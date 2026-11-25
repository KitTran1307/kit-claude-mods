import { describe, expect, test } from 'claude-code/testing'

import { newSnapshotId } from './snapshot'
import { pruneAll } from './vault'
import type { IO, VaultCfg } from './vault'
import { ROOT, SNAPS, KEY, MB, CFG, world, snap, snapDirOf, BACKENDS } from '../tests/vault-helpers'

// The counts the vault's limits are about: 50,000 files, a manifest that fits one write, 200 projects and 500 snapshots a project.
// The sizes (3 MiB a file, 4 MiB a read) are in vault-sizes.test.ts, the small cases of the same code in vault.test.ts.

for (const { name, mode } of BACKENDS) {
  describe(`createSnapshot: ${name}`, () => {
    test('more than 50 000 files: too-big whatever their size', async () => {
      const w = world({ node: mode })
      for (let i = 0; i < 50_001; i += 1) w.fs.file(`${ROOT}/many/f${i}`, '')
      const out = await snap(w, ['many'])
      expect(out.ok === false && out.reason).toBe('too-big')
      // The number of files tripped, not the size: the person must not be told "more than 200 MB" (there are 0 bytes).
      expect(out).toMatchObject({ ok: false, reason: 'too-big', bytes: 0, byFiles: true })
      expect(w.fs.below(SNAPS)).toEqual([])
    })

    test('the size limit tripped: no byFiles; both tripped at once: the size wins', { timeoutMs: 30_000 }, async () => {
      const w = world({ node: mode })
      for (let i = 0; i < 5; i += 1) w.fs.file(`${ROOT}/big/f${i}`, 'x'.repeat(100))
      const bySize = await snap(w, ['big'], {}, { ...CFG, maxBytes: 250 })
      expect(bySize.ok === false && 'byFiles' in bySize).toBe(false)
      expect(bySize).toMatchObject({ ok: false, reason: 'too-big' })
      // Just under the file limit with empty files; the last one by name passes the size limit (and, for the text-only backend,
      // which also counts folders, the file limit in the same step). The limit is a smaller maxFiles: the default of 50,000 is
      // the test above, and building a 50,000-file tree again for this one only repeated that cost.
      const w2 = world({ node: mode })
      for (let i = 0; i < 99; i += 1) w2.fs.file(`${ROOT}/many/f${i}`, '')
      w2.fs.file(`${ROOT}/many/zz`, 'x'.repeat(100))
      const both = await snap(w2, ['many'], {}, { ...CFG, maxBytes: 50, maxFiles: 100 })
      expect(both).toMatchObject({ ok: false, reason: 'too-big' })
      expect(both.ok === false && 'byFiles' in both).toBe(false)
    })
  })
}

describe('createSnapshot: fs backend only', () => {
  test('a manifest too large for one engine write is "too big", not a half snapshot', async () => {
    const w = world()
    for (let i = 0; i < 3_000; i += 1) w.fs.file(`${ROOT}/long/${'x'.repeat(1_500)}${i}`, '')
    const out = await snap(w, ['long'])
    expect(out.ok === false && out.reason).toBe('too-big')
    // It is the record (a name for each file) that is too long, not the bytes: 3 000 empty files must not read as "more than 200 MB".
    expect(out).toMatchObject({ ok: false, reason: 'too-big', bytes: 0, byFiles: true })
    expect(w.fs.below(SNAPS).filter(p => p.endsWith('manifest.json'))).toEqual([])
    expect(w.fs.below(SNAPS).every(p => w.fs.read(p) === '' || w.fs.nodes.get(p)?.kind === 'dir')).toBe(true)
  })
})

describe('pruneAll: the retention sweep for every project', () => {
  const CFG14: VaultCfg = { maxBytes: 100 * MB, keepCount: 20, keepDays: 14 }

  test('bounded: at most 200 project folders are looked into, and at most 500 snapshot folders in each', { timeoutMs: 30_000 }, async () => {
    const w = world()
    for (let i = 0; i < 205; i += 1) w.fs.dir(`${SNAPS}/p${String(i).padStart(3, '0')}-aaaaaaaaaaaaaa`)
    const looked = new Set<string>()
    const spy: IO = { ...w.io, list: async p => { looked.add(p); return w.io.list(p) } }
    expect(await pruneAll({ ...w.env, io: spy }, CFG14)).toBe(0)
    expect([...looked].filter(p => p !== SNAPS).length).toBe(200)

    const w2 = world()
    const base = Date.UTC(2025, 0, 1)
    for (let i = 0; i < 505; i += 1) {
      const id = newSnapshotId(base + i * 1000, [])
      w2.fs.dir(snapDirOf(id))
      w2.fs.dirTimes.set(snapDirOf(id), base)
    }
    expect(await pruneAll(w2.env, CFG14)).toBe(500)
    // The newest 500 were looked at; the 5 oldest are beyond the bound.
    const left = w2.fs.childrenOf(`${SNAPS}/${KEY}`).filter(([k]) => !w2.fs.has(`${k}/pruned`)).map(([k]) => k.slice(k.lastIndexOf('/') + 1)).sort()
    expect(left).toEqual(Array.from({ length: 5 }, (_, i) => newSnapshotId(base + i * 1000, [])))
  })
})
