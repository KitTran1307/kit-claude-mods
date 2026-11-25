import { dirName, normalizePath } from '../hooks/paths'
import { newSnapshotId, parseManifest, projectKey, snapshotDir } from '../hooks/snapshot'
import type { Manifest } from '../hooks/snapshot'
import type { Risk } from '../hooks/types'
import { createSnapshot, findSnapshot, ioFromEngine } from '../hooks/vault'
import type { IO, IOEntry, IORun, IOStat, RestoreOutcome, SnapshotOutcome, SnapshotRequest, VaultCfg, VaultEnv } from '../hooks/vault'

// The in-memory world shared by vault.test.ts, vault-limits.test.ts and vault-sizes.test.ts: a byte-exact file tree with folder links, a scripted git, a fake of the
// Node helper (same protocol as scripts/safety-fs.mjs: that script has its own tests, scripts/safety-fs.test.mjs), and the IO over all three.
// Nothing here registers a test.

export type Node = { kind: 'file'; bytes: Uint8Array; mtimeMs: number } | { kind: 'dir' } | { kind: 'link'; target: string }

export const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_CODES = Uint8Array.from(B64, c => c.charCodeAt(0))
/** Base64 of the bytes (RFC 4648, padded). Writes into a byte array instead of gluing strings: that is ten times faster on MiB-sized files. */
export function encode64(bytes: Uint8Array): string {
  const n = bytes.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o++] = B64_CODES[v >> 18]!
    out[o++] = B64_CODES[(v >> 12) & 63]!
    out[o++] = B64_CODES[(v >> 6) & 63]!
    out[o++] = B64_CODES[v & 63]!
  }
  if (i < n) {
    const v = (bytes[i]! << 16) | ((i + 1 < n ? bytes[i + 1]! : 0) << 8)
    out[o++] = B64_CODES[v >> 18]!
    out[o++] = B64_CODES[(v >> 12) & 63]!
    out[o++] = i + 1 < n ? B64_CODES[(v >> 6) & 63]! : 61
    out[o++] = 61
  }
  return new TextDecoder().decode(out)
}
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
export const text = (b: Uint8Array): string => new TextDecoder().decode(b)

export const clock = { now: Date.UTC(2026, 10, 24, 9, 30, 15) }
export const ROOT = '/work/acme-shop'
export const HOME = '/home/dev'
export const SNAPS = `${HOME}/.claude/kit-safety/snapshots`
export const HELPER = '/plugins/kit-safety/scripts/safety-fs.mjs'
export const KEY = projectKey(ROOT)
export const SHA1 = '1'.repeat(40)
export const SHA2 = '2'.repeat(40)
export const SHA3 = '3'.repeat(40)
export const MB = 1024 * 1024
export const CFG: VaultCfg = { maxBytes: 100 * MB, keepCount: 20, keepDays: 14 }
export const DAY = 86_400_000

export class Fs {
  nodes = new Map<string, Node>()
  writes: string[] = []
  /** Paths (as spelled in the write call) whose write must fail. */
  failWrite: (path: string) => boolean = () => false
  failRead: (path: string) => boolean = () => false
  /** Folders the engine could not resolve (no realPath answered). */
  noRealPath = false
  /** The modification time a folder reports (folders report 0, "unknown", unless a test sets one). */
  dirTimes = new Map<string, number>()

  real(path: string, followLast = true): string {
    let p = normalizePath(path)
    for (let guard = 0; guard < 40; guard += 1) {
      const prefix = /^([A-Za-z]:\/|\/)/.exec(p)?.[1] ?? ''
      const rest = p.slice(prefix.length).split('/').filter(Boolean)
      let cur = prefix
      let jumped = false
      for (const [i, seg] of rest.entries()) {
        const next = cur === prefix ? prefix + seg : `${cur}/${seg}`
        const node = this.nodes.get(next)
        if (node?.kind === 'link' && (i < rest.length - 1 || followLast)) {
          p = normalizePath(`${node.target}/${rest.slice(i + 1).join('/')}`)
          jumped = true
          break
        }
        cur = next
      }
      if (!jumped) return cur
    }
    return normalizePath(path)
  }

  dir(path: string): void {
    const p = normalizePath(path)
    const prefix = /^([A-Za-z]:\/|\/)/.exec(p)?.[1] ?? ''
    if (prefix !== '' && !this.nodes.has(prefix)) this.nodes.set(prefix, { kind: 'dir' })
    let cur = ''
    for (const seg of p.slice(prefix.length).split('/').filter(Boolean)) {
      cur = cur === '' ? prefix + seg : `${cur}/${seg}`
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir' })
    }
  }

  file(path: string, content: string | Uint8Array | number[] = 'x', mtimeMs = 1_700_000_000_000): void {
    const p = normalizePath(path)
    const parent = dirName(p)
    if (!this.nodes.has(parent)) this.dir(parent) // a parent that is there has all its own parents (a 50,000-file tree is built in half the time)
    this.nodes.set(p, { kind: 'file', bytes: typeof content === 'string' ? utf8(content) : Uint8Array.from(content), mtimeMs })
  }

  link(path: string, target: string): void {
    const p = normalizePath(path)
    this.dir(dirName(p))
    this.nodes.set(p, { kind: 'link', target: normalizePath(target) })
  }

  remove(path: string): void {
    const p = normalizePath(path)
    for (const key of [...this.nodes.keys()]) if (key === p || key.startsWith(`${p}/`)) this.nodes.delete(key)
  }

  has(path: string): boolean {
    return this.nodes.has(normalizePath(path))
  }

  read(path: string): string | undefined {
    const n = this.nodes.get(this.real(path))
    return n?.kind === 'file' ? text(n.bytes) : undefined
  }

  bytesOf(path: string): Uint8Array | undefined {
    const n = this.nodes.get(this.real(path))
    return n?.kind === 'file' ? n.bytes : undefined
  }

  /** Every path below `prefix` (not the folder itself), sorted. */
  below(prefix: string): string[] {
    const p = normalizePath(prefix)
    return [...this.nodes.keys()].filter(k => k.startsWith(`${p}/`)).sort()
  }

  childrenOf(at: string): [string, Node][] {
    return [...this.nodes].filter(([k]) => k !== at && dirName(k) === at)
  }

  io(run: (argv: string[], init?: { stdin?: string; cwd?: string }) => IORun): IO {
    const fs = this
    const info = (node: Node, isLink: boolean): Omit<IOStat, 'realPath'> =>
      node.kind === 'file' ? { kind: 'file', size: node.bytes.length, mtimeMs: node.mtimeMs, isLink } : { kind: node.kind === 'dir' ? 'dir' : 'other', size: 0, mtimeMs: 0, isLink }
    return {
      async readText(path) {
        if (fs.failRead(path)) throw new Error('EIO')
        const node = fs.nodes.get(fs.real(path))
        if (node?.kind !== 'file') throw new Error('ENOENT')
        return text(node.bytes)
      },
      async readBase64(path, range) {
        if (fs.failRead(path)) throw new Error('EIO')
        const node = fs.nodes.get(fs.real(path))
        if (node?.kind !== 'file') throw new Error('ENOENT')
        return encode64(range ? node.bytes.slice(range.offset, range.offset + range.length) : node.bytes)
      },
      async writeText(path, content) {
        if (fs.failWrite(path)) throw new Error('ENOSPC')
        const landed = fs.real(path)
        fs.dir(dirName(landed))
        fs.nodes.set(landed, { kind: 'file', bytes: utf8(content), mtimeMs: clock.now })
        fs.writes.push(normalizePath(path))
      },
      async list(path): Promise<IOEntry[]> {
        const at = fs.real(path)
        if (fs.nodes.get(at)?.kind !== 'dir') return []
        return fs.childrenOf(at).map(([key, node]): IOEntry => {
          const name = key.slice(key.lastIndexOf('/') + 1)
          return node.kind === 'link' ? { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true } : { name, ...info(node, false) }
        })
      },
      async stat(path, resolve) {
        const own = fs.nodes.get(fs.real(path, false))
        if (!own) return null
        const landed = fs.real(path)
        const target = fs.nodes.get(landed)
        const out: IOStat = own.kind === 'link' ? (target ? { ...info(target, true) } : { kind: 'other', size: 0, mtimeMs: 0, isLink: true }) : info(own, false)
        if (resolve && target && !fs.noRealPath) out.realPath = landed
        const at = fs.dirTimes.get(normalizePath(path))
        if (at !== undefined && out.kind === 'dir') out.mtimeMs = at
        return out
      },
      async run(argv, init) {
        return run(argv, init)
      },
      now: () => clock.now,
    }
  }
}

export const done = (exitCode: number, stdout = ''): IORun => ({ exitCode, stdout, stderr: '' })

export class Git {
  isRepo = false
  head: string | null = SHA1
  branch = 'main'
  detached = false
  /** What `git stash create` prints: null = a clean tree (nothing). */
  stash: string | null = null
  branches: Record<string, string> = {}
  /** Remote-tracking branches by `<remote>/<name>`. */
  remotes: Record<string, string> = {}
  refs = new Map<string, string>()
  calls: string[][] = []
  /** Every full argv, as it was run (the part before `-C` is what the plugin sets for every git call). */
  argvs: string[][] = []
  identity: boolean[] = []
  failUpdateRef = false
  failStash = false
  /** Refs that were made, and refs that were deleted, in order. */
  made: string[] = []
  deleted: string[] = []

  /** The `cwd` of every git call (undefined: none given). */
  cwds: (string | undefined)[] = []

  handle = (argv: string[], init?: { cwd?: string }): IORun => {
    if (argv[0] !== 'git') return done(-1)
    const at = argv.indexOf('-C')
    this.argvs.push(argv)
    this.cwds.push(init?.cwd)
    this.identity.push(argv.some(a => a.startsWith('user.name=')))
    const rest = argv.slice(at + 2)
    this.calls.push(rest)
    const [cmd, ...args] = rest
    if (cmd === 'rev-parse' && args[0] === '--is-inside-work-tree') return this.isRepo ? done(0, 'true\n') : done(128)
    if (!this.isRepo) return done(128)
    if (cmd === 'rev-parse' && args[0] === 'HEAD') return this.head ? done(0, `${this.head}\n`) : done(128)
    if (cmd === 'rev-parse' && args[0] === '--abbrev-ref') return this.head ? done(0, `${this.detached ? 'HEAD' : this.branch}\n`) : done(128, 'HEAD\n')
    if (cmd === 'stash' && args[0] === 'create') return !this.head || this.failStash ? done(128) : done(0, this.stash ? `${this.stash}\n` : '')
    if (cmd === 'rev-parse' && args[0] === '--verify') {
      const full = args[args.length - 1] ?? ''
      const sha = full.startsWith('refs/remotes/') ? this.remotes[full.slice('refs/remotes/'.length)] : this.branches[full.replace('refs/heads/', '')]
      return sha ? done(0, `${sha}\n`) : done(1)
    }
    if (cmd === 'update-ref' && args[0] === '-d') {
      this.deleted.push(args[1] ?? '')
      this.refs.delete(args[1] ?? '')
      return done(0)
    }
    if (cmd === 'update-ref') {
      if (this.failUpdateRef) return done(128)
      // `update-ref <ref> <sha> ""` is create-only: git refuses when the ref is there.
      if (args[2] === '' && this.refs.has(args[0] ?? '')) return done(128)
      this.refs.set(args[0] ?? '', args[1] ?? '')
      this.made.push(args[0] ?? '')
      return done(0)
    }
    return done(129)
  }
  subcommands(): string[] {
    return [...new Set(this.calls.map(c => (c[0] === 'rev-parse' ? 'rev-parse' : c[0] === 'stash' ? 'stash create' : (c[0] ?? ''))))].sort()
  }
}

export type NodeMode =
  | 'ok'
  | 'garbage'
  | 'crash'
  | 'refuse'
  | 'collide-once'
  | 'collide-always'
  | 'none'
  /** Copies, then the answer is lost: the process dies (exit 1) after the snapshot is complete. */
  | 'lost-answer'
  /** Copies, then the answer is cut in the middle (the engine's 4 MiB cap on a command's output). */
  | 'cut-answer'
  /** Dies half way through the copy: a folder with some files and no manifest. */
  | 'die-midway'

/** The helper's protocol over the fake tree. `none` = no node on this machine. */
export class NodeFake {
  mode: NodeMode = 'none'
  version = 'v22.3.0'
  requests: Record<string, unknown>[] = []
  /** The `cwd` of every helper call (and of `node --version`: see `versionCwds`). */
  cwds: (string | undefined)[] = []
  versionCwds: (string | undefined)[] = []
  versionCalls = 0
  collided = 0
  /** Entries the fake helper reports as skipped when it copies. */
  skipOnCopy: { rel: string; reason: string }[] = []
  /** Pretend the copy found more skipped entries than it lists. */
  extraSkipped = 0
  /** What restore reports as failed. */
  restoreFailed: { rel: string; reason: string }[] = []
  keptNewer = 0

  constructor(private fs: Fs) {}

  handle = (argv: string[], init?: { stdin?: string; cwd?: string }): IORun | undefined => {
    if (argv[0] !== 'node') return undefined
    if (this.mode === 'none') return done(-1)
    if (argv[1] === '--version') {
      this.versionCalls += 1
      this.versionCwds.push(init?.cwd)
      return done(0, `${this.version}\n`)
    }
    if (argv[1] !== HELPER) return done(1)
    if (this.mode === 'crash') return done(1)
    if (this.mode === 'garbage') return done(0, 'this is not json\n')
    const req = JSON.parse(init?.stdin ?? '{}') as Record<string, unknown>
    this.requests.push(req)
    this.cwds.push(init?.cwd)
    const reply = (v: unknown): IORun => done(0, `${JSON.stringify(v)}\n`)
    switch (req.cmd) {
      case 'scan':
        return reply(this.scan(req))
      case 'copy': {
        if (this.mode === 'die-midway') {
          this.fs.file(`${normalizePath(String(req.destDir))}/files/part.txt`, 'half')
          return done(1)
        }
        const answer = this.copy(req)
        if (this.mode === 'lost-answer') return done(1)
        if (this.mode === 'cut-answer') return done(0, JSON.stringify(answer).slice(0, 40))
        return reply(answer)
      }
      case 'restore':
        return reply(this.restore(req))
      case 'remove': {
        const dir = snapshotDir(String(req.snapshotsRoot), String(req.projectKey), String(req.id))
        this.fs.remove(dir)
        return reply({ ok: true, removed: true })
      }
      default:
        return reply({ ok: false, error: 'unknown command' })
    }
  }

  private collect(root: string, targets: string[], maxBytes: number, maxFiles: number) {
    const files: { rel: string; abs: string; node: Extract<Node, { kind: 'file' }> }[] = []
    const dirs: string[] = []
    const missing: string[] = []
    let bytes = 0
    let tooBig = false
    const walk = (abs: string, rel: string): boolean => {
      const kids = this.fs.childrenOf(abs).sort(([a], [b]) => (a < b ? -1 : 1))
      let stored = false
      for (const [key, node] of kids) {
        const childRel = `${rel}/${key.slice(key.lastIndexOf('/') + 1)}`
        if (node.kind === 'file') {
          files.push({ rel: childRel, abs: key, node })
          bytes += node.bytes.length
          stored = true
          if (bytes > maxBytes || files.length > maxFiles) {
            tooBig = true
            return true
          }
        } else if (node.kind === 'dir') {
          if (walk(key, childRel)) stored = true
        }
      }
      if (!stored) dirs.push(rel)
      return true
    }
    for (const rel of targets) {
      if (tooBig) break
      const abs = normalizePath(`${root}/${rel}`)
      const node = this.fs.nodes.get(abs)
      if (!node) missing.push(rel)
      else if (node.kind === 'file') {
        files.push({ rel, abs, node })
        bytes += node.bytes.length
        if (bytes > maxBytes || files.length > maxFiles) tooBig = true
      } else if (node.kind === 'dir') walk(abs, rel)
    }
    return { files, dirs, missing, bytes, tooBig, tooBigBy: bytes > maxBytes ? 'bytes' : 'files' }
  }

  private scan(req: Record<string, unknown>) {
    const c = this.collect(String(req.root), req.targets as string[], Number(req.maxBytes), Number(req.maxFiles))
    return { ok: true, files: c.files.length, dirs: c.dirs.length, bytes: c.bytes, tooBig: c.tooBig, ...(c.tooBig ? { tooBigBy: c.tooBigBy } : {}), isTruncated: c.tooBig, skipped: [], skippedCount: 0, missing: c.missing, missingCount: c.missing.length }
  }

  private copy(req: Record<string, unknown>) {
    const dest = normalizePath(String(req.destDir))
    if (this.mode === 'collide-always' || (this.mode === 'collide-once' && this.collided === 0)) {
      this.collided += 1
      return { ok: false, error: 'destination already exists' }
    }
    if (this.mode === 'refuse') return { ok: false, error: 'internal error' }
    if (this.fs.nodes.has(dest)) return { ok: false, error: 'destination already exists' }
    const c = this.collect(String(req.root), req.targets as string[], Number(req.maxBytes), Number(req.maxFiles))
    if (c.tooBig) return { ok: true, tooBig: true, tooBigBy: c.tooBigBy, files: c.files.length, bytes: c.bytes, dirs: c.dirs.length, skippedCount: 0, missing: c.missing, missingCount: c.missing.length }
    const base = req.manifest as Record<string, unknown>
    for (const f of c.files) this.fs.file(`${dest}/files/${f.rel}`, f.node.bytes, f.node.mtimeMs)
    for (const d of c.dirs) this.fs.dir(`${dest}/files/${d}`)
    const files = c.files.map(f => ({ rel: f.rel, size: f.node.bytes.length, mtimeMs: f.node.mtimeMs, mode: 420, sha256: 'f'.repeat(64) }))
    const manifest = {
      ...base,
      root: req.root,
      backend: 'node',
      targets: req.targets,
      files,
      dirs: [...c.dirs].sort(),
      skipped: this.skipOnCopy,
      totalBytes: files.reduce((t, f) => t + f.size, 0),
    }
    this.fs.file(`${dest}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    // Like the real helper: a summary only. The manifest is on disk, not in the answer.
    return { ok: true, tooBig: false, files: files.length, bytes: manifest.totalBytes, dirs: c.dirs.length, skippedCount: this.skipOnCopy.length + this.extraSkipped, missing: c.missing, missingCount: c.missing.length }
  }

  private restore(req: Record<string, unknown>) {
    const snap = normalizePath(String(req.snapDir))
    const mf = this.fs.read(`${snap}/manifest.json`)
    if (mf === undefined) return { ok: false, error: 'snapshot has no manifest' }
    const m = JSON.parse(mf) as { files: { rel: string }[]; dirs: string[] }
    // Like the real helper: one unsafe path refuses the whole manifest.
    const safe = (rel: string) => rel !== '' && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.includes('\\') && rel.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
    if (![...m.files.map(f => f.rel), ...m.dirs].every(safe)) return { ok: false, error: 'invalid manifest' }
    const only = Array.isArray(req.only) ? (req.only as string[]) : null
    const picked = (rel: string) => only === null || only.some(o => rel === o || rel.startsWith(`${o}/`))
    let restored = 0
    for (const f of m.files) {
      const bytes = this.fs.bytesOf(`${snap}/files/${f.rel}`)
      if (!bytes || this.restoreFailed.some(x => x.rel === f.rel) || !picked(f.rel)) continue
      this.fs.file(`${String(req.root)}/${f.rel}`, bytes)
      restored += 1
    }
    for (const d of m.dirs) if (picked(d)) this.fs.dir(`${String(req.root)}/${d}`)
    return { ok: true, restored, dirs: m.dirs.length, bytes: 0, failed: this.restoreFailed, failedCount: this.restoreFailed.length, keptNewer: this.keptNewer }
  }
}

export type World = { fs: Fs; git: Git; node: NodeFake; io: IO; env: VaultEnv }

export function world(opts: { node?: NodeMode; git?: boolean; envNode?: boolean | undefined } = {}): World {
  const fs = new Fs()
  const git = new Git()
  const node = new NodeFake(fs)
  node.mode = opts.node ?? 'none'
  git.isRepo = opts.git ?? false
  fs.dir(ROOT)
  fs.dir(SNAPS)
  const io = fs.io((argv, init) => (argv[0] === 'git' ? git.handle(argv, init) : (node.handle(argv, init) ?? done(-1))))
  // `node` in the env is what the plugin believes: true when this machine has Node (unless the test says it is not probed yet).
  const believed = 'envNode' in opts ? opts.envNode : (opts.node ?? 'none') !== 'none'
  const env: VaultEnv = { io, snapshotsRoot: SNAPS, helper: HELPER, ...(believed === undefined ? {} : { node: believed }) }
  clock.now = Date.UTC(2026, 10, 24, 9, 30, 15)
  return { fs, git, node, io, env }
}

export const risk = (kind: Risk['kind'] = 'delete', label = 'rm -rf', extra: Partial<Risk> = {}): Risk => ({ kind, tier: 'ask', label, paths: [], ...extra })
export const req = (targets: string[], extra: Partial<SnapshotRequest> = {}): SnapshotRequest => ({
  root: ROOT,
  tool: 'Bash',
  command: 'rm -rf build',
  risks: [risk()],
  targets,
  kind: 'before-command',
  ...extra,
})

export async function snap(w: World, targets: string[], extra: Partial<SnapshotRequest> = {}, cfg: VaultCfg = CFG): Promise<SnapshotOutcome> {
  return createSnapshot(w.env, req(targets, extra), cfg)
}

/** A snapshot that must have worked. */
export async function made(w: World, targets: string[], extra: Partial<SnapshotRequest> = {}, cfg: VaultCfg = CFG) {
  const out = await snap(w, targets, extra, cfg)
  if (!out.ok) throw new Error(`snapshot failed: ${JSON.stringify(out)}`)
  return out
}

export const snapDirOf = (id: string): string => `${SNAPS}/${KEY}/${id}`
export const manifestOf = (w: World, id: string): Manifest => {
  const m = parseManifest(w.fs.read(`${snapDirOf(id)}/manifest.json`) ?? '')
  if (!m) throw new Error('no manifest')
  return m
}
export const ID0 = newSnapshotId(Date.UTC(2026, 10, 24, 9, 30, 15), [])

/** Both backends run the same tests where the result must be the same. */
export const BACKENDS: { name: string; mode: NodeMode }[] = [
  { name: 'fs backend', mode: 'none' },
  { name: 'node backend', mode: 'ok' },
]

export type RestoreWorld = { w: World; id: string }

/** A project with a folder snapshot taken; the folder is then changed, as `rm -rf` or an overwrite would. */
export async function snapshotted(mode: NodeMode, files: Record<string, string | number[]>, targets: string[], git = false): Promise<RestoreWorld> {
  const w = world({ node: mode, git })
  for (const [rel, content] of Object.entries(files)) w.fs.file(`${ROOT}/${rel}`, content)
  const out = await made(w, targets)
  clock.now += 60_000
  return { w, id: out.id }
}
export const find = async (w: World, id: string): Promise<Manifest> => {
  const m = await findSnapshot(w.env, ROOT, id)
  if (!m) throw new Error('snapshot not found')
  return m
}
export const reasons = (o: RestoreOutcome) => o.failed.map(f => `${f.rel}:${f.reason}`).sort()

/** The engine `$` as the real `ioFromEngine` sees it: every call is recorded in `calls`; `over` replaces a whole noun. */
export type Calls = { reads: unknown[][]; writes: unknown[][]; runs: unknown[][] }
export function engine(over: Record<string, unknown> = {}, opts?: { hooksDir?: string }) {
  const calls: Calls = { reads: [], writes: [], runs: [] }
  const $ = {
    fs: {
      read: async (...a: unknown[]) => {
        calls.reads.push(a)
        const opts = a[1] as { as?: string } | undefined
        return opts?.as === 'bytes' ? { base64: 'Zm9v' } : 'text'
      },
      write: async (...a: unknown[]) => void calls.writes.push(a),
      list: async () => [{ name: 'a', kind: 'file', size: 3, mtimeMs: 5, isLink: false, extra: 'dropped' }],
      stat: async (_p: string, o?: { resolve?: boolean }) => ({ kind: 'file', size: 3, mtimeMs: 5, isLink: false, ...(o?.resolve ? { realPath: '/real' } : {}) }),
    },
    process: { run: async (...a: unknown[]) => (calls.runs.push(a), { exitCode: 0, stdout: 'out', stderr: 'err', isStdoutTruncated: false, isStderrTruncated: false }) },
    clock: { now: async () => 42 },
    ...over,
  }
  return { io: ioFromEngine($ as never, opts), calls }
}
