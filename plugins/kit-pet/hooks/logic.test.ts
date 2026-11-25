import { expect, test } from 'claude-code/testing'

import {
  ACHIEVEMENT_ORDER, BAR_CELLS, DONE_MS, MAX_DAYS, QUOTA_PCT, STAGE_AT, STREAK_GOAL, TOOL_ERROR_MS, TURNS_GOAL, TURN_ERROR_MS,
  addDay, bar, clock, countdown, dayKey, deriveState, durationText, emptyModel, emptySave, fitText, growth, isCommitCommand,
  isGreenCommitCommand, isGreenTestCommand, isTestCommand, markAnnounced, mergeSave, pickToast, prevDay, quotaOf, recordCommit, recordTest, recordTurn, sanitizeSave, stageOf, step,
  streakOf, testCommandFromTool,
} from './logic'
import type { Ev, Model, Save } from './logic'

const NOW = 1_800_000_000_000

function run(events: Ev[], from: Model = emptyModel()): Model {
  return events.reduce(step, from)
}

test('constants match the contract', () => {
  expect([...STAGE_AT]).toEqual([0, 50, 300])
  expect([DONE_MS, TOOL_ERROR_MS, QUOTA_PCT, STREAK_GOAL, TURNS_GOAL, BAR_CELLS, MAX_DAYS]).toEqual([8000, 6000, 85, 7, 100, 6, 400])
  expect([...ACHIEVEMENT_ORDER]).toEqual(['firstCommit', 'firstTest', 'turns100', 'streak7'])
})

test('stageOf: thresholds and garbage', () => {
  const table: [number, 1 | 2 | 3][] = [
    [0, 1], [1, 1], [49, 1], [49.9, 1], [50, 2], [299, 2], [300, 3], [100000, 3],
    [-5, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [Number.NEGATIVE_INFINITY, 1],
  ]
  for (const [turns, stage] of table) expect(stageOf(turns)).toBe(stage)
  expect(stageOf('300' as unknown as number)).toBe(1)
  expect(stageOf(undefined as unknown as number)).toBe(1)
})

test('growth: progress inside each stage', () => {
  expect(growth(0)).toEqual({ stage: 1, into: 0, span: 50, filled: 0, left: 50 })
  expect(growth(8)).toEqual({ stage: 1, into: 8, span: 50, filled: 0, left: 42 })
  expect(growth(9)).toEqual({ stage: 1, into: 9, span: 50, filled: 1, left: 41 })
  expect(growth(49)).toEqual({ stage: 1, into: 49, span: 50, filled: 5, left: 1 })
  expect(growth(50)).toEqual({ stage: 2, into: 0, span: 250, filled: 0, left: 250 })
  expect(growth(91)).toEqual({ stage: 2, into: 41, span: 250, filled: 0, left: 209 })
  expect(growth(92)).toEqual({ stage: 2, into: 42, span: 250, filled: 1, left: 208 })
  expect(growth(299)).toEqual({ stage: 2, into: 249, span: 250, filled: 5, left: 1 })
  expect(growth(300)).toEqual({ stage: 3, into: 0, span: null, filled: BAR_CELLS, left: null })
  expect(growth(450)).toEqual({ stage: 3, into: 150, span: null, filled: BAR_CELLS, left: null })
  expect(growth(-3)).toEqual({ stage: 1, into: 0, span: 50, filled: 0, left: 50 })
  expect(growth(Number.NaN).stage).toBe(1)
})

test('step never mutates and follows the rules', () => {
  const m0 = emptyModel()
  const frozen = JSON.stringify(m0)
  const m1 = step(m0, { t: 'turnStart', at: 10 })
  expect(JSON.stringify(m0)).toBe(frozen)
  expect(m1).toEqual({ ...m0, working: true, workingSince: 10 })
  const m2 = step(m1, { t: 'toolFail', at: 20 })
  expect(m2.toolErrorAt).toBe(20)
  expect(m1.toolErrorAt).toBe(null)
  expect(step(m2, { t: 'toolOk', at: 30 }).toolErrorAt).toBe(null)
  const m3 = step(m2, { t: 'turnEnd', at: 40, reason: 'answer' })
  expect(m3).toEqual({ ...m0, working: false, workingSince: null, endedAt: 40, endReason: 'answer', toolErrorAt: null })
  // A new turn clears the last outcome.
  const m4 = step(step(m0, { t: 'turnEnd', at: 5, reason: 'error' }), { t: 'turnStart', at: 6 })
  expect(m4.endedAt).toBe(null)
  expect(m4.endReason).toBe(null)
  expect(m4.working).toBe(true)
})

test('step quota: clamps and drops garbage', () => {
  const q = (pct: number | null) => step(emptyModel(), { t: 'quota', pct }).quotaPct
  expect(q(42)).toBe(42)
  expect(q(150)).toBe(100)
  expect(q(-4)).toBe(0)
  expect(q(Number.NaN)).toBe(null)
  expect(q(Number.POSITIVE_INFINITY)).toBe(null)
  expect(q(null)).toBe(null)
  // Quota survives turns.
  expect(run([{ t: 'quota', pct: 90 }, { t: 'turnStart', at: 1 }, { t: 'turnEnd', at: 2, reason: 'answer' }]).quotaPct).toBe(90)
})

test('deriveState: idle by default', () => {
  expect(deriveState(emptyModel(), NOW)).toBe('idle')
})

test('deriveState: working, and tool errors only briefly', () => {
  const working = run([{ t: 'turnStart', at: NOW }])
  expect(deriveState(working, NOW + 1)).toBe('working')
  const failed = step(working, { t: 'toolFail', at: NOW + 100 })
  expect(deriveState(failed, NOW + 100)).toBe('error')
  expect(deriveState(failed, NOW + 100 + TOOL_ERROR_MS - 1)).toBe('error')
  expect(deriveState(failed, NOW + 100 + TOOL_ERROR_MS)).toBe('working')
  // Clock going backwards: not an error, still working.
  expect(deriveState(failed, NOW + 50)).toBe('working')
  // A good tool call clears it.
  expect(deriveState(step(failed, { t: 'toolOk', at: NOW + 200 }), NOW + 200)).toBe('working')
})

test('deriveState: done window boundaries', () => {
  const m = run([{ t: 'turnStart', at: NOW - 5 }, { t: 'turnEnd', at: NOW, reason: 'answer' }])
  expect(deriveState(m, NOW)).toBe('done')
  expect(deriveState(m, NOW + 7999)).toBe('done')
  expect(deriveState(m, NOW + 8000)).toBe('idle')
  expect(deriveState(m, NOW + 8001)).toBe('idle')
  expect(deriveState(m, NOW - 1)).toBe('idle')
})

test('deriveState: error and refusal stay until the next turn, but for TURN_ERROR_MS at most', () => {
  for (const reason of ['error', 'refusal'] as const) {
    const m = run([{ t: 'turnStart', at: NOW }, { t: 'turnEnd', at: NOW + 10, reason }])
    expect(deriveState(m, NOW + 10)).toBe('error')
    expect(deriveState(m, NOW + 10 + 30_000)).toBe('error')
    expect(deriveState(m, NOW + 10 + 59_999)).toBe('error')
    expect(deriveState(m, NOW + 10 + 60_000)).toBe('idle')
    expect(deriveState(m, NOW + 10 + 1_000_000)).toBe('idle')
    // A clock that went backwards is not an error.
    expect(deriveState(m, NOW + 9)).toBe('idle')
    // A new turn inside the minute wipes it; after it there is nothing to wipe.
    expect(deriveState(step(m, { t: 'turnStart', at: NOW + 20_000 }), NOW + 20_001)).toBe('working')
    expect(deriveState(step(m, { t: 'turnStart', at: NOW + 2_000_000 }), NOW + 2_000_001)).toBe('working')
  }
  expect(TURN_ERROR_MS).toBe(60_000)
})

test('deriveState: after the error minute the state falls to low quota, else idle', () => {
  const end = (pct: number | null) => run([{ t: 'quota', pct }, { t: 'turnStart', at: NOW }, { t: 'turnEnd', at: NOW + 10, reason: 'error' }])
  expect(deriveState(end(85), NOW + 10 + 59_999)).toBe('error')
  expect(deriveState(end(85), NOW + 10 + 60_000)).toBe('quota')
  expect(deriveState(end(84), NOW + 10 + 60_000)).toBe('idle')
  expect(deriveState(end(null), NOW + 10 + 60_000)).toBe('idle')
})

test('deriveState: an aborted turn ends in plain idle', () => {
  const m = run([{ t: 'turnStart', at: NOW }, { t: 'turnEnd', at: NOW + 10, reason: 'aborted' }])
  expect(deriveState(m, NOW + 11)).toBe('idle')
})

test('deriveState: quota boundaries 84/85/100/null', () => {
  const at = (pct: number | null) => deriveState(step(emptyModel(), { t: 'quota', pct }), NOW)
  expect(at(84)).toBe('idle')
  expect(at(85)).toBe('quota')
  expect(at(100)).toBe('quota')
  expect(at(null)).toBe('idle')
})

test('deriveState: priority error > working > done > quota > idle', () => {
  const done = run([{ t: 'quota', pct: 95 }, { t: 'turnStart', at: NOW }, { t: 'turnEnd', at: NOW + 1, reason: 'answer' }])
  expect(deriveState(done, NOW + 2)).toBe('done')
  expect(deriveState(done, NOW + 1 + DONE_MS)).toBe('quota')
  const working = step(done, { t: 'turnStart', at: NOW + 20 })
  expect(deriveState(working, NOW + 21)).toBe('working')
  expect(deriveState(step(working, { t: 'toolFail', at: NOW + 22 }), NOW + 23)).toBe('error')
  const errored = run([{ t: 'quota', pct: 95 }, { t: 'turnStart', at: NOW }, { t: 'turnEnd', at: NOW + 1, reason: 'error' }])
  expect(deriveState(errored, NOW + 2)).toBe('error')
})

test('dayKey: local day from a getTimezoneOffset offset', () => {
  // 2026-01-01T00:30:00Z
  const ms = Date.UTC(2026, 0, 1, 0, 30)
  expect(dayKey(ms, 0)).toBe('2026-01-01')
  // UTC-5 (offset +300): still Dec 31 locally.
  expect(dayKey(ms, 300)).toBe('2025-12-31')
  // UTC+7 (offset -420): 07:30 on Jan 1.
  expect(dayKey(ms, -420)).toBe('2026-01-01')
  // UTC+14 crosses forward.
  expect(dayKey(Date.UTC(2026, 0, 1, 23, 0), -840)).toBe('2026-01-02')
  expect(dayKey(Date.UTC(2024, 1, 29, 12, 0), 0)).toBe('2024-02-29')
  expect(dayKey(0, 0)).toBe('1970-01-01')
  expect(dayKey(Number.NaN, 0)).toBe('1970-01-01')
  expect(dayKey(ms, Number.NaN)).toBe('2026-01-01')
  expect(dayKey(8.64e15 + 1, 0)).toBe('1970-01-01')
})

test('prevDay: month, year and leap borders', () => {
  const table: [string, string][] = [
    ['2026-03-15', '2026-03-14'], ['2026-03-01', '2026-02-28'], ['2024-03-01', '2024-02-29'], ['2100-03-01', '2100-02-28'],
    ['2000-03-01', '2000-02-29'], ['2026-01-01', '2025-12-31'], ['2026-05-01', '2026-04-30'], ['0001-01-01', '0000-12-31'],
  ]
  for (const [k, p] of table) expect(prevDay(k)).toBe(p)
  expect(prevDay('nope')).toBe('')
  expect(prevDay('2026-02-30')).toBe('')
  expect(prevDay('')).toBe('')
})

test('addDay: sorted, unique, capped, malformed ignored', () => {
  expect(addDay([], '2026-01-02')).toEqual(['2026-01-02'])
  expect(addDay(['2026-01-03', '2026-01-01'], '2026-01-02')).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  expect(addDay(['2026-01-01'], '2026-01-01')).toEqual(['2026-01-01'])
  expect(addDay(['2026-01-01'], 'garbage')).toEqual(['2026-01-01'])
  expect(addDay(['2026-01-01', 'x', '2026-13-01'], '2026-01-02')).toEqual(['2026-01-01', '2026-01-02'])
  const many: string[] = []
  let d = '2026-06-30'
  for (let i = 0; i < MAX_DAYS + 20; i++) {
    many.push(d)
    d = prevDay(d)
  }
  const out = addDay(many, '2026-07-01')
  expect(out.length).toBe(MAX_DAYS)
  expect(out[out.length - 1]).toBe('2026-07-01')
  expect([...out].sort()).toEqual(out)
  const input = ['2026-01-02']
  addDay(input, '2026-01-01')
  expect(input).toEqual(['2026-01-02'])
})

test('streakOf: runs, gaps, today optional', () => {
  const days = ['2026-03-01', '2026-03-02', '2026-03-03']
  expect(streakOf(days, '2026-03-03')).toBe(3)
  // Today has no entry yet: the streak ends yesterday.
  expect(streakOf(days, '2026-03-04')).toBe(3)
  // A whole missed day breaks it.
  expect(streakOf(days, '2026-03-05')).toBe(0)
  expect(streakOf([], '2026-03-05')).toBe(0)
  expect(streakOf(['2026-03-01', '2026-03-03'], '2026-03-03')).toBe(1)
  expect(streakOf(days, 'bad')).toBe(0)
  expect(streakOf(['2026-03-03', '2026-03-01', '2026-03-02', '2026-03-02'], '2026-03-03')).toBe(3)
})

test('streakOf: month, year and leap-day borders', () => {
  expect(streakOf(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01')).toBe(3)
  expect(streakOf(['2023-02-28', '2023-03-01'], '2023-03-01')).toBe(2)
  expect(streakOf(['2025-12-30', '2025-12-31', '2026-01-01'], '2026-01-01')).toBe(3)
  expect(streakOf(['2026-04-30', '2026-05-01'], '2026-05-02')).toBe(2)
  const long: string[] = []
  let d = '2026-03-10'
  for (let i = 0; i < 60; i++) {
    long.push(d)
    d = prevDay(d)
  }
  expect(streakOf(long, '2026-03-10')).toBe(60)
})

test('a streak past the old cap of 60 days survives addDay and is counted in full', () => {
  let days: string[] = []
  let d = '2026-03-10'
  for (let i = 0; i < 200; i++) {
    days = addDay(days, d)
    d = prevDay(d)
  }
  expect(days).toHaveLength(200)
  expect(streakOf(days, '2026-03-10')).toBe(200)
})

test('emptySave is a valid save', () => {
  const s = emptySave()
  expect(sanitizeSave(s)).toEqual(s)
  expect(s.v).toBe(1)
  expect(emptySave()).not.toBe(emptySave())
})

test('sanitizeSave: garbage in, valid save out', () => {
  const empty = emptySave()
  for (const raw of [null, undefined, 5, 'x', [], true, () => 1, Symbol('s')]) expect(sanitizeSave(raw)).toEqual(empty)
  expect(sanitizeSave({})).toEqual(empty)
  const s = sanitizeSave({
    turns: 12.9,
    days: ['2026-02-02', 5, null, '2026-02-01', 'bad', '2026-02-02'],
    testGreen: 'yes',
    committed: true,
    earned: { firstCommit: '2026-02-01', bogus: '2026-02-01', turns100: 'garbage', firstTest: 7 },
    announced: ['firstCommit', 'nope', 'firstCommit', 4],
    lastToastDay: '2026-02-01',
    today: { day: '2026-02-02', turns: -3 },
  })
  expect(s).toEqual({
    v: 1, turns: 12, days: ['2026-02-01', '2026-02-02'], testGreen: false, committed: true,
    earned: { firstCommit: '2026-02-01' }, announced: ['firstCommit'], lastToastDay: '2026-02-01', today: { day: '2026-02-02', turns: 0 },
  })
  expect(sanitizeSave({ turns: -4 }).turns).toBe(0)
  expect(sanitizeSave({ turns: Number.NaN }).turns).toBe(0)
  expect(sanitizeSave({ turns: '9' }).turns).toBe(0)
  expect(sanitizeSave({ days: 'nope', earned: [], announced: 'x', today: [] })).toEqual(empty)
  expect(sanitizeSave({ lastToastDay: 5, today: { day: 3, turns: 'a' } })).toEqual(empty)
  expect(sanitizeSave(JSON.parse('{"__proto__":{"turns":9},"earned":{"__proto__":"2026-01-01"}}'))).toEqual(empty)
  const many = Array.from({ length: 90 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`)
  expect(sanitizeSave({ days: many }).days.length).toBe(28)
})

test('sanitizeSave: round trip through JSON', () => {
  let s: Save = emptySave()
  s = recordTurn(s, '2026-01-01')
  s = recordTest(s, '2026-01-01')
  s = markAnnounced(s, 'firstTest', '2026-01-01')
  expect(sanitizeSave(JSON.parse(JSON.stringify(s)))).toEqual(s)
})

test('recordTurn: counts, days, today counter', () => {
  const a = recordTurn(emptySave(), '2026-03-01')
  expect(a.turns).toBe(1)
  expect(a.days).toEqual(['2026-03-01'])
  expect(a.today).toEqual({ day: '2026-03-01', turns: 1 })
  const b = recordTurn(a, '2026-03-01')
  expect(b.turns).toBe(2)
  expect(b.days).toEqual(['2026-03-01'])
  expect(b.today).toEqual({ day: '2026-03-01', turns: 2 })
  const c = recordTurn(b, '2026-03-02')
  expect(c.today).toEqual({ day: '2026-03-02', turns: 1 })
  expect(c.days).toEqual(['2026-03-01', '2026-03-02'])
  // The old save is untouched.
  expect(a.turns).toBe(1)
  expect(a.today.turns).toBe(1)
  // A bad day changes nothing.
  expect(recordTurn(c, 'nope')).toEqual(c)
})

test('recordTurn: turns100 earned on the 100th turn, once', () => {
  let s = emptySave()
  for (let i = 0; i < 99; i++) s = recordTurn(s, '2026-03-01')
  expect(s.earned.turns100).toBe(undefined)
  s = recordTurn(s, '2026-03-02')
  expect(s.turns).toBe(100)
  expect(s.earned.turns100).toBe('2026-03-02')
  s = recordTurn(s, '2026-03-09')
  expect(s.earned.turns100).toBe('2026-03-02')
})

test('recordTurn: streak7 on the 7th consecutive day, not on a gap', () => {
  let s = emptySave()
  let d = '2026-02-24'
  for (let i = 0; i < 6; i++) {
    s = recordTurn(s, d)
    expect(s.earned.streak7).toBe(undefined)
    d = nextDay(d)
  }
  s = recordTurn(s, d)
  // 2026-02-24 .. 2026-03-02 crosses the Feb/Mar border.
  expect(d).toBe('2026-03-02')
  expect(s.earned.streak7).toBe('2026-03-02')
  let g = emptySave()
  for (const day of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']) g = recordTurn(g, day)
  expect(g.earned.streak7).toBe(undefined)
})

function nextDay(key: string): string {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) + 1))
  return d.toISOString().slice(0, 10)
}

test('recordTest and recordCommit: once, first day wins', () => {
  const t1 = recordTest(emptySave(), '2026-03-01')
  expect(t1.testGreen).toBe(true)
  expect(t1.earned.firstTest).toBe('2026-03-01')
  expect(recordTest(t1, '2026-03-05').earned.firstTest).toBe('2026-03-01')
  expect(emptySave().testGreen).toBe(false)
  const c1 = recordCommit(emptySave(), '2026-03-01')
  expect(c1.committed).toBe(true)
  expect(c1.earned.firstCommit).toBe('2026-03-01')
  expect(recordCommit(c1, '2026-03-09').earned.firstCommit).toBe('2026-03-01')
  // A bad day still notes the fact; a later good day earns it.
  const bad = recordTest(emptySave(), 'x')
  expect(bad.testGreen).toBe(true)
  expect(bad.earned.firstTest).toBe(undefined)
  expect(recordTest(bad, '2026-03-02').earned.firstTest).toBe('2026-03-02')
  expect(recordCommit(t1, '2026-03-01').earned).toEqual({ firstTest: '2026-03-01', firstCommit: '2026-03-01' })
})

test('pickToast: order, one per day, announced skipped', () => {
  let s = emptySave()
  expect(pickToast(s, '2026-03-01')).toBe(null)
  s = recordTest(s, '2026-03-01')
  s = recordCommit(s, '2026-03-01')
  expect(pickToast(s, '2026-03-01')).toBe('firstCommit')
  s = markAnnounced(s, 'firstCommit', '2026-03-01')
  expect(s.announced).toEqual(['firstCommit'])
  expect(s.lastToastDay).toBe('2026-03-01')
  // Same day: no second toast.
  expect(pickToast(s, '2026-03-01')).toBe(null)
  expect(pickToast(s, '2026-03-02')).toBe('firstTest')
  s = markAnnounced(s, 'firstTest', '2026-03-02')
  expect(pickToast(s, '2026-03-03')).toBe(null)
  // Marking twice does not duplicate.
  expect(markAnnounced(s, 'firstTest', '2026-03-04').announced).toEqual(['firstCommit', 'firstTest'])
  const before = JSON.stringify(s)
  markAnnounced(s, 'turns100', '2026-03-09')
  expect(JSON.stringify(s)).toBe(before)
})

test('quotaOf: busiest of five_hour and seven_day', () => {
  expect(quotaOf([])).toEqual({ pct: null, resetsAt: null, kind: null })
  const at = '2026-03-01T10:00:00Z'
  expect(quotaOf([{ kind: 'five_hour', percentUsed: 30.4, resetsAt: at }, { kind: 'seven_day', percentUsed: 61.6 }])).toEqual({ pct: 62, resetsAt: null, kind: 'seven_day' })
  expect(quotaOf([{ kind: 'five_hour', percentUsed: 90, resetsAt: at }, { kind: 'seven_day', percentUsed: 20 }])).toEqual({ pct: 90, resetsAt: Date.parse(at), kind: 'five_hour' })
  expect(quotaOf([{ kind: 'opus', percentUsed: 99 }, { kind: 'seven_day', percentUsed: 10 }]).kind).toBe('seven_day')
  expect(quotaOf([{ kind: 'opus', percentUsed: 99 }])).toEqual({ pct: null, resetsAt: null, kind: null })
  expect(quotaOf([{ kind: 'five_hour', percentUsed: Number.NaN }, { kind: 'seven_day', percentUsed: Number.POSITIVE_INFINITY }])).toEqual({ pct: null, resetsAt: null, kind: null })
  expect(quotaOf([{ kind: 'five_hour', percentUsed: 140 }]).pct).toBe(100)
  expect(quotaOf([{ kind: 'five_hour', percentUsed: -3 }]).pct).toBe(0)
  expect(quotaOf([{ kind: 'five_hour', percentUsed: 5, resetsAt: 'not a date' }]).resetsAt).toBe(null)
  // A tie keeps the first.
  expect(quotaOf([{ kind: 'seven_day', percentUsed: 50 }, { kind: 'five_hour', percentUsed: 50 }]).kind).toBe('seven_day')
})

test('clock', () => {
  const table: [number, string][] = [
    [0, '0:00'], [999, '0:00'], [1000, '0:01'], [59_000, '0:59'], [60_000, '1:00'], [161_000, '2:41'],
    [3_599_999, '59:59'], [3_600_000, '1:00:00'], [3_725_000, '1:02:05'], [36_000_000, '10:00:00'],
    [-5, '0:00'], [Number.NaN, '0:00'], [Number.POSITIVE_INFINITY, '0:00'],
  ]
  for (const [ms, text] of table) expect(clock(ms)).toBe(text)
})

test('durationText', () => {
  const table: [number, string][] = [
    [0, '0s'], [45_000, '45s'], [59_999, '59s'], [60_000, '1m 0s'], [161_000, '2m 41s'], [3_599_000, '59m 59s'],
    [3_900_000, '1h 05m'], [7_200_000, '2h 00m'], [-1, '0s'], [Number.NaN, '0s'],
  ]
  for (const [ms, text] of table) expect(durationText(ms)).toBe(text)
})

test('countdown', () => {
  const min = 60_000
  expect(countdown(null, NOW)).toBe('')
  expect(countdown(NOW, NOW)).toBe('')
  expect(countdown(NOW - 1, NOW)).toBe('')
  expect(countdown(Number.NaN, NOW)).toBe('')
  expect(countdown(NOW + 30_000, NOW)).toBe('<1m')
  expect(countdown(NOW + 49 * min, NOW)).toBe('49m')
  expect(countdown(NOW + 60 * min, NOW)).toBe('1h00m')
  expect(countdown(NOW + 109 * min, NOW)).toBe('1h49m')
  expect(countdown(NOW + 125 * min, NOW)).toBe('2h05m')
  expect(countdown(NOW + 1439 * min, NOW)).toBe('23h59m')
  expect(countdown(NOW + (3 * 1440 + 4 * 60 + 30) * min, NOW)).toBe('3d 4h')
  expect(countdown(NOW + 1440 * min, NOW)).toBe('1d 0h')
})

test('bar', () => {
  expect(bar(2)).toEqual({ on: '▰▰', off: '▱▱▱▱' })
  expect(bar(0)).toEqual({ on: '', off: '▱▱▱▱▱▱' })
  expect(bar(6)).toEqual({ on: '▰▰▰▰▰▰', off: '' })
  expect(bar(99)).toEqual({ on: '▰▰▰▰▰▰', off: '' })
  expect(bar(-4)).toEqual({ on: '', off: '▱▱▱▱▱▱' })
  expect(bar(Number.NaN)).toEqual({ on: '', off: '▱▱▱▱▱▱' })
  expect(bar(3, 4)).toEqual({ on: '▰▰▰', off: '▱' })
  expect(bar(2.9, 4)).toEqual({ on: '▰▰', off: '▱▱' })
  expect(bar(1, 0)).toEqual({ on: '', off: '' })
  expect(bar(1, -2)).toEqual({ on: '', off: '' })
})

test('fitText: whitespace, controls, cuts, code points, hostile text', () => {
  expect(fitText('hello world', 20)).toBe('hello world')
  expect(fitText('  a \n\t b   c  ', 20)).toBe('a b c')
  expect(fitText('hello world', 8)).toBe('hello w…')
  expect(fitText('hello', 5)).toBe('hello')
  expect(fitText('hello', 4)).toBe('hel…')
  expect(fitText('hello', 1)).toBe('…')
  expect(fitText('hello', 0)).toBe('')
  expect(fitText('hello', -3)).toBe('')
  expect(fitText('hello', Number.NaN)).toBe('')
  expect(fitText('', 5)).toBe('')
  expect(fitText('hello', Number.POSITIVE_INFINITY)).toBe('hello')
  // Code points, not UTF-16 units: each emoji counts as one.
  expect(fitText('😀😀😀😀😀', 5)).toBe('😀😀😀😀😀')
  expect(fitText('😀😀😀😀😀', 3)).toBe('😀😀…')
  // ESC, BEL, C1 and the like are removed.
  const hostile = 'a\u001b[31mb\u0007c\u009bd\u0000e\u007ff\u202eg\u200bh'
  const out = fitText(hostile, 100)
  expect(out).toBe('a[31mbcdefgh')
  // eslint-disable-next-line no-control-regex
  expect(/[\u0000-\u001f\u007f-\u009f\u202e\u200b]/.test(out)).toBe(false)
  expect(fitText('x\u001b]0;evil\u0007y', 100)).toBe('x]0;evily')
  expect(fitText('line1\r\nline2\u2028line3\u0085line4', 100)).toBe('line1 line2 line3 line4')
  expect(fitText(5 as unknown as string, 5)).toBe('')
  expect(Array.from(fitText('a'.repeat(1000), 10)).length).toBe(10)
})

test('isTestCommand: commands that run tests', () => {
  const yes = [
    'npm test', 'npm t', 'npm run test', 'npm run test -- --watch', 'npm run test:unit', 'npm.cmd test', 'npm.cmd run test:e2e',
    'yarn test', 'yarn run test', 'yarn test:unit', 'pnpm test', 'pnpm run test:unit', 'pnpm -r test', 'pnpm --filter web test',
    'bun test', 'bun run test', 'npx jest', 'npx -y vitest run', 'pnpm exec vitest', 'pnpm dlx jest', 'bunx mocha', 'npx ava',
    'npx playwright test', 'npx cypress run', 'jest', 'vitest', 'mocha test/', 'pytest', 'pytest -q tests/', 'pytest.exe', 'py.test',
    'python -m pytest', 'python3 -m pytest -x', 'python3.12 -m pytest', 'python -u -m pytest', 'python -m unittest discover',
    'tox', 'nox -s tests', 'go test ./...', 'go test -run TestX ./pkg', 'cargo test', 'cargo +nightly test --lib',
    'cargo nextest run', 'mvn test', 'mvn clean verify', './mvnw test', 'gradle test', 'gradle check', './gradlew test',
    './gradlew :app:check', 'gradlew.bat test', 'dotnet test', 'rspec', 'bundle exec rspec spec/models', 'bundle exec rake test',
    'rake test', 'rake spec', 'phpunit', './vendor/bin/phpunit --filter X', 'composer test', 'composer run test', 'mix test',
    'deno test', 'swift test', 'ctest --output-on-failure', 'make test', 'make -j4 check', 'node --test', 'node --test src/',
    'claude plugin test', 'claude plugin test plugins/kit-pet', 'flutter test', 'dart test', 'ruby -Itest test/a_test.rb',
    'sbt test', 'lein test',
    // Wrappers, env vars, lists of commands.
    'CI=1 npm test', 'CI=1 FOO=bar pytest', 'time npm test', 'sudo pytest', 'xvfb-run -a npm test', 'uv run pytest',
    'uv run python -m pytest', 'poetry run pytest', 'pipenv run pytest', 'cd app && npm test', 'cd app; npm run test',
    'npm run build && npm test', 'npm ci\nnpm test', 'false || npm test', 'npm test | tee out.log', 'npm test 2>&1', '(cd x && go test ./...)',
    'FOO="a b" npm test', 'node_modules/.bin/jest', 'C:\\tools\\pytest.exe', '/usr/bin/pytest -q', 'echo start && "npm" test',
    'if npm test; then echo ok; fi', 'echo $(npm test)',
  ]
  for (const c of yes) expect([c, isTestCommand(c)]).toEqual([c, true])
})

test('isTestCommand: commands that only mention a runner or run no tests', () => {
  const no = [
    '', '   ', 'ls', 'echo "npm test"', "echo 'pytest'", 'echo npm test', 'grep pytest file', 'grep -r "jest" src', 'cat jest.config.js',
    'git commit -m "fix npm test"', 'git commit -m "x" && echo "cargo test"', 'npm install jest', 'npm i -D vitest', 'pnpm add -D vitest',
    'yarn add jest', 'pip install pytest', 'python -m pip install pytest', 'python script.py', 'python -m http.server',
    'npm run build', 'npm run lint', 'npm run testing', 'npm run pretest-x', 'npm start', 'yarn build', 'cargo build', 'go build ./...',
    'go vet ./...', 'make build', 'make', 'rake build', 'mvn package', 'gradle build', 'dotnet build', 'node script.js --test',
    'node index.js', 'claude plugin list', 'claude plugin install x', 'cd tests', 'vim jest.config.js', 'echo "a && npm test"',
    'echo "x" # npm test', 'ruby app.rb', 'git status', 'cargo nextest list', 'composer install', 'docker run image npm test',
    // Options that run no tests.
    'jest --help', 'jest -h', 'vitest --version', 'pytest --collect-only', 'pytest --co', 'pytest --help', 'npm test -- --help',
    'jest --listTests', 'jest --list', 'cargo test --no-run', 'dotnet test --list-tests', 'mvn test --dry-run', 'npm test --dry-run',
    'mocha --list',
  ]
  for (const c of no) expect([c, isTestCommand(c)]).toEqual([c, false])
})

test('isTestCommand: case matters, Windows suffixes do not', () => {
  expect(isTestCommand('Jest')).toBe(false)
  expect(isTestCommand('PYTEST')).toBe(false)
  expect(isTestCommand('npm.CMD test')).toBe(true)
  expect(isTestCommand('PYTEST.EXE')).toBe(false)
  expect(isTestCommand('pytest.EXE')).toBe(true)
  expect(isTestCommand('npx.cmd jest')).toBe(true)
  expect(isTestCommand('pnpm.cmd run test:unit')).toBe(true)
})

test('isTestCommand: non-strings are not tests', () => {
  for (const x of [null, undefined, 5, {}, [], ['npm test'], true]) {
    expect(isTestCommand(x as unknown as string)).toBe(false)
    expect(isCommitCommand(x as unknown as string)).toBe(false)
  }
})

test('isTestCommand: unbalanced and odd quoting stays calm', () => {
  expect(isTestCommand('echo "npm test')).toBe(false)
  expect(isTestCommand("echo 'unfinished && npm test")).toBe(false)
  expect(isTestCommand('npm test "unfinished')).toBe(true)
  expect(isTestCommand('echo \\" && npm test')).toBe(true)
  expect(isTestCommand('echo a\\ && npm test')).toBe(true)
  expect(isTestCommand('npm \\\n test')).toBe(true)
})

test('long commands never hang (the parser is capped by length, segments and words)', () => {
  const long = 'a'.repeat(20_000)
  expect(isTestCommand(long)).toBe(false)
  expect(isCommitCommand(long)).toBe(false)
  expect(isTestCommand(`echo "${long}"`)).toBe(false)
  expect(isTestCommand(`echo '${long}`)).toBe(false)
  expect(isTestCommand('echo a && '.repeat(2000))).toBe(false)
  expect(isTestCommand('& '.repeat(10_000))).toBe(false)
  expect(isTestCommand('"'.repeat(20_000))).toBe(false)
  expect(isTestCommand('\\'.repeat(20_000))).toBe(false)
  expect(isTestCommand('(' .repeat(20_000))).toBe(false)
  expect(isTestCommand(`npm test ${long}`)).toBe(true)
  expect(isTestCommand(`${'x '.repeat(200)}&& npm test`)).toBe(true)
  expect(isCommitCommand(`git commit -m "${long}"`)).toBe(true)
})

test('isCommitCommand: true cases', () => {
  const yes = [
    'git commit', 'git commit -m "x"', "git commit -m 'x'", 'git commit -am "x"', 'git commit --amend --no-edit', 'git commit -a -m x',
    'git -C /tmp/repo commit -m x', 'git -c user.name=x commit -m y', 'git -c a=b -c c=d commit -m y', 'git --no-pager commit',
    'git --git-dir=/x/.git commit', 'git --git-dir /x/.git commit', 'git.exe commit -m x', 'git add . && git commit -m "x"',
    'cd x; git commit -m y', 'git add -A\ngit commit -m z', 'time git commit -m x', 'GIT_AUTHOR_NAME=x git commit -m y',
    '/usr/bin/git commit', 'git commit -m "$(cat <<\'EOF\'\nmsg && npm test\nEOF\n)"', 'git commit --no-verify -m x',
  ]
  for (const c of yes) expect([c, isCommitCommand(c)]).toEqual([c, true])
})

test('isCommitCommand: false cases', () => {
  const no = [
    '', 'git', 'git status', 'git log --grep commit', 'git commit-tree HEAD^{tree}', 'git commit-graph write', 'git commit --dry-run',
    'git commit -m x --dry-run', 'git commit --help', 'git commit -h', 'echo git commit', 'echo "git commit -m x"', 'grep commit file',
    'git push origin commit', 'git checkout -b commit', 'git -C commit status', 'cat git commit', 'npm test', 'git cherry-pick abc',
    'git add commit', "echo 'x && git commit'",
  ]
  for (const c of no) expect([c, isCommitCommand(c)]).toEqual([c, false])
})

test('isGreenCommitCommand: the commit decides the exit status of the line', () => {
  const yes = [
    'git commit -m x', 'git add . && git commit -m x', 'cd x; git commit -am y', 'git add -A\ngit commit -m z', 'git commit -m x 2>&1',
    "bash -c 'git add . && git commit -m x'", 'git -C /tmp/r commit -m x', 'git commit -m x;',
  ]
  for (const c of yes) expect([c, isGreenCommitCommand(c)]).toEqual([c, true])
  const no = [
    'git commit -m x || echo nothing', 'git commit -m x | cat', 'git commit -m x |& tee log', 'false || git commit -m x', 'git commit -m x &',
    'git commit -m x; echo done', 'git commit -m x && git push', 'git commit --dry-run', 'git status', '', 'echo "git commit"',
    "bash -c 'git commit -m x || true'",
  ]
  for (const c of no) expect([c, isGreenCommitCommand(c)]).toEqual([c, false])
  // Still a commit by the looser rule.
  expect(isCommitCommand('git commit -m x || echo nothing')).toBe(true)
  for (const x of [null, undefined, 5, {}, ['git commit']]) expect(isGreenCommitCommand(x as unknown as string)).toBe(false)
  expect(isGreenCommitCommand(`${'echo a && '.repeat(60)}git commit -m x`)).toBe(false)
})

test('testCommandFromTool', () => {
  expect(testCommandFromTool({ command: 'npm test' })).toBe('npm test')
  expect(testCommandFromTool({ command: 5 })).toBe('')
  expect(testCommandFromTool({ command: ['npm', 'test'] })).toBe('')
  expect(testCommandFromTool({})).toBe('')
  expect(testCommandFromTool(null)).toBe('')
  expect(testCommandFromTool(undefined)).toBe('')
  expect(testCommandFromTool('npm test')).toBe('')
  expect(testCommandFromTool(['npm test'])).toBe('')
  expect(testCommandFromTool(42)).toBe('')
})

// ---------- commands: accuracy ----------

test('isTestCommand: lookups and heredoc text are not test runs', () => {
  for (const c of [
    'command -v jest', 'command -v pytest || pip install pytest', 'command pytest --version',
    "cat > x <<'EOF'\nnpm test\nEOF", 'cat > x <<EOF\nnpm test\nEOF', 'cat <<-EOF\n\tpytest\n\tEOF', 'cat <<"END"\ncargo test\nEND\n',
    "cat <<'EOF' > f.sh\nnpm test\nEOF\necho done",
  ]) expect([c, isTestCommand(c)]).toEqual([c, false])
  // The line after the heredoc is a command again.
  expect(isTestCommand("cat > x <<'EOF'\nhello\nEOF\nnpm test")).toBe(true)
  // A body line that only starts with the word does not end it.
  expect(isTestCommand("cat <<EOF\nEOF2\nnpm test\nEOF")).toBe(false)
  // An unterminated heredoc swallows the rest.
  expect(isTestCommand('cat <<EOF\nnpm test')).toBe(false)
  // A here-string is not a heredoc.
  expect(isTestCommand('cat <<< x && npm test')).toBe(true)
})

test('isTestCommand: options that list instead of run', () => {
  for (const c of ['tox -l', 'tox --listenvs', 'tox --listenvs-all', 'tox --show-config', 'nox -l', 'pytest --fixtures', 'pytest --markers'])
    expect([c, isTestCommand(c)]).toEqual([c, false])
  // -l is only a listing for tox and nox; pytest -l is --showlocals.
  expect(isTestCommand('pytest -l')).toBe(true)
  expect(isTestCommand('tox -e py312')).toBe(true)
})

test('isTestCommand: dry runs and listings that run no tests', () => {
  for (const c of [
    'go test -list .', 'go test -list "Test.*" ./...', 'make -n test', 'gmake -n check', 'ctest -N', 'pytest --trace-config', 'pytest --setup-plan',
    'pytest --collect-only -q', 'jest --listTests', 'cargo test -- --list', 'dotnet test --list-tests', 'mvn test -dry-run', 'make --dry-run test',
    'make --just-print test', 'pytest --help',
  ]) expect([c, isTestCommand(c)]).toEqual([c, false])
  // The same letters mean something else elsewhere: pytest -n is the xdist worker count, -N is not ctest's for others.
  for (const c of ['pytest -n 4', 'pytest -n auto tests/', 'make test', 'make -j4 test', 'ctest -j4', 'go test ./...', 'go test -run TestList ./...'])
    expect([c, isTestCommand(c)]).toEqual([c, true])
  expect(isGreenTestCommand('pytest -n 4')).toBe(true)
})

test('isTestCommand: tox and nox run tests unless they select only checkers', () => {
  for (const c of ['tox', 'nox', 'tox -e py311', 'tox -e py311,py312', 'tox --env py311', 'nox -s tests', 'nox --session tests', 'tox -e py311 -- -k x', 'tox run -e py311'])
    expect([c, isTestCommand(c)]).toEqual([c, true])
  for (const c of [
    'tox -e lint', 'tox -e docs', 'tox -e py311,lint', 'tox -e lint,py311', 'tox --env=docs', 'tox -e type', 'tox -e typing', 'tox -e mypy', 'tox -e flake8',
    'tox -e format', 'tox -e fmt', 'tox -e style', 'tox -e pylint', 'tox -e ruff', 'tox -e py311-lint', 'nox -s lint', 'nox --session=docs', 'nox -s tests lint',
    'uv run tox -e lint', 'nox -s mypy -- --strict',
  ]) expect([c, isTestCommand(c)]).toEqual([c, false])
  // A checker named only after `--` is an argument of the runner behind it, not a selection.
  expect(isTestCommand('tox -e py311 -- -e lint')).toBe(true)
})

test('isTestCommand: wrappers and runners that hide the command', () => {
  const yes = [
    'timeout 60 npm test', 'timeout -s KILL 30s pytest', 'timeout --foreground -k 5 1m cargo test', 'nice -n 10 npm test', 'nice pytest',
    "bash -c 'npm test'", 'sh -c "cd app && go test ./..."', "zsh -c 'pytest -q'", "bash -lc 'npm test'", "bash -c \"bash -c 'npm test'\"",
    'sudo -u ci pytest', 'sudo -E npm test', 'sudo -u ci -g staff npm test', 'env -u FOO pytest',
    'python3 manage.py test', 'python manage.py test app.tests', './manage.py test', 'yarn workspace web test', 'yarn workspace web run test:unit',
    'node --import ./setup.mjs --test', 'node --test', 'node --require x --test src/',
  ]
  for (const c of yes) expect([c, isTestCommand(c)]).toEqual([c, true])
  const no = [
    "bash -c 'echo npm test'", 'bash script.sh', 'bash -c', 'sudo -u ci ls', 'timeout 60 ls', 'python3 manage.py migrate', 'yarn workspace web build',
    'node --import ./setup.mjs script.js', 'nice -n 5 make build',
    // Deeper than two levels is not followed.
    `bash -c "bash -c 'bash -c \\"npm test\\"'"`,
  ]
  for (const c of no) expect([c, isTestCommand(c)]).toEqual([c, false])
})

test('isTestCommand: stays fast on hostile heredocs and nesting', () => {
  expect(isTestCommand('cat <<EOF\n'.repeat(5000))).toBe(false)
  expect(isTestCommand('<<'.repeat(10_000))).toBe(false)
  expect(isTestCommand(`cat <<EOF\n${'x\n'.repeat(5000)}`)).toBe(false)
  expect(isTestCommand("bash -c '".repeat(500))).toBe(false)
})

test('isGreenTestCommand: the test decides the exit status of the line', () => {
  const yes = [
    'npm test', 'cd x && npm test', 'CI=1 npm test', 'npm run build && npm test', 'cd x; pytest', 'npm ci\nnpm test', 'npm test\n',
    'npm test 2>&1', 'timeout 60 npm test', "bash -c 'cd x && npm test'", 'sudo -u ci pytest', 'npm test # all of it',
    'npm run build &&\n  npm test', '(cd x && go test ./...)', 'npm test;',
  ]
  for (const c of yes) expect([c, isGreenTestCommand(c)]).toEqual([c, true])
  const no = [
    'npm test || true', 'npm test; echo done', 'npm test | tail -5', 'npm test | tee out.log', 'false || npm test', 'npm test &', 'npm test && echo ok',
    'echo hi', '', 'npm install', 'npm test |& tee x', "bash -c 'npm test || true'", "bash -c 'npm test' | tail", 'echo $(npm test)',
    'npm test --help',
    // Watchers never finish, so they decide nothing.
    'npm run test:watch', 'npm test -- --watch', 'vitest --watch', 'vitest -w', 'mocha -w', 'jest --watchAll', 'pnpm run test-watch',
  ]
  for (const c of no) expect([c, isGreenTestCommand(c)]).toEqual([c, false])
  // The same words are still tests for classification.
  for (const c of ['npm test || true', 'npm run test:watch', 'vitest -w', 'npm test | tail -5']) expect(isTestCommand(c)).toBe(true)
  // A watch flag set to a false value is not watch mode; a true or bare one is.
  for (const c of ['vitest --watch=false', 'vitest --watch=0', 'vitest --watch=no', 'jest --watchAll=false', 'jest --watch=false', 'jest --watch-all=false', 'jest --watch=FALSE'])
    expect([c, isGreenTestCommand(c)]).toEqual([c, true])
  for (const c of ['vitest --watch=true', 'vitest --watch=1', 'jest --watchAll=true', 'jest --watch', 'jest --watchAll', 'jest --watch-all', 'jest --watch=yes'])
    expect([c, isGreenTestCommand(c)]).toEqual([c, false])
  // -w is a workspace for npm and the worker count for jest, not watch mode.
  expect(isGreenTestCommand('npm test -w web')).toBe(true)
  expect(isGreenTestCommand('jest -w 2')).toBe(true)
  for (const x of [null, undefined, 5, {}, ['npm test']]) expect(isGreenTestCommand(x as unknown as string)).toBe(false)
})

test('isGreenTestCommand: a line cut by a cap never counts (the last segment seen is not known to be the last)', () => {
  expect(isGreenTestCommand(`${'echo a && '.repeat(60)}npm test`)).toBe(false)
  expect(isGreenTestCommand(`${'x '.repeat(6000)}&& npm test`)).toBe(false)
  expect(isGreenTestCommand(`${'echo a && '.repeat(10)}npm test`)).toBe(true)
})

// ---------- mergeSave ----------

const sv = (over: Partial<Save> = {}): Save => ({ ...emptySave(), ...over })

test('mergeSave: only the turns a session added since its base are counted on top of the stored ones', () => {
  expect(mergeSave(sv({ turns: 10 }), sv({ turns: 5 }), 5).turns).toBe(10)
  expect(mergeSave(sv({ turns: 10 }), sv({ turns: 8 }), 5).turns).toBe(13)
  expect(mergeSave(sv({ turns: 3 }), sv({ turns: 8 }), 5).turns).toBe(6)
  // A base above the local turns (should not happen) adds nothing instead of subtracting.
  expect(mergeSave(sv({ turns: 10 }), sv({ turns: 2 }), 5).turns).toBe(10)
  expect(mergeSave(sv(), sv({ turns: 4 }), 0).turns).toBe(4)
})

test('mergeSave: days are a union, sorted, trimmed to MAX_DAYS and unchanged inputs', () => {
  const stored = sv({ days: ['2026-03-01', '2026-03-03'] })
  const local = sv({ days: ['2026-03-02', '2026-03-03'] })
  const frozen = JSON.stringify([stored, local])
  expect(mergeSave(stored, local, 0).days).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
  expect(JSON.stringify([stored, local])).toBe(frozen)
  const many: string[] = []
  let d = '2026-06-30'
  for (let i = 0; i < MAX_DAYS + 30; i++) {
    many.push(d)
    d = prevDay(d)
  }
  const out = mergeSave(sv({ days: many }), sv({ days: ['2026-07-01'] }), 0).days
  expect(out).toHaveLength(MAX_DAYS)
  expect(out[out.length - 1]).toBe('2026-07-01')
})

test('mergeSave: earned keeps the earlier valid day and anything either has; announced is a union in order', () => {
  const stored = sv({ earned: { firstTest: '2026-03-05', turns100: '2026-03-09' }, announced: ['turns100'] })
  const local = sv({ earned: { firstTest: '2026-03-02', firstCommit: '2026-03-04', streak7: 'bad' as never }, announced: ['firstCommit'] })
  const m = mergeSave(stored, local, 0)
  expect(m.earned).toEqual({ firstCommit: '2026-03-04', firstTest: '2026-03-02', turns100: '2026-03-09' })
  expect(m.announced).toEqual(['firstCommit', 'turns100'])
})

test('mergeSave: lastToastDay is the later, flags are either, today is the later day', () => {
  expect(mergeSave(sv({ lastToastDay: '2026-03-05' }), sv({ lastToastDay: '2026-03-02' }), 0).lastToastDay).toBe('2026-03-05')
  expect(mergeSave(sv(), sv({ lastToastDay: '2026-03-02' }), 0).lastToastDay).toBe('2026-03-02')
  expect(mergeSave(sv(), sv(), 0).lastToastDay).toBeNull()
  expect(mergeSave(sv({ testGreen: true }), sv({ committed: true }), 0)).toMatchObject({ testGreen: true, committed: true })
  expect(mergeSave(sv(), sv(), 0)).toMatchObject({ testGreen: false, committed: false })
  const today = (day: string | null, turns: number) => sv({ today: { day, turns } })
  expect(mergeSave(today('2026-03-05', 9), today('2026-03-04', 2), 0).today).toEqual({ day: '2026-03-05', turns: 9 })
  expect(mergeSave(today('2026-03-04', 9), today('2026-03-05', 2), 0).today).toEqual({ day: '2026-03-05', turns: 2 })
  expect(mergeSave(today('2026-03-05', 3), today('2026-03-05', 7), 0).today).toEqual({ day: '2026-03-05', turns: 7 })
  expect(mergeSave(today('2026-03-05', 8), today('2026-03-05', 7), 0).today).toEqual({ day: '2026-03-05', turns: 8 })
  expect(mergeSave(today(null, 0), today('2026-03-05', 1), 0).today).toEqual({ day: '2026-03-05', turns: 1 })
  expect(mergeSave(today('2026-03-05', 4), today(null, 0), 0).today).toEqual({ day: '2026-03-05', turns: 4 })
  expect(mergeSave(today(null, 0), today(null, 0), 0).today).toEqual({ day: null, turns: 0 })
})

test('mergeSave: the result is always a valid save', () => {
  const m = mergeSave(sanitizeSave('junk'), sanitizeSave(null), Number.NaN)
  expect(m).toEqual(emptySave())
  expect(sanitizeSave(JSON.parse(JSON.stringify(m)))).toEqual(m)
})
