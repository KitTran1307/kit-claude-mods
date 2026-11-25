import { expect, test } from 'claude-code/testing'

import { TABLES } from './i18n'

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 25, h, m, s).getTime()
const T0 = at(14, 2)
const ROOT = 'D:/work/acme-shop'

const BAND = (over: Record<string, unknown> = {}) => ({
  plugin: 'kit-turn',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {}, ...over },
}) as const
const PANE = {
  plugin: 'kit-turn', component: 'Pane', requestId: 'kit-turn',
  props: { title: 'Turn Card', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  now: number
  cwd: string
  /** The working copy vcs.detect finds; null: none; 'error': the call refuses. */
  copy: { vcs: string; root: string; revision: string | null; branch: string | null } | null | 'error'
  /** Uncommitted files vcs.diff reports; a string: it cannot say. */
  diff: any[] | string
  /** git by its arguments after the config pair; missing: exit 128. */
  git: Record<string, { exitCode: number; stdout: string }>
  gitCalls: string[]
  /** The conversation rows after the turn's start; 'deny' answers {deny}. */
  rows: any[] | 'deny'
  language: unknown
  everyCalls: number
  /** Lets the timer's current period end: its tick runs. */
  everyGate: (() => void) | null
  fillOk: boolean
  statuses: (string | undefined)[]
  toasts: string[]
  filled: string[]
  submitted: string[]
  opened: string[]
  commands: { name: string; description: string }[]
  failAll: boolean
  /** Rows of earlier turns: a read of the whole session includes them, a read after the turn's mark does not. */
  history: any[]
  /** The first moments of calls, in order. */
  order: string[]
  diffCalls: number
  failMessages: boolean
  /** While set, vcs.diff waits for it (a slow disk). */
  holdDiff: Promise<void> | null
  /** The prompt box's draft; 'error': it cannot be read. */
  draft: string
}

/** Lets the work the plugin started without waiting for (a baseline read, a timer tick) finish. */
const flush = async () => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
  await new Promise(r => (globalThis as any).setTimeout(r, 25))
}

function engine(on: any, over: Partial<World> = {}): World {
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const w: World = {
    now: T0, cwd: ROOT, copy: { vcs: 'git', root: ROOT, revision: 'aaa1111', branch: 'main' }, diff: [], git: {}, gitCalls: [], rows: [],
    language: undefined, everyCalls: 0, everyGate: null, fillOk: true, statuses: [], toasts: [], filled: [], submitted: [], opened: [], commands: [], failAll: false, history: [], order: [], diffCalls: 0, failMessages: false, holdDiff: null, draft: '',
    ...over,
  }
  const refuse = (why: string) => ({ deny: why })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: any) => ({ text: String(e.answer) }))
  on('command.register', (_: unknown, e: any) => { if (w.failAll) return refuse('no'); w.commands.push({ name: e.name, description: e.description }); return w.failAll ? refuse('no') : { value: { command: e.name } } })
  on('settings.read', () => (w.language === 'error' ? refuse('no settings') : { value: w.language === undefined ? {} : { language: w.language } }))
  on('session.cwd', () => (w.failAll ? refuse('no') : { value: w.cwd }))
  on('clock.now', () => ({ value: w.now }))
  // One period per call: it ends when a test opens the gate (w.everyGate), so the test decides when a tick runs.
  on('clock.every', () => { w.everyCalls += 1; return new Promise(res => { w.everyGate = () => res({ value: {} } as never) }) as any })
  on('ui.status', (_: unknown, e: any) => { w.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_: unknown, e: any) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('ui.open', (_: unknown, e: any) => { w.opened.push(String(e.id)); return { value: { isPlaced: true } } })
  on('prompt.fill', (_: unknown, e: any) => { w.filled.push(String(e.text)); return w.fillOk ? { isFilled: true, text: e.text, cursor: 0 } : { isFilled: false, refusal: 'no_composer', text: '', cursor: 0 } })
  on('prompt.submit', (_: unknown, e: any) => { w.submitted.push(String(e.text)); return { text: e.text } })
  on('prompt.read', () => (w.draft === 'error' ? refuse('no box') : { value: { text: w.draft, cursor: w.draft.length } }))
  on('vcs.detect', () => {
    w.order.push('detect')
    if (w.failAll || w.copy === 'error') throw new Error('no disk')
    return w.copy === null ? null : { ...w.copy, mainRoot: w.copy.root, defaultBranch: 'main', remote: null }
  })
  on('vcs.diff', async () => {
    w.diffCalls += 1
    if (w.holdDiff) await w.holdDiff
    if (w.failAll) throw new Error('no disk')
    return typeof w.diff === 'string' ? { unknown: w.diff } : { base: 'head', files: w.diff }
  })
  on('process.run', (_: unknown, e: any) => {
    if (w.failAll) return refuse('spawn git ENOENT')
    const argv: string[] = e.argv
    const key = argv.slice(argv[1] === '-c' ? 3 : 1).join(' ')
    w.gitCalls.push(key)
    const hit = w.git[key]
    return { value: { exitCode: hit?.exitCode ?? 128, stdout: hit?.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.messages', (_: unknown, e: any) => {
    if (w.failMessages) throw new Error('gone')
    if (e.last) { w.order.push('messages-last'); return { value: [{ role: 'user', text: 'Fix the rounding', toolUses: [], uuid: 'u0' }] } }
    if (e.after && w.rows === 'deny') return { value: { deny: 'row gone' } }
    const rows = w.rows === 'deny' ? [] : w.rows
    // After the turn's mark only the turn's rows come back; without one, the whole session does.
    return { value: e.after ? (e.after === 'u0' ? rows : []) : [...w.history, ...rows] }
  })
  return w
}

const file = (path: string, added: number, removed: number, extra: object = {}) => ({ path, renamedFrom: null, added, removed, isBinary: false, isUntracked: false, ...extra })
const EDITED = [file('src/cart/checkout.ts', 22, 5), file('src/cart/discount.ts', 14, 6), file('tests/checkout.test.ts', 4, 1)]
const RESULT_ROWS = [
  { role: 'user', text: 'Fix the rounding', toolUses: [] },
  {
    role: 'assistant', text: '',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a' } },
      { tool_use_id: 'e1', tool: 'Edit', input: { file_path: 'src/cart/checkout.ts', old_string: 'a', new_string: 'b' } },
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: 'ℹ tests 12\nℹ pass 12\nℹ fail 0' },
    ],
  },
]
const GIT_UNPUSHED = {
  'rev-parse --abbrev-ref --symbolic-full-name @{u}': { exitCode: 0, stdout: 'origin/main\n' },
  'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '2\n' },
  'log --format=%h%x09%s -n 30 @{u}..HEAD': { exitCode: 0, stdout: 'a1b2c3d\tFix cart rounding\ne4f5a6b\tAdd test\n' },
}

const start = ($: any, w: World, surface: 'terminal' | 'desktop' = 'terminal') => $.session.start({ cwd: w.cwd, surface, isInteractive: true })
const COMPLETE = (over: Record<string, unknown> = {}): any => ({ answer: 'Fixed the rounding of the cart total at checkout.\n\nMore detail.', durationMs: 192_000, isAborted: false, turnId: 't1', reason: 'answer', ...over })

/** One whole turn: starts, lets the baseline be read, changes the world as Claude would, and completes. */
async function turn($: any, w: World, change: () => void = () => { w.diff = EDITED; w.rows = RESULT_ROWS }, over: Record<string, unknown> = {}) {
  await $.turn.start({ text: 'Fix the rounding of the cart total', turnId: 't1' })
  await flush()
  change()
  w.now += 192_000
  await $.turn.complete(COMPLETE(over))
  await flush() // the summary is built beside the turn's end
}

const textsOf = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
const keysOf = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? ''))
const runCmd = async ($: any, args: string): Promise<string> => String(((await $.command.run({ command: 'turn', args } as never)) as any)?.text)
const en = TABLES.en

test('the card shows after a turn: what was done, changes per file, tests, time and the unpushed warning, on both surfaces', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w, 'desktop')
  await turn($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND(), surface })
    const texts = await textsOf(ui)
    const all = texts.join('\n')
    for (const t of ['Done', 'Changes', 'Checks', 'Time', 'Fixed the rounding of the cart total at checkout.', 'src/cart/checkout.ts', 'src/cart/discount.ts', 'tests/checkout.test.ts', '+22', '-5', '+14', '-6', '+4', '-1', 'Changed 3 files (+40/-12)', 'node --test: 12 passed - 0 failed', 'engine']) {
      expect(all).toContain(t)
    }
    expect(all).toContain('3 min 12 s - started 14:02')
    expect(all).toContain('14:02 -> 14:05')
    expect(all).toContain('⚠ 2 commits not pushed to origin/main')
    expect(await keysOf(ui)).toEqual(['push', 'commits', 'details', 'hide'])
    await ui.unmount()
  }
  expect(w.filled).toEqual([])
  expect(w.submitted).toEqual([])
})

test('the timeline style draws one line per step with its clock time, then the result and Push now', { options: { style: 'timeline' } }, async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s - started 14:02')
  for (const t of ['Started: "Fix the rounding of the cart total"', 'Read 1 file', 'Edited checkout.ts', 'Ran tests: 12 passed', 'ended 14:05 (3 min 12 s)']) expect(all).toContain(t)
  expect(await keysOf(ui)).toContain('push')
  await ui.unmount()
})

test('while a turn runs the band shows the clock and the card is hidden; the card returns when the turn ends', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  await turn($, w)
  await $.turn.start({ text: 'Next request', turnId: 't2' })
  await flush()
  expect(w.statuses.at(-1)).toBe('Working - started 14:05 - under 1 min')
  const idle = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await textsOf(idle)).join('\n')).not.toContain('Last turn') // the card is gone from the start of the next turn
  await idle.unmount()
  const busy = await $.ui.mount({ ...BAND({ isWorking: true }), surface: 'terminal' })
  expect((await textsOf(busy)).join('\n')).toContain('Working - started 14:05 - under 1 min')
  // a tick after three minutes moves the clock; before a whole minute passes it draws nothing new
  const calls = w.statuses.length
  w.now += 30_000
  w.everyGate?.()
  await flush()
  expect(w.statuses).toHaveLength(calls)
  w.now += 190_000
  w.everyGate?.()
  await flush()
  expect(w.statuses.at(-1)).toBe('Working - started 14:05 - 3 min')
  expect((await textsOf(busy)).join('\n')).toContain('Working - started 14:05 - 3 min')
  await busy.unmount()
  await $.turn.complete(COMPLETE({ turnId: 't2', answer: 'Done again.' }))
  await flush()
  expect(w.statuses.at(-1)).toBeUndefined()
  const after = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await textsOf(after)).join('\n')).toContain('Done again.')
  await after.unmount()
})

test('showClock off: no status line and no clock row', { options: { showClock: false } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await flush()
  const busy = await $.ui.mount({ ...BAND({ isWorking: true }), surface: 'terminal' })
  expect(await textsOf(busy)).toEqual(['engine'])
  await busy.unmount()
  expect(w.statuses).toEqual([])
  expect(w.everyCalls).toBe(0)
})

test('Push now only fills the prompt box, View commits opens the pane, Hide takes the card away', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  await ui.press({ key: 'push' })
  expect(w.filled).toEqual(['Push my commits to the remote (git push) and tell me the result.'])
  expect(w.submitted).toEqual([])
  expect(w.toasts.at(-1)).toContain('Press Enter')
  w.fillOk = false
  await ui.press({ key: 'push' })
  expect(w.toasts.at(-1)).toContain('tell Claude: Push my commits')
  await ui.press({ key: 'commits' })
  expect(w.opened).toEqual(['kit-turn'])
  await ui.press({ key: 'details' })
  expect(w.opened).toEqual(['kit-turn', 'kit-turn'])
  await ui.press({ key: 'hide' })
  expect(await textsOf(ui)).toEqual(['engine'])
  expect(w.submitted).toEqual([])
  await ui.unmount()
})

const NO_UPSTREAM = { 'rev-parse --abbrev-ref --symbolic-full-name @{u}': { exitCode: 128, stdout: '' } }
const UNPUSHED_CASES: [string, Record<string, { exitCode: number; stdout: string }>, string | null][] = [
  ['no upstream: counted against every remote', { ...NO_UPSTREAM, remote: { exitCode: 0, stdout: 'origin\n' }, 'rev-list --count HEAD --not --remotes': { exitCode: 0, stdout: '1\n' }, 'log --format=%h%x09%s -n 30 HEAD --not --remotes': { exitCode: 0, stdout: 'a1b2c3d\tWip\n' } }, '⚠ 1 commit not on any remote'],
  ['a remote-less repository is never warned about', { ...NO_UPSTREAM, remote: { exitCode: 0, stdout: '' } }, null],
  ['no remote command answer: no warning', { ...NO_UPSTREAM }, null],
  ['nothing ahead of the upstream: no warning', { ...GIT_UNPUSHED, 'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: '0\n' } }, null],
  ['a count that cannot be read: no warning', { ...GIT_UNPUSHED, 'rev-list --count @{u}..HEAD': { exitCode: 0, stdout: 'garbage' } }, null],
]
for (const [name, git, expected] of UNPUSHED_CASES) {
  test(`unpushed commits - ${name}`, async ($, on) => {
    const w = engine(on, { git })
    await start($, w)
    await turn($, w)
    const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
    const all = (await textsOf(ui)).join('\n')
    if (expected) { expect(all).toContain(expected); expect(await keysOf(ui)).toContain('push') }
    else { expect(all).not.toContain('⚠'); expect(await keysOf(ui)).toEqual(['details', 'hide']) }
    await ui.unmount()
  })
}

test('without a repository the card still works from Claude’s own edits, with no warning', async ($, on) => {
  const w = engine(on, { copy: null })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('Changed about 1 file (+1/-1)')
  expect(all).toContain('node --test: 12 passed')
  expect(all).not.toContain('⚠')
  await ui.unmount()
  expect(await runCmd($, 'changes')).toContain('not in a repository')
})

test('nothing breaks when every engine call fails: the turn ends, the card shows what is known', async ($, on) => {
  const w = engine(on, { failAll: true })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('Fixed the rounding of the cart total at checkout.')
  expect(all).toContain('3 min 12 s')
  expect(all).not.toContain('⚠')
  await ui.unmount()
  expect(await runCmd($, '')).toContain('Last turn')
  for (const arg of ['changes', 'doctor', 'pane', 'bogus']) expect(typeof (await runCmd($, arg))).toBe('string')
})

const DEGRADED: [string, Partial<World>][] = [
  ['version control cannot list changes', { diff: 'cannot say' }],
  ['the conversation read is refused', { rows: 'deny' }],
  ['no working copy is found (the call refuses)', { copy: 'error' }],
  ['git refuses every command', { git: {} }],
]
for (const [name, over] of DEGRADED) {
  test(`degrades quietly - ${name}`, async ($, on) => {
    const w = engine(on, { git: GIT_UNPUSHED, ...over })
    await start($, w)
    await turn($, w)
    const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
    const all = (await textsOf(ui)).join('\n')
    expect(all).toContain('Fixed the rounding of the cart total at checkout.')
    expect(all).toContain('started 14:02')
    await ui.unmount()
  })
}

test('commits made during the turn are counted, files changed before it are left out, new files are listed', async ($, on) => {
  const w = engine(on, { diff: [file('old.ts', 3, 1)] })
  await start($, w)
  await turn($, w, () => {
    w.copy = { vcs: 'git', root: ROOT, revision: 'bbb2222', branch: 'main' }
    w.diff = [file('old.ts', 3, 1), file('notes.md', 0, 0, { isUntracked: true })]
    w.git = {
      'diff --numstat aaa1111': { exitCode: 0, stdout: '22\t5\tsrc/cart/checkout.ts\n3\t1\told.ts\n' },
      'rev-list --count aaa1111..HEAD': { exitCode: 0, stdout: '2\n' },
    }
    w.rows = RESULT_ROWS
  })
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('Changed 2 files (+22/-5), 2 commits made')
  expect(all).toContain('src/cart/checkout.ts')
  expect(all).toContain('notes.md')
  expect(all).toContain('new')
  expect(all).not.toContain('old.ts')
  await ui.unmount()
})

test('stopped and failed turns are named in the summary', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turn($, w, undefined, { isAborted: true, reason: 'aborted', answer: '' })
  let ui = await $.ui.mount({ ...BAND({ maxRows: 1 }), surface: 'terminal' })
  expect((await textsOf(ui)).join('\n')).toContain('■ Stopped before it finished')
  await ui.unmount()
  await turn($, w, undefined, { reason: 'error' })
  ui = await $.ui.mount({ ...BAND({ maxRows: 1 }), surface: 'terminal' })
  expect((await textsOf(ui)).join('\n')).toContain('✖ Ended with an error')
  await ui.unmount()
})

test('subagent turns do not make a card or start a clock', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'agent-1' })
  await $.turn.complete(COMPLETE({ turnId: 's1', agentId: 'agent-1' }))
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
  expect(w.statuses).toEqual([])
  expect(await runCmd($, '')).toBe(en.noTurnYet)
})

test('little room collapses the card to one line; Files opens the list; one row keeps the warning and Push', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  await turn($, w)
  const line = await $.ui.mount({ ...BAND({ maxRows: 3 }), surface: 'terminal' })
  const all = (await textsOf(line)).join('\n')
  expect(all).toContain('✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s - started 14:02')
  expect(all).not.toContain('Checks')
  expect(await keysOf(line)).toEqual(['files', 'hide', 'push'])
  await line.press({ key: 'files' })
  expect((await textsOf(line)).join('\n')).not.toContain('checkout.ts') // 3 rows: no room for the list
  await line.unmount()
  const open = await $.ui.mount({ ...BAND({ maxRows: 8, bodyColumns: 20 }), surface: 'terminal' })
  expect((await textsOf(open)).join('\n')).toContain('checkout.ts') // the list stays open from the press above
  await open.press({ key: 'files' })
  expect((await textsOf(open)).join('\n')).not.toContain('checkout.ts')
  await open.unmount()
  const one = await $.ui.mount({ ...BAND({ maxRows: 1 }), surface: 'terminal' })
  expect((await textsOf(one)).join('\n')).toContain('⚠ 2 not pushed - ✔ Changed 3 files')
  expect(await keysOf(one)).toEqual(['push'])
  await one.unmount()
})

test('the band stays out of the way: survey, collapsed band, showBand off, nothing to show', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const none = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await textsOf(none)).toEqual(['engine']) // before any turn
  await none.unmount()
  await turn($, w)
  for (const over of [{ hasSurvey: true }, { isCollapsed: true }, { maxRows: 0 }]) {
    const ui = await $.ui.mount({ ...BAND(over), surface: 'terminal' })
    expect(await textsOf(ui)).toEqual(['engine'])
    await ui.unmount()
  }
})

test('showBand off hides the band but /turn and the pane keep working', { options: { showBand: false } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
  expect(await runCmd($, '')).toContain('Last turn')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await textsOf(pane)).join('\n')).toContain('Turn Card')
  await pane.unmount()
})

test('maxFiles limits the listed files and bad values fall back or are cut', { options: { maxFiles: 2 } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('src/cart/discount.ts')
  expect(all).not.toContain('tests/checkout.test.ts')
  expect(all).toContain('+1 more')
  await ui.unmount()
})

test('a maxFiles below the range is cut to 1', { options: { maxFiles: -4 } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  expect(all).toContain('src/cart/checkout.ts')
  expect(all).not.toContain('src/cart/discount.ts')
  expect(all).toContain('+2 more')
  await ui.unmount()
})

test('the timeline shows when each step ended, as the engine reported it', { options: { style: 'timeline' } }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  await $.turn.start({ text: 'Fix it', turnId: 't1' })
  await flush()
  w.diff = EDITED
  w.rows = RESULT_ROWS
  w.now = at(14, 3, 30)
  const stored: any = await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    door: 'tool-result', origin: { kind: 'tool', tool: 'Edit' }, uuid: 'x1',
  })
  expect(stored.uuid).toBe('x1') // the row passes on unchanged
  w.now = at(14, 5)
  await $.turn.complete(COMPLETE())
  await flush()
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const texts = await textsOf(ui)
  const i = texts.indexOf('Edited checkout.ts')
  expect(i).toBeGreaterThan(0)
  expect(texts[i - 1]).toBe('14:03')
  await ui.unmount()
})

test('/turn prints the last summary, the session’s changes, the pane and a health check', async ($, on) => {
  const w = engine(on, { git: { ...GIT_UNPUSHED, '--version': { exitCode: 0, stdout: 'git version 2.50.0\n' } }, diff: [file('old.ts', 3, 1)] })
  await start($, w)
  expect(w.commands).toEqual([{ name: 'turn', description: en.commandDescription }])
  expect(await runCmd($, '')).toBe('No turn has finished in this session yet.')
  await turn($, w, () => { w.diff = [file('old.ts', 3, 1), ...EDITED]; w.rows = RESULT_ROWS })
  const last = await runCmd($, '')
  expect(last).toContain('Last turn (14:02 -> 14:05, 3 min 12 s)')
  expect(last).toContain('Done: Fixed the rounding of the cart total at checkout.')
  expect(last).toContain('  src/cart/checkout.ts +22/-5')
  const changes = await runCmd($, 'changes')
  expect(changes).toContain('Changes in this session:')
  expect(changes).toContain('3 files changed since the session started (+40/-12)')
  expect(changes).not.toContain('old.ts')
  expect(changes).toContain('⚠ 2 commits not pushed to origin/main:')
  expect(changes).toContain('  a1b2c3d Fix cart rounding')
  expect(await runCmd($, 'pane')).toBe('Opened the Turn Card pane.')
  expect(w.opened).toEqual(['kit-turn'])
  expect(await runCmd($, 'bogus')).toBe(en.usage)
  const doctor = await runCmd($, 'doctor')
  for (const line of ['Turn Card health:', 'PASS git - git version 2.50.0', 'PASS repository - git, branch main', 'PASS upstream - pushes go to origin/main',
    'PASS session start - recorded at aaa1111', 'PASS language - en', 'PASS turns seen - 1 turn summarised']) expect(doctor).toContain(line)
  for (const l of doctor.split('\n').slice(1)) expect(l).toMatch(/^(PASS|WARN) /)
})

test('/turn doctor says what is missing and how to fix it', async ($, on) => {
  const w = engine(on, { copy: null, failAll: false })
  await start($, w)
  const doctor = await runCmd($, 'doctor')
  expect(doctor).toContain('WARN git - git was not found')
  expect(doctor).toContain('Fix: Install git')
  expect(doctor).toContain('WARN repository - this folder is not in a repository')
  expect(doctor).toContain('WARN session start - not recorded')
})

test('the pane lists everything: steps, files, the session and the unpushed commits with Push now', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await textsOf(empty)).join('\n')).toContain(en.paneNoTurn)
  await empty.unmount()
  await turn($, w)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const all = (await textsOf(pane)).join('\n')
    for (const t of ['Turn Card', 'What happened', 'Edited checkout.ts', 'Read 1 file', 'This session', 'Commits not pushed', 'a1b2c3d Fix cart rounding', 'e4f5a6b Add test', 'src/cart/discount.ts', 'ended 14:05 (3 min 12 s)']) expect(all).toContain(t)
    expect(await keysOf(pane)).toContain('push')
    await pane.press({ key: 'push' })
    await pane.unmount()
  }
  expect(w.filled).toHaveLength(2)
  expect(w.submitted).toEqual([])
})

test('Vietnamese: by option, by Claude Code’s own language setting, and English when the setting cannot be read', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED, language: 'Vietnamese' })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const all = (await textsOf(ui)).join('\n')
  for (const t of ['Lượt vừa rồi', 'Đã làm', 'Thay đổi', 'Kiểm tra', 'Thời gian', 'Sửa 3 file (+40/-12)', '3 phút 12 giây - bắt đầu 14:02', '⚠ 2 commit chưa push lên origin/main']) expect(all).toContain(t)
  expect(await ui.find({ type: 'Button', key: 'push' })).toBeDefined()
  await ui.press({ key: 'push' })
  expect(w.filled).toEqual(['Push my commits to the remote (git push) and tell me the result.']) // what Claude reads stays English
  expect(w.toasts.at(-1)).toContain('Đã điền vào ô nhập')
  await ui.unmount()
  expect(await runCmd($, '')).toContain('Lượt vừa rồi')
  expect(w.commands[0]?.description).toBe(TABLES.vi.commandDescription)
  expect(await runCmd($, 'bogus')).toBe(TABLES.vi.usage)
})

test('language vi forces Vietnamese, and an unreadable setting keeps English', { options: { language: 'vi' } }, async ($, on) => {
  const w = engine(on, { language: 'English' })
  await start($, w)
  expect(await runCmd($, '')).toBe(TABLES.vi.noTurnYet)
})

test('an unreadable language setting keeps English', async ($, on) => {
  const w = engine(on, { language: 'error' })
  await start($, w)
  expect(await runCmd($, '')).toBe(en.noTurnYet)
})

const OLD_ROWS = [
  { role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'old1', tool: 'Edit', input: { file_path: 'src/old.ts', old_string: 'a', new_string: 'b' } },
    { tool_use_id: 'old2', tool: 'Bash', input: { command: 'npm test' }, text: 'ℹ pass 99\nℹ fail 0' },
  ] },
]

test('outside a repository the turn still reads only its own rows, not earlier turns', async ($, on) => {
  const w = engine(on, { copy: null, history: OLD_ROWS })
  await start($, w)
  await turn($, w)
  const text = await runCmd($, '')
  expect(text).toContain('src/cart/checkout.ts')
  expect(text).not.toContain('old.ts')
  expect(text).toContain('12 passed')
  expect(text).not.toContain('99')
})

test('when the working folder is unknown the turn still reads only its own rows', async ($, on) => {
  const w = engine(on, { history: OLD_ROWS })
  await start($, w)
  await $.turn.start({ text: 'Fix', turnId: 't1' })
  await flush()
  w.cwd = ''
  w.rows = RESULT_ROWS
  w.now += 1000
  await $.turn.complete(COMPLETE())
  await flush()
  const text = await runCmd($, '')
  expect(text).toContain('12 passed')
  expect(text).not.toContain('99')
})

test('the turn start reads the newest conversation row first, before any version-control call', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.order.length = 0
  await $.turn.start({ text: 'Fix', turnId: 't1' })
  await flush()
  expect(w.order[0]).toBe('messages-last')
  expect(w.order).toContain('detect')
})

test('a conversation mark that cannot be read leaves the steps out instead of guessing at earlier turns', async ($, on) => {
  const w = engine(on, { copy: null, history: OLD_ROWS, failMessages: true })
  await start($, w)
  await turn($, w)
  const text = await runCmd($, '')
  expect(text).not.toContain('99')
  expect(text).not.toContain('old.ts')
})

test('the end of the turn does not wait for git: the card appears when the reads finish', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await $.turn.start({ text: 'Fix the rounding of the cart total', turnId: 't1' })
  await flush()
  let release: () => void = () => undefined
  w.holdDiff = new Promise<void>(resolve => { release = resolve })
  w.diff = EDITED
  w.rows = RESULT_ROWS
  w.now += 192_000
  await $.turn.complete(COMPLETE()) // returns while the disk is still busy
  const waiting = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await textsOf(waiting)).toEqual(['engine'])
  await waiting.unmount()
  w.holdDiff = null
  release()
  await flush()
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect((await textsOf(ui)).join('\n')).toContain('Changed 3 files (+40/-12)')
  await ui.unmount()
})

test('a turn that starts while the last summary is still being built keeps its clock and hides the old card', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await $.turn.start({ text: 'First', turnId: 't1' })
  await flush()
  let release: () => void = () => undefined
  w.holdDiff = new Promise<void>(resolve => { release = resolve })
  w.diff = EDITED
  w.rows = RESULT_ROWS
  await $.turn.complete(COMPLETE())
  await $.turn.start({ text: 'Second', turnId: 't2' })
  w.holdDiff = null
  release()
  await flush()
  const working = await $.ui.mount({ ...BAND({ isWorking: true }), surface: 'terminal' })
  expect((await textsOf(working)).join('\n')).toContain('Working')
  await working.unmount()
  const idle = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await textsOf(idle)).toEqual(['engine'])
  await idle.unmount()
})

test('the session list is read when the pane is drawn, not at the end of every turn', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turn($, w)
  expect(w.diffCalls).toBe(3) // session start, turn start, turn end
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await flush()
  expect(w.diffCalls).toBe(4)
  expect((await textsOf(pane)).join('\n')).toContain('This session')
  await pane.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(w.diffCalls).toBe(4) // fresh enough: not read again
  await again.unmount()
})

const PUSH = 'Push my commits to the remote (git push) and tell me the result.'
const pushWith = async ($: any, on: any, draft: string) => {
  const w = engine(on, { git: GIT_UNPUSHED, draft })
  await start($, w)
  await turn($, w)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  await ui.press({ key: 'push' })
  await ui.unmount()
  return w
}
test('Push now starts on a new line when the prompt box already holds a draft', async ($, on) => {
  expect((await pushWith($, on, 'fix the tests too')).filled).toEqual([`\n${PUSH}`])
})
test('Push now adds no blank line to an empty box or a draft that already ends in one', async ($, on) => {
  expect((await pushWith($, on, '')).filled).toEqual([PUSH])
})
test('Push now works when the draft cannot be read', async ($, on) => {
  expect((await pushWith($, on, 'error')).filled).toEqual([PUSH])
})
test('Push now after a draft ending in a line break adds no extra line break', async ($, on) => {
  expect((await pushWith($, on, 'fix it\n')).filled).toEqual([PUSH])
})

test('a path with control characters is drawn clean in the card, the pane and /turn changes', async ($, on) => {
  const w = engine(on, { git: GIT_UNPUSHED })
  await start($, w)
  await turn($, w, () => { w.diff = [file('src/\u001b[2Jevil.ts', 3, 1)]; w.rows = RESULT_ROWS })
  for (const comp of [BAND(), PANE]) {
    const ui = await $.ui.mount({ ...comp, surface: 'terminal' })
    const all = (await textsOf(ui)).join('\n')
    expect(all).not.toContain('\u001b')
    expect(all).toContain('evil.ts')
    await ui.unmount()
  }
  expect(await runCmd($, 'changes')).not.toContain('\u001b')
})
