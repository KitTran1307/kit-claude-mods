// Pure logic of kit-notify: no engine calls, so every function here is unit-tested on its own.
import type { AwayEvent, QueueItem } from '../types'

export const QUEUE_MAX = 20
export const TEXT_MAX = 4000
/** A person who edited the prompt box this recently is looking at the session: no sound, no notification. */
export const LOOKING_MS = 8_000
/** A permission prompt or question is waited on at once, so only a very recent keystroke hides it. */
export const NEEDS_LOOKING_MS = 3_000
/** The oldest unseen event must be at least this old before the welcome-back card shows (a notification just told them). */
export const SEEN_BY_NOTIFICATION_MS = 60_000
export const AWAY_EVENTS_MAX = 30

/** A number option as a whole number inside [min, max]; anything that is not a finite number is the default. */
export function clampOption(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** A boolean option: only an explicit false (or the string "false") turns it off, so a missing value keeps the default. */
export function flag(value: unknown, fallback = true): boolean {
  if (value === false || value === 'false') return false
  if (value === true || value === 'true') return true
  return fallback
}

/** Quiet hours as minutes after midnight; null means never quiet. */
export type Quiet = { from: number; to: number } | null

const CLOCK = /^(\d{1,2})(?::(\d{2}))?$/

function minutesOf(part: string): number | null {
  const m = CLOCK.exec(part.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null
  return (h % 24) * 60 + min
}

/** "22:00-07:00", "22-7", "22:00 to 07:00" or with an en dash; anything else is null (never quiet). */
export function parseQuietHours(value: unknown): Quiet {
  if (typeof value !== 'string') return null
  const parts = value.trim().split(/\s*(?:-|–|—|\bto\b)\s*/i)
  if (parts.length !== 2) return null
  const from = minutesOf(parts[0] ?? '')
  const to = minutesOf(parts[1] ?? '')
  if (from === null || to === null || from === to) return null
  return { from, to }
}

/** Whether a local time of day (minutes after midnight) falls in quiet hours; the range may cross midnight. */
export function isQuiet(quiet: Quiet, minuteOfDay: number): boolean {
  if (!quiet) return false
  return quiet.from < quiet.to
    ? minuteOfDay >= quiet.from && minuteOfDay < quiet.to
    : minuteOfDay >= quiet.from || minuteOfDay < quiet.to
}

export const minuteOfDay = (ms: number): number => {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** "HH:MM" in local time. */
export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Characters that draw nothing or move the cursor: control characters except newline and tab, and bidi/zero-width controls. */
// (U+200C and U+200D stay: they join letters in Persian, Indic scripts and emoji.)
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** A prompt as it is stored and sent: line ends made \n, hidden characters gone, trimmed. Never cut: see addToQueue. */
export function cleanPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim()
}

/** One line of text for a row, a notification or a card: markdown marks off the front, spaces collapsed, cut with an ellipsis. */
export function shortLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const first = value.replace(HIDDEN, ' ').split(/\r?\n/).map(l => l.replace(/^[\s#>*\-\u2022`]+/, '').replace(/[*`]+/g, '').replace(/\s+/g, ' ').trim()).find(l => l !== '') ?? ''
  const chars = Array.from(first)
  return chars.length <= max ? first : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

/** A whole prompt on one line (every line joined), for a numbered row. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

// --- the turn-done rule ---------------------------------------------------------------------------------------------

/** A finished main-loop turn rings only when it was answered (not stopped, not an error) and ran long enough. */
export function shouldAlertDone(e: { reason?: unknown; durationMs?: unknown }, afterSec: number): boolean {
  if (e.reason !== 'answer') return false
  const ms = typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) ? e.durationMs : 0
  return ms >= afterSec * 1000
}

/** Whether the person edited the prompt box a moment ago (so they are looking at the session). */
export function isLooking(now: number, lastTyped: number, windowMs = LOOKING_MS): boolean {
  return lastTyped > 0 && now - lastTyped < windowMs
}

/** A prompt that comes from the person at a keyboard (or their phone), not from a schedule, a task, a peer or a plugin. */
export function isPerson(origin: unknown): boolean {
  const kind = typeof origin === 'object' && origin !== null ? (origin as { kind?: unknown }).kind : undefined
  return kind === 'composer' || kind === 'bridge'
}

/** The kinds of Notification a person must act on; the others (idle, sign-in, our own) never ring. */
export function isNeedsYou(type: unknown): boolean {
  return type === 'permission_prompt' || type === 'elicitation_dialog'
}

// --- the queue ------------------------------------------------------------------------------------------------------

export type AddResult = { queue: QueueItem[]; added?: QueueItem; problem?: 'empty' | 'full' | 'long' }

export function addToQueue(queue: readonly QueueItem[], text: unknown, id: string): AddResult {
  const clean = cleanPrompt(text)
  if (clean === '') return { queue: [...queue], problem: 'empty' }
  if (Array.from(clean).length > TEXT_MAX) return { queue: [...queue], problem: 'long' } // never sent cut short
  if (queue.length >= QUEUE_MAX) return { queue: [...queue], problem: 'full' }
  const added = { id, text: clean }
  return { queue: [...queue, added], added }
}

/** Removes the n-th (1-based) item; `removed` is undefined when there is no such number. */
export function removeNth(queue: readonly QueueItem[], n: number): { queue: QueueItem[]; removed?: QueueItem } {
  if (!Number.isInteger(n) || n < 1 || n > queue.length) return { queue: [...queue] }
  return { queue: queue.filter((_, i) => i !== n - 1), removed: queue[n - 1] }
}

export const removeById = (queue: readonly QueueItem[], id: string): QueueItem[] => queue.filter(q => q.id !== id)

export type Drain = 'send' | 'empty' | 'paused' | 'running' | 'question' | 'typing'

/** Whether the next queued prompt may be sent now, or why not. Order matters: a permission prompt always wins. */
export function decideDrain(s: { queueLength: number; isPaused: boolean; isRunning: boolean; hasQuestion: boolean; draft: string }): Drain {
  if (s.queueLength === 0) return 'empty'
  if (s.isPaused) return 'paused'
  if (s.hasQuestion) return 'question'
  if (s.isRunning) return 'running'
  if (s.draft.trim() !== '') return 'typing'
  return 'send'
}

export type Verb = 'add' | 'list' | 'remove' | 'clear' | 'pause' | 'resume' | 'next' | 'help'

/** "/queue add fix it", "/queue fix it" (the shorthand for add), "/queue remove 2", "/queue" alone lists. */
export function parseQueueArgs(args: string): { verb: Verb; rest: string } {
  const text = args.trim()
  if (text === '') return { verb: 'list', rest: '' }
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text)!
  const word = (m[1] ?? '').toLowerCase()
  const rest = (m[2] ?? '').trim()
  const verbs: Record<string, Verb> = {
    add: 'add', list: 'list', ls: 'list', show: 'list', status: 'list',
    remove: 'remove', rm: 'remove', delete: 'remove', del: 'remove',
    clear: 'clear', pause: 'pause', hold: 'pause', resume: 'resume', continue: 'resume',
    next: 'next', now: 'next', send: 'next', help: 'help', '?': 'help',
  }
  const verb = verbs[word]
  // A word that is a verb only when nothing else is meant: "/queue clear" clears, "/queue add clear the logs" adds.
  if (verb === 'add') return { verb, rest }
  if (verb !== undefined && (rest === '' || verb === 'remove')) return { verb, rest }
  return { verb: 'add', rest: text }
}

// --- the welcome-back card ------------------------------------------------------------------------------------------

/** An event that happened; questions can be answered meanwhile and then stop counting. */
export function addEvent(events: readonly AwayEvent[], event: AwayEvent): AwayEvent[] {
  return [...events, event].slice(-AWAY_EVENTS_MAX)
}

export function resolveQuestions(events: readonly AwayEvent[]): AwayEvent[] {
  return events.filter(e => e.kind !== 'question')
}

/**
 * Whether the person's return deserves the card: away at least `awayMin` minutes (0 turns it off), something happened,
 * and the oldest of it is older than a minute (a notification just told them otherwise).
 */
export function shouldShowCard(s: { awayMin: number; lastActive: number; now: number; events: readonly AwayEvent[] }): boolean {
  if (s.awayMin <= 0 || s.events.length === 0) return false
  if (s.now - s.lastActive < s.awayMin * 60_000) return false
  const oldest = Math.min(...s.events.map(e => e.at))
  return s.now - oldest >= SEEN_BY_NOTIFICATION_MS
}

export type AwayCounts = { done: number; questions: number }
export const countEvents = (events: readonly AwayEvent[]): AwayCounts => ({
  done: events.filter(e => e.kind === 'done').length,
  questions: events.filter(e => e.kind === 'question').length,
})

/** Whole minutes of a span, at least 1. */
export const awayMinutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** The card is one line (summary and Dismiss) when there are fewer than 6 rows to give it. */
export const isCardCompact = (rows: number): boolean => !(rows >= 6)

/** Card rows to draw for the room there is: the heading and buttons always, then as many events as fit (questions first). */
export function cardEvents(events: readonly AwayEvent[], rows: number): { shown: AwayEvent[]; hidden: number } {
  const ordered = [...events.filter(e => e.kind === 'question'), ...events.filter(e => e.kind === 'done')]
  const room = Math.max(0, Math.min(6, rows - 5)) // border 2 + heading 1 + summary 1 + buttons 1
  if (ordered.length <= room) return { shown: ordered, hidden: 0 }
  const keep = Math.max(0, room - 1) // one row says how many more
  return { shown: ordered.slice(0, keep), hidden: ordered.length - keep }
}

// --- the queue band's size --------------------------------------------------------------------------------------------

export type QueuePlan = { mode: 'box'; shown: number; hidden: number; rows: number } | { mode: 'line'; rows: 1 }

/** Full numbered list when it fits; one line (count, next prompt, buttons) when there are fewer than 6 rows. */
export function planQueue(maxRows: number, length: number, buttonRows = 1): QueuePlan {
  const rows = Number.isFinite(maxRows) ? maxRows : 40
  const chrome = 3 + buttonRows // border 2, heading 1, the button rows
  if (length === 0 || rows < chrome + 2) return { mode: 'line', rows: 1 }
  const room = rows - chrome
  if (length <= room) return { mode: 'box', shown: length, hidden: 0, rows: chrome + length }
  const shown = Math.max(1, room - 1)
  return { mode: 'box', shown, hidden: length - shown, rows: chrome + shown + 1 }
}

// --- sound ------------------------------------------------------------------------------------------------------------

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

/** The platform from what the engine says (`session.info`), else the OS variable and `uname -sr` output; unknown when nothing says. */
export function detectPlatform(fromEngine: unknown, os: unknown, uname: unknown): Platform {
  if (fromEngine === 'macos' || fromEngine === 'windows' || fromEngine === 'wsl' || fromEngine === 'linux') return fromEngine
  if (os === 'Windows_NT') return 'windows'
  const text = typeof uname === 'string' ? uname.trim() : ''
  if (/^Darwin\b/i.test(text)) return 'macos'
  if (/^Linux\b/i.test(text)) return /microsoft|wsl/i.test(text) ? 'wsl' : 'linux'
  if (/^(MINGW|MSYS|CYGWIN)/i.test(text)) return 'windows'
  return 'unknown'
}

/** A path inside a PowerShell single-quoted string: every kind of single quote PowerShell knows is doubled. */
export const psQuote = (path: string): string => `'${path.replace(/['\u2018\u2019\u201a\u201b]/g, m => m + m)}'`

/**
 * Commands that play a wav file with what the system already has, in order of preference; the first that exits 0 wins.
 * macOS (and an unknown platform) has none: the engine's own `audio.play` plays there.
 */
export function playerCommands(platform: Platform, file: string): string[][] {
  if (platform === 'windows') {
    return [['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync()`]]
  }
  if (platform === 'linux' || platform === 'wsl') {
    return [['paplay', file], ['aplay', '-q', file], ['canberra-gtk-play', '-f', file]]
  }
  return []
}

/** The name of the sound file for an alert. */
export const soundFile = (kind: 'done' | 'needs'): string => (kind === 'done' ? 'done.wav' : 'needs-you.wav')
