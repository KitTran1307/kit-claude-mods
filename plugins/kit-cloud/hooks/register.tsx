// kit-cloud: which Claude Code cloud sessions are working, above the prompt.
// cloud-pilot (the kit-cloud-pilot plugin: Node + the gh CLI) is the only part that talks to GitHub, for every session
// of every account on this machine; this module reads the hub's state.json, starts the hub through its CLI and draws. Collapsed band = one
// summary line (click to expand); expanded = one line per session with its link.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CloudRow } from '../types'
import { STRINGS, changeText, languageFromSetting, languageOption } from './i18n'
import type { LanguageOption, Strings } from './i18n'
import { GROUP_COLOR, MAX_TEXT, accountName, checkLine, cleanText, flagValue, olderThan, pilotLacks, prNumber, parseQuestions, rowIdAt, safeUrl, agoText, asideNote, bandPlan, changes, fit, fromHub, ghSlug, githubNote, groupDot, headerFit, headline, inScope, markOf, rowLayout, wrappedRows, parseCommand, queueFileName, queueHasEvents, shortTitle, snapshot, staleNote, table, waiterNote, wakeBatch } from './status'
import type { BandLine, Check, HubRow, PilotQuestion, Scope, ScopeMode, Snapshot } from './status'

const rows = atom({ plugin: 'kit-cloud', key: 'rows' } as const, [] as CloudRow[], { shape: 'rows-1' })
const expanded = atom({ plugin: 'kit-cloud', key: 'expanded' } as const, false)
const updatedAt = atom({ plugin: 'kit-cloud', key: 'updatedAt' } as const, 0)
const lastError = atom({ plugin: 'kit-cloud', key: 'error' } as const, '')
const stale = atom({ plugin: 'kit-cloud', key: 'stale' } as const, '')
const noWaiter = atom({ plugin: 'kit-cloud', key: 'noWaiter' } as const, '')
const ghProblem = atom({ plugin: 'kit-cloud', key: 'ghProblem' } as const, '')

const REFRESH_MS = 30_000 // a file read: cheap

type Settings = {
  scope: ScopeMode
  autoWatch: boolean
  showBand: boolean
  notifications: boolean
  notifyInSession: boolean
  wakeSession: boolean
  deleteMergedBranches: boolean
  language: LanguageOption
}

export function settingsFrom(options: PluginOptions | undefined): Settings {
  const o = options ?? {}
  const scope = o.scope === 'repo' || o.scope === 'all' ? o.scope : 'account+repo'
  const flag = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt)
  return {
    scope,
    autoWatch: flag(o.autoWatch, true),
    showBand: flag(o.showBand, true),
    notifications: flag(o.notifications, true),
    notifyInSession: flag(o.notifyInSession, true),
    wakeSession: flag(o.wakeSession, true),
    deleteMergedBranches: flag(o.deleteMergedBranches, false),
    language: languageOption(o.language),
  }
}

let settings = settingsFrom(undefined)
let scope: Scope | null = null
let slug = ''
let statePath = ''
/** The words in the chosen language: English until session.start has read the setting. */
let t: Strings = STRINGS.en
/** How each in-scope session looked at the last refresh; null until the first one, which only seeds it. */
let previous: Map<string, Snapshot> | null = null

/** The `language` option, or Claude Code's own `language` setting when it is auto; any failure is English. */
async function pickLanguage($: EngineInterface): Promise<Strings> {
  if (settings.language !== 'auto') return STRINGS[settings.language]
  try {
    return STRINGS[languageFromSetting(await $.settings.read({ key: 'language' }))]
  } catch {
    return STRINGS.en
  }
}

const clean = (v: string | undefined) => (v ?? '').trim()
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')

/** cloud-pilot's data folder: CLOUD_PILOT_DIR, the older KIT_HUB_DIR, else ~/.claude/cloud-pilot (its own rule). */
async function hubDir($: EngineInterface): Promise<string> {
  const dir = clean(await $.env.get('CLOUD_PILOT_DIR')) || clean(await $.env.get('KIT_HUB_DIR'))
  if (dir) return trimSlash(dir)
  // Node's os.homedir(): USERPROFILE on Windows (where HOME may be a Git Bash path), HOME elsewhere.
  const home = clean(await $.env.get('USERPROFILE')) || clean(await $.env.get('HOME'))
  return `${trimSlash(home)}/.claude/cloud-pilot`
}

export const INSTALL_PILOT = STRINGS.en.installPilot

/** The cloud-pilot CLI, from the install.json the kit-cloud-pilot plugin writes when it loads; '' when not installed. */
async function pilotCli($: EngineInterface): Promise<string> {
  try {
    const file = `${await hubDir($)}/install.json`
    if (!(await $.fs.exists(file))) return ''
    const cli = (JSON.parse(String(await $.fs.read(file))) as { cli?: unknown }).cli
    return typeof cli === 'string' && /cloud-pilot\.mjs$/.test(cli) ? cli : ''
  } catch {
    return ''
  }
}

/** The kit-cloud-pilot version from install.json, '' when it does not say. */
async function pilotVersion($: EngineInterface): Promise<string> {
  try {
    const v = (JSON.parse(String(await $.fs.read(`${await hubDir($)}/install.json`))) as { version?: unknown }).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v.trim()) ? v.trim().slice(0, 30) : ''
  } catch {
    return ''
  }
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return '' // no git on this machine
  }
}

async function findScope($: EngineInterface, cwd: string): Promise<Scope> {
  const repoRoot = (await git($, cwd, ['rev-parse', '--show-toplevel'])) || cwd
  slug = ghSlug(await git($, cwd, ['remote', 'get-url', 'origin']))
  return {
    account: accountName(clean(await $.env.get('CLAUDE_CONFIG_DIR'))),
    repoRoot,
    slug,
    repo: trimSlash(repoRoot).split(/[\\/]/).pop() ?? '',
  }
}

/** Runs the cloud-pilot CLI as this session; resolves its one JSON line, or { ok:false, message } when it cannot run. */
async function hub($: EngineInterface, args: string[]): Promise<Record<string, unknown>> {
  const cli = await pilotCli($)
  if (!cli) return { ok: false, missing: true, message: t.installPilot }
  // CLOUD_PILOT_DIR always: cloud-pilot and this module then agree on the folder whatever HOME says.
  const env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: await $.session.id(), CLOUD_PILOT_DIR: await hubDir($) }
  if (!settings.notifications) env.CLOUD_PILOT_NOTIFY = '0'
  if (settings.deleteMergedBranches) env.CLOUD_PILOT_DELETE_MERGED = '1'
  try {
    const r = await $.process.run(['node', cli, ...args], {
      cwd: scope?.repoRoot, env, timeoutMs: 30_000,
    })
    const line = r.stdout.trim().split(/\r?\n/).pop() ?? ''
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.exitCode}` }
    }
  } catch (err) {
    return { ok: false, message: t.nodeFailed((err as Error).message) }
  }
}

type HubFile = { rows: HubRow[]; polledMs?: number; waiting?: string[]; queued?: Record<string, number>; errors?: Record<string, unknown>; accounts?: Record<string, unknown> }

async function readHub($: EngineInterface): Promise<HubFile> {
  if (!statePath) statePath = `${await hubDir($)}/state.json`
  if (!(await $.fs.exists(statePath))) return { rows: [] }
  const parsed = JSON.parse(String(await $.fs.read(statePath))) as { rows?: unknown; hub?: { polledMs?: number }; waiting?: unknown; queued?: unknown; errors?: unknown; accounts?: unknown }
  const list = Array.isArray(parsed?.rows) ? (parsed.rows as HubRow[]) : []
  return {
    rows: list.filter(r => r && typeof r === 'object' && r.kind === 'branch' && typeof r.id === 'string'),
    polledMs: typeof parsed?.hub?.polledMs === 'number' ? parsed.hub.polledMs : undefined,
    waiting: Array.isArray(parsed?.waiting) ? parsed.waiting.filter((x): x is string => typeof x === 'string') : undefined,
    queued: parsed?.queued && typeof parsed.queued === 'object' ? (parsed.queued as Record<string, number>) : undefined,
    errors: parsed?.errors && typeof parsed.errors === 'object' ? (parsed.errors as Record<string, unknown>) : undefined,
    accounts: parsed?.accounts && typeof parsed.accounts === 'object' ? (parsed.accounts as Record<string, unknown>) : undefined,
  }
}

/**
 * Reads the hub's state into the band. `timer`: the 30 s tick, the only caller that may hand events to Claude (a
 * prompt submitted from a command or the session's start would wait on the very turn that hook holds).
 */
async function refresh($: EngineInterface, timer = false): Promise<void> {
  try {
    const file = await readHub($)
    const mine = scope ? file.rows.filter(r => inScope(r, scope!, settings.scope)) : file.rows
    const nowMs = await $.clock.now()
    const list = mine.map(fromHub)
    // Before any further await: a timer refresh and a command's refresh must not both announce the same change.
    const happened = changes(previous, list)
    previous = snapshot(list)
    await update($, rows, () => list)
    await update($, stale, () => staleNote(file.polledMs, nowMs, mine.some(r => r.active), t))
    const sid = await $.session.id()
    const note = waiterNote(file.rows, sid, file.waiting, file.queued, t)
    // With wakeSession this plugin is the waiter once cloud-pilot's take has answered: no wait needs to run. The note
    // asks for one when take is missing (an old cloud-pilot) or never answered.
    if (timer && settings.wakeSession && interactive) await wake($, sid, Boolean(note) && takeWorks === null)
    await update($, noWaiter, () => (settings.wakeSession && takeWorks ? '' : note))
    // The first of this band's repos whose last poll failed, said plainly (sign in, install gh, offline...).
    const failing = [...new Set(mine.filter(r => r.active).map(r => r.repo))].map(repo => file.errors?.[repo]).find(Boolean)
    // A GitHub poll failing here first; else this account set aside by cloud-pilot (its sessions cannot push).
    await update($, ghProblem, () => githubNote(failing, t) || asideNote(file.accounts, scope?.account, t))
    if (settings.notifyInSession) announce($, happened)
    await update($, lastError, () => '')
    await update($, updatedAt, () => nowMs)
  } catch (e) {
    // A half-written or unreadable file keeps the last good rows; /cloud shows the reason.
    await update($, lastError, () => (e as Error).message)
  }
}

let waking = false
/** Whether cloud-pilot's `take` answers here: null until asked, false for an old cloud-pilot without it. */
let takeWorks: boolean | null = null
/** The queue file as it stood when take last found nothing of this session's (only watch-found events): skip it. */
let idleQueue = ''
/** Events taken but not yet handed to Claude (a refused prompt, or more than one message holds). */
let pending: unknown[] = []
let toldPending = false
/** False for a session with no person at the prompt (claude -p, an SDK host): it is never woken. */
let interactive = true

/**
 * Hands Claude in this session the events cloud-pilot queued for it (sessions it started: a question, a PR, a merge,
 * a CI failure, silence, nothing pushed) as a prompt from this plugin, run once the session is idle. Without it Claude
 * hears of them only while a `cloud-pilot wait` runs, and that wait ends after each batch. The queue file is read
 * first, so an empty queue costs one small file read per refresh and no process. Events taken but not delivered are
 * kept and sent again on the next refresh.
 */
async function wake($: EngineInterface, sid: string, probe: boolean): Promise<void> {
  if (waking || !sid || takeWorks === false) return
  waking = true
  try {
    if (!pending.length) {
      const file = `${await hubDir($)}/queue/${queueFileName(sid)}`
      const text = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
      if (!probe && (!queueHasEvents(text) || text === idleQueue)) return
      const r = await hub($, ['take'])
      if (r.missing) return
      takeWorks = r.status === 'events' || r.status === 'settling' || r.status === 'empty'
      if (r.status === 'empty') idleQueue = text
      if (r.status !== 'events' || !Array.isArray(r.events)) return
      pending = r.events
      toldPending = false
    }
    const { text, rest } = wakeBatch(pending)
    const sent = await Promise.resolve($.prompt.submit({ text })).catch((err: unknown) => ({ drop: String(err) })) as { drop?: string } | undefined
    if (sent && typeof sent.drop === 'string') {
      $.ui.log(`kit-cloud: cloud news not handed to Claude yet (${sent.drop}); trying again`, { to: 'debug' })
      if (!toldPending) {
        toldPending = true
        const kinds = [...new Set(pending.map(e => String((e as { kind?: unknown })?.kind ?? '?')))].join(', ')
        try { $.ui.toast(`☁ ${t.wakeFailed(kinds)}`) } catch { /* nowhere to show it */ }
      }
      return
    }
    pending = rest
  } catch (err) {
    $.ui.log(`kit-cloud: wake failed: ${String(err)}`, { to: 'debug' })
  } finally {
    waking = false
  }
}

/** A toast and a system notification for each change: the hub only notifies when no Claude session is open. */
function announce($: EngineInterface, happened: ReturnType<typeof changes>): void {
  for (const { row, kind } of happened) {
    const text = changeText(t, kind, row)
    try {
      $.ui.toast(`☁ ${text}`)
      Promise.resolve($.ui.notify(text, { title: t.notifyTitle })).catch(() => undefined)
    } catch {
      // A surface with nowhere to show it: the band still tells.
    }
  }
}

function needRepo(): string {
  return slug ? '' : t.noOrigin
}

/** The questions listed by the last /cloud questions, in the order shown; null until one was run. */
let lastQuestions: PilotQuestion[] | null = null

function questionLines(q: PilotQuestion, n: number): string[] {
  const head = `${n}. ${t.questionPr(q.pr)}: ${q.text}${q.who ? ` (${q.who})` : ''}${q.edited ? ` (${t.questionEdited})` : ''}${q.id && q.sha ? '' : ` [${t.questionNoAnswer}]`}`
  return q.url ? [head, `   ${q.url}`] : [head]
}

/** Asks cloud-pilot for the open questions of each tracked PR of this repo; `text` is set when nothing more can be said. */
async function gatherQuestions($: EngineInterface): Promise<{ list: PilotQuestion[]; notes: string[]; text?: string }> {
  const none = { list: [] as PilotQuestion[], notes: [] as string[] }
  let file: HubFile
  try {
    file = await readHub($)
  } catch (err) {
    return { ...none, text: t.stateUnreadable((err as Error).message) }
  }
  const prs = [...new Set(file.rows.filter(r => String(r.repo).toLowerCase() === slug.toLowerCase()).map(prNumber).filter(n => n > 0))].slice(0, 10)
  if (!prs.length) return { ...none, text: t.questionsNoPrs }
  const list: PilotQuestion[] = []
  const notes: string[] = []
  for (const pr of prs) {
    const r = await hub($, ['questions', '--repo', slug, '--pr', String(pr)])
    if (r.missing) return { ...none, text: t.installPilot }
    if (pilotLacks(r)) return { ...none, text: t.pilotTooOld('questions') }
    if (r.status !== 'ok') { notes.push(t.questionsFailed(pr, cleanText(String(r.message ?? r.error ?? t.unknownError), 120))); continue }
    list.push(...parseQuestions(r, pr))
  }
  return { list, notes }
}

/** What Claude Code version runs this: the engine's own answer, else `claude --version`; '' when neither says. */
async function claudeVersion($: EngineInterface): Promise<string> {
  try {
    const v = (await $.session.version())?.version
    if (typeof v === 'string' && /\d+\.\d+\.\d+/.test(v)) return v
  } catch { /* an engine without it: ask the CLI */ }
  try {
    const r = await $.process.run(['claude', '--version'], { timeoutMs: 5000 })
    return r.exitCode === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? '' : ''
  } catch {
    return ''
  }
}

/** The oldest Claude Code this plugin is meant for, and the first kit-cloud-pilot with nudge, questions and reply. */
export const MIN_CLAUDE = '2.1.292'
export const MIN_PILOT = '1.7.0'
const LOCK_STALE_MS = 10 * 60_000

/** One check per line of /cloud doctor. Reads files only (never their contents beyond JSON validity), changes nothing. */
async function doctorChecks($: EngineInterface): Promise<Check[]> {
  const d = t.doc
  const out: Check[] = []
  const version = (v: unknown) => (typeof v === 'string' && /^v?\d+(\.\d+)*$/.test(v.trim()) ? ` ${v.trim().replace(/^v/, '')}` : '')
  const cli = await pilotCli($)
  const pilotV = cli ? await pilotVersion($) : ''
  out.push(cli
    ? { level: 'PASS', name: 'kit-cloud-pilot', detail: d.pilot(pilotV) }
    : { level: 'FAIL', name: 'kit-cloud-pilot', detail: d.pilotMissing, fix: d.pilotFix })

  // The hub's own checks. Problems it lists keep their own words.
  const r = cli ? await hub($, ['doctor']) : null
  const problems = r && r.ok !== true ? (Array.isArray(r.problems) ? (r.problems as unknown[]).map(String) : [String(r.message ?? t.doctorUnknown)]) : []
  const has = (re: RegExp) => problems.filter(p => re.test(p))
  const nodeBad = has(/node|spawn|ENOENT|did not run/i)
  const ghBad = has(/\bgh\b/i)
  const ghOut = ghBad.filter(p => /sign|auth|login|token/i.test(p))
  const ghGone = ghBad.filter(p => !ghOut.includes(p))
  const rest = problems.filter(p => !nodeBad.includes(p) && !ghBad.includes(p))
  if (!r) {
    for (const name of ['node', 'gh', 'gh login']) out.push({ level: 'WARN', name, detail: d.notChecked, fix: d.pilotFix })
  } else if (r.ok === true) {
    out.push({ level: 'PASS', name: 'node', detail: d.node(version(r.node).trim() || '') .trim() })
    out.push({ level: 'PASS', name: 'gh', detail: d.ghFound(version(r.gh).trim()).trim() })
    out.push({ level: 'PASS', name: 'gh login', detail: d.ghIn })
  } else {
    out.push(nodeBad.length
      ? { level: 'WARN', name: 'node', detail: `${d.nodeMissing}: ${nodeBad.join('; ')}`, fix: d.nodeFix }
      : { level: 'PASS', name: 'node', detail: d.node('').trim() })
    if (nodeBad.length) {
      out.push({ level: 'WARN', name: 'gh', detail: d.notChecked, fix: d.nodeFix })
      out.push({ level: 'WARN', name: 'gh login', detail: d.notChecked, fix: d.nodeFix })
    } else {
      out.push(ghGone.length ? { level: 'WARN', name: 'gh', detail: `${d.ghMissing}: ${ghGone.join('; ')}`, fix: d.ghFix } : { level: 'PASS', name: 'gh', detail: d.ghFound('').trim() })
      out.push(ghOut.length ? { level: 'WARN', name: 'gh login', detail: `${d.ghOut}: ${ghOut.join('; ')}`, fix: d.ghOutFix } : ghGone.length ? { level: 'WARN', name: 'gh login', detail: d.notChecked, fix: d.ghFix } : { level: 'PASS', name: 'gh login', detail: d.ghIn })
    }
    for (const p of rest) out.push({ level: 'WARN', name: 'cloud-pilot', detail: d.hubOther(p), fix: d.hubOtherFix })
  }
  const dir = typeof r?.dir === 'string' && r.dir ? r.dir : await hubDir($)
  out.push({ level: 'PASS', name: 'data folder', detail: d.data(dir) })
  if (r?.ok === true) out.push({ level: 'PASS', name: 'hub', detail: r.running ? d.hubRunning : d.hubIdle })

  // Claude Code itself.
  const cv = await claudeVersion($)
  out.push(!cv
    ? { level: 'WARN', name: 'Claude Code', detail: d.claudeUnknown }
    : olderThan(cv, MIN_CLAUDE)
      ? { level: 'WARN', name: 'Claude Code', detail: d.claudeOld(cv, MIN_CLAUDE), fix: d.claudeFix }
      : { level: 'PASS', name: 'Claude Code', detail: d.claude(cv, MIN_CLAUDE) })

  // nudge, questions and reply need kit-cloud-pilot 1.7.0: nothing probes it without side effects, so the version says.
  if (cli) {
    out.push(pilotV && olderThan(pilotV, MIN_PILOT)
      ? { level: 'WARN', name: 'nudge', detail: d.nudgeOld(pilotV, MIN_PILOT), fix: d.nudgeFix }
      : { level: 'PASS', name: 'nudge', detail: pilotV ? d.nudgeOk(pilotV) : d.nudgeLater })
  }

  // The hub's files: the state file must parse; lock files older than 10 minutes are named, never deleted.
  try {
    const file = `${dir}/state.json`
    if (!(await $.fs.exists(file))) out.push({ level: 'PASS', name: 'hub files', detail: d.stateNone })
    else {
      JSON.parse(String(await $.fs.read(file)))
      out.push({ level: 'PASS', name: 'hub files', detail: d.stateOk })
    }
  } catch {
    out.push({ level: 'FAIL', name: 'hub files', detail: d.stateBad, fix: d.stateFix })
  }
  try {
    const entries = await $.fs.list(dir)
    const now = await $.clock.now()
    const old = (Array.isArray(entries) ? entries : []).filter(e => e.kind === 'file' && /\.lock$/i.test(String(e.name)) && now - Number(e.mtimeMs) > LOCK_STALE_MS).map(e => cleanText(e.name, 60))
    out.push(old.length
      ? { level: 'WARN', name: 'lock files', detail: d.lockStale(old.length, old.slice(0, 5).join(', ')), fix: d.lockFix }
      : { level: 'PASS', name: 'lock files', detail: d.lockNone })
  } catch {
    out.push({ level: 'PASS', name: 'lock files', detail: d.lockNone })
  }

  // Settings that change what shows.
  out.push(settings.showBand
    ? { level: 'PASS', name: 'band', detail: d.bandOn(settings.scope) }
    : { level: 'WARN', name: 'band', detail: d.bandOff(settings.scope), fix: d.bandFix })
  out.push(settings.notifications
    ? { level: 'PASS', name: 'notifications', detail: d.notifyOn }
    : { level: 'WARN', name: 'notifications', detail: d.notifyOff, fix: d.notifyFix })
  return out
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseCommand(args, t)
  const nowEpoch = Math.floor((await $.clock.now()) / 1000)
  const warn = (s: string) => (s ? `\n⚠ ${s}.` : '')
  const failed = (r: Record<string, unknown>) => t.pilotFailed(cleanText(String(r.message ?? t.unknownError), 200))
  switch (cmd.verb) {
    case 'help':
      return (cmd.error ? `${cmd.error}\n\n` : '') + t.usage
    case 'doctor':
      return (await doctorChecks($)).map(checkLine).join('\n')
    case 'nudge': {
      let id = cmd.target
      if (/^\d{1,3}$/.test(id)) {
        await refresh($)
        id = rowIdAt(await read($, rows), Number(id))
        if (!id) return t.rowNotFound(Number(cmd.target))
      }
      // The text is one argv element after --text, never through a shell.
      const r = await hub($, ['nudge', '--id', id, ...(cmd.text ? ['--text', flagValue(cmd.text.slice(0, MAX_TEXT))] : [])])
      if (r.missing) return t.installPilot
      if (typeof r.sent === 'boolean') {
        if (r.sent) {
          const url = safeUrl(r.session_url)
          // Name what was nudged, so a wrong pick is visible at once.
          const hit = (await read($, rows)).find(x => x.id === id)
          const title = cleanText(hit ? shortTitle(hit.title, hit.repo) : '?', 60)
          return url ? t.nudgeSent(url, title, id) : t.nudgeSentNoUrl(title, id)
        }
        return t.nudgeNotSent(cleanText(String(r.reason ?? '').replace(/_+/g, ' '), 200) || t.unknownError)
      }
      return pilotLacks(r) ? t.pilotTooOld('nudge') : failed(r)
    }
    case 'questions': {
      if (needRepo()) return needRepo()
      const g = await gatherQuestions($)
      if (g.text) return g.text
      lastQuestions = g.list
      if (g.list.length === 0) return g.notes.join('\n') || t.questionsNone(slug)
      return [t.questionsHead(g.list.length, slug), t.untrustedNote, ...g.list.flatMap((q, i) => questionLines(q, i + 1)), ...g.notes].join('\n')
    }
    case 'reply': {
      if (needRepo()) return needRepo()
      if (lastQuestions === null) return t.replyRunQuestions
      const q = lastQuestions[cmd.n - 1]
      if (!q) return t.replyNoQuestion(cmd.n, lastQuestions.length)
      if (!q.id || !q.sha) return t.replyNotAnswerable(cmd.n)
      const r = await hub($, ['answer', '--repo', slug, '--pr', String(q.pr), '--id', q.id, '--question-sha256', q.sha, '--answer', flagValue(cmd.text)])
      if (r.missing) return t.installPilot
      if (pilotLacks(r)) return t.pilotTooOld('reply')
      if (r.status === 'error' || r.status === 'usage') return t.replyFailed(cleanText(String(r.message ?? t.unknownError), 200))
      if (r.status !== 'posted') return t.replyUnknown
      lastQuestions = null // answered: the next list is read again
      return t.replySent(cmd.n, q.pr, cleanText(q.text, 80), t.untrustedNote)
    }
    case 'watch': case 'unwatch': {
      if (needRepo()) return needRepo()
      const r = await hub($, [cmd.verb, '--repo', slug])
      if (r.ok !== true) return failed(r)
      return cmd.verb === 'watch' ? t.watching(slug) : t.unwatched(slug, Number(r.stopped ?? 0))
    }
    case 'track': {
      if (needRepo()) return needRepo()
      const r = await hub($, ['track', '--repo', slug, ...(cmd.branch ? ['--branch', cmd.branch] : []), ...(cmd.url ? ['--url', cmd.url] : [])])
      if (r.ok !== true) return failed(r)
      await refresh($)
      return t.tracking(cmd.branch || cmd.url, slug, String(r.id)) + (cmd.branch ? '' : t.trackNoBranch)
    }
    case 'untrack': {
      const r = await hub($, ['untrack', '--id', cmd.id])
      if (r.ok !== true) return t.untrackMissing(cmd.id)
      await refresh($)
      return t.untracked(cmd.id)
    }
    case 'list': {
      if (cmd.all) {
        try {
          const file = await readHub($)
          return table(file.rows.map(fromHub), nowEpoch, t.everyAccount, t) + warn(staleNote(file.polledMs, nowEpoch * 1000, file.rows.some(r => r.active), t))
        } catch (err) {
          return t.stateUnreadable((err as Error).message)
        }
      }
      await refresh($)
      const where = scope ? (settings.scope === 'repo' ? scope.repo : settings.scope === 'all' ? t.everyAccount : `${scope.account} · ${scope.repo}`) : ''
      const err = await read($, lastError)
      return table(await read($, rows), nowEpoch, where, t) + '\n' + t.listFooter
        + warn(await read($, stale)) + warn(await read($, noWaiter)) + warn(await read($, ghProblem)) + (err ? `\n(${t.stateUnreadable(err)})` : '')
    }
  }
}

/**
 * Starts the repo's watch. kit-cloud-pilot writes install.json when it loads, so on the first session after an install
 * it may load after this plugin: then the CLI is not known yet, and one retry a few seconds later finds it.
 */
async function startWatch($: EngineInterface, repo: string): Promise<void> {
  try {
    const first = await hub($, ['watch', '--repo', repo])
    if (!first.missing) return
    await $.clock.sleep(5000)
    await hub($, ['watch', '--repo', repo])
  } catch (err) {
    $.ui.log(`kit-cloud: watch not started: ${String(err)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    try {
      previous = null // the first refresh below only seeds it: a reload never replays old events
      interactive = (e as { isInteractive?: boolean }).isInteractive !== false
      takeWorks = null
      idleQueue = ''
      lastQuestions = null
      pending = [] // a new session (or /clear): what the last one could not hand over was its own
      t = await pickLanguage($)
      await $.command.register({ name: 'cloud', description: t.commandDescription, argumentHint: '[all | track <url> [branch] | untrack <id> | nudge <n|id> [text] | questions | reply <n> <text> | watch | unwatch | doctor | help]' })
      scope = await findScope($, e.cwd)
      await refresh($)
      $.clock.every(REFRESH_MS, () => { refresh($, true).catch(() => undefined) })
      // Watching asks GitHub through gh; a missing node or gh only means no watch (see /cloud doctor). Not awaited:
      // a slow node or disk never holds the session's start.
      if (settings.autoWatch && slug) void startWatch($, slug)
    } catch (err) {
      await update($, lastError, () => (err as Error).message)
    }
    return next(e)
  })

  on('command.run', { command: 'cloud' }, async ($, e) => ({ text: await runCommand($, String(e.args ?? '')) }))

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked, so several bands show together. A part that passes hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let passed = false
    const pass = (x: typeof e) => { passed = true; return next(x) }
    const { tree: mine, used } = await ownBand($, e, pass)
    if (passed) return mine
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - used) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
}

/** The band's own name for where its sessions are: the repo, unless it shows every repo. */
function scopeLabel(list: CloudRow[]): string {
  const repos = new Set(list.map(r => r.repo))
  return repos.size === 1 ? [...repos][0]! : ''
}

/** Lines of the open band under its header, kept under half a short terminal. */
const BAND_LINES = 10

/** The open band's lines under its header and note, in the rows Claude Code gives the band; none while folded. */
async function openPlan($: EngineInterface, e: any, list: CloudRow[], noteRows: number): Promise<BandLine[]> {
  if (!(await read($, expanded))) return []
  const room = Math.min(BAND_LINES, Math.max(2, (Number(e.props.maxRows) || 20) - 1 - noteRows))
  return bandPlan(list, room)
}

async function ownBand($: EngineInterface, e: any, next: (x: any) => Promise<any>) {
  const list = await read($, rows)
  if (!settings.showBand || e.props.hasSurvey || list.length === 0) return { tree: await next(e), used: 0 }
  const { Box, Button, Link, Text } = $.ui.resolve(e)
  const isOpen = await read($, expanded)
  // Something wrong with the hub or GitHub: one note, in plain words.
  const note = (await read($, ghProblem)) || (await read($, stale)) || (await read($, noWaiter))
  const toggle = () => update($, expanded, v => !v)
  const cols = Number(e.props.bodyColumns) || 100
  const allParts = headline(list, t)
  const hint = isOpen ? t.hide : t.showSessions
  // What of the header fits one line: the repo goes first, then the dots, then the counts after the first.
  const fits = headerFit(cols, t.bandName, fit(scopeLabel(list), 24).trim(), allParts, hint, isOpen)
  const where = fits.where ? fit(scopeLabel(list), 24).trim() : ''
  const parts = allParts.slice(0, fits.count)
  // The note has its own line under the header, wrapped, every row of it counted for the plugins beneath.
  const noteLine = note ? `  ⚠ ${note}` : ''
  const noteRows = note ? wrappedRows(`${noteLine} `, cols) : 0 // a cell spare: some terminals draw ⚠ wide
  const noteTree = note ? <Text key="note" color="warning" wrap="wrap">{noteLine}</Text> : null

  // ✻ Cloud · acme-shop  ● 2 need you   ● 1 working   ● 1 in review   ✓ 1 finished   Show ›
  // One button (the terminal brackets each). Open, the counts run as one quiet sentence and the sessions hang
  // under it as a tree, as a tool's output hangs under its call.
  const head = (
    <Box key="cloud-head">
      <Button key="cloud-toggle" onPress={toggle}>
        <Text color="claude" bold>{t.bandName}</Text>
        {where ? <Text key="where" color="inactive">{` · ${fit(where, 24).trim()}`}</Text> : null}
        {parts.flatMap((p, i) => {
          const lead = isOpen ? (i ? ' · ' : '   ') : (i ? '   ' : '  ')
          const color = p.strong ? 'claude' : isOpen ? 'subtle' : 'inactive'
          return [
            <Text key={`lead-${i}`} color={p.group && !isOpen ? GROUP_COLOR[p.group] : 'subtle'}>{lead}{fits.dots && p.group && !isOpen ? `${groupDot(p.group)} ` : ''}</Text>,
            <Text key={`part-${i}`} color={color} bold={p.strong}>{p.text}</Text>,
          ]
        })}
        <Text key="hint" color="subtle">{`   ${hint}`}</Text>
      </Button>
    </Box>
  )
  if (!isOpen) return { tree: <Box flexDirection="column">{head}{noteTree}</Box>, used: 1 + noteRows }

  const plan = await openPlan($, e, list, noteRows)
  // Columns: the repo (and account) only when the sessions span several; the task takes the width left.
  const withAccount = new Set(list.map(r => r.account)).size > 1
  const withRepo = !scopeLabel(list)
  const { ctxW, titleW, detailW, showAge } = rowLayout(cols, withAccount, withRepo, [...t.openLink].length)
  const nowEpoch = Math.floor((await read($, updatedAt)) / 1000)
  const lead = (i: number) => (i === 0 ? '  ⎿  ' : '     ')

  const lines = plan.map((l, i) => {
    if (l.kind === 'group') {
      return (
        <Box key={`group-${l.key}`}>
          <Text color="subtle">{lead(i)}</Text>
          <Text color={GROUP_COLOR[l.key]} bold>{t.group[l.key]}</Text>
        </Box>
      )
    }
    if (l.kind === 'folded') {
      return <Text key="group-finished" color="subtle">{`${lead(i)}${t.group.finished} · ${l.count}   /cloud`}</Text>
    }
    if (l.kind === 'more') return <Text key="more" color="subtle">{`${lead(i)}${t.moreRows(l.hidden)}`}</Text>
    const r = l.row
    const m = markOf(r)
    const ctx = [withAccount ? r.account : '', withRepo ? r.repo : ''].filter(Boolean).join('/')
    return (
      <Box key={`row-${r.sessionId}`}>
        <Text color="subtle">{`${lead(i)}${l.last ? '└' : '├'} `}</Text>
        <Text color={m.color} bold>{`${m.mark} `}</Text>
        {ctxW ? <Text color="subtle">{`${fit(ctx, ctxW)} `}</Text> : null}
        <Text>{`${fit(withRepo ? r.title : shortTitle(r.title, r.repo), titleW)} `}</Text>
        <Text color={l.key === 'needs' ? 'claude' : 'inactive'}>{`${fit(r.detail, detailW)} `}</Text>
        {showAge ? <Text color="subtle">{`${agoText(r.startedEpoch, nowEpoch).padStart(5)}  `}</Text> : null}
        {r.url ? <Link href={r.url}>{t.openLink}</Link> : null}
      </Box>
    )
  })
  return {
    tree: (
      <Box flexDirection="column">
        {head}
        {noteTree}
        {lines}
      </Box>
    ),
    used: 1 + noteRows + plan.length,
  }
}
