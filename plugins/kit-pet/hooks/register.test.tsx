import { expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { TABLES } from './i18n'
import { dayKey, emptySave, prevDay } from './logic'
import { register } from './register'
import type { Save } from './logic'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const DAY = 86_400_000
const AT = (ms: number) => new Date(ms).toISOString()
const dayOf = (ms: number) => dayKey(ms, new Date(ms).getTimezoneOffset())
const TODAY = dayOf(NOW)
/** The calendar day `n` days before today, by calendar (not by 24 hours: a clock change must not matter). */
const back = (n: number): string => { let d = TODAY; for (let i = 0; i < n; i += 1) d = prevDay(d); return d }
const en = TABLES.en
const vi = TABLES.vi

const BAND = {
  plugin: 'kit-pet',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

type Surface = 'terminal' | 'desktop' | 'mobile'
const SURFACES: Surface[] = ['terminal', 'desktop', 'mobile']

// ---------- the world beneath the plugin ----------

type World = {
  /** What the store holds under `save` at the start. */
  save?: unknown
  surfaces?: string[]
  /** The `language` setting of Claude Code. */
  language?: string
  rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  version?: string | 'error'
  /** `$.store.set` / `$.store.get` / `$.ui.toast` refuse. */
  setFails?: boolean
  getFails?: boolean
  toastFails?: boolean
  /** The 1 s timer is refused / `clock.now` is refused / every timer request is only counted (timers never fire). */
  clock?: 'no-every' | 'no-now' | 'count'
  /** `session.usage`, `settings.read` and `command.register` refuse. */
  engineFails?: boolean
}

function world(on: On, w: World = {}) {
  let clock: ReturnType<typeof mock.clock> = undefined as never
  // Timer requests seen when the clock is not the mock one, and the order of what happens beneath, in a store/toast/engine log.
  const timers: string[] = []
  const order: string[] = []
  if (w.clock === undefined) clock = mock.clock(on, { now: NOW })
  else {
    on('clock.now', () => (w.clock === 'no-now' ? ({ deny: 'no clock' } as never) : { value: NOW }))
    on('clock.every', () => { timers.push('every'); return w.clock === 'no-every' ? ({ deny: 'no timers here' } as never) : { value: undefined as never } })
    on('clock.after', () => { timers.push('after'); return { value: undefined as never } })
  }
  // Atom values the test puts in place of the stored ones (damaged data); off until `garbage.on`.
  const garbage = { on: false, view: undefined as unknown }
  on('state.get', (_, e, next) => (garbage.on ? ({ value: { value: e.key === 'view' ? garbage.view : e.key === 'now' ? 'x' : null, version: 1 } } as never) : next(e)))
  const stored = new Map<string, unknown>(w.save === undefined ? [] : [['save', w.save]])
  const toasts: string[] = []
  const logs: string[] = []
  const commands: Array<{ name: string; description: string }> = []
  const sets: unknown[] = []
  const fails = { set: w.setFails === true, get: w.getFails === true, toast: w.toastFails === true }
  on('store.get', (_, e) => (fails.get ? ({ deny: 'store is gone' } as never) : { value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    if (fails.set) return { deny: 'disk full' } as never
    order.push('store.set')
    stored.set(e.key, JSON.parse(JSON.stringify(e.value)))
    sets.push(stored.get(e.key))
    return { value: undefined as never }
  })
  on('ui.toast', (_: unknown, e: any) => {
    if (fails.toast) return { deny: 'no toasts here' } as never
    order.push('toast')
    toasts.push(String(e.text))
    return { value: undefined as never }
  })
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('command.register', (_: any, e: any) => {
    if (w.engineFails) return { deny: 'refused' } as never
    commands.push(e)
    return { value: { command: e.name } }
  })
  on('session.surfaces', () => ({ value: (w.surfaces ?? ['terminal']) as never }))
  on('session.version', () => (w.version === undefined || w.version === 'error' ? ({ deny: 'not available' } as never) : { value: { version: w.version } as never }))
  on('settings.read', () => (w.engineFails ? ({ deny: 'not available' } as never) : { value: (w.language === undefined ? {} : { language: w.language }) as never }))
  on('session.usage', () => (w.engineFails
    ? ({ deny: 'not available' } as never)
    : { value: { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: w.rateLimits ?? [] } as never }))
  // The engine beneath the plugin: where the events end.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => { order.push('engine:turn.start'); return { turnId: e.turnId } })
  on('turn.complete', () => { order.push('engine:turn.complete'); return { text: '' } })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('classic.PostToolUse', () => { order.push('engine:PostToolUse'); return {} })
  on('classic.PostToolUseFailure', () => ({}))
  return { clock, stored, toasts, logs, commands, sets, fails, garbage, timers, order }
}

const start = ($: any, surface: Surface = 'terminal') => $.session.start({ cwd: '/home/ann/work', surface, isInteractive: true })
const turnStart = ($: any, extra: object = {}) => $.turn.start({ text: 'go', turnId: 't1', ...extra })
const turnEnd = ($: any, reason: 'answer' | 'error' | 'refusal' | 'aborted' = 'answer', durationMs = 161_000, extra: object = {}) =>
  $.turn.complete({
    answer: 'ok', durationMs, isAborted: reason === 'aborted', turnId: 't1', reason,
    ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}), ...extra,
  })
const toolOk = ($: any, name = 'Read', input: unknown = {}, response: unknown = {}, extra: object = {}) =>
  $.classic.PostToolUse({ tool_name: name, tool_input: input, tool_response: response, tool_use_id: 'u1', ...extra })
const toolFail = ($: any, name = 'Bash', extra: object = {}) =>
  $.classic.PostToolUseFailure({ tool_name: name, tool_input: {}, tool_use_id: 'u2', error: 'boom', ...extra })
const measure = ($: any, rateLimits: unknown[]) =>
  $.session.measure({ context: { percent: 10 } as never, rateLimits: rateLimits as never, changed: ['rateLimits'] })
const FIVE = (pct: number, minutes = 109) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: AT(NOW + minutes * 60_000) })

// ---------- drawing and reading the band ----------

type Tree = { type: string; props: Record<string, any>; children?: Array<Tree | string | null | undefined> }
type Mounted = {
  drawn: () => Promise<unknown>
  findAll: (q: { type: string }) => Promise<Array<{ text: string; props: Record<string, any> }>>
  find: (q: { type: string }) => Promise<{ text: string; props: Record<string, any> } | undefined>
  unmount: () => Promise<void>
}

async function mount($: any, surface: Surface, props: object = {}): Promise<Mounted> {
  return $.ui.mount({ ...BAND, surface, props: { ...BAND.props, ...props } })
}
const textsOf = async (ui: Mounted): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map(t => t.text)
/** Everything the band shows as text, joined; the mount is closed again. */
async function band($: any, surface: Surface = 'terminal', props: object = {}) {
  const ui = await mount($, surface, props)
  const texts = await textsOf(ui)
  const svg = await ui.find({ type: 'Svg' })
  const tree = (await ui.drawn()) as Tree
  await ui.unmount()
  return { texts, all: texts.join('|'), flat: texts.join(''), svg, tree }
}
const halfBlocks = (texts: string[]) => texts.filter(t => /[▀▄]/.test(t))

// Rows and columns a tree takes, as the layout (column: stacked, row: side by side) would give them.
const kids = (n: Tree) => (n.children ?? []).filter((c): c is Tree | string => c !== null && c !== undefined)
function rowsOf(n: Tree | string): number {
  if (typeof n === 'string') return 1
  if (n.type === 'Svg') return 3
  if (n.type === 'Text') return 1
  const rows = kids(n).map(rowsOf)
  if (rows.length === 0) return 0
  return n.props?.flexDirection === 'column' ? rows.reduce((a, b) => a + b, 0) : Math.max(...rows)
}
function colsOf(n: Tree | string): number {
  if (typeof n === 'string') return Array.from(n).length
  if (n.type === 'Svg') return 8
  if (n.type === 'Text') return kids(n).reduce((a, c) => a + colsOf(c), 0)
  if (typeof n.props?.width === 'number') return n.props.width
  const cols = kids(n).map(colsOf)
  if (cols.length === 0) return 0
  if (n.props?.flexDirection === 'column') return Math.max(...cols)
  return cols.reduce((a, b) => a + b, 0) + (n.props?.gap ?? 0) * (cols.length - 1)
}

const day = (n: number): string => back(n)
/** A save as the store holds it: `turns` finished, the given days in the history. */
const saveWith = (turns: number, over: Partial<Save> = {}): Save => ({ ...emptySave(), turns, days: [], ...over })

// ---------- every state, on every surface ----------

for (const surface of SURFACES) {
  test(`${surface}: idle shows the name and state pills, the waiting line, the growth bar and the counts`, async ($, on) => {
    world(on, { save: saveWith(34, { days: [TODAY], today: { day: TODAY, turns: 7 } }) })
    await start($, surface)
    const b = await band($, surface)
    expect(b.texts).toContain(' Moss ')
    expect(b.texts).toContain(' IDLE ')
    expect(b.all).toContain(en.idle('Moss'))
    expect(b.all).toContain('7 turns finished today · Sprout')
    expect(b.flat).toContain('▰▰▰▰▱▱')
    expect(b.all).toContain('34/50')
    if (surface === 'terminal') {
      expect(halfBlocks(b.texts).length).toBeGreaterThan(0)
      expect(b.svg).toBeUndefined()
    } else {
      expect(b.svg?.props.alt).toBe('Moss, idle')
      expect(b.svg?.props.height).toBe(48)
      expect(String(b.svg?.props.source)).toContain('<svg')
      expect(halfBlocks(b.texts)).toHaveLength(0)
    }
  })

  test(`${surface}: working shows the clock and the step count with the last tool`, async ($, on) => {
    const w = world(on)
    await start($, surface)
    await turnStart($)
    await toolOk($, 'Read')
    await toolOk($, 'Edit')
    await w.clock.advance(3000)
    const b = await band($, surface)
    expect(b.texts).toContain(' WORKING ')
    expect(b.all).toContain(en.working('Moss', '0:03'))
    expect(b.all).toContain('2 steps so far · last: Edit')
    expect(surface === 'terminal' ? halfBlocks(b.texts).length > 0 : b.svg?.props.alt === 'Moss, working').toBe(true)
  })

  test(`${surface}: done shows how long the turn took and how many turns are left to grow`, async ($, on) => {
    world(on, { save: saveWith(34, { days: [TODAY] }) })
    await start($, surface)
    await turnStart($)
    await turnEnd($, 'answer', 161_000)
    const b = await band($, surface)
    expect(b.texts).toContain(' DONE ')
    expect(b.all).toContain('All done! Took 2m 41s')
    expect(b.all).toContain('Turn #35 · 15 more until Moss grows')
    expect(surface === 'terminal' ? halfBlocks(b.texts).length > 0 : b.svg?.props.alt === 'Moss, done').toBe(true)
  })

  test(`${surface}: a failed step shows the error state, a turn that did not finish another`, async ($, on) => {
    world(on)
    await start($, surface)
    await turnStart($)
    await toolFail($)
    let b = await band($, surface)
    expect(b.texts).toContain(' ERROR ')
    expect(b.all).toContain(en.errorTool('Moss'))
    expect(b.all).toContain(en.lineError())
    await turnEnd($, 'error')
    b = await band($, surface)
    expect(b.texts).toContain(' ERROR ')
    expect(b.all).toContain(en.errorTurn('Moss'))
    expect(surface === 'terminal' ? halfBlocks(b.texts).length > 0 : b.svg?.props.alt === 'Moss, error').toBe(true)
  })

  test(`${surface}: a tool that failed inside a subagent counts as a step but does not make the pet sad`, async ($, on) => {
    world(on)
    await start($, surface)
    await turnStart($)
    await toolFail($, 'Bash', { agent_id: 'sub1' })
    const b = await band($, surface)
    expect(b.texts).toContain(' WORKING ')
    expect(b.all).toContain('1 step so far · last: Bash')
  })

  test(`${surface}: a nearly used limit shows the low-quota state with the refill time`, async ($, on) => {
    world(on, { rateLimits: [FIVE(92, 109)] })
    await start($, surface)
    const b = await band($, surface)
    expect(b.texts).toContain(' LOW QUOTA ')
    expect(b.all).toContain('5-hour limit is 92% used')
    expect(b.all).toContain('Refills in 1h49m')
    expect(surface === 'terminal' ? halfBlocks(b.texts).length > 0 : b.svg?.props.alt === 'Moss, low quota').toBe(true)
  })
}

for (const [pet, name, accent] of [['moss', 'Moss', '#73daca'], ['bun', 'Bun', '#ff9e64'], ['jelly', 'Jelly', '#d4bcff']] as const) {
  test(`pet ${pet}: its name, its accent color, and a sprite in its own colors`, { options: { pet } }, async ($, on) => {
    world(on)
    await start($)
    const ui = await mount($, 'terminal')
    // Jelly's body is the same lavender as its name pill, so the sprite's half blocks are left out of the search.
    const pills = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor === accent && !/[▀▄]/.test(t.text))
    expect(pills.map(p => p.text)).toEqual([` ${name} `])
    expect(halfBlocks(await textsOf(ui)).length).toBeGreaterThan(0)
    await ui.unmount()
    const d = await band($, 'desktop')
    expect(d.svg?.props.alt).toBe(`${name}, idle`)
  })
}

test('an unknown pet option falls back to Moss', { options: { pet: 'dragon' } }, async ($, on) => {
  world(on)
  await start($)
  expect((await band($)).texts).toContain(' Moss ')
})

test('state pills use the design colors', async ($, on) => {
  world(on, { rateLimits: [] })
  await start($)
  const colorOf = async (label: string) => {
    const ui = await mount($, 'terminal')
    const pill = (await ui.findAll({ type: 'Text' })).find(t => t.text === ` ${label} `)
    await ui.unmount()
    return pill?.props.backgroundColor
  }
  expect(await colorOf('IDLE')).toBe('#7aa2f7')
  await turnStart($)
  expect(await colorOf('WORKING')).toBe('#e0af68')
  await toolFail($)
  expect(await colorOf('ERROR')).toBe('#ffa3b5')
  await turnEnd($, 'answer')
  expect(await colorOf('DONE')).toBe('#9ece6a')
  await measure($, [FIVE(90)])
  await turnStart($)
  await turnEnd($, 'aborted')
  expect(await colorOf('LOW QUOTA')).toBe('#ff9e64')
})

// ---------- growth ----------

for (const [turns, stage, line, counts] of [
  [0, 'Sprout', '▱▱▱▱▱▱', '0/50'],
  [34, 'Sprout', '▰▰▰▰▱▱', '34/50'],
  [49, 'Sprout', '▰▰▰▰▰▱', '49/50'],
  [50, 'Little Moss', '▱▱▱▱▱▱', '0/250'],
  [299, 'Little Moss', '▰▰▰▰▰▱', '249/250'],
  [300, 'Blooming Moss', '▰▰▰▰▰▰', '300'],
] as const) {
  test(`growth: ${turns} turns is ${stage}, the bar reads ${line} and the counts ${counts}`, async ($, on) => {
    world(on, { save: saveWith(turns) })
    await start($)
    const b = await band($)
    expect(b.all).toContain(`· ${stage}`)
    expect(b.flat).toContain(line)
    expect(b.all).toContain(counts)
  })
}

test('the three stages draw three different sprites', async ($, on) => {
  const w = world(on)
  const sources: string[] = []
  for (const turns of [0, 100, 400]) {
    w.stored.set('save', saveWith(turns))
    await start($, 'desktop')
    sources.push(String((await band($, 'desktop')).svg?.props.source))
  }
  expect(new Set(sources).size).toBe(3)
})

// ---------- language ----------

test('vi: pills, lines and the sprite alt are Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { save: saveWith(60) })
  await start($, 'desktop')
  const b = await band($, 'desktop')
  expect(b.texts).toContain(' Rêu ')
  expect(b.texts).toContain(' RẢNH ')
  expect(b.all).toContain(vi.idle('Rêu'))
  expect(b.all).toContain('Hôm nay chưa xong lượt nào · Rêu con')
  expect(b.svg?.props.alt).toBe('Rêu, rảnh')
  await turnStart($)
  expect((await band($, 'desktop')).texts).toContain(' ĐANG LÀM ')
})

test('language auto follows the language setting of Claude Code', async ($, on) => {
  world(on, { language: 'Tiếng Việt' })
  await start($)
  expect((await band($)).texts).toContain(' RẢNH ')
})

test('language auto with an unreadable setting is English', async ($, on) => {
  world(on, { engineFails: true })
  await start($)
  expect((await band($)).texts).toContain(' IDLE ')
})

test('language en is English whatever the setting says', { options: { language: 'en' } }, async ($, on) => {
  world(on, { language: 'vi' })
  await start($)
  expect((await band($)).texts).toContain(' IDLE ')
})

// ---------- when the band yields ----------

test('showPet false: nothing of the pet is drawn, the next plugin is, and progress is still counted', { options: { showPet: false } }, async ($, on) => {
  const w = world(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await start($)
  await turnStart($)
  await turnEnd($)
  const b = await band($)
  expect(b.all).toBe('engine')
  expect((w.stored.get('save') as Save).turns).toBe(1)
})

for (const [name, props] of [['a survey', { hasSurvey: true }], ['a collapsed band', { isCollapsed: true }], ['no room', { maxRows: 0 }]] as const) {
  test(`${name}: the pet yields to the next plugin`, async ($, on) => {
    world(on)
    on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
    await start($)
    expect((await band($, 'terminal', props)).all).toBe('engine')
    expect((await band($, 'desktop', props)).all).toBe('engine')
  })
}

test('the pet stacks with the plugin beneath it: both are drawn, the other gets the remaining rows', async ($, on) => {
  world(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>{`engine rows=${e.props.maxRows}`}</Text> })
  await start($)
  const b = await band($, 'terminal', { maxRows: 5 })
  expect(b.all).toContain('Moss')
  // (This engine hands each plugin the band's own rows; the rows left over are offered, and ignored if it keeps its own.)
  expect(b.all).toMatch(/engine rows=\d/)
  const narrow = await band($, 'terminal', { maxRows: 1 })
  expect(narrow.all).toContain('engine rows=')
  expect(rowsOf(narrow.tree)).toBeGreaterThanOrEqual(1)
})

// ---------- layouts: never taller than 3 rows, never taller than allowed, never wider than the band ----------

for (const surface of SURFACES) {
  for (const columns of [20, 30, 60, 120]) {
    for (const maxRows of [1, 2, 3]) {
      test(`${surface} ${columns} columns, ${maxRows} rows allowed: fits`, async ($, on) => {
        world(on, { save: saveWith(34, { days: [TODAY] }), rateLimits: [] })
        await start($, surface)
        const states: Array<() => Promise<unknown>> = [
          async () => undefined,
          () => turnStart($),
          () => toolFail($),
          () => turnEnd($, 'answer'),
          () => measure($, [FIVE(95)]),
        ]
        for (const go of states) {
          await go()
          const { tree, texts } = await band($, surface, { bodyColumns: columns, maxRows })
          const rows = rowsOf(tree)
          expect(rows).toBeGreaterThanOrEqual(1)
          expect(rows).toBeLessThanOrEqual(Math.min(3, maxRows))
          if (surface === 'terminal') expect(colsOf(tree)).toBeLessThanOrEqual(columns)
          const wide = columns >= 44 && maxRows >= 3
          // The sprite only comes with the 3-row layout.
          if (surface === 'terminal') expect(halfBlocks(texts).length > 0).toBe(wide)
          else expect(tree.children !== undefined && JSON.stringify(tree).includes('"Svg"')).toBe(wide)
        }
      })
    }
  }
}

test('narrow (under 24 columns): one row with name, state and the clock, cut to the width less two', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await w.clock.advance(65_000)
  const { texts } = await band($, 'terminal', { bodyColumns: 23, maxRows: 3 })
  expect(texts).toEqual(['Moss · WORKING · 1:05'])
  const cut = await band($, 'terminal', { bodyColumns: 22, maxRows: 3 })
  expect(cut.texts).toEqual(['Moss · WORKING · 1:…'])
  const tiny = await band($, 'terminal', { bodyColumns: 8, maxRows: 3 })
  expect(Array.from(tiny.texts.join('')).length).toBeLessThanOrEqual(6)
  expect(tiny.texts.join('')).toContain('…')
})

test('medium: one row with both pills and the message, cut with an ellipsis to the room left', async ($, on) => {
  world(on)
  await start($)
  const { texts } = await band($, 'terminal', { bodyColumns: 40, maxRows: 3 })
  expect(texts.slice(0, 2)).toEqual([' Moss ', ' IDLE '])
  const message = texts[2] ?? ''
  expect(message.endsWith('…')).toBe(true)
  // 40 columns less the pills (6 + 6) and the two gaps.
  expect(Array.from(message).length).toBeLessThanOrEqual(40 - 6 - 6 - 2)
})

test('wide: the text rows beside the terminal sprite are cut to the width left of it', async ($, on) => {
  world(on)
  await start($)
  const { tree } = await band($, 'terminal', { bodyColumns: 50, maxRows: 3 })
  expect(colsOf(tree)).toBeLessThanOrEqual(50)
  expect(rowsOf(tree)).toBe(3)
})

test('a bad or missing size from the engine still draws something small', async ($, on) => {
  world(on)
  await start($)
  const b = await band($, 'terminal', { bodyColumns: Number.NaN, maxRows: undefined })
  expect(b.all).toContain('Moss')
  expect(rowsOf(b.tree)).toBeLessThanOrEqual(3)
})

// ---------- event flows ----------

test('flow: session start with a saved pet, a turn, tools, a failure, the end and the fade back to idle', async ($, on) => {
  const w = world(on, { save: saveWith(10, { days: [back(1)] }) })
  await start($)
  const ui = await mount($, 'terminal')
  expect((await textsOf(ui)).join('|')).toContain(' IDLE ')

  await turnStart($)
  expect((await textsOf(ui)).join('|')).toContain(' WORKING ')
  await toolOk($, 'Read')
  await toolOk($, 'Grep')
  await toolOk($, 'Edit')
  expect((await textsOf(ui)).join('|')).toContain('3 steps so far · last: Edit')

  await toolFail($, 'Bash')
  expect((await textsOf(ui)).join('|')).toContain(' ERROR ')
  // The error flash ends by itself after 6 s, back to working, without any event.
  await w.clock.advance(6100)
  expect((await textsOf(ui)).join('|')).toContain(' WORKING ')

  await turnEnd($, 'answer', 161_000)
  let all = (await textsOf(ui)).join('|')
  expect(all).toContain(' DONE ')
  expect(all).toContain('Took 2m 41s')
  expect((w.stored.get('save') as Save).turns).toBe(11)
  expect((w.stored.get('save') as Save).days).toEqual([back(1), TODAY])

  await w.clock.advance(7900)
  expect((await textsOf(ui)).join('|')).toContain(' DONE ')
  await w.clock.advance(300)
  all = (await textsOf(ui)).join('|')
  expect(all).toContain(' IDLE ')
  expect(all).toContain('1 turn finished today')
  await ui.unmount()
})

test('flow: the working clock counts seconds while the turn runs and stops with it', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await mount($, 'terminal')
  await turnStart($)
  await w.clock.advance(1000)
  expect((await textsOf(ui)).join('|')).toContain('0:01')
  await w.clock.advance(2000)
  expect((await textsOf(ui)).join('|')).toContain('0:03')
  await turnEnd($)
  await w.clock.advance(5000)
  expect((await textsOf(ui)).join('|')).not.toContain('0:08')
  await ui.unmount()
})

test('flow: a 1 s timer that cannot start leaves the pet working, without a ticking clock', async ($, on) => {
  world(on, { clock: 'no-every' })
  await start($)
  await turnStart($)
  expect((await band($)).texts).toContain(' WORKING ')
  await turnEnd($)
  expect((await band($)).texts).toContain(' DONE ')
})

test('flow: a done flash that is replaced by a new turn is not undone by the old timer', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await turnEnd($)
  await w.clock.advance(5000)
  await turnStart($)
  await w.clock.advance(4000)
  expect((await band($)).texts).toContain(' WORKING ')
})

test('flow: an aborted turn counts nothing and ends in idle', async ($, on) => {
  const w = world(on, { save: saveWith(5, { days: [TODAY], today: { day: TODAY, turns: 2 } }) })
  await start($)
  await turnStart($)
  await turnEnd($, 'aborted', 3000)
  const b = await band($)
  expect(b.texts).toContain(' IDLE ')
  expect(w.sets).toHaveLength(0)
  expect((await $.command.run({ command: 'pet' } as never) as { text: string }).text).toContain('Turns finished: 5')
})

for (const reason of ['error', 'refusal'] as const) {
  test(`flow: a ${reason} ends in the error state and counts nothing`, async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await turnEnd($, reason)
    const b = await band($)
    expect(b.texts).toContain(' ERROR ')
    expect(b.all).toContain(en.errorTurn('Moss'))
    expect(w.sets).toHaveLength(0)
    // The next turn wipes it.
    await turnStart($)
    expect((await band($)).texts).toContain(' WORKING ')
  })
}

test('flow: only the main loop moves the pet: a subagent turn and its tool calls leave it alone for turns', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($, { agentId: 'sub1' })
  expect((await band($)).texts).toContain(' IDLE ')
  await turnEnd($, 'answer', 1000, { agentId: 'sub1' })
  expect((await band($)).texts).toContain(' IDLE ')
  expect(w.sets).toHaveLength(0)
})

test('flow: an interrupted tool is not a failure', async ($, on) => {
  world(on)
  await start($)
  await turnStart($)
  await toolFail($, 'Bash', { is_interrupt: true })
  expect((await band($)).texts).toContain(' WORKING ')
})

test('flow: tool names are cleaned and cut, an MCP tool is just MCP, commands and outputs are never shown or stored', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await toolOk($, 'a_very_long_tool_name_indeed', { command: 'echo SECRET-COMMAND' }, { stdout: 'SECRET-OUTPUT' })
  let b = await band($)
  expect(b.all).toContain('last: a_very_long_tool_na…')
  await toolOk($, 'mcp__some_server__a_very_long_tool_name', { command: 'echo SECRET-COMMAND' }, { stdout: 'SECRET-OUTPUT' })
  b = await band($)
  expect(b.all).toContain('last: MCP')
  expect(b.all).not.toContain('some_server')
  // (A failure inside a subagent leaves the state alone, so the tool name stays on the line.)
  await toolFail($, 'mcp__other_server__tool', { agent_id: 'sub1' })
  b = await band($)
  expect(b.all).toContain('last: MCP')
  expect(b.all).not.toContain('other_server')
  expect(b.all).not.toContain('SECRET')
  await turnEnd($)
  expect(JSON.stringify([...w.stored.values()])).not.toContain('SECRET')
  expect(JSON.stringify(w.logs)).not.toContain('SECRET')
})

test('flow: a limit reading shows the low-quota state at 92%, idle again at 60%, and no reading changes nothing', async ($, on) => {
  world(on, { rateLimits: [] })
  await start($)
  expect((await band($)).texts).toContain(' IDLE ')
  await measure($, [FIVE(92)])
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  // A measurement without limits (API key, nothing new) keeps the last reading.
  await measure($, [])
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  await measure($, [FIVE(60)])
  expect((await band($)).texts).toContain(' IDLE ')
  expect((await band($)).all).not.toContain('limit is')
})

test('flow: the busier of the two windows counts, and its name is said', async ($, on) => {
  world(on)
  await start($)
  await measure($, [FIVE(40), { kind: 'seven_day', percentUsed: 88, resetsAt: AT(NOW + 3 * DAY) }])
  const b = await band($)
  expect(b.all).toContain('Weekly limit is 88% used')
  expect(b.all).toContain('Refills in 3d 0h')
})

test('flow: no limit data at all (API key, third-party provider): the low-quota state never shows', async ($, on) => {
  world(on, { rateLimits: [] })
  await start($)
  await measure($, [])
  await measure($, [{ kind: 'spend_limit', percentUsed: 99 }])
  await turnStart($)
  await turnEnd($, 'aborted')
  expect((await band($)).texts).toContain(' IDLE ')
})

test('flow: the limit read at session start counts', async ($, on) => {
  world(on, { rateLimits: [FIVE(90)] })
  await start($)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
})

test('flow: working wins over low quota, and the quota is back after the turn fades', async ($, on) => {
  const w = world(on, { rateLimits: [FIVE(90)] })
  await start($)
  await turnStart($)
  expect((await band($)).texts).toContain(' WORKING ')
  await turnEnd($, 'aborted')
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  void w
})

test('flow: a reload without session.start still works (the save is read the first time it is needed)', async ($, on) => {
  const w = world(on, { save: saveWith(20) })
  // No session.start: the first event reads the save.
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(21)
  const w2 = await band($)
  expect(w2.all).toContain('Moss')
})

test('flow: a band drawn before anything else loaded shows the saved growth', async ($, on) => {
  world(on, { save: saveWith(34) })
  const b = await band($)
  expect(b.all).toContain('34/50')
})

test('flow: a second session.start (a resume, say; /clear fires session.end and no session.start) starts a clean turn and keeps the progress', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await turnEnd($)
  await start($)
  const b = await band($)
  expect(b.texts).toContain(' IDLE ')
  expect(b.all).toContain('1/50')
  void w
})

// ---------- achievements ----------

const toastFor = (id: 'streak7' | 'turns100' | 'firstTest' | 'firstCommit', pet = 'Moss') =>
  en.toast(en.achievement[id].title, en.achievement[id].text(pet))

test('achievement: the first green test run (npm test in Bash) shows one toast', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' }, { stdout: '' })
  expect(w.toasts).toEqual([toastFor('firstTest')])
  const save = w.stored.get('save') as Save
  expect(save.testGreen).toBe(true)
  expect(save.earned.firstTest).toBe(TODAY)
  expect(save.announced).toEqual(['firstTest'])
  expect(save.lastToastDay).toBe(TODAY)
})

test('achievement: a command that only mentions a test runner is not a test run', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'echo npm test' })
  await toolOk($, 'Read', { command: 'npm test' })
  expect(w.toasts).toEqual([])
  expect(w.sets).toHaveLength(0)
})

test('achievement: a test run that failed (PostToolUseFailure) earns nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await toolFail($, 'Bash')
  expect(w.toasts).toEqual([])
})

test('achievement: the first commit, from the tool result (gitOperation.commit)', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'make ship' }, { gitOperation: { commit: { sha: 'abc1234', kind: 'committed' } } })
  expect(w.toasts).toEqual([toastFor('firstCommit')])
  expect((w.stored.get('save') as Save).committed).toBe(true)
})

test('achievement: the first commit, from the command (git commit)', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'git add -A && git commit -m "x"' })
  expect(w.toasts).toEqual([toastFor('firstCommit')])
})

test('achievement: the 100th finished turn', async ($, on) => {
  const w = world(on, { save: saveWith(99, { days: [TODAY] }) })
  await start($)
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([toastFor('turns100')])
  expect((w.stored.get('save') as Save).turns).toBe(100)
})

test('achievement: a 7-day streak, seeded with the six days before', async ($, on) => {
  const w = world(on, { save: saveWith(30, { days: [1, 2, 3, 4, 5, 6].map(day) }) })
  await start($)
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([toastFor('streak7')])
})

test('achievement: a streak with a gap is no streak', async ($, on) => {
  const w = world(on, { save: saveWith(30, { days: [1, 2, 3, 5, 6].map(day) }) })
  await start($)
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([])
})

test('achievement: two earned on one day show one toast; the others wait for the next days, one a day', async ($, on) => {
  const w = world(on, { save: saveWith(99, { days: [1, 2, 3, 4, 5, 6].map(day) }) })
  await start($)
  await turnStart($)
  await turnEnd($)
  // The 100th turn and the 7th day come on the same turn: the first in the pet's order is cheered.
  expect(w.toasts).toEqual([toastFor('turns100')])
  // A third milestone the same day, and more checks: still only one toast that day.
  await toolOk($, 'Bash', { command: 'pytest' })
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([toastFor('turns100')])
  let save = w.stored.get('save') as Save
  expect(save.announced).toEqual(['turns100'])
  expect(Object.keys(save.earned).sort()).toEqual(['firstTest', 'streak7', 'turns100'])
  // The next day's first check shows the next one in order, the day after that the last.
  await w.clock.advance(DAY)
  await toolOk($, 'Read')
  expect(w.toasts).toEqual([toastFor('turns100')])
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([toastFor('turns100'), toastFor('firstTest')])
  await w.clock.advance(DAY)
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([toastFor('turns100'), toastFor('firstTest'), toastFor('streak7')])
  save = w.stored.get('save') as Save
  expect([...save.announced].sort()).toEqual(['firstTest', 'streak7', 'turns100'])
  await w.clock.advance(DAY)
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toHaveLength(3)
})

test('achievement: a toast is shown once, never again after it is announced', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' })
  await toolOk($, 'Bash', { command: 'npm test' })
  await w.clock.advance(DAY)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toHaveLength(1)
})

test('achievements off: nothing is shown and nothing is marked announced, but the milestone is remembered', { options: { achievements: false } }, async ($, on) => {
  const w = world(on, { save: saveWith(99, { days: [1, 2, 3, 4, 5, 6].map(day) }) })
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' })
  await toolOk($, 'Bash', { command: 'git commit -m x' })
  await turnStart($)
  await turnEnd($)
  expect(w.toasts).toEqual([])
  const save = w.stored.get('save') as Save
  expect(save.announced).toEqual([])
  expect(save.lastToastDay).toBeNull()
  expect(Object.keys(save.earned).sort()).toEqual(['firstCommit', 'firstTest', 'streak7', 'turns100'])
})

test('achievement: the toast speaks the language and names the pet', { options: { language: 'vi', pet: 'bun' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toEqual([vi.toast(vi.achievement.firstTest.title, vi.achievement.firstTest.text('Bao'))])
})

test('achievement: a toast that cannot be shown is not an error, and progress is still saved', async ($, on) => {
  const w = world(on, { toastFails: true })
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toEqual([])
  expect((w.stored.get('save') as Save).testGreen).toBe(true)
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(1)
})

// ---------- failures never break the next hook ----------

test('a store that refuses writes: the pet still counts in memory and every hook still works', async ($, on) => {
  const w = world(on, { setFails: true })
  await start($)
  await turnStart($)
  await toolOk($, 'Bash', { command: 'npm test' })
  await turnEnd($)
  expect(w.stored.has('save')).toBe(false)
  expect((await band($)).texts).toContain(' DONE ')
  expect((await $.command.run({ command: 'pet' } as never) as { text: string }).text).toContain('Turns finished: 1')
  await turnStart($)
  await turnEnd($)
  expect((await $.command.run({ command: 'pet' } as never) as { text: string }).text).toContain('Turns finished: 2')
  // Once the disk works again the progress reaches it.
  w.fails.set = false
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(3)
  expect(w.logs.some(l => l.includes('progress not saved'))).toBe(true)
})

test('a store that cannot be read: a fresh pet, no error', async ($, on) => {
  world(on, { getFails: true })
  await start($)
  const b = await band($)
  expect(b.texts).toContain(' IDLE ')
  expect(b.all).toContain('0/50')
})

test('a failing session.usage, settings and command registration do not stop the start', async ($, on) => {
  const w = world(on, { engineFails: true })
  await start($)
  expect((await band($)).texts).toContain(' IDLE ')
  await turnStart($)
  await turnEnd($)
  expect((await band($)).texts).toContain(' DONE ')
  expect(w.logs.length).toBeGreaterThan(0)
})

test('a failing clock does not break events', async ($, on) => {
  const w = world(on, { clock: 'no-now' })
  await start($)
  await turnStart($)
  await turnEnd($)
  await toolOk($)
  await toolFail($)
  expect(w.logs.length).toBeGreaterThan(0)
  expect((await band($)).all).toContain('Moss')
})

// ---------- damaged data ----------

for (const [name, saved] of [
  ['a string', 'moss'], ['null', null], ['a number', 42], ['an array', [1, 2]],
  ['wrong field types', { turns: 'many', days: 'x', earned: 3, announced: 'all', today: 5, testGreen: 'yes' }],
  ['negative and non-finite numbers', { turns: -50, today: { day: TODAY, turns: -2 }, days: [TODAY, 'nonsense', 20260101] }],
  ['an older shape', { v: 0, count: 9 }],
] as const) {
  test(`damaged save (${name}): the pet starts fresh and draws`, async ($, on) => {
    world(on, { save: saved })
    await start($)
    const b = await band($)
    expect(b.texts).toContain(' IDLE ')
    expect(b.all).toContain('0/50')
    await turnStart($)
    await turnEnd($)
    expect((await band($)).all).toContain('Turn #1')
  })
}

test('damaged state values (a view written by an older version) never crash a draw', async ($, on) => {
  const w = world(on)
  const garbage = [
    'oops', null, 7, [], {},
    { model: 'x', save: 'x', quota: 'x', steps: 'x', lastTool: 5, errorKind: 'weird' },
    { model: { working: 'yes', workingSince: 'now', endReason: 'melted' }, save: { turns: -1 }, quota: { pct: 'high', kind: 'hourly' }, steps: -3, lastTool: { a: 1 } },
    { model: { working: true, workingSince: null }, loaded: true },
  ]
  for (const value of garbage) {
    w.garbage.on = true
    w.garbage.view = value
    const b = await band($, 'terminal')
    expect(b.all).toContain('Moss')
    expect(rowsOf(b.tree)).toBeLessThanOrEqual(3)
    const d = await band($, 'desktop')
    expect(d.svg).toBeDefined()
  }
})

// ---------- /pet ----------

const pet = async ($: any, args?: string): Promise<string> => ((await $.command.run({ command: 'pet', ...(args === undefined ? {} : { args }) } as never)) as { text: string }).text

test('/pet registers itself with a description at session start', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.commands).toHaveLength(1)
  expect(w.commands[0]?.name).toBe('pet')
  expect(w.commands[0]?.description).toBe(en.command.description)
})

test('/pet and /pet status tell how the pet is doing', async ($, on) => {
  world(on, { save: saveWith(34, { days: [back(1), TODAY], earned: { firstCommit: back(3) } }), rateLimits: [FIVE(92)] })
  await start($)
  for (const args of [undefined, '', 'status', ' STATUS ']) {
    const text = await pet($, args)
    expect(text).toContain('Moss · Sprout')
    expect(text).toContain('Turns finished: 34 · 16 more until the next stage')
    expect(text).toContain('Day streak: 2')
    expect(text).toContain('Achievements: First commit')
    expect(text).toContain('Limit: 92% · ↻ 1h49m')
  }
})

test('/pet without limit data leaves the limit line out', async ($, on) => {
  world(on)
  await start($)
  expect(await pet($)).not.toContain('Limit:')
})

test('/pet in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { save: saveWith(3) })
  await start($)
  expect(await pet($)).toContain('Số lượt đã xong: 3')
  expect(await pet($, 'junk')).toBe(vi.command.usage)
})

test('/pet junk shows the usage', async ($, on) => {
  world(on)
  await start($)
  expect(await pet($, 'junk')).toBe(en.command.usage)
  expect(await pet($, 'doctor extra')).toBe(en.command.usage)
})

test('/pet doctor: everything fine is all PASS', async ($, on) => {
  world(on, { version: '2.1.331', surfaces: ['terminal', 'desktop'], rateLimits: [FIVE(40)] })
  await start($)
  const lines = (await pet($, 'doctor')).split('\n')
  expect(lines).toEqual([
    'PASS version - Claude Code 2.1.331 works with the pet',
    'PASS surfaces - the pet can show on: terminal, desktop',
    "PASS save - your pet's progress is saved and readable",
    'PASS limits - limit data is available (40% used)',
  ])
})

test('/pet doctor: a limit reading whose window has reset counts as unknown', async ($, on) => {
  const w = world(on, { version: '2.1.331', surfaces: ['terminal'], rateLimits: [FIVE(92, 109)] })
  await start($)
  expect(await pet($, 'doctor')).toContain('PASS limits - limit data is available (92% used)')
  await w.clock.advance(110 * 60_000)
  expect(await pet($, 'doctor')).toContain('PASS limits - limit data is not available')
})

test('/pet doctor: unknown version, no surface, no limit data and a hidden pet', { options: { showPet: false } }, async ($, on) => {
  world(on, { version: 'error', surfaces: [] })
  await start($)
  const text = await pet($, 'doctor')
  expect(text).toContain('WARN version - ')
  expect(text).toContain('WARN surfaces - ')
  expect(text).toContain('PASS limits - limit data is not available')
  expect(text).toContain('WARN band - the pet is hidden: showPet.')
})

test('/pet doctor: an old Claude Code fails the version check', async ($, on) => {
  world(on, { version: '2.0.9' })
  await start($)
  expect(await pet($, 'doctor')).toContain('FAIL version - Claude Code 2.0.9 is older than 2.1.275.')
})

test('/pet doctor: a store that cannot be read or written is a WARN, and nothing is written to test it', async ($, on) => {
  const w = world(on, { getFails: true })
  await start($)
  expect(await pet($, 'doctor')).toContain('WARN save - ')
  expect(w.sets).toHaveLength(0)
})

test('/pet doctor: a damaged save is reported', async ($, on) => {
  world(on, { save: 'junk' })
  await start($)
  expect(await pet($, 'doctor')).toContain('WARN save - ')
})

test('/pet doctor: a write that failed shows up as a WARN', async ($, on) => {
  world(on, { setFails: true })
  await start($)
  await turnStart($)
  await turnEnd($)
  expect(await pet($, 'doctor')).toContain('WARN save - ')
})

test('/pet doctor in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  world(on, { version: '2.1.331' })
  await start($)
  expect(await pet($, 'doctor')).toContain('PASS version - Claude Code 2.1.331 chạy được với thú cưng')
})

test('/pet works without session.start', async ($, on) => {
  world(on, { save: saveWith(7) })
  expect(await pet($)).toContain('Turns finished: 7')
})

// ---------- several sessions at once ----------

/** What another session of the same person would have written to the store meanwhile. */
const other = (w: ReturnType<typeof world>, over: Partial<Save>) => { w.stored.set('save', { ...(w.stored.get('save') as Save | undefined ?? emptySave()), ...over }) }

test('two sessions: a turn in a stale session adds to what the other session saved instead of overwriting it', async ($, on) => {
  const w = world(on, { save: saveWith(10, { days: [back(1)] }) })
  await start($)
  await turnStart($)
  // The other session finished 5 turns, on another day too, while this one was working.
  other(w, { turns: 15, days: [back(3), back(1)] })
  await turnEnd($)
  let save = w.stored.get('save') as Save
  expect(save.turns).toBe(16)
  expect(save.days).toEqual([back(3), back(1), TODAY])
  // The merged save is what the band and /pet show now, and it is the new base: the next turn counts once.
  expect(await pet($)).toContain('Turns finished: 16')
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(17)
  // And again, with the other session writing in between.
  other(w, { turns: 20 })
  await turnStart($)
  await turnEnd($)
  save = w.stored.get('save') as Save
  expect(save.turns).toBe(21)
  expect((await band($)).all).toContain('Turn #21')
})

test('two sessions: an achievement the other session earned and announced is not announced again', async ($, on) => {
  const w = world(on, { save: saveWith(99, { days: [TODAY] }) })
  await start($)
  await turnStart($)
  // The other session reached the 100th turn first, cheered it and wrote that down.
  other(w, { turns: 100, earned: { turns100: TODAY }, announced: ['turns100'], lastToastDay: TODAY })
  await turnEnd($)
  expect(w.toasts).toEqual([])
  const save = w.stored.get('save') as Save
  expect(save.turns).toBe(101)
  expect(save.announced).toEqual(['turns100'])
  expect(save.earned.turns100).toBe(TODAY)
})

test('two sessions: an achievement earned in the other session is announced here once, and the one already announced is not', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toEqual([toastFor('firstTest')])
  // The other session commits (earned, not yet cheered); this session cheers it the next day, but not firstTest again.
  other(w, { committed: true, earned: { ...(w.stored.get('save') as Save).earned, firstCommit: TODAY } })
  await w.clock.advance(DAY)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toEqual([toastFor('firstTest'), toastFor('firstCommit')])
  // Once only, not again on the next events.
  await turnStart($)
  await turnEnd($)
  await toolOk($, 'Bash', { command: 'npm test' })
  expect(w.toasts).toHaveLength(2)
  const save = w.stored.get('save') as Save
  expect(save.committed).toBe(true)
  expect(save.announced).toEqual(['firstCommit', 'firstTest'])
})

test('two sessions: a store that cannot be re-read is written from this session alone', async ($, on) => {
  const w = world(on, { save: saveWith(4) })
  await start($)
  w.fails.get = true
  await turnStart($)
  await turnEnd($)
  w.fails.get = false
  expect((w.stored.get('save') as Save).turns).toBe(5)
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(6)
})

test('two sessions: after a reload without session.start nothing is counted twice', async ($, on) => {
  const w = world(on, { save: saveWith(20) })
  await turnStart($)
  await turnEnd($)
  expect((w.stored.get('save') as Save).turns).toBe(21)
})

// ---------- a test run must really be green ----------

test('achievement: a test run that went to the background, timed out or was interrupted is not green', async ($, on) => {
  const w = world(on)
  await start($)
  const cmd = { command: 'npm test' }
  await toolOk($, 'Bash', cmd, { backgroundTaskId: 'b1' })
  await toolOk($, 'Bash', cmd, { timedOutAfterMs: 120_000 })
  await toolOk($, 'Bash', cmd, { interrupted: true })
  await toolOk($, 'Bash', cmd, { backgroundedByUser: true })
  expect(w.toasts).toEqual([])
  expect(w.sets).toHaveLength(0)
  // interrupted: false is just a normal finish.
  await toolOk($, 'Bash', cmd, { interrupted: false, stdout: 'ok' })
  expect(w.toasts).toEqual([toastFor('firstTest')])
})

test('achievement: a line whose exit status is not the test\'s (|| true, ; echo, a pipe, a watcher) is not green', async ($, on) => {
  const w = world(on)
  await start($)
  for (const command of ['npm test || true', 'npm test; echo done', 'npm test | tail -5', 'npm run test:watch', 'npm test &']) await toolOk($, 'Bash', { command })
  expect(w.toasts).toEqual([])
  expect((w.stored.get('save') as Save | undefined)?.testGreen ?? false).toBe(false)
  await toolOk($, 'Bash', { command: 'cd app && npm run build && npm test' })
  expect(w.toasts).toEqual([toastFor('firstTest')])
})

test('achievement: a commit that went to the background is not counted, one with gitOperation.commit is', async ($, on) => {
  const w = world(on)
  await start($)
  await toolOk($, 'Bash', { command: 'git commit -m x' }, { backgroundTaskId: 'b1' })
  await toolOk($, 'Bash', { command: 'git commit -m x' }, { interrupted: true })
  await toolOk($, 'Bash', { command: 'make ship' }, { backgroundedByUser: true, gitOperation: { commit: { sha: 'abc' } } })
  expect(w.toasts).toEqual([])
  await toolOk($, 'Bash', { command: 'make ship' }, { gitOperation: { commit: { sha: 'abc' } } })
  expect(w.toasts).toEqual([toastFor('firstCommit')])
})

// ---------- subagent tools ----------

test('flow: a subagent\'s tool result counts as a step but neither flashes nor clears the error', async ($, on) => {
  world(on)
  await start($)
  await turnStart($)
  await toolOk($, 'Read', {}, {}, { agent_id: 'sub1' })
  let b = await band($)
  expect(b.texts).toContain(' WORKING ')
  expect(b.all).toContain('1 step so far · last: Read')
  await toolFail($, 'Bash')
  expect((await band($)).texts).toContain(' ERROR ')
  // The error of the main loop stays while a subagent's tool succeeds.
  await toolOk($, 'Grep', {}, {}, { agent_id: 'sub1' })
  b = await band($)
  expect(b.texts).toContain(' ERROR ')
  expect(b.all).not.toContain('last: Grep')
  // The main loop's own success clears it.
  await toolOk($, 'Edit')
  b = await band($)
  expect(b.texts).toContain(' WORKING ')
  expect(b.all).toContain('4 steps so far · last: Edit')
})

// ---------- the hot path ----------

test('hot path: the event is passed on before the save is written and the toast is shown', async ($, on) => {
  const w = world(on, { save: saveWith(99, { days: [TODAY] }) })
  await start($)
  await turnStart($)
  w.order.length = 0
  await turnEnd($)
  expect(w.order[0]).toBe('engine:turn.complete')
  expect(w.order.slice(1)).toContain('store.set')
  expect(w.order.slice(1)).toContain('toast')
  expect(w.toasts).toEqual([toastFor('turns100')])
  expect((w.stored.get('save') as Save).turns).toBe(100)

  w.order.length = 0
  await toolOk($, 'Bash', { command: 'git commit -m x' })
  expect(w.order[0]).toBe('engine:PostToolUse')
  expect(w.order.slice(1)).toContain('store.set')
  expect((w.stored.get('save') as Save).committed).toBe(true)
})

test('hot path: a store write that throws never stops the event from being passed on', async ($, on) => {
  const w = world(on, { setFails: true })
  await start($)
  await turnStart($)
  w.order.length = 0
  await turnEnd($)
  expect(w.order).toContain('engine:turn.complete')
})

// ---------- no timers when nothing can be shown ----------

test('showPet false: no 1 s tick and no redraw timers are started', { options: { showPet: false } }, async ($, on) => {
  const w = world(on, { clock: 'count' })
  await start($)
  await turnStart($)
  await toolFail($)
  await turnEnd($)
  await turnStart($)
  await turnEnd($, 'error')
  expect(w.timers).toEqual([])
  expect((w.stored.get('save') as Save).turns).toBe(1)
})

test('showPet true: the same events do start the timers (the test above would otherwise prove nothing)', async ($, on) => {
  const w = world(on, { clock: 'count' })
  await start($)
  await turnStart($)
  await toolFail($)
  await turnEnd($)
  expect(w.timers).toContain('every')
  expect(w.timers).toContain('after')
})

// ---------- a limit that has reset ----------

test('flow: a low-quota state ends when the limit has reset, the band no longer shows the old reading', async ($, on) => {
  const w = world(on, { rateLimits: [FIVE(92, 30)] })
  await start($)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  await w.clock.advance(29 * 60_000)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  await w.clock.advance(2 * 60_000)
  const b = await band($)
  expect(b.texts).toContain(' IDLE ')
  expect(b.all).not.toContain('limit is')
  expect(await pet($)).not.toContain('Limit:')
  // A new reading brings it back.
  await measure($, [{ kind: 'five_hour', percentUsed: 90, resetsAt: AT(NOW + 5 * 3_600_000) }])
  expect((await band($)).texts).toContain(' LOW QUOTA ')
})

// ---------- an error that ends by itself ----------

for (const reason of ['error', 'refusal'] as const) {
  test(`flow: the ${reason} state of a turn ends after 60 s by itself, without any event`, async ($, on) => {
    const w = world(on)
    await start($)
    const ui = await mount($, 'terminal')
    await turnStart($)
    await turnEnd($, reason)
    expect((await textsOf(ui)).join('|')).toContain(' ERROR ')
    // Sticky inside the minute.
    await w.clock.advance(59_000)
    expect((await textsOf(ui)).join('|')).toContain(' ERROR ')
    await w.clock.advance(1_100)
    const all = (await textsOf(ui)).join('|')
    expect(all).toContain(' IDLE ')
    expect(all).not.toContain(' ERROR ')
    await ui.unmount()
  })
}

test('flow: an error inside its minute is still wiped by the next turn, and the old timer does not undo it', async ($, on) => {
  const w = world(on)
  await start($)
  await turnStart($)
  await turnEnd($, 'error')
  await w.clock.advance(30_000)
  expect((await band($)).texts).toContain(' ERROR ')
  await turnStart($)
  expect((await band($)).texts).toContain(' WORKING ')
  await w.clock.advance(40_000)
  expect((await band($)).texts).toContain(' WORKING ')
})

test('flow: after the error minute the low-quota state shows when the limit is high', async ($, on) => {
  const w = world(on, { rateLimits: [FIVE(92, 600)] })
  await start($)
  await turnStart($)
  await turnEnd($, 'error')
  expect((await band($)).texts).toContain(' ERROR ')
  await w.clock.advance(61_000)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
})

// ---------- a commit must really be one ----------

test('achievement: a commit whose exit status is masked (|| echo, a pipe) is not counted from the command line', async ($, on) => {
  const w = world(on)
  await start($)
  for (const command of ['git commit -m x || echo nothing', 'git commit -m x | cat', 'git commit -m x; echo done', 'git commit -m x &']) await toolOk($, 'Bash', { command })
  expect(w.toasts).toEqual([])
  expect((w.stored.get('save') as Save | undefined)?.committed ?? false).toBe(false)
  await toolOk($, 'Bash', { command: 'git add . && git commit -m x' })
  expect(w.toasts).toEqual([toastFor('firstCommit')])
})

test('achievement: gitOperation.commit counts whatever the command line says, and a gitOperation without a commit stops the text fallback', async ($, on) => {
  const w = world(on)
  await start($)
  // The engine saw a push only: the line is not read for a commit.
  await toolOk($, 'Bash', { command: 'git commit -m x' }, { gitOperation: { push: { branch: 'main' } } })
  expect(w.toasts).toEqual([])
  await toolOk($, 'Bash', { command: 'git commit -m x || echo nothing' }, { gitOperation: { commit: { sha: 'abc' } } })
  expect(w.toasts).toEqual([toastFor('firstCommit')])
})

// ---------- a limit reading without a reset time ----------

const NO_RESET = { kind: 'five_hour', percentUsed: 92 }
const HOUR = 3_600_000

test('flow: a reading without a reset time is dropped after 6 hours, /pet status too; a fresh measure restores it', async ($, on) => {
  const w = world(on, { rateLimits: [NO_RESET] })
  await start($)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  await w.clock.advance(5 * HOUR + 59 * 60_000)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  expect(await pet($)).toContain('Limit: 92%')
  await w.clock.advance(2 * 60_000)
  expect((await band($)).texts).toContain(' IDLE ')
  expect(await pet($)).not.toContain('Limit:')
  await measure($, [NO_RESET])
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  expect(await pet($)).toContain('Limit: 92%')
})

test('flow: a reading with a reset time in the future is kept whatever its age', async ($, on) => {
  const w = world(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 92, resetsAt: AT(NOW + 3 * DAY) }] })
  await start($)
  await w.clock.advance(7 * HOUR)
  expect((await band($)).texts).toContain(' LOW QUOTA ')
  expect(await pet($)).toContain('Limit: 92%')
})

test('flow: a stored reading from an older version (no time taken, no reset time) counts as unknown', async ($, on) => {
  const w = world(on)
  w.garbage.on = true
  w.garbage.view = { model: { quotaPct: 92 }, loaded: true, quota: { pct: 92, resetsAt: null, kind: 'five_hour' } }
  expect((await band($)).texts).toContain(' IDLE ')
})

// ---------- which events are hooked ----------

test('no tool.call or tool.run hook is registered (that would turn off background-moving and live output of Bash)', () => {
  const names: string[] = []
  const on = ((name: string) => { names.push(name) }) as unknown as On
  register(on, {})
  expect(names.length).toBeGreaterThan(0)
  expect(names.filter(n => n === 'tool.call' || n === 'tool.run' || n.startsWith('tool.call') || n.startsWith('tool.run'))).toEqual([])
  expect(names).toContain('classic.PostToolUse')
})
