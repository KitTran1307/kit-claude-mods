import { expect, test } from 'claude-code/testing'

import {
  PANE_AFTER_MS, ageOf, anyLongRunning, barCells, boardAgents, cardRows, cleanText, compactText, contextBar, contextPercent, countLevels, countWaiting, elapsedOf, formatElapsed,
  formatLine, listLine, maxCardsFrom, metaText, modelLabel, paletteFor, planBoard, planRows, sortAgents, stateOf, toBoardAgent,
} from './data'
import { TABLES, languageFromSetting, languageOption } from './i18n'
import type { BoardAgent } from '../types'

const EN = TABLES.en
const agent = (over: Partial<BoardAgent> = {}): BoardAgent => ({ id: 'a1', name: 'explore-cart', type: 'Explore', state: 'running', label: 'Find the cart total', ...over })

test('maxCards is a whole number from 1 to 12, 4 when it is not a number', () => {
  expect(maxCardsFrom(undefined)).toBe(4)
  expect(maxCardsFrom('abc')).toBe(4)
  expect(maxCardsFrom('')).toBe(4)
  expect(maxCardsFrom(NaN)).toBe(4)
  expect(maxCardsFrom(0)).toBe(1)
  expect(maxCardsFrom(-3)).toBe(1)
  expect(maxCardsFrom(99)).toBe(12)
  expect(maxCardsFrom(2.6)).toBe(3)
  expect(maxCardsFrom('6')).toBe(6)
})

test('cleanText makes one clean line and cuts it', () => {
  expect(cleanText('a\nb\t  c', 20)).toBe('a b c')
  expect(cleanText('x\u202ey\u200bz', 20)).toBe('x y z')
  expect(cleanText('abcdefghij', 5)).toBe('abcd…')
  expect(cleanText(42, 5)).toBe('')
  expect(cleanText('   ', 5)).toBe('')
})

test('state mapping: running, waiting, starting; anything else is not active', () => {
  expect(stateOf('running')).toBe('running')
  expect(stateOf('waiting')).toBe('waiting')
  expect(stateOf('pending')).toBe('starting')
  for (const s of ['idle', 'completed', 'failed', 'killed', undefined, 3]) expect(stateOf(s)).toBe(null)
})

test('model ids read as Sonnet 4.5, Haiku 3.5, Opus 4; no id, no label', () => {
  expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
  expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(modelLabel('claude-opus-4-1')).toBe('Opus 4.1')
  expect(modelLabel('claude-sonnet-20250101')).toBe('Sonnet')
  expect(modelLabel('sonnet')).toBe('Sonnet')
  expect(modelLabel('gpt-x-large')).toBe('gpt-x-large')
  expect(modelLabel('')).toBeUndefined()
  expect(modelLabel(undefined)).toBeUndefined()
})

test('context percent is clamped and absent when the window is unknown', () => {
  expect(contextPercent(34_000, 100_000)).toBe(34)
  expect(contextPercent(120_000, 100_000)).toBe(100)
  expect(contextPercent(-5, 100_000)).toBe(0)
  expect(contextPercent(0, 100_000)).toBe(0)
  expect(contextPercent(10, 0)).toBeUndefined()
  expect(contextPercent(10, undefined)).toBeUndefined()
  expect(contextPercent(undefined, 100)).toBeUndefined()
  expect(contextPercent(NaN, 100)).toBeUndefined()
  expect(contextPercent(10, Infinity)).toBeUndefined()
})

test('context bar has the cells asked, filled first, and stays in range', () => {
  expect(contextBar(0, 10)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(contextBar(50, 10)).toBe('▰▰▰▰▰▱▱▱▱▱')
  expect(contextBar(100, 6)).toBe('▰▰▰▰▰▰')
  expect(contextBar(250, 4)).toBe('▰▰▰▰')
  expect(contextBar(-9, 4)).toBe('▱▱▱▱')
  expect(Array.from(contextBar(34, 10)).length).toBe(10)
  expect(barCells(30)).toBe(6)
  expect(barCells(80)).toBe(10)
})

test('elapsed time is mm:ss, then h:mm:ss, never negative', () => {
  expect(formatElapsed(0)).toBe('00:00')
  expect(formatElapsed(-5000)).toBe('00:00')
  expect(formatElapsed(NaN)).toBe('00:00')
  expect(formatElapsed(72_000)).toBe('01:12')
  expect(formatElapsed(277_999)).toBe('04:37')
  expect(formatElapsed(3_600_000)).toBe('1:00:00')
  expect(formatElapsed(3_725_000)).toBe('1:02:05')
  expect(elapsedOf({ startTime: 1000 }, 73_000)).toBe('01:12')
  expect(elapsedOf({}, 73_000)).toBeUndefined()
})

test('toBoardAgent keeps what the engine gives and leaves out what it does not', () => {
  const a = toBoardAgent({
    id: 'x1', name: 'test-writer', type: 'general-purpose', status: 'waiting', label: 'Write tests\nfor the coupon code', description: 'd',
    startTime: 5000, model: 'claude-sonnet-4-5-20250929', tokenCount: 61_000, contextWindowSize: 100_000,
  })
  expect(a).toEqual({ id: 'x1', name: 'test-writer', type: 'general-purpose', state: 'waiting', label: 'Write tests for the coupon code', model: 'Sonnet 4.5', startTime: 5000, pct: 61 })
  const bare = toBoardAgent({ id: 'abcdefghijkl', status: 'running' })
  expect(bare).toEqual({ id: 'abcdefghijkl', name: 'abcdefgh', type: '', state: 'running', label: '' })
  expect(toBoardAgent({ id: 'x', type: 'Explore', status: 'pending', description: 'Look around' })).toMatchObject({ name: 'Explore', state: 'starting', label: 'Look around' })
  expect(toBoardAgent({ id: 'x', status: 'completed' })).toBe(null)
  expect(toBoardAgent({ status: 'running' })).toBe(null)
  expect(toBoardAgent(null)).toBe(null)
  expect(toBoardAgent('x')).toBe(null)
})

test('ordering: waiting for the person first, then the longest running, ties by id', () => {
  const list = [
    agent({ id: 'c', startTime: 300 }), agent({ id: 'w', state: 'waiting', startTime: 900 }), agent({ id: 'a', startTime: 100 }),
    agent({ id: 'n2' }), agent({ id: 'n1' }), agent({ id: 'b', startTime: 100 }),
  ]
  expect(sortAgents(list).map(a => a.id)).toEqual(['w', 'a', 'b', 'c', 'n1', 'n2'])
  expect(boardAgents([{ id: 'q', status: 'running', startTime: 2 }, { id: 'p', status: 'waiting', startTime: 9 }, { id: 'q', status: 'running' }, { id: 'z', status: 'idle' }]).map(a => a.id)).toEqual(['p', 'q'])
  expect(boardAgents(undefined)).toEqual([])
  expect(boardAgents({})).toEqual([])
  expect(countWaiting(list)).toBe(1)
})

test('card rows count border, lines, bar and Reply', () => {
  expect(cardRows(agent({ pct: 10 }))).toBe(6)
  expect(cardRows(agent())).toBe(5)
  expect(cardRows(agent({ label: '' }))).toBe(4)
  expect(cardRows(agent({ pct: 61, state: 'waiting' }))).toBe(7)
})

test('planBoard: three agents fit whole in 40 rows (about 20), fewer rows turn cards into lines, then a count', () => {
  const three = [agent({ id: 'w', state: 'waiting', pct: 61 }), agent({ id: 'a', pct: 34 }), agent({ id: 'b', pct: 18 })]
  expect(planBoard(40, three, 4)).toEqual({ mode: 'board', full: 3, compact: 0, hidden: 0, rows: 1 + 7 + 6 + 6 })
  // 12 rows: header 1 + budget 11; compact baseline 3; the waiting card (+6) fits, the next (+5) does not.
  expect(planBoard(12, three, 4)).toEqual({ mode: 'board', full: 1, compact: 2, hidden: 0, rows: 10 })
  // 4 rows: budget 3, all three as lines, none upgraded.
  expect(planBoard(4, three, 4)).toEqual({ mode: 'board', full: 0, compact: 3, hidden: 0, rows: 4 })
  // 3 rows: budget 2: one line and the "+N more" line.
  expect(planBoard(3, three, 4)).toEqual({ mode: 'board', full: 0, compact: 1, hidden: 2, rows: 3 })
  expect(planBoard(2, three, 4)).toEqual({ mode: 'line', rows: 1 })
  expect(planBoard(0, three, 4)).toEqual({ mode: 'line', rows: 1 })
  expect(planBoard(NaN, three, 4)).toEqual({ mode: 'line', rows: 1 })
  expect(planBoard(40, [], 4)).toEqual({ mode: 'none' })
})

test('planBoard: maxCards hides the rest on a "+N more" line, and no plan ever exceeds the rows given', () => {
  const many = Array.from({ length: 9 }, (_, i) => agent({ id: 'a' + i, pct: i * 10, state: i === 5 ? 'waiting' : 'running' }))
  const sorted = sortAgents(many)
  expect(planBoard(100, sorted, 2)).toMatchObject({ mode: 'board', full: 2, compact: 0, hidden: 7 })
  expect(planBoard(100, sorted, 12)).toMatchObject({ mode: 'board', full: 9, hidden: 0 })
  for (let rows = 1; rows <= 60; rows += 1) {
    for (const cards of [1, 4, 12]) {
      const plan = planBoard(rows, sorted, cards)
      expect(planRows(plan)).toBeLessThanOrEqual(Math.max(1, rows))
      if (plan.mode === 'board') {
        expect(plan.full + plan.compact).toBeLessThanOrEqual(cards)
        expect(plan.full + plan.compact + plan.hidden).toBe(sorted.length)
        const real = 1 + sorted.slice(0, plan.full).reduce((n, a) => n + cardRows(a), 0) + plan.compact + (plan.hidden > 0 ? 1 : 0)
        expect(real).toBe(plan.rows)
      }
    }
  }
})

test('text forms of an agent', () => {
  const a = agent({ state: 'waiting', model: 'Sonnet 4.5', pct: 61, startTime: 0 })
  expect(compactText(a, 277_000, EN)).toBe('04:37 Sonnet 4.5 61% Waiting Find the cart total')
  expect(compactText(agent(), 1000, EN)).toBe('Find the cart total')
  expect(metaText(a, EN)).toEqual({ state: 'Waiting', rest: ' · Sonnet 4.5 · Explore' })
  expect(metaText(agent({ name: 'Explore' }), EN)).toEqual({ state: 'Running', rest: '' })
  expect(listLine(a, 0, 277_000, EN)).toBe('1. [Waiting] explore-cart - Sonnet 4.5 - 04:37 - context 61% - Find the cart total')
  expect(listLine(agent(), 1, 0, EN)).toBe('2. [Running] explore-cart - Find the cart total')
  expect(compactText(a, 0, TABLES.vi)).toContain('Đang chờ')
})

test('palettes: dark in the terminal, light elsewhere; doctor lines format and count', () => {
  expect(paletteFor('terminal').border).not.toBe(paletteFor('desktop').border)
  expect(paletteFor('terminal').waiting).toBe('#efa890')
  expect(paletteFor(undefined)).toEqual(paletteFor('desktop'))
  const lines = [{ level: 'PASS' as const, name: 'a', detail: 'ok' }, { level: 'WARN' as const, name: 'b', detail: 'hm', fix: 'do x' }, { level: 'FAIL' as const, name: 'c', detail: 'no' }]
  expect(lines.map(formatLine)).toEqual(['PASS a - ok', 'WARN b - hm Fix: do x', 'FAIL c - no'])
  expect(countLevels(lines)).toEqual({ pass: 1, warn: 1, fail: 1 })
})

test('language: the option and Claude Code\'s own setting; both tables have the same shape', () => {
  expect(languageOption('vi')).toBe('vi')
  expect(languageOption('en')).toBe('en')
  expect(languageOption('fr')).toBe('auto')
  expect(languageOption(undefined)).toBe('auto')
  for (const v of ['Vietnamese', 'vi', 'vi-VN', 'Tiếng Việt']) expect(languageFromSetting(v)).toBe('vi')
  for (const v of ['English', 'French', 'video', undefined, 5]) expect(languageFromSetting(v)).toBe('en')
  expect(Object.keys(TABLES.vi).sort()).toEqual(Object.keys(TABLES.en).sort())
  expect(Object.keys(TABLES.vi.doctor).sort()).toEqual(Object.keys(TABLES.en.doctor).sort())
  expect(TABLES.en.count(3, 1)).toBe('3 running, 1 waiting')
  expect(TABLES.vi.count(3, 1)).toBe('3 đang chạy, 1 đang chờ')
  expect(TABLES.en.more(2)).toBe('+2 more')
})

test('ageOf runs from the start time, else from when the board first saw the agent, else it is 0', () => {
  expect(ageOf(agent({ startTime: 1_000 }), 4_000, {})).toBe(3_000)
  expect(ageOf(agent({ startTime: 5_000 }), 4_000, {})).toBe(0)
  expect(ageOf(agent({ id: 'q' }), 9_000, { q: 2_000 })).toBe(7_000)
  expect(ageOf(agent({ id: 'q' }), 9_000, {})).toBe(0)
})

test('the pane waits for an agent that has run PANE_AFTER_MS', () => {
  expect(PANE_AFTER_MS).toBe(5_000)
  expect(anyLongRunning([], 10_000, {})).toBe(false)
  expect(anyLongRunning([agent({ startTime: 8_000 })], 10_000, {})).toBe(false)
  expect(anyLongRunning([agent({ startTime: 5_000 })], 10_000, {})).toBe(true)
  expect(anyLongRunning([agent({ startTime: 9_000 }), agent({ id: 'b', startTime: 1_000 })], 10_000, {})).toBe(true)
  expect(anyLongRunning([agent({ id: 'n' })], 10_000, { n: 4_999 })).toBe(true)
  expect(anyLongRunning([agent({ id: 'n' })], 10_000, { n: 5_001 })).toBe(false)
})

test('the waiting state is worded neutrally: it is not known to be waiting for the person', () => {
  expect(TABLES.en.state.waiting).toBe('Waiting')
  expect(TABLES.vi.state.waiting).toBe('Đang chờ')
  for (const lang of ['en', 'vi'] as const) {
    expect(JSON.stringify(TABLES[lang].count(2, 1))).not.toMatch(/needs you|cần bạn/i)
    expect(TABLES[lang].listHeader(2, 1)).not.toMatch(/needs you|cần bạn/i)
  }
})
