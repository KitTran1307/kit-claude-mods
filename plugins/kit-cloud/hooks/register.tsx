// kit-cloud: which Claude Code cloud sessions are working, above the prompt.
// cloud-pilot (the kit-cloud-pilot plugin: Node + the gh CLI) is the only part that talks to GitHub, for every session
// of every account on this machine; this module reads the hub's state.json, starts the hub through its CLI and draws. Collapsed band = one
// summary line (click to expand); expanded = one line per session with its link.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CloudRow } from '../types'
import { STRINGS, changeText, languageFromSetting, languageOption } from './i18n'
import type { LanguageOption, Strings } from './i18n'
import { accountName, asideNote, changes, fit, fromHub, ghSlug, githubNote, grouped, headline, inScope, parseCommand, queueFileName, queueHasEvents, shortTitle, snapshot, staleNote, table, waiterNote, wakeBatch } from './status'
import type { HubRow, Scope, ScopeMode, Snapshot } from './status'

const rows = atom({ plugin: 'kit-cloud', key: 'rows' } as const, [] as CloudRow[], { shape: 'rows-1' })
const expanded = atom({ plugin: 'kit-cloud', key: 'expanded' } as const, false)
const updatedAt = atom({ plugin: 'kit-cloud', key: 'updatedAt' } as const, 0)
const lastError = atom({ plugin: 'kit-cloud', key: 'error' } as const, '')
const stale = atom({ plugin: 'kit-cloud', key: 'stale' } as const, '')
const noWaiter = atom({ plugin: 'kit-cloud', key: 'noWaiter' } as const, '')
const ghProblem = atom({ plugin: 'kit-cloud', key: 'ghProblem' } as const, '')

const REFRESH_MS = 30_000 // a file read: cheap
const BAND_ROWS = 8

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

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseCommand(args, t)
  const nowEpoch = Math.floor((await $.clock.now()) / 1000)
  const warn = (s: string) => (s ? `\n⚠ ${s}.` : '')
  const failed = (r: Record<string, unknown>) => t.pilotFailed(String(r.message ?? t.unknownError))
  switch (cmd.verb) {
    case 'help':
      return (cmd.error ? `${cmd.error}\n\n` : '') + t.usage
    case 'doctor': {
      const r = await hub($, ['doctor'])
      if (r.ok === true) return t.doctorReady(String(r.node), String(r.gh), String(r.dir), Boolean(r.running))
      const problems = Array.isArray(r.problems) ? (r.problems as string[]) : [String(r.message ?? t.doctorUnknown)]
      return t.doctorNeeds(problems)
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
      pending = [] // a new session (or /clear): what the last one could not hand over was its own
      t = await pickLanguage($)
      await $.command.register({ name: 'cloud', description: t.commandDescription, argumentHint: '[all | track <url> [branch] | untrack <id> | watch | unwatch | doctor | help]' })
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
    const mine = await ownBand($, e, pass)
    if (passed) return mine
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const used = (await read($, expanded)) ? 2 + Math.min((await read($, rows)).length, BAND_ROWS) : 1
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - used) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
}

async function ownBand($: EngineInterface, e: any, next: (x: any) => Promise<any>) {
  {
    const list = await read($, rows)
    if (!settings.showBand || e.props.hasSurvey || list.length === 0) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const isOpen = await read($, expanded)
    const staleText = await read($, stale)
    const waiterText = await read($, noWaiter)
    const ghText = await read($, ghProblem)
    const toggle = () => update($, expanded, v => !v)
    // Something wrong with the hub or GitHub: one note, in plain words, after the counts.
    const note = ghText || staleText || waiterText

    // ✻ Cloud  Nothing needs you · 1 working · 3 in review   Show ›   (Claude's orange for the name and what needs you)
    const head = (
      <Button key="cloud-toggle" onPress={toggle}>
        <Text color="claude" bold>{t.bandName}</Text>
        {(isOpen ? [] : headline(list, t)).map((p, i) => (
          <Text key={`part-${i}`} color={p.strong ? 'claude' : 'subtle'} bold={p.strong}>{i ? ' · ' : '  '}{p.text}</Text>
        ))}
        {note ? <Text key="note" color="warning">{`  ⚠ ${note}`}</Text> : null}
        <Text key="hint" color="subtle">{`   ${isOpen ? t.hide : t.showSessions}`}</Text>
      </Button>
    )
    if (!isOpen) return <Box>{head}</Box>

    // Grouped, most urgent first. Live groups list their sessions; finished ones are one quiet line (/cloud lists
    // them). The account is shown only when the rows come from more than one; the title takes the width left.
    const withAccount = new Set(list.map(r => r.account)).size > 1
    const cols = Number(e.props.bodyColumns) || 100
    const titleW = Math.max(16, Math.min(48, cols - 4 - (withAccount ? 9 : 0) - 16 - 21 - 6))
    let left = BAND_ROWS
    let hidden = 0
    const blocks = grouped(list).map(g => {
      const isNeeds = g.key === 'needs'
      if (g.key === 'finished') {
        return <Text key="group-finished" color="subtle">{`  ${t.group.finished} · ${g.rows.length}   /cloud`}</Text>
      }
      const shown = g.rows.slice(0, Math.max(0, left))
      left -= shown.length
      hidden += g.rows.length - shown.length
      if (shown.length === 0) return null
      return (
        <Box key={`group-${g.key}`} flexDirection="column">
          <Text color={isNeeds ? 'claude' : 'subtle'} bold={isNeeds}>{`  ${t.group[g.key]}`}</Text>
          {shown.map(r => (
            <Box key={r.sessionId}>
              <Text>{'    '}{withAccount ? `${fit(r.account, 8)} ` : ''}{fit(r.repo, 15)} {fit(shortTitle(r.title, r.repo), titleW)} </Text>
              <Text color={isNeeds ? 'claude' : 'subtle'}>{fit(r.detail, 20)} </Text>
              {r.url ? <Link href={r.url}>{t.openLink}</Link> : null}
            </Box>
          ))}
        </Box>
      )
    })
    return (
      <Box flexDirection="column">
        {head}
        {blocks}
        {hidden > 0 && <Text color="subtle">{`  ${t.moreRows(hidden)}`}</Text>}
      </Box>
    )
  }
}
