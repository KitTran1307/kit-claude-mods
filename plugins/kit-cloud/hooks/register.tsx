// kit-cloud: which Claude Code cloud sessions are working, above the prompt.
// cloud-pilot (the kit-cloud-pilot plugin: Node + the gh CLI) is the only part that talks to GitHub, for every session
// of every account on this machine; this module reads the hub's state.json, starts the hub through its CLI and draws. Collapsed band = one
// summary line (click to expand); expanded = one line per session with its link.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CloudRow } from '../types'
import { MARK, USAGE, accountName, fit, fromHub, ghSlug, inScope, parseCommand, staleNote, summary, table, waiterNote } from './status'
import type { HubRow, Scope, ScopeMode } from './status'

const rows = atom({ plugin: 'kit-cloud', key: 'rows' } as const, [] as CloudRow[], { shape: 'rows-1' })
const expanded = atom({ plugin: 'kit-cloud', key: 'expanded' } as const, false)
const updatedAt = atom({ plugin: 'kit-cloud', key: 'updatedAt' } as const, 0)
const lastError = atom({ plugin: 'kit-cloud', key: 'error' } as const, '')
const stale = atom({ plugin: 'kit-cloud', key: 'stale' } as const, '')
const noWaiter = atom({ plugin: 'kit-cloud', key: 'noWaiter' } as const, '')

const REFRESH_MS = 30_000 // a file read: cheap
const BAND_ROWS = 8

type Settings = { scope: ScopeMode; autoWatch: boolean; showBand: boolean; notifications: boolean; deleteMergedBranches: boolean }

export function settingsFrom(options: PluginOptions | undefined): Settings {
  const o = options ?? {}
  const scope = o.scope === 'repo' || o.scope === 'all' ? o.scope : 'account+repo'
  const flag = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt)
  return {
    scope,
    autoWatch: flag(o.autoWatch, true),
    showBand: flag(o.showBand, true),
    notifications: flag(o.notifications, true),
    deleteMergedBranches: flag(o.deleteMergedBranches, false),
  }
}

let settings = settingsFrom(undefined)
let scope: Scope | null = null
let slug = ''
let statePath = ''

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

export const INSTALL_PILOT = 'kit-cloud reads the sessions cloud-pilot tracks. Install it: /plugin install kit-cloud-pilot --marketplace KitTran1307/kit-claude-mods (then start a new session).'

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
  if (!cli) return { ok: false, missing: true, message: INSTALL_PILOT }
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
    return { ok: false, message: `node did not run (${(err as Error).message}). Install Node 18+ and make sure node is on PATH.` }
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
    await update($, rows, () => mine.map(fromHub))
    await update($, stale, () => staleNote(file.polledMs, nowMs, mine.some(r => r.active)))
    const sid = await $.session.id()
    await update($, noWaiter, () => waiterNote(file.rows, sid, file.waiting, file.queued))
    await update($, lastError, () => '')
    await update($, updatedAt, () => nowMs)
  } catch (e) {
    // A half-written or unreadable file keeps the last good rows; /cloud shows the reason.
    await update($, lastError, () => (e as Error).message)
  }
}

function needRepo(): string {
  return slug ? '' : 'This folder has no GitHub "origin" remote, so there is no repo to track here.'
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseCommand(args)
  const nowEpoch = Math.floor((await $.clock.now()) / 1000)
  const warn = (s: string) => (s ? `\n⚠ ${s}.` : '')
  const failed = (r: Record<string, unknown>) => `cloud-pilot could not do it: ${String(r.message ?? 'unknown error')}\nTry /cloud doctor.`
  switch (cmd.verb) {
    case 'help':
      return (cmd.error ? `${cmd.error}\n\n` : '') + USAGE
    case 'doctor': {
      const r = await hub($, ['doctor'])
      if (r.ok === true) return `cloud-pilot is ready: node ${String(r.node)}, gh ${String(r.gh)} signed in. Data: ${String(r.dir)}. Hub ${r.running ? 'running' : 'not running (starts when something is tracked)'}.`
      const problems = Array.isArray(r.problems) ? (r.problems as string[]) : [String(r.message ?? 'unknown problem')]
      return `cloud-pilot needs:\n${problems.map(p => `- ${p}`).join('\n')}`
    }
    case 'watch': case 'unwatch': {
      if (needRepo()) return needRepo()
      const r = await hub($, [cmd.verb, '--repo', slug])
      if (r.ok !== true) return failed(r)
      return cmd.verb === 'watch'
        ? `Watching ${slug}: each new claude/* branch is tracked by itself.`
        : `Stopped watching ${slug} (${String(r.stopped ?? 0)} watch track). Sessions already tracked go on.`
    }
    case 'track': {
      if (needRepo()) return needRepo()
      const r = await hub($, ['track', '--repo', slug, ...(cmd.branch ? ['--branch', cmd.branch] : []), ...(cmd.url ? ['--url', cmd.url] : [])])
      if (r.ok !== true) return failed(r)
      await refresh($)
      return `Tracking ${cmd.branch || cmd.url} in ${slug} (id ${String(r.id)}).` + (cmd.branch ? '' : '\nWithout its claude/... branch the hub can only show it as started; add the branch when you know it.')
    }
    case 'untrack': {
      const r = await hub($, ['untrack', '--id', cmd.id])
      if (r.ok !== true) return `No tracked session has id ${cmd.id}.`
      await refresh($)
      return `Stopped tracking ${cmd.id}.`
    }
    case 'list': {
      if (cmd.all) {
        try {
          const file = await readHub($)
          return table(file.rows.map(fromHub), nowEpoch, 'every account and repo') + warn(staleNote(file.polledMs, nowEpoch * 1000, file.rows.some(r => r.active)))
        } catch (err) {
          return `Could not read cloud-pilot's state: ${(err as Error).message}`
        }
      }
      await refresh($)
      const where = scope ? (settings.scope === 'repo' ? scope.repo : settings.scope === 'all' ? 'every account and repo' : `${scope.account} · ${scope.repo}`) : ''
      const err = await read($, lastError)
      return table(await read($, rows), nowEpoch, where) + '\n/cloud all: every account and repo. /cloud help: all commands.'
        + warn(await read($, stale)) + warn(await read($, noWaiter)) + (err ? `\n(Could not read cloud-pilot's state: ${err})` : '')
    }
  }
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'cloud', description: 'Cloud sessions of this account and repo (/cloud help for more)', argumentHint: '[all | track <url> [branch] | untrack <id> | watch | unwatch | doctor | help]' })
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
    const parts = summary(list)

    const head = (
      <Button key="cloud-toggle" onPress={toggle}>
        <Text color="suggestion">☁ Cloud </Text>
        {parts.map((p, i) => (
          <Text key={`part-${i}`} color={p.color}>{i ? ' · ' : ' '}{p.text}</Text>
        ))}
        {staleText ? <Text key="stale" color="warning">{` · ⚠ ${staleText}`}</Text> : null}
        {waiterText ? <Text key="waiter" color="warning">{` · ⚠ ${waiterText}`}</Text> : null}
        <Text key="hint" dimColor>{isOpen ? '  ▾ hide' : '  ▸ show sessions'}</Text>
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
              {r.url ? <Link href={r.url}>open</Link> : <Text dimColor>-</Text>}
            </Box>
          )
        })}
        {list.length > BAND_ROWS && <Text dimColor>… {list.length - BAND_ROWS} more: type /cloud</Text>}
      </Box>
    )
  }
}
