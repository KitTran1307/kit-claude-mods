// Pure functions of the Turn Card: options, formatting, parsers, the file-change maths, the timeline and the layout
// plan. No engine calls, so every one is unit-tested without an engine.

import type { Commit, FileChange, Step, Summary, TestRun, Unpushed } from '../types'
import type { Strings } from './i18n'

export type Style = 'card' | 'timeline'

/** What "Push now" puts in the prompt box. English on purpose: Claude reads it. It only asks; the plugin never pushes. */
export const PUSH_PROMPT = 'Push my commits to the remote (git push) and tell me the result.'

export const MAX_FILES_DEFAULT = 8
export const MAX_FILES_RANGE: [number, number] = [1, 30]
export const CLOCK_TICK_MS = 15_000
export const MAX_STEPS = 60

export const COLORS = {
  // Text colors hold 7:1 on the backgrounds scripts/contrast.mjs lists (dark terminals; white and cream for the light surfaces).
  dark: { accent: '#efa890', ok: '#aebe98', bad: '#f1a59e', warn: '#e0b06a', add: '#9ece6a', del: '#f2a4b2' },
  light: { accent: '#893214', ok: '#3e5428', bad: '#982016', warn: '#714406', add: '#225a24', del: '#972019' },
}
export type Palette = typeof COLORS.dark

// --- options -------------------------------------------------------------------------------------------------

/** A whole number from min to max; a missing or bad value is the default, a number outside the range is cut to it. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export const maxFilesFrom = (v: unknown) => clampInt(v, MAX_FILES_DEFAULT, MAX_FILES_RANGE[0], MAX_FILES_RANGE[1])
export const styleOption = (v: unknown): Style => (v === 'timeline' ? 'timeline' : 'card')

// --- text ---------------------------------------------------------------------------------------------------

export const stripAnsi = (s: string) => s.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')

/** Control characters out (a path or a commit text from outside must never move the cursor or recolor the screen). */
export const stripControl = (text: string): string => String(text ?? '').replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '')

/** One line of at most max characters: whitespace runs become one space, control characters go, a longer text ends in an ellipsis. */
export function shortText(text: string, max: number): string {
  const src = String(text ?? '')
  const flat = stripControl(src.slice(0, max * 4).replace(/\s+/g, ' ')).trim()
  if (flat.length <= max && src.length <= max * 4) return flat
  const cut = flat.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
  return `${cut}…`
}

/** Terminal cells a text takes, on the safe side: wide characters and emoji count two, everything else one. */
export function textCells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const wide = (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3)
      || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60)
      || (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x20000 && c <= 0x3FFFD)
    n += wide ? 2 : 1
  }
  return n
}

/** One extra row once a text wraps: a break at a word boundary can cost more than the plain division says. */
export function wrapRows(text: string, width: number): number {
  const cells = textCells(text)
  const w = Math.max(1, width)
  return cells <= w ? 1 : Math.ceil(cells / w) + 1
}

/** A path cut from the left to fit max cells: "src/cart/checkout.ts" becomes "…/cart/checkout.ts" or "…/checkout.ts". */
export function shortPath(path: string, max: number): string {
  const p = stripControl(path).replace(/\\/g, '/')
  if (textCells(p) <= max) return p
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const cand = `…/${parts.slice(i).join('/')}`
    if (textCells(cand) <= max) return cand
  }
  const name = parts[parts.length - 1] ?? p
  return `…${[...name].slice(-Math.max(1, max - 1)).join('')}`
}

/** First useful line of Claude's answer: markdown marks and list bullets are dropped, the line is cut at max. */
export function firstLine(answer: string, max = 140): string {
  let inFence = false
  for (const raw of String(answer ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (inFence || !line || /^(---+$|\|)/.test(line)) continue
    line = line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1').replace(/`([^`]*)`/g, '$1').trim()
    if (line) return shortText(line, max)
  }
  return ''
}

// --- time ---------------------------------------------------------------------------------------------------

/** Local 24-hour clock, "14:02". */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "3 min 12 s", "42 s", "1 h 5 min". */
export function formatDuration(ms: number, t: Strings): string {
  const safe = Math.max(0, ms)
  if (safe < 1000) return t.underASecond
  const total = Math.round(safe / 1000)
  if (total < 60) return t.seconds(total)
  if (total < 3600) return t.minutes(Math.floor(total / 60), total % 60)
  return t.hours(Math.floor(total / 3600), Math.floor((total % 3600) / 60))
}

/** The running clock's elapsed part, minutes only: "under 1 min", "3 min", "1 h 5 min". */
export function formatElapsed(ms: number, t: Strings): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return t.elapsedUnderMinute
  if (m < 60) return t.elapsedMinutes(m)
  return t.elapsedHours(Math.floor(m / 60), m % 60)
}

// --- test output --------------------------------------------------------------------------------------------

const num = (m: RegExpExecArray | null) => (m ? Number(m[1]) : 0)
const sum = (ms: RegExpMatchArray[], i: number) => ms.reduce((n, m) => n + Number(m[i] ?? 0), 0)

/** Reads the counts a test runner printed (node --test, Jest, Vitest, pytest, cargo test, go test); null when none is recognised. */
export function parseTestOutput(raw: string): TestRun | null {
  const text = stripAnsi(String(raw ?? ''))
  if (!text) return null
  // cargo test: one "test result:" line per binary; they add up.
  const cargo = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (cargo.length) return { runner: 'cargo', passed: sum(cargo, 1), failed: sum(cargo, 2), skipped: sum(cargo, 3) }
  // node --test: "ℹ pass 12 / ℹ fail 0" (spec reporter) or "# pass 12" (TAP).
  const nodePass = /^(?:ℹ|#)\s+pass\s+(\d+)\s*$/m.exec(text)
  const nodeFail = /^(?:ℹ|#)\s+fail\s+(\d+)\s*$/m.exec(text)
  if (nodePass && nodeFail) {
    return { runner: 'node', passed: num(nodePass), failed: num(nodeFail), skipped: num(/^(?:ℹ|#)\s+skipped\s+(\d+)\s*$/m.exec(text)) }
  }
  // Jest: "Tests:       1 failed, 11 passed, 12 total"; Vitest: " Tests  1 failed | 11 passed (12)".
  const jest = /^\s*Tests:\s+(.+)$/m.exec(text)
  const vitest = /^\s*Tests\s+(\d.*\(\d+\).*)$/m.exec(text)
  const line = jest?.[1] ?? vitest?.[1]
  if (line && /(passed|failed)/.test(line)) {
    return {
      runner: jest ? 'jest' : 'vitest',
      passed: num(/(\d+) passed/.exec(line)), failed: num(/(\d+) failed/.exec(line)), skipped: num(/(\d+) (?:skipped|todo)/.exec(line)),
    }
  }
  // pytest: "=== 1 failed, 11 passed, 2 skipped in 0.5s ===" or "12 passed in 0.31s".
  const py = /^[= ]*((?:\d+ (?:passed|failed|skipped|xfailed|xpassed|errors?|warnings?|deselected)(?:, | and )?)+)\s+in\s+[\d.]+s/m.exec(text)
  if (py) {
    const s = py[1] ?? ''
    return { runner: 'pytest', passed: num(/(\d+) passed/.exec(s)), failed: num(/(\d+) failed/.exec(s)) + num(/(\d+) errors?/.exec(s)), skipped: num(/(\d+) skipped/.exec(s)) }
  }
  // go test: -v prints one "--- PASS/FAIL/SKIP" per test; without it the lines are per package.
  const goPass = [...text.matchAll(/^\s*--- PASS: /gm)].length
  const goFail = [...text.matchAll(/^\s*--- FAIL: /gm)].length
  const goSkip = [...text.matchAll(/^\s*--- SKIP: /gm)].length
  if (goPass + goFail + goSkip > 0) return { runner: 'go', passed: goPass, failed: goFail, skipped: goSkip }
  const pkgOk = [...text.matchAll(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)].length
  const pkgFail = [...text.matchAll(/^FAIL\s+\S+\s+(?:[\d.]+s|\[build failed\]|\[setup failed\])/gm)].length
  if (pkgOk + pkgFail > 0) return { runner: 'go', passed: pkgOk, failed: pkgFail, skipped: 0, unit: 'packages' }
  return null
}

// --- git output ---------------------------------------------------------------------------------------------

/** The new name in a numstat rename: "src/{a => b}/x.ts" becomes "src/b/x.ts", "a.ts => b.ts" becomes "b.ts". */
export function renameTarget(p: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p)
  if (braces) return (`${braces[1]}${braces[3]}${braces[4]}`).replace(/\/\//g, '/')
  const plain = /^.* => (.*)$/.exec(p)
  return plain ? (plain[1] ?? p) : p
}

/** "git diff --numstat": "22<TAB>5<TAB>path"; binary files print "-". */
export function parseNumstat(text: string): FileChange[] {
  const out: FileChange[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const isBinary = m[1] === '-'
    out.push({ path: renameTarget(m[3] ?? ''), added: isBinary ? 0 : Number(m[1]), removed: isBinary ? 0 : Number(m[2]), ...(isBinary ? { isBinary: true } : {}) })
  }
  return out
}

/** "hash<TAB>subject" lines of git log. */
export function parseCommits(text: string): Commit[] {
  const out: Commit[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{4,40})\t(.*)$/.exec(line)
    if (m) out.push({ hash: m[1] ?? '', subject: shortText(m[2] ?? '', 120) })
  }
  return out
}

export const parseCount = (text: string): number | null => {
  const m = /^\s*(\d+)\s*$/.exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}

export const unpushedOf = (count: number, upstream: string | null, commits: Commit[]): Unpushed => ({
  count, upstream: upstream === null ? null : shortText(upstream, 120), commits: commits.slice(0, 30),
})

// --- changes ------------------------------------------------------------------------------------------------

export type Baseline = { [path: string]: { a: number; r: number } }

/** Files changed since a baseline: a file whose numbers did not move since then was changed before and is left out. */
export function deltaFiles(end: FileChange[], base: Baseline): FileChange[] {
  const out: FileChange[] = []
  for (const f of end) {
    const b = base[f.path]
    if (!b) { out.push(f); continue }
    if (b.a === f.added && b.r === f.removed) continue
    const added = Math.max(0, f.added - b.a)
    const removed = Math.max(0, f.removed - b.r)
    out.push(added || removed ? { ...f, added, removed } : f)
  }
  return out
}

export function totals(files: FileChange[]): { n: number; added: number; removed: number } {
  return files.reduce((t, f) => ({ n: t.n + 1, added: t.added + f.added, removed: t.removed + f.removed }), { n: 0, added: 0, removed: 0 })
}

/** One tool call of the turn, as session.messages reports it. */
export type ToolUse = { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true }
export type Message = { role: 'user' | 'assistant'; text: string; toolUses: ToolUse[] }

const lineCount = (s: unknown) => (typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n').length : 0)

/** Lines added and removed by one Edit/Write call, from its stored patch when there is one, else from its input. */
export function editStats(use: ToolUse): { path: string; added: number; removed: number; isNew: boolean } | null {
  const path = [use.input.file_path, use.input.notebook_path].find((p): p is string => typeof p === 'string' && p !== '')
  if (!path) return null
  const result = (use.result && typeof use.result === 'object' ? use.result : {}) as Record<string, unknown>
  const patch = result.structuredPatch
  if (Array.isArray(patch) && patch.length) {
    let added = 0
    let removed = 0
    for (const hunk of patch) {
      const lines = (hunk as { lines?: unknown }).lines
      for (const l of Array.isArray(lines) ? lines : []) {
        if (typeof l !== 'string') continue
        if (l.startsWith('+')) added += 1
        else if (l.startsWith('-')) removed += 1
      }
    }
    return { path, added, removed, isNew: result.type === 'create' }
  }
  if (use.tool === 'Write') return { path, added: lineCount(use.input.content), removed: 0, isNew: result.type === 'create' }
  if (use.tool === 'MultiEdit' && Array.isArray(use.input.edits)) {
    let added = 0
    let removed = 0
    for (const e of use.input.edits as Record<string, unknown>[]) { added += lineCount(e.new_string); removed += lineCount(e.old_string) }
    return { path, added, removed, isNew: false }
  }
  return { path, added: lineCount(use.input.new_string), removed: lineCount(use.input.old_string), isNew: false }
}

/** Shells: their runs are "commands". Any other tool the engine does not know here (a Code Mode script, a polling tool, an MCP tool) is an "other action". */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'LS'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const HELPER_TOOLS = new Set(['Agent', 'Task'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])
/** In a script (Code Mode's REPL and the like): a shell call that only prints a file, or a file read. */
const ECHO_SCRIPT = /\$`\s*(?:cat|grep|rg|type|head|tail|less|more|echo|sed)\b|\b(?:readFile|readFileSync|Read)\s*\(/
const COMMIT_COMMAND = /\bgit\s+(?:-[-\w=./]+\s+)*commit\b/
const ECHO_COMMAND = /^\s*(?:cat|grep|rg|type|head|tail|less|more|echo|sed)\b/

/** The commit message in git's own answer to a commit: "[main abc1234] Fix rounding". */
export function commitSubject(output: string): string | null {
  const m = /^\[[^\]\n]+ [0-9a-f]{7,40}\] (.+)$/m.exec(stripAnsi(output))
  return m ? shortText(m[1] ?? '', 100) : null
}

/** The text a tool call printed, wherever the engine kept it; capped, because only the end of a long output holds test counts. */
export function outputOf(use: ToolUse): string {
  const r = use.result
  const fromResult = typeof r === 'string' ? r : r && typeof r === 'object'
    ? [(r as Record<string, unknown>).stdout, (r as Record<string, unknown>).text, (r as Record<string, unknown>).output].find((v): v is string => typeof v === 'string')
    : undefined
  const out = typeof use.text === 'string' && use.text !== '' ? use.text : (fromResult ?? '')
  return out.length > 200_000 ? out.slice(-200_000) : out
}

/** The command or script a call ran: its command, else its code or script text. */
export const commandOf = (use: ToolUse): string =>
  [use.input.command, use.input.code, use.input.script, use.input.cmd].find((v): v is string => typeof v === 'string') ?? ''

export type StepInput = {
  messages: Message[]
  /** When each call ended (tool_use_id to epoch ms), as far as it was seen. */
  times: Record<string, number>
  startedAt: number
  endedAt: number
  asked: string
}

/**
 * The timeline: what the main conversation did this turn, in order. Edits of one file are one step; runs of reads,
 * commands, helpers, web lookups and other actions are one step each. A call whose time was not seen gets an even share of the turn.
 */
export function buildSteps(input: StepInput): { steps: Step[]; tests: TestRun | null; testRuns: number; editedFiles: FileChange[] } {
  const uses = input.messages.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
  const span = Math.max(0, input.endedAt - input.startedAt)
  const steps: Step[] = [{ at: input.startedAt, kind: 'start', text: input.asked }]
  const byFile = new Map<string, Step>()
  let tests: TestRun | null = null
  let testRuns = 0
  const group = (kind: 'read' | 'command' | 'helper' | 'web' | 'other', at: number): Step => {
    const prev = steps[steps.length - 1]
    if (prev && prev.kind === kind) return prev
    const step: Step = { at, kind, n: 0, ...(kind === 'read' ? { m: 0 } : {}) }
    steps.push(step)
    return step
  }
  uses.forEach((use, i) => {
    const at = input.times[use.tool_use_id] ?? Math.round(input.startedAt + (span * (i + 1)) / (uses.length + 1))
    if (EDIT_TOOLS.has(use.tool)) {
      if (use.isError) return
      const s = editStats(use)
      if (!s) return
      const known = byFile.get(s.path)
      if (known) { known.added = (known.added ?? 0) + s.added; known.removed = (known.removed ?? 0) + s.removed; return }
      const step: Step = { at, kind: s.isNew ? 'create' : 'edit', file: s.path, added: s.added, removed: s.removed }
      byFile.set(s.path, step)
      steps.push(step)
    } else if (READ_TOOLS.has(use.tool) || SEARCH_TOOLS.has(use.tool)) {
      const step = group('read', at)
      if (READ_TOOLS.has(use.tool)) step.n = (step.n ?? 0) + 1
      else step.m = (step.m ?? 0) + 1
    } else if (HELPER_TOOLS.has(use.tool)) {
      const step = group('helper', at)
      step.n = (step.n ?? 0) + 1
    } else if (WEB_TOOLS.has(use.tool)) {
      const step = group('web', at)
      step.n = (step.n ?? 0) + 1
    } else {
      // A shell, or a tool this plugin does not know (Code Mode's script runner, a poller, an MCP tool): its printed output
      // may still hold test counts or a commit, and what is not one of those is counted as a command or an other action.
      const command = commandOf(use)
      const out = outputOf(use)
      const isCommit = COMMIT_COMMAND.test(command)
      const echoes = ECHO_COMMAND.test(command) || (!SHELL_TOOLS.has(use.tool) && ECHO_SCRIPT.test(command))
      const run = isCommit || echoes ? null : parseTestOutput(out)
      if (run) {
        tests = run
        testRuns += 1
        steps.push({ at, kind: 'test', test: run })
      } else if (isCommit && !use.isError && commitSubject(out) !== null) {
        steps.push({ at, kind: 'commit', text: commitSubject(out) ?? '' })
      } else {
        const step = group(SHELL_TOOLS.has(use.tool) ? 'command' : 'other', at)
        step.n = (step.n ?? 0) + 1
      }
    }
  })
  const editedFiles: FileChange[] = [...byFile.values()].map(s => ({ path: s.file ?? '', added: s.added ?? 0, removed: s.removed ?? 0, ...(s.kind === 'create' ? { isNew: true } : {}) }))
  return { steps: steps.slice(0, MAX_STEPS), tests, testRuns, editedFiles }
}

/** Puts the real per-file numbers (from version control) on the edit steps that name the same file. */
export function applyFileStats(steps: Step[], files: FileChange[] | null): Step[] {
  if (!files) return steps
  return steps.map(s => {
    if ((s.kind !== 'edit' && s.kind !== 'create') || !s.file) return s
    const file = s.file.replace(/\\/g, '/')
    const f = files.find(x => x.path === file || file.endsWith(`/${x.path}`))
    return f ? { ...s, added: f.added, removed: f.removed } : s
  })
}

/** Keeps a timeline within room rows: the first step, a "... N more steps" row and the newest steps. */
export function fitSteps(steps: Step[], room: number): { shown: Step[]; hidden: number } {
  if (steps.length <= room) return { shown: steps, hidden: 0 }
  if (room < 3) { const n = Math.max(0, room); return { shown: steps.slice(0, n), hidden: steps.length - n } }
  const tail = room - 2
  return { shown: [steps[0] as Step, ...steps.slice(steps.length - tail)], hidden: steps.length - 1 - tail }
}

// --- the summary text ---------------------------------------------------------------------------------------

export const baseName = (p: string) => stripControl(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || stripControl(p)

export function changesText(s: Pick<Summary, 'files' | 'filesApprox' | 'commitsMade'>, t: Strings): string {
  if (!s.files) return ''
  const tot = totals(s.files)
  const base = s.files.length === 0 ? t.noFilesChanged : (s.filesApprox ? t.changedFilesApprox : t.changedFiles)(tot.n, tot.added, tot.removed)
  return s.commitsMade > 0 ? `${base}, ${t.commitsMade(s.commitsMade)}` : base
}

/** The shared one-line summary: "✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s - started 14:02". */
export function oneLine(s: Summary, t: Strings): string {
  const mark = s.outcome === 'done' ? '✔' : s.outcome === 'stopped' ? '■' : '✖'
  const parts = [
    s.outcome === 'stopped' ? t.stopped : s.outcome === 'error' ? t.failed : '',
    changesText(s, t),
    s.tests ? t.testsShort(s.tests) : '',
    formatDuration(s.durationMs, t),
    t.started(clockTime(s.startedAt)),
  ].filter(Boolean)
  return `${mark} ${parts.join(' - ')}`
}

/** "src/cart/checkout.ts +22/-5". */
export function fileText(f: FileChange, t: Strings): string {
  const counts = f.isBinary ? t.binaryFile : f.isNew && !f.added ? t.newFile : `+${f.added}/-${f.removed}`
  return `${stripControl(f.path)} ${counts}`
}

/** "a1b2c3d Fix cart rounding": a commit as one clean line. */
export const commitText = (c: Commit): string => `${stripControl(c.hash)} ${shortText(c.subject, 120)}`

/** The text of a step for the timeline (without the clock time and the line counts). */
export function stepText(step: Step, t: Strings): string {
  switch (step.kind) {
    case 'start': return t.stepStart(shortText(step.text ?? '', 60))
    case 'read': return t.stepRead(step.n ?? 0, step.m ?? 0)
    case 'edit': return t.stepEdit(baseName(step.file ?? ''))
    case 'create': return t.stepCreate(baseName(step.file ?? ''))
    case 'test': return step.test ? t.stepTest(step.test) : ''
    case 'commit': return t.stepCommit(step.text ?? '')
    case 'command': return t.stepCommand(step.n ?? 1)
    case 'helper': return t.stepHelper(step.n ?? 1)
    case 'other': return t.stepOther(step.n ?? 1)
    default: return t.stepWeb(step.n ?? 1)
  }
}

/** The plain-text summary /turn prints. */
export function summaryText(s: Summary, t: Strings, maxFiles: number): string {
  const lines = [
    `${t.title} (${t.range(clockTime(s.startedAt), clockTime(s.endedAt))}, ${formatDuration(s.durationMs, t)})`,
    s.what ? t.textDone(s.what) : t.textRequest(s.asked || t.noAnswer),
    oneLine(s, t),
  ]
  if (s.files && s.files.length) {
    for (const f of s.files.slice(0, maxFiles)) lines.push(`  ${fileText(f, t)}`)
    if (s.files.length > maxFiles) lines.push(`  ${t.moreFiles(s.files.length - maxFiles)}`)
  }
  if (s.tests) lines.push(t.testsLong(s.tests, s.testRuns))
  if (s.unpushed && s.unpushed.count > 0) lines.push(`⚠ ${t.unpushed(s.unpushed.count, s.unpushed.upstream)}. ${t.textUnpushedFooter}`)
  return lines.join('\n')
}

// --- layout -------------------------------------------------------------------------------------------------

export type Mode = 'card' | 'timeline' | 'line' | 'line1' | 'none'
export type Plan = {
  mode: Mode
  /** File rows drawn (card, and the open list of the line). */
  files: number
  /** Timeline rows drawn, the "more steps" row not included. */
  steps: number
  /** Rows the whole draw takes, never above the rows given. */
  rows: number
}

export type PlanInput = { rows: number; cols: number; style: Style; expanded: boolean; maxFiles: number }

/** Rows a row of buttons takes in width cells ("[ label ]" is the label plus four cells, a gap of one between them). */
export function buttonRows(labels: string[], width: number): number {
  let rows = 1
  let used = 0
  for (const l of labels) {
    const w = textCells(l) + 4
    if (used > 0 && used + 1 + w > width) { rows += 1; used = w } else used += (used > 0 ? 1 : 0) + w
  }
  return rows
}

const hasUnpushed = (s: Summary) => !!s.unpushed && s.unpushed.count > 0
const unpushedLine = (s: Summary, t: Strings) => `⚠ ${t.unpushed(s.unpushed?.count ?? 0, s.unpushed?.upstream ?? null)}`

/** The buttons under the card or timeline, in order. */
export const cardButtons = (s: Summary, t: Strings): string[] => [
  ...(hasUnpushed(s) ? [t.buttons.push, t.buttons.commits] : []),
  t.buttons.details, t.buttons.hide,
]

/** Rows of the card with n file rows. Counts every wrapped line on the wide side so the draw never passes the rows given. */
export function cardRows(s: Summary, cols: number, files: number, t: Strings): number {
  const inner = Math.max(1, cols - 4)
  let rows = 2 // border
  rows += 1 // title
  rows += 1 + wrapRows(s.what || (s.asked ? t.asked(s.asked) : t.noAnswer), inner) // Done
  if (s.files) {
    rows += 1 + wrapRows(changesText(s, t), inner)
    const shown = Math.min(files, s.files.length)
    rows += shown * 1 + (s.files.length > shown && shown > 0 ? 1 : 0)
  }
  if (s.tests) rows += 1 + wrapRows(t.testsLong(s.tests, s.testRuns), inner)
  rows += 1 + wrapRows(`${formatDuration(s.durationMs, t)} - ${t.started(clockTime(s.startedAt))}`, inner)
  if (hasUnpushed(s)) rows += wrapRows(unpushedLine(s, t), inner)
  rows += buttonRows(cardButtons(s, t), inner)
  return rows
}

/** Longest a file row may be in the card: path, then the counts. Both go on one row; a longer row is cut. */
export const FILE_ROW_PAD = 14

/** Rows of the timeline for the given steps (with a "more steps" row when hidden > 0). */
export function timelineRows(s: Summary, cols: number, steps: Step[], hidden: number, t: Strings): number {
  const width = Math.max(1, cols - 2)
  let rows = wrapRows(oneLine(s, t), width)
  rows += steps.length // one row each, cut at the width
  if (hidden > 0) rows += 1
  if (hasUnpushed(s)) rows += wrapRows(unpushedLine(s, t), width)
  rows += buttonRows(cardButtons(s, t), width)
  rows += 1 // the end line
  return rows
}

/**
 * Chooses what to draw in rows x cols: the person's style when it fits (a card gives up file rows before it gives up),
 * then the one-line summary with a warning row and, when opened, the file list; then a single line. Never more rows
 * than given.
 */
export function planBand(s: Summary, input: PlanInput, t: Strings): Plan {
  const { rows, cols } = input
  if (rows < 1) return { mode: 'none', files: 0, steps: 0, rows: 0 }
  const fileCount = s.files ? s.files.length : 0
  if (rows >= 6 && cols >= 28) {
    if (input.style === 'card') {
      for (let files = Math.min(input.maxFiles, fileCount); files >= 0; files -= 1) {
        const r = cardRows(s, cols, files, t)
        if (r <= rows) return { mode: 'card', files, steps: 0, rows: r }
      }
    } else {
      for (let room = Math.min(s.steps.length, MAX_STEPS); room >= 1; room -= 1) {
        const { shown, hidden } = fitSteps(s.steps, room)
        const r = timelineRows(s, cols, shown, hidden, t)
        if (r <= rows) return { mode: 'timeline', files: 0, steps: room, rows: r }
      }
    }
  }
  if (rows >= 2) {
    const base = 1 + (hasUnpushed(s) ? 1 : 0)
    const wanted = input.expanded ? Math.min(input.maxFiles, fileCount) : 0
    let open = Math.max(0, Math.min(wanted, rows - base))
    if (open > 0 && open < fileCount && base + open + 1 > rows) open -= 1
    const total = base + open + (open > 0 && open < fileCount ? 1 : 0)
    return { mode: 'line', files: open, steps: 0, rows: total }
  }
  return { mode: 'line1', files: 0, steps: 0, rows: 1 }
}

// --- doctor -------------------------------------------------------------------------------------------------

export type Level = 'PASS' | 'WARN'
export type Line = { level: Level; name: string; detail: string; fix?: string }

/** "PASS name - detail" or "WARN name - detail Fix: hint", on one line. */
export function formatLine(line: Line, fixLabel = 'Fix:'): string {
  const base = `${line.level} ${line.name} - ${line.detail.replace(/\s+/g, ' ').trim()}`
  return line.level === 'PASS' || !line.fix ? base : `${base} ${fixLabel} ${line.fix.replace(/\s+/g, ' ').trim()}`
}
