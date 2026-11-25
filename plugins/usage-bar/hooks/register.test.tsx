import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

const NOW = 1_800_000_000_000
const MIB = 1024 * 1024
const SID = '0f9e8d7c-1111-4222-8333-444455556666'
const AT = (ms: number) => new Date(ms).toISOString()

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const BOTH = { surfaces: 'desktop+terminal' } as const

const INFO = {
  repo: 'notes', model: 'Opus 5.5', effort: 'HIGH', ctx: 42,
  five: { pct: 30, resetsAt: NOW + 133 * 60_000 },
  week: { pct: 93, resetsAt: NOW + (3 * 24 + 3) * 3_600_000 },
  email: 'ann@example.com', label: 'work', colorIndex: 2, title: 'fix the status band',
}

// Stands in for the session's stored values, as an earlier hook wrote them.
function seed(on: On, info: object = INFO): void {
  // Stands for the engine beneath the plugins at the band: what other tests draw there, else an empty band.
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('state.get', (_, e) => ({ value: { value: e.key === 'info' ? info : NOW, version: 1 } }))
}

type Mounted = { findAll: (q: { type: string }) => Promise<Array<{ text: string; props: Record<string, unknown> }>> }
const shown = async (ui: Mounted): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map(t => t.text)
const textOf = async (ui: Mounted, needle: string) => (await shown(ui)).find(t => t.includes(needle))
const colorOf = async (ui: Mounted, needle: string) =>
  (await ui.findAll({ type: 'Text' })).find(t => t.text.includes(needle))?.props.backgroundColor

// ---------- the band ----------
for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
  test(`the band shows every field of the status line on the ${surface}`, { options: BOTH }, async ($, on) => {
    seed(on)
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = (await shown(ui)).join('|')
    for (const text of ['notes', 'Opus 5.5', 'HIGH', 'ctx', '42%', 'work', 'ann@example.com', 'fix the status band',
      '5H', '30%', '↻ 2h13m', 'WEEK', '93%', '/ 56%', '↻ 3d03h']) {
      expect(all).toContain(text)
    }
    await ui.unmount()
  })

  test(`no usage data (API key, third-party provider): the limits row is hidden and ctx reads -- on the ${surface}`, { options: BOTH }, async ($, on) => {
    seed(on, { ...INFO, ctx: null, five: { pct: null, resetsAt: null }, week: { pct: null, resetsAt: null } })
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = (await shown(ui)).join('|')
    expect(all).toContain('--')
    expect(all).toContain('notes')
    expect(all).not.toContain('5H')
    expect(all).not.toContain('WEEK')
    await ui.unmount()
  })
}

const STATUS_LINE = JSON.stringify({ statusLine: { type: 'command', command: 'node ~/.claude/statusline.mjs' } })
// The shared engine stub (seed/world) already draws "engine" where a plugin hands the band on.
const engineDraws = (_on: On) => undefined

test('auto: with no status line set up, the terminal gets the band too', async ($, on) => {
  world(on, { surfaces: ['terminal'] })
  engineDraws(on)
  await start($)
  expect((await band($, 'terminal')).text).toContain('notes')
})

test('auto: a status line in the user settings keeps the terminal to it; the desktop still draws', async ($, on) => {
  world(on, { surfaces: ['terminal', 'desktop'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  engineDraws(on)
  await start($)
  const term = await band($, 'terminal')
  expect(term.text).toBe('engine')
  expect((await band($, 'desktop')).text).toContain('notes')
})

test('auto: a status line in the project settings counts too', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/work/notes/.claude/settings.local.json': STATUS_LINE } })
  engineDraws(on)
  await start($)
  expect((await band($, 'terminal')).text).toBe('engine')
})

test('auto: a broken settings file is no status line', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': '{ "statusLine": ' } })
  engineDraws(on)
  await start($)
  expect((await band($, 'terminal')).text).toContain('notes')
})

test('desktop+terminal draws in the terminal even with a status line', { options: BOTH }, async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  engineDraws(on)
  await start($)
  expect((await band($, 'terminal')).text).toContain('notes')
})

// The question auto mode asks once when the terminal already has a status line, and what each answer saves.
const QUESTION = /already have a status line/
function asks(on: On, answer: string | null) {
  const seen = { asked: [] as string[], set: [] as Array<{ key: string; value: unknown }> }
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    const q = (e.questions ?? e.input?.questions)?.[0]?.question ?? JSON.stringify(Object.keys(e))
    seen.asked.push(q)
    if (answer === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions ?? e.input?.questions, answers: { [q]: answer } }, text: answer }
  })
  on('config.set', (_: any, e: any) => { seen.set.push({ key: e.key, value: e.value }); return { value: e.value } })
  return seen
}
// The question is not awaited by session.start: give it a moment to be asked and answered.
const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 30))

for (const [answer, surfaces] of [['Keep only my status line', 'desktop'], ['Show both', 'desktop+terminal']] as const) {
  test(`auto with a status line in the terminal asks once; "${answer}" saves surfaces=${surfaces}`, async ($, on) => {
    world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
    const seen = asks(on, answer)
    await start($)
    await settle()
    expect(seen.asked).toHaveLength(1)
    expect(seen.asked[0]).toMatch(QUESTION)
    expect(seen.set).toEqual([{ key: 'usage-bar.surfaces', value: surfaces }])
    expect((await band($, 'terminal')).text).toBe('engine') // until the saved answer reloads the plugin
  })
}

test('a dismissed question keeps the status line and is saved, so it is not asked at every start', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, null)
  await start($)
  await settle()
  expect(seen.set).toEqual([{ key: 'usage-bar.surfaces', value: 'desktop' }])
  expect((await band($, 'terminal')).text).toBe('engine')
})

test('a -p run is never asked and saves nothing', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, 'Show both')
  await $.session.start({ cwd: '/home/ann/work/notes', surface: 'terminal', isInteractive: false })
  await settle()
  expect(seen.asked).toEqual([])
  expect(seen.set).toEqual([])
})

test('no question without a status line', async ($, on) => {
  world(on, { surfaces: ['terminal'] })
  const seen = asks(on, 'Show both')
  await start($)
  await settle()
  expect(seen.asked).toEqual([])
})

test('no question when only the desktop is attached', async ($, on) => {
  world(on, { surfaces: ['desktop'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, 'Show both')
  await start($)
  await settle()
  expect(seen.asked).toEqual([])
})

test('no question when surfaces is chosen already', { options: { surfaces: 'desktop' } }, async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, 'Show both')
  await start($)
  await settle()
  expect(seen.asked).toEqual([])
})

test('a load with no session.start (a /reload-plugins) still keeps out of a terminal that has a status line', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  expect((await band($, 'terminal')).text).toBe('engine')
})

test('a load with no session.start draws in a terminal without a status line once it has looked', async ($, on) => {
  const seen = world(on, { surfaces: ['terminal'] })
  const drawn = await band($, 'terminal')
  expect(seen.logs).toEqual([])
  expect(drawn.text).not.toBe('engine')
})

test('by default the desktop draws the band', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(ui, 'notes')).toContain('notes')
  await ui.unmount()
})

test('surfaces=desktop does not draw on the terminal either, when asked for explicitly', { options: { surfaces: 'desktop' } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, 'notes')).toBe(undefined)
  expect(await textOf(ui, 'engine')).toBe('engine')
  await ui.unmount()
})

test('an unknown surface is left to the engine', { options: BOTH }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await textOf(ui, 'notes')).toBe(undefined)
  expect(await textOf(ui, 'engine')).toBe('engine')
  await ui.unmount()
})

test('a survey holds the band: nothing is drawn over it', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })
  expect(await textOf(ui, 'notes')).toBe(undefined)
  expect(await textOf(ui, 'engine')).toBe('engine')
  await ui.unmount()
})

test('effort absent: no effort pill; the other pills stay', async ($, on) => {
  seed(on, { ...INFO, effort: null })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = await shown(ui)
  expect(all.some(t => t.includes('HIGH'))).toBe(false)
  expect(all.some(t => t.includes('Opus 5.5'))).toBe(true)
  await ui.unmount()
})

test('only one limit window reported: only that bar is drawn', async ($, on) => {
  seed(on, { ...INFO, week: { pct: null, resetsAt: null } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).toContain('5H')
  expect(all).not.toContain('WEEK')
  await ui.unmount()
})

test('no email known: the badge and the title stand alone', async ($, on) => {
  seed(on, { ...INFO, email: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).toContain('work')
  expect(all).toContain('fix the status band')
  expect(all).not.toContain('@')
  await ui.unmount()
})

test('showEmail=false hides the email', { options: { showEmail: false } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).not.toContain('ann@example.com')
  expect(all).toContain('fix the status band')
  await ui.unmount()
})

test('showTitle=false hides the session title', { options: { showTitle: false } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).not.toContain('fix the status band')
  expect(all).toContain('ann@example.com')
  await ui.unmount()
})

test('showLimits=false hides the limits row even when there is data', { options: { showLimits: false } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).not.toContain('5H')
  expect(all).not.toContain('WEEK')
  expect(all).toContain('42%')
  await ui.unmount()
})

test('weeklyBudgetPerDay defaults to 14 a day', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(ui, '/ 56%')).toBe('/ 56%')
  await ui.unmount()
})

test('weeklyBudgetPerDay=20 steps the budget by 20', { options: { weeklyBudgetPerDay: 20 } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(ui, '/ 80%')).toBe('/ 80%')
  await ui.unmount()
})

test('weeklyBudgetPerDay=0 hides the budget but keeps the weekly bar', { options: { weeklyBudgetPerDay: 0 } }, async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).toContain('WEEK')
  expect(all).toContain('93%')
  expect(all).not.toContain('/ 56%')
  expect(all).not.toMatch(/\/ \d+%/)
  await ui.unmount()
})

test('the account badge: default is orange, another label has its own slot of the palette', async ($, on) => {
  seed(on, { ...INFO, label: 'default', colorIndex: 0 })
  const orange = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(orange, 'default')).toBe('#ff9e64')
  await orange.unmount()
})

test('the account badge of a named account uses its slot', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(ui, 'work')).toBe('#d4bcff')
  await ui.unmount()
})

test('narrow desktop: a long title is cut to what the badge and email leave, with an ellipsis', async ($, on) => {
  const long = 'investigate why the nightly export job fails only on the first Monday of a month and fix it'
  seed(on, { ...INFO, title: long })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 50 }, surface: 'desktop' })
  const title = (await shown(ui)).find(t => t.startsWith('investigate'))
  // 50 columns less ` work ` (6), the email (15) and the two gaps before them (2)
  expect(title).toBeDefined()
  expect(title?.endsWith('…')).toBe(true)
  expect(title?.length).toBe(27)
  expect(long.startsWith(title?.slice(0, -1) ?? '#')).toBe(true)
  await ui.unmount()
})

test('wide desktop: a title that fits shows whole', async ($, on) => {
  const title = 'a title that is long but fits'
  seed(on, { ...INFO, title })
  const wide = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(wide, title)).toBe(title)
  await wide.unmount()
})

test('a desktop too narrow for the title draws the rest of the band without it', async ($, on) => {
  seed(on, { ...INFO, title: 'a title that cannot fit' })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 26 }, surface: 'desktop' })
  const all = (await shown(ui)).join('|')
  expect(all).not.toContain('a title')
  expect(all).toContain('ann@example.com')
  await ui.unmount()
})

// ---------- the session, through the engine ----------
type FileSpec = string | { text: string; mtimeMs?: number; size?: number }
type World = {
  files?: Record<string, FileSpec>
  env?: Record<string, string>
  cwd?: string
  /** A repo root, null (not in a repo), or 'error' (git itself failed). */
  repo?: string | null | 'error'
  surfaces?: Array<'desktop' | 'terminal' | 'mobile' | 'vscode'>
  ctx?: number
  rateLimits?: unknown[]
  model?: string
  /** What `node session-info.mjs` answers: JSON text, or 'missing' when Node cannot be started. */
  helper?: string | 'missing'
  /** The `language` setting of Claude Code: a value, or 'error' when the settings cannot be read. */
  language?: unknown
  /** What `$.session.version()` answers (a version, or 'error'), and what `claude --version` / `node --version` print. */
  version?: string | 'error'
  claudeVersion?: string
  nodeVersion?: string
  /** 'record': timers only record their period (the clock does not move); 'no-fast': the same, and the 1 s one is refused. */
  timers?: 'no-fast' | 'record'
  /** A read of a file under projects/ that fails with this text. */
  readFails?: boolean
  /** `$.session.surfaces()` fails. */
  surfacesFail?: boolean
}

// The engine beneath the plugin: environment, files, session facts, clock, a Node helper. Returns what it saw.
function world(on: On, w: World = {}) {
  // Stands for the engine beneath the plugins at the band: what other tests draw there, else an empty band.
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const sawReads: string[] = []
  const sawStats: string[] = []
  const sawRuns: string[][] = []
  const logs: string[] = []
  const state = { id: SID, surfaces: w.surfaces ?? ['desktop'], settingsReads: 0 }
  // Paths compare without a drive letter: a test host that resolves /home/ann against its own drive still matches,
  // and a POSIX host that takes C:\... as a relative path (prefixing its own folder) still finds the Windows path.
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/')
    const win = /[A-Za-z]:\/.*$/.exec(s)
    return (win ? win[0] : s).replace(/^[A-Za-z]:/, '')
  }
  const table = new Map<string, { text: string; mtimeMs?: number; size?: number }>()
  const put = (path: string, spec: FileSpec) => { table.set(norm(path), typeof spec === 'string' ? { text: spec } : spec) }
  for (const [path, spec] of Object.entries(w.files ?? {})) put(path, spec)

  mock.env(on, w.env ?? { HOME: '/home/ann' })
  const periods: number[] = []
  const callbacks: Array<{ ms: number; fn: () => void }> = []
  const commands: Array<{ name: string; description: string; argumentHint?: string }> = []
  const clock = w.timers === undefined ? mock.clock(on, { now: NOW }) : (() => {
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', (_: any, e: any) => { periods.push(e.ms); callbacks.push({ ms: e.ms, fn: e.fn }); return e.ms === 1000 && w.timers === 'no-fast' ? ({ deny: 'no timers' } as never) : { value: undefined as never } })
    return undefined as never
  })()
  on('command.register', (_: any, e: any) => { commands.push(e); return { value: { command: e.name } } })
  on('session.id', () => ({ value: state.id }))
  on('session.cwd', () => ({ value: w.cwd ?? '/home/ann/work/notes' }))
  on('session.model', () => ({ value: w.model ?? 'claude-opus-5-5' }))
  on('session.surfaces', () => (w.surfacesFail ? ({ deny: 'boom' } as never) : { value: state.surfaces }))
  on('session.repo', () => {
    if (w.repo === 'error') return { deny: 'git: command not found' }
    const root = w.repo === undefined ? '/home/ann/work/notes' : w.repo
    return { value: root === null ? null : ({ root } as never) }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: w.ctx }, rateLimits: w.rateLimits ?? [] } as never,
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('session.version', () => (w.version === undefined || w.version === 'error' ? ({ deny: 'not available' } as never) : { value: { version: w.version } as never }))
  on('settings.read', () => {
    state.settingsReads += 1
    if (w.language === 'error') return { deny: 'settings are not readable' } as never
    return { value: (w.language === undefined ? {} : { language: w.language }) as never }
  })

  on('fs.stat', (_, e) => {
    const path = norm(e.path)
    sawStats.push(path)
    const f = table.get(path)
    if (f) return { value: { kind: 'file' as const, size: f.size ?? f.text.length, mtimeMs: f.mtimeMs ?? 1, isLink: false } }
    if ([...table.keys()].some(k => k.startsWith(`${path}/`))) {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    }
    return { deny: 'ENOENT: no such file or directory' }
  })
  on('fs.read', (_, e) => {
    const path = norm(e.path)
    const f = table.get(path)
    if (!f) return { deny: 'ENOENT: no such file or directory' }
    if (w.readFails && path.endsWith('.jsonl')) return { deny: 'EACCES: permission denied' }
    if ((f.size ?? f.text.length) > 4 * MIB) return { deny: 'file is over 4 MiB' }
    sawReads.push(path)
    return { value: f.text }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path).replace(/\/$/, '')
    const names = new Set<string>()
    for (const k of table.keys()) if (k.startsWith(`${dir}/`)) names.add(k.slice(dir.length + 1).split('/')[0] ?? '')
    if (names.size === 0) return { deny: 'ENOENT: no such directory' }
    return {
      value: [...names].map(name => ({
        name, kind: table.has(`${dir}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false,
      })),
    }
  })
  on('process.run', (_, e) => {
    sawRuns.push([...e.argv])
    if (e.argv[1] === '--version') {
      const out = e.argv[0] === 'claude' ? w.claudeVersion : e.argv[0] === 'node' ? w.nodeVersion : undefined
      if (out === undefined) return { deny: 'spawn ENOENT' }
      return { value: { exitCode: 0, stdout: `${out}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (w.helper === undefined || w.helper === 'missing') return { deny: 'spawn node ENOENT' }
    return { value: { exitCode: 0, stdout: w.helper, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { sawReads, sawStats, sawRuns, logs, state, clock, put, periods, callbacks, commands }
}

const start = ($: any, cwd = '/home/ann/work/notes') => $.session.start({ cwd, surface: 'desktop', isInteractive: true })
const finishTurn = ($: any) => $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })

const row = (o: object) => `${JSON.stringify(o)}\n`
const aiTitle = (t: string) => row({ type: 'ai-title', aiTitle: t })
const renameTo = (t: string) => row({ type: 'custom-title', customTitle: t })
const ctxEmail = (email: string) => row({ attachment: { userEmail: `The user's email address is ${email}. Use it.` } })
const LOGIN = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } })
const TRANSCRIPT = `/home/ann/.claude/projects/-home-ann-work-notes/${SID}.jsonl`

async function band($: any, surface: 'desktop' | 'terminal' = 'desktop') {
  const ui = await $.ui.mount({ ...BAND, surface })
  const all: string[] = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  const backgrounds: Record<string, unknown> = {}
  for (const t of await ui.findAll({ type: 'Text' })) backgrounds[t.text.trim()] = t.props.backgroundColor
  await ui.unmount()
  return { all, text: all.join('|'), backgrounds }
}

test('session start: repo, model, context and both limits reach the band', async ($, on) => {
  world(on, {
    ctx: 37,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 61.4, resetsAt: AT(NOW + 90 * 60_000) },
      { kind: 'seven_day', percentUsed: 12, resetsAt: AT(NOW + 6.5 * 86_400_000) },
    ],
  })
  await start($)
  const { text } = await band($)
  for (const part of ['notes', 'Opus 5.5', '37%', '5H', '61%', '↻ 1h30m', 'WEEK', '12%', '/ 14%', '↻ 6d12h']) {
    expect(text).toContain(part)
  }
})

test('no repo: the band names the working folder', async ($, on) => {
  world(on, { repo: null, cwd: '/home/ann/scratch/ideas' })
  await start($, '/home/ann/scratch/ideas')
  expect((await band($)).all.some(t => t.includes('ideas'))).toBe(true)
})

test('no repo on Windows: the working folder\'s own name, whichever way the path is spelled', async ($, on) => {
  world(on, { repo: null, env: { USERPROFILE: 'C:\\Users\\Ann' }, cwd: 'C:\\Users\\Ann\\Documents\\ideas\\' })
  await start($, 'C:\\Users\\Ann\\Documents\\ideas\\')
  expect((await band($)).all.some(t => t.includes('ideas'))).toBe(true)
})

test('no git installed: the repo lookup fails and the working folder is shown instead', async ($, on) => {
  const seen = world(on, { repo: 'error', cwd: '/home/ann/work/notes' })
  await start($)
  expect((await band($)).all.some(t => t.includes('notes'))).toBe(true)
  expect(seen.logs.filter(l => l.includes('failed'))).toHaveLength(0)
})

test('a repo root names the repo, not the folder inside it', async ($, on) => {
  world(on, { repo: '/home/ann/work/big-repo', cwd: '/home/ann/work/big-repo/packages/web' })
  await start($, '/home/ann/work/big-repo/packages/web')
  const { all } = await band($)
  expect(all.some(t => t.includes('big-repo'))).toBe(true)
  expect(all.some(t => t.includes('web'))).toBe(false)
})

test('no usage data at all (API key, third-party provider): ctx --, no limits row, nothing thrown', async ($, on) => {
  world(on, { rateLimits: [] })
  await start($)
  const { text } = await band($)
  expect(text).toContain('ctx')
  expect(text).toContain('--')
  expect(text).not.toContain('5H')
  expect(text).not.toContain('WEEK')
})

test('the effort pill follows the model: a level, a numeric budget, then none', async ($, on) => {
  world(on)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await start($)
  const step = async (model: string, effort?: 'high' | number) => {
    const stream = $.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 1 } as never)
    for await (const chunk of stream) void chunk
  }
  await step('claude-opus-5-5', 'high')
  expect((await band($)).text).toContain('HIGH')
  await step('claude-sonnet-5-20260101', 16000)
  const numeric = await band($)
  expect(numeric.text).toContain('16K')
  expect(numeric.text).toContain('Sonnet 5')
  expect(numeric.text).not.toContain('HIGH')
  await step('claude-haiku-5-5')
  const none = await band($)
  expect(none.text).toContain('Haiku 5.5')
  expect(none.text).not.toContain('16K')
})

test('a subagent\'s step does not change the main model or effort', async ($, on) => {
  world(on)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await start($)
  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' } as never)
  for await (const chunk of stream) void chunk
  const { text } = await band($)
  expect(text).toContain('Opus 5.5')
  expect(text).not.toContain('Haiku')
})

test('a measurement without rate limits keeps the last bars; one with them replaces them', async ($, on) => {
  const stored: Record<string, unknown> = { info: INFO, now: NOW }
  on('state.get', (_, e) => ({ value: { value: stored[e.key], version: 1 } }))
  on('state.set', (_, e: any) => { stored[e.key] = e.value; return { value: { isSet: true as const, version: 2 } } })
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({ context: { percent: 50 } as never, rateLimits: [], changed: ['context'] })
  expect((stored.info as typeof INFO).five.pct).toBe(30)
  expect((stored.info as typeof INFO).ctx).toBe(50)
  await $.session.measure({
    context: { percent: 51 } as never,
    rateLimits: [{ kind: 'five_hour', percentUsed: 61.4, resetsAt: AT(NOW + 3_600_000) }] as never,
    changed: ['rateLimits'],
  })
  expect((stored.info as typeof INFO).five.pct).toBe(61)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a plan with no 5-hour window shows only the week on the ${surface}`, { options: BOTH }, async ($, on) => {
    const stored: Record<string, unknown> = { info: INFO, now: NOW }
    on('ui.render', ($$: any, e: any) => { const { Text } = $$.ui.resolve(e); return <Text>engine</Text> })
    on('state.get', (_, e) => ({ value: { value: stored[e.key], version: 1 } }))
    on('state.set', (_, e: any) => { stored[e.key] = e.value; return { value: { isSet: true as const, version: 2 } } })
    on('clock.now', () => ({ value: NOW }))
    on('session.measure', (_, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { percent: 42 } as never,
      rateLimits: [{ kind: 'seven_day', percentUsed: 12, resetsAt: AT(NOW + 3 * 86_400_000) }] as never,
      changed: ['rateLimits'],
    })
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = (await shown(ui)).join('|')
    expect(all).not.toContain('5H')
    expect(all).toContain('WEEK')
    expect(all).toContain('12%')
    await ui.unmount()
  })
}

// ---------- the account ----------
test('default account: label default, orange, the login record\'s email', async ($, on) => {
  world(on, { files: { '/home/ann/.claude.json': LOGIN('ann@example.com') } })
  await start($)
  const { text, backgrounds } = await band($)
  expect(text).toContain('default')
  expect(text).toContain('ann@example.com')
  expect(backgrounds.default).toBe('#ff9e64')
})

test('CLAUDE_CONFIG_DIR names the account: .claude-work is work, with a color of its own', async ($, on) => {
  world(on, {
    env: { HOME: '/home/ann', CLAUDE_CONFIG_DIR: '/home/ann/.claude-work' },
    files: {
      '/home/ann/.claude.json': LOGIN('default@example.com'),
      '/home/ann/.claude-work/.claude.json': LOGIN('work@example.com'),
    },
  })
  await start($)
  const { text, backgrounds } = await band($)
  expect(text).toContain('work@example.com')
  expect(text).not.toContain('default@example.com')
  expect(backgrounds.work).toBe('#d4bcff')
})

test('a config folder with any other name: its name without the dot', async ($, on) => {
  world(on, { env: { HOME: '/home/ann', CLAUDE_CONFIG_DIR: '/srv/ai/team-a/' } })
  await start($)
  const { all, backgrounds } = await band($)
  expect(all.some(t => t.trim() === 'team-a')).toBe(true)
  expect(backgrounds['team-a']).toBe('#9ece6a')
})

test('Windows: USERPROFILE is the home, the project folder is the cwd with dashes', async ($, on) => {
  const cwd = 'C:\\Users\\Ann\\notes'
  world(on, {
    env: { HOME: '/c/Users/Ann', USERPROFILE: 'C:\\Users\\Ann' },
    cwd,
    repo: null,
    files: {
      'C:\\Users\\Ann\\.claude.json': LOGIN('win@example.com'),
      [`C:\\Users\\Ann\\.claude\\projects\\C--Users-Ann-notes\\${SID}.jsonl`]: aiTitle('Windows session'),
    },
  })
  await start($, cwd)
  const { text } = await band($)
  expect(text).toContain('Windows session')
  expect(text).toContain('win@example.com')
  expect(text).toContain('default')
})

// ---------- email lookup ----------
test('the session context\'s email wins over the login record', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: ctxEmail('session@example.com') + aiTitle('T'), '/home/ann/.claude.json': LOGIN('login@example.com') } })
  await start($)
  const { text } = await band($)
  expect(text).toContain('session@example.com')
  expect(text).not.toContain('login@example.com')
})

test('login record missing: no email shown, nothing thrown', async ($, on) => {
  const seen = world(on, { files: {} })
  await start($)
  const { text } = await band($)
  expect(text).not.toContain('@')
  expect(seen.logs.filter(l => l.includes('failed'))).toHaveLength(0)
})

test('login record that is not JSON: no email shown', async ($, on) => {
  world(on, { files: { '/home/ann/.claude.json': '{ this is not json' } })
  await start($)
  expect((await band($)).text).not.toContain('@')
})

test('login record without an account: no email shown', async ($, on) => {
  world(on, { files: { '/home/ann/.claude.json': JSON.stringify({ numStartups: 3 }) } })
  await start($)
  expect((await band($)).text).not.toContain('@')
})

test('with CLAUDE_CONFIG_DIR set only its own login record is read', async ($, on) => {
  const seen = world(on, {
    env: { HOME: '/home/ann', CLAUDE_CONFIG_DIR: '/data/claude-cfg' },
    files: { '/home/ann/.claude.json': LOGIN('home@example.com') },
  })
  await start($)
  expect((await band($)).text).not.toContain('@')
  expect(seen.sawReads.includes('/home/ann/.claude.json')).toBe(false)
})

test('showEmail=false: the login record and the transcript email are never looked up for display', { options: { showEmail: false, showTitle: false, showHookErrors: false, showCacheClock: false } }, async ($, on) => {
  const seen = world(on, { files: { '/home/ann/.claude.json': LOGIN('ann@example.com'), [TRANSCRIPT]: ctxEmail('ann@example.com') } })
  await start($)
  expect((await band($)).text).not.toContain('@')
  expect(seen.sawReads).toHaveLength(0)
})

test('a login record over the 4 MB read limit is read by the Node helper', async ($, on) => {
  const seen = world(on, {
    files: { '/home/ann/.claude.json': { text: LOGIN('big@example.com'), size: 9 * MIB } },
    helper: JSON.stringify({ title: '', transcriptEmail: '', loginEmail: 'big@example.com', email: 'big@example.com' }),
  })
  await start($)
  expect((await band($)).text).toContain('big@example.com')
  expect(seen.sawRuns[0]?.slice(2)).toEqual(['--login-file', '/home/ann/.claude.json'])
})

// ---------- the session title ----------
test('the title comes from the session\'s transcript in its project folder', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: row({ type: 'user', message: { content: 'hi' } }) + aiTitle('Fix the nightly export') } })
  await start($)
  expect((await band($)).text).toContain('Fix the nightly export')
  expect(seen.sawReads).toEqual([TRANSCRIPT])
  expect(seen.sawRuns).toHaveLength(0)
})

test('a rename beats the automatic title', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: aiTitle('Automatic') + renameTo('My own name') + aiTitle('Automatic again') } })
  await start($)
  const { text } = await band($)
  expect(text).toContain('My own name')
  expect(text).not.toContain('Automatic')
})

test('the transcript is found by scanning projects/*/ when the project folder is not the cwd\'s', async ($, on) => {
  const elsewhere = `/home/ann/.claude/projects/-home-ann-other-place/${SID}.jsonl`
  const seen = world(on, {
    files: {
      [elsewhere]: aiTitle('Found by scan'),
      [`/home/ann/.claude/projects/-home-ann-another/${'1'.repeat(8)}.jsonl`]: aiTitle('Someone else'),
    },
  })
  await start($)
  expect((await band($)).text).toContain('Found by scan')
  expect(seen.sawReads).toEqual([elsewhere])
})

test('the transcript is read only when its modification time or size changed', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: aiTitle('First title'), mtimeMs: 100 } } })
  await start($)
  await finishTurn($)
  await finishTurn($)
  expect(seen.sawReads).toHaveLength(1)
  seen.put(TRANSCRIPT, { text: aiTitle('First title') + renameTo('Renamed later'), mtimeMs: 200 })
  await finishTurn($)
  expect(seen.sawReads).toHaveLength(2)
  expect((await band($)).text).toContain('Renamed later')
  seen.put(TRANSCRIPT, { text: aiTitle('First title') + renameTo('Renamed later') + row({ type: 'user' }), mtimeMs: 200 })
  await finishTurn($)
  expect(seen.sawReads).toHaveLength(3)
})

test('the title appears once the transcript exists (it is not there at session start)', async ($, on) => {
  const seen = world(on, { files: {} })
  await start($)
  expect((await band($)).text).not.toContain('Later title')
  seen.put(TRANSCRIPT, aiTitle('Later title'))
  await finishTurn($)
  expect((await band($)).text).toContain('Later title')
})

test('transcript missing: no title, no error', async ($, on) => {
  const seen = world(on, { files: { '/home/ann/.claude/projects/-home-ann-work-notes/other-session.jsonl': aiTitle('Not mine') } })
  await start($)
  const { text } = await band($)
  expect(text).not.toContain('Not mine')
  expect(text).toContain('notes')
  expect(seen.logs.filter(l => l.includes('failed'))).toHaveLength(0)
})

test('a transcript without title entries shows no title', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: row({ type: 'user', message: { content: 'only talking' } }) } })
  await start($)
  expect((await band($)).text).not.toContain('only talking')
})

test('a title quoted inside a message (escaped) is not a title entry', async ($, on) => {
  const quoted = row({ type: 'user', message: { content: 'parse {"type":"ai-title","aiTitle":"Quoted title"} please' } })
  world(on, { files: { [TRANSCRIPT]: aiTitle('Real title') + quoted } })
  await start($)
  const { text } = await band($)
  expect(text).toContain('Real title')
  expect(text).not.toContain('Quoted title')
})

test('a title that exists only as quoted text shows nothing', async ($, on) => {
  const quoted = row({ type: 'user', message: { content: 'parse {"type":"custom-title","customTitle":"Quoted only"} please' } })
  world(on, { files: { [TRANSCRIPT]: quoted } })
  await start($)
  expect((await band($)).text).not.toContain('Quoted only')
})

test('a transcript over the limit is read from its end by the Node helper', async ($, on) => {
  const seen = world(on, {
    files: { [TRANSCRIPT]: { text: aiTitle('never read here'), size: 9 * MIB } },
    helper: JSON.stringify({ title: 'From the helper', transcriptEmail: 'tail@example.com', loginEmail: '', email: 'tail@example.com', transcript: TRANSCRIPT }),
  })
  await start($)
  const { text } = await band($)
  expect(text).toContain('From the helper')
  expect(text).toContain('tail@example.com')
  expect(seen.sawReads).toHaveLength(0)
  expect(seen.sawRuns).toHaveLength(1)
  expect(seen.sawRuns[0]?.[0]).toBe('node')
  expect(seen.sawRuns[0]?.[1]).toMatch(/scripts[\\/]session-info\.mjs$/)
  expect(seen.sawRuns[0]?.slice(2)).toEqual(['--transcript', TRANSCRIPT, '--tail-mb', '8'])
})

test('maxTranscriptMB lowers the limit: a 2 MB transcript goes to the helper', { options: { maxTranscriptMB: 1 } }, async ($, on) => {
  const seen = world(on, {
    files: { [TRANSCRIPT]: { text: aiTitle('read here'), size: 2 * MIB } },
    helper: JSON.stringify({ title: 'Helper title', transcriptEmail: '', loginEmail: '' }),
  })
  await start($)
  expect((await band($)).text).toContain('Helper title')
  expect(seen.sawReads).toHaveLength(0)
  expect(seen.sawRuns[0]?.slice(2)).toEqual(['--transcript', TRANSCRIPT, '--tail-mb', '1'])
})

test('the module reads a transcript up to 4 MB itself, whatever maxTranscriptMB says', { options: { maxTranscriptMB: 20 } }, async ($, on) => {
  const seen = world(on, {
    files: { [TRANSCRIPT]: { text: aiTitle('Read in the module'), size: 3 * MIB } },
    helper: JSON.stringify({ title: 'Helper title' }),
  })
  await start($)
  expect((await band($)).text).toContain('Read in the module')
  expect(seen.sawRuns).toHaveLength(0)
  seen.put(TRANSCRIPT, { text: aiTitle('Read in the module'), size: 5 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect(seen.sawRuns).toHaveLength(1)
  expect(seen.sawRuns[0]?.slice(2)).toEqual(['--transcript', TRANSCRIPT, '--tail-mb', '20'])
})

test('a transcript that grew past the limit with no Node: the last known title stays, and Node is not tried again', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: aiTitle('Earlier title'), mtimeMs: 1 } }, helper: 'missing' })
  await start($)
  expect((await band($)).text).toContain('Earlier title')
  seen.put(TRANSCRIPT, { text: aiTitle('Earlier title'), size: 9 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await band($)).text).toContain('Earlier title')
  expect(seen.sawRuns).toHaveLength(1)
  expect(seen.logs.some(l => l.includes('Node helper did not run'))).toBe(true)
  seen.put(TRANSCRIPT, { text: aiTitle('Earlier title'), size: 10 * MIB, mtimeMs: 3 })
  await finishTurn($)
  expect(seen.sawRuns).toHaveLength(1)
  expect((await band($)).text).toContain('Earlier title')
})

test('over the limit with no Node and no earlier title: no title, nothing thrown', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: aiTitle('x'), size: 9 * MIB } }, helper: 'missing' })
  await start($)
  const { text } = await band($)
  expect(text).toContain('notes')
  expect(seen.sawReads).toHaveLength(0)
  expect(seen.logs.some(l => l.startsWith('Node helper did not run'))).toBe(true)
})

test('the helper finding no title in the tail keeps the last known one', async ($, on) => {
  const seen = world(on, {
    files: { [TRANSCRIPT]: { text: aiTitle('Known title'), mtimeMs: 1 } },
    helper: JSON.stringify({ title: '', transcriptEmail: '', loginEmail: '' }),
  })
  await start($)
  seen.put(TRANSCRIPT, { text: '', size: 9 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await band($)).text).toContain('Known title')
})

test('a helper that exits with an error or prints nonsense changes nothing', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: aiTitle('Known title'), mtimeMs: 1 } }, helper: 'this is not json' })
  await start($)
  seen.put(TRANSCRIPT, { text: '', size: 9 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await band($)).text).toContain('Known title')
})

test('a /clear starts a new session: the old title is gone', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: aiTitle('Old session title') } })
  await start($)
  expect((await band($)).text).toContain('Old session title')
  seen.state.id = '11111111-2222-4333-8444-555566667777'
  await finishTurn($)
  expect((await band($)).text).not.toContain('Old session title')
})

// ---------- surfaces ----------
test('surfaces=desktop with only the terminal attached: no transcript or login file is looked at', { options: { surfaces: 'desktop' } }, async ($, on) => {
  const seen = world(on, { surfaces: ['terminal'], files: { [TRANSCRIPT]: aiTitle('Hidden'), '/home/ann/.claude.json': LOGIN('ann@example.com') } })
  await start($)
  expect(seen.sawStats).toHaveLength(0)
  expect(seen.sawReads).toHaveLength(0)
})

test('desktop+terminal with only the terminal attached: the title and email are looked up and drawn there', { options: BOTH }, async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { [TRANSCRIPT]: aiTitle('Terminal title'), '/home/ann/.claude.json': LOGIN('ann@example.com') } })
  await start($)
  const { text } = await band($, 'terminal')
  expect(text).toContain('Terminal title')
  expect(text).toContain('ann@example.com')
})

test('a desktop attaching later brings the title and email in', { options: { surfaces: 'desktop' } }, async ($, on) => {
  const seen = world(on, { surfaces: ['terminal'], files: { [TRANSCRIPT]: aiTitle('After attach') } })
  await start($)
  expect(seen.sawReads).toHaveLength(0)
  seen.state.surfaces = ['terminal', 'desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect((await band($)).text).toContain('After attach')
})

// ---------- failing hooks ----------
const hookFail = (o: object = {}, type = 'hook_non_blocking_error') => row({ type: 'attachment', attachment: { type, ...o }, timestamp: '2026-11-12T08:00:00Z' })
const STOP_FAIL = { hookName: 'Stop', command: 'bash scripts/x.sh', stderr: 'Failed with non-blocking status code: bash: scripts/x.sh: No such file or directory' }
const WARNING = /⚠/

test('failed hooks: the band warns with their number and the hook that failed last', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) + hookFail({ ...STOP_FAIL, hookName: 'PreToolUse' }) + hookFail(STOP_FAIL) } })
  await start($)
  const { all } = await band($)
  expect(all).toContain('⚠ 3 hook errors (Stop)')
})

test('failed hooks: one failure reads in the singular; none shows no warning', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) } })
  await start($)
  expect((await band($)).all).toContain('⚠ 1 hook error (Stop)')
  seen.put(TRANSCRIPT, { text: aiTitle('T'), mtimeMs: 5 })
  await finishTurn($)
  expect((await band($)).text).not.toMatch(WARNING)
})

test('failed hooks: text quoting a failure inside a message is not a failure', async ($, on) => {
  const quoted = row({ type: 'user', message: { content: 'see {"type":"attachment","attachment":{"type":"hook_non_blocking_error"}}' } })
  world(on, { files: { [TRANSCRIPT]: aiTitle('T') + quoted } })
  await start($)
  expect((await band($)).text).not.toMatch(WARNING)
})

test('failed hooks: showHookErrors=false hides the warning', { options: { showHookErrors: false } }, async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) } })
  await start($)
  const { text } = await band($)
  expect(text).not.toMatch(WARNING)
  expect(text).toContain('T')
})

test('failed hooks: showHookErrors=false hides what the stored state holds too', { options: { showHookErrors: false } }, async ($, on) => {
  seed(on, { ...INFO, hookErrors: { count: 2, last: { hook: 'Stop', command: 'x', reason: 'y' } } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await shown(ui)).join('|')).not.toMatch(WARNING)
  await ui.unmount()
})

test('failed hooks: the warning comes from the one read of the transcript that finds the title', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: aiTitle('T') + hookFail(STOP_FAIL), mtimeMs: 1 } } })
  await start($)
  await band($)
  await band($)
  expect(seen.sawReads).toEqual([TRANSCRIPT])
  await finishTurn($)
  expect(seen.sawReads).toEqual([TRANSCRIPT]) // unchanged file: nothing read again
})

test('failed hooks: pressing the warning toasts the hook, the command and the reason', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) } })
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'hook-errors' })).toBeDefined()
  await ui.press({ key: 'hook-errors' })
  await ui.unmount()
  expect(toasts).toEqual(['Stop hook failed · bash scripts/x.sh · bash: scripts/x.sh: No such file or directory'])
})

test('failed hooks: a transcript over the limit gets its count from the Node helper', async ($, on) => {
  world(on, {
    files: { [TRANSCRIPT]: { text: 'never read here', size: 9 * MIB } },
    helper: JSON.stringify({ title: 'Big', hookErrors: { count: 4, last: { hook: 'SessionStart', command: 'node gone.js', reason: 'Cannot find module' } } }),
  })
  await start($)
  expect((await band($)).all).toContain('⚠ 4 hook errors (SessionStart)')
})

test('failed hooks: a helper that does not know the field keeps the last count', async ($, on) => {
  const seen = world(on, {
    files: { [TRANSCRIPT]: { text: aiTitle('T') + hookFail(STOP_FAIL), mtimeMs: 1 } },
    helper: JSON.stringify({ title: 'Big' }),
  })
  await start($)
  seen.put(TRANSCRIPT, { text: '', size: 9 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await band($)).all).toContain('⚠ 1 hook error (Stop)')
})

test('failed hooks: a /clear starts a new session with no failures', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) } })
  await start($)
  expect((await band($)).text).toMatch(WARNING)
  seen.state.id = '11111111-2222-4333-8444-555566667777'
  await finishTurn($)
  expect((await band($)).text).not.toMatch(WARNING)
})

// ---------- language ----------
const LIMITS = [
  { kind: 'five_hour', percentUsed: 30, resetsAt: AT(NOW + 133 * 60_000) },
  { kind: 'seven_day', percentUsed: 12, resetsAt: AT(NOW + 6.5 * 86_400_000) },
]
const VI_WORDS = ['ngữ cảnh', '5 GIỜ', 'TUẦN', 'mặc định']

test('language auto: a Vietnamese Claude Code setting draws the band in Vietnamese; the numbers and names stay', async ($, on) => {
  world(on, { language: 'Vietnamese', rateLimits: LIMITS, ctx: 42, files: { [TRANSCRIPT]: aiTitle('T') + hookFail(STOP_FAIL) + hookFail(STOP_FAIL) } })
  await start($)
  const { text, all } = await band($)
  for (const word of VI_WORDS) expect(text).toContain(word)
  expect(all).toContain('⚠ 2 lỗi hook (Stop)')
  for (const kept of ['notes', 'Opus 5.5', '42%', '30%', '↻ 2h13m']) expect(text).toContain(kept)
  for (const gone of ['ctx', '5H', 'WEEK', 'default']) expect(text).not.toContain(gone)
})

for (const language of ['English', undefined, 'error', 42]) {
  test(`language auto: the setting ${String(language)} draws English`, async ($, on) => {
    world(on, { language, rateLimits: LIMITS })
    await start($)
    const { text } = await band($)
    for (const word of ['ctx', '5H', 'WEEK', 'default']) expect(text).toContain(word)
    for (const word of VI_WORDS) expect(text).not.toContain(word)
  })
}

test('language auto: the setting is read once at session start, not on every draw', async ($, on) => {
  const seen = world(on, { language: 'vi' })
  await start($)
  await band($)
  await band($)
  await finishTurn($)
  expect(seen.state.settingsReads).toBe(1)
})

test('language=vi draws Vietnamese whatever the setting says', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { language: 'English', rateLimits: LIMITS })
  await start($)
  const { text } = await band($)
  for (const word of VI_WORDS) expect(text).toContain(word)
})

test('language=en draws English even when the setting is Vietnamese', { options: { language: 'en' } }, async ($, on) => {
  world(on, { language: 'Vietnamese', rateLimits: LIMITS })
  await start($)
  const { text } = await band($)
  expect(text).toContain('5H')
  expect(text).not.toContain('TUẦN')
})

test('language: the status line question is asked in Vietnamese and its answer saves surfaces', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, 'Hiện cả hai')
  await start($)
  await settle()
  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toMatch(/đã có status line/)
  expect(seen.set).toEqual([{ key: 'usage-bar.surfaces', value: 'desktop+terminal' }])
})


// ---------- cache clock, forecast, stale, doctor ----------
const assistant = (ageMs: number, o: { oneHour?: boolean; sidechain?: boolean; usage?: object | null } = {}) => row({
  type: 'assistant', timestamp: AT(NOW - ageMs), isSidechain: o.sidechain === true,
  message: { role: 'assistant', usage: o.usage === undefined ? { cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: o.oneHour ? 5 : 0 } } : o.usage },
})
const textProps = async ($: any, needle: string, surface: 'desktop' | 'terminal' = 'desktop') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const hit = (await ui.findAll({ type: 'Text' })).find((t: { text: string }) => t.text.includes(needle))
  const all: string[] = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  await ui.unmount()
  return { hit, all: all.join('|') }
}

test('cache clock: warm shows m:ss in green once the turn has finished', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(53_000) } })
  await start($)
  await finishTurn($)
  const { hit } = await textProps($, '◷')
  expect(hit?.text).toBe('◷ cache 4:07')
  expect(hit?.props.color).toBe('#9ece6a')
})

test('cache clock: under 60 s left is yellow and bold', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(250_000) } })
  await start($)
  await finishTurn($)
  const { hit } = await textProps($, '◷')
  expect(hit?.text).toBe('◷ cache 0:50')
  expect(hit?.props.color).toBe('#e0af68')
  expect(hit?.props.weight).toBe('bold')
})

test('cache clock: once expired it reads cache cold in bold red (nguội in Vietnamese)', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(400_000) } })
  await start($)
  await finishTurn($)
  const cold = await textProps($, '◷')
  expect(cold.hit?.text).toBe('◷ cache cold')
  expect(cold.hit?.props.color).toBe('#ffa3b5')
  expect(cold.hit?.props.weight).toBe('bold')
})

test('cache clock: Vietnamese cold word', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(400_000) } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache nguội')
})

test('cache clock: a 1 hour cache is still warm after ten minutes', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(600_000, { oneHour: true }) } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 50:00')
})

test('cache clock: hidden before the first reply, for a subagent-only transcript and when a field is missing', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: aiTitle('T') } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
  seen.put(TRANSCRIPT, { text: aiTitle('T') + assistant(10_000, { sidechain: true }), mtimeMs: 5 })
  await finishTurn($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
  seen.put(TRANSCRIPT, { text: aiTitle('T') + assistant(10_000, { usage: null }), mtimeMs: 6 })
  await finishTurn($)
  const after = await textProps($, '◷')
  expect(after.all).not.toContain('◷')
  expect(seen.logs).toEqual([])
})

test('cache clock: the transcript is re-read after each turn, so the stamp stays fresh', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: assistant(250_000), mtimeMs: 1 } } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 0:50')
  seen.put(TRANSCRIPT, { text: assistant(250_000) + assistant(1_000), mtimeMs: 2 })
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:59')
})

test('cache clock: showCacheClock=false hides it and the transcript is not read for it', { options: { showCacheClock: false, showTitle: false, showEmail: false, showHookErrors: false } }, async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(53_000) } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
  expect(seen.sawReads).toHaveLength(0)
})

test('cache clock: a transcript over 4 MB takes its stamp from the Node helper', async ($, on) => {
  const helper = JSON.stringify({ title: '', transcriptEmail: '', loginEmail: '', hookErrors: { count: 0, last: null }, cacheStamp: { at: NOW - 100_000, ttlMs: 300_000 } })
  world(on, { helper, files: { [TRANSCRIPT]: { text: '', size: 5 * MIB } } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 3:20')
})

test('cache clock: a helper without cacheStamp keeps the last stamp', async ($, on) => {
  const helper = JSON.stringify({ title: '', transcriptEmail: '', loginEmail: '' })
  const seen = world(on, { helper, files: { [TRANSCRIPT]: { text: assistant(100_000), mtimeMs: 1 } } })
  await start($)
  await finishTurn($)
  seen.put(TRANSCRIPT, { text: '', size: 5 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 3:20')
})

// The timer: 1 s while the clock is on screen, nothing otherwise.
function countNowWrites(on: On) {
  const writes = { count: 0 }
  on('state.set', (_: any, e: any, next: any) => { if (e.key === 'now') writes.count += 1; return next(e) })
  return writes
}

test('1 s clock: counts down while warm and visible, one write per second', async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  await finishTurn($)
  const before = writes.count
  await seen.clock.advance(5000)
  expect(writes.count - before).toBe(5)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:45')
})

test('1 s clock: once cold (or with no reply, or the option off) a tick writes nothing', async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(400_000) } })
  await start($)
  await finishTurn($)
  const before = writes.count
  await seen.clock.advance(5000)
  expect(writes.count).toBe(before)
  seen.put(TRANSCRIPT, { text: aiTitle('x'), mtimeMs: 9 })
  await finishTurn($)
  const mid = writes.count
  await seen.clock.advance(5000)
  expect(writes.count).toBe(mid)
})

test('1 s clock: it stops by itself after the cache runs out, with one last write that shows cold', async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(297_000) } })
  await start($)
  await finishTurn($)
  await seen.clock.advance(5000)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache cold')
  const done = writes.count
  await seen.clock.advance(5000)
  expect(writes.count).toBe(done)
})

test('1 s clock: no timer at all when the option is off', { options: { showCacheClock: false } }, async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  const before = writes.count
  await seen.clock.advance(5000)
  expect(writes.count).toBe(before)
})

test('1 s clock: a surface that does not draw (terminal with a status line) gets no writes', async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { surfaces: ['terminal'], files: { [TRANSCRIPT]: assistant(10_000), '/home/ann/.claude/settings.json': STATUS_LINE } })
  await start($)
  await finishTurn($)
  const before = writes.count
  await seen.clock.advance(5000)
  expect(writes.count).toBe(before)
})

test('1 s clock: a timer that ticks keeps the seconds after the first 60 s tick (no wrong fall back)', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  await finishTurn($)
  await seen.clock.advance(60_000)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 3:50')
})

test('1 s clock: no timer is ever faster than 1 s', async ($, on) => {
  const { periods } = world(on, { timers: 'record', files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  expect(periods.length).toBeGreaterThan(0)
  expect(Math.min(...periods)).toBeGreaterThanOrEqual(1000)
  expect(periods).toContain(60_000)
  expect(periods).toContain(1000)
})

test('1 s clock: a second session.start (/clear, resume) does not stack timers: still one write per second', async ($, on) => {
  const writes = countNowWrites(on)
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  await start($)
  await finishTurn($)
  const before = writes.count
  await seen.clock.advance(5000)
  expect(writes.count - before).toBe(5)
})

test('1 s clock: every session.start registers the 1 s timer again (flags reset)', async ($, on) => {
  const { periods } = world(on, { timers: 'record', files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  await start($)
  expect(periods.filter(p => p === 1000)).toHaveLength(2)
  expect(periods.filter(p => p === 60_000)).toHaveLength(2)
  expect(Math.min(...periods)).toBeGreaterThanOrEqual(1000)
})

// the final reply lands in the transcript a moment after turn.complete
const transcriptReads = (seen: { sawReads: string[] }) => seen.sawReads.filter(p => p.endsWith('.jsonl')).length

test('follow-up: a reply that lands after turn.complete is picked up by one more read ~2.5 s later', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(60_000) } })
  await start($)
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:00')
  seen.put(TRANSCRIPT, { text: assistant(60_000) + assistant(0), mtimeMs: 5 })
  await seen.clock.advance(1000)
  expect((await textProps($, '◷')).hit?.text).not.toBe('◷ cache 5:00')
  await seen.clock.advance(1600)
  const hit = (await textProps($, '◷')).hit?.text
  expect(hit).toBe('◷ cache 4:58')
})

test('follow-up: exactly one extra read, no polling, and none when the file did not change', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: assistant(60_000) } })
  await start($)
  await finishTurn($)
  const afterTurn = transcriptReads(seen)
  await seen.clock.advance(30_000)
  // unchanged file: the follow-up stats it but does not read it again, and nothing keeps polling
  expect(transcriptReads(seen)).toBe(afterTurn)
  const stats = seen.sawStats.length
  await seen.clock.advance(30_000)
  expect(seen.sawStats.length).toBe(stats)
})

test('follow-up: no timer is faster than 1 s', async ($, on) => {
  const { periods } = world(on, { timers: 'record', files: { [TRANSCRIPT]: assistant(60_000) } })
  await start($)
  await finishTurn($)
  expect(Math.min(...periods)).toBeGreaterThanOrEqual(1000)
})

// 5H forecast
const HALF = [{ kind: 'five_hour', percentUsed: 30, resetsAt: AT(NOW + 150 * 60_000) }, { kind: 'seven_day', percentUsed: 12, resetsAt: AT(NOW + 3 * 86_400_000) }]
const fiveAt = (pct: number, fractionLeft: number) => [{ kind: 'five_hour', percentUsed: pct, resetsAt: AT(NOW + fractionLeft * 18_000_000) }]

test('forecast: the 5H row shows the projection right after its percentage, the week row does not', async ($, on) => {
  world(on, { rateLimits: HALF })
  await start($)
  const { all, hit } = await textProps($, '→')
  expect(hit?.text).toBe('→ 60%')
  expect(hit?.props.color).toBe('#8a93bd')
  expect(all.split('→')).toHaveLength(2)
  expect(all.indexOf('30%')).toBeLessThan(all.indexOf('→ 60%'))
  expect(all.indexOf('→ 60%')).toBeLessThan(all.indexOf('↻ 2h30m'))
})

// the window has just ended: the projection is the percentage itself, so these are the boundaries
for (const [pct, text, color, weight] of [[79, '→ 79%', '#8a93bd', undefined], [80, '→ 80%', '#e0af68', undefined], [99, '→ 99%', '#e0af68', undefined], [100, '→ 100%', '#ffa3b5', 'bold']] as const) {
  test(`forecast: ${text} is ${color}${weight ? ' bold' : ''}`, async ($, on) => {
    world(on, { rateLimits: fiveAt(pct, 0) })
    await start($)
    const { hit } = await textProps($, '→')
    expect(hit?.text).toBe(text)
    expect(hit?.props.color).toBe(color)
    expect(hit?.props.weight).toBe(weight)
  })
}

test('forecast: hidden in the first tenth of the window, at 0%, and with showForecast=false', async ($, on) => {
  world(on, { rateLimits: fiveAt(5, 0.95) })
  await start($)
  expect((await textProps($, '→')).all).not.toContain('→')
})

test('forecast: 0% used shows no projection', async ($, on) => {
  world(on, { rateLimits: fiveAt(0, 0.5) })
  await start($)
  expect((await textProps($, '→')).all).not.toContain('→')
})

test('forecast: showForecast=false hides it', { options: { showForecast: false } }, async ($, on) => {
  world(on, { rateLimits: HALF })
  await start($)
  const { all } = await textProps($, '→')
  expect(all).not.toContain('→')
  expect(all).toContain('30%')
})

// stale limits
test('stale: limits not refreshed for over 5 minutes are dim and end with how old they are', async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  await start($)
  const fresh = await textProps($, '⟳')
  expect(fresh.all).not.toContain('⟳')
  await seen.clock.advance(1000)
  await finishTurn($)
  await seen.clock.advance(5 * 60_000 - 1000)
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
  await seen.clock.advance(60_000)
  const stale = await textProps($, '⟳')
  expect(stale.hit?.text).toBe('⟳ old 6m')
  expect(stale.hit?.props.color).toBe('#8a93bd')
  const pct = await textProps($, '30%')
  expect(pct.hit?.props.color).toBe('#8a93bd')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pill = (await ui.findAll({ type: 'Text' })).find((t: any) => t.text.includes('5H'))
  await ui.unmount()
  expect(pill?.props.backgroundColor).toBe('#3b4261')
  expect(pill?.props.color).toBe('#c0caf5')
})

test('stale: a measurement with rate limits makes them fresh again; one without does not', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const seen = world(on, { rateLimits: HALF })
  await start($)
  await seen.clock.advance(1000)
  await finishTurn($)
  await seen.clock.advance(7 * 60_000 - 1000)
  expect((await textProps($, '⟳')).hit?.text).toBe('⟳ old 7m')
  await $.session.measure({ context: { percent: 50 } as never, rateLimits: [], changed: ['context'] })
  await seen.clock.advance(60_000)
  expect((await textProps($, '⟳')).hit?.text).toBe('⟳ old 8m')
  await $.session.measure({ context: { percent: 51 } as never, rateLimits: HALF as never, changed: ['rateLimits'] })
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
})

test('stale: a person who is only idle (no turn since the refresh) never sees the marker', async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  await start($)
  await seen.clock.advance(10 * 60_000)
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
})

test('stale: a turn that ran before the refresh does not make it stale', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const seen = world(on, { rateLimits: HALF })
  await start($)
  await seen.clock.advance(1000)
  await finishTurn($)
  await seen.clock.advance(1000)
  await $.session.measure({ context: { percent: 51 } as never, rateLimits: HALF as never, changed: ['rateLimits'] })
  await seen.clock.advance(10 * 60_000)
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
})

test('stale: a main-thread step counts as a turn', async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  stepHook(on)
  await start($)
  await seen.clock.advance(1000)
  await mainStep($)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.advance(6 * 60_000)
  expect((await textProps($, '⟳')).hit?.text).toBe('⟳ old 6m')
})

test('stale: a subagent step is not a turn of the main thread', async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  stepHook(on)
  await start($)
  await seen.clock.advance(1000)
  await mainStep($, 'sub1')
  await seen.clock.advance(6 * 60_000)
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
})

test('stale: the pill label is readable on the dim background (T.fg on T.hl2)', async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  await start($)
  await seen.clock.advance(1000)
  await finishTurn($)
  await seen.clock.advance(6 * 60_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pill = (await ui.findAll({ type: 'Text' })).find((t: any) => t.text.includes('5H'))
  await ui.unmount()
  expect([pill?.props.backgroundColor, pill?.props.color]).toEqual(['#3b4261', '#c0caf5'])
})

test('stale: Vietnamese marker', { options: { language: 'vi' } }, async ($, on) => {
  const seen = world(on, { rateLimits: HALF })
  await start($)
  await seen.clock.advance(1000)
  await finishTurn($)
  await seen.clock.advance(6 * 60_000 - 1000)
  expect((await textProps($, '⟳')).hit?.text).toBe('⟳ cũ 6m')
})

test('stale: a stored value without the refresh time (older version) is not stale', async ($, on) => {
  seed(on)
  const { all } = await textProps($, '⟳')
  expect(all).not.toContain('⟳')
  expect(all).toContain('30%')
})

test('stale: with no limit data there is no limits row and no marker', async ($, on) => {
  const seen = world(on, {})
  await start($)
  await seen.clock.advance(10 * 60_000)
  expect((await textProps($, '⟳')).all).not.toContain('⟳')
})

// /usage-bar doctor
const doctor = async ($: any, args = 'doctor'): Promise<string> => ((await $.command.run({ command: 'usage-bar', args } as never)) as { text: string }).text

test('the usage-bar command is registered with a hint', async ($, on) => {
  const { commands } = world(on, {})
  await start($)
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({ name: 'usage-bar', argumentHint: '[doctor]' })
  expect(commands[0]?.description).toBeTruthy()
})

test('doctor: no argument or help prints one line of usage', async ($, on) => {
  world(on, {})
  await start($)
  for (const args of ['', 'help', 'what']) {
    const text = await doctor($, args)
    expect(text).toContain('/usage-bar doctor')
    expect(text.split('\n')).toHaveLength(1)
  }
})

test('doctor: a healthy setup is all PASS lines', async ($, on) => {
  world(on, { version: '2.1.319', nodeVersion: 'v22.1.0', rateLimits: LIMITS, files: { [TRANSCRIPT]: assistant(1000), '/home/ann/.claude/settings.json': '{}' } })
  await start($)
  const lines = (await doctor($)).split('\n')
  expect(lines).toHaveLength(6)
  for (const l of lines) expect(l).toMatch(/^PASS /)
  expect(lines[0]).toBe('PASS version - Claude Code 2.1.319 (needs 2.1.275 or later)')
  expect(lines[1]).toBe('PASS node - Node 22.1.0 found (only used for transcripts over 4 MB)')
})

test('doctor: the version falls back to claude --version, then to a quiet WARN', async ($, on) => {
  const a = world(on, { claudeVersion: '2.1.300 (Claude Code)' })
  await start($)
  expect(await doctor($)).toContain('PASS version - Claude Code 2.1.300')
  expect(a.sawRuns.some(r => r[0] === 'claude')).toBe(true)
})

test('doctor: no way to read the version is a WARN, not a FAIL; an old one FAILs', async ($, on) => {
  world(on, {})
  await start($)
  const text = await doctor($)
  expect(text).toMatch(/WARN version - could not tell which Claude Code version this is\. Fix: /)
  expect(text).not.toContain('FAIL')
})

test('doctor: an old Claude Code FAILs with a fix', async ($, on) => {
  world(on, { version: '2.0.5' })
  await start($)
  expect(await doctor($)).toMatch(/FAIL version - Claude Code 2\.0\.5 is older than 2\.1\.275\. Fix: Update Claude Code/)
})

test('doctor: no Node is a WARN and the plugin still works', async ($, on) => {
  world(on, { version: '2.1.319', files: { [TRANSCRIPT]: assistant(1000) } })
  await start($)
  await finishTurn($)
  expect(await doctor($)).toMatch(/WARN node - Node not found.* Fix: Install Node\.js/)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:59')
})

test('doctor: transcript none, fine, large and unreadable', async ($, on) => {
  const seen = world(on, { version: '2.1.319', nodeVersion: '22.0.0' })
  await start($)
  expect(await doctor($)).toMatch(/WARN transcript - no transcript for this session yet\. Fix: /)
  seen.put(TRANSCRIPT, { text: assistant(1000) })
  expect(await doctor($)).toMatch(/PASS transcript - this session's transcript is readable/)
  seen.put(TRANSCRIPT, { text: '', size: 6 * MIB })
  expect(await doctor($)).toMatch(/PASS transcript - .*over 4 MB/)
})

test('doctor: a transcript that exists but cannot be read FAILs', async ($, on) => {
  world(on, { readFails: true, version: '2.1.319', nodeVersion: '22.0.0', files: { [TRANSCRIPT]: assistant(1000) } })
  await start($)
  expect(await doctor($)).toMatch(/FAIL transcript - this session's transcript exists but could not be read\. Fix: /)
})

test('doctor: options that hide rows are each listed; a terminal-only session under surfaces=desktop is too', { options: { surfaces: 'desktop', showForecast: false, showTitle: false } }, async ($, on) => {
  world(on, { surfaces: ['terminal'], version: '2.1.319', nodeVersion: '22.0.0' })
  await start($)
  const band = (await doctor($)).split('\n').find(l => l.includes(' band - ')) ?? ''
  expect(band).toMatch(/^WARN band - /)
  for (const r of ['surfaces leaves out the terminal', 'showForecast is off', 'showTitle is off']) expect(band).toContain(r)
})

test('doctor: a terminal status line under auto is named', async ($, on) => {
  world(on, { surfaces: ['terminal'], version: '2.1.319', nodeVersion: '22.0.0', files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  await start($)
  expect(await doctor($)).toMatch(/WARN band - .*status line is set up/)
})

test('doctor: no rate-limit data is a PASS (API key or third-party provider)', async ($, on) => {
  world(on, { version: '2.1.319' })
  await start($)
  expect(await doctor($)).toMatch(/PASS limits - no rate-limit data yet \(normal with an API key/)
})

test('doctor: the config folder is named by CLAUDE_CONFIG_DIR label only; a default one says so; a missing one WARNs', async ($, on) => {
  world(on, { env: { HOME: '/home/ann', CLAUDE_CONFIG_DIR: '/home/ann/.claude-work' }, files: { '/home/ann/.claude-work/projects/x/y.jsonl': 'x' } })
  await start($)
  const text = await doctor($)
  expect(text).toContain('PASS config - CLAUDE_CONFIG_DIR is set; account label "work"')
  expect(text).not.toContain('/home/ann')
})

test('doctor: default config folder', async ($, on) => {
  world(on, { files: { '/home/ann/.claude/settings.json': '{}' } })
  await start($)
  expect(await doctor($)).toContain('PASS config - default config folder')
})

test('doctor: a config folder that does not exist WARNs', async ($, on) => {
  world(on, { env: { HOME: '/home/ann' } })
  await start($)
  expect(await doctor($)).toMatch(/WARN config - the config folder was not found\. Fix: /)
})

test('doctor: nothing secret is printed: no email, no token, no path', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { version: '2.1.319', nodeVersion: '22.0.0', files: { '/home/ann/.claude.json': LOGIN('ann@example.com'), [TRANSCRIPT]: ctxEmail('ann@example.com') + assistant(1000) } })
  await start($)
  const text = await doctor($)
  expect(text).not.toContain('@')
  expect(text).not.toContain('/home')
  expect(text).not.toContain('.claude.json')
  expect(text.split('\n').every(l => /^(PASS|WARN|FAIL) \S+ - /.test(l))).toBe(true)
})

test('doctor: a failure inside it is logged, not thrown, and the usage line comes back', async ($, on) => {
  world(on, { surfacesFail: true })
  await start($)
  const text = await doctor($)
  expect(text.split('\n').filter(l => /^(PASS|WARN|FAIL) /.test(l)).length + (text.includes('Usage') ? 1 : 0)).toBeGreaterThan(0)
})

// ---------- control characters in hook failures ----------
const DIRTY = { hookName: 'St\u001b]0;x\u0007op', command: 'bash \u001b]0;x\u0007 run.sh', stderr: 'Failed with non-blocking status code: \u001b[31mbash: gone: No such file\u001b[0m' }
const CTL = /[\u0000-\u001f\u007f-\u009f]/

async function pressWarning($: any, on: On): Promise<{ toasts: string[]; all: string }> {
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('|')
  await ui.press({ key: 'hook-errors' })
  await ui.unmount()
  return { toasts, all }
}

test('failed hooks: control characters from the transcript reach neither the toast nor the band', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: aiTitle('T') + hookFail(DIRTY) } })
  const { toasts, all } = await pressWarning($, on)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).not.toMatch(CTL)
  expect(all).not.toMatch(CTL)
  expect(toasts[0]).toContain('St]0;xop')
})

test('failed hooks: control characters in what the Node helper answers are stripped again by the module', async ($, on) => {
  world(on, {
    files: { [TRANSCRIPT]: { text: 'never read here', size: 9 * MIB } },
    helper: JSON.stringify({ title: 'Big', hookErrors: { count: 1, last: { hook: 'St\u001b]0;x\u0007op', command: 'bash \u001b]0;x\u0007 run.sh', reason: '\u001b[31m  bad   thing\u0007 ' } } }),
  })
  const { toasts, all } = await pressWarning($, on)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).not.toMatch(CTL)
  expect(toasts[0]).toBe('St]0;xop hook failed · bash ]0;x run.sh · [31m bad thing')
  expect(all).not.toMatch(CTL)
})

// ---------- the cache clock during a turn ----------
const stepHook = (on: On) => on('turn.step', async function* (_, e) {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
})
const mainStep = async ($: any, agentId?: string) => {
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId } as never)) void chunk
}

test('cache clock: hidden (not red) while a main-thread turn runs, back with the next reply', async ($, on) => {
  const seen = world(on, { files: { [TRANSCRIPT]: { text: assistant(400_000), mtimeMs: 1 } } })
  stepHook(on)
  await start($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache cold')
  await mainStep($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
  seen.put(TRANSCRIPT, { text: assistant(10_000), mtimeMs: 2 })
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:50')
})

test('cache clock: a subagent step does not hide it; session.start clears a stale busy', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: { text: assistant(10_000), mtimeMs: 1 } } })
  stepHook(on)
  await start($)
  await mainStep($, 'a1')
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:50')
  await mainStep($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
  await start($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:50')
})

test('cache clock: a stored state without busy (older version) shows the clock as before', async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: { text: assistant(10_000), mtimeMs: 1 } } })
  await start($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 4:50')
})

// ---------- doctor and Node ----------
test('doctor: a cached "Node missing" does not stand once Node is installed; the probe clears it', async ($, on) => {
  const w: World = { version: '2.1.319', helper: 'missing', files: { [TRANSCRIPT]: { text: '', size: 5 * MIB, mtimeMs: 1 } } }
  const seen = world(on, w)
  await start($)
  expect(seen.logs.some(l => l.includes('Node helper did not run'))).toBe(true)
  w.nodeVersion = 'v22.1.0'
  w.helper = JSON.stringify({ title: 'Big', cacheStamp: { at: NOW - 100_000, ttlMs: 300_000 } })
  expect(await doctor($)).toContain('PASS node - Node 22.1.0 found')
  seen.put(TRANSCRIPT, { text: '', size: 6 * MIB, mtimeMs: 2 })
  await finishTurn($)
  expect((await textProps($, '◷')).hit?.text).toBe('◷ cache 3:20')
})

test('cache clock off: the reply time is not parsed from a transcript the module reads', { options: { showCacheClock: false } }, async ($, on) => {
  world(on, { files: { [TRANSCRIPT]: assistant(10_000) } })
  await start($)
  expect((await textProps($, '◷')).all).not.toContain('◷')
})
