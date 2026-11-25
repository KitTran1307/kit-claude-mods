// What the plugin reads from the engine and from read-only git. Every call is wrapped: a missing capability (no git, no
// repository, an old Claude Code) gives null or an empty answer, never an error.

import type { EngineInterface } from 'claude-code'

import type { FileChange, SessionChanges, Unpushed } from '../types'
import { deltaFiles, parseCommits, parseCount, parseNumstat, unpushedOf } from './data'
import type { Baseline, Message } from './data'

const GIT_TIMEOUT = 5_000

export type Snapshot = {
  vcs: string
  root: string
  rev: string | null
  branch: string | null
  /** Per-file numbers of the uncommitted changes at that moment. */
  files: Baseline
  /** False when version control could not list the changes (they are then not subtracted later). */
  filesKnown: boolean
}

/** Runs read-only git (no shell; the engine runs it with repo hooks off). Never throws. */
export async function git($: EngineInterface, args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: GIT_TIMEOUT })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

/**
 * Id of the newest conversation row, so the rows after it (a turn's own) can be read later. Independent of version control: it
 * works outside a repository too. undefined: the conversation had no rows yet (every later row is the turn's); null: it could not
 * be read (the turn's rows are then not guessed at).
 */
export async function newestRow($: EngineInterface): Promise<string | null | undefined> {
  try {
    const rows = await $.session.messages({ last: 1 })
    if (!Array.isArray(rows)) return null
    const row = rows[rows.length - 1]
    if (!row) return undefined
    return typeof row.uuid === 'string' && row.uuid ? row.uuid : null
  } catch {
    return null
  }
}

/** Where a working copy stands now: its system, root, revision and the uncommitted changes. Null when it is in no repository. */
export async function snapshotOf($: EngineInterface, cwd: string): Promise<Snapshot | null> {
  try {
    const copy = await $.vcs.detect({ path: cwd })
    if (!copy) return null
    const files: Baseline = {}
    let filesKnown = true
    try {
      const d = await $.vcs.diff({ path: cwd, vcs: copy.vcs, base: 'head', isStatOnly: true })
      if (d.files) for (const f of d.files) files[f.path] = { a: f.added, r: f.removed }
      else filesKnown = false
    } catch {
      filesKnown = false
    }
    return { vcs: copy.vcs, root: copy.root, rev: copy.revision, branch: copy.branch, files, filesKnown }
  } catch {
    return null
  }
}

export type Changed = { files: FileChange[] | null; commitsMade: number; vcs: string | null; root: string | null; branch: string | null }

/**
 * What changed in the working copy since a snapshot: its uncommitted files, plus (when git moved HEAD since, commits
 * were made) everything between the snapshot's revision and the working tree. Files already changed at the snapshot
 * are left out unless they changed again.
 */
export async function changesSince($: EngineInterface, cwd: string, base: Snapshot | null): Promise<Changed> {
  const none: Changed = { files: null, commitsMade: 0, vcs: null, root: null, branch: null }
  try {
    const copy = await $.vcs.detect({ path: cwd })
    if (!copy) return none
    const out: Changed = { files: null, commitsMade: 0, vcs: copy.vcs, root: copy.root, branch: copy.branch }
    let end: FileChange[] | null = null
    let untracked: FileChange[] = []
    try {
      const d = await $.vcs.diff({ path: cwd, vcs: copy.vcs, base: 'head', isStatOnly: true })
      if (d.files) {
        end = d.files.map(f => ({ path: f.path, added: f.added, removed: f.removed, ...(f.isBinary ? { isBinary: true } : {}), ...(f.isUntracked ? { isNew: true } : {}) }))
        untracked = end.filter(f => f.isNew)
      }
    } catch { /* unknown */ }
    const moved = !!base?.rev && !!copy.revision && base.rev !== copy.revision
    if (moved && copy.vcs === 'git' && base?.rev) {
      const diff = await git($, ['diff', '--numstat', base.rev], copy.root)
      if (diff.ok) {
        const seen = new Set<string>()
        end = [...parseNumstat(diff.out), ...untracked].filter(f => (seen.has(f.path) ? false : (seen.add(f.path), true)))
      }
      const count = await git($, ['rev-list', '--count', `${base.rev}..HEAD`], copy.root)
      out.commitsMade = (count.ok ? parseCount(count.out) : null) ?? 0
    }
    out.files = end ? deltaFiles(end, base && base.filesKnown ? base.files : {}) : null
    return out
  } catch {
    return none
  }
}

/** Commits no remote holds yet: against the upstream branch, else against every remote. Null when it cannot be told (not git, no remote). */
export async function readUnpushed($: EngineInterface, root: string | null): Promise<Unpushed | null> {
  if (!root) return null
  try {
    const up = await git($, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
    const upstream = up.ok ? up.out.trim() || null : null
    let range: string[]
    if (upstream) {
      range = ['@{u}..HEAD']
    } else {
      const remotes = await git($, ['remote'], root)
      if (!remotes.ok || remotes.out.trim() === '') return null
      range = ['HEAD', '--not', '--remotes']
    }
    const count = await git($, ['rev-list', '--count', ...range], root)
    const n = count.ok ? parseCount(count.out) : null
    if (n === null) return null
    if (n === 0) return unpushedOf(0, upstream, [])
    const log = await git($, ['log', '--format=%h%x09%s', '-n', '30', ...range], root)
    return unpushedOf(n, upstream, log.ok ? parseCommits(log.out) : [])
  } catch {
    return null
  }
}

/** The conversation rows after a row id (all rows when there was none). Empty when the mark is unknown (null) or the engine cannot say. */
export async function rowsAfter($: EngineInterface, uuid: string | null | undefined): Promise<Message[]> {
  if (uuid === null) return []
  try {
    const rows = uuid ? await $.session.messages({ after: uuid }) : await $.session.messages()
    if (!Array.isArray(rows)) return []
    return rows.map(r => ({ role: r.role, text: r.text, toolUses: (r.toolUses ?? []) as Message['toolUses'] }))
  } catch {
    return []
  }
}

/** What the session changed since it started. */
export async function sessionChanges($: EngineInterface, cwd: string, base: Snapshot | null, now: number): Promise<SessionChanges> {
  const changed = await changesSince($, cwd, base)
  return { at: now, files: changed.files, commitsMade: changed.commitsMade, unpushed: await readUnpushed($, changed.vcs === 'git' ? changed.root : null) }
}
