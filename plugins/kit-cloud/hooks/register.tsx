// kit-cloud: which Claude Code cloud sessions are working, above the prompt.
// cloud-pilot (the kit-cloud-pilot plugin: Node + the gh CLI) is the only part that talks to GitHub, for every session
// of every account on this machine; this module reads the hub's state.json, starts the hub through its CLI and draws. Collapsed band = one
// summary line (click to expand); expanded = one line per session with its link.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CloudRow } from '../types'
import { STRINGS, changeText, languageFromSetting, languageOption } from './i18n'
import type { LanguageOption, Strings } from './i18n'
import { MARK, accountName, changes, fit, fromHub, ghSlug, inScope, parseCommand, snapshot, staleNote, summary, table, waiterNote } from './status'
import type { HubRow, Scope, ScopeMode, Snapshot } from './status'

const rows = atom({ plugin: 'kit-cloud', key: 'rows' } as const, [] as CloudRow[], { shape: 'rows-1' })
const expanded = atom({ plugin: 'kit-cloud', key: 'expanded' } as const, false)
const updatedAt = atom({ plugin: 'kit-cloud', key: 'updatedAt' } as const, 0)
const lastError = atom({ plugin: 'kit-cloud', key: 'error' } as const, '')
const stale = atom({ plugin: 'kit-cloud', key: 'stale' } as const, '')
const noWaiter = atom({ plugin: 'kit-cloud', key: 'noWaiter' } as const, '')

const REFRESH_MS = 30_000 // a file read: cheap
const BAND_ROWS = 8

type Settings = {
  scope: ScopeMode
  autoWatch: boolean
  showBand: boolean
  notifications: boolean
  notifyInSession: boolean
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

type HubFile = { rows: HubRow[]; polledMs?: number; waiting?: string[]; queued?: Record<string, number> }

async function readHub($: EngineInterface): Promise<HubFile> {
  if (!statePath) statePath = `${await hubDir($)}/state.json`
  if (!(await $.fs.exists(statePath))) return { rows: [] }
  const parsed = JSON.parse(String(await $.fs.read(statePath))) as { rows?: unknown; hub?: { polledMs?: number }; waiting?: unknown; queued?: unknown }
  const list = Array.isArray(parsed?.rows) ? (parsed.rows as HubRow[]) : []
  return {
    rows: list.filter(r => r && typeof r === 'object' && r.kind === 'branch' && typeof r.id === 'string'),
    polledMs: typeof parsed?.hub?.polledMs === 'number' ? parsed.hub.polledMs : undefined,
    waiting: Array.isArray(parsed?.waiting) ? parsed.waiting.filter((x): x is string => typeof x === 'string') : undefined,
    queued: parsed?.queued && typeof parsed.queued === 'object' ? (parsed.queued as Record<string, number>) : undefined,
  }
}

async function refresh($: EngineInterface): Promise<void> {
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
    await update($, noWaiter, () => waiterNote(file.rows, sid, file.waiting, file.queued, t))
    if (settings.notifyInSession) announce($, happened)
    await update($, lastError, () => '')
    await update($, updatedAt, () => nowMs)
  } catch (e) {
    // A half-written or unreadable file keeps the last good rows; /cloud shows the reason.
    await update($, lastError, () => (e as Error).message)
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
        + warn(await read($, stale)) + warn(await read($, noWaiter)) + (err ? `\n(${t.stateUnreadable(err)})` : '')
    }
  }
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    try {
      previous = null // the first refresh below only seeds it: a reload never replays old events
      t = await pickLanguage($)
      await $.command.register({ name: 'cloud', description: t.commandDescription, argumentHint: '[all | track <url> [branch] | untrack <id> | watch | unwatch | doctor | help]' })
      scope = await findScope($, e.cwd)
      await refresh($)
      $.clock.every(REFRESH_MS, () => { refresh($).catch(() => undefined) })
      // Watching asks GitHub through gh; a missing node or gh only means no watch (see /cloud doctor).
      if (settings.autoWatch && slug) await hub($, ['watch', '--repo', slug])
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
    const toggle = () => update($, expanded, v => !v)
    const parts = summary(list, t)

    const head = (
      <Button key="cloud-toggle" onPress={toggle}>
        <Text color="suggestion">{t.bandName}</Text>
        {parts.map((p, i) => (
          <Text key={`part-${i}`} color={p.color}>{i ? ' · ' : ' '}{p.text}</Text>
        ))}
        {staleText ? <Text key="stale" color="warning">{` · ⚠ ${staleText}`}</Text> : null}
        {waiterText ? <Text key="waiter" color="warning">{` · ⚠ ${waiterText}`}</Text> : null}
        <Text key="hint" dimColor>{isOpen ? t.hide : t.showSessions}</Text>
      </Button>
    )
    if (!isOpen) return <Box>{head}</Box>

    return (
      <Box flexDirection="column">
        {head}
        {list.slice(0, BAND_ROWS).map(r => {
          const m = MARK[r.state]
          return (
            <Box key={r.sessionId}>
              <Text color={m.color}>{m.mark} </Text>
              <Text>{fit(r.account, 8)} {fit(r.repo, 14)} {fit(r.title, 26)} </Text>
              <Text color={m.color}>{fit(r.detail, 26)} </Text>
              {r.url ? <Link href={r.url}>{t.openLink}</Link> : <Text dimColor>-</Text>}
            </Box>
          )
        })}
        {list.length > BAND_ROWS && <Text dimColor>{t.moreRows(list.length - BAND_ROWS)}</Text>}
      </Box>
    )
  }
}
