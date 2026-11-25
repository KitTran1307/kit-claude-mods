// A fake world for the engine tests (band.test.tsx, register.test.tsx): hooks that stand for the engine beneath the plugin and
// answer `fs.*`, `process.run`, `session.*`, `env.get`, `ui.*`, `command.register` and the tools themselves from memory. The file
// tree is a Map, so the real vault and guard run over it (the 'fs' backend: no Node by default); `ran` records what the tools
// really ran, and `rm -rf <path>` and `Write` change the tree, so a test can run a command, restore and look at the files.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PRESS_GUARD_MS } from '../hooks/flow'

export const ROOT = '/work/acme-shop'
export const HOME = '/home/dev'
export const SNAPS = `${HOME}/.claude/kit-safety/snapshots`
/** 24 Nov 2026, 14:05:12 local time, so "14:05" reads the same in every time zone. */
export const NOW = new Date(2026, 10, 24, 14, 5, 12).getTime()

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function encode64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

/**
 * A path as the fake stores and compares it: with `/`, no drive, no doubled or trailing separator. The test engine on Windows puts
 * a drive in front of every path and turns the separators round (`/work/acme-shop` reaches a handler as `D:\work\acme-shop`), so
 * `D:\work\acme-shop\build`, `d:/work/acme-shop/build//` and `/work/acme-shop/build` are one place here. `.` and `..` are kept: the
 * plugin resolves its own paths, and an unresolved one handed to `fs` is a bug the fake must not hide.
 */
export const norm = (p: unknown): string =>
  String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'

export type World = {
  /** The text of every file, by absolute path. */
  files: Map<string, string>
  /** Folders that exist although no file is in them. */
  dirs: Set<string>
  /**
   * A scripted git: `head` null = no commit yet; `stash` is what `git stash create` prints ('' = a clean tree); `stashFails` = it
   * fails (an unfinished merge); `branches` are the local branch tips by name, `remotes` the remote-tracking tips by `<remote>/<name>`.
   */
  git: { isRepo: boolean; tracked: Set<string>; ignored: Set<string>; head: string | null; branch: string; stash: string; stashFails: boolean; branches: Record<string, string>; remotes: Record<string, string> }
  /** Git is installed (`git --version` answers). */
  hasGit: boolean
  /** Node: null = not installed; otherwise `helperOk` says whether the helper script answers `hello` (it answers nothing else). */
  node: { helperOk: boolean } | null
  /** What Claude Code's `language` setting holds; 'error' = reading settings fails. */
  language: unknown
  /** The surfaces the session draws on; 'error' = the call fails. */
  surfaces: string[] | 'error'
  /** `$.session.root()` fails. */
  failRoot: boolean
  /** Writes below the snapshot folder fail (the snapshot cannot be saved). */
  failSnapshotWrites: boolean
  /** Reads of the project's files fail. */
  failProjectReads: boolean
  /** Variables the plugin may read. */
  env: Record<string, string | undefined>
  /** How Claude Code's question box answers: a label, null (dismissed), or a promise the test settles. Default: dismissed. */
  ask: (question: string, options: string[]) => string | null | Promise<string | null>
  ran: { tool: string; input: Record<string, unknown> }[]
  /** Every program the plugin ran, with the working directory it asked for (undefined = none: the engine's own). */
  runs: { argv: string[]; cwd: string | undefined }[]
  asked: { question: string; options: string[] }[]
  /** Windows mode only: every path the `fs.*` calls and the program runs carried, as the handlers saw it (`D:\...`). */
  seen: string[]
  toasts: string[]
  logs: { text: string; to: string }[]
  commands: string[]
  writes: string[]
  gitCalls: string[][]
  clock: ReturnType<typeof mock.clock>
  session: ReturnType<typeof mock.session>
  put(path: string, text: string): void
  read(path: string): string | undefined
  /** Ids of the snapshots of the project, oldest first. */
  snapshotIds(): string[]
}

const isDir = (w: World, p: string): boolean => {
  const n = norm(p)
  if (w.dirs.has(n) || n === '/') return true
  for (const key of w.files.keys()) if (key.startsWith(`${n}/`)) return true
  for (const key of w.dirs) if (key.startsWith(`${n}/`)) return true
  return false
}

/** A path git is asked about, the way the test lists it: relative to the project, with `/` (a drive or `\` in it does not matter). */
const gitKey = (p: string): string => {
  const n = norm(p)
  return n.startsWith(`${ROOT}/`) ? n.slice(ROOT.length + 1) : n
}

function git(w: World, argv: readonly string[]): { exitCode: number; stdout: string } {
  w.gitCalls.push([...argv])
  const at = argv.indexOf('-C')
  const rest = argv.slice(at + 2).filter(a => !a.startsWith('--literal'))
  if (!w.git.isRepo) return { exitCode: 128, stdout: '' }
  const cmd = rest[0]
  if (cmd === 'rev-parse') {
    if (rest.includes('--is-inside-work-tree')) return { exitCode: 0, stdout: 'true\n' }
    if (rest.includes('--abbrev-ref')) return w.git.head === null ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${w.git.branch}\n` }
    if (rest.includes('--verify')) {
      const ref = String(rest[rest.length - 1])
      const sha = ref.startsWith('refs/remotes/') ? w.git.remotes[ref.slice('refs/remotes/'.length)] : w.git.branches[ref.replace('refs/heads/', '')]
      return sha ? { exitCode: 0, stdout: `${sha}\n` } : { exitCode: 1, stdout: '' }
    }
    return w.git.head === null ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${w.git.head}\n` }
  }
  const rel = rest[rest.length - 1] ?? ''
  const key = gitKey(rel)
  if (cmd === 'ls-files') return { exitCode: w.git.tracked.has(rel) || w.git.tracked.has(key) ? 0 : 1, stdout: '' }
  if (cmd === 'check-ignore') {
    const isIgnored = (r: string) => w.git.ignored.has(r) || w.git.ignored.has(gitKey(r))
    // `check-ignore -z -- a b c` (several paths, as the guard asks): prints the ignored ones NUL-ended, exit 0 when there is one, else 1
    if (rest.includes('-z')) {
      const paths = rest.slice(rest.indexOf('--') + 1)
      const hits = paths.filter(isIgnored)
      return hits.length > 0 ? { exitCode: 0, stdout: `${hits.join('\0')}\0` } : { exitCode: 1, stdout: '' }
    }
    return { exitCode: isIgnored(rel) ? 0 : 1, stdout: '' }
  }
  if (cmd === 'stash') return w.git.stashFails ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: w.git.stash === '' ? '' : `${w.git.stash}\n` }
  if (cmd === 'update-ref') return { exitCode: 0, stdout: '' }
  return { exitCode: 1, stdout: '' }
}

const refuse = (why: string) => ({ deny: why })

/** Whether a path is the snapshot folder or below it (any spelling: the check is made on the normalised path). */
export const underSnaps = (p: unknown): boolean => norm(p) === SNAPS || norm(p).startsWith(`${SNAPS}/`)

/** What the engine's `fs.*` calls carry to a handler: `path` always, in any spelling (`/work/x`, `D:\work\x`). */
export type FsCall = { path: string; as?: string; offset?: number; length?: number; resolve?: boolean; text?: string }

/**
 * The answers the fake gives to the engine's `fs.*` calls, one function per call (the bottom of the chain). They are plain
 * functions so a test can call them with any spelling of a path and look at the answer, as well as through the engine.
 */
export function fakeFs(w: World) {
  return {
    read: (e: FsCall) => {
      const path = norm(e.path)
      if (w.failProjectReads && !underSnaps(path)) return refuse('EIO')
      const text = w.files.get(path)
      if (text === undefined) return refuse('ENOENT')
      if (e.as === 'bytes') {
        let bytes = new TextEncoder().encode(text)
        if (typeof e.offset === 'number') bytes = bytes.slice(e.offset, typeof e.length === 'number' ? e.offset + e.length : undefined)
        return { value: { base64: encode64(bytes) } }
      }
      return { value: text }
    },
    write: (e: FsCall) => {
      if (w.failSnapshotWrites && underSnaps(e.path)) return refuse('ENOSPC')
      w.files.set(norm(e.path), String(e.text))
      w.writes.push(norm(e.path))
      return { value: undefined }
    },
    exists: (e: FsCall) => ({ value: w.files.has(norm(e.path)) || isDir(w, e.path) }),
    stat: (e: FsCall) => {
      const path = norm(e.path)
      const text = w.files.get(path)
      const base = { size: 0, mtimeMs: 1_700_000_000_000, isLink: false, ...(e.resolve ? { realPath: path } : {}) }
      if (text !== undefined) return { value: { kind: 'file' as const, ...base, size: new TextEncoder().encode(text).length } }
      if (isDir(w, path)) return { value: { kind: 'dir' as const, ...base } }
      return refuse('ENOENT')
    },
    list: (e: FsCall) => {
      const path = norm(e.path)
      if (!isDir(w, path)) return refuse('ENOENT')
      const prefix = path === '/' ? '/' : `${path}/`
      const seen = new Map<string, 'file' | 'dir'>()
      for (const key of w.files.keys()) {
        if (!key.startsWith(prefix)) continue
        const head = key.slice(prefix.length).split('/')
        seen.set(head[0]!, head.length === 1 ? 'file' : 'dir')
      }
      for (const key of w.dirs) if (key.startsWith(prefix)) seen.set(key.slice(prefix.length).split('/')[0]!, 'dir')
      return {
        value: [...seen].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? new TextEncoder().encode(w.files.get(prefix + name) ?? '').length : 0, mtimeMs: kind === 'file' ? 1_700_000_000_000 : 0, isLink: false })),
      }
    },
  }
}

/** The fake's answer to `process.run`: scripted git, node and claude, nothing else. The working directory is recorded as a normalised path. */
export function fakeRun(w: World, e: { argv?: string[]; init?: { cwd?: unknown; stdin?: unknown } }) {
  const argv: string[] = e.argv ?? []
  w.runs.push({ argv: [...argv], cwd: typeof e.init?.cwd === 'string' ? norm(e.init.cwd) : undefined })
  const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  if (argv[0] === 'git') {
    if (!w.hasGit) return refuse('spawn git ENOENT')
    if (argv[1] === '--version') return ok('git version 2.43.0\n')
    const r = git(w, argv)
    return ok(r.stdout, r.exitCode)
  }
  if (argv[0] === 'node') {
    if (w.node === null) return refuse('spawn node ENOENT')
    if (argv[1] === '--version') return ok('v22.1.0\n')
    // the helper answers `hello` and nothing else, so a snapshot falls back to the 'fs' backend
    if (w.node.helperOk && String(e.init?.stdin ?? '').includes('"hello"')) return ok('{"ok":true,"v":1,"node":"22.1.0"}\n')
    return ok('', 1)
  }
  if (argv[0] === 'claude') return ok('2.1.331 (Claude Code)\n')
  return refuse('not stubbed')
}

/** How the Windows engine spells a path before a handler sees it: `D:\work\x` for `/work/x` (a relative path only turns its separators). */
export const dosPath = (drive: string, p: string): string => (/^[A-Za-z]:|^\\/.test(p) ? p : (p.startsWith('/') ? drive : '') + p.replace(/\//g, '\\'))

export type WorldOptions = Partial<Pick<World, 'hasGit' | 'node' | 'language' | 'surfaces' | 'failRoot' | 'failSnapshotWrites' | 'failProjectReads' | 'env' | 'ask'>> & {
  /**
   * Windows mode, a drive such as `'D:'`: every path the plugin hands to `fs.*` (and every working directory it gives a program)
   * reaches the handlers as the Windows test engine spells it (`D:\work\acme-shop\build`), and `world.seen` lists them. What the
   * fake hands back to the plugin stays POSIX. Fixed when the world is made.
   */
  drive?: string
}

/** Registers the fake engine on `on` and returns it. Everything about it can be changed from the test (it is read on every call). */
export function world(on: On, options: WorldOptions = {}): World {
  const { drive, ...over } = options
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  const w: World = {
    files: new Map(),
    dirs: new Set([ROOT, HOME]),
    git: { isRepo: false, tracked: new Set(), ignored: new Set(), head: null, branch: 'main', stash: '', stashFails: false, branches: {}, remotes: {} },
    hasGit: true,
    node: null,
    language: undefined,
    surfaces: ['terminal'],
    failRoot: false,
    failSnapshotWrites: false,
    failProjectReads: false,
    env: { HOME },
    ask: () => null,
    ran: [], runs: [], asked: [], seen: [], toasts: [], logs: [], commands: [], writes: [], gitCalls: [],
    clock,
    session,
    put: (path, text) => { w.files.set(norm(path), text) },
    read: path => w.files.get(norm(path)),
    snapshotIds: () => {
      const ids = new Set<string>()
      for (const key of w.files.keys()) {
        const m = new RegExp(`^${SNAPS}/[^/]+/([0-9]{8}T[0-9]{6}Z[^/]*)/`).exec(key)
        if (m) ids.add(m[1]!)
      }
      return [...ids].sort()
    },
    ...over,
  }

  // Windows mode: a hook above the handlers (registered first, so outermost) that rewrites the paths as that engine does.
  // On a real Windows host the plugin's own path resolution has already put the host's current drive in front of the fake's
  // POSIX root (`D:\work\acme-shop`), so a path that arrives with a drive is moved to the simulated one: the world lives on
  // `drive` whatever the host's drive is.
  const onDrive = (p: string): string => (/^[A-Za-z]:/.test(p) ? dosPath(drive!, norm(p)) : dosPath(drive!, p))
  if (drive !== undefined) {
    on('fs.*', (_: unknown, e: any, next: any) => {
      if (typeof e.path !== 'string') return next(e)
      const path = onDrive(e.path)
      w.seen.push(path)
      return next({ ...e, path })
    })
    on('process.*', (_: unknown, e: any, next: any) => {
      if (typeof e.init?.cwd !== 'string') return next(e)
      const cwd = onDrive(e.init.cwd)
      w.seen.push(cwd)
      return next({ ...e, init: { ...e.init, cwd } })
    })
  }

  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
  on('session.root', () => (w.failRoot ? refuse('no root') : { value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.surfaces', () => (w.surfaces === 'error' ? refuse('no surfaces') : { value: w.surfaces as never }))
  on('session.version', () => ({ value: { version: '2.1.331', base: '2.1.331' } }))
  on('settings.read', () => (w.language === 'error' ? refuse('no settings') : { value: w.language === undefined ? {} : { language: w.language } }))
  on('env.get', (_: unknown, e: any) => ({ value: w.env[e.name] }))
  on('command.register', (_: unknown, e: any) => { w.commands.push(String(e.name)); return { value: { command: e.name } } })
  on('ui.toast', (_: unknown, e: any) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('ui.log', (_: unknown, e: any) => { w.logs.push({ text: String(e.text), to: String(e.to) }); return { value: undefined } })

  // ---- files ----
  const fs = fakeFs(w)
  on('fs.read', (_: unknown, e: any) => fs.read(e))
  on('fs.write', (_: unknown, e: any) => fs.write(e))
  on('fs.exists', (_: unknown, e: any) => fs.exists(e))
  on('fs.stat', (_: unknown, e: any) => fs.stat(e))
  on('fs.list', (_: unknown, e: any) => fs.list(e))

  // ---- commands ----
  on('process.run', (_: unknown, e: any) => fakeRun(w, e))

  // ---- tools: what runs when the plugin lets a call through ----
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const question = String((e.questions ?? e.input?.questions)?.[0]?.question ?? '')
      const options = ((e.questions ?? e.input?.questions)?.[0]?.options ?? []).map((o: any) => String(o.label ?? o))
      w.asked.push({ question, options })
      const answer = await w.ask(question, options)
      if (answer === null) return { deny: 'dismissed' }
      return { result: { questions: e.questions ?? e.input?.questions, answers: { [question]: answer } }, text: answer }
    }
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e
    w.ran.push({ tool: String(tool), input })
    if (tool === 'Bash') {
      // `rm -rf a b/ c`: each plain name is removed (nothing with a pipe, a list or a comment is run)
      const m = /^rm -rf((?: [^\s#;&|]+)+)$/.exec(String(input.command))
      if (m) {
        for (const name of m[1]!.trim().split(' ')) {
          const target = norm(`${ROOT}/${name.replace(/\/+$/, '')}`)
          for (const key of [...w.files.keys()]) if (key === target || key.startsWith(`${target}/`)) w.files.delete(key)
          w.dirs.delete(target)
        }
      }
    }
    if (tool === 'Write' || tool === 'Edit') w.files.set(norm(String(input.file_path)), String(input.content ?? input.new_string ?? ''))
    return { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
  })

  // ---- what the engine draws where the plugin leaves a site alone ----
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    if (e.component === 'ToolResult') return <Text>{`engine result: ${JSON.stringify(e.props.output)}`}</Text>
    if (e.component === 'CommandOutput') return <Text>{`engine command: ${e.props.text}`}</Text>
    return <Text>engine</Text>
  })
  return w
}

// ---- helpers for the tests ----

export const BAND_PROPS = { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

export const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
export type Surface = (typeof SURFACES)[number]

/** Lets everything that is under way run, as far as it can without the clock moving. */
export async function settle(w: World, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await w.clock.settle()
}

/** The strings a mounted drawing shows, in order. */
export async function textsOf(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

export async function buttonsOf(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined; props: Record<string, unknown> }[]> }): Promise<{ key: string | undefined; label: unknown; hotkey: unknown; variant: unknown }[]> {
  return (await ui.findAll({ type: 'Button' })).map(b => ({ key: b.key, label: b.props.label, hotkey: b.props.hotkey, variant: b.props.variant }))
}

/** A promise whose settling the test can look at without awaiting it. */
export function track<T>(promise: Promise<T>): { promise: Promise<T>; readonly isDone: boolean } {
  let isDone = false
  promise.then(
    () => { isDone = true },
    () => { isDone = true },
  )
  return { promise, get isDone() { return isDone } }
}

/** The text of the tree's own rows with the fake engine's "engine" row left out. */
export async function ours(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string[]> {
  return (await textsOf(ui)).filter(t => t !== 'engine')
}

// ---- the usual moves of a test ----

export const mountBand = ($: Engine, surface: Surface, props: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'kit-safety', component: 'AbovePrompt', surface, props: { ...BAND_PROPS, ...props } as never })

/** The session starts in the terminal with a person at the prompt (or headless), and everything settles. */
export async function begin($: Engine, w: World, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive })
  await settle(w)
}

export const bash = ($: Engine, command: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command, ...extra } as never)

/** Lets the question on screen age past the moment in which Allow and Cancel ignore a press (a stray digit, a double press). */
export const readIt = (w: World): Promise<void> => w.clock.advance(PRESS_GUARD_MS)

/** Presses a button of the band on the terminal, after the question has been on screen long enough to be answered. */
export async function press($: Engine, w: World, key: 'allow' | 'cancel' | 'details'): Promise<void> {
  const ui = await mountBand($, 'terminal')
  await readIt(w)
  await ui.press({ key })
  await ui.unmount()
  await settle(w)
}

/** Answers every question still waiting with Cancel, so that no test leaves a call held. */
export async function drain($: Engine, w: World): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const ui = await mountBand($, 'terminal')
    const hasCancel = (await buttonsOf(ui)).some(b => b.key === 'cancel')
    if (hasCancel) {
      await readIt(w)
      await ui.press({ key: 'cancel' })
    }
    await ui.unmount()
    await settle(w)
    if (!hasCancel) return
  }
}

/** The band's own texts right now, from a fresh mount on `surface`. */
export async function bandTexts($: Engine, surface: Surface = 'desktop'): Promise<string[]> {
  const ui = await mountBand($, surface)
  const texts = await ours(ui)
  await ui.unmount()
  return texts
}

/** `/safety <args>` as the person types it: the text of the answer. */
export async function safety($: Engine, args = ''): Promise<string> {
  const out = (await $.command.run({ command: 'safety', args } as never)) as { text?: string }
  return String(out?.text ?? '')
}

/** Every file's text in the world, all together (to look for something that must not be stored anywhere). */
export const everything = (w: World): string => [...w.files.values()].join('\n')
