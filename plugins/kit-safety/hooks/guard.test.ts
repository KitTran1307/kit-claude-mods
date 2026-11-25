import { describe, expect, test } from 'claude-code/testing'

import { assess, assessRisks, expandBraces, isWatched, REGENERABLE_FOLDERS, resetGuardCache, SNAPSHOT_LIMITS } from './guard'
import type { Assessment, Place } from './guard'
import { dirName, normalizePath } from './paths'
import { classifyBash } from './risk'
import type { IO, IOEntry, IORun, IOStat } from './vault'
import type { Risk } from './types'

// ---------------------------------------------------------------------------------------------------------------------
// An in-memory world: a file tree (with folder links), a scripted git, and the IO over both. Nothing is ever changed by guard.ts,
// so the fake is read-only for it; `calls` records every command so a test can prove which git commands ran.

type Node = { kind: 'file'; text: string; mtimeMs: number } | { kind: 'dir' } | { kind: 'link'; target: string }

const ROOT = '/work/acme-shop'
const HOME = '/home/dev'
const SHA = 'a'.repeat(40)

class Tree {
  nodes = new Map<string, Node>()
  reads: string[] = []

  /** Follows folder links; the last segment too when `followLast`. */
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
    let cur = ''
    const prefix = /^([A-Za-z]:\/|\/)/.exec(p)?.[1] ?? ''
    if (prefix !== '' && !this.nodes.has(prefix)) this.nodes.set(prefix, { kind: 'dir' })
    for (const seg of p.slice(prefix.length).split('/').filter(Boolean)) {
      cur = cur === '' ? prefix + seg : `${cur}/${seg}`
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'dir' })
    }
  }

  file(path: string, text = 'x', mtimeMs = 1_700_000_000_000): void {
    const p = normalizePath(path)
    this.dir(dirName(p))
    this.nodes.set(p, { kind: 'file', text, mtimeMs })
  }

  link(path: string, target: string): void {
    const p = normalizePath(path)
    this.dir(dirName(p))
    this.nodes.set(p, { kind: 'link', target: normalizePath(target) })
  }

  io(run: (argv: string[]) => IORun): IO {
    const tree = this
    const info = (node: Node, isLink: boolean): Omit<IOStat, 'realPath'> =>
      node.kind === 'file'
        ? { kind: 'file', size: new TextEncoder().encode(node.text).length, mtimeMs: node.mtimeMs, isLink }
        : { kind: node.kind === 'dir' ? 'dir' : 'other', size: 0, mtimeMs: 0, isLink }
    return {
      async readText(path) {
        tree.reads.push(path)
        const node = tree.nodes.get(tree.real(path))
        if (node?.kind !== 'file') throw new Error('ENOENT')
        return node.text
      },
      async readBase64() {
        throw new Error('guard never reads bytes')
      },
      async writeText() {
        throw new Error('guard never writes')
      },
      async list(path): Promise<IOEntry[]> {
        const at = tree.real(path)
        if (tree.nodes.get(at)?.kind !== 'dir') return []
        const out: IOEntry[] = []
        for (const [key, node] of tree.nodes) {
          if (key === at || dirName(key) !== at) continue
          const name = key.slice(key.lastIndexOf('/') + 1)
          out.push(node.kind === 'link' ? { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true } : { name, ...info(node, false) })
        }
        return out
      },
      async stat(path, resolve) {
        const own = tree.nodes.get(tree.real(path, false))
        if (!own) return null
        const landed = tree.real(path)
        const target = tree.nodes.get(landed)
        const out: IOStat =
          own.kind === 'link' ? (target ? { ...info(target, true) } : { kind: 'other', size: 0, mtimeMs: 0, isLink: true }) : info(own, false)
        if (resolve && target) out.realPath = landed
        return out
      },
      async run(argv) {
        return run(argv)
      },
      now: () => clock.now,
    }
  }
}

const clock = { now: 1_800_000_000_000 }

/** A scripted git: answers exactly the commands guard.ts is allowed to ask. */
class Git {
  isRepo = true
  tracked = new Set<string>()
  ignored = new Set<string>()
  untracked: string[] = []
  calls: string[][] = []
  /** Exit code to answer for the next calls of a command name (`ls-files`...). */
  breakCmd = new Set<string>()

  handle = (argv: string[]): IORun => {
    if (argv[0] !== 'git') return { exitCode: -1, stdout: '', stderr: 'not found' }
    const at = argv.indexOf('-C')
    const rest = argv.slice(at + 2)
    this.calls.push(rest)
    // `--literal-pathspecs` is a global option placed before the command; the real `check-ignore` refuses it.
    const literal = rest[0] === '--literal-pathspecs'
    const [cmd, ...args] = literal ? rest.slice(1) : rest
    const done = (exitCode: number, stdout = ''): IORun => ({ exitCode, stdout, stderr: '' })
    if (cmd === 'check-ignore' && literal) return done(128)
    if (this.breakCmd.has(cmd ?? '')) return done(128)
    if (cmd === 'rev-parse' && args[0] === '--is-inside-work-tree') return this.isRepo ? done(0, 'true\n') : done(128)
    if (!this.isRepo) return done(128)
    if (cmd === 'ls-files' && args[0] === '--error-unmatch') return this.tracked.has(args[args.length - 1] ?? '') ? done(0, `${args[args.length - 1]}\n`) : done(1)
    if (cmd === 'check-ignore') {
      // Names stand after `--`. Like git: exit 0 when some are ignored (with -z they are printed, NUL-ended), 1 when none.
      const hit = args.slice(args.indexOf('--') + 1).filter(n => this.ignored.has(n))
      return hit.length === 0 ? done(1) : done(0, args.includes('-z') ? hit.map(n => `${n}\0`).join('') : '')
    }
    if (cmd === 'ls-files' && args[0] === '--others') return done(0, this.untracked.map(u => `${u}\0`).join(''))
    return done(129)
  }
}

type World = { tree: Tree; git: Git; io: IO; place: Place }

function world(): World {
  const tree = new Tree()
  const git = new Git()
  tree.dir(ROOT)
  tree.dir(HOME)
  clock.now += 1_000_000 // a new moment: nothing cached by an earlier test is still fresh
  resetGuardCache()
  return { tree, git, io: tree.io(git.handle), place: { root: ROOT, cwd: ROOT, home: HOME } }
}

/** The git command of a recorded call, past the `--literal-pathspecs` option that may stand before it. */
const cmdOf = (c: string[]): string | undefined => (c[0] === '--literal-pathspecs' ? c[1] : c[0])
const call = (tool: string, input: Record<string, unknown>) => ({ tool, input })
const bash = (command: string) => call('Bash', { command })
const at = (rel: string, root = ROOT) => `${root}/${rel}`

async function run(w: World, c: { tool: string; input: Record<string, unknown> }, place: Place = w.place): Promise<Assessment> {
  return assess(w.io, c, place)
}

const kinds = (a: Assessment) => a.risks.map(r => r.kind)

// ---------------------------------------------------------------------------------------------------------------------

describe('isWatched', () => {
  test('the tools that can lose data', () => {
    for (const t of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(isWatched(t), t).toBe(true)
  })
  test('everything else is left alone', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'bash', 'BASH', 'WebFetch', 'Task', 'mcp__x__write', '', ' Bash', 'Bash ', 'NotebookRead'])
      expect(isWatched(t), t).toBe(false)
    expect(isWatched(undefined as unknown as string)).toBe(false)
    expect(isWatched(42 as unknown as string)).toBe(false)
  })
  test('the limits', () => expect(SNAPSHOT_LIMITS.maxFiles).toBe(50_000))
})

describe('expandBraces', () => {
  const table: [string, string[]][] = [
    ['plain', ['plain']],
    ['a/{b,c}', ['a/b', 'a/c']],
    ['{a,b}/{c,d}', ['a/c', 'a/d', 'b/c', 'b/d']],
    ['x{1..3}', ['x1', 'x2', 'x3']],
    ['x{3..1}', ['x3', 'x2', 'x1']],
    ['f{a..c}.txt', ['fa.txt', 'fb.txt', 'fc.txt']],
    ['a{b,c{d,e}}', ['ab', 'acd', 'ace']],
    ['{a}', ['{a}']],
    ['{}', ['{}']],
    ['a{b', ['a{b']],
    ['a}b{', ['a}b{']],
    ['{,a}', ['', 'a']],
    ['a{b,}c', ['abc', 'ac']],
    ['no braces here*', ['no braces here*']],
  ]
  for (const [input, want] of table) test(JSON.stringify(input), () => expect(expandBraces(input)).toEqual(want))
  test('too many alternatives gives up (null) instead of exploding', () => {
    expect(expandBraces('{1..1000}')).toBeNull()
    expect(expandBraces('{a,b,c,d,e}{a,b,c,d,e}{a,b,c,d,e}{a,b,c,d,e}')).toBeNull()
    expect(expandBraces('{1..100}')?.length).toBe(100)
    expect(expandBraces('{1..100}', 10)).toBeNull()
  })
  test('hostile input stays fast and total', () => {
    const t0 = Date.now()
    expect(expandBraces('{'.repeat(3000) + '}'.repeat(3000))).not.toBeUndefined()
    expect(expandBraces('x'.repeat(100_000))).toBeNull()
    expect(expandBraces(undefined as unknown as string)).toBeNull()
    expect(expandBraces('{a,b' + ',c'.repeat(200) + '}')).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('Write / Edit / MultiEdit / NotebookEdit', () => {
  test('a file that does not exist yet: nothing to lose', async () => {
    const w = world()
    const a = await run(w, call('Write', { file_path: at('new.txt'), content: 'hi' }))
    expect(a).toEqual({ risks: [], targets: [], isUnknown: false, isGit: false, cheap: false })
  })

  test('an existing file git does not track: saved quietly first (tier snapshot)', async () => {
    const w = world()
    w.tree.file(at('notes.txt'), 'old')
    const a = await run(w, call('Write', { file_path: at('notes.txt'), content: 'new' }))
    expect(a.risks).toEqual([{ kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: ['notes.txt'] }])
    expect(a.targets).toEqual(['notes.txt'])
    expect(a.isGit).toBe(true)
    expect(a.isUnknown).toBe(false)
    expect(a.env).toBeUndefined()
    expect(w.git.calls).toContainEqual(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', 'notes.txt'])
    expect(w.git.calls).toContainEqual(['check-ignore', '-q', '--', 'notes.txt'])
  })

  test('a file git tracks is safe: git has it', async () => {
    const w = world()
    w.tree.file(at('src/app.ts'))
    w.git.tracked.add('src/app.ts')
    const a = await run(w, call('Edit', { file_path: at('src/app.ts'), old_string: 'a', new_string: 'b' }))
    expect(a.risks).toEqual([])
    expect(a.targets).toEqual([])
    expect(a.isGit).toBe(true)
    expect(w.git.calls.some(c => c[0] === 'check-ignore')).toBe(false) // only asked when not tracked
  })

  test('an ignored file is saved quietly (a change in what it is made of can be costly to regenerate): a snapshot-tier risk', async () => {
    const w = world()
    w.tree.file(at('dist/out.js'))
    w.git.ignored.add('dist/out.js')
    const a = await run(w, call('Write', { file_path: at('dist/out.js'), content: '' }))
    expect(a.risks).toEqual([{ kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: ['dist/out.js'] }])
    expect(a.targets).toEqual(['dist/out.js'])
    expect(w.git.calls.some(c => c[0] === 'check-ignore')).toBe(true)
  })

  test('outside a git repository (or git missing) an existing file is still saved', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.git.isRepo = false
    const a = await run(w, call('Write', { file_path: at('a.txt'), content: '' }))
    expect(a.risks[0]?.tier).toBe('snapshot')
    expect(a.targets).toEqual(['a.txt'])
    expect(a.isGit).toBe(false)
    expect(w.git.calls.every(c => c[0] === 'rev-parse')).toBe(true) // no ls-files or check-ignore outside a repo
    const w2 = world()
    w2.tree.file(at('a.txt'))
    w2.io = w2.tree.io(() => ({ exitCode: -1, stdout: '', stderr: 'git: not found' }))
    const b = await run(w2, call('Write', { file_path: at('a.txt'), content: '' }))
    expect(b.targets).toEqual(['a.txt'])
    expect(b.isGit).toBe(false)
  })

  test('when git cannot say whether the file is tracked, it is treated as untracked and saved', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.git.breakCmd.add('ls-files')
    const a = await run(w, call('Write', { file_path: at('a.txt'), content: '' }))
    expect(a.targets).toEqual(['a.txt'])
    expect(a.risks[0]?.tier).toBe('snapshot')
    expect(w.git.calls.some(c => c[0] === 'check-ignore')).toBe(false)
  })

  test('a .env-like file always asks (tier ask), tracked or not, and no git call is needed', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\nB=2\n')
    w.git.tracked.add('.env')
    const a = await run(w, call('Write', { file_path: at('.env'), content: 'A=1\nC=3\n' }))
    expect(a.risks).toEqual([{ kind: 'overwrite', tier: 'ask', label: 'Write', paths: ['.env'] }])
    expect(a.targets).toEqual(['.env'])
    expect(a.env).toEqual({ before: 2, after: 2, removed: ['B'], added: ['C'] })
    expect(w.git.calls.some(c => cmdOf(c) === 'ls-files')).toBe(false)
  })

  test('.env.example is a template: an ordinary file', async () => {
    const w = world()
    w.tree.file(at('.env.example'), 'A=1\n')
    w.git.tracked.add('.env.example')
    expect((await run(w, call('Write', { file_path: at('.env.example'), content: '' }))).risks).toEqual([])
  })

  test('Edit: the new text is the file with the edit applied when old_string occurs exactly once', async () => {
    const w = world()
    w.tree.file(at('.env.local'), 'A=1\nB=2\n')
    const a = await run(w, call('Edit', { file_path: at('.env.local'), old_string: 'B=2\n', new_string: 'B=2\nC=3\n' }))
    expect(a.env).toEqual({ before: 2, after: 3, removed: [], added: ['C'] })
    const twice = await run(w, call('Edit', { file_path: at('.env.local'), old_string: '=', new_string: ':' }))
    expect(twice.env).toBeUndefined() // ambiguous: not guessed
    const missing = await run(w, call('Edit', { file_path: at('.env.local'), old_string: 'Z=9', new_string: '' }))
    expect(missing.env).toBeUndefined()
    const all = await run(w, call('Edit', { file_path: at('.env.local'), old_string: 'B=2\n', new_string: '', replace_all: true }))
    expect(all.env).toEqual({ before: 2, after: 1, removed: ['B'], added: [] })
    expect(a.risks[0]?.tier).toBe('ask')
  })

  test('Edit: a replacement text with $ patterns is inserted as it is', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\n')
    const a = await run(w, call('Edit', { file_path: at('.env'), old_string: 'A=1', new_string: 'B=$&$1' }))
    expect(a.env).toEqual({ before: 1, after: 1, removed: ['A'], added: ['B'] })
  })

  test('MultiEdit applies its edits in order; one that is unclear leaves the diff unknown', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\nB=2\n')
    const edits = [
      { old_string: 'A=1', new_string: 'A=9' },
      { old_string: 'B=2', new_string: 'C=2' },
    ]
    const a = await run(w, call('MultiEdit', { file_path: at('.env'), edits }))
    expect(a.env).toEqual({ before: 2, after: 2, removed: ['B'], added: ['C'] })
    expect(a.risks[0]?.label).toBe('MultiEdit')
    const bad = await run(w, call('MultiEdit', { file_path: at('.env'), edits: [...edits, { old_string: 'nope', new_string: 'x' }] }))
    expect(bad.env).toBeUndefined()
    expect(bad.risks).toHaveLength(1)
    const junk = await run(w, call('MultiEdit', { file_path: at('.env'), edits: ['x', null, 5] }))
    expect(junk.env).toBeUndefined()
  })

  test('a .env larger than 256 KB is not read', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\n'.repeat(70_000))
    const a = await run(w, call('Write', { file_path: at('.env'), content: 'B=1\n' }))
    expect(a.risks).toHaveLength(1)
    expect(a.env).toBeUndefined()
    expect(w.tree.reads).toEqual([])
  })

  test('NotebookEdit reads notebook_path', async () => {
    const w = world()
    w.tree.file(at('analysis.ipynb'), '{}')
    const a = await run(w, call('NotebookEdit', { notebook_path: at('analysis.ipynb'), new_source: 'x' }))
    expect(a.risks[0]?.label).toBe('NotebookEdit')
    expect(a.targets).toEqual(['analysis.ipynb'])
    expect(await run(w, call('NotebookEdit', { file_path: at('analysis.ipynb') }))).toEqual({ risks: [], targets: [], isUnknown: false, isGit: false, cheap: false })
  })

  test('relative paths are read from the working folder; ~ from home', async () => {
    const w = world()
    w.tree.file(at('web/a.txt'))
    const sub = { ...w.place, cwd: at('web') }
    expect((await run(w, call('Write', { file_path: 'a.txt', content: '' }), sub)).targets).toEqual(['web/a.txt'])
    expect((await run(w, call('Write', { file_path: '../web/./a.txt', content: '' }), sub)).targets).toEqual(['web/a.txt'])
    const inHome = { root: `${HOME}/proj`, cwd: `${HOME}/proj`, home: HOME }
    w.tree.file(`${HOME}/proj/n.txt`)
    expect((await run(w, call('Write', { file_path: '~/proj/n.txt', content: '' }), inHome)).targets).toEqual(['n.txt'])
  })

  test('a path outside the project is not our business', async () => {
    const w = world()
    w.tree.file('/etc/hosts')
    w.tree.file('/work/other/a.txt')
    w.tree.file('/work/acme-shop-two/a.txt') // a sibling that shares the prefix
    for (const p of ['/etc/hosts', '/work/other/a.txt', '/work/acme-shop-two/a.txt', '../other/a.txt'])
      expect((await run(w, call('Write', { file_path: p, content: '' }))).risks, p).toEqual([])
  })

  test('a folder is not a file: nothing lost by Write on it', async () => {
    const w = world()
    w.tree.dir(at('src'))
    expect((await run(w, call('Write', { file_path: at('src'), content: '' }))).risks).toEqual([])
  })

  test('a link inside the project writes through to the file it reaches: that one is the target', async () => {
    const w = world()
    w.tree.file(at('real/data.txt'))
    w.tree.link(at('alias.txt'), at('real/data.txt'))
    const a = await run(w, call('Write', { file_path: at('alias.txt'), content: '' }))
    expect(a.targets).toEqual(['real/data.txt'])
  })

  test('a link that leads out of the project is not followed: not our business', async () => {
    const w = world()
    w.tree.file('/etc/secret.conf')
    w.tree.link(at('conf'), '/etc/secret.conf')
    w.tree.link(at('etc-dir'), '/etc')
    expect((await run(w, call('Write', { file_path: at('conf'), content: '' }))).risks).toEqual([])
    expect((await run(w, call('Write', { file_path: at('etc-dir/secret.conf'), content: '' }))).risks).toEqual([])
  })

  test('a folder link inside the project: the real place counts, so the target is the real path', async () => {
    const w = world()
    w.tree.file(at('packages/core/index.ts'))
    w.tree.link(at('core'), at('packages/core'))
    const a = await run(w, call('Write', { file_path: at('core/index.ts'), content: '' }))
    expect(a.targets).toEqual(['packages/core/index.ts'])
  })

  test('a root that is itself reached through a link: paths are compared by their real place', async () => {
    const w = world()
    w.tree.file('/srv/data/acme/a.txt')
    w.tree.link('/work/link-root', '/srv/data/acme')
    const place = { root: '/work/link-root', cwd: '/work/link-root', home: HOME }
    const a = await run(w, call('Write', { file_path: '/work/link-root/a.txt', content: '' }), place)
    expect(a.targets).toEqual(['a.txt'])
    const given = { ...place, realRoot: '/srv/data/acme' }
    expect((await run(w, call('Write', { file_path: '/work/link-root/a.txt', content: '' }), given)).targets).toEqual(['a.txt'])
  })

  test('the project named by its real folder is still the project; a link inside that leads out is not', async () => {
    const w = world()
    w.tree.file('/srv/data/acme/a.txt')
    w.tree.file('/srv/data/acme/sub/b.txt')
    w.tree.file('/elsewhere/c.txt')
    w.tree.link('/work/link-root', '/srv/data/acme')
    w.tree.link('/srv/data/acme/out', '/elsewhere')
    const place = { root: '/work/link-root', cwd: '/work/link-root', home: HOME }
    expect((await run(w, call('Write', { file_path: '/srv/data/acme/a.txt', content: '' }), place)).targets).toEqual(['a.txt'])
    expect((await run(w, call('Write', { file_path: '/work/link-root/sub/b.txt', content: '' }), place)).targets).toEqual(['sub/b.txt'])
    expect((await run(w, call('Write', { file_path: '/work/link-root/out/c.txt', content: '' }), place)).risks).toEqual([])
    expect((await run(w, call('Write', { file_path: '/elsewhere/c.txt', content: '' }), place)).risks).toEqual([])
  })

  test('a path that cannot be read from its spelling is flagged, never guessed', async () => {
    const w = world()
    for (const p of ['$HOME/x.txt', '~other/x.txt', '`pwd`/x', '$(pwd)/x.txt', 'C:x.txt'])
      expect(await run(w, call('Write', { file_path: p, content: '' })), p).toEqual({ risks: [], targets: [], isUnknown: true, isGit: false, cheap: false })
  })

  test('missing or odd inputs are quiet', async () => {
    const w = world()
    const quiet = { risks: [], targets: [], isUnknown: false, isGit: false, cheap: false }
    for (const input of [{}, { file_path: '' }, { file_path: 5 }, { file_path: null }, { file_path: ['a'] }]) expect(await run(w, call('Write', input as never))).toEqual(quiet)
  })

  test('a file name with pattern characters is asked about literally', async () => {
    const w = world()
    w.tree.file(at('weird[1]*.txt'))
    const a = await run(w, call('Write', { file_path: at('weird[1]*.txt'), content: '' }))
    expect(a.targets).toEqual(['weird[1]*.txt'])
    expect(w.git.calls).toContainEqual(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', 'weird[1]*.txt'])
  })

  test('Windows spellings: C:\\ paths, mixed slashes, case-insensitive root', async () => {
    const w = world()
    const root = 'C:\\Users\\dev\\acme-shop'
    w.tree.file('C:/Users/dev/acme-shop/src/a.txt')
    w.tree.file('C:/Users/dev/acme-shop/.env')
    const place = { root, cwd: root, home: 'C:\\Users\\dev' }
    expect((await run(w, call('Write', { file_path: 'C:\\Users\\dev\\acme-shop\\src\\a.txt', content: '' }), place)).targets).toEqual(['src/a.txt'])
    // The folder is spelled in another case: Windows does not care.
    const lower = { root: 'c:\\users\\dev\\acme-shop', cwd: 'c:\\users\\dev\\acme-shop', home: 'C:\\Users\\dev' }
    expect((await run(w, call('Write', { file_path: 'C:\\Users\\dev\\acme-shop\\src\\a.txt', content: '' }), lower)).targets).toEqual(['src/a.txt'])
    expect((await run(w, call('Write', { file_path: 'src\\a.txt', content: '' }), place)).targets).toEqual(['src/a.txt'])
    expect((await run(w, call('Write', { file_path: '.env', content: 'A=1' }), place)).risks[0]?.tier).toBe('ask')
    expect((await run(w, call('Write', { file_path: 'D:\\other\\a.txt', content: '' }), place)).risks).toEqual([])
    expect(w.git.calls.length).toBeGreaterThan(0)
  })
})

describe('Bash: delete', () => {
  test('rm -rf of a folder: the folder is the target', async () => {
    const w = world()
    w.tree.file(at('build/a.js'))
    w.tree.file(at('build/sub/b.js'))
    const a = await run(w, bash('rm -rf build'))
    expect(kinds(a)).toEqual(['delete'])
    expect(a.risks[0]?.tier).toBe('snapshot') // a folder every build makes again is a quiet cleanup (see "everyday cleanups" below)
    expect(a.cheap).toBe(true)
    expect(a.targets).toEqual(['build'])
    expect(a.isGit).toBe(true)
    expect(a.isUnknown).toBe(false)
    // Any other folder is still asked about.
    w.tree.file(at('old-reports/a.pdf'))
    const b = await run(w, bash('rm -rf old-reports'))
    expect(b.risks[0]?.tier).toBe('ask')
    expect(b.cheap).toBe(false)
    expect(b.targets).toEqual(['old-reports'])
  })

  test('several operands, files and folders, deduplicated; a child of another target is dropped', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.tree.file(at('dist/x.js'))
    w.tree.file(at('dist/deep/y.js'))
    const a = await run(w, bash('rm -rf dist dist/deep/y.js a.txt a.txt ./a.txt dist/'))
    expect(a.targets).toEqual(['a.txt', 'dist'])
  })

  test('a path that does not exist is dropped; the risk stays so the caller can decide', async () => {
    const w = world()
    const a = await run(w, bash('rm -rf nothing-here'))
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual([])
    expect(a.isUnknown).toBe(false)
  })

  test('a symlink is never a target: deleting a link loses no data', async () => {
    const w = world()
    w.tree.file(at('real/a.txt'))
    w.tree.link(at('alias'), at('real'))
    w.tree.link(at('alias.txt'), at('real/a.txt'))
    const a = await run(w, bash('rm -rf alias alias.txt'))
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual([])
  })

  test('a path through a symlinked folder that leads out of the project is dropped', async () => {
    const w = world()
    w.tree.file('/data/big/a.bin')
    w.tree.link(at('out'), '/data/big')
    const a = await run(w, bash('rm -rf out/a.bin'))
    expect(a.targets).toEqual([])
  })

  test('a path through a symlinked folder that stays inside is saved by its real place', async () => {
    const w = world()
    w.tree.file(at('packages/core/a.ts'))
    w.tree.link(at('core'), at('packages/core'))
    expect((await run(w, bash('rm -rf core/a.ts'))).targets).toEqual(['packages/core/a.ts'])
  })

  test('a path outside the project is not in the targets', async () => {
    const w = world()
    w.tree.file(at('keep/a.txt'))
    w.tree.file('/work/other/b.txt')
    const a = await run(w, bash('rm -rf keep /work/other ../other /work/acme-shop-two'))
    expect(a.targets).toEqual(['keep'])
  })

  test('an unknown path ($DIR, $(...)) is flagged', async () => {
    const w = world()
    const a = await run(w, bash('rm -rf "$DIR"'))
    expect(kinds(a)).toEqual(['delete'])
    expect(a.isUnknown).toBe(true)
    expect(a.targets).toEqual([])
    const b = await run(w, bash('rm -rf $(cat list.txt) build'))
    expect(b.isUnknown).toBe(true)
  })

  test('cd in a chain: paths arrive absolute and are resolved as they are', async () => {
    const w = world()
    w.tree.file(at('web/dist/a.js'))
    const a = await run(w, bash('cd web && rm -rf dist'))
    expect(a.targets).toEqual(['web/dist'])
    const b = await run(w, bash(`cd ${ROOT}/web && rm -rf dist/a.js`))
    expect(b.targets).toEqual(['web/dist/a.js'])
  })

  test('~ and ./ and .. spellings', async () => {
    const w = world()
    w.tree.file(`${HOME}/proj/build/a`)
    w.tree.file(`${HOME}/proj/web/x`)
    const place = { root: `${HOME}/proj`, cwd: `${HOME}/proj/web`, home: HOME }
    expect((await run(w, bash('rm -rf ~/proj/build'), place)).targets).toEqual(['build'])
    expect((await run(w, bash('rm -rf ../build ./x'), place)).targets).toEqual(['build', 'web/x'])
  })

  test('a call from a sub-folder: relative paths are read from there', async () => {
    const w = world()
    w.tree.file(at('web/dist/a.js'))
    const place = { ...w.place, cwd: at('web') }
    expect((await run(w, bash('rm -rf dist'), place)).targets).toEqual(['web/dist'])
  })

  test('PowerShell: Remove-Item with Windows paths', async () => {
    const w = world()
    w.tree.file('C:/Users/dev/acme/build/a.js')
    const place = { root: 'C:\\Users\\dev\\acme', cwd: 'C:\\Users\\dev\\acme', home: 'C:\\Users\\dev' }
    const a = await run(w, call('PowerShell', { command: 'Remove-Item -Recurse -Force .\\build' }), place)
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual(['build'])
    const b = await run(w, call('PowerShell', { command: 'Remove-Item -Recurse C:\\Users\\dev\\acme\\build\\a.js' }), place)
    expect(b.targets).toEqual(['build/a.js'])
  })

  test('commands that are not risky: nothing, and no process is started', async () => {
    const w = world()
    for (const c of ['ls -la', 'echo "rm -rf /"', 'git status', 'rm file.txt', 'git push', 'git reset --soft HEAD~1']) {
      const a = await run(w, bash(c))
      expect(a, c).toEqual({ risks: [], targets: [], isUnknown: false, isGit: false, cheap: false })
    }
    expect(w.git.calls).toEqual([])
  })
})

describe('Bash: wildcards and braces', () => {
  function shop(w: World): void {
    w.tree.file(at('src/a.map'))
    w.tree.file(at('src/b.map'))
    w.tree.file(at('src/c.js'))
    w.tree.file(at('src/.hidden.map'))
    w.tree.file(at('src/deep/d.map'))
    w.tree.file(at('docs/readme.md'))
    w.tree.file(at('.env'))
    w.tree.file(at('.git/HEAD'))
    w.tree.file(at('package.json'))
  }

  test('src/*.map: one folder level, dotfiles not matched', async () => {
    const w = world()
    shop(w)
    expect((await run(w, bash('rm -rf src/*.map'))).targets).toEqual(['src/a.map', 'src/b.map'])
  })

  test('a pattern that starts with a dot does match dotfiles', async () => {
    const w = world()
    shop(w)
    expect((await run(w, bash('rm -rf src/.*.map'))).targets).toEqual(['src/.hidden.map'])
  })

  test('a wildcard in the middle: */x and src/*/*.map; ** acts as *', async () => {
    const w = world()
    shop(w)
    expect((await run(w, bash('rm -rf */readme.md'))).targets).toEqual(['docs/readme.md'])
    expect((await run(w, bash('rm -rf src/*/*.map'))).targets).toEqual(['src/deep/d.map'])
    expect((await run(w, bash('rm -rf src/**/*.map'))).targets).toEqual(['src/deep/d.map'])
  })

  test('? and [..] sets', async () => {
    const w = world()
    shop(w)
    expect((await run(w, bash('rm -rf src/?.map src/[ab].map'))).targets).toEqual(['src/a.map', 'src/b.map'])
    expect((await run(w, bash('rm -rf src/[!a].map'))).targets).toEqual(['src/b.map'])
  })

  test('braces are written out first, then looked up', async () => {
    const w = world()
    shop(w)
    expect((await run(w, bash('rm -rf src/{a,c}.* docs/{readme.md,missing.md}'))).targets.sort()).toEqual(['docs/readme.md', 'src/a.map', 'src/c.js'].sort())
    expect((await run(w, bash('rm -rf src/{a..b}.map'))).targets).toEqual(['src/a.map', 'src/b.map'])
    const huge = await run(w, bash('rm -rf src/{1..500}'))
    expect(huge.isUnknown).toBe(true)
  })

  test('a pattern with no match gives no target and no error', async () => {
    const w = world()
    shop(w)
    const a = await run(w, bash('rm -rf src/*.zzz nodir/*'))
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual([])
    expect(a.isUnknown).toBe(false)
  })

  test('a wildcard never walks into a symlinked folder, and a matched link is not a target', async () => {
    const w = world()
    shop(w)
    w.tree.file('/data/x/secret.map')
    w.tree.link(at('src/outlink'), '/data/x')
    w.tree.link(at('src/z.map'), at('src/a.map'))
    const a = await run(w, bash('rm -rf src/*/*.map src/*.map'))
    expect(a.targets).toEqual(['src/a.map', 'src/b.map', 'src/deep/d.map'])
  })

  test('a base folder that is a link out of the project is not read at all', async () => {
    const w = world()
    w.tree.file('/data/x/a.log')
    w.tree.link(at('logs'), '/data/x')
    const a = await run(w, bash('rm -rf logs/*'))
    expect(a.targets).toEqual([])
    expect(a.isUnknown).toBe(false)
  })

  test('a base folder outside the project is not listed (and costs no read)', async () => {
    const w = world()
    w.tree.file('/tmp/build/a.o')
    const a = await run(w, bash('rm -rf /tmp/build/*'))
    expect(a.risks).toEqual([]) // risk.ts: outside the project and not above it
    const b = await run(w, bash(`rm -rf /work/*`))
    expect(b.targets).toEqual([]) // would include the project's own folder: whole project
  })

  test('more than 5 000 matches: the first 5 000, and the answer says it is cut', async () => {
    const w = world()
    for (let i = 0; i < 5_050; i += 1) w.tree.file(at(`tmp/f${String(i).padStart(5, '0')}`))
    const a = await run(w, bash('rm -rf tmp/*'))
    expect(a.targets).toHaveLength(5_000)
    expect(a.isUnknown).toBe(true)
    const b = await run(w, bash('rm -rf tmp'))
    expect(b.targets).toEqual(['tmp'])
    expect(b.isUnknown).toBe(false)
  })

  test('a quoted pattern is treated as the literal it is written (a file really named like that)', async () => {
    const w = world()
    w.tree.file(at('odd*name'))
    w.tree.file(at('oddxname'))
    const a = await run(w, bash('rm -rf "odd*name"'))
    expect(a.targets.sort()).toEqual(['odd*name', 'oddxname']) // over-protective, never under
  })
})

describe('Bash: the whole project (the root and its ancestors)', () => {
  function project(w: World): void {
    w.tree.file(at('src/a.ts'))
    w.tree.file(at('README.md'))
    w.tree.file(at('.env'))
    w.tree.file(at('.git/HEAD'))
    w.tree.file(at('.git/objects/aa/bb'))
    w.tree.link(at('alias'), at('src'))
    w.tree.file('/work/other/keep.txt')
    w.tree.file('/work/stray.txt')
  }
  const WHOLE = ['.env', 'README.md', 'src'] // top-level entries, no .git, no link

  for (const cmd of ['rm -rf .', 'rm -rf ..', 'rm -rf ../acme-shop', `rm -rf ${ROOT}`, 'rm -rf /work', 'rm -rf /', 'rm -rf ../*', 'rm -rf ../../work', 'cd .. && rm -rf *', 'cd /work && rm -rf *', 'rm -rf ./*', 'rm -rf .*']) {
    test(cmd, async () => {
      const w = world()
      project(w)
      const a = await run(w, bash(cmd))
      expect(kinds(a), cmd).toEqual(['delete'])
      const want = cmd === 'rm -rf .*' ? ['.env', '.git'] : cmd === 'rm -rf ./*' ? ['README.md', 'src'] : WHOLE
      expect(a.targets, cmd).toEqual(want)
      expect(a.targets.every(t => !t.startsWith('..') && !t.startsWith('/')), cmd).toBe(true)
    })
  }

  test('~ above the project is the whole project; ~ equal to the root is too much to save', async () => {
    const w = world()
    w.tree.file(`${HOME}/proj/a.txt`)
    w.tree.file(`${HOME}/proj/.git/HEAD`)
    w.tree.file(`${HOME}/other/b.txt`)
    const under = { root: `${HOME}/proj`, cwd: `${HOME}/proj`, home: HOME }
    expect((await run(w, bash('rm -rf ~'), under)).targets).toEqual(['a.txt'])
    const same = { root: HOME, cwd: HOME, home: HOME }
    const a = await run(w, bash('rm -rf ~'), same)
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual([])
    // ...but a named path inside the home folder is still saved.
    expect((await run(w, bash('rm -rf ~/other/b.txt'), same)).targets).toEqual(['other/b.txt'])
    expect((await run(w, bash('rm -rf ~/*'), same)).targets).toEqual(['other', 'proj'])
  })

  test('a filesystem root as the project root: nothing is saved, the risk stays', async () => {
    const w = world()
    w.tree.file('/etc/hosts')
    const place = { root: '/', cwd: '/', home: HOME }
    const a = await run(w, bash('rm -rf /etc'), place)
    expect(a.targets).toEqual([])
    const b = await run(w, bash('rm -rf /'), place)
    expect(b.targets).toEqual([])
    expect(kinds(b).length).toBeGreaterThan(0)
  })

  test('a root that is not an absolute path: nothing is saved, nothing throws', async () => {
    const w = world()
    const a = await run(w, bash('rm -rf build'), { root: 'acme-shop', cwd: 'acme-shop', home: HOME })
    expect(a.targets).toEqual([])
  })

  test('the root with nothing but .git in it has no top-level targets', async () => {
    const w = world()
    w.tree.file(at('.git/HEAD'))
    const a = await run(w, bash('rm -rf *'))
    expect(a.targets).toEqual([])
  })
})

describe('Bash: a delete that covers the project also deletes its .git, which is never copied', () => {
  function project(w: World, withGit: boolean): void {
    w.tree.file(at('src/a.ts'))
    w.tree.file(at('README.md'))
    if (withGit) w.tree.file(at('.git/HEAD'))
  }
  for (const cmd of ['rm -rf .', 'rm -rf ..', 'rm -rf ../acme-shop', `rm -rf ${ROOT}`, 'rm -rf /work']) {
    test(`${cmd}: losesGit`, async () => {
      const w = world()
      project(w, true)
      const a = await run(w, bash(cmd))
      expect(a.losesGit, cmd).toBe(true)
      expect(a.targets, cmd).not.toContain('.git')
    })
  }
  test('no .git, a glob that skips it, or a folder inside the project: not flagged', async () => {
    const w = world()
    project(w, false)
    expect((await run(w, bash('rm -rf .'))).losesGit).toBeUndefined()
    const g = world()
    project(g, true)
    expect((await run(g, bash('rm -rf *'))).losesGit).toBeUndefined()
    expect((await run(g, bash('rm -rf src'))).losesGit).toBeUndefined()
  })
  test('a git discard of the whole tree is not a delete of .git', async () => {
    const w = world()
    project(w, true)
    expect((await run(w, bash('git checkout -- .'))).losesGit).toBeUndefined()
  })
})

describe('Bash: something that exists but has no safe relative path is asked about (never taken for nothing)', () => {
  for (const name of ['we\\ird', 'a:backup']) {
    test(`a folder named ${name}`, async () => {
      const w = world()
      w.tree.file(at(`${name}/x.txt`))
      const a = await run(w, bash(`rm -rf '${name}'`))
      expect(kinds(a)).toEqual(['delete'])
      expect(a.targets).toEqual([])
      expect(a.isUnknown).toBe(true)
      expect(a.cheap).toBe(false)
    })
  }
  test('rm -rf . with an odd name at the top of the project', async () => {
    const w = world()
    w.tree.file(at('src/a.ts'))
    w.tree.file(at('we\\ird/x.txt'))
    const a = await run(w, bash('rm -rf .'))
    expect(a.targets).toEqual(['src'])
    expect(a.isUnknown).toBe(true)
  })
  test('a name with a backslash that is simply not there is still nothing', async () => {
    const w = world()
    const a = await run(w, bash("rm -rf 'we\\ird'"))
    expect(a.isUnknown).toBe(false)
  })
})

describe('Bash: a project reached through a link', () => {
  test('wildcards and plain paths are saved by their real place', async () => {
    const w = world()
    w.tree.file('/srv/data/acme/dist/a.js')
    w.tree.file('/srv/data/acme/dist/b.js')
    w.tree.file('/srv/data/acme/keep.txt')
    w.tree.link('/work/link-root', '/srv/data/acme')
    const place = { root: '/work/link-root', cwd: '/work/link-root', home: HOME }
    expect((await run(w, bash('rm -rf dist/*.js'), place)).targets).toEqual(['dist/a.js', 'dist/b.js'])
    expect((await run(w, bash('rm -rf dist'), place)).targets).toEqual(['dist'])
    expect((await run(w, bash('rm -rf *'), place)).targets).toEqual(['dist', 'keep.txt'])
    expect((await run(w, bash('rm -rf .'), place)).targets).toEqual(['dist', 'keep.txt'])
  })
})

describe('Bash: overwrite (.env)', () => {
  test('cp over an existing .env: the file is saved, and the diff comes from the source file', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\nB=2\n')
    w.tree.file(at('.env.production'), 'A=1\nC=3\n')
    const a = await run(w, bash('cp .env.production .env'))
    expect(kinds(a)).toEqual(['overwrite'])
    expect(a.risks[0]?.tier).toBe('ask')
    expect(a.targets).toEqual(['.env'])
    expect(a.env).toEqual({ before: 2, after: 2, removed: ['B'], added: ['C'] })
  })

  test('mv over .env: same', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\n')
    w.tree.file(at('new.txt'), 'B=1\n')
    const a = await run(w, bash('mv new.txt .env'))
    expect(a.targets).toEqual(['.env'])
    expect(a.env).toEqual({ before: 1, after: 1, removed: ['A'], added: ['B'] })
  })

  test('a redirect onto .env: saved, new content unknown', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\n')
    const a = await run(w, bash('echo A=2 > .env'))
    expect(kinds(a)).toEqual(['overwrite'])
    expect(a.targets).toEqual(['.env'])
    expect(a.env).toBeUndefined()
  })

  test('copying onto a .env that does not exist yet is not a risk', async () => {
    const w = world()
    w.tree.file(at('.env.production'), 'A=1\n')
    const a = await run(w, bash('cp .env.production .env'))
    expect(a.risks).toEqual([])
    expect(a.targets).toEqual([])
    expect(a.env).toBeUndefined()
  })

  test('a .env that is a folder or a link is not a regular file: no risk', async () => {
    const w = world()
    w.tree.dir(at('.env'))
    expect((await run(w, bash('echo x > .env'))).risks).toEqual([])
    const w2 = world()
    w2.tree.file(at('real.env'), 'A=1')
    w2.tree.link(at('.env'), at('real.env'))
    expect((await run(w2, bash('echo x > .env'))).risks).toEqual([])
  })

  test('the source file is only read when it is small and exists', async () => {
    const w = world()
    w.tree.file(at('.env'), 'A=1\n')
    expect((await run(w, bash('cp missing.env .env'))).env).toBeUndefined()
    w.tree.file(at('big.env'), 'B=1\n'.repeat(70_000))
    expect((await run(w, bash('cp big.env .env'))).env).toBeUndefined()
  })
})

describe('Bash: db-drop', () => {
  test('a sqlite file is a target; a database on the network is a risk with no files', async () => {
    const w = world()
    w.tree.file(at('shop.db'), 'x')
    const a = await run(w, bash('sqlite3 shop.db "drop table orders"'))
    expect(kinds(a)).toEqual(['db-drop'])
    expect(a.targets).toEqual(['shop.db'])
    const b = await run(w, bash('psql -c "drop database shop"'))
    expect(kinds(b)).toEqual(['db-drop'])
    expect(b.targets).toEqual([])
    expect(b.isGit).toBe(true)
  })

  test('a sqlite file that is not there: the risk stays, no target', async () => {
    const w = world()
    const a = await run(w, bash('sqlite3 gone.db "drop table x"'))
    expect(kinds(a)).toEqual(['db-drop'])
    expect(a.targets).toEqual([])
  })
})

describe('Bash: git risks', () => {
  test('reset --hard, checkout -- ., force push, branch -D: risks without files (git itself is the snapshot)', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    for (const [cmd, kind] of [
      ['git reset --hard', 'reset-hard'],
      ['git checkout -- .', 'discard'],
      ['git push --force origin main', 'force-push'],
      ['git branch -D feature/x', 'branch-delete'],
    ] as const) {
      const a = await run(w, bash(cmd))
      expect(kinds(a), cmd).toEqual([kind])
      expect(a.targets, cmd).toEqual([])
      expect(a.isGit, cmd).toBe(true)
    }
  })

  test('outside a repository isGit is false', async () => {
    const w = world()
    w.git.isRepo = false
    const a = await run(w, bash('git reset --hard'))
    expect(kinds(a)).toEqual(['reset-hard'])
    expect(a.isGit).toBe(false)
  })

  test('git clean: the untracked files are the targets (folders kept whole)', async () => {
    const w = world()
    w.git.untracked = ['scratch.txt', 'tmp/', 'notes/draft.md', '', '../escape', '/abs']
    const a = await run(w, bash('git clean -fd'))
    expect(kinds(a)).toEqual(['clean'])
    expect(a.targets).toEqual(['scratch.txt', 'tmp', 'notes/draft.md'].sort((x, y) => x.split('/').length - y.split('/').length || (x < y ? -1 : 1)))
    expect(w.git.calls).toContainEqual(['ls-files', '--others', '--directory', '-z', '--exclude-standard'])
  })

  test('git clean -x also takes ignored files; -X only ignored ones', async () => {
    const w = world()
    w.git.untracked = ['a.txt']
    await run(w, bash('git clean -fdx'))
    expect(w.git.calls).toContainEqual(['ls-files', '--others', '--directory', '-z'])
    await run(w, bash('git clean -fdX'))
    expect(w.git.calls).toContainEqual(['ls-files', '--others', '--directory', '-z', '--ignored', '--exclude-standard'])
  })

  test('git clean when git cannot list: the targets are unknown', async () => {
    const w = world()
    w.git.breakCmd.add('ls-files')
    const a = await run(w, bash('git clean -fd'))
    expect(kinds(a)).toEqual(['clean'])
    expect(a.targets).toEqual([])
    expect(a.isUnknown).toBe(true)
  })

  test('git clean outside a repository: no listing is attempted', async () => {
    const w = world()
    w.git.isRepo = false
    const a = await run(w, bash('git clean -fd'))
    expect(a.targets).toEqual([])
    expect(w.git.calls.every(c => c[0] === 'rev-parse')).toBe(true)
  })

  test('a chain gives every risk, with every target', async () => {
    const w = world()
    w.tree.file(at('build/a'))
    const a = await run(w, bash('rm -rf build && git reset --hard && git push -f'))
    expect(kinds(a)).toEqual(['delete', 'reset-hard', 'force-push'])
    expect(a.targets).toEqual(['build'])
  })
})

describe('guard.ts only asks git read-only questions', () => {
  test('across every kind of call, the git commands are rev-parse, ls-files and check-ignore', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.tree.file(at('.env'), 'A=1')
    w.git.untracked = ['u.txt']
    const calls = [
      call('Write', { file_path: at('a.txt'), content: '' }),
      call('Edit', { file_path: at('.env'), old_string: 'A=1', new_string: 'A=2' }),
      bash('rm -rf a.txt'),
      bash('git clean -fdx'),
      bash('git reset --hard'),
      bash('cp .env .env'),
      bash('cd .. && rm -rf *'),
    ]
    for (const c of calls) await run(w, c)
    const names = new Set(w.git.calls.map(cmdOf))
    expect([...names].sort()).toEqual(['check-ignore', 'ls-files', 'rev-parse'])
  })

  test('the repository question is asked once and remembered, then asked again after a reset', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.tree.file(at('b.txt'))
    await run(w, bash('rm -rf a.txt'))
    await run(w, bash('rm -rf b.txt'))
    expect(w.git.calls.filter(c => c[0] === 'rev-parse')).toHaveLength(1)
    resetGuardCache()
    await run(w, bash('rm -rf a.txt'))
    expect(w.git.calls.filter(c => c[0] === 'rev-parse')).toHaveLength(2)
  })

  test('"not a repository" is remembered only briefly: git init is noticed', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    w.git.isRepo = false
    expect((await run(w, bash('rm -rf a.txt'))).isGit).toBe(false)
    w.git.isRepo = true
    expect((await run(w, bash('rm -rf a.txt'))).isGit).toBe(false) // still remembered
    clock.now += 60_000
    expect((await run(w, bash('rm -rf a.txt'))).isGit).toBe(true)
  })
})

describe('assess never throws', () => {
  test('odd calls', async () => {
    const w = world()
    const empty = { risks: [], targets: [], isUnknown: false, isGit: false, cheap: false }
    for (const c of [
      undefined,
      null,
      {},
      { tool: 'Bash' },
      { tool: 'Bash', input: null },
      { tool: 'Bash', input: { command: 42 } },
      { tool: 'Bash', input: { command: '' } },
      { tool: 'Read', input: { file_path: '/etc/passwd' } },
      { tool: 'Write', input: undefined },
      { tool: 5, input: {} },
    ])
      expect(await assess(w.io, c as never, w.place), JSON.stringify(c)).toEqual(empty)
  })

  test('odd places', async () => {
    const w = world()
    for (const place of [undefined, null, {}, { root: '', cwd: '', home: '' }, { root: 5, cwd: 5, home: 5 }, { root: ROOT }])
      await assess(w.io, bash('rm -rf build'), place as never)
  })

  test('an IO that fails on everything: the risks are still reported', async () => {
    const hostile: IO = {
      readText: () => Promise.reject(new Error('x')),
      readBase64: () => Promise.reject(new Error('x')),
      writeText: () => Promise.reject(new Error('x')),
      list: () => Promise.reject(new Error('x')),
      stat: () => Promise.reject(new Error('x')),
      run: () => Promise.reject(new Error('x')),
      now: () => Promise.reject(new Error('x')),
    }
    const a = await assess(hostile, bash('rm -rf build'), { root: ROOT, cwd: ROOT, home: HOME })
    expect(kinds(a)).toEqual(['delete'])
    expect(a.targets).toEqual([])
    expect(await assess(hostile, call('Write', { file_path: at('a.txt'), content: '' }), { root: ROOT, cwd: ROOT, home: HOME })).toEqual({ risks: [], targets: [], isUnknown: false, isGit: false, cheap: false })
  })

  test('hostile commands stay fast', async () => {
    const w = world()
    w.tree.file(at('a'))
    const t0 = Date.now()
    await run(w, bash('rm -rf ' + 'a '.repeat(20_000)))
    await run(w, bash('rm -rf ' + '*/'.repeat(5_000)))
    await run(w, bash('rm -rf ' + '{a,b}'.repeat(50)))
    await run(w, bash('x'.repeat(2_000_000)))
    expect(Date.now() - t0).toBeLessThan(8_000)
  })

  test('the input is not changed', async () => {
    const w = world()
    w.tree.file(at('a.txt'))
    const c = call('Write', { file_path: at('a.txt'), content: 'x' })
    const before = JSON.stringify(c)
    await run(w, c)
    expect(JSON.stringify(c)).toBe(before)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('Bash: everyday cleanups are quiet', () => {
  const tiers = (a: Assessment) => a.risks.map(r => r.tier)
  const checks = (w: World) => w.git.calls.filter(c => c[0] === 'check-ignore')
  /** A folder with a file in it. */
  const folder = (w: World, rel: string, root = ROOT) => w.tree.file(`${root}/${rel}/x.txt`)
  /** The run of one command must be quiet (every risk tier snapshot, `cheap`) or asked (a tier ask is left, not `cheap`). */
  async function verdict(w: World, cmd: string, place: Place = w.place): Promise<'quiet' | 'ask' | 'mixed'> {
    const a = await run(w, bash(cmd), place)
    if (a.risks.length === 0) return 'mixed'
    const t = tiers(a)
    if (t.every(x => x === 'snapshot')) return a.cheap ? 'quiet' : 'mixed'
    return t.some(x => x === 'ask') && !a.cheap ? 'ask' : 'mixed'
  }

  test('the names that count', () => {
    expect([...REGENERABLE_FOLDERS]).toEqual(['node_modules', 'dist', 'build', '.next', '.cache', 'target', '__pycache__', 'coverage'])
  })

  test('each regenerable folder is quiet at every depth, with Git and without, and Git is not even asked', async () => {
    const bad: string[] = []
    for (const isRepo of [true, false]) {
      for (const name of REGENERABLE_FOLDERS) {
        for (const prefix of ['', 'packages/a/', 'a/b/c/d/']) {
          const w = world()
          w.git.isRepo = isRepo
          folder(w, prefix + name)
          const a = await run(w, bash(`rm -rf ${prefix}${name}`))
          const ok = tiers(a).join() === 'snapshot' && a.cheap && a.targets.join() === prefix + name && a.risks[0]?.kind === 'delete' && checks(w).length === 0 && !a.isUnknown
          if (!ok) bad.push(`${isRepo ? 'git' : 'no git'}: ${prefix}${name} -> ${JSON.stringify(a)}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  test('the same cleanup written other ways: trailing slash, ./, absolute, -r, -fr, cd first, braces, several at once', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'dist')
    folder(w, 'web/.next')
    const bad: string[] = []
    for (const cmd of [
      'rm -rf node_modules/',
      'rm -rf ./node_modules',
      `rm -rf ${ROOT}/node_modules`,
      'rm -r node_modules',
      'rm -fr node_modules',
      'rm -R node_modules',
      'rm --recursive --force node_modules',
      'cd web && rm -rf .next',
      'rm -rf {node_modules,dist}',
      'rm -rf node_modules dist web/.next',
      'rm -rf node_modules && rm -rf dist',
      'rm -rf -- node_modules',
    ]) {
      if ((await verdict(w, cmd)) !== 'quiet') bad.push(cmd)
    }
    expect(bad).toEqual([])
  })

  test('names that only look alike are asked about, with Git and without; so is a plain FILE called build', async () => {
    const bad: string[] = []
    const names = ['builds', 'my-dist', 'Build', 'DIST', 'node_modules2', 'node-modules', '.nextt', 'next', 'cache', '.cachee', 'targets', '__pycache__x', 'distribution', 'coverage-old', 'src', 'lib/build-tools', 'a b']
    for (const isRepo of [true, false]) {
      for (const name of names) {
        const w = world()
        w.git.isRepo = isRepo
        folder(w, name)
        const a = await run(w, bash(`rm -rf '${name}'`))
        if (tiers(a).join() !== 'ask' || a.cheap || a.targets.join() !== name) bad.push(`${isRepo}: ${name}`)
      }
      for (const name of REGENERABLE_FOLDERS) {
        const w = world()
        w.git.isRepo = isRepo
        w.tree.file(at(name), 'a script, not a folder')
        const a = await run(w, bash(`rm -rf ${name}`))
        if (tiers(a).join() !== 'ask' || a.cheap) bad.push(`${isRepo}: file ${name}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('a folder Git ignores is quiet; ONE check-ignore call asks for every target the names did not cover', async () => {
    const w = world()
    folder(w, 'tmp-out')
    folder(w, 'uploads/cache-old')
    folder(w, 'dist')
    w.git.ignored.add('tmp-out').add('uploads/cache-old')
    const a = await run(w, bash('rm -rf tmp-out uploads/cache-old dist'))
    expect(tiers(a)).toEqual(['snapshot'])
    expect(a.cheap).toBe(true)
    expect(a.targets).toEqual(['dist', 'tmp-out', 'uploads/cache-old'])
    expect(checks(w)).toEqual([['check-ignore', '-z', '--', 'tmp-out', 'uploads/cache-old']])
  })

  test('an ignored FILE counts too; a name starting with a dash stays a name', async () => {
    const w = world()
    w.tree.file(at('debug.log'))
    w.tree.file(at('-odd/a'))
    w.git.ignored.add('debug.log').add('-odd')
    expect(await verdict(w, 'rm -rf debug.log')).toBe('quiet')
    expect(await verdict(w, 'rm -rf -- -odd')).toBe('quiet')
    expect(checks(w).every(c => c[c.indexOf('--') + 1] !== undefined && c.includes('--'))).toBe(true)
  })

  test('a folder Git does not ignore is asked about: src, and one such target keeps the whole risk asked', async () => {
    const w = world()
    folder(w, 'src/old')
    folder(w, 'node_modules')
    folder(w, 'tmp-out')
    w.git.ignored.add('tmp-out')
    expect(await verdict(w, 'rm -rf src/old')).toBe('ask')
    expect(await verdict(w, 'rm -rf node_modules src/old')).toBe('ask')
    expect(await verdict(w, 'rm -rf tmp-out src/old')).toBe('ask')
    expect(await verdict(w, 'rm -rf node_modules tmp-out')).toBe('quiet')
    const a = await run(w, bash('rm -rf node_modules src/old'))
    expect(a.targets).toEqual(['node_modules', 'src/old']) // the snapshot still covers both
  })

  test('a .env is never quiet, even when Git ignores it or it sits in a regenerable folder', async () => {
    const w = world()
    for (const rel of ['.env', '.env.local', '.envrc', 'config/.env', 'prod.env', 'build/.env', 'dist/.env.production']) w.tree.file(at(rel), 'A=1')
    folder(w, 'build', ROOT)
    folder(w, 'dist', ROOT)
    for (const rel of ['.env', '.env.local', '.envrc', 'config/.env', 'prod.env', 'build/.env', 'dist/.env.production', 'config']) w.git.ignored.add(rel)
    const bad: string[] = []
    for (const cmd of ['rm -rf .env', 'rm -rf .env.local', 'rm -rf .envrc', 'rm -rf config/.env', 'rm -rf prod.env', 'rm -rf build/.env', 'rm -rf build .env', 'rm -rf dist dist/.env.production', 'rm -rf node_modules .env']) {
      const a = await run(w, bash(cmd))
      if (!(a.risks.length > 0 && tiers(a).every(t => t === 'ask') && !a.cheap)) bad.push(cmd)
    }
    expect(bad).toEqual([])
    // ...while a template is not a secret.
    w.tree.file(at('.env.example'), 'A=')
    w.git.ignored.add('.env.example')
    expect(await verdict(w, 'rm -rf .env.example')).toBe('quiet')
  })

  test('without a repository only the names count; when Git fails or cannot say, an ignored folder is asked about', async () => {
    const w = world()
    folder(w, 'tmp-out')
    folder(w, 'node_modules')
    w.git.ignored.add('tmp-out')
    w.git.isRepo = false
    expect(await verdict(w, 'rm -rf tmp-out')).toBe('ask')
    expect(await verdict(w, 'rm -rf node_modules')).toBe('quiet')
    expect(await verdict(w, 'rm -rf node_modules tmp-out')).toBe('ask')
    expect(checks(w)).toEqual([])
    // A repository whose check-ignore fails (a broken index, a refused option, a timeout).
    const g = world()
    folder(g, 'tmp-out')
    folder(g, 'node_modules')
    g.git.ignored.add('tmp-out')
    g.git.breakCmd.add('check-ignore')
    expect(await verdict(g, 'rm -rf tmp-out')).toBe('ask')
    expect(await verdict(g, 'rm -rf node_modules')).toBe('quiet')
    // git itself missing: every command fails to start.
    const h = world()
    folder(h, 'tmp-out')
    folder(h, 'dist')
    h.git.ignored.add('tmp-out')
    const io = { ...h.io, run: async () => ({ exitCode: -1, stdout: '', stderr: '' }) }
    const a = await assess(io, bash('rm -rf tmp-out'), h.place)
    expect(tiers(a)).toEqual(['ask'])
    expect(a.cheap).toBe(false)
    expect(tiers(await assess(io, bash('rm -rf dist'), h.place))).toEqual(['snapshot'])
  })

  test('git says nothing for a name it does not list: only what it prints counts as ignored', async () => {
    const w = world()
    folder(w, 'a-out')
    folder(w, 'b-out')
    w.git.ignored.add('a-out')
    expect(await verdict(w, 'rm -rf a-out b-out')).toBe('ask')
    expect(await verdict(w, 'rm -rf a-out')).toBe('quiet')
  })

  test('a wildcard is quiet only when everything it reaches is covered', async () => {
    const w = world()
    folder(w, 'packages/a/node_modules')
    folder(w, 'packages/b/node_modules')
    folder(w, 'packages/c/src')
    folder(w, 'packages/a/dist')
    folder(w, 'dist-old')
    folder(w, 'dist')
    folder(w, 'tmp/one')
    folder(w, 'tmp/two')
    expect(await verdict(w, 'rm -rf packages/*/node_modules')).toBe('quiet') // c has none: not reached
    expect(await verdict(w, 'rm -rf packages/*/dist packages/*/node_modules')).toBe('quiet')
    expect(await verdict(w, 'rm -rf packages/*/src')).toBe('ask')
    expect(await verdict(w, 'rm -rf packages/*')).toBe('ask') // a, b, c are not regenerable names
    expect(await verdict(w, 'rm -rf dist*')).toBe('ask') // dist and dist-old
    w.git.ignored.add('dist-old')
    expect(await verdict(w, 'rm -rf dist*')).toBe('quiet')
    expect(await verdict(w, 'rm -rf tmp/*')).toBe('ask')
    w.git.ignored.add('tmp/one').add('tmp/two')
    expect(await verdict(w, 'rm -rf tmp/*')).toBe('quiet') // each child is ignored
    expect(await verdict(w, 'rm -rf packages/*/node_modules packages/*/src')).toBe('ask')
    expect(await verdict(w, 'rm -rf {dist,node_modules,packages/c/src}')).toBe('ask')
    expect(await verdict(w, 'rm -rf {dist,node_modules}')).toBe('quiet')
    // a wildcard that reaches nothing: no targets, nothing is made quiet
    const none = await run(w, bash('rm -rf nodir/*.zzz'))
    expect(tiers(none)).toEqual(['ask'])
    expect(none.cheap).toBe(false)
  })

  test('a wildcard that lists the project root or a folder above it is never quiet, even when everything in it is regenerable', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'dist')
    w.tree.file('/work/other/node_modules/x')
    const bad: string[] = []
    for (const cmd of ['rm -rf *', 'rm -rf ./*', 'rm -rf .*', 'rm -rf ../*', 'rm -rf /work/*', 'rm -rf ${ROOT}/*', 'rm -rf [!.]*', 'rm -rf ?*', 'cd .. && rm -rf *', 'rm -rf {*,x}', 'rm -rf node_modules *']) {
      const v = await verdict(w, cmd.replace('${ROOT}', ROOT))
      if (v === 'quiet') bad.push(cmd)
    }
    expect(bad).toEqual([])
    // A sub-folder is not the root: its own children are judged one by one.
    folder(w, 'packages/dist')
    folder(w, 'packages/node_modules')
    expect(await verdict(w, 'cd packages && rm -rf *')).toBe('quiet')
    folder(w, 'packages/src')
    expect(await verdict(w, 'cd packages && rm -rf *')).toBe('ask')
  })

  test('the project root and the folders above it are never quiet, whatever their names or what Git says', async () => {
    const bad: string[] = []
    const cases: [string, string][] = [['/work/acme-shop', 'rm -rf .'], ['/work/acme-shop', 'rm -rf ..'], ['/work/build', 'rm -rf .'], ['/work/build', 'rm -rf ../build'], ['/work/build', 'rm -rf /work/build'], ['/work/node_modules', 'rm -rf .'], ['/work/build/dist', 'rm -rf ..'], ['/work/acme-shop', `rm -rf ${ROOT}`], ['/work/acme-shop', 'rm -rf ../acme-shop'], ['/work/acme-shop', 'rm -rf /work']]
    for (const [root, cmd] of cases) {
      const w = world()
      folder(w, 'node_modules', root)
      folder(w, 'dist', root)
      w.git.ignored.add('.').add('..').add(root.slice(root.lastIndexOf('/') + 1))
      const place = { root, cwd: root, home: HOME }
      if ((await verdict(w, cmd, place)) === 'quiet') bad.push(`${root}: ${cmd}`)
    }
    expect(bad).toEqual([])
  })

  test('a link is never quiet: not the link itself, and not a list that holds one', async () => {
    const w = world()
    folder(w, 'real-data')
    folder(w, 'dist')
    w.tree.link(at('node_modules'), at('real-data'))
    w.tree.link(at('build'), '/elsewhere')
    expect(await verdict(w, 'rm -rf node_modules')).toBe('ask')
    expect(await verdict(w, 'rm -rf dist node_modules')).toBe('ask')
    expect(await verdict(w, 'rm -rf build')).toBe('ask')
    expect(await verdict(w, 'rm -rf dist')).toBe('quiet')
    // an ignored link is a link all the same
    w.tree.link(at('ign-link'), at('real-data'))
    w.git.ignored.add('ign-link')
    expect(await verdict(w, 'rm -rf ign-link')).toBe('ask')
    // a link reached by a wildcard
    w.tree.link(at('packages/x/node_modules'), at('real-data'))
    folder(w, 'packages/y/node_modules')
    expect(await verdict(w, 'rm -rf packages/*/node_modules')).toBe('ask')
    // a folder through a linked parent counts by where it really is
    folder(w, 'packages/core/dist')
    w.tree.link(at('core'), at('packages/core'))
    const a = await run(w, bash('rm -rf core/dist'))
    expect(tiers(a)).toEqual(['snapshot'])
    expect(a.targets).toEqual(['packages/core/dist'])
  })

  test('a path that is unknown or outside the project keeps the question', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'dist')
    w.tree.file('/work/other/node_modules/x')
    w.tree.file('/data/build/x')
    const bad: string[] = []
    for (const cmd of ['rm -rf "$DIR"', 'rm -rf node_modules "$DIR"', 'rm -rf $(cat list.txt) dist', 'rm -rf node_modules `pwd`/x', 'rm -rf {1..500}', 'rm -rf node_modules ~other/x']) {
      const a = await run(w, bash(cmd))
      if (!(a.risks.length > 0 && tiers(a).every(t => t === 'ask') && !a.cheap)) bad.push(`${cmd} -> ${JSON.stringify(a)}`)
    }
    expect(bad).toEqual([])
    // a hand-made risk that says its path is unknown
    const risk: Risk = { kind: 'delete', tier: 'ask', label: 'rm -rf', paths: ['node_modules'], hasUnknownPath: true }
    const a = await assessRisks(w.io, [risk], w.place)
    expect(a.risks).toEqual([risk])
    expect(a.cheap).toBe(false)
    expect(a.isUnknown).toBe(true)
    // A path outside the project is never saved, so the question stays (risk.ts drops such paths from a command's risk; a risk
    // that still carries one is not a cleanup).
    for (const paths of [['node_modules', '/work/other/node_modules'], ['node_modules', '../other/node_modules'], ['/data/build'], ['node_modules', '/data/build']]) {
      const outside: Risk = { kind: 'delete', tier: 'ask', label: 'rm -rf', paths }
      const o = await assessRisks(w.io, [outside], w.place)
      expect(o.risks.map(r => r.tier), paths.join(' ')).toEqual(['ask'])
      expect(o.cheap).toBe(false)
    }
  })

  test('nothing that is there, or a root that cannot be saved: nothing is made quiet', async () => {
    const w = world()
    const absent = await run(w, bash('rm -rf node_modules'))
    expect(tiers(absent)).toEqual(['ask'])
    expect(absent.cheap).toBe(false)
    folder(w, 'node_modules')
    expect(await verdict(w, 'rm -rf node_modules', { root: 'acme-shop', cwd: 'acme-shop', home: HOME })).toBe('ask')
    expect(await verdict(w, 'rm -rf node_modules', { root: '/', cwd: '/', home: HOME })).toBe('ask')
  })

  test('a nested target does not matter once its folder is covered; an uncovered folder with a covered child stays asked', async () => {
    const w = world()
    folder(w, 'dist/deep')
    folder(w, 'src/dist')
    expect(await verdict(w, 'rm -rf dist dist/deep dist/deep/x.txt')).toBe('quiet')
    expect(await verdict(w, 'rm -rf src src/dist')).toBe('ask')
    expect(await verdict(w, 'rm -rf src/dist')).toBe('quiet')
  })

  test('find ... -delete follows the same rule through its start folders, and keeps its flags', async () => {
    const w = world()
    folder(w, 'build')
    folder(w, 'src')
    const q = await run(w, bash("find build -name '*.pyc' -delete"))
    expect(q.risks.map(r => [r.kind, r.tier, r.picks])).toEqual([['delete', 'snapshot', true]])
    expect(q.cheap).toBe(true)
    expect(await verdict(w, "find src -name '*.pyc' -delete")).toBe('ask')
    expect(await verdict(w, 'find . -name node_modules -delete')).toBe('ask')
    expect(await verdict(w, 'find . -name dist -type d -delete')).toBe('ask')
  })

  test('PowerShell with Windows paths: Remove-Item -Recurse on a build folder is quiet, on a source folder asked', async () => {
    const w = world()
    w.tree.file('C:/Users/dev/acme/node_modules/a.js')
    w.tree.file('C:/Users/dev/acme/src/a.js')
    const place = { root: 'C:\\Users\\dev\\acme', cwd: 'C:\\Users\\dev\\acme', home: 'C:\\Users\\dev' }
    const q = await run(w, call('PowerShell', { command: 'Remove-Item -Recurse -Force .\\node_modules' }), place)
    expect(tiers(q)).toEqual(['snapshot'])
    expect(q.cheap).toBe(true)
    expect(q.targets).toEqual(['node_modules'])
    const a = await run(w, call('PowerShell', { command: 'Remove-Item -Recurse -Force .\\src' }), place)
    expect(tiers(a)).toEqual(['ask'])
    expect(a.cheap).toBe(false)
  })

  test('more targets than one command line should carry: asked, not guessed', async () => {
    const w = world()
    for (let i = 0; i < 101; i += 1) {
      w.tree.file(at(`logs/l${i}`))
      w.git.ignored.add(`logs/l${i}`)
    }
    expect(await verdict(w, 'rm -rf logs/*')).toBe('ask')
    expect(checks(w)).toEqual([])
    const few = world()
    for (let i = 0; i < 100; i += 1) {
      few.tree.file(at(`logs/l${i}`))
      few.git.ignored.add(`logs/l${i}`)
    }
    expect(await verdict(few, 'rm -rf logs/*')).toBe('quiet')
    expect(checks(few)).toHaveLength(1)
  })

  test('a list cut short is never made quiet, and what came before the cut keeps its answer', async () => {
    const w = world()
    folder(w, 'node_modules')
    w.tree.dir(at('tmp'))
    for (let i = 0; i < 5_050; i += 1) w.tree.nodes.set(at(`tmp/f${i}`), { kind: 'file', text: 'x', mtimeMs: 0 })
    const a = await run(w, bash('rm -rf node_modules && rm -rf tmp/*'))
    expect(tiers(a)).toEqual(['snapshot', 'ask'])
    expect(a.cheap).toBe(false)
    expect(a.isUnknown).toBe(true)
  })

  test('cheap is true exactly when something was made quiet and no question is left', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'dist')
    folder(w, 'src')
    w.tree.file(at('notes.txt'))
    const table: [string, boolean][] = [
      ['rm -rf node_modules', true],
      ['rm -rf node_modules && rm -rf dist', true],
      ['rm -rf node_modules; rm -rf dist', true],
      ['rm -rf src', false],
      ['rm -rf node_modules && rm -rf src', false],
      ['rm -rf node_modules && git reset --hard', false],
      ['rm -rf node_modules && git push --force', false],
      ['rm -rf node_modules && git branch -D old', false],
      ['rm -rf node_modules && git checkout -- .', false],
      ['git reset --hard', false],
      ['ls', false],
      ['rm notes.txt', false],
    ]
    const bad: string[] = []
    for (const [cmd, want] of table) {
      const a = await run(w, bash(cmd))
      if (a.cheap !== want) bad.push(`${cmd}: ${a.cheap}`)
    }
    expect(bad).toEqual([])
    // a quiet save before an edit is not a cleanup
    const edit = await run(w, call('Write', { file_path: at('notes.txt'), content: 'x' }))
    expect(tiers(edit)).toEqual(['snapshot'])
    expect(edit.cheap).toBe(false)
    // a risk that was already quiet is not "made quiet"
    const already = await assessRisks(w.io, [{ kind: 'delete', tier: 'snapshot', label: 'rm -rf', paths: ['node_modules'] }], w.place)
    expect(already.cheap).toBe(false)
  })

  test('cheap stays false next to an unparsed risk, which is asked about', async () => {
    const w = world()
    folder(w, 'node_modules')
    const del: Risk = { kind: 'delete', tier: 'ask', label: 'rm -rf', paths: ['node_modules'] }
    const unparsed: Risk = { kind: 'unparsed', tier: 'ask', label: 'long command', paths: [] }
    const a = await assessRisks(w.io, [del, unparsed], w.place)
    expect(a.risks).toEqual([{ ...del, tier: 'snapshot' }, unparsed])
    expect(a.cheap).toBe(false)
    const alone = await assessRisks(w.io, [unparsed], w.place)
    expect(alone.risks).toEqual([unparsed])
    expect(alone.cheap).toBe(false)
  })

  test('only a delete is made quiet: the other kinds keep their tier whatever the paths', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'build')
    w.tree.file(at('build/x.js'))
    const bad: string[] = []
    for (const kind of ['discard', 'db-drop', 'clean', 'reset-hard', 'force-push', 'branch-delete', 'git-erase', 'unparsed'] as const) {
      const risk: Risk = { kind, tier: 'ask', label: kind, paths: ['node_modules', 'build'] }
      const a = await assessRisks(w.io, [risk], w.place)
      if (a.cheap || a.risks.map(r => r.tier).join() !== 'ask') bad.push(kind)
    }
    expect(bad).toEqual([])
    const overwrite: Risk = { kind: 'overwrite', tier: 'ask', label: 'cp .env', paths: ['build/x.js'] }
    const o = await assessRisks(w.io, [overwrite], w.place)
    expect(o.risks).toEqual([overwrite])
    expect(o.cheap).toBe(false)
  })

  test('the quiet risk keeps its kind, label, paths and flags: only the tier changes, and the input is not touched', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'build')
    const [orig] = classifyBash('rm -rf node_modules', { cwd: ROOT, root: ROOT, home: HOME })
    expect(orig?.tier).toBe('ask')
    const a = await run(w, bash('rm -rf node_modules'))
    expect(a.risks).toEqual([{ ...orig, tier: 'snapshot' }])
    const hand: Risk = { kind: 'delete', tier: 'ask', label: 'find -delete', paths: ['build'], picks: true, match: 'x.js' }
    const before = JSON.stringify(hand)
    const b = await assessRisks(w.io, [hand], w.place)
    expect(b.risks).toEqual([{ ...hand, tier: 'snapshot' }])
    expect(b.risks[0]).not.toBe(hand)
    expect(JSON.stringify(hand)).toBe(before)
    expect(hand.tier).toBe('ask')
  })

  test('the targets of a quiet cleanup are still reported, for the small snapshot', async () => {
    const w = world()
    folder(w, 'node_modules')
    folder(w, 'packages/a/dist')
    const a = await run(w, bash('rm -rf node_modules packages/a/dist packages/a/dist/x.txt'))
    expect(a.cheap).toBe(true)
    expect(a.targets).toEqual(['node_modules', 'packages/a/dist'])
    expect(a.isGit).toBe(true)
  })

  test('no folder is listed and no file is read for a target that is made quiet (stat and Git only)', async () => {
    const w = world()
    for (let i = 0; i < 300; i += 1) w.tree.file(at(`node_modules/pkg${i}/index.js`))
    folder(w, 'packages/a/dist')
    folder(w, 'tmp-out')
    w.git.ignored.add('tmp-out')
    const listed: string[] = []
    const io: IO = { ...w.io, list: async p => (listed.push(p), w.io.list(p)) }
    const readsBefore = w.tree.reads.length
    for (const cmd of ['rm -rf node_modules', 'rm -rf packages/a/dist', 'rm -rf tmp-out', 'rm -rf node_modules packages/a/dist tmp-out', 'rm -rf src-that-is-not-there']) {
      const a = await assess(io, bash(cmd), w.place)
      expect(a.risks.length, cmd).toBe(1)
    }
    expect(listed).toEqual([])
    expect(w.tree.reads.length).toBe(readsBefore)
    // a wildcard has to list to find its targets, but only the folders it names
    const a = await assess(io, bash('rm -rf packages/*/dist'), w.place)
    expect(tiers(a)).toEqual(['snapshot'])
    expect(listed).toEqual([at('packages')])
  })

  test('everything it runs is still one of the three read-only git questions', async () => {
    const w = world()
    folder(w, 'tmp-out')
    folder(w, 'dist')
    w.git.ignored.add('tmp-out')
    await run(w, bash('rm -rf tmp-out dist'))
    await run(w, bash('rm -rf src-that-is-not-there'))
    expect([...new Set(w.git.calls.map(cmdOf))].sort()).toEqual(['check-ignore', 'rev-parse'])
  })
})

describe('risks made by hand: the kinds that carry no files', () => {
  const tree = (): World => {
    const w = world()
    w.tree.file(at('build/a.js'))
    w.tree.file(at('src/b.ts'))
    return w
  }

  test('an unparsed risk stays a risk with no targets (it is asked about; the snapshot covers what git can undo)', async () => {
    const w = tree()
    const unparsed: Risk = { kind: 'unparsed', tier: 'ask', label: 'bash', paths: [] }
    const a = await assessRisks(w.io, [unparsed], w.place)
    expect(a.risks).toEqual([unparsed])
    expect(a.targets).toEqual([])
    expect(a.isGit).toBe(true)
    expect(a.isUnknown).toBe(false)
    expect(a.env).toBeUndefined()
    // Next to a delete it neither adds nor removes targets.
    const del: Risk = { kind: 'delete', tier: 'ask', label: 'rm -rf', paths: ['build'] }
    const both = await assessRisks(w.io, [del, unparsed], w.place)
    expect(both.risks.map(r => r.kind)).toEqual(['delete', 'unparsed'])
    expect(both.targets).toEqual(['build'])
    // A path on an unparsed risk is not looked at: it carries no files by definition.
    const odd = await assessRisks(w.io, [{ ...unparsed, paths: ['src'] }], w.place)
    expect(odd.targets).toEqual([])
    expect(odd.risks.length).toBe(1)
  })

  test('a discard that names files copies them; a whole-tree discard has no files of its own (git covers it)', async () => {
    const w = tree()
    const named: Risk = { kind: 'discard', tier: 'ask', label: 'git checkout --', paths: ['src/b.ts', 'not-there.ts'] }
    const a = await assessRisks(w.io, [named], w.place)
    expect(a.risks).toEqual([named])
    expect(a.targets).toEqual(['src/b.ts'])
    const folder: Risk = { kind: 'discard', tier: 'ask', label: 'git restore', paths: ['src'] }
    expect((await assessRisks(w.io, [folder], w.place)).targets).toEqual(['src'])
    const whole: Risk = { kind: 'discard', tier: 'ask', label: 'git checkout -- .', paths: [] }
    const b = await assessRisks(w.io, [whole], w.place)
    expect(b.risks).toEqual([whole])
    expect(b.targets).toEqual([])
    // a path outside the project is never copied
    const outside: Risk = { kind: 'discard', tier: 'ask', label: 'git checkout --', paths: ['../elsewhere/x.ts', '/etc/hosts'] }
    expect((await assessRisks(w.io, [outside], w.place)).targets).toEqual([])
  })

  test('a risk with a branch list passes through untouched, with no targets and no file lookups', async () => {
    const w = tree()
    const callsBefore = w.tree.reads.length
    const risk: Risk = { kind: 'branch-delete', tier: 'ask', label: 'git branch -D', paths: [], name: 'f1', names: ['f1', 'f2', 'f3'] }
    const a = await assessRisks(w.io, [risk], w.place)
    expect(a.risks).toEqual([risk])
    expect(a.risks[0]?.names).toEqual(['f1', 'f2', 'f3'])
    expect(a.targets).toEqual([])
    expect(w.tree.reads.length).toBe(callsBefore)
    const push: Risk = { kind: 'force-push', tier: 'ask', label: 'git push --force', paths: [], remote: 'origin', name: 'dev', names: ['dev', 'main'] }
    expect((await assessRisks(w.io, [push], w.place)).risks).toEqual([push])
  })

  test('a find-style delete that picks its files keeps its flag and its targets', async () => {
    const w = tree()
    const picks: Risk = { kind: 'delete', tier: 'ask', label: 'find -delete', paths: ['build'], picks: true }
    const a = await assessRisks(w.io, [picks], w.place)
    expect(a.risks[0]?.picks).toBe(true)
    expect(a.targets).toEqual(['build'])
  })

  test('odd input is total: not a list, entries that are not risks, a risk with no paths', async () => {
    const w = tree()
    expect((await assessRisks(w.io, undefined as unknown as Risk[], w.place)).risks).toEqual([])
    expect((await assessRisks(w.io, [], w.place)).risks).toEqual([])
    expect((await assessRisks(w.io, [null, 5, 'x', []] as unknown as Risk[], w.place)).risks).toEqual([])
    const noPaths = { kind: 'delete', tier: 'ask', label: 'rm -rf' } as unknown as Risk
    const a = await assessRisks(w.io, [null as unknown as Risk, noPaths], w.place)
    expect(a.risks).toEqual([noPaths])
    expect(a.targets).toEqual([])
  })

  test('every git call guard makes goes through gitRun: core.fsmonitor is switched off', async () => {
    const w = tree()
    w.tree.file(at('notes.txt'))
    const seen: string[][] = []
    const io: IO = { ...w.io, run: async (argv, init) => { seen.push(argv); return w.io.run(argv, init) } }
    await assess(io, call('Write', { file_path: at('notes.txt'), content: '' }), w.place)
    await assess(io, bash('git clean -fd'), w.place)
    expect(seen.length).toBeGreaterThan(2)
    for (const argv of seen) {
      expect(argv.slice(0, 3), argv.join(' ')).toEqual(['git', '-c', 'core.fsmonitor=false'])
    }
  })
})
