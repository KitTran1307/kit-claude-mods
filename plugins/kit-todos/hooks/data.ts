import type { Snapshot, Todo } from '../types'

// Pure logic: no engine calls and no Node APIs, so everything here is unit-tested without an engine.

/** Where the list lives unless the `todosFile` option says otherwise. */
export const DEFAULT_TODOS_FILE = '~/.claude/kit-todos/todos.json'
/** A task due within this many days counts as "Due soon" unless the `soonDays` option says otherwise. */
export const DEFAULT_SOON_DAYS = 2
const MAX_SOON_DAYS = 30

export type Status = 'over' | 'soon' | 'plan' | 'none' | 'done'

/** Order of urgency, which is also the legend's order. */
export const STATUSES: { id: Status; label: string }[] = [
  { id: 'over', label: 'Overdue' },
  { id: 'soon', label: 'Due soon' },
  { id: 'plan', label: 'Scheduled' },
  { id: 'none', label: 'No date' },
  { id: 'done', label: 'Done' },
]

export const LABELS = { now: 'Do it now', draft: 'Draft', done: 'Done', open: 'Open list', hide: 'Hide today' } as const

/** Anthropic brand palette (anthropics/skills brand-guidelines) plus one red; lighter twins for a dark terminal. */
export const COLORS: Record<'light' | 'dark', Record<Status, string>> = {
  light: { over: '#c0453a', soon: '#d97757', plan: '#6a9bcc', none: '#b0aea5', done: '#788c5d' },
  dark: { over: '#e5675b', soon: '#d77757', plan: '#7fb0de', none: '#8f8c84', done: '#93a876' },
}

const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Longest task text drawn in the band (cards and rows) and in the pane; longer text is cut with an ellipsis. */
export const BAND_TEXT_MAX = 160
export const PANE_TEXT_MAX = 400

// --- options ---------------------------------------------------------------------------------------------------

/** The `soonDays` option: a whole number of days from 0 to 30; anything that is not a number counts as the default. */
export function soonDaysFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SOON_DAYS
  return Math.min(MAX_SOON_DAYS, Math.max(0, Math.floor(value)))
}

/**
 * The todos file's absolute path from the `todosFile` option and the home folder. `~` and `~/` stand for home, a
 * relative path is under home, `\` and `/` both work (the result uses `/`, which every platform accepts). Empty
 * means the path needs a home folder that is not known.
 */
export function resolveTodosPath(setting: unknown, home: string): string {
  const raw = typeof setting === 'string' && setting.trim() ? setting.trim() : DEFAULT_TODOS_FILE
  const path = raw.replace(/\\/g, '/')
  const base = home.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  if (path === '~') return base
  if (path.startsWith('~/')) return base ? `${base}/${path.slice(2).replace(/^\/+/, '')}` : ''
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return path
  return base ? `${base}/${path.replace(/^(\.\/)+/, '')}` : ''
}

// --- dates -----------------------------------------------------------------------------------------------------

/** The local calendar date (machine time) as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysUntil(due: string, now: number): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${localDay(now)}T00:00:00Z`)) / DAY_MS)
}

/** The due date when it is a real YYYY-MM-DD day; anything else (typo, "2026-11-9", "2026-02-30") counts as no date. */
export function validDue(todo: Pick<Todo, 'due'>): string | undefined {
  const due = todo.due
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined
  const t = Date.parse(`${due}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === due ? due : undefined
}

export function statusOf(todo: Todo, now: number, soonDays: number = DEFAULT_SOON_DAYS): Status {
  if (todo.done) return 'done'
  const due = validDue(todo)
  if (!due) return 'none'
  const days = daysUntil(due, now)
  return days < 0 ? 'over' : days <= soonDays ? 'soon' : 'plan'
}

/** "today, Mon Nov 9", "tomorrow, Tue Nov 10", "overdue 2 days (Sat Nov 7)", "Fri Nov 14". Fixed English names, no locale. */
export function dueText(todo: Pick<Todo, 'due'>, now: number): string {
  const due = validDue(todo)
  if (!due) return ''
  const days = daysUntil(due, now)
  const [, m, d] = due.split('-')
  const date = `${WEEKDAYS[new Date(`${due}T12:00:00Z`).getUTCDay()]} ${MONTHS[Number(m) - 1]} ${Number(d)}`
  if (days < 0) return `overdue ${-days} ${days === -1 ? 'day' : 'days'} (${date})`
  if (days === 0) return `today, ${date}`
  if (days === 1) return `tomorrow, ${date}`
  return date
}

// --- tasks -----------------------------------------------------------------------------------------------------

/** A task with no project shows in every project; otherwise the names match ignoring case and outer spaces. */
export function isMine(todo: Pick<Todo, 'project'>, project: string): boolean {
  const own = typeof todo.project === 'string' ? todo.project.trim().toLowerCase() : ''
  return !own || own === project.trim().toLowerCase()
}

/** Open todos of this project (or of no project), most urgent first, then by due date, then in file order. */
export function openTodos(snap: Snapshot | null, now: number, soonDays: number = DEFAULT_SOON_DAYS): Todo[] {
  if (!snap) return []
  const rank = (t: Todo) => STATUSES.findIndex(s => s.id === statusOf(t, now, soonDays))
  return snap.todos
    .filter(t => !t.done && isMine(t, snap.project))
    .sort((a, b) => rank(a) - rank(b) || cmp(validDue(a) ?? '9999', validDue(b) ?? '9999') || a.index - b.index)
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Todos of this project marked done in the last 24 hours, newest first. */
export function recentlyDone(snap: Snapshot | null, now: number): Todo[] {
  if (!snap) return []
  return snap.todos
    .filter(t => t.done && isMine(t, snap.project) && t.doneAt && now - Date.parse(t.doneAt) < DAY_MS)
    .sort((a, b) => Date.parse(b.doneAt ?? '') - Date.parse(a.doneAt ?? ''))
}

/** "3 tasks, 1 overdue": the most urgent count only. */
export function countText(todos: Todo[], now: number, soonDays: number = DEFAULT_SOON_DAYS): string {
  const over = todos.filter(t => statusOf(t, now, soonDays) === 'over').length
  const soon = todos.filter(t => statusOf(t, now, soonDays) === 'soon').length
  const extra = over ? `, ${over} overdue` : soon ? `, ${soon} due soon` : ''
  return `${todos.length} ${todos.length === 1 ? 'task' : 'tasks'}${extra}`
}

/** One line of at most `max` characters: whitespace runs become one space, a longer text ends in an ellipsis. */
export function shortText(text: string, max: number): string {
  const flat = text.slice(0, max * 4).replace(/\s+/g, ' ').trim()
  if (flat.length <= max && text.length <= max * 4) return flat
  const cut = flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()
  return `${cut}…`
}

/** Claude Code's project folder name for a working directory: every character but a letter or digit becomes "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// --- the todos file --------------------------------------------------------------------------------------------

/**
 * The todos file as written, for a change: a missing file is an empty list, anything unreadable throws so a
 * write never replaces a list it could not read. Entries are kept as they are, even ones the band skips.
 */
export function parseTodosForWrite(text: string | null): unknown[] {
  const clean = text === null ? '' : text.replace(/^\uFEFF/, '')
  if (clean.trim() === '') return []
  let list: unknown
  try {
    list = JSON.parse(clean)
  } catch {
    throw new Error('the file is not valid JSON')
  }
  if (!Array.isArray(list)) throw new Error('the file is not a JSON list (an array of tasks)')
  return list
}

/**
 * Entries the plugin can show: an object with a non-empty string id and string text. Each carries its position in
 * the file. `done` counts only as the boolean true.
 */
export function usableTodos(list: unknown[]): Todo[] {
  const out: Todo[] = []
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const t = entry as Record<string, unknown>
    if (typeof t.id !== 'string' || !t.id.trim() || typeof t.text !== 'string' || !t.text.trim()) return
    out.push({
      id: t.id,
      text: t.text,
      note: typeof t.note === 'string' ? t.note : undefined,
      project: typeof t.project === 'string' ? t.project : undefined,
      due: typeof t.due === 'string' ? t.due : undefined,
      done: t.done === true,
      doneAt: typeof t.doneAt === 'string' ? t.doneAt : undefined,
      index,
    })
  })
  return out
}

/**
 * The list with the entry at `index` marked done. When ids repeat, the one the person picked is the one marked.
 * If the file changed since it was shown and `index` no longer holds that open task, the entry is found by its id
 * only when exactly one open entry has it; otherwise null and nothing should be written.
 */
export function markDoneAt(list: unknown[], index: number, id: string, doneAt: string): unknown[] | null {
  const isOpenWithId = (t: unknown) => !!t && typeof t === 'object' && (t as Todo).id === id && (t as Todo).done !== true
  let at = index
  if (!isOpenWithId(list[index])) {
    const matches = list.flatMap((t, i) => (isOpenWithId(t) ? [i] : []))
    if (matches.length !== 1) return null
    at = matches[0] ?? -1
  }
  return list.map((t, i) => (i === at ? { ...(t as object), done: true, doneAt } : t))
}

/** An id no entry of the list has, built from the time. */
export function newId(list: unknown[], now: number): string {
  const taken = new Set(list.map(t => (t && typeof t === 'object' ? (t as { id?: unknown }).id : undefined)))
  const base = `t${now.toString(36)}`
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Ids the plugin puts in a prompt as they are: letters, digits, `.`, `_`, `-`, 64 at most (newId makes `t…` ids). */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/
export const isSafeId = (id: unknown): id is string => typeof id === 'string' && SAFE_ID.test(id)

/** Characters a card does not show plainly: control characters (not tab or line breaks), zero-width and bidi marks, tag characters. */
const HIDDEN_CHARS = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}\u{E0000}-\u{E007F}]/u
/** Line breaks: a card or a list row shows the first line, so a second one could go unseen. */
const LINE_BREAKS = /[\r\n\u{2028}\u{2029}]/u

/**
 * Whether "Do it now" should draft instead of sending: the prompt would carry text the person did not see on the
 * card (a note, task text cut for the band or spread over several lines, an id outside SAFE_ID, or characters a
 * card does not show), so they read the whole prompt in the prompt box before it goes to Claude. `shownCells`: the
 * cells the text had where the button was pressed (a list row cuts it to its width); a wider text was cut there.
 */
export function needsReview(todo: Todo, shownCells = Infinity): boolean {
  const text = String(todo.text ?? '')
  return (typeof todo.note === 'string' && todo.note.trim() !== '')
    || textCells(text) > shownCells
    || [...text].length > BAND_TEXT_MAX
    || LINE_BREAKS.test(text)
    || !isSafeId(todo.id)
    || HIDDEN_CHARS.test(text)
}

/**
 * Terminal cells a text takes, counted on the safe side: East Asian wide characters and emoji take two, everything
 * else one (a combining mark counts one too, so the estimate is never short).
 */
export function textCells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const wide = (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3)
      || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60)
      || (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x20000 && c <= 0x3FFFD)
      || (c >= 0x2600 && c <= 0x27BF)
    n += wide ? 2 : 1
  }
  return n
}

/**
 * Cells left for the task text in one list row of a band `cols` wide (`bodyColumns`): the band's border and
 * padding, the dot, the due date and the two buttons with the gaps between them take the rest. A text wider than this
 * is cut on screen, so "Do it now" drafts it for reading instead of sending.
 */
export function listRowTextCells(cols: number, dueTextCells: number, withButtons: boolean): number {
  const inner = cols - 4
  return Math.max(0, inner - 2 - (dueTextCells > 0 ? dueTextCells + 1 : 0) - (withButtons ? LIST_BUTTONS : 0))
}

/** What "Do it now" sends and "Draft" drafts. `file` is the todos file in use; an id outside SAFE_ID is quoted as JSON. */
export function taskPrompt(todo: Todo, file: string): string {
  return [
    `Work on this task from my to-do list (id ${isSafeId(todo.id) ? todo.id : JSON.stringify(todo.id)}): ${todo.text}`,
    typeof todo.note === 'string' && todo.note ? `Note: ${todo.note}` : '',
    `When it is finished and verified, mark it done in ${file}: set "done": true and "doneAt" to the current time in UTC (ISO 8601) on the entry with this id.`,
    'If anything needs a decision, ask me before you decide on my behalf.',
  ].filter(Boolean).join('\n')
}

// --- memories --------------------------------------------------------------------------------------------------

/** `- [Title](file.md) - hook` lines of a MEMORY.md index (the dash may be a hyphen, en dash or em dash). */
export function parseIndex(text: string): { title: string; hook: string; file: string }[] {
  const out: { title: string; hook: string; file: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]?\s*(.*)$/.exec(line.trim())
    if (m) out.push({ title: m[1] ?? '', file: m[2] ?? '', hook: m[3] ?? '' })
  }
  return out
}

const looksWindows = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** The folders without repeats: Windows-style paths compare ignoring case and slash direction. First one wins. */
export function dedupeDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    const clean = dir.trim().replace(/[\\/]+$/, '')
    if (!clean) continue
    const norm = clean.replace(/\\/g, '/')
    const key = looksWindows(clean) ? norm.toLowerCase() : norm
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/**
 * Folders that may hold a project's memories. By default only the current profile's: the config folder the session
 * was started with (`CLAUDE_CONFIG_DIR`), else `~/.claude`. With `allProfiles` (the `memoriesAllProfiles` option)
 * also `~/.claude` and every `~/.claude-*` folder (one per account profile), so another account's memories can show.
 */
export function configDirCandidates(configDir: string | undefined, home: string, homeNames: readonly string[], allProfiles = false): string[] {
  const base = home.replace(/[\\/]+$/, '')
  if (!allProfiles) return dedupeDirs(configDir ? [configDir] : base ? [`${base}/.claude`] : [])
  const profiles = homeNames.filter(n => n.startsWith('.claude-') && n.length > '.claude-'.length).sort(cmp)
  return dedupeDirs([
    ...(configDir ? [configDir] : []),
    ...(base ? [`${base}/.claude`, ...profiles.map(n => `${base}/${n}`)] : []),
  ])
}

// --- band layout -----------------------------------------------------------------------------------------------

export type BandPlan =
  | { mode: 'cards'; perRow: number; cardWidth: number; showLegend: boolean; showMemory: boolean }
  | { mode: 'list'; shown: number; rowButtons: boolean; showMemory: boolean }
  | { mode: 'line' }

const buttonsWidth = (...labels: string[]) => labels.reduce((n, l) => n + l.length + 4, labels.length - 1) // "[ label ]" and a space between
const CARD_MIN = 26 // narrowest card that still reads (cells, border included)
const CARD_BUTTONS = buttonsWidth(LABELS.now, LABELS.draft)
const LIST_BUTTONS = CARD_BUTTONS + 1 // the same two buttons at the end of a list row, one cell of gap before them
const LEGEND = STATUSES.map(s => `● ${s.label}`).join('  ').length

// Word wrap wastes cells at line ends: plan for 85% of the width so an estimate never comes out short.
// Wide characters count two cells, so a card of CJK text or emoji is not planned shorter than it draws.
const linesFor = (text: string, width: number) => Math.max(1, Math.ceil(textCells(text) / Math.max(1, Math.floor(width * 0.85))))

/** Rows one card takes at a given outer width. */
/** Rows a band plan takes (what is left goes to the bands of other plugins beneath it). */
export function planRows(plan: BandPlan, todos: Todo[]): number {
  if (plan.mode === 'line') return 1
  if (plan.mode === 'list') return 4 + plan.shown + (todos.length > plan.shown ? 1 : 0) + (plan.showMemory ? 1 : 0)
  const tallest = Math.max(...todos.slice(0, plan.perRow).map(t => cardRows(t, plan.cardWidth)))
  return 2 + 1 + tallest + (todos.length > plan.perRow ? 1 : 0) + 1 + (plan.showLegend ? 1 : 0) + (plan.showMemory ? 1 : 0)
}

export function cardRows(todo: Todo, width: number): number {
  const inner = width - 4 // border + paddingX 1 on each side
  return 2 + 1 + linesFor(shortText(todo.text, BAND_TEXT_MAX), inner) + (validDue(todo) ? 1 : 0) + linesFor('x'.repeat(CARD_BUTTONS), inner)
}

/**
 * The richest band layout whose height is at most `rows` (the engine's `maxRows`, so it never scrolls)
 * in `cols` cells (`bodyColumns`). Falls back cards -> one row per task -> a single line.
 */
export function planBand(rows: number, cols: number, todos: Todo[]): BandPlan {
  const inner = cols - 4 // the band's own border + padding
  const perRow = Math.min(3, todos.length, Math.floor((inner + 1) / (CARD_MIN + 1)))
  if (perRow >= 1) {
    const cardWidth = Math.floor((inner - (perRow - 1)) / perRow)
    const tallest = Math.max(...todos.slice(0, perRow).map(t => cardRows(t, cardWidth)))
    const more = todos.length > perRow ? 1 : 0
    const base = 2 + 1 + tallest + more + 1 // border, header, cards, "N more", actions
    const legendRows = linesFor('x'.repeat(LEGEND), inner)
    if (base + legendRows + 1 <= rows) return { mode: 'cards', perRow, cardWidth, showLegend: true, showMemory: true }
    if (base <= rows) return { mode: 'cards', perRow, cardWidth, showLegend: false, showMemory: false }
  }
  const room = rows - 4 // border, header, actions
  if (room >= 1) {
    // Reserve one row for "N more" when not every task fits.
    const shown = todos.length <= room ? todos.length : Math.max(1, room - 1)
    const showMemory = shown === todos.length && room > shown
    return { mode: 'list', shown, rowButtons: inner >= 40 + LIST_BUTTONS, showMemory }
  }
  return { mode: 'line' }
}
