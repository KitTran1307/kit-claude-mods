// The snapshot model of Safety Net: what a snapshot is on disk and every pure rule around it. No engine calls and no Node, so
// all of it is unit-tested directly (snapshot.test.ts). vault.ts (engine-bound) and scripts/safety-fs.mjs (Node helper) both
// work to the layout and the manifest defined here; they are the two ways of making the same snapshot:
//
//   <snapshotsRoot>/<projectKey>/<id>/manifest.json        the manifest (serializeManifest / parseManifest)
//   <snapshotsRoot>/<projectKey>/<id>/files/<rel>          a copy of every saved file; <rel> is relative to the project
//                                                          root, `/` separators (isSafeRelative holds for every one)
//
// `<snapshotsRoot>` is `<config folder>/kit-safety/snapshots`. Backend 'node' = scripts/safety-fs.mjs copied the files
// (binary-safe, sha256 per file); backend 'fs' = the plugin copied small text files with $.fs.read / $.fs.write (no hashes).
// Everything read back from disk goes through parseManifest first: a hostile or damaged manifest never reaches a path.
import { baseName, isAbsolute, isFilesystemRoot, isSafeRelative, isWindowsPath, joinPath, normalizePath } from './paths'

// ---- types ----

export type GitInfo = {
  head: string | null
  branch: string | null
  /** The ref that keeps the stash commit alive (see gitSafetyRef), when the plugin made one. */
  ref?: string
  /** Commit made by `git stash create`: the uncommitted changes at snapshot time. */
  stashSha?: string
  /** Git state was asked for, HEAD exists, and `git stash create` failed (an unfinished merge, a time-out): the uncommitted changes are NOT saved. */
  isPartial?: boolean
  /**
   * Tips git would lose: the branches a `git branch -D` would delete, and (`remote: true`, named `<remote>/<branch>`) the remote
   * branches a force push would overwrite.
   */
  branches?: { name: string; sha: string; remote?: boolean }[]
}

export type ManifestFile = { rel: string; size: number; mtimeMs: number; mode?: number; sha256?: string }

/**
 * Why something was not saved. `rel` is for display only: it is never joined to a path. `private` is a `.env`-like file the
 * text-only backend does not copy (the copy would get the default permissions and cannot be made private); the Node helper
 * never produces it (it keeps the mode and makes every folder 0700).
 */
export type SkipReason = 'symlink' | 'binary' | 'too-large' | 'unreadable' | 'outside' | 'special' | 'limit' | 'private'
export type Skipped = { rel: string; reason: SkipReason }

export type ManifestKind = 'before-command' | 'before-restore'

export type Manifest = {
  v: 1
  id: string
  /** The number the person sees (`#7`): one more than the highest in the project. */
  n: number
  createdAt: number
  root: string
  /** before-restore = the undo point `/safety undo` uses. */
  kind: ManifestKind
  tool: string
  /**
   * Made by a call whose every risk was only worth a quiet snapshot (an edit of an untracked file): when a project holds more
   * snapshots than it keeps, these go first (planPrune), so a run of quiet edits never pushes out the snapshot of a deleted
   * folder while quiet ones remain. The command text is never stored.
   */
  quiet?: boolean
  risks: { kind: string; label: string; name?: string }[]
  /** Top-level rel paths the call would touch (files or folders). */
  targets: string[]
  backend: 'node' | 'fs'
  files: ManifestFile[]
  /** Empty folders (a folder with files is recreated by its files). */
  dirs: string[]
  skipped: Skipped[]
  totalBytes: number
  git?: GitInfo
  restoredFrom?: string
}

export type ManifestBase = Omit<Manifest, 'files' | 'dirs' | 'skipped' | 'totalBytes'>

export type SnapshotSummary = {
  id: string
  n: number
  createdAt: number
  kind: ManifestKind
  files: number
  bytes: number
  /** First risk's label, else the tool name. */
  label: string
  /** True when gitRestoreCommands has something to offer. */
  hasGit: boolean
  /** Git was asked for the uncommitted changes and could not save them (see GitInfo.isPartial). Only set when true. */
  gitPartial?: boolean
  /** A quiet snapshot (see Manifest.quiet). */
  quiet?: boolean
}

// ---- constants ----

export const MANIFEST_VERSION = 1
export const MANIFEST_FILE = 'manifest.json'
export const FILES_DIR = 'files'
/** Most files one snapshot holds unless the caller says otherwise (limitReached). */
export const DEFAULT_MAX_FILES = 50_000
/** Used only when a size limit is not a number at all. */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024
export const DEFAULT_KEEP_COUNT = 20
export const DEFAULT_KEEP_DAYS = 14

const DAY_MS = 86_400_000
const MAX_TIME = 8.64e15
const MAX_SIZE = 2 ** 50
const MAX_TOTAL = 2 ** 53 - 1
const MAX_N = 1_000_000_000
const MAX_ENTRIES = 200_000
const MAX_REL = 4096
const MAX_MANIFEST_CHARS = 64 * 1024 * 1024
const SKIP_REASONS: readonly string[] = ['symlink', 'binary', 'too-large', 'unreadable', 'outside', 'special', 'limit', 'private']
const KINDS: readonly string[] = ['before-command', 'before-restore']

const ID_RE = /^\d{8}T\d{6}Z(?:-[1-9]\d{0,5})?$/
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}-[0-9a-f]{14}$/
const SHA256_RE = /^[0-9a-f]{64}$/i
const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i
const GIT_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/

// ---- ids and keys ----

/** `20261124T093015Z` or, when that second was taken, `20261124T093015Z-2`. */
export function isSnapshotId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 30 && ID_RE.test(s)
}

/** `<slug>-<14 hex>` as projectKey makes it. */
export function isProjectKey(s: unknown): s is string {
  return typeof s === 'string' && KEY_RE.test(s)
}

/** 64 bits of a string hash (two 32-bit lanes of the cyrb53 family) as 16 hex characters. Stable, not cryptographic. */
function hash64(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

function slugOf(name: string): string {
  let s = name
  try {
    s = s.normalize('NFD')
  } catch {
    // keep the name as it is
  }
  s = s.replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '')
  return s || 'project'
}

/**
 * The folder name of a project inside the snapshots folder: the readable last folder name plus 14 hex characters of a
 * hash of the whole normalized root, so two projects with the same folder name never share snapshots. Windows-style
 * roots hash in lower case (`C:\Work\App` and `c:/work/app` are one project). Never throws.
 */
export function projectKey(root: string): string {
  const text = typeof root === 'string' ? root : ''
  const norm = normalizePath(text)
  const keyed = isWindowsPath(text) ? norm.toLowerCase() : norm
  return `${slugOf(baseName(norm))}-${hash64(keyed).slice(0, 14)}`
}

/** `YYYYMMDDTHHMMSSZ` from the UTC clock; `-2`, `-3`... is appended while that id is in `existingIds`. */
export function newSnapshotId(nowMs: number, existingIds: readonly string[]): string {
  const ms = typeof nowMs === 'number' && Number.isFinite(nowMs) ? Math.min(253_402_300_799_000, Math.max(0, nowMs)) : 0
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const base =
    `${String(d.getUTCFullYear()).padStart(4, '0')}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}` +
    `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
  const taken = new Set(Array.isArray(existingIds) ? existingIds : [])
  if (!taken.has(base)) return base
  for (let i = 2; ; i += 1) {
    const id = `${base}-${i}`
    if (!taken.has(id)) return id
  }
}

/** One more than the highest `n`, 1 when there is none. Entries that are not usable numbers are ignored. */
export function nextNumber(existing: readonly { n: number }[]): number {
  let max = 0
  if (Array.isArray(existing)) {
    for (const e of existing) {
      const n = e && typeof e.n === 'number' && Number.isFinite(e.n) ? Math.min(MAX_N, Math.floor(e.n)) : 0
      if (n > max) max = n
    }
  }
  return max + 1
}

/** `<snapshotsRoot>/<key>/<id>`, normalized. */
export function snapshotDir(snapshotsRoot: string, key: string, id: string): string {
  return joinPath(snapshotsRoot, key, id)
}

/** Where the copy of `rel` lives inside a snapshot folder, or null when `rel` is not a safe relative path. */
export function storedPath(snapDir: string, rel: string): string | null {
  return isSafeRelative(rel) ? joinPath(snapDir, FILES_DIR, rel) : null
}

/** True when `rel` is `parent` or below it (both safe relative paths, `/` separators). */
export function relUnder(parent: string, rel: string): boolean {
  return rel === parent || rel.startsWith(parent + '/')
}

/** `refs/kit-safety/<id>`: the ref that keeps a snapshot's stash commit from being cleaned up by git. */
export function gitSafetyRef(id: string): string {
  return `refs/kit-safety/${id}`
}

// ---- text ----

// Bidi controls and zero-width characters change what a line looks like without showing: removed outright.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g
const CONTROL_OR_SPACE = /[\s\u0000-\u001F\u007F-\u009F]+/g

/** One line of at most `max` characters: whitespace and control characters become one space, invisible controls go, cut with `…`. */
export function safeCommandText(text: string, max = 500): string {
  if (typeof text !== 'string') return ''
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 500
  if (limit === 0) return ''
  const cut = text.length > 1_000_000
  const clean = (cut ? text.slice(0, 1_000_000) : text).replace(INVISIBLE, '').replace(CONTROL_OR_SPACE, ' ').trim()
  if (clean === '') return ''
  if (!cut && clean.length <= limit) return clean
  const chars = Array.from(clean)
  if (!cut && chars.length <= limit) return chars.join('')
  return limit === 1 ? '…' : `${chars.slice(0, limit - 1).join('').trimEnd()}…`
}

/** `0 B`, `512 B`, `1.4 KB`, `18 MB`, `1.2 GB`: one decimal below 10 (a trailing `.0` is dropped), none from 10 up. */
export function formatBytes(n: number): string {
  const bytes = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  const shown = (v: number) => (v < 10 ? Number(v.toFixed(1)) : Math.round(v))
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 1023.9 KB rounds to 1024: that reads better as 1 MB.
  if (shown(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${shown(value)} ${units[unit]}`
}

/** Local time as `HH:mm`, 24 hours, zero-padded; `--:--` when `ms` is not a time. */
export function formatClock(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** True when a snapshot has outgrown a limit (strictly more than allowed). A limit that is not a number falls back to its default. */
export function limitReached(totals: { bytes: number; files: number }, maxBytes: number, maxFiles: number = DEFAULT_MAX_FILES): boolean {
  const bytes = typeof totals?.bytes === 'number' && !Number.isNaN(totals.bytes) ? totals.bytes : 0
  const files = typeof totals?.files === 'number' && !Number.isNaN(totals.files) ? totals.files : 0
  const byteLimit = typeof maxBytes === 'number' && !Number.isNaN(maxBytes) ? maxBytes : DEFAULT_MAX_BYTES
  const fileLimit = typeof maxFiles === 'number' && !Number.isNaN(maxFiles) ? maxFiles : DEFAULT_MAX_FILES
  return bytes > byteLimit || files > fileLimit
}

// ---- manifest ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A number clamped into [min, max]; null for a non-number or NaN (Infinity clamps). */
function clampNum(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null
  return Math.min(max, Math.max(min, v))
}

function cleanRoot(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 4096 || /[\u0000-\u001F\u007F]/.test(v)) return null
  if (!isAbsolute(v) || isFilesystemRoot(v)) return null
  if (v.split(/[\\/]/).some(seg => seg === '..' || seg === '.')) return null
  return v
}

function cleanRelList(v: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(v)) return out
  const seen = new Set<string>()
  for (const item of v) {
    if (out.length >= MAX_ENTRIES) break
    if (typeof item !== 'string' || item.length > MAX_REL || !isSafeRelative(item) || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function cleanFiles(v: unknown): ManifestFile[] {
  const out: ManifestFile[] = []
  if (!Array.isArray(v)) return out
  const seen = new Set<string>()
  for (const item of v) {
    if (out.length >= MAX_ENTRIES) break
    if (!isObj(item)) continue
    const rel = item.rel
    if (typeof rel !== 'string' || rel.length > MAX_REL || !isSafeRelative(rel) || seen.has(rel)) continue
    const size = clampNum(item.size, 0, MAX_SIZE)
    const mtimeMs = clampNum(item.mtimeMs, 0, MAX_TIME)
    if (size === null || mtimeMs === null) continue
    seen.add(rel)
    const file: ManifestFile = { rel, size: Math.floor(size), mtimeMs }
    const mode = item.mode
    if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0 && mode <= 0o7777) file.mode = mode
    const sha = item.sha256
    if (typeof sha === 'string' && SHA256_RE.test(sha)) file.sha256 = sha.toLowerCase()
    out.push(file)
  }
  return out
}

function cleanSkipped(v: unknown): Skipped[] {
  const out: Skipped[] = []
  if (!Array.isArray(v)) return out
  for (const item of v) {
    if (out.length >= MAX_ENTRIES) break
    if (!isObj(item) || typeof item.rel !== 'string' || typeof item.reason !== 'string' || !SKIP_REASONS.includes(item.reason)) continue
    const rel = safeCommandText(item.rel, 300)
    if (rel) out.push({ rel, reason: item.reason as SkipReason })
  }
  return out
}

function cleanRisks(v: unknown): Manifest['risks'] {
  const out: Manifest['risks'] = []
  if (!Array.isArray(v)) return out
  for (const item of v) {
    if (out.length >= 20) break
    if (!isObj(item) || typeof item.kind !== 'string' || typeof item.label !== 'string') continue
    const kind = safeCommandText(item.kind, 40)
    const label = safeCommandText(item.label, 120)
    if (!kind || !label) continue
    const risk: Manifest['risks'][number] = { kind, label }
    const name = typeof item.name === 'string' ? safeCommandText(item.name, 200) : ''
    if (name) risk.name = name
    out.push(risk)
  }
  return out
}

/** A git ref, branch or sha as it may appear in a command we print: plain characters only, never an option, never `..`. */
function safeGitName(v: unknown): string | null {
  if (typeof v !== 'string' || !GIT_NAME_RE.test(v)) return null
  if (v.startsWith('-') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.') || v.includes('..') || v.includes('//')) return null
  return v
}

// A name git accepts for a ref and that holds nothing that could hide or act inside a command: no control, invisible or bidi
// characters, no space, none of `~ ^ : ? * [ \`, no `..`, `@{` or `//`, no leading `-` or `/`, no trailing `/`, `.` or `.lock`.
// Letters of any script are fine (`fix/lỗi-đăng-nhập`). Names that pass are pinned; only the strict ones are ever printed (safeGitName).
const REF_BAD = /[\u0000- \u007F-\u009F~^:?*[\\\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/

/** True for a branch or remote name that is safe to hand to git as one argument and to keep in a manifest (not to print). */
export function looseRefName(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200 || REF_BAD.test(v)) return false
  if (v.includes('..') || v.includes('@{') || v.includes('//')) return false
  return !(v.startsWith('-') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.') || v.endsWith('.lock'))
}

function cleanGit(v: unknown): GitInfo | undefined {
  if (!isObj(v)) return undefined
  const git: GitInfo = { head: safeGitName(v.head), branch: safeGitName(v.branch) }
  const ref = safeGitName(v.ref)
  if (ref) git.ref = ref
  if (typeof v.stashSha === 'string' && GIT_SHA_RE.test(v.stashSha)) git.stashSha = v.stashSha.toLowerCase()
  if (v.isPartial === true) git.isPartial = true
  if (Array.isArray(v.branches)) {
    const branches: NonNullable<GitInfo['branches']> = []
    for (const b of v.branches) {
      if (branches.length >= 100) break
      if (!isObj(b) || !looseRefName(b.name) || typeof b.sha !== 'string' || !GIT_SHA_RE.test(b.sha)) continue
      const entry: NonNullable<GitInfo['branches']>[number] = { name: b.name, sha: b.sha.toLowerCase() }
      if (b.remote === true) entry.remote = true
      branches.push(entry)
    }
    if (branches.length > 0) git.branches = branches
  }
  return git
}

function parseUnsafe(text: string): Manifest | null {
  if (typeof text !== 'string' || text.length > MAX_MANIFEST_CHARS) return null
  const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (!isObj(raw) || raw.v !== MANIFEST_VERSION) return null
  const id = raw.id
  if (!isSnapshotId(id)) return null
  const n = clampNum(raw.n, 1, MAX_N)
  const createdAt = clampNum(raw.createdAt, 0, MAX_TIME)
  const root = cleanRoot(raw.root)
  if (n === null || createdAt === null || root === null) return null
  const kind = raw.kind
  const backend = raw.backend
  if (typeof kind !== 'string' || !KINDS.includes(kind) || (backend !== 'node' && backend !== 'fs')) return null
  if (typeof raw.tool !== 'string') return null
  const files = cleanFiles(raw.files)
  const sum = files.reduce((total, f) => Math.min(MAX_TOTAL, total + f.size), 0)
  const manifest: Manifest = {
    v: 1,
    id,
    n: Math.floor(n),
    createdAt,
    root,
    kind: kind as ManifestKind,
    tool: safeCommandText(raw.tool, 100),
    risks: cleanRisks(raw.risks),
    targets: cleanRelList(raw.targets),
    backend,
    files,
    dirs: cleanRelList(raw.dirs),
    skipped: cleanSkipped(raw.skipped),
    totalBytes: Math.floor(clampNum(raw.totalBytes, 0, MAX_TOTAL) ?? sum),
  }
  // An old manifest may still carry a `command` field: it is dropped here, the command text is never kept.
  if (raw.quiet === true) manifest.quiet = true
  const git = cleanGit(raw.git)
  if (git) manifest.git = git
  if (isSnapshotId(raw.restoredFrom)) manifest.restoredFrom = raw.restoredFrom
  return manifest
}

/**
 * Reads a manifest's text. Returns null for anything that is not a valid manifest of version 1 (bad JSON, wrong types,
 * a wrong `v`, an id or root that does not look right). Entries that are not safe are dropped, not repaired: a file or
 * folder whose `rel` fails isSafeRelative, a file with no usable size, a duplicate. Sizes are clamped, unknown fields are
 * left behind (the result is built field by field), text is made one clean line. Never throws.
 */
export function parseManifest(text: string): Manifest | null {
  try {
    return parseUnsafe(text)
  } catch {
    return null
  }
}

/** The manifest as text: fixed key order, 2-space indent, a final newline. */
export function serializeManifest(m: Manifest): string {
  const ordered: Record<string, unknown> = {
    v: m.v,
    id: m.id,
    n: m.n,
    createdAt: m.createdAt,
    root: m.root,
    kind: m.kind,
    tool: m.tool,
  }
  if (m.quiet === true) ordered.quiet = true
  ordered.risks = m.risks.map(r => (r.name === undefined ? { kind: r.kind, label: r.label } : { kind: r.kind, label: r.label, name: r.name }))
  ordered.targets = m.targets
  ordered.backend = m.backend
  ordered.files = m.files.map(f => {
    const file: Record<string, unknown> = { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs }
    if (f.mode !== undefined) file.mode = f.mode
    if (f.sha256 !== undefined) file.sha256 = f.sha256
    return file
  })
  ordered.dirs = m.dirs
  ordered.skipped = m.skipped.map(s => ({ rel: s.rel, reason: s.reason }))
  ordered.totalBytes = m.totalBytes
  if (m.git) {
    const git: Record<string, unknown> = { head: m.git.head, branch: m.git.branch }
    if (m.git.ref !== undefined) git.ref = m.git.ref
    if (m.git.stashSha !== undefined) git.stashSha = m.git.stashSha
    if (m.git.isPartial === true) git.isPartial = true
    if (m.git.branches !== undefined) git.branches = m.git.branches.map(b => (b.remote === true ? { name: b.name, sha: b.sha, remote: true } : { name: b.name, sha: b.sha }))
    ordered.git = git
  }
  if (m.restoredFrom !== undefined) ordered.restoredFrom = m.restoredFrom
  return `${JSON.stringify(ordered, null, 2)}\n`
}

const byRel = (a: { rel: string }, b: { rel: string }) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)

/** The finished manifest of the 'fs' backend: files and folders sorted for a stable file, `totalBytes` summed. */
export function buildManifest(base: ManifestBase, parts: { files: ManifestFile[]; dirs: string[]; skipped: Skipped[] }): Manifest {
  const files = [...parts.files].sort(byRel)
  return {
    ...base,
    files,
    dirs: [...parts.dirs].sort(),
    skipped: [...parts.skipped],
    totalBytes: files.reduce((total, f) => total + f.size, 0),
  }
}

/** The one-line facts the list shows. */
export function summarize(m: Manifest): SnapshotSummary {
  const summary: SnapshotSummary = {
    id: m.id,
    n: m.n,
    createdAt: m.createdAt,
    kind: m.kind,
    files: m.files.length,
    bytes: m.totalBytes,
    label: m.risks[0]?.label || m.tool,
    hasGit: gitRestoreCommands(m).length > 0,
  }
  if (m.quiet === true) summary.quiet = true
  if (m.git?.isPartial === true) summary.gitPartial = true
  return summary
}

// ---- pruning ----

function atLeastOne(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback
  return Math.max(1, Math.floor(v))
}

/**
 * Which snapshots to delete. First the age rule: everything older than `keepDays` goes (the newest included: age wins). Then the
 * count rule: the quiet and the asked-about snapshots that are left are counted TOGETHER, newest first; every unprotected one
 * beyond the newest `keepCount` has to go, but WHICH ones go is chosen quiet first (oldest first) and only then asked-about
 * (oldest first), so a flurry of quiet edits never evicts the snapshot of a deleted folder while quiet ones remain. The ids in
 * `protectIds` (the new snapshot, the undo point, the one being restored) are never in the answer; they take their place in the
 * count like any other, so a protected one that is old leaves the project with more than `keepCount`. A count or a number of days
 * below 1 counts as 1; one that is not a number falls back to its default; an `nowMs` that is not a number turns the age rule
 * off. Oldest first.
 */
export function planPrune(
  list: readonly { id: string; createdAt: number; kind?: string; quiet?: boolean }[],
  opts: { keepCount: number; keepDays: number; nowMs: number; protectIds?: readonly string[] },
): string[] {
  if (!Array.isArray(list)) return []
  const keepCount = atLeastOne(opts?.keepCount, DEFAULT_KEEP_COUNT)
  const keepDays = atLeastOne(opts?.keepDays, DEFAULT_KEEP_DAYS)
  const cutoff = typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs - keepDays * DAY_MS : -Infinity
  const protect = new Set(Array.isArray(opts?.protectIds) ? opts.protectIds : [])
  const time = (e: { createdAt: number }) => (typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0)
  const sorted = list
    .filter(e => e && typeof e.id === 'string')
    .sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const seen = new Set<string>()
  const doomed: { id: string; at: number }[] = []
  // What the age rule leaves, newest first: the ones the count rule is about.
  const live: typeof sorted = []
  for (const entry of sorted) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    if (time(entry) < cutoff) {
      if (!protect.has(entry.id)) doomed.push({ id: entry.id, at: time(entry) })
    } else {
      live.push(entry)
    }
  }
  let excess = live.slice(keepCount).filter(e => !protect.has(e.id)).length
  if (excess > 0) {
    const spare = live.filter(e => !protect.has(e.id)).reverse() // oldest first
    for (const entry of [...spare.filter(e => e.quiet === true), ...spare.filter(e => e.quiet !== true)]) {
      if (excess <= 0) break
      doomed.push({ id: entry.id, at: time(entry) })
      excess -= 1
    }
  }
  return doomed.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(d => d.id)
}

// ---- the total cap over all snapshots ----

/** A snapshot as the total cap sees it. `locked` ones count toward the total but are never evicted. */
export type Evictable = { id: string; createdAt: number; bytes: number; locked?: boolean }

/** A total cap as a positive number of bytes, or undefined for "no cap" (not a number, 0 or below, Infinity). */
export function totalLimit(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(1, Math.floor(v)) : undefined
}

const bytesOf = (e: { bytes: number }): number => (typeof e?.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes > 0 ? e.bytes : 0)
const timeOf = (e: { createdAt: number }): number => (typeof e?.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0)

/** The snapshots that may be evicted (not `locked`), the oldest overall first; equal times keep the order of `list`. Never changes `list`. */
export function evictionOrder<T extends Evictable>(list: readonly T[]): T[] {
  if (!Array.isArray(list)) return []
  return list.filter(e => e && typeof e.id === 'string' && e.locked !== true).sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * What to delete so that all snapshots together take at most `maxTotalBytes` (a size in bytes, as the manifests say): the oldest
 * overall first, skipping the `locked` ones (their bytes still count), no more than needed. A cap that is not a positive number
 * means no cap. A cap smaller than what the locked ones take alone deletes every other snapshot and stops there.
 */
export function planTotalPrune<T extends Evictable>(list: readonly T[], maxTotalBytes: number | undefined): T[] {
  const cap = totalLimit(maxTotalBytes)
  if (cap === undefined || !Array.isArray(list)) return []
  let total = 0
  for (const e of list) if (e && typeof e.id === 'string') total += bytesOf(e)
  const out: T[] = []
  for (const e of evictionOrder(list)) {
    if (total <= cap) break
    out.push(e)
    total -= bytesOf(e)
  }
  return out
}

// ---- globs ----

type Token = { t: 'lit'; c: string } | { t: 'any' } | { t: 'star' } | { t: 'set'; neg: boolean; ranges: [number, number][] }

const MAX_GLOB = 8192

function compileGlob(pattern: string): Token[] {
  const chars = Array.from(pattern)
  const tokens: Token[] = []
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!
    if (ch === '*') {
      if (tokens[tokens.length - 1]?.t !== 'star') tokens.push({ t: 'star' })
    } else if (ch === '?') {
      tokens.push({ t: 'any' })
    } else if (ch === '[') {
      let j = i + 1
      let neg = false
      if (chars[j] === '!' || chars[j] === '^') {
        neg = true
        j += 1
      }
      const start = j
      if (chars[j] === ']') j += 1 // a `]` right after the opening is a member
      while (j < chars.length && chars[j] !== ']') j += 1
      if (j >= chars.length) {
        tokens.push({ t: 'lit', c: '[' }) // no closing bracket: a plain `[`
      } else {
        const items = chars.slice(start, j)
        const ranges: [number, number][] = []
        for (let k = 0; k < items.length; ) {
          const lo = items[k]!.codePointAt(0)!
          if (items[k + 1] === '-' && k + 2 < items.length) {
            ranges.push([lo, items[k + 2]!.codePointAt(0)!])
            k += 3
          } else {
            ranges.push([lo, lo])
            k += 1
          }
        }
        tokens.push({ t: 'set', neg, ranges })
        i = j
      }
    } else {
      tokens.push({ t: 'lit', c: ch })
    }
  }
  return tokens
}

function tokenAccepts(tok: Token, ch: string): boolean {
  if (tok.t === 'lit') return tok.c === ch
  if (tok.t === 'any') return true
  if (tok.t === 'set') {
    const cp = ch.codePointAt(0)!
    const inside = tok.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)
    return inside !== tok.neg
  }
  return false
}

/** True when a path has a wildcard in it: `*`, `?` or a complete `[...]`. A lone `[` is an ordinary character. */
export function hasGlob(path: string): boolean {
  if (typeof path !== 'string' || path.length > MAX_GLOB) return false
  return path.split(/[\\/]/).some(seg => compileGlob(seg).some(t => t.t !== 'lit'))
}

/**
 * Splits a path at its first wildcard segment (both `/` and `\` separate segments; there are no escapes). `base` is the part
 * before it, written with `/` (`.` when the path starts with a wildcard, `/` for one directly under the root); `segments` is
 * the rest, each still a pattern or a plain name. Without a wildcard, `base` is the whole path and `segments` is empty.
 */
export function splitGlob(path: string): { base: string; segments: string[] } {
  if (typeof path !== 'string') return { base: '.', segments: [] }
  const segs = path.split(/[\\/]/)
  const at = segs.findIndex(seg => compileGlob(seg).some(t => t.t !== 'lit'))
  if (at < 0) return { base: segs.join('/'), segments: [] }
  const lead = segs.slice(0, at)
  let base: string
  if (lead.length === 0) base = '.'
  else if (lead.length === 1 && lead[0] === '') base = '/'
  else if (lead.length === 1 && /^[A-Za-z]:$/.test(lead[0]!)) base = `${lead[0]}/`
  else base = lead.join('/')
  return { base, segments: segs.slice(at).filter(seg => seg !== '') }
}

/** The folder part of a wildcard path: everything before the first wildcard segment (see splitGlob). */
export function globBase(path: string): string {
  return splitGlob(path).base
}

/**
 * Does one file or folder name match a wildcard pattern? `*` is any run of characters (also none), `?` one character,
 * `[abc]`, `[a-z]`, `[!x]` (or `[^x]`) a set. Case-sensitive; no `**`; a name has no `/`. Like a shell, a name that starts
 * with `.` is matched only by a pattern that starts with a literal `.`, unless `dotfiles` is true.
 */
export function matchGlob(pattern: string, name: string, opts: { dotfiles?: boolean } = {}): boolean {
  if (typeof pattern !== 'string' || typeof name !== 'string') return false
  if (pattern.length > MAX_GLOB || name.length > MAX_GLOB || name.includes('/')) return false
  const tokens = compileGlob(pattern)
  const chars = Array.from(name)
  if (!opts?.dotfiles && chars[0] === '.') {
    const first = tokens[0]
    if (!first || first.t !== 'lit' || first.c !== '.') return false
  }
  let t = 0
  let c = 0
  let starAt = -1
  let starChar = 0
  while (c < chars.length) {
    const tok = tokens[t]
    if (tok && tok.t === 'star') {
      starAt = t
      t += 1
      starChar = c
    } else if (tok && tokenAccepts(tok, chars[c]!)) {
      t += 1
      c += 1
    } else if (starAt >= 0) {
      t = starAt + 1
      starChar += 1
      c = starChar
    } else {
      return false
    }
  }
  while (tokens[t]?.t === 'star') t += 1
  return t === tokens.length
}

// ---- git recovery ----

/** The commands that bring back a force-pushed-over remote branch name it `<branch>-before-force-push`. */
const FORCE_PUSH_SUFFIX = '-before-force-push'

/** True for the hint that offers the remote branch a force push overwrote as a local branch (`git branch main-before-force-push <sha>`). */
export function isOverwrittenBranchHint(command: unknown): boolean {
  return typeof command === 'string' && /^git branch [A-Za-z0-9._/-]+-before-force-push [0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(command)
}

/** True for the read-only hint that lists the saved branch tips whose names are not fit to print (`git for-each-ref refs/kit-safety/<id>.b`). */
export function isTipListHint(command: unknown): boolean {
  return typeof command === 'string' && /^git for-each-ref refs\/kit-safety\/\d{8}T\d{6}Z(?:-[1-9]\d{0,5})?\.b$/.test(command)
}

/**
 * The exact commands that bring back what git threw away, for the person to copy: the plugin never runs them. Which commands
 * depend on what the call was: `git stash apply` for a reset or a discard (when a stash was made), `git branch <name> <sha>` for
 * every deleted branch, `git branch <name>-before-force-push <sha>` for the remote branch a force push overwrote, and a hint for
 * the head the project was on before a reset; a plain `rm -rf` offers none of them, and neither does a force push that pinned no
 * remote tip (it throws nothing local away, so the head is no hint for it). When Git could not save the uncommitted changes
 * (`isPartial`) there is no stash and no head hint: nothing about them is promised. Only refs, branch names and shas made of
 * letters, digits and `. _ / -` are printed (nothing needs quoting); an entry with any other character, or one that starts with
 * `-`, is left out. When a tip is pinned whose name cannot be printed (`feat+x`, `fix/lỗi`) one read-only line that lists the saved
 * tips takes its place (`git for-each-ref refs/kit-safety/<id>.b`). So the answer is empty exactly when nothing can be brought back.
 */
export function gitRestoreCommands(m: Manifest): { label: 'stash' | 'branch' | 'head'; command: string }[] {
  const out: { label: 'stash' | 'branch' | 'head'; command: string }[] = []
  const git = m?.git
  if (!git) return out
  const kinds = new Set<unknown>((Array.isArray(m.risks) ? m.risks : []).map(r => r?.kind))
  const partial = git.isPartial === true
  const ref = safeGitName(git.ref)
  const stash = typeof git.stashSha === 'string' && GIT_SHA_RE.test(git.stashSha) ? git.stashSha : null
  if (!partial && (kinds.has('reset-hard') || kinds.has('discard'))) {
    if (ref) out.push({ label: 'stash', command: `git stash apply ${ref}` })
    else if (stash) out.push({ label: 'stash', command: `git stash apply ${stash}` })
  }
  const tips = Array.isArray(git.branches) ? git.branches : []
  // A tip that is kept (a sha, a name git takes) but whose name cannot be printed has no command of its own.
  let unprinted = 0
  const isKept = (b: { name?: unknown; sha?: unknown } | undefined): boolean => looseRefName(b?.name) && typeof b?.sha === 'string' && GIT_SHA_RE.test(b.sha)
  if (kinds.has('branch-delete')) {
    for (const b of tips) {
      if (b?.remote === true) continue
      const name = safeGitName(b?.name)
      if (name && typeof b.sha === 'string' && GIT_SHA_RE.test(b.sha)) out.push({ label: 'branch', command: `git branch ${name} ${b.sha}` })
      else if (isKept(b)) unprinted += 1
    }
  }
  if (kinds.has('force-push')) {
    for (const b of tips) {
      if (b?.remote !== true) continue
      const name = safeGitName(b.name)
      const rest = name === null ? '' : name.slice(name.indexOf('/') + 1)
      const local = name !== null && name.includes('/') ? safeGitName(`${rest}${FORCE_PUSH_SUFFIX}`) : null
      if (local && typeof b.sha === 'string' && GIT_SHA_RE.test(b.sha)) out.push({ label: 'branch', command: `git branch ${local} ${b.sha}` })
      else if (isKept(b)) unprinted += 1
    }
  }
  const head = safeGitName(git.head)
  if (!partial && head && kinds.has('reset-hard')) out.push({ label: 'head', command: `git checkout ${head}` })
  if (unprinted > 0 && isSnapshotId(m.id)) out.push({ label: 'branch', command: `git for-each-ref ${gitSafetyRef(m.id)}.b` })
  return out
}
