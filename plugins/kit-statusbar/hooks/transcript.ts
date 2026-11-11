// The session transcript (<config dir>/projects/<project>/<session id>.jsonl) and the login record: where they are,
// and what to read from them. The module reads files itself through $.fs (a read is capped at 4 MiB by the engine);
// a transcript above the limit is read from its end by scripts/session-info.mjs when Node is there.
import type { EngineInterface, FsEntry, FsStat } from 'claude-code'

import { joinPath, parseLoginEmail } from './account'

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
export type HelperAnswer = { title: string; transcriptEmail: string; loginEmail: string }
/** Set once Node could not be started: it is not tried again until the module reloads. */
export type NodeState = { missing: boolean }

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
  const text = (k: string): string => (typeof v[k] === 'string' ? (v[k] as string) : '')
  return { title: text('title'), transcriptEmail: text('transcriptEmail'), loginEmail: text('loginEmail') }
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
export type Memo = { id: string; path: string; mtimeMs: number; size: number; title: string; email: string }
export type Facts = { title: string; email: string }
export type Lookup = { configDir: string; id: string; cwd: string; maxMB: number }

/**
 * The title and the session-context email of a session's transcript, read only when the file changed since `prev`.
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
  if (!stat) return { memo: null, facts: { title: '', email: '' } }
  if (known && known.path === path && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return { memo: known, facts: { title: known.title, email: known.email } }
  }

  let { title, email } = known ?? { title: '', email: '' }
  if (stat.size <= Math.min(look.maxMB * MIB, FS_READ_CAP)) {
    try {
      const text = await $.fs.read(path)
      title = lastTitle(text)
      email = transcriptEmail(text) || email
    } catch (err) {
      $.ui.log(`transcript not read: ${String(err)}`, { to: 'debug' })
    }
  } else {
    const tail = String(Math.max(1, Math.min(64, Math.round(look.maxMB))))
    const answer = await runHelper($, ['--transcript', path, '--tail-mb', tail], node)
    if (answer) {
      title = answer.title || title
      email = answer.transcriptEmail || email
    }
  }
  return { memo: { id: look.id, path, mtimeMs: stat.mtimeMs, size: stat.size, title, email }, facts: { title, email } }
}
