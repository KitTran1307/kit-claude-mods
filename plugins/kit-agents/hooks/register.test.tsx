import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'kit-agents',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const PANE = {
  plugin: 'kit-agents',
  component: 'Pane',
  requestId: 'kit-agents',
  props: { title: 'Agent Board', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const NOW = 1_000_000
const raw = (over: Record<string, unknown>) => ({
  id: 'x', status: 'running', kind: 'local_agent', taskStatus: 'running', description: 'd', type: 'general-purpose', label: 'working',
  startTime: NOW - 72_000, cwd: '/w', tokenCount: 0, tokenSamples: [], hasRow: true, ...over,
})
const AGENTS = [
  raw({ id: 'a1', name: 'explore-cart', type: 'Explore', label: 'Find the cart total', model: 'claude-haiku-4-5-20251001', tokenCount: 34_000, contextWindowSize: 100_000, startTime: NOW - 72_000 }),
  raw({ id: 'a2', name: 'test-writer', status: 'waiting', label: 'Write tests for the coupon code', model: 'claude-sonnet-4-5-20250929', tokenCount: 61_000, contextWindowSize: 100_000, startTime: NOW - 277_000 }),
  raw({ id: 'a3', name: 'code-reviewer', label: 'Review PR 482', model: 'claude-sonnet-4-5-20250929', tokenCount: 18_000, contextWindowSize: 100_000, startTime: NOW - 48_000 }),
  raw({ id: 'a4', name: 'done-one', status: 'completed' }),
  raw({ id: 'a5', name: 'resting', status: 'idle' }),
]

type World = {
  now: number
  agents: unknown
  surface: 'terminal' | 'desktop' | null
  failList: boolean
  listCalls: number
  language: unknown
  periods: number // how many one-second periods resolve before the interval is refused
  everyCalls: number[]
  afterCalls: number[]
  opened: { id: string; title?: string }[]
  closed: string[]
  placed: boolean
  panes: { id: string; isPlaced: boolean }[]
  viewCalls: unknown[]
  viewDeny?: string
  toasts: string[]
  commands: string[]
}

const refuse = (why: string) => ({ deny: why })

function engine(on: any, over: Partial<World> = {}): World {
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const w: World = {
    now: NOW, agents: AGENTS, surface: 'terminal', failList: false, listCalls: 0, language: undefined, periods: 2, everyCalls: [], afterCalls: [],
    opened: [], closed: [], placed: true, panes: [], viewCalls: [], toasts: [], commands: [], ...over,
  }
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', (_: unknown, e: any) => ({ text: String(e.text) }))
  on('clock.now', () => ({ value: w.now }))
  on('clock.every', (_: unknown, e: any) => {
    w.everyCalls.push(e.ms)
    return w.everyCalls.length <= w.periods ? { value: {} } : refuse('stop')
  })
  on('clock.after', (_: unknown, e: any) => { w.afterCalls.push(e.ms); return { value: {} } })
  on('agent.list', () => (w.listCalls += 1, w.failList ? refuse('no agents') : { value: w.agents }))
  on('agent.limits', () => ({ value: { concurrent: 20, depth: 2, isBackgroundEnabled: true } }))
  on('settings.read', () => (w.language === 'error' ? refuse('no settings') : { value: w.language === undefined ? {} : { language: w.language } }))
  on('command.register', (_: unknown, e: any) => { w.commands.push(String(e.name)); return { value: { command: e.name } } })
  on('ui.open', (_: unknown, e: any) => {
    w.opened.push({ id: String(e.id), title: e.title })
    w.panes = [{ id: String(e.id), isPlaced: w.placed }]
    return { value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is 100 columns wide' } }
  })
  on('ui.close', (_: unknown, e: any) => { w.closed.push(String(e.id)); w.panes = []; return { value: undefined } })
  on('ui.panes', () => ({ value: w.panes.map(p => ({ ...p, title: p.id, isShown: true, isFocused: false })) }))
  on('ui.view', (_: unknown, e: any) => { w.viewCalls.push(e); return { value: w.viewDeny ? { deny: w.viewDeny } : {} } })
  on('ui.toast', (_: unknown, e: any) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('session.version', () => ({ value: { version: '2.1.331', base: '2.1.331', builtAt: '' } }))
  return w
}

const start = ($: any, w: World) => $.session.start({ cwd: 'D:\\Work\\acme-shop', surface: w.surface, isInteractive: true })
const run = async ($: any, args: string): Promise<string> => String(((await $.command.run({ command: 'board', args } as never)) as any)?.text)
const textsOf = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
const buttonLabels = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.label ?? b.text ?? ''))
const flat = async (ui: any) => (await textsOf(ui)).join('|')

test('the band shows one card per running subagent, the one waiting first with Reply; finished and resting agents are left out', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = await flat(ui)
  expect(all).toContain('Agent Board')
  expect(all).toContain('3 running, 1 waiting')
  for (const s of ['test-writer', 'explore-cart', 'code-reviewer', 'Waiting', 'Haiku 4.5', 'Sonnet 4.5', 'Write tests for the coupon code', '61%', '34%', '18%', '04:37', '01:12', '00:48', 'opens its conversation']) expect(all).toContain(s)
  expect(all).not.toContain('done-one')
  expect(all).not.toContain('resting')
  const texts = await textsOf(ui)
  expect(texts.findIndex(t => t.includes('test-writer'))).toBeLessThan(texts.findIndex(t => t.includes('explore-cart')))
  expect(await buttonLabels(ui)).toEqual(['Reply'])
  await ui.unmount()
})

test('the board is not drawn when no subagent runs, and the band leaves the site to the others', async ($, on) => {
  const w = engine(on, { surface: 'desktop', agents: [raw({ id: 'z', status: 'completed' })] })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
})

test('stacks with the bands beneath it and leaves them the rows it does not use', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await textsOf(ui)).includes('engine')).toBe(true)
  await ui.unmount()
})

test('Reply opens the agent; a refusal or a missing engine call says so in a toast and nothing throws', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'reply-a2' })
  expect(w.viewCalls).toEqual([{ agentId: 'a2' }])
  expect(w.toasts).toEqual([])
  w.viewDeny = 'not person-initiated'
  await ui.press({ key: 'reply-a2' })
  expect(w.toasts.at(-1)).toBe("Could not open that agent from here (not person-initiated). Open it from Claude Code's agent list instead.")
  await ui.unmount()
})

test('a short band turns cards into lines and then one line; it never takes more rows than it is given', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const small = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, maxRows: 4 } })
  const t = await flat(small)
  expect(t).toContain('explore-cart')
  expect(t).not.toContain('opens its conversation')
  expect(await buttonLabels(small)).toEqual(['Reply']) // the waiting line keeps its button
  await small.unmount()
  const one = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, maxRows: 1 } })
  const o = await flat(one)
  expect(o).toContain('3 running, 1 waiting')
  expect(o).not.toContain('explore-cart')
  expect(await buttonLabels(one)).toEqual(['Reply'])
  await one.unmount()
})

test('maxCards 1 shows one subagent and counts the rest', { options: { maxCards: 1 } }, async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const t = await flat(ui)
  expect(t).toContain('test-writer')
  expect(t).not.toContain('explore-cart')
  expect(t).toContain('+2 more')
  await ui.unmount()
})

test('showBand off hides the band; a survey on the site is respected', { options: { showBand: false } }, async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
})

test('a survey holds the band: the board yields', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
})

test('terminal: the pane opens by itself when subagents run, the band steps aside once it is drawn', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(w.opened).toEqual([{ id: 'kit-agents', title: 'Agent Board' }])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(band)).toEqual(['engine'])
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = await flat(pane)
  expect(t).toContain('3 running, 1 waiting')
  expect(t).toContain('Write tests for the coupon code')
  expect(await buttonLabels(pane)).toEqual(['Reply'])
  await pane.unmount()
})

test('terminal too narrow for the pane: it waits undrawn and the band shows the board', async ($, on) => {
  const w = engine(on, { placed: false })
  await start($, w)
  expect(w.opened.length).toBe(1)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await flat(band)).toContain('test-writer')
  await band.unmount()
})

test('usePane off: no pane is opened and the band is always used', { options: { usePane: false } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(w.opened).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await flat(band)).toContain('test-writer')
  await band.unmount()
})

for (const surface of ['desktop', null] as const) {
  test(`surface ${surface} never opens a pane`, async ($, on) => {
    const w = engine(on, { surface })
    await start($, w)
    expect(w.opened).toEqual([])
  })
}

test('the pane is closed when the subagents are done', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(w.opened.length).toBe(1)
  w.agents = []
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.closed).toEqual(['kit-agents'])
})

test('no timer runs while no subagent does', async ($, on) => {
  const w = engine(on, { agents: [] })
  await start($, w)
  expect(w.everyCalls).toEqual([])
})

test('a timer runs every second while a subagent runs', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  expect(w.everyCalls[0]).toBe(1_000)
})

test('each period reads the agent list again, and a redraw shows the time that has passed', async ($, on) => {
  const w = engine(on, { surface: 'desktop', periods: 3 })
  await start($, w)
  for (let i = 0; i < 300; i += 1) await Promise.resolve()
  expect(w.listCalls).toBeGreaterThan(1)
  w.now = NOW + 5_000
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await flat(ui)).toContain('04:42')
  await ui.unmount()
})

test('/board lists the subagents, waiting first', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  expect(w.commands).toEqual(['board'])
  expect((await run($, '')).split('\n')).toEqual([
    'Subagents (3 running, 1 waiting):',
    '1. [Waiting] test-writer - Sonnet 4.5 - 04:37 - context 61% - Write tests for the coupon code',
    '2. [Running] explore-cart - Haiku 4.5 - 01:12 - context 34% - Find the cart total',
    '3. [Running] code-reviewer - Sonnet 4.5 - 00:48 - context 18% - Review PR 482',
  ])
  w.agents = []
  expect(await run($, '')).toBe('No subagents are running.')
  expect(await run($, 'frobnicate')).toBe('Usage: /board | /board pane | /board doctor')
})

test('/board pane opens the pane in the terminal', async ($, on) => {
  const w = engine(on, { placed: false })
  await start($, w)
  expect(await run($, 'pane')).toContain('The pane is open but not drawn yet')
  w.placed = true
  expect(await run($, 'pane')).toBe('Opened the Agent Board pane.')
})

test('/board pane elsewhere says the band is used', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  expect(await run($, 'pane')).toBe('The pane is for the terminal. Here the board is the band above the prompt.')
})

test('/board pane with no subagents says the board opens by itself', async ($, on) => {
  const w = engine(on, { agents: [] })
  await start($, w)
  expect(await run($, 'pane')).toBe('No subagents are running. The board opens by itself when one starts.')
})

test('/board doctor reports each check and a summary, and never throws when calls are missing', async ($, on) => {
  const w = engine(on, { surface: 'desktop' })
  await start($, w)
  const lines = (await run($, 'doctor')).split('\n')
  expect(lines[0]).toBe('PASS claude-code - Claude Code 2.1.331')
  expect(lines.some(l => l.startsWith('PASS agent-list - the engine lists 5 agents, 3 running or waiting'))).toBe(true)
  expect(lines.some(l => l.startsWith('PASS limits - up to 20 subagents at once; background subagents are on'))).toBe(true)
  expect(lines.at(-1)).toMatch(/^\d+ ok, 0 to look at, 0 broken\.$/)
  w.failList = true
  const bad = await run($, 'doctor')
  expect(bad).toContain('WARN agent-list - the engine does not list its subagents')
  expect(bad).toContain('Fix: Update Claude Code')
})

test('an engine that cannot list agents leaves the board empty and starts nothing', async ($, on) => {
  const w = engine(on, { failList: true, surface: 'desktop' })
  await start($, w)
  expect(w.everyCalls).toEqual([])
  expect(w.opened).toEqual([])
  expect(await run($, '')).toBe('This Claude Code does not list its subagents, so the board stays empty.')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
})

test('a spawn is heard: the board looks again at once and shortly after', async ($, on) => {
  const w = engine(on, { surface: 'desktop', agents: [] })
  on('agent.spawn', () => ({ model: 'm' }))
  await start($, w)
  w.agents = AGENTS
  await $.agent.spawn({ prompt: 'Read README.md.' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.afterCalls).toEqual(expect.arrayContaining([400, 2000]))
  expect(w.everyCalls[0]).toBe(1_000)
})

test('language vi draws the board and /board in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = engine(on, { surface: 'desktop', language: 'English' })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const t = await flat(ui)
  for (const s of ['Bảng subagent', '3 đang chạy, 1 đang chờ', 'Đang chờ', 'Đang chạy', 'ngữ cảnh', 'mở cuộc trò chuyện của nó']) expect(t).toContain(s)
  expect(await buttonLabels(ui)).toEqual(['Trả lời'])
  await ui.unmount()
  expect(await run($, '')).toContain('Subagent (3 đang chạy, 1 đang chờ):')
  expect(await run($, 'nope')).toBe('Cách dùng: /board | /board pane | /board doctor')
})

test('language auto follows Claude Code\'s Vietnamese setting', async ($, on) => {
  const w = engine(on, { surface: 'desktop', language: 'Vietnamese' })
  await start($, w)
  expect(await run($, 'frobnicate')).toContain('Cách dùng')
})

test('language auto is English when the setting cannot be read', async ($, on) => {
  const w = engine(on, { surface: 'desktop', language: 'error' })
  await start($, w)
  expect(await run($, 'frobnicate')).toContain('Usage')
})

test('agents with no model, no context window or no label draw without them', async ($, on) => {
  const w = engine(on, { surface: 'desktop', agents: [raw({ id: 'm', name: 'bare', label: '', description: '', tokenCount: 5, startTime: undefined })] })
  await start($, w)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const t = await flat(ui)
  expect(t).toContain('bare')
  expect(t).not.toContain('context')
  expect(t).not.toContain('%')
  await ui.unmount()
})

test('the pane does not open for a short job: it opens once an agent has run 5 seconds', async ($, on) => {
  const w = engine(on, { agents: [raw({ id: 's1', name: 'quick', startTime: NOW - 2_000 })] })
  await start($, w)
  expect(w.opened).toEqual([])
  w.now = NOW + 2_000 // 4 seconds
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.opened).toEqual([])
  w.now = NOW + 3_000 // 5 seconds
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.opened).toEqual([{ id: 'kit-agents', title: 'Agent Board' }])
})

test('an agent with no start time counts from when the board first saw it', async ($, on) => {
  const w = engine(on, { agents: [raw({ id: 's2', name: 'noclock', startTime: undefined })] })
  await start($, w)
  expect(w.opened).toEqual([])
  w.now = NOW + 6_000
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.opened.length).toBe(1)
})

test('a job that ends before 5 seconds never opens or closes a pane', async ($, on) => {
  const w = engine(on, { agents: [raw({ id: 's3', startTime: NOW - 1_000 })] })
  await start($, w)
  w.agents = []
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  expect(w.opened).toEqual([])
  expect(w.closed).toEqual([])
})

test('when the agent list can no longer be read the last board is cleared and the timer stops', async ($, on) => {
  const w = engine(on, { surface: 'desktop', periods: 5 })
  await start($, w)
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await flat(before)).toContain('test-writer')
  await before.unmount()
  w.failList = true
  await $.turn.complete({ text: 'ok', reason: 'answer' } as never)
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textsOf(after)).toEqual(['engine'])
  await after.unmount()
})
