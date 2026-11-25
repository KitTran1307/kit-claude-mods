// The numbers behind the tips, the "why" card and the pre-send estimate. Every function here is pure: no engine, no clock.
import { tierOf, tierWeight } from './model'
import type { CacheStamp, Calibration, Tier, TurnStat } from '../types'

export type { CacheStamp, Calibration, TurnStat }

export const MINUTE_MS = 60_000
export const CACHE_TTL_5M_MS = 5 * MINUTE_MS
export const CACHE_TTL_1H_MS = 60 * MINUTE_MS

// ---------- what a turn used ----------
/** The token counts of a turn as the engine reports them (a subset of its TurnUsage). */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_1h_input_tokens?: number
  model?: string
}

/** Relative weight of each kind of token (list-price ratios, plain input = 1). */
export const TOKEN_WEIGHT = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A turn's use in Sonnet-equivalent weighted tokens: cheap cache reads count little, writes and output count more. */
export function weighted(u: Usage): number {
  const raw =
    n(u.input_tokens) * TOKEN_WEIGHT.input + n(u.cache_read_input_tokens) * TOKEN_WEIGHT.cacheRead +
    n(u.cache_creation_input_tokens) * TOKEN_WEIGHT.cacheWrite + n(u.output_tokens) * TOKEN_WEIGHT.output
  return raw * tierWeight(u.model)
}

/** All tokens a turn touched, for display (input, cache and output together). */
export const totalTokens = (u: Usage): number =>
  n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)

// ---------- the prompt cache ----------
export type CacheInfo = { state: 'warm' | 'cold' | 'unknown'; idleMs: number; leftMs: number }

/** The cache stamp of a finished reply: it lives 1 hour when the reply wrote 1-hour entries, 5 minutes when it wrote 5-minute ones, and as long as before when it only read. */
export function stampOf(u: Usage | undefined, at: number, previous?: CacheStamp | null): CacheStamp | null {
  if (!u) return previous ?? null
  if (n(u.ephemeral_1h_input_tokens) > 0) return { at, ttlMs: CACHE_TTL_1H_MS }
  // A reply that wrote nothing only read the cache: it keeps the life of the entry it read.
  if (n(u.cache_creation_input_tokens) === 0 && previous) return { at, ttlMs: previous.ttlMs }
  return { at, ttlMs: CACHE_TTL_5M_MS }
}

export function cacheInfo(stamp: CacheStamp | null | undefined, now: number): CacheInfo {
  if (!stamp || !Number.isFinite(stamp.at) || now <= 0) return { state: 'unknown', idleMs: 0, leftMs: 0 }
  const idleMs = Math.max(0, now - stamp.at)
  const leftMs = stamp.ttlMs - idleMs
  return leftMs > 0 ? { state: 'warm', idleMs, leftMs } : { state: 'cold', idleMs, leftMs: 0 }
}

// ---------- calibration ----------

export const NO_CALIBRATION_VALUE: Calibration = { pct: 0, weighted: 0, turns: 0 }

/** Points of the 5-hour window that must have moved, and turns that must have run, before an estimate is shown. */
export const MIN_POINTS = 3
export const MIN_TURNS = 3

/**
 * Adds a turn to the totals. `windowPct` is the 5-hour percentage now, `lastPct` the one before the turn; a percentage that
 * went down is a new window and starts the totals over. A turn with no known percentage adds its tokens only when the
 * totals already hold some (so the rate does not drift), never a guess.
 */
export function addTurn(c: Calibration, spent: number, lastPct: number | null, windowPct: number | null): Calibration {
  if (lastPct === null || windowPct === null || !Number.isFinite(lastPct) || !Number.isFinite(windowPct)) return c
  if (windowPct < lastPct) return { pct: 0, weighted: 0, turns: 0 }
  return { pct: c.pct + (windowPct - lastPct), weighted: c.weighted + Math.max(0, spent), turns: c.turns + 1 }
}

/** The 5-hour percentage while its window is still open; null once the window's reset time has passed (the number is old). */
export function livePct(pct: number | null, resetsAt: string | null, now: number): number | null {
  if (pct === null) return null
  const end = resetsAt ? Date.parse(resetsAt) : NaN
  return Number.isFinite(end) && end <= now ? null : pct
}

/** A window's high-water mark in the store: the highest percentage any session has credited in the window named `resetsAt`. */
export type HighWater = { resetsAt: string; pct: number }

/**
 * The points a turn is credited with. The 5-hour percentage belongs to the account, so with two sessions open each sees
 * the other's spending move it: only what rose above the window's high-water mark is credited, once.
 */
export function credit(base: number | null, after: number | null, resetsAt: string | null, hw: HighWater | null): { points: number; hw: HighWater | null } {
  if (after === null || !Number.isFinite(after)) return { points: 0, hw }
  const same = hw !== null && resetsAt !== null && hw.resetsAt === resetsAt
  const floor = base === null ? (same ? hw.pct : after) : same ? Math.max(base, hw.pct) : base
  return {
    points: Math.max(0, after - floor),
    hw: resetsAt === null ? hw : { resetsAt, pct: same ? Math.max(hw.pct, after) : after },
  }
}

export const isCalibrated = (c: Calibration): boolean => c.turns >= MIN_TURNS && c.pct >= MIN_POINTS && c.weighted > 0

/** Percentage points of the 5-hour window per weighted token; null until calibrated. */
export const rateOf = (c: Calibration): number | null => (isCalibrated(c) ? c.pct / c.weighted : null)

// ---------- the pre-send estimate ----------

/** The most recent turns kept for averages. */
export const KEEP_TURNS = 8

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** What the next turn is expected to use, in weighted tokens, from the context size, the cache and what recent turns looked like. */
export function expectedWeighted(ctxTokens: number, recent: readonly TurnStat[], cache: 'warm' | 'cold' | 'unknown', model: string): number {
  const steps = Math.max(1, Math.round(avg(recent.slice(-5).map(t => t.steps)) || 1))
  const output = avg(recent.slice(-5).map(t => t.output))
  const first = cache === 'cold' ? TOKEN_WEIGHT.cacheWrite : TOKEN_WEIGHT.cacheRead
  const reads = ctxTokens * (first + TOKEN_WEIGHT.cacheRead * (steps - 1))
  return (reads + output * TOKEN_WEIGHT.output) * tierWeight(model)
}

export type Estimate = { low: number; mid: number; high: number; coldExtra: number }

/** The uncertainty: one point of rounding on the measured total, plus a fifth for how much turns differ. */
export const uncertainty = (c: Calibration): number => Math.min(0.8, 0.2 + 1 / Math.max(1, c.pct))

/** The share of the 5-hour window the next turn is expected to use; null until the rate is calibrated or without a context size. */
export function estimateTurn(
  c: Calibration, ctxTokens: number | null, recent: readonly TurnStat[], cache: 'warm' | 'cold' | 'unknown', model: string,
): Estimate | null {
  const rate = rateOf(c)
  if (rate === null || ctxTokens === null || ctxTokens <= 0) return null
  const mid = rate * expectedWeighted(ctxTokens, recent, cache, model)
  const u = uncertainty(c)
  const warm = rate * expectedWeighted(ctxTokens, recent, 'warm', model)
  const cold = rate * expectedWeighted(ctxTokens, recent, 'cold', model)
  return { low: mid * (1 - u), mid, high: mid * (1 + u), coldExtra: Math.max(0, cold - warm) }
}

// ---------- tips ----------
export type TipKind = 'context' | 'agents' | 'cache' | 'model'

export type Tip =
  | { kind: 'context'; pct: number; savePct: number }
  | { kind: 'agents'; count: number }
  | { kind: 'cache'; idleMin: number; tokens: number }
  | { kind: 'model'; tier: Tier }

export type TipFacts = {
  ctxPct: number | null
  ctxTokens: number | null
  window: number | null
  model: string
  agentsRunning: number
  cache: CacheInfo
  recent: readonly TurnStat[]
  contextThreshold: number
}

/** After a compaction the context is roughly a summary: at least 15k tokens, or 8% of the window. */
export function compactSavingPct(tokens: number, window: number): number {
  const after = Math.max(15_000, 0.08 * window)
  if (!(tokens > after * 1.5)) return 0
  return Math.min(90, Math.floor(((1 - after / tokens) * 100) / 5) * 5)
}

/** A cold cache on a context this big is worth a word: re-reading it is not discounted. */
export const BIG_CONTEXT_TOKENS = 50_000
export const MANY_AGENTS = 3
const LIGHT = { turns: 3, steps: 3, output: 1200 } as const

/** Whether the last turns were light work: few steps, short answers, no subagents. */
export function isLightWork(recent: readonly TurnStat[]): boolean {
  const last = recent.slice(-LIGHT.turns)
  return last.length >= LIGHT.turns && last.every(t => t.steps <= LIGHT.steps && t.output <= LIGHT.output && t.subagents === 0)
}

/** Every tip that applies now, most useful first. */
export function activeTips(f: TipFacts): Tip[] {
  const tips: Tip[] = []
  if (f.ctxPct !== null && f.ctxPct >= f.contextThreshold && f.ctxTokens !== null && f.window !== null) {
    const savePct = compactSavingPct(f.ctxTokens, f.window)
    if (savePct > 0) tips.push({ kind: 'context', pct: Math.round(f.ctxPct), savePct })
  }
  if (f.agentsRunning >= MANY_AGENTS) tips.push({ kind: 'agents', count: f.agentsRunning })
  if (f.cache.state === 'cold' && f.ctxTokens !== null && f.ctxTokens >= BIG_CONTEXT_TOKENS) {
    tips.push({ kind: 'cache', idleMin: Math.floor(f.cache.idleMs / MINUTE_MS), tokens: f.ctxTokens })
  }
  const tier = tierOf(f.model)
  if (tier === 'opus' && isLightWork(f.recent)) tips.push({ kind: 'model', tier })
  return tips
}

/** The tip to show: the first one not dismissed. */
export const pickTip = (active: readonly Tip[], dismissed: readonly string[]): Tip | null =>
  active.find(t => !dismissed.includes(t.kind)) ?? null

/** A dismissal lasts while its tip keeps applying; once it stops applying (compacted, finished) the tip may come back. */
export const rearm = (dismissed: readonly string[], active: readonly Tip[]): string[] =>
  dismissed.filter(k => active.some(t => t.kind === k))

// ---------- the "why" card ----------
export type Why = {
  ctxTokens: number | null
  ctxPct: number | null
  window: number | null
  model: string
  /** How many times as much as Sonnet a unit of work on the model uses; 1 for Sonnet and unknown models. */
  timesSonnet: number
  agentsRunning: number
  agentsLastTurn: number
  /** Share of the 5-hour window the last turn used (estimated from the calibrated rate), or null. */
  lastTurnPct: number | null
  /** What the last turn did: model steps, tokens and the size of its answer; null before the first turn. */
  lastTurn: { steps: number; tokens: number } | null
  /** Average per turn this window, or null. */
  avgTurnPct: number | null
  cache: CacheInfo
  savePct: number
  /** Whether a cheaper model would help: the model is a strong one. */
  canSwitch: boolean
}

export function whyOf(f: TipFacts, c: Calibration, last: TurnStat | null): Why {
  const rate = rateOf(c)
  const w = tierWeight(f.model)
  return {
    ctxTokens: f.ctxTokens,
    ctxPct: f.ctxPct,
    window: f.window,
    model: f.model,
    timesSonnet: w,
    agentsRunning: f.agentsRunning,
    agentsLastTurn: last?.subagents ?? 0,
    lastTurnPct: last ? (last.pct > 0 ? last.pct : rate !== null ? rate * last.spent : null) : null,
    lastTurn: last ? { steps: last.steps, tokens: last.tokens } : null,
    avgTurnPct: isCalibrated(c) ? c.pct / c.turns : null,
    cache: f.cache,
    savePct: f.ctxTokens !== null && f.window !== null ? compactSavingPct(f.ctxTokens, f.window) : 0,
    canSwitch: tierOf(f.model) === 'opus',
  }
}

// ---------- formatting ----------
/** 156000 -> 156k, 1250000 -> 1.3M, 900 -> 900. */
export function fmtTokens(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0'
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (t >= 10_000) return `${Math.round(t / 1000)}k`
  if (t >= 1000) return `${(t / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(t))
}

/** A share of the window: under half a point is "<1", else whole points ("3"). */
export const fmtPoints = (p: number): string => (!Number.isFinite(p) || p < 0.5 ? '<1' : String(Math.round(p)))

/** The low end of a range: under half a point is "0". */
export const fmtLow = (p: number): string => (!Number.isFinite(p) || p < 0.5 ? '0' : String(Math.round(p)))

/** Minutes as "7 min" is the strings' job; this gives whole minutes, at least 0. */
export const wholeMinutes = (ms: number): number => Math.max(0, Math.floor(ms / MINUTE_MS))

/** A bar of `width` cells for value/max. */
export function bar(value: number, max: number, width: number): { on: string; off: string } {
  const cells = max > 0 && value > 0 ? Math.max(1, Math.min(width, Math.round((value / max) * width))) : 0
  return { on: '▬'.repeat(cells), off: '▭'.repeat(width - cells) }
}
