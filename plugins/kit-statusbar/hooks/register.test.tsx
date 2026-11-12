import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

const NOW = 1_800_000_000_000
const MIB = 1024 * 1024
const SID = '0f9e8d7c-1111-4222-8333-444455556666'
const AT = (ms: number) => new Date(ms).toISOString()

const BAND = {
  plugin: 'kit-statusbar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
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
for (const surface of ['terminal', 'desktop'] as const) {
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
    expect(seen.set).toEqual([{ key: 'kit-statusbar.surfaces', value: surfaces }])
    expect((await band($, 'terminal')).text).toBe('engine') // until the saved answer reloads the plugin
  })
}

test('a dismissed question keeps auto: the terminal stays with the status line, nothing is saved', async ($, on) => {
  world(on, { surfaces: ['terminal'], files: { '/home/ann/.claude/settings.json': STATUS_LINE } })
  const seen = asks(on, null)
  await start($)
  await settle()
  expect(seen.set).toEqual([])
  expect((await band($, 'terminal')).text).toBe('engine')
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
  expect(await colorOf(ui, 'work')).toBe('#bb9af7')
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
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: state.id }))
  on('session.cwd', () => ({ value: w.cwd ?? '/home/ann/work/notes' }))
  on('session.model', () => ({ value: w.model ?? 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: state.surfaces }))
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
    if (w.helper === undefined || w.helper === 'missing') return { deny: 'spawn node ENOENT' }
    return { value: { exitCode: 0, stdout: w.helper, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { sawReads, sawStats, sawRuns, logs, state, clock, put }
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
  expect(backgrounds.work).toBe('#bb9af7')
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

test('showEmail=false: the login record and the transcript email are never looked up for display', { options: { showEmail: false, showTitle: false, showHookErrors: false } }, async ($, on) => {
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
  expect(seen.set).toEqual([{ key: 'kit-statusbar.surfaces', value: 'desktop+terminal' }])
})
