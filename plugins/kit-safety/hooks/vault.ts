// Where snapshots live and how they are made, listed, restored and pruned. Everything here talks to the world through ONE small
// interface (IO), so the logic is tested with an in-memory fake and the engine adapter (ioFromEngine) stays a thin function.
//
// Two ways to make the same snapshot (layout and manifest: snapshot.ts):
//   backend 'node' - scripts/safety-fs.mjs under real Node (binary-safe, hashes, symlink-safe, restores times and modes);
//   backend 'fs'   - the engine's own file calls only: small UTF-8 text files, no binary, no empty-folder restore.
// The plugin starts with 'node' when `node` exists and quietly falls back to 'fs' when it does not or when the helper fails.
//
// Every public function is total: it returns a result object (`ok: false, reason`), `[]`, `null` or `0`, never a rejection.
// Nothing here runs a command that changes the working tree, the index, HEAD or a branch: git is used for `rev-parse`,
// `stash create` (writes objects only), `update-ref` on our own `refs/kit-safety/` names, and nothing else; and only for the calls
// that git can undo (GIT_KINDS). Every git call runs with `core.fsmonitor=false` and `core.hooksPath=<an empty folder of ours>`
// (a hostile repository's config and hooks must not run code: `update-ref` would run a reference-transaction hook), and every
// non-git process (`node`) runs in the snapshots folder, never in the project.
import type { EngineInterface } from 'claude-code'

import { maskText } from './mask'
import { baseName, dirName, isAbsolute, isFilesystemRoot, isInside, isSafeRelative, isWindowsPath, joinPath, normalizePath, relativeTo } from './paths'
import { isEnvLike } from './risk'
import {
  buildManifest, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, evictionOrder, FILES_DIR, gitRestoreCommands, gitSafetyRef, isProjectKey, isSnapshotId,
  looseRefName, MANIFEST_FILE, newSnapshotId, nextNumber, parseManifest, planPrune, planTotalPrune, projectKey, relUnder, safeCommandText,
  serializeManifest, snapshotDir, storedPath, totalLimit,
} from './snapshot'
import type { GitInfo, Manifest, ManifestBase, ManifestFile, Skipped } from './snapshot'
import type { Risk } from './types'

// ---------------------------------------------------------------------------------------------------------------------
// The IO interface

export type IOEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
export type IOStat = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string }
export type IORun = { exitCode: number; stdout: string; stderr: string }
export type IO = {
  /** Rejects when the file is missing. */
  readText(path: string): Promise<string>
  /** Standard padded base64 of the file's bytes (or of a range of them). Rejects when missing. */
  readBase64(path: string, range?: { offset: number; length: number }): Promise<string>
  /** Creates the parent folders. */
  writeText(path: string, text: string): Promise<void>
  /** `[]` when the path is missing or not a folder. A link is `other` with `isLink`. */
  list(path: string): Promise<IOEntry[]>
  /** What the path leads to (a link is followed; `isLink` says the path itself is one); null when missing. */
  stat(path: string, resolve?: boolean): Promise<IOStat | null>
  /** Runs a command with no shell. NEVER rejects: a command that cannot start is `exitCode: -1`. */
  run(argv: string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<IORun>
  /** Milliseconds since the epoch. The engine's clock is asynchronous, so a promise is allowed. */
  now(): number | Promise<number>
  /**
   * An absolute folder the plugin owns (`<config folder>/kit-safety/no-hooks`) that every git call gets as `core.hooksPath`, so a
   * hook in the project can never run. Made on first use (once per IO); when it is missing, relative or cannot be made, git is
   * pointed at the null device instead, so hooks are off in every case.
   */
  hooksDir?: string
}

export type VaultEnv = {
  io: IO
  /** `<config folder>/kit-safety/snapshots`, absolute. */
  snapshotsRoot: string
  /** Absolute path of scripts/safety-fs.mjs. */
  helper: string
  /** `true`: the helper may be used. `false`: it may not. `undefined`: not probed yet (vault probes for itself). */
  node?: boolean
}
export type VaultCfg = {
  maxBytes: number
  keepCount: number
  keepDays: number
  /** All snapshots together (bytes): the oldest go first. undefined, 0 or below: no total cap. */
  maxTotalBytes?: number
  /** Files one snapshot may hold; a smaller number than the default makes a cheap snapshot. undefined: DEFAULT_MAX_FILES. */
  maxFiles?: number
}

export type SnapshotRequest = {
  root: string
  tool: string
  /** Not stored: a command can hold a password in a shape no mask knows, so the manifest never has the command text (ignored here). */
  command?: string
  risks: Risk[]
  /** Project-relative paths, already contained and existing (guard.ts). */
  targets: string[]
  kind: Manifest['kind']
  restoredFrom?: string
  /** More snapshot ids the prune that follows must leave alone (the new one and `restoredFrom` always are). */
  protectIds?: string[]
}

export type SnapshotOutcome =
  | {
      ok: true
      id: string
      n: number
      createdAt: number
      files: number
      bytes: number
      /** Something that holds data was not saved (binary file in the 'fs' backend, unreadable file, list cut). Links alone do not count. */
      isPartial: boolean
      hasGit: boolean
      backend: 'node' | 'fs'
      skippedBinary: number
      /** Git state was asked for but the uncommitted changes could not be saved (an unfinished merge, a time-out). Only set when true. */
      isGitPartial?: boolean
      /** `.env`-like files the text-only backend did not copy (they would get the default permissions). Only set when more than 0; `isPartial` is true then. */
      skippedPrivate?: number
    }
  | {
      ok: false
      /**
       * 'too-big': over the size or file limit, nothing written. 'nothing': no files and no git state to record. 'private': the
       * only things there were `.env`-like files and the text-only backend (no Node) does not copy those; nothing written.
       */
      reason: 'too-big' | 'nothing' | 'failed' | 'private'
      bytes?: number
      /** `too-big` only: the limit that tripped was the number of files, not the size (so `bytes` is no measure of it). */
      byFiles?: true
      /** `nothing` only: entries that were seen but could not be saved (binary files in the 'fs' backend). */
      skipped?: number
    }

export type RestoreOutcome = {
  /** True when the restore ran and nothing failed. */
  ok: boolean
  /** Files restored plus empty folders recreated. */
  restored: number
  failed: { rel: string; reason: string }[]
  /** Items under a restored folder that the snapshot does not have: the person's newer work, left where it is. */
  keptNewer: number
  /** The snapshot's own time. */
  at: number
  id: string
  n: number
  /** Up to 5 project-relative paths. */
  sample: string[]
  hasUndo: boolean
  /** What brings back what git threw away: shown, never run. */
  git: { label: string; command: string }[]
  /** The snapshot's Git state is partial: Git could not save the uncommitted changes when it was taken. Only set when true. */
  gitPartial?: boolean
  /**
   * Existing files the restore did NOT overwrite because the undo point could not be saved first (only those missing now were
   * put back). Only set when more than 0; `ok` is false then.
   */
  leftAsIs?: number
  /** Nothing in the project was overwritten (every place the restore wrote to was empty), so there is no undo point and none is needed. Only set when true. */
  noneOverwritten?: true
  /** Set when nothing was attempted: 'other-project' (a snapshot of another folder), 'not-found', 'failed'. */
  reason?: 'other-project' | 'not-found' | 'failed'
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants

/** Largest file the 'fs' backend copies. */
export const MAX_FILE_BYTES = 3 * 1024 * 1024
/** One engine read or write is limited to 4 MiB: a manifest the 'fs' backend cannot write in one piece is "too big". */
const MAX_WRITE_BYTES = 4 * 1024 * 1024 - 1024
const MAX_READ_TEXT = 64 * 1024 * 1024
const READ_CHUNK = 3 * 1024 * 1024
const MAX_DEPTH = 64
const PRUNED_MARKER = 'pruned'
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 5_000
const HELPER_SCAN_MS = 120_000
const HELPER_RUN_MS = 300_000
const HELPER_REMOVE_MS = 60_000
const GIT_IDENTITY = ['-c', 'user.name=Safety Net', '-c', 'user.email=safety-net@localhost']
/** `core.fsmonitor` in a repository's own config is a command git would run for `stash create`, `ls-files` and `check-ignore`. (Hooks: gitRun.) */
const GIT_SAFE = ['-c', 'core.fsmonitor=false']
/** The calls whose damage git can undo: only these get a git state (the file copy covers delete, overwrite, clean, db-drop). */
export const GIT_KINDS: ReadonlySet<string> = new Set(['reset-hard', 'discard', 'force-push', 'branch-delete'])
/** The ones that throw away uncommitted changes: only these ask for a stash. */
const STASH_KINDS: ReadonlySet<string> = new Set(['reset-hard', 'discard'])
const MAX_BRANCH_NAMES = 20
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/
const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i
const NO_PRUNE = { keepCount: Infinity, keepDays: Infinity }
/** Any valid id: for the questions that do not depend on which one it is. */
const ID_PLACEHOLDER = '20000101T000000Z'
const DAY_MS = 86_400_000
/** A snapshot folder without a readable manifest is debris (a helper killed mid-copy); this old it is certainly not in the making. */
const ORPHAN_AGE_MS = DAY_MS
const MAX_PROJECTS = 200
const MAX_PER_PROJECT = 500
const SWEEP_BUDGET_MS = 60_000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

// ---------------------------------------------------------------------------------------------------------------------
// Bytes and text

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_VALUE = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i
  return table
})()

/** The bytes of a standard base64 text (padding optional, whitespace ignored), or null when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== 'string') return null
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(text.replace(/\s+/g, ''))
  if (!m) return null
  const clean = m[1] ?? ''
  const pad = m[2] ?? ''
  if (clean.length % 4 === 1 || (pad !== '' && (clean.length + pad.length) % 4 !== 0)) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let at = 0
  for (let i = 0; i < clean.length; i += 1) {
    acc = (acc << 6) | (B64_VALUE[clean.charCodeAt(i)] ?? 0)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at] = (acc >> bits) & 0xff
      at += 1
      acc &= (1 << bits) - 1
    }
  }
  return out
}

/**
 * The text of valid UTF-8 bytes (a byte order mark is kept as U+FEFF, so writing the text back gives the same bytes), or null for
 * bytes that hold a NUL or are not UTF-8: a binary file. Done by hand: the engine's TextDecoder takes no `fatal` option.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  const parts: string[] = []
  let units: number[] = []
  const flush = (): void => {
    parts.push(String.fromCharCode(...units))
    units = []
  }
  const n = bytes.length
  const cont = (at: number, lo = 0x80, hi = 0xbf): number => {
    const b = at < n ? bytes[at] ?? -1 : -1
    return b >= lo && b <= hi ? b & 0x3f : -1
  }
  for (let i = 0; i < n; ) {
    const b = bytes[i] ?? 0
    let cp: number
    if (b < 0x80) {
      if (b === 0) return null
      cp = b
      i += 1
    } else if (b >= 0xc2 && b <= 0xdf) {
      const c1 = cont(i + 1)
      if (c1 < 0) return null
      cp = ((b & 0x1f) << 6) | c1
      i += 2
    } else if (b >= 0xe0 && b <= 0xef) {
      const c1 = b === 0xe0 ? cont(i + 1, 0xa0) : b === 0xed ? cont(i + 1, 0x80, 0x9f) : cont(i + 1)
      const c2 = cont(i + 2)
      if (c1 < 0 || c2 < 0) return null
      cp = ((b & 0x0f) << 12) | (c1 << 6) | c2
      i += 3
    } else if (b >= 0xf0 && b <= 0xf4) {
      const c1 = b === 0xf0 ? cont(i + 1, 0x90) : b === 0xf4 ? cont(i + 1, 0x80, 0x8f) : cont(i + 1)
      const c2 = cont(i + 2)
      const c3 = cont(i + 3)
      if (c1 < 0 || c2 < 0 || c3 < 0) return null
      cp = ((b & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3
      i += 4
    } else {
      return null
    }
    if (cp >= 0x10000) {
      cp -= 0x10000
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      units.push(cp)
    }
    if (units.length >= 8192) flush()
  }
  flush()
  return parts.join('')
}

// ---------------------------------------------------------------------------------------------------------------------
// The engine adapter

/**
 * The IO over `$.fs`, `$.process.run` and `$.clock`. Reads that the engine limits to 4 MiB are done in ranges. `opts.hooksDir` is
 * the folder every git call gets as `core.hooksPath` (see IO.hooksDir).
 */
export function ioFromEngine($: EngineInterface, opts?: { hooksDir?: string }): IO {
  const hooksDir = typeof opts?.hooksDir === 'string' && opts.hooksDir !== '' ? opts.hooksDir : undefined
  return {
    ...(hooksDir !== undefined ? { hooksDir } : {}),
    readText: async path => {
      try {
        return await $.fs.read(path)
      } catch (error) {
        const st = await $.fs.stat(path).catch(() => null)
        if (!st || st.kind !== 'file' || st.size <= MAX_WRITE_BYTES || st.size > MAX_READ_TEXT) throw error
        const parts: Uint8Array[] = []
        let total = 0
        for (let offset = 0; offset < st.size; offset += READ_CHUNK) {
          const { base64 } = await $.fs.read(path, { as: 'bytes', offset, length: READ_CHUNK })
          const bytes = decodeBase64(base64)
          if (!bytes) throw error
          parts.push(bytes)
          total += bytes.length
        }
        const all = new Uint8Array(total)
        let at = 0
        for (const part of parts) {
          all.set(part, at)
          at += part.length
        }
        return new TextDecoder().decode(all)
      }
    },
    readBase64: async (path, range) => {
      const result = range ? await $.fs.read(path, { as: 'bytes', offset: range.offset, length: range.length }) : await $.fs.read(path, { as: 'bytes' })
      return result.base64
    },
    writeText: (path, text) => $.fs.write(path, text),
    list: async path => {
      try {
        const entries = await $.fs.list(path)
        return entries.map(e => ({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, isLink: e.isLink }))
      } catch {
        return []
      }
    },
    stat: async (path, resolve) => {
      try {
        const s = resolve ? await $.fs.stat(path, { resolve: true }) : await $.fs.stat(path)
        const out: IOStat = { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs, isLink: s.isLink }
        if (s.realPath !== undefined) out.realPath = s.realPath
        return out
      } catch {
        return null
      }
    },
    run: async (argv, init) => {
      try {
        const r = await $.process.run(argv, { ...(init?.cwd !== undefined ? { cwd: init.cwd } : {}), ...(init?.stdin !== undefined ? { stdin: init.stdin } : {}), timeoutMs: init?.timeoutMs ?? 30_000 })
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      } catch (error) {
        return { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : 'could not run' }
      }
    },
    now: () => $.clock.now(),
  }
}

/** The IO's clock as a number, whatever it answers with (the real time when it fails). */
export async function nowOf(io: IO): Promise<number> {
  try {
    const t = await io.now()
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Node helper

/** The folder `node` and the helper run in: the snapshots folder when it exists (nothing is created). Never the project: on Windows a hostile `node.exe` there would be picked up first. */
async function runFolder(io: IO, folder: string | undefined): Promise<string | undefined> {
  if (typeof folder !== 'string' || folder === '') return undefined
  try {
    const st = await io.stat(folder)
    return st !== null && st !== undefined && st.kind === 'dir' ? folder : undefined
  } catch {
    return undefined
  }
}

/** True when `node --version` answers with a major version of 18 or more. `folder` is where to run it (the snapshots folder, when it exists). */
export async function probeNode(io: IO, folder?: string): Promise<boolean> {
  try {
    const cwd = await runFolder(io, folder)
    const r = await io.run(['node', '--version'], { timeoutMs: NODE_TIMEOUT_MS, ...(cwd !== undefined ? { cwd } : {}) })
    if (r.exitCode !== 0) return false
    const m = /^v?(\d+)\./.exec(r.stdout.trim())
    return m !== null && Number(m[1]) >= 18
  } catch {
    return false
  }
}

const useNode = async (env: VaultEnv): Promise<boolean> => (env.node === undefined ? probeNode(env.io, env.snapshotsRoot) : env.node)

/** One request to scripts/safety-fs.mjs. null when it could not be run or did not answer with JSON; otherwise its answer (`ok` may be false). */
async function callHelper(env: VaultEnv, request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const cwd = await runFolder(env.io, env.snapshotsRoot)
    const r = await env.io.run(['node', env.helper], { stdin: JSON.stringify(request), timeoutMs, ...(cwd !== undefined ? { cwd } : {}) })
    if (r.exitCode !== 0) return null
    const lines = r.stdout.trim().split('\n')
    const answer: unknown = JSON.parse(lines[lines.length - 1] ?? '')
    return isObj(answer) && typeof answer.ok === 'boolean' ? answer : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// git (read-only for the project; refs only under refs/kit-safety/)

const NO_HOOKS_NOTE =
  'This folder is empty on purpose.\n\n' +
  'Safety Net runs every Git command with core.hooksPath pointing here, so that a Git hook inside one of your projects can never\n' +
  'run while Safety Net saves a snapshot. Please leave this folder empty: anything you put in it would run as a Git hook.\n' +
  'You can delete this note; Safety Net writes it again.\n'

/** The outcome of making the hooks folder, once per IO (also a failed one: the null device is just as safe). */
const hooksReady = new WeakMap<object, Promise<string | null>>()

/** The folder git is pointed at for hooks (see IO.hooksDir), made once per IO; null when there is none or it could not be made. */
async function hooksFolder(io: IO): Promise<string | null> {
  const dir = io?.hooksDir
  if (typeof io !== 'object' || io === null || typeof dir !== 'string' || dir.length > 4096 || /[\u0000-\u001F\u007F]/.test(dir)) return null
  if (!isAbsolute(dir) || isFilesystemRoot(dir)) return null
  let ready = hooksReady.get(io)
  if (ready === undefined) {
    ready = (async () => {
      try {
        // Never a file named like a git hook: only a note.
        const note = joinPath(dir, 'README.txt')
        if (!(await io.stat(note))) await io.writeText(note, NO_HOOKS_NOTE)
        return dir
      } catch {
        return null
      }
    })()
    hooksReady.set(io, ready)
  }
  return ready
}

/** The OS null device: a `core.hooksPath` that cannot hold hooks. */
const nullDevice = (root: unknown): string => (typeof root === 'string' && isWindowsPath(root) ? 'NUL' : '/dev/null')

/**
 * Runs `git -C <root> ...` with the hooks folder (see IO.hooksDir) as its working folder, never the project. `ok` is exit code 0. Never throws. The first options are always the same and come before `-C`:
 * `-c core.fsmonitor=false`, `-c core.hooksPath=<IO.hooksDir, else the null device>`, then (for `identity`) the stash identity.
 * Nothing in them is read from the project: a hostile repository's config cannot choose where hooks are looked for.
 */
export async function gitRun(io: IO, root: string, args: string[], opts: { identity?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; code: number; out: string }> {
  try {
    const folder = await hooksFolder(io)
    const hooks = folder ?? nullDevice(root)
    // Run from our own (note-only) folder, never the project: on Windows a program is looked for in the working folder first, and a
    // project may hold a `git.exe` or `git.cmd` of its own. `-C` still points git at the project.
    const cwd = folder ?? undefined
    const argv = ['git', ...GIT_SAFE, '-c', `core.hooksPath=${hooks}`, ...(opts.identity ? GIT_IDENTITY : []), '-C', root, ...args]
    const r = await io.run(argv, { timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS, ...(cwd !== undefined ? { cwd } : {}) })
    return { ok: r.exitCode === 0, code: r.exitCode, out: typeof r.stdout === 'string' ? r.stdout : '' }
  } catch {
    return { ok: false, code: -1, out: '' }
  }
}

type GitTip = { name: string; sha: string; remote?: true }
type GitFacts = {
  head: string | null
  branch: string | null
  stashSha?: string
  /** HEAD exists, a stash was asked for and `git stash create` failed. */
  isPartial: boolean
  /** The call throws uncommitted changes away: the stash (or, for a clean tree, the head) is kept alive under a ref. */
  keepsHead: boolean
  /** Deleted branches, then the remote branches a force push overwrites (`remote: true`, named `<remote>/<branch>`). */
  tips: GitTip[]
}

const shaOf = (out: string): string | null => {
  const line = out.trim().split('\n')[0]?.trim() ?? ''
  return GIT_SHA_RE.test(line) ? line.toLowerCase() : null
}

/** The branch names a risk carries: all of `names`, else `name`. */
function namesOf(r: Risk): string[] {
  const list = Array.isArray(r.names) && r.names.length > 0 ? r.names : typeof r.name === 'string' ? [r.name] : []
  return list.filter((n): n is string => typeof n === 'string')
}

/** The branches a `git branch -D` would delete: any name git takes as a ref (not only the ones fit to print), at most 20. */
function branchNames(risks: readonly Risk[]): string[] {
  const names: string[] = []
  for (const r of risks) {
    if (r?.kind !== 'branch-delete') continue
    for (const name of namesOf(r)) if (looseRefName(name) && !names.includes(name) && names.length < MAX_BRANCH_NAMES) names.push(name)
  }
  return names
}

/** The remote branches a force push names, as `{ remote, name }`, at most 20. */
function pushedBranches(risks: readonly Risk[]): { remote: string; name: string }[] {
  const out: { remote: string; name: string }[] = []
  for (const r of risks) {
    if (r?.kind !== 'force-push' || typeof r.remote !== 'string' || !looseRefName(r.remote) || r.remote.includes('/')) continue
    for (const name of namesOf(r)) {
      if (looseRefName(name) && out.length < MAX_BRANCH_NAMES && !out.some(o => o.remote === r.remote && o.name === name)) out.push({ remote: r.remote, name })
    }
  }
  return out
}

/** What git knows now, or null for a call git cannot undo, outside a repository, or without git. Changes nothing in the project. */
async function collectGit(io: IO, root: string, risks: readonly Risk[]): Promise<GitFacts | null> {
  if (!risks.some(r => GIT_KINDS.has(r?.kind))) return null
  const inside = await gitRun(io, root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') return null
  const headRun = await gitRun(io, root, ['rev-parse', 'HEAD'])
  const head = headRun.ok ? shaOf(headRun.out) : null
  const b = await gitRun(io, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = b.out.trim()
  const branch = b.ok && name !== 'HEAD' && BRANCH_NAME_RE.test(name) ? name : null
  const keepsHead = risks.some(r => STASH_KINDS.has(r?.kind))
  const facts: GitFacts = { head, branch, isPartial: false, keepsHead, tips: [] }
  if (head && keepsHead) {
    // `stash create` makes a commit of the uncommitted changes of tracked files and prints its sha; a clean tree prints nothing and
    // exits 0. A failure (an unfinished merge: "needs merge", or the time-out) means the changes are NOT saved: say so.
    const stash = await gitRun(io, root, ['stash', 'create'], { identity: true })
    if (!stash.ok) facts.isPartial = true
    else {
      const sha = shaOf(stash.out)
      if (sha) facts.stashSha = sha
    }
  }
  for (const branchName of branchNames(risks)) {
    const tip = await gitRun(io, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`])
    const sha = tip.ok ? shaOf(tip.out) : null
    if (sha) facts.tips.push({ name: branchName, sha })
  }
  for (const pushed of pushedBranches(risks)) {
    const tip = await gitRun(io, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${pushed.remote}/${pushed.name}`])
    const sha = tip.ok ? shaOf(tip.out) : null
    if (sha) facts.tips.push({ name: `${pushed.remote}/${pushed.name}`, sha, remote: true })
  }
  return facts
}

/** The git part of a manifest as it will be once its refs are made (the stash ref is named from the id; pinGit says whether it was). */
function gitStateOf(facts: GitFacts | null, id: string): GitInfo | undefined {
  if (!facts) return undefined
  // A call that keeps nothing (a force push with no remote tip to pin, `git branch -D` of a branch that is not there) has no git
  // state at all: nothing is stored, so nothing can be claimed.
  if (!facts.keepsHead && facts.tips.length === 0) return undefined
  const info: GitInfo = { head: facts.head, branch: facts.branch }
  if (facts.stashSha) {
    info.stashSha = facts.stashSha
    info.ref = gitSafetyRef(id)
  }
  if (facts.isPartial) info.isPartial = true
  if (facts.tips.length > 0) info.branches = facts.tips.map(t => (t.remote === true ? { name: t.name, sha: t.sha, remote: true } : { name: t.name, sha: t.sha }))
  return info
}

/**
 * Is there something git-shaped to keep for these risks and this state? True when gitRestoreCommands would print a hint, and when
 * Git could not save the uncommitted changes: that snapshot is still made, so that the person is told so.
 */
function hasGitState(risks: readonly Risk[], git: GitInfo | undefined): boolean {
  if (git === undefined) return false
  if (git.isPartial === true) return true
  const kinds = risks.map(r => ({ kind: typeof r?.kind === 'string' ? r.kind : '', label: '' }))
  return gitRestoreCommands({ id: ID_PLACEHOLDER, git, risks: kinds } as Manifest).length > 0
}

const branchRef = (id: string, i: number): string => `${gitSafetyRef(id)}.b/${i}`

/** Every ref a snapshot may own: the stash (or head) ref, then one per recorded tip. */
function refsOf(id: string, git: GitInfo | undefined): string[] {
  const refs = [gitSafetyRef(id)]
  for (let i = 1; i <= (git?.branches?.length ?? 0); i += 1) refs.push(branchRef(id, i))
  return refs
}

type Pinned = { info: GitInfo | undefined; /** The refs this call made (and so the only ones it may delete). */ created: string[] }

/**
 * Keeps the commits alive: the stash (or, for a reset, the head) under `refs/kit-safety/<id>`, one ref per recorded tip. Refs are
 * made create-only (`update-ref <ref> <sha> ""` fails when the ref exists): a ref that is already there belongs to someone else
 * and is neither moved nor, later, deleted by this call. `info.ref` is only set when the stash ref really was made.
 */
async function pinGit(io: IO, root: string, id: string, facts: GitFacts): Promise<Pinned> {
  const created: string[] = []
  const pin = async (ref: string, sha: string): Promise<boolean> => {
    const r = await gitRun(io, root, ['update-ref', ref, sha, ''])
    if (r.ok) created.push(ref)
    return r.ok
  }
  const info = gitStateOf(facts, id)
  if (info === undefined) return { info, created }
  const target = facts.stashSha ?? (facts.keepsHead ? facts.head : null)
  if (target && !(await pin(gitSafetyRef(id), target))) delete info.ref
  for (const [i, tip] of facts.tips.entries()) await pin(branchRef(id, i + 1), tip.sha)
  return { info, created }
}

/** Deletes refs this call made (and only those). */
async function dropRefs(io: IO, root: string, refs: readonly string[]): Promise<void> {
  for (const ref of refs) await gitRun(io, root, ['update-ref', '-d', ref])
}

/** What git facts to store for a call: head, branch, a stash ref, the tips of branches about to be deleted or overwritten. undefined for a call git cannot undo, outside a repository. */
export async function gitInfoFor(io: IO, root: string, risks: Risk[], id: string): Promise<GitInfo | undefined> {
  try {
    if (!isSnapshotId(id)) return undefined
    const facts = await collectGit(io, root, Array.isArray(risks) ? risks : [])
    return facts ? (await pinGit(io, root, id, facts)).info : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what is there

const usableRoot = (root: unknown): root is string =>
  typeof root === 'string' && root.length <= 4096 && !/[\u0000-\u001F\u007F]/.test(root) && isAbsolute(root) && !isFilesystemRoot(root)

/** Two spellings of one folder (Windows paths compare without regard to case). */
function sameRoot(a: string, b: string): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return isWindowsPath(a) || isWindowsPath(b) ? x.toLowerCase() === y.toLowerCase() : x === y
}

async function readManifest(env: VaultEnv, key: string, id: string): Promise<Manifest | null> {
  try {
    const dir = snapshotDir(env.snapshotsRoot, key, id)
    const m = parseManifest(await env.io.readText(joinPath(dir, MANIFEST_FILE)))
    if (!m || m.id !== id || projectKey(m.root) !== key) return null
    if (await env.io.stat(joinPath(dir, PRUNED_MARKER))) return null
    return m
  } catch {
    return null
  }
}

const newestFirst = (a: Manifest, b: Manifest): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** `ids` is every snapshot-looking folder (also damaged and pruned ones: their names stay taken); `items` the usable manifests, newest first. */
async function readProject(env: VaultEnv, root: string): Promise<{ ids: string[]; items: Manifest[] }> {
  const key = projectKey(root)
  const entries = await env.io.list(joinPath(env.snapshotsRoot, key))
  const ids = entries.filter(e => e.kind === 'dir' && !e.isLink && isSnapshotId(e.name)).map(e => e.name)
  const found = await Promise.all(ids.map(id => readManifest(env, key, id)))
  const items = found.filter((m): m is Manifest => m !== null).sort(newestFirst)
  return { ids, items }
}

/** The project's usable snapshots, newest first. Damaged, pruned and foreign ones are left out. */
export async function listSnapshots(env: VaultEnv, root: string): Promise<Manifest[]> {
  try {
    if (!usableRoot(root)) return []
    return (await readProject(env, root)).items.filter(m => sameRoot(m.root, root))
  } catch {
    return []
  }
}

/**
 * One snapshot by what the person typed: `7` or `#7` (its number), a full id, or a prefix of an id that only one snapshot has.
 * Nothing typed means the newest 'before-command' snapshot that was asked about (not a quiet save before an edit), and only when
 * there is no other the newest quiet one. null when there is none or the prefix is ambiguous.
 */
export async function findSnapshot(env: VaultEnv, root: string, idOrNumber?: string): Promise<Manifest | null> {
  try {
    const list = await listSnapshots(env, root)
    const text = (typeof idOrNumber === 'string' ? idOrNumber : '').trim().replace(/^#/, '').trim()
    if (text === '') return list.find(m => m.kind === 'before-command' && m.quiet !== true) ?? list.find(m => m.kind === 'before-command') ?? null
    if (text.length > 40) return null
    if (/^\d{1,9}$/.test(text)) {
      const byNumber = list.find(m => m.n === Number(text))
      if (byNumber) return byNumber
    }
    const up = text.toUpperCase()
    const exact = list.find(m => m.id === up)
    if (exact) return exact
    const matches = /^[0-9T]/.test(up) ? list.filter(m => m.id.startsWith(up)) : []
    return matches.length === 1 ? (matches[0] ?? null) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Making a snapshot

function cleanTargets(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const t of list) if (typeof t === 'string' && t.length <= 4096 && isSafeRelative(t)) seen.add(t)
  const sorted = [...seen].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
  const kept: string[] = []
  for (const t of sorted) if (!kept.some(k => relUnder(k, t))) kept.push(t)
  return kept
}

function cleanRisks(list: unknown): Manifest['risks'] {
  const out: Manifest['risks'] = []
  if (!Array.isArray(list)) return out
  for (const r of list) {
    if (out.length >= 20) break
    if (!isObj(r) || typeof r.kind !== 'string' || typeof r.label !== 'string') continue
    const kind = safeCommandText(r.kind, 40)
    const label = safeCommandText(maskText(r.label).text, 120)
    if (!kind || !label) continue
    const risk: Manifest['risks'][number] = { kind, label }
    const name = typeof r.name === 'string' ? safeCommandText(maskText(r.name).text, 200) : ''
    if (name) risk.name = name
    out.push(risk)
  }
  return out
}

function baseOf(req: SnapshotRequest, id: string, n: number, createdAt: number, backend: 'node' | 'fs', targets: string[], git: GitInfo | undefined, quiet: boolean): ManifestBase {
  // No command text: a manifest holds labels (masked), paths and git facts, never the command line.
  const base: ManifestBase = { v: 1, id, n, createdAt, root: req.root, kind: req.kind, tool: safeCommandText(typeof req.tool === 'string' ? req.tool : '', 100), risks: cleanRisks(req.risks), targets, backend }
  if (quiet) base.quiet = true
  if (git) base.git = git
  if (isSnapshotId(req.restoredFrom)) base.restoredFrom = req.restoredFrom
  return base
}

/** A call whose every risk is only worth a quiet snapshot (an edit of a file git does not track): pruned apart from the asked-about ones. */
const isQuiet = (req: SnapshotRequest): boolean => req.kind === 'before-command' && req.risks.length > 0 && req.risks.every(r => isObj(r) && r.tier === 'snapshot')

function outcomeOf(m: Manifest, unlisted = 0): Extract<SnapshotOutcome, { ok: true }> {
  const lost = unlisted > 0 || m.skipped.some(s => s.reason !== 'symlink')
  const outcome: Extract<SnapshotOutcome, { ok: true }> = {
    ok: true,
    id: m.id,
    n: m.n,
    createdAt: m.createdAt,
    files: m.files.length,
    bytes: m.totalBytes,
    isPartial: lost,
    hasGit: gitRestoreCommands(m).length > 0,
    backend: m.backend,
    skippedBinary: m.skipped.filter(s => s.reason === 'binary').length,
  }
  if (m.git?.isPartial === true) outcome.isGitPartial = true
  const priv = m.skipped.filter(s => s.reason === 'private').length
  if (priv > 0) outcome.skippedPrivate = priv
  return outcome
}

/** A size limit as a plain number the helper accepts (JSON has no Infinity): a missing or bad one is the default. */
const sizeLimit = (v: unknown): number => (typeof v === 'number' && !Number.isNaN(v) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, v)) : DEFAULT_MAX_BYTES)

/** The number of files one snapshot may hold: 1 up to the default; a missing or bad one is the default (a larger one is not honoured). */
const fileLimit = (v: unknown): number => (typeof v === 'number' && !Number.isNaN(v) ? Math.min(DEFAULT_MAX_FILES, Math.max(1, Math.floor(v))) : DEFAULT_MAX_FILES)

type Project = { ids: string[]; items: Manifest[] }
type Job = {
  env: VaultEnv
  req: SnapshotRequest
  cfg: VaultCfg
  targets: string[]
  key: string
  quiet: boolean
  project: Project
  /** Every id seen taken (also by a collision just now): never offered again. */
  taken: Set<string>
}

/** Saves what a risky call would lose. See the file header for the two backends; `nothing` and `too-big` write nothing. */
export async function createSnapshot(env: VaultEnv, req: SnapshotRequest, cfg: VaultCfg): Promise<SnapshotOutcome> {
  try {
    if (!usableRoot(req?.root) || typeof env?.snapshotsRoot !== 'string' || !isAbsolute(env.snapshotsRoot)) return { ok: false, reason: 'failed' }
    if (req.kind !== 'before-command' && req.kind !== 'before-restore') return { ok: false, reason: 'failed' }
    // The manifest must read back: check its root and fields the way listSnapshots will, before anything is written.
    const draft = baseOf(req, ID_PLACEHOLDER, 1, 0, 'fs', [], undefined, false)
    if (parseManifest(serializeManifest(buildManifest(draft, { files: [], dirs: [], skipped: [] }))) === null) return { ok: false, reason: 'failed' }
    const project = await readProject(env, req.root)
    const job: Job = {
      env,
      req: { ...req, risks: Array.isArray(req.risks) ? req.risks : [] },
      cfg: { maxBytes: sizeLimit(cfg?.maxBytes), keepCount: cfg?.keepCount, keepDays: cfg?.keepDays, maxTotalBytes: cfg?.maxTotalBytes, maxFiles: fileLimit(cfg?.maxFiles) },
      targets: cleanTargets(req.targets),
      key: projectKey(req.root),
      quiet: false,
      project,
      taken: new Set(project.ids),
    }
    job.quiet = isQuiet(job.req)
    if (await useNode(env)) {
      const done = await viaNode(job)
      if (done) return done
    }
    return await viaFs(job)
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** After a snapshot was made: prune, and leave the new one (and the one it was made for) alone. Errors are ignored. */
async function finish(job: Job, m: Manifest, outcome: SnapshotOutcome): Promise<SnapshotOutcome> {
  const protect = [m.id, ...(job.req.restoredFrom ? [job.req.restoredFrom] : []), ...(job.req.protectIds ?? [])]
  try {
    await pruneSnapshots(job.env, job.req.root, job.cfg, protect)
  } catch {
    // pruning is housekeeping
  }
  return outcome
}

/** What git knows for this call: only a before-command call that git can undo has a git state at all. */
const gitFacts = (job: Job): Promise<GitFacts | null> => (job.req.kind === 'before-command' ? collectGit(job.env.io, job.req.root, job.req.risks) : Promise.resolve(null))

/** An id was taken by someone else (another session): never offer it again, and look at the project again so the number is fresh. */
async function retake(job: Job, id: string): Promise<void> {
  job.taken.add(id)
  try {
    job.project = await readProject(job.env, job.req.root)
    for (const taken of job.project.ids) job.taken.add(taken)
  } catch {
    // the old listing stays
  }
}

const tooBigOutcome = (answer: Record<string, unknown>): SnapshotOutcome => ({ ok: false, reason: 'too-big', bytes: count(answer.bytes), ...(answer.tooBigBy === 'files' ? { byFiles: true as const } : {}) })

/**
 * The manifest the helper wrote into `<snapshots>/<key>/<id>`, read back from disk (the copy answer is only a summary, and the
 * manifest of a big tree is far over the engine's 4 MiB limit on a command's output). null unless it is a valid manifest of THIS
 * call (same id, time and project): the folder was checked to be absent before the copy, but the check is cheap.
 */
async function storedManifest(env: VaultEnv, key: string, base: ManifestBase): Promise<Manifest | null> {
  try {
    const m = parseManifest(await env.io.readText(joinPath(snapshotDir(env.snapshotsRoot, key, base.id), MANIFEST_FILE)))
    return m !== null && m.id === base.id && m.createdAt === base.createdAt && m.backend === 'node' && sameRoot(m.root, base.root) ? m : null
  } catch {
    return null
  }
}

/** True when `<snapshots>/<key>/<id>` holds a manifest that reads back: a snapshot that is complete, whoever made it. */
async function holdsManifest(env: VaultEnv, key: string, id: string): Promise<boolean> {
  try {
    return parseManifest(await env.io.readText(joinPath(snapshotDir(env.snapshotsRoot, key, id), MANIFEST_FILE))) !== null
  } catch {
    return false
  }
}

/**
 * A snapshot folder this call made and cannot use (the helper died mid-copy): removed, with the helper, so no half snapshot is
 * left. Only a folder without a manifest that reads back: one that has a valid manifest is a snapshot (ours would have been used
 * already, so it is another session's, made with the same id a moment ago) and is never touched.
 */
async function clearFolder(job: Job, id: string): Promise<void> {
  try {
    const dir = snapshotDir(job.env.snapshotsRoot, job.key, id)
    if (!(await job.env.io.stat(dir))) return
    if (await holdsManifest(job.env, job.key, id)) return
    await callHelper(job.env, { cmd: 'remove', snapshotsRoot: job.env.snapshotsRoot, projectKey: job.key, id }, HELPER_REMOVE_MS)
  } catch {
    // a folder without a manifest is invisible to the list, and the sweep (pruneAll) removes it when it is a day old
  }
}

/** The helper made the snapshot: now (and only now) the git refs are made, and the manifest is made to tell the truth about them. */
async function commitNode(job: Job, m: Manifest, facts: GitFacts | null, unlisted: number): Promise<SnapshotOutcome> {
  const { io } = job.env
  let final = m
  if (facts) {
    const pinned = await pinGit(io, job.req.root, m.id, facts)
    // The manifest already names the stash ref; when git did not make it, the manifest must not promise it.
    if (m.git?.ref !== undefined && pinned.info?.ref === undefined) {
      const git: GitInfo = { ...m.git }
      delete git.ref
      final = { ...m, git }
      try {
        await io.writeText(joinPath(snapshotDir(job.env.snapshotsRoot, job.key, m.id), MANIFEST_FILE), serializeManifest(final))
      } catch {
        // the copy is complete; the printed command then names a ref that is not there, and `git stash apply` says so
      }
    }
  }
  return finish(job, final, outcomeOf(final, unlisted))
}

/** Backend 'node'. null = it did not work out: the caller tries the 'fs' backend. At most one snapshot is made for one call. */
async function viaNode(job: Job): Promise<SnapshotOutcome | null> {
  const { env, req, cfg, key } = job
  const { io } = env
  let targets = job.targets
  let planned = { files: 0, dirs: 0 }
  let unsaved = 0
  if (targets.length > 0) {
    const scan = await callHelper(env, { cmd: 'scan', root: req.root, targets, maxBytes: cfg.maxBytes, maxFiles: fileLimit(cfg.maxFiles) }, HELPER_SCAN_MS)
    if (!scan || scan.ok !== true) return null
    if (scan.tooBig === true) return tooBigOutcome(scan)
    const missing = strings(scan.missing)
    targets = targets.filter(t => !missing.includes(t))
    planned = { files: count(scan.files), dirs: count(scan.dirs) }
    unsaved = (Array.isArray(scan.skipped) ? scan.skipped : []).filter(s => isObj(s) && s.reason !== 'symlink').length
  }
  const facts = await gitFacts(job)
  if (planned.files === 0 && planned.dirs === 0 && !hasGitState(req.risks, gitStateOf(facts, ID_PLACEHOLDER))) return { ok: false, reason: 'nothing', skipped: unsaved }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const createdAt = await nowOf(io)
    const id = newSnapshotId(createdAt, [...job.taken])
    const dir = snapshotDir(env.snapshotsRoot, key, id)
    // A folder that is there is not ours (another session, or debris): never copy into it, and never remove it.
    if (await io.stat(dir)) {
      await retake(job, id)
      continue
    }
    const base = baseOf(req, id, nextNumber(job.project.items), createdAt, 'node', targets, gitStateOf(facts, id), job.quiet)
    const answer = await callHelper(
      env,
      { cmd: 'copy', root: req.root, destDir: dir, targets, maxBytes: cfg.maxBytes, maxFiles: fileLimit(cfg.maxFiles), manifest: base },
      HELPER_RUN_MS,
    )
    if (answer && answer.ok === true && answer.tooBig === true) return tooBigOutcome(answer)
    // The helper refuses a folder that exists: another session took this id a moment ago. Once more with a fresh id and number.
    if (answer && answer.ok === false && typeof answer.error === 'string' && /already exists/.test(answer.error)) {
      await retake(job, id)
      continue
    }
    // The helper answers with a summary; the snapshot is what is on disk. When the answer was lost (a crash after the copy, an
    // answer cut off) the folder is still a complete snapshot if its manifest is there: use it, never make a second one.
    const m = answer === null || answer.ok === true ? await storedManifest(env, key, base) : null
    if (m) return commitNode(job, m, facts, answer ? Math.max(0, count(answer.skippedCount) - m.skipped.length) : 0)
    // A complete snapshot that is not ours is in the folder: another session took this id a moment ago. Leave it, take a fresh id.
    if (await holdsManifest(env, key, id)) {
      await retake(job, id)
      continue
    }
    await clearFolder(job, id)
    job.taken.add(id)
    return null
  }
  return null
}

type Walked = {
  files: { rel: string; abs: string; size: number; mtimeMs: number }[]
  dirs: string[]
  skipped: Skipped[]
  missing: string[]
  bytes: number
  entries: number
  tooBig: boolean
  /** Which limit tripped (the size when both did). */
  tooBigBy: 'bytes' | 'files'
}

/**
 * Lists what the targets hold with the engine's own calls: no links followed, bounded by the file and size limits. A `.env`-like
 * file (by its base name, also one found while walking a folder) is never copied here: the copy would be written with the default
 * permissions and the engine cannot make it private. It is skipped as `private`, and a folder that held nothing else is not
 * recorded as an empty folder (that would say something was saved).
 */
async function walkFs(io: IO, root: string, targets: string[], maxBytes: number, maxFiles: number): Promise<Walked> {
  const w: Walked = { files: [], dirs: [], skipped: [], missing: [], bytes: 0, entries: 0, tooBig: false, tooBigBy: 'files' }
  const limit = sizeLimit(maxBytes)
  const maxEntries = fileLimit(maxFiles)
  const walked: string[] = []
  const realRoot = (await io.stat(root, true))?.realPath
  const tick = (): void => {
    w.entries += 1
    if (w.entries > maxEntries) {
      w.tooBig = true
      if (w.bytes > limit) w.tooBigBy = 'bytes'
    }
  }
  const skip = (rel: string, reason: Skipped['reason']): void => {
    tick()
    w.skipped.push({ rel, reason })
  }
  // True when the file will be copied.
  const add = (rel: string, abs: string, size: number, mtimeMs: number): boolean => {
    tick()
    if (isEnvLike(baseName(rel))) {
      w.skipped.push({ rel, reason: 'private' })
      return false
    }
    if (size > MAX_FILE_BYTES) {
      w.skipped.push({ rel, reason: 'too-large' })
      return false
    }
    w.bytes += size
    w.files.push({ rel, abs, size, mtimeMs })
    if (w.bytes > limit) {
      w.tooBig = true
      w.tooBigBy = 'bytes'
    }
    return true
  }
  // A folder is recorded as an empty folder when nothing below it will be copied. Always true: it was handled.
  const walkDir = async (abs: string, rel: string, depth: number): Promise<boolean> => {
    walked.push(rel)
    tick()
    const entries = (await io.list(abs)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    let stored = false
    let hidden = false
    for (const e of entries) {
      if (w.tooBig) return true
      const childRel = `${rel}/${e.name}`
      if (!isSafeRelative(childRel)) skip(childRel, 'special')
      else if (e.isLink) skip(childRel, 'symlink')
      else if (e.kind === 'dir') {
        if (depth >= MAX_DEPTH) skip(childRel, 'limit')
        else if (await walkDir(joinPath(abs, e.name), childRel, depth + 1)) stored = true
      } else if (e.kind === 'file') {
        if (add(childRel, joinPath(abs, e.name), e.size, e.mtimeMs)) stored = true
        else if (isEnvLike(e.name)) hidden = true
      } else skip(childRel, 'special')
    }
    if (!stored && !hidden && !w.tooBig) w.dirs.push(rel)
    return true
  }
  for (const rel of targets) {
    if (w.tooBig) break
    if (walked.some(p => relUnder(p, rel))) continue
    const abs = joinPath(root, rel)
    const st = await io.stat(abs, true)
    if (!st) w.missing.push(rel)
    else if (st.isLink) skip(rel, 'symlink')
    else if (realRoot !== undefined && st.realPath !== undefined && !isInside(realRoot, st.realPath)) skip(rel, 'outside')
    else if (st.kind === 'file') add(rel, abs, st.size, st.mtimeMs)
    else if (st.kind === 'dir') await walkDir(abs, rel, 1)
    else skip(rel, 'special')
  }
  return w
}

/** Nothing was saved: 'private' when `.env`-like files were left out (they are the reason), else 'nothing'. */
const nothingSaved = (skipped: readonly Skipped[]): SnapshotOutcome =>
  skipped.some(s => s.reason === 'private') ? { ok: false, reason: 'private' } : { ok: false, reason: 'nothing', skipped: skipped.filter(s => s.reason !== 'symlink').length }

/** Backend 'fs': small UTF-8 text files copied through the engine's read and write. */
async function viaFs(job: Job): Promise<SnapshotOutcome> {
  const { env, req, cfg, key } = job
  const { io } = env
  const limit = sizeLimit(cfg.maxBytes)
  const walk = await walkFs(io, req.root, job.targets, cfg.maxBytes, fileLimit(cfg.maxFiles))
  if (walk.tooBig) return { ok: false, reason: 'too-big', bytes: walk.bytes, ...(walk.tooBigBy === 'files' ? { byFiles: true as const } : {}) }
  const targets = job.targets.filter(t => !walk.missing.includes(t))
  const facts = await gitFacts(job)
  if (walk.files.length === 0 && walk.dirs.length === 0 && !hasGitState(req.risks, gitStateOf(facts, ID_PLACEHOLDER))) return nothingSaved(walk.skipped)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const createdAt = await nowOf(io)
    const id = newSnapshotId(createdAt, [...job.taken])
    const dir = snapshotDir(env.snapshotsRoot, key, id)
    if (await io.stat(dir)) {
      await retake(job, id)
      continue
    }
    const written: string[] = []
    let created: string[] = []
    const giveUp = async (outcome: SnapshotOutcome): Promise<SnapshotOutcome> => {
      await undoWrites(io, written)
      await dropRefs(io, req.root, created)
      return outcome
    }
    try {
      const files: ManifestFile[] = []
      const skipped: Skipped[] = [...walk.skipped]
      let copied = 0
      for (const f of walk.files) {
        let bytes: Uint8Array | null = null
        try {
          bytes = decodeBase64(await io.readBase64(f.abs))
        } catch {
          bytes = null
        }
        if (!bytes) {
          skipped.push({ rel: f.rel, reason: 'unreadable' })
          continue
        }
        if (bytes.length > MAX_FILE_BYTES) {
          skipped.push({ rel: f.rel, reason: 'too-large' })
          continue
        }
        const text = decodeUtf8(bytes)
        if (text === null) {
          skipped.push({ rel: f.rel, reason: 'binary' })
          continue
        }
        copied += bytes.length
        if (copied > limit) return await giveUp({ ok: false, reason: 'too-big', bytes: copied })
        const to = storedPath(dir, f.rel)
        if (to === null) {
          skipped.push({ rel: f.rel, reason: 'special' })
          continue
        }
        written.push(to)
        await io.writeText(to, text)
        files.push({ rel: f.rel, size: bytes.length, mtimeMs: f.mtimeMs })
      }
      let git = gitStateOf(facts, id)
      if (files.length === 0 && walk.dirs.length === 0 && !hasGitState(req.risks, git)) {
        return await giveUp(nothingSaved(skipped))
      }
      const make = (): Manifest => buildManifest(baseOf(req, id, nextNumber(job.project.items), createdAt, 'fs', targets, git, job.quiet), { files, dirs: walk.dirs, skipped })
      let manifest = make()
      let text = serializeManifest(manifest)
      // The record itself (a name per file) is what is too long here, not the bytes: the words say files.
      if (new TextEncoder().encode(text).length > MAX_WRITE_BYTES) return await giveUp({ ok: false, reason: 'too-big', bytes: manifest.totalBytes, byFiles: true })
      if (!parseManifest(text)) return await giveUp({ ok: false, reason: 'failed' })
      // The copy is complete: only now are the git refs made (create-only; what this call made it alone may delete).
      if (facts) {
        const pinned = await pinGit(io, req.root, id, facts)
        created = pinned.created
        if (git?.ref !== undefined && pinned.info?.ref === undefined) {
          git = pinned.info
          manifest = make()
          text = serializeManifest(manifest)
        }
      }
      const parsed = parseManifest(text)
      if (!parsed) return await giveUp({ ok: false, reason: 'failed' })
      await io.writeText(joinPath(dir, MANIFEST_FILE), text)
      return await finish(job, parsed, outcomeOf(parsed))
    } catch {
      return await giveUp({ ok: false, reason: 'failed' })
    }
  }
  return { ok: false, reason: 'failed' }
}

/** A cut-off copy leaves no half snapshot: what was written is emptied, and no manifest is written, so nothing lists it. */
async function undoWrites(io: IO, written: string[]): Promise<void> {
  for (const p of written) {
    try {
      await io.writeText(p, '')
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Removing and pruning

/**
 * Makes a snapshot disappear: the helper deletes the folder; without it the files are emptied and a `pruned` marker hides it for
 * good. The snapshot's git refs go too, through `gitRoot` (the open project's folder; null: no git runs, which is the case for a
 * snapshot of any other project, and such a snapshot is only ever removed when it holds no git state).
 */
async function removeSnapshot(env: VaultEnv, key: string, m: Manifest, node: boolean, gitRoot: string | null): Promise<boolean> {
  const { io } = env
  const dir = snapshotDir(env.snapshotsRoot, key, m.id)
  let gone = false
  if (node) {
    const answer = await callHelper(env, { cmd: 'remove', snapshotsRoot: env.snapshotsRoot, projectKey: key, id: m.id }, HELPER_REMOVE_MS)
    gone = answer !== null && answer.ok === true
  }
  if (!gone) {
    try {
      await io.writeText(joinPath(dir, PRUNED_MARKER), 'pruned\n')
      gone = true
    } catch {
      return false
    }
    const paths = [...m.files.map(f => storedPath(dir, f.rel)).filter((p): p is string => p !== null), joinPath(dir, MANIFEST_FILE)]
    for (const p of paths) {
      try {
        const st = await io.stat(p)
        if (st && st.kind === 'file' && !st.isLink) await io.writeText(p, '')
      } catch {
        // the marker already hides it
      }
    }
  }
  if (m.git && gitRoot !== null) await dropRefs(io, gitRoot, refsOf(m.id, m.git))
  return gone
}

/** A snapshot that is still there, as the total cap sees it. */
type Held = { key: string; m: Manifest; id: string; createdAt: number; bytes: number; locked: boolean }

const heldOf = (key: string, m: Manifest, locked: boolean): Held => ({ key, m, id: m.id, createdAt: m.createdAt, bytes: m.totalBytes, locked })

/**
 * Deletes the oldest snapshots of `held` (the ones not `locked`) until what is left takes at most `cap` bytes. A snapshot that could
 * not be removed does not count as gone, so the next one goes instead. `stop` is asked before each removal (the sweep's time
 * budget). Returns how many were removed.
 */
async function evictToTotal(held: readonly Held[], cap: number, remove: (h: Held) => Promise<boolean>, stop: () => Promise<boolean>): Promise<number> {
  let total = held.reduce((sum, h) => sum + (Number.isFinite(h.bytes) && h.bytes > 0 ? h.bytes : 0), 0)
  let removed = 0
  for (const h of evictionOrder(held)) {
    if (total <= cap || (await stop())) break
    if (await remove(h)) {
      total -= Number.isFinite(h.bytes) && h.bytes > 0 ? h.bytes : 0
      removed += 1
    }
  }
  return removed
}

/**
 * Deletes snapshots by the plan of planPrune: older than `keepDays` (the newest too), and beyond the newest `keepCount` of all of
 * them together (the quiet ones go first). Then, when `cfg.maxTotalBytes` is set, the oldest of what is left until this project's
 * snapshots take no more than that. The ids in `protectIds` and the newest snapshot stay whatever the cap. Returns how many were pruned.
 */
export async function pruneSnapshots(env: VaultEnv, root: string, cfg: VaultCfg, protectIds: string[] = []): Promise<number> {
  try {
    if (!usableRoot(root)) return 0
    const { items } = await readProject(env, root)
    const protect = Array.isArray(protectIds) ? protectIds : []
    const doomed = planPrune(items, { keepCount: cfg?.keepCount, keepDays: cfg?.keepDays, nowMs: await nowOf(env.io), protectIds: protect })
    const cap = totalLimit(cfg?.maxTotalBytes)
    const key = projectKey(root)
    // What the plan leaves, as the cap sees it: the newest and the protected ones are never evicted for size.
    const heldAfter = (gone: ReadonlySet<string>): Held[] => {
      const left = items.filter(m => !gone.has(m.id))
      return left.map(m => heldOf(key, m, m === left[0] || protect.includes(m.id)))
    }
    const overCap = cap !== undefined && planTotalPrune(heldAfter(new Set(doomed)), cap).length > 0
    if (doomed.length === 0 && !overCap) return 0
    const node = await useNode(env)
    let pruned = 0
    const gone = new Set<string>()
    for (const id of doomed) {
      const m = items.find(x => x.id === id)
      if (m && (await removeSnapshot(env, key, m, node, root))) {
        pruned += 1
        gone.add(id)
      }
    }
    if (cap !== undefined && overCap) pruned += await evictToTotal(heldAfter(gone), cap, h => removeSnapshot(env, key, h.m, node, root), async () => false)
    return pruned
  } catch {
    return 0
  }
}

/** Files below `dir` (a bounded walk, links never followed): the stored copies of a snapshot whose manifest is gone. */
async function filesBelow(io: IO, dir: string, limit: number): Promise<string[]> {
  const out: string[] = []
  const walk = async (at: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= limit) return
    for (const e of await io.list(at)) {
      if (out.length >= limit) return
      if (e.isLink) continue
      if (e.kind === 'dir') await walk(joinPath(at, e.name), depth + 1)
      else if (e.kind === 'file') out.push(joinPath(at, e.name))
    }
  }
  await walk(dir, 0)
  return out
}

/** A snapshot folder with no readable manifest (a helper killed mid-copy): the helper removes it; without one its files are emptied and a marker hides it. */
async function removeOrphan(env: VaultEnv, key: string, id: string, node: boolean): Promise<boolean> {
  const { io } = env
  const dir = snapshotDir(env.snapshotsRoot, key, id)
  if (node) {
    const answer = await callHelper(env, { cmd: 'remove', snapshotsRoot: env.snapshotsRoot, projectKey: key, id }, HELPER_REMOVE_MS)
    if (answer !== null && answer.ok === true) return true
  }
  try {
    await io.writeText(joinPath(dir, PRUNED_MARKER), 'pruned\n')
  } catch {
    return false
  }
  for (const p of await filesBelow(io, dir, 5_000)) {
    try {
      if (!p.endsWith(`/${PRUNED_MARKER}`)) await io.writeText(p, '')
    } catch {
      // the marker already hides it
    }
  }
  return true
}

/**
 * The retention sweep for the whole snapshots folder, not only one project: every project folder (at most 200), the newest 500
 * snapshot folders of each, planned by the same planPrune. Git runs only in the open project (`currentRoot`) and only its own
 * snapshots lose their refs. Every other project is pruned only of the snapshots that hold no git state (file-only ones): one with
 * git refs is left alone until that project is open (the normal prune then removes it with its refs). A snapshot folder without a
 * valid manifest that is more than a day old is debris and goes too. After the per-project plans, when `cfg.maxTotalBytes` is set,
 * the oldest snapshots overall go until all of them together take no more than that; never `protectIds` (ids of the open project),
 * the newest snapshot of the open project, or the git-bearing ones of other projects. Errors are ignored; the sweep stops after a
 * minute. Returns how many were pruned. `currentRoot` (the open project) is swept first.
 */
export async function pruneAll(env: VaultEnv, cfg: VaultCfg, currentRoot?: string, protectIds: string[] = []): Promise<number> {
  let pruned = 0
  try {
    const { io } = env
    if (typeof env?.snapshotsRoot !== 'string' || !isAbsolute(env.snapshotsRoot)) return 0
    const started = await nowOf(io)
    const node = await useNode(env)
    const open = usableRoot(currentRoot) ? currentRoot : null
    const current = open === null ? '' : projectKey(open)
    const protect = Array.isArray(protectIds) ? protectIds : []
    const keys = (await io.list(env.snapshotsRoot))
      .filter(e => e.kind === 'dir' && !e.isLink && isProjectKey(e.name))
      .map(e => e.name)
      .sort((a, b) => (a === current ? -1 : b === current ? 1 : a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_PROJECTS)
    const rootOf = (key: string): string | null => (key === current ? open : null)
    const alive: { key: string; m: Manifest }[] = []
    for (const key of keys) {
      try {
        const ids = (await io.list(joinPath(env.snapshotsRoot, key)))
          .filter(e => e.kind === 'dir' && !e.isLink && isSnapshotId(e.name))
          .map(e => e.name)
          .sort()
          .reverse()
          .slice(0, MAX_PER_PROJECT)
        const items: Manifest[] = []
        const orphans: string[] = []
        for (const id of ids) {
          const m = await readManifest(env, key, id)
          if (m) items.push(m)
          else if (!(await io.stat(joinPath(env.snapshotsRoot, key, id, PRUNED_MARKER)))) orphans.push(id)
        }
        const now = await nowOf(io)
        const doomed = planPrune(items, { keepCount: cfg?.keepCount, keepDays: cfg?.keepDays, nowMs: now, protectIds: key === current ? protect : [] })
        const gone = new Set<string>()
        for (const id of doomed) {
          if (now - started > SWEEP_BUDGET_MS) return pruned
          const m = items.find(x => x.id === id)
          // Another project's snapshot that holds git refs waits until that project is open: no git runs outside it.
          if (!m || (key !== current && m.git !== undefined)) continue
          if (await removeSnapshot(env, key, m, node, rootOf(key))) {
            pruned += 1
            gone.add(id)
          }
        }
        for (const m of items) if (!gone.has(m.id)) alive.push({ key, m })
        for (const id of orphans) {
          if ((await nowOf(io)) - started > SWEEP_BUDGET_MS) return pruned
          const st = await io.stat(joinPath(env.snapshotsRoot, key, id))
          // Only a folder that is certainly not being made right now: an unknown age (no time) is left alone.
          if (st && st.kind === 'dir' && !st.isLink && st.mtimeMs > 0 && now - st.mtimeMs > ORPHAN_AGE_MS && (await removeOrphan(env, key, id, node))) pruned += 1
        }
      } catch {
        // one project's trouble does not stop the others
      }
    }
    const cap = totalLimit(cfg?.maxTotalBytes)
    if (cap !== undefined && alive.length > 0) {
      const newest = alive.filter(a => a.key === current).sort((a, b) => newestFirst(a.m, b.m))[0]?.m
      const held = alive.map(a => heldOf(a.key, a.m, a.m === newest || (a.key === current && protect.includes(a.m.id)) || (a.key !== current && a.m.git !== undefined)))
      pruned += await evictToTotal(held, cap, h => removeSnapshot(env, h.key, h.m, node, rootOf(h.key)), async () => (await nowOf(io)) - started > SWEEP_BUDGET_MS)
    }
  } catch {
    // housekeeping
  }
  return pruned
}

// ---------------------------------------------------------------------------------------------------------------------
// Restoring

function refusal(m: { id?: string; n?: number; createdAt?: number }, reason: NonNullable<RestoreOutcome['reason']>): RestoreOutcome {
  return { ok: false, restored: 0, failed: [], keptNewer: 0, at: m.createdAt ?? 0, id: m.id ?? '', n: m.n ?? 0, sample: [], hasUndo: false, git: [], reason }
}

/** The folders that hold the real path of `abs`'s nearest existing ancestor must lie inside the real root. */
async function landsInside(io: IO, realRoot: string | undefined, abs: string, root: string, cache: Map<string, boolean>): Promise<boolean> {
  if (realRoot === undefined) return false
  let at = dirName(abs)
  const chain: string[] = []
  for (let guard = 0; guard < 4096; guard += 1) {
    const known = cache.get(at)
    if (known !== undefined) {
      for (const c of chain) cache.set(c, known)
      return known
    }
    const st = await io.stat(at, true)
    if (st) {
      const ok = st.kind === 'dir' && st.realPath !== undefined && isInside(realRoot, st.realPath)
      cache.set(at, ok)
      for (const c of chain) cache.set(c, ok)
      return ok
    }
    chain.push(at)
    if (sameRoot(at, root) || !isInside(root, at)) return false
    at = dirName(at)
  }
  return false
}

type FsRestore = { restored: number; failed: { rel: string; reason: string }[]; keptNewer: number }

/** Restore with the engine's own file calls: text files only, nothing outside the real project root, no link written through. */
async function restoreViaFs(env: VaultEnv, root: string, m: Manifest, only?: ReadonlySet<string>): Promise<FsRestore> {
  const { io } = env
  const dir = snapshotDir(env.snapshotsRoot, projectKey(root), m.id)
  const realRoot = (await io.stat(root, true))?.realPath
  const cache = new Map<string, boolean>()
  const failed: { rel: string; reason: string }[] = []
  let restored = 0
  // Checks the place a file or folder would go; a reason when it must not be written.
  const refuse = async (rel: string, abs: string): Promise<string | null> => {
    if (!isSafeRelative(rel) || relativeTo(root, abs) === null) return 'outside'
    if (!(await landsInside(io, realRoot, abs, root, cache))) return 'outside'
    return null
  }
  for (const f of m.files) {
    if (only !== undefined && !only.has(f.rel)) continue
    try {
      const abs = joinPath(root, f.rel)
      const stored = storedPath(dir, f.rel)
      if (stored === null) {
        failed.push({ rel: f.rel, reason: 'outside' })
        continue
      }
      const why = await refuse(f.rel, abs)
      if (why) {
        failed.push({ rel: f.rel, reason: why })
        continue
      }
      const now = await io.stat(abs)
      if (now && now.isLink) {
        failed.push({ rel: f.rel, reason: 'symlink' })
        continue
      }
      if (now && now.kind !== 'file') {
        failed.push({ rel: f.rel, reason: 'blocked' })
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        failed.push({ rel: f.rel, reason: 'needs-node' })
        continue
      }
      let bytes: Uint8Array | null = null
      try {
        bytes = decodeBase64(await io.readBase64(stored))
      } catch {
        failed.push({ rel: f.rel, reason: 'missing' })
        continue
      }
      if (!bytes) {
        failed.push({ rel: f.rel, reason: 'corrupt' })
        continue
      }
      const text = decodeUtf8(bytes)
      if (text === null) {
        failed.push({ rel: f.rel, reason: 'needs-node' })
        continue
      }
      try {
        await io.writeText(abs, text)
        restored += 1
      } catch {
        failed.push({ rel: f.rel, reason: 'write-failed' })
      }
    } catch {
      failed.push({ rel: f.rel, reason: 'write-failed' })
    }
  }
  for (const rel of m.dirs) {
    if (only !== undefined && !only.has(rel)) continue
    try {
      const abs = joinPath(root, rel)
      const why = await refuse(rel, abs)
      if (why) {
        failed.push({ rel, reason: why })
        continue
      }
      const now = await io.stat(abs)
      if (now && !now.isLink && now.kind === 'dir') restored += 1
      else if (now) failed.push({ rel, reason: now.isLink ? 'symlink' : 'blocked' })
      else failed.push({ rel, reason: 'needs-node' }) // the engine cannot make an empty folder
    } catch {
      failed.push({ rel, reason: 'write-failed' })
    }
  }
  return { restored, failed, keptNewer: await countExtra(io, root, m) }
}

/** Items under a restored folder that the snapshot does not hold (bounded walk, links counted, never followed). */
async function countExtra(io: IO, root: string, m: Manifest): Promise<number> {
  try {
    const known = new Set(m.files.map(f => f.rel))
    const skipped = m.skipped.map(s => s.rel)
    const folders = m.targets.filter(t => m.dirs.some(d => relUnder(t, d)) || m.files.some(f => relUnder(t, f.rel) && f.rel !== t))
    let extra = 0
    let visited = 0
    const visit = async (abs: string, rel: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || visited > DEFAULT_MAX_FILES) return
      for (const e of await io.list(abs)) {
        visited += 1
        const childRel = `${rel}/${e.name}`
        if (e.kind === 'dir' && !e.isLink) await visit(joinPath(abs, e.name), childRel, depth + 1)
        else if (!known.has(childRel) && !skipped.some(s => relUnder(s, childRel))) extra += 1
      }
    }
    for (const t of folders) await visit(joinPath(root, t), t, 1)
    return extra
  } catch {
    return 0
  }
}

/** The undo point of a restore needs a limit of its own when the caller gives none: the default size, and no pruning. */
const undoCfg = (cfg: VaultCfg | undefined): VaultCfg => ({
  maxBytes: cfg?.maxBytes ?? DEFAULT_MAX_BYTES,
  ...(cfg
    ? { keepCount: cfg.keepCount, keepDays: cfg.keepDays, ...(cfg.maxTotalBytes !== undefined ? { maxTotalBytes: cfg.maxTotalBytes } : {}), ...(cfg.maxFiles !== undefined ? { maxFiles: cfg.maxFiles } : {}) }
    : NO_PRUNE),
})

/**
 * Puts a snapshot's files back. A snapshot of another project is refused; the manifest is read again from disk. Before anything is
 * written an undo point (kind 'before-restore') saves what is there now. When that is not possible nothing that exists is
 * overwritten: only the files and folders that are missing now are put back, and `leftAsIs` says how many were left alone. `cfg` is the plugin's options: without it the undo point has the default size limit and nothing is pruned.
 */
export async function restoreSnapshot(env: VaultEnv, root: string, m: Manifest, cfg?: VaultCfg): Promise<RestoreOutcome> {
  try {
    if (!usableRoot(root) || !isObj(m) || typeof m.root !== 'string' || !sameRoot(m.root, root)) return refusal(m ?? {}, 'other-project')
    const key = projectKey(root)
    const disk = isSnapshotId(m.id) ? await readManifest(env, key, m.id) : null
    if (!disk) return refusal(m, 'not-found')
    if (!sameRoot(disk.root, root)) return refusal(disk, 'other-project')
    // The undo point: what is there now at the places this restore writes to.
    const present: string[] = []
    for (const t of disk.targets) if (await env.io.stat(joinPath(root, t))) present.push(t)
    let hasUndo = false
    let keepExisting = false
    if (present.length > 0) {
      const undo = await createSnapshot(
        env,
        { root, tool: 'safety', command: `restore #${disk.n}`, risks: [{ kind: 'overwrite', tier: 'snapshot', label: 'restore', paths: [] }], targets: present, kind: 'before-restore', restoredFrom: disk.id, protectIds: [disk.id] },
        undoCfg(cfg),
      )
      hasUndo = undo.ok
      // Nothing to lose (only links, say) needs no undo point; anything else that could not be saved is never overwritten.
      keepExisting = !undo.ok && !(undo.reason === 'nothing' && !(typeof undo.skipped === 'number' && undo.skipped > 0))
    }
    let only: string[] | undefined
    let leftAsIs = 0
    if (keepExisting) {
      only = []
      for (const rel of [...disk.files.map(f => f.rel), ...disk.dirs]) {
        if (await env.io.stat(joinPath(root, rel))) leftAsIs += 1
        else only.push(rel)
      }
    }
    let result: FsRestore | null = null
    if (only !== undefined && only.length === 0) result = { restored: 0, failed: [], keptNewer: 0 }
    else if (await useNode(env)) {
      const answer = await callHelper(env, { cmd: 'restore', root, snapDir: snapshotDir(env.snapshotsRoot, key, disk.id), ...(only !== undefined ? { only } : {}) }, HELPER_RUN_MS)
      if (answer && answer.ok === true) {
        const failed = (Array.isArray(answer.failed) ? answer.failed : [])
          .filter((f): f is { rel: string; reason: string } => isObj(f) && typeof f.rel === 'string' && typeof f.reason === 'string')
          .map(f => ({ rel: safeCommandText(f.rel, 300), reason: safeCommandText(f.reason, 40) }))
        result = { restored: count(answer.restored) + count(answer.dirs), failed, keptNewer: count(answer.keptNewer) }
      }
    }
    result ??= await restoreViaFs(env, root, disk, only === undefined ? undefined : new Set(only))
    const bad = new Set(result.failed.map(f => f.rel))
    const picked = only === undefined ? undefined : new Set(only)
    const sample = [...disk.files.map(f => f.rel), ...disk.dirs].filter(rel => !bad.has(rel) && (picked === undefined || picked.has(rel))).slice(0, 5)
    return {
      ok: result.failed.length === 0 && leftAsIs === 0,
      restored: result.restored,
      failed: result.failed.slice(0, 500),
      keptNewer: result.keptNewer,
      at: disk.createdAt,
      id: disk.id,
      n: disk.n,
      sample,
      hasUndo,
      ...(leftAsIs > 0 ? { leftAsIs } : {}),
      ...(present.length === 0 ? { noneOverwritten: true as const } : {}),
      git: gitRestoreCommands(disk),
      ...(disk.git?.isPartial === true ? { gitPartial: true } : {}),
    }
  } catch {
    return refusal(isObj(m) ? m : {}, 'failed')
  }
}

/**
 * Takes back the last restore: restores the newest 'before-restore' snapshot (which saves the present state first, so a second
 * undo is a redo) and, when that went without a failure, removes the undo point it used. null when there is none.
 */
export async function undoRestore(env: VaultEnv, root: string, cfg?: VaultCfg): Promise<RestoreOutcome | null> {
  try {
    const point = (await listSnapshots(env, root)).find(m => m.kind === 'before-restore')
    if (!point) return null
    const outcome = await restoreSnapshot(env, root, point, cfg)
    if (outcome.ok) await removeSnapshot(env, projectKey(root), point, await useNode(env), root)
    return outcome
  } catch {
    return refusal({}, 'failed')
  }
}
