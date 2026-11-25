import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { HOME, ROOT, SNAPS, bash, begin, bandTexts, drain, dosPath, fakeFs, fakeRun, norm, press, safety, settle, track, underSnaps, world } from './world'
import type { World, WorldOptions } from './world'

// The fake world must not care how a path is spelled. The test engine on Windows hands every path to the fake with a drive in front
// and backslashes (`/work/acme-shop` arrives as `D:\work\acme-shop`); Linux CI cannot show that, so these tests (a) pin `norm`, (b)
// call every handler of the fake with Windows spellings and compare each answer with the POSIX one, and (c) run whole flows of the
// plugin in "Windows mode" (`world(on, { drive })`), where a hook above the handlers rewrites every path the plugin sends them.

const DRIVES = ['D:', 'd:', 'C:', 'Z:']
const PROJECT = '/work/acme-shop'
const SNAP_ID = '20261124T140512Z'

// ---------------------------------------------------------------------------------------------------------------------
// (a) norm

test('norm: a POSIX path stays as it is', () => {
  for (const p of ['/', '/work', PROJECT, `${PROJECT}/build/a.js`, `${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`, '/a b/c d', '/.env', '/work/.hidden/x', 'build/a.js', 'a', '.', '..']) {
    expect(norm(p)).toBe(p)
  }
})

test('norm: every spelling of the project folder is the same place', () => {
  const spellings = [
    PROJECT,
    'D:\\work\\acme-shop',
    'd:\\work\\acme-shop',
    'D:/work/acme-shop',
    'd:/work/acme-shop',
    'Z:\\work\\acme-shop',
    '\\work\\acme-shop',
    '\\work/acme-shop',
    'D:\\work/acme-shop',
    'D:/work\\acme-shop',
    '/work/acme-shop/',
    'D:\\work\\acme-shop\\',
    'D:\\work\\acme-shop\\\\',
    '//work//acme-shop//',
    'D:\\\\work\\\\acme-shop',
    'D:\\//work\\\\//acme-shop/\\/',
  ]
  expect(spellings.filter(p => norm(p) !== PROJECT)).toEqual([])
  const build = spellings.map(p => `${p.replace(/[\\/]+$/, '')}${p.includes('\\') ? '\\' : '/'}build`)
  expect(build.filter(p => norm(p) !== `${PROJECT}/build`)).toEqual([])
})

test('norm: Windows paths below the project, the snapshot folder and the home folder', () => {
  expect(norm('\\work\\acme-shop\\build')).toBe(`${PROJECT}/build`)
  expect(norm('D:\\work\\acme-shop\\build\\sub\\b.js')).toBe(`${PROJECT}/build/sub/b.js`)
  expect(norm('D:\\home\\dev\\.claude\\kit-safety\\snapshots\\acme-shop-1a2b\\20261124T140512Z\\manifest.json')).toBe(`${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`)
  expect(norm('c:\\home\\dev')).toBe(HOME)
})

test('norm: a root is "/" however it is written', () => {
  for (const p of ['/', '//', '///', '\\', '\\\\', 'D:', 'D:\\', 'D:/', 'd:\\\\', 'C:/\\/', '']) expect(norm(p)).toBe('/')
})

test('norm: doubled and trailing separators go, the rest of the name is untouched', () => {
  expect(norm('/work//acme-shop///build//')).toBe(`${PROJECT}/build`)
  expect(norm('/work/acme-shop/build/')).toBe(`${PROJECT}/build`)
  expect(norm('build//a.js')).toBe('build/a.js')
  expect(norm('build/')).toBe('build')
  expect(norm('/work/acme  shop/a  b ')).toBe('/work/acme  shop/a  b ')
  expect(norm('/work/acme-shop/.')).toBe(`${PROJECT}/.`)
})

test('norm: . and .. segments are kept as written (the plugin resolves its own paths; an unresolved one is its bug, not a thing to hide)', () => {
  expect(norm('/work/acme-shop/../x')).toBe('/work/acme-shop/../x')
  expect(norm('D:\\work\\.\\acme-shop\\..\\x\\')).toBe('/work/./acme-shop/../x')
  expect(norm('..\\x')).toBe('../x')
  expect(norm('/work/acme-shop/..')).not.toBe('/work')
})

test('norm: only a drive letter at the very start counts, and only one letter', () => {
  expect(norm('/work/a:b')).toBe('/work/a:b')
  expect(norm('/work/c:\\x')).toBe('/work/c:/x')
  expect(norm('/c:/x')).toBe('/c:/x')
  expect(norm('1:/x')).toBe('1:/x')
  expect(norm('ab:/x')).toBe('ab:/x')
  expect(norm(':x')).toBe(':x')
  expect(norm('D::x')).toBe(':x')
  expect(norm('\u00e9:/x')).toBe('\u00e9:/x')
  // a relative path with a drive ("the current folder of D:") has no drive left and is relative
  expect(norm('D:work')).toBe('work')
  expect(norm('d:build\\a.js')).toBe('build/a.js')
})

test('norm: odd input never throws and always gives a string', () => {
  for (const v of [undefined, null, 0, 42, -1, NaN, true, false, [], ['a', 'b'], {}, () => 1, 10n, Symbol('x')]) {
    const out = (() => { try { return norm(v) } catch { return null } })()
    expect(typeof out).toBe('string')
  }
  expect(norm(undefined)).toBe('undefined')
  expect(norm(null)).toBe('null')
  expect(norm(42)).toBe('42')
  expect(norm('')).toBe('/')
  expect(norm(' ')).toBe(' ')
  expect(norm('\n')).toBe('\n')
})

test('norm: unicode, control characters and very long input pass through unharmed, and fast', () => {
  const odd = ['\u3164\u2800', '\u202Eevil', 'a\u0000b', 'tab\there', 'line\nbreak', '\u{1F4C1}', 'Thư mục', 'cafe\u0301']
  const bad: string[] = []
  for (const name of odd) {
    if (norm(`D:\\work\\acme-shop\\${name}`) !== `${PROJECT}/${name}`) bad.push(name)
    if (norm(`${PROJECT}/${name}`) !== `${PROJECT}/${name}`) bad.push(name)
  }
  expect(bad).toEqual([])
  const long = 'x'.repeat(200_000)
  expect(norm(`D:\\${long}\\${long}\\`)).toBe(`/${long}/${long}`)
  expect(norm('\\'.repeat(100_000))).toBe('/')
  expect(norm('/'.repeat(100_000))).toBe('/')
  expect(norm(`D:${'\\/'.repeat(50_000)}a`)).toBe('/a')
  const started = Date.now()
  norm(`${'a/'.repeat(50_000)}\\${'b\\'.repeat(50_000)}`)
  expect(Date.now() - started).toBeLessThan(500)
})

test('norm is idempotent, and a Windows spelling of any path norms to the path itself', () => {
  const paths = ['/', PROJECT, `${PROJECT}/build/a.js`, `${PROJECT}/.env`, `${PROJECT}/\u3164\u2800`, `${SNAPS}/p/${SNAP_ID}/manifest.json`, HOME, '/a', '/a b/c']
  const bad: string[] = []
  for (const p of paths) {
    if (norm(norm(p)) !== norm(p)) bad.push(`idempotent ${p}`)
    for (const drive of DRIVES) {
      for (const spelled of [dosPath(drive, p), `${drive}${p}`, `${dosPath(drive, p)}\\`, dosPath(drive, p).replace(/\\/g, '\\\\')]) {
        if (norm(spelled) !== norm(p)) bad.push(`${JSON.stringify(spelled)} -> ${norm(spelled)}`)
        if (norm(norm(spelled)) !== norm(spelled)) bad.push(`idempotent ${spelled}`)
      }
    }
  }
  expect(bad).toEqual([])
})

test('dosPath spells a path the way the Windows engine does, and leaves a spelled one alone', () => {
  expect(dosPath('D:', PROJECT)).toBe('D:\\work\\acme-shop')
  expect(dosPath('c:', `${PROJECT}/build/`)).toBe('c:\\work\\acme-shop\\build\\')
  expect(dosPath('D:', '/')).toBe('D:\\')
  expect(dosPath('D:', 'build/a.js')).toBe('build\\a.js')
  expect(dosPath('D:', 'D:\\work\\x')).toBe('D:\\work\\x')
  expect(dosPath('D:', 'c:/work/x')).toBe('c:/work/x')
  expect(dosPath('D:', '\\work\\x')).toBe('\\work\\x')
  expect(dosPath('D:', '')).toBe('')
})

// ---------------------------------------------------------------------------------------------------------------------
// (b) every handler of the fake, with every spelling of a path

const BYTES_OF_SRC = new TextEncoder().encode('h\u00e9llo').length

function fixture(on: On, options: WorldOptions = {}): World {
  const w = world(on, options)
  w.put(`${ROOT}/build/a.js`, 'aaaaaa')
  w.put(`${ROOT}/build/sub/b.js`, 'bb')
  w.put(`${ROOT}/src/app.ts`, 'h\u00e9llo')
  w.put(`${ROOT}/.env`, 'A=1\n')
  w.put(`${ROOT}/\u3164\u2800`, 'x')
  w.put(`${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`, '{}')
  w.put(`${SNAPS}/acme-shop-1a2b/${SNAP_ID}/files/build/a.js`, 'aaaaaa')
  w.dirs.add(`${ROOT}/empty`)
  return w
}

/** The ways a path can reach a handler: as the plugin wrote it, and as the Windows engine, a slashed drive path and a sloppy one spell it. */
const spellings = (p: string, isFolder = false): string[] => [
  p,
  dosPath('D:', p),
  dosPath('d:', p),
  dosPath('Z:', p),
  `D:${p}`,
  p.replace(/\//g, '\\'),
  `D:${p.replace(/\//g, '\\\\')}`,
  ...(isFolder ? [`${p}/`, `${dosPath('D:', p)}\\`, `${p}//`] : []),
]

/** Every spelling of every path must get the answer the POSIX spelling gets; the mismatches come back as a list to assert once. */
function mismatches(paths: { path: string; isFolder?: boolean }[], ask: (path: string) => unknown): string[] {
  const bad: string[] = []
  for (const { path, isFolder } of paths) {
    const expected = JSON.stringify(ask(path))
    for (const spelled of spellings(path, isFolder)) {
      const got = JSON.stringify(ask(spelled))
      if (got !== expected) bad.push(`${JSON.stringify(spelled)}: ${got} instead of ${expected}`)
    }
  }
  return bad
}

const FILES = [`${ROOT}/build/a.js`, `${ROOT}/build/sub/b.js`, `${ROOT}/src/app.ts`, `${ROOT}/.env`, `${ROOT}/\u3164\u2800`, `${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`]
const FOLDERS = ['/', '/work', ROOT, `${ROOT}/build`, `${ROOT}/build/sub`, `${ROOT}/src`, `${ROOT}/empty`, HOME, SNAPS, `${SNAPS}/acme-shop-1a2b`]
const MISSING = [`${ROOT}/nope.txt`, `${ROOT}/build/nope/x.js`, '/nowhere', `${ROOT}/src/app.ts/inside`, `${ROOT}-other`, `${ROOT}x`]
const ALL = [...FILES.map(path => ({ path })), ...FOLDERS.map(path => ({ path, isFolder: true })), ...MISSING.map(path => ({ path }))]

test('fs.stat answers a Windows spelling of a path exactly as it answers the POSIX one', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  expect(mismatches(ALL, path => fs.stat({ path, resolve: false }))).toEqual([])
  expect(mismatches(ALL, path => fs.stat({ path, resolve: true }))).toEqual([])
  // and the answers are the real ones, not "nothing" everywhere
  const file = { kind: 'file', size: 6, mtimeMs: 1_700_000_000_000, isLink: false }
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\build\\a.js', resolve: false })).toEqual({ value: file })
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\src\\app.ts', resolve: false })).toEqual({ value: { ...file, size: BYTES_OF_SRC } })
  expect(fs.stat({ path: 'D:\\work\\acme-shop', resolve: false })).toEqual({ value: { kind: 'dir', size: 0, mtimeMs: 1_700_000_000_000, isLink: false } })
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\empty', resolve: false })).toMatchObject({ value: { kind: 'dir' } })
  expect(fs.stat({ path: 'D:\\', resolve: false })).toMatchObject({ value: { kind: 'dir' } })
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\nope.txt', resolve: false })).toEqual({ deny: 'ENOENT' })
  // what the fake hands back is POSIX: the resolved path has no drive and no backslash
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\build\\a.js', resolve: true })).toEqual({ value: { ...file, realPath: `${ROOT}/build/a.js` } })
  expect(fs.stat({ path: 'd:/work/acme-shop/', resolve: true })).toMatchObject({ value: { kind: 'dir', realPath: ROOT } })
})

test('fs.exists answers a Windows spelling of a path exactly as it answers the POSIX one', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  expect(mismatches(ALL, path => fs.exists({ path }))).toEqual([])
  expect(fs.exists({ path: 'D:\\work\\acme-shop\\build\\a.js' })).toEqual({ value: true })
  expect(fs.exists({ path: 'D:\\work\\acme-shop\\build' })).toEqual({ value: true })
  expect(fs.exists({ path: 'D:\\work\\acme-shop\\build\\' })).toEqual({ value: true })
  expect(fs.exists({ path: 'd:/home/dev/.claude/kit-safety/snapshots' })).toEqual({ value: true })
  expect(fs.exists({ path: 'D:\\work\\acme-shop\\nope.txt' })).toEqual({ value: false })
  expect(fs.exists({ path: 'D:\\work\\acme-shop-other' })).toEqual({ value: false })
  expect(fs.exists({ path: 'D:\\' })).toEqual({ value: true })
})

test('fs.list answers a Windows spelling of a folder exactly as it answers the POSIX one', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  expect(mismatches(ALL, path => fs.list({ path }))).toEqual([])
  const names = (path: string) => {
    const r = fs.list({ path })
    return 'value' in r ? r.value.map(e => `${e.name}:${e.kind}`).sort() : r
  }
  expect(names('D:\\work\\acme-shop')).toEqual(['.env:file', 'build:dir', 'empty:dir', 'src:dir', '\u3164\u2800:file'].sort())
  expect(names('D:\\work\\acme-shop\\')).toEqual(names(ROOT))
  expect(names('\\work\\acme-shop\\build')).toEqual(['a.js:file', 'sub:dir'])
  expect(names('d:/work/acme-shop/build/sub/')).toEqual(['b.js:file'])
  expect(names('D:\\work\\acme-shop\\empty')).toEqual([])
  expect(names('D:\\')).toEqual(['home:dir', 'work:dir'])
  expect(names('D:\\work\\acme-shop\\nope')).toEqual({ deny: 'ENOENT' })
  // a file is not a folder
  expect(names('D:\\work\\acme-shop\\build\\a.js')).toEqual({ deny: 'ENOENT' })
  // sizes are the bytes of the text
  const listed = fs.list({ path: 'D:\\work\\acme-shop\\src' })
  expect('value' in listed && listed.value).toEqual([{ name: 'app.ts', kind: 'file', size: BYTES_OF_SRC, mtimeMs: 1_700_000_000_000, isLink: false }])
})

test('fs.read answers a Windows spelling of a path exactly as it answers the POSIX one, text and bytes', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  expect(mismatches(ALL, path => fs.read({ path, as: 'text' }))).toEqual([])
  expect(mismatches(ALL, path => fs.read({ path, as: 'bytes' }))).toEqual([])
  expect(mismatches(ALL, path => fs.read({ path, as: 'bytes', offset: 1, length: 3 }))).toEqual([])
  expect(fs.read({ path: 'D:\\work\\acme-shop\\build\\a.js', as: 'text' })).toEqual({ value: 'aaaaaa' })
  expect(fs.read({ path: 'D:\\work\\acme-shop\\src\\app.ts', as: 'text' })).toEqual({ value: 'h\u00e9llo' })
  // 'bb' is bytes 0x62 0x62: base64 "YmI="
  expect(fs.read({ path: '\\work\\acme-shop\\build\\sub\\b.js', as: 'bytes' })).toEqual({ value: { base64: 'YmI=' } })
  // a range: bytes 1..2 of "aaaaaa" is "aa" (YWE=), a range past the end is cut
  expect(fs.read({ path: 'D:/work/acme-shop/build/a.js', as: 'bytes', offset: 1, length: 2 })).toEqual({ value: { base64: 'YWE=' } })
  expect(fs.read({ path: 'D:\\work\\acme-shop\\build\\a.js', as: 'bytes', offset: 4, length: 99 })).toEqual({ value: { base64: 'YWE=' } })
  expect(fs.read({ path: 'D:\\work\\acme-shop\\nope.txt', as: 'text' })).toEqual({ deny: 'ENOENT' })
  // a folder is not a file
  expect(fs.read({ path: 'D:\\work\\acme-shop\\build', as: 'text' })).toEqual({ deny: 'ENOENT' })
})

test('fs.write under a Windows spelling stores the file under its POSIX key; every spelling then reads, stats and lists it', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  expect(fs.write({ path: 'D:\\work\\acme-shop\\notes\\todo.txt', text: 'one' })).toEqual({ value: undefined })
  expect(fs.write({ path: 'd:/work/acme-shop//notes//plan.txt', text: 'two' })).toEqual({ value: undefined })
  expect(fs.write({ path: '\\work\\acme-shop\\build\\a.js', text: 'changed' })).toEqual({ value: undefined })
  expect([...w.files.keys()].filter(k => k.startsWith(`${ROOT}/notes`)).sort()).toEqual([`${ROOT}/notes/plan.txt`, `${ROOT}/notes/todo.txt`])
  expect(w.files.get(`${ROOT}/build/a.js`)).toBe('changed')
  expect(w.writes).toEqual([`${ROOT}/notes/todo.txt`, `${ROOT}/notes/plan.txt`, `${ROOT}/build/a.js`])
  expect([...w.files.keys()].filter(k => /^[A-Za-z]:|\\|\/\//.test(k))).toEqual([])
  expect(mismatches([{ path: `${ROOT}/notes/todo.txt` }], path => fs.read({ path, as: 'text' }))).toEqual([])
  expect(fs.read({ path: `${ROOT}/notes/todo.txt`, as: 'text' })).toEqual({ value: 'one' })
  expect(fs.read({ path: 'Z:\\work\\acme-shop\\notes\\plan.txt', as: 'text' })).toEqual({ value: 'two' })
  expect(fs.exists({ path: 'D:\\work\\acme-shop\\notes' })).toEqual({ value: true })
  const names = fs.list({ path: 'C:\\work\\acme-shop\\notes\\' })
  expect('value' in names && names.value.map(e => e.name).sort()).toEqual(['plan.txt', 'todo.txt'])
  // put and read, the test's own moves, take every spelling too
  w.put('D:\\work\\acme-shop\\put.txt', 'p')
  expect(w.files.get(`${ROOT}/put.txt`)).toBe('p')
  expect(w.read('d:/work/acme-shop/put.txt')).toBe('p')
  expect(w.read(`${ROOT}/put.txt`)).toBe('p')
  expect(w.read('D:\\work\\acme-shop\\missing.txt')).toBeUndefined()
})

test('writes below the snapshot folder fail on request in every spelling, and nothing else does', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  w.failSnapshotWrites = true
  const below = [
    `${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`,
    SNAPS,
    `${SNAPS}/`,
    `${SNAPS}/x`,
  ]
  const bad: string[] = []
  for (const p of below) for (const spelled of spellings(p)) {
    if (JSON.stringify(fs.write({ path: spelled, text: 'z' })) !== JSON.stringify({ deny: 'ENOSPC' })) bad.push(`should fail: ${spelled}`)
  }
  expect(bad).toEqual([])
  // the neighbours of the folder (a sibling whose name starts the same, the parent, the project, the home folder) still write
  const apart = [`${SNAPS}-old/x`, `${HOME}/.claude/kit-safety/snap`, `${HOME}/.claude/kit-safety`, `${ROOT}/y.txt`, `${HOME}/z`, '/snapshots/x', `${ROOT}${SNAPS}/x`]
  for (const p of apart) for (const spelled of spellings(p)) {
    if (JSON.stringify(fs.write({ path: spelled, text: 'z' })) !== JSON.stringify({ value: undefined })) bad.push(`should write: ${spelled}`)
  }
  expect(bad).toEqual([])
  // the refused writes left nothing behind, in any spelling
  expect(w.files.get(`${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`)).toBe('{}')
  expect(w.files.has(`${SNAPS}/x`)).toBe(false)
  expect(w.files.has(`${SNAPS}-old/x`)).toBe(true)
  expect(w.writes.some(p => p.startsWith(`${SNAPS}/`) || p === SNAPS)).toBe(false)
  expect([...w.files.keys()].filter(k => /^[A-Za-z]:|\\/.test(k))).toEqual([])
})

test('underSnaps: the snapshot folder and what is below it, in any spelling, and not a folder that merely starts the same', () => {
  const inside = [SNAPS, `${SNAPS}/`, `${SNAPS}/p`, `${SNAPS}/p/${SNAP_ID}/files/build/a.js`, `${SNAPS}//p`, `D:\\home\\dev\\.claude\\kit-safety\\snapshots`, `d:\\home\\dev\\.claude\\kit-safety\\snapshots\\p\\${SNAP_ID}\\manifest.json`, `D:/home/dev/.claude/kit-safety/snapshots/p`]
  const outside = [HOME, `${HOME}/.claude`, `${HOME}/.claude/kit-safety`, `${SNAPS}-old`, `${SNAPS}-old/x`, `${SNAPS}x/y`, ROOT, `${ROOT}${SNAPS}`, '/', '', 'D:\\home\\dev\\.claude\\kit-safety\\snapshot', 'D:\\home\\dev\\.claude\\kit-safety\\snapshots-old\\x']
  expect(inside.filter(p => !underSnaps(p))).toEqual([])
  expect(outside.filter(p => underSnaps(p))).toEqual([])
})

test('failProjectReads fails reads of the project in every spelling and still reads the snapshot folder', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  w.failProjectReads = true
  const bad: string[] = []
  for (const p of [`${ROOT}/build/a.js`, `${ROOT}/src/app.ts`, `${ROOT}/nope.txt`]) for (const spelled of spellings(p)) {
    if (JSON.stringify(fs.read({ path: spelled, as: 'text' })) !== JSON.stringify({ deny: 'EIO' })) bad.push(`should fail: ${spelled}`)
  }
  for (const p of [`${SNAPS}/acme-shop-1a2b/${SNAP_ID}/manifest.json`, `${SNAPS}/acme-shop-1a2b/${SNAP_ID}/files/build/a.js`]) for (const spelled of spellings(p)) {
    if (!('value' in fs.read({ path: spelled, as: 'text' }))) bad.push(`should read: ${spelled}`)
  }
  expect(bad).toEqual([])
  // stat, exists and list are not reads
  expect(fs.stat({ path: 'D:\\work\\acme-shop\\build\\a.js', resolve: false })).toMatchObject({ value: { kind: 'file' } })
})

test('snapshotIds finds a snapshot written under a Windows spelling, once, oldest first', (_$, on) => {
  const w = world(on)
  const fs = fakeFs(w)
  expect(w.snapshotIds()).toEqual([])
  const dir = (id: string) => `D:\\home\\dev\\.claude\\kit-safety\\snapshots\\acme-shop-1a2b\\${id}`
  fs.write({ path: `${dir('20261124T140600Z')}\\manifest.json`, text: '{}' })
  fs.write({ path: `${dir('20261124T140600Z')}\\files\\build\\a.js`, text: 'a' })
  fs.write({ path: `${dir('20261124T140512Z')}\\manifest.json`, text: '{}' })
  fs.write({ path: 'd:/home/dev/.claude/kit-safety/snapshots/other-project-9f9f/20261123T090000Z/manifest.json', text: '{}' })
  expect(w.snapshotIds()).toEqual(['20261123T090000Z', '20261124T140512Z', '20261124T140600Z'])
  // a file that only looks like one, elsewhere, is no snapshot
  fs.write({ path: 'D:\\work\\acme-shop\\20261124T140512Z\\manifest.json', text: '{}' })
  expect(w.snapshotIds()).toHaveLength(3)
})

test('hostile and odd paths reach the handlers without a throw', (_$, on) => {
  const w = fixture(on)
  const fs = fakeFs(w)
  const long = `D:\\work\\${'acme\\'.repeat(5000)}x`
  const odd = [long, 'D:\\work\\\u202E\\x', 'D:\\work\\a\u0000b', '', 'D:', '\\\\', '//', '.', '..', ' ', '\n', '\u{1F4C1}', undefined as never, 7 as never, null as never]
  const threw: string[] = []
  for (const path of odd) {
    for (const [name, call] of Object.entries({
      stat: () => fs.stat({ path, resolve: false }),
      exists: () => fs.exists({ path }),
      list: () => fs.list({ path }),
      read: () => fs.read({ path, as: 'text' }),
    })) {
      try { call() } catch { threw.push(`${name} ${String(path).slice(0, 20)}`) }
    }
  }
  expect(threw).toEqual([])
  expect(fs.exists({ path: long })).toEqual({ value: false })
})

test('the scripted git and the program runner: a path in any spelling is looked up the same way, and the working directory is recorded as a POSIX path', (_$, on) => {
  const w = fixture(on)
  w.git.isRepo = true
  w.git.head = 'a'.repeat(40)
  w.git.tracked.add('old.txt')
  w.git.tracked.add('src/app.ts')
  w.git.ignored.add('dist/out.js')
  const git = (...args: string[]) => fakeRun(w, { argv: ['git', '-C', 'D:\\work\\acme-shop', ...args], init: { cwd: 'D:\\work\\acme-shop' } })
  const code = (r: ReturnType<typeof git>) => ('value' in r ? r.value.exitCode : r.deny)
  const tracked = (rel: string) => code(git('--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel))
  const ignored = (rel: string) => code(git('check-ignore', '-q', '--', rel))
  // tracked: the way the plugin writes it (relative, with /), with a backslash, and as the absolute path in any spelling
  expect([tracked('old.txt'), tracked('src/app.ts'), tracked('src\\app.ts'), tracked(`${ROOT}/src/app.ts`), tracked('D:\\work\\acme-shop\\src\\app.ts'), tracked('d:/work/acme-shop/old.txt')]).toEqual([0, 0, 0, 0, 0, 0])
  expect([tracked('new.txt'), tracked('src/other.ts'), tracked('src'), tracked(''), tracked('D:\\elsewhere\\old.txt')]).toEqual([1, 1, 1, 1, 1])
  expect([ignored('dist/out.js'), ignored('dist\\out.js'), ignored('D:\\work\\acme-shop\\dist\\out.js')]).toEqual([0, 0, 0])
  expect([ignored('old.txt'), ignored('dist')]).toEqual([1, 1])
  // not a repository: every git call fails the same way
  w.git.isRepo = false
  expect(code(git('rev-parse', '--is-inside-work-tree'))).toBe(128)
  // the working directory the plugin asked for is recorded without drive or backslash; none stays none
  w.runs.length = 0
  fakeRun(w, { argv: ['node', '--version'], init: { cwd: 'D:\\home\\dev\\.claude\\kit-safety\\snapshots' } })
  fakeRun(w, { argv: ['git', '--version'], init: { cwd: `${SNAPS}/` } })
  fakeRun(w, { argv: ['git', '--version'] })
  fakeRun(w, { argv: ['git', '--version'], init: {} })
  fakeRun(w, { argv: ['git', '--version'], init: { cwd: 42 } })
  expect(w.runs.map(r => r.cwd)).toEqual([SNAPS, SNAPS, undefined, undefined, undefined])
  // odd calls never throw
  expect(() => fakeRun(w, {})).not.toThrow()
  expect(() => fakeRun(w, { argv: [] })).not.toThrow()
})

// ---------------------------------------------------------------------------------------------------------------------
// (c) whole flows of the plugin in Windows mode: what the plugin does must not depend on the drive

const MODES = [undefined, 'D:', 'c:'] as const
const modeName = (drive: string | undefined) => (drive === undefined ? 'POSIX' : `Windows ${drive}`)
const SHA = 'a'.repeat(40)

// a folder the guard never counts as an everyday cleanup (a `build/` is made again, so removing it is only saved quietly)
const NOTES = ['a.md', 'b.md', 'c.md']
const notesFolder = (w: World) => NOTES.forEach(n => w.put(`${ROOT}/notes/${n}`, 'xxxxxx'))
const notesFiles = (w: World) => [...w.files.keys()].filter(k => k.startsWith(`${ROOT}/notes/`)).sort()
const NOTES_KEYS = NOTES.map(n => `${ROOT}/notes/${n}`)

/** Nothing may leak a drive or a backslash into what the fake stores, and Windows mode must really have spelled the paths. */
function expectSpelling(w: World, drive: string | undefined, file = 'notes/a.md'): void {
  const keys = [...w.files.keys(), ...w.dirs, ...w.writes]
  expect(keys.filter(k => !k.startsWith('/') || k.includes('\\') || /^[A-Za-z]:/.test(k))).toEqual([])
  if (drive === undefined) {
    expect(w.seen).toEqual([])
    return
  }
  expect(w.seen.length).toBeGreaterThan(0)
  expect(w.seen.filter(p => !p.startsWith(`${drive}\\`) || p.includes('/'))).toEqual([])
  expect(w.seen).toContain(`${drive}\\work\\acme-shop\\${file.replace(/\//g, '\\')}`)
  expect(w.seen.some(p => p.startsWith(`${drive}\\home\\dev\\.claude\\kit-safety\\snapshots\\`))).toBe(true)
}

for (const drive of MODES) {
  const mode = modeName(drive)
  const make = (on: On, more: WorldOptions = {}) => world(on, { ...more, ...(drive === undefined ? {} : { drive }) })

  test(`${mode}: rm -rf is held until Allow, runs, and /safety restore puts the folder back`, async ($, on) => {
    const w = make(on)
    notesFolder(w)
    w.put(`${ROOT}/src/app.ts`, 'keep')
    await begin($, w)
    const call = track(bash($, 'rm -rf notes/'))
    await settle(w)
    expect(call.isDone).toBe(false)
    expect(w.ran).toEqual([])
    expect(notesFiles(w)).toEqual(NOTES_KEYS)
    expect(w.snapshotIds()).toHaveLength(1)
    expect((await bandTexts($)).some(t => t.includes('notes/'))).toBe(true)
    await press($, w, 'allow')
    const out = await call.promise
    expect(w.ran).toEqual([{ tool: 'Bash', input: { command: 'rm -rf notes/' } }])
    expect(notesFiles(w)).toEqual([])
    expect(out).toMatchObject({ result: { stdout: 'ok' }, context: [expect.stringContaining('/safety restore 1')] })
    expect(await bandTexts($)).toEqual([])
    const text = await safety($, 'restore')
    expect(text).toContain('Restored 3 files')
    expect(text).toContain('notes/a.md')
    expect(notesFiles(w)).toEqual(NOTES_KEYS)
    expect(w.read(`${ROOT}/notes/a.md`)).toBe('xxxxxx')
    expect(w.read(`${ROOT}/src/app.ts`)).toBe('keep')
    expect(await safety($, 'list')).toContain('#1')
    expectSpelling(w, drive)
  })

  test(`${mode}: Cancel runs nothing, keeps every file, and the snapshot is still there to restore`, async ($, on) => {
    const w = make(on)
    notesFolder(w)
    await begin($, w)
    const call = track(bash($, 'rm -rf notes/'))
    await settle(w)
    await press($, w, 'cancel')
    expect(await call.promise).toMatchObject({ deny: expect.stringContaining('Nothing was changed') })
    expect(w.ran).toEqual([])
    expect(notesFiles(w)).toEqual(NOTES_KEYS)
    expect(w.snapshotIds()).toHaveLength(1)
    expect(await bandTexts($)).toEqual([])
    expectSpelling(w, drive)
  })

  test(`${mode}: an edit of a tracked file loses nothing, one of an untracked file is saved quietly, and /safety restore puts it back`, async ($, on) => {
    const w = make(on)
    w.git.isRepo = true
    w.git.head = SHA
    w.git.tracked.add('tracked.txt')
    w.put(`${ROOT}/notes.txt`, 'v1')
    w.put(`${ROOT}/tracked.txt`, 'v1')
    await begin($, w, false)
    expect(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/tracked.txt`, old_string: 'v1', new_string: 'v2' } as never)).toMatchObject({ result: { stdout: 'ok' } })
    expect(w.snapshotIds()).toEqual([])
    expect(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/notes.txt`, old_string: 'v1', new_string: 'v2' } as never)).toMatchObject({ result: { stdout: 'ok' } })
    expect(w.snapshotIds()).toHaveLength(1)
    expect(w.asked).toEqual([])
    expect(w.read(`${ROOT}/notes.txt`)).toBe('v2')
    expect(await safety($, 'restore 1')).toContain('Restored 1 file')
    expect(w.read(`${ROOT}/notes.txt`)).toBe('v1')
    // Git has the tracked file's old text, so no snapshot holds it and a restore leaves it alone
    expect(w.read(`${ROOT}/tracked.txt`)).toBe('v2')
    expectSpelling(w, drive, 'notes.txt')
  })

  test(`${mode}: with confirm always, overwriting an untracked file asks first; Allow lets it through; /safety restore and /safety undo move it back and forth`, { options: { confirm: 'always' } }, async ($, on) => {
    const w = make(on)
    w.put(`${ROOT}/plan.txt`, 'A=1\nB=2\n')
    await begin($, w)
    const call = track($.tool.call({ tool: 'Write', file_path: `${ROOT}/plan.txt`, content: 'NEW=1\n' } as never))
    await settle(w)
    expect(call.isDone).toBe(false)
    expect(w.read(`${ROOT}/plan.txt`)).toBe('A=1\nB=2\n')
    expect(w.snapshotIds()).toHaveLength(1)
    await press($, w, 'allow')
    await call.promise
    expect(w.read(`${ROOT}/plan.txt`)).toBe('NEW=1\n')
    expect(await safety($, 'restore')).toContain('Restored 1 file')
    expect(w.read(`${ROOT}/plan.txt`)).toBe('A=1\nB=2\n')
    expect(await safety($, 'undo')).toContain('Undid the last restore')
    expect(w.read(`${ROOT}/plan.txt`)).toBe('NEW=1\n')
    expectSpelling(w, drive, 'plan.txt')
  })

  test(`${mode}: a snapshot that cannot be saved is said on the band, and the question is still asked`, async ($, on) => {
    const w = make(on)
    notesFolder(w)
    w.failSnapshotWrites = true
    await begin($, w)
    const call = track(bash($, 'rm -rf notes/'))
    await settle(w)
    expect((await bandTexts($)).some(t => t.includes('No snapshot could be saved'))).toBe(true)
    expect(w.snapshotIds()).toEqual([])
    await drain($, w)
    await call.promise
    expect(w.ran).toEqual([])
    expect(w.writes.filter(p => p.startsWith(SNAPS))).toEqual([])
    expectSpelling(w, drive)
  })

  test(`${mode}: Node and Git are asked from inside the snapshot folder, and the runs record it as ${SNAPS}`, async ($, on) => {
    const w = make(on, { node: { helperOk: true } })
    notesFolder(w)
    w.dirs.add(SNAPS)
    await begin($, w, false)
    await bash($, 'rm -rf notes/')
    w.runs.length = 0
    await safety($, 'doctor')
    const programs = w.runs.filter(r => r.argv[0] === 'node' || r.argv[0] === 'git')
    expect(programs.length).toBeGreaterThan(0)
    for (const r of programs) expect(r.cwd).toBe(SNAPS)
    for (const r of w.runs) expect(r.cwd).not.toBe(ROOT)
    if (drive !== undefined) expect(w.seen).toContain(`${drive}\\home\\dev\\.claude\\kit-safety\\snapshots`)
    expectSpelling(w, drive)
  })
}

test('Windows mode: another drive letter finds the project and snapshots it too', async ($, on) => {
  const w = world(on, { drive: 'E:' })
  notesFolder(w)
  await begin($, w, false)
  await bash($, 'rm -rf notes/')
  expect(w.seen).toContain('E:\\work\\acme-shop\\notes\\a.md')
  expect(w.snapshotIds()).toHaveLength(1)
  expect(w.snapshotIds()[0]).toMatch(/^[0-9]{8}T[0-9]{6}Z/)
  expectSpelling(w, 'E:')
})
