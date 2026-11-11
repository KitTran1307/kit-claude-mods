// Pure helpers: palette, names, countdowns, level and pace colors, bars. No engine calls.
import type { SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

// Tokyo Night.
export const T = {
  dark: '#16161e', hl: '#292e42', hl2: '#3b4261', comment: '#565f89', fg: '#c0caf5',
  blue: '#7aa2f7', cyan: '#7dcfff', magenta: '#bb9af7', orange: '#ff9e64',
  yellow: '#e0af68', green: '#9ece6a', teal: '#73daca', red: '#f7768e',
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

// One line of at most `room` cells, cut with an ellipsis; too little room is no text at all.
export function fitText(text: string, room: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  if (Number.isNaN(room) || room < 4) return ''
  return chars.length <= room ? chars.join('') : `${chars.slice(0, room - 1).join('')}…`
}
