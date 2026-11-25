import { expect, test } from 'claude-code/testing'

import type { Pending, SnapshotView } from '../types'
import {
  DEFAULT_OPTIONS, DENY_COULD_NOT_FINISH, FALLBACK_AFTER_MS, FALLBACK_LATER_MS, PRESS_GUARD_MS, QUESTION_TIMEOUT_MS, STALE_SNAPSHOT_MS, answerOfDialog, boundedOption, buildPending,
  catchVerdict, coalesceKey, coalesceKeys, confirmOption, createAsked, createDecisions, dequeue, dirKey, enqueue, fallbackDelay, fallbackId, frontOf, isEarlyPress, isSnapshotStale,
  maskBlocks, maskOption, needsFallback, othersIn, parseArgs, pathsToCheck, planCall, readOptions, remember, riskViewsOf, snippetOf,
  QUIET_MAX_FILES, QUIET_MAX_MB, hasNothingToLose, limitsOf, savedView, snapshotView, toggledDetail, vaultCfg, waitingBehind, withNote,
} from './flow'
import type { PlanInput } from './flow'
import type { Risk } from './types'
import type { SnapshotOutcome } from './vault'

// Secret-shaped values are assembled at run time: no key is ever written out contiguously in this file.
const anthropic = () => ['sk', 'ant', 'api03', 'Ab3dEf9hJk1mNp4rStUv'.repeat(2)].join('-')
const github = () => ['gh', 'p_'].join('') + 'Zx8Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz2Xc4'
const MARK = '•••• masked'

const WHERE = { root: '/work/acme-shop', cwd: '/work/acme-shop', home: '/home/dev' }
const risk = (over: Partial<Risk> & Pick<Risk, 'kind'>): Risk => ({ tier: 'ask', label: 'rm -rf', paths: [], ...over })
const saved = (n = 7): SnapshotView => ({ state: 'saved', id: `20261124T140512Z${n}`, n, at: 1_700_000_000_000, files: 3, bytes: 1000, isPartial: false, hasGit: false })
const pending = (id: string, over: Partial<Pending> = {}): Pending => ({ id, at: 1, tool: 'Bash', risks: [], snapshot: saved(), ...over })

// ---------------------------------------------------------------------------------------------------------------------
// Options

test('readOptions: the defaults when nothing is set, and for anything that is not an object', () => {
  for (const raw of [undefined, null, 5, 'x', true, [], () => 1, {}]) expect(readOptions(raw)).toEqual(DEFAULT_OPTIONS)
  expect(DEFAULT_OPTIONS).toEqual({ confirm: 'risky', confirmText: 'risky', maskSecrets: true, keepSnapshots: 20, keepDays: 7, maxSizeMB: 200, maxTotalMB: 2048, language: 'auto' })
})

test('readOptions: every valid value is kept', () => {
  expect(readOptions({ confirm: 'always', maskSecrets: false, keepSnapshots: 50, keepDays: 30, maxSizeMB: 500, maxTotalMB: 5000, language: 'vi' })).toEqual({
    confirm: 'always', confirmText: 'always', maskSecrets: false, keepSnapshots: 50, keepDays: 30, maxSizeMB: 500, maxTotalMB: 5000, language: 'vi',
  })
  expect(readOptions({ confirm: 'never', language: 'en' })).toMatchObject({ confirm: 'never', language: 'en' })
})

test('confirm: an unknown value means risky, and the doctor still sees what was written', () => {
  for (const value of ['ALWAYS', 'Never', ' never', 'sometimes', '', 0, 1, true, null, undefined, {}, []]) expect(confirmOption(value)).toBe('risky')
  expect(readOptions({ confirm: 'Never' })).toMatchObject({ confirm: 'risky', confirmText: 'Never' })
  expect(readOptions({ confirm: 5 }).confirmText).toBe('5')
  expect(readOptions({ confirm: '' }).confirmText).toBe('risky')
  expect(readOptions({ confirm: {} }).confirmText).toBe('risky')
  expect(readOptions({ confirm: 'x'.repeat(500) }).confirmText).toHaveLength(40)
})

test('numbers are whole and cut to their range; text that holds a number counts; anything else is the default', () => {
  const cases: [unknown, number][] = [
    [20, 20], [1, 1], [200, 200], [0, 1], [-5, 1], [999, 200], [1e9, 200], [12.9, 12], [0.4, 1], ['30', 30], [' 45 ', 45], ['1e2', 100],
    [Number.NaN, 20], [Number.POSITIVE_INFINITY, 20], [Number.NEGATIVE_INFINITY, 20], ['abc', 20], ['', 20], ['  ', 20], [null, 20], [undefined, 20],
    [true, 20], [[], 20], [{}, 20], [[5], 20], ['0x10', 16],
  ]
  for (const [value, expected] of cases) expect(boundedOption(value, 20, 1, 200)).toBe(expected)
  expect(readOptions({ keepSnapshots: 'many' }).keepSnapshots).toBe(20)
  expect(readOptions({ keepSnapshots: 1000 }).keepSnapshots).toBe(200)
  expect(readOptions({ keepDays: 0 }).keepDays).toBe(1)
  expect(readOptions({ keepDays: 365 }).keepDays).toBe(90)
  expect(readOptions({ maxSizeMB: 1 }).maxSizeMB).toBe(10)
  expect(readOptions({ maxSizeMB: 99999 }).maxSizeMB).toBe(2000)
  expect(readOptions({ maxSizeMB: Number.NaN }).maxSizeMB).toBe(200)
})

test('maxTotalMB: default 2048, whole numbers from 100 to 20000, text that holds a number counts, garbage is the default', () => {
  const cases: [unknown, number][] = [
    [undefined, 2048], [null, 2048], ['', 2048], ['lots', 2048], [Number.NaN, 2048], [Number.POSITIVE_INFINITY, 2048], [true, 2048], [{}, 2048], [[], 2048], [[500], 2048],
    [100, 100], [20000, 20000], [2048, 2048], [5000, 5000], [5000.9, 5000], ['5000', 5000], [' 750 ', 750], ['1e3', 1000],
    [99, 100], [0, 100], [-1, 100], [1, 100], [20001, 20000], [1e12, 20000], ['999999', 20000],
  ]
  const bad: string[] = []
  for (const [value, expected] of cases) if (readOptions({ maxTotalMB: value }).maxTotalMB !== expected) bad.push(`${String(value)} -> ${readOptions({ maxTotalMB: value }).maxTotalMB}, wanted ${expected}`)
  expect(bad).toEqual([])
  // the other options are not touched by it
  expect(readOptions({ maxTotalMB: 300 })).toEqual({ ...DEFAULT_OPTIONS, maxTotalMB: 300 })
})

test('maskSecrets is on unless it is plainly false', () => {
  for (const value of [false, 'false', 'False', ' FALSE ']) expect(maskOption(value)).toBe(false)
  for (const value of [true, 'true', undefined, null, 0, 1, '', 'no', 'off', {}, [], Number.NaN]) expect(maskOption(value)).toBe(true)
})

test('an unknown language option is auto', () => {
  for (const value of ['fr', 'VI', 5, null, {}, '']) expect(readOptions({ language: value }).language).toBe('auto')
})

test('vaultCfg turns the options into bytes, a count, days and the total of all snapshots', () => {
  expect(vaultCfg(DEFAULT_OPTIONS)).toEqual({ maxBytes: 200 * 1024 * 1024, keepCount: 20, keepDays: 7, maxTotalBytes: 2048 * 1024 * 1024 })
  expect(vaultCfg({ maxSizeMB: 10, keepSnapshots: 1, keepDays: 90, maxTotalMB: 100 })).toEqual({ maxBytes: 10_485_760, keepCount: 1, keepDays: 90, maxTotalBytes: 104_857_600 })
  expect(vaultCfg(readOptions({ maxTotalMB: 20000 })).maxTotalBytes).toBe(20000 * 1024 * 1024)
  // never a cap of 0 or less, which the vault reads as "no cap"
  for (const raw of [undefined, 0, -5, 'x', Number.NaN]) expect(vaultCfg(readOptions({ maxTotalMB: raw })).maxTotalBytes).toBeGreaterThan(0)
})

test('limitsOf: the configured limits, or the small ones of a quiet cleanup (2,000 files, at most 50 MB)', () => {
  expect(QUIET_MAX_FILES).toBe(2000)
  expect(QUIET_MAX_MB).toBe(50)
  const normal = limitsOf(DEFAULT_OPTIONS, false)
  expect(normal.cfg).toEqual(vaultCfg(DEFAULT_OPTIONS))
  expect(normal.cfg.maxFiles).toBeUndefined()
  expect(normal.view).toEqual({ maxSizeMB: 200 })
  const quiet = limitsOf(DEFAULT_OPTIONS, true)
  expect(quiet.cfg).toEqual({ ...vaultCfg(DEFAULT_OPTIONS), maxBytes: 50 * 1024 * 1024, maxFiles: 2000 })
  expect(quiet.view).toEqual({ maxSizeMB: 50, maxFiles: 2000 })
  // a person who allows less than 50 MB keeps that smaller limit; one who allows more does not get it for a cleanup
  expect(limitsOf({ ...DEFAULT_OPTIONS, maxSizeMB: 20 }, true)).toMatchObject({ cfg: { maxBytes: 20 * 1024 * 1024, maxFiles: 2000 }, view: { maxSizeMB: 20, maxFiles: 2000 } })
  expect(limitsOf({ ...DEFAULT_OPTIONS, maxSizeMB: 2000 }, true)).toMatchObject({ cfg: { maxBytes: 50 * 1024 * 1024 }, view: { maxSizeMB: 50 } })
  expect(limitsOf({ ...DEFAULT_OPTIONS, maxSizeMB: 2000 }, false)).toMatchObject({ cfg: { maxBytes: 2000 * 1024 * 1024 }, view: { maxSizeMB: 2000 } })
  // the other settings are the same either way
  expect(quiet.cfg.keepCount).toBe(normal.cfg.keepCount)
  expect(quiet.cfg.keepDays).toBe(normal.cfg.keepDays)
  expect(quiet.cfg.maxTotalBytes).toBe(normal.cfg.maxTotalBytes)
})

test('timing: a question waits 15 minutes (a hook may run 20), and the band has 1.5 s to draw before the question box asks', () => {
  expect(QUESTION_TIMEOUT_MS).toBe(15 * 60_000)
  expect(QUESTION_TIMEOUT_MS).toBeLessThan(20 * 60_000)
  expect(FALLBACK_AFTER_MS).toBe(1500)
})

test('the band is looked at every 1.5 s for the first 30 s, then every 10 s', () => {
  expect(Array.from({ length: 20 }, (_, i) => fallbackDelay(i))).toEqual(Array.from({ length: 20 }, () => 1500))
  for (const tick of [20, 21, 100, 5000]) expect(fallbackDelay(tick)).toBe(FALLBACK_LATER_MS)
  for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, 'x']) expect(fallbackDelay(odd as never)).toBe(1500)
  expect(fallbackDelay(-5)).toBe(1500)
  // a 15-minute wait is a few dozen looks, not hundreds
  let t = 0
  let looks = 0
  for (let tick = 0; t < QUESTION_TIMEOUT_MS; tick += 1) {
    t += fallbackDelay(tick)
    looks += 1
  }
  expect(looks).toBeLessThan(120)
})

// ---------------------------------------------------------------------------------------------------------------------
// The truth table

type Row = [confirm: PlanInput['confirm'], tiers: 'ask' | 'snap' | 'mixed' | 'none', interactive: boolean, coalesced: boolean, snapshot: boolean, ask: boolean, note: boolean, toast: boolean]
const T = true
const F = false
const TABLE: Row[] = [
  // risky: an `ask`-tier risk asks; a `snapshot`-tier one is saved quietly, once per file
  ['risky', 'ask', T, F, T, T, T, F], ['risky', 'ask', T, T, T, T, T, F], ['risky', 'ask', F, F, T, F, T, F], ['risky', 'ask', F, T, T, F, T, F],
  ['risky', 'mixed', T, F, T, T, T, F], ['risky', 'mixed', T, T, T, T, T, F], ['risky', 'mixed', F, F, T, F, T, F], ['risky', 'mixed', F, T, T, F, T, F],
  ['risky', 'snap', T, F, T, F, F, F], ['risky', 'snap', T, T, F, F, F, F], ['risky', 'snap', F, F, T, F, F, F], ['risky', 'snap', F, T, F, F, F, F],
  // always: every risk asks (when somebody can answer); the snapshot is still once per file
  ['always', 'ask', T, F, T, T, T, F], ['always', 'ask', T, T, T, T, T, F], ['always', 'ask', F, F, T, F, T, F], ['always', 'ask', F, T, T, F, T, F],
  ['always', 'mixed', T, F, T, T, T, F], ['always', 'mixed', T, T, T, T, T, F], ['always', 'mixed', F, F, T, F, T, F], ['always', 'mixed', F, T, T, F, T, F],
  ['always', 'snap', T, F, T, T, T, F], ['always', 'snap', T, T, F, T, F, F], ['always', 'snap', F, F, T, F, F, F], ['always', 'snap', F, T, F, F, F, F],
  // never: nothing asks; a risky call is saved and says so with a toast
  ['never', 'ask', T, F, T, F, T, T], ['never', 'ask', T, T, T, F, T, T], ['never', 'ask', F, F, T, F, T, F], ['never', 'ask', F, T, T, F, T, F],
  ['never', 'mixed', T, F, T, F, T, T], ['never', 'mixed', T, T, T, F, T, T], ['never', 'mixed', F, F, T, F, T, F], ['never', 'mixed', F, T, T, F, T, F],
  ['never', 'snap', T, F, T, F, F, F], ['never', 'snap', T, T, F, F, F, F], ['never', 'snap', F, F, T, F, F, F], ['never', 'snap', F, T, F, F, F, F],
  // no risk: nothing at all
  ['risky', 'none', T, F, F, F, F, F], ['always', 'none', T, F, F, F, F, F], ['never', 'none', T, F, F, F, F, F], ['always', 'none', F, T, F, F, F, F],
]
const TIERS = { ask: [{ tier: 'ask' as const }], snap: [{ tier: 'snapshot' as const }], mixed: [{ tier: 'snapshot' as const }, { tier: 'ask' as const }], none: [] }

for (const [confirm, tiers, interactive, coalesced, snapshot, ask, note, toast] of TABLE) {
  test(`planCall ${confirm} / ${tiers} / ${interactive ? 'a person is there' : 'headless'} / ${coalesced ? 'already saved' : 'new'}`, () => {
    expect(planCall({ confirm, risks: TIERS[tiers], interactive, coalesced })).toEqual({ snapshot, ask, note, toast })
  })
}

test('planCall: invariants over every combination', () => {
  for (const confirm of ['risky', 'always', 'never'] as const) {
    for (const tiers of Object.values(TIERS)) {
      for (const interactive of [true, false]) {
        for (const coalesced of [true, false]) {
          const plan = planCall({ confirm, risks: tiers, interactive, coalesced })
          if (confirm === 'never' || !interactive) expect(plan.ask).toBe(false)
          if (tiers.some(r => r.tier === 'ask') && interactive && confirm !== 'never') expect(plan.ask).toBe(true)
          if (tiers.some(r => r.tier === 'ask')) expect(plan.snapshot).toBe(true)
          if (tiers.length > 0 && !coalesced) expect(plan.snapshot).toBe(true)
          if (plan.toast) expect(confirm).toBe('never')
          if (plan.note) expect(plan.snapshot).toBe(true)
        }
      }
    }
  }
})

test('planCall: hostile input is the safe middle', () => {
  expect(planCall(undefined as never)).toEqual({ snapshot: false, ask: false, note: false, toast: false })
  expect(planCall({ confirm: 'bogus' as never, risks: TIERS.ask, interactive: true, coalesced: false })).toMatchObject({ ask: true, snapshot: true })
  expect(planCall({ confirm: 'risky', risks: [null, { tier: 'ask' }] as never, interactive: undefined as never, coalesced: undefined as never })).toMatchObject({ ask: true, snapshot: true })
  expect(planCall({ confirm: 'risky', risks: 'x' as never, interactive: true, coalesced: false })).toEqual({ snapshot: false, ask: false, note: false, toast: false })
})

// ---------------------------------------------------------------------------------------------------------------------
// One snapshot per file per session

test('coalesce keys are absolute spellings; a Windows path ignores case', () => {
  expect(coalesceKey('/work/acme-shop', 'src/app.ts')).toBe('/work/acme-shop/src/app.ts')
  expect(coalesceKey('/work/acme-shop/', 'src//./app.ts')).toBe('/work/acme-shop/src/app.ts')
  expect(coalesceKey('C:\\Work\\Acme', 'Src/App.ts')).toBe('c:/work/acme/src/app.ts')
  expect(coalesceKeys('/w', ['a', 'b/c', '', 5 as never])).toEqual(['/w/a', '/w/b/c'])
  expect(coalesceKeys('/w', undefined as never)).toEqual([])
})

test('savedView: only when every file was saved; the first file names the snapshot', () => {
  const seen = new Map<string, SnapshotView>()
  const a = saved(1)
  const b = saved(2)
  remember(seen, ['/w/a'], a)
  remember(seen, ['/w/b'], b)
  expect(savedView(['/w/a'], seen)).toBe(a)
  expect(savedView(['/w/a', '/w/b'], seen)).toBe(a)
  expect(savedView(['/w/b', '/w/a'], seen)).toBe(b)
  expect(savedView(['/w/a', '/w/c'], seen)).toBeNull()
  expect(savedView(['/w/c'], seen)).toBeNull()
  expect(savedView([], seen)).toBeNull()
})

test('remember: only a snapshot that holds the files counts, the newest wins, and the memory is capped', () => {
  const seen = new Map<string, SnapshotView>()
  for (const view of [{ state: 'failed' }, { state: 'too-big', limitMB: 10 }, { state: 'none', hasGit: true }] as SnapshotView[]) remember(seen, ['/w/a'], view)
  expect(seen.size).toBe(0)
  remember(seen, ['/w/a'], saved(1))
  remember(seen, ['/w/a'], saved(2))
  expect((seen.get('/w/a') as { n: number }).n).toBe(2)
  for (let i = 0; i < 2100; i += 1) remember(seen, [`/w/f${i}`], saved(3))
  expect(seen.size).toBe(2000)
  expect(seen.has('/w/a')).toBe(false)
  expect(seen.has('/w/f2099')).toBe(true)
})

// ---------------------------------------------------------------------------------------------------------------------
// The queue

test('the queue is oldest first, and the band shows the first', () => {
  let q: Pending[] = []
  expect(frontOf(q)).toBeNull()
  expect(waitingBehind(q)).toBe(0)
  q = enqueue(q, pending('a'))
  q = enqueue(q, pending('b'))
  q = enqueue(q, pending('c'))
  expect(q.map(p => p.id)).toEqual(['a', 'b', 'c'])
  expect(frontOf(q)?.id).toBe('a')
  expect(waitingBehind(q)).toBe(2)
  q = dequeue(q, 'a')
  expect(frontOf(q)?.id).toBe('b')
  expect(waitingBehind(q)).toBe(1)
  q = dequeue(q, 'c')
  expect(q.map(p => p.id)).toEqual(['b'])
  expect(waitingBehind(q)).toBe(0)
})

test('enqueue keeps the place of a question asked again; dequeue of an unknown id changes nothing and never shares the list', () => {
  const first = [pending('a'), pending('b')]
  const again = enqueue(first, pending('a', { tool: 'Edit' }))
  expect(again.map(p => `${p.id}:${p.tool}`)).toEqual(['a:Edit', 'b:Bash'])
  expect(first[0]?.tool).toBe('Bash')
  const same = dequeue(first, 'zzz')
  expect(same).toEqual(first)
  expect(same).not.toBe(first)
  expect(dequeue([], 'a')).toEqual([])
})

test('"See changes" opens the details of its question and closes them on a second press', () => {
  expect(toggledDetail(null, 'a')).toBe('a')
  expect(toggledDetail('a', 'a')).toBeNull()
  expect(toggledDetail('b', 'a')).toBe('a')
})

// ---------------------------------------------------------------------------------------------------------------------
// Answers

test('Allow answers once: a later timeout, a double press and an abort are nothing', async () => {
  const d = createDecisions()
  const waiting = d.open('a')
  expect(d.has('a')).toBe(true)
  expect(d.size).toBe(1)
  expect(d.answer('a', 'allow')).toBe(true)
  expect(await waiting).toBe('allow')
  expect(d.answer('a', 'timeout')).toBe(false)
  expect(d.answer('a', 'allow')).toBe(false)
  expect(d.answer('a', 'cancel')).toBe(false)
  expect(d.has('a')).toBe(false)
  expect(d.size).toBe(0)
})

test('Cancel, a timeout and an interrupt each end the wait, and the first one wins', async () => {
  const d = createDecisions()
  const a = d.open('a')
  const b = d.open('b')
  const c = d.open('c')
  d.answer('a', 'cancel')
  d.answer('b', 'timeout')
  d.answer('c', 'aborted')
  d.answer('a', 'allow')
  d.answer('b', 'allow')
  d.answer('c', 'allow')
  expect(await Promise.all([a, b, c])).toEqual(['cancel', 'timeout', 'aborted'])
})

test('answering a question nobody waits for is false and harmless', () => {
  const d = createDecisions()
  expect(d.answer('nope', 'allow')).toBe(false)
  expect(d.has('nope')).toBe(false)
  expect(d.abortAll()).toBe(0)
})

test('waiting twice on one id ends the first wait as aborted; the second is still open', async () => {
  const d = createDecisions()
  const first = d.open('a')
  const second = d.open('a')
  expect(await first).toBe('aborted')
  expect(d.has('a')).toBe(true)
  d.answer('a', 'allow')
  expect(await second).toBe('allow')
})

test('abortAll ends every wait and counts them', async () => {
  const d = createDecisions()
  const waits = [d.open('a'), d.open('b'), d.open('c')]
  d.answer('b', 'allow')
  expect(d.abortAll()).toBe(2)
  expect(await Promise.all(waits)).toEqual(['aborted', 'allow', 'aborted'])
  expect(d.size).toBe(0)
  expect(d.abortAll()).toBe(0)
})

test('the question box: only the Allow label allows', () => {
  expect(answerOfDialog('Allow', 'Allow')).toBe('allow')
  expect(answerOfDialog('Cancel', 'Allow')).toBe('cancel')
  expect(answerOfDialog('allow', 'Allow')).toBe('cancel')
  expect(answerOfDialog('Allow, Cancel', 'Allow')).toBe('cancel')
  expect(answerOfDialog('Allow it please', 'Allow')).toBe('cancel')
  for (const value of [undefined, null, 1, true, {}, '', ' ']) expect(answerOfDialog(value, 'Allow')).toBe('cancel')
  expect(answerOfDialog('Cho chạy', 'Cho chạy')).toBe('allow')
})

test('the question box asks only for the question at the front that the band has not drawn, once', () => {
  const base = { isOpen: true, isFront: true, isDrawn: false, isAsking: false }
  expect(needsFallback(base)).toBe(true)
  expect(needsFallback({ ...base, isOpen: false })).toBe(false)
  expect(needsFallback({ ...base, isFront: false })).toBe(false)
  expect(needsFallback({ ...base, isDrawn: true })).toBe(false)
  expect(needsFallback({ ...base, isAsking: true })).toBe(false)
})

// ---------------------------------------------------------------------------------------------------------------------
// What the band is told

test('snapshotView: every outcome has a view', () => {
  const cfg = { maxSizeMB: 200 }
  const ok = { ok: true, id: '20261124T140512Z', n: 7, createdAt: 1_700_000_000_000, files: 342, bytes: 18_000_000, isPartial: false, hasGit: true, backend: 'node', skippedBinary: 0 } as const
  expect(snapshotView(ok, cfg)).toEqual({ state: 'saved', id: '20261124T140512Z', n: 7, at: 1_700_000_000_000, files: 342, bytes: 18_000_000, isPartial: false, hasGit: true })
  expect(snapshotView({ ...ok, isPartial: true, hasGit: false }, cfg)).toMatchObject({ state: 'saved', isPartial: true, hasGit: false })
  // no file to copy: a database or a remote branch, with or without a Git copy
  expect(snapshotView({ ...ok, files: 0, bytes: 0 }, cfg)).toEqual({ state: 'none', hasGit: true })
  expect(snapshotView({ ...ok, files: 0, bytes: 0, hasGit: false }, cfg)).toEqual({ state: 'none', hasGit: false })
  expect(snapshotView({ ok: false, reason: 'too-big', bytes: 5e9 }, { maxSizeMB: 50 })).toEqual({ state: 'too-big', limitMB: 50 })
  expect(snapshotView({ ok: false, reason: 'nothing' }, cfg)).toEqual({ state: 'none', hasGit: false })
  expect(snapshotView({ ok: false, reason: 'nothing', skipped: 0 }, cfg)).toEqual({ state: 'none', hasGit: false })
  // binary files that could not be saved are not "nothing to copy"
  expect(snapshotView({ ok: false, reason: 'nothing', skipped: 3 }, cfg)).toEqual({ state: 'failed' })
  expect(snapshotView({ ok: false, reason: 'failed' }, cfg)).toEqual({ state: 'failed' })
  for (const odd of [null, undefined, 5, 'x', {}, { ok: 'yes' }, []] as unknown as SnapshotOutcome[]) expect(snapshotView(odd, cfg)).toEqual({ state: 'failed' })
})

test('riskViewsOf: a folder is named with its trailing slash, a file without', () => {
  const risks = [risk({ kind: 'delete', paths: ['build'] })]
  const dirs = new Set(pathsToCheck(risks, ['build'], WHERE).map(dirKey))
  expect(riskViewsOf(risks, ['build'], WHERE, dirs)).toEqual([{ kind: 'delete', label: 'rm -rf', paths: ['build/'], count: 1 }])
  expect(riskViewsOf(risks, ['build'], WHERE)).toEqual([{ kind: 'delete', label: 'rm -rf', paths: ['build'], count: 1 }])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['build/'] })], ['build'], WHERE, dirs)[0]?.paths).toEqual(['build/'])
  expect(pathsToCheck(risks, ['build'], WHERE)).toEqual(['/work/acme-shop/build'])
})

test('riskViewsOf: several named paths, at most 3 shown and the count of all', () => {
  const risks = [risk({ kind: 'delete', paths: ['a', 'b.txt', 'c', 'd', 'e'] })]
  const [v] = riskViewsOf(risks, ['a', 'b.txt', 'c', 'd', 'e'], WHERE)
  expect(v?.paths).toEqual(['a', 'b.txt', 'c'])
  expect(v?.count).toBe(5)
  expect(pathsToCheck(risks, [], WHERE)).toEqual(['/work/acme-shop/a', '/work/acme-shop/b.txt', '/work/acme-shop/c'])
})

test('riskViewsOf: paths are read from where the command runs and shown from the project root', () => {
  const where = { ...WHERE, cwd: '/work/acme-shop/web' }
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['dist'] })], ['web/dist'], where)[0]?.paths).toEqual(['web/dist'])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['../api/out'] })], [], where)[0]?.paths).toEqual(['api/out'])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['/work/acme-shop/tmp'] })], [], where)[0]?.paths).toEqual(['tmp'])
  // `~` is the home folder, not the project: outside it, so the spelling stays
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['~/work/acme-shop/tmp'] })], [], where)[0]?.paths).toEqual(['~/work/acme-shop/tmp'])
})

test('riskViewsOf: the project itself, or a folder that holds it, is "."', () => {
  for (const p of ['.', './', '..', '../', '../..', '/work', '/work/acme-shop', '/work/acme-shop/']) {
    expect(riskViewsOf([risk({ kind: 'delete', paths: [p] })], [], WHERE)[0]?.paths).toEqual(['.'])
  }
  // a folder called "." is not marked as a folder
  const dirs = new Set(['/work/acme-shop'])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['.'] })], [], WHERE, dirs)[0]?.paths).toEqual(['.'])
})

test('riskViewsOf: a path outside the project keeps its spelling', () => {
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['/tmp/scratch'] })], [], WHERE)[0]?.paths).toEqual(['/tmp/scratch'])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['/tmp/scratch/'] })], [], WHERE, new Set(['/tmp/scratch']))[0]?.paths).toEqual(['/tmp/scratch/'])
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['~/old'] })], [], WHERE, new Set(['/home/dev/old']))[0]?.paths).toEqual(['~/old/'])
})

test('riskViewsOf: a path the command does not spell out is not shown ("files this command picks")', () => {
  const [v] = riskViewsOf([risk({ kind: 'delete', paths: ['$DIR', '`pwd`', ''], hasUnknownPath: true })], [], WHERE)
  expect(v?.paths).toEqual([])
  expect(v?.count).toBe(0)
  const [w] = riskViewsOf([risk({ kind: 'delete', paths: ['$DIR', 'build'], hasUnknownPath: true })], [], WHERE)
  expect(w?.paths).toEqual(['build'])
  expect(w?.count).toBe(1)
})

test('riskViewsOf: a wildcard shows what it matched (the targets), not the pattern', () => {
  const targets = ['build/a.js', 'build/b.js', 'build/css', 'build/img', 'build/z.txt']
  const [v] = riskViewsOf([risk({ kind: 'delete', paths: ['build/*'] })], targets, WHERE)
  expect(v?.paths).toEqual(['build/a.js', 'build/b.js', 'build/css'])
  expect(v?.count).toBe(5)
  // a named path and a wildcard: the named one is not counted twice
  const [w] = riskViewsOf([risk({ kind: 'delete', paths: ['old', 'build/*'] })], ['old', ...targets], WHERE)
  expect(w?.paths).toEqual(['old', 'build/a.js', 'build/b.js'])
  expect(w?.count).toBe(6)
  // a wildcard with nothing matched
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['nothing/*'] })], [], WHERE)[0]).toMatchObject({ paths: [], count: 0 })
  // two wildcard risks: the matches are shown once
  const both = riskViewsOf([risk({ kind: 'delete', paths: ['a/*'] }), risk({ kind: 'delete', paths: ['b/*'] })], ['a/x', 'b/y'], WHERE)
  expect(both.map(x => x.count)).toEqual([2, 0])
})

test('riskViewsOf: a brace list names several paths', () => {
  const [v] = riskViewsOf([risk({ kind: 'delete', paths: ['{dist,build}/out'] })], [], WHERE)
  expect(v?.paths).toEqual(['dist/out', 'build/out'])
  expect(v?.count).toBe(2)
})

test('riskViewsOf: every kind of risk, with its name and remote and no credentials of ours added', () => {
  const views = riskViewsOf(
    [
      risk({ kind: 'overwrite', tier: 'ask', label: 'cp .env.example', paths: ['.env'], source: '.env.example' }),
      risk({ kind: 'force-push', label: 'git push --force', name: 'main', remote: 'origin' }),
      risk({ kind: 'reset-hard', label: 'git reset --hard' }),
      risk({ kind: 'clean', label: 'git clean -f' }),
      risk({ kind: 'discard', label: 'git checkout --' }),
      risk({ kind: 'branch-delete', label: 'git branch -D', name: 'old-spike' }),
      risk({ kind: 'db-drop', label: 'psql', name: 'shop_dev', paths: [] }),
    ],
    ['.env'],
    WHERE,
  )
  expect(views).toEqual([
    { kind: 'overwrite', label: 'cp .env.example', paths: ['.env'], count: 1 },
    { kind: 'force-push', label: 'git push --force', name: 'main', remote: 'origin', paths: [], count: 0 },
    { kind: 'reset-hard', label: 'git reset --hard', paths: [], count: 0 },
    { kind: 'clean', label: 'git clean -f', paths: [], count: 0 },
    { kind: 'discard', label: 'git checkout --', paths: [], count: 0 },
    { kind: 'branch-delete', label: 'git branch -D', name: 'old-spike', paths: [], count: 0 },
    { kind: 'db-drop', label: 'psql', name: 'shop_dev', paths: [], count: 0 },
  ])
})

test('riskViewsOf: a Write over a file is the file, and a Windows project works', () => {
  expect(riskViewsOf([risk({ kind: 'overwrite', tier: 'snapshot', label: 'Write', paths: ['src/app.ts'] })], ['src/app.ts'], WHERE)[0]?.paths).toEqual(['src/app.ts'])
  const win = { root: 'C:\\Work\\Acme', cwd: 'C:\\Work\\Acme', home: 'C:\\Users\\dev' }
  const risks = [risk({ kind: 'delete', paths: ['build\\out'] })]
  const dirs = new Set(pathsToCheck(risks, [], win).map(dirKey))
  expect(riskViewsOf(risks, [], win, dirs)[0]?.paths).toEqual(['build/out/'])
  // the folder is found whatever the case the engine reports
  expect(riskViewsOf(risks, [], win, new Set(['c:/work/acme/build/out']))[0]?.paths).toEqual(['build/out/'])
})

test('riskViewsOf and pathsToCheck are total', () => {
  for (const odd of [undefined, null, 5, 'x', {}, [null], [5], [{}], [{ kind: 'delete' }], [{ kind: 'delete', paths: 'x' }], [{ kind: 'delete', paths: [5, null] }]] as unknown[]) {
    expect(() => riskViewsOf(odd as never, odd as never, WHERE)).not.toThrow()
    expect(() => pathsToCheck(odd as never, odd as never, WHERE)).not.toThrow()
  }
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['x'.repeat(10_000)] })], [], WHERE)).toHaveLength(1)
  expect(riskViewsOf([risk({ kind: 'delete', paths: Array.from({ length: 500 }, (_, i) => `d${i}`) })], [], WHERE)[0]?.paths).toHaveLength(3)
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['a'] })], [], { root: '', cwd: '', home: '' })[0]?.paths).toEqual([])
})

test('buildPending: gitLost is kept only when true', () => {
  const base = { id: 'x', at: 1, tool: 'Bash', risks: [], snapshot: saved() }
  expect(buildPending({ ...base, gitLost: true }).gitLost).toBe(true)
  for (const v of [false, undefined, 'yes' as never, 1 as never]) expect('gitLost' in buildPending({ ...base, gitLost: v }), String(v)).toBe(false)
})

test('buildPending: a plain copy; variable names are names only, capped, strings only', () => {
  const names = Array.from({ length: 80 }, (_, i) => `VAR_${i}`)
  const p = buildPending({
    id: 'call-1', at: 5, tool: 'Write', risks: [], snapshot: saved(),
    env: { before: 12, after: 9, removed: [...names, 7 as never, null as never], added: ['NEW_ONE'] }, isAgent: true,
  })
  expect(p.env?.removed).toHaveLength(50)
  expect(p.env?.removed[0]).toBe('VAR_0')
  expect(p.env?.added).toEqual(['NEW_ONE'])
  expect(p.env).toMatchObject({ before: 12, after: 9 })
  expect(p.isAgent).toBe(true)
  expect(p.tool).toBe('Write')
  expect(p.id).toBe('call-1')
  const bare = buildPending({ id: 'x', at: Number.NaN, tool: 'Bash', risks: [], snapshot: { state: 'failed' } })
  expect(bare).toEqual({ id: 'x', at: 0, tool: 'Bash', risks: [], snapshot: { state: 'failed' } })
  expect('env' in bare).toBe(false)
  expect('isAgent' in bare).toBe(false)
  expect('isAgent' in buildPending({ id: 'x', at: 1, tool: 'Bash', risks: [], snapshot: { state: 'failed' }, isAgent: false })).toBe(false)
  expect(buildPending({ id: 'x', at: 1, tool: 'Bash', risks: [], snapshot: { state: 'failed' }, env: { before: Number.NaN, after: 3, removed: 'x' as never, added: undefined as never } }).env).toEqual({ before: 0, after: 3, removed: [], added: [] })
})

test('fallbackId: a different id each time, always text', () => {
  const ids = new Set(Array.from({ length: 500 }, () => fallbackId(1_700_000_000_000)))
  expect(ids.size).toBe(500)
  for (const id of ids) expect(id).toMatch(/^q[0-9a-z]+-[0-9a-z]+$/)
  expect(fallbackId(Number.NaN)).toMatch(/^q0-/)
})

// ---------------------------------------------------------------------------------------------------------------------
// Small rewrites

test('withNote adds one context line to an allowed call and leaves a refusal alone', () => {
  const result = { result: { stdout: 'ok' }, ref: 4, text: 'ok' }
  expect(withNote(result, 'saved #7')).toEqual({ ...result, context: ['saved #7'] })
  expect(withNote({ ...result, context: ['earlier'] }, 'saved #7').context).toEqual(['earlier', 'saved #7'])
  expect(withNote({ deny: 'no' }, 'saved #7')).toEqual({ deny: 'no' })
  expect(withNote(result, null)).toBe(result)
  expect(withNote(result, '')).toBe(result)
  expect(result).not.toHaveProperty('context')
  expect(withNote({ ...result, context: 'x' as never }, 'n').context).toEqual(['n'])
  expect(withNote({ ...result, context: ['a', 5 as never] }, 'n').context).toEqual(['a', 'n'])
  expect(withNote({ ...result, isError: true as const }, 'n')).toMatchObject({ isError: true, context: ['n'] })
  for (const odd of [undefined, null, 5, 'x', [1]]) expect(withNote(odd, 'n')).toBe(odd)
})

test('maskBlocks: text, nested tool results and plain strings are masked; images and pinned blocks are not walked', () => {
  const key = anthropic()
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${key}${'A'.repeat(1000)}` } }
  const content = [
    { type: 'text', text: `KEY=${key}` },
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `token ${github()}` }, image] },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: `plain ${key}` },
    { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: `echo ${key}` } },
    { type: 'document', source: { data: key } },
    { type: 'thinking', thinking: key },
    { type: 'text', text: 'nothing secret' },
  ]
  const found = maskBlocks(content)
  expect(found.count).toBe(3)
  const out = found.value as typeof content
  expect((out[0] as { text: string }).text).toBe(`KEY=sk-ant-${MARK}`)
  const inner = (out[1] as { content: { text?: string }[] }).content
  expect(inner[0]?.text).toBe(`token ghp_${MARK}`)
  expect(inner[1]).toBe(image)
  expect((out[1] as { tool_use_id: string }).tool_use_id).toBe('toolu_1')
  expect((out[2] as { content: string }).content).toBe(`plain sk-ant-${MARK}`)
  // not walked: what the engine pins and what is megabytes of base64
  expect(out[3]).toBe(content[3])
  expect(out[4]).toBe(content[4])
  expect(out[5]).toBe(content[5])
  expect(out[6]).toBe(content[6])
  expect(JSON.stringify(content)).toContain(key)
  expect(JSON.stringify([out[0], inner[0], out[2]])).not.toContain(key)
  expect(maskBlocks(`export TOKEN=${key}`)).toEqual({ value: `export TOKEN=sk-ant-${MARK}`, count: 1 })
})

test('maskBlocks: nothing to mask returns the very same content, and odd content is returned as it is', () => {
  const clean = [{ type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ls output' }] }]
  const found = maskBlocks(clean)
  expect(found.count).toBe(0)
  expect(found.value).toBe(clean)
  expect(maskBlocks('hello')).toEqual({ value: 'hello', count: 0 })
  for (const odd of [undefined, null, 5, true, {}, { type: 'text' }]) expect(maskBlocks(odd)).toEqual({ value: odd, count: 0 })
  const blocks = [null, 5, 'a string', [], { type: 5, text: 'x' }, { type: 'tool_result' }, { type: 'tool_result', content: null }]
  expect(() => maskBlocks(blocks)).not.toThrow()
  expect(maskBlocks(blocks).count).toBe(0)
  const withString = ['loose ' + anthropic()]
  expect(maskBlocks(withString)).toEqual({ value: [`loose sk-ant-${MARK}`], count: 1 })
})

test('maskBlocks never changes its input', () => {
  const content = [{ type: 'text', text: anthropic() }]
  const before = JSON.stringify(content)
  maskBlocks(content)
  expect(JSON.stringify(content)).toBe(before)
})

test('parseArgs: the first word in lower case, the rest trimmed', () => {
  expect(parseArgs('')).toEqual({ verb: '', tail: '' })
  expect(parseArgs('   ')).toEqual({ verb: '', tail: '' })
  expect(parseArgs('list')).toEqual({ verb: 'list', tail: '' })
  expect(parseArgs('  LIST  ')).toEqual({ verb: 'list', tail: '' })
  expect(parseArgs('restore 7')).toEqual({ verb: 'restore', tail: '7' })
  expect(parseArgs('Restore   #7  ')).toEqual({ verb: 'restore', tail: '#7' })
  expect(parseArgs('restore a b\nc')).toEqual({ verb: 'restore', tail: 'a b\nc' })
  for (const odd of [undefined, null, 5, {}, []]) expect(parseArgs(odd)).toEqual({ verb: '', tail: '' })
  expect(parseArgs('x'.repeat(100_000)).verb).toHaveLength(2000)
})

// ---------------------------------------------------------------------------------------------------------------------
// Nothing to lose

test('hasNothingToLose: a delete of something that is not there loses nothing, so nothing is asked', () => {
  const del = risk({ kind: 'delete', paths: ['build'] })
  expect(hasNothingToLose({ risks: [del], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(true)
  expect(hasNothingToLose({ risks: [del, risk({ kind: 'delete', paths: ['dist'] })], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(true)
  // something exists: ask
  expect(hasNothingToLose({ risks: [del], targets: ['build'], isUnknown: false }, WHERE.root, WHERE.home)).toBe(false)
  // a path that could not be read from its spelling, or a list that was cut short: unknown is not nothing
  expect(hasNothingToLose({ risks: [del], targets: [], isUnknown: true }, WHERE.root, WHERE.home)).toBe(false)
  expect(hasNothingToLose({ risks: [risk({ kind: 'delete', hasUnknownPath: true })], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(false)
  // only deletes qualify: history, uncommitted work and databases have no files of ours to look for
  for (const kind of ['force-push', 'reset-hard', 'clean', 'discard', 'branch-delete', 'db-drop', 'overwrite', 'unparsed'] as const) {
    expect(hasNothingToLose({ risks: [risk({ kind })], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(false)
    expect(hasNothingToLose({ risks: [del, risk({ kind })], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(false)
  }
  // no risk at all is the caller's business, not "nothing to lose"
  expect(hasNothingToLose({ risks: [], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(false)
})

test('hasNothingToLose: never for a filesystem root or the home folder, where no targets means too much to look at', () => {
  const a = { risks: [risk({ kind: 'delete', paths: ['x'] })], targets: [], isUnknown: false }
  expect(hasNothingToLose(a, '/', '/home/dev')).toBe(false)
  expect(hasNothingToLose(a, 'C:\\', 'C:\\Users\\dev')).toBe(false)
  expect(hasNothingToLose(a, '/home/dev', '/home/dev')).toBe(false)
  expect(hasNothingToLose(a, '/home/dev/', '/home/dev')).toBe(false)
  expect(hasNothingToLose(a, 'C:\\Users\\Dev', 'c:/users/dev')).toBe(false)
  expect(hasNothingToLose(a, '', '/home/dev')).toBe(false)
  // a project below home is an ordinary project; an unknown home changes nothing
  expect(hasNothingToLose(a, '/home/dev/acme-shop', '/home/dev')).toBe(true)
  expect(hasNothingToLose(a, '/home/dev/acme-shop', '')).toBe(true)
})

test('hasNothingToLose is total: odd input is "not nothing", never an exception', () => {
  const odd: unknown[] = [undefined, null, 5, 'x', [], {}, { risks: 'x' }, { risks: [null], targets: 'y', isUnknown: 'no' }, { risks: [{}], targets: [], isUnknown: false }]
  for (const a of odd) expect(hasNothingToLose(a as never, WHERE.root, WHERE.home)).toBe(false)
  for (const root of [undefined, null, 5, {}]) expect(hasNothingToLose({ risks: [risk({ kind: 'delete' })], targets: [], isUnknown: false }, root as never, WHERE.home)).toBe(false)
})

// ---------------------------------------------------------------------------------------------------------------------
// Fix pass D

test('hasNothingToLose: a command line that could not be read is never "nothing", whatever else is known about it', () => {
  const unparsed = risk({ kind: 'unparsed', label: 'Bash' })
  const del = risk({ kind: 'delete', paths: ['build'] })
  for (const targets of [[], ['build']]) {
    for (const isUnknown of [false, true]) {
      expect(hasNothingToLose({ risks: [unparsed], targets, isUnknown }, WHERE.root, WHERE.home)).toBe(false)
      expect(hasNothingToLose({ risks: [del, unparsed], targets, isUnknown }, WHERE.root, WHERE.home)).toBe(false)
      expect(hasNothingToLose({ risks: [unparsed, del], targets, isUnknown }, WHERE.root, WHERE.home)).toBe(false)
    }
  }
  // the delete next to it is nothing on its own
  expect(hasNothingToLose({ risks: [del], targets: [], isUnknown: false }, WHERE.root, WHERE.home)).toBe(true)
})

test('snapshotView: more than the file count limit is its own reason; the size limit stays as it was', () => {
  const cfg = { maxSizeMB: 200 }
  expect(snapshotView({ ok: false, reason: 'too-big', byFiles: true }, cfg)).toEqual({ state: 'too-big', limitMB: 200, byFiles: true })
  expect(snapshotView({ ok: false, reason: 'too-big', bytes: 5e9 }, cfg)).toEqual({ state: 'too-big', limitMB: 200 })
  expect('byFiles' in snapshotView({ ok: false, reason: 'too-big', bytes: 5e9 }, cfg)).toBe(false)
  // only `true` counts
  for (const odd of [false, 1, 'yes', null, undefined, {}]) expect('byFiles' in snapshotView({ ok: false, reason: 'too-big', byFiles: odd as never }, cfg)).toBe(false)
})

test('snapshotView: a Git state that could not be saved is carried, also when there are no files', () => {
  const cfg = { maxSizeMB: 200 }
  const ok = { ok: true, id: '20261124T140512Z', n: 7, createdAt: 1_700_000_000_000, files: 3, bytes: 900, isPartial: false, hasGit: true, backend: 'node', skippedBinary: 0 } as const
  expect(snapshotView({ ...ok, isGitPartial: true }, cfg)).toEqual({
    state: 'saved', id: '20261124T140512Z', n: 7, at: 1_700_000_000_000, files: 3, bytes: 900, isPartial: false, hasGit: true, isGitPartial: true,
  })
  // no files: with a sound Git state it is "nothing to copy", with a partial one it stays a snapshot that says so
  expect(snapshotView({ ...ok, files: 0, bytes: 0 }, cfg)).toEqual({ state: 'none', hasGit: true })
  expect(snapshotView({ ...ok, files: 0, bytes: 0, isGitPartial: true }, cfg)).toEqual({
    state: 'saved', id: '20261124T140512Z', n: 7, at: 1_700_000_000_000, files: 0, bytes: 0, isPartial: false, hasGit: true, isGitPartial: true,
  })
  // not partial: no flag at all
  expect('isGitPartial' in snapshotView(ok, cfg)).toBe(false)
  for (const odd of [false, 1, 'yes', null, undefined]) expect('isGitPartial' in snapshotView({ ...ok, isGitPartial: odd as never }, cfg)).toBe(false)
})

test('riskViewsOf: a delete that picks its files when it runs names no path, even though a snapshot of where it looks was taken', () => {
  const find = risk({ kind: 'delete', label: 'find -delete', paths: ['.'], picks: true })
  const [view] = riskViewsOf([find], ['src/a.pyc', 'src/b.pyc'], WHERE)
  expect(view).toEqual({ kind: 'delete', label: 'find -delete', paths: [], count: 0, picks: true })
  const sub = riskViewsOf([risk({ kind: 'delete', label: 'find -delete', paths: ['build'], picks: true })], ['build/a.pyc'], WHERE)[0]
  expect(sub).toEqual({ kind: 'delete', label: 'find -delete', paths: [], count: 0, picks: true })
  // an ordinary delete and a delete with a flag that is not `true` are as before
  expect(riskViewsOf([risk({ kind: 'delete', paths: ['build'] })], ['build'], WHERE)[0]).toEqual({ kind: 'delete', label: 'rm -rf', paths: ['build'], count: 1 })
  expect('picks' in riskViewsOf([risk({ kind: 'delete', paths: ['build'], picks: false as never })], ['build'], WHERE)[0]!).toBe(false)
  // its paths are not looked up (nobody shows them), the others are
  expect(pathsToCheck([find], ['src/a.pyc'], WHERE)).toEqual([])
  expect(pathsToCheck([find, risk({ kind: 'delete', paths: ['build'] })], [], WHERE)).toEqual(['/work/acme-shop/build'])
})

test('snapshotView: a .env that cannot be copied without Node is its own view, and a partial save carries it', () => {
  const cfg = { maxSizeMB: 200 }
  const ok = { ok: true, id: '20261124T140512Z', n: 7, createdAt: 1_700_000_000_000, files: 3, bytes: 900, isPartial: false, hasGit: false, backend: 'fs', skippedBinary: 0 } as const
  expect(snapshotView({ ok: false, reason: 'private' }, cfg)).toEqual({ state: 'needs-node' })
  // a success that left a .env out is a partial save, even if the vault did not say so
  expect(snapshotView({ ...ok, skippedPrivate: 1 }, cfg)).toEqual({ state: 'saved', id: '20261124T140512Z', n: 7, at: 1_700_000_000_000, files: 3, bytes: 900, isPartial: true, hasGit: false })
  expect(snapshotView({ ...ok, isPartial: true, skippedPrivate: 2 }, cfg)).toMatchObject({ state: 'saved', isPartial: true })
  // no files copied but a .env left out (with a Git state to keep): still a save that says some files were left out, never "nothing to copy"
  expect(snapshotView({ ...ok, files: 0, bytes: 0, hasGit: true, skippedPrivate: 1 }, cfg)).toMatchObject({ state: 'saved', files: 0, isPartial: true, hasGit: true })
  // nothing private: as before
  expect(snapshotView({ ...ok, skippedPrivate: 0 }, cfg)).toMatchObject({ state: 'saved', isPartial: false })
  for (const odd of [false, 'yes', null, undefined, -1, Number.NaN]) expect(snapshotView({ ...ok, skippedPrivate: odd as never }, cfg)).toMatchObject({ state: 'saved', isPartial: false })
  expect(snapshotView({ ok: false, reason: 'nothing' }, cfg)).toEqual({ state: 'none', hasGit: false })
  expect(snapshotView({ ok: false, reason: 'failed' }, cfg)).toEqual({ state: 'failed' })
})

test('snapshotView: the limits of a quiet cleanup are the ones named when it is too big', () => {
  const quiet = limitsOf(DEFAULT_OPTIONS, true).view
  expect(snapshotView({ ok: false, reason: 'too-big', bytes: 5e9 }, quiet)).toEqual({ state: 'too-big', limitMB: 50 })
  expect(snapshotView({ ok: false, reason: 'too-big', byFiles: true }, quiet)).toEqual({ state: 'too-big', limitMB: 50, byFiles: true, limitFiles: 2000 })
  // the usual limit names no file count of its own (the words use 50,000), and a limit that is not below it is not named either
  expect(snapshotView({ ok: false, reason: 'too-big', byFiles: true }, { maxSizeMB: 200 })).toEqual({ state: 'too-big', limitMB: 200, byFiles: true })
  for (const odd of [50_000, 60_000, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, '2000', null]) {
    expect('limitFiles' in snapshotView({ ok: false, reason: 'too-big', byFiles: true }, { maxSizeMB: 200, maxFiles: odd as never })).toBe(false)
  }
  expect(snapshotView({ ok: false, reason: 'too-big', byFiles: true }, { maxSizeMB: 200, maxFiles: 10.9 })).toMatchObject({ limitFiles: 10 })
})

test('riskViewsOf: a filtered delete with a name carries the name and where it looks; without a name nothing changes', () => {
  const find = (over: Partial<Risk> = {}) => risk({ kind: 'delete', label: 'find -delete', paths: ['.'], picks: true, match: 'node_modules', ...over })
  expect(riskViewsOf([find()], ['a/node_modules'], WHERE)[0]).toEqual({ kind: 'delete', label: 'find -delete', paths: ['.'], count: 1, picks: true, match: 'node_modules' })
  const dirs = new Set(pathsToCheck([find({ paths: ['src'] })], [], WHERE).map(dirKey))
  expect(riskViewsOf([find({ paths: ['src'] })], [], WHERE, dirs)[0]).toEqual({ kind: 'delete', label: 'find -delete', paths: ['src/'], count: 1, picks: true, match: 'node_modules' })
  expect(pathsToCheck([find({ paths: ['src'] })], [], WHERE)).toEqual(['/work/acme-shop/src'])
  // several places it looks: the first three and the count
  const many = riskViewsOf([find({ paths: ['a', 'b', 'c', 'd'] })], [], WHERE)[0]
  expect(many).toMatchObject({ paths: ['a', 'b', 'c'], count: 4, match: 'node_modules' })
  // no name, an empty one or one that is not text: the old view, with no path
  for (const m of [undefined, '', 5, null, {}] as never[]) {
    const v = riskViewsOf([find({ match: m })], ['a/b'], WHERE)[0]!
    expect(v).toEqual({ kind: 'delete', label: 'find -delete', paths: [], count: 0, picks: true })
    expect('match' in v).toBe(false)
  }
  expect(pathsToCheck([find({ match: undefined })], [], WHERE)).toEqual([])
  // a name belongs to a filtered delete only
  const plain = riskViewsOf([risk({ kind: 'delete', paths: ['build'], match: 'x' })], ['build'], WHERE)[0]!
  expect(plain).toEqual({ kind: 'delete', label: 'rm -rf', paths: ['build'], count: 1 })
  expect('match' in riskViewsOf([risk({ kind: 'overwrite', paths: ['a.txt'], picks: false as never, match: 'x' })], ['a.txt'], WHERE)[0]!).toBe(false)
  // a very long or odd name is cut and kept as text (the words clean it)
  expect(riskViewsOf([find({ match: 'x'.repeat(5000) })], [], WHERE)[0]?.match).toHaveLength(200)
  expect(riskViewsOf([find({ match: 'a"b\u202Ec' })], [], WHERE)[0]?.match).toBe('a"b\u202Ec')
})

test('riskViewsOf: the emptying of Git\'s own safety nets is a risk with its label and no files', () => {
  const labels = ['git stash drop', 'git stash clear', 'git update-ref -d', 'git reflog expire', 'git gc --prune=now']
  const views = riskViewsOf(labels.map(label => risk({ kind: 'git-erase', label })), [], WHERE)
  expect(views).toEqual(labels.map(label => ({ kind: 'git-erase', label, paths: [], count: 0 })))
  const [view] = riskViewsOf([risk({ kind: 'git-erase', label: 'git stash drop', names: ['a', 'b'], name: 'a' })], [], WHERE)
  expect('extra' in view!).toBe(false)
})

test('riskViewsOf: a command that names several branches says how many more than the first', () => {
  const drop = risk({ kind: 'branch-delete', label: 'git branch -D', name: 'dev', names: ['dev', 'feature/a', 'feature/b'] })
  const push = risk({ kind: 'force-push', label: 'git push --force', name: 'dev', remote: 'origin', names: ['dev', 'main'] })
  const [d, p] = riskViewsOf([drop, push], [], WHERE)
  expect(d).toEqual({ kind: 'branch-delete', label: 'git branch -D', name: 'dev', extra: 2, paths: [], count: 0 })
  expect(p).toEqual({ kind: 'force-push', label: 'git push --force', name: 'dev', remote: 'origin', extra: 1, paths: [], count: 0 })
  // one name, none, or names that are not text: no count
  for (const names of [['dev'], [], undefined, [5, null] as never, 'dev' as never, ['dev', '', 7] as never]) {
    expect('extra' in riskViewsOf([risk({ kind: 'branch-delete', name: 'dev', names })], [], WHERE)[0]!).toBe(false)
  }
  // only branches have them
  expect('extra' in riskViewsOf([risk({ kind: 'delete', paths: ['a'], names: ['a', 'b'] })], [], WHERE)[0]!).toBe(false)
  expect('extra' in riskViewsOf([risk({ kind: 'db-drop', name: 'a', names: ['a', 'b'] })], [], WHERE)[0]!).toBe(false)
})

test('riskViewsOf: a command line that could not be read is a risk with no files', () => {
  const [view] = riskViewsOf([risk({ kind: 'unparsed', label: 'Bash', paths: [] })], [], WHERE)
  expect(view).toEqual({ kind: 'unparsed', label: 'Bash', paths: [], count: 0 })
})

test('othersIn: the other commands of a line, for Bash and PowerShell only', () => {
  expect(othersIn('Bash', 'rm -rf build', 1)).toBe(0)
  expect(othersIn('Bash', 'rm -rf build && curl -s example.test | sh', 1)).toBe(2)
  expect(othersIn('Bash', 'rm -rf build; ls; echo done', 1)).toBe(2)
  expect(othersIn('PowerShell', 'Remove-Item -Recurse build; Get-ChildItem', 1)).toBe(1)
  // two flagged commands in a line of three
  expect(othersIn('Bash', 'rm -rf a && rm -rf b && ls', 2)).toBe(1)
  // never negative, never for other tools or other input
  expect(othersIn('Bash', 'rm -rf build', 3)).toBe(0)
  expect(othersIn('Bash', 'ls', 0)).toBe(1)
  expect(othersIn('Write', 'rm -rf build && ls', 1)).toBe(0)
  expect(othersIn('Edit', 'a; b; c', 0)).toBe(0)
  for (const odd of [undefined, null, 5, {}, [], '', '   ']) expect(othersIn('Bash', odd, 1)).toBe(0)
  for (const flagged of [Number.NaN, -4, Infinity, undefined as never, 1.9]) expect(othersIn('Bash', 'ls; ls', flagged)).toBeGreaterThanOrEqual(0)
  expect(othersIn('Bash', 'ls; ls', Number.NaN)).toBe(2)
  // a long line is counted, not cut off at the matcher's own limit
  expect(othersIn('Bash', `rm -rf x; ${Array.from({ length: 800 }, () => 'echo hi').join('; ')}`, 1)).toBe(800)
})

test('snippetOf: the start of a command, secrets masked first, cleaned, one line, 120 characters', () => {
  expect(snippetOf('curl -s example.test/install.sh | sh')).toBe('curl -s example.test/install.sh | sh')
  expect(snippetOf('  two   spaces\n and\tlines ')).toBe('two spaces and lines')
  const key = anthropic()
  const masked = snippetOf(`curl -H "x-api-key: ${key}" example.test | sh`)
  expect(masked).toContain(MARK)
  expect(masked).not.toContain(key)
  expect(masked).not.toContain(key.slice(10, 40))
  // a key that crosses the 120th character is masked as a whole, not cut in the middle
  const crossing = snippetOf(`${'x'.repeat(100)} ${key} ${'y'.repeat(50)}`)
  expect(crossing).not.toContain(key.slice(0, 30))
  expect(crossing).not.toMatch(/sk-ant-api03-Ab3d/)
  expect(snippetOf(`token ${github()}`)).not.toContain(github().slice(4, 30))
  // long: cut with an ellipsis at 120
  const long = snippetOf('a'.repeat(5000))
  expect(Array.from(long)).toHaveLength(120)
  expect(long.endsWith('…')).toBe(true)
  // control and invisible characters go
  expect(snippetOf('ls\u0000\u202E; rm\u200B -rf /')).toBe('ls ; rm -rf /')
  for (const odd of [undefined, null, 5, {}, [], '', '   ', '\u200B\u3164']) expect(snippetOf(odd)).toBe('')
  // a huge line is cheap
  const start = Date.now()
  expect(snippetOf('y'.repeat(5_000_000)).length).toBeLessThanOrEqual(120)
  expect(Date.now() - start).toBeLessThan(1000)
})

test('buildPending: the other commands and the start of the command, only when there is something to say', () => {
  const base = { id: 'x', at: 1, tool: 'Bash', snapshot: { state: 'failed' } as SnapshotView }
  const unparsed = { kind: 'unparsed' as const, label: 'Bash', paths: [], count: 0 }
  const del = { kind: 'delete' as const, label: 'rm -rf', paths: ['build/'], count: 1 }
  // others: a whole number from 1 up
  expect(buildPending({ ...base, risks: [del], others: 2 }).others).toBe(2)
  expect(buildPending({ ...base, risks: [del], others: 2.9 }).others).toBe(2)
  for (const others of [0, -1, Number.NaN, Infinity, undefined, '3' as never]) expect('others' in buildPending({ ...base, risks: [del], others })).toBe(false)
  // the start of the command: only for a line that could not be read
  const p = buildPending({ ...base, risks: [unparsed], command: 'curl -s example.test | sh' })
  expect(p.snippet).toBe('curl -s example.test | sh')
  expect('snippet' in buildPending({ ...base, risks: [del], command: 'rm -rf build/' })).toBe(false)
  expect('snippet' in buildPending({ ...base, risks: [], command: 'rm -rf build/' })).toBe(false)
  expect('snippet' in buildPending({ ...base, risks: [unparsed] })).toBe(false)
  expect('snippet' in buildPending({ ...base, risks: [unparsed], command: '   ' })).toBe(false)
  expect(buildPending({ ...base, risks: [del, unparsed], command: 'rm -rf build/ && x' }).snippet).toBe('rm -rf build/ && x')
  // the secret in it is masked, and the command is not kept anywhere else on the question
  const key = anthropic()
  const secret = buildPending({ ...base, risks: [unparsed], command: `API_KEY=${key} run` })
  expect(JSON.stringify(secret)).not.toContain(key)
  expect(secret.snippet).toContain(MARK)
  expect('command' in secret).toBe(false)
  // odd risks and odd commands never throw
  expect(() => buildPending({ ...base, risks: undefined as never, command: 5 as never })).not.toThrow()
})

test('isEarlyPress: a press less than 600 ms after the question first drew is not an answer', () => {
  expect(PRESS_GUARD_MS).toBe(600)
  expect(isEarlyPress(1000, 1000)).toBe(true)
  expect(isEarlyPress(1000, 1599)).toBe(true)
  expect(isEarlyPress(1000, 1600)).toBe(false)
  expect(isEarlyPress(1000, 9999)).toBe(false)
  // a question never seen drawn, a clock that went back, and odd numbers are never "early"
  expect(isEarlyPress(undefined, 1000)).toBe(false)
  expect(isEarlyPress(1000, 500)).toBe(false)
  for (const odd of [Number.NaN, Infinity, -Infinity, '5' as never, null as never]) {
    expect(isEarlyPress(odd as never, 1000)).toBe(false)
    expect(isEarlyPress(1000, odd as never)).toBe(false)
  }
})

test('isSnapshotStale: older than a minute when the person says Allow', () => {
  expect(STALE_SNAPSHOT_MS).toBe(60_000)
  expect(isSnapshotStale(0, 60_000)).toBe(false)
  expect(isSnapshotStale(0, 60_001)).toBe(true)
  expect(isSnapshotStale(1_000, 30_000)).toBe(false)
  expect(isSnapshotStale(1_000, 20 * 60_000)).toBe(true)
  // a clock that went back, and odd numbers, are not stale
  expect(isSnapshotStale(100_000, 50_000)).toBe(false)
  for (const odd of [Number.NaN, Infinity, '1' as never, undefined as never]) {
    expect(isSnapshotStale(odd as never, 10 ** 9)).toBe(false)
    expect(isSnapshotStale(0, odd as never)).toBe(false)
  }
})

test('createAsked: marks a call, forgets it, keeps the newest 500', () => {
  const asked = createAsked()
  expect(asked.has('a')).toBe(false)
  asked.mark('a')
  asked.mark('a')
  expect(asked.has('a')).toBe(true)
  expect(asked.size).toBe(1)
  asked.clear('a')
  asked.clear('never-marked')
  expect(asked.has('a')).toBe(false)
  expect(asked.size).toBe(0)
  for (let i = 0; i < 700; i += 1) asked.mark(`id-${i}`)
  expect(asked.size).toBe(500)
  expect(asked.has('id-0')).toBe(false)
  expect(asked.has('id-199')).toBe(false)
  expect(asked.has('id-200')).toBe(true)
  expect(asked.has('id-699')).toBe(true)
  // marking again makes it the newest
  asked.mark('id-200')
  for (let i = 700; i < 900; i += 1) asked.mark(`id-${i}`)
  expect(asked.has('id-200')).toBe(true)
  expect(asked.has('id-201')).toBe(false)
  // two lists share nothing
  expect(createAsked().has('id-200')).toBe(false)
})

test('catchVerdict: what ran stands, a call that was asked about is refused, anything else goes on', () => {
  expect(catchVerdict({ called: true, wasAsked: true })).toBe('replay')
  expect(catchVerdict({ called: true, wasAsked: false })).toBe('replay')
  expect(catchVerdict({ called: false, wasAsked: true })).toBe('deny')
  expect(catchVerdict({ called: false, wasAsked: false })).toBe('pass')
  for (const odd of [undefined, null, {}, { called: 'yes', wasAsked: 'yes' }] as never[]) expect(catchVerdict(odd)).toBe('pass')
  expect(DENY_COULD_NOT_FINISH).toBe('Safety Net could not finish asking the person, so nothing was run. Ask them and try again.')
})
