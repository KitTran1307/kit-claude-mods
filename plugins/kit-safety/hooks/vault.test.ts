import { describe, expect, test } from 'claude-code/testing'

import { normalizePath } from './paths'
import { newSnapshotId, parseManifest, projectKey } from './snapshot'
import type { Manifest } from './snapshot'
import type { Risk } from './types'
import {
  createSnapshot, decodeBase64, decodeUtf8, findSnapshot, gitInfoFor, gitRun, listSnapshots, probeNode, pruneAll, pruneSnapshots,
  restoreSnapshot, undoRestore,
} from './vault'
import type { IO, IORun, SnapshotRequest, VaultCfg, VaultEnv } from './vault'
import {
  encode64, utf8, text, clock, ROOT, HOME, SNAPS, HELPER, KEY, SHA1, SHA2, SHA3, MB, CFG, DAY, Fs, done, world, risk, req, snap, made,
  snapDirOf, manifestOf, ID0, BACKENDS, snapshotted, find, reasons, engine,
} from '../tests/vault-helpers'
import type { NodeMode, World } from '../tests/vault-helpers'


describe('decodeBase64', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['Zg==', 'f'],
    ['Zm8=', 'fo'],
    ['Zm9v', 'foo'],
    ['Zm9vYg==', 'foob'],
    ['Zm9vYmE=', 'fooba'],
    ['Zm9vYmFy', 'foobar'],
  ]
  for (const [b64, want] of vectors) test(`RFC 4648: ${JSON.stringify(b64)}`, () => expect(text(decodeBase64(b64) ?? new Uint8Array([63]))).toBe(want))
  test('padding is optional and whitespace is ignored', () => {
    expect(text(decodeBase64('Zm9vYg')!)).toBe('foob')
    expect(text(decodeBase64('Zm9v\nYmFy\r\n')!)).toBe('foobar')
    expect(text(decodeBase64('  Zm 9v ')!)).toBe('foo')
  })
  test('every byte value survives a round trip', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...decodeBase64(encode64(all))!]).toEqual([...all])
    for (let n = 0; n < 12; n += 1) expect([...decodeBase64(encode64(all.slice(0, n)))!]).toEqual([...all.slice(0, n)])
  })
  test('anything that is not base64 is null, never a throw', () => {
    for (const bad of ['*', 'Zm9v!', 'Zm9v-', 'Zm9v_', 'Z', 'Zm9vY', 'é', '=', '==', 'Zg=a', 'Zm9v=', 'Zg=', '=Zg=', 'Zg===', 'Z m=9v='] as string[]) expect(decodeBase64(bad), bad).toBeNull()
    expect(decodeBase64(undefined as unknown as string)).toBeNull()
    expect(decodeBase64(5 as unknown as string)).toBeNull()
  })
})

describe('decodeUtf8', () => {
  test('text is text, a byte order mark is kept, an empty file is an empty string', () => {
    expect(decodeUtf8(utf8('hello\r\nworld\n'))).toBe('hello\r\nworld\n')
    expect(decodeUtf8(utf8('café 日本語 😀'))).toBe('café 日本語 😀')
    expect(decodeUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('\ufeffa')
    expect(decodeUtf8(new Uint8Array())).toBe('')
  })
  test('a NUL is a binary file', () => {
    expect(decodeUtf8(Uint8Array.from([0x61, 0, 0x62]))).toBeNull()
    expect(decodeUtf8(Uint8Array.from([0]))).toBeNull()
  })
  const invalid: [string, number[]][] = [
    ['a lone continuation byte', [0x80]],
    ['a continuation after ascii', [0x61, 0xbf]],
    ['C0 (an overlong ascii)', [0xc0, 0x80]],
    ['C1', [0xc1, 0xbf]],
    ['an overlong 3-byte form', [0xe0, 0x80, 0x80]],
    ['a surrogate (U+D800)', [0xed, 0xa0, 0x80]],
    ['an overlong 4-byte form', [0xf0, 0x80, 0x80, 0x80]],
    ['above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['F5', [0xf5, 0x80, 0x80, 0x80]],
    ['FF', [0xff]],
    ['a 2-byte start cut off at the end', [0x61, 0xc3]],
    ['a 3-byte start with one continuation', [0xe2, 0x82]],
    ['a 4-byte start with two continuations', [0xf0, 0x9f, 0x98]],
    ['latin-1 text', [0x63, 0x61, 0x66, 0xe9]],
    ['a continuation that is ascii', [0xc3, 0x28]],
  ]
  for (const [name, bytes] of invalid) test(`not UTF-8: ${name}`, () => expect(decodeUtf8(Uint8Array.from(bytes)), name).toBeNull())
  test('agrees with the engine encoder on generated text (round trip), also across the internal chunk size', () => {
    let seed = 12345
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed
    }
    const pool = ['a', 'Z', ' ', '\n', 'é', 'ß', '日', '本', '€', '😀', '𝄞', '\u00a0', '\ufeff', '\u2028']
    for (let round = 0; round < 40; round += 1) {
      let s = ''
      const n = round < 30 ? rnd() % 60 : 9_000 + (rnd() % 3_000)
      for (let i = 0; i < n; i += 1) s += pool[rnd() % pool.length]
      expect(decodeUtf8(utf8(s)), `round ${round}`).toBe(s)
    }
    // An astral character exactly at the 8192-unit boundary must not be split.
    const edge = 'a'.repeat(8191) + '😀' + 'b'.repeat(10)
    expect(decodeUtf8(utf8(edge))).toBe(edge)
  })
})

describe('probeNode', () => {
  const probe = async (stdout: string, exitCode = 0) => probeNode({ run: async () => ({ exitCode, stdout, stderr: '' }) } as unknown as IO)
  test('Node 18 or newer', async () => {
    expect(await probe('v22.3.0\n')).toBe(true)
    expect(await probe('v18.0.0')).toBe(true)
    expect(await probe('20.1.0')).toBe(true)
  })
  test('older, missing or odd answers are no', async () => {
    expect(await probe('v16.20.2\n')).toBe(false)
    expect(await probe('v8.0.0')).toBe(false)
    expect(await probe('command not found')).toBe(false)
    expect(await probe('')).toBe(false)
    expect(await probe('v22.3.0', 1)).toBe(false)
    expect(await probe('v22.3.0', -1)).toBe(false)
  })
  test('a run that throws is no', async () => {
    expect(await probeNode({ run: () => Promise.reject(new Error('x')) } as unknown as IO)).toBe(false)
  })
  test('asks with a short timeout', async () => {
    let seen: { timeoutMs?: number } | undefined
    let argv: string[] = []
    await probeNode({ run: async (a: string[], init: { timeoutMs?: number }) => { argv = a; seen = init; return done(0, 'v22.0.0') } } as unknown as IO)
    expect(argv).toEqual(['node', '--version'])
    expect(seen?.timeoutMs).toBeLessThanOrEqual(5000)
  })
})

describe('gitInfoFor', () => {
  const ID = '20261124T093015Z'
  test('a clean tree: head and branch, history protected under the snapshot ref, no stash offered', async () => {
    const w = world({ git: true })
    const info = await gitInfoFor(w.io, ROOT, [risk('reset-hard', 'git reset --hard')], ID)
    expect(info).toEqual({ head: SHA1, branch: 'main' })
    expect(w.git.refs.get(`refs/kit-safety/${ID}`)).toBe(SHA1)
  })

  test('a dirty tree: the stash commit is kept alive under the ref and offered', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    const info = await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)
    expect(info).toEqual({ head: SHA1, branch: 'main', stashSha: SHA2, ref: `refs/kit-safety/${ID}` })
    expect(w.git.refs.get(`refs/kit-safety/${ID}`)).toBe(SHA2)
  })

  test('a repository with no commits yet: nothing to protect, no stash asked', async () => {
    const w = world({ git: true })
    w.git.head = null
    expect(await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)).toEqual({ head: null, branch: null })
    expect(w.git.refs.size).toBe(0)
    expect(w.git.calls.some(c => c[0] === 'stash')).toBe(false)
  })

  test('not a repository, or git is not installed: undefined', async () => {
    const w = world({ git: false })
    expect(await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)).toBeUndefined()
    const io = new Fs().io(() => done(-1))
    expect(await gitInfoFor(io, ROOT, [risk('reset-hard')], ID)).toBeUndefined()
  })

  test('a detached head has a head but no branch', async () => {
    const w = world({ git: true })
    w.git.detached = true
    expect(await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)).toEqual({ head: SHA1, branch: null })
  })

  test('branch -D: the tip of every branch about to go is recorded and kept alive', async () => {
    const w = world({ git: true })
    w.git.branches = { 'feature/x': SHA2, old: SHA3 }
    const info = await gitInfoFor(w.io, ROOT, [risk('branch-delete', 'git branch -D', { name: 'feature/x' }), risk('branch-delete', 'git branch -D', { name: 'old' }), risk('branch-delete', 'git branch -D', { name: 'gone' })], ID)
    expect(info?.branches).toEqual([{ name: 'feature/x', sha: SHA2 }, { name: 'old', sha: SHA3 }])
    // A branch delete keeps the tips of the branches alive; the head is not at risk, so no ref for it.
    expect([...w.git.refs.entries()].sort()).toEqual([[`refs/kit-safety/${ID}.b/1`, SHA2], [`refs/kit-safety/${ID}.b/2`, SHA3]].sort())
  })

  test('branch names that are not plain are never passed to git', async () => {
    const w = world({ git: true })
    // Names git would refuse (or read as an option, a revision or a path) never reach git; `x;rm` and `$(x)` are fine for git, which
    // is not run through a shell: they are asked about like any ref name.
    const names = ['-D', '--force', 'a b', '../etc', 'a//b', 'trailing/', '', 'new\nline', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a..b', 'a@{1}', 'x.lock', 'dot.', '/abs', 'x'.repeat(201)]
    const info = await gitInfoFor(w.io, ROOT, names.map(name => risk('branch-delete', 'git branch -D', { name })), ID)
    expect(info?.branches).toBeUndefined()
    expect(w.git.calls.some(c => c[0] === 'rev-parse' && c[1] === '--verify')).toBe(false)
  })

  test('only the questions and refs the plugin owns: rev-parse, stash create, update-ref', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.git.branches = { x: SHA3 }
    await gitInfoFor(w.io, ROOT, [risk('branch-delete', 'git branch -D', { name: 'x' }), risk('reset-hard', 'git reset --hard'), risk('force-push', 'git push --force')], ID)
    expect(w.git.subcommands()).toEqual(['rev-parse', 'stash create', 'update-ref'])
    for (const [ref] of w.git.refs) expect(ref.startsWith('refs/kit-safety/')).toBe(true)
  })

  test('a force push has git facts only when a remote tip was pinned, and a branch delete only when a tip was found', async () => {
    const w = world({ git: true })
    const push = risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })
    expect(await gitInfoFor(w.io, ROOT, [push], ID)).toBeUndefined()
    expect(await gitInfoFor(w.io, ROOT, [risk('branch-delete', 'git branch -D', { name: 'gone' })], ID)).toBeUndefined()
    expect(w.git.refs.size).toBe(0)
    w.git.remotes = { 'origin/main': SHA3 }
    expect(await gitInfoFor(w.io, ROOT, [push], ID)).toEqual({ head: SHA1, branch: 'main', branches: [{ name: 'origin/main', sha: SHA3, remote: true }] })
    expect([...w.git.refs]).toEqual([[`refs/kit-safety/${ID}.b/1`, SHA3]])
    // a reset still has its head, tip or no tip
    const reset = world({ git: true })
    expect(await gitInfoFor(reset.io, ROOT, [risk('reset-hard')], ID)).toEqual({ head: SHA1, branch: 'main' })
  })

  test('stash create gets a name and email so it works on a machine with none set; nothing else does', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)
    expect(w.git.calls.some(c => c[0] === 'stash')).toBe(true)
    w.git.calls.forEach((c, i) => expect(w.git.identity[i], c.join(' ')).toBe(c[0] === 'stash'))
  })

  test('a failing stash or update-ref only means less git info', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.git.failUpdateRef = true
    const a = await gitInfoFor(w.io, ROOT, [risk('reset-hard')], ID)
    expect(a).toEqual({ head: SHA1, branch: 'main', stashSha: SHA2 })
    // A stash that could not be made is said so (isPartial): that is not the same as a clean tree.
    const w2 = world({ git: true })
    w2.git.failStash = true
    expect(await gitInfoFor(w2.io, ROOT, [risk('reset-hard')], ID)).toEqual({ head: SHA1, branch: 'main', isPartial: true })
  })

  test('an id that is not a snapshot id, odd risks and a throwing IO give undefined, not a throw', async () => {
    const w = world({ git: true })
    expect(await gitInfoFor(w.io, ROOT, [risk('reset-hard')], '../x')).toBeUndefined()
    expect(await gitInfoFor(w.io, ROOT, undefined as unknown as Risk[], ID)).toBeUndefined()
    expect(await gitInfoFor(w.io, ROOT, [null, 5, {}] as unknown as Risk[], ID)).toBeUndefined()
    expect(await gitInfoFor(w.io, ROOT, [null, 5, {}, risk('reset-hard')] as unknown as Risk[], ID)).toEqual({ head: SHA1, branch: 'main' })
    const boom = { run: () => Promise.reject(new Error('x')) } as unknown as IO
    expect(await gitInfoFor(boom, ROOT, [risk('reset-hard')], ID)).toBeUndefined()
  })
})

for (const { name, mode } of BACKENDS) {
  describe(`createSnapshot: ${name}`, () => {
    const backend = mode === 'none' ? 'fs' : 'node'

    test('saves files and folders under <snapshots>/<project key>/<id>, and the manifest reads back', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/build/index.js`, 'console.log(1)\r\n', 1_700_000_001_000)
      w.fs.file(`${ROOT}/build/sub/deep/app.css`, 'body {}\n')
      w.fs.file(`${ROOT}/build/empty.txt`, '')
      w.fs.file(`${ROOT}/build/ünï/日本.txt`, 'unicode name é')
      w.fs.file(`${ROOT}/keep.txt`, 'not a target')
      const out = await made(w, ['build'])
      expect(out).toMatchObject({ ok: true, id: ID0, n: 1, createdAt: clock.now, files: 4, isPartial: false, hasGit: false, backend, skippedBinary: 0 })
      expect(out.bytes).toBe(16 + 8 + 0 + 15)
      const dir = snapDirOf(ID0)
      expect(w.fs.read(`${dir}/files/build/index.js`)).toBe('console.log(1)\r\n')
      expect(w.fs.read(`${dir}/files/build/sub/deep/app.css`)).toBe('body {}\n')
      expect(w.fs.read(`${dir}/files/build/empty.txt`)).toBe('')
      expect(w.fs.read(`${dir}/files/build/ünï/日本.txt`)).toBe('unicode name é')
      expect(w.fs.has(`${dir}/files/keep.txt`)).toBe(false)
      const m = manifestOf(w, ID0)
      expect(m).toMatchObject({ v: 1, id: ID0, n: 1, root: ROOT, kind: 'before-command', tool: 'Bash', backend, targets: ['build'], dirs: [] })
      expect('command' in m).toBe(false) // the command text is never stored
      expect(m.files.map(f => f.rel)).toEqual(['build/empty.txt', 'build/index.js', 'build/sub/deep/app.css', 'build/ünï/日本.txt'])
      expect(m.files.find(f => f.rel === 'build/index.js')).toMatchObject({ size: 16, mtimeMs: 1_700_000_001_000 })
      expect(m.risks).toEqual([{ kind: 'delete', label: 'rm -rf' }])
      expect(m.totalBytes).toBe(out.bytes)
      const listed = await listSnapshots(w.env, ROOT)
      expect(listed.map(x => x.id)).toEqual([ID0])
    })

    test('a single file, and a file and a folder together', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/notes.txt`, 'A=1\n')
      w.fs.file(`${ROOT}/dist/a.js`, 'a')
      const out = await made(w, ['notes.txt', 'dist'])
      expect(out.files).toBe(2)
      expect(manifestOf(w, ID0).targets).toEqual(['dist', 'notes.txt'])
    })

    // Changed from "a .env file is copied like any other" (both backends): the text-only backend must not copy it any more.
    test('a .env file and a folder together: the helper copies both, the text-only backend leaves the .env out as private', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/.env`, 'A=1\n')
      w.fs.file(`${ROOT}/dist/a.js`, 'a')
      const out = await made(w, ['.env', 'dist'])
      expect(manifestOf(w, ID0).targets).toEqual(['.env', 'dist'])
      if (mode === 'none') {
        expect(out).toMatchObject({ files: 1, isPartial: true, skippedPrivate: 1 })
        expect(w.fs.has(`${snapDirOf(ID0)}/files/.env`)).toBe(false)
      } else {
        expect(out.files).toBe(2)
        expect(out.isPartial).toBe(false)
        expect('skippedPrivate' in out).toBe(false)
      }
    })

    test('an empty folder is kept as a folder', async () => {
      const w = world({ node: mode })
      w.fs.dir(`${ROOT}/cache/empty`)
      w.fs.file(`${ROOT}/cache/a.txt`, 'a')
      const out = await made(w, ['cache'])
      expect(out.files).toBe(1)
      expect(manifestOf(w, ID0).dirs).toEqual(['cache/empty'])
      const w2 = world({ node: mode })
      w2.fs.dir(`${ROOT}/only-empty`)
      expect((await made(w2, ['only-empty'])).files).toBe(0)
      expect(manifestOf(w2, ID0).dirs).toEqual(['only-empty'])
    })

    test('a target inside another target, duplicates, and unsafe targets are cleaned before anything happens', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a/b/c.txt`, 'c')
      w.fs.file(`${ROOT}/a/d.txt`, 'd')
      const out = await made(w, ['a/b/c.txt', 'a', 'a', 'a/d.txt', '../outside', '/etc/passwd', 'x\\y', '', 'a/./b', 'C:/x', 'a//b'])
      expect(manifestOf(w, ID0).targets).toEqual(['a'])
      expect(out.files).toBe(2)
    })

    test('nothing to save: no targets and no git state', async () => {
      const w = world({ node: mode })
      expect(await snap(w, [])).toEqual({ ok: false, reason: 'nothing', skipped: 0 })
      expect(w.fs.below(SNAPS)).toEqual([])
      const gone = await snap(w, ['not/there', 'neither'])
      expect(gone.ok).toBe(false)
      expect(gone.ok === false && gone.reason).toBe('nothing')
      expect(w.fs.below(SNAPS)).toEqual([])
    })

    test('nothing to save: a call that has no targets and no git risk in a repository still records nothing', async () => {
      const w = world({ node: mode, git: true })
      const out = await snap(w, [], { risks: [risk('delete')] })
      expect(out.ok === false && out.reason).toBe('nothing')
      expect(w.git.calls).toEqual([]) // no point asking git
    })

    test('over the size limit: too-big, nothing written (not a file, not a ref)', async () => {
      const w = world({ node: mode, git: true })
      w.fs.file(`${ROOT}/big/a.bin`, 'x'.repeat(600))
      w.fs.file(`${ROOT}/big/b.bin`, 'x'.repeat(600))
      const out = await snap(w, ['big'], {}, { ...CFG, maxBytes: 1000 })
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.reason).toBe('too-big')
        expect(out.bytes).toBeGreaterThan(1000)
      }
      expect(w.fs.below(SNAPS)).toEqual([])
      expect(w.git.refs.size).toBe(0)
      expect(w.fs.writes).toEqual([])
    })

    test('exactly at the limit is fine; one byte more is too big', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'x'.repeat(100))
      expect((await snap(w, ['a.txt'], {}, { ...CFG, maxBytes: 100 })).ok).toBe(true)
      const w2 = world({ node: mode })
      w2.fs.file(`${ROOT}/a.txt`, 'x'.repeat(101))
      const out = await snap(w2, ['a.txt'], {}, { ...CFG, maxBytes: 100 })
      expect(out.ok === false && out.reason).toBe('too-big')
    })

    test('the command text is never stored: no secret in any shape reaches a file, a request or a git call', async () => {
      const w = world({ node: mode, git: true })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const password = ['hunter', '2x9q'].join('')
      const key = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-')
      const url = `postgres://admin:${password}@db.example.com:5432/shop`
      const out = await snap(w, ['a.txt'], { command: `pg_dump ${url} > dump.sql && curl -H "x-api-key: ${key}" https://example.com\n\t&& rm -rf a.txt`, risks: [risk('delete', `rm -rf ${key}`, { name: key })] })
      expect(out.ok).toBe(true)
      const m = manifestOf(w, ID0)
      expect('command' in m).toBe(false)
      // What is stored of a risk (label, name) is masked.
      expect(JSON.stringify(m.risks)).not.toContain(key)
      expect(JSON.stringify(m.risks)).toContain('masked')
      for (const [path, node] of w.fs.nodes) {
        if (node.kind !== 'file') continue
        expect(text(node.bytes).includes(password), path).toBe(false)
        expect(text(node.bytes).includes(key), path).toBe(false)
      }
      expect(JSON.stringify(w.node.requests)).not.toContain(password)
      expect(JSON.stringify(w.node.requests)).not.toContain(key)
      expect(JSON.stringify(w.git.calls)).not.toContain(password)
    })

    // Shapes of a secret that no mask knows by their key: a variable, a flag, a connection string.
    const SECRET_COMMANDS = [
      'PGPASSWORD=hunter2 psql -h db -U app shop',
      'mysql -u root -ps3cret shop',
      'redis-cli -a x7q9 get key',
      'mongosh --password x7q9 mongodb://db/shop',
      'psql "host=db user=app password=x7q9 dbname=shop"',
      'DB_PASS=x7q9 ./migrate && rm -rf build',
    ]
    test('a manifest never contains the command text, for any of the commands that put a password in a shape no mask knows', async () => {
      const w = world({ node: mode, git: true })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const leaks: string[] = []
      for (const [i, command] of SECRET_COMMANDS.entries()) {
        clock.now += 1000
        const out = await made(w, ['a.txt'], { command }, { ...CFG, keepCount: 100 })
        const onDisk = w.fs.read(`${snapDirOf(out.id)}/manifest.json`) ?? ''
        const parsed = manifestOf(w, out.id)
        for (const secret of ['hunter2', 's3cret', 'x7q9', command]) {
          if (onDisk.includes(secret)) leaks.push(`#${i} disk: ${secret}`)
          if (JSON.stringify(parsed).includes(secret)) leaks.push(`#${i} parsed: ${secret}`)
        }
        if ('command' in parsed || onDisk.includes('"command"')) leaks.push(`#${i} has a command field`)
      }
      expect(leaks).toEqual([])
      expect(JSON.stringify(w.node.requests)).not.toContain('x7q9')
    })

    test('a very long command costs nothing: it is not stored, so the manifest stays small', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      await made(w, ['a.txt'], { command: `echo ${'y'.repeat(100_000)}` })
      const onDisk = w.fs.read(`${snapDirOf(ID0)}/manifest.json`) ?? ''
      expect(onDisk.length).toBeLessThan(2_000)
      expect(onDisk).not.toContain('yyyy')
    })

    test('no command is fine; odd risk labels and tools are cleaned', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      await made(w, ['a.txt'], { command: undefined, tool: 'Wr\nite', risks: [risk('overwrite', 'lab\u0000el\n'), { kind: 'delete', tier: 'ask', label: '', paths: [] }, null as unknown as Risk] })
      const m = manifestOf(w, ID0)
      expect('command' in m).toBe(false)
      expect(m.tool).toBe('Wr ite')
      expect(m.risks).toEqual([{ kind: 'overwrite', label: 'lab el' }])
    })

    test('numbers go up by one; an id taken in the same second gets -2, -3', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const first = await made(w, ['a.txt'])
      const second = await made(w, ['a.txt'])
      const third = await made(w, ['a.txt'])
      expect([first.id, second.id, third.id]).toEqual([ID0, `${ID0}-2`, `${ID0}-3`])
      expect([first.n, second.n, third.n]).toEqual([1, 2, 3])
      clock.now += 5_000
      const later = await made(w, ['a.txt'])
      expect(later.n).toBe(4)
      expect(later.id).toBe(newSnapshotId(clock.now, []))
    })

    test('a folder that is already there under that id (another session, or debris) is never touched', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      w.fs.file(`${snapDirOf(ID0)}/files/other.txt`, 'someone else')
      const out = await made(w, ['a.txt'])
      expect(out.id).toBe(`${ID0}-2`)
      expect(w.fs.read(`${snapDirOf(ID0)}/files/other.txt`)).toBe('someone else')
    })

    test('numbering after prunes: numbers are never reused while newer snapshots exist', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const cfg = { ...CFG, keepCount: 2 }
      const ns: number[] = []
      for (let i = 0; i < 5; i += 1) {
        clock.now += 1000
        ns.push((await made(w, ['a.txt'], {}, cfg)).n)
      }
      expect(ns).toEqual([1, 2, 3, 4, 5])
      expect((await listSnapshots(w.env, ROOT)).map(m => m.n)).toEqual([5, 4])
    })

    test('after making a snapshot the oldest are pruned; the new one is never among them', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      for (let i = 0; i < 3; i += 1) {
        clock.now += 1000
        await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      }
      clock.now += 1000
      const out = await made(w, ['a.txt'], {}, { ...CFG, keepCount: 2 })
      const left = await listSnapshots(w.env, ROOT)
      expect(left).toHaveLength(2)
      expect(left[0]?.id).toBe(out.id)
    })

    test('symbolic links inside a target are not saved (they hold no data), and that is not "partial"', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/d/real.txt`, 'r')
      w.fs.file('/outside/secret.txt', 'secret')
      w.fs.link(`${ROOT}/d/alias.txt`, `${ROOT}/d/real.txt`)
      w.fs.link(`${ROOT}/d/out`, '/outside')
      const out = await made(w, ['d'])
      expect(out.files).toBe(1)
      expect(out.isPartial).toBe(false)
      expect(w.fs.below(snapDirOf(ID0)).some(p => p.includes('secret') || p.endsWith('alias.txt') || p.includes('/out/'))).toBe(false)
      if (mode === 'none') expect(manifestOf(w, ID0).skipped).toEqual([{ rel: 'd/alias.txt', reason: 'symlink' }, { rel: 'd/out', reason: 'symlink' }])
    })

    test('a target that is itself a link, or whose real place is outside the project, is not saved', async () => {
      const w = world({ node: mode })
      w.fs.file('/outside/big.txt', 'x')
      w.fs.link(`${ROOT}/lnk`, '/outside/big.txt')
      w.fs.link(`${ROOT}/ldir`, '/outside')
      const out = await snap(w, ['lnk', 'ldir/big.txt'])
      expect(out.ok === false && out.reason).toBe('nothing')
      expect(w.fs.below(SNAPS)).toEqual([])
    })

    test('a project that cannot be a root is refused without writing anything', async () => {
      const w = world({ node: mode })
      for (const root of ['relative/path', '/', 'C:\\', '', '/work/../x', `/work/a${String.fromCharCode(0)}b`]) {
        const out = await createSnapshot(w.env, req(['a.txt'], { root }), CFG)
        expect(out, root).toEqual({ ok: false, reason: 'failed' })
      }
      expect(w.fs.writes).toEqual([])
    })

    test('a restore undo point never touches git; a before-command snapshot in a repository does', async () => {
      const w = world({ node: mode, git: true })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      await made(w, ['a.txt'], { kind: 'before-restore', restoredFrom: '20200101T000000Z', risks: [risk('reset-hard')] })
      expect(w.git.calls).toEqual([])
      await made(w, ['a.txt'], { risks: [risk('reset-hard')] })
      expect(w.git.calls.length).toBeGreaterThan(0)
    })

    test('git: head, branch and stash are in the manifest, the ref keeps the stash alive', async () => {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      expect(out.hasGit).toBe(true)
      const m = manifestOf(w, out.id)
      expect(m.git).toEqual({ head: SHA1, branch: 'main', stashSha: SHA2, ref: `refs/kit-safety/${out.id}` })
      expect(w.git.refs.get(`refs/kit-safety/${out.id}`)).toBe(SHA2)
      expect(w.git.subcommands()).toEqual(['rev-parse', 'stash create', 'update-ref'])
    })

    test('git: only a git state, no files (a force push that pins a remote tip): the snapshot is just that tip', async () => {
      const w = world({ node: mode, git: true })
      w.git.remotes = { 'origin/main': SHA3 }
      const out = await made(w, [], { command: 'git push --force origin main', risks: [risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })] })
      expect(out).toMatchObject({ files: 0, hasGit: true, isPartial: false })
      const m = manifestOf(w, out.id)
      expect(m.files).toEqual([])
      expect(m.git).toEqual({ head: SHA1, branch: 'main', branches: [{ name: 'origin/main', sha: SHA3, remote: true }] })
      // A force push loses nothing local: no ref is made for the head, only for the remote tip.
      expect([...w.git.refs.keys()]).toEqual([`refs/kit-safety/${out.id}.b/1`])
    })

    test('git: a force push that pins no remote tip saves nothing: no folder, no ref, no git state (the head is no copy of anything)', async () => {
      for (const remotes of [{}, { 'origin/other': SHA3 }] as Record<string, string>[]) {
        const w = world({ node: mode, git: true })
        w.git.remotes = remotes
        const out = await snap(w, [], { command: 'git push --force origin main', risks: [risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })] })
        expect(out).toEqual({ ok: false, reason: 'nothing', skipped: 0 })
        expect(w.git.refs.size).toBe(0)
        expect(w.fs.below(`${SNAPS}/${KEY}`)).toEqual([])
        expect(await listSnapshots(w.env, ROOT)).toEqual([])
      }
    })

    test('git: a force push that pins no tip but comes with files: the files are saved and the manifest holds no git facts, hasGit is false', async () => {
      const w = world({ node: mode, git: true })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [risk('delete', 'rm -rf'), risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })] })
      expect(out).toMatchObject({ files: 1, hasGit: false })
      expect(manifestOf(w, out.id).git).toBeUndefined()
      expect(w.git.refs.size).toBe(0)
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      expect(back.git).toEqual([])
    })

    test('git: a deleted branch is recorded with its tip and kept alive', async () => {
      const w = world({ node: mode, git: true })
      w.git.branches = { 'feature/x': SHA3 }
      const out = await made(w, [], { risks: [risk('branch-delete', 'git branch -D', { name: 'feature/x' })] })
      const m = manifestOf(w, out.id)
      expect(m.git?.branches).toEqual([{ name: 'feature/x', sha: SHA3 }])
      expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/1`)).toBe(SHA3)
    })

    test('git: no commits yet and nothing to copy: nothing', async () => {
      const w = world({ node: mode, git: true })
      w.git.head = null
      const out = await snap(w, [], { risks: [risk('clean', 'git clean -fd')] })
      expect(out.ok === false && out.reason).toBe('nothing')
    })

    test('git: not a repository: files only, hasGit false', async () => {
      const w = world({ node: mode, git: false })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'])
      expect(out.hasGit).toBe(false)
      expect(manifestOf(w, ID0).git).toBeUndefined()
    })

    test('git: git missing: files only', async () => {
      const w = world({ node: mode })
      const io = w.fs.io((argv, init) => (argv[0] === 'git' ? done(-1) : (w.node.handle(argv, init) ?? done(-1))))
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
      expect(out.ok && out.hasGit).toBe(false)
    })

    test('too-big leaves no git ref behind', async () => {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.fs.file(`${ROOT}/big.txt`, 'x'.repeat(500))
      const out = await snap(w, ['big.txt'], {}, { ...CFG, maxBytes: 10 })
      expect(out.ok).toBe(false)
      expect(w.git.refs.size).toBe(0)
    })

    test('never throws, whatever the IO does', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const boom = (): never => {
        throw new Error('boom')
      }
      const hostile: IO = { readText: boom, readBase64: boom, writeText: boom, list: boom, stat: boom, run: boom, now: boom }
      expect(await createSnapshot({ ...w.env, io: hostile }, req(['a.txt']), CFG)).toEqual({ ok: false, reason: 'failed' })
      expect(await createSnapshot(undefined as unknown as VaultEnv, req(['a.txt']), CFG)).toEqual({ ok: false, reason: 'failed' })
      expect(await createSnapshot(w.env, undefined as unknown as SnapshotRequest, CFG)).toEqual({ ok: false, reason: 'failed' })
      expect(await createSnapshot(w.env, req(['a.txt'], { kind: 'bogus' as never }), CFG)).toEqual({ ok: false, reason: 'failed' })
      expect(await createSnapshot({ ...w.env, snapshotsRoot: 'relative' }, req(['a.txt']), CFG)).toEqual({ ok: false, reason: 'failed' })
    })

    test('an id that another session took between the listing and the write: once more with a fresh one, never over it', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      w.fs.file(`${snapDirOf(ID0)}/files/theirs.txt`, 'theirs')
      w.fs.file(`${snapDirOf(ID0)}/manifest.json`, 'theirs too')
      // The folder exists but this session's listing does not show it (it appeared a moment after).
      const io: IO = { ...w.io, list: async p => (p === `${SNAPS}/${KEY}` ? [] : w.io.list(p)) }
      const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
      expect(out.ok && out.id).toBe(`${ID0}-2`)
      expect(w.fs.read(`${snapDirOf(ID0)}/files/theirs.txt`)).toBe('theirs')
      expect(w.fs.read(`${snapDirOf(ID0)}/manifest.json`)).toBe('theirs too')
    })

    test('the clock may answer with a promise (the engine clock does)', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const io: IO = { ...w.io, now: () => Promise.resolve(clock.now) }
      const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
      expect(out.ok && out.id).toBe(ID0)
    })
  })
}

describe('createSnapshot: fs backend only', () => {
  test('binary files are skipped and reported; the rest is saved; the outcome says partial', async () => {
    const w = world()
    w.fs.file(`${ROOT}/assets/logo.png`, [0x89, 0x50, 0x4e, 0x47, 0, 0, 1])
    w.fs.file(`${ROOT}/assets/latin.txt`, [0x63, 0x61, 0x66, 0xe9])
    w.fs.file(`${ROOT}/assets/readme.md`, '# hi')
    const out = await made(w, ['assets'])
    expect(out).toMatchObject({ files: 1, isPartial: true, skippedBinary: 2, backend: 'fs' })
    const m = manifestOf(w, ID0)
    expect(m.skipped).toEqual([{ rel: 'assets/latin.txt', reason: 'binary' }, { rel: 'assets/logo.png', reason: 'binary' }])
    expect(w.fs.has(`${snapDirOf(ID0)}/files/assets/logo.png`)).toBe(false)
    expect(w.fs.read(`${snapDirOf(ID0)}/files/assets/readme.md`)).toBe('# hi')
  })

  test('only binary files: nothing is written and the answer says how many were seen', async () => {
    const w = world()
    w.fs.file(`${ROOT}/logo.png`, [0x89, 0, 1, 2])
    w.fs.file(`${ROOT}/icon.ico`, [0, 0, 1, 0])
    const out = await snap(w, ['logo.png', 'icon.ico'])
    expect(out).toEqual({ ok: false, reason: 'nothing', skipped: 2 })
    expect(w.fs.below(SNAPS)).toEqual([])
  })

  test('a binary file with a git state: still a snapshot (of git), partial', async () => {
    const w = world({ git: true })
    w.fs.file(`${ROOT}/logo.png`, [0x89, 0, 1, 2])
    const out = await made(w, ['logo.png'], { risks: [risk('reset-hard', 'git reset --hard')] })
    expect(out).toMatchObject({ files: 0, hasGit: true, isPartial: true, skippedBinary: 1 })
  })

  test('an unreadable file is skipped, the rest is saved', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    w.fs.file(`${ROOT}/b.txt`, 'b')
    w.fs.failRead = p => p.endsWith('/a.txt')
    const out = await made(w, ['a.txt', 'b.txt'])
    expect(out).toMatchObject({ files: 1, isPartial: true })
    expect(manifestOf(w, ID0).skipped).toEqual([{ rel: 'a.txt', reason: 'unreadable' }])
  })

  test('a copy that fails midway leaves nothing: what was written is emptied, no manifest, no git ref', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'aaaa')
    w.fs.file(`${ROOT}/b.txt`, 'bbbb')
    w.fs.file(`${ROOT}/c.txt`, 'cccc')
    w.fs.failWrite = p => p.endsWith('/files/c.txt')
    const out = await snap(w, ['a.txt', 'b.txt', 'c.txt'])
    expect(out).toEqual({ ok: false, reason: 'failed' })
    expect(w.fs.read(`${snapDirOf(ID0)}/files/a.txt`)).toBe('')
    expect(w.fs.read(`${snapDirOf(ID0)}/files/b.txt`)).toBe('')
    expect(w.fs.has(`${snapDirOf(ID0)}/manifest.json`)).toBe(false)
    expect(w.git.refs.size).toBe(0)
    expect(await listSnapshots(w.env, ROOT)).toEqual([])
    // The project itself was never written.
    expect(w.fs.writes.every(p => p.startsWith(SNAPS))).toBe(true)
  })

  test('a manifest write that fails also leaves nothing usable', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'aaaa')
    w.fs.failWrite = p => p.endsWith('manifest.json')
    expect(await snap(w, ['a.txt'])).toEqual({ ok: false, reason: 'failed' })
    expect(w.fs.read(`${snapDirOf(ID0)}/files/a.txt`)).toBe('')
    expect(await listSnapshots(w.env, ROOT)).toEqual([])
  })

  test('a folder nested deeper than the engine walks is skipped (limit) and the snapshot says partial', async () => {
    const w = world()
    w.fs.file(`${ROOT}/top.txt`, 'top')
    w.fs.file(`${ROOT}/deep/${'d/'.repeat(70)}leaf.txt`, 'leaf')
    w.fs.file(`${ROOT}/deep/shallow.txt`, 'shallow')
    const out = await made(w, ['deep', 'top.txt'])
    expect(out.isPartial).toBe(true)
    expect(manifestOf(w, ID0).skipped.map(x => x.reason)).toEqual(['limit'])
    expect(manifestOf(w, ID0).files.map(f => f.rel)).toContain('deep/shallow.txt')
  })

  test('only the snapshots folder is ever written to', async () => {
    const w = world({ git: true })
    w.fs.file(`${ROOT}/a/b.txt`, 'x')
    w.fs.file(`${ROOT}/c.png`, [0, 1, 2])
    await made(w, ['a', 'c.png'])
    expect(w.fs.writes.length).toBeGreaterThan(0)
    expect(w.fs.writes.every(p => p.startsWith(`${SNAPS}/${KEY}/`))).toBe(true)
  })

  test('an unprobed node (undefined) is probed; a machine without node uses the fs backend quietly', async () => {
    const w = world({ node: 'none', envNode: undefined })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    expect(w.env.node).toBeUndefined()
    const out = await made(w, ['a.txt'])
    expect(out.backend).toBe('fs')
  })

  test('the same snapshot on Windows paths', async () => {
    const root = 'C:\\Users\\dev\\acme-shop'
    const snaps = 'C:\\Users\\dev\\.claude\\kit-safety\\snapshots'
    const w = world()
    w.fs.file('C:/Users/dev/acme-shop/build/a.js', 'a')
    w.fs.dir('C:/Users/dev/.claude/kit-safety/snapshots')
    const env: VaultEnv = { ...w.env, snapshotsRoot: snaps }
    const out = await createSnapshot(env, req(['build'], { root }), CFG)
    expect(out.ok).toBe(true)
    const key = projectKey(root)
    expect(key).toBe(projectKey('c:/users/dev/ACME-SHOP'))
    if (out.ok) expect(w.fs.read(`C:/Users/dev/.claude/kit-safety/snapshots/${key}/${out.id}/files/build/a.js`)).toBe('a')
    expect((await listSnapshots(env, 'C:/Users/dev/acme-shop')).map(m => m.id)).toEqual([ID0])
  })
})

describe('createSnapshot: node backend only', () => {
  test('a size limit that is not a usable number is replaced before it reaches the helper (JSON has no Infinity or NaN)', async () => {
    for (const maxBytes of [Infinity, NaN, undefined as unknown as number]) {
      const w = world({ node: 'ok' })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await snap(w, ['a.txt'], {}, { ...CFG, maxBytes })
      expect(out.ok, String(maxBytes)).toBe(true)
      for (const r of w.node.requests.filter(q => q.cmd === 'scan' || q.cmd === 'copy')) expect(typeof r.maxBytes === 'number' && Number.isFinite(r.maxBytes), String(maxBytes)).toBe(true)
    }
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    expect((await snap(w, ['a.txt'], {}, { ...CFG, maxBytes: -5 })).ok).toBe(false) // a negative limit saves nothing
  })

  test('the helper gets scan, then copy, with the manifest base, the project key folder and the limits', async () => {
    const w = world({ node: 'ok', git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/build/a.js`, 'a')
    const out = await made(w, ['build'], { command: 'rm -rf build', risks: [risk('delete', 'rm -rf', { paths: ['build'] }), risk('reset-hard', 'git reset --hard')] })
    expect(w.node.requests.map(r => r.cmd)).toEqual(['scan', 'copy'])
    const scan = w.node.requests[0]!
    expect(scan).toMatchObject({ cmd: 'scan', root: ROOT, targets: ['build'], maxBytes: 100 * MB, maxFiles: 50_000 })
    const copy = w.node.requests[1]!
    expect(copy).toMatchObject({ cmd: 'copy', root: ROOT, destDir: `${SNAPS}/${KEY}/${ID0}`, targets: ['build'], maxBytes: 100 * MB, maxFiles: 50_000 })
    expect(copy.manifest).toMatchObject({ v: 1, id: ID0, n: 1, createdAt: clock.now, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'delete', label: 'rm -rf' }, { kind: 'reset-hard', label: 'git reset --hard' }], git: { head: SHA1, branch: 'main', stashSha: SHA2, ref: `refs/kit-safety/${ID0}` } })
    expect('command' in (copy.manifest as object)).toBe(false) // the command text is not even sent to the helper
    expect(out).toMatchObject({ backend: 'node', files: 1, hasGit: true })
    const m = manifestOf(w, ID0)
    expect(m.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(w.fs.writes).toEqual([]) // the plugin writes nothing itself: the helper did it
  })

  test('binary files are saved byte for byte, and that is complete (not partial)', async () => {
    const w = world({ node: 'ok' })
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    w.fs.file(`${ROOT}/assets/logo.png`, bytes)
    const out = await made(w, ['assets'])
    expect(out).toMatchObject({ files: 1, isPartial: false, skippedBinary: 0 })
    expect([...w.fs.bytesOf(`${snapDirOf(ID0)}/files/assets/logo.png`)!]).toEqual([...bytes])
  })

  test('the size check happens first: too-big from scan means no copy and no git ref', async () => {
    const w = world({ node: 'ok', git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/big.txt`, 'x'.repeat(500))
    const out = await snap(w, ['big.txt'], {}, { ...CFG, maxBytes: 100 })
    expect(out).toEqual({ ok: false, reason: 'too-big', bytes: 500 }) // the file that crossed the limit is counted
    expect(w.node.requests.map(r => r.cmd)).toEqual(['scan'])
    expect(w.git.calls).toEqual([])
  })

  test('too-big from copy itself (the tree grew after the scan) is too-big and unpins git', async () => {
    const w = world({ node: 'ok', git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const real = w.node.handle
    let scans = 0
    w.node.handle = (argv, init) => {
      const r = JSON.parse(init?.stdin ?? '{}') as { cmd?: string }
      if (argv[1] === HELPER && r.cmd === 'copy') return done(0, `${JSON.stringify({ ok: true, tooBig: true, files: 9, bytes: 12345, skipped: [], skippedCount: 0, missing: [] })}\n`)
      scans += 1
      return real(argv, init)
    }
    const io = w.fs.io((argv, init) => (argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))))
    const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
    expect(out).toEqual({ ok: false, reason: 'too-big', bytes: 12345 })
    expect(scans).toBeGreaterThan(0)
    expect(w.git.refs.size).toBe(0)
  })

  test('targets the scan found missing are left out of the copy request', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    await made(w, ['a.txt', 'gone.txt'])
    expect((w.node.requests[1] as { targets: string[] }).targets).toEqual(['a.txt'])
    expect(manifestOf(w, ID0).targets).toEqual(['a.txt'])
  })

  test('a scan with nothing in it and no git: nothing, and no copy is attempted', async () => {
    const w = world({ node: 'ok' })
    expect((await snap(w, ['gone.txt'])).ok).toBe(false)
    expect(w.node.requests.map(r => r.cmd)).toEqual(['scan'])
  })

  for (const mode of ['crash', 'garbage', 'refuse'] as const) {
    test(`a helper that ${mode === 'crash' ? 'exits with an error' : mode === 'garbage' ? 'prints something that is not JSON' : 'refuses'}: the fs backend takes over quietly`, async () => {
      const w = world({ node: mode })
      w.env.node = true
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'])
      expect(out.backend).toBe('fs')
      expect(w.fs.read(`${snapDirOf(out.id)}/files/a.txt`)).toBe('a')
    })
  }

  test('node is announced but cannot start (spawn failure): the fs backend', async () => {
    const w = world({ node: 'none' })
    w.env.node = true
    w.fs.file(`${ROOT}/a.txt`, 'a')
    expect((await made(w, ['a.txt'])).backend).toBe('fs')
  })

  test('a helper that refuses a folder that exists: one more try with a fresh id', async () => {
    const w = world({ node: 'collide-once' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    expect(out.id).toBe(`${ID0}-2`)
    expect(out.backend).toBe('node')
    expect(w.node.requests.filter(r => r.cmd === 'copy').map(r => (r.manifest as { id: string }).id)).toEqual([ID0, `${ID0}-2`])
  })

  test('a helper that always refuses a folder: after the second try the fs backend takes over', async () => {
    const w = world({ node: 'collide-always' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    expect(out.backend).toBe('fs')
    expect(w.node.requests.filter(r => r.cmd === 'copy')).toHaveLength(2)
  })

  test('a helper that refuses leaves no ref behind (refs are made after the copy), and the fs fallback makes exactly one', async () => {
    const w = world({ node: 'refuse', git: true })
    w.env.node = true
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'], { risks: [risk('reset-hard')] })
    expect([...w.git.refs.keys()]).toEqual([`refs/kit-safety/${out.id}`])
    expect(w.git.deleted).toEqual([]) // nothing was made for the failed try, so nothing is deleted
  })

  test('an unprobed node is probed once per call', async () => {
    const w = world({ node: 'ok', envNode: undefined })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    expect(w.env.node).toBeUndefined()
    const out = await made(w, ['a.txt'])
    expect(out.backend).toBe('node')
    expect(w.node.versionCalls).toBe(1) // the prune that follows has nothing to remove, so it does not ask again
  })

  test('an old node (16) is not used', async () => {
    const w = world({ node: 'ok', envNode: undefined })
    w.node.version = 'v16.0.0'
    w.fs.file(`${ROOT}/a.txt`, 'a')
    expect((await made(w, ['a.txt'])).backend).toBe('fs')
    expect(w.node.requests).toEqual([])
  })

  test('what the helper could not read makes the snapshot partial; links alone do not; a cut skipped list does', async () => {
    const a = world({ node: 'ok' })
    a.fs.file(`${ROOT}/a.txt`, 'a')
    a.node.skipOnCopy = [{ rel: 'a.txt', reason: 'unreadable' }]
    expect((await made(a, ['a.txt'])).isPartial).toBe(true)
    const b = world({ node: 'ok' })
    b.fs.file(`${ROOT}/a.txt`, 'a')
    b.node.skipOnCopy = [{ rel: 'l', reason: 'symlink' }]
    expect((await made(b, ['a.txt'])).isPartial).toBe(false)
    const c = world({ node: 'ok' })
    c.fs.file(`${ROOT}/a.txt`, 'a')
    c.node.skipOnCopy = [{ rel: 'l', reason: 'symlink' }]
    c.node.extraSkipped = 3
    expect((await made(c, ['a.txt'])).isPartial).toBe(true)
  })
})

describe('listSnapshots', () => {
  test('newest first; a folder that is not a usable snapshot is left out', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      clock.now += 1000
      ids.push((await made(w, ['a.txt'])).id)
    }
    // damaged, foreign and odd folders
    w.fs.file(`${SNAPS}/${KEY}/20200101T000000Z/manifest.json`, '{not json')
    w.fs.file(`${SNAPS}/${KEY}/20200102T000000Z/manifest.json`, '')
    w.fs.dir(`${SNAPS}/${KEY}/20200103T000000Z`)
    w.fs.file(`${SNAPS}/${KEY}/not-an-id/manifest.json`, w.fs.read(`${snapDirOf(ids[0]!)}/manifest.json`)!)
    w.fs.file(`${SNAPS}/${KEY}/20200104T000000Z/manifest.json`, w.fs.read(`${snapDirOf(ids[0]!)}/manifest.json`)!) // id does not match its folder
    w.fs.file(`${SNAPS}/${KEY}/stray.txt`, 'x')
    const listed = await listSnapshots(w.env, ROOT)
    expect(listed.map(m => m.id)).toEqual([...ids].reverse())
    expect(listed.map(m => m.n)).toEqual([3, 2, 1])
  })

  test('a manifest of another project copied into this one is not listed', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    const other = { ...manifestOf(w, out.id), id: '20200105T000000Z', root: '/work/other-project' }
    w.fs.file(`${SNAPS}/${KEY}/20200105T000000Z/manifest.json`, JSON.stringify(other))
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([out.id])
    expect(await listSnapshots(w.env, '/work/other-project')).toEqual([])
  })

  test('a pruned marker hides a snapshot for good', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    w.fs.file(`${snapDirOf(out.id)}/pruned`, 'pruned\n')
    expect(await listSnapshots(w.env, ROOT)).toEqual([])
  })

  test('equal times are ordered by id; two projects do not see each other', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    w.fs.file('/work/other/a.txt', 'a')
    await made(w, ['a.txt'])
    await made(w, ['a.txt'])
    const o = await createSnapshot(w.env, req(['a.txt'], { root: '/work/other' }), CFG)
    expect(o.ok).toBe(true)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([`${ID0}-2`, ID0])
    expect(await listSnapshots(w.env, '/work/other')).toHaveLength(1)
  })

  test('no snapshots folder, a root that cannot be used, a throwing IO: []', async () => {
    const w = world()
    expect(await listSnapshots(w.env, ROOT)).toEqual([])
    expect(await listSnapshots(w.env, 'relative')).toEqual([])
    expect(await listSnapshots(w.env, '/')).toEqual([])
    const boom = (): never => {
      throw new Error('x')
    }
    expect(await listSnapshots({ ...w.env, io: { ...w.io, list: boom } }, ROOT)).toEqual([])
    expect(await listSnapshots(undefined as unknown as VaultEnv, ROOT)).toEqual([])
  })
})

describe('findSnapshot', () => {
  async function three(): Promise<{ w: World; ids: string[] }> {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      clock.now += 1000
      ids.push((await made(w, ['a.txt'])).id)
    }
    return { w, ids }
  }
  const id = async (w: World, q?: string) => (await findSnapshot(w.env, ROOT, q))?.id ?? null

  test('by number: 2 and #2', async () => {
    const { w, ids } = await three()
    expect(await id(w, '2')).toBe(ids[1])
    expect(await id(w, '#2')).toBe(ids[1])
    expect(await id(w, ' #3 ')).toBe(ids[2])
    expect(await id(w, '# 1')).toBe(ids[0])
    expect(await id(w, '4')).toBeNull()
    expect(await id(w, '0')).toBeNull()
  })

  test('by full id, in any case', async () => {
    const { w, ids } = await three()
    expect(await id(w, ids[0])).toBe(ids[0])
    expect(await id(w, ids[0]!.toLowerCase())).toBe(ids[0])
  })

  test('by a prefix that only one snapshot has; an ambiguous prefix is null', async () => {
    const { w, ids } = await three()
    expect(await id(w, ids[2]!.slice(0, 15))).toBe(ids[2]) // up to the last digit of the second
    expect(await id(w, '20261124T0930')).toBeNull() // all three
    expect(await id(w, '2026')).toBeNull()
    expect(await id(w, '20261124T093016')).toBe(ids[0])
  })

  test('no argument: the newest snapshot made before a command (not an undo point)', async () => {
    const { w, ids } = await three()
    clock.now += 1000
    await made(w, ['a.txt'], { kind: 'before-restore', restoredFrom: ids[0] })
    expect(await id(w)).toBe(ids[2])
    expect(await id(w, '')).toBe(ids[2])
    expect(await id(w, '   ')).toBe(ids[2])
    expect(await id(w, '#')).toBe(ids[2])
  })

  test('no argument: a quiet save before an edit is only the default when nothing else was made before a command; a number or id still picks it', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const quiet: Risk = { kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: [] }
    clock.now += 1000
    const first = await made(w, ['a.txt'], { tool: 'Write', risks: [quiet] })
    expect(manifestOf(w, first.id).quiet).toBe(true)
    // only quiet ones: the newest of them
    expect(await id(w)).toBe(first.id)
    clock.now += 1000
    const asked = await made(w, ['a.txt'])
    expect('quiet' in manifestOf(w, asked.id)).toBe(false)
    clock.now += 1000
    const second = await made(w, ['a.txt'], { tool: 'Edit', risks: [quiet] })
    clock.now += 1000
    const third = await made(w, ['a.txt'], { tool: 'Edit', risks: [quiet] })
    expect(manifestOf(w, third.id).quiet).toBe(true)
    // the newest snapshot is quiet, but the default is the newest one that was asked about
    expect(await id(w)).toBe(asked.id)
    expect(await id(w, '')).toBe(asked.id)
    // an undo point is still never the default, and an explicit number or id picks exactly that one
    clock.now += 1000
    await made(w, ['a.txt'], { kind: 'before-restore', restoredFrom: asked.id })
    expect(await id(w)).toBe(asked.id)
    expect(await id(w, String(third.n))).toBe(third.id)
    expect(await id(w, second.id)).toBe(second.id)
  })

  test('an undo point can be found by its number', async () => {
    const { w } = await three()
    clock.now += 1000
    const undo = await made(w, ['a.txt'], { kind: 'before-restore' })
    expect(await id(w, String(undo.n))).toBe(undo.id)
  })

  test('nothing there, odd input, never a throw', async () => {
    const w = world()
    expect(await id(w)).toBeNull()
    const { w: v } = await three()
    for (const q of ['abc', '-1', '1.5', '1e3', '9'.repeat(30), 'x'.repeat(1000), '../..', '*', '\u0000', '2026 1124', 'T093015Z'] as string[]) expect(await id(v, q), q).toBeNull()
    expect(await findSnapshot(v.env, 'relative', '1')).toBeNull()
    expect(await findSnapshot(v.env, ROOT, 5 as unknown as string)).toEqual((await findSnapshot(v.env, ROOT))!)
  })
})

describe('pruneSnapshots', () => {
  async function many(w: World, n: number, stepMs: number): Promise<string[]> {
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const ids: string[] = []
    for (let i = 0; i < n; i += 1) {
      clock.now += stepMs
      ids.push((await made(w, ['a.txt'], {}, { ...CFG, keepCount: 1000, keepDays: 100_000 })).id)
    }
    return ids
  }

  test('beyond the newest keepCount: the oldest go', async () => {
    const w = world()
    const ids = await many(w, 6, 1000)
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 4 })).toBe(2)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([ids[5], ids[4], ids[3], ids[2]])
  })

  test('older than keepDays: they go too, and age beats "the newest": a snapshot a year old goes even when it is the only one', async () => {
    const w = world()
    const ids = await many(w, 3, 20 * DAY)
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepDays: 14 })).toBe(2)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([ids[2]])
    clock.now += 365 * DAY
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepDays: 1 }, [])).toBe(1)
    expect(await listSnapshots(w.env, ROOT)).toHaveLength(0)
  })

  test('only protected ids are exempt from the age rule', async () => {
    const w = world()
    const ids = await many(w, 2, 1000)
    clock.now += 365 * DAY
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepDays: 1 }, [ids[1]!])).toBe(1)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([ids[1]])
  })

  test('protected ids stay, even the oldest', async () => {
    const w = world()
    const ids = await many(w, 4, 1000)
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 }, [ids[0]!, ids[1]!])).toBe(1)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([ids[3], ids[1], ids[0]])
  })

  test('undo points count like the others', async () => {
    const w = world()
    const ids = await many(w, 2, 1000)
    clock.now += 1000
    const undo = await made(w, ['a.txt'], { kind: 'before-restore', restoredFrom: ids[0] }, { ...CFG, keepCount: 1000 })
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 })).toBe(2)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([undo.id])
  })

  test('without node: files are emptied, a pruned marker hides the snapshot, git refs go', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'secret-ish content')
    w.fs.file(`${ROOT}/d/b.txt`, 'more')
    clock.now += 1000
    const reset = { risks: [risk('reset-hard', 'git reset --hard')] }
    const old = await made(w, ['a.txt', 'd'], reset, { ...CFG, keepCount: 100 })
    clock.now += 1000
    const fresh = await made(w, ['a.txt'], reset, { ...CFG, keepCount: 100 })
    expect(w.git.refs.has(`refs/kit-safety/${old.id}`)).toBe(true)
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 })).toBe(1)
    const dir = snapDirOf(old.id)
    expect(w.fs.has(`${dir}/pruned`)).toBe(true)
    expect(w.fs.read(`${dir}/files/a.txt`)).toBe('')
    expect(w.fs.read(`${dir}/files/d/b.txt`)).toBe('')
    expect(w.fs.read(`${dir}/manifest.json`)).toBe('')
    expect(w.git.refs.has(`refs/kit-safety/${old.id}`)).toBe(false)
    expect(w.git.refs.has(`refs/kit-safety/${fresh.id}`)).toBe(true)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([fresh.id])
    // The id stays taken, so a new snapshot in the same second does not reuse the folder.
    clock.now -= 1000
    expect((await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })).id).not.toBe(old.id)
  })

  test('with node: the helper deletes the folder, and the git refs go', async () => {
    const w = world({ node: 'ok', git: true })
    w.git.stash = SHA2
    w.git.branches = { x: SHA3 }
    w.fs.file(`${ROOT}/a.txt`, 'a')
    clock.now += 1000
    const old = await made(w, ['a.txt'], { risks: [risk('branch-delete', 'git branch -D', { name: 'x' }), risk('reset-hard', 'git reset --hard')] }, { ...CFG, keepCount: 100 })
    clock.now += 1000
    await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
    expect(w.git.refs.has(`refs/kit-safety/${old.id}.b/1`)).toBe(true)
    expect(w.git.refs.has(`refs/kit-safety/${old.id}`)).toBe(true)
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 })).toBe(1)
    expect(w.fs.has(snapDirOf(old.id))).toBe(false)
    expect(w.node.requests.filter(r => r.cmd === 'remove')).toEqual([{ cmd: 'remove', snapshotsRoot: SNAPS, projectKey: KEY, id: old.id }])
    expect(w.git.refs.has(`refs/kit-safety/${old.id}`)).toBe(false)
    expect(w.git.refs.has(`refs/kit-safety/${old.id}.b/1`)).toBe(false)
  })

  test('a helper that cannot remove: the marker way is used instead', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    clock.now += 1000
    const old = await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
    clock.now += 1000
    await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
    w.node.mode = 'crash'
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 })).toBe(1)
    expect(w.fs.has(`${snapDirOf(old.id)}/pruned`)).toBe(true)
  })

  test('only git refs of the plugin are ever deleted', async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'a')
    w.git.refs.set('refs/heads/main', SHA1)
    clock.now += 1000
    await made(w, ['a.txt'], { risks: [risk('reset-hard')] }, { ...CFG, keepCount: 100 })
    clock.now += 1000
    await made(w, ['a.txt'], { risks: [risk('reset-hard')] }, { ...CFG, keepCount: 100 })
    await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1 })
    expect(w.git.deleted.length).toBeGreaterThan(0)
    expect(w.git.refs.get('refs/heads/main')).toBe(SHA1)
    for (const c of w.git.calls.filter(c => c[0] === 'update-ref' && c[1] === '-d')) expect(c[2]?.startsWith('refs/kit-safety/')).toBe(true)
    for (const ref of w.git.deleted) expect(ref.startsWith('refs/kit-safety/')).toBe(true)
  })

  test('nothing to prune, bad numbers, a root that cannot be used, a throwing IO: 0', async () => {
    const w = world()
    expect(await pruneSnapshots(w.env, ROOT, CFG)).toBe(0)
    await many(w, 3, 1000)
    expect(await pruneSnapshots(w.env, ROOT, { maxBytes: NaN, keepCount: NaN, keepDays: NaN })).toBe(0) // defaults: 20 and 14 days
    expect(await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 0 })).toBe(2) // below 1 counts as 1
    expect(await pruneSnapshots(w.env, 'relative', CFG)).toBe(0)
    expect(await pruneSnapshots(w.env, ROOT, CFG, 'x' as unknown as string[])).toBe(0)
    const boom = (): never => {
      throw new Error('x')
    }
    expect(await pruneSnapshots({ ...w.env, io: { ...w.io, list: boom } }, ROOT, CFG)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Restore

for (const { name, mode } of BACKENDS) {
  describe(`restoreSnapshot: ${name}`, () => {
    test('a deleted folder comes back, file by file, with its content', async () => {
      const { w, id } = await snapshotted(mode, { 'build/a.js': 'A\r\n', 'build/sub/b.css': 'B', 'build/c.txt': '' }, ['build'])
      w.fs.remove(`${ROOT}/build`)
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
      expect(out).toMatchObject({ ok: true, restored: 3, failed: [], keptNewer: 0, id, n: 1, at: Date.UTC(2026, 10, 24, 9, 30, 15), hasUndo: false, git: [] })
      expect(out.sample).toEqual(['build/a.js', 'build/c.txt', 'build/sub/b.css'])
      expect(w.fs.read(`${ROOT}/build/a.js`)).toBe('A\r\n')
      expect(w.fs.read(`${ROOT}/build/sub/b.css`)).toBe('B')
      expect(w.fs.read(`${ROOT}/build/c.txt`)).toBe('')
    })

    test('an overwritten file gets its old content back; a newer file next to it is left alone and counted', async () => {
      const { w, id } = await snapshotted(mode, { 'src/a.ts': 'old', 'src/b.ts': 'old b' }, ['src'])
      w.fs.file(`${ROOT}/src/a.ts`, 'NEW')
      w.fs.file(`${ROOT}/src/new-work.ts`, 'my newer work')
      w.fs.file(`${ROOT}/src/deep/more.ts`, 'more newer work')
      w.node.keptNewer = 2
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
      expect(out.ok).toBe(true)
      expect(out.restored).toBe(2)
      expect(out.keptNewer).toBe(2)
      expect(w.fs.read(`${ROOT}/src/a.ts`)).toBe('old')
      expect(w.fs.read(`${ROOT}/src/new-work.ts`)).toBe('my newer work')
      expect(w.fs.read(`${ROOT}/src/deep/more.ts`)).toBe('more newer work')
    })

    test('before it writes anything an undo point saves what is there now', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      w.fs.file(`${ROOT}/a.txt`, 'v2')
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
      expect(out).toMatchObject({ ok: true, hasUndo: true })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
      const list = await listSnapshots(w.env, ROOT)
      expect(list).toHaveLength(2)
      const undo = list[0]!
      expect(undo).toMatchObject({ kind: 'before-restore', restoredFrom: id, tool: 'safety', targets: ['a.txt'] })
      expect('command' in undo).toBe(false)
      expect(w.fs.read(`${snapDirOf(undo.id)}/files/a.txt`)).toBe('v2')
    })

    test('no undo point when there is nothing at the places the restore writes to', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      w.fs.remove(`${ROOT}/a.txt`)
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
      expect(out).toMatchObject({ ok: true, restored: 1, hasUndo: false, noneOverwritten: true })
      expect(out.leftAsIs).toBeUndefined()
      expect(await listSnapshots(w.env, ROOT)).toHaveLength(1)
    })

    test('an undo point that could not be saved: what exists is NOT overwritten, only what is missing comes back, and it says so', async () => {
      const { w, id } = await snapshotted(mode, { 'src/a.txt': 'v1', 'src/b.txt': 'b1', 'src/c/d.txt': 'd1' }, ['src'])
      w.fs.file(`${ROOT}/src/a.txt`, 'x'.repeat(5000)) // too big for the undo point below
      w.fs.remove(`${ROOT}/src/b.txt`)
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id), { ...CFG, maxBytes: 100 })
      expect(out).toMatchObject({ ok: false, hasUndo: false, leftAsIs: 2, restored: 1, failed: [] })
      expect(out.sample).toEqual(['src/b.txt'])
      expect(w.fs.read(`${ROOT}/src/a.txt`)).toBe('x'.repeat(5000)) // kept
      expect(w.fs.read(`${ROOT}/src/c/d.txt`)).toBe('d1') // kept (existing, same)
      expect(w.fs.read(`${ROOT}/src/b.txt`)).toBe('b1') // was missing: back
      expect(await listSnapshots(w.env, ROOT)).toHaveLength(1) // no undo point
    })

    test('an undo point that could not be saved and nothing missing: nothing is written at all', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      w.fs.file(`${ROOT}/a.txt`, 'x'.repeat(5000))
      w.fs.writes.length = 0
      const out = await restoreSnapshot(w.env, ROOT, await find(w, id), { ...CFG, maxBytes: 100 })
      expect(out).toMatchObject({ ok: false, restored: 0, leftAsIs: 1, hasUndo: false })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('x'.repeat(5000))
      expect(w.fs.writes).toEqual([])
      expect(w.node.requests.filter(r => r.cmd === 'restore')).toEqual([])
    })

    test('the snapshot being restored survives the prune that the undo point triggers', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'v1')
      clock.now += 1000
      const first = await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      for (let i = 0; i < 3; i += 1) {
        clock.now += 1000
        w.fs.file(`${ROOT}/a.txt`, `v${i + 2}`)
        await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      }
      const out = await restoreSnapshot(w.env, ROOT, await find(w, first.id), { ...CFG, keepCount: 1 })
      expect(out).toMatchObject({ ok: true, hasUndo: true })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
      const ids = (await listSnapshots(w.env, ROOT)).map(m => m.id)
      expect(ids).toContain(first.id)
    })

    test('without a cfg the undo point has a default limit and nothing is pruned', async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'v1')
      const first = await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      for (let i = 0; i < 4; i += 1) {
        clock.now += 1000
        await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      }
      await restoreSnapshot(w.env, ROOT, await find(w, first.id))
      expect(await listSnapshots(w.env, ROOT)).toHaveLength(6)
    })

    test('git facts become commands to copy; none of them is run', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'], true)
      w.git.stash = SHA2
      clock.now += 1000
      const second = await made(w, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      const before = w.git.calls.length
      const out = await restoreSnapshot(w.env, ROOT, await find(w, second.id))
      expect(out.git).toEqual([
        { label: 'stash', command: `git stash apply refs/kit-safety/${second.id}` },
        { label: 'head', command: `git checkout ${SHA1}` },
      ])
      expect(w.git.calls.length).toBe(before) // restore itself asks git nothing
      expect(id).toBeTruthy()
    })

    test('a snapshot of another project is refused, nothing is written', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      const m = await find(w, id)
      w.fs.file('/work/other/a.txt', 'other')
      const writes = w.fs.writes.length
      const out = await restoreSnapshot(w.env, '/work/other', m)
      expect(out).toMatchObject({ ok: false, restored: 0, reason: 'other-project', failed: [] })
      expect(w.fs.read('/work/other/a.txt')).toBe('other')
      expect(w.fs.writes.length).toBe(writes)
      // also when the manifest object claims to be this project but the folder on disk is another's
      const forged = { ...m, root: '/work/other' }
      expect((await restoreSnapshot(w.env, ROOT, forged)).reason).toBe('other-project')
    })

    test('a snapshot that is gone (pruned, or never there) is "not-found"', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      const m = await find(w, id)
      w.fs.remove(snapDirOf(id))
      expect(await restoreSnapshot(w.env, ROOT, m)).toMatchObject({ ok: false, reason: 'not-found', restored: 0 })
      expect(await restoreSnapshot(w.env, ROOT, { ...m, id: 'bad id' })).toMatchObject({ ok: false, reason: 'not-found' })
    })

    test('a manifest changed on disk is read again: unsafe entries are dropped, never written', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      const m = await find(w, id)
      const doctored = {
        ...JSON.parse(w.fs.read(`${snapDirOf(id)}/manifest.json`)!),
        files: [
          { rel: 'a.txt', size: 2, mtimeMs: 1 },
          { rel: '../escape.txt', size: 1, mtimeMs: 1 },
          { rel: '/etc/passwd', size: 1, mtimeMs: 1 },
          { rel: 'a/../../up.txt', size: 1, mtimeMs: 1 },
          { rel: 'C:/win.txt', size: 1, mtimeMs: 1 },
          { rel: 'back\\slash.txt', size: 1, mtimeMs: 1 },
        ],
        dirs: ['../dir', '/abs'],
        targets: ['../escape.txt', 'a.txt'],
      }
      w.fs.file(`${snapDirOf(id)}/manifest.json`, JSON.stringify(doctored))
      w.fs.file(`${snapDirOf(id)}/files/../escape.txt`, 'pwned')
      w.fs.remove(`${ROOT}/a.txt`)
      const out = await restoreSnapshot(w.env, ROOT, m)
      expect(out).toMatchObject({ ok: true, restored: 1 })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
      expect(w.fs.has(`${ROOT}/../escape.txt`)).toBe(false)
      expect(w.fs.has('/etc/passwd')).toBe(false)
      expect(w.fs.has('/work/escape.txt')).toBe(false)
    })

    test('a manifest that no longer parses is "not-found"', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      const m = await find(w, id)
      w.fs.file(`${snapDirOf(id)}/manifest.json`, '{"v":2}')
      expect((await restoreSnapshot(w.env, ROOT, m)).reason).toBe('not-found')
    })

    test('never throws: odd manifests, a throwing IO', async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1' }, ['a.txt'])
      const m = await find(w, id)
      for (const bad of [undefined, null, {}, 5, 'x', { ...m, root: 5 }] as unknown[]) expect((await restoreSnapshot(w.env, ROOT, bad as Manifest)).ok).toBe(false)
      expect((await restoreSnapshot(w.env, 'relative', m)).ok).toBe(false)
      const boom = (): never => {
        throw new Error('x')
      }
      const hostile: IO = { readText: boom, readBase64: boom, writeText: boom, list: boom, stat: boom, run: boom, now: boom }
      const out = await restoreSnapshot({ ...w.env, io: hostile }, ROOT, m)
      expect(out.ok).toBe(false)
    })
  })
}

describe('restoreSnapshot: fs backend only', () => {
  test('a folder link in the way that leaves the project: that file is refused, the outside is untouched', async () => {
    const { w, id } = await snapshotted('none', { 'src/a.txt': 'v1', 'src/b.txt': 'v1b', 'ok.txt': 'ok' }, ['src', 'ok.txt'])
    w.fs.file('/outside/a.txt', 'OUTSIDE')
    w.fs.remove(`${ROOT}/src`)
    w.fs.link(`${ROOT}/src`, '/outside')
    w.fs.remove(`${ROOT}/ok.txt`)
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.ok).toBe(false)
    expect(reasons(out)).toEqual(['src/a.txt:outside', 'src/b.txt:outside'])
    expect(out.restored).toBe(1)
    expect(w.fs.read('/outside/a.txt')).toBe('OUTSIDE')
    expect(w.fs.has('/outside/b.txt')).toBe(false)
    expect(w.fs.read(`${ROOT}/ok.txt`)).toBe('ok')
    expect(w.fs.writes.every(p => p.startsWith(ROOT) || p.startsWith(SNAPS))).toBe(true)
  })

  test('a link inside the project that stays inside is followed; the file at its end is written', async () => {
    const { w, id } = await snapshotted('none', { 'packages/core/a.txt': 'v1' }, ['packages'])
    w.fs.remove(`${ROOT}/packages`)
    w.fs.dir(`${ROOT}/real`)
    w.fs.dir(`${ROOT}/packages`)
    w.fs.link(`${ROOT}/packages/core`, `${ROOT}/real`)
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.ok).toBe(true)
    expect(w.fs.read(`${ROOT}/real/a.txt`)).toBe('v1')
  })

  test('the file itself is now a symbolic link: it is not written through', async () => {
    const { w, id } = await snapshotted('none', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.file('/outside/target.txt', 'OUTSIDE')
    w.fs.remove(`${ROOT}/a.txt`)
    w.fs.link(`${ROOT}/a.txt`, '/outside/target.txt')
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(reasons(out)).toEqual(['a.txt:symlink'])
    expect(w.fs.read('/outside/target.txt')).toBe('OUTSIDE')
  })

  test('a folder is where a file should be: refused as blocked', async () => {
    const { w, id } = await snapshotted('none', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.remove(`${ROOT}/a.txt`)
    w.fs.file(`${ROOT}/a.txt/inner.txt`, 'x')
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(reasons(out)).toEqual(['a.txt:blocked'])
    expect(w.fs.read(`${ROOT}/a.txt/inner.txt`)).toBe('x')
  })

  test('a parent that is a file: refused', async () => {
    const { w, id } = await snapshotted('none', { 'd/a.txt': 'v1' }, ['d'])
    w.fs.remove(`${ROOT}/d`)
    w.fs.file(`${ROOT}/d`, 'now a file')
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.ok).toBe(false)
    expect(w.fs.read(`${ROOT}/d`)).toBe('now a file')
  })

  test('when the engine cannot say where the project really is, nothing is written', async () => {
    const { w, id } = await snapshotted('none', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.remove(`${ROOT}/a.txt`)
    w.fs.noRealPath = true
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(reasons(out)).toEqual(['a.txt:outside'])
    expect(w.fs.has(`${ROOT}/a.txt`)).toBe(false)
  })

  test('partial failures: a stored copy that is missing, one that cannot be written; the rest is restored', async () => {
    const { w, id } = await snapshotted('none', { 'd/a.txt': 'A', 'd/b.txt': 'B', 'd/c.txt': 'C', 'd/e.txt': 'E' }, ['d'])
    w.fs.remove(`${ROOT}/d`)
    w.fs.remove(`${snapDirOf(id)}/files/d/b.txt`)
    w.fs.failWrite = p => p === `${ROOT}/d/c.txt`
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.ok).toBe(false)
    expect(out.restored).toBe(2)
    expect(reasons(out)).toEqual(['d/b.txt:missing', 'd/c.txt:write-failed'])
    expect(out.sample).toEqual(['d/a.txt', 'd/e.txt'])
    expect(w.fs.read(`${ROOT}/d/a.txt`)).toBe('A')
    expect(w.fs.read(`${ROOT}/d/e.txt`)).toBe('E')
  })

  test('a stored copy that is not text (a snapshot made by the node backend) needs node: reported, not corrupted', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/assets/logo.png`, [0x89, 0x50, 0, 1, 2, 0xff])
    w.fs.file(`${ROOT}/assets/readme.md`, '# hi')
    const out0 = await made(w, ['assets'])
    w.fs.remove(`${ROOT}/assets`)
    w.node.mode = 'none'
    w.env.node = false
    const out = await restoreSnapshot(w.env, ROOT, await find(w, out0.id))
    expect(out.ok).toBe(false)
    expect(reasons(out)).toEqual(['assets/logo.png:needs-node'])
    expect(out.restored).toBe(1)
    expect(w.fs.read(`${ROOT}/assets/readme.md`)).toBe('# hi')
    expect(w.fs.has(`${ROOT}/assets/logo.png`)).toBe(false)
  })

  test('an empty folder that is gone cannot be made by the engine; one that exists is fine', async () => {
    const w2 = world()
    w2.fs.dir(`${ROOT}/cache/empty-1`)
    w2.fs.file(`${ROOT}/cache/a.txt`, 'a')
    const out0 = await made(w2, ['cache'])
    expect(manifestOf(w2, out0.id).dirs).toEqual(['cache/empty-1'])
    const present = await restoreSnapshot(w2.env, ROOT, await find(w2, out0.id))
    expect(present.ok).toBe(true)
    w2.fs.remove(`${ROOT}/cache/empty-1`)
    const gone = await restoreSnapshot(w2.env, ROOT, await find(w2, out0.id))
    expect(reasons(gone)).toEqual(['cache/empty-1:needs-node'])
    expect(gone.restored).toBe(1)
  })

  test('keptNewer counts what is under a restored folder but not in the snapshot', async () => {
    const { w, id } = await snapshotted('none', { 'src/a.ts': 'a', 'src/sub/b.ts': 'b' }, ['src'])
    w.fs.file(`${ROOT}/src/new.ts`, 'n')
    w.fs.file(`${ROOT}/src/sub/new2.ts`, 'n')
    w.fs.file(`${ROOT}/src/deeper/new3.ts`, 'n')
    w.fs.link(`${ROOT}/src/lnk`, `${ROOT}/src/a.ts`)
    w.fs.file(`${ROOT}/elsewhere.ts`, 'not under a restored folder')
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.keptNewer).toBe(4)
  })

  test('a Windows project restores the same way', async () => {
    const root = 'C:\\Users\\dev\\acme-shop'
    const w = world()
    w.fs.file('C:/Users/dev/acme-shop/build/a.js', 'a')
    w.fs.dir('C:/Users/dev/.claude/kit-safety/snapshots')
    const env: VaultEnv = { ...w.env, snapshotsRoot: 'C:\\Users\\dev\\.claude\\kit-safety\\snapshots' }
    const out0 = await createSnapshot(env, req(['build'], { root }), CFG)
    expect(out0.ok).toBe(true)
    w.fs.remove('C:/Users/dev/acme-shop/build')
    const m = (await findSnapshot(env, root, '1'))!
    const out = await restoreSnapshot(env, root, m)
    expect(out).toMatchObject({ ok: true, restored: 1 })
    expect(w.fs.read('C:/Users/dev/acme-shop/build/a.js')).toBe('a')
  })
})

describe('restoreSnapshot: node backend only', () => {
  test('the helper restores: it gets the real root and the snapshot folder, its answer becomes the outcome', async () => {
    const { w, id } = await snapshotted('ok', { 'a.txt': 'v1', 'd/b.txt': 'v1b', 'e/empty/.keep': 'x' }, ['a.txt', 'd'])
    w.fs.remove(`${ROOT}/a.txt`)
    w.fs.remove(`${ROOT}/d`)
    w.node.requests.length = 0
    w.node.restoreFailed = [{ rel: 'd/b.txt', reason: 'blocked' }]
    w.node.keptNewer = 3
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    const restoreReq = w.node.requests.find(r => r.cmd === 'restore')
    expect(restoreReq).toEqual({ cmd: 'restore', root: ROOT, snapDir: snapDirOf(id) })
    expect(out.ok).toBe(false)
    expect(out.restored).toBe(1)
    expect(out.failed).toEqual([{ rel: 'd/b.txt', reason: 'blocked' }])
    expect(out.keptNewer).toBe(3)
    expect(out.sample).toEqual(['a.txt'])
    expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
  })

  test('the undo point is made by the helper too, before the restore', async () => {
    const { w, id } = await snapshotted('ok', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.file(`${ROOT}/a.txt`, 'v2')
    w.node.requests.length = 0
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out.hasUndo).toBe(true)
    expect(w.node.requests.map(r => r.cmd)).toEqual(['scan', 'copy', 'restore'])
    expect((w.node.requests[1]?.manifest as { kind: string; restoredFrom: string }).kind).toBe('before-restore')
    expect((w.node.requests[1]?.manifest as { restoredFrom: string }).restoredFrom).toBe(id)
    expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
  })

  test('a helper that cannot restore: the fs backend does it', async () => {
    const { w, id } = await snapshotted('ok', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.remove(`${ROOT}/a.txt`)
    w.node.mode = 'crash'
    const out = await restoreSnapshot(w.env, ROOT, await find(w, id))
    expect(out).toMatchObject({ ok: true, restored: 1 })
    expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
  })

  test('the helper counts the folders it recreated', async () => {
    const w = world({ node: 'ok' })
    w.fs.dir(`${ROOT}/cache/empty`)
    w.fs.file(`${ROOT}/cache/a.txt`, 'a')
    const out0 = await made(w, ['cache'])
    w.fs.remove(`${ROOT}/cache`)
    const out = await restoreSnapshot(w.env, ROOT, await find(w, out0.id))
    expect(out).toMatchObject({ ok: true, restored: 2 })
    expect(out.sample).toEqual(['cache/a.txt', 'cache/empty'])
  })

  test('at most 5 sample paths, and a long failure list is cut at 500', async () => {
    const w = world({ node: 'ok' })
    for (let i = 0; i < 8; i += 1) w.fs.file(`${ROOT}/d/f${i}.txt`, 'x')
    const out0 = await made(w, ['d'])
    w.fs.remove(`${ROOT}/d`)
    w.node.restoreFailed = Array.from({ length: 700 }, (_, i) => ({ rel: `x${i}`, reason: 'blocked' }))
    const out = await restoreSnapshot(w.env, ROOT, await find(w, out0.id))
    expect(out.sample).toHaveLength(5)
    expect(out.failed).toHaveLength(500)
  })
})

describe('undoRestore', () => {
  for (const { name, mode } of BACKENDS) {
    test(`${name}: takes the restore back, removes the undo point it used, and a second undo goes forward again`, async () => {
      const { w, id } = await snapshotted(mode, { 'a.txt': 'v1', 'd/b.txt': 'b1' }, ['a.txt', 'd'])
      w.fs.file(`${ROOT}/a.txt`, 'v2')
      w.fs.file(`${ROOT}/d/b.txt`, 'b2')
      w.fs.file(`${ROOT}/d/newer.txt`, 'newer')
      clock.now += 1000
      expect(await restoreSnapshot(w.env, ROOT, await find(w, id))).toMatchObject({ ok: true, hasUndo: true })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
      const undo1 = (await listSnapshots(w.env, ROOT)).find(m => m.kind === 'before-restore')!
      clock.now += 1000
      const back = await undoRestore(w.env, ROOT)
      expect(back).toMatchObject({ ok: true, id: undo1.id, hasUndo: true })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v2')
      expect(w.fs.read(`${ROOT}/d/b.txt`)).toBe('b2')
      expect(w.fs.read(`${ROOT}/d/newer.txt`)).toBe('newer')
      const after = await listSnapshots(w.env, ROOT)
      expect(after.map(m => m.id)).not.toContain(undo1.id) // used up
      expect(after.filter(m => m.kind === 'before-command').map(m => m.id)).toEqual([id])
      clock.now += 1000
      expect(await undoRestore(w.env, ROOT)).toMatchObject({ ok: true })
      expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v1')
    })
  }

  test('nothing to undo: null', async () => {
    const w = world()
    expect(await undoRestore(w.env, ROOT)).toBeNull()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    await made(w, ['a.txt'])
    expect(await undoRestore(w.env, ROOT)).toBeNull() // a snapshot before a command is not an undo point
    expect(await undoRestore(w.env, 'relative')).toBeNull()
  })

  test('the newest undo point is the one used', async () => {
    const { w, id } = await snapshotted('none', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.file(`${ROOT}/a.txt`, 'v2')
    await restoreSnapshot(w.env, ROOT, await find(w, id)) // undo point holds v2
    w.fs.file(`${ROOT}/a.txt`, 'v3')
    clock.now += 1000
    await restoreSnapshot(w.env, ROOT, await find(w, id)) // undo point holds v3
    clock.now += 1000
    await undoRestore(w.env, ROOT)
    expect(w.fs.read(`${ROOT}/a.txt`)).toBe('v3')
  })

  test('when the undo has a failure the undo point is kept so it can be tried again', async () => {
    const { w, id } = await snapshotted('none', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.file(`${ROOT}/a.txt`, 'v2')
    await restoreSnapshot(w.env, ROOT, await find(w, id))
    const undo = (await listSnapshots(w.env, ROOT)).find(m => m.kind === 'before-restore')!
    w.fs.failWrite = p => p === `${ROOT}/a.txt`
    const out = await undoRestore(w.env, ROOT)
    expect(out?.ok).toBe(false)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toContain(undo.id)
  })

  test('with the helper the used undo point is deleted by the helper', async () => {
    const { w, id } = await snapshotted('ok', { 'a.txt': 'v1' }, ['a.txt'])
    w.fs.file(`${ROOT}/a.txt`, 'v2')
    await restoreSnapshot(w.env, ROOT, await find(w, id))
    const undo = (await listSnapshots(w.env, ROOT)).find(m => m.kind === 'before-restore')!
    clock.now += 1000
    await undoRestore(w.env, ROOT)
    expect(w.fs.has(snapDirOf(undo.id))).toBe(false)
    expect(w.node.requests.some(r => r.cmd === 'remove' && r.id === undo.id)).toBe(true)
  })

  test('a throwing IO: a failed outcome, not a throw', async () => {
    const w = world()
    const boom = (): never => {
      throw new Error('x')
    }
    const out = await undoRestore({ ...w.env, io: { ...w.io, list: boom, stat: boom } }, ROOT)
    expect(out === null || out.ok === false).toBe(true)
  })
})

describe('what is stored never holds a secret', () => {
  test('across both backends, every file the plugin or the helper writes outside the project is free of the secret in the command (the command text is not stored at all)', async () => {
    const secret = ['sk', 'ant', 'api03', 'z'.repeat(48)].join('-')
    const dbPassword = ['correct', 'horse9battery'].join('')
    for (const mode of ['none', 'ok'] as NodeMode[]) {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.fs.file(`${ROOT}/a.txt`, 'content')
      const command = `ANTHROPIC_API_KEY=${secret} node run.js --db "mysql://root:${dbPassword}@10.0.0.5/app" && rm -rf a.txt`
      await made(w, ['a.txt'], { command, risks: [risk('delete', 'rm -rf', { paths: ['a.txt'] }), risk('reset-hard', 'git reset --hard')] })
      const everything: string[] = [JSON.stringify(w.node.requests), JSON.stringify(w.git.calls), JSON.stringify([...w.git.refs])]
      for (const [path, node] of w.fs.nodes) if (path.startsWith(SNAPS) && node.kind === 'file') everything.push(text(node.bytes), path)
      const joined = everything.join('\n')
      expect(joined.includes(secret), mode).toBe(false)
      expect(joined.includes(dbPassword), mode).toBe(false)
      expect(joined).not.toContain('ANTHROPIC_API_KEY')
      expect(joined).not.toContain('"command"')
    }
  })
})

describe('ioFromEngine', () => {
  test('hooksDir: kept when it is a non-empty text, otherwise there is none (gitRun then uses the null device)', () => {
    expect(engine({}, { hooksDir: '/home/dev/.claude/kit-safety/no-hooks' }).io.hooksDir).toBe('/home/dev/.claude/kit-safety/no-hooks')
    for (const opts of [undefined, {}, { hooksDir: '' }, { hooksDir: 5 as unknown as string }, { hooksDir: null as unknown as string }]) {
      expect('hooksDir' in engine({}, opts).io, JSON.stringify(opts)).toBe(false)
    }
  })

  test('a git call through the engine IO carries both -c pairs, the hooks folder is made once, and it holds only a note', async () => {
    const dir = '/home/dev/.claude/kit-safety/no-hooks'
    const { io, calls } = engine({}, { hooksDir: dir })
    await gitRun(io, '/work/acme-shop', ['rev-parse', 'HEAD'])
    await gitRun(io, '/work/acme-shop', ['rev-parse', 'HEAD'])
    const git = calls.runs.filter(r => (r[0] as string[])[0] === 'git').map(r => r[0] as string[])
    expect(git).toHaveLength(2)
    for (const argv of git) expect(argv.slice(0, 6)).toEqual(['git', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${dir}`, '-C'])
    // The engine's stat answers "a file" for any path, so the note counts as there already: nothing was written.
    expect(calls.writes).toEqual([])
  })

  test('reads and writes text, reads bytes (whole or a range) as base64', async () => {
    const { io, calls } = engine()
    expect(await io.readText('/a')).toBe('text')
    expect(await io.readBase64('/a')).toBe('Zm9v')
    expect(await io.readBase64('/a', { offset: 4, length: 8 })).toBe('Zm9v')
    await io.writeText('/b', 'hello')
    expect(calls.reads[1]).toEqual(['/a', { as: 'bytes' }])
    expect(calls.reads[2]).toEqual(['/a', { as: 'bytes', offset: 4, length: 8 }])
    expect(calls.writes).toEqual([['/b', 'hello']])
  })

  test('list keeps the five fields; a missing folder is []', async () => {
    expect(await engine().io.list('/x')).toEqual([{ name: 'a', kind: 'file', size: 3, mtimeMs: 5, isLink: false }])
    expect(await engine({ fs: { list: () => Promise.reject(new Error('ENOENT')) } }).io.list('/x')).toEqual([])
  })

  test('stat is null when missing, and carries realPath only when asked for', async () => {
    const { io } = engine()
    expect(await io.stat('/x')).toEqual({ kind: 'file', size: 3, mtimeMs: 5, isLink: false })
    expect(await io.stat('/x', true)).toEqual({ kind: 'file', size: 3, mtimeMs: 5, isLink: false, realPath: '/real' })
    expect(await engine({ fs: { stat: () => Promise.reject(new Error('ENOENT')) } }).io.stat('/x')).toBeNull()
  })

  test('run: the command, folder, input and time limit are passed; a command that cannot start is exit code -1, never a rejection', async () => {
    const { io, calls } = engine()
    expect(await io.run(['git', 'status'], { cwd: '/p', stdin: 'in', timeoutMs: 5000 })).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' })
    expect(calls.runs[0]).toEqual([['git', 'status'], { cwd: '/p', stdin: 'in', timeoutMs: 5000 }])
    await io.run(['x'])
    expect(calls.runs[1]).toEqual([['x'], { timeoutMs: 30_000 }])
    const broken = engine({ process: { run: () => Promise.reject(new Error('spawn ENOENT')) } }).io
    expect(await broken.run(['nope'])).toEqual({ exitCode: -1, stdout: '', stderr: 'spawn ENOENT' })
    expect((await engine({ process: { run: () => Promise.reject('plain') } }).io.run(['nope'])).exitCode).toBe(-1)
  })

  test('the clock is the engine clock (a promise)', async () => {
    expect(await engine().io.now()).toBe(42)
  })

  test('a missing file still rejects, and a file too big even for ranges rejects', async () => {
    const missing = engine({ fs: { read: () => Promise.reject(new Error('ENOENT')), stat: () => Promise.reject(new Error('ENOENT')) } }).io
    await expect(missing.readText('/nope')).rejects.toThrow()
    const huge = engine({ fs: { read: () => Promise.reject(new Error('too large')), stat: async () => ({ kind: 'file', size: 100 * MB, mtimeMs: 1, isLink: false }) } }).io
    await expect(huge.readText('/huge')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fix pass C: one snapshot per call, no command in the manifest, quiet snapshots, git only where it matters, pinned tips,
// create-only refs, hostile config, retention for everything.

/** A world whose helper run is cut like the engine cuts a command's output (here at `cap` characters, in the engine at 4 MiB). */
function cappedWorld(cap: number): World {
  const w = world({ node: 'ok' })
  const io = w.fs.io((argv, init) => {
    const r = argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))
    return { ...r, stdout: r.stdout.length > cap ? r.stdout.slice(0, cap) : r.stdout }
  })
  return { ...w, io, env: { ...w.env, io } }
}

const snapshotFolders = (w: World): string[] => w.fs.childrenOf(`${SNAPS}/${KEY}`).map(([k]) => k.slice(k.lastIndexOf('/') + 1)).sort()

describe('createSnapshot: one snapshot per call, whatever the helper answers', () => {
  test('a big tree: the helper answers with a summary and the manifest is read from disk (an answer over the output limit never happens)', async () => {
    const w = cappedWorld(2048)
    for (let i = 0; i < 120; i += 1) w.fs.file(`${ROOT}/src/module-${String(i).padStart(4, '0')}/component-with-a-longer-name.ts`, `export const n = ${i}\n`)
    const out = await made(w, ['src'])
    expect(out).toMatchObject({ backend: 'node', n: 1, files: 120, id: ID0 })
    expect(snapshotFolders(w)).toEqual([ID0])
    expect(w.node.requests.filter(r => r.cmd === 'copy')).toHaveLength(1)
    expect(w.fs.read(`${snapDirOf(ID0)}/manifest.json`)!.length).toBeGreaterThan(2048) // the manifest is bigger than what can be answered
    expect((await listSnapshots(w.env, ROOT)).map(m => [m.id, m.n, m.backend])).toEqual([[ID0, 1, 'node']])
    expect(w.fs.writes).toEqual([]) // no text-only copy was made as well
  })

  test('the helper answer is a summary: no manifest and no file list in it', async () => {
    const w = world({ node: 'ok' })
    for (let i = 0; i < 50; i += 1) w.fs.file(`${ROOT}/d/f${i}.txt`, 'x')
    let answer = ''
    const io = w.fs.io((argv, init) => {
      const r = argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))
      if (argv[0] === 'node' && argv[1] === HELPER && String(init?.stdin).includes('"copy"')) answer = r.stdout
      return r
    })
    await made({ ...w, io, env: { ...w.env, io } }, ['d'])
    const parsed = JSON.parse(answer) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['bytes', 'dirs', 'files', 'missing', 'missingCount', 'ok', 'skippedCount', 'tooBig'])
    expect(answer.length).toBeLessThan(300)
  })

  const lost: [NodeMode, string][] = [
    ['cut-answer', 'an answer that was cut in the middle'],
    ['lost-answer', 'a helper that dies after the copy was complete (the answer is lost)'],
  ]
  for (const [mode, what] of lost) {
    test(`${what}: the snapshot on disk is used; no second snapshot, no text-only copy, the number is #1`, async () => {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.fs.file(`${ROOT}/a.txt`, 'a')
      w.fs.file(`${ROOT}/build/b.txt`, 'b')
      const out = await made(w, ['a.txt', 'build'], { risks: [risk('reset-hard', 'git reset --hard')] })
      expect(out).toMatchObject({ id: ID0, n: 1, backend: 'node', files: 2, hasGit: true })
      expect(snapshotFolders(w)).toEqual([ID0])
      expect(w.node.requests.filter(r => r.cmd === 'copy')).toHaveLength(1)
      expect(w.node.requests.some(r => r.cmd === 'remove')).toBe(false)
      expect(w.fs.writes).toEqual([])
      const list = await listSnapshots(w.env, ROOT)
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id: ID0, n: 1, backend: 'node' })
      // The refs belong to this snapshot (made after the copy was found complete).
      expect(w.git.refs.get(`refs/kit-safety/${ID0}`)).toBe(SHA2)
      // `/safety restore 1` restores the node copy.
      w.fs.remove(`${ROOT}/build`)
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      expect(back.ok).toBe(true)
      expect(w.fs.read(`${ROOT}/build/b.txt`)).toBe('b')
    })
  }

  test('a helper that dies half way: the half folder is removed, then the text-only backend makes ONE snapshot', async () => {
    const w = world({ node: 'die-midway' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    expect(out).toMatchObject({ n: 1, backend: 'fs', files: 1 })
    expect(w.node.requests.filter(r => r.cmd === 'remove')).toEqual([{ cmd: 'remove', snapshotsRoot: SNAPS, projectKey: KEY, id: ID0 }])
    expect(w.fs.has(snapDirOf(ID0))).toBe(false) // the half folder is gone
    expect(snapshotFolders(w)).toEqual([out.id])
    expect(out.id).not.toBe(ID0)
    expect((await listSnapshots(w.env, ROOT)).map(m => [m.id, m.n])).toEqual([[out.id, 1]])
  })

  test('a helper that dies before it starts (nothing on disk): nothing to remove, the text-only backend makes one snapshot', async () => {
    const w = world({ node: 'crash' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    expect(out).toMatchObject({ n: 1, backend: 'fs' })
    expect(snapshotFolders(w)).toEqual([out.id])
    expect(w.node.requests).toEqual([])
  })

  test('a copy the helper refuses: no folder is left, the text-only backend makes one snapshot', async () => {
    const w = world({ node: 'refuse' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['a.txt'])
    expect(out).toMatchObject({ n: 1, backend: 'fs' })
    expect(snapshotFolders(w)).toEqual([out.id])
    expect((await listSnapshots(w.env, ROOT)).length).toBe(1)
  })

  test('a lost answer whose folder holds somebody else\'s manifest is not adopted', async () => {
    // The folder of this id appears (another session) after the check and before the copy: its manifest is not ours.
    const w = world({ node: 'lost-answer' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const theirs = { v: 1, id: ID0, n: 9, createdAt: clock.now + 5, root: ROOT, kind: 'before-command', tool: 'Bash', risks: [], targets: [], backend: 'node', files: [], dirs: [], skipped: [], totalBytes: 0 }
    const real = w.node.handle
    w.node.handle = (argv, init) => {
      const r = JSON.parse(init?.stdin ?? '{}') as { cmd?: string }
      if (argv[1] === HELPER && r.cmd === 'copy') {
        w.fs.file(`${snapDirOf(ID0)}/manifest.json`, JSON.stringify(theirs))
        return done(1)
      }
      return real(argv, init)
    }
    const io = w.fs.io((argv, init) => (argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))))
    const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
    expect(out.ok && out.id).not.toBe(ID0)
    expect(out.ok && out.backend).toBe('fs')
  })

  // The helper's answer is lost (or it fails) while another session has just made a snapshot with the same id: its folder holds a
  // valid manifest that is not ours. Cleaning up after our own failed copy must never touch it.
  const THEIRS = (n = 9) => ({ v: 1, id: ID0, n, createdAt: clock.now + 5, root: ROOT, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'delete', label: 'rm -rf' }], targets: [], backend: 'node', files: [], dirs: [], skipped: [], totalBytes: 0 })
  type Race = { w: World; env: VaultEnv; theirs: string; copies: string[] }
  /** A world whose helper, on each of its first `times` copy requests, finds a foreign snapshot in the folder it was asked to fill and then fails with `reply`. */
  function raced(times: number, reply: (id: string) => IORun): Race {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const theirs = `${JSON.stringify(THEIRS(), null, 2)}\n`
    const copies: string[] = []
    const real = w.node.handle
    w.node.handle = (argv, init) => {
      const r = JSON.parse(init?.stdin ?? '{}') as { cmd?: string; destDir?: string }
      if (argv[1] === HELPER && r.cmd === 'copy' && copies.length < times) {
        const dest = normalizePath(String(r.destDir))
        copies.push(dest)
        // the foreign snapshot carries the id of the folder it sits in
        w.fs.file(`${dest}/manifest.json`, theirs.replace(ID0, dest.slice(dest.lastIndexOf('/') + 1)))
        return reply(dest.slice(dest.lastIndexOf('/') + 1))
      }
      return real(argv, init)
    }
    const io = w.fs.io((argv, init) => (argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))))
    return { w, env: { ...w.env, io }, theirs, copies }
  }
  const replies: [string, (id: string) => IORun][] = [
    ['the answer is lost (the helper exits 1)', () => done(1)],
    ['the answer is garbage', () => done(0, 'not json\n')],
    ['the helper fails with an error of its own', () => done(0, `${JSON.stringify({ ok: false, error: 'internal error' })}\n`)],
  ]
  for (const [what, reply] of replies) {
    test(`${what} while another session's snapshot sits in the folder: it is left untouched, and this call takes a fresh id and number`, async () => {
      const { w, env, theirs, copies } = raced(1, reply)
      const out = await createSnapshot(env, req(['a.txt']), CFG)
      expect(out).toMatchObject({ ok: true, id: `${ID0}-2`, n: 10, backend: 'node', files: 1 })
      expect(copies).toEqual([snapDirOf(ID0)])
      // theirs: still there, byte for byte, and the helper was never asked to remove anything
      expect(w.fs.read(`${snapDirOf(ID0)}/manifest.json`)).toBe(theirs)
      expect(w.node.requests.some(r => r.cmd === 'remove')).toBe(false)
      expect(snapshotFolders(w)).toEqual([ID0, `${ID0}-2`])
      expect((await listSnapshots(w.env, ROOT)).map(m => [m.id, m.n])).toEqual([[ID0, 9], [`${ID0}-2`, 10]]) // theirs was made a moment later
    })
  }

  test('another session\'s snapshot in the folder twice running: neither is touched, and the text-only backend then makes the snapshot', async () => {
    const { w, env, copies } = raced(2, () => done(1))
    const out = await createSnapshot(env, req(['a.txt']), CFG)
    expect(out).toMatchObject({ ok: true, backend: 'fs', files: 1 })
    expect(out.ok && out.id).toBe(`${ID0}-3`)
    expect(copies).toEqual([snapDirOf(ID0), snapDirOf(`${ID0}-2`)])
    expect(w.node.requests.some(r => r.cmd === 'remove')).toBe(false)
    for (const dest of copies) expect(parseManifest(w.fs.read(`${dest}/manifest.json`) ?? '')?.n).toBe(9)
    expect(snapshotFolders(w)).toEqual([ID0, `${ID0}-2`, `${ID0}-3`])
  })

  test('a folder of ours with no manifest (the helper died half way) is still removed: only a valid manifest protects a folder', async () => {
    const w = world({ node: 'die-midway' })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    // a manifest that does not read back is no snapshot either
    const real = w.node.handle
    w.node.handle = (argv, init) => {
      const r = real(argv, init)
      if (argv[1] === HELPER && String(init?.stdin).includes('"copy"')) w.fs.file(`${snapDirOf(ID0)}/manifest.json`, '{ "v": 1, "id": ')
      return r
    }
    const io = w.fs.io((argv, init) => (argv[0] === 'git' ? w.git.handle(argv) : (w.node.handle(argv, init) ?? done(-1))))
    const out = await createSnapshot({ ...w.env, io }, req(['a.txt']), CFG)
    expect(out).toMatchObject({ ok: true, backend: 'fs' })
    expect(w.node.requests.filter(r => r.cmd === 'remove')).toEqual([{ cmd: 'remove', snapshotsRoot: SNAPS, projectKey: KEY, id: ID0 }])
    expect(w.fs.has(snapDirOf(ID0))).toBe(false)
  })
})

describe('createSnapshot: quiet snapshots', () => {
  const quietRisk = (): Risk => ({ kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: [] })
  for (const { name, mode } of BACKENDS) {
    test(`${name}: a call whose every risk is snapshot-tier is marked quiet; any other mix is not`, async () => {
      const w = world({ node: mode })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const a = await made(w, ['a.txt'], { tool: 'Write', command: undefined, risks: [quietRisk()] }, { ...CFG, keepCount: 100 })
      expect(manifestOf(w, a.id).quiet).toBe(true)
      clock.now += 1000
      const b = await made(w, ['a.txt'], { risks: [quietRisk(), risk('delete', 'rm -rf')] }, { ...CFG, keepCount: 100 })
      expect('quiet' in manifestOf(w, b.id)).toBe(false)
      clock.now += 1000
      const c = await made(w, ['a.txt'], { risks: [risk('delete', 'rm -rf')] }, { ...CFG, keepCount: 100 })
      expect('quiet' in manifestOf(w, c.id)).toBe(false)
      clock.now += 1000
      const d = await made(w, ['a.txt'], { risks: [] }, { ...CFG, keepCount: 100 })
      expect('quiet' in manifestOf(w, d.id)).toBe(false)
      clock.now += 1000
      const e = await made(w, ['a.txt'], { kind: 'before-restore', restoredFrom: a.id, risks: [quietRisk()] }, { ...CFG, keepCount: 100 })
      expect('quiet' in manifestOf(w, e.id)).toBe(false)
    })
  }

  // Changed from "20 quiet ones are kept next to the build snapshot" (separate caps): one count now, quiet ones go first.
  test('22 quiet edits after an `rm -rf build`: the build snapshot is still there, one count of 20 for all, the quiet ones went first', async () => {
    const w = world()
    w.fs.file(`${ROOT}/build/a.js`, 'a')
    w.fs.file(`${ROOT}/notes.txt`, 'n')
    const cfg = { ...CFG, keepCount: 20 }
    const build = await made(w, ['build'], {}, cfg)
    for (let i = 0; i < 22; i += 1) {
      clock.now += 1000
      await made(w, ['notes.txt'], { tool: 'Edit', risks: [quietRisk()] }, cfg)
    }
    const list = await listSnapshots(w.env, ROOT)
    expect(list.some(m => m.id === build.id)).toBe(true)
    expect(list.filter(m => m.quiet === true)).toHaveLength(19)
    expect(list).toHaveLength(20)
    expect(list.at(-1)?.id).toBe(build.id)
  })

  // Changed from "a quiet edit never costs an asked-about snapshot its place" (separate caps): with no older quiet snapshot to
  // evict, the new quiet one (protected, it was just made) takes a place of the one count and the oldest asked one goes.
  test('one count for both kinds: when there is no older quiet snapshot, the oldest asked-about one goes; when there is, it goes first', async () => {
    const w = world()
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const cfg = { ...CFG, keepCount: 3 }
    const asked: string[] = []
    for (let i = 0; i < 4; i += 1) {
      clock.now += 1000
      asked.push((await made(w, ['a.txt'], {}, cfg)).id)
    }
    clock.now += 1000
    const q1 = await made(w, ['a.txt'], { risks: [quietRisk()] }, cfg)
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([q1.id, asked[3], asked[2]])
    clock.now += 1000
    const q2 = await made(w, ['a.txt'], { risks: [quietRisk()] }, cfg)
    // q1 (quiet, older) goes, both asked-about ones stay.
    expect((await listSnapshots(w.env, ROOT)).map(m => m.id)).toEqual([q2.id, asked[3], asked[2]])
  })
})

describe('createSnapshot: git state only where it matters', () => {
  const NO_GIT_RISKS: [string, Risk][] = [
    ['a quiet edit', { kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: [] }],
    ['delete', risk('delete', 'rm -rf')],
    ['overwrite', risk('overwrite', 'cp .env.example')],
    ['clean', risk('clean', 'git clean -fd')],
    ['db-drop', risk('db-drop', 'dropdb')],
    ['unparsed', risk('unparsed', 'bash')],
  ]
  for (const [what, r] of NO_GIT_RISKS) {
    for (const { name, mode } of BACKENDS) {
      test(`${name}: ${what}: no git command is run, no ref is made, no git state is recorded`, async () => {
        const w = world({ node: mode, git: true })
        w.git.stash = SHA2
        w.fs.file(`${ROOT}/a.txt`, 'a')
        const out = await made(w, ['a.txt'], { risks: [r] })
        expect(w.git.calls).toEqual([])
        expect(w.git.refs.size).toBe(0)
        expect(manifestOf(w, out.id).git).toBeUndefined()
        expect(out.hasGit).toBe(false)
        // `/safety restore` after a plain delete never prints a git command.
        const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
        expect(back.git).toEqual([])
      })
    }
  }

  for (const kind of ['reset-hard', 'discard', 'force-push', 'branch-delete'] as const) {
    test(`${kind}: git state is captured`, async () => {
      const w = world({ git: true })
      w.fs.file(`${ROOT}/a.txt`, 'a')
      w.git.branches = { old: SHA3 }
      w.git.remotes = { 'origin/old': SHA3 } // a force push keeps nothing without a remote tip
      await made(w, ['a.txt'], { risks: [risk(kind, kind, { name: 'old', remote: 'origin' })] })
      expect(w.git.calls.length).toBeGreaterThan(0)
      expect(manifestOf(w, ID0).git).toBeDefined()
    })
  }

  test('restore prints exactly what fits: a reset offers the stash and the head, a discard only the stash, a branch delete the branch, a force push the remote branch only', async () => {
    const run = async (r: Risk, setup: (w: World) => void = () => undefined) => {
      const w = world({ git: true })
      w.git.stash = SHA2
      setup(w)
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [r] })
      return (await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, String(out.n)))!)).git.map(g => g.command)
    }
    expect(await run(risk('reset-hard'))).toEqual([`git stash apply refs/kit-safety/${ID0}`, `git checkout ${SHA1}`])
    expect(await run(risk('discard'))).toEqual([`git stash apply refs/kit-safety/${ID0}`])
    // a force push throws nothing local away: with no remote tip there is nothing to offer, with one only that
    expect(await run(risk('force-push'))).toEqual([])
    expect(await run(risk('force-push', 'git push --force', { remote: 'origin', name: 'main' }), w => (w.git.remotes = { 'origin/main': SHA3 }))).toEqual([`git branch main-before-force-push ${SHA3}`])
    expect(await run(risk('branch-delete', 'git branch -D', { name: 'old' }), w => (w.git.branches = { old: SHA3 }))).toEqual([`git branch old ${SHA3}`])
  })

  test('a stash that fails (an unfinished merge, a time-out) is a partial git snapshot, said so; a clean tree is not partial', async () => {
    for (const { mode } of BACKENDS) {
      const w = world({ node: mode, git: true })
      w.git.failStash = true
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      expect(out).toMatchObject({ files: 1, isGitPartial: true })
      expect(manifestOf(w, out.id).git).toEqual({ head: SHA1, branch: 'main', isPartial: true })
      expect(w.git.refs.get(`refs/kit-safety/${out.id}`)).toBe(SHA1) // the head is still kept alive
      const clean = world({ node: mode, git: true })
      clean.git.stash = null // `stash create` exits 0 and prints nothing: nothing to save
      clean.fs.file(`${ROOT}/a.txt`, 'a')
      const ok = await made(clean, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      expect('isGitPartial' in ok).toBe(false)
      expect(manifestOf(clean, ok.id).git?.isPartial).toBeUndefined()
    }
  })

  test('restoring a partial Git snapshot says so (gitPartial) and offers no stash and no head; a complete one carries no such flag', async () => {
    for (const { mode } of BACKENDS) {
      const w = world({ node: mode, git: true })
      w.git.failStash = true
      w.git.branches = { old: SHA3 }
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, String(out.n)))!)
      expect(back.gitPartial, mode).toBe(true)
      expect(back.git, mode).toEqual([])
      expect(back.ok).toBe(true)
      // the same call that also deleted a branch: the tip is still offered, the partial flag stays
      const both = world({ node: mode, git: true })
      both.git.failStash = true
      both.git.branches = { old: SHA3 }
      both.fs.file(`${ROOT}/a.txt`, 'a')
      const o2 = await made(both, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard'), risk('branch-delete', 'git branch -D', { name: 'old' })] })
      const b2 = await restoreSnapshot(both.env, ROOT, (await findSnapshot(both.env, ROOT, String(o2.n)))!)
      expect(b2.gitPartial).toBe(true)
      expect(b2.git.map(g => g.command)).toEqual([`git branch old ${SHA3}`])
      // complete: no flag at all
      const ok = world({ node: mode, git: true })
      ok.git.stash = SHA2
      ok.fs.file(`${ROOT}/a.txt`, 'a')
      const o3 = await made(ok, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      const b3 = await restoreSnapshot(ok.env, ROOT, (await findSnapshot(ok.env, ROOT, String(o3.n)))!)
      expect('gitPartial' in b3).toBe(false)
      expect(b3.git.map(g => g.label)).toEqual(['stash', 'head'])
      // a refusal never carries it
      expect('gitPartial' in (await restoreSnapshot(ok.env, '/work/other', (await findSnapshot(ok.env, ROOT, '1'))!))).toBe(false)
    }
  })

  test('a failing stash is not "partial" for a call that has no use for a stash (a force push, a branch delete); and none is asked for', async () => {
    const w = world({ git: true })
    w.git.failStash = true
    w.git.branches = { old: SHA3 }
    const out = await made(w, [], { risks: [risk('branch-delete', 'git branch -D', { name: 'old' }), risk('force-push', 'git push --force')] })
    expect('isGitPartial' in out).toBe(false)
    expect(w.git.calls.some(c => c[0] === 'stash')).toBe(false)
  })

  test('a repository with no commits: no stash is asked, so nothing is partial', async () => {
    const w = world({ git: true })
    w.git.head = null
    const out = await snap(w, [], { risks: [risk('reset-hard')] })
    expect(out.ok === false && out.reason).toBe('nothing')
  })
})

describe('createSnapshot: every branch is kept, names git accepts included', () => {
  const del = (...names: string[]): Risk => risk('branch-delete', 'git branch -D', { name: names[0] ?? '', names })
  for (const { name, mode } of BACKENDS) {
    test(`${name}: git branch -D f1 f2 f3 keeps all three tips alive`, async () => {
      const w = world({ node: mode, git: true })
      w.git.branches = { f1: SHA1, f2: SHA2, f3: SHA3 }
      const out = await made(w, [], { risks: [del('f1', 'f2', 'f3')] })
      expect(manifestOf(w, out.id).git?.branches).toEqual([{ name: 'f1', sha: SHA1 }, { name: 'f2', sha: SHA2 }, { name: 'f3', sha: SHA3 }])
      expect([...w.git.refs.entries()].sort()).toEqual([[`refs/kit-safety/${out.id}.b/1`, SHA1], [`refs/kit-safety/${out.id}.b/2`, SHA2], [`refs/kit-safety/${out.id}.b/3`, SHA3]].sort())
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      expect(back.git.map(g => g.command)).toEqual([`git branch f1 ${SHA1}`, `git branch f2 ${SHA2}`, `git branch f3 ${SHA3}`])
    })
  }

  test('a name with + or letters of another script is pinned; only its printed hint is left out', async () => {
    const w = world({ git: true })
    w.git.branches = { 'feat+x': SHA2, 'fix/lỗi-đăng-nhập': SHA3, plain: SHA1 }
    const out = await made(w, [], { risks: [del('feat+x', 'fix/lỗi-đăng-nhập', 'plain')] })
    const m = manifestOf(w, out.id)
    expect(m.git?.branches?.map(b => b.name)).toEqual(['feat+x', 'fix/lỗi-đăng-nhập', 'plain'])
    expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/1`)).toBe(SHA2)
    expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/2`)).toBe(SHA3)
    expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/3`)).toBe(SHA1)
    const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
    // the two names that cannot be printed are not; one line lists every saved tip, so they can still be found
    expect(back.git.map(g => g.command)).toEqual([`git branch plain ${SHA1}`, `git for-each-ref refs/kit-safety/${out.id}.b`])
  })

  test('only names that cannot be printed: nothing is lost for want of a hint, the snapshot is made and the list line is the way back', async () => {
    for (const { mode } of BACKENDS) {
      const w = world({ node: mode, git: true })
      w.git.branches = { 'feat+x': SHA2 }
      const out = await made(w, [], { risks: [del('feat+x')] })
      expect(out).toMatchObject({ files: 0, hasGit: true })
      expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/1`)).toBe(SHA2)
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      expect(back.git).toEqual([{ label: 'branch', command: `git for-each-ref refs/kit-safety/${out.id}.b` }])
    }
  })

  test('without names the risk\'s own name is used; at most 20 are kept; duplicates count once; a missing branch is skipped', async () => {
    const w = world({ git: true })
    const many = Array.from({ length: 25 }, (_, i) => `b${i}`)
    w.git.branches = Object.fromEntries(many.map((n, i) => [n, `${(i % 9) + 1}`.repeat(40)]))
    const out = await made(w, [], { risks: [risk('branch-delete', 'git branch -D', { name: 'b0' }), del(...many, 'b3', 'b3'), del('gone')] })
    const names = manifestOf(w, out.id).git?.branches?.map(b => b.name)
    expect(names).toEqual(many.slice(0, 20))
    expect([...w.git.refs.keys()].length).toBe(20)
  })
})

describe('createSnapshot: a force push keeps the remote branch it overwrites', () => {
  const push = (extra: Partial<Risk> = {}): Risk => risk('force-push', 'git push --force', { remote: 'origin', name: 'main', ...extra })
  for (const { name, mode } of BACKENDS) {
    test(`${name}: the old tip of the remote branch is recorded, kept alive, and offered as a local branch`, async () => {
      const w = world({ node: mode, git: true })
      w.git.remotes = { 'origin/main': SHA3 }
      const out = await made(w, [], { command: 'git push --force origin main', risks: [push()] })
      expect(manifestOf(w, out.id).git).toEqual({ head: SHA1, branch: 'main', branches: [{ name: 'origin/main', sha: SHA3, remote: true }] })
      expect(w.git.refs.get(`refs/kit-safety/${out.id}.b/1`)).toBe(SHA3)
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      // the head is no hint here: a force push moves nothing local
      expect(back.git.map(g => g.command)).toEqual([`git branch main-before-force-push ${SHA3}`])
      expect(w.git.argvs.some(a => a.includes('refs/remotes/origin/main'))).toBe(true)
    })
  }

  test('several branches (git push --force origin dev main), a remote the repository does not have, and names that are not valid are skipped', async () => {
    const w = world({ git: true })
    w.git.remotes = { 'origin/dev': SHA2, 'origin/main': SHA3 }
    const out = await made(w, [], { risks: [push({ name: 'dev', names: ['dev', 'main', 'gone', 'a b', '../x'] })] })
    expect(manifestOf(w, out.id).git?.branches).toEqual([{ name: 'origin/dev', sha: SHA2, remote: true }, { name: 'origin/main', sha: SHA3, remote: true }])
    // no tip: nothing to keep, so nothing is made
    const none = world({ git: true })
    expect(await snap(none, [], { risks: [push()] })).toEqual({ ok: false, reason: 'nothing', skipped: 0 })
    const odd = world({ git: true })
    expect(await snap(odd, [], { risks: [push({ remote: 'o r i g i n' }), push({ remote: '-x' }), push({ remote: 'a/b' }), risk('force-push', 'git push --force', { name: 'main' })] })).toMatchObject({ ok: false, reason: 'nothing' })
    expect(odd.git.argvs.some(a => a.some(x => x.startsWith('refs/remotes/')))).toBe(false)
  })

  test('a deleted branch and a force push in one command are told apart', async () => {
    const w = world({ git: true })
    w.git.branches = { old: SHA2 }
    w.git.remotes = { 'origin/old': SHA3 }
    const out = await made(w, [], { risks: [risk('branch-delete', 'git branch -D', { name: 'old' }), push({ name: 'old' })] })
    const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, String(out.n)))!)
    expect(back.git.filter(g => g.label === 'branch').map(g => g.command)).toEqual([`git branch old ${SHA2}`, `git branch old-before-force-push ${SHA3}`])
  })
})

describe('createSnapshot: refs are made after the copy, create-only, and never deleted unless this call made them', () => {
  for (const { name, mode } of BACKENDS) {
    test(`${name}: a ref that already exists is neither moved nor deleted; the manifest does not promise it`, async () => {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.git.refs.set(`refs/kit-safety/${ID0}`, SHA3) // somebody else's, a stale one
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const out = await made(w, ['a.txt'], { risks: [risk('reset-hard', 'git reset --hard')] })
      expect(out.id).toBe(ID0)
      expect(w.git.refs.get(`refs/kit-safety/${ID0}`)).toBe(SHA3)
      expect(w.git.deleted).toEqual([])
      const m = manifestOf(w, ID0)
      expect(m.git).toEqual({ head: SHA1, branch: 'main', stashSha: SHA2 }) // no `ref`
      const back = await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
      expect(back.git[0]?.command).toBe(`git stash apply ${SHA2}`) // by its commit
    })

    test(`${name}: every ref is made with update-ref <ref> <sha> "" (create-only)`, async () => {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.git.branches = { x: SHA3 }
      await made(w, [], { risks: [risk('reset-hard'), risk('branch-delete', 'git branch -D', { name: 'x' })] })
      const updates = w.git.calls.filter(c => c[0] === 'update-ref')
      expect(updates.length).toBe(2)
      for (const u of updates) expect(u).toEqual(['update-ref', u[1], u[2], '']) // ref, sha, then the empty "old value": must not exist yet
    })
  }

  test('node: the refs are made after the copy answered, never before (a failed copy leaves none, and deletes none)', async () => {
    const w = world({ node: 'collide-always', git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const order: string[] = []
    const base = w.io.run
    const io: IO = { ...w.io, run: async (argv, init) => {
      if (argv[0] === 'git' && argv.includes('update-ref')) order.push('ref')
      if (argv[0] === 'node' && String(init?.stdin).includes('"copy"')) order.push('copy')
      return base(argv, init)
    } }
    const out = await createSnapshot({ ...w.env, io }, req(['a.txt'], { risks: [risk('reset-hard')] }), CFG)
    expect(out.ok).toBe(true)
    // Two refused copies, then the text-only backend: its single ref comes last.
    expect(order.filter(x => x === 'copy')).toHaveLength(2)
    expect(order.lastIndexOf('copy')).toBeLessThan(order.indexOf('ref'))
    expect(w.git.deleted).toEqual([])
  })

  test('an id taken by another session (the folder is there): a fresh id and a fresh number, the other snapshot untouched', async () => {
    for (const { mode } of BACKENDS) {
      const w = world({ node: mode, git: true })
      w.git.stash = SHA2
      w.fs.file(`${ROOT}/a.txt`, 'a')
      const theirs = { v: 1, id: ID0, n: 5, createdAt: clock.now, root: ROOT, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'reset-hard', label: 'x' }], targets: [], backend: 'node', files: [], dirs: [], skipped: [], totalBytes: 0, git: { head: SHA1, branch: 'main', ref: `refs/kit-safety/${ID0}`, stashSha: SHA3 } }
      w.fs.file(`${snapDirOf(ID0)}/manifest.json`, JSON.stringify(theirs))
      w.git.refs.set(`refs/kit-safety/${ID0}`, SHA3)
      // The first listing does not show the folder (it appeared after), the second one does.
      let listed = 0
      const io: IO = { ...w.io, list: async p => (p === `${SNAPS}/${KEY}` && (listed += 1) === 1 ? [] : w.io.list(p)) }
      const out = await createSnapshot({ ...w.env, io }, req(['a.txt'], { risks: [risk('reset-hard')] }), CFG)
      expect(out.ok && out.id, mode).toBe(`${ID0}-2`)
      expect(out.ok && out.n, mode).toBe(6) // freshly computed from what is there now
      expect(w.git.refs.get(`refs/kit-safety/${ID0}`), mode).toBe(SHA3) // theirs, untouched
      expect(w.git.refs.get(`refs/kit-safety/${ID0}-2`), mode).toBe(SHA2)
      expect(w.git.deleted, mode).toEqual([])
    }
  })
})

describe('hostile repository config and a hostile folder', () => {
  test('every git call switches core.fsmonitor off, before -C', async () => {
    const w = world({ node: 'ok', git: true })
    w.git.stash = SHA2
    w.git.branches = { x: SHA3 }
    w.git.remotes = { 'origin/main': SHA3 }
    w.fs.file(`${ROOT}/a.txt`, 'a')
    await made(w, ['a.txt'], { risks: [risk('reset-hard'), risk('branch-delete', 'git branch -D', { name: 'x' }), risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })] })
    await gitInfoFor(w.io, ROOT, [risk('reset-hard')], '20261124T093016Z')
    await pruneSnapshots(w.env, ROOT, { ...CFG, keepCount: 1, keepDays: 0 })
    expect(w.git.argvs.length).toBeGreaterThan(8)
    for (const argv of w.git.argvs) {
      const c = argv.indexOf('core.fsmonitor=false')
      expect(c, argv.join(' ')).toBeGreaterThan(0)
      expect(argv[c - 1]).toBe('-c')
      expect(c).toBeLessThan(argv.indexOf('-C'))
    }
    // The identity for `stash create` is still there.
    expect(w.git.argvs.some(a => a.includes('user.name=Safety Net'))).toBe(true)
  })

  test('the helper and node run in the snapshots folder, never in the project', async () => {
    const w = world({ node: 'ok', envNode: undefined })
    w.fs.file(`${ROOT}/a.txt`, 'a')
    await made(w, ['a.txt'])
    expect(w.node.versionCwds).toEqual([SNAPS])
    expect(w.node.cwds.length).toBeGreaterThan(1)
    expect(w.node.cwds.every(c => c === SNAPS)).toBe(true)
    await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!)
    expect(w.node.cwds.every(c => c === SNAPS)).toBe(true)
  })

  test('without a snapshots folder yet nothing is created for it: cwd is omitted', async () => {
    const w = world({ node: 'ok', envNode: undefined })
    w.fs.remove(SNAPS)
    expect(w.fs.has(SNAPS)).toBe(false)
    expect(await probeNode(w.io, SNAPS)).toBe(true)
    expect(w.node.versionCwds).toEqual([undefined])
    expect(w.fs.has(SNAPS)).toBe(false) // probing created nothing
    expect(w.fs.writes).toEqual([])
    w.fs.dir(SNAPS)
    expect(await probeNode(w.io, SNAPS)).toBe(true)
    expect(w.node.versionCwds).toEqual([undefined, SNAPS])
    expect(await probeNode(w.io)).toBe(true) // no folder given: none used
    expect(w.node.versionCwds[2]).toBeUndefined()
  })

  test('a folder that is a file, or an IO that cannot say, gives no cwd (never an error)', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${SNAPS}-file`, 'x')
    expect(await probeNode(w.io, `${SNAPS}-file`)).toBe(true)
    expect(w.node.versionCwds.at(-1)).toBeUndefined()
    const io: IO = { ...w.io, stat: () => Promise.reject(new Error('boom')) }
    expect(await probeNode(io, SNAPS)).toBe(true)
    expect(w.node.versionCwds.at(-1)).toBeUndefined()
  })
})

describe('pruneAll: the retention sweep for every project', () => {
  const ROOT2 = '/work/other-app'
  const ROOT3 = '/work/third-app'
  const T0 = Date.UTC(2026, 10, 24, 9, 30, 15)
  const CFG14: VaultCfg = { maxBytes: 100 * MB, keepCount: 20, keepDays: 14 }

  /** A snapshot of `root` made `daysAgo` days ago (the clock goes back for it and returns). */
  async function made2(w: World, root: string, daysAgo: number, extra: Partial<SnapshotRequest> = {}): Promise<string> {
    w.fs.dir(root)
    w.fs.file(`${root}/a.txt`, 'a')
    clock.now = T0 - daysAgo * DAY
    const out = await createSnapshot(w.env, req(['a.txt'], { root, ...extra }), { ...CFG, keepCount: 1000, keepDays: 100_000 })
    clock.now = T0
    if (!out.ok) throw new Error(JSON.stringify(out))
    return out.id
  }
  const stillThere = (w: World, id: string): boolean => w.fs.has(snapDirOf(id)) && !w.fs.has(`${snapDirOf(id)}/pruned`)
  const idsOf = async (w: World, root: string): Promise<string[]> => (await listSnapshots(w.env, root)).map(m => m.id)

  for (const { name, mode } of BACKENDS) {
    test(`${name}: every project folder is swept by the same plan, not only the open one; the number pruned is returned`, async () => {
      const w = world({ node: mode })
      const a1 = await made2(w, ROOT, 40)
      const a2 = await made2(w, ROOT, 1)
      const b1 = await made2(w, ROOT2, 30)
      const b2 = await made2(w, ROOT2, 20)
      const b3 = await made2(w, ROOT2, 2)
      expect(await pruneAll(w.env, CFG14)).toBe(3)
      expect(await idsOf(w, ROOT)).toEqual([a2])
      expect(await idsOf(w, ROOT2)).toEqual([b3])
      expect([a1, b1, b2].filter(id => stillThere(w, id))).toEqual([]) // gone (helper) or hidden by the marker (text-only)
      expect(await pruneAll(w.env, CFG14)).toBe(0) // nothing more to do
    })
  }

  test('age beats "the newest": a lone snapshot older than keepDays goes', async () => {
    const w = world()
    const only = await made2(w, ROOT, 30)
    expect(await pruneAll(w.env, CFG14)).toBe(1)
    expect(await idsOf(w, ROOT)).toEqual([])
    expect(w.fs.has(`${snapDirOf(only)}/pruned`)).toBe(true)
  })

  // Changed from "quiet snapshots are counted apart in the sweep too" (one pruned): one count, the quiet ones go first (two pruned).
  test('quiet and asked snapshots share one count in the sweep too, the quiet ones go first', async () => {
    const w = world()
    const quiet: Partial<SnapshotRequest> = { risks: [{ kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: [] }] }
    const keep = await made2(w, ROOT, 3)
    await made2(w, ROOT, 0.3, quiet)
    await made2(w, ROOT, 0.2, quiet)
    const q3 = await made2(w, ROOT, 0.1, quiet)
    expect(await pruneAll(w.env, { ...CFG14, keepCount: 2 })).toBe(2)
    expect((await idsOf(w, ROOT)).sort()).toEqual([keep, q3].sort())
  })

  // Changed from "git refs of other projects": the old sweep deleted another project's refs through the root its manifest names.
  // Now git runs only in the open project and only its own snapshots lose their refs; another project's git-bearing snapshot waits.
  describe('git refs and the sweep scope', () => {
    const RESET = { risks: [risk('reset-hard', 'git reset --hard')] }
    /** Is the snapshot still there (not removed, not hidden by the marker)? The folder is the one of `root`'s project. */
    const held = (w: World, root: string, id: string): boolean => w.fs.has(`${SNAPS}/${projectKey(root)}/${id}`) && !w.fs.has(`${SNAPS}/${projectKey(root)}/${id}/pruned`)
    /** A reset snapshot in ROOT2 (made long ago) and one in ROOT (also long ago): both are old enough for the sweep. */
    async function sweep(open: string | undefined) {
      const w = world({ git: true })
      w.git.stash = SHA2
      const other = await made2(w, ROOT2, 40, RESET)
      // (One scripted repository answers for every root, so the two snapshots must not share an id: refs are named after it.)
      const mine = await made2(w, ROOT, 41, RESET)
      const asked: string[] = []
      const io = w.fs.io((argv, init) => {
        if (argv[0] !== 'git') return w.node.handle(argv, init) ?? done(-1)
        asked.push(argv[argv.indexOf('-C') + 1] ?? '')
        return w.git.handle(argv)
      })
      const before = [...w.git.refs.keys()]
      const pruned = await pruneAll({ ...w.env, io }, CFG14, open)
      return { w, other, mine, asked, before, pruned }
    }

    test('the open project loses its snapshot and its refs; another project snapshot that holds git refs is left alone with them', async () => {
      const r = await sweep(ROOT)
      expect(r.before.length).toBe(2)
      expect(r.pruned).toBe(1)
      expect(held(r.w, ROOT, r.mine)).toBe(false)
      expect(r.w.git.refs.has(`refs/kit-safety/${r.mine}`)).toBe(false)
      expect(held(r.w, ROOT2, r.other)).toBe(true)
      expect(r.w.git.refs.has(`refs/kit-safety/${r.other}`)).toBe(true)
      expect(r.w.git.deleted).toEqual([`refs/kit-safety/${r.mine}`])
    })

    test('git never runs anywhere but in the open project', async () => {
      const r = await sweep(ROOT)
      expect(r.asked.length).toBeGreaterThan(0)
      expect(r.asked.every(root => root === ROOT)).toBe(true)
      expect(r.asked).not.toContain(ROOT2)
    })

    test('no open project (or an unusable root): git does not run at all, and every git-bearing snapshot stays', async () => {
      for (const open of [undefined, '', 'relative', '/']) {
        const r = await sweep(open)
        expect(r.asked, String(open)).toEqual([])
        expect(r.pruned, String(open)).toBe(0)
        expect(held(r.w, ROOT, r.mine) && held(r.w, ROOT2, r.other), String(open)).toBe(true)
        expect(r.w.git.deleted, String(open)).toEqual([])
      }
    })

    test('the same snapshot goes once its project is the open one, refs and all', async () => {
      const r = await sweep(ROOT2)
      expect(r.pruned).toBe(1)
      expect(held(r.w, ROOT2, r.other)).toBe(false)
      expect(r.w.git.deleted).toEqual([`refs/kit-safety/${r.other}`])
      expect(held(r.w, ROOT, r.mine)).toBe(true)
      expect(r.asked.every(root => root === ROOT2)).toBe(true)
    })

    for (const { name, mode } of BACKENDS) {
      test(`${name}: the file-only snapshots of another project are still pruned by the same plan, beside one that holds git refs`, async () => {
        const w = world({ node: mode, git: true })
        w.git.stash = SHA2
        const gitful = await made2(w, ROOT2, 40, RESET)
        const plain1 = await made2(w, ROOT2, 30)
        const plain2 = await made2(w, ROOT2, 3)
        w.git.calls.length = 0 // (what making the snapshots asked git is not the question)
        expect(await pruneAll(w.env, CFG14, ROOT)).toBe(1)
        expect(await idsOf(w, ROOT2)).toEqual([plain2, gitful])
        expect(held(w, ROOT2, plain1)).toBe(false)
        expect(held(w, ROOT2, gitful)).toBe(true)
        expect(w.git.deleted).toEqual([])
        expect(w.git.calls).toEqual([])
      })
    }

    test('a git-bearing snapshot that the plan would delete does not count as pruned, and is not looked for in the manifest root', async () => {
      const w = world({ git: true })
      w.git.stash = SHA2
      const id = await made2(w, ROOT2, 40, RESET)
      // The manifest root is gone and was never a repository here: nothing may be asked about it either way.
      w.fs.remove(ROOT2)
      w.git.calls.length = 0
      expect(await pruneAll(w.env, CFG14, ROOT)).toBe(0)
      expect(held(w, ROOT2, id)).toBe(true)
      expect(w.git.calls).toEqual([])
    })
  })

  describe('a snapshot folder with no valid manifest (a helper killed mid-copy)', () => {
    const half = (w: World, id: string, ageMs: number | undefined): void => {
      w.fs.file(`${snapDirOf(id)}/files/a.txt`, 'half a file')
      w.fs.file(`${snapDirOf(id)}/files/sub/b.txt`, 'more')
      if (ageMs !== undefined) w.fs.dirTimes.set(snapDirOf(id), T0 - ageMs)
    }
    const OLD = '20260101T000000Z'
    const NEW = '20261124T090000Z'
    const UNKNOWN = '20261124T080000Z'

    test('older than a day: removed by the helper; younger or of unknown age: left alone; counted as pruned', async () => {
      const w = world({ node: 'ok' })
      half(w, OLD, 2 * DAY)
      half(w, NEW, 3_600_000)
      half(w, UNKNOWN, undefined)
      expect(await pruneAll(w.env, CFG14)).toBe(1)
      expect(w.fs.has(snapDirOf(OLD))).toBe(false)
      expect(w.fs.has(snapDirOf(NEW))).toBe(true)
      expect(w.fs.has(snapDirOf(UNKNOWN))).toBe(true)
      expect(w.node.requests.filter(r => r.cmd === 'remove')).toEqual([{ cmd: 'remove', snapshotsRoot: SNAPS, projectKey: KEY, id: OLD }])
    })

    test('without Node: its files are emptied and a pruned marker hides it, like the text-only prune', async () => {
      const w = world()
      half(w, OLD, 2 * DAY)
      expect(await pruneAll(w.env, CFG14)).toBe(1)
      expect(w.fs.has(`${snapDirOf(OLD)}/pruned`)).toBe(true)
      expect(w.fs.read(`${snapDirOf(OLD)}/files/a.txt`)).toBe('')
      expect(w.fs.read(`${snapDirOf(OLD)}/files/sub/b.txt`)).toBe('')
      // Marked: it is not counted again.
      expect(await pruneAll(w.env, CFG14)).toBe(0)
    })

    test('a helper that cannot remove: the marker way is used', async () => {
      const w = world({ node: 'ok' })
      half(w, OLD, 2 * DAY)
      w.node.mode = 'crash'
      expect(await pruneAll(w.env, CFG14)).toBe(1)
      expect(w.fs.has(`${snapDirOf(OLD)}/pruned`)).toBe(true)
    })

    test('a valid snapshot is never taken for debris, however old the folder says it is', async () => {
      const w = world()
      const id = await made2(w, ROOT, 1)
      w.fs.dirTimes.set(snapDirOf(id), T0 - 300 * DAY)
      expect(await pruneAll(w.env, CFG14)).toBe(0)
      expect(await idsOf(w, ROOT)).toEqual([id])
    })

    test('a folder whose manifest is damaged is debris too', async () => {
      const w = world()
      half(w, OLD, 5 * DAY)
      w.fs.file(`${snapDirOf(OLD)}/manifest.json`, '{ not json')
      expect(await pruneAll(w.env, CFG14)).toBe(1)
    })
  })

  test('the open project is swept first', async () => {
    const w = world()
    await made2(w, ROOT2, 40)
    await made2(w, ROOT, 40)
    const order: string[] = []
    const spy: IO = { ...w.io, list: async p => { if (p.startsWith(`${SNAPS}/`) && !p.slice(SNAPS.length + 1).includes('/')) order.push(p.slice(SNAPS.length + 1)); return w.io.list(p) } }
    await pruneAll({ ...w.env, io: spy }, CFG14, ROOT)
    expect(order[0]).toBe(KEY)
    expect(order).toContain(projectKey(ROOT2))
  })

  test('no snapshots folder, odd input and an IO that throws: 0, never a throw', async () => {
    const w = world()
    w.fs.remove(SNAPS)
    expect(await pruneAll(w.env, CFG14)).toBe(0)
    expect(await pruneAll({ ...w.env, snapshotsRoot: 'relative' }, CFG14)).toBe(0)
    expect(await pruneAll(undefined as unknown as VaultEnv, CFG14)).toBe(0)
    expect(await pruneAll(w.env, undefined as unknown as VaultCfg)).toBe(0)
    const boom = (): never => {
      throw new Error('x')
    }
    expect(await pruneAll({ ...w.env, io: { ...w.io, list: boom, stat: boom, run: boom, now: boom } }, CFG14, ROOT)).toBe(0)
    // One project that throws does not stop the others.
    const w2 = world()
    await made2(w2, ROOT, 40)
    await made2(w2, ROOT2, 40)
    const spy: IO = { ...w2.io, list: async p => { if (p === `${SNAPS}/${KEY}`) throw new Error('boom'); return w2.io.list(p) } }
    expect(await pruneAll({ ...w2.env, io: spy }, CFG14)).toBe(1)
  })

  test('keepCount and keepDays that are not numbers fall back to the defaults', async () => {
    const w = world()
    const id = await made2(w, ROOT, 1)
    expect(await pruneAll(w.env, { maxBytes: NaN, keepCount: NaN, keepDays: NaN })).toBe(0)
    expect(await idsOf(w, ROOT)).toEqual([id])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Round 2, item 4: git hooks and config

describe('git hooks: every git call runs with core.hooksPath on an empty folder of ours', () => {
  const HOOKS = `${HOME}/.claude/kit-safety/no-hooks`
  const NOTE = `${HOOKS}/README.txt`
  const HOOK_NAMES = ['pre-commit', 'pre-push', 'post-checkout', 'post-merge', 'reference-transaction', 'pre-rebase', 'post-commit', 'prepare-commit-msg', 'commit-msg']
  const withHooks = (w: World, dir: string | undefined = HOOKS): IO => ({ ...w.io, ...(dir === undefined ? {} : { hooksDir: dir }) })

  /** Every kind of git call the vault makes, through one IO: snapshots (with refs), a prune that deletes refs, and a git info. */
  async function everything(w: World, io: IO): Promise<void> {
    w.git.stash = SHA2
    w.git.branches = { x: SHA3 }
    w.git.remotes = { 'origin/main': SHA3 }
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const env = { ...w.env, io }
    const risks = [risk('reset-hard'), risk('branch-delete', 'git branch -D', { name: 'x' }), risk('force-push', 'git push --force', { remote: 'origin', name: 'main' })]
    await createSnapshot(env, req(['a.txt'], { risks }), { ...CFG, keepCount: 100 })
    clock.now += 1000
    await createSnapshot(env, req(['a.txt'], { risks }), { ...CFG, keepCount: 100 })
    await gitInfoFor(io, ROOT, [risk('reset-hard')], '20261124T093016Z')
    await pruneSnapshots(env, ROOT, { ...CFG, keepCount: 1 })
    await pruneAll(env, { ...CFG, keepCount: 1 }, ROOT)
  }

  test('both -c pairs come first and in this order: fsmonitor, hooksPath, then the stash identity, then -C <root>', async () => {
    const w = world({ node: 'ok', git: true })
    await everything(w, withHooks(w))
    expect(w.git.argvs.length).toBeGreaterThan(10)
    expect(w.git.deleted.length).toBeGreaterThan(0) // the prune did run git too
    const head = ['git', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${HOOKS}`]
    const bad: string[] = []
    for (const argv of w.git.argvs) {
      const identity = argv[5] === '-c'
      const expected = identity ? [...head, '-c', 'user.name=Safety Net', '-c', 'user.email=safety-net@localhost', '-C', ROOT] : [...head, '-C', ROOT]
      if (JSON.stringify(argv.slice(0, expected.length)) !== JSON.stringify(expected)) bad.push(argv.join(' '))
      if (argv.filter(a => a.startsWith('core.hooksPath=')).length !== 1) bad.push(`twice: ${argv.join(' ')}`)
    }
    expect(bad).toEqual([])
    expect(w.git.argvs.some(a => a[5] === '-c')).toBe(true) // `stash create` is in the run
  })

  test('the folder is made once per IO, holds only a note named README.txt (never a name git would run), and the note says why', async () => {
    const w = world({ node: 'ok', git: true })
    await everything(w, withHooks(w))
    expect(w.fs.writes.filter(p => p === NOTE)).toEqual([NOTE])
    expect(w.fs.below(HOOKS)).toEqual([NOTE])
    for (const name of HOOK_NAMES) expect(w.fs.has(`${HOOKS}/${name}`), name).toBe(false)
    const note = w.fs.read(NOTE) ?? ''
    expect(note).toMatch(/empty on purpose/)
    expect(note).toMatch(/core\.hooksPath/)
    // Nothing else was written outside the snapshots folder and the note.
    expect(w.fs.writes.every(p => p === NOTE || p.startsWith(`${SNAPS}/`))).toBe(true)
  })

  test('once per IO object, whatever the number of calls and however many run at the same time', async () => {
    const w = world({ git: true })
    const io = withHooks(w)
    await Promise.all([1, 2, 3, 4, 5].map(() => gitRun(io, ROOT, ['rev-parse', 'HEAD'])))
    await gitRun(io, ROOT, ['rev-parse', 'HEAD'])
    expect(w.fs.writes.filter(p => p === NOTE)).toHaveLength(1)
    // Another IO object (a copy) makes its own: it is "once per IO", and cheap.
    await gitRun({ ...io }, ROOT, ['rev-parse', 'HEAD'])
    expect(w.fs.writes.filter(p => p === NOTE)).toHaveLength(1) // the note is there: it is looked at, not written again
    w.fs.remove(HOOKS)
    await gitRun({ ...io }, ROOT, ['rev-parse', 'HEAD'])
    expect(w.fs.writes.filter(p => p === NOTE)).toHaveLength(2)
  })

  test('git runs from the hooks folder, never the project (a project may hold its own git.exe); with no folder, no cwd', async () => {
    const w = world({ node: 'ok', git: true })
    await everything(w, withHooks(w))
    expect(w.git.cwds.length).toBeGreaterThan(10)
    expect(w.git.cwds.every(c => c === HOOKS)).toBe(true)
    const none = world({ git: true })
    await gitRun(none.io, ROOT, ['rev-parse', 'HEAD'])
    expect(none.git.cwds).toEqual([undefined])
  })

  test('an existing note is left as it is (nothing is written)', async () => {
    const w = world({ git: true })
    w.fs.file(NOTE, 'edited by the person')
    w.fs.writes.length = 0
    await gitRun(withHooks(w), ROOT, ['rev-parse', 'HEAD'])
    expect(w.fs.writes).toEqual([])
    expect(w.fs.read(NOTE)).toBe('edited by the person')
    expect(w.git.argvs[0]?.[4]).toBe(`core.hooksPath=${HOOKS}`)
  })

  test('with no hooksDir the hooks path is the null device: /dev/null, and NUL for a Windows-style root; nothing is written', async () => {
    const w = world({ node: 'ok', git: true })
    await everything(w, w.io)
    for (const argv of w.git.argvs) expect(argv.slice(3, 5), argv.join(' ')).toEqual(['-c', 'core.hooksPath=/dev/null'])
    expect(w.fs.writes.every(p => p.startsWith(`${SNAPS}/`))).toBe(true)
    const seen: string[][] = []
    const io: IO = { ...w.io, run: async argv => (seen.push(argv), done(0, '')) }
    await gitRun(io, 'C:\\Users\\dev\\acme-shop', ['status'])
    await gitRun(io, 'c:/Users/dev/acme-shop', ['status'])
    await gitRun(io, '\\\\server\\share\\app', ['status'])
    await gitRun(io, '/c/Users/dev/app', ['status'])
    expect(seen.map(a => a[4])).toEqual(['core.hooksPath=NUL', 'core.hooksPath=NUL', 'core.hooksPath=NUL', 'core.hooksPath=/dev/null'])
  })

  test('a Windows hooksDir is passed as it is spelled, and the note is made under the normalized path', async () => {
    const w = world({ git: true })
    const dir = 'C:\\Users\\dev\\.claude\\kit-safety\\no-hooks'
    await gitRun(withHooks(w, dir), 'C:\\Users\\dev\\acme-shop', ['rev-parse', 'HEAD'])
    expect(w.git.argvs[0]?.[4]).toBe(`core.hooksPath=${dir}`)
    expect(w.fs.writes).toEqual(['C:/Users/dev/.claude/kit-safety/no-hooks/README.txt'])
  })

  test('a hooksDir that cannot be used (relative, empty, a filesystem root, control characters, too long, not text) falls back to the null device', async () => {
    const odd = ['no-hooks', './no-hooks', '', '/', 'C:\\', '/tmp/a\nb', '/tmp/a\u0000b', `/${'x'.repeat(5000)}`, 5, null, {}, ['/abs']]
    for (const dir of odd) {
      const w = world({ git: true })
      const out = await gitRun({ ...w.io, hooksDir: dir as unknown as string }, ROOT, ['rev-parse', '--is-inside-work-tree'])
      expect(out.ok, JSON.stringify(dir)).toBe(true) // the call still ran
      expect(w.git.argvs[0]?.[4], JSON.stringify(dir)).toBe('core.hooksPath=/dev/null')
      expect(w.fs.writes, JSON.stringify(dir)).toEqual([])
    }
  })

  test('a folder that cannot be made (a write that fails, a stat that throws) is the null device, tried once, never an error', async () => {
    const w = world({ git: true })
    w.git.isRepo = true
    let attempts = 0
    w.fs.failWrite = p => {
      if (p === NOTE) attempts += 1
      return p === NOTE
    }
    const io = withHooks(w)
    for (let i = 0; i < 3; i += 1) expect((await gitRun(io, ROOT, ['rev-parse', '--is-inside-work-tree'])).ok).toBe(true)
    expect(attempts).toBe(1)
    for (const argv of w.git.argvs) expect(argv[4]).toBe('core.hooksPath=/dev/null')
    const w2 = world({ git: true })
    const io2: IO = { ...withHooks(w2), stat: () => Promise.reject(new Error('boom')) }
    expect((await gitRun(io2, ROOT, ['rev-parse', 'HEAD'])).code).toBe(0)
    expect(w2.git.argvs[0]?.[4]).toBe('core.hooksPath=/dev/null')
    const io3: IO = { ...withHooks(w2), writeText: () => Promise.reject(new Error('EROFS')) }
    w2.fs.remove(HOOKS)
    expect((await gitRun(io3, ROOT, ['rev-parse', 'HEAD'])).code).toBe(0)
    expect(w2.git.argvs.at(-1)?.[4]).toBe('core.hooksPath=/dev/null')
  })

  test('the value never comes from the project: a hostile config, hooks folder or folder name changes nothing', async () => {
    const w = world({ git: true })
    w.fs.file(`${ROOT}/.git/config`, '[core]\n\thooksPath = /tmp/evil-hooks\n\tfsmonitor = /tmp/evil-monitor\n')
    w.fs.file(`${ROOT}/.git/hooks/reference-transaction`, '#!/bin/sh\necho owned\n')
    w.fs.file(`${ROOT}/.githooks/pre-push`, '#!/bin/sh\n')
    w.git.stash = SHA2
    await everything(w, withHooks(w))
    const nasty = '/work/core.hooksPath=/tmp/evil'
    w.fs.dir(nasty)
    const seen: string[][] = []
    const io: IO = { ...withHooks(w), run: async argv => (seen.push(argv), done(0, '')) }
    await gitRun(io, nasty, ['rev-parse', 'HEAD'])
    for (const argv of [...w.git.argvs, ...seen]) {
      const values = argv.filter(a => a.startsWith('core.hooksPath='))
      expect(values, argv.join(' ')).toEqual([`core.hooksPath=${HOOKS}`])
      expect(argv.join(' ')).not.toMatch(/evil-hooks|\.git\/hooks|\.githooks/)
      expect(argv.indexOf(values[0] ?? '')).toBeLessThan(argv.indexOf('-C'))
    }
    // The odd folder name is one argument after -C, not an option.
    expect(seen[0]?.slice(-4)).toEqual(['-C', nasty, 'rev-parse', 'HEAD'])
  })

  test('gitRun keeps its shape: the result, the identity flags after the hooks pair, the time limit, and never a throw', async () => {
    const w = world({ git: true })
    const seen: { argv: string[]; timeoutMs?: number }[] = []
    const io: IO = { ...w.io, run: async (argv, init) => (seen.push({ argv, ...(init?.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}) }), done(argv.includes('fail') ? 128 : 0, 'out\n')) }
    expect(await gitRun(io, ROOT, ['x'])).toEqual({ ok: true, code: 0, out: 'out\n' })
    expect(await gitRun(io, ROOT, ['fail'])).toEqual({ ok: false, code: 128, out: 'out\n' })
    await gitRun(io, ROOT, ['stash', 'create'], { identity: true, timeoutMs: 1234 })
    expect(seen[2]?.argv).toEqual(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Safety Net', '-c', 'user.email=safety-net@localhost', '-C', ROOT, 'stash', 'create'])
    expect(seen[2]?.timeoutMs).toBe(1234)
    expect(seen[0]?.timeoutMs).toBe(10_000)
    const boom: IO = { ...w.io, run: () => Promise.reject(new Error('x')) }
    expect(await gitRun(boom, ROOT, ['x'])).toEqual({ ok: false, code: -1, out: '' })
    expect(await gitRun(undefined as unknown as IO, ROOT, ['x'])).toEqual({ ok: false, code: -1, out: '' })
    expect(await gitRun({ run: () => done(0, 'x') } as unknown as IO, undefined as unknown as string, ['x'])).toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Round 2, item 6: no Node and `.env` files

describe('the text-only backend does not copy .env-like files', () => {
  const T = 'fs backend'
  const skippedOf = (w: World, id = ID0) => manifestOf(w, id).skipped

  test(`${T}: a .env target alone: nothing saved, the failure says private, nothing is written`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/.env`, 'SECRET=1\n')
    const out = await snap(w, ['.env'])
    expect(out).toEqual({ ok: false, reason: 'private' })
    expect(w.fs.below(SNAPS)).toEqual([])
    expect(w.fs.writes).toEqual([])
  })

  test(`${T}: .env and other files: the others are saved, the snapshot is partial and counts what it left out; the .env is not stored anywhere`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/.env`, 'SECRET=1\n')
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['.env', 'a.txt'])
    expect(out).toMatchObject({ files: 1, isPartial: true, skippedPrivate: 1, backend: 'fs', skippedBinary: 0 })
    expect(skippedOf(w)).toEqual([{ rel: '.env', reason: 'private' }])
    expect(manifestOf(w, ID0).files.map(f => f.rel)).toEqual(['a.txt'])
    expect(w.fs.below(`${SNAPS}/${KEY}`).filter(p => p.includes('.env'))).toEqual([])
    expect(w.fs.writes.some(p => p.includes('.env'))).toBe(false)
    expect(w.fs.below(SNAPS).map(p => w.fs.read(p) ?? '').join('').includes('SECRET')).toBe(false)
  })

  test(`${T}: found while walking a folder, by base name, in any case: .env, .env.<x>, <x>.env, .envrc; templates are copied`, async () => {
    const w = world()
    for (const name of ['.env', '.env.local', '.env.production', '.ENV', 'prod.env', '.envrc', 'sub/.env']) w.fs.file(`${ROOT}/cfg/${name}`, 'K=v')
    for (const name of ['.env.example', '.env.sample', 'env.txt', 'environment.js', 'a.txt', 'dotenv', '.environment']) w.fs.file(`${ROOT}/cfg/${name}`, 'ok')
    const out = await made(w, ['cfg'])
    expect(out).toMatchObject({ isPartial: true, skippedPrivate: 7 })
    expect(manifestOf(w, ID0).files.map(f => f.rel).sort()).toEqual(['cfg/.env.example', 'cfg/.env.sample', 'cfg/.environment', 'cfg/a.txt', 'cfg/dotenv', 'cfg/env.txt', 'cfg/environment.js'])
    expect(skippedOf(w).map(s => s.rel).sort()).toEqual(['cfg/.ENV', 'cfg/.env', 'cfg/.env.local', 'cfg/.env.production', 'cfg/.envrc', 'cfg/prod.env', 'cfg/sub/.env'])
    expect(skippedOf(w).every(s => s.reason === 'private')).toBe(true)
  })

  test(`${T}: a folder that held only .env files is not recorded as an empty folder, so there is nothing to claim; one with an empty sibling folder still is`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/only/deep/.env`, 'K=v')
    expect(await snap(w, ['only'])).toEqual({ ok: false, reason: 'private' })
    expect(w.fs.below(SNAPS)).toEqual([])
    const w2 = world()
    w2.fs.file(`${ROOT}/mix/a/.env`, 'K=v')
    w2.fs.dir(`${ROOT}/mix/b`)
    const out = await made(w2, ['mix'])
    expect(manifestOf(w2, ID0).dirs).toEqual(['mix/b'])
    expect(out).toMatchObject({ files: 0, isPartial: true, skippedPrivate: 1 })
  })

  test(`${T}: a folder named .env (a virtual environment) is copied: only FILES are judged by their names`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/.env/bin/activate`, 'source')
    w.fs.file(`${ROOT}/.env/pyvenv.cfg`, 'home = /usr')
    const out = await made(w, ['.env'])
    expect(out).toMatchObject({ files: 2, isPartial: false })
    expect('skippedPrivate' in out).toBe(false)
  })

  test(`${T}: only .env files and binary files: private wins as the reason, still nothing is written`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/d/.env`, 'K=v')
    w.fs.file(`${ROOT}/d/logo.png`, [0, 1, 2, 3])
    expect(await snap(w, ['d'])).toEqual({ ok: false, reason: 'private' })
    expect(w.fs.below(SNAPS)).toEqual([])
    // Without the .env it is the old answer.
    const w2 = world()
    w2.fs.file(`${ROOT}/d/logo.png`, [0, 1, 2, 3])
    expect(await snap(w2, ['d'])).toEqual({ ok: false, reason: 'nothing', skipped: 1 })
  })

  test(`${T}: with git state to keep, a .env that was left out still gives a snapshot (partial), not a failure`, async () => {
    const w = world({ git: true })
    w.git.stash = SHA2
    w.fs.file(`${ROOT}/.env`, 'K=v')
    const out = await made(w, ['.env'], { risks: [risk('reset-hard', 'git reset --hard')] })
    expect(out).toMatchObject({ files: 0, hasGit: true, isPartial: true, skippedPrivate: 1 })
    expect(w.git.refs.has(`refs/kit-safety/${out.id}`)).toBe(true)
  })

  test('the Node helper copies a .env as before (it keeps the mode and makes every folder private), and says nothing about private', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/.env`, 'K=v')
    w.fs.file(`${ROOT}/d/.env.local`, 'K=v')
    const out = await made(w, ['.env', 'd'])
    expect(out).toMatchObject({ files: 2, isPartial: false, backend: 'node' })
    expect('skippedPrivate' in out).toBe(false)
    expect(w.fs.read(`${snapDirOf(ID0)}/files/.env`)).toBe('K=v')
  })

  test('a helper that fails and hands over to the text-only backend: the .env is left out there', async () => {
    const w = world({ node: 'refuse' })
    w.fs.file(`${ROOT}/.env`, 'K=v')
    w.fs.file(`${ROOT}/a.txt`, 'a')
    const out = await made(w, ['.env', 'a.txt'])
    expect(out).toMatchObject({ backend: 'fs', files: 1, skippedPrivate: 1, isPartial: true })
    const w2 = world({ node: 'crash' })
    w2.fs.file(`${ROOT}/.env`, 'K=v')
    expect(await snap(w2, ['.env'])).toEqual({ ok: false, reason: 'private' })
  })

  test('restoring such a snapshot never offers the .env: it is neither restored, nor failed, nor in the sample, nor counted as newer work', async () => {
    const w = world()
    w.fs.file(`${ROOT}/cfg/.env`, 'K=v')
    w.fs.file(`${ROOT}/cfg/a.txt`, 'a')
    await made(w, ['cfg'])
    w.fs.remove(`${ROOT}/cfg/a.txt`)
    const m = (await findSnapshot(w.env, ROOT, '1'))!
    const back = await restoreSnapshot(w.env, ROOT, m)
    expect(back).toMatchObject({ ok: true, restored: 1, keptNewer: 0 })
    expect(back.failed).toEqual([])
    expect(back.sample).toEqual(['cfg/a.txt'])
    expect(w.fs.read(`${ROOT}/cfg/a.txt`)).toBe('a')
    expect(w.fs.read(`${ROOT}/cfg/.env`)).toBe('K=v') // untouched
  })

  test('a manifest with the reason private reads back (and a made-up reason does not)', async () => {
    const w = world()
    w.fs.file(`${ROOT}/.env`, 'K=v')
    w.fs.file(`${ROOT}/a.txt`, 'a')
    await made(w, ['.env', 'a.txt'])
    const listed = await listSnapshots(w.env, ROOT)
    expect(listed[0]?.skipped).toEqual([{ rel: '.env', reason: 'private' }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Round 2, item 8: maxFiles, the total cap over all snapshots

describe('maxFiles: a smaller number makes a cheap snapshot', () => {
  const files = (w: World, n: number): string[] => {
    const names: string[] = []
    for (let i = 0; i < n; i += 1) {
      names.push(`f${i}.txt`)
      w.fs.file(`${ROOT}/f${i}.txt`, 'x')
    }
    return names
  }

  test('fs backend: one more than maxFiles is too-big by files, nothing written; exactly maxFiles is fine', async () => {
    const w = world()
    const names = files(w, 3)
    expect(await snap(w, names, {}, { ...CFG, maxFiles: 2 })).toEqual({ ok: false, reason: 'too-big', bytes: expect.any(Number), byFiles: true })
    expect(w.fs.below(SNAPS)).toEqual([])
    const w2 = world()
    const two = files(w2, 2)
    expect((await snap(w2, two, {}, { ...CFG, maxFiles: 2 })).ok).toBe(true)
    // A folder counts as an entry too: the folder and its 2 files are 3.
    const w3 = world()
    w3.fs.file(`${ROOT}/d/a.txt`, 'a')
    w3.fs.file(`${ROOT}/d/b.txt`, 'b')
    expect((await snap(w3, ['d'], {}, { ...CFG, maxFiles: 2 })).ok).toBe(false)
    expect((await snap(w3, ['d'], {}, { ...CFG, maxFiles: 3 })).ok).toBe(true)
  })

  test('node backend: the helper is asked with the same number, for the scan and for the copy', async () => {
    const w = world({ node: 'ok' })
    files(w, 1)
    await made(w, ['f0.txt'], {}, { ...CFG, maxFiles: 7 })
    expect(w.node.requests.filter(r => r.cmd === 'scan' || r.cmd === 'copy').map(r => r.maxFiles)).toEqual([7, 7])
  })

  test('between 1 and the default: a bigger number is not honoured, a number below 1 is 1, odd values are the default', async () => {
    const asked = async (maxFiles: unknown): Promise<unknown> => {
      const w = world({ node: 'ok' })
      files(w, 1)
      await snap(w, ['f0.txt'], {}, { ...CFG, maxFiles: maxFiles as number })
      return w.node.requests.find(r => r.cmd === 'scan')?.maxFiles
    }
    const table: [unknown, number][] = [
      [undefined, 50_000], [NaN, 50_000], ['5', 50_000], [null, 50_000], [Infinity, 50_000], [10 ** 9, 50_000], [50_000, 50_000], [49_999, 49_999],
      [2.9, 2], [1, 1], [0, 1], [-5, 1], [-Infinity, 1],
    ]
    const wrong: string[] = []
    for (const [input, want] of table) if ((await asked(input)) !== want) wrong.push(`${String(input)} -> ${String(await asked(input))}, wanted ${want}`)
    expect(wrong).toEqual([])
  })

  test('the number is passed to the undo point of a restore as well', async () => {
    const w = world({ node: 'ok' })
    files(w, 1)
    await made(w, ['f0.txt'])
    w.node.requests.length = 0
    await restoreSnapshot(w.env, ROOT, (await findSnapshot(w.env, ROOT, '1'))!, { ...CFG, maxFiles: 9 })
    expect(w.node.requests.filter(r => r.cmd === 'scan').map(r => r.maxFiles)).toEqual([9])
  })
})

describe('the total cap over all snapshots', () => {
  const T0 = Date.UTC(2026, 10, 24, 9, 30, 15)
  const ROOT2 = '/work/other-app'
  const ROOT3 = '/work/third-app'
  const CFG14: VaultCfg = { maxBytes: 100 * MB, keepCount: 100, keepDays: 14 }
  let serial = 0

  /** A snapshot of `root` of exactly `bytes` bytes, made `daysAgo` days ago (the clock goes back for it and returns). */
  async function bytes(w: World, root: string, daysAgo: number, size: number, extra: Partial<SnapshotRequest> = {}): Promise<string> {
    serial += 1
    const name = `blob-${serial}.txt`
    w.fs.dir(root)
    w.fs.file(`${root}/${name}`, 'x'.repeat(size))
    clock.now = T0 - daysAgo * DAY
    const out = await createSnapshot(w.env, req([name], { root, ...extra }), { ...CFG, keepCount: 1000, keepDays: 100_000 })
    clock.now = T0
    if (!out.ok) throw new Error(JSON.stringify(out))
    return out.id
  }
  const held = (w: World, root: string, id: string): boolean => w.fs.has(`${SNAPS}/${projectKey(root)}/${id}`) && !w.fs.has(`${SNAPS}/${projectKey(root)}/${id}/pruned`)
  const idsOf = async (w: World, root: string): Promise<string[]> => (await listSnapshots(w.env, root)).map(m => m.id)
  /** The ids the helper was asked to remove, in order. */
  const removed = (w: World): string[] => w.node.requests.filter(r => r.cmd === 'remove').map(r => `${String(r.projectKey)}/${String(r.id)}`)

  describe('pruneSnapshots (one project, also what createSnapshot runs after a copy)', () => {
    async function five(w: World): Promise<string[]> {
      const ids: string[] = []
      for (const days of [5, 4, 3, 2, 1]) ids.push(await bytes(w, ROOT, days, 100))
      return ids // oldest first
    }

    test('the oldest go until the total is at most the cap: an exact order and an exact stop', async () => {
      const w = world({ node: 'ok' })
      const ids = await five(w)
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 300 })).toBe(2)
      expect(removed(w)).toEqual([`${KEY}/${ids[0]}`, `${KEY}/${ids[1]}`])
      expect(await idsOf(w, ROOT)).toEqual([ids[4], ids[3], ids[2]])
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 300 })).toBe(0) // at most, not less than
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 299 })).toBe(1)
      expect(await idsOf(w, ROOT)).toEqual([ids[4], ids[3]])
    })

    test('nothing over the cap (or nothing there): nothing is asked of the helper, and node is not even probed', async () => {
      const w = world({ node: 'ok', envNode: undefined })
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 300 })).toBe(0) // no snapshots at all
      await five(w)
      w.node.versionCalls = 0
      w.node.requests.length = 0
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 500 })).toBe(0)
      expect(w.node.versionCalls).toBe(0)
      expect(w.node.requests).toEqual([])
    })

    test('a cap that is not a positive number is no cap', async () => {
      for (const cap of [undefined, 0, -1, NaN, Infinity, -Infinity, '100' as unknown as number, null as unknown as number]) {
        const w = world()
        await five(w)
        expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: cap }), String(cap)).toBe(0)
        expect(await idsOf(w, ROOT), String(cap)).toHaveLength(5)
      }
    })

    test('a cap smaller than one snapshot: the newest is kept, all the others go', async () => {
      const w = world({ node: 'ok' })
      const ids = await five(w)
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 10 })).toBe(4)
      expect(await idsOf(w, ROOT)).toEqual([ids[4]])
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 1 })).toBe(0)
      expect(await idsOf(w, ROOT)).toEqual([ids[4]])
    })

    test('protected ids are skipped (their bytes still count), and so is the newest', async () => {
      const w = world({ node: 'ok' })
      const ids = await five(w)
      // Evictable, oldest first: 1, 2, 3 (0 is protected, 4 is the newest). 500 -> 200 needs three removals.
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 250 }, [ids[0]!])).toBe(3)
      expect(removed(w)).toEqual([`${KEY}/${ids[1]}`, `${KEY}/${ids[2]}`, `${KEY}/${ids[3]}`])
      expect((await idsOf(w, ROOT)).sort()).toEqual([ids[0], ids[4]].sort())
      // When what is protected alone is over the cap, nothing else is left to remove and it stops there.
      const w2 = world()
      const all = await five(w2)
      expect(await pruneSnapshots(w2.env, ROOT, { ...CFG14, maxTotalBytes: 50 }, all.slice(0, 3))).toBe(1) // only the fourth is neither protected nor the newest
      expect((await idsOf(w2, ROOT)).sort()).toEqual(all.slice(0, 3).concat(all[4]!).sort())
    })

    test('the count and age rules run first; the cap then looks at what is left', async () => {
      const w = world({ node: 'ok' })
      const old = await bytes(w, ROOT, 30, 100)
      const ids = await five(w)
      // 6 snapshots, 600 bytes: age takes `old` (500 left), the count (keepCount 4) takes the oldest of the five (400 left),
      // the cap (350) takes one more.
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, keepCount: 4, maxTotalBytes: 350 })).toBe(3)
      expect(removed(w)).toEqual([`${KEY}/${old}`, `${KEY}/${ids[0]}`, `${KEY}/${ids[1]}`])
    })

    test('sizes are the manifests totalBytes: bigger snapshots count for more', async () => {
      const w = world()
      const small = await bytes(w, ROOT, 3, 10)
      const big = await bytes(w, ROOT, 2, 1000)
      const newest = await bytes(w, ROOT, 1, 10)
      // 1020 bytes; the cap 500 removes the oldest (small): 1010 is still over, so the big one goes too.
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 500 })).toBe(2)
      expect(await idsOf(w, ROOT)).toEqual([newest])
      expect([small, big].some(id => held(w, ROOT, id))).toBe(false)
    })

    test('a snapshot that cannot be removed does not count as gone: the next one goes instead', async () => {
      const w = world() // text-only: removing writes a `pruned` marker
      const ids = await five(w)
      w.fs.failWrite = p => p === `${SNAPS}/${KEY}/${ids[0]}/pruned`
      expect(await pruneSnapshots(w.env, ROOT, { ...CFG14, maxTotalBytes: 300 })).toBe(2)
      expect((await idsOf(w, ROOT)).sort()).toEqual([ids[0], ids[3], ids[4]].sort())
    })

    test('createSnapshot enforces it at the end of its own prune: the new snapshot stays, the oldest go', async () => {
      for (const { mode } of BACKENDS) {
        const w = world({ node: mode })
        const cfg: VaultCfg = { ...CFG, maxTotalBytes: 250 }
        w.fs.file(`${ROOT}/a.txt`, 'x'.repeat(100))
        const ids: string[] = []
        for (let i = 0; i < 4; i += 1) {
          clock.now += 1000
          ids.push((await made(w, ['a.txt'], {}, cfg)).id)
        }
        expect(await idsOf(w, ROOT), mode).toEqual([ids[3], ids[2]])
        // A snapshot bigger than the cap is still kept (it was just made and is the newest); everything else goes.
        w.fs.file(`${ROOT}/big.txt`, 'x'.repeat(400))
        clock.now += 1000
        const big = await made(w, ['big.txt'], {}, cfg)
        expect(await idsOf(w, ROOT), mode).toEqual([big.id])
      }
    })

    test('a restore undo point carries the cap through (the cfg of the restore)', async () => {
      const w = world()
      const ids = await five(w)
      w.fs.file(`${ROOT}/a.txt`, 'x'.repeat(100))
      const first = await made(w, ['a.txt'], {}, { ...CFG, keepCount: 100 })
      expect(first.ok).toBe(true)
      const m = (await listSnapshots(w.env, ROOT)).find(x => x.id === ids[4])!
      await restoreSnapshot(w.env, ROOT, m, { ...CFG14, maxTotalBytes: 250 })
      expect((await idsOf(w, ROOT)).length).toBeLessThanOrEqual(3)
      expect(await idsOf(w, ROOT)).toContain(ids[4])
    })
  })

  describe('pruneAll (every project)', () => {
    /** Three projects, two snapshots each, 100 bytes each: the open one is ROOT. Oldest first: a1 b1 c1 a2 b2 c2. */
    async function three(w: World, extra: { b1?: Partial<SnapshotRequest>; a1?: Partial<SnapshotRequest> } = {}) {
      const a1 = await bytes(w, ROOT, 9, 100, extra.a1)
      const b1 = await bytes(w, ROOT2, 8, 100, extra.b1)
      const c1 = await bytes(w, ROOT3, 7, 100)
      const a2 = await bytes(w, ROOT, 4, 100)
      const b2 = await bytes(w, ROOT2, 3, 100)
      const c2 = await bytes(w, ROOT3, 2, 100)
      return { a1, b1, c1, a2, b2, c2 }
    }
    const k = (root: string, id: string): string => `${projectKey(root)}/${id}`

    test('the oldest snapshot overall goes first, across projects, until all of them together take at most the cap', async () => {
      const w = world({ node: 'ok' })
      const s = await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 300 }, ROOT)).toBe(3)
      expect(removed(w)).toEqual([k(ROOT, s.a1), k(ROOT2, s.b1), k(ROOT3, s.c1)])
      expect(await idsOf(w, ROOT)).toEqual([s.a2])
      expect(await idsOf(w, ROOT2)).toEqual([s.b2])
      expect(await idsOf(w, ROOT3)).toEqual([s.c2])
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 300 }, ROOT)).toBe(0)
    })

    test('the same across projects without Node (marker way)', async () => {
      const w = world()
      const s = await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 450 }, ROOT)).toBe(2)
      expect(held(w, ROOT, s.a1) || held(w, ROOT2, s.b1)).toBe(false)
      expect(held(w, ROOT3, s.c1) && held(w, ROOT, s.a2) && held(w, ROOT2, s.b2) && held(w, ROOT3, s.c2)).toBe(true)
    })

    test('no cap (undefined, 0, below, not a number): nothing is removed for size', async () => {
      for (const cap of [undefined, 0, -1, NaN, Infinity]) {
        const w = world()
        await three(w)
        expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: cap }, ROOT), String(cap)).toBe(0)
      }
    })

    test('the per-project plans run first: only what they leave is counted against the cap', async () => {
      const w = world({ node: 'ok' })
      const old = await bytes(w, ROOT2, 40, 100) // age takes it (keepDays 14)
      const s = await three(w)
      // 700 bytes before, 600 after the age rule: the cap 450 then needs two more removals.
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 450 }, ROOT)).toBe(3)
      expect(removed(w)).toEqual([k(ROOT2, old), k(ROOT, s.a1), k(ROOT2, s.b1)])
    })

    test('a cap smaller than one snapshot: the newest snapshot of the open project stays, every other file-only one goes', async () => {
      const w = world({ node: 'ok' })
      const s = await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 1 }, ROOT)).toBe(5)
      expect(removed(w)).toEqual([k(ROOT, s.a1), k(ROOT2, s.b1), k(ROOT3, s.c1), k(ROOT2, s.b2), k(ROOT3, s.c2)])
      expect(await idsOf(w, ROOT)).toEqual([s.a2])
      expect(await idsOf(w, ROOT2)).toEqual([])
      expect(await idsOf(w, ROOT3)).toEqual([])
    })

    test('with no open project nothing is the newest of it: every file-only snapshot may go', async () => {
      const w = world()
      await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 1 })).toBe(6)
      expect(await idsOf(w, ROOT)).toEqual([])
    })

    test('protectIds (ids of the open project) are skipped by the cap and by the plan', async () => {
      const w = world({ node: 'ok' })
      const s = await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 300 }, ROOT, [s.a1])).toBe(3)
      expect(removed(w)).toEqual([k(ROOT2, s.b1), k(ROOT3, s.c1), k(ROOT2, s.b2)])
      expect((await idsOf(w, ROOT)).sort()).toEqual([s.a1, s.a2].sort())
      // The same id in another project is not protected by it.
      const w2 = world({ node: 'ok' })
      const clash = await bytes(w2, ROOT2, 8, 100)
      const own = await bytes(w2, ROOT, 8, 100)
      expect(clash).toBe(own)
      await bytes(w2, ROOT, 1, 100)
      await pruneAll(w2.env, { ...CFG14, maxTotalBytes: 250 }, ROOT, [own])
      expect(removed(w2)).toEqual([k(ROOT2, clash)])
    })

    test('a snapshot of another project that holds git refs is locked: its bytes count, it is never removed; the open project own ones are removed with their refs', async () => {
      const reset = { risks: [risk('reset-hard', 'git reset --hard')] }
      const w = world({ node: 'ok', git: true })
      w.git.stash = SHA2
      const s = await three(w, { b1: reset })
      w.git.calls.length = 0
      // 600 bytes, cap 200: b1 (git, other project) stays, a1 c1 a2 b2... go until nothing else is left to remove.
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 200 }, ROOT)).toBe(4)
      expect(held(w, ROOT2, s.b1)).toBe(true)
      expect(w.git.refs.has(`refs/kit-safety/${s.b1}`)).toBe(true)
      expect(removed(w)).not.toContain(k(ROOT2, s.b1))
      expect(await idsOf(w, ROOT2)).toEqual([s.b1])
      expect(w.git.calls).toEqual([]) // none of the removed ones held git state
      // The open project's own git snapshot goes like any other, with its refs, through the open root.
      const w2 = world({ node: 'ok', git: true })
      w2.git.stash = SHA2
      const t = await three(w2, { a1: reset })
      expect(w2.git.refs.has(`refs/kit-safety/${t.a1}`)).toBe(true)
      await pruneAll(w2.env, { ...CFG14, maxTotalBytes: 500 }, ROOT)
      expect(held(w2, ROOT, t.a1)).toBe(false)
      expect(w2.git.deleted).toEqual([`refs/kit-safety/${t.a1}`])
      expect(w2.git.argvs.every(a => a[a.indexOf('-C') + 1] === ROOT)).toBe(true)
    })

    test('a snapshot that could not be removed does not count as gone: the next one goes instead', async () => {
      const w = world()
      const s = await three(w)
      w.fs.failWrite = p => p === `${SNAPS}/${projectKey(ROOT)}/${s.a1}/pruned`
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 450 }, ROOT)).toBe(2)
      expect(held(w, ROOT, s.a1)).toBe(true)
      expect(held(w, ROOT2, s.b1) || held(w, ROOT3, s.c1)).toBe(false)
    })

    test('the sweep stops at its time budget, without an error', async () => {
      const w = world({ node: 'ok' })
      await three(w)
      let t = T0
      const io: IO = { ...w.io, now: () => (t += 25_000) }
      const pruned = await pruneAll({ ...w.env, io }, { ...CFG14, maxTotalBytes: 1 }, ROOT)
      expect(pruned).toBeLessThan(5)
    })

    test('odd cfg and a throwing IO give 0, never a throw', async () => {
      const w = world()
      await three(w)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 'x' as unknown as number }, ROOT)).toBe(0)
      const boom = (): never => {
        throw new Error('x')
      }
      expect(await pruneAll({ ...w.env, io: { ...w.io, list: boom, stat: boom, run: boom, now: boom } }, { ...CFG14, maxTotalBytes: 1 }, ROOT)).toBe(0)
      expect(await pruneAll(w.env, { ...CFG14, maxTotalBytes: 1 }, ROOT, 'x' as unknown as string[])).toBeGreaterThan(0)
    })
  })
})
