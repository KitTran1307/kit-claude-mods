// Pure parts of kit-cloud: map cloud-pilot hub rows to band rows, filter by scope, summarise, parse commands. No `$` here.
import type { CloudRow, CloudState } from '../types'
import { STRINGS } from './i18n'
import type { ChangeKind, Strings } from './i18n'

const EN = STRINGS.en

/** One row of <hub dir>/state.json, written by hub/hub.mjs. */
export type HubRow = {
  id: string
  kind: 'branch' | 'repo'
  repo: string
  branch?: string
  url?: string
  title?: string
  active?: boolean
  account?: string
  repoRoot?: string
  createdMs?: number
  state?: string
  detail?: string
  lastActivityMs?: number
  prUrl?: string
  /** Found by watching the repo: whose account started it is unknown. */
  discovered?: boolean
  /** The local session that gets this track's events. */
  ownerSessionId?: string
}

const STATE_MAP: Record<string, CloudState> = {
  working: 'working', pr: 'pr', question: 'question', silent: 'silent', done: 'done', closed: 'closed',
  gone: 'ended', abandoned: 'ended', parked: 'ended', error: 'ended', repo: 'working', untracked: 'untracked',
}

export function fromHub(r: HubRow): CloudRow {
  return {
    id: String(r.id ?? ''),
    account: r.account || '?',
    repo: String(r.repo ?? '?').split('/').pop() || '?',
    title: String(r.title || r.branch || ''),
    url: safeUrl(r.url) || safeUrl(r.prUrl),
    sessionId: String(r.id ?? ''),
    startedEpoch: Math.floor((Number(r.createdMs) || 0) / 1000),
    state: STATE_MAP[r.state ?? ''] ?? 'untracked',
    detail: String(r.detail ?? ''),
  }
}

/** Only http(s) links are ever drawn as links: the hub file is local data, but a link is something a person clicks. */
export function safeUrl(u: unknown): string {
  return typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u) ? u : ''
}

function mins(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60))
}

/** "5m" since a start, or "?" when the hub gave no start time. */
export function agoText(startedEpoch: number, nowEpoch: number): string {
  if (!(startedEpoch > 0)) return '?'
  const m = mins(nowEpoch - startedEpoch)
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d`
}

/** The hub polls every 2-5 minutes while it has live sessions: older than this, its rows are stale. */
export const HUB_STALE_MS = 15 * 60_000

/** A note when the hub's last poll is too old to trust while live rows are still listed. */
export function staleNote(polledMs: number | undefined, nowMs: number, hasLive: boolean, t: Strings = EN): string {
  if (!hasLive) return ''
  if (!polledMs) return t.pilotNotPolled
  const age = nowMs - polledMs
  return age > HUB_STALE_MS ? t.pilotStopped(Math.round(age / 60_000)) : ''
}

/**
 * A note when this session owns live tracks but nothing of it waits for their events (its `cloud-pilot wait` ended or
 * was killed, e.g. for low memory). `waiting` undefined: a hub too old to say, so no note. Events stay queued for it.
 */
export function waiterNote(rows: HubRow[], sessionId: string, waiting: string[] | undefined, queued: Record<string, number> | undefined, t: Strings = EN): string {
  if (!sessionId || !Array.isArray(waiting) || waiting.includes(sessionId)) return ''
  const owned = rows.filter(r => r.active && r.ownerSessionId === sessionId).length
  if (!owned) return ''
  return t.noWaiter(owned, Number(queued?.[sessionId]) || 0)
}

export function summary(rows: CloudRow[], t: Strings = EN): Array<{ text: string; color: string }> {
  const n = (s: CloudState) => rows.filter(r => r.state === s).length
  const failing = rows.filter(r => r.state === 'pr' && /CI failed/.test(r.detail)).length
  const parts: Array<{ text: string; color: string }> = []
  if (n('question')) parts.push({ text: t.sumAsking(n('question')), color: 'warning' })
  if (n('working')) parts.push({ text: t.sumWorking(n('working')), color: 'success' })
  if (n('pr')) parts.push({ text: t.sumPr(n('pr'), failing), color: failing ? 'error' : 'warning' })
  if (n('silent')) parts.push({ text: t.sumSilent(n('silent')), color: 'error' })
  const ended = n('done') + n('closed') + n('ended')
  if (ended) parts.push({ text: t.sumFinished(ended), color: 'inactive' })
  if (n('untracked')) parts.push({ text: t.sumUntracked(n('untracked')), color: 'inactive' })
  return parts
}

export const MARK: Record<CloudState, { mark: string; color: string; word: string }> = {
  working: { mark: '●', color: 'success', word: EN.word.working },
  pr: { mark: '◐', color: 'warning', word: EN.word.pr },
  question: { mark: '?', color: 'warning', word: EN.word.question },
  silent: { mark: '⚠', color: 'error', word: EN.word.silent },
  done: { mark: '✓', color: 'inactive', word: EN.word.done },
  closed: { mark: '✕', color: 'inactive', word: EN.word.closed },
  ended: { mark: '✕', color: 'inactive', word: EN.word.ended },
  untracked: { mark: '○', color: 'inactive', word: EN.word.untracked },
}

/** The word for a state in the chosen language (MARK.word is the English one). */
export const stateWord = (state: CloudState, t: Strings = EN): string => t.word[state]

/** Cut to a width by characters, with an ellipsis; pads to the width. */
export function fit(s: string, w: number): string {
  const chars = [...String(s).replace(/[\r\n\t]+/g, ' ')]
  return (chars.length > w ? chars.slice(0, Math.max(0, w - 1)).join('') + '…' : chars.join('')).padEnd(w)
}

export function table(rows: CloudRow[], nowEpoch: number, where = '', t: Strings = EN): string {
  const scopeText = where ? ` (${where})` : ''
  if (rows.length === 0) return t.tableNone(scopeText)
  // The account column grows to fit its heading and the task column gives the room back, so the table keeps its width.
  const accountW = Math.max(8, [...t.colAccount].length)
  const taskW = 26 - (accountW - 8)
  const lines = [t.tableHead(rows.length, scopeText), '',
    `  ${fit(t.colId, 10)} ${fit(t.colAccount, accountW)} ${fit(t.colRepo, 14)} ${fit(t.colTask, taskW)} ${fit(t.colStatus, 24)} ${t.colAge.padStart(5)}`]
  for (const r of rows) {
    const m = MARK[r.state]
    lines.push(`${m.mark} ${fit(r.id, 10)} ${fit(r.account, accountW)} ${fit(r.repo, 14)} ${fit(r.title, taskW)} ${fit(r.detail, 24)} ${agoText(r.startedEpoch, nowEpoch).padStart(5)}`)
    if (r.url) lines.push(`  ${r.url}`)
  }
  lines.push('', t.legend)
  return lines.join('\n')
}

/** slug: the repo's GitHub owner/name when known; it identifies the repo across clones and worktrees. */
export type Scope = { account: string; repoRoot: string; repo: string; slug?: string }
export type ScopeMode = 'account+repo' | 'repo' | 'all'

/** Same rule as the hub: ~/.claude -> "default", ~/.claude-work -> "work". */
export function accountName(configDir: string): string {
  const base = configDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return base.startsWith('.claude-') ? base.slice('.claude-'.length) : 'default'
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Whether a hub row belongs in this session's view. */
export function inScope(row: { account?: string; repoRoot?: string; repo?: string; discovered?: boolean }, scope: Scope, mode: ScopeMode = 'account+repo'): boolean {
  if (mode === 'all') return true
  // A session found by watching has no known account: it shows for every account in its repo.
  if (mode === 'account+repo' && !row.discovered && (row.account ?? '') !== scope.account) return false
  if (scope.slug && (row.repo ?? '').includes('/')) return (row.repo ?? '').toLowerCase() === scope.slug.toLowerCase()
  if (row.repoRoot && scope.repoRoot) return norm(row.repoRoot) === norm(scope.repoRoot)
  const name = (row.repo ?? '').split('/').pop() ?? ''
  return name !== '' && name.toLowerCase() === scope.repo.toLowerCase()
}

/** "owner/name" from a GitHub remote URL (https, ssh, git@), or '' for anything else. */
export function ghSlug(remote: string): string {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(remote).trim())
  return m ? `${m[1]}/${m[2]}` : ''
}

export type CloudCommand =
  | { verb: 'list'; all: boolean }
  | { verb: 'track'; url: string; branch: string }
  | { verb: 'untrack'; id: string }
  | { verb: 'watch' }
  | { verb: 'unwatch' }
  | { verb: 'doctor' }
  | { verb: 'help'; error?: string }

/** The command list in English; `Strings.usage` holds each language's. */
export const USAGE = EN.usage

export function parseCommand(args: string, t: Strings = EN): CloudCommand {
  const [first = '', ...rest] = String(args ?? '').trim().split(/\s+/).filter(Boolean)
  const verb = first.toLowerCase()
  if (!verb) return { verb: 'list', all: false }
  if (verb === 'all') return { verb: 'list', all: true }
  if (verb === 'watch') return { verb: 'watch' }
  if (verb === 'unwatch') return { verb: 'unwatch' }
  if (verb === 'doctor') return { verb: 'doctor' }
  if (verb === 'untrack') {
    const id = rest[0] ?? ''
    return /^[0-9a-f]{6,40}$/i.test(id) ? { verb: 'untrack', id } : { verb: 'help', error: t.errUntrackId }
  }
  if (verb === 'track') {
    const url = rest.find(a => /^https:\/\//i.test(a)) ?? ''
    const branch = rest.find(a => /^claude\//.test(a)) ?? ''
    if (!url && !branch) return { verb: 'help', error: t.errTrackArgs }
    if (branch && (!/^claude\/[\w./-]+$/.test(branch) || branch.includes('..'))) return { verb: 'help', error: t.errTrackBranch(branch) }
    return { verb: 'track', url, branch }
  }
  return { verb: 'help', error: verb === 'help' ? undefined : t.errUnknown(first) }
}

/** What one session looked like at the last refresh: enough to tell what changed at the next. */
export type Snapshot = { state: CloudState; detail: string }

export function snapshot(rows: CloudRow[]): Map<string, Snapshot> {
  return new Map(rows.map(r => [r.id, { state: r.state, detail: r.detail }]))
}

const FINISHED: ReadonlySet<CloudState> = new Set<CloudState>(['done', 'closed', 'ended'])
const CI_FAILED = /CI failed/

/**
 * What changed since `prev` that a person should hear about, at most one entry per session: it entered `question`
 * (asking), its PR's CI newly failed (ci-failed), it entered `pr` (pr), it finished (finished) or went `silent`.
 * `prev` null is the first look after load: nothing is announced, so a reload never replays old events. A session
 * seen for the first time is announced only when it is already asking.
 */
export function changes(prev: Map<string, Snapshot> | null, rows: CloudRow[]): Array<{ row: CloudRow; kind: ChangeKind }> {
  if (!prev) return []
  const out: Array<{ row: CloudRow; kind: ChangeKind }> = []
  for (const row of rows) {
    const before = prev.get(row.id)
    const kind = before ? kindOfChange(before, row) : row.state === 'question' ? 'asking' : null
    if (kind) out.push({ row, kind })
  }
  return out
}

function kindOfChange(before: Snapshot, row: CloudRow): ChangeKind | null {
  const failing = row.state === 'pr' && CI_FAILED.test(row.detail)
  if (row.state === before.state) return failing && !CI_FAILED.test(before.detail) ? 'ci-failed' : null
  if (row.state === 'question') return 'asking'
  if (row.state === 'pr') return failing ? 'ci-failed' : 'pr'
  if (row.state === 'silent') return 'silent'
  if (FINISHED.has(row.state) && !FINISHED.has(before.state)) return 'finished'
  return null
}
