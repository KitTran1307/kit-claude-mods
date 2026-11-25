// The decisions behind the guard, with no engine calls: reading the options, which calls are asked about and which are only
// saved, the queue of waiting questions and how one is answered (Allow, Cancel, no answer, an interrupt), what the band is
// told about a call (the Pending view) and the small rewrites of a tool's result and of a message. register.tsx wires these to
// the engine; everything here takes plain values and returns plain values, so it is unit-tested directly (flow.test.ts).
// Every function is total: odd input gives a safe default, never an exception.
import type { Pending, RiskView, SnapshotView } from '../types'
import { sanitizeShown } from './describe'
import type { TooBigView } from './describe'
import { expandBraces } from './guard'
import { languageOption } from './i18n'
import type { Lang } from './i18n'
import { maskDeep, maskText } from './mask'
import { isFilesystemRoot, isInside, isWindowsPath, joinPath, normalizePath, relativeTo, resolvePath } from './paths'
import { commandCount } from './risk'
import { DEFAULT_MAX_FILES, hasGlob, relUnder } from './snapshot'
import type { Confirm, Risk } from './types'
import type { SnapshotOutcome, VaultCfg } from './vault'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------------------------------------------------
// Options

export type Options = {
  confirm: Confirm
  /** The `confirm` option as it was written (`/safety doctor` shows it when it is none of the three). */
  confirmText: string
  maskSecrets: boolean
  keepSnapshots: number
  keepDays: number
  maxSizeMB: number
  /** All snapshots of all projects together, in MB. */
  maxTotalMB: number
  language: 'auto' | Lang
}

export const DEFAULT_OPTIONS: Readonly<Options> = {
  confirm: 'risky',
  confirmText: 'risky',
  maskSecrets: true,
  keepSnapshots: 20,
  keepDays: 7,
  maxSizeMB: 200,
  maxTotalMB: 2048,
  language: 'auto',
}

/** `always` and `never` exactly; anything else (a typo, a number, nothing) means `risky`, the safe middle. */
export function confirmOption(value: unknown): Confirm {
  return value === 'always' || value === 'never' ? value : 'risky'
}

/** A whole number from `min` to `max`; a number written as text counts; anything else is `fallback`. */
export function boundedOption(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** On unless it is plainly switched off (`false`). */
export function maskOption(value: unknown): boolean {
  return !(value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false'))
}

/** The plugin's options, read once per load. Every value has a working default. */
export function readOptions(raw: unknown): Options {
  const o = isObj(raw) ? raw : {}
  const text = typeof o.confirm === 'string' ? o.confirm.slice(0, 40) : typeof o.confirm === 'number' || typeof o.confirm === 'boolean' ? String(o.confirm) : 'risky'
  return {
    confirm: confirmOption(o.confirm),
    confirmText: text === '' ? 'risky' : text,
    maskSecrets: maskOption(o.maskSecrets),
    keepSnapshots: boundedOption(o.keepSnapshots, DEFAULT_OPTIONS.keepSnapshots, 1, 200),
    keepDays: boundedOption(o.keepDays, DEFAULT_OPTIONS.keepDays, 1, 90),
    maxSizeMB: boundedOption(o.maxSizeMB, DEFAULT_OPTIONS.maxSizeMB, 10, 2000),
    maxTotalMB: boundedOption(o.maxTotalMB, DEFAULT_OPTIONS.maxTotalMB, 100, 20000),
    language: languageOption(o.language),
  }
}

/** What the vault is told: bytes, a count, days and the total of all snapshots. */
export function vaultCfg(o: Pick<Options, 'maxSizeMB' | 'keepSnapshots' | 'keepDays' | 'maxTotalMB'>): VaultCfg {
  return { maxBytes: o.maxSizeMB * 1024 * 1024, keepCount: o.keepSnapshots, keepDays: o.keepDays, maxTotalBytes: o.maxTotalMB * 1024 * 1024 }
}

/** A quiet cleanup (`rm -rf node_modules`) is saved with small limits: this many files and (at most) this many MB. */
export const QUIET_MAX_FILES = 2000
export const QUIET_MAX_MB = 50

/** What the size and file limits of one snapshot are, for the vault and for the words that name them (see snapshotView). */
export type Limits = { cfg: VaultCfg; view: { maxSizeMB: number; maxFiles?: number } }

/**
 * The limits of the snapshot of one call: the configured ones, or, when `isCheap` (assess says the call is only a cleanup of things
 * that are cheap to regenerate), the small ones: a cleanup of a huge folder is not worth the disk space or the wait, and the call
 * then goes on with no snapshot rather than being held up.
 */
export function limitsOf(o: Pick<Options, 'maxSizeMB' | 'keepSnapshots' | 'keepDays' | 'maxTotalMB'>, isCheap: boolean): Limits {
  const cfg = vaultCfg(o)
  if (!isCheap) return { cfg, view: { maxSizeMB: o.maxSizeMB } }
  const maxSizeMB = Math.min(o.maxSizeMB, QUIET_MAX_MB)
  return { cfg: { ...cfg, maxBytes: maxSizeMB * 1024 * 1024, maxFiles: QUIET_MAX_FILES }, view: { maxSizeMB, maxFiles: QUIET_MAX_FILES } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Which calls are asked about, and which are only saved

/** A question nobody answers for this long is denied: a risky call never runs unattended. (A hook may use 20 minutes.) */
export const QUESTION_TIMEOUT_MS = 15 * 60_000
/** The band has this long to draw a question before Claude Code's own question box asks instead. */
export const FALLBACK_AFTER_MS = 1_500
/**
 * An Allow or Cancel press that comes less than this long after the question first drew on screen is not an answer: the band
 * shows the next question at once, so a double press, or the first letter of a message typed into an empty prompt, could
 * answer a question the person never read.
 */
export const PRESS_GUARD_MS = 600
/** A snapshot older than this when the person says Allow is taken again, so that what changed while the question waited is in it. */
export const STALE_SNAPSHOT_MS = 60_000
/** After the first 30 seconds the band is looked at less often (it only matters if the person collapses it meanwhile). */
export const FALLBACK_LATER_MS = 10_000
const FALLBACK_QUICK_TICKS = 20

/** How long to wait before look number `tick` (from 0) at whether the band drew a question. */
export function fallbackDelay(tick: number): number {
  return Number.isFinite(tick) && tick >= FALLBACK_QUICK_TICKS ? FALLBACK_LATER_MS : FALLBACK_AFTER_MS
}

/** Whether a press at `now` is too early for a question that first drew at `shownAt` (a question never drawn, or a clock that went back, is not early). */
export function isEarlyPress(shownAt: number | undefined, now: number): boolean {
  if (typeof shownAt !== 'number' || !Number.isFinite(shownAt) || typeof now !== 'number' || !Number.isFinite(now)) return false
  const waited = now - shownAt
  return waited >= 0 && waited < PRESS_GUARD_MS
}

/** Whether the snapshot taken at `takenAt` is old enough, at `now`, that it should be taken again before the call runs. */
export function isSnapshotStale(takenAt: number, now: number): boolean {
  return Number.isFinite(takenAt) && Number.isFinite(now) && now - takenAt > STALE_SNAPSHOT_MS
}

export type PlanInput = {
  confirm: Confirm
  risks: readonly { tier: 'ask' | 'snapshot' }[]
  /** A person can answer (a headless `-p` run has nobody). */
  interactive: boolean
  /** Every file this call touches was already saved in this session. */
  coalesced: boolean
}

export type CallPlan = {
  /** Save a snapshot before the call. */
  snapshot: boolean
  /** Hold the call until the person answers. */
  ask: boolean
  /** Tell Claude (a context line) that a snapshot exists, once the call was allowed. */
  note: boolean
  /** Show a toast saying a snapshot was saved (confirm=never, so nothing else tells the person). */
  toast: boolean
}

/**
 * The truth table of the guard.
 * - confirm=never: never asks. confirm=risky: asks for an `ask`-tier risk. confirm=always: asks for any risk.
 * - Nobody to answer (headless): never asks, whatever the option says; the snapshot is still saved.
 * - A snapshot is saved for every call with a risk, except when the only risks are `snapshot`-tier and every file they touch was
 *   already saved in this session (a session that edits one file 30 times makes one snapshot).
 * - Claude is told about the snapshot when the call was risky enough to ask about, or was asked about.
 */
export function planCall(i: PlanInput): CallPlan {
  const risks = Array.isArray(i?.risks) ? i.risks : []
  const hasAsk = risks.some(r => r?.tier === 'ask')
  const confirm = confirmOption(i?.confirm)
  const interactive = i?.interactive !== false
  const wantsAsk = risks.length > 0 && confirm !== 'never' && (confirm === 'always' || hasAsk)
  const ask = wantsAsk && interactive
  const snapshot = risks.length > 0 && !(i?.coalesced === true && !hasAsk)
  return { snapshot, ask, note: snapshot && (hasAsk || ask), toast: snapshot && confirm === 'never' && hasAsk && interactive }
}

/**
 * True when nothing can be lost: every risk is a delete, no path is unknown, and nothing it names exists in the project (`rm -rf
 * build` with no build folder, or a link, which holds no data). Asking about that only trains people to click Allow. Never true
 * when the project is a filesystem root or the home folder, where "no targets" means "too much to look at", not "nothing there".
 */
export function hasNothingToLose(a: { risks: readonly Risk[]; targets: readonly string[]; isUnknown: boolean }, root: string, home: string): boolean {
  try {
    const risks = Array.isArray(a?.risks) ? a.risks : []
    if (risks.length === 0 || (Array.isArray(a.targets) && a.targets.length > 0) || a.isUnknown !== false) return false
    if (typeof root !== 'string' || root === '' || isFilesystemRoot(root)) return false
    const same = (x: string, y: string) => (isWindowsPath(x) || isWindowsPath(y) ? normalizePath(x).toLowerCase() === normalizePath(y).toLowerCase() : normalizePath(x) === normalizePath(y))
    if (typeof home === 'string' && home !== '' && same(root, home)) return false
    return risks.every(r => r?.kind === 'delete' && r.hasUnknownPath !== true)
  } catch {
    return false
  }
}

// ---- one snapshot per file per session ----

const COALESCE_MAX = 2000

/** The key of a file that was saved: its absolute spelling (case ignored for a Windows path). */
export function coalesceKey(root: string, rel: string): string {
  const abs = joinPath(typeof root === 'string' ? root : '', typeof rel === 'string' ? rel : '')
  return isWindowsPath(abs) ? abs.toLowerCase() : abs
}

export function coalesceKeys(root: string, targets: readonly string[]): string[] {
  return (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === 'string' && t !== '').map(t => coalesceKey(root, t))
}

/** The snapshot that already holds all of these files, or null when any of them is not saved yet (or there are none). */
export function savedView(keys: readonly string[], seen: ReadonlyMap<string, SnapshotView>): SnapshotView | null {
  if (keys.length === 0) return null
  let first: SnapshotView | null = null
  for (const key of keys) {
    const view = seen.get(key)
    if (!view) return null
    first ??= view
  }
  return first
}

/** Remembers that these files are saved (only a snapshot that really holds them counts). The oldest entries go first. */
export function remember(seen: Map<string, SnapshotView>, keys: readonly string[], view: SnapshotView): void {
  if (view.state !== 'saved') return
  for (const key of keys) {
    seen.delete(key)
    seen.set(key, view)
  }
  while (seen.size > COALESCE_MAX) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The queue of waiting questions

/** Appends a question (oldest first); one with the same id is replaced where it stood. */
export function enqueue(list: readonly Pending[], p: Pending): Pending[] {
  const at = list.findIndex(x => x.id === p.id)
  if (at < 0) return [...list, p]
  const out = [...list]
  out[at] = p
  return out
}

export function dequeue(list: readonly Pending[], id: string): Pending[] {
  return list.some(x => x.id === id) ? list.filter(x => x.id !== id) : [...list]
}

/** The question the band shows: the oldest. */
export function frontOf(list: readonly Pending[]): Pending | null {
  return list[0] ?? null
}

/** How many wait behind the one on show. */
export function waitingBehind(list: readonly Pending[]): number {
  return Math.max(0, list.length - 1)
}

/** `detail` after a press on "See changes" for `id`: open it, or close it when it was open. */
export function toggledDetail(current: string | null, id: string): string | null {
  return current === id ? null : id
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers: Allow, Cancel, no answer in time, an interrupt

export type Answer = 'allow' | 'cancel' | 'timeout' | 'aborted'

export type Decisions = {
  /** Starts waiting for the question `id`. A second wait on the same id ends the first as `aborted`. */
  open(id: string): Promise<Answer>
  /** Answers it. True when it was waiting: the first answer wins, a later one (a double press, a timeout after Allow) is nothing. */
  answer(id: string, answer: Answer): boolean
  has(id: string): boolean
  /** Ends every wait as `aborted` (the session ends); how many were waiting. */
  abortAll(): number
  readonly size: number
}

export function createDecisions(): Decisions {
  const open = new Map<string, (a: Answer) => void>()
  const settle = (id: string, a: Answer): boolean => {
    const resolve = open.get(id)
    if (!resolve) return false
    open.delete(id)
    resolve(a)
    return true
  }
  return {
    open(id) {
      settle(id, 'aborted')
      return new Promise<Answer>(resolve => {
        open.set(id, resolve)
      })
    },
    answer: settle,
    has: id => open.has(id),
    abortAll() {
      let n = 0
      for (const id of [...open.keys()]) if (settle(id, 'aborted')) n += 1
      return n
    },
    get size() {
      return open.size
    },
  }
}

/** What the fallback dialog's answer means: only the Allow label allows; free text typed under "Other" and a dismissal cancel. */
export function answerOfDialog(label: unknown, allowLabel: string): Answer {
  return typeof label === 'string' && label === allowLabel ? 'allow' : 'cancel'
}

/** Whether the fallback dialog should ask now: the question is still open, is the one the band would show, and the band has not drawn it. */
export function needsFallback(i: { isOpen: boolean; isFront: boolean; isDrawn: boolean; isAsking: boolean }): boolean {
  return i.isOpen && i.isFront && !i.isDrawn && !i.isAsking
}

// ---------------------------------------------------------------------------------------------------------------------
// What the band is told: the Pending view

/**
 * How a snapshot attempt reads to the person. `cfg.maxSizeMB` is the size limit that a `too-big` outcome names; `cfg.maxFiles`, when
 * it is below the usual limit (a quiet cleanup), is the file limit it names.
 */
export function snapshotView(outcome: SnapshotOutcome | null | undefined, cfg: { maxSizeMB: number; maxFiles?: number }): SnapshotView {
  if (!outcome || typeof outcome !== 'object') return { state: 'failed' }
  if (outcome.ok === true) {
    const isGitPartial = outcome.isGitPartial === true
    // `.env`-like files the text-only backend left out: what was saved is partial, whatever else was saved
    const skippedPrivate = typeof outcome.skippedPrivate === 'number' && outcome.skippedPrivate > 0
    // No files and nothing wrong with Git: nothing to copy. With Git unable to keep the uncommitted changes the view stays a
    // `saved` one (with no files), so that the band can say so instead of "Git state saved".
    if (outcome.files === 0 && !isGitPartial && !skippedPrivate) return { state: 'none', hasGit: outcome.hasGit === true }
    const view: SnapshotView = { state: 'saved', id: outcome.id, n: outcome.n, at: outcome.createdAt, files: outcome.files, bytes: outcome.bytes, isPartial: outcome.isPartial === true || skippedPrivate, hasGit: outcome.hasGit === true }
    return isGitPartial ? { ...view, isGitPartial: true } : view
  }
  if (outcome.reason === 'too-big') {
    if (outcome.byFiles !== true) return { state: 'too-big', limitMB: cfg.maxSizeMB }
    const limit = typeof cfg.maxFiles === 'number' && cfg.maxFiles >= 1 && cfg.maxFiles < DEFAULT_MAX_FILES ? Math.floor(cfg.maxFiles) : 0
    const view: TooBigView = { state: 'too-big', limitMB: cfg.maxSizeMB, byFiles: true, ...(limit > 0 ? { limitFiles: limit } : {}) }
    return view
  }
  // Only a `.env`-like file was to be saved and there is no Node.js to keep its copy private.
  if (outcome.reason === 'private') return { state: 'needs-node' }
  // Entries that were seen but could not be saved (binary files without Node) are not "nothing to copy".
  if (outcome.reason === 'nothing') return typeof outcome.skipped === 'number' && outcome.skipped > 0 ? { state: 'failed' } : { state: 'none', hasGit: false }
  return { state: 'failed' }
}

export type Where = { root: string; cwd: string; home: string }
type Slot = { text: string; abs: string | null }

const MAX_SHOWN = 3
const MAX_WRITTEN = 24

/** The key under which a path is looked up in the set of folders (case is ignored for a Windows path). */
export const dirKey = (p: string): string => (isWindowsPath(p) ? normalizePath(p).toLowerCase() : normalizePath(p))

/** Where a path of the command points, in the words of the band: relative to the project, `.` for the project itself. */
function slotOfWritten(where: Where, written: string): Slot | null {
  const abs = resolvePath(where.cwd, written, where.home)
  if (abs === null) return null
  const rel = relativeTo(where.root, abs)
  if (rel === '') return { text: '.', abs }
  if (rel !== null) return { text: rel, abs }
  // an ancestor of the project (`rm -rf ..`): the project goes with it
  if (isInside(abs, where.root)) return { text: '.', abs }
  const text = written.replace(/[\\/]+$/, '')
  return text === '' ? null : { text, abs }
}

type Laid = { risk: Risk; slots: Slot[]; count: number }

/** The paths each risk would show: the ones the command names, and for a wildcard what it matched (the call's targets). */
function layout(risks: readonly Risk[], targets: readonly string[], where: Where): Laid[] {
  const list = (Array.isArray(risks) ? risks : []).filter((r): r is Risk => isObj(r))
  const sound = (Array.isArray(targets) ? targets : []).filter((t): t is string => typeof t === 'string' && t !== '')
  const laid: Laid[] = list.map(risk => ({ risk, slots: [], count: 0 }))
  const covered: string[] = []
  const wildcard: Laid[] = []
  for (const l of laid) {
    if (l.risk.kind !== 'delete' && l.risk.kind !== 'overwrite') continue
    const written = (Array.isArray(l.risk.paths) ? l.risk.paths : []).filter((p): p is string => typeof p === 'string')
    let hasWildcard = false
    for (const p of written.slice(0, MAX_WRITTEN)) {
      if (hasGlob(p)) {
        hasWildcard = true
        continue
      }
      // {a,b} names several paths
      for (const one of (expandBraces(p) ?? [p]).slice(0, MAX_WRITTEN)) {
        const slot = slotOfWritten(where, one)
        if (!slot) continue
        l.slots.push(slot)
        if (slot.text !== '.' && relativeTo(where.root, slot.abs ?? '') !== null) covered.push(slot.text)
      }
    }
    if (written.length > MAX_WRITTEN) hasWildcard = true
    l.count = l.slots.length
    if (hasWildcard) wildcard.push(l)
  }
  // what a wildcard matched: the targets that no named path already covers (given to the first risk that has a wildcard)
  const first = wildcard[0]
  if (first) {
    const extra = sound.filter(t => !covered.some(c => relUnder(c, t)))
    first.slots.push(...extra.map((t): Slot => ({ text: t, abs: joinPath(where.root, t) })))
    first.count += extra.length
  }
  return laid
}

/** The absolute paths the views would show, so the caller can ask which of them are folders (and say so with a trailing `/`). */
export function pathsToCheck(risks: readonly Risk[], targets: readonly string[], where: Where): string[] {
  const out: string[] = []
  for (const l of layout(risks, targets, where)) {
    // the paths of a `find ... -delete` are not shown (unless the filter holds a name: "under src/"), so nobody needs to know which of them are folders
    if (l.risk.picks === true && !hasMatch(l.risk)) continue
    for (const s of l.slots.slice(0, MAX_SHOWN)) if (s.abs !== null) out.push(normalizePath(s.abs))
  }
  return [...new Set(out)]
}

/** A delete whose files are picked at run time by a name pattern the matcher could read. */
const hasMatch = (r: Risk): boolean => r.picks === true && typeof r.match === 'string' && r.match !== ''

const MATCH_MAX = 200

const folderMark = (s: Slot, dirs: ReadonlySet<string>): string => {
  const isDir = s.abs !== null && s.text !== '.' && dirs.has(dirKey(s.abs))
  return isDir && !/[\\/]$/.test(s.text) ? `${s.text}/` : s.text
}

/** One RiskView for each risk of the call. `dirs` holds the normalized absolute paths that are folders (see pathsToCheck). */
export function riskViewsOf(risks: readonly Risk[], targets: readonly string[], where: Where, dirs: ReadonlySet<string> = new Set()): RiskView[] {
  return layout(risks, targets, where).map(({ risk, slots, count }) => {
    // A delete whose files are chosen at run time (`find ... -delete`) names no path: the words say so even though a snapshot of
    // where it looks was taken. With a name pattern in the filter the words say what it looks for, and where.
    const picks = risk.picks === true
    const named = hasMatch(risk)
    const view: RiskView = {
      kind: risk.kind,
      label: typeof risk.label === 'string' ? risk.label : '',
      paths: picks && !named ? [] : slots.slice(0, MAX_SHOWN).map(s => folderMark(s, dirs)),
      count: picks && !named ? 0 : count,
    }
    if (picks) view.picks = true
    if (named) view.match = (risk.match as string).slice(0, MATCH_MAX)
    if (typeof risk.name === 'string' && risk.name !== '') view.name = risk.name
    if (typeof risk.remote === 'string' && risk.remote !== '') view.remote = risk.remote
    // a command that names several branches (`git branch -D a b c`) says how many more than the first
    const names = Array.isArray(risk.names) ? risk.names.filter((n): n is string => typeof n === 'string' && n !== '') : []
    if ((risk.kind === 'force-push' || risk.kind === 'branch-delete') && names.length > 1) view.extra = names.length - 1
    return view
  })
}

const NAMES_MAX = 50

const namesOf = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).filter((n): n is string => typeof n === 'string').slice(0, NAMES_MAX)

export type PendingInput = {
  id: string
  at: number
  tool: string
  risks: RiskView[]
  snapshot: SnapshotView
  env?: { before: number; after: number; removed: readonly string[]; added: readonly string[] } | undefined
  isAgent?: boolean | undefined
  /** How many other commands the line holds besides the flagged ones (see othersIn). */
  others?: number | undefined
  /** The call deletes the project's own `.git` folder, which a snapshot never holds (see Assessment.losesGit). */
  gitLost?: boolean | undefined
  /** The command line: only its start is kept, and only for a question about a line that could not be read to the end. */
  command?: string | undefined
}

/** How many characters of a command the band shows for a line that could not be read. */
const SNIPPET_MAX = 120
/** How much of the command is looked at for secrets before it is cut (a key may cross the cut at 120 characters). */
const SNIPPET_SCAN = 20_000

/** The start of a command for the band: secret shapes masked first, then cleaned and cut. Total: '' for anything but text. */
export function snippetOf(command: unknown): string {
  try {
    if (typeof command !== 'string' || command === '') return ''
    return sanitizeShown(maskText(command.slice(0, SNIPPET_SCAN)).text, SNIPPET_MAX)
  } catch {
    return ''
  }
}

/**
 * How many other commands a command line holds besides the `flagged` risks (`rm -rf build && curl x | sh`: 2 commands, 1 flagged,
 * 1 other), for Bash and PowerShell only; 0 for any other tool, for text with no commands, and never negative.
 */
export function othersIn(tool: string, command: unknown, flagged: number): number {
  try {
    if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof command !== 'string') return 0
    return Math.max(0, commandCount(command) - (Number.isFinite(flagged) ? Math.max(0, Math.floor(flagged)) : 0))
  } catch {
    return 0
  }
}

/** The question the band shows. The variable names are copied (names only, capped). */
export function buildPending(i: PendingInput): Pending {
  const p: Pending = { id: i.id, at: Number.isFinite(i.at) ? i.at : 0, tool: i.tool, risks: i.risks, snapshot: i.snapshot }
  if (i.env) p.env = { before: Number(i.env.before) || 0, after: Number(i.env.after) || 0, removed: namesOf(i.env.removed), added: namesOf(i.env.added) }
  if (i.isAgent === true) p.isAgent = true
  if (i.gitLost === true) p.gitLost = true
  if (typeof i.others === 'number' && Number.isFinite(i.others) && i.others >= 1) p.others = Math.floor(i.others)
  // only a line that could not be read to the end shows its start: for every other risk the label and the paths say enough
  if ((Array.isArray(i.risks) ? i.risks : []).some(r => r?.kind === 'unparsed')) {
    const snippet = snippetOf(i.command)
    if (snippet !== '') p.snippet = snippet
  }
  return p
}

let counter = 0
/** The id of a question when the call carries none. */
export function fallbackId(now: number): string {
  counter = (counter + 1) % 1_000_000
  return `q${Math.floor(Number.isFinite(now) ? now : 0).toString(36)}-${counter.toString(36)}`
}

// ---------------------------------------------------------------------------------------------------------------------
// A guard that fails

/** Sent to Claude when the guard failed after the person had been asked: the call did not run. */
export const DENY_COULD_NOT_FINISH = 'Safety Net could not finish asking the person, so nothing was run. Ask them and try again.'

const ASKED_MAX = 500

/**
 * The calls that a question was raised for and that have not been answered yet. The mark outlives an interruption on purpose: when
 * the engine gives up on the hook (it ran out of time) it cancels the wait first and asks the hook's `.catch` afterwards, by which
 * time the wait is gone, but the question was asked. Capped, oldest first.
 */
export type AskedMarks = {
  mark(id: string): void
  clear(id: string): void
  has(id: string): boolean
  readonly size: number
}

export function createAsked(): AskedMarks {
  const ids = new Set<string>()
  return {
    mark(id) {
      ids.delete(id)
      ids.add(id)
      while (ids.size > ASKED_MAX) {
        const oldest = ids.values().next().value
        if (oldest === undefined) break
        ids.delete(oldest)
      }
    },
    clear: id => {
      ids.delete(id)
    },
    has: id => ids.has(id),
    get size() {
      return ids.size
    },
  }
}

/**
 * What the `.catch` of the `tool.call` hook does: where the hook had already run the tool, what it settled to stands (`replay`);
 * where a question was raised for this call, the call is refused (`deny`: never run what the person was asked about and did not
 * answer); where nothing was asked, the fault is ours and the call goes on (`pass`).
 */
export function catchVerdict(i: { called: boolean; wasAsked: boolean }): 'replay' | 'deny' | 'pass' {
  if (i?.called === true) return 'replay'
  return i?.wasAsked === true ? 'deny' : 'pass'
}

// ---------------------------------------------------------------------------------------------------------------------
// Small rewrites

/** The result of an allowed call with one more context line for Claude; a refusal (`deny`) and a missing note come back as they are. */
export function withNote<R>(result: R, note: string | null): R {
  if (note === null || note === '' || !isObj(result) || typeof result.deny === 'string') return result
  const context = Array.isArray(result.context) ? result.context.filter((c): c is string => typeof c === 'string') : []
  return { ...result, context: [...context, note] } as R
}

const SKIPPED_BLOCKS: ReadonlySet<string> = new Set(['image', 'document', 'thinking', 'redacted_thinking', 'tool_use'])

type Masked<T> = { value: T; count: number }

/**
 * The content blocks of a tool-result row with every secret shape masked. Images, documents and the blocks the engine pins are not
 * walked (a screenshot is megabytes of base64, and a block the engine pins cannot be changed anyway). `count` is the number of
 * masked values; when it is 0 the very same array comes back.
 */
export function maskBlocks(content: unknown): Masked<unknown> {
  if (typeof content === 'string') {
    const r = maskDeep(content)
    return { value: r.value, count: r.count }
  }
  if (!Array.isArray(content)) return { value: content, count: 0 }
  let count = 0
  let changed = false
  const out = content.map((block: unknown) => {
    if (!isObj(block)) {
      const r = maskDeep(block)
      count += r.count
      changed ||= r.count > 0
      return r.value
    }
    const type = typeof block.type === 'string' ? block.type : ''
    if (SKIPPED_BLOCKS.has(type)) return block
    if (type === 'tool_result') {
      const inner = maskBlocks(block.content)
      if (inner.count === 0) return block
      count += inner.count
      changed = true
      return { ...block, content: inner.value }
    }
    const r = maskDeep(block)
    count += r.count
    changed ||= r.count > 0
    return r.value
  })
  return changed ? { value: out, count } : { value: content, count: 0 }
}

/** `/safety` arguments: the first word (lower case) and the rest. */
export function parseArgs(args: unknown): { verb: string; tail: string } {
  const text = typeof args === 'string' ? args.slice(0, 2000) : ''
  const m = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  return { verb: (m?.[1] ?? '').toLowerCase(), tail: (m?.[2] ?? '').trim() }
}
