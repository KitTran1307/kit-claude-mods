import { expect, test } from 'claude-code/testing'

import {
  buildManifest, DEFAULT_KEEP_COUNT, DEFAULT_MAX_BYTES, evictionOrder, formatBytes, formatClock, gitRestoreCommands, gitSafetyRef, globBase,
  hasGlob, isOverwrittenBranchHint, isProjectKey, isSnapshotId, isTipListHint, limitReached, looseRefName, matchGlob, newSnapshotId, nextNumber,
  parseManifest, planPrune, planTotalPrune, projectKey, relUnder, safeCommandText, serializeManifest, snapshotDir, splitGlob, storedPath, summarize,
  totalLimit,
} from './snapshot'
import type { Evictable, Manifest } from './snapshot'

const ID = '20261124T093015Z'
const SHA = 'a'.repeat(64)
const GIT_SHA = 'b'.repeat(40)
const GIT_SHA_2 = 'c'.repeat(40)
const NOW = Date.UTC(2026, 10, 24, 9, 30, 15)
const DAY = 86_400_000

/** A complete, valid manifest. */
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    id: ID,
    n: 7,
    createdAt: NOW,
    root: '/home/user/acme-shop',
    kind: 'before-command',
    tool: 'Bash',
    risks: [{ kind: 'delete', label: 'rm -rf' }],
    targets: ['build'],
    backend: 'node',
    files: [
      { rel: 'build/a.js', size: 100, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: SHA },
      { rel: 'build/sub/b.js', size: 50, mtimeMs: 1_700_000_001_000 },
    ],
    dirs: ['build/empty'],
    skipped: [{ rel: 'build/link', reason: 'symlink' }],
    totalBytes: 150,
    ...over,
  }
}

/** The text of a valid manifest with some fields replaced (raw, so tests can put anything in them). */
function rawWith(over: Record<string, unknown>, base: Manifest = manifest()): string {
  return JSON.stringify({ ...base, ...over })
}

// ---- ids and keys ----

test('isSnapshotId: only the id shape, with an optional -N suffix', () => {
  for (const id of [ID, '20260101T000000Z', '20261231T235959Z', `${ID}-2`, `${ID}-10`, `${ID}-999999`]) expect(isSnapshotId(id), id).toBe(true)
  const bad = ['', 'x', '2026', '20261124', '20261124T093015', '20261124T093015Z-', '20261124T093015Z-0', '20261124T093015Z-01', '20261124T093015Z-1234567',
    '20261124T093015z', '20261124t093015Z', ' 20261124T093015Z', '20261124T093015Z ', '20261124T093015Z\n', '../20261124T093015Z', '20261124T093015Z/..',
    '20261124T093015Z/x', '20261124T093015Z\\x', '20261124T093015Z\0', '２０２６1124T093015Z', 'latest', '..', '.', '2026112T0930150Z']
  for (const id of bad) expect(isSnapshotId(id), JSON.stringify(id)).toBe(false)
  for (const v of [undefined, null, 5, {}, [], [ID], true]) expect(isSnapshotId(v)).toBe(false)
  expect(isSnapshotId('2'.repeat(100_000))).toBe(false)
})

test('projectKey: readable slug, a dash and 14 hex characters', () => {
  const key = projectKey('/home/user/acme-shop')
  expect(key).toMatch(/^acme-shop-[0-9a-f]{14}$/)
  expect(isProjectKey(key)).toBe(true)
})

test('projectKey: stable, so snapshots stay findable (the value is pinned)', () => {
  expect(projectKey('/home/user/acme-shop')).toBe(projectKey('/home/user/acme-shop'))
  expect(projectKey('/home/user/acme-shop')).toBe('acme-shop-db650920f3247c')
  expect(projectKey('C:\\Users\\x\\Acme Shop')).toBe('acme-shop-c05ae40c01fd86')
})

test('projectKey: the whole root matters, not only the folder name', () => {
  const a = projectKey('/home/user/acme-shop')
  const b = projectKey('/work/acme-shop')
  expect(a).not.toBe(b)
  expect(a.slice(0, 10)).toBe(b.slice(0, 10))
  expect(projectKey('/a/b')).not.toBe(projectKey('/a/b/c'))
  expect(projectKey('/home/user/acme-shop')).not.toBe(projectKey('/home/user/acme-shop2'))
})

test('projectKey: spelling of the same folder gives one key (slashes, trailing slash, dots)', () => {
  const key = projectKey('/home/user/acme-shop')
  expect(projectKey('/home/user/acme-shop/')).toBe(key)
  expect(projectKey('/home/user//acme-shop')).toBe(key)
  expect(projectKey('/home/user/./acme-shop')).toBe(key)
  expect(projectKey('/home/user/x/../acme-shop')).toBe(key)
})

test('projectKey: Windows-style roots ignore case and slash direction; POSIX roots keep case', () => {
  const key = projectKey('C:\\Users\\Me\\Acme-Shop')
  expect(projectKey('c:/users/me/acme-shop')).toBe(key)
  expect(projectKey('C:/Users/Me/Acme-Shop/')).toBe(key)
  expect(projectKey('c:\\USERS\\ME\\ACME-SHOP')).toBe(key)
  expect(projectKey('D:\\Users\\Me\\Acme-Shop')).not.toBe(key)
  expect(projectKey('/Home/User/App')).not.toBe(projectKey('/home/user/app'))
})

test('projectKey: the slug is a-z, 0-9 and single dashes, at most 24 characters', () => {
  const slug = (root: string) => projectKey(root).replace(/-[0-9a-f]{14}$/, '')
  expect(slug('/x/My Project (v2)')).toBe('my-project-v2')
  expect(slug('/x/--weird__name--')).toBe('weird-name')
  expect(slug('/x/UPPER.lower.123')).toBe('upper-lower-123')
  expect(slug('/x/Dự án Đà Nẵng')).toBe('du-an-da-nang')
  expect(slug('/x/Crème brûlée')).toBe('creme-brulee')
  expect(slug('/x/日本語')).toBe('project')
  expect(slug('/x/---')).toBe('project')
  expect(slug('/')).toBe('project')
  expect(slug('')).toBe('project')
  expect(slug('C:\\')).toBe('c')
  expect(slug('/x/' + 'a'.repeat(100))).toBe('a'.repeat(24))
  expect(slug('/x/' + 'ab-'.repeat(20))).toBe('ab-ab-ab-ab-ab-ab-ab-ab')
  expect(slug('/x/aaaaaaaaaaaaaaaaaaaaaaa-b')).toBe('aaaaaaaaaaaaaaaaaaaaaaa-b'.slice(0, 24).replace(/-+$/, ''))
  for (const root of ['/x/My Project (v2)', '/x/日本語', '/x/' + 'z'.repeat(500), '/', '', 'C:\\', '/x/a b c d e f g h i j k l m n o p']) {
    expect(isProjectKey(projectKey(root)), root).toBe(true)
    expect(projectKey(root).length).toBeLessThanOrEqual(24 + 1 + 14)
  }
})

test('projectKey never throws and always makes a valid key', () => {
  for (const root of ['\0', '\n', ' ', '..', '../..', '%', '*', '\u202e', '😀', '\\\\server\\share', '//', 'x'.repeat(1_000_000), undefined as unknown as string, null as unknown as string, 5 as unknown as string]) {
    expect(isProjectKey(projectKey(root))).toBe(true)
  }
})

test('isProjectKey accepts only what projectKey makes', () => {
  expect(isProjectKey('acme-shop-0123456789abcd')).toBe(true)
  expect(isProjectKey('a-0123456789abcd')).toBe(true)
  for (const k of ['', 'acme', '-0123456789abcd', 'acme-0123456789abc', 'acme-0123456789abcde', 'ACME-0123456789abcd', 'acme-0123456789ABCD', '../acme-0123456789abcd',
    'acme/x-0123456789abcd', 'acme-shop-0123456789abcd\n', 'a b-0123456789abcd', 'a'.repeat(25) + '-0123456789abcd', 'acme-0123456789abcg', '..', '.']) {
    expect(isProjectKey(k), JSON.stringify(k)).toBe(false)
  }
  expect(isProjectKey(5)).toBe(false)
  expect(isProjectKey(null)).toBe(false)
})

test('newSnapshotId: UTC time, YYYYMMDDTHHMMSSZ', () => {
  expect(newSnapshotId(NOW, [])).toBe(ID)
  expect(newSnapshotId(Date.UTC(2026, 0, 2, 3, 4, 5), [])).toBe('20260102T030405Z')
  expect(newSnapshotId(Date.UTC(2026, 11, 31, 23, 59, 59, 999), [])).toBe('20261231T235959Z')
  expect(newSnapshotId(Date.UTC(1999, 11, 31, 23, 59, 59), [])).toBe('19991231T235959Z')
  expect(newSnapshotId(0, [])).toBe('19700101T000000Z')
  expect(newSnapshotId(Date.UTC(2028, 1, 29, 12, 0, 0), [])).toBe('20280229T120000Z') // a leap day
})

test('newSnapshotId: a taken id gets -2, -3, ... in order', () => {
  expect(newSnapshotId(NOW, [ID])).toBe(`${ID}-2`)
  expect(newSnapshotId(NOW, [ID, `${ID}-2`])).toBe(`${ID}-3`)
  expect(newSnapshotId(NOW, [`${ID}-2`])).toBe(ID)
  expect(newSnapshotId(NOW, [ID, `${ID}-3`])).toBe(`${ID}-2`)
  expect(newSnapshotId(NOW, ['20260101T000000Z', ID])).toBe(`${ID}-2`)
  const many = [ID, ...Array.from({ length: 50 }, (_, i) => `${ID}-${i + 2}`)]
  expect(newSnapshotId(NOW, many)).toBe(`${ID}-52`)
  expect(isSnapshotId(newSnapshotId(NOW, many))).toBe(true)
})

test('newSnapshotId: ids made over time sort in the order they were made', () => {
  const ids: string[] = []
  for (let i = 0; i < 20; i += 1) ids.push(newSnapshotId(NOW + i * 7_000, ids))
  expect([...ids].sort()).toEqual(ids)
  expect(new Set(ids).size).toBe(20)
})

test('newSnapshotId is total: a time that is not a time still gives a valid id', () => {
  for (const t of [NaN, Infinity, -Infinity, -1, -1e18, 1e18, Number.MAX_VALUE, 8.64e15 + 1, undefined as unknown as number, null as unknown as number, '5' as unknown as number]) {
    expect(isSnapshotId(newSnapshotId(t, [])), String(t)).toBe(true)
  }
  expect(newSnapshotId(NaN, [])).toBe('19700101T000000Z')
  expect(newSnapshotId(1e18, [])).toBe('99991231T235959Z')
  expect(isSnapshotId(newSnapshotId(NOW, undefined as unknown as string[]))).toBe(true)
})

test('nextNumber: one more than the highest, 1 for none', () => {
  expect(nextNumber([])).toBe(1)
  expect(nextNumber([{ n: 1 }])).toBe(2)
  expect(nextNumber([{ n: 3 }, { n: 9 }, { n: 4 }])).toBe(10)
  expect(nextNumber([{ n: 0 }])).toBe(1)
  expect(nextNumber([{ n: 7.9 }])).toBe(8)
  expect(nextNumber([{ n: 2 }, { n: 2 }])).toBe(3)
})

test('nextNumber ignores entries that are not numbers and clamps absurd ones', () => {
  expect(nextNumber([{ n: NaN }, { n: -5 }, { n: Infinity }, { n: '9' as unknown as number }, { n: 3 }])).toBe(4)
  expect(nextNumber([{ n: -5 }])).toBe(1)
  expect(nextNumber([{ n: Number.MAX_SAFE_INTEGER }])).toBe(1_000_000_001)
  expect(nextNumber([null as unknown as { n: number }, undefined as unknown as { n: number }, { n: 2 }])).toBe(3)
  expect(nextNumber(undefined as unknown as { n: number }[])).toBe(1)
  expect(nextNumber(Array.from({ length: 100_000 }, (_, i) => ({ n: i })))).toBe(100_000)
})

test('snapshotDir, storedPath, relUnder and gitSafetyRef', () => {
  expect(snapshotDir('/cfg/kit-safety/snapshots', 'acme-0123456789abcd', ID)).toBe(`/cfg/kit-safety/snapshots/acme-0123456789abcd/${ID}`)
  expect(snapshotDir('C:\\cfg\\snapshots\\', 'k', 'i')).toBe('C:/cfg/snapshots/k/i')
  expect(storedPath('/s/k/i', 'build/a.js')).toBe('/s/k/i/files/build/a.js')
  for (const bad of ['../a', '/a', 'a/../b', 'C:\\x', 'a\\b', '', 'a//b', 'a\0b']) expect(storedPath('/s/k/i', bad), bad).toBeNull()
  expect(relUnder('build', 'build')).toBe(true)
  expect(relUnder('build', 'build/a.js')).toBe(true)
  expect(relUnder('build', 'build2/a.js')).toBe(false)
  expect(relUnder('build', 'buil')).toBe(false)
  expect(relUnder('build/a', 'build')).toBe(false)
  expect(gitSafetyRef(ID)).toBe(`refs/kit-safety/${ID}`)
})

// ---- manifest: parse and serialize ----

test('parseManifest reads what serializeManifest wrote, field for field', () => {
  const m = manifest({
    quiet: true,
    risks: [{ kind: 'reset-hard', label: 'git reset --hard', name: 'main' }, { kind: 'delete', label: 'rm -rf' }],
    git: {
      head: 'main', branch: 'main', ref: gitSafetyRef(ID), stashSha: GIT_SHA, isPartial: true,
      branches: [{ name: 'feature/x', sha: GIT_SHA_2 }, { name: 'origin/main', sha: GIT_SHA, remote: true }],
    },
    restoredFrom: '20261123T080000Z',
  })
  expect(parseManifest(serializeManifest(m))).toEqual(m)
  expect(parseManifest(serializeManifest(manifest()))).toEqual(manifest())
  const noOptional = manifest({ files: [], dirs: [], skipped: [], risks: [], targets: [], totalBytes: 0 })
  expect(parseManifest(serializeManifest(noOptional))).toEqual(noOptional)
  expect(parseManifest(serializeManifest(manifest({ backend: 'fs', kind: 'before-restore' })))).toEqual(manifest({ backend: 'fs', kind: 'before-restore' }))
})

test('serializeManifest: fixed key order, 2-space indent, final newline, same text every time', () => {
  const text = serializeManifest(manifest({ git: { head: GIT_SHA, branch: null }, restoredFrom: '20261123T080000Z' }))
  expect(text.endsWith('}\n')).toBe(true)
  expect(text.startsWith('{\n  "v": 1,\n  "id": "' + ID + '",\n')).toBe(true)
  expect(Object.keys(JSON.parse(text))).toEqual(['v', 'id', 'n', 'createdAt', 'root', 'kind', 'tool', 'risks', 'targets', 'backend', 'files', 'dirs', 'skipped', 'totalBytes', 'git', 'restoredFrom'])
  expect(Object.keys(JSON.parse(serializeManifest(manifest({ quiet: true }))))).toEqual(['v', 'id', 'n', 'createdAt', 'root', 'kind', 'tool', 'quiet', 'risks', 'targets', 'backend', 'files', 'dirs', 'skipped', 'totalBytes'])
  expect(Object.keys(JSON.parse(text).files[0])).toEqual(['rel', 'size', 'mtimeMs', 'mode', 'sha256'])
  expect(text).toBe(serializeManifest(manifest({ git: { head: GIT_SHA, branch: null }, restoredFrom: '20261123T080000Z' })))
  // Key order does not depend on how the object was built.
  const ordered = manifest({ restoredFrom: '20261123T080000Z' })
  const shuffled = Object.fromEntries(Object.entries(ordered).reverse()) as Manifest
  expect(Object.keys(shuffled)[0]).toBe('restoredFrom')
  expect(serializeManifest(shuffled)).toBe(serializeManifest(ordered))
})

test('serializeManifest leaves out what is not there and what is not part of the manifest', () => {
  const m = { ...manifest(), extra: 'hostile', command: 'PGPASSWORD=hunter2 psql' } as Manifest & { extra: string }
  const parsed = JSON.parse(serializeManifest(m))
  expect('extra' in parsed).toBe(false)
  expect('command' in parsed).toBe(false) // the command text is never serialized
  expect('quiet' in parsed).toBe(false)
  expect('git' in parsed).toBe(false)
  expect('restoredFrom' in parsed).toBe(false)
  expect(Object.keys(parsed.files[1])).toEqual(['rel', 'size', 'mtimeMs'])
  expect(Object.keys(parsed.risks[0])).toEqual(['kind', 'label'])
})

test('parseManifest: not a manifest at all', () => {
  for (const text of ['', ' ', '{', '[]', 'null', 'true', '5', '"x"', '{}', 'not json', '{"v":1}', '\0', '[[[[', '{"v":1,"id":']) expect(parseManifest(text), JSON.stringify(text)).toBeNull()
  for (const v of [undefined, null, 5, {}, [], true]) expect(parseManifest(v as unknown as string)).toBeNull()
})

test('parseManifest: a wrong version, id, kind, backend, tool, number or time is refused', () => {
  const bad: Record<string, unknown>[] = [
    { v: 2 }, { v: 0 }, { v: '1' }, { v: null }, { v: undefined },
    { id: '' }, { id: '../x' }, { id: '20261124T093015Z/../x' }, { id: '20261124T093015Z\n' }, { id: 5 }, { id: null }, { id: undefined }, { id: `${ID}-0` },
    { kind: 'other' }, { kind: '' }, { kind: 5 }, { kind: undefined },
    { backend: 'cloud' }, { backend: '' }, { backend: undefined },
    { tool: 5 }, { tool: null }, { tool: undefined },
    { n: 'seven' }, { n: null }, { n: undefined }, { n: [7] },
    { createdAt: 'yesterday' }, { createdAt: null }, { createdAt: undefined },
  ]
  for (const over of bad) expect(parseManifest(rawWith(over)), JSON.stringify(over)).toBeNull()
  // Without the key at all (JSON.stringify drops undefined).
  for (const key of ['v', 'id', 'n', 'createdAt', 'root', 'kind', 'tool', 'backend']) {
    const raw = JSON.parse(rawWith({})) as Record<string, unknown>
    delete raw[key]
    expect(parseManifest(JSON.stringify(raw)), key).toBeNull()
  }
})

test('parseManifest: a root that is not an absolute, ordinary folder path is refused', () => {
  const bad = ['', 'relative/path', './x', '../x', '~', '~/x', '/', 'C:\\', 'C:/', 'C:', '\\\\server\\share', '/a/../b', '/a/./b', 'C:\\a\\..\\b', '/a\0b', '/home/x\n', '/home/\u001b[31mx', 'x'.repeat(5000),
    '/' + 'x'.repeat(5000), 5, null, ['/a'], {}, true]
  for (const root of bad) expect(parseManifest(rawWith({ root })), JSON.stringify(root)).toBeNull()
  for (const root of ['/home/user/acme-shop', 'C:\\Users\\x\\acme-shop', 'C:/Users/x/app', '\\\\server\\share\\proj', '/home/user/dự án/my project', '/a', 'D:\\a', '/tmp/..hidden']) {
    expect(parseManifest(rawWith({ root }))?.root, root).toBe(root)
  }
})

test('parseManifest drops every file, folder and target whose path is not a safe relative path', () => {
  const evil = ['../escape', 'a/../../escape', '/etc/passwd', 'C:\\Windows\\x', 'C:/x', 'C:x', 'a\\b', '..\\x', 'a/./b', './a', 'a//b', 'a/', '', '.', '..', 'a\0b', '//server/share/x']
  const files = evil.map(rel => ({ rel, size: 1, mtimeMs: 1 }))
  const m = parseManifest(rawWith({ files: [...files, { rel: 'ok/file.txt', size: 3, mtimeMs: 2 }], dirs: [...evil, 'ok/dir'], targets: [...evil, 'ok'] }))
  expect(m).not.toBeNull()
  expect(m!.files.map(f => f.rel)).toEqual(['ok/file.txt'])
  expect(m!.dirs).toEqual(['ok/dir'])
  expect(m!.targets).toEqual(['ok'])
  // Safe-looking but not strings.
  const odd = parseManifest(rawWith({ files: [{ rel: 5, size: 1, mtimeMs: 1 }, { rel: null, size: 1, mtimeMs: 1 }, { rel: ['a'], size: 1, mtimeMs: 1 }, { rel: { x: 1 }, size: 1, mtimeMs: 1 }], dirs: [5, null, ['a'], {}], targets: [true, 7] }))
  expect(odd!.files).toEqual([])
  expect(odd!.dirs).toEqual([])
  expect(odd!.targets).toEqual([])
  const long = parseManifest(rawWith({ files: [{ rel: 'a/'.repeat(3000) + 'f', size: 1, mtimeMs: 1 }], dirs: ['d/'.repeat(3000)] }))
  expect(long!.files).toEqual([])
  expect(long!.dirs).toEqual([])
})

test('parseManifest: file entries with unusable fields are dropped, sizes and times are clamped', () => {
  const m = parseManifest(rawWith({
    files: [
      { rel: 'a', size: 1.9, mtimeMs: 5.5 },
      { rel: 'b', size: -50, mtimeMs: -1 },
      { rel: 'c', size: 1e30, mtimeMs: 1e30 },
      { rel: 'd', size: 'big', mtimeMs: 1 },
      { rel: 'e', size: 1, mtimeMs: '1' },
      { rel: 'f', size: null, mtimeMs: 1 },
      { rel: 'g', mtimeMs: 1 },
      { rel: 'h', size: 1 },
      'string',
      null,
      7,
      [],
      { rel: 'i', size: 1, mtimeMs: 1, mode: -1 },
      { rel: 'j', size: 1, mtimeMs: 1, mode: 0o10000 },
      { rel: 'k', size: 1, mtimeMs: 1, mode: 1.5 },
      { rel: 'l', size: 1, mtimeMs: 1, mode: '644' },
      { rel: 'm', size: 1, mtimeMs: 1, mode: 0o7777 },
      { rel: 'n', size: 1, mtimeMs: 1, sha256: 'xyz' },
      { rel: 'o', size: 1, mtimeMs: 1, sha256: 'A'.repeat(64) },
      { rel: 'p', size: 1, mtimeMs: 1, sha256: 'a'.repeat(63) },
      { rel: 'q', size: 1, mtimeMs: 1, sha256: 5 },
    ],
  }))
  const by = Object.fromEntries(m!.files.map(f => [f.rel, f]))
  expect(Object.keys(by)).toEqual(['a', 'b', 'c', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q'])
  expect(by.a).toEqual({ rel: 'a', size: 1, mtimeMs: 5.5 })
  expect(by.b).toEqual({ rel: 'b', size: 0, mtimeMs: 0 })
  expect(by.c!.size).toBe(2 ** 50)
  expect(by.c!.mtimeMs).toBe(8.64e15)
  for (const rel of ['i', 'j', 'k', 'l']) expect('mode' in by[rel]!, rel).toBe(false)
  expect(by.m!.mode).toBe(0o7777)
  for (const rel of ['n', 'p', 'q']) expect('sha256' in by[rel]!, rel).toBe(false)
  expect(by.o!.sha256).toBe('a'.repeat(64))
})

test('parseManifest: Infinity from 1e999 is clamped, not trusted', () => {
  const text = '{"v":1,"id":"' + ID + '","n":1e999,"createdAt":1e999,"root":"/a/b","kind":"before-command","tool":"Bash","backend":"node","files":[{"rel":"a","size":1e999,"mtimeMs":-1e999}],"totalBytes":1e999}'
  const m = parseManifest(text)
  expect(m).not.toBeNull()
  expect(m!.n).toBe(1_000_000_000)
  expect(m!.createdAt).toBe(8.64e15)
  expect(m!.files[0]).toEqual({ rel: 'a', size: 2 ** 50, mtimeMs: 0 })
  expect(m!.totalBytes).toBe(2 ** 53 - 1)
})

test('parseManifest: duplicate paths keep the first entry; totalBytes is summed when missing', () => {
  const m = parseManifest(rawWith({
    files: [{ rel: 'a', size: 10, mtimeMs: 1 }, { rel: 'a', size: 99, mtimeMs: 2 }, { rel: 'b', size: 5, mtimeMs: 1 }],
    dirs: ['d', 'd', 'e'],
    targets: ['t', 't'],
    totalBytes: undefined,
  }))
  expect(m!.files).toEqual([{ rel: 'a', size: 10, mtimeMs: 1 }, { rel: 'b', size: 5, mtimeMs: 1 }])
  expect(m!.dirs).toEqual(['d', 'e'])
  expect(m!.targets).toEqual(['t'])
  expect(m!.totalBytes).toBe(15)
  expect(parseManifest(rawWith({ totalBytes: 'many' }))!.totalBytes).toBe(150)
  expect(parseManifest(rawWith({ totalBytes: -4 }))!.totalBytes).toBe(0)
  expect(parseManifest(rawWith({ totalBytes: 12.7 }))!.totalBytes).toBe(12)
})

test('parseManifest: missing lists become empty lists, not failures', () => {
  const raw = JSON.parse(rawWith({})) as Record<string, unknown>
  for (const key of ['risks', 'targets', 'files', 'dirs', 'skipped', 'totalBytes', 'quiet', 'git']) delete raw[key]
  const m = parseManifest(JSON.stringify(raw))
  expect(m).not.toBeNull()
  expect(m!.files).toEqual([])
  expect(m!.dirs).toEqual([])
  expect(m!.targets).toEqual([])
  expect(m!.skipped).toEqual([])
  expect(m!.risks).toEqual([])
  expect(m!.totalBytes).toBe(0)
  expect('quiet' in m!).toBe(false)
  expect('git' in m!).toBe(false)
  const wrong = parseManifest(rawWith({ files: 'x', dirs: {}, targets: 5, skipped: null, risks: 'r' }))
  expect(wrong!.files).toEqual([])
  expect(wrong!.risks).toEqual([])
})

test('parseManifest: the reason private (a .env the text-only backend left out) is known and survives a round trip', () => {
  const m = parseManifest(rawWith({ skipped: [{ rel: 'cfg/.env', reason: 'private' }, { rel: 'cfg/.env.x', reason: 'Private' }, { rel: 'a', reason: 'secret' }] }))
  expect(m!.skipped).toEqual([{ rel: 'cfg/.env', reason: 'private' }])
  const again = parseManifest(serializeManifest(manifest({ skipped: [{ rel: 'cfg/.env', reason: 'private' }, { rel: 'l', reason: 'symlink' }] })))
  expect(again!.skipped).toEqual([{ rel: 'cfg/.env', reason: 'private' }, { rel: 'l', reason: 'symlink' }])
})

test('parseManifest: skipped entries keep a known reason and become display text', () => {
  const m = parseManifest(rawWith({
    skipped: [
      { rel: 'a/link', reason: 'symlink' },
      { rel: 'big.iso', reason: 'too-large' },
      { rel: 'x', reason: 'unknown-reason' },
      { rel: 5, reason: 'symlink' },
      { rel: 'y', reason: 5 },
      { rel: '', reason: 'symlink' },
      { rel: 'line\nbreak\u001b[31m', reason: 'special' },
      { rel: '../outside', reason: 'outside' },
      null,
      'text',
    ],
  }))
  expect(m!.skipped).toEqual([
    { rel: 'a/link', reason: 'symlink' },
    { rel: 'big.iso', reason: 'too-large' },
    { rel: 'line break [31m', reason: 'special' },
    { rel: '../outside', reason: 'outside' }, // display only: never joined to a path
  ])
})

test('parseManifest: risks are cleaned and capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ kind: 'delete', label: `rm ${i}` }))
  const m = parseManifest(rawWith({
    risks: [{ kind: 'delete', label: 'rm -rf', name: 'build', evil: 1 }, { kind: 'x' }, { label: 'y' }, { kind: 5, label: 'z' }, 'junk', null, { kind: 'a\nb', label: 'l\u0007\tm' }, ...many],
  }))
  expect(m!.risks.length).toBe(20)
  expect(m!.risks[0]).toEqual({ kind: 'delete', label: 'rm -rf', name: 'build' })
  expect(m!.risks[1]).toEqual({ kind: 'a b', label: 'l m' })
})

test('parseManifest: text fields become one clean line and are cut', () => {
  const m = parseManifest(rawWith({ tool: 'Bash\n\u0000x' }))
  expect(m!.tool).toBe('Bash x')
  expect(parseManifest(rawWith({ tool: 'x'.repeat(5000) }))!.tool.length).toBe(100)
})

test('parseManifest: an old manifest that still has a command field parses without it (the command text is never kept)', () => {
  for (const command of ['rm -rf build', 'PGPASSWORD=hunter2 psql -h db', 'x'.repeat(5000), '   ', 5, null]) {
    const m = parseManifest(rawWith({ command }))
    expect(m, String(command)).not.toBeNull()
    expect('command' in m!, String(command)).toBe(false)
    expect(JSON.stringify(m)).not.toContain('hunter2')
    expect(serializeManifest(m!)).not.toContain('"command"')
  }
})

test('parseManifest: quiet is kept only when it is true', () => {
  expect(parseManifest(rawWith({ quiet: true }))!.quiet).toBe(true)
  for (const v of [false, 'yes', 1, null, {}]) expect('quiet' in parseManifest(rawWith({ quiet: v }))!, JSON.stringify(v)).toBe(false)
  expect(parseManifest(serializeManifest(manifest({ quiet: true })))!.quiet).toBe(true)
})

test('parseManifest: git facts: head, branch and ref must be plain; a branch name stays when git takes it as a ref', () => {
  const m = parseManifest(rawWith({
    git: {
      head: '-f', branch: 'main', ref: 'refs/kit-safety/x y', stashSha: 'z'.repeat(40),
      branches: [{ name: 'ok', sha: GIT_SHA }, { name: 'bad name', sha: GIT_SHA }, { name: '$(x)', sha: GIT_SHA }, { name: 'ok2', sha: 'short' }, { name: '-D', sha: GIT_SHA }, { name: 'a..b', sha: GIT_SHA }, null, 5],
    },
  }))
  // A branch name is kept when git takes it as a ref (the manifest never prints it); only the strict names are ever printed.
  expect(m!.git).toEqual({ head: null, branch: 'main', branches: [{ name: 'ok', sha: GIT_SHA }, { name: '$(x)', sha: GIT_SHA }] })
  const upper = parseManifest(rawWith({ git: { head: null, branch: null, stashSha: 'ABCDEF'.repeat(6) + 'ABCD', ref: 'refs/kit-safety/' + ID } }))
  expect(upper!.git).toEqual({ head: null, branch: null, ref: `refs/kit-safety/${ID}`, stashSha: ('abcdef'.repeat(6) + 'abcd') })
  expect(parseManifest(rawWith({ git: 'main' }))!.git).toBeUndefined()
  expect(parseManifest(rawWith({ git: [] }))!.git).toBeUndefined()
  expect(parseManifest(rawWith({ git: null }))!.git).toBeUndefined()
  expect(parseManifest(rawWith({ git: { head: 5, branch: {} } }))!.git).toEqual({ head: null, branch: null })
})

test('parseManifest: restoredFrom must be an id', () => {
  expect(parseManifest(rawWith({ restoredFrom: '20261123T080000Z' }))!.restoredFrom).toBe('20261123T080000Z')
  for (const v of ['../x', '', 5, null, 'latest', '20261123T080000Z/..']) expect('restoredFrom' in parseManifest(rawWith({ restoredFrom: v }))!, JSON.stringify(v)).toBe(false)
})

test('parseManifest strips unknown fields everywhere: only known keys come out', () => {
  const raw = JSON.parse(rawWith({})) as Record<string, unknown>
  raw.evil = { deep: true }
  raw.script = '<script>'
  ;(raw.files as Record<string, unknown>[])[0]!.evil = 'x'
  ;(raw.skipped as Record<string, unknown>[])[0]!.evil = 'x'
  raw.git = { head: 'main', branch: 'main', evil: 1, branches: [{ name: 'a', sha: GIT_SHA, evil: 1 }] }
  const m = parseManifest(JSON.stringify(raw))!
  expect(Object.keys(m).sort()).toEqual(['backend', 'createdAt', 'dirs', 'files', 'git', 'id', 'kind', 'n', 'risks', 'root', 'skipped', 'targets', 'tool', 'totalBytes', 'v'].sort())
  expect(Object.keys(m.files[0]!).sort()).toEqual(['mode', 'mtimeMs', 'rel', 'sha256', 'size'])
  expect(Object.keys(m.skipped[0]!).sort()).toEqual(['reason', 'rel'])
  expect(Object.keys(m.git!).sort()).toEqual(['branch', 'branches', 'head'])
  expect(Object.keys(m.git!.branches![0]!).sort()).toEqual(['name', 'sha'])
  expect(JSON.stringify(m)).not.toContain('evil')
})

test('parseManifest: prototype-pollution keys change nothing and are not carried on', () => {
  const text = `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"v":1,"id":"${ID}","n":1,"createdAt":1,"root":"/a/b","kind":"before-command","tool":"Bash","backend":"node",` +
    '"risks":[{"kind":"delete","label":"x","__proto__":{"polluted3":true}}],"targets":["__proto__","constructor","prototype"],' +
    '"files":[{"rel":"__proto__","size":1,"mtimeMs":1,"__proto__":{"polluted4":true},"constructor":{"prototype":{"polluted5":true}}},{"rel":"constructor","size":2,"mtimeMs":1}],' +
    '"dirs":["__proto__/x"],"skipped":[{"rel":"toString","reason":"symlink","__proto__":{"polluted6":true}}],' +
    '"git":{"head":"main","branch":"main","__proto__":{"polluted7":true},"branches":[{"name":"a","sha":"' + GIT_SHA + '","__proto__":{"polluted8":true}}]}}'
  const m = parseManifest(text)
  expect(m).not.toBeNull()
  const probe = {} as Record<string, unknown>
  for (let i = 1; i <= 8; i += 1) expect(probe[i === 1 ? 'polluted' : `polluted${i}`], `polluted${i}`).toBeUndefined()
  expect(probe.polluted2).toBeUndefined()
  expect(Object.getPrototypeOf(m)).toBe(Object.prototype)
  expect(Object.prototype.hasOwnProperty.call(m, '__proto__')).toBe(false)
  expect(JSON.stringify(m)).not.toContain('polluted')
  // Odd but harmless names are ordinary file names.
  expect(m!.files.map(f => f.rel)).toEqual(['__proto__', 'constructor'])
  expect(m!.targets).toEqual(['__proto__', 'constructor', 'prototype'])
  expect(m!.files[0]!.size).toBe(1)
  expect(Object.getPrototypeOf(m!.files[0])).toBe(Object.prototype)
})

test('parseManifest: a byte-order mark in front is tolerated', () => {
  expect(parseManifest('\uFEFF' + serializeManifest(manifest()))).toEqual(manifest())
})

test('parseManifest: 10 MB of text never throws and is answered quickly', () => {
  const started = Date.now()
  expect(parseManifest('x'.repeat(10 * 1024 * 1024))).toBeNull()
  expect(parseManifest('{"v":1,"id":"' + 'a'.repeat(10 * 1024 * 1024) + '"}')).toBeNull()
  expect(parseManifest('['.repeat(1_000_000))).toBeNull()
  expect(parseManifest('{"a":'.repeat(200_000))).toBeNull()
  expect(Date.now() - started).toBeLessThan(5000)
  // A valid manifest whose text fields are huge keeps only the cut text.
  const big = parseManifest(rawWith({ command: 'c'.repeat(10 * 1024 * 1024), tool: 't'.repeat(1024 * 1024) }))
  expect('command' in big!).toBe(false)
  expect(big!.tool.length).toBe(100)
  expect(parseManifest('{"v":1}' + ' '.repeat(65 * 1024 * 1024))).toBeNull() // over the size limit
})

test('parseManifest: a big but valid manifest is read whole, in time; an absurd one is capped', () => {
  const entries = Array.from({ length: 50_000 }, (_, i) => ({ rel: `src/dir${i % 100}/file${i}.txt`, size: i, mtimeMs: 1_700_000_000_000 + i, mode: 0o644, sha256: SHA }))
  const started = Date.now()
  const m = parseManifest(serializeManifest(manifest({ files: entries, totalBytes: 0 })))
  expect(m!.files.length).toBe(50_000)
  expect(m!.files[49_999]!.rel).toBe('src/dir99/file49999.txt')
  expect(Date.now() - started).toBeLessThan(5000)
  const absurd = parseManifest(rawWith({ files: Array.from({ length: 210_000 }, (_, i) => ({ rel: `f${i}`, size: 1, mtimeMs: 1 })) }))
  expect(absurd!.files.length).toBe(200_000)
})

test('buildManifest sorts files and folders and sums the bytes', () => {
  const base = manifest()
  const m = buildManifest(
    { v: 1, id: base.id, n: base.n, createdAt: base.createdAt, root: base.root, kind: base.kind, tool: base.tool, risks: base.risks, targets: base.targets, backend: 'fs' },
    {
      files: [{ rel: 'b/z.txt', size: 5, mtimeMs: 1 }, { rel: 'a.txt', size: 7, mtimeMs: 1 }, { rel: 'b/a.txt', size: 1, mtimeMs: 1 }],
      dirs: ['z', 'a/empty'],
      skipped: [{ rel: 'x', reason: 'unreadable' }],
    },
  )
  expect(m.files.map(f => f.rel)).toEqual(['a.txt', 'b/a.txt', 'b/z.txt'])
  expect(m.dirs).toEqual(['a/empty', 'z'])
  expect(m.totalBytes).toBe(13)
  expect(m.skipped).toEqual([{ rel: 'x', reason: 'unreadable' }])
  expect(m.backend).toBe('fs')
  expect(parseManifest(serializeManifest(m))).toEqual(m)
  const empty = buildManifest({ ...base }, { files: [], dirs: [], skipped: [] })
  expect(empty.totalBytes).toBe(0)
})

test('summarize: the facts a list needs; the label is the first risk, else the tool', () => {
  const s = summarize(manifest())
  expect(s).toEqual({ id: ID, n: 7, createdAt: NOW, kind: 'before-command', files: 2, bytes: 150, label: 'rm -rf', hasGit: false })
  expect(summarize(manifest({ risks: [] })).label).toBe('Bash')
  expect(summarize(manifest({ risks: [{ kind: 'x', label: '' }], tool: 'Write' })).label).toBe('Write')
  expect(summarize(manifest({ risks: [{ kind: 'a', label: 'first' }, { kind: 'b', label: 'second' }] })).label).toBe('first')
  expect(summarize(manifest({ kind: 'before-restore' })).kind).toBe('before-restore')
  expect(summarize(manifest({ git: { head: null, branch: null } })).hasGit).toBe(false)
  // hasGit means gitRestoreCommands has something to offer, which depends on what the call was.
  expect(summarize(manifest({ git: { head: null, branch: null, stashSha: GIT_SHA } })).hasGit).toBe(false)
  expect(summarize(manifest({ git: { head: null, branch: null, stashSha: GIT_SHA }, risks: [{ kind: 'reset-hard', label: 'git reset --hard' }] })).hasGit).toBe(true)
  expect('quiet' in summarize(manifest())).toBe(false)
  expect(summarize(manifest({ quiet: true })).quiet).toBe(true)
  expect(summarize(manifest({ files: [], totalBytes: 0 })).files).toBe(0)
})

// ---- pruning ----

const snap = (id: string, daysAgo: number, kind = 'before-command') => ({ id, createdAt: NOW - daysAgo * DAY, kind })
const opts = (over: Partial<Parameters<typeof planPrune>[1]> = {}) => ({ keepCount: 30, keepDays: 14, nowMs: NOW, ...over })

test('planPrune: nothing to delete when the list is short and recent', () => {
  expect(planPrune([], opts())).toEqual([])
  expect(planPrune([snap('a', 0)], opts())).toEqual([])
  expect(planPrune([snap('a', 0), snap('b', 1), snap('c', 2)], opts())).toEqual([])
})

test('planPrune: everything beyond the newest keepCount goes, oldest first, whatever the input order', () => {
  const list = [snap('s3', 3), snap('s1', 1), snap('s5', 5), snap('s2', 2), snap('s4', 4)]
  expect(planPrune(list, opts({ keepCount: 3 }))).toEqual(['s5', 's4'])
  expect(planPrune(list, opts({ keepCount: 1 }))).toEqual(['s5', 's4', 's3', 's2'])
  expect(planPrune(list, opts({ keepCount: 5 }))).toEqual([])
  expect(planPrune(list, opts({ keepCount: 99 }))).toEqual([])
})

test('planPrune: snapshots older than keepDays go even when there are few; exactly keepDays old stays', () => {
  const list = [snap('new', 0), snap('mid', 10), snap('edge', 14), snap('old', 15), snap('ancient', 400)]
  expect(planPrune(list, opts())).toEqual(['ancient', 'old'])
  expect(planPrune([snap('a', 0), { id: 'late', createdAt: NOW - 14 * DAY - 1 }], opts())).toEqual(['late'])
  expect(planPrune([snap('a', 0), { id: 'edge', createdAt: NOW - 14 * DAY }], opts())).toEqual([])
  expect(planPrune(list, opts({ keepDays: 30 }))).toEqual(['ancient'])
  expect(planPrune(list, opts({ keepDays: 1000 }))).toEqual([])
})

test('planPrune: age beats "the newest": a snapshot older than keepDays goes even when it is the only or the newest one', () => {
  expect(planPrune([snap('only', 999)], opts({ keepCount: 1, keepDays: 1 }))).toEqual(['only'])
  expect(planPrune([snap('a', 999), snap('b', 1000)], opts({ keepCount: 1, keepDays: 1 }))).toEqual(['b', 'a'])
  expect(planPrune([snap('a', 50), snap('b', 60)], opts({ keepCount: 5, keepDays: 1 }))).toEqual(['b', 'a'])
  // Only protectIds are exempt from the age rule.
  expect(planPrune([snap('a', 999), snap('b', 1000)], opts({ keepCount: 1, keepDays: 1, protectIds: ['a'] }))).toEqual(['b'])
})

test('planPrune: the count rule alone never takes the newest snapshot (keepCount is at least 1)', () => {
  const list = [snap('s1', 1), snap('s2', 2), snap('s3', 3)]
  for (const keepCount of [0, -5, 1]) expect(planPrune(list, opts({ keepCount })), String(keepCount)).toEqual(['s3', 's2'])
})

const quiet = (id: string, daysAgo: number) => ({ id, createdAt: NOW - daysAgo * DAY, kind: 'before-command', quiet: true })

// Changed from "quiet snapshots have a count of their own" (separate caps): one count for both kinds, the quiet ones go first.
test('planPrune: quiet and asked snapshots share one count; over it, the quiet ones go first (oldest first), then the asked ones', () => {
  // 22 quiet edits made after one `rm -rf build`: 23 snapshots, keepCount 20: the three oldest QUIET ones go, rm-build stays.
  const list = [snap('rm-build', 3), ...Array.from({ length: 22 }, (_, i) => quiet(`q${String(i).padStart(2, '0')}`, 0.001 * (i + 1)))]
  const doomed = planPrune(list, opts({ keepCount: 20 }))
  expect(doomed).toEqual(['q21', 'q20', 'q19'])
  expect(doomed).not.toContain('rm-build')
  // 22 asked-about snapshots and one quiet one: the quiet one goes first, then the oldest asked one.
  const others = Array.from({ length: 22 }, (_, i) => snap(`a${String(i).padStart(2, '0')}`, 0.001 * (i + 1)))
  expect(planPrune([...others, quiet('q', 0)], opts({ keepCount: 20 }))).toEqual(['a21', 'a20', 'q'])
  // 22 + 22: 44 snapshots against 20: all 22 quiet ones go, then the two oldest asked ones (the answer is oldest first).
  const both = [...others, ...Array.from({ length: 22 }, (_, i) => quiet(`q${String(i).padStart(2, '0')}`, 0.001 * (i + 1) + 0.0005))]
  const goes = planPrune(both, opts({ keepCount: 20 }))
  expect(goes).toHaveLength(24)
  expect(goes.filter(id => id.startsWith('q'))).toHaveLength(22)
  expect(goes.filter(id => id.startsWith('a')).sort()).toEqual(['a20', 'a21'])
  expect(both.length - goes.length).toBe(20)
})

test('planPrune: the exact eviction order is quiet oldest first, then asked oldest first', () => {
  // newest first: s1 q1 s2 q2 s3 q3 (days 1..6); keepCount 2 evicts four: q3 q2 q1 (quiet, oldest first) then s3 (asked, oldest).
  const list = [snap('s1', 1), quiet('q1', 2), snap('s2', 3), quiet('q2', 4), snap('s3', 5), quiet('q3', 6)]
  // The answer is ordered by age, oldest first, whatever the order they were chosen in.
  expect(planPrune(list, opts({ keepCount: 2 }))).toEqual(['q3', 's3', 'q2', 'q1'])
  expect(planPrune(list, opts({ keepCount: 3 }))).toEqual(['q3', 'q2', 'q1'])
  expect(planPrune(list, opts({ keepCount: 4 }))).toEqual(['q3', 'q2'])
  // Only what is over the count is evicted, and the oldest QUIET one goes, not the oldest overall (which is an asked one here).
  const oldAsked = [quiet('q1', 1), snap('s1', 2), quiet('q2', 3), snap('s2', 4), snap('s3', 5), snap('s-oldest', 6)]
  expect(planPrune(oldAsked, opts({ keepCount: 5 }))).toEqual(['q2'])
  expect(planPrune(oldAsked, opts({ keepCount: 4 }))).toEqual(['q2', 'q1'])
  expect(planPrune(oldAsked, opts({ keepCount: 3 }))).toEqual(['s-oldest', 'q2', 'q1'])
  // No quiet ones: the oldest asked ones go, as always.
  expect(planPrune([snap('a', 1), snap('b', 2), snap('c', 3)], opts({ keepCount: 1 }))).toEqual(['c', 'b'])
  // Only quiet ones: the oldest of them go.
  expect(planPrune([quiet('a', 1), quiet('b', 2), quiet('c', 3)], opts({ keepCount: 1 }))).toEqual(['c', 'b'])
})

test('planPrune: the age rule is applied first and keeps beating everything but protectIds; the count only looks at what age left', () => {
  // Two old quiet ones are gone by age; the count (3 live against 3) then has nothing to evict.
  const list = [snap('s1', 1), quiet('q1', 2), snap('s2', 3), quiet('old1', 20), quiet('old2', 30)]
  expect(planPrune(list, opts({ keepCount: 3 }))).toEqual(['old2', 'old1'])
  expect(planPrune(list, opts({ keepCount: 3, protectIds: ['old1'] }))).toEqual(['old2'])
  // A new quiet snapshot (protected, as createSnapshot does) is never evicted even when it is the only quiet one.
  const next = [snap('a', 1), snap('b', 2), snap('c', 3), quiet('new', 0)]
  expect(planPrune(next, opts({ keepCount: 3, protectIds: ['new'] }))).toEqual(['c'])
  expect(planPrune(next, opts({ keepCount: 3 }))).toEqual(['new'])
})

test('planPrune: protected ones take their place in the count but are never evicted, even when that leaves more than keepCount', () => {
  const list = [snap('s1', 1), snap('s2', 2), quiet('q1', 3), snap('s3', 4)]
  // keepCount 2: s3 and q1 are over; q1 is protected, so only s3 goes (the quiet-first rule cannot take a protected one).
  expect(planPrune(list, opts({ keepCount: 2, protectIds: ['q1'] }))).toEqual(['s3'])
  // Both over-the-count ones protected: nothing to evict.
  expect(planPrune(list, opts({ keepCount: 2, protectIds: ['q1', 's3'] }))).toEqual([])
  // A quiet snapshot inside the count is still evicted first when something older is over it and unprotected.
  expect(planPrune(list, opts({ keepCount: 3, protectIds: [] }))).toEqual(['q1'])
})

// Changed from separate caps: with keepCount 1 the answer was ['s-old', 'q-old', 'undo'] (the newest quiet and the newest asked
// one both stayed); one count keeps one snapshot, the newest asked one, and the quiet ones go before the asked ones. With `undo`
// protected the answer was ['s-old', 'q-old'] at keepCount 1; the same idea at keepCount 2 is asserted below.
test('planPrune: quiet snapshots are bounded by keepDays like the others; before-restore counts with the others; the answer is oldest first', () => {
  const list = [quiet('q-new', 0), quiet('q-old', 20), snap('s-old', 30), snap('s-new', 1), { id: 'undo', createdAt: NOW - 2 * DAY, kind: 'before-restore' }]
  expect(planPrune(list, opts())).toEqual(['s-old', 'q-old'])
  // keepCount 1, no age: four go, quiet ones first (q-old, q-new), then asked oldest first (s-old, undo); s-new (newest asked) stays.
  expect(planPrune(list, opts({ keepCount: 1, keepDays: 1000 }))).toEqual(['s-old', 'q-old', 'undo', 'q-new'])
  // `undo` protected, keepCount 2: the two places go to q-new and s-new, `undo` (third) and the two older ones are over the count;
  // `undo` stays, so two evictions are due, and quiet comes first: q-old and q-new. (Three snapshots stay: s-new, undo, s-old.)
  expect(planPrune(list, opts({ keepCount: 2, keepDays: 1000, protectIds: ['undo'] }))).toEqual(['q-old', 'q-new'])
  // `quiet` must be exactly true to count as quiet.
  const odd = [snap('x1', 1), { ...snap('x2', 2), quiet: 'yes' as unknown as boolean }, { ...snap('x3', 3), quiet: false }]
  expect(planPrune(odd, opts({ keepCount: 1 }))).toEqual(['x3', 'x2'])
})

test('planPrune: protected ids stay, even the oldest and even beyond the limits', () => {
  const list = [snap('s1', 1), snap('s2', 2), snap('s3', 3), snap('old', 300), snap('older', 301)]
  expect(planPrune(list, opts({ keepCount: 2, protectIds: ['old'] }))).toEqual(['older', 's3'])
  expect(planPrune(list, opts({ keepCount: 1, protectIds: ['s2', 's3', 'old', 'older'] }))).toEqual([])
  expect(planPrune(list, opts({ keepCount: 2, protectIds: ['no-such-id'] }))).toEqual(['older', 'old', 's3'])
  expect(planPrune(list, opts({ keepCount: 2, protectIds: [] }))).toEqual(['older', 'old', 's3'])
  expect(planPrune(list, opts({ keepCount: 2, protectIds: undefined }))).toEqual(['older', 'old', 's3'])
})

test('planPrune: a keepCount or keepDays below 1 counts as 1', () => {
  const list = [snap('s1', 0), snap('s2', 0.5), snap('s3', 3)]
  for (const keepCount of [0, -1, -100, 0.5, 0.99, -Infinity]) expect(planPrune(list, opts({ keepCount })), String(keepCount)).toEqual(['s3', 's2'])
  for (const keepDays of [0, -1, -100, 0.5, -Infinity]) expect(planPrune(list, opts({ keepDays })), String(keepDays)).toEqual(['s3'])
  expect(planPrune(list, opts({ keepCount: 2.9 }))).toEqual(['s3']) // floored to 2
})

test('planPrune: a number that is not a number falls back to the default; Infinity keeps everything', () => {
  const many = Array.from({ length: DEFAULT_KEEP_COUNT + 5 }, (_, i) => snap(`s${String(i).padStart(3, '0')}`, i * 0.01))
  expect(planPrune(many, opts({ keepCount: NaN })).length).toBe(5)
  expect(planPrune(many, opts({ keepCount: undefined as unknown as number })).length).toBe(5)
  expect(planPrune(many, opts({ keepCount: '3' as unknown as number })).length).toBe(5)
  expect(planPrune([snap('a', 0), snap('b', 13), snap('c', 15)], opts({ keepDays: NaN }))).toEqual(['c'])
  expect(planPrune(many, opts({ keepCount: Infinity }))).toEqual([])
  expect(planPrune([snap('a', 0), snap('b', 5000)], opts({ keepDays: Infinity }))).toEqual([])
})

test('planPrune: an nowMs that is not a time turns the age rule off, the count rule stays', () => {
  const list = [snap('a', 0), snap('b', 500), snap('c', 900)]
  expect(planPrune(list, opts({ nowMs: NaN }))).toEqual([])
  expect(planPrune(list, opts({ nowMs: NaN, keepCount: 2 }))).toEqual(['c'])
  expect(planPrune(list, opts({ nowMs: Infinity }))).toEqual([])
  expect(planPrune(list, opts({ nowMs: undefined as unknown as number }))).toEqual([])
})

test('planPrune: equal times are ordered by id (the later id is newer); duplicates count once', () => {
  const same = [{ id: '20261124T093015Z', createdAt: NOW }, { id: '20261124T093015Z-2', createdAt: NOW }, { id: '20261124T093015Z-3', createdAt: NOW }]
  expect(planPrune(same, opts({ keepCount: 1 }))).toEqual(['20261124T093015Z', '20261124T093015Z-2'])
  expect(planPrune([snap('a', 0), snap('a', 0), snap('b', 1)], opts({ keepCount: 5 }))).toEqual([])
  expect(planPrune([snap('a', 0), snap('b', 1), snap('b', 1), snap('c', 2)], opts({ keepCount: 2 }))).toEqual(['c'])
  expect(planPrune([snap('a', 1), snap('a', 0), snap('b', 0.5)], opts({ keepCount: 1 }))).toEqual(['b'])
})

test('planPrune: bad entries and bad lists are ignored, the input is not changed', () => {
  expect(planPrune(undefined as unknown as [], opts())).toEqual([])
  expect(planPrune('x' as unknown as [], opts())).toEqual([])
  const messy = [snap('a', 0), null, undefined, { id: 5, createdAt: NOW }, { createdAt: NOW }, { id: 'nan', createdAt: NaN }, { id: 'str', createdAt: 'x' }, snap('b', 1)] as { id: string; createdAt: number }[]
  const before = JSON.stringify(messy)
  expect(planPrune(messy, opts({ keepCount: 2 }))).toEqual(['nan', 'str'])
  expect(JSON.stringify(messy)).toBe(before)
  expect(planPrune([snap('a', 0), snap('b', 1)], undefined as unknown as Parameters<typeof planPrune>[1])).toEqual([])
  const list = [snap('s2', 2), snap('s1', 1)]
  planPrune(list, opts({ keepCount: 1 }))
  expect(list.map(s => s.id)).toEqual(['s2', 's1'])
})

test('planPrune: kind does not change the plan; a large list is planned fast', () => {
  const a = [snap('x', 0, 'before-restore'), snap('y', 1, 'before-command'), snap('z', 2, 'before-restore')]
  expect(planPrune(a, opts({ keepCount: 1 }))).toEqual(['z', 'y'])
  const big = Array.from({ length: 50_000 }, (_, i) => snap(`id${i}`, i / 1000))
  const started = Date.now()
  const doomed = planPrune(big, opts({ keepCount: 100, keepDays: 1000 }))
  expect(doomed.length).toBe(49_900)
  expect(doomed[0]).toBe('id49999')
  expect(Date.now() - started).toBeLessThan(3000)
})

// ---- the total cap ----

const held = (id: string, daysAgo: number, bytes: number, locked?: boolean): Evictable => ({ id, createdAt: NOW - daysAgo * DAY, bytes, ...(locked === undefined ? {} : { locked }) })

test('totalLimit: a positive finite number is a cap (whole bytes, at least 1); anything else is no cap', () => {
  expect(totalLimit(1)).toBe(1)
  expect(totalLimit(2048 * 1024 * 1024)).toBe(2048 * 1024 * 1024)
  expect(totalLimit(1.9)).toBe(1)
  expect(totalLimit(0.5)).toBe(1)
  for (const v of [undefined, null, 0, -1, -0.5, NaN, Infinity, -Infinity, '5', {}, [], true]) expect(totalLimit(v), String(v)).toBeUndefined()
})

test('evictionOrder: the ones that may go, oldest first, ties by id; locked ones and bad entries are left out; the input is not changed', () => {
  const list = [held('c', 1, 1), held('a', 3, 1), held('b', 2, 1, true), held('d', 3, 1), held('e', 5, 1, false)]
  expect(evictionOrder(list).map(e => e.id)).toEqual(['e', 'a', 'd', 'c'])
  expect(list.map(e => e.id)).toEqual(['c', 'a', 'b', 'd', 'e'])
  expect(evictionOrder([null, undefined, 5, { id: 5 }, { createdAt: 1 }, held('ok', 1, 1)] as unknown as Evictable[]).map(e => e.id)).toEqual(['ok'])
  expect(evictionOrder(undefined as unknown as Evictable[])).toEqual([])
  expect(evictionOrder('x' as unknown as Evictable[])).toEqual([])
  expect(evictionOrder([])).toEqual([])
  // A time that is not a time counts as the oldest (0), like in planPrune.
  expect(evictionOrder([held('t', 1, 1), { id: 'nan', createdAt: NaN, bytes: 1 }]).map(e => e.id)).toEqual(['nan', 't'])
})

test('planTotalPrune: the oldest overall go, no more than needed; at most the cap stays', () => {
  const list = [held('s1', 1, 100), held('s2', 2, 100), held('s3', 3, 100), held('s4', 4, 100), held('s5', 5, 100)]
  expect(planTotalPrune(list, 1000).map(e => e.id)).toEqual([])
  expect(planTotalPrune(list, 500).map(e => e.id)).toEqual([])
  expect(planTotalPrune(list, 499).map(e => e.id)).toEqual(['s5'])
  expect(planTotalPrune(list, 400).map(e => e.id)).toEqual(['s5'])
  expect(planTotalPrune(list, 399).map(e => e.id)).toEqual(['s5', 's4'])
  expect(planTotalPrune(list, 100).map(e => e.id)).toEqual(['s5', 's4', 's3', 's2'])
  // Whatever the order of the list.
  expect(planTotalPrune([...list].reverse(), 300).map(e => e.id)).toEqual(['s5', 's4'])
})

test('planTotalPrune: sizes differ, so the number removed does too; the first removal that gets under the cap is the last', () => {
  const list = [held('new', 1, 10), held('mid', 2, 500), held('old', 3, 20), held('oldest', 4, 1000)]
  expect(planTotalPrune(list, 600).map(e => e.id)).toEqual(['oldest'])
  expect(planTotalPrune(list, 529).map(e => e.id)).toEqual(['oldest', 'old'])
  expect(planTotalPrune(list, 29).map(e => e.id)).toEqual(['oldest', 'old', 'mid'])
})

test('planTotalPrune: locked ones count toward the total but are never in the plan; a cap below what they take removes every other one and stops', () => {
  const list = [held('keep-new', 1, 100, true), held('a', 2, 100), held('keep-old', 6, 100, true), held('b', 4, 100), held('c', 5, 100)]
  expect(planTotalPrune(list, 400).map(e => e.id)).toEqual(['c'])
  expect(planTotalPrune(list, 350).map(e => e.id)).toEqual(['c', 'b'])
  expect(planTotalPrune(list, 250).map(e => e.id)).toEqual(['c', 'b', 'a'])
  expect(planTotalPrune(list, 1).map(e => e.id)).toEqual(['c', 'b', 'a'])
  expect(planTotalPrune([held('only', 1, 500, true)], 1)).toEqual([])
  expect(planTotalPrune([held('newest', 1, 500)], 1).map(e => e.id)).toEqual(['newest']) // nobody locked it: the caller locks the newest
})

test('planTotalPrune: no cap, or a cap that is not a number, plans nothing; odd lists and sizes are survived', () => {
  const list = [held('a', 1, 100), held('b', 2, 100)]
  for (const cap of [undefined, 0, -1, NaN, Infinity, '1' as unknown as number, null as unknown as number]) expect(planTotalPrune(list, cap), String(cap)).toEqual([])
  expect(planTotalPrune(undefined as unknown as Evictable[], 10)).toEqual([])
  expect(planTotalPrune([], 10)).toEqual([])
  // A size that is not a number (or is negative) weighs nothing, but it is still taken in its turn (oldest first).
  const odd = [{ id: 'x', createdAt: NOW, bytes: NaN }, { id: 'y', createdAt: NOW - DAY, bytes: -5 }, { id: 'z', createdAt: NOW - 2 * DAY, bytes: Infinity }, held('real', 1, 100)] as Evictable[]
  expect(planTotalPrune(odd, 50).map(e => e.id)).toEqual(['z', 'real'])
  expect(planTotalPrune(odd, 1_000_000)).toEqual([])
})

test('planTotalPrune: it returns the entries themselves (so a caller can map them back), and a large list is planned fast', () => {
  const list = [held('a', 1, 100), held('b', 2, 100)]
  expect(planTotalPrune(list, 100)[0]).toBe(list[1])
  const big = Array.from({ length: 100_000 }, (_, i) => held(`id${i}`, i / 1000, 10))
  const started = Date.now()
  const plan = planTotalPrune(big, 10 * 1000)
  expect(plan.length).toBe(99_000)
  expect(plan[0]?.id).toBe('id99999')
  expect(Date.now() - started).toBeLessThan(3000)
})

// ---- globs ----

test('matchGlob: the pattern table', () => {
  const table: [string, string, boolean][] = [
    // star
    ['*', 'a', true], ['*', 'file.txt', true], ['*.log', 'a.log', true], ['*.log', 'a.logx', false], ['*.log', 'log', false], ['*.log', 'a.log.gz', false],
    ['a*', 'a', true], ['a*', 'abc', true], ['a*', 'ba', false], ['*a', 'ba', true], ['*a', 'ab', false], ['*a*', 'bab', true], ['*a*', 'bbb', false],
    ['a*b*c', 'aXbYc', true], ['a*b*c', 'abc', true], ['a*b*c', 'aXbY', false], ['a*b*c', 'cba', false], ['a**b', 'ab', true], ['a**b', 'aXb', true],
    ['*.tar.gz', 'x.tar.gz', true], ['*.tar.gz', 'x.tar.gzz', false], ['build*', 'build', true], ['build*', 'build-2', true], ['build*', 'rebuild', false],
    ['*-*', 'a-b', true], ['*-*', 'ab', false],
    // question mark
    ['?', 'a', true], ['?', 'ab', false], ['??', 'ab', true], ['a?c', 'abc', true], ['a?c', 'ac', false], ['a?c', 'abbc', false], ['?.txt', 'a.txt', true], ['?.txt', '.txt', false],
    // sets
    ['[abc]x', 'ax', true], ['[abc]x', 'cx', true], ['[abc]x', 'dx', false], ['[abc]', 'ab', false],
    ['[a-c]x', 'bx', true], ['[a-c]x', 'dx', false], ['[a-c]x', 'Bx', false], ['[A-Z]*', 'Zed', true], ['[a-z]*', 'Zed', false],
    ['[0-9]', '7', true], ['[0-9]', 'a', false], ['file[0-9].txt', 'file7.txt', true], ['file[0-9].txt', 'file77.txt', false], ['file[0-9][0-9]', 'file7', false],
    ['[!a-c]x', 'dx', true], ['[!a-c]x', 'bx', false], ['[!x]', 'y', true], ['[!x]', 'x', false], ['[^a]', 'b', true], ['[^a]', 'a', false],
    ['[a-]', '-', true], ['[a-]', 'a', true], ['[a-]', 'b', false], ['[-a]', '-', true], ['[a-c-e]', '-', true], ['[a-c-e]', 'e', true], ['[a-c-e]', 'd', false],
    ['[]a]', ']', true], ['[]a]', 'a', true], ['[]a]', 'b', false], ['[!]a]', 'b', true], ['[!]a]', ']', false],
    ['[a-cx-z]', 'y', true], ['[a-cx-z]', 'm', false], ['[z-a]', 'm', false], ['[z-a]', 'z', false],
    ['[*]', '*', true], ['[*]', 'a', false], ['[?]', '?', true], ['[?]', 'a', false],
    // a bracket with no closing one is an ordinary character
    ['a[', 'a[', true], ['[abc', '[abc', true], ['[abc', 'a', false], ['[', '[', true], ['[]', '[]', true], ['a[b', 'a[b', true],
    // literals and case
    ['build', 'build', true], ['build', 'Build', false], ['build', 'builds', false], ['*.TXT', 'a.txt', false], ['*.txt', 'a.TXT', false], ['', 'a', false],
    ['.', '.', true], ['a.b', 'a.b', true], ['a.b', 'aXb', false], ['a+b', 'a+b', true], ['(a)', '(a)', true], ['a|b', 'a', false], ['a b', 'a b', true], ['^a$', 'a', false], ['\\*', '*', false],
    // unicode: a character is one character
    ['*', '日本語', true], ['?', '日', true], ['???', '日本語', true], ['??', '日本語', false], ['?', '😀', true], ['??', '😀', false], ['[日-本]', '日', true], ['*語', '日本語', true],
    ['dự*', 'dự án', true], ['[à-ý]', 'é', true], ['[à-ý]', 'ễ', false],
    // a name is one path segment
    ['*.js', 'a/b.js', false], ['*', 'a/b', false], ['a/b', 'a/b', false],
  ]
  for (const [pattern, name, want] of table) expect(matchGlob(pattern, name), `${JSON.stringify(pattern)} vs ${JSON.stringify(name)}`).toBe(want)
})

test('matchGlob: like a shell, a name that starts with a dot needs a pattern that starts with a dot', () => {
  const table: [string, string, boolean][] = [
    ['*', '.env', false], ['*', '.git', false], ['?env', '.env', false], ['*env', '.env', false], ['*.local', '.env.local', false], ['[.]env', '.env', false],
    ['[!a]env', '.env', false], ['*', '..', false],
    ['.*', '.env', true], ['.*', '.', true], ['.*', 'env', false], ['.env*', '.env.local', true], ['.env', '.env', true], ['.env', 'env', false], ['.git*', '.github', true],
    ['.?nv', '.env', true], ['.[a-z]*', '.env', true], ['*', 'env', true], ['*.env', 'a.env', true], ['a.*', 'a.env', true], ['*', 'a.hidden', true],
  ]
  for (const [pattern, name, want] of table) expect(matchGlob(pattern, name), `${JSON.stringify(pattern)} vs ${JSON.stringify(name)}`).toBe(want)
  // With dotfiles on, a wildcard matches them too.
  const withDots: [string, string, boolean][] = [['*', '.env', true], ['*', '.git', true], ['?env', '.env', true], ['*env', '.env', true], ['[.]env', '.env', true], ['*.local', '.env.local', true], ['x*', '.env', false]]
  for (const [pattern, name, want] of withDots) expect(matchGlob(pattern, name, { dotfiles: true }), `${JSON.stringify(pattern)} vs ${JSON.stringify(name)} (dotfiles)`).toBe(want)
  expect(matchGlob('*', '.env', { dotfiles: false })).toBe(false)
  expect(matchGlob('*', '.env', {})).toBe(false)
})

test('matchGlob never throws, handles hostile patterns without blowing up, and refuses huge input', () => {
  const started = Date.now()
  expect(matchGlob('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false)
  expect(matchGlob('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000) + 'b')).toBe(true)
  expect(matchGlob('*'.repeat(5000) + 'x', 'y'.repeat(5000))).toBe(false)
  expect(matchGlob('?*'.repeat(2000), 'z'.repeat(4000))).toBe(true)
  expect(matchGlob('[a-z]*'.repeat(500) + '!', 'abc'.repeat(1000))).toBe(false)
  expect(Date.now() - started).toBeLessThan(3000)
  expect(matchGlob('*', 'x'.repeat(10_000))).toBe(false) // longer than any file name
  expect(matchGlob('x'.repeat(10_000), 'x')).toBe(false)
  for (const [p, n] of [['', ''], ['*', ''], ['[', ''], ['\0', '\0'], ['[\0-\u0001]', '\0'], ['\u{1F600}*', '\u{1F600}x'], ['*', '\ud800'], ['[\ud800-\udfff]', '\ud800']] as [string, string][]) {
    expect(typeof matchGlob(p, n)).toBe('boolean')
  }
  expect(matchGlob(5 as unknown as string, 'a')).toBe(false)
  expect(matchGlob('a', undefined as unknown as string)).toBe(false)
  expect(matchGlob('a', 'a', null as unknown as { dotfiles?: boolean })).toBe(true)
})

test('hasGlob: a wildcard is *, ? or a complete [...]', () => {
  for (const p of ['*', '*.js', 'a/*', 'build/*/x', 'a?', '?', '[ab]', 'x[0-9]y', '[!a]', '[]a]', 'C:\\x\\*.tmp', '$HOME/*', '~/dir/*.log', '.*', 'src/**/x']) expect(hasGlob(p), p).toBe(true)
  for (const p of ['', 'a', 'a/b', 'build/', './x', '../x', '~/dir', '[', 'a[b', 'a]', '[]', ']', 'a[', 'a[]b', 'file.txt', 'C:\\Users\\x', '日本語', 'a b', '$HOME']) expect(hasGlob(p), p).toBe(false)
  expect(hasGlob(5 as unknown as string)).toBe(false)
  expect(hasGlob('*'.repeat(10_000))).toBe(false) // over the size limit: not a path
})

test('globBase and splitGlob: the part before the first wildcard segment', () => {
  const table: [string, string, string[]][] = [
    ['build/*.js', 'build', ['*.js']],
    ['*.js', '.', ['*.js']],
    ['./*.js', '.', ['*.js']],
    ['../*.js', '..', ['*.js']],
    ['/tmp/*', '/tmp', ['*']],
    ['/*', '/', ['*']],
    ['/a/b/*/c/d*', '/a/b', ['*', 'c', 'd*']],
    ['a/b*/c/d*', 'a', ['b*', 'c', 'd*']],
    ['~/proj/*/dist', '~/proj', ['*', 'dist']],
    ['src/**/x', 'src', ['**', 'x']],
    ['C:\\x\\*.tmp', 'C:/x', ['*.tmp']],
    ['C:\\*', 'C:/', ['*']],
    ['C:/Users/me/*/cache', 'C:/Users/me', ['*', 'cache']],
    ['\\\\server\\share\\*', '//server/share', ['*']],
    ['build/*/', 'build', ['*']],
    ['dir with space/file ?.txt', 'dir with space', ['file ?.txt']],
    ['a/[ab]/c', 'a', ['[ab]', 'c']],
    ['a/[ab/c', 'a/[ab/c', []], // no complete set: no wildcard at all
    ['a/b/c', 'a/b/c', []],
    ['plain.txt', 'plain.txt', []],
  ]
  for (const [path, base, segments] of table) {
    expect(splitGlob(path), path).toEqual({ base, segments })
    expect(globBase(path), path).toBe(base)
  }
  expect(globBase(5 as unknown as string)).toBe('.')
  expect(splitGlob(undefined as unknown as string)).toEqual({ base: '.', segments: [] })
})

// ---- formatting ----

test('formatBytes: B below 1 KB, one decimal below 10, none from 10 up', () => {
  const table: [number, string][] = [
    [0, '0 B'], [1, '1 B'], [512, '512 B'], [999, '999 B'], [1000, '1000 B'], [1023, '1023 B'], [1023.9, '1023 B'],
    [1024, '1 KB'], [1025, '1 KB'], [1433, '1.4 KB'], [1536, '1.5 KB'], [2048, '2 KB'], [9 * 1024, '9 KB'], [9.5 * 1024, '9.5 KB'], [10 * 1024, '10 KB'],
    [10239, '10 KB'], [10 * 1024 + 400, '10 KB'], [10 * 1024 + 600, '11 KB'], [100 * 1024, '100 KB'], [1023 * 1024, '1023 KB'],
    [1048575, '1 MB'], [1024 * 1024, '1 MB'], [1.5 * 1024 * 1024, '1.5 MB'], [18 * 1024 * 1024, '18 MB'], [18.4 * 1024 * 1024, '18 MB'], [18.6 * 1024 * 1024, '19 MB'],
    [999 * 1024 * 1024, '999 MB'], [1.2 * 1024 ** 3, '1.2 GB'], [1024 ** 3, '1 GB'], [50 * 1024 ** 3, '50 GB'], [1024 ** 4, '1 TB'], [3.3 * 1024 ** 4, '3.3 TB'],
    [1024 ** 5, '1 PB'], [Number.MAX_SAFE_INTEGER, '8 PB'],
  ]
  for (const [n, want] of table) expect(formatBytes(n), String(n)).toBe(want)
})

test('formatBytes: numbers that are not sizes read as 0 B', () => {
  for (const n of [NaN, -1, -1024, -Infinity, 0.4, undefined as unknown as number, null as unknown as number, '5' as unknown as number, {} as unknown as number]) expect(formatBytes(n), String(n)).toBe('0 B')
  expect(formatBytes(Infinity)).toBe('0 B')
  expect(formatBytes(1e30)).toBe('8 PB')
  expect(formatBytes(Number.MAX_VALUE)).toBe('8 PB')
})

test('formatClock: local HH:mm, 24 hours, zero-padded', () => {
  const at = (h: number, m: number, d = 24) => new Date(2026, 10, d, h, m, 30).getTime()
  expect(formatClock(at(7, 5))).toBe('07:05')
  expect(formatClock(at(0, 0))).toBe('00:00')
  expect(formatClock(at(9, 30))).toBe('09:30')
  expect(formatClock(at(12, 0))).toBe('12:00')
  expect(formatClock(at(13, 45))).toBe('13:45')
  expect(formatClock(at(23, 59))).toBe('23:59')
  expect(formatClock(new Date(2026, 10, 24, 23, 59, 59, 999).getTime())).toBe('23:59')
  expect(formatClock(at(0, 7, 1))).toBe('00:07')
  expect(formatClock(0)).toBe(`${String(new Date(0).getHours()).padStart(2, '0')}:${String(new Date(0).getMinutes()).padStart(2, '0')}`)
})

test('formatClock: a value that is not a time reads --:--', () => {
  for (const v of [NaN, Infinity, -Infinity, 1e20, -1e20, undefined as unknown as number, null as unknown as number, '12:00' as unknown as number, {} as unknown as number]) {
    expect(formatClock(v), String(v)).toBe('--:--')
  }
})

test('limitReached: strictly more than the limit, either one', () => {
  expect(limitReached({ bytes: 100, files: 1 }, 100)).toBe(false)
  expect(limitReached({ bytes: 101, files: 1 }, 100)).toBe(true)
  expect(limitReached({ bytes: 0, files: 50_000 }, 100)).toBe(false)
  expect(limitReached({ bytes: 0, files: 50_001 }, 100)).toBe(true)
  expect(limitReached({ bytes: 0, files: 10 }, 100, 9)).toBe(true)
  expect(limitReached({ bytes: 0, files: 9 }, 100, 9)).toBe(false)
  expect(limitReached({ bytes: 0, files: 0 }, 0)).toBe(false)
  expect(limitReached({ bytes: 1, files: 0 }, 0)).toBe(true)
  expect(limitReached({ bytes: 1e15, files: 1e9 }, Infinity, Infinity)).toBe(false)
})

test('limitReached: a limit or total that is not a number never throws; a missing limit uses its default', () => {
  expect(limitReached({ bytes: DEFAULT_MAX_BYTES, files: 1 }, NaN)).toBe(false)
  expect(limitReached({ bytes: DEFAULT_MAX_BYTES + 1, files: 1 }, NaN)).toBe(true)
  expect(limitReached({ bytes: 0, files: 50_001 }, 100, NaN)).toBe(true)
  expect(limitReached({ bytes: NaN, files: NaN }, 100)).toBe(false)
  expect(limitReached({ bytes: -5, files: -5 }, 100)).toBe(false)
  expect(limitReached(undefined as unknown as { bytes: number; files: number }, 100)).toBe(false)
  expect(limitReached({ bytes: 5, files: 5 }, undefined as unknown as number)).toBe(false)
  expect(limitReached({ bytes: '999999999999' as unknown as number, files: 1 }, 100)).toBe(false)
})

// ---- safeCommandText ----

test('safeCommandText: one line, whitespace collapsed', () => {
  expect(safeCommandText('rm -rf build')).toBe('rm -rf build')
  expect(safeCommandText('  rm   -rf \t build \n')).toBe('rm -rf build')
  expect(safeCommandText('line one\nline two\r\nline three')).toBe('line one line two line three')
  expect(safeCommandText('a\u00a0b\u2028c\u2029d\u3000e')).toBe('a b c d e')
  expect(safeCommandText('')).toBe('')
  expect(safeCommandText('   \n\t ')).toBe('')
  expect(safeCommandText('日本語 のテキスト')).toBe('日本語 のテキスト')
})

test('safeCommandText: control characters become spaces, invisible and bidi controls disappear', () => {
  expect(safeCommandText('a\u0000b\u0007c\u001bd\u007fe\u009bf')).toBe('a b c d e f')
  expect(safeCommandText('\u001b[31mred\u001b[0m')).toBe('[31mred [0m')
  expect(safeCommandText('rm \u202e fdp.txt')).toBe('rm fdp.txt')
  expect(safeCommandText('a\u200bb\u200dc\ufeffd\u2066e\u2069f')).toBe('abcdef')
  expect(safeCommandText('\u202eevil')).toBe('evil')
  expect(safeCommandText('echo "\u0000"')).toBe('echo " "')
})

test('safeCommandText: cut with … so the result is at most max characters', () => {
  const cut = safeCommandText('x'.repeat(600))
  expect(cut.length).toBe(500)
  expect(cut.endsWith('…')).toBe(true)
  expect(cut).toBe('x'.repeat(499) + '…')
  expect(safeCommandText('x'.repeat(500))).toBe('x'.repeat(500))
  expect(safeCommandText('x'.repeat(501), 500).length).toBe(500)
  expect(safeCommandText('abcdef', 5)).toBe('abcd…')
  expect(safeCommandText('abcde', 5)).toBe('abcde')
  expect(safeCommandText('abc def ghi', 5)).toBe('abc…') // no space before the ellipsis
  expect(safeCommandText('abcdef', 1)).toBe('…')
  expect(safeCommandText('a', 1)).toBe('a')
  expect(safeCommandText('abcdef', 0)).toBe('')
  expect(safeCommandText('abcdef', -3)).toBe('')
  expect(safeCommandText('abcdef', 3.9)).toBe('ab…')
  expect(safeCommandText('x'.repeat(600), NaN).length).toBe(500)
  expect(safeCommandText('abcdef', Infinity).length).toBe(6)
})

test('safeCommandText never cuts a character in half', () => {
  expect(safeCommandText('😀'.repeat(10), 5)).toBe('😀😀😀😀…')
  expect(safeCommandText('😀'.repeat(5), 5)).toBe('😀'.repeat(5))
  expect(safeCommandText('😀'.repeat(300), 500)).toBe('😀'.repeat(300))
  for (let max = 1; max < 12; max += 1) {
    const out = safeCommandText('a😀b😀c😀d😀e😀f😀', max)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), `max ${max}`).toBe(false)
    expect(Array.from(out).length).toBeLessThanOrEqual(max)
  }
})

test('safeCommandText is total and fast on hostile input', () => {
  expect(safeCommandText(5 as unknown as string)).toBe('')
  expect(safeCommandText(null as unknown as string)).toBe('')
  expect(safeCommandText(undefined as unknown as string)).toBe('')
  expect(safeCommandText({} as unknown as string)).toBe('')
  const started = Date.now()
  const big = safeCommandText('word '.repeat(2_000_000))
  expect(big.length).toBe(500)
  expect(big.endsWith('…')).toBe(true)
  expect(safeCommandText('\u0000'.repeat(5_000_000))).toBe('')
  expect(safeCommandText(' '.repeat(5_000_000) + 'x')).toBe('') // past the 1 MB window nothing is left but spaces
  expect(Date.now() - started).toBeLessThan(5000)
})

// ---- git recovery commands ----

const kindsOf = (...kinds: string[]) => kinds.map(kind => ({ kind, label: kind }))
/** A manifest of a call that git can undo; by default a reset that also deleted a branch (so every kind of command may show). */
const withGit = (git: Manifest['git'], kinds: string[] = ['reset-hard', 'branch-delete']) => manifest({ git, risks: kindsOf(...kinds) })

test('gitRestoreCommands: nothing without git facts', () => {
  expect(gitRestoreCommands(manifest())).toEqual([])
  expect(gitRestoreCommands(withGit({ head: null, branch: null }))).toEqual([])
  expect(gitRestoreCommands(undefined as unknown as Manifest)).toEqual([])
  expect(gitRestoreCommands({} as Manifest)).toEqual([])
})

test('gitRestoreCommands: the stash is applied from its ref, or from its commit when there is no ref', () => {
  expect(gitRestoreCommands(withGit({ head: null, branch: null, ref: gitSafetyRef(ID), stashSha: GIT_SHA }))).toEqual([{ label: 'stash', command: `git stash apply refs/kit-safety/${ID}` }])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, ref: gitSafetyRef(ID) }))).toEqual([{ label: 'stash', command: `git stash apply refs/kit-safety/${ID}` }])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, stashSha: GIT_SHA }))).toEqual([{ label: 'stash', command: `git stash apply ${GIT_SHA}` }])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, stashSha: 'f'.repeat(64) }))).toEqual([{ label: 'stash', command: `git stash apply ${'f'.repeat(64)}` }])
})

test('gitRestoreCommands: every deleted branch gets its own command, then the head hint', () => {
  const cmds = gitRestoreCommands(withGit({
    head: GIT_SHA, branch: 'main', ref: gitSafetyRef(ID),
    branches: [{ name: 'feature/login', sha: GIT_SHA_2 }, { name: 'release-1.2', sha: GIT_SHA }, { name: 'v2_x.y', sha: GIT_SHA_2 }],
  }))
  expect(cmds).toEqual([
    { label: 'stash', command: `git stash apply refs/kit-safety/${ID}` },
    { label: 'branch', command: `git branch feature/login ${GIT_SHA_2}` },
    { label: 'branch', command: `git branch release-1.2 ${GIT_SHA}` },
    { label: 'branch', command: `git branch v2_x.y ${GIT_SHA_2}` },
    { label: 'head', command: `git checkout ${GIT_SHA}` },
  ])
  expect(gitRestoreCommands(withGit({ head: 'main', branch: 'main' }))).toEqual([{ label: 'head', command: 'git checkout main' }])
})

test('gitRestoreCommands: anything that would need quoting is left out, never quoted and printed', () => {
  const unsafe = ['bad name', 'a;rm -rf x', 'a&b', 'a|b', '$(whoami)', '`id`', "it's", 'q"uote', 'a\nb', 'a\tb', '-D', '--force', '-', 'a..b', '..', '/abs', 'trail/', 'dot.', 'a//b', 'ünï', '日本語', 'a b', '', 'a*', 'a?', 'a[b]', 'a{b}', 'a>b', 'a<b', 'a\\b', 'a#b', 'a~b', 'a^b', 'a:b', 'a\0b', 'x'.repeat(201)]
  // The names are never printed. A name git takes as a ref is still pinned, so one read-only line that lists the saved tips stands in.
  const wrong: string[] = []
  for (const name of unsafe) {
    const cmds = gitRestoreCommands(withGit({
      head: name, branch: name, ref: name, stashSha: 'not hex',
      branches: [{ name, sha: GIT_SHA }],
    }))
    const want = looseRefName(name) ? [{ label: 'branch', command: `git for-each-ref refs/kit-safety/${ID}.b` }] : []
    if (JSON.stringify(cmds) !== JSON.stringify(want)) wrong.push(`${JSON.stringify(name)} -> ${JSON.stringify(cmds)}`)
  }
  expect(wrong).toEqual([])
  // A bad sha drops the branch, not the whole list.
  const cmds = gitRestoreCommands(withGit({
    head: null, branch: null,
    branches: [{ name: 'good', sha: GIT_SHA }, { name: 'nosha', sha: 'abc' }, { name: 'shell', sha: GIT_SHA + ';x' }, { name: 'upper', sha: 'A'.repeat(40) }],
  }))
  expect(cmds.map(c => c.command)).toEqual([`git branch good ${GIT_SHA}`, `git branch upper ${'A'.repeat(40)}`])
  for (const c of cmds) expect(c.command).toMatch(/^[A-Za-z0-9 ._/-]+$/)
})

test('gitRestoreCommands: every command is plain words, whatever the manifest holds (checked on generated hostile input)', () => {
  const pieces = ['a', 'B', '1', '.', '_', '-', '/', ' ', ';', '$', '`', '"', "'", '\\', '\n', '*', '&', '|', '(', ')', '<', '>', '..', '--', '日', '\0']
  let seed = 12345
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  const word = () => Array.from({ length: 1 + (next() % 8) }, () => pieces[next() % pieces.length]).join('')
  for (let i = 0; i < 400; i += 1) {
    const m = withGit({
      head: word(), branch: word(), ref: word(), stashSha: next() % 3 === 0 ? GIT_SHA : word(),
      branches: [{ name: word(), sha: next() % 2 === 0 ? GIT_SHA : word() }, { name: word(), sha: GIT_SHA_2 }, { name: `${word()}/${word()}`, sha: GIT_SHA, remote: true }],
    }, ['reset-hard', 'discard', 'branch-delete', 'force-push'])
    for (const c of gitRestoreCommands(m)) {
      expect(c.command, JSON.stringify(m.git)).toMatch(/^git [a-z-]+( [a-z]+)? [A-Za-z0-9._/-]+( [0-9a-fA-F]{40,64})?$/)
      expect(c.command).not.toContain('..')
      expect(c.command).not.toMatch(/ -/)
    }
  }
})

test('gitRestoreCommands ignores a manifest field that is not what it should be', () => {
  expect(gitRestoreCommands(withGit({ head: 5 as unknown as string, branch: null, ref: {} as unknown as string, stashSha: 5 as unknown as string, branches: 'x' as unknown as [] }))).toEqual([])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [null, undefined, 5, { name: 5, sha: 5 }, { name: 'ok', sha: GIT_SHA }] as unknown as [] }))).toEqual([
    { label: 'branch', command: `git branch ok ${GIT_SHA}` },
  ])
})

test('gitRestoreCommands: only the commands that fit what the call was (a plain rm -rf offers no git command at all)', () => {
  const git = { head: GIT_SHA, branch: 'main', ref: gitSafetyRef(ID), stashSha: GIT_SHA_2, branches: [{ name: 'old', sha: GIT_SHA }] }
  const stash = { label: 'stash', command: `git stash apply refs/kit-safety/${ID}` }
  const branch = { label: 'branch', command: `git branch old ${GIT_SHA}` }
  const head = { label: 'head', command: `git checkout ${GIT_SHA}` }
  const cases: [string[], unknown[]][] = [
    [['delete'], []],
    [['overwrite'], []],
    [['clean'], []],
    [['db-drop'], []],
    [['unparsed'], []],
    [[], []],
    [['reset-hard'], [stash, head]],
    [['discard'], [stash]],
    // a force push throws nothing local away: only a remote tip (below) is offered, never the head
    [['force-push'], []],
    [['branch-delete'], [branch]],
    [['reset-hard', 'branch-delete'], [stash, branch, head]],
    [['discard', 'force-push', 'delete'], [stash]],
  ]
  for (const [kinds, want] of cases) expect(gitRestoreCommands(withGit(git, kinds)), kinds.join('+') || 'no risk').toEqual(want)
  // A stash with no ref (the ref could not be made) is offered by its commit; and no stash at all offers no stash command.
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: null, stashSha: GIT_SHA_2 }, ['discard']))).toEqual([{ label: 'stash', command: `git stash apply ${GIT_SHA_2}` }])
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: null }, ['discard']))).toEqual([])
})

test('gitRestoreCommands: the remote branch a force push overwrote comes back as a local branch; a deleted branch is not mistaken for it', () => {
  const git = {
    head: GIT_SHA, branch: 'main',
    branches: [{ name: 'feature/x', sha: GIT_SHA }, { name: 'origin/main', sha: GIT_SHA_2, remote: true }, { name: 'upstream/release/1.2', sha: GIT_SHA, remote: true }],
  }
  expect(gitRestoreCommands(withGit(git, ['force-push'])).filter(c => c.label === 'branch')).toEqual([
    { label: 'branch', command: `git branch main-before-force-push ${GIT_SHA_2}` },
    { label: 'branch', command: `git branch release/1.2-before-force-push ${GIT_SHA}` },
  ])
  expect(gitRestoreCommands(withGit(git, ['branch-delete'])).filter(c => c.label === 'branch')).toEqual([{ label: 'branch', command: `git branch feature/x ${GIT_SHA}` }])
  expect(gitRestoreCommands(withGit(git, ['branch-delete', 'force-push'])).filter(c => c.label === 'branch').length).toBe(3)
  // A remote tip with no `<remote>/` part, or one that is not plain, is left out.
  // The head is no hint for a force push, with or without a tip.
  const head = withGit({ head: GIT_SHA, branch: 'main', branches: [{ name: 'origin/main', sha: GIT_SHA_2, remote: true }] }, ['force-push'])
  expect(gitRestoreCommands(head).map(c => c.label)).toEqual(['branch'])
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main' }, ['force-push']))).toEqual([])
  // A remote tip with no `<remote>/` part, or one that is not plain, has no command: a name git takes is covered by the tip list line,
  // one that git would not take (a space) is not a tip at all.
  const odd = withGit({ head: null, branch: null, branches: [{ name: 'main', sha: GIT_SHA, remote: true }, { name: 'origin/ünï', sha: GIT_SHA, remote: true }, { name: 'origin/a b', sha: GIT_SHA, remote: true }] }, ['force-push'])
  expect(gitRestoreCommands(odd)).toEqual([{ label: 'branch', command: `git for-each-ref refs/kit-safety/${ID}.b` }])
  const space = withGit({ head: null, branch: null, branches: [{ name: 'origin/a b', sha: GIT_SHA, remote: true }] }, ['force-push'])
  expect(gitRestoreCommands(space)).toEqual([])
})

test('gitRestoreCommands: a branch whose name git accepts but that is not plain is kept in the manifest and never printed', () => {
  const m = parseManifest(serializeManifest(withGit({ head: null, branch: null, branches: [{ name: 'fix/lỗi-đăng-nhập', sha: GIT_SHA }, { name: 'feat+x', sha: GIT_SHA_2 }, { name: 'plain', sha: GIT_SHA }] }, ['branch-delete'])))!
  expect(m.git!.branches!.map(b => b.name)).toEqual(['fix/lỗi-đăng-nhập', 'feat+x', 'plain'])
  // `feat+x` and `fix/lỗi-đăng-nhập` are pinned but never printed: one read-only line lists them
  expect(gitRestoreCommands(m).map(c => c.command)).toEqual([`git branch plain ${GIT_SHA}`, `git for-each-ref refs/kit-safety/${ID}.b`])
})

test('looseRefName: what git takes as one ref name, letters of any script included', () => {
  const ok = ['main', 'feature/login', 'release-1.2', 'feat+x', 'fix/lỗi-đăng-nhập', '日本語', 'a@b', 'v1.0.0-rc.1', '$(x)', 'a#b', 'x'.repeat(200)]
  const bad = ['', 'a b', 'a\tb', 'a\nb', 'a\u0000b', '-D', '--force', '/abs', 'trail/', 'dot.', 'x.lock', 'a..b', 'a@{1}', 'a//b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\u007Fb', 'a\u0085b', 'a\u202Eb', 'a\u200Bb', 'a\uFEFFb', 'x'.repeat(201), 5, null, undefined, {}]
  const wrongOk = ok.filter(v => !looseRefName(v))
  const wrongBad = bad.filter(v => looseRefName(v))
  expect(wrongOk).toEqual([])
  expect(wrongBad).toEqual([])
})

// ---- a force push that kept nothing, a partial Git snapshot, tips that cannot be printed ----

test('gitRestoreCommands: a force push offers only the remote tip it pinned; with no tip there is no command and no head hint', () => {
  const tip = { name: 'origin/main', sha: GIT_SHA_2, remote: true }
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main' }, ['force-push']))).toEqual([])
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main', branches: [] }, ['force-push']))).toEqual([])
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main', branches: [tip] }, ['force-push']))).toEqual([
    { label: 'branch', command: `git branch main-before-force-push ${GIT_SHA_2}` },
  ])
  // a reset in the same command still offers its head
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main', branches: [tip] }, ['reset-hard', 'force-push'])).map(c => c.label)).toEqual(['branch', 'head'])
})

test('gitRestoreCommands: Git could not save the uncommitted changes: no stash and no head hint, the branch tips are still offered', () => {
  const partial = { head: GIT_SHA, branch: 'main', isPartial: true as const }
  for (const kinds of [['reset-hard'], ['discard'], ['reset-hard', 'discard']]) expect(gitRestoreCommands(withGit(partial, kinds)), kinds.join('+')).toEqual([])
  // even a manifest that (wrongly) carries a stash does not promise it
  expect(gitRestoreCommands(withGit({ ...partial, ref: gitSafetyRef(ID), stashSha: GIT_SHA_2 }, ['reset-hard']))).toEqual([])
  expect(gitRestoreCommands(withGit({ ...partial, branches: [{ name: 'old', sha: GIT_SHA_2 }] }, ['reset-hard', 'branch-delete']))).toEqual([
    { label: 'branch', command: `git branch old ${GIT_SHA_2}` },
  ])
  // without the flag the same manifest offers both
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main' }, ['reset-hard'])).map(c => c.label)).toEqual(['head'])
})

test('summarize: gitPartial is set only for a partial Git snapshot, and hasGit follows the commands that can be printed', () => {
  const partial = summarize(withGit({ head: GIT_SHA, branch: 'main', isPartial: true }, ['reset-hard']))
  expect(partial.gitPartial).toBe(true)
  expect(partial.hasGit).toBe(false)
  expect('gitPartial' in summarize(withGit({ head: GIT_SHA, branch: 'main' }, ['reset-hard']))).toBe(false)
  expect('gitPartial' in summarize(manifest())).toBe(false)
  // a force push with no remote tip has no Git copy; with one it has
  expect(summarize(withGit({ head: GIT_SHA, branch: 'main' }, ['force-push'])).hasGit).toBe(false)
  expect(summarize(withGit({ head: GIT_SHA, branch: 'main', branches: [{ name: 'origin/main', sha: GIT_SHA_2, remote: true }] }, ['force-push'])).hasGit).toBe(true)
  // a partial snapshot with a tip: both facts at once
  const both = summarize(withGit({ head: GIT_SHA, branch: 'main', isPartial: true, branches: [{ name: 'old', sha: GIT_SHA_2 }] }, ['reset-hard', 'branch-delete']))
  expect(both).toMatchObject({ gitPartial: true, hasGit: true })
})

test('summarize().hasGit is true exactly when gitRestoreCommands has a command (checked on every combination of kinds and facts)', () => {
  const kinds = ['reset-hard', 'discard', 'force-push', 'branch-delete', 'delete']
  const facts: Manifest['git'][] = [
    { head: GIT_SHA, branch: 'main' },
    { head: null, branch: null },
    { head: GIT_SHA, branch: 'main', isPartial: true },
    { head: GIT_SHA, branch: 'main', stashSha: GIT_SHA_2, ref: gitSafetyRef(ID) },
    { head: GIT_SHA, branch: 'main', branches: [{ name: 'old', sha: GIT_SHA_2 }] },
    { head: GIT_SHA, branch: 'main', branches: [{ name: 'origin/main', sha: GIT_SHA_2, remote: true }] },
    { head: GIT_SHA, branch: 'main', branches: [{ name: 'feat+x', sha: GIT_SHA_2 }, { name: 'origin/feat+x', sha: GIT_SHA_2, remote: true }] },
    { head: GIT_SHA, branch: 'main', isPartial: true, branches: [{ name: 'feat+x', sha: GIT_SHA_2 }] },
  ]
  const wrong: string[] = []
  for (let mask = 0; mask < 2 ** kinds.length; mask += 1) {
    const chosen = kinds.filter((_, i) => (mask >> i) & 1)
    for (const git of facts) {
      const m = withGit(git, chosen)
      const n = gitRestoreCommands(m).length
      if (summarize(m).hasGit !== n > 0) wrong.push(`${chosen.join('+')} ${JSON.stringify(git)}`)
      // no command is ever a promise about uncommitted changes when Git could not save them
      if (git?.isPartial === true && gitRestoreCommands(m).some(c => c.label !== 'branch')) wrong.push(`partial ${chosen.join('+')}`)
      // a force push alone never offers anything but a branch
      if (chosen.length === 1 && chosen[0] === 'force-push' && gitRestoreCommands(m).some(c => c.label !== 'branch')) wrong.push(`push ${JSON.stringify(git)}`)
    }
  }
  expect(wrong).toEqual([])
})

test('gitRestoreCommands: the tip list line stands in for the tips that cannot be printed, and only for those', () => {
  const list = { label: 'branch', command: `git for-each-ref refs/kit-safety/${ID}.b` }
  const odd = { name: 'feat+x', sha: GIT_SHA }
  const plain = { name: 'plain', sha: GIT_SHA_2 }
  // a deleted branch with a name that is not plain: the line, and nothing else
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [odd] }, ['branch-delete']))).toEqual([list])
  // plain ones are printed, the odd one adds the line once, at the end
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [odd, plain, { name: 'fix/lỗi', sha: GIT_SHA }] }, ['branch-delete'])).map(c => c.command)).toEqual([
    `git branch plain ${GIT_SHA_2}`, list.command,
  ])
  // the same for the remote branch of a force push
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [{ name: 'origin/feat+x', sha: GIT_SHA, remote: true }] }, ['force-push']))).toEqual([list])
  // after the head hint of a reset
  expect(gitRestoreCommands(withGit({ head: GIT_SHA, branch: 'main', branches: [odd] }, ['reset-hard', 'branch-delete'])).map(c => c.label)).toEqual(['head', 'branch'])
  // not for a tip the call does not use, a tip that is not kept (not a name git takes, or no sha), or a manifest whose id is not an id
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [odd] }, ['force-push']))).toEqual([])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [{ name: 'a b', sha: GIT_SHA }, { name: 'ok', sha: 'abc' }, { name: '-D', sha: GIT_SHA }] }, ['branch-delete']))).toEqual([])
  expect(gitRestoreCommands({ ...withGit({ head: null, branch: null, branches: [odd] }, ['branch-delete']), id: '../x' })).toEqual([])
  expect(gitRestoreCommands(withGit({ head: null, branch: null, branches: [odd] }, ['clean', 'delete']))).toEqual([])
  // the id of a second snapshot in the same second keeps its suffix
  expect(gitRestoreCommands({ ...withGit({ head: null, branch: null, branches: [odd] }, ['branch-delete']), id: `${ID}-2` }).map(c => c.command)).toEqual([`git for-each-ref refs/kit-safety/${ID}-2.b`])
})

test('isOverwrittenBranchHint and isTipListHint: only the commands gitRestoreCommands makes', () => {
  expect(isOverwrittenBranchHint(`git branch main-before-force-push ${GIT_SHA}`)).toBe(true)
  expect(isOverwrittenBranchHint(`git branch release/1.2-before-force-push ${'A'.repeat(64)}`)).toBe(true)
  for (const no of [`git branch main ${GIT_SHA}`, `git stash apply ${GIT_SHA}`, 'git branch main-before-force-push abc', `git branch x-before-force-push ${GIT_SHA};id`, `git branch x y-before-force-push ${GIT_SHA}`, '', 5, null, undefined, {}]) {
    expect(isOverwrittenBranchHint(no), JSON.stringify(no)).toBe(false)
  }
  expect(isTipListHint(`git for-each-ref refs/kit-safety/${ID}.b`)).toBe(true)
  expect(isTipListHint(`git for-each-ref refs/kit-safety/${ID}-12.b`)).toBe(true)
  for (const no of [`git for-each-ref refs/kit-safety/${ID}`, `git for-each-ref refs/kit-safety/${ID}.b/1`, 'git for-each-ref refs/heads', `git for-each-ref refs/kit-safety/${ID}.b --format=%(x)`, `git branch a ${GIT_SHA}`, '', 5, null, undefined]) {
    expect(isTipListHint(no), JSON.stringify(no)).toBe(false)
  }
})
