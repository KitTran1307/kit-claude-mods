// Pure helpers: palette, names, countdowns, level and pace colors, bars. No engine calls.
import type { SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

// Tokyo Night.
export const T = {
  dark: '#16161e', hl: '#292e42', hl2: '#3b4261', comment: '#8a93bd', fg: '#c0caf5',
  blue: '#7aa2f7', cyan: '#a6e3ff', magenta: '#d4bcff', orange: '#ff9e64',
  yellow: '#e0af68', green: '#9ece6a', teal: '#73daca', red: '#ffa3b5',
} as const

// Slot 0 is the default account (orange); the others are picked by a hash of the account label.
export const ACCOUNT_COLORS = [T.orange, T.cyan, T.magenta, T.green, T.red, T.yellow, T.blue, T.teal] as const

export const NO_LIMIT: Limit = { pct: null, resetsAt: null }
export const BAR_CELLS = 8
export const DEFAULT_BUDGET_PER_DAY = 14
const DAY_MS = 86_400_000

export function prettyModel(id: string): string {
  // A minor version is 1-2 digits; a dated suffix (claude-sonnet-5-20260101) is not one.
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, name = '', major = '', minor] = m ?? []
  if (!name) return id
  const family = name.charAt(0).toUpperCase() + name.slice(1)
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

// An effort level (`high`) or an integer thinking budget (`16000` -> `16K`); anything else is no effort.
export function prettyEffort(effort: unknown): string | null {
  if (typeof effort === 'string') return effort.trim() ? effort.trim().toUpperCase() : null
  if (typeof effort === 'number' && Number.isFinite(effort) && effort > 0) {
    return effort >= 1000 ? `${Number((effort / 1000).toFixed(1))}K` : String(Math.round(effort))
  }
  return null
}

export function countdown(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt == null) return null
  const totalMin = Math.floor((resetsAt - nowMs) / 60_000)
  if (!Number.isFinite(totalMin) || totalMin <= 0) return null
  if (totalMin < 60) return `${totalMin}m`
  if (totalMin < 360) return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}m`
  if (totalMin < 1440) return `${Math.floor(totalMin / 60)}h`
  return `${Math.floor(totalMin / 1440)}d${String(Math.floor((totalMin % 1440) / 60)).padStart(2, '0')}h`
}

export function levelColor(pct: number | null, calm: string): string {
  if (pct == null) return T.comment
  if (pct >= 90) return T.red
  if (pct >= 70) return T.yellow
  return calm
}

// Weekly budget (display only): `perDay` % per day of the 7-day window, current day included, stepping up once a
// day, never above 100. The window starts 7 days before its reset time. A `perDay` of 0 or less is no budget.
export function weekBudget(resetsAt: number | null, nowMs: number, perDay = DEFAULT_BUDGET_PER_DAY): number | null {
  if (resetsAt == null || !Number.isFinite(perDay) || perDay <= 0) return null
  const elapsedDays = (nowMs - (resetsAt - 7 * DAY_MS)) / DAY_MS
  if (!Number.isFinite(elapsedDays)) return null
  return Math.min(100, perDay * Math.max(1, Math.min(7, Math.floor(elapsedDays) + 1)))
}

// The worse of the usual thresholds and the pace: over budget is yellow, a full day over is red.
export function paceColor(pct: number | null, budget: number | null, calm: string, perDay = DEFAULT_BUDGET_PER_DAY): string {
  const base = levelColor(pct, calm)
  if (pct == null || budget == null || pct <= budget) return base
  const pace = pct - budget >= perDay ? T.red : T.yellow
  return base === T.red || pace === T.red ? T.red : T.yellow
}

export function bar(pct: number | null): { on: string; off: string } {
  const filled = pct == null ? 0 : Math.max(0, Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS)))
  return { on: '▰'.repeat(filled), off: '▱'.repeat(BAR_CELLS - filled) }
}

export function toLimit(limits: readonly SessionRateLimit[], kind: string): Limit {
  const hit = limits.find(l => l.kind === kind)
  if (!hit) return NO_LIMIT
  const resetsAt = hit.resetsAt ? Date.parse(hit.resetsAt) : NaN
  return { pct: Math.round(hit.percentUsed), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
}

/** One line of plain text: whitespace collapsed, every C0/C1 control character (ESC, BEL...) removed. */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim()
}

// One line of at most `room` cells, cut with an ellipsis; too little room is no text at all.
export function fitText(text: string, room: number): string {
  // Control characters (ESC, OSC...) never reach the screen: a hook's stderr or a title cannot drive the terminal.
  const chars = [...cleanText(text)]
  if (Number.isNaN(room) || room < 4) return ''
  return chars.length <= room ? chars.join('') : `${chars.slice(0, room - 1).join('')}…`
}

// ---------- prompt-cache clock ----------
/** The last main-thread reply of the session: when it was written, and how long the prompt cache it touched lives. */
export type CacheStamp = { at: number; ttlMs: number }
export const CACHE_TTL_5M_MS = 300_000
export const CACHE_TTL_1H_MS = 3_600_000
const CACHE_LOW_MS = 60_000
/** A reply stamped further ahead than this (clock skew) is not believed. */
const CACHE_SKEW_MS = 60_000

export type CacheClock = {
  state: 'warm' | 'low' | 'cold'
  /** The time left as `4:07` (seconds) or `4m` / `<1m` (minutes); '' once cold. */
  value: string
}

/**
 * The cache clock for the band. null: nothing to show (no reply yet, a stamp that is missing, not a number or in
 * the future). `tickMs` is how often the band redraws: whole seconds only when it is a second or less, otherwise
 * whole minutes (the redraw would be stale in between). `busy` (a turn is running) hides the clock.
 */
export function cacheClock(stamp: CacheStamp | null | undefined, nowMs: number, tickMs: number, busy = false): CacheClock | null {
  // The main thread is in the middle of a turn: it touches the cache at every step, so the last reply's stamp says nothing.
  if (busy) return null
  if (!stamp || !Number.isFinite(stamp.at) || !Number.isFinite(stamp.ttlMs) || stamp.ttlMs <= 0 || !Number.isFinite(nowMs)) return null
  if (stamp.at - nowMs > CACHE_SKEW_MS) return null
  const left = Math.min(stamp.ttlMs, stamp.at + stamp.ttlMs - nowMs)
  if (left <= 0) return { state: 'cold', value: '' }
  const state = left < CACHE_LOW_MS ? 'low' : 'warm'
  if (tickMs <= 1000) {
    const s = Math.ceil(left / 1000)
    return { state, value: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  }
  return { state, value: left < CACHE_LOW_MS ? '<1m' : `${Math.floor(left / 60_000)}m` }
}

// ---------- 5-hour forecast ----------
export const FIVE_HOUR_MS = 18_000_000
export const FORECAST_MAX = 999

/**
 * Where the 5-hour window ends at the current pace: pct / the share of the window gone. null while it is too early
 * to say (under 10% of the window), when nothing is used yet, or when a number is missing or makes no sense.
 */
export function forecastPct(pct: number | null, resetsAt: number | null, nowMs: number): number | null {
  if (pct == null || resetsAt == null || !Number.isFinite(pct) || !Number.isFinite(resetsAt) || !Number.isFinite(nowMs) || pct <= 0) return null
  const elapsed = FIVE_HOUR_MS - (resetsAt - nowMs)
  if (elapsed * 10 < FIVE_HOUR_MS || elapsed > FIVE_HOUR_MS) return null
  return Math.min(FORECAST_MAX, Math.round((pct * FIVE_HOUR_MS) / elapsed))
}

export function forecastStyle(n: number): { color: string; bold: boolean } {
  if (n >= 100) return { color: T.red, bold: true }
  if (n >= 80) return { color: T.yellow, bold: false }
  return { color: T.comment, bold: false }
}

// ---------- stale limits ----------
export const STALE_AFTER_MS = 300_000

/**
 * Whole minutes since the limits last refreshed, when they are stale: more than 5 minutes old AND a main-thread turn
 * ran after that refresh (`turnAt`). A person who is only idle does not make them stale, since nothing moved; an
 * unknown or earlier turn time is not stale either. null: fresh, idle or not known.
 */
export function staleMinutes(measuredAt: number | null | undefined, turnAt: number | null | undefined, nowMs: number): number | null {
  if (measuredAt == null || !Number.isFinite(measuredAt) || !Number.isFinite(nowMs)) return null
  if (turnAt == null || !Number.isFinite(turnAt) || turnAt <= measuredAt) return null
  const age = nowMs - measuredAt
  return age > STALE_AFTER_MS ? Math.floor(age / 60_000) : null
}
