// From a tool call to "what is risky and what would be lost": reads the call (risk.ts says what kind of danger it is), then looks at
// the real folder to find the files a snapshot has to save. Talks to the world through the IO of vault.ts only, so it is tested
// with an in-memory fake. Nothing here changes anything: the only commands it runs are `git rev-parse`, `ls-files` and `check-ignore`
// (all through gitRun, which switches `core.fsmonitor` off: a hostile repository's config never runs code here).
//
// Rules that hold for every target it returns:
//   - it is a project-relative path with `/` separators (isSafeRelative), and it exists now;
//   - it lies inside the project root by spelling AND by real location (a symlinked folder that leads out is dropped);
//   - a symbolic link is never a target (deleting a link loses no data); a Write/Edit through a link targets the file it reaches;
//   - no target is inside another target.
// A `delete` that only takes folders a build makes again (`rm -rf node_modules`) or things Git ignores is made quiet, see "Everyday cleanups".
// A path that is the project root or one of its ancestors (`rm -rf ..`, `cd .. && rm -rf *`) means "the whole project": the
// targets become the root's own top-level entries without `.git` (git is covered by the stash ref), never anything outside it.
import { isAbsolute, isFilesystemRoot, isInside, isSafeRelative, joinPath, normalizePath, relativeTo, resolvePath } from './paths'
import { classifyBash, classifyFile, envDiff, isEnvLike } from './risk'
import type { EnvDiff } from './risk'
import { DEFAULT_MAX_FILES, hasGlob, matchGlob, splitGlob } from './snapshot'
import type { Risk } from './types'
import { gitRun, nowOf } from './vault'
import type { IO, IOStat } from './vault'

export type Place = { root: string; cwd: string; home: string; realRoot?: string }
export type Assessment = {
  /** Empty = nothing to do. Risks with only `tier: 'snapshot'` stay: the caller decides whether to ask. */
  risks: Risk[]
  /** Project-relative paths to snapshot. */
  targets: string[]
  /** Some path could not be resolved from its spelling, or a list was cut short. */
  isUnknown: boolean
  /** For an overwrite of a `.env`-like file whose new content is known: which variables go and come. Names only. */
  env?: EnvDiff
  isGit: boolean
  /**
   * A `delete` covers the whole project and so the repository's own `.git` folder, which is not copied (Git keeps its refs there):
   * unpushed commits, local branches and stashes go with it and no snapshot can bring them back. The band says so.
   */
  losesGit?: true
  /**
   * True exactly when at least one `delete` was made quiet (see "Everyday cleanups" below) and no risk of tier `ask` is left in
   * `risks`: the call is only a cleanup of things that are cheap to regenerate, so the caller saves a small snapshot (a few
   * thousand files, a few dozen MB) and gives up silently when the folder is bigger, instead of interrupting the work.
   */
  cheap: boolean
}

export const SNAPSHOT_LIMITS = { maxFiles: DEFAULT_MAX_FILES }

const WATCHED: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const MAX_MATCHES = 5_000
const MAX_ENV_BYTES = 256 * 1024
const MAX_BRACE = 100
const TTL_REPO_MS = 10 * 60_000
const TTL_NO_REPO_MS = 30_000

/** The tools whose calls are looked at. */
export function isWatched(tool: string): boolean {
  return typeof tool === 'string' && WATCHED.has(tool)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const emptyAssessment = (): Assessment => ({ risks: [], targets: [], isUnknown: false, isGit: false, cheap: false })

// ---------------------------------------------------------------------------------------------------------------------
// git facts

const repoCache = new Map<string, { isRepo: boolean; until: number }>()

/** Forgets what was learned about repositories (tests, and a plugin reload). */
export function resetGuardCache(): void {
  repoCache.clear()
}

/** `git rev-parse --is-inside-work-tree` for the project root, remembered for a while (longer when it is a repository). */
async function isGitRepo(io: IO, root: string): Promise<boolean> {
  const key = normalizePath(root)
  const now = await nowOf(io)
  const hit = repoCache.get(key)
  if (hit && hit.until > now) return hit.isRepo
  const r = await gitRun(io, root, ['rev-parse', '--is-inside-work-tree'])
  const isRepo = r.ok && r.out.trim() === 'true'
  if (repoCache.size >= 100) repoCache.delete(repoCache.keys().next().value as string)
  repoCache.set(key, { isRepo, until: now + (isRepo ? TTL_REPO_MS : TTL_NO_REPO_MS) })
  return isRepo
}

/** 0 = yes, 1 = no, anything else (not a repository, git missing, a failure) = undefined. */
const yesNo = (code: number): boolean | undefined => (code === 0 ? true : code === 1 ? false : undefined)

/**
 * Whether git tracks the file, and when it does not, whether it ignores it. `ls-files` reads its argument as a pathspec, so the
 * file name is taken literally (`--literal-pathspecs`); `check-ignore` reads plain pathnames and refuses that option.
 */
async function trackedAndIgnored(io: IO, root: string, rel: string): Promise<{ isTracked: boolean | undefined; isIgnored: boolean | undefined }> {
  const tracked = yesNo((await gitRun(io, root, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel])).code)
  if (tracked !== false) return { isTracked: tracked, isIgnored: undefined }
  return { isTracked: false, isIgnored: yesNo((await gitRun(io, root, ['check-ignore', '-q', '--', rel])).code) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Where things are

type Ctx = {
  io: IO
  root: string
  realRoot: string
  home: string
  cwd: string
  /** The project root is not a folder we may take snapshots of (a filesystem root, or not absolute). */
  isBlocked: boolean
  /** The whole project is too much to save: the root is a filesystem root or the home folder. */
  noWhole: boolean
  left: number
  isCut: boolean
  /** Something inside the project exists but cannot be written as a safe relative path (a name with a backslash or "c:" on macOS/Linux): it cannot be snapshotted, so the call is never taken for harmless. */
  isOdd: boolean
  /** The whole-project listing met the project's own `.git` and left it out. */
  sawGit: boolean
}

async function makeCtx(io: IO, place: Place): Promise<Ctx> {
  const root = typeof place.root === 'string' ? place.root : ''
  const usable = isAbsolute(root) && !isFilesystemRoot(root)
  const realRoot = place.realRoot ?? (usable ? (await io.stat(root, true))?.realPath : undefined) ?? normalizePath(root)
  const home = typeof place.home === 'string' ? place.home : ''
  return {
    io,
    root,
    realRoot,
    home,
    cwd: typeof place.cwd === 'string' && isAbsolute(place.cwd) ? place.cwd : root,
    isBlocked: !usable,
    noWhole: !usable || (home !== '' && normalizePath(home) === normalizePath(root)),
    left: MAX_MATCHES,
    isCut: false,
    isOdd: false,
    sawGit: false,
  }
}

/** A thing found on disk: where it is spelled, where it really is when known, and what it is. */
type Found = { abs: string; real?: string; kind: IOStat['kind']; isLink: boolean }

/**
 * `rel` below the root for a found thing: by its real location when that is known (a link inside the project then counts as the
 * file it reaches, one that leads out counts as outside), else by its spelling; null when it is outside.
 */
function relOf(f: Found, ctx: Ctx): string | null {
  const rel = f.real !== undefined ? relativeTo(ctx.realRoot, f.real) : relativeTo(ctx.root, f.abs)
  return rel === null || rel === '' || !isSafeRelative(rel) ? null : rel
}

/** True for a thing that is inside the project but whose path cannot be written safely (see Ctx.isOdd). */
function isOddInside(f: Found, ctx: Ctx): boolean {
  const rel = f.real !== undefined ? relativeTo(ctx.realRoot, f.real) : relativeTo(ctx.root, f.abs)
  return rel !== null && rel !== '' && !isSafeRelative(rel)
}

/** The root's own top-level entries, `.git` left out (the whole project as targets). */
async function wholeProject(ctx: Ctx): Promise<string[]> {
  if (ctx.noWhole) return []
  const out: string[] = []
  for (const e of await ctx.io.list(ctx.root)) {
    if (e.name === '.git') {
      ctx.sawGit = true
      continue
    }
    if (e.isLink || e.kind === 'other') continue
    if (!isSafeRelative(e.name)) {
      ctx.isOdd = true
      continue
    }
    if (out.length >= MAX_MATCHES) {
      ctx.isCut = true
      break
    }
    out.push(e.name)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Braces and wildcards

function splitTop(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(from, i))
      from = i + 1
    }
  }
  parts.push(body.slice(from))
  return parts
}

/** The alternatives of the first brace group in `s` that expands (`{a,b}`, `{1..3}`, `{a..c}`), or undefined when there is none. */
function braceOnce(s: string): string[] | undefined {
  let from = 0
  while (from < s.length) {
    const open = s.indexOf('{', from)
    if (open < 0) return undefined
    let depth = 0
    let close = -1
    for (let k = open; k < s.length; k += 1) {
      if (s[k] === '{') depth += 1
      else if (s[k] === '}') {
        depth -= 1
        if (depth === 0) {
          close = k
          break
        }
      }
    }
    if (close < 0) return undefined
    const body = s.slice(open + 1, close)
    let alts: string[] | null = null
    const parts = splitTop(body)
    if (parts.length > 1) alts = parts
    else {
      const num = /^(-?\d{1,6})\.\.(-?\d{1,6})$/.exec(body)
      const chr = /^([A-Za-z])\.\.([A-Za-z])$/.exec(body)
      if (num) {
        const a = Number(num[1])
        const b = Number(num[2])
        if (Math.abs(b - a) <= MAX_BRACE) alts = Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => String(a <= b ? a + i : a - i))
        else alts = Array.from({ length: MAX_BRACE + 2 }, (_, i) => String(i)) // too many: the caller gives up
      } else if (chr) {
        const a = chr[1]!.charCodeAt(0)
        const b = chr[2]!.charCodeAt(0)
        alts = Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => String.fromCharCode(a <= b ? a + i : a - i))
      }
    }
    if (alts) return alts.map(alt => s.slice(0, open) + alt + s.slice(close + 1))
    from = open + 1
  }
  return undefined
}

/** Brace lists written out like a shell does (`a/{b,c}` is `a/b` and `a/c`), at most `max` of them; null when there would be more. */
export function expandBraces(text: string, max = MAX_BRACE): string[] | null {
  if (typeof text !== 'string' || text.length > 4096) return null
  let out = [text]
  for (let round = 0; round < 64; round += 1) {
    const next: string[] = []
    let changed = false
    for (const s of out) {
      const alts = braceOnce(s)
      if (alts) {
        changed = true
        next.push(...alts)
      } else next.push(s)
      if (next.length > max) return null
    }
    out = next
    if (!changed) return out
  }
  return null
}

type Step = { abs: string; real: string; listed: boolean }

/**
 * Expands a wildcard path one folder level at a time with `io.list`: only real folders are walked into (links are not followed),
 * and a name that starts with `.` is matched only by a pattern that does. A base outside the project (and not above it) is not read.
 */
async function expandGlob(pattern: string, ctx: Ctx): Promise<Found[]> {
  const { io } = ctx
  const { base, segments } = splitGlob(pattern)
  const baseAbs = resolvePath(ctx.cwd, base, ctx.home)
  if (baseAbs === null) throw new Error('unresolvable')
  const baseStat = await io.stat(baseAbs, true)
  if (!baseStat || baseStat.kind !== 'dir') return []
  // Inside the project by spelling or by where it really is; a spelling inside that really leads out is not read.
  const realInside = baseStat.realPath !== undefined ? isInside(ctx.realRoot, baseStat.realPath) : undefined
  const inRoot = isInside(ctx.root, baseAbs) ? realInside !== false : realInside === true
  if (!inRoot && !isInside(baseAbs, ctx.root)) return []
  let frontier: Step[] = [{ abs: baseAbs, real: baseStat.realPath ?? baseAbs, listed: true }]
  const found: Found[] = []
  for (const [index, seg] of segments.entries()) {
    const last = index === segments.length - 1
    const next: Step[] = []
    if (!hasGlob(seg)) {
      for (const f of frontier) next.push({ abs: joinPath(f.abs, seg), real: joinPath(f.real, seg), listed: false })
      frontier = next
      continue
    }
    for (const f of frontier) {
      if (!f.listed) {
        // A folder named without a wildcard, reached after one: it must be a real folder, not a link.
        const st = await io.stat(f.abs)
        if (!st || st.kind !== 'dir' || st.isLink) continue
      }
      const entries = (await io.list(f.abs)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const e of entries) {
        if (!matchGlob(seg, e.name)) continue
        if (ctx.left <= 0) {
          ctx.isCut = true
          return found
        }
        const child = { abs: joinPath(f.abs, e.name), real: joinPath(f.real, e.name) }
        if (last) {
          ctx.left -= 1
          found.push({ ...child, kind: e.kind, isLink: e.isLink })
        } else if (e.kind === 'dir' && !e.isLink) next.push({ ...child, listed: true })
      }
    }
    frontier = next
  }
  // Names written without a wildcard after the last one (`*/dist`) are checked one by one.
  for (const f of frontier) {
    if (f.listed) continue
    const st = await io.stat(f.abs, true)
    if (st) found.push({ abs: f.abs, ...(st.realPath !== undefined ? { real: st.realPath } : {}), kind: st.kind, isLink: st.isLink })
  }
  return found
}

/** Everything one path of a risk stands for: braces written out, wildcards expanded, plain names looked up. */
async function resolveOperand(p: string, ctx: Ctx): Promise<{ found: Found[]; isUnknown: boolean }> {
  const variants = expandBraces(p)
  if (variants === null) return { found: [], isUnknown: true }
  const found: Found[] = []
  let isUnknown = false
  for (const v of variants) {
    try {
      if (hasGlob(v)) {
        found.push(...(await expandGlob(v, ctx)))
        continue
      }
      const abs = resolvePath(ctx.cwd, v, ctx.home)
      if (abs === null) {
        isUnknown = true
        continue
      }
      const st = await ctx.io.stat(abs, true)
      if (st) found.push({ abs, ...(st.realPath !== undefined ? { real: st.realPath } : {}), kind: st.kind, isLink: st.isLink })
    } catch {
      isUnknown = true
    }
  }
  return { found, isUnknown }
}

/** The project-relative targets of a list of found things; `kinds` says which kinds count ('file', or also 'dir'). */
async function targetsOf(found: Found[], ctx: Ctx, kinds: 'files' | 'any'): Promise<string[]> {
  const out: string[] = []
  let whole = false
  for (const f of found) {
    if (ctx.isBlocked) continue
    if (isInside(f.abs, ctx.root)) {
      // The root itself or a folder above it: the whole project. (Replacing a file never means that.)
      if (kinds === 'any' && f.kind === 'dir') whole = true
      continue
    }
    if (f.isLink || f.kind === 'other' || (kinds === 'files' && f.kind !== 'file')) continue
    const rel = relOf(f, ctx)
    if (rel !== null) out.push(rel)
    else if (isOddInside(f, ctx)) ctx.isOdd = true
  }
  if (whole) out.push(...(await wholeProject(ctx)))
  return out
}

/** Untracked files `git clean` would delete (ignored ones too with `-x`, only those with `-X`), as project-relative paths. */
async function untrackedFiles(ctx: Ctx, label: string): Promise<string[] | null> {
  const flags = label.split(/\s+/).filter(t => /^-[A-Za-z]+$/.test(t)).join('')
  const mode = flags.includes('X') ? ['--ignored', '--exclude-standard'] : flags.includes('x') ? [] : ['--exclude-standard']
  const r = await gitRun(ctx.io, ctx.root, ['ls-files', '--others', '--directory', '-z', ...mode])
  if (!r.ok) return null
  const out: string[] = []
  for (const raw of r.out.split('\0')) {
    const rel = raw.replace(/\/+$/, '')
    if (rel === '') continue
    if (!isSafeRelative(rel)) {
      ctx.isOdd = true
      continue
    }
    if (out.length >= MAX_MATCHES) {
      ctx.isCut = true
      break
    }
    out.push(rel)
  }
  return out
}

/** Drops duplicates and every path that is inside another one. */
function reduceTargets(list: string[]): string[] {
  const sorted = [...new Set(list)].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
  const kept: string[] = []
  const seen = new Set<string>()
  for (const rel of sorted) {
    // Parents come first (fewer segments), so one lookup per ancestor says whether a kept path holds this one.
    const parts = rel.split('/')
    let isHeld = false
    for (let i = 1; i < parts.length && !isHeld; i += 1) isHeld = seen.has(parts.slice(0, i).join('/'))
    if (isHeld) continue
    kept.push(rel)
    seen.add(rel)
  }
  return kept
}

// ---------------------------------------------------------------------------------------------------------------------
// Everyday cleanups
//
// `rm -rf node_modules` or `rm -rf dist` is part of ordinary work. Asking about it every time teaches people to press Allow without
// reading, which makes the questions that matter worthless. So a `delete` becomes quiet (tier `snapshot`: saved, not asked about)
// when EVERY top-level target it names
//   - is not `.env`-like: a secrets file is never quiet, whatever Git says about it (it is often ignored, and it exists nowhere else);
//   - and is either a folder named exactly like one of REGENERABLE_FOLDERS (its last path segment, at any depth, so
//     `packages/a/node_modules` counts and `my-build` or a plain file called `build` does not), or is ignored by Git.
// Names alone are a guess, so they are used with no Git needed (a project without a repository still gets quiet cleanups); the Git
// rule needs a repository and an answer from `git check-ignore` for the target, otherwise the person is asked as before.
//
// An ignored folder is not always cheap to regenerate: it can hold local data that lives nowhere else (a database file, uploads,
// notes). That is the compromise: the call is flagged `cheap` and the caller saves a SMALL snapshot (about 2 000 files, 50 MB) and
// silently gives up when the folder is bigger. A 100 000-file `node_modules` is never walked here: this code only stats the target
// and asks Git, it does not list a folder it makes quiet.
//
// Never quiet, however the names look: a path that could not be read from its spelling, a pattern that reaches anything not covered
// by the rule, the project root or a folder above it (`rm -rf .`, `..`, `*` in the root: the whole project), a link, a path outside
// the project (nothing of it is saved), a pattern or list that was cut short, and a risk that is not a `delete` (`unparsed`...).

/** Folders that a build, an install or a run makes again. Matched by exact name. */
export const REGENERABLE_FOLDERS: readonly string[] = ['node_modules', 'dist', 'build', '.next', '.cache', 'target', '__pycache__', 'coverage']
const REGENERABLE: ReadonlySet<string> = new Set(REGENERABLE_FOLDERS)
/** More targets than this that need Git's answer (a wide pattern): not worth a long command line, the person is asked. */
const MAX_IGNORE_ASKS = 100
const MAX_IGNORE_CHARS = 16_000

/** A pattern segment that matches nearly anything (`*`, `.*`, `?*`, `[!.]*`): it lists a whole folder. */
const matchesAnything = (seg: string): boolean => seg.replace(/\[[^\]]*\]/g, '').replace(/[*?.]/g, '') === ''

/** True when a path of the risk lists a whole folder that is the project root or above it (`*`, `./*`, `../*`, `.*`). */
function listsRootFolder(paths: readonly string[], ctx: Ctx): boolean {
  for (const p of paths) {
    for (const v of expandBraces(p) ?? []) {
      if (!hasGlob(v)) continue
      const { base, segments } = splitGlob(v)
      const last = segments[0]
      if (segments.length !== 1 || last === undefined || !matchesAnything(last)) continue
      const abs = resolvePath(ctx.cwd, base, ctx.home)
      if (abs !== null && isInside(abs, ctx.root)) return true
    }
  }
  return false
}

/** Which of `rels` (project-relative, `/` separators) Git ignores: one `check-ignore` for all of them; null when Git cannot say. */
async function ignoredAmong(ctx: Ctx, rels: string[]): Promise<Set<string> | null> {
  if (rels.length > MAX_IGNORE_ASKS || rels.reduce((n, r) => n + r.length + 1, 0) > MAX_IGNORE_CHARS) return null
  // Exit 0: some are ignored (they are printed, NUL-ended with -z); 1: none; anything else: no answer. `--` keeps a name that
  // starts with `-` a name. Git never reports a tracked file as ignored. Only the ignored ones count: no answer is not "ignored".
  const r = await gitRun(ctx.io, ctx.root, ['check-ignore', '-z', '--', ...rels])
  if (r.code !== 0 && r.code !== 1) return null
  return new Set(r.out.split('\0').filter(x => x !== ''))
}

/** Whether a `delete` that was resolved to `things` is an everyday cleanup (see above). Stats and Git only: it never lists a folder. */
async function isCheapDelete(paths: readonly string[], things: Found[], ctx: Ctx, isGit: boolean): Promise<boolean> {
  if (ctx.isBlocked || things.length === 0 || listsRootFolder(paths, ctx)) return false
  const isDir = new Map<string, boolean>()
  for (const f of things) {
    // The root or a folder above it is the whole project; a link or an odd thing is not a plain file or folder.
    if (isInside(f.abs, ctx.root) || f.isLink || f.kind === 'other') return false
    // Outside the project nothing is saved, so the person is asked. Any `.env`-like name in the list keeps the question.
    const rel = relOf(f, ctx)
    if (rel === null || isEnvLike(rel)) return false
    isDir.set(rel, f.kind === 'dir')
  }
  const top = reduceTargets([...isDir.keys()])
  const rest = top.filter(rel => !(isDir.get(rel) === true && REGENERABLE.has(rel.slice(rel.lastIndexOf('/') + 1))))
  if (rest.length === 0) return true
  if (!isGit) return false
  const ignored = await ignoredAmong(ctx, rest)
  return ignored !== null && rest.every(rel => ignored.has(rel))
}

// ---------------------------------------------------------------------------------------------------------------------
// New text of a .env file

/** The text after one edit, or null when it is not clear what the edit does (`old` absent or more than once without `replace_all`). */
function applyEdit(text: string, edit: unknown): string | null {
  if (!isObj(edit) || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || edit.old_string === '') return null
  const parts = text.split(edit.old_string)
  if (edit.replace_all === true) return parts.length > 1 ? parts.join(edit.new_string) : null
  return parts.length === 2 ? parts[0] + edit.new_string + parts[1] : null
}

async function readSmall(io: IO, abs: string, size: number): Promise<string | null> {
  if (size > MAX_ENV_BYTES) return null
  try {
    return await io.readText(abs)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Write / Edit

async function assessFile(io: IO, tool: string, input: Record<string, unknown>, place: Place): Promise<Assessment> {
  const out = emptyAssessment()
  const raw = tool === 'NotebookEdit' ? input.notebook_path : input.file_path
  if (typeof raw !== 'string' || raw === '') return out
  const abs = resolvePath(typeof place.cwd === 'string' ? place.cwd : '', raw, place.home)
  if (abs === null) {
    out.isUnknown = true
    return out
  }
  const ctx = await makeCtx(io, place)
  if (ctx.isBlocked) return out
  // A file that is not there (or is a folder) loses nothing.
  const st = await io.stat(abs, true)
  if (!st || st.kind !== 'file') return out
  const f: Found = { abs, ...(st.realPath !== undefined ? { real: st.realPath } : {}), kind: st.kind, isLink: false }
  // Through a link the tool writes the file the link reaches: that one is what would be lost (relOf uses the real place).
  const rel = relOf(f, ctx)
  if (rel === null) return out
  const isEnv = isEnvLike(rel)
  const isGit = await isGitRepo(io, ctx.root)
  out.isGit = isGit
  const git = isEnv || !isGit ? { isTracked: undefined, isIgnored: undefined } : await trackedAndIgnored(io, ctx.root, rel)
  const risk = classifyFile(tool, rel, { isInsideRoot: true, exists: true, ...git })
  if (!risk) return out
  out.risks = [risk]
  out.targets = [rel]
  if (isEnv) {
    const before = await readSmall(io, abs, st.size)
    const after = before === null ? null : newText(tool, input, before)
    if (before !== null && after !== null) out.env = envDiff(before, after)
  }
  return out
}

/** What a Write/Edit/MultiEdit leaves in the file, when that can be told; null otherwise. */
function newText(tool: string, input: Record<string, unknown>, before: string): string | null {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : null
  if (tool === 'Edit') return applyEdit(before, input)
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let text: string | null = before
    for (const edit of input.edits.slice(0, 100)) {
      text = applyEdit(text, edit)
      if (text === null) return null
    }
    return text
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Bash / PowerShell

async function assessCommand(io: IO, input: Record<string, unknown>, place: Place): Promise<Assessment> {
  const command = input.command
  if (typeof command !== 'string' || command === '') return emptyAssessment()
  return await assessRisks(io, classifyBash(command, { cwd: place.cwd, root: place.root, home: place.home }), place)
}

/**
 * What the risks of a command would take with them. Risks that carry no files of their own (`unparsed`: a command too long or
 * too tangled to read to the end; git risks; `db-drop` of a network database) stay as risks with no targets: they are asked about,
 * and the snapshot covers what git can undo. A `delete` of everyday regenerable things comes back with tier `snapshot` (and `cheap`
 * set when nothing is left to ask), see "Everyday cleanups". Exported so a hand-made risk list can be assessed without a command text.
 */
export async function assessRisks(io: IO, list: Risk[], place: Place): Promise<Assessment> {
  const out = emptyAssessment()
  const found = Array.isArray(list) ? list.filter((r): r is Risk => isObj(r)) : []
  if (found.length === 0) return out
  out.risks = found
  out.isUnknown = found.some(r => r.hasUnknownPath === true)
  try {
    const ctx = await makeCtx(io, place)
    out.isGit = ctx.isBlocked ? false : await isGitRepo(io, ctx.root)
    const kept: Risk[] = []
    const targets: string[] = []
    let quiet = 0
    for (const risk of found) {
      let rels: string[] = []
      let shown = risk
      ctx.sawGit = false
      // A `discard` that names files (`git checkout -- src/a.ts`) copies them too: uncommitted changes are the data it destroys.
      if ((risk.kind === 'delete' || risk.kind === 'overwrite' || risk.kind === 'db-drop' || risk.kind === 'discard') && Array.isArray(risk.paths) && risk.paths.length > 0) {
        const things: Found[] = []
        let isGuess = false
        for (const p of risk.paths) {
          const r = await resolveOperand(p, ctx)
          things.push(...r.found)
          if (r.isUnknown) {
            out.isUnknown = true
            isGuess = true
          }
        }
        rels = await targetsOf(things, ctx, risk.kind === 'overwrite' ? 'files' : 'any')
        if (risk.kind === 'delete' && ctx.sawGit) out.losesGit = true
        // Replacing a file that is not there yet loses nothing.
        if (risk.kind === 'overwrite' && rels.length === 0) continue
        if (risk.kind === 'overwrite' && out.env === undefined) out.env = await envOfOverwrite(io, risk, rels, ctx)
        // A list that was cut short (here or earlier) may hold what the rule would not cover: it is never made quiet.
        if (risk.kind === 'delete' && risk.tier === 'ask' && risk.hasUnknownPath !== true && !isGuess && !ctx.isCut && !ctx.isOdd && (await isCheapDelete(risk.paths, things, ctx, out.isGit))) {
          shown = { ...risk, tier: 'snapshot' }
          quiet += 1
        }
      } else if (risk.kind === 'clean' && out.isGit && !ctx.isBlocked) {
        const files = await untrackedFiles(ctx, risk.label)
        if (files === null) out.isUnknown = true
        else rels = files
      }
      kept.push(shown)
      targets.push(...rels)
    }
    out.risks = kept
    out.targets = reduceTargets(targets)
    out.cheap = quiet > 0 && kept.every(r => r.tier !== 'ask')
    if (ctx.isCut || ctx.isOdd) out.isUnknown = true
  } catch {
    out.isUnknown = true
  }
  return out
}

/** For `cp new.env .env` / `mv`: which variables the replacement drops and adds. Only when the source file can be read. */
async function envOfOverwrite(io: IO, risk: Risk, rels: string[], ctx: Ctx): Promise<EnvDiff | undefined> {
  const rel = rels.find(r => isEnvLike(r))
  if (rel === undefined || risk.source === undefined) return undefined
  const sourceAbs = resolvePath(ctx.cwd, risk.source, ctx.home)
  if (sourceAbs === null) return undefined
  const targetAbs = joinPath(ctx.realRoot, rel)
  const [source, target] = await Promise.all([io.stat(sourceAbs), io.stat(targetAbs)])
  if (!source || source.kind !== 'file' || !target || target.kind !== 'file') return undefined
  const after = await readSmall(io, sourceAbs, source.size)
  const before = await readSmall(io, targetAbs, target.size)
  return before !== null && after !== null ? envDiff(before, after) : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point

/**
 * What a tool call would do and what would be lost. `risks` empty means nothing to do. Never throws: a step that fails gives
 * fewer targets (and `isUnknown`), not an exception.
 */
export async function assess(io: IO, call: { tool: string; input: Record<string, unknown> }, place: Place): Promise<Assessment> {
  try {
    const tool = call?.tool
    const input = isObj(call?.input) ? call.input : {}
    if (!isWatched(tool) || !isObj(place)) return emptyAssessment()
    if (tool === 'Bash' || tool === 'PowerShell') return await assessCommand(io, input, place)
    return await assessFile(io, tool, input, place)
  } catch {
    return emptyAssessment()
  }
}
