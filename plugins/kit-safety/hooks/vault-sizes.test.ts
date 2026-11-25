import { describe, expect, test } from 'claude-code/testing'

import { decodeBase64, decodeUtf8, restoreSnapshot } from './vault'
import { encode64, utf8, ROOT, MB, world, made, manifestOf, ID0, find, reasons, engine } from '../tests/vault-helpers'
import type { World } from '../tests/vault-helpers'

// The sizes the vault's limits are about: 3 MiB a file the engine copies, 4 MiB a read the engine makes in one piece.
// The counts (50,000 files, a long manifest, many projects) are in vault-limits.test.ts, the small cases in vault.test.ts.

describe('decodeBase64', () => {
  test('3 MiB decodes quickly', () => {
    const big = new Uint8Array(3 * MB).map((_, i) => (i * 7) & 255)
    const t0 = Date.now()
    const back = decodeBase64(encode64(big))!
    expect(back.length).toBe(big.length)
    expect(back[12345]).toBe(big[12345])
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('decodeUtf8', () => {
  test('3 MiB of text decodes quickly', () => {
    const big = utf8('line of text é\n'.repeat(Math.ceil((3 * MB) / 16)))
    const t0 = Date.now()
    expect(decodeUtf8(big)?.length).toBeGreaterThan(1_000_000)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('createSnapshot: fs backend only', () => {
  test('a file over 3 MiB is skipped (too-large), 3 MiB exactly is saved', async () => {
    const w = world()
    w.fs.file(`${ROOT}/exact.txt`, 'a'.repeat(3 * MB))
    w.fs.file(`${ROOT}/over.txt`, 'a'.repeat(3 * MB + 1))
    const out = await made(w, ['exact.txt', 'over.txt'])
    expect(out.files).toBe(1)
    expect(out.isPartial).toBe(true)
    expect(manifestOf(w, ID0).skipped).toEqual([{ rel: 'over.txt', reason: 'too-large' }])
  })
})

describe('restoreSnapshot: fs backend only', () => {
  test('a file larger than the engine copies (3 MiB) is reported as needing node', async () => {
    const w = world({ node: 'ok' })
    w.fs.file(`${ROOT}/big.txt`, 'a'.repeat(4 * MB))
    const out0 = await made(w, ['big.txt'])
    w.fs.remove(`${ROOT}/big.txt`)
    w.env.node = false
    const out = await restoreSnapshot(w.env, ROOT, await find(w, out0.id))
    expect(reasons(out)).toEqual(['big.txt:needs-node'])
  })
})

describe('ioFromEngine', () => {
  test('a file the engine will not read in one piece (over 4 MiB) is read in ranges', { timeoutMs: 30_000 }, async () => {
    const size = 4 * MB + 123 // just over the engine's 4 MiB limit: two ranges, the last one partial
    const bytes = new Uint8Array(size).fill(0x61)
    const reads: unknown[][] = []
    const { io } = engine({
      fs: {
        read: async (...a: unknown[]) => {
          reads.push(a)
          const o = a[1] as { as?: string; offset?: number; length?: number } | undefined
          if (!o) throw new Error('too large')
          const slice = bytes.slice(o.offset ?? 0, (o.offset ?? 0) + (o.length ?? size))
          return { base64: encode64(slice) }
        },
        stat: async () => ({ kind: 'file', size, mtimeMs: 1, isLink: false }),
      },
    })
    const got = await io.readText('/big.json')
    expect(got.length).toBe(size)
    expect(got.startsWith('aaaa')).toBe(true)
    expect(reads.length).toBe(1 + Math.ceil(size / (3 * MB)))
  })
})

describe('the text-only backend does not copy .env-like files', () => {
  const T = 'fs backend'
  const skippedOf = (w: World, id = ID0) => manifestOf(w, id).skipped

  test(`${T}: a .env that is a link is skipped as a link; one that is too large or binary is still private (the name decides first)`, async () => {
    const w = world()
    w.fs.file(`${ROOT}/real.txt`, 'x')
    w.fs.link(`${ROOT}/d/.env`, `${ROOT}/real.txt`)
    w.fs.file(`${ROOT}/d/.env.big`, new Uint8Array(4 * MB).fill(97))
    w.fs.file(`${ROOT}/d/a.txt`, 'a')
    const out = await made(w, ['d'])
    expect(out).toMatchObject({ files: 1, skippedPrivate: 1 })
    expect(Object.fromEntries(skippedOf(w).map(s => [s.rel, s.reason]))).toEqual({ 'd/.env': 'symlink', 'd/.env.big': 'private' })
  })
})
