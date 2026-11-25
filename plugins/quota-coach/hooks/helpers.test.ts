import { expect, test } from 'claude-code/testing'
import type { PluginOptions } from 'claude-code'

import {
  BIG_CONTEXT_TOKENS, MANY_AGENTS, activeTips, addTurn, bar, cacheInfo, compactSavingPct, credit, estimateTurn, expectedWeighted, fmtLow, fmtPoints,
  fmtTokens, isCalibrated, isLightWork, livePct, pickTip, rateOf, rearm, stampOf, totalTokens, uncertainty, weighted, whyOf, wholeMinutes,
} from './calc'
import type { Tip, TipFacts, Usage } from './calc'
import { readConfig } from './config'
import { MAX_FILES, READ_CAP, configDirOf, readTodayTranscripts } from './files'
import { TABLES, languageFromSetting } from './i18n'
import { prettyModel, tierLabel, tierOf, tierWeight, versionOf } from './model'
import {
  KEEP_DAYS, addToDay, buildReport, dateOfKey, dayKey, dayStart, dayStoreKey, emptyDay, expiredKeys, hourOf, lineText, mergeDays, parseTranscript, plain, reportLines, sanitizeDay, transcriptParser,
} from './report'
import type { Day, TurnRecord } from './report'
import type { TurnStat } from '../types'

const near = (a: number | undefined, b: number, eps = 1e-9): boolean => a !== undefined && Math.abs(a - b) <= eps
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const usage = (over: Partial<Usage> = {}): Usage => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over,
})
const turn = (over: Partial<TurnStat> = {}): TurnStat => ({ steps: 1, output: 100, subagents: 0, spent: 1000, tokens: 5000, model: 'claude-sonnet-5', at: 0, pct: 0, ...over })

// ---------- model.ts ----------
test('tierOf finds the family in any id, else other', () => {
  expect(tierOf('claude-opus-5-5')).toBe('opus')
  expect(tierOf('CLAUDE-SONNET-4')).toBe('sonnet')
  expect(tierOf('claude-3-5-haiku-20241022')).toBe('haiku')
  expect(tierOf('gpt-5')).toBe('other')
  expect(tierOf('')).toBe('other')
  expect(tierOf(null)).toBe('other')
  expect(tierOf(undefined)).toBe('other')
})

test('versionOf reads major and minor in both id shapes', () => {
  expect(versionOf('claude-opus-4-5')).toEqual({ major: 4, minor: 5 })
  expect(versionOf('claude-opus-4-1-20250805')).toEqual({ major: 4, minor: 1 })
  expect(versionOf('claude-sonnet-5-5[1m]')).toEqual({ major: 5, minor: 5 })
  expect(versionOf('claude-sonnet-5-20260101')).toEqual({ major: 5, minor: 0 })
  expect(versionOf('claude-sonnet-4-20250514')).toEqual({ major: 4, minor: 0 })
  expect(versionOf('claude-opus-4.5')).toEqual({ major: 4, minor: 5 })
  expect(versionOf('claude-opus')).toBe(null)
  expect(versionOf('gpt-5')).toBe(null)
})

test('versionOf reads the old "version before family" ids from the doc comment', () => {
  // The doc comment names claude-3-opus-20240229 as a supported shape: the date must not be read as a version.
  expect(versionOf('claude-3-opus-20240229')).toEqual({ major: 3, minor: 0 })
  expect(versionOf('claude-3-5-sonnet-20241022')).toEqual({ major: 3, minor: 5 })
  expect(versionOf('claude-3-haiku-20240307')).toEqual({ major: 3, minor: 0 })
})

test('tierWeight: Opus before 4.5 is 5, from 4.5 on 1.7, unknown Opus 1.7, Haiku 0.33, Sonnet and unknown 1', () => {
  expect(tierWeight('claude-opus-4-1')).toBe(5)
  expect(tierWeight('claude-opus-4')).toBe(5)
  expect(tierWeight('claude-opus-3')).toBe(5)
  expect(tierWeight('claude-opus-4-5')).toBe(1.7)
  expect(tierWeight('claude-opus-5')).toBe(1.7)
  expect(tierWeight('opus')).toBe(1.7)
  expect(tierWeight('claude-haiku-4-5')).toBe(0.33)
  expect(tierWeight('claude-sonnet-5')).toBe(1)
  expect(tierWeight('some-model')).toBe(1)
  expect(tierWeight(null)).toBe(1)
  expect(tierWeight(undefined)).toBe(1)
})

test('tierWeight of an old Opus with a date id is 5', () => {
  expect(tierWeight('claude-3-opus-20240229')).toBe(5)
})

test('prettyModel and tierLabel', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-opus-4-5[1m]')).toBe('Opus 4.5')
  expect(prettyModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(prettyModel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(prettyModel('claude-opus')).toBe('Opus')
  expect(prettyModel('  claude-haiku-4-5  ')).toBe('Haiku 4.5')
  expect(prettyModel('gpt-5')).toBe('gpt-5')
  expect(prettyModel('')).toBe('')
  expect(prettyModel(null)).toBe('')
  const long = 'some-gateway/very-long-model-name-x'
  expect(prettyModel(long)).toBe(long.slice(0, 23) + '…')
  expect(prettyModel('a'.repeat(24))).toBe('a'.repeat(24))
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(tierLabel('opus')).toBe('Opus')
  expect(tierLabel('sonnet')).toBe('Sonnet')
  expect(tierLabel('haiku', 'ignored')).toBe('Haiku')
  expect(tierLabel('other')).toBe('?')
  expect(tierLabel('other', 'gpt-5')).toBe('gpt-5')
})

// ---------- calc.ts: tokens and cache ----------
test('weighted: hand-computed per token kind and per model', () => {
  // input 1000*1 + cacheRead 10000*0.1 + cacheWrite 2000*1.25 + output 100*5 = 1000 + 1000 + 2500 + 500 = 5000
  const u = usage({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 })
  expect(weighted({ ...u, model: 'claude-sonnet-5' })).toBe(5000)
  expect(weighted(u)).toBe(5000)
  expect(near(weighted({ ...u, model: 'claude-opus-5-5' }), 8500)).toBe(true) // 5000 * 1.7
  expect(near(weighted({ ...u, model: 'claude-opus-4-1' }), 25_000)).toBe(true) // 5000 * 5
  expect(near(weighted({ ...u, model: 'claude-haiku-4-5' }), 1650)).toBe(true) // 5000 * 0.33
})

test('weighted and totalTokens ignore garbage counts', () => {
  const bad = usage({ input_tokens: NaN, output_tokens: -5, cache_read_input_tokens: Infinity, cache_creation_input_tokens: 100 })
  expect(weighted(bad)).toBe(125) // only 100 * 1.25
  expect(totalTokens(bad)).toBe(100)
  expect(totalTokens(usage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }))).toBe(10)
  expect(weighted(usage())).toBe(0)
})

test('stampOf: 1-hour entries give a 1-hour life, else 5 minutes, no usage gives null', () => {
  expect(stampOf(undefined, 5)).toBe(null)
  expect(stampOf(usage(), 5)).toEqual({ at: 5, ttlMs: 5 * MIN })
  expect(stampOf(usage({ ephemeral_1h_input_tokens: 0 }), 5)).toEqual({ at: 5, ttlMs: 5 * MIN })
  expect(stampOf(usage({ ephemeral_1h_input_tokens: 10 }), 7)).toEqual({ at: 7, ttlMs: 60 * MIN })
})

test('cacheInfo: unknown, warm, exactly at the TTL, cold, clock behind the stamp', () => {
  const stamp = { at: 1_000_000, ttlMs: 5 * MIN }
  expect(cacheInfo(null, 2_000_000)).toEqual({ state: 'unknown', idleMs: 0, leftMs: 0 })
  expect(cacheInfo(undefined, 2_000_000)).toEqual({ state: 'unknown', idleMs: 0, leftMs: 0 })
  expect(cacheInfo(stamp, 0).state).toBe('unknown')
  expect(cacheInfo({ at: NaN, ttlMs: 1 }, 5).state).toBe('unknown')
  expect(cacheInfo(stamp, 1_000_000 + 4 * MIN)).toEqual({ state: 'warm', idleMs: 4 * MIN, leftMs: MIN })
  expect(cacheInfo(stamp, 1_000_000 + 5 * MIN)).toEqual({ state: 'cold', idleMs: 5 * MIN, leftMs: 0 })
  expect(cacheInfo(stamp, 1_000_000 + 9 * MIN)).toEqual({ state: 'cold', idleMs: 9 * MIN, leftMs: 0 })
  expect(cacheInfo(stamp, 999_000)).toEqual({ state: 'warm', idleMs: 0, leftMs: 5 * MIN })
})

// ---------- calc.ts: calibration ----------
test('addTurn adds points, tokens and a turn', () => {
  const c0 = { pct: 0, weighted: 0, turns: 0 }
  const c1 = addTurn(c0, 5000, 10, 12)
  expect(c1).toEqual({ pct: 2, weighted: 5000, turns: 1 })
  const c2 = addTurn(c1, 3000, 12, 15)
  expect(c2).toEqual({ pct: 5, weighted: 8000, turns: 2 })
  expect(c0).toEqual({ pct: 0, weighted: 0, turns: 0 }) // not mutated
})

test('addTurn: unchanged percentage still counts the turn; negative spend is clamped', () => {
  expect(addTurn({ pct: 4, weighted: 100, turns: 1 }, 50, 20, 20)).toEqual({ pct: 4, weighted: 150, turns: 2 })
  expect(addTurn({ pct: 4, weighted: 100, turns: 1 }, -50, 20, 21)).toEqual({ pct: 5, weighted: 100, turns: 2 })
})

test('addTurn resets the totals when the window percentage goes down (a new window)', () => {
  expect(addTurn({ pct: 9, weighted: 90_000, turns: 7 }, 5000, 40, 2)).toEqual({ pct: 0, weighted: 0, turns: 0 })
  expect(addTurn({ pct: 9, weighted: 90_000, turns: 7 }, 5000, 40, 39.9)).toEqual({ pct: 0, weighted: 0, turns: 0 })
})

test('addTurn with an unknown percentage returns the same totals', () => {
  const c = { pct: 9, weighted: 90_000, turns: 7 }
  expect(addTurn(c, 5000, null, 10)).toBe(c)
  expect(addTurn(c, 5000, 10, null)).toBe(c)
  expect(addTurn(c, 5000, NaN, 10)).toBe(c)
  expect(addTurn(c, 5000, 10, Infinity)).toBe(c)
})

test('isCalibrated needs 3 turns, 3 points and some tokens; rateOf is null until then', () => {
  expect(isCalibrated({ pct: 3, weighted: 1000, turns: 3 })).toBe(true)
  expect(isCalibrated({ pct: 3, weighted: 1000, turns: 2 })).toBe(false)
  expect(isCalibrated({ pct: 2.9, weighted: 1000, turns: 9 })).toBe(false)
  expect(isCalibrated({ pct: 3, weighted: 0, turns: 3 })).toBe(false)
  expect(isCalibrated({ pct: 0, weighted: 0, turns: 0 })).toBe(false)
  expect(rateOf({ pct: 3, weighted: 1000, turns: 2 })).toBe(null)
  expect(rateOf({ pct: 10, weighted: 100_000, turns: 5 })).toBe(1e-4)
})

test('a window reset really clears calibration', () => {
  let c = { pct: 0, weighted: 0, turns: 0 }
  c = addTurn(c, 10_000, 0, 1)
  c = addTurn(c, 10_000, 1, 2)
  c = addTurn(c, 10_000, 2, 4)
  expect(isCalibrated(c)).toBe(true) // 3 turns, 4 points
  c = addTurn(c, 10_000, 4, 1)
  expect(isCalibrated(c)).toBe(false)
  expect(rateOf(c)).toBe(null)
})

// ---------- calc.ts: estimate ----------
test('expectedWeighted: hand-computed for warm and cold, with and without recent turns', () => {
  // no recent turns: steps 1, output 0. warm: 100000 * 0.1 = 10000; cold: 100000 * 1.25 = 125000
  expect(expectedWeighted(100_000, [], 'warm', 'claude-sonnet-5')).toBe(10_000)
  expect(expectedWeighted(100_000, [], 'unknown', 'claude-sonnet-5')).toBe(10_000)
  expect(expectedWeighted(100_000, [], 'cold', 'claude-sonnet-5')).toBe(125_000)
  // steps 3, output 1000: reads 100000 * (0.1 + 0.1*2) = 30000, output 1000*5 = 5000 -> 35000
  const recent = [turn({ steps: 3, output: 1000 })]
  expect(near(expectedWeighted(100_000, recent, 'warm', 'claude-sonnet-5'), 35_000)).toBe(true)
  expect(near(expectedWeighted(100_000, recent, 'warm', 'claude-opus-5-5'), 59_500)).toBe(true) // * 1.7
  // cold with the same turns: 100000 * (1.25 + 0.2) = 145000 + 5000 = 150000
  expect(near(expectedWeighted(100_000, recent, 'cold', 'claude-sonnet-5'), 150_000)).toBe(true)
})

test('expectedWeighted averages only the last 5 turns and rounds the steps', () => {
  const old = turn({ steps: 50, output: 50_000 })
  const five = [1, 2, 2, 2, 3].map(steps => turn({ steps, output: 0 })) // avg 2
  expect(near(expectedWeighted(10_000, [old, ...five], 'warm', 'claude-sonnet-5'), 10_000 * (0.1 + 0.1))).toBe(true)
  // avg steps 1.4 -> round 1
  const r = [1, 1, 1, 1, 3].map(steps => turn({ steps, output: 0 }))
  expect(near(expectedWeighted(10_000, r, 'warm', 'claude-sonnet-5'), 1000)).toBe(true)
})

test('uncertainty: 0.2 plus one point of rounding, capped at 0.8', () => {
  expect(near(uncertainty({ pct: 10, weighted: 1, turns: 3 }), 0.3)).toBe(true)
  expect(near(uncertainty({ pct: 100, weighted: 1, turns: 3 }), 0.21)).toBe(true)
  expect(uncertainty({ pct: 1, weighted: 1, turns: 3 })).toBe(0.8) // 0.2 + 1 = 1.2 capped
  expect(uncertainty({ pct: 0, weighted: 1, turns: 3 })).toBe(0.8)
})

test('estimateTurn: null until calibrated or without a context size', () => {
  const ok = { pct: 10, weighted: 100_000, turns: 5 }
  expect(estimateTurn({ pct: 3, weighted: 1000, turns: 2 }, 100_000, [], 'warm', 'claude-sonnet-5')).toBe(null)
  expect(estimateTurn(ok, null, [], 'warm', 'claude-sonnet-5')).toBe(null)
  expect(estimateTurn(ok, 0, [], 'warm', 'claude-sonnet-5')).toBe(null)
  expect(estimateTurn(ok, -5, [], 'warm', 'claude-sonnet-5')).toBe(null)
})

test('estimateTurn: hand-computed range and cold extra', () => {
  // rate = 10 / 100000 = 1e-4; warm turn on 100000 context = 10000 weighted -> mid 1.0 point
  // uncertainty = 0.2 + 1/10 = 0.3 -> low 0.7, high 1.3; cold would be 125000 -> 12.5 points; extra = 12.5 - 1 = 11.5
  const e = estimateTurn({ pct: 10, weighted: 100_000, turns: 5 }, 100_000, [], 'warm', 'claude-sonnet-5')
  expect(near(e?.mid, 1)).toBe(true)
  expect(near(e?.low, 0.7)).toBe(true)
  expect(near(e?.high, 1.3)).toBe(true)
  expect(near(e?.coldExtra, 11.5)).toBe(true)
})

test('estimateTurn: low <= mid <= high, and a cold cache raises mid by the cold extra', () => {
  const c = { pct: 6, weighted: 80_000, turns: 4 }
  const recent = [turn({ steps: 2, output: 500 }), turn({ steps: 4, output: 900 })]
  for (const cache of ['warm', 'cold', 'unknown'] as const) {
    const e = estimateTurn(c, 60_000, recent, cache, 'claude-opus-5-5')
    expect(e !== null && e.low <= e.mid && e.mid <= e.high && e.coldExtra >= 0).toBe(true)
  }
  const warm = estimateTurn(c, 60_000, recent, 'warm', 'claude-sonnet-5')
  const cold = estimateTurn(c, 60_000, recent, 'cold', 'claude-sonnet-5')
  expect(near(cold?.mid, (warm?.mid ?? 0) + (warm?.coldExtra ?? 0))).toBe(true)
  expect(near(cold?.coldExtra, warm?.coldExtra ?? -1)).toBe(true)
})

// ---------- calc.ts: tips ----------
test('compactSavingPct: hand-computed values and the no-saving cases', () => {
  // window 200000: after = max(15000, 16000) = 16000. 156000 tokens: (1 - 16000/156000) * 100 = 89.7 -> floor to 5s = 85
  expect(compactSavingPct(156_000, 200_000)).toBe(85)
  // 24000 is the limit (1.5 * 16000): at it nothing, just above it a small saving
  expect(compactSavingPct(24_000, 200_000)).toBe(0)
  expect(compactSavingPct(20_000, 200_000)).toBe(0)
  expect(compactSavingPct(24_001, 200_000)).toBe(30) // 1 - 16000/24001 = 33.3 -> 30
  // window 1M: after = 80000, 100000 tokens is under 120000
  expect(compactSavingPct(100_000, 1_000_000)).toBe(0)
  // small window: after = 15000 (8% of 100000 is 8000); 100000 -> 85 exactly? (1-0.15)*100 = 85
  expect(compactSavingPct(1_000_000, 200_000)).toBe(90) // 98.4 -> 95 -> capped at 90
  expect(compactSavingPct(NaN, 200_000)).toBe(0)
})

const baseFacts = (over: Partial<TipFacts> = {}): TipFacts => ({
  ctxPct: 10, ctxTokens: 20_000, window: 200_000, model: 'claude-sonnet-5', agentsRunning: 0,
  cache: { state: 'warm', idleMs: 0, leftMs: 5 * MIN }, recent: [], contextThreshold: 70, ...over,
})

test('activeTips: nothing in a quiet session', () => {
  expect(activeTips(baseFacts())).toEqual([])
})

test('context tip: at the threshold yes, just below no, unknown values no, too small to save no', () => {
  const big = { ctxTokens: 156_000, window: 200_000 }
  expect(activeTips(baseFacts({ ...big, ctxPct: 70 }))).toEqual([{ kind: 'context', pct: 70, savePct: 85 }])
  expect(activeTips(baseFacts({ ...big, ctxPct: 69.9 }))).toEqual([])
  expect(activeTips(baseFacts({ ...big, ctxPct: 70.4 }))).toEqual([{ kind: 'context', pct: 70, savePct: 85 }])
  expect(activeTips(baseFacts({ ...big, ctxPct: 95 })).length).toBe(1)
  expect(activeTips(baseFacts({ ...big, ctxPct: null }))).toEqual([])
  expect(activeTips(baseFacts({ ctxPct: 80, ctxTokens: null, window: 200_000 }))).toEqual([])
  expect(activeTips(baseFacts({ ctxPct: 80, ctxTokens: 156_000, window: null }))).toEqual([])
  // over the threshold but already small: compaction would save nothing, so no tip
  expect(activeTips(baseFacts({ ctxPct: 80, ctxTokens: 20_000, window: 200_000 }))).toEqual([])
  expect(activeTips(baseFacts({ ...big, ctxPct: 50, contextThreshold: 50 })).length).toBe(1)
  expect(activeTips(baseFacts({ ...big, ctxPct: 50, contextThreshold: 51 }))).toEqual([])
})

test('agents tip: 3 yes, 2 no', () => {
  expect(MANY_AGENTS).toBe(3)
  expect(activeTips(baseFacts({ agentsRunning: 3 }))).toEqual([{ kind: 'agents', count: 3 }])
  expect(activeTips(baseFacts({ agentsRunning: 7 }))).toEqual([{ kind: 'agents', count: 7 }])
  expect(activeTips(baseFacts({ agentsRunning: 2 }))).toEqual([])
})

test('cache tip: only cold with a big context', () => {
  const cold = { state: 'cold' as const, idleMs: 12 * MIN + 30_000, leftMs: 0 }
  expect(activeTips(baseFacts({ cache: cold, ctxTokens: BIG_CONTEXT_TOKENS }))).toEqual([{ kind: 'cache', idleMin: 12, tokens: 50_000 }])
  expect(activeTips(baseFacts({ cache: cold, ctxTokens: BIG_CONTEXT_TOKENS - 1 }))).toEqual([])
  expect(activeTips(baseFacts({ cache: cold, ctxTokens: null }))).toEqual([])
  const warm = { state: 'warm' as const, idleMs: MIN, leftMs: 4 * MIN }
  expect(activeTips(baseFacts({ cache: warm, ctxTokens: 150_000 }))).toEqual([])
  const unknown = { state: 'unknown' as const, idleMs: 0, leftMs: 0 }
  expect(activeTips(baseFacts({ cache: unknown, ctxTokens: 150_000 }))).toEqual([])
})

test('isLightWork: needs 3 light turns, looks only at the last 3', () => {
  const light = turn({ steps: 3, output: 1200, subagents: 0 })
  expect(isLightWork([])).toBe(false)
  expect(isLightWork([light, light])).toBe(false)
  expect(isLightWork([light, light, light])).toBe(true)
  expect(isLightWork([turn({ steps: 4 }), light, light, light])).toBe(true) // older heavy turn ignored
  expect(isLightWork([light, light, turn({ steps: 4 })])).toBe(false)
  expect(isLightWork([light, light, turn({ output: 1201 })])).toBe(false)
  expect(isLightWork([light, light, turn({ subagents: 1 })])).toBe(false)
  expect(isLightWork([turn({ steps: 3 }), light, turn({ output: 1200 })])).toBe(true)
})

test('model tip: Opus with light work only', () => {
  const light = [turn(), turn(), turn()]
  const heavy = [turn(), turn(), turn({ steps: 9 })]
  expect(activeTips(baseFacts({ model: 'claude-opus-5-5', recent: light }))).toEqual([{ kind: 'model', tier: 'opus' }])
  expect(activeTips(baseFacts({ model: 'claude-opus-5-5', recent: heavy }))).toEqual([])
  expect(activeTips(baseFacts({ model: 'claude-opus-5-5', recent: [] }))).toEqual([])
  expect(activeTips(baseFacts({ model: 'claude-sonnet-5', recent: light }))).toEqual([])
  expect(activeTips(baseFacts({ model: 'claude-haiku-4-5', recent: light }))).toEqual([])
  expect(activeTips(baseFacts({ model: 'gpt-5', recent: light }))).toEqual([])
})

test('activeTips keeps the order context, agents, cache, model', () => {
  const tips = activeTips(baseFacts({
    ctxPct: 80, ctxTokens: 156_000, window: 200_000, agentsRunning: 4, model: 'claude-opus-5-5',
    cache: { state: 'cold', idleMs: 6 * MIN, leftMs: 0 }, recent: [turn(), turn(), turn()],
  }))
  expect(tips.map(t => t.kind)).toEqual(['context', 'agents', 'cache', 'model'])
})

test('pickTip skips dismissed kinds and returns null when none is left', () => {
  const a: Tip = { kind: 'agents', count: 3 }
  const m: Tip = { kind: 'model', tier: 'opus' }
  expect(pickTip([], [])).toBe(null)
  expect(pickTip([a, m], [])).toBe(a)
  expect(pickTip([a, m], ['agents'])).toBe(m)
  expect(pickTip([a, m], ['agents', 'model'])).toBe(null)
  expect(pickTip([a], ['context'])).toBe(a)
})

test('dismissal and re-arm: a dismissal lasts while the tip applies, then the tip may come back', () => {
  const a: Tip = { kind: 'agents', count: 3 }
  const c: Tip = { kind: 'context', pct: 80, savePct: 85 }
  // the person dismisses "agents"; it still applies, so it stays dismissed and nothing shows
  let dismissed = ['agents']
  dismissed = rearm(dismissed, [a])
  expect(dismissed).toEqual(['agents'])
  expect(pickTip([a], dismissed)).toBe(null)
  // it stops applying: the dismissal is dropped
  dismissed = rearm(dismissed, [])
  expect(dismissed).toEqual([])
  // it applies again: it shows again
  expect(pickTip([a], dismissed)).toBe(a)
  // two dismissed, only one still applies, order kept
  expect(rearm(['context', 'agents'], [a])).toEqual(['agents'])
  expect(rearm(['context', 'agents'], [a, c])).toEqual(['context', 'agents'])
  expect(rearm([], [a])).toEqual([])
  const input = ['agents']
  rearm(input, [])
  expect(input).toEqual(['agents'])
})

test('whyOf: calibrated, uncalibrated and no last turn', () => {
  const f = baseFacts({ ctxPct: 78, ctxTokens: 156_000, window: 200_000, model: 'claude-opus-5-5', agentsRunning: 2 })
  const cal = { pct: 10, weighted: 100_000, turns: 5 }
  const last = turn({ spent: 20_000, subagents: 2 })
  const w = whyOf(f, cal, last)
  expect(w.timesSonnet).toBe(1.7)
  expect(near(w.lastTurnPct ?? undefined, 2)).toBe(true) // 1e-4 * 20000
  expect(w.avgTurnPct).toBe(2) // 10 points over 5 turns
  expect(w.agentsRunning).toBe(2)
  expect(w.agentsLastTurn).toBe(2)
  expect(w.savePct).toBe(85)
  expect(w.canSwitch).toBe(true)
  expect(w.ctxTokens).toBe(156_000)
  expect(w.cache).toBe(f.cache)

  const un = whyOf(f, { pct: 1, weighted: 100, turns: 1 }, last)
  expect(un.lastTurnPct).toBe(null)
  expect(un.avgTurnPct).toBe(null)

  const none = whyOf(baseFacts({ ctxTokens: null, window: null }), cal, null)
  expect(none.lastTurnPct).toBe(null)
  expect(none.agentsLastTurn).toBe(0)
  expect(none.savePct).toBe(0)
  expect(none.timesSonnet).toBe(1)
  expect(none.canSwitch).toBe(false)
})

// ---------- calc.ts: formatting ----------
test('fmtTokens', () => {
  expect(fmtTokens(0)).toBe('0')
  expect(fmtTokens(900)).toBe('900')
  expect(fmtTokens(999.6)).toBe('1000')
  expect(fmtTokens(1000)).toBe('1k')
  expect(fmtTokens(1250)).toBe('1.3k')
  expect(fmtTokens(9999)).toBe('10k')
  expect(fmtTokens(10_000)).toBe('10k')
  expect(fmtTokens(156_000)).toBe('156k')
  expect(fmtTokens(999_999)).toBe('1000k')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(fmtTokens(-1)).toBe('0')
  expect(fmtTokens(NaN)).toBe('0')
  expect(fmtTokens(Infinity)).toBe('0')
})

test('fmtPoints, wholeMinutes', () => {
  expect(fmtPoints(0)).toBe('<1')
  expect(fmtPoints(0.49)).toBe('<1')
  expect(fmtPoints(0.5)).toBe('1')
  expect(fmtPoints(2.4)).toBe('2')
  expect(fmtPoints(2.5)).toBe('3')
  expect(fmtPoints(100)).toBe('100')
  expect(fmtPoints(-3)).toBe('<1')
  expect(fmtPoints(NaN)).toBe('<1')
  expect(wholeMinutes(0)).toBe(0)
  expect(wholeMinutes(59_999)).toBe(0)
  expect(wholeMinutes(MIN)).toBe(1)
  expect(wholeMinutes(7.9 * MIN)).toBe(7)
  expect(wholeMinutes(-5 * MIN)).toBe(0)
})

test('bar fills proportionally, at least one cell for a positive value, none for zero', () => {
  expect(bar(5, 10, 10)).toEqual({ on: '▬'.repeat(5), off: '▭'.repeat(5) })
  expect(bar(10, 10, 10)).toEqual({ on: '▬'.repeat(10), off: '' })
  expect(bar(20, 10, 4)).toEqual({ on: '▬'.repeat(4), off: '' })
  expect(bar(0.01, 10, 10)).toEqual({ on: '▬', off: '▭'.repeat(9) })
  expect(bar(0, 10, 4)).toEqual({ on: '', off: '▭'.repeat(4) })
  expect(bar(5, 0, 4)).toEqual({ on: '', off: '▭'.repeat(4) })
  expect(bar(-1, 10, 4)).toEqual({ on: '', off: '▭'.repeat(4) })
})

// ---------- report.ts: time ----------
test('dayKey and hourOf in several time zones (offset is Date.getTimezoneOffset: minutes behind UTC)', () => {
  const t = Date.UTC(2026, 10, 25, 20, 0, 0) // 25 Nov 2026 20:00 UTC
  expect(dayKey(t, 0)).toBe('2026-11-25')
  expect(hourOf(t, 0)).toBe(20)
  expect(dayKey(t, -420)).toBe('2026-11-26') // UTC+7 -> 03:00 next day
  expect(hourOf(t, -420)).toBe(3)
  expect(dayKey(t, 300)).toBe('2026-11-25') // UTC-5 -> 15:00
  expect(hourOf(t, 300)).toBe(15)
  expect(dayKey(t, -330)).toBe('2026-11-26') // UTC+5:30 -> 01:30
  expect(hourOf(t, -330)).toBe(1)
  expect(dayKey(t, 720)).toBe('2026-11-25') // UTC-12 -> 08:00
  expect(hourOf(t, 720)).toBe(8)
})

test('day boundary: the last second of a local day and the first of the next', () => {
  const midnightUtcMinus5 = Date.UTC(2026, 10, 25, 5, 0, 0) // local midnight of 25 Nov in UTC-5
  expect(dayKey(midnightUtcMinus5 - 1000, 300)).toBe('2026-11-24')
  expect(hourOf(midnightUtcMinus5 - 1000, 300)).toBe(23)
  expect(dayKey(midnightUtcMinus5, 300)).toBe('2026-11-25')
  expect(hourOf(midnightUtcMinus5, 300)).toBe(0)
  const midnightUtcPlus7 = Date.UTC(2026, 10, 24, 17, 0, 0) // local midnight of 25 Nov in UTC+7
  expect(dayKey(midnightUtcPlus7 - 1, -420)).toBe('2026-11-24')
  expect(dayKey(midnightUtcPlus7, -420)).toBe('2026-11-25')
})

test('dayStart is the local midnight as UTC ms', () => {
  const t = Date.UTC(2026, 10, 25, 20, 0, 0)
  expect(dayStart(t, 0)).toBe(Date.UTC(2026, 10, 25))
  expect(dayStart(t, -420)).toBe(Date.UTC(2026, 10, 25, 17)) // local 26 Nov 00:00 in UTC+7
  expect(dayStart(t, 300)).toBe(Date.UTC(2026, 10, 25, 5)) // local 25 Nov 00:00 in UTC-5
  expect(dayStart(Date.UTC(2026, 10, 25, 5) - 1, 300)).toBe(Date.UTC(2026, 10, 24, 5))
  expect(dayStart(Date.UTC(2026, 10, 25, 5), 300)).toBe(Date.UTC(2026, 10, 25, 5))
  expect(dayStart(t, -330)).toBe(Date.UTC(2026, 10, 25, 18, 30)) // local 26 Nov 00:00 in UTC+5:30
  expect(dayStart(-1, 0)).toBe(-DAY) // before 1970 still rounds down
  for (const tz of [0, -420, 300, -330, 720]) {
    const s = dayStart(t, tz)
    expect(s <= t && t - s < DAY).toBe(true)
    expect(hourOf(s, tz)).toBe(0)
    expect(dayKey(s, tz)).toBe(dayKey(t, tz))
  }
})

// ---------- report.ts: the store ----------
const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  id: 'a', title: 'First', tier: 'opus', pct: 2, tokens: 1000, at: Date.UTC(2026, 10, 25, 13, 30), resetsAt: 'R1', ...over,
})

test('addToDay: a turn that moved the window adds points, tokens, hour, model and window', () => {
  const day = emptyDay()
  const d1 = addToDay(day, rec(), 0)
  expect(d1.sessions.a).toEqual({ title: 'First', pct: 2, tokens: 1000, models: { opus: 2 } })
  expect(d1.hours[13]).toBe(2)
  expect(d1.hours.reduce((a, b) => a + b, 0)).toBe(2)
  expect(d1.models).toEqual({ opus: 2 })
  expect(d1.windows).toEqual(['R1'])
  expect(day).toEqual(emptyDay()) // not mutated
})

test('addToDay: time zone decides the hour', () => {
  const d = addToDay(emptyDay(), rec(), -420) // 13:30 UTC is 20:30 in UTC+7
  expect(d.hours[20]).toBe(2)
  expect(d.hours[13]).toBe(0)
})

test('addToDay: a turn with no points adds tokens only, keeps title, no duplicate window', () => {
  const d1 = addToDay(emptyDay(), rec(), 0)
  const d2 = addToDay(d1, rec({ pct: 0, tokens: 500, title: '', tier: 'sonnet' }), 0)
  expect(d2.sessions.a).toEqual({ title: 'First', pct: 2, tokens: 1500, models: { opus: 2 } })
  expect(d2.hours).toEqual(d1.hours)
  expect(d2.models).toEqual({ opus: 2 })
  expect(d2.windows).toEqual(['R1'])
  const d3 = addToDay(d2, rec({ pct: NaN, tokens: -50, title: 'New', resetsAt: null }), 0)
  expect(d3.sessions.a).toEqual({ title: 'New', pct: 2, tokens: 1500, models: { opus: 2 } })
  expect(d3.windows).toEqual(['R1'])
})

test('addToDay: adds up per session, per model, per hour; second window is kept; windows are capped at 12', () => {
  let d = addToDay(emptyDay(), rec(), 0)
  d = addToDay(d, rec({ pct: 3, tier: 'sonnet', resetsAt: 'R2' }), 0)
  d = addToDay(d, rec({ id: 'b', title: 'Other', pct: 1, tier: 'opus', at: Date.UTC(2026, 10, 25, 14, 0) }), 0)
  expect(d.sessions.a?.pct).toBe(5)
  expect(d.sessions.a?.models).toEqual({ opus: 2, sonnet: 3 })
  expect(d.sessions.b?.pct).toBe(1)
  expect(d.models).toEqual({ opus: 3, sonnet: 3 })
  expect(d.hours[13]).toBe(5)
  expect(d.hours[14]).toBe(1)
  expect(d.windows).toEqual(['R1', 'R2'])
  let many = emptyDay()
  for (let i = 0; i < 15; i++) many = addToDay(many, rec({ resetsAt: 'W' + i }), 0)
  expect(many.windows.length).toBe(12)
  expect(many.windows[11]).toBe('W14')
  expect(many.windows[0]).toBe('W3')
})

test('expiredKeys: day records older than the newest KEEP_DAYS dates, other keys never', () => {
  expect(KEEP_DAYS).toBe(14)
  const keys = ['highWater', 'other:thing']
  for (let i = 1; i <= 20; i++) keys.push('day:2026-11-' + String(i).padStart(2, '0') + ':sess-a', 'day:2026-11-' + String(i).padStart(2, '0') + ':sess-b')
  const old = expiredKeys(keys)
  expect(old.length).toBe(12) // dates 01..06, two sessions each
  expect(old).toContain('day:2026-11-01:sess-a')
  expect(old).toContain('day:2026-11-06:sess-b')
  expect(old).not.toContain('day:2026-11-07:sess-a')
  expect(old).not.toContain('highWater')
  expect(expiredKeys(['day:2026-11-02:x', 'day:2026-11-01:x'])).toEqual([])
  expect(expiredKeys([])).toEqual([])
})

test('dayStoreKey and dateOfKey round-trip; other keys have no date', () => {
  expect(dayStoreKey('2026-11-25', 'abc-1')).toBe('day:2026-11-25:abc-1')
  expect(dateOfKey('day:2026-11-25:abc-1')).toBe('2026-11-25')
  expect(dateOfKey('day:2026-11-25:')).toBe(null)
  expect(dateOfKey('highWater')).toBe(null)
  expect(dateOfKey('day:xx:abc')).toBe(null)
})

test('sanitizeDay drops anything that is not a day of the right shape and zeroes bad numbers', () => {
  expect(sanitizeDay(null)).toBe(null)
  expect(sanitizeDay(undefined)).toBe(null)
  expect(sanitizeDay('x')).toBe(null)
  expect(sanitizeDay(5)).toBe(null)
  expect(sanitizeDay([emptyDay()])).toBe(null)
  expect(sanitizeDay({ sessions: {}, hours: [1, 2, 3], models: {}, windows: [] })).toBe(null)
  expect(sanitizeDay({ sessions: 'no', hours: Array.from({ length: 24 }, () => 0) })).toBe(null)
  expect(sanitizeDay({ sessions: {}, hours: 'no' })).toBe(null)
  const good = emptyDay()
  expect(sanitizeDay(good)).toEqual(good)
  const hours = Array.from({ length: 24 }, () => 1)
  hours[3] = 'x' as unknown as number
  hours[4] = NaN
  hours[5] = -2
  const out = sanitizeDay({
    sessions: { a: { title: 5, pct: 'x', tokens: NaN, models: { opus: 3, sonnet: 'no' } }, b: null, c: { title: 'ok', pct: 2, tokens: 10 } },
    hours, models: { opus: 3, haiku: -1 }, windows: ['a', 5, null, 'b'],
  })
  expect(out?.hours[3]).toBe(0)
  expect(out?.hours[4]).toBe(0)
  expect(out?.hours[5]).toBe(0)
  expect(out?.hours[6]).toBe(1)
  expect(out?.models).toEqual({ opus: 3 })
  expect(out?.windows).toEqual(['a', 'b'])
  expect(out?.sessions.a).toEqual({ title: '', pct: 0, tokens: 0, models: { opus: 3 } })
  expect(out?.sessions.b).toBeUndefined()
  expect(out?.sessions.c).toEqual({ title: 'ok', pct: 2, tokens: 10, models: {} })
})

test('mergeDays adds sessions, models, hours and windows; sessions of different records stay apart', () => {
  const a = addToDay(emptyDay(), { id: 's1', title: 'one', tier: 'opus', pct: 4, tokens: 100, at: Date.UTC(2026, 10, 25, 10, 0), resetsAt: 'W1' }, 0)
  const b = addToDay(emptyDay(), { id: 's2', title: 'two', tier: 'sonnet', pct: 3, tokens: 50, at: Date.UTC(2026, 10, 25, 10, 30), resetsAt: 'W1' }, 0)
  const c = addToDay(emptyDay(), { id: 's3', title: 'three', tier: 'opus', pct: 2, tokens: 10, at: Date.UTC(2026, 10, 25, 12, 0), resetsAt: 'W2' }, 0)
  const m = mergeDays([a, b, c])
  expect(Object.keys(m.sessions).sort()).toEqual(['s1', 's2', 's3'])
  expect(m.models).toEqual({ opus: 6, sonnet: 3 })
  expect(m.hours[10]).toBe(7)
  expect(m.hours[12]).toBe(2)
  expect(m.windows).toEqual(['W1', 'W2'])
  expect(mergeDays([])).toEqual(emptyDay())
})

test('credit: only what rose above the window high-water mark is credited, once', () => {
  // First session: window W at 10, turn takes it to 14.
  const first = credit(10, 14, 'W', null)
  expect(first.points).toBe(4)
  expect(first.hw).toEqual({ resetsAt: 'W', pct: 14 })
  // A second session whose turn started at 10 and ended at 16 (it saw the first one's 4 points too): credited 2.
  const second = credit(10, 16, 'W', first.hw)
  expect(second.points).toBe(2)
  expect(second.hw).toEqual({ resetsAt: 'W', pct: 16 })
  // A turn that ends below the mark credits nothing and leaves the mark.
  const third = credit(12, 15, 'W', second.hw)
  expect(third.points).toBe(0)
  expect(third.hw).toEqual({ resetsAt: 'W', pct: 16 })
  // Another window starts over from its own base.
  expect(credit(1, 3, 'W2', second.hw)).toEqual({ points: 2, hw: { resetsAt: 'W2', pct: 3 } })
  // No window id: the base is the floor, no mark is kept.
  expect(credit(5, 9, null, null)).toEqual({ points: 4, hw: null })
  // Unknown base: nothing is credited unless the mark says where the window stood.
  expect(credit(null, 9, 'W', null).points).toBe(0)
  expect(credit(null, 9, 'W', { resetsAt: 'W', pct: 6 }).points).toBe(3)
  // Unknown end: nothing.
  expect(credit(5, null, 'W', null)).toEqual({ points: 0, hw: null })
  expect(credit(5, NaN, 'W', null).points).toBe(0)
})

test('livePct: the percentage is old once its window has ended', () => {
  expect(livePct(40, new Date(2000).toISOString(), 1000)).toBe(40)
  expect(livePct(40, new Date(1000).toISOString(), 1000)).toBe(null)
  expect(livePct(40, new Date(500).toISOString(), 1000)).toBe(null)
  expect(livePct(40, null, 1000)).toBe(40)
  expect(livePct(40, 'garbage', 1000)).toBe(40)
  expect(livePct(null, new Date(2000).toISOString(), 1000)).toBe(null)
})

test('fmtLow: under half a point is 0', () => {
  expect(fmtLow(0.2)).toBe('0')
  expect(fmtLow(0.5)).toBe('1')
  expect(fmtLow(2.4)).toBe('2')
  expect(fmtLow(NaN)).toBe('0')
})

test('stampOf keeps the life of a cache that was only read, and a write sets a new one', () => {
  const prev = { at: 1, ttlMs: 60 * MIN }
  expect(stampOf(undefined, 9, prev)).toEqual(prev)
  expect(stampOf(usage({ cache_creation_input_tokens: 0 }), 9, prev)).toEqual({ at: 9, ttlMs: 60 * MIN })
  expect(stampOf(usage({ cache_creation_input_tokens: 0 }), 9, null)).toEqual({ at: 9, ttlMs: 5 * MIN })
  expect(stampOf(usage({ cache_creation_input_tokens: 100 }), 9, prev)).toEqual({ at: 9, ttlMs: 5 * MIN })
  expect(stampOf(usage({ cache_creation_input_tokens: 100, ephemeral_1h_input_tokens: 100 }), 9, null)).toEqual({ at: 9, ttlMs: 60 * MIN })
})

test('whyOf: the measured points of the last turn win before the rate is learnt, then the rate speaks', () => {
  const f = { ctxPct: 50, ctxTokens: 100_000, window: 200_000, model: 'claude-opus-5-5', agentsRunning: 0, cache: { state: 'warm' as const, idleMs: 0, leftMs: 1 }, recent: [], contextThreshold: 70 }
  const last = turn({ steps: 4, tokens: 90_000, spent: 13_500, pct: 3 })
  expect(whyOf(f, { pct: 0, weighted: 0, turns: 0 }, last).lastTurnPct).toBe(3)
  expect(whyOf(f, { pct: 0, weighted: 0, turns: 0 }, last).lastTurn).toEqual({ steps: 4, tokens: 90_000 })
  expect(whyOf(f, { pct: 0, weighted: 0, turns: 0 }, turn({ pct: 0 })).lastTurnPct).toBe(null)
  expect(near(whyOf(f, { pct: 8, weighted: 54_000, turns: 4 }, turn({ pct: 0, spent: 13_500 })).lastTurnPct ?? undefined, 2)).toBe(true)
  expect(whyOf(f, { pct: 0, weighted: 0, turns: 0 }, null).lastTurn).toBe(null)
})

// ---------- report.ts: transcripts ----------
const FROM = Date.UTC(2026, 10, 25)
const TO = FROM + DAY
const asst = (ts: string | undefined, model: string | undefined, u: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage: u }, ...extra })

test('parseTranscript: good lines count, tokens and weighted tokens are hand-computed', () => {
  const text = [
    asst('2026-11-25T10:00:00.000Z', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    asst('2026-11-25T11:00:00.000Z', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 10 }),
  ].join('\n')
  const r = parseTranscript('sess', text, FROM, TO)
  expect(r.id).toBe('sess')
  expect(r.title).toBe('')
  expect(r.entries.length).toBe(2)
  const [o, s] = r.entries
  // opus: tokens 100+50+1000+200 = 1350; weighted (100 + 1000*0.1 + 200*1.25 + 50*5) * 1.7 = 700 * 1.7 = 1190
  expect(o?.tokens).toBe(1350)
  expect(near(o?.weighted, 1190)).toBe(true)
  expect(o?.tier).toBe('opus')
  expect(o?.model).toBe('claude-opus-5-5')
  expect(o?.at).toBe(Date.parse('2026-11-25T10:00:00.000Z'))
  // sonnet: tokens 20; weighted 10 + 10*5 = 60
  expect(s?.tokens).toBe(20)
  expect(s?.weighted).toBe(60)
  expect(s?.tier).toBe('sonnet')
})

test('parseTranscript skips bad JSON, other lines, sidechains, <synthetic>, missing data and out-of-range times', () => {
  const ok = { input_tokens: 1, output_tokens: 1 }
  const text = [
    '{not json',
    'plain text',
    '',
    '{}',
    '{"type":"user"}',
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T10:00:00Z', isSidechain: true, message: { model: 'claude-opus-5-5', usage: ok } }),
    asst('2026-11-25T10:00:00Z', '<synthetic>', ok),
    asst('2026-11-25T10:00:00Z', undefined, ok),
    asst('2026-11-25T10:00:00Z', 'claude-opus-5-5', undefined),
    asst('2026-11-25T10:00:00Z', 'claude-opus-5-5', 'oops'),
    asst(undefined, 'claude-opus-5-5', ok),
    asst('not a date', 'claude-opus-5-5', ok),
    asst('2026-11-24T23:59:59.999Z', 'claude-opus-5-5', ok), // one ms before the range
    asst('2026-11-26T00:00:00.000Z', 'claude-opus-5-5', ok), // at "to": excluded
    asst('2026-11-25T00:00:00.000Z', 'claude-haiku-4-5', ok), // at "from": included
    asst('2026-11-25T23:59:59.999Z', 'claude-sonnet-5', ok), // last ms: included
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T10:00:00Z', isSidechain: false, message: { model: 'claude-sonnet-5', usage: { input_tokens: 'x', output_tokens: -3 } } }),
  ].join('\n')
  const r = parseTranscript('s', text, FROM, TO)
  expect(r.entries.map(e => e.tier)).toEqual(['haiku', 'sonnet', 'sonnet'])
  expect(r.entries[2]?.tokens).toBe(0) // garbage counts become 0 but the reply is kept
  expect(r.entries[2]?.weighted).toBe(0)
  expect(parseTranscript('s', '', FROM, TO)).toEqual({ id: 's', title: '', entries: [] })
})

test('parseTranscript titles: /rename beats the automatic title, latest wins, blank ignored', () => {
  const t = (type: string, key: string, value: unknown): string => JSON.stringify({ type, [key]: value })
  expect(parseTranscript('s', [t('ai-title', 'aiTitle', 'Auto one'), t('ai-title', 'aiTitle', 'Auto two')].join('\n'), FROM, TO).title).toBe('Auto two')
  expect(parseTranscript('s', [t('ai-title', 'aiTitle', 'Auto'), t('custom-title', 'customTitle', '  Mine  ')].join('\n'), FROM, TO).title).toBe('Mine')
  expect(parseTranscript('s', [t('custom-title', 'customTitle', 'Mine'), t('ai-title', 'aiTitle', 'Auto later')].join('\n'), FROM, TO).title).toBe('Mine')
  expect(parseTranscript('s', [t('custom-title', 'customTitle', 'One'), t('custom-title', 'customTitle', 'Two')].join('\n'), FROM, TO).title).toBe('Two')
  expect(parseTranscript('s', [t('custom-title', 'customTitle', '   '), t('ai-title', 'aiTitle', 'Auto')].join('\n'), FROM, TO).title).toBe('Auto')
  expect(parseTranscript('s', [t('custom-title', 'customTitle', 7), t('ai-title', 'aiTitle', null)].join('\n'), FROM, TO).title).toBe('')
})

// ---------- report.ts: the report ----------
const label = (tier: string, model: string): string => tier + ':' + model
const T10 = Date.parse('2026-11-25T10:00:00.000Z')
const entry = (tier: 'opus' | 'sonnet' | 'haiku', model: string, tokens: number, w: number, at = T10) => ({ at, tier, model, tokens, weighted: w })

test('buildReport without percentages: tokens only, from the transcripts', () => {
  const uses = [{ id: 's1', title: 'Auto title', entries: [entry('opus', 'claude-opus-5-5', 1350, 1190), entry('sonnet', 'claude-sonnet-5', 20, 60)] }]
  const r = buildReport(undefined, uses, 0, label)
  expect(r.hasPct).toBe(false)
  expect(r.totalPct).toBe(null)
  expect(r.totalTokens).toBe(1370)
  expect(r.sessions).toEqual([{ id: 's1', title: 'Auto title', tier: 'opus', pct: null, tokens: 1370 }])
  expect(r.models).toEqual([
    { tier: 'opus', label: 'opus:claude-opus-5-5', pct: null, tokens: 1350 },
    { tier: 'sonnet', label: 'sonnet:claude-sonnet-5', pct: null, tokens: 20 },
  ])
  expect(r.hours).toEqual([{ hour: 10, pct: null, tokens: 1370 }])
  expect(r.busiestHour).toBe(10)
  expect(r.topTier).toBe('opus')
  expect(r.topShare).toBe(99) // round(1350 / 1370 * 100) = round(98.54)
  expect(r.windows).toBe(0)
})

test('buildReport: the session tier is the family with the most weighted tokens, and the hour follows the time zone', () => {
  const uses = [{ id: 's', title: '', entries: [entry('opus', 'o', 10, 5), entry('sonnet', 'x', 10, 50)] }]
  const r = buildReport(undefined, uses, -420, label)
  expect(r.sessions[0]?.tier).toBe('sonnet')
  expect(r.hours[0]?.hour).toBe(17) // 10:00 UTC is 17:00 in UTC+7
})

test('buildReport with percentages: store wins for title and points, transcript wins for tokens, store-only sessions kept', () => {
  const hours = Array.from({ length: 24 }, () => 0)
  hours[10] = 10
  const day: Day = {
    sessions: {
      s1: { title: 'Stored', pct: 4, tokens: 999, models: { opus: 3, sonnet: 1 } },
      s2: { title: 'Gone', pct: 6, tokens: 500, models: { sonnet: 6 } },
    },
    hours, models: { opus: 3, sonnet: 7 }, windows: ['a', 'b'],
  }
  const uses = [
    { id: 's1', title: 'Auto', entries: [entry('opus', 'claude-opus-5-5', 1350, 1190), entry('sonnet', 'claude-sonnet-5', 20, 60)] },
    { id: 's3', title: 'No store', entries: [entry('haiku', 'claude-haiku-4-5', 70, 20)] },
    { id: 'empty', title: 'Nothing', entries: [] },
  ]
  const r = buildReport(day, uses, 0, label)
  expect(r.hasPct).toBe(true)
  expect(r.totalPct).toBe(10)
  expect(r.sessions).toEqual([
    { id: 's2', title: 'Gone', tier: 'sonnet', pct: 6, tokens: 500 },
    { id: 's1', title: 'Stored', tier: 'opus', pct: 4, tokens: 1370 },
    { id: 's3', title: 'No store', tier: 'haiku', pct: null, tokens: 70 },
  ])
  expect(r.totalTokens).toBe(1940) // 500 + 1370 + 70
  expect(r.models.map(m => [m.tier, m.pct])).toEqual([['sonnet', 7], ['opus', 3], ['haiku', 0]])
  expect(r.models[0]?.label).toBe('sonnet:claude-sonnet-5')
  expect(r.hours).toEqual([{ hour: 10, pct: 10, tokens: 1440 }])
  expect(r.busiestHour).toBe(10)
  expect(r.topTier).toBe('sonnet')
  expect(r.topShare).toBe(70) // 7 of 10 points
  expect(r.windows).toBe(2)
})

test('buildReport: a stored day with no points counts as no percentages; an empty day is empty', () => {
  const day: Day = { ...emptyDay(), sessions: { x: { title: 'X', pct: 0, tokens: 40, models: {} } } }
  const r = buildReport(day, [], 0, label)
  expect(r.hasPct).toBe(false)
  expect(r.totalPct).toBe(null)
  expect(r.sessions).toEqual([{ id: 'x', title: 'X', tier: null, pct: 0, tokens: 40 }])
  const e = buildReport(undefined, [], 0, label)
  expect(e.sessions).toEqual([])
  expect(e.models).toEqual([])
  expect(e.hours).toEqual([])
  expect(e.busiestHour).toBe(null)
  expect(e.topTier).toBe(null)
  expect(e.topShare).toBe(0)
  expect(e.totalTokens).toBe(0)
})

test('buildReport: busiest hour is the biggest by points, or by tokens without points', () => {
  const hours = Array.from({ length: 24 }, () => 0)
  hours[9] = 1
  hours[15] = 5
  const day: Day = { sessions: { s: { title: 's', pct: 6, tokens: 1, models: { opus: 6 } } }, hours, models: { opus: 6 }, windows: [] }
  const uses = [{ id: 's', title: '', entries: [entry('opus', 'o', 100, 1, Date.parse('2026-11-25T09:00:00Z')), entry('opus', 'o', 900, 1, Date.parse('2026-11-25T15:00:00Z'))] }]
  expect(buildReport(day, uses, 0, label).busiestHour).toBe(15)
  expect(buildReport(undefined, uses, 0, label).busiestHour).toBe(15)
  expect(buildReport(undefined, uses, 0, label).hours.map(h => h.hour)).toEqual([9, 15])
})

// ---------- report.ts: drawing ----------
const en = TABLES.en
const vi = TABLES.vi

test('reportLines for an empty report: title, subtitle, blank, note', () => {
  const lines = reportLines(en, buildReport(undefined, [], 0, label), '2026-11-25')
  expect(lines.map(l => l.kind)).toEqual(['title', 'sub', 'blank', 'note'])
  expect(lines[0]?.text).toBe(en.reportTitle)
  expect(lines[1]?.text).toBe(en.reportSubtitle('2026-11-25', null, 0))
  expect(lines[3]?.text).toBe(en.reportEmpty)
})

test('reportLines with percentages: rows, tips and the percent note', () => {
  const hours = Array.from({ length: 24 }, () => 0)
  hours[10] = 10
  const day: Day = {
    sessions: { s1: { title: 'Stored', pct: 4, tokens: 999, models: { opus: 3, sonnet: 1 } }, s2: { title: '', pct: 6, tokens: 500, models: { sonnet: 6 } } },
    hours, models: { opus: 3, sonnet: 7 }, windows: ['a'],
  }
  const lines = reportLines(en, buildReport(day, [], 0, tierLabelOf), '2026-11-25')
  expect(lines[1]?.text).toBe(en.reportSubtitle('2026-11-25', '10', 1))
  expect(lines[2]?.text).toBe(en.reportCounts(2, '1.5k'))
  const rows = lines.filter(l => l.kind === 'row')
  expect(rows.length).toBe(2 + 2 + 1) // 2 sessions, 2 models, 1 hour
  expect(rows[0]?.value).toBe('6%')
  expect(rows[0]?.label?.trim()).toBe(en.untitled)
  expect(rows[0]?.label?.length).toBe(28)
  expect(rows[0]?.tag).toBe('Sonnet')
  expect(rows[0]?.bar).toEqual({ on: '▬'.repeat(10), off: '' })
  expect(rows[1]?.value).toBe('4%')
  expect(rows[1]?.bar?.on.length).toBe(7) // round(4 / 6 * 10) = 7
  expect(rows[4]?.label?.trim()).toBe('10h')
  expect(rows[4]?.value).toBe('10%')
  const tips = lines.filter(l => l.kind === 'tip').map(l => l.text)
  expect(tips).toEqual([en.reportBusiest(10, '10%'), en.reportTop('Sonnet', 70)])
  expect(lines[lines.length - 1]).toEqual({ kind: 'note', text: en.reportNote })
  expect(lines.map(l => l.kind).filter(k => k === 'head').length).toBe(3)
})

test('reportLines without percentages shows tokens and the tokens-only note', () => {
  const uses = [{ id: 's1', title: 'T', entries: [entry('opus', 'claude-opus-5-5', 1370, 1)] }]
  const lines = reportLines(vi, buildReport(undefined, uses, 0, tierLabelOf), '2026-11-25')
  const rows = lines.filter(l => l.kind === 'row')
  expect(rows.map(r => r.value)).toEqual(['1.4k', '1.4k', '1.4k'])
  expect(lines[lines.length - 1]).toEqual({ kind: 'note', text: vi.reportTokensOnly })
  expect(lines.some(l => l.text === vi.reportBusiest(10, '1.4k'))).toBe(true)
})

test('reportLines shows at most 8 sessions and long titles are cut', () => {
  const sessions: Day['sessions'] = {}
  for (let i = 0; i < 10; i++) sessions['s' + i] = { title: 'x'.repeat(40), pct: i + 1, tokens: 1, models: { sonnet: i + 1 } }
  const hours = Array.from({ length: 24 }, () => 0)
  hours[5] = 55
  const day: Day = { sessions, hours, models: { sonnet: 55 }, windows: [] }
  const lines = reportLines(en, buildReport(day, [], 0, tierLabelOf), 'd')
  expect(lines.filter(l => l.kind === 'row').length).toBe(8 + 1 + 1)
  const first = lines.find(l => l.kind === 'row')
  expect(first?.label?.length).toBe(28)
  expect(first?.label?.trim()).toBe('x'.repeat(27) + '…')
})

test('reportLines: an "other" top family gets no top tip', () => {
  const uses = [{ id: 's', title: 'T', entries: [{ at: T10, tier: 'other' as never, model: 'gpt-5', tokens: 10, weighted: 10 }] }]
  const lines = reportLines(en, buildReport(undefined, uses, 0, label), 'd')
  expect(lines.filter(l => l.kind === 'tip').length).toBe(1) // the busiest hour only
})

function tierLabelOf(tier: string, model: string): string {
  return tierLabel(tier as never, model)
}

test('lineText: rows join their parts with two spaces, other lines give their text', () => {
  expect(lineText({ kind: 'title', text: 'Hello' })).toBe('Hello')
  expect(lineText({ kind: 'blank', text: '' })).toBe('')
  expect(lineText({ kind: 'row', text: 'ignored', label: 'a', tag: 'Opus', bar: { on: '▬', off: '▭' }, value: '3%' })).toBe('a  Opus  ▬▭  3%')
  expect(lineText({ kind: 'row', text: '', label: 'a', tag: '', bar: { on: '▬', off: '▭' }, value: '3%' })).toBe('a  ▬▭  3%')
  expect(lineText({ kind: 'row', text: '', label: 'a' })).toBe('a')
  expect(lineText({ kind: 'row', text: '', label: 'a', value: '' })).toBe('a')
})

// ---------- i18n.ts ----------
test('languageFromSetting', () => {
  for (const v of ['vi', 'VI', '  vi ', 'Vietnamese', 'vietnamese', 'Vietnam', 'Tiếng Việt', 'tiếng việt', 'tieng viet', { language: 'vi' }, { language: 'Vietnamese' }]) {
    expect(languageFromSetting(v)).toBe('vi')
  }
  for (const v of ['en', 'English', 'français', '', '   ', 'v', undefined, null, 5, {}, { language: 5 }, { language: 'en' }, [], true]) {
    expect(languageFromSetting(v)).toBe('en')
  }
})

test('both language tables have identical keys and kinds', () => {
  const enKeys = Object.keys(TABLES.en).sort()
  const viKeys = Object.keys(TABLES.vi).sort()
  expect(viKeys).toEqual(enKeys)
  const e = TABLES.en as unknown as Record<string, unknown>
  const v = TABLES.vi as unknown as Record<string, unknown>
  for (const k of enKeys) expect(typeof v[k]).toBe(typeof e[k])
})

test('every string is non-empty and every function returns a non-empty string, in both languages', () => {
  const argSets: unknown[][] = [[1, 2, 3], [0, 0, 0], ['a', 'b', 'c'], [null, null, null], [5, 'x', null], ['x', 5, 9]]
  for (const lang of ['en', 'vi'] as const) {
    const table = TABLES[lang] as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'function') {
        for (const args of argSets) {
          const out = (value as (...a: unknown[]) => unknown)(...args)
          expect(typeof out === 'string' && out.trim().length > 0).toBe(true)
        }
      } else {
        expect(typeof value === 'string' && value.trim().length > 0).toBe(true)
      }
      expect(key.length > 0).toBe(true)
    }
  }
})

test('the strings carry the numbers they are given', () => {
  expect(en.tipContext(78, 85)).toContain('78%')
  expect(en.tipContext(78, 85)).toContain('85%')
  expect(vi.tipContext(78, 85)).toContain('78%')
  expect(en.tipAgents(4)).toContain('4')
  expect(en.tipCache(12, '156k')).toContain('12')
  expect(en.tipCache(12, '156k')).toContain('156k')
  expect(en.estimate('2', '1', '3')).toBe('This turn ~2% of 5H (1-3%)')
  expect(en.estimateTail('Opus 5.5', '156k', null)).not.toContain('cold')
  expect(en.estimateTail('Opus 5.5', '156k', '11')).toContain('+11%')
})

// ---------- config.ts ----------
const opts = (o: Record<string, unknown> | undefined): PluginOptions | undefined => o as unknown as PluginOptions | undefined

test('readConfig defaults', () => {
  const d = { language: 'auto', tips: true, estimate: true, contextTipPercent: 70 }
  expect(readConfig(undefined)).toEqual(d)
  expect(readConfig(opts({}))).toEqual(d)
  expect(readConfig(opts({ language: 'fr', tips: 'no', estimate: 0, contextTipPercent: '80' }))).toEqual(d)
})

test('readConfig: language, switches and clamping of the context percentage', () => {
  expect(readConfig(opts({ language: 'en' })).language).toBe('en')
  expect(readConfig(opts({ language: 'vi' })).language).toBe('vi')
  expect(readConfig(opts({ language: 'auto' })).language).toBe('auto')
  expect(readConfig(opts({ tips: false })).tips).toBe(false)
  expect(readConfig(opts({ estimate: false })).estimate).toBe(false)
  expect(readConfig(opts({ tips: false, estimate: false }))).toEqual({ language: 'auto', tips: false, estimate: false, contextTipPercent: 70 })
  expect(readConfig(opts({ contextTipPercent: 50 })).contextTipPercent).toBe(50)
  expect(readConfig(opts({ contextTipPercent: 30 })).contextTipPercent).toBe(30)
  expect(readConfig(opts({ contextTipPercent: 95 })).contextTipPercent).toBe(95)
  expect(readConfig(opts({ contextTipPercent: 10 })).contextTipPercent).toBe(30)
  expect(readConfig(opts({ contextTipPercent: 0 })).contextTipPercent).toBe(30)
  expect(readConfig(opts({ contextTipPercent: -5 })).contextTipPercent).toBe(30)
  expect(readConfig(opts({ contextTipPercent: 99 })).contextTipPercent).toBe(95)
  expect(readConfig(opts({ contextTipPercent: 1000 })).contextTipPercent).toBe(95)
  expect(readConfig(opts({ contextTipPercent: NaN })).contextTipPercent).toBe(70)
  expect(readConfig(opts({ contextTipPercent: Infinity })).contextTipPercent).toBe(70)
  expect(readConfig(opts({ contextTipPercent: null })).contextTipPercent).toBe(70)
})

// ---------- files.ts ----------
test('configDirOf: env wins, then home, then user profile, else empty', () => {
  expect(configDirOf('/cfg', '/home/u', 'C:\\Users\\u')).toBe('/cfg')
  expect(configDirOf('  /cfg  ', undefined, undefined)).toBe('/cfg')
  expect(configDirOf('', '/home/u', undefined)).toBe('/home/u/.claude')
  expect(configDirOf('   ', '/home/u', 'C:\\Users\\u')).toBe('/home/u/.claude')
  expect(configDirOf(undefined, undefined, 'C:\\Users\\u')).toBe('C:\\Users\\u/.claude')
  expect(configDirOf(undefined, '  ', 'C:\\Users\\u')).toBe('C:\\Users\\u/.claude')
  expect(configDirOf(undefined, '/home/u/', undefined)).toBe('/home/u/.claude')
  expect(configDirOf(undefined, 'C:\\Users\\u\\', undefined)).toBe('C:\\Users\\u\\.claude')
  expect(configDirOf(undefined, undefined, undefined)).toBe('')
  expect(configDirOf('', '', '')).toBe('')
  expect(configDirOf(undefined, '   ', '   ')).toBe('')
})

// ---------- transcripts: one reply is written as several lines ----------
const FROM2 = Date.UTC(2026, 10, 25)
const reply = (id: string, ts: string, out: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, ...extra, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })

test('a reply written as several lines is counted once, from its last line', () => {
  const text = [
    reply('msg_1', '2026-11-25T10:00:00.000Z', 5), // thinking block: output so far
    reply('msg_1', '2026-11-25T10:00:01.000Z', 5), // text block
    reply('msg_1', '2026-11-25T10:00:02.000Z', 120), // tool_use block: the final count
    reply('msg_2', '2026-11-25T10:05:00.000Z', 40),
  ].join('\n')
  const use = parseTranscript('s', text, FROM2, FROM2 + DAY)
  expect(use.entries.length).toBe(2)
  expect(use.entries.map(e => e.tokens).sort((a, b) => a - b)).toEqual([50, 130]) // 10+40 and 10+120
})

test('a line with no message id falls back to its request id, and with neither counts as its own reply', () => {
  const noId = (rid: string | undefined, out: number): string => JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T10:00:00.000Z', requestId: rid, message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: out } } })
  const use = parseTranscript('s', [noId('req_1', 3), noId('req_1', 9), noId(undefined, 1), noId(undefined, 2)].join('\n'), FROM2, FROM2 + DAY)
  expect(use.entries.map(e => e.tokens).sort((a, b) => a - b)).toEqual([1, 2, 9])
})

test('transcriptParser takes pieces, and a title line outside the day still names the session', () => {
  const p = transcriptParser('s', FROM2, FROM2 + DAY)
  p.feed(reply('a', '2026-11-25T10:00:00.000Z', 1))
  p.feed(JSON.stringify({ type: 'ai-title', aiTitle: 'Auto title' }) + '\n' + reply('b', '2026-11-24T10:00:00.000Z', 1))
  p.feed(JSON.stringify({ type: 'custom-title', customTitle: 'My name' }))
  const out = p.result()
  expect(out.title).toBe('My name')
  expect(out.entries.length).toBe(1)
})

test('plain strips control characters from titles and models', () => {
  expect(plain('a\u001b[31mred\u0007\nb')).toBe('a [31mred  b')
  expect(plain('ok text')).toBe('ok text')
  const use = parseTranscript('s', [JSON.stringify({ type: 'ai-title', aiTitle: 'bad\u001b]0;x\u0007title' })].join('\n'), FROM2, FROM2 + DAY)
  expect(use.title.includes('\u001b')).toBe(false)
  expect(use.title.includes('\u0007')).toBe(false)
})

test('a title in a report row has no control characters', () => {
  const day = addToDay(emptyDay(), { id: 'x', title: 'evil\u001b[2Jtitle', tier: 'opus', pct: 1, tokens: 10, at: 0 }, 0)
  const lines = reportLines(TABLES.en, buildReport(day, [], 0, tl => tl), '2026-11-25')
  expect(lines.some(l => (l.label ?? '').includes('\u001b'))).toBe(false)
})

// ---------- files.ts: a transcript bigger than one read is read in pieces ----------
type FakeFile = { text: string; mtimeMs: number }
function fakeEngine(files: Record<string, FakeFile>, reads: Array<{ offset?: number; length?: number }> = []) {
  return {
    fs: {
      list: async (path: string) => {
        const dir = path.replace(/\/$/, '')
        const names = new Map<string, 'file' | 'dir'>()
        for (const k of Object.keys(files)) if (k.startsWith(dir + '/')) { const rest = k.slice(dir.length + 1); names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file') }
        if (names.size === 0) throw new Error('ENOENT')
        return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: files[dir + '/' + name]?.mtimeMs ?? 5, isLink: false }))
      },
      stat: async (path: string) => { const f = files[path]; if (!f) throw new Error('ENOENT'); return { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } },
      read: async (path: string, o?: { offset?: number; length?: number }) => {
        const f = files[path]
        if (!f) throw new Error('ENOENT')
        reads.push(o ?? {})
        if (o === undefined && f.text.length > READ_CAP) throw new Error('over 4 MiB')
        return o ? f.text.slice(o.offset ?? 0, (o.offset ?? 0) + (o.length ?? READ_CAP)) : f.text
      },
    },
  } as never
}

test('a transcript of several MiB is read from start to end in pieces cut at line ends, each reply once', async () => {
  const lines: string[] = []
  let want = 0
  let size = 0
  for (let i = 0; size < 9 * 1024 * 1024; i++) {
    lines.push(JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T10:00:00.000Z', pad: 'x'.repeat(900 + (i % 7)), message: { id: 'm' + i, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2 } } }))
    size += (lines[i]?.length ?? 0) + 1
    want += 1
  }
  const text = lines.join('\n') + '\n'
  const reads: Array<{ offset?: number; length?: number }> = []
  const $ = fakeEngine({ '/c/projects/p/s1.jsonl': { text, mtimeMs: Date.UTC(2026, 10, 25, 12) } }, reads)
  const uses = await readTodayTranscripts($, '/c', FROM2, FROM2 + DAY)
  expect(uses.length).toBe(1)
  expect(uses[0]?.id).toBe('s1')
  expect(uses[0]?.entries.length).toBe(want)
  expect(reads.length).toBe(3) // 9+ MiB in pieces of 4 MiB
  expect(reads.every(r => (r.length ?? 0) <= READ_CAP)).toBe(true)
})

test('readTodayTranscripts: newest first, at most MAX_FILES, skips unreadable ones and files older than the day, never throws', async () => {
  const files: Record<string, FakeFile> = {}
  for (let i = 0; i < MAX_FILES + 5; i++) files['/c/projects/p/s' + String(i).padStart(2, '0') + '.jsonl'] = { text: reply('m' + i, '2026-11-25T10:00:00.000Z', 1), mtimeMs: FROM2 + 1000 + i }
  files['/c/projects/p/old.jsonl'] = { text: reply('o', '2026-11-25T10:00:00.000Z', 1), mtimeMs: FROM2 - 1 }
  const logs: string[] = []
  const uses = await readTodayTranscripts(fakeEngine(files), '/c', FROM2, FROM2 + DAY, what => logs.push(what))
  expect(uses.length).toBe(MAX_FILES)
  expect(uses[0]?.id).toBe('s' + String(MAX_FILES + 4))
  expect(uses.some(u => u.id === 'old')).toBe(false)
  expect(await readTodayTranscripts(fakeEngine({}), '/c', FROM2, FROM2 + DAY, what => logs.push(what))).toEqual([])
  expect(logs).toContain('transcripts folder not listed')
  expect(await readTodayTranscripts(fakeEngine({}), '', FROM2, FROM2 + DAY)).toEqual([])
})
