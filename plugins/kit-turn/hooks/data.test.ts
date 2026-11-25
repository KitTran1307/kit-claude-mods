import { expect, test } from 'claude-code/testing'

import type { FileChange, Summary } from '../types'
import {
  PUSH_PROMPT, COLORS, applyFileStats, buildSteps, buttonRows, cardRows, changesText, clampInt, clockTime, commandOf, commitSubject, commitText, deltaFiles, editStats, firstLine,
  fitSteps, fileText, formatDuration, formatElapsed, formatLine, maxFilesFrom, oneLine, parseCommits, parseCount, parseNumstat, outputOf, parseTestOutput, unpushedOf,
  planBand, renameTarget, shortPath, shortText, stepText, stripControl, styleOption, summaryText, textCells, timelineRows, totals, wrapRows,
} from './data'
import type { Message } from './data'
import { TABLES, languageFromSetting, languageOption } from './i18n'

const en = TABLES.en
const vi = TABLES.vi
// Local time, so "14:02" is the same in every time zone the tests may run in.
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 25, h, m, s).getTime()

const FILES: FileChange[] = [
  { path: 'src/cart/checkout.ts', added: 22, removed: 5 },
  { path: 'src/cart/discount.ts', added: 14, removed: 6 },
  { path: 'tests/checkout.test.ts', added: 4, removed: 1 },
]
const SUMMARY: Summary = {
  startedAt: at(14, 2), endedAt: at(14, 5, 12), durationMs: 192_000, outcome: 'done',
  what: 'Fixed the rounding of the cart total at checkout.', asked: 'Fix the rounding of the cart total',
  files: FILES, filesApprox: false, commitsMade: 0,
  tests: { runner: 'node', passed: 12, failed: 0, skipped: 0 }, testRuns: 1,
  steps: [
    { at: at(14, 2), kind: 'start', text: 'Fix the rounding of the cart total' },
    { at: at(14, 3), kind: 'read', n: 6, m: 0 },
    { at: at(14, 3, 30), kind: 'edit', file: 'src/cart/checkout.ts', added: 22, removed: 5 },
    { at: at(14, 4), kind: 'edit', file: 'src/cart/discount.ts', added: 14, removed: 6 },
    { at: at(14, 4, 30), kind: 'create', file: 'tests/checkout.test.ts', added: 4, removed: 1 },
    { at: at(14, 5), kind: 'test', test: { runner: 'node', passed: 12, failed: 0, skipped: 0 } },
    { at: at(14, 5, 5), kind: 'commit', text: 'Fix cart rounding' },
  ],
  unpushed: { count: 2, upstream: 'origin/main', commits: [{ hash: 'a1b2c3d', subject: 'Fix cart rounding' }, { hash: 'e4f5a6b', subject: 'Add test' }] },
}

test('options are clamped and fall back to their defaults', () => {
  expect([undefined, null, 'x', NaN, Infinity, {}, true].map(maxFilesFrom)).toEqual([8, 8, 8, 8, 8, 8, 8])
  expect([-5, 0, 1, 7.9, 30, 31, 400].map(maxFilesFrom)).toEqual([1, 1, 1, 7, 30, 30, 30])
  expect(clampInt(5, 2, 0, 3)).toBe(3)
  expect(['card', 'timeline', 'TIMELINE', undefined, 3, {}].map(styleOption)).toEqual(['card', 'timeline', 'card', 'card', 'card', 'card'])
  expect(['auto', 'en', 'vi', 'fr', undefined].map(languageOption)).toEqual(['auto', 'en', 'vi', 'auto', 'auto'])
  expect(['Vietnamese', 'vi', 'Tiếng Việt', 'vi-VN', 'english', 7].map(languageFromSetting)).toEqual(['vi', 'vi', 'vi', 'vi', 'en', 'en'])
})

test('time formats: clock, duration and elapsed, in English and Vietnamese', () => {
  expect(clockTime(at(14, 2))).toBe('14:02')
  expect(clockTime(at(9, 5))).toBe('09:05')
  expect([0, 400, 999, 1000, 42_000, 59_400, 60_000, 192_000, 3_600_000, 3_900_000, 7_380_000].map(ms => formatDuration(ms, en))).toEqual(
    ['under 1 s', 'under 1 s', 'under 1 s', '1 s', '42 s', '59 s', '1 min', '3 min 12 s', '1 h', '1 h 5 min', '2 h 3 min'])
  expect(formatDuration(192_000, vi)).toBe('3 phút 12 giây')
  expect(formatDuration(3_900_000, vi)).toBe('1 giờ 5 phút')
  expect(formatDuration(-5, en)).toBe('under 1 s')
  expect([0, 59_999, 60_000, 180_000, 3_600_000, 3_900_000].map(ms => formatElapsed(ms, en))).toEqual(['under 1 min', 'under 1 min', '1 min', '3 min', '1 h', '1 h 5 min'])
  expect(formatElapsed(30_000, vi)).toBe('dưới 1 phút')
})

test('test output of each runner is read, with colours stripped', () => {
  const node = 'ℹ tests 12\nℹ suites 0\nℹ pass 11\nℹ fail 1\nℹ cancelled 0\nℹ skipped 2\nℹ todo 0\nℹ duration_ms 99'
  expect(parseTestOutput(node)).toEqual({ runner: 'node', passed: 11, failed: 1, skipped: 2 })
  expect(parseTestOutput('# tests 5\n# pass 5\n# fail 0\n')).toEqual({ runner: 'node', passed: 5, failed: 0, skipped: 0 })
  expect(parseTestOutput('Test Suites: 2 passed, 2 total\nTests:       1 failed, 11 passed, 12 total\nTime: 2s')).toEqual({ runner: 'jest', passed: 11, failed: 1, skipped: 0 })
  expect(parseTestOutput('\u001B[32m Tests \u001B[39m 12 passed (12)\n Duration 1s')).toEqual({ runner: 'vitest', passed: 12, failed: 0, skipped: 0 })
  expect(parseTestOutput(' Tests  1 failed | 10 passed | 1 skipped (12)')).toEqual({ runner: 'vitest', passed: 10, failed: 1, skipped: 1 })
  expect(parseTestOutput('===== 1 failed, 11 passed, 2 skipped in 0.52s =====')).toEqual({ runner: 'pytest', passed: 11, failed: 1, skipped: 2 })
  expect(parseTestOutput('============ 12 passed in 0.31s ============')).toEqual({ runner: 'pytest', passed: 12, failed: 0, skipped: 0 })
  expect(parseTestOutput('=== 2 passed, 1 error in 1.00s ===')).toEqual({ runner: 'pytest', passed: 2, failed: 1, skipped: 0 })
  const cargo = 'test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured'
  expect(parseTestOutput(cargo)).toEqual({ runner: 'cargo', passed: 12, failed: 1, skipped: 1 })
  expect(parseTestOutput('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n    --- PASS: TestC/sub (0.00s)\n--- SKIP: TestD')).toEqual({ runner: 'go', passed: 2, failed: 1, skipped: 1 })
  expect(parseTestOutput('ok  \tacme/shop/cart\t0.012s\nok  \tacme/shop/pay\t(cached)\nFAIL\tacme/shop/ship\t0.5s')).toEqual({ runner: 'go', passed: 2, failed: 1, skipped: 0, unit: 'packages' })
  for (const none of ['', 'hello', 'Tests are great', 'build finished in 3s', undefined as unknown as string]) expect(parseTestOutput(none)).toBe(null)
})

test('git output: numstat (renames, binary), log lines and counts', () => {
  const text = '22\t5\tsrc/cart/checkout.ts\n-\t-\tlogo.png\n3\t0\tsrc/{old => new}/x.ts\n1\t1\ta.ts => b.ts\nnot a line\n'
  expect(parseNumstat(text)).toEqual([
    { path: 'src/cart/checkout.ts', added: 22, removed: 5 },
    { path: 'logo.png', added: 0, removed: 0, isBinary: true },
    { path: 'src/new/x.ts', added: 3, removed: 0 },
    { path: 'b.ts', added: 1, removed: 1 },
  ])
  expect(renameTarget('{a => b}/x.ts')).toBe('b/x.ts')
  expect(renameTarget('src/{ => sub}/x.ts')).toBe('src/sub/x.ts')
  expect(parseCommits('a1b2c3d\tFix cart rounding\ne4f5a6b\tAdd test\n\nbad line')).toEqual([{ hash: 'a1b2c3d', subject: 'Fix cart rounding' }, { hash: 'e4f5a6b', subject: 'Add test' }])
  expect([parseCount('3\n'), parseCount(' 0 '), parseCount('x'), parseCount('')]).toEqual([3, 0, null, null])
  expect(commitSubject('[main a1b2c3d] Fix cart rounding\n 2 files changed')).toBe('Fix cart rounding')
  expect(commitSubject('nothing to commit')).toBe(null)
})

test('files changed in a turn: what was already changed before it is left out', () => {
  const end: FileChange[] = [
    { path: 'a.ts', added: 10, removed: 2 }, { path: 'b.ts', added: 3, removed: 0 }, { path: 'c.ts', added: 5, removed: 5, isNew: true }, { path: 'd.ts', added: 1, removed: 1 },
  ]
  const base = { 'a.ts': { a: 10, r: 2 }, 'b.ts': { a: 1, r: 0 }, 'd.ts': { a: 4, r: 4 } }
  expect(deltaFiles(end, base)).toEqual([{ path: 'b.ts', added: 2, removed: 0 }, { path: 'c.ts', added: 5, removed: 5, isNew: true }, { path: 'd.ts', added: 1, removed: 1 }])
  expect(deltaFiles(end, {})).toEqual(end)
  expect(totals(FILES)).toEqual({ n: 3, added: 40, removed: 12 })
  expect(totals([])).toEqual({ n: 0, added: 0, removed: 0 })
})

test('lines added and removed by an edit come from its patch, else from its input', () => {
  const patch = { structuredPatch: [{ lines: [' ctx', '-old', '+new1', '+new2', '+++ not counted?'] }] }
  expect(editStats({ tool_use_id: '1', tool: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }, result: patch })).toEqual({ path: '/p/a.ts', added: 3, removed: 1, isNew: false })
  expect(editStats({ tool_use_id: '2', tool: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'c\nd\ne' } })).toEqual({ path: '/p/a.ts', added: 3, removed: 2, isNew: false })
  expect(editStats({ tool_use_id: '3', tool: 'Write', input: { file_path: '/p/n.ts', content: 'a\nb\nc\n' }, result: { type: 'create' } })).toEqual({ path: '/p/n.ts', added: 3, removed: 0, isNew: true })
  expect(editStats({ tool_use_id: '4', tool: 'MultiEdit', input: { file_path: '/p/m.ts', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd', new_string: 'e' }] } })).toEqual({ path: '/p/m.ts', added: 3, removed: 2, isNew: false })
  expect(editStats({ tool_use_id: '5', tool: 'Edit', input: {} })).toBe(null)
})

test('the timeline is built from the turn’s tool calls: edits per file, reads and commands grouped, tests and commits named', () => {
  const messages: Message[] = [
    { role: 'user', text: 'go', toolUses: [] },
    {
      role: 'assistant', text: '',
      toolUses: [
        { tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a' } },
        { tool_use_id: 'r2', tool: 'Read', input: { file_path: 'b' } },
        { tool_use_id: 'r3', tool: 'Grep', input: { pattern: 'x' } },
        { tool_use_id: 'e1', tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y\nz' } },
        { tool_use_id: 'e2', tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'q', new_string: 'r' } },
        { tool_use_id: 'w1', tool: 'Write', input: { file_path: 'src/new.ts', content: 'a\nb' }, result: { type: 'create' } },
        { tool_use_id: 'b1', tool: 'Bash', input: { command: 'ls' }, text: 'a b' },
        { tool_use_id: 'b2', tool: 'Bash', input: { command: 'pwd' }, text: '/x' },
        { tool_use_id: 'b3', tool: 'Bash', input: { command: 'npm test' }, text: 'ℹ pass 12\nℹ fail 0' },
        { tool_use_id: 'b4', tool: 'Bash', input: { command: 'cat log.txt' }, text: 'ℹ pass 99\nℹ fail 0' },
        { tool_use_id: 'b5', tool: 'Bash', input: { command: 'git commit -m "Fix"' }, text: '[main a1b2c3d] Fix rounding\n 1 file changed' },
        { tool_use_id: 'b6', tool: 'Bash', input: { command: 'git commit -m "Fix"' }, text: 'nothing to commit', isError: true },
        { tool_use_id: 'a1', tool: 'Agent', input: {} },
        { tool_use_id: 'f1', tool: 'WebFetch', input: {} },
        { tool_use_id: 'x1', tool: 'mcp__other__tool', input: {} },
      ],
    },
  ]
  const times = { r1: at(14, 3), e1: at(14, 3, 30) }
  const built = buildSteps({ messages, times, startedAt: at(14, 2), endedAt: at(14, 5), asked: 'Fix it' })
  expect(built.steps.map(s => s.kind)).toEqual(['start', 'read', 'edit', 'create', 'command', 'test', 'command', 'commit', 'command', 'helper', 'web', 'other'])
  expect(built.steps[1]).toMatchObject({ kind: 'read', n: 2, m: 1, at: at(14, 3) })
  expect(built.steps[2]).toMatchObject({ kind: 'edit', file: 'src/a.ts', added: 3, removed: 2, at: at(14, 3, 30) })
  expect(built.steps[4]).toMatchObject({ kind: 'command', n: 2 })
  expect(built.steps[7]).toMatchObject({ kind: 'commit', text: 'Fix rounding' })
  expect(built.tests).toEqual({ runner: 'node', passed: 12, failed: 0, skipped: 0 })
  expect(built.testRuns).toBe(1)
  expect(built.editedFiles).toEqual([{ path: 'src/a.ts', added: 3, removed: 2 }, { path: 'src/new.ts', added: 2, removed: 0, isNew: true }])
  // a call with no measured time gets an even share, always inside the turn and never before the previous
  for (const s of built.steps) { expect(s.at).toBeGreaterThanOrEqual(at(14, 2)); expect(s.at).toBeLessThanOrEqual(at(14, 5)) }
  const stats = applyFileStats(built.steps, [{ path: 'a.ts', added: 40, removed: 1 }])
  expect(stats[2]).toMatchObject({ added: 40, removed: 1 })
  expect(applyFileStats(built.steps, null)).toBe(built.steps)
  expect(buildSteps({ messages: [], times: {}, startedAt: 1, endedAt: 2, asked: '' }).steps).toHaveLength(1)
})

test('step text, one-line summary and plain text, in English and Vietnamese', () => {
  expect(oneLine(SUMMARY, en)).toBe('✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s - started 14:02')
  expect(oneLine({ ...SUMMARY, commitsMade: 2 }, en)).toBe('✔ Changed 3 files (+40/-12), 2 commits made - tests: 12 passed - 3 min 12 s - started 14:02')
  expect(oneLine({ ...SUMMARY, tests: { runner: 'jest', passed: 10, failed: 2, skipped: 0 }, files: [] }, en)).toBe('✔ No files changed - tests: 2 failed, 10 passed - 3 min 12 s - started 14:02')
  expect(oneLine({ ...SUMMARY, files: null, tests: null, outcome: 'stopped' }, en)).toBe('■ Stopped before it finished - 3 min 12 s - started 14:02')
  expect(oneLine({ ...SUMMARY, outcome: 'error' }, en)).toContain('✖ Ended with an error')
  expect(oneLine(SUMMARY, vi)).toBe('✔ Sửa 3 file (+40/-12) - chạy test: 12 đạt - 3 phút 12 giây - bắt đầu 14:02')
  expect(changesText({ files: FILES, filesApprox: true, commitsMade: 0 }, en)).toBe('Changed about 3 files (+40/-12)')
  expect(changesText({ files: null, filesApprox: false, commitsMade: 0 }, en)).toBe('')
  expect(fileText(FILES[0] as FileChange, en)).toBe('src/cart/checkout.ts +22/-5')
  expect(fileText({ path: 'logo.png', added: 0, removed: 0, isBinary: true }, en)).toBe('logo.png binary')
  expect(fileText({ path: 'new.txt', added: 0, removed: 0, isNew: true }, en)).toBe('new.txt new')
  expect(SUMMARY.steps.map(s => stepText(s, en))).toEqual([
    'Started: "Fix the rounding of the cart total"', 'Read 6 files', 'Edited checkout.ts', 'Edited discount.ts', 'Created checkout.test.ts', 'Ran tests: 12 passed', 'Made a commit: Fix cart rounding'])
  expect(stepText({ at: 0, kind: 'read', n: 0, m: 2 }, en)).toBe('Searched 2 times')
  expect(stepText({ at: 0, kind: 'read', n: 1, m: 2 }, en)).toBe('Read 1 file, searched 2 times')
  expect(stepText({ at: 0, kind: 'edit', file: 'src/cart/checkout.ts' }, vi)).toBe('Sửa checkout.ts')
  const text = summaryText(SUMMARY, en, 2)
  expect(text).toContain('Last turn (14:02 -> 14:05, 3 min 12 s)')
  expect(text).toContain('Done: Fixed the rounding')
  expect(text).toContain('  src/cart/checkout.ts +22/-5')
  expect(text).toContain('  +1 more')
  expect(text).toContain('node --test: 12 passed - 0 failed')
  expect(text).toContain('⚠ 2 commits not pushed to origin/main.')
  expect(summaryText({ ...SUMMARY, what: '', unpushed: { count: 1, upstream: null, commits: [] } }, en, 8)).toContain('Request: Fix the rounding of the cart total')
  expect(en.unpushed(1, null)).toBe('1 commit not on any remote')
  expect(PUSH_PROMPT).toBe('Push my commits to the remote (git push) and tell me the result.')
})

test('the first line of an answer, short text and short paths', () => {
  expect(firstLine('## Summary\n\nI **fixed** the `rounding` bug.\n\nDetails…')).toBe('Summary')
  expect(firstLine('\n\n- I fixed the rounding bug.\n- more')).toBe('I fixed the rounding bug.')
  expect(firstLine('```ts\ncode\n```\nAfter the code.')).toBe('After the code.')
  expect(firstLine('```\nonly code')).toBe('')
  expect(firstLine('Mixed `code` and **bold** text')).toBe('Mixed code and bold text')
  expect(firstLine('')).toBe('')
  expect(firstLine('x'.repeat(300), 20)).toBe('x'.repeat(19) + '…')
  expect(shortText('a\n\n b\tc\u0007', 50)).toBe('a b c')
  expect(shortText('😀'.repeat(10), 5)).toBe('😀😀…')
  expect(shortText('😀'.repeat(10), 4)).toBe('😀…') // a character is never split
  expect(shortPath('src/cart/checkout.ts', 40)).toBe('src/cart/checkout.ts')
  expect(shortPath('src/cart/checkout.ts', 18)).toBe('…/cart/checkout.ts')
  expect(shortPath('src/cart/checkout.ts', 14)).toBe('…/checkout.ts')
  expect(shortPath('src/cart/checkout.ts', 6)).toBe('…ut.ts')
  expect(textCells('abc')).toBe(3)
  expect(textCells('日本')).toBe(4)
  expect(wrapRows('a'.repeat(10), 10)).toBe(1)
  expect(wrapRows('a'.repeat(11), 10)).toBeGreaterThan(1)
  expect(buttonRows(['Push now', 'View commits', 'Details', 'Hide'], 80)).toBe(1)
  expect(buttonRows(['Push now', 'View commits', 'Details', 'Hide'], 24)).toBeGreaterThan(1)
})

test('fitSteps keeps the first step, a gap and the newest steps', () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({ at: i, kind: 'command' as const, n: i }))
  expect(fitSteps(steps, 10)).toEqual({ shown: steps, hidden: 0 })
  const r = fitSteps(steps, 5)
  expect(r.shown.map(s => s.n)).toEqual([0, 7, 8, 9])
  expect(r.hidden).toBe(6)
  expect(fitSteps(steps, 2)).toEqual({ shown: steps.slice(0, 2), hidden: 8 })
  expect(fitSteps(steps, 0)).toEqual({ shown: [], hidden: 10 })
})

test('the layout never takes more rows than it is given, at any size, in either style', () => {
  const manyFiles = Array.from({ length: 20 }, (_, i) => ({ path: 'src/dir' + i + '/file-with-a-long-name-' + i + '.ts', added: i, removed: 1 }))
  const manySteps = Array.from({ length: 40 }, (_, i) => ({ at: SUMMARY.startedAt + i, kind: i % 2 ? ('edit' as const) : ('command' as const), n: 1, file: 'f' + i + '.ts', added: 1, removed: 1 }))
  const long = 'Fixed the rounding of the cart total at checkout and also cleaned up the discount code path so that coupons stack correctly. '.repeat(2)
  const variants: Summary[] = [
    SUMMARY,
    { ...SUMMARY, files: manyFiles, steps: manySteps, what: long, commitsMade: 3 },
    { ...SUMMARY, unpushed: null, tests: null, files: [] },
    { ...SUMMARY, files: null, what: '', asked: '', tests: { runner: 'go', passed: 3, failed: 1, skipped: 2, unit: 'packages' }, testRuns: 4 },
    { ...SUMMARY, outcome: 'stopped', steps: [], unpushed: { count: 1, upstream: null, commits: [] } },
  ]
  for (const s of variants) {
    for (const t of [en, vi]) {
      for (const style of ['card', 'timeline'] as const) {
        for (const expanded of [false, true]) {
          for (let rows = 0; rows <= 45; rows += 1) {
            for (const cols of [10, 20, 27, 28, 30, 39, 40, 60, 80, 120, 200]) {
              const plan = planBand(s, { rows, cols, style, expanded, maxFiles: 8 }, t)
              expect(plan.rows).toBeLessThanOrEqual(rows)
              if (rows < 1) expect(plan.mode).toBe('none')
              else expect(plan.mode).not.toBe('none')
              if (plan.mode === 'card') expect(plan.rows).toBe(cardRows(s, cols, plan.files, t))
              if (plan.mode === 'card') expect(plan.files).toBeLessThanOrEqual(8)
              if (plan.mode === 'line1') expect(plan.rows).toBe(1)
              if (plan.mode === 'line') expect(plan.files).toBeLessThanOrEqual(Math.min(8, s.files?.length ?? 0))
              if (!expanded && plan.mode === 'line') expect(plan.files).toBe(0)
            }
          }
        }
      }
    }
  }
})

test('the layout picks the card or timeline with room, and falls back to one line when short', () => {
  const roomy = { rows: 30, cols: 100, expanded: false, maxFiles: 8 }
  expect(planBand(SUMMARY, { ...roomy, style: 'card' }, en)).toMatchObject({ mode: 'card', files: 3 })
  expect(planBand(SUMMARY, { ...roomy, style: 'timeline' }, en)).toMatchObject({ mode: 'timeline', steps: 7 })
  expect(planBand(SUMMARY, { ...roomy, style: 'card', maxFiles: 2 }, en)).toMatchObject({ mode: 'card', files: 2 })
  expect(planBand(SUMMARY, { ...roomy, style: 'card', rows: 4 }, en).mode).toBe('line')
  expect(planBand(SUMMARY, { ...roomy, style: 'card', rows: 1 }, en).mode).toBe('line1')
  expect(planBand(SUMMARY, { ...roomy, style: 'card', cols: 20 }, en).mode).toBe('line')
  // a card with little room gives up file rows before it gives up itself
  const full = cardRows(SUMMARY, 100, 3, en)
  // two files plus the "+1 more" row take as many rows as three files, so the next step down is one file
  expect(planBand(SUMMARY, { ...roomy, style: 'card', rows: full - 1 }, en)).toMatchObject({ mode: 'card', files: 1 })
  expect(planBand(SUMMARY, { ...roomy, style: 'card', rows: full - 3 }, en)).toMatchObject({ mode: 'card', files: 0 })
  expect(timelineRows(SUMMARY, 100, SUMMARY.steps, 0, en)).toBeGreaterThan(SUMMARY.steps.length)
  // an opened one-line summary lists files when it has the rows
  expect(planBand(SUMMARY, { rows: 6, cols: 20, style: 'card', expanded: true, maxFiles: 8 }, en)).toMatchObject({ mode: 'line', files: 3 })
  expect(planBand(SUMMARY, { rows: 3, cols: 20, style: 'card', expanded: true, maxFiles: 8 }, en)).toMatchObject({ mode: 'line', files: 0 })
})

test('doctor lines and both language tables have the same words', () => {
  expect(formatLine({ level: 'PASS', name: 'git', detail: 'git version 2.50' })).toBe('PASS git - git version 2.50')
  expect(formatLine({ level: 'WARN', name: 'git', detail: 'not  found', fix: 'Install git.' })).toBe('WARN git - not found Fix: Install git.')
  expect(formatLine({ level: 'WARN', name: 'x', detail: 'd', fix: 'F' }, 'Cách sửa:')).toBe('WARN x - d Cách sửa: F')
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map(x => k + '.' + x) : [k]))
  expect(keys(vi)).toEqual(keys(en))
  const run = { runner: 'node' as const, passed: 1, failed: 0, skipped: 0 }
  for (const t of [en, vi]) {
    for (const v of [t.testsShort(run), t.testsLong(run, 2), t.stepTest(run), t.unpushed(2, null), t.unpushed(1, 'origin/main'), t.sessionFiles(1, 2, 3), t.paneTitle, t.usage]) {
      expect(typeof v).toBe('string')
      expect(v).not.toContain('undefined')
    }
  }
  expect(totals([]).n).toBe(0)
})

test('a tool the plugin does not know is counted as an other action; a shell is a command', () => {
  const m = (toolUses: Message['toolUses']): Message[] => [{ role: 'assistant', text: '', toolUses }]
  const built = buildSteps({
    messages: m([
      { tool_use_id: 'p1', tool: 'Poll', input: {} },
      { tool_use_id: 'p2', tool: 'mcp__docs__search', input: { query: 'x' } },
      { tool_use_id: 'ps', tool: 'PowerShell', input: { command: 'Get-Date' }, text: 'Tuesday' },
      { tool_use_id: 'p3', tool: 'REPL', input: { code: 'await Read({file_path: "a"})' }, text: 'file text' },
    ]),
    times: {}, startedAt: at(14, 2), endedAt: at(14, 5), asked: 'Go',
  })
  expect(built.steps.map(s => [s.kind, s.n])).toEqual([['start', undefined], ['other', 2], ['command', 1], ['other', 1]])
  expect(stepText(built.steps[1] as never, en)).toBe('Ran 2 other actions')
  expect(stepText({ at: 0, kind: 'other', n: 1 }, en)).toBe('Ran 1 other action')
  expect(stepText({ at: 0, kind: 'other', n: 3 }, vi)).toBe('Chạy 3 thao tác khác')
  expect(built.tests).toBe(null)
})

test('test counts are read from any tool result, not only a Bash one (a Code Mode script, PowerShell, an MCP tool)', () => {
  const run = (tool: string, input: Record<string, unknown>, extra: object) => buildSteps({
    messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool, input, ...extra }] }],
    times: {}, startedAt: at(14, 2), endedAt: at(14, 5), asked: '',
  })
  const out = 'ℹ tests 12\nℹ pass 12\nℹ fail 0'
  for (const built of [
    run('REPL', { code: 'await $`npm test`.text()' }, { text: out }),
    run('REPL', { code: 'run()' }, { result: { stdout: out } }),
    run('PowerShell', { command: 'npm test' }, { result: { text: out } }),
    run('mcp__ci__run', {}, { result: out }),
    run('Monitor', {}, { result: { output: out } }),
  ]) {
    expect(built.tests).toEqual({ runner: 'node', passed: 12, failed: 0, skipped: 0 })
    expect(built.testRuns).toBe(1)
    expect(built.steps.map(s => s.kind)).toEqual(['start', 'test'])
  }
  // a script that only prints a file does not count as a test run, and a commit made from a script is named
  expect(run('REPL', { code: 'await $`cat log.txt`.text()' }, { text: out }).tests).toBe(null)
  expect(run('REPL', { code: 'await $`git commit -m "Fix"`.text()' }, { text: '[main a1b2c3d] Fix rounding' }).steps[1]).toMatchObject({ kind: 'commit', text: 'Fix rounding' })
})

test('outputOf and commandOf find the text wherever the engine kept it, and cap a huge output at its end', () => {
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {}, text: 'a' })).toBe('a')
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {}, result: { stdout: 'b' } })).toBe('b')
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {}, result: { text: 'c' } })).toBe('c')
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {}, result: 'd' })).toBe('d')
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {}, result: 42 })).toBe('')
  expect(outputOf({ tool_use_id: '1', tool: 'X', input: {} })).toBe('')
  const big = outputOf({ tool_use_id: '1', tool: 'X', input: {}, text: `${'x'.repeat(300_000)}END` })
  expect(big.length).toBe(200_000)
  expect(big.endsWith('END')).toBe(true)
  expect(commandOf({ tool_use_id: '1', tool: 'Bash', input: { command: 'ls' } })).toBe('ls')
  expect(commandOf({ tool_use_id: '1', tool: 'REPL', input: { code: 'run()' } })).toBe('run()')
  expect(commandOf({ tool_use_id: '1', tool: 'Z', input: { script: 's' } })).toBe('s')
  expect(commandOf({ tool_use_id: '1', tool: 'Z', input: {} })).toBe('')
})

test('control characters from a path, a commit or an upstream never reach the screen', () => {
  expect(stripControl('a\u001b[31mb\u0007c\u202ed')).toBe('a[31mbcd')
  expect(shortPath('src/\u001b[2Jcart/x.ts', 40)).toBe('src/[2Jcart/x.ts')
  expect(fileText({ path: 'a\u0008b.ts', added: 1, removed: 0 }, en)).toBe('ab.ts +1/-0')
  expect(stepText({ at: 0, kind: 'edit', file: 'src/\u001b]0;x\u0007y.ts' }, en)).toBe('Edited ]0;xy.ts')
  expect(commitText({ hash: 'a1b2c3d', subject: 'Fix\u001b[1m rounding\n' })).toBe('a1b2c3d Fix[1m rounding')
  expect(unpushedOf(1, 'origin/ma\u001bin', [])).toEqual({ count: 1, upstream: 'origin/main', commits: [] })
  expect(unpushedOf(0, null, []).upstream).toBe(null)
})

test('the text colors are written as six-digit hex and every role exists in both palettes', () => {
  for (const mode of ['dark', 'light'] as const) {
    expect(Object.keys(COLORS[mode]).sort()).toEqual(['accent', 'add', 'bad', 'del', 'ok', 'warn'])
    for (const c of Object.values(COLORS[mode])) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  }
})
