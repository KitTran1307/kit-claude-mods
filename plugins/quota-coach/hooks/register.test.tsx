import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { dayKey } from './report'

const NOW = 1_800_000_000_000
const MIN = 60_000
const SID = '0f9e8d7c-1111-4222-8333-444455556666'
const WINDOW = new Date(NOW + 120 * MIN).toISOString()
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

const BAND = {
  plugin: 'quota-coach',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'quota-coach',
  component: 'Pane',
  requestId: 'quota-report',
  props: { title: 'Report', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type World = {
  /** Context tokens, window and percent of the last response. */
  ctx?: { tokens: number; window: number }
  /** 5-hour window percent; null: the plan has none. */
  five?: number | null
  model?: string
  agents?: number
  draft?: string
  panePlaced?: boolean
  files?: Record<string, string>
  usageFails?: boolean
  compactSkip?: string
  settings?: object
  store?: Record<string, unknown>
  resetsAt?: string
  fillRefusal?: 'dialog'
  compactThrows?: boolean
  usageFor?: (w: World) => unknown
}

// The engine beneath the plugin. Returns what it saw, and the world the test moves between steps.
function world(on: On, given: World = {}) {
  // A copy: a test moves the world between steps, and the shared constants must stay as they were.
  const w: World = { five: 10, ...given }
  const seen = { compacts: 0, fills: [] as string[], fillModes: [] as unknown[], opens: [] as string[], closes: [] as string[], logs: [] as string[], commands: [] as string[] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, given.store)
  mock.env(on, { HOME: '/home/ann' })
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('session.id', () => ({ value: SID }))
  on('session.model', () => ({ value: w.model ?? 'claude-sonnet-5-5' }))
  on('session.usage', () => {
    if (w.usageFails) return { deny: 'no usage' } as never
    const ctx = w.ctx ?? { tokens: 20_000, window: 200_000 }
    const five = w.five
    return {
      value: {
        startedAt: 0,
        context: { tokens: ctx.tokens, window: ctx.window, percent: Math.round((ctx.tokens / ctx.window) * 100) },
        rateLimits: five === null ? [] : [{ kind: 'five_hour', percentUsed: five, resetsAt: w.resetsAt ?? WINDOW }],
      } as never,
    }
  })
  on('agent.list', () => ({ value: Array.from({ length: w.agents ?? 0 }, (_, i) => ({ id: 'a' + i, status: 'running', kind: 'local_agent' })) as never }))
  on('command.register', (_: any, e: any) => { seen.commands.push(e.name); return { value: { command: e.name } } })
  on('settings.read', () => ({ value: (w.settings ?? {}) as never }))
  on('prompt.change', (_, e) => ({ text: e.text, cursor: e.cursor }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => { if (w.compactThrows) throw new Error('boom')
    if (w.compactSkip) return { skip: w.compactSkip }; seen.compacts += 1; return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('prompt.read', () => ({ value: { text: w.draft ?? '', cursor: (w.draft ?? '').length } }))
  on('prompt.fill', (_: any, e: any) => {
    seen.fills.push(e.text); seen.fillModes.push(e.mode)
    return w.fillRefusal ? { isFilled: false, refusal: w.fillRefusal, text: '', cursor: 0 } : { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.open', (_: any, e: any) => { seen.opens.push(e.id); return { value: w.panePlaced === false ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } } })
  on('ui.close', (_: any, e: any) => { seen.closes.push(e.id); return { value: undefined as never } })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.edit', (_, e) => ({ text: e.text, cursor: e.cursor }) as never)
  on('ui.log', (_, e) => { seen.logs.push(e.text); return { value: undefined } })
  const files = w.files ?? {}
  // Paths compare without a drive letter: a test host that resolves /home/ann against its own drive still matches.
  const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '')
  on('fs.list', (_: any, e: any) => {
    const dir = norm(e.path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of Object.keys(files)) if (k.startsWith(dir + '/')) { const rest = k.slice(dir.length + 1); names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file') }
    if (names.size === 0) return { deny: 'ENOENT' } as never
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.stat', (_: any, e: any) => {
    const f = files[norm(e.path)]
    return f === undefined ? ({ deny: 'ENOENT' } as never) : { value: { kind: 'file' as const, size: f.length, mtimeMs: NOW, isLink: false } }
  })
  on('fs.read', (_: any, e: any) => {
    const f = files[norm(e.path)]
    return f === undefined ? ({ deny: 'ENOENT' } as never) : { value: f }
  })
  return { seen, clock, w }
}

const start = ($: any) => $.session.start({ cwd: '/home/ann/work/notes', surface: 'desktop', isInteractive: true })

let last: { unmount: () => Promise<void> } | null = null

async function band($: any, surface: (typeof SURFACES)[number] = 'desktop', props: object = {}) {
  await last?.unmount().catch(() => undefined)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface })
  const all: string[] = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  last = ui
  return { ui, all, text: all.join('|') }
}

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }

/** One main-loop turn: the step, the window moving by `inc` points, the end. */
async function turn($: any, world: { w: World }, inc: number, usage: object = USAGE, model = 'claude-sonnet-5-5') {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  if (typeof world.w.five === 'number') world.w.five += inc
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', usage } as never)
}

/** Typing into the prompt: an edit, as the engine raises it for keys and pastes. */
const typing = ($: any, text: string) => $.prompt.edit({ text, cursor: text.length, start: 0, end: 0, inputText: text, origin: { kind: 'typing' } } as never)

const FULL = { ctx: { tokens: 156_000, window: 200_000 } }

// ---------- tips ----------
for (const surface of SURFACES) {
  test(`a full context shows the compact tip with its button on the ${surface}`, async ($, on) => {
    world(on, FULL)
    await start($)
    const { ui, text } = await band($, surface)
    expect(text).toContain('Context is 78% full')
    expect(text).toContain('/compact')
    expect(await ui.find({ key: 'tip-action' })).toBeDefined()
    expect(await ui.find({ key: 'tip-why' })).toBeDefined()
    expect(await ui.find({ key: 'tip-dismiss' })).toBeDefined()
  })
}

test('below the threshold nothing is drawn: the site is handed on', async ($, on) => {
  world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  const { ui, text } = await band($)
  expect(text).toBe('engine')
})

test('the tips option off hides the tip', { options: { tips: false } }, async ($, on) => {
  world(on, FULL)
  await start($)
  const { ui, text } = await band($)
  expect(text).toBe('engine')
})

test('the context level is an option', { options: { contextTipPercent: 90 } }, async ($, on) => {
  world(on, FULL)
  await start($)
  const { ui, text } = await band($)
  expect(text).toBe('engine')
})

test('three running subagents get a tip with no action button', async ($, on) => {
  world(on, { agents: 3 })
  await start($)
  const { ui, text } = await band($)
  expect(text).toContain('3 subagents are running')
  expect(await ui.find({ key: 'tip-action' })).toBeUndefined()
  expect(await ui.find({ key: 'tip-why' })).toBeDefined()
})

test('two subagents are not many', async ($, on) => {
  world(on, { agents: 2 })
  await start($)
  const { ui, text } = await band($)
  expect(text).toBe('engine')
})

test('a cache that ran out before a big context gets a tip, once the minute tick has passed', async ($, on) => {
  const x = world(on, { ctx: { tokens: 90_000, window: 200_000 } })
  await start($)
  await turn($, x, 0)
  const before = await band($)
  expect(before.text).toBe('engine')
  await x.clock.advance(6 * MIN)
  const { ui, text } = await band($)
  expect(text).toContain('The prompt cache is cold (idle 6 min)')
  expect(text).toContain('~90k tokens')
})

test('a 1-hour cache is not cold after 6 minutes', async ($, on) => {
  const x = world(on, { ctx: { tokens: 90_000, window: 200_000 } })
  await start($)
  await turn($, x, 0, { ...USAGE, ephemeral_1h_input_tokens: 500 })
  await x.clock.advance(6 * MIN)
  expect((await band($)).text).toBe('engine')
})

test('three light turns on Opus suggest Sonnet; Sonnet itself gets no such tip', async ($, on) => {
  const x = world(on, { model: 'claude-opus-5-5' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, model: 'claude-opus-5-5', cache_read_input_tokens: 5000 }, 'claude-opus-5-5')
  const { ui, text } = await band($)
  expect(text).toContain('light work on Opus 5.5')
  expect(await ui.find({ key: 'tip-action' })).toBeDefined()
})

test('Sonnet itself gets no model tip, however light the turns', async ($, on) => {
  const x = world(on, { model: 'claude-sonnet-5-5' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, cache_read_input_tokens: 5000 })
  expect((await band($)).text).toBe('engine')
})

test('a heavy turn (long answer) is not light work', async ($, on) => {
  const x = world(on, { model: 'claude-opus-5-5' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, model: 'claude-opus-5-5', output_tokens: 5000 }, 'claude-opus-5-5')
  expect((await band($)).text).toBe('engine')
})

test('nothing is drawn while a turn runs', async ($, on) => {
  world(on, FULL)
  await start($)
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  expect((await band($)).text).toBe('engine')
})

test('a hand-over to a survey leaves the band alone', async ($, on) => {
  world(on, FULL)
  await start($)
  expect((await band($, 'desktop', { hasSurvey: true })).text).toBe('engine')
})

// ---------- the buttons ----------
test('Compact calls the engine once and says so; the old tip goes at once (the new size is unknown until the next response)', async ($, on) => {
  const x = world(on, FULL)
  await start($)
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect(x.seen.compacts).toBe(1)
  const after = await band($)
  expect(after.text).toContain('Compacted.')
  expect(after.text).not.toContain('Context is')
})

test('a measurement with no token count (just after a compaction) clears the context, so the tip cannot linger', async ($, on) => {
  world(on, FULL)
  await start($)
  expect((await band($)).text).toContain('Context is 78% full')
  await $.session.measure({ context: { window: 200_000 } as never, rateLimits: [], changed: ['context'] })
  expect((await band($)).text).toBe('engine')
})

test('a compaction a hook vetoes is reported, not hidden', async ($, on) => {
  const x = world(on, { ...FULL, compactSkip: 'a hook said no' })
  await start($)
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect((await band($)).text).toContain('Not compacted: a hook said no')
  expect(x.seen.compacts).toBe(0)
})

test('the notice clears itself', async ($, on) => {
  const x = world(on, FULL)
  await start($)
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect((await band($)).text).toContain('Compacted.')
  await x.clock.advance(9000)
  expect((await band($)).text).not.toContain('Compacted.')
})

test('Dismiss hides the tip; it comes back after the context dropped and filled again', async ($, on) => {
  const x = world(on, FULL)
  await start($)
  const first = await band($)
  await first.ui.press({ key: 'tip-dismiss' })
  expect((await band($)).text).toBe('engine')
  // Nothing changed: still dismissed after another measurement.
  await $.session.measure({ context: { tokens: 157_000, window: 200_000, percent: 79 } as never, rateLimits: [], changed: ['context'] })
  expect((await band($)).text).toBe('engine')
  // The context drops (a compaction), then fills again.
  await $.session.measure({ context: { tokens: 20_000, window: 200_000, percent: 10 } as never, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: { tokens: 160_000, window: 200_000, percent: 80 } as never, rateLimits: [], changed: ['context'] })
  expect((await band($)).text).toContain('Context is 80% full')
  void x
})

test('Fill /model sonnet types into an empty prompt and never sends it', async ($, on) => {
  const x = world(on, { model: 'claude-opus-5-5' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, model: 'claude-opus-5-5', cache_read_input_tokens: 5000 }, 'claude-opus-5-5')
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect(x.seen.fills).toEqual(['/model sonnet'])
  expect((await band($)).text).toContain('press Enter to switch')
})

test('Fill /model sonnet leaves a typed draft alone', async ($, on) => {
  const x = world(on, { model: 'claude-opus-5-5', draft: 'write the tests' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, model: 'claude-opus-5-5', cache_read_input_tokens: 5000 }, 'claude-opus-5-5')
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect(x.seen.fills).toEqual([])
  expect((await band($)).text).toContain('nothing was typed')
})

// ---------- the why card ----------
test('Why? opens the card: context, model, subagents, cache, and the actions', async ($, on) => {
  const x = world(on, { ...FULL, model: 'claude-opus-5-5', agents: 3 })
  await start($)
  const { ui } = await band($)
  await ui.press({ key: 'tip-why' })
  const card = await band($, 'desktop', { maxRows: 30 })
  for (const part of ['Why did the last turn cost this?', 'Context', '156k / 200k tokens (78%)', 'Model', 'Opus 5.5', 'About 1.7x Sonnet', 'Subagents', '3 running now', 'Cache', 'not known yet']) {
    expect(card.text).toContain(part)
  }
  expect(await card.ui.find({ key: 'why-compact' })).toBeDefined()
  expect(await card.ui.find({ key: 'why-sonnet' })).toBeDefined()
  await card.ui.press({ key: 'why-compact' })
  expect(x.seen.compacts).toBe(1)
  await card.ui.press({ key: 'why-close' })
  expect((await band($)).text).not.toContain('Why did the last turn')
})

test('/quota why opens the card', async ($, on) => {
  world(on, { ...FULL })
  await start($)
  const out = await $.command.run({ command: 'quota', args: 'why' } as never)
  expect(JSON.stringify(out)).toContain('Showing why the last turn cost')
  expect((await band($)).text).toContain('Why did the last turn cost this?')
})

test('the card knows the cost of the last turn once the rate is learnt, and the cache once a reply was seen', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await $.command.run({ command: 'quota', args: 'why' } as never)
  const { text } = await band($)
  // 4 turns x 13,500 weighted tokens = 54,000 for 8 points: 13,500 x 8/54,000 = 2 points for the last turn.
  expect(text).toContain('~2% of 5H')
  expect(text).toContain('average 2%')
  expect(text).toContain('warm (about 5 min left)')
})

test('a plan with no 5-hour window: the card says only tokens are known', async ($, on) => {
  world(on, { ...FULL, five: null })
  await start($)
  await $.command.run({ command: 'quota', args: 'why' } as never)
  const { text } = await band($)
  expect(text).toContain('only token counts are known')
  expect(text).toContain('cost not measured yet')
})

// ---------- the estimate ----------
test('after three turns the estimate shows while typing: a hand-computed range', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, five: 10 })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'add the tests')
  const { ui, text } = await band($)
  // rate = 8 points / 54,000 weighted; next turn: 100,000 x 0.1 (warm read) + 500 x 5 = 12,500 -> 1.85 points.
  // uncertainty = 0.2 + 1/8 = 0.325 -> 1.25 to 2.45.
  expect(text).toContain('This turn ~2% of 5H (1-2%)')
  expect(text).toContain('18% → 20%')
  expect(text).toContain('Sonnet 5.5')
  expect(text).toContain('ctx 100k')
})

for (const surface of SURFACES) {
  test(`the estimate draws on the ${surface}`, async ($, on) => {
    const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
    await start($)
    for (let i = 0; i < 4; i += 1) await turn($, x, 2)
    await typing($, 'x')
    const { ui, text } = await band($, surface)
    expect(text).toContain('This turn ~')
  })
}

test('a cold cache adds its extra to the estimate', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await x.clock.advance(6 * MIN)
  await typing($, 'x')
  const { ui, text } = await band($)
  // Cold: 100,000 x 1.25 + 2,500 = 127,500 weighted -> 18.9 points; the extra over warm is 17.
  expect(text).toContain('cache cold +17%')
})

test('the estimate is hidden until calibrated, with no draft, with the option off and with no 5-hour window', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  await typing($, 'x')
  for (let i = 0; i < 2; i += 1) await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine') // two turns: not calibrated
  await turn($, x, 2)
  await turn($, x, 2)
  expect((await band($)).text).toBe('engine') // calibrated, but the draft was cleared by the turn
  await typing($, 'x')
  expect((await band($)).text).toContain('This turn ~')
  await typing($, '  ')
  expect((await band($)).text).toBe('engine') // blank draft
})

test('estimate off', { options: { estimate: false } }, async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine')
})

test('a window that resets (the percentage falls) starts the totals over', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, five: 50 })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  x.w.five = 1
  await turn($, x, 0)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine')
})

test('no 5-hour window (API key, third-party provider): no estimate, no error', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, five: null })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine')
  expect(x.seen.logs.filter(l => !/not read/.test(l))).toEqual([])
})

test('usage that cannot be read leaves the band to the engine and logs to debug only', async ($, on) => {
  const x = world(on, { usageFails: true })
  await start($)
  await turn($, x, 0)
  expect((await band($)).text).toBe('engine')
  expect(x.seen.logs.length).toBeGreaterThan(0)
})

// ---------- language ----------
test('Vietnamese when asked', { options: { language: 'vi' } }, async ($, on) => {
  const x = world(on, FULL)
  await start($)
  const { ui, text } = await band($)
  expect(text).toContain('Ngữ cảnh đã đầy 78%')
})

test('auto follows Claude Code\'s language setting', async ($, on) => {
  world(on, { ...FULL, settings: { language: 'Vietnamese' } })
  await start($)
  const { ui, text } = await band($)
  expect(text).toContain('Ngữ cảnh đã đầy 78%')
})

// ---------- the report ----------
const TRANSCRIPT = '/home/ann/.claude/projects/-home-ann-work-notes/' + SID + '.jsonl'
const row = (o: object) => JSON.stringify(o)
const REPLY = (ms: number, model: string, out: number) =>
  row({ type: 'assistant', timestamp: new Date(ms).toISOString(), message: { model, usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } })

test('/quota report opens the pane when one is seated, and the pane draws sessions, models and hours', async ($, on) => {
  const x = world(on, {
    ctx: { tokens: 100_000, window: 200_000 },
    files: { [TRANSCRIPT]: [row({ type: 'ai-title', aiTitle: 'Fix the cart total' }), REPLY(NOW - MIN, 'claude-opus-5-5', 800), REPLY(NOW - 2 * MIN, 'claude-sonnet-5-5', 300)].join('\n') },
  })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 2)
  const out = await $.command.run({ command: 'quota', args: 'report' } as never)
  expect(JSON.stringify(out), JSON.stringify(x.seen.logs)).toContain("report is open in the side pane")
  expect(x.seen.logs).toEqual([])
  expect(x.seen.opens).toEqual(['quota-report'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts: string[] = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  const all = texts.join('|')
  for (const part of ["Today's report", 'SESSIONS', 'Fix the cart total', 'BY MODEL', 'Opus', 'Sonnet', 'BY HOUR']) expect(all).toContain(part)
  // The three measured turns moved the window 6 points; the session carries them.
  expect(all).toContain('6%')
})

test('/quota report falls back to plain text where no pane is seated', async ($, on) => {
  const x = world(on, { panePlaced: false, files: { [TRANSCRIPT]: REPLY(NOW - MIN, 'claude-haiku-4-5', 200) } })
  await start($)
  const out: any = await $.command.run({ command: 'quota', args: 'report' } as never)
  const text = JSON.stringify(out)
  expect(text).toContain('BY MODEL')
  expect(text).toContain('Haiku')
  expect(text).toContain('tokens') // no 5-hour percentages: the report counts tokens
  void x
})

test('/quota report with nothing recorded says so; no transcripts folder is no error', async ($, on) => {
  world(on, { panePlaced: false })
  await start($)
  const out: any = await $.command.run({ command: 'quota', args: 'report' } as never)
  expect(JSON.stringify(out)).toContain('Nothing recorded today yet.')
})

test('the pane before any report was built says so', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Nothing recorded/ }))?.text).toContain('Nothing recorded today yet.')
})

test('/quota with no or an unknown word says how to use it; the command is registered at start', async ($, on) => {
  const x = world(on)
  await start($)
  expect(x.seen.commands).toEqual(['quota'])
  for (const args of ['', 'nonsense']) {
    const out: any = await $.command.run({ command: 'quota', args } as never)
    expect(JSON.stringify(out)).toContain('/quota why')
  }
})

test('the day is kept in the plugin\'s own store, by session, model and hour', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, panePlaced: false })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 2)
  const out: any = await $.command.run({ command: 'quota', args: 'report' } as never)
  const lines: string[] = String(out.text ?? JSON.parse(JSON.stringify(out)).text).split('\n')
  // Three turns moved the window 2 points each: 6 in the subtitle, on the session, on the model and in one hour.
  expect(lines.find(l => l.includes('5H used'))).toContain('5H used 6%')
  expect(lines.filter(l => /\s6%$/.test(l))).toHaveLength(3)
  expect(lines.find(l => l.startsWith('Sonnet'))).toContain('6%')
  expect(lines.find(l => l.includes('303k tokens') || l.includes('305k tokens'))).toBeDefined()
})

// ---------- what a real session does that a simple world does not ----------
test('typing is an edit; a clear or history is a change: both keep the estimate\'s draft flag right', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'hello')
  expect((await band($)).text).toContain('This turn ~')
  await (($ as any).prompt.change as (e: object) => Promise<unknown>)({ text: '', cursor: 0, origin: { kind: 'clear' } })
  expect((await band($)).text).toBe('engine')
  await (($ as any).prompt.change as (e: object) => Promise<unknown>)({ text: 'from history', cursor: 12, origin: { kind: 'history' } })
  expect((await band($)).text).toContain('This turn ~')
})

test('/clear ends the conversation without a new start: what was learnt goes with it', async ($, on) => {
  const x = world(on, FULL)
  await start($)
  await $.command.run({ command: 'quota', args: 'why' } as never)
  expect((await band($)).text).toContain('Why did the last turn cost this?')
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { kind: 'none' } } as never)
  x.w.ctx = { tokens: 5_000, window: 200_000 }
  expect((await band($)).text).toBe('engine')
})

test('a first turn that started with no known percentage teaches nothing: three known turns are needed', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, five: null })
  await start($)
  x.w.five = 10
  await turn($, x, 0) // started with no percentage: not counted
  await turn($, x, 2)
  await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine') // 2 counted turns, 4 points
  await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toContain('This turn ~') // 3 counted turns, 6 points
})

test('another 5-hour window starts the totals over', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toContain('This turn ~')
  const step = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never)
  for await (const chunk of step) void chunk
  x.w.resetsAt = new Date(NOW + 400 * MIN).toISOString()
  x.w.five = 12 // a new window that happens to read higher than the old one did
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer', usage: USAGE } as never)
  await typing($, 'x')
  expect((await band($)).text).toBe('engine')
})

test('the estimate is hidden once the window it belongs to has ended', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  for (let i = 0; i < 4; i += 1) await turn($, x, 2)
  await typing($, 'x')
  expect((await band($)).text).toContain('This turn ~')
  await x.clock.advance(130 * MIN) // past the window's reset time
  expect((await band($)).text).not.toContain('This turn')
})

test('subagents running during a turn get a tip while it runs, and no compact button', async ($, on) => {
  const x = world(on, { agents: 3 })
  await start($)
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never)
  for await (const chunk of stream) void chunk
  const mid = await band($)
  expect(mid.text).toContain('3 subagents are running')
  expect(await mid.ui.find({ key: 'tip-action' })).toBeUndefined()
  x.w.agents = 1
  await x.clock.advance(MIN) // the minute tick looks again
  expect((await band($)).text).toBe('engine')
})

test('a cache written for an hour stays warm for an hour across replies that only read it', async ($, on) => {
  const x = world(on, { ctx: { tokens: 90_000, window: 200_000 } })
  await start($)
  await turn($, x, 0, { ...USAGE, ephemeral_1h_input_tokens: 500, cache_creation_input_tokens: 500 })
  await x.clock.advance(3 * MIN)
  await turn($, x, 0, { ...USAGE, cache_creation_input_tokens: 0 })
  await x.clock.advance(6 * MIN)
  expect((await band($)).text).toBe('engine') // 6 minutes after the last reply, but the entry lives an hour
})

test('the report pane that could not be seated is closed again, and the text goes to the command', async ($, on) => {
  const x = world(on, { panePlaced: false })
  await start($)
  await $.command.run({ command: 'quota', args: 'report' } as never)
  expect(x.seen.closes).toEqual(['quota-report'])
})

test('the report pane\'s Close button closes the pane', async ($, on) => {
  const x = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'report-close' })
  expect(x.seen.closes).toEqual(['quota-report'])
})

test('Fill /model sonnet goes in beside typed text, not over it, and a refusal is said as one', async ($, on) => {
  const x = world(on, { model: 'claude-opus-5-5', fillRefusal: 'dialog' })
  await start($)
  for (let i = 0; i < 3; i += 1) await turn($, x, 0, { ...USAGE, model: 'claude-opus-5-5', cache_read_input_tokens: 5000 }, 'claude-opus-5-5')
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect(x.seen.fillModes).toEqual(['insert'])
  expect((await band($)).text).toContain('Could not type into the prompt right now.')
})

test('a compaction that fails is said as a notice, never thrown', async ($, on) => {
  const x = world(on, { ...FULL, compactThrows: true })
  await start($)
  const { ui } = await band($)
  await ui.press({ key: 'tip-action' })
  expect((await band($)).text).toContain('Could not compact right now.')
  expect(x.seen.logs.some(l => l.includes('compact failed'))).toBe(true)
})

test('the card after a turn shows what the last turn did, and its measured points before the rate is learnt', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 } })
  await start($)
  await turn($, x, 3)
  await $.command.run({ command: 'quota', args: 'why' } as never)
  const { text } = await band($, 'desktop', { maxRows: 30 })
  expect(text).toContain('Last turn')
  expect(text).toContain('1 step · 102k tokens')
  expect(text).toContain('~3% of 5H')
})

test('a short band drops the card\'s explanations and keeps the facts and the buttons', async ($, on) => {
  const x = world(on, { ...FULL, model: 'claude-opus-5-5' })
  await start($)
  await $.command.run({ command: 'quota', args: 'why' } as never)
  const { ui, text } = await band($, 'desktop', { maxRows: 9 })
  expect(text).toContain('156k / 200k tokens (78%)')
  expect(text).not.toContain('Every step re-sends')
  expect(await ui.find({ key: 'why-close' })).toBeDefined()
  void x
})

test('the window\'s high-water mark: a turn that only saw another session\'s points is credited nothing', async ($, on) => {
  const x = world(on, { ctx: { tokens: 100_000, window: 200_000 }, panePlaced: false, store: { highWater: { resetsAt: WINDOW, pct: 14 } } })
  await start($)
  await turn($, x, 2) // 10 -> 12, below the mark of 14: another session spent those points
  let out: any = await $.command.run({ command: 'quota', args: 'report' } as never)
  expect(JSON.stringify(out)).toContain('counts tokens')
  await turn($, x, 6) // 12 -> 18: 4 points above the mark
  out = await $.command.run({ command: 'quota', args: 'report' } as never)
  expect(JSON.stringify(out)).toContain('5H used 4%')
})

test('the report adds up the records of every session of the day', async ($, on) => {
  const date = dayKey(NOW, new Date(NOW).getTimezoneOffset())
  const rec = (id: string, pct: number) => ({
    sessions: { [id]: { title: 'Session ' + id, pct, tokens: 1000, models: { opus: pct } } },
    hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? pct : 0)), models: { opus: pct }, windows: ['W'],
  })
  world(on, { panePlaced: false, store: { ['day:' + date + ':aaa']: rec('aaa', 5), ['day:' + date + ':bbb']: rec('bbb', 7), ['day:2000-01-01:old']: rec('old', 99), highWater: { resetsAt: 'x', pct: 1 } } })
  await start($)
  const out: any = await $.command.run({ command: 'quota', args: 'report' } as never)
  const text = JSON.stringify(out)
  expect(text).toContain('5H used 12%')
  expect(text).toContain('Session aaa')
  expect(text).toContain('Session bbb')
  expect(text).not.toContain('Session old')
})
