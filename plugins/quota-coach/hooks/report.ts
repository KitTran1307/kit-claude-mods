// The daily report: what each session, model and hour used of the plan today. Pure functions: the module reads this
// plugin's own store and the local transcripts through $.fs and hands the text here.
import { bar, fmtPoints, fmtTokens, totalTokens, weighted } from './calc'
import type { Usage } from './calc'
import type { Strings } from './i18n'
import { tierLabel, tierOf } from './model'
import type { Day, DaySession, Report, ReportRow, Tier } from '../types'

export type { Day, DaySession, Report, ReportRow, Tier }
export const emptyDay = (): Day => ({ sessions: {}, hours: Array.from({ length: 24 }, () => 0), models: {}, windows: [] })

export const KEEP_DAYS = 14

/** The local date as YYYY-MM-DD; `tzOffsetMin` is `Date.getTimezoneOffset()` (minutes behind UTC). */
export const dayKey = (ms: number, tzOffsetMin: number): string => new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 10)
export const hourOf = (ms: number, tzOffsetMin: number): number => new Date(ms - tzOffsetMin * 60_000).getUTCHours()
/** Midnight of the local day containing `ms`, as UTC ms. */
export const dayStart = (ms: number, tzOffsetMin: number): number => {
  const local = ms - tzOffsetMin * 60_000
  return local - (((local % 86_400_000) + 86_400_000) % 86_400_000) + tzOffsetMin * 60_000
}

export type TurnRecord = { id: string; title: string; tier: Tier; pct: number; tokens: number; at: number; resetsAt?: string | null }

const add = (m: Partial<Record<Tier, number>>, tier: Tier, v: number): Partial<Record<Tier, number>> => ({ ...m, [tier]: (m[tier] ?? 0) + v })

/** Adds one finished turn to a day. A turn that moved the window adds its points; every turn adds its tokens. */
export function addToDay(day: Day, t: TurnRecord, tzOffsetMin: number): Day {
  const pct = Number.isFinite(t.pct) && t.pct > 0 ? t.pct : 0
  const prior = day.sessions[t.id]
  const session: DaySession = {
    title: t.title || prior?.title || '',
    pct: (prior?.pct ?? 0) + pct,
    tokens: (prior?.tokens ?? 0) + Math.max(0, t.tokens),
    models: pct > 0 ? add(prior?.models ?? {}, t.tier, pct) : (prior?.models ?? {}),
  }
  const hours = day.hours.slice()
  if (pct > 0) hours[hourOf(t.at, tzOffsetMin)] = (hours[hourOf(t.at, tzOffsetMin)] ?? 0) + pct
  const windows = t.resetsAt && !day.windows.includes(t.resetsAt) ? [...day.windows, t.resetsAt].slice(-12) : day.windows
  return { sessions: { ...day.sessions, [t.id]: session }, hours, models: pct > 0 ? add(day.models, t.tier, pct) : day.models, windows }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** One day read back from the store; anything of the wrong shape is dropped (null), a bad number inside it counts as 0. */
export function sanitizeDay(raw: unknown): Day | null {
  const d = raw as Partial<Day> | null
  if (!d || typeof d !== 'object' || !d.sessions || typeof d.sessions !== 'object' || !Array.isArray(d.hours) || d.hours.length !== 24) return null
  const sessions: Record<string, DaySession> = {}
  for (const [id, v] of Object.entries(d.sessions)) {
    const x = v as Partial<DaySession> | null
    if (!x || typeof x !== 'object') continue
    const models: Partial<Record<Tier, number>> = {}
    for (const [k, n] of Object.entries(x.models ?? {})) if (finite(n)) models[k as Tier] = n
    sessions[id] = { title: typeof x.title === 'string' ? x.title : '', pct: finite(x.pct) ? x.pct : 0, tokens: finite(x.tokens) ? x.tokens : 0, models }
  }
  const models: Partial<Record<Tier, number>> = {}
  for (const [k, n] of Object.entries(d.models ?? {})) if (finite(n)) models[k as Tier] = n
  return {
    sessions, models, hours: d.hours.map(x => (finite(x) ? x : 0)),
    windows: Array.isArray(d.windows) ? d.windows.filter((w): w is string => typeof w === 'string') : [],
  }
}

/** Several days (one per session, kept apart so two sessions never write one value) added into one. */
export function mergeDays(days: readonly Day[]): Day {
  let out = emptyDay()
  for (const d of days) {
    const sessions = { ...out.sessions, ...d.sessions }
    const models = { ...out.models }
    for (const [k, n] of Object.entries(d.models) as Array<[Tier, number]>) models[k] = (models[k] ?? 0) + n
    out = {
      sessions, models, hours: out.hours.map((h, i) => h + (d.hours[i] ?? 0)),
      windows: [...out.windows, ...d.windows.filter(w => !out.windows.includes(w))].slice(-12),
    }
  }
  return out
}

/** The store key of one session's record for one day. */
export const dayStoreKey = (date: string, sessionId: string): string => `day:${date}:${sessionId}`
/** The date a store key belongs to, or null for a key that is not a day record. */
export const dateOfKey = (key: string): string | null => /^day:(\d{4}-\d{2}-\d{2}):./.exec(key)?.[1] ?? null

/** The store keys to delete: day records older than the newest `KEEP_DAYS` dates. */
export function expiredKeys(keys: readonly string[]): string[] {
  const dates = [...new Set(keys.map(dateOfKey).filter((d): d is string => d !== null))].sort().slice(0, -KEEP_DAYS)
  return keys.filter(k => dates.includes(dateOfKey(k) ?? ''))
}

// ---------- the transcripts ----------
export type TranscriptUse = { id: string; title: string; entries: Array<{ at: number; tier: Tier; model: string; tokens: number; weighted: number }> }

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The replies of one transcript inside [from, to): when, which model and how many tokens. A line that does not parse,
 * a subagent's, a stand-in (`<synthetic>`) and a reply with no usage are skipped. The title is the latest /rename, else
 * the latest automatic title; both come from the same file.
 */
export type TranscriptParser = { feed: (text: string) => void; result: () => TranscriptUse }

/** Strips control characters (a title or model id comes from a file, and is drawn in a terminal). */
export const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')

/**
 * A reader that is fed a transcript in pieces (each ending at a line end) and answers with what was read. Claude Code writes
 * one line per content block of a reply, each repeating the reply's id and usage: a reply is counted once, from its last line.
 */
export function transcriptParser(id: string, from: number, to: number): TranscriptParser {
  const byReply = new Map<string, TranscriptUse['entries'][number]>()
  const loose: TranscriptUse['entries'] = []
  let custom = ''
  let auto = ''
  const feed = (text: string): void => {
    for (const line of text.split('\n')) readLine(line)
  }
  const readLine = (line: string): void => {
    if (!line.startsWith('{') || !(line.includes('"type":"assistant"') || line.includes('-title"'))) return
    let o: Record<string, unknown> | null
    try { o = rec(JSON.parse(line)) } catch { return }
    if (!o) return
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) custom = plain(o.customTitle).trim()
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) auto = plain(o.aiTitle).trim()
    else if (o.type === 'assistant' && o.isSidechain !== true) {
      const message = rec(o.message)
      const usage = rec(message?.usage)
      const model = typeof message?.model === 'string' ? message.model : ''
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
      if (!usage || !model || model === '<synthetic>' || !Number.isFinite(at) || at < from || at >= to) return
      const u: Usage = {
        input_tokens: num(usage.input_tokens), output_tokens: num(usage.output_tokens),
        cache_read_input_tokens: num(usage.cache_read_input_tokens), cache_creation_input_tokens: num(usage.cache_creation_input_tokens), model,
      }
      const entry = { at, tier: tierOf(model), model: plain(model), tokens: totalTokens(u), weighted: weighted(u) }
      const replyId = typeof message?.id === 'string' && message.id ? message.id : typeof o.requestId === 'string' ? o.requestId : ''
      if (replyId) byReply.set(replyId, entry)
      else loose.push(entry)
    }
  }
  return { feed, result: () => ({ id, title: custom || auto, entries: [...byReply.values(), ...loose] }) }
}

/** One transcript read whole. */
export function parseTranscript(id: string, text: string, from: number, to: number): TranscriptUse {
  const parser = transcriptParser(id, from, to)
  parser.feed(text)
  return parser.result()
}

// ---------- the report ----------
const biggestKey = (m: Partial<Record<Tier, number>>): Tier | null => {
  let best: Tier | null = null
  for (const [k, v] of Object.entries(m) as Array<[Tier, number]>) if (best === null || v > (m[best] ?? 0)) best = k
  return best
}

/** Puts the stored day and the transcripts together. Percentages come only from the store; tokens from both (the transcript wins). */
export function buildReport(day: Day | undefined, uses: readonly TranscriptUse[], tzOffsetMin: number, labelOf: (tier: Tier, model: string) => string): Report {
  const d = day ?? emptyDay()
  const byId = new Map<string, ReportRow>()
  const tokensByTier = new Map<Tier, { tokens: number; label: string }>()
  const tokensByHour = new Array<number>(24).fill(0)
  for (const u of uses) {
    if (u.entries.length === 0) continue
    const tokens = u.entries.reduce((a, e) => a + e.tokens, 0)
    const top = new Map<Tier, number>()
    for (const e of u.entries) {
      top.set(e.tier, (top.get(e.tier) ?? 0) + e.weighted)
      tokensByHour[hourOf(e.at, tzOffsetMin)] = (tokensByHour[hourOf(e.at, tzOffsetMin)] ?? 0) + e.tokens
      const cur = tokensByTier.get(e.tier)
      tokensByTier.set(e.tier, { tokens: (cur?.tokens ?? 0) + e.tokens, label: cur?.label ?? labelOf(e.tier, e.model) })
    }
    const tier = [...top.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const stored = d.sessions[u.id]
    byId.set(u.id, { id: u.id, title: stored?.title || u.title, tier, pct: stored ? stored.pct : null, tokens: Math.max(tokens, stored?.tokens ?? 0) })
  }
  for (const [id, s] of Object.entries(d.sessions)) {
    if (!byId.has(id)) byId.set(id, { id, title: s.title, tier: biggestKey(s.models), pct: s.pct, tokens: s.tokens })
  }
  const sessions = [...byId.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.tokens - a.tokens)
  const storedPct = Object.values(d.sessions).reduce((a, s) => a + s.pct, 0)
  const hasPct = storedPct > 0
  const tiers = new Set<Tier>([...tokensByTier.keys(), ...(Object.keys(d.models) as Tier[])])
  const models = [...tiers].map(tier => ({
    tier, label: tokensByTier.get(tier)?.label ?? labelOf(tier, ''), pct: hasPct ? (d.models[tier] ?? 0) : null, tokens: tokensByTier.get(tier)?.tokens ?? 0,
  })).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || b.tokens - a.tokens)
  const hours = tokensByHour.map((tokens, hour) => ({ hour, pct: hasPct ? (d.hours[hour] ?? 0) : null, tokens })).filter(h => (h.pct ?? 0) > 0 || h.tokens > 0)
  const busiest = hours.length ? hours.reduce((a, b) => ((b.pct ?? b.tokens) > (a.pct ?? a.tokens) ? b : a)) : null
  const topTier = hasPct ? biggestKey(d.models) : (models[0]?.tier ?? null)
  const modelTotal = hasPct ? storedPct : models.reduce((a, m) => a + m.tokens, 0)
  const topValue = topTier === null ? 0 : hasPct ? (d.models[topTier] ?? 0) : (models.find(m => m.tier === topTier)?.tokens ?? 0)
  return {
    totalPct: hasPct ? storedPct : null,
    totalTokens: sessions.reduce((a, s) => a + s.tokens, 0),
    sessions, models, hours,
    windows: d.windows.length,
    hasPct,
    busiestHour: busiest?.hour ?? null,
    topTier,
    topShare: modelTotal > 0 ? Math.round((topValue / modelTotal) * 100) : 0,
  }
}

// ---------- drawing the report: the same lines for the pane and for the command's text ----------
export type Line = {
  kind: 'title' | 'sub' | 'head' | 'row' | 'tip' | 'note' | 'blank'
  text: string
  /** A row: its label, an optional tag (the model), a bar and the value. */
  label?: string
  tag?: string
  bar?: { on: string; off: string }
  value?: string
}

const BAR_WIDTH = 10
const LABEL_WIDTH = 28

const fit = (s: string, width: number): string => {
  const clean = plain(s).replace(/\s+/g, ' ').trim()
  return clean.length > width ? clean.slice(0, width - 1) + '…' : clean
}

/** The text of a line as it reads in plain text (the command's reply). */
export function lineText(l: Line): string {
  if (l.kind !== 'row') return l.text
  return [l.label, l.tag, l.bar ? l.bar.on + l.bar.off : '', l.value].filter(x => x !== undefined && x !== '').join('  ')
}

export function reportLines(t: Strings, r: Report, date: string): Line[] {
  const lines: Line[] = [
    { kind: 'title', text: t.reportTitle },
    { kind: 'sub', text: t.reportSubtitle(date, r.totalPct === null ? null : fmtPoints(r.totalPct), r.windows) },
  ]
  if (r.sessions.length === 0) return [...lines, { kind: 'blank', text: '' }, { kind: 'note', text: t.reportEmpty }]
  lines.push({ kind: 'sub', text: t.reportCounts(r.sessions.length, fmtTokens(r.totalTokens)) })
  const value = (pct: number | null, tokens: number): string => (pct === null ? fmtTokens(tokens) : `${fmtPoints(pct)}%`)
  const measure = (pct: number | null, tokens: number): number => (pct === null ? tokens : pct)

  lines.push({ kind: 'blank', text: '' }, { kind: 'head', text: t.reportSessions })
  const topSession = Math.max(0, ...r.sessions.map(s => measure(s.pct, s.tokens)))
  for (const s of r.sessions.slice(0, 8)) {
    lines.push({
      kind: 'row', text: '', label: fit(s.title || t.untitled, LABEL_WIDTH).padEnd(LABEL_WIDTH), tag: s.tier ? tierLabel(s.tier).padEnd(6) : ''.padEnd(6),
      bar: bar(measure(s.pct, s.tokens), topSession, BAR_WIDTH), value: value(s.pct, s.tokens),
    })
  }
  lines.push({ kind: 'blank', text: '' }, { kind: 'head', text: t.reportModels })
  const topModel = Math.max(0, ...r.models.map(m => measure(m.pct, m.tokens)))
  for (const m of r.models) {
    lines.push({ kind: 'row', text: '', label: fit(m.label, LABEL_WIDTH).padEnd(LABEL_WIDTH), bar: bar(measure(m.pct, m.tokens), topModel, BAR_WIDTH), value: value(m.pct, m.tokens) })
  }
  lines.push({ kind: 'blank', text: '' }, { kind: 'head', text: t.reportHours })
  const topHour = Math.max(0, ...r.hours.map(h => measure(h.pct, h.tokens)))
  for (const h of r.hours) {
    lines.push({ kind: 'row', text: '', label: `${h.hour}h`.padStart(3).padEnd(LABEL_WIDTH), bar: bar(measure(h.pct, h.tokens), topHour, BAR_WIDTH), value: value(h.pct, h.tokens) })
  }
  lines.push({ kind: 'blank', text: '' })
  const busy = r.hours.find(h => h.hour === r.busiestHour)
  if (busy) lines.push({ kind: 'tip', text: t.reportBusiest(busy.hour, value(busy.pct, busy.tokens)) })
  if (r.topTier && r.topTier !== 'other' && r.topShare > 0) lines.push({ kind: 'tip', text: t.reportTop(tierLabel(r.topTier), r.topShare) })
  lines.push({ kind: 'note', text: r.hasPct ? t.reportNote : t.reportTokensOnly })
  return lines
}
