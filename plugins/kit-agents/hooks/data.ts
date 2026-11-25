// Pure functions of the board: no engine calls, so every one is unit-tested without an engine.
import type { AgentState, BoardAgent } from '../types'
import type { Strings } from './i18n'

export const DEFAULT_CARDS = 4
export const MAX_CARDS = 12
/** Rows of the header line, of a one-line agent, of the "+N more" line. */
export const HEADER_ROWS = 1
/** Characters kept of a name, a label and a model before the layout cuts them to the width. */
export const NAME_MAX = 60
export const LABEL_MAX = 200

export type Palette = { accent: string; running: string; waiting: string; starting: string; border: string; warn: string }
export const COLORS: { dark: Palette; light: Palette } = {
  // Terminal: dark background. Desktop, VS Code and mobile: light. Text colors hold 7:1 on the backgrounds scripts/contrast.mjs
  // lists (the border is not text).
  dark: { accent: '#efa890', running: '#9ece6a', waiting: '#efa890', starting: '#e0b06a', border: '#565f89', warn: '#f2a4b2' },
  light: { accent: '#893214', running: '#215a24', waiting: '#853413', starting: '#714406', border: '#94a3b8', warn: '#9c1818' },
}
export const paletteFor = (surface: unknown): Palette => (surface === 'terminal' ? COLORS.dark : COLORS.light)

/** The `maxCards` option: a whole number from 1 to 12; anything else is the default (4), a number outside it is cut to it. */
export function maxCardsFrom(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_CARDS
  return Math.min(MAX_CARDS, Math.max(1, Math.round(n)))
}

/** One line of text: hidden and control characters out, blanks collapsed, cut to `max` characters with an ellipsis. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : s
}

/** The board's word for an engine status: it works, it is held, it has not started; null for an agent that is not active. */
export function stateOf(status: unknown): AgentState | null {
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'pending') return 'starting'
  return null
}

/**
 * A model id as a person reads it: "claude-sonnet-4-5-20250929" is "Sonnet 4.5", "claude-3-5-haiku-20241022" is
 * "Haiku 3.5", "claude-opus-4-20250514" is "Opus 4". An id of no known family is shown cleaned and cut; no id, no label.
 */
export function modelLabel(id: unknown): string | undefined {
  const raw = cleanText(id, 80)
  if (!raw) return undefined
  const lower = raw.toLowerCase()
  const family = /(opus|sonnet|haiku)/.exec(lower)?.[1]
  if (!family) return cleanText(raw.replace(/^claude-/i, ''), 24) || undefined
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  // A date (8 digits) is not a version: only one or two digits count.
  const after = new RegExp(`${family}-(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?`).exec(lower)
  const before = /claude-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?-(?:opus|sonnet|haiku)/.exec(lower)
  const m = after ?? before
  return m ? `${name} ${m[1]}${m[2] ? `.${m[2]}` : ''}` : name
}

/** Share of the context window used, a whole number from 0 to 100; undefined when the window or the count is not known. */
export function contextPercent(tokens: unknown, window: unknown): number | undefined {
  if (typeof tokens !== 'number' || typeof window !== 'number') return undefined
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
}

/** A bar of `cells` cells for a percentage: filled cells first. */
export function contextBar(pct: number, cells: number): string {
  const n = Math.max(1, Math.floor(cells))
  const filled = Math.min(n, Math.max(0, Math.round((Math.min(100, Math.max(0, pct)) / 100) * n)))
  return '▰'.repeat(filled) + '▱'.repeat(n - filled)
}

/** Cells of a context bar for the width given: a shorter one on a narrow screen. */
export const barCells = (columns: number): number => (columns < 44 ? 6 : 10)

/** Running time as mm:ss, or h:mm:ss from an hour on; 00:00 for a time that is not in the past. */
export function formatElapsed(ms: unknown): string {
  const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** How long an agent has run at `now`; undefined when it has no start time. */
export const elapsedOf = (a: Pick<BoardAgent, 'startTime'>, now: number): string | undefined =>
  a.startTime === undefined ? undefined : formatElapsed(now - a.startTime)

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})

/** One entry of `$.agent.list()` as the board holds it; null for what is not an active agent or has no id. Never throws. */
export function toBoardAgent(raw: unknown): BoardAgent | null {
  const o = obj(raw)
  const id = typeof o.id === 'string' ? o.id : ''
  const state = stateOf(o.status)
  if (!id || !state) return null
  const type = cleanText(o.type, NAME_MAX)
  const agent: BoardAgent = {
    id,
    name: cleanText(o.name, NAME_MAX) || type || cleanText(id.slice(0, 8), 8),
    type,
    state,
    label: cleanText(o.label, LABEL_MAX) || cleanText(o.description, LABEL_MAX),
  }
  const model = modelLabel(o.model)
  if (model) agent.model = model
  if (typeof o.startTime === 'number' && Number.isFinite(o.startTime) && o.startTime > 0) agent.startTime = o.startTime
  const pct = contextPercent(o.tokenCount, o.contextWindowSize)
  if (pct !== undefined) agent.pct = pct
  return agent
}

/** Waiting for the person first, then the longest running first; an agent with no start time after those, by id. */
export function sortAgents(agents: readonly BoardAgent[]): BoardAgent[] {
  const rank = (a: BoardAgent) => (a.state === 'waiting' ? 0 : 1)
  return [...agents].sort((a, b) =>
    rank(a) - rank(b)
    || (a.startTime ?? Infinity) - (b.startTime ?? Infinity)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The active agents of an engine list, ordered for the board. A list that is not a list is empty. */
export function boardAgents(list: unknown): BoardAgent[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const agents: BoardAgent[] = []
  for (const raw of list) {
    const a = toBoardAgent(raw)
    if (a && !seen.has(a.id)) { seen.add(a.id); agents.push(a) }
  }
  return sortAgents(agents)
}

export const countWaiting = (agents: readonly BoardAgent[]): number => agents.filter(a => a.state === 'waiting').length

/** Rows a whole card takes: border (2), name line, state line, then the task, the context bar and the Reply row when there are. */
export const cardRows = (a: BoardAgent): number =>
  2 + 2 + (a.label ? 1 : 0) + (a.pct !== undefined ? 1 : 0) + (a.state === 'waiting' ? 1 : 0)

export type BoardPlan =
  | { mode: 'none' }
  /** One line: the count, and Reply for the first agent that waits. */
  | { mode: 'line'; rows: 1 }
  /** `full` whole cards, then `compact` one-line agents, then a "+N more" line when `hidden` is above 0. */
  | { mode: 'board'; full: number; compact: number; hidden: number; rows: number }

/**
 * What fits in `maxRows` (the rows the engine gives the band): the most urgent agents as whole cards, the next as one
 * line each, the rest counted on a "+N more" line. At most `maxCards` agents show; with no room for the header and one
 * line, the board is a single line. Never more rows than given (and never fewer than one).
 */
export function planBoard(maxRows: number, agents: readonly BoardAgent[], maxCards: number): BoardPlan {
  if (agents.length === 0) return { mode: 'none' }
  const rows = Number.isFinite(maxRows) ? Math.floor(maxRows) : 1
  if (rows < HEADER_ROWS + 2) return { mode: 'line', rows: 1 }
  const budget = rows - HEADER_ROWS
  const listed = agents.slice(0, Math.max(1, Math.floor(maxCards)))
  let compact = listed.length
  let hidden = agents.length - compact
  // One line each, leaving a row for "+N more" when some are not listed; drop the last ones until it fits.
  while (compact > 1 && compact + (hidden > 0 ? 1 : 0) > budget) { compact -= 1; hidden += 1 }
  let used = compact + (hidden > 0 ? 1 : 0)
  let full = 0
  // Upgrade in order, so the most urgent get the whole cards; the first that does not fit stops it.
  for (let i = 0; i < compact; i += 1) {
    const extra = cardRows(listed[i]!) - 1
    if (used + extra > budget) break
    used += extra
    full += 1
  }
  return { mode: 'board', full, compact: compact - full, hidden, rows: HEADER_ROWS + used }
}

/** Rows a plan takes, for the bands of the plugins beneath. */
export const planRows = (plan: BoardPlan): number => (plan.mode === 'none' ? 0 : plan.mode === 'line' ? 1 : plan.rows)

/** The one-line form of an agent: running time, model, context share and what it does, in the order of importance. */
export function compactText(a: BoardAgent, now: number, t: Pick<Strings, 'state'>): string {
  const parts = [
    elapsedOf(a, now),
    a.model,
    a.pct !== undefined ? `${a.pct}%` : undefined,
    a.state === 'running' ? undefined : t.state[a.state],
    a.label || undefined,
  ].filter((p): p is string => !!p)
  return parts.join(' ')
}

/** The state line of a card: the state, then the model and the type when it differs from the name. */
export function metaText(a: BoardAgent, t: Pick<Strings, 'state'>): { state: string; rest: string } {
  const rest = [a.model, a.type && a.type !== a.name ? a.type : undefined].filter((p): p is string => !!p).join(' · ')
  return { state: t.state[a.state], rest: rest ? ` · ${rest}` : '' }
}

/** One line of /board for an agent. */
export function listLine(a: BoardAgent, index: number, now: number, t: Pick<Strings, 'state' | 'ctx'>): string {
  const parts = [
    `[${t.state[a.state]}] ${a.name}`,
    a.model,
    elapsedOf(a, now),
    a.pct !== undefined ? `${t.ctx} ${a.pct}%` : undefined,
    a.label || undefined,
  ].filter((p): p is string => !!p)
  return `${index + 1}. ${parts.join(' - ')}`
}

export type Level = 'PASS' | 'WARN' | 'FAIL'
export type Line = { level: Level; name: string; detail: string; fix?: string }
export const formatLine = (l: Line): string => `${l.level} ${l.name} - ${l.detail}${l.fix ? ` Fix: ${l.fix}` : ''}`
export const countLevels = (lines: readonly Line[]) => ({
  pass: lines.filter(l => l.level === 'PASS').length,
  warn: lines.filter(l => l.level === 'WARN').length,
  fail: lines.filter(l => l.level === 'FAIL').length,
})

/** How long an agent must have run before the pane opens for it: a short job is over before a pane would be useful (the band shows meanwhile). */
export const PANE_AFTER_MS = 5_000

/** Milliseconds an agent has run: from its start time, else from when the board first saw it; 0 when neither is known. */
export function ageOf(a: BoardAgent, now: number, firstSeen: Record<string, number>): number {
  const from = typeof a.startTime === 'number' ? a.startTime : firstSeen[a.id]
  return typeof from === 'number' ? Math.max(0, now - from) : 0
}

/** Whether any agent has run for at least PANE_AFTER_MS. */
export const anyLongRunning = (agents: BoardAgent[], now: number, firstSeen: Record<string, number>): boolean =>
  agents.some(a => ageOf(a, now, firstSeen) >= PANE_AFTER_MS)
