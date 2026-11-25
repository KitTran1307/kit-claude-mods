// The session transcript (<config dir>/projects/<project>/<session id>.jsonl) and the login record: where they are,
// and what to read from them. The module reads files itself through $.fs (a read is capped at 4 MiB by the engine);
// a transcript above the limit is read from its end by scripts/session-info.mjs when Node is there.
import type { EngineInterface, FsEntry, FsStat } from 'claude-code'

import { joinPath, parseLoginEmail } from './account'
import { CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, fitText } from './format'
import type { CacheStamp } from './format'
import type { HookFailure } from './i18n'

export const MIB = 1024 * 1024
/** The most `$.fs.read` returns in one call. */
export const FS_READ_CAP = 4 * MIB
const SCAN_LIMIT = 2000
const HELPER_TIMEOUT_MS = 10_000

export const isSessionId = (id: string): boolean => /^[0-9a-f-]{8,}$/i.test(id)

// How Claude Code names a project's folder: every character that is not a letter or digit becomes a dash.
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// ---------- pure reading of the transcript text ----------
function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The text of `field` in the last entry of `type`. Matching the unescaped `"type":"..."` key means text quoted
// inside a message (escaped `\"type\":\"...\"`) never counts as an entry. An entry that does not parse (a line cut
// short) is skipped for the one before it.
function lastEntryField(text: string, type: string, field: string): string {
  const key = `"type":"${type}"`
  let at = text.lastIndexOf(key)
  for (let tries = 0; at >= 0 && tries < 50; tries += 1) {
    const start = text.lastIndexOf('\n', at) + 1
    const end = text.indexOf('\n', at)
    const value = parseObject(text.slice(start, end < 0 ? undefined : end))?.[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (start === 0) break
    at = text.lastIndexOf(key, start - 1)
  }
  return ''
}

/** The latest /rename (custom-title), else the latest automatic title (ai-title); '' when there is none. */
export function lastTitle(text: string): string {
  return lastEntryField(text, 'custom-title', 'customTitle') || lastEntryField(text, 'ai-title', 'aiTitle')
}

// The cache life a reply's own usage shows: 1 h when it wrote 1-hour tokens, 5 min when it wrote only 5-minute ones;
// null when it wrote nothing (a reply that only read the cache, or touched it not at all).
function writerTtl(message: Record<string, unknown> | null): number | null {
  const created = record(record(message?.usage)?.cache_creation)
  const hour = created?.ephemeral_1h_input_tokens
  const five = created?.ephemeral_5m_input_tokens
  if (typeof hour === 'number' && hour > 0) return CACHE_TTL_1H_MS
  if (typeof five === 'number' && five > 0) return CACHE_TTL_5M_MS
  return null
}

/**
 * The prompt-cache stamp of the last main-thread reply: its `timestamp` and the life of the cache. The life is the
 * one the most recent reply that WROTE cache set (1 hour when it wrote 1-hour tokens, 5 minutes when only 5-minute
 * ones): a reply that only read the cache keeps it. With no writer to be found (no cache activity, or none within
 * the entries looked at) the life is 5 minutes. Only the unescaped `"type":"assistant"` key counts; a line that does
 * not parse, a subagent's (`isSidechain`) and an error stand-in (`<synthetic>` model) are skipped. The last real
 * reply decides the time: with a field missing from it the answer is null (unknown), never an earlier reply's.
 */
export function lastCacheStamp(text: string): CacheStamp | null {
  const key = '"type":"assistant"'
  let at = text.lastIndexOf(key)
  let stampAt: number | null = null
  for (let tries = 0; at >= 0 && tries < 50; tries += 1) {
    const start = text.lastIndexOf('\n', at) + 1
    const end = text.indexOf('\n', at)
    const entry = parseObject(text.slice(start, end < 0 ? undefined : end))
    if (entry && entry.type === 'assistant' && entry.isSidechain !== true) {
      const message = record(entry.message)
      if (message?.model === '<synthetic>') {
        // not a reply that touched the cache
      } else if (stampAt === null) {
        const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
        const created = record(record(message?.usage)?.cache_creation)?.ephemeral_1h_input_tokens
        if (!Number.isFinite(stamp) || typeof created !== 'number' || !Number.isFinite(created)) return null
        const ttlMs = writerTtl(message)
        if (ttlMs !== null) return { at: stamp, ttlMs }
        stampAt = stamp
      } else {
        const ttlMs = writerTtl(message)
        if (ttlMs !== null) return { at: stampAt, ttlMs }
      }
    }
    if (start === 0) break
    at = text.lastIndexOf(key, start - 1)
  }
  return stampAt === null ? null : { at: stampAt, ttlMs: CACHE_TTL_5M_MS }
}

// The session context's userEmail key (unescaped, so a real entry, not quoted text):
// "userEmail":"The user's email address is <email>. ..."
const EMAIL_KEY = `"userEmail":"The user's email address is `

/** The account the session itself runs as, from its own context; '' when the transcript has none. */
export function transcriptEmail(text: string): string {
  const at = text.lastIndexOf(EMAIL_KEY)
  if (at < 0) return ''
  const from = at + EMAIL_KEY.length
  return /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text.slice(from, from + 320))?.[0] ?? ''
}

// ---------- hook failures ----------
/** How many hooks failed in the text, and the latest failure. */
export type HookErrors = { count: number; last: HookFailure | null }
export const NO_HOOK_ERRORS: HookErrors = { count: 0, last: null }

const HOOK_ERROR_TYPES = ['hook_non_blocking_error', 'hook_blocking_error']
const HOOK_ROOM = 40
const COMMAND_ROOM = 60
const REASON_ROOM = 80

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null)

// The hook, its command and why it failed, read defensively: the field names differ between versions and kinds.
// A stack trace starts with where it was thrown; the line naming the error is the one worth showing.
const CAUSE = /\b(?:\w*Error|error|No such file|not found|Cannot|ENOENT|EACCES|denied|does not exist)\b/i

function hookFailure(att: Record<string, unknown>): HookFailure {
  const nested = record(att.blockingError)
  const raw = text(att.stderr) || text(att.content) || text(nested?.blockingError) || text(att.blockingError) || text(att.output) || text(att.message)
  const lines = raw.replace(/^Failed with non-blocking status code:\s*/i, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const firstLine = lines.find(l => CAUSE.test(l)) ?? lines[0] ?? ''
  return {
    hook: fitText(text(att.hookName) || text(att.hookEvent) || text(att.hook_event_name), HOOK_ROOM),
    command: fitText(text(att.command) || text(nested?.command), COMMAND_ROOM),
    reason: fitText(firstLine.replace(/^Failed with non-blocking status code:\s*/i, ''), REASON_ROOM),
  }
}

/**
 * The hook failures this session's transcript records: `attachment` entries of type hook_non_blocking_error or
 * hook_blocking_error. Like lastEntryField, only the unescaped `"type":"..."` key counts, so text quoted inside a
 * message never does; a line that does not parse (cut short) or is not such an entry is skipped.
 */
export function hookErrors(transcript: string): HookErrors {
  const seen = new Set<number>()
  let count = 0
  let lastAt = -1
  let last: HookFailure | null = null
  for (const type of HOOK_ERROR_TYPES) {
    const key = `"type":"${type}"`
    // After a hit the search goes on from the end of its line: a line packed with keys is looked at once (linear).
    let next = 0
    for (let at = transcript.indexOf(key); at >= 0; at = transcript.indexOf(key, next)) {
      const start = transcript.lastIndexOf('\n', at) + 1
      const end = transcript.indexOf('\n', at)
      next = end < 0 ? transcript.length : end + 1
      if (seen.has(start)) continue
      seen.add(start)
      const entry = parseObject(transcript.slice(start, end < 0 ? undefined : end))
      const att = record(entry?.attachment) ?? entry
      if (!att || !HOOK_ERROR_TYPES.includes(att.type as string)) continue
      count += 1
      if (start > lastAt) { lastAt = start; last = hookFailure(att) }
    }
  }
  return { count, last }
}

// ---------- files, through $.fs ----------
async function statFile($: EngineInterface, path: string): Promise<FsStat | null> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' ? stat : null
  } catch {
    return null
  }
}

/** The transcript of a session: its project's folder first, then every folder under projects/. '' when not found. */
export async function findTranscript($: EngineInterface, configDir: string, id: string, cwd: string): Promise<string> {
  if (!configDir || !isSessionId(id)) return ''
  const projects = joinPath(configDir, 'projects')
  const direct = joinPath(projects, projectSlug(cwd), `${id}.jsonl`)
  if (await statFile($, direct)) return direct
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(projects)
  } catch {
    return ''
  }
  for (const entry of entries.slice(0, SCAN_LIMIT)) {
    if (entry.kind === 'file') continue
    const file = joinPath(projects, entry.name, `${id}.jsonl`)
    if (await statFile($, file)) return file
  }
  return ''
}

// ---------- the Node helper, when Node is there ----------
export type HelperAnswer = {
  title: string; transcriptEmail: string; loginEmail: string; hookErrors: HookErrors | null
  /** The helper's cacheStamp: null when it has none or an older helper left it out. */
  cache: CacheStamp | null
}
/** Set once Node could not be started: it is not tried again until the module reloads. */
export type NodeState = { missing: boolean }

// The helper's hookErrors field; null when an older helper left it out or it is not in the expected shape.
function helperHookErrors(v: unknown): HookErrors | null {
  const o = record(v)
  if (!o || typeof o.count !== 'number' || !Number.isFinite(o.count)) return null
  const last = record(o.last)
  return {
    count: Math.max(0, Math.round(o.count)),
    last: last ? { hook: fitText(text(last.hook), HOOK_ROOM), command: fitText(text(last.command), COMMAND_ROOM), reason: fitText(text(last.reason), REASON_ROOM) } : null,
  }
}

export async function runHelper($: EngineInterface, args: readonly string[], node: NodeState): Promise<HelperAnswer | null> {
  if (node.missing) return null
  let stdout = ''
  try {
    const run = await $.process.run(['node', joinPath($.plugin.root, 'scripts', 'session-info.mjs'), ...args], {
      timeoutMs: HELPER_TIMEOUT_MS,
    })
    if (run.exitCode !== 0) {
      $.ui.log(`helper exited ${run.exitCode}: ${run.stderr.slice(0, 200)}`, { to: 'debug' })
      return null
    }
    stdout = run.stdout
  } catch (err) {
    node.missing = true
    $.ui.log(`Node helper did not run: ${String(err)}`, { to: 'debug' })
    return null
  }
  const v = parseObject(stdout)
  if (!v) return null
  const str = (k: string): string => (typeof v[k] === 'string' ? (v[k] as string) : '')
  const c = record(v.cacheStamp)
  const cache = c && typeof c.at === 'number' && Number.isFinite(c.at) && typeof c.ttlMs === 'number' && c.ttlMs > 0 ? { at: c.at, ttlMs: c.ttlMs } : null
  return { title: str('title'), transcriptEmail: str('transcriptEmail'), loginEmail: str('loginEmail'), hookErrors: helperHookErrors(v.hookErrors), cache }
}

/** oauthAccount.emailAddress of the login record; '' when the file is missing, not JSON or holds none. */
export async function readLoginEmail($: EngineInterface, loginFile: string, node: NodeState): Promise<string> {
  if (!loginFile) return ''
  const stat = await statFile($, loginFile)
  if (!stat) return ''
  if (stat.size > FS_READ_CAP) {
    // A login record grown past what $.fs reads in one call: Node reads it whole.
    return (await runHelper($, ['--login-file', loginFile], node))?.loginEmail ?? ''
  }
  try {
    return parseLoginEmail(await $.fs.read(loginFile))
  } catch (err) {
    $.ui.log(`login record not read: ${String(err)}`, { to: 'debug' })
    return ''
  }
}

// ---------- title and email of one session ----------
export type Memo = { id: string; path: string; mtimeMs: number; size: number; title: string; email: string; hooks: HookErrors; cache: CacheStamp | null }
export type Facts = { title: string; email: string; hooks: HookErrors; cache: CacheStamp | null }
export type Lookup = { configDir: string; id: string; cwd: string; maxMB: number; /** false: the reply time is not parsed (default true). */ cache?: boolean }

/**
 * The title, the session-context email and the hook failures of a session's transcript, read only when the file changed since `prev`.
 * Up to min(maxMB, 4) MB the module reads the file; above that the helper reads its last `maxMB` MB, and without
 * Node the last known values stay. `memo` is null while no transcript exists yet.
 */
export async function readTranscript(
  $: EngineInterface, look: Lookup, prev: Memo | null, node: NodeState,
): Promise<{ memo: Memo | null; facts: Facts }> {
  const known = prev && prev.id === look.id ? prev : null
  let path = known?.path ?? ''
  let stat = path ? await statFile($, path) : null
  if (!stat) {
    path = await findTranscript($, look.configDir, look.id, look.cwd)
    stat = path ? await statFile($, path) : null
  }
  if (!stat) return { memo: null, facts: { title: '', email: '', hooks: NO_HOOK_ERRORS, cache: null } }
  if (known && known.path === path && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return { memo: known, facts: { title: known.title, email: known.email, hooks: known.hooks, cache: known.cache } }
  }

  let { title, email, hooks, cache } = known ?? { title: '', email: '', hooks: NO_HOOK_ERRORS, cache: null as CacheStamp | null }
  if (stat.size <= Math.min(look.maxMB * MIB, FS_READ_CAP)) {
    try {
      const body = await $.fs.read(path)
      title = lastTitle(body)
      email = transcriptEmail(body) || email
      hooks = hookErrors(body)
      if (look.cache !== false) cache = lastCacheStamp(body)
    } catch (err) {
      $.ui.log(`transcript not read: ${String(err)}`, { to: 'debug' })
    }
  } else {
    const tail = String(Math.max(1, Math.min(64, Math.round(look.maxMB))))
    const answer = await runHelper($, ['--transcript', path, '--tail-mb', tail], node)
    if (answer) {
      title = answer.title || title
      email = answer.transcriptEmail || email
      hooks = answer.hookErrors ?? hooks
      cache = answer.cache ?? cache
    }
  }
  return { memo: { id: look.id, path, mtimeMs: stat.mtimeMs, size: stat.size, title, email, hooks, cache }, facts: { title, email, hooks, cache } }
}
