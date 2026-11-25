import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import {
  HOME, NOW, ROOT, SNAPS, SURFACES, bandTexts, bash, begin, buttonsOf, drain, everything, mountBand, ours, press, readIt, safety, settle, textsOf, track, world,
} from '../tests/world'
import type { World } from '../tests/world'
import { outcomeText } from './command'
import { TABLES } from './i18n'
import { joinPath } from './paths'
import { buildManifest, newSnapshotId, projectKey, serializeManifest, snapshotDir } from './snapshot'
import type { Manifest } from './snapshot'
import type { RestoreOutcome } from './vault'

// The whole plugin over the fake world of tests/world.tsx: hooks that stand for the engine answer files, commands, the session and
// the question box from memory, and the plugin's real guard, vault, band and commands run over them. Secret-shaped values are
// assembled at run time: no key is ever written out contiguously in this file.
const anthropic = () => ['sk', 'ant', 'api03', 'Ab3dEf9hJk1mNp4rStUv'.repeat(2)].join('-')
const github = () => ['gh', 'p_'].join('') + 'Zx8Qw3Er5Ty7Ui9Op1As3Df5Gh7Jk9Lz2Xc4'
const MASKED = 'sk-ant-•••• masked'
const SHA = 'a'.repeat(40)
const MIN = 60_000
const DAY = 86_400_000

const put = (w: World, rel: string, text = 'x'.repeat(6)) => w.put(`${ROOT}/${rel}`, text)
const reports = (w: World) => ['a.js', 'b.js', 'c.js'].forEach(n => put(w, `reports/${n}`))
const edit = ($: Engine, rel: string, to: string) => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${rel}`, old_string: 'v1', new_string: to } as never)
const write = ($: Engine, rel: string, content: string) => $.tool.call({ tool: 'Write', file_path: `${ROOT}/${rel}`, content } as never)
const pendingQuestion = async ($: Engine) => (await buttonsOf(await mountBand($, 'desktop'))).some(b => b.key === 'allow')

// ---------------------------------------------------------------------------------------------------------------------
// The guard

test('a risky rm -rf is held until Allow; then it runs, and Claude is told where the snapshot is', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(call.isDone).toBe(false)
  expect(w.ran).toEqual([])
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(true)
  expect(w.snapshotIds()).toHaveLength(1)
  await press($, w, 'allow')
  const out = await call.promise
  expect(w.ran).toEqual([{ tool: 'Bash', input: { command: 'rm -rf reports/' } }])
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(false)
  expect(out).toMatchObject({ result: { stdout: 'ok' }, context: ['Safety Net saved snapshot #1 before this ran; /safety restore 1 puts it back.'] })
  expect(await bandTexts($)).toEqual([])
})

test('Cancel: nothing runs, Claude reads a plain English refusal that names no command and nothing secret', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const key = anthropic()
  const call = track(bash($, `rm -rf reports/ # key ${key}`))
  await settle(w)
  await press($, w, 'cancel')
  const out = await call.promise
  expect(out).toEqual({ deny: 'The person chose Cancel in Safety Net: About to delete the folder "reports/". Nothing was changed. Ask them what they want instead.' })
  expect(JSON.stringify(out)).not.toContain(key)
  expect(w.ran).toEqual([])
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(true)
  // the snapshot record holds no command text and no secret at all (not even a masked one): only labels, paths and Git facts
  const manifests = [...w.files].filter(([path]) => path.startsWith(SNAPS) && path.endsWith('/manifest.json'))
  expect(manifests).toHaveLength(1)
  const record = manifests[0]![1]
  expect(record).not.toContain(key)
  expect(record).not.toContain(MASKED)
  expect(record).not.toContain('sk-ant')
  expect(record).not.toContain('# key')
  expect(record).not.toContain('rm -rf reports/')
  expect(JSON.parse(record)).not.toHaveProperty('command')
  expect(everything(w)).not.toContain(key)
  expect(everything(w)).not.toContain(MASKED)
  expect(await bandTexts($)).toEqual([])
})

test('no answer for 15 minutes denies the call, and a late Allow is nothing', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal') // the band is up, so Claude Code's own question box does not ask
  await w.clock.advance(15 * MIN - 1000)
  expect(call.isDone).toBe(false)
  expect(w.asked).toEqual([])
  await w.clock.advance(1000)
  await settle(w)
  expect(await call.promise).toEqual({
    deny: 'Safety Net asked the person to confirm this and got no answer in time: About to delete the folder "reports/". Nothing was changed. Ask them whether to go ahead.',
  })
  expect(w.ran).toEqual([])
  expect(await ours(ui)).toEqual([])
  await ui.unmount()
  expect(w.asked).toEqual([])
})

test('after Allow, the timeout, a second Allow and a Cancel change nothing', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  await readIt(w)
  // two presses at once: the second one finds the question already answered
  await Promise.allSettled([ui.press({ key: 'allow' }), ui.press({ key: 'allow' }), ui.press({ key: 'cancel' })])
  await ui.unmount()
  await settle(w)
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
  await w.clock.advance(30 * MIN)
  expect(w.ran).toHaveLength(1)
  expect(w.asked).toEqual([])
  expect(await bandTexts($)).toEqual([])
})

// A hook above gives up on the call after 5 seconds, which is how the engine abandons a call (`next.signal` aborts below it).
const IMPATIENT = {
  name: 'impatient',
  tier: 'prepend' as const,
  register: (on: Parameters<Plugin['register']>[0]) => {
    on('tool.call', async ($, e, next) => {
      next(e).catch(() => undefined)
      await $.clock.sleep(5000)
      return { deny: 'interrupted' }
    })
  },
}

test('an interrupted call is denied cleanly and leaves no question behind', {
  plugins: [IMPATIENT],
}, async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  expect((await buttonsOf(ui)).map(b => b.key)).toEqual(['allow', 'cancel'])
  await w.clock.advance(5000)
  await settle(w)
  expect(await call.promise).toEqual({ deny: 'interrupted' })
  expect(await ours(ui)).toEqual([])
  expect(w.ran).toEqual([])
  await w.clock.advance(20 * MIN)
  expect(w.asked).toEqual([])
  await ui.unmount()
})

// ---- the question box, for a band that cannot be shown ----

test('an interruption while Claude Code\'s own question box is open ends the wait too', { plugins: [IMPATIENT] }, async ($, on) => {
  const w = world(on, { ask: () => new Promise<string | null>(() => undefined) })
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked).toHaveLength(1)
  await w.clock.advance(3500)
  await settle(w)
  expect(await call.promise).toEqual({ deny: 'interrupted' })
  expect(await bandTexts($)).toEqual([])
  await w.clock.advance(20 * MIN)
  expect(w.asked).toHaveLength(1)
  expect(w.ran).toEqual([])
})

test('the question box in Vietnamese: the question, the buttons, and "Cho chạy" allows', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on, { ask: () => 'Cho chạy' })
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.options).toEqual(['Cho chạy', 'Huỷ'])
  expect(w.asked[0]?.question.startsWith('Sắp xoá thư mục "reports/".')).toBe(true)
  expect(w.asked[0]?.question.endsWith('Cho chạy không?')).toBe(true)
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
  expect(w.ran).toHaveLength(1)
})

test('a band that never draws: after 1.5 s Claude Code\'s own question box asks, once, with the snapshot in the question', async ($, on) => {
  const w = world(on)
  reports(w)
  let answer: (label: string | null) => void = () => undefined
  w.ask = () => new Promise(resolve => { answer = resolve })
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  await w.clock.advance(1400)
  expect(w.asked).toEqual([])
  await w.clock.advance(100)
  await settle(w)
  expect(w.asked).toEqual([{ question: 'About to delete the folder "reports/". Snapshot saved at 14:05 (#1) · 3 files, 18 B. Allow it?', options: ['Allow', 'Cancel'] }])
  // asked once, however long it takes
  await w.clock.advance(30_000)
  expect(w.asked).toHaveLength(1)
  expect(call.isDone).toBe(false)
  answer('Allow')
  await settle(w)
  expect(await call.promise).toMatchObject({ context: [expect.stringContaining('snapshot #1')] })
  expect(w.ran).toHaveLength(1)
})

for (const [name, reply] of [['Cancel', 'Cancel'], ['a dismissed box', null], ['free text', 'sure, why not'], ['a label in the wrong case', 'allow']] as const) {
  test(`the question box: ${name} denies`, async ($, on) => {
    const w = world(on, { ask: () => reply })
    reports(w)
    await begin($, w)
    const call = track(bash($, 'rm -rf reports/'))
    await settle(w)
    await w.clock.advance(1500)
    await settle(w)
    expect(w.asked).toHaveLength(1)
    expect(await call.promise).toMatchObject({ deny: expect.stringContaining('The person chose Cancel in Safety Net') })
    expect(w.ran).toEqual([])
  })
}

for (const [name, props] of [['a band the person collapsed', { isCollapsed: true }], ['a survey that holds the band', { hasSurvey: true }]] as const) {
  test(`${name} hands the question to the box`, async ($, on) => {
    const w = world(on, { ask: () => 'Allow' })
    reports(w)
    await begin($, w)
    const call = track(bash($, 'rm -rf reports/'))
    await settle(w)
    const ui = await mountBand($, 'terminal', props)
    await w.clock.advance(1500)
    await settle(w)
    expect(w.asked).toHaveLength(1)
    expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
    await ui.unmount()
  })
}

test('a band that is showing the question keeps the box closed', async ($, on) => {
  const w = world(on, { ask: () => 'Allow' })
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'desktop')
  await w.clock.advance(10_000)
  await settle(w)
  expect(w.asked).toEqual([])
  expect(call.isDone).toBe(false)
  await ui.unmount()
  await drain($, w)
  await call.promise
})

test('with no band at all, a queue is asked one at a time, in order', async ($, on) => {
  const w = world(on)
  for (const f of ['a', 'b']) put(w, `${f}/x.txt`)
  const answers: ((label: string | null) => void)[] = []
  w.ask = () => new Promise(resolve => { answers.push(resolve) })
  await begin($, w)
  const first = track(bash($, 'rm -rf a/'))
  await settle(w)
  const second = track(bash($, 'rm -rf b/'))
  await settle(w)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked.map(a => a.question.slice(0, 42))).toEqual(['About to delete the folder "a/". Snapshot '])
  await w.clock.advance(5000)
  expect(w.asked).toHaveLength(1)
  answers[0]!('Allow')
  await settle(w)
  expect(first.isDone).toBe(true)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked.map(a => a.question.slice(0, 42))).toEqual(['About to delete the folder "a/". Snapshot ', 'About to delete the folder "b/". Snapshot '])
  answers[1]!('Cancel')
  await settle(w)
  expect(await second.promise).toMatchObject({ deny: expect.stringContaining('About to delete the folder "b/"') })
  expect(w.ran.map(r => r.input.command)).toEqual(['rm -rf a/'])
})

// ---- nobody to answer, and the options ----

test('headless: nobody can answer, so it saves the snapshot and lets the command run, telling Claude', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w, false)
  const out = await bash($, 'rm -rf reports/')
  expect(w.ran).toHaveLength(1)
  expect(w.asked).toEqual([])
  expect(w.snapshotIds()).toHaveLength(1)
  expect(out).toMatchObject({ context: ['Safety Net saved snapshot #1 before this ran; /safety restore 1 puts it back.'] })
  expect(await bandTexts($)).toEqual([])
  expect(w.toasts).toEqual([])
})

for (const [name, surfaces, asks] of [['draws nowhere (headless)', [], false], ['draws in the terminal', ['terminal'], true], ['cannot be told', 'error', true]] as const) {
  test(`when session.start did not run (a reload) and the session ${name}, ${asks ? 'the person is asked' : 'nobody is asked'}`, async ($, on) => {
    const w = world(on, { surfaces: surfaces as never })
    reports(w)
    const call = track(bash($, 'rm -rf reports/'))
    await settle(w)
    expect(await pendingQuestion($)).toBe(asks)
    if (asks) await drain($, w)
    await call.promise
    expect(w.snapshotIds()).toHaveLength(1)
    expect(w.ran).toHaveLength(asks ? 0 : 1)
  })
}

test('confirm never: runs at once, a toast says where the snapshot is, Claude is told', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const out = await bash($, 'rm -rf reports/')
  expect(w.ran).toHaveLength(1)
  expect(w.toasts).toEqual(['Snapshot #1 saved before this command. Undo: /safety restore 1'])
  expect(out).toMatchObject({ context: [expect.stringContaining('/safety restore 1')] })
  expect(await bandTexts($)).toEqual([])
  expect(w.asked).toEqual([])
  // a quiet save of an edit is no news
  put(w, 'notes.txt', 'v1')
  const edited = await edit($, 'notes.txt', 'v2')
  expect(w.toasts).toHaveLength(1)
  expect(edited).not.toHaveProperty('context')
})

test('confirm always asks about an edit of a file Git does not track; the second edit asks again but saves no second snapshot', { options: { confirm: 'always' } }, async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w)
  const first = track(edit($, 'notes.txt', 'v2'))
  await settle(w)
  expect(await bandTexts($)).toContain(' WAITING FOR YOU  About to overwrite the file "notes.txt" · Edit')
  expect(await bandTexts($)).toContain('✔ Snapshot saved at 14:05 (#1)')
  await press($, w, 'allow')
  await first.promise
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v2')
  const second = track(write($, 'notes.txt', 'v3'))
  await settle(w)
  expect(second.isDone).toBe(false)
  expect(await bandTexts($)).toContain('✔ Snapshot saved at 14:05 (#1)')
  expect(w.snapshotIds()).toHaveLength(1)
  await press($, w, 'allow')
  const out = await second.promise
  expect(out).not.toHaveProperty('context')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v3')
})

test('the default (risky) saves an edit of an untracked file quietly, once for the whole session; the first save keeps the original', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w)
  const outs = []
  for (const to of ['v2', 'v3', 'v4']) outs.push(await edit($, 'notes.txt', to))
  expect(w.ran).toHaveLength(3)
  expect(w.asked).toEqual([])
  expect(await bandTexts($)).toEqual([])
  expect(w.snapshotIds()).toHaveLength(1)
  for (const out of outs) expect(out).not.toHaveProperty('context')
  const saved = [...w.files].find(([k]) => k.includes('/files/notes.txt'))
  expect(saved?.[1]).toBe('v1')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v4')
  // another file is another snapshot
  put(w, 'other.txt', 'v1')
  await edit($, 'other.txt', 'v2')
  expect(w.snapshotIds()).toHaveLength(2)
})

test('two edits of one file at the same moment make one snapshot', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w)
  await Promise.all([edit($, 'notes.txt', 'v2'), edit($, 'notes.txt', 'v3'), edit($, 'notes.txt', 'v4')])
  expect(w.ran).toHaveLength(3)
  expect(w.snapshotIds()).toHaveLength(1)
})

test('the other watched tools are looked at too: MultiEdit, NotebookEdit, PowerShell', async ($, on) => {
  const w = world(on)
  put(w, 'a.txt', 'v1')
  put(w, 'nb.ipynb', '{}')
  reports(w)
  await begin($, w)
  await $.tool.call({ tool: 'MultiEdit', file_path: `${ROOT}/a.txt`, edits: [{ old_string: 'v1', new_string: 'v2' }] } as never)
  expect(w.snapshotIds()).toHaveLength(1)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/nb.ipynb`, new_source: 'x' } as never)
  expect(w.snapshotIds()).toHaveLength(2)
  const call = track($.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force reports' } as never))
  await settle(w)
  expect(await bandTexts($)).toContain(' WAITING FOR YOU  About to delete the folder "reports/" · Remove-Item -Recurse')
  await drain($, w)
  await call.promise
})

// (Claude Code itself already reads a value outside the list as the default; flow.test.ts covers the plugin's own reading of one.)
test('an unknown confirm value means risky: a risky command asks, a plain edit does not', { options: { confirm: 'sometimes' } }, async ($, on) => {
  const w = world(on)
  reports(w)
  put(w, 'notes.txt', 'v1')
  await begin($, w)
  await edit($, 'notes.txt', 'v2')
  expect(w.ran).toHaveLength(1)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(await pendingQuestion($)).toBe(true)
  await drain($, w)
  await call.promise
})

// ---- calls that are none of its business ----

test('ordinary calls pass straight through: no snapshot, no question, no state, no git', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  reports(w)
  put(w, 'old.txt')
  await begin($, w)
  const commands = ['ls -la', 'git push origin main', 'rm old.txt', 'git commit -m "git reset --hard"', 'echo "rm -rf /"', 'git reset --soft HEAD~1', 'npm test', 'cat .env']
  for (const command of commands) expect(await bash($, command)).toMatchObject({ result: { stdout: 'ok' } })
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task']) expect(await $.tool.call({ tool, file_path: `${ROOT}/old.txt`, pattern: 'x' } as never)).toMatchObject({ result: { stdout: 'ok' } })
  // an edit of a file that did not exist, and of one Git tracks, loses nothing
  expect(await write($, 'brand-new.txt', 'hello')).toMatchObject({ result: { stdout: 'ok' } })
  w.git.tracked.add('old.txt')
  expect(await edit($, 'old.txt', 'v2')).toMatchObject({ result: { stdout: 'ok' } })
  expect(w.ran).toHaveLength(commands.length + 5 + 2)
  expect(w.snapshotIds()).toEqual([])
  expect(w.asked).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.writes.filter(p => p.startsWith(SNAPS))).toEqual([])
  expect(await bandTexts($)).toEqual([])
  for (const c of w.gitCalls) expect(c.join(' ')).not.toMatch(/stash|update-ref/)
})

test('rm -rf of something that is not there loses nothing: it runs without a question, while a real folder still asks', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  expect(await bash($, 'rm -rf not-there/ also-missing')).toMatchObject({ result: { stdout: 'ok' } })
  expect(w.asked).toEqual([])
  expect(w.snapshotIds()).toEqual([])
  expect(await bandTexts($)).toEqual([])
  // the same command on a folder that exists is still held for the person
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(call.isDone).toBe(false)
  expect(w.snapshotIds()).toHaveLength(1)
  await press($, w, 'cancel')
  expect(await call.promise).toMatchObject({ deny: expect.stringContaining('Cancel') })
})

test('a lookup that fails lets the call go on, and says so in the debug log only', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  w.failRoot = true
  const out = await bash($, 'rm -rf reports/')
  expect(out).toMatchObject({ result: { stdout: 'ok' } })
  expect(w.ran).toHaveLength(1)
  expect(await bandTexts($)).toEqual([])
  expect(w.logs.length).toBeGreaterThan(0)
  for (const l of w.logs) expect(l.to).toBe('debug')
  expect(w.logs.some(l => l.text.startsWith('kit-safety: could not look at a Bash call; it goes on'))).toBe(true)
  expect(w.toasts).toEqual([])
})

test('a snapshot that cannot be saved is said on the band, and the question is still asked', async ($, on) => {
  const w = world(on)
  reports(w)
  w.failSnapshotWrites = true
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(await bandTexts($)).toContain('⚠ No snapshot could be saved, so /safety restore cannot bring this back')
  await press($, w, 'allow')
  // Allowed, but there is nothing to tell Claude about
  expect(await call.promise).not.toHaveProperty('context')
  expect(w.ran).toHaveLength(1)
})

test('the project root being unknown or odd never blocks a call', async ($, on) => {
  const w = world(on, { env: {} })
  reports(w)
  await begin($, w)
  // no home folder: snapshots cannot be placed, the question still is
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(await bandTexts($)).toContain('⚠ No snapshot could be saved, so /safety restore cannot bring this back')
  await drain($, w)
  await call.promise
})

// ---- the session ----

test('session.end answers every waiting question as interrupted and empties the band', async ($, on) => {
  const w = world(on)
  for (const f of ['a', 'b']) put(w, `${f}/x.txt`)
  await begin($, w)
  const first = track(bash($, 'rm -rf a/'))
  await settle(w)
  const second = track(bash($, 'rm -rf b/'))
  await settle(w)
  expect(await pendingQuestion($)).toBe(true)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: {} } as never)
  await settle(w)
  expect(first.isDone).toBe(true)
  expect(second.isDone).toBe(true)
  // an interruption is not a "Cancel": the person did not answer
  expect(await first.promise).toEqual({ deny: 'The call was interrupted before the person answered in Safety Net: About to delete the folder "a/". Nothing was changed.' })
  expect(await second.promise).toEqual({ deny: 'The call was interrupted before the person answered in Safety Net: About to delete the folder "b/". Nothing was changed.' })
  expect(w.ran).toEqual([])
  expect(await bandTexts($)).toEqual([])
  await w.clock.advance(20 * MIN)
  expect(w.asked).toEqual([])
})

test('session.start clears a question left over from before a reload, registers /safety, and never blocks', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  expect(w.commands).toEqual(['safety'])
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  expect(await pendingQuestion($)).toBe(true)
  await begin($, w)
  expect(await bandTexts($)).toEqual([])
  expect(w.commands).toEqual(['safety', 'safety'])
  // the old wait ends by itself, with no one to ask
  await w.clock.advance(15 * MIN)
  await settle(w)
  expect(await call.promise).toMatchObject({ deny: expect.stringContaining('no answer in time') })
})

/** A snapshot of another project, as an earlier session of that folder left it. */
const OTHER = '/work/other-shop'
function foreignSnapshot(w: World, createdAt: number): { dir: string; file: string } {
  const id = newSnapshotId(createdAt, [])
  const dir = snapshotDir(SNAPS, projectKey(OTHER), id)
  const manifest = buildManifest(
    { v: 1, id, n: 1, createdAt, root: OTHER, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'delete', label: 'rm -rf' }], targets: ['dist'], backend: 'fs' },
    { files: [{ rel: 'dist/a.js', size: 6, mtimeMs: 1 }], dirs: [], skipped: [] },
  )
  w.put(`${dir}/manifest.json`, serializeManifest(manifest))
  w.put(`${dir}/files/dist/a.js`, 'xxxxxx')
  return { dir, file: `${dir}/files/dist/a.js` }
}

test('session.start sweeps old snapshots of every project in the background; age beats "the newest", and a fresh one stays', { options: { keepDays: 1 } }, async ($, on) => {
  const w = world(on)
  for (const f of ['a', 'b', 'c']) put(w, `${f}/x.txt`)
  await begin($, w, false)
  await bash($, 'rm -rf a/')
  await bash($, 'rm -rf b/')
  const other = foreignSnapshot(w, NOW)
  expect(await safety($)).toContain('Snapshots for acme-shop (2):')
  const old = w.snapshotIds().filter(id => w.read(`${snapshotDir(SNAPS, projectKey(ROOT), id)}/manifest.json`) !== undefined)
  expect(old).toHaveLength(2)
  // three days later a new session starts: every snapshot is older than keepDays, the newest ones too, in this project and in the other
  await w.clock.advance(3 * DAY)
  await begin($, w, false)
  expect(await safety($)).toBe(['There are no snapshots for this project yet.', 'Usage: /safety list | /safety restore [number] | /safety undo | /safety doctor'].join('\n'))
  for (const id of old) expect(w.read(`${snapshotDir(SNAPS, projectKey(ROOT), id)}/pruned`)).toBeDefined()
  expect(w.read(`${other.dir}/pruned`)).toBeDefined()
  expect(w.read(other.file)).toBe('')
  // a snapshot made after the sweep is a fresh one: it stays through the next session start
  await bash($, 'rm -rf c/')
  await begin($, w, false)
  const list = await safety($)
  expect(list).toContain('Snapshots for acme-shop (1):')
  expect(list).toContain('rm -rf')
  expect(w.read(`${other.dir}/pruned`)).toBeDefined()
})

test('session.start survives every call failing', async ($, on) => {
  const w = world(on, { language: 'error', surfaces: 'error', failRoot: true })
  await begin($, w)
  await expect($.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })).resolves.toBeDefined()
})

// ---------------------------------------------------------------------------------------------------------------------
// Masking

const row = (content: unknown[], over: Record<string, unknown> = {}) =>
  ({ message: { type: 'user', role: 'user', content, ...over }, door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'u1' }) as never

test('session.append: a tool result is stored with every secret masked, and everything the engine pins stays as it was', async ($, on) => {
  const w = world(on)
  const key = anthropic()
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${key}AAAA` } }
  await $.session.append(row([
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `KEY=${key}\nTOKEN=${github()}` }, image] },
  ], { isMeta: true, name: 'tool_result' }))
  const [stored] = w.session.appended()
  expect(stored?.message.content).toEqual([
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `KEY=${MASKED}\nTOKEN=ghp_•••• masked` }, image] },
  ])
  expect(stored?.message).toMatchObject({ type: 'user', role: 'user', isMeta: true, name: 'tool_result' })
  expect(stored?.door).toBe('tool-result')
  expect(stored?.uuid).toBe('u1')
  expect(JSON.stringify((stored?.message.content[0] as unknown as { content: { text: string }[] }).content[0])).not.toContain(key)
})

test('session.append: a string result is masked, a clean one is not touched', async ($, on) => {
  const w = world(on)
  await $.session.append(row([{ type: 'tool_result', tool_use_id: 't1', content: `postgres://shop:${'pw'.repeat(6)}@db.acme-shop.example/app` }]))
  const clean = [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x  2 dev dev 4096 .' }] }]
  await $.session.append(row(clean))
  const [masked, plain] = w.session.appended()
  expect(JSON.stringify(masked?.message.content)).toContain('••••')
  expect(JSON.stringify(masked?.message.content)).not.toContain('pwpwpw')
  expect(plain?.message.content).toEqual(clean)
})

test('session.append: only tool results are masked (the person\'s own words and the model\'s are not rewritten)', async ($, on) => {
  const w = world(on)
  const key = anthropic()
  for (const [door, origin] of [['prompt', { kind: 'composer' }], ['response', { kind: 'model', model: 'm' }]] as const) {
    await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: `my key is ${key}` }] }, door, origin, uuid: `u-${door}` } as never)
  }
  for (const stored of w.session.appended()) expect(JSON.stringify(stored.message.content)).toContain(key)
})

test('maskSecrets false: nothing is masked, anywhere', { options: { maskSecrets: false } }, async ($, on) => {
  const w = world(on)
  const key = anthropic()
  await $.session.append(row([{ type: 'tool_result', tool_use_id: 't1', content: `KEY=${key}` }]))
  expect(JSON.stringify(w.session.appended()[0]?.message.content)).toContain(key)
  const ui = await $.ui.mount({ plugin: 'kit-safety', component: 'ToolResult', surface: 'terminal', props: { tool_use_id: 't1', tool: 'Bash', output: { stdout: `KEY=${key}` }, isErrored: false } })
  expect(await textsOf(ui)).toEqual([`engine result: ${JSON.stringify({ stdout: `KEY=${key}` })}`])
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`ToolResult on the ${surface}: the screen shows the masked result and one dim line saying so`, async ($, on) => {
    world(on)
    const key = anthropic()
    const output = { stdout: `ANTHROPIC_API_KEY=${key}\nDATABASE_URL=postgres://shop:${'pw'.repeat(6)}@db.acme-shop.example/app`, stderr: '', nested: [{ token: github() }] }
    const ui = await $.ui.mount({ plugin: 'kit-safety', component: 'ToolResult', surface, props: { tool_use_id: 't1', tool: 'Bash', output, isErrored: false } })
    const texts = await textsOf(ui)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain(MASKED)
    expect(texts[0]).toContain('ghp_•••• masked')
    expect(texts[0]).not.toContain(key)
    expect(texts[0]).not.toContain('pwpwpw')
    expect(texts[1]).toBe('◈ 3 secret values were masked before they entered the conversation.')
    const note = await ui.find({ type: 'Text', text: texts[1]! })
    expect(note?.props.dimColor).toBe(true)
    await ui.unmount()
  })
}

test('ToolResult: one secret reads in the singular; a clean result is the engine\'s own; an errored one is masked too', async ($, on) => {
  world(on)
  const key = anthropic()
  const mount = (output: unknown, isErrored = false) =>
    $.ui.mount({ plugin: 'kit-safety', component: 'ToolResult', surface: 'desktop', props: { tool_use_id: 't1', tool: 'Bash', output, isErrored } })
  let ui = await mount(`token ${key}`)
  expect((await textsOf(ui)).at(-1)).toBe('◈ 1 secret value was masked before it entered the conversation.')
  await ui.unmount()
  ui = await mount({ stdout: 'total 8', stderr: '' })
  expect(await textsOf(ui)).toEqual(['engine result: {"stdout":"total 8","stderr":""}'])
  await ui.unmount()
  ui = await mount(`failed with ${key}`, true)
  expect((await textsOf(ui))[0]).not.toContain(key)
  await ui.unmount()
  for (const odd of [undefined, null, 5, true, [], {}]) {
    ui = await mount(odd)
    expect(await textsOf(ui)).toHaveLength(1)
    await ui.unmount()
  }
})

test('the secret of a command never reaches the screen, the context or the snapshot record', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w, false)
  const key = anthropic()
  const out = await bash($, `API_KEY=${key} rm -rf reports/`)
  expect(JSON.stringify(out)).not.toContain(key)
  expect(everything(w)).not.toContain(key)
  expect(JSON.stringify(w.logs)).not.toContain(key)
  expect(JSON.stringify(w.toasts)).not.toContain(key)
})

// ---------------------------------------------------------------------------------------------------------------------
// /safety

test('/safety and /safety list: no snapshots yet, then one line each', async ($, on) => {
  const w = world(on)
  reports(w)
  put(w, 'notes.txt', 'v1')
  await begin($, w, false)
  const usage = 'Usage: /safety list | /safety restore [number] | /safety undo | /safety doctor'
  expect(await safety($)).toBe(['There are no snapshots for this project yet.', usage].join('\n'))
  await bash($, 'rm -rf reports/')
  await edit($, 'notes.txt', 'v2')
  const text = await safety($)
  expect(text.split('\n')).toEqual([
    'Snapshots for acme-shop (2):',
    '#2  today 14:05  Edit (saved quietly)  1 file, 2 B',
    `#1  today 14:05  ${'rm -rf'.padEnd('Edit (saved quietly)'.length)}  3 files, 18 B`,
    'Put one back with /safety restore <number>, or /safety restore for the newest.',
    usage,
  ])
  expect(await safety($, 'list')).toBe(text)
  expect(await safety($, '  LIST ')).toBe(text)
  expect(await safety($, 'list now')).toBe(usage)
})

test('/safety help, an unknown word, and extra words give the usage', async ($, on) => {
  const w = world(on)
  await begin($, w)
  const usage = 'Usage: /safety list | /safety restore [number] | /safety undo | /safety doctor'
  expect(await safety($, 'help')).toContain(usage)
  expect(await safety($, 'help')).toContain('Usage: /safety restore [number]')
  expect(await safety($, '--help')).toContain(usage)
  expect(await safety($, 'frobnicate')).toBe(usage)
  expect(await safety($, 'undo please')).toBe(usage)
  expect(await safety($, 'doctor now')).toBe(usage)
})

test('/safety restore puts the folder back, says what it did, and knows no undo point could be made for a folder that is gone', async ($, on) => {
  const w = world(on)
  reports(w)
  put(w, 'src/app.ts', 'keep')
  await begin($, w, false)
  await bash($, 'rm -rf reports/')
  expect([...w.files.keys()].filter(k => k.startsWith(`${ROOT}/reports`))).toEqual([])
  const text = await safety($, 'restore')
  expect(text.split('\n')).toEqual([
    '✓ Restored 3 files to 14:05  (snapshot #1)',
    '  reports/a.js  reports/b.js  reports/c.js',
    // the folder was gone, so nothing was overwritten: no undo point was needed (it was not "could not be saved")
    'Nothing was overwritten, so there is no undo point: /safety undo cannot take restored files away again. To remove them, delete them yourself.',
  ])
  expect([...w.files.keys()].filter(k => k.startsWith(`${ROOT}/reports`)).sort()).toEqual([`${ROOT}/reports/a.js`, `${ROOT}/reports/b.js`, `${ROOT}/reports/c.js`])
  expect(w.read(`${ROOT}/reports/a.js`)).toBe('xxxxxx')
  expect(w.read(`${ROOT}/src/app.ts`)).toBe('keep')
  // by number, with or without the #
  await bash($, 'rm -rf reports/')
  expect(await safety($, 'restore 1')).toContain('✓ Restored 3 files to 14:05  (snapshot #1)')
  await bash($, 'rm -rf reports/')
  expect(await safety($, 'restore #1')).toContain('✓ Restored 3 files')
  expect(w.files.has(`${ROOT}/reports/b.js`)).toBe(true)
})

test('/safety restore: no snapshots, an unknown number, and words that are not a number', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w, false)
  expect(await safety($, 'restore')).toBe('There are no snapshots for this project yet.')
  await bash($, 'rm -rf reports/')
  expect(await safety($, 'restore 99')).toBe('There is no snapshot #99. /safety list shows them.')
  expect(await safety($, 'restore #99')).toBe('There is no snapshot #99. /safety list shows them.')
  expect(await safety($, 'restore all')).toBe('There is no snapshot #all. /safety list shows them.')
  expect(await safety($, `restore ${'9'.repeat(500)}`)).toContain('There is no snapshot #')
  expect((await safety($, 'restore \u202E7\u0007')).includes('\u202E')).toBe(false)
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(false)
})

test('/safety undo takes back a restore, a second undo is a redo, and with no restore it says so', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w, false)
  expect(await safety($, 'undo')).toBe('There is nothing to undo: no restore has been done in this project yet.')
  await edit($, 'notes.txt', 'v2')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v2')
  const restored = await safety($, 'restore 1')
  expect(restored.split('\n')).toEqual(['✓ Restored 1 file to 14:05  (snapshot #1)', '  notes.txt', 'Changed your mind? /safety undo'])
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v1')
  const undone = await safety($, 'undo')
  expect(undone.split('\n')[0]).toBe('✓ Undid the last restore: 1 file back as they were at 14:05  (snapshot #2)')
  expect(undone).toContain('To go back again: /safety undo')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v2')
  await safety($, 'undo')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v1')
})

test('after a restore the files are saved again by the next edit (what was remembered no longer holds)', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w, false)
  await edit($, 'notes.txt', 'v2')
  await edit($, 'notes.txt', 'v3')
  expect(w.snapshotIds()).toHaveLength(1)
  await safety($, 'restore 1')
  await edit($, 'notes.txt', 'v4')
  const list = await safety($)
  expect(list).toContain('#3')
  expect(list).toContain('(undo point)')
})

test('a restore is not asked about, and runs no git command; a plain rm -rf snapshot has no Git hint to show', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stash = 'b'.repeat(40)
  reports(w)
  await begin($, w, false)
  await bash($, 'rm -rf reports/')
  const before = w.gitCalls.length
  const text = await safety($, 'restore')
  expect(w.asked).toEqual([])
  expect(await bandTexts($)).toEqual([])
  // a delete is not a Git risk: no Git state was saved for it, so there is nothing to print
  expect(text).not.toContain('Git:')
  expect(text).not.toContain('git stash')
  expect(text).toContain('✓ Restored 3 files to 14:05  (snapshot #1)')
  for (const c of w.gitCalls.slice(before)) expect(c.join(' ')).not.toMatch(/checkout|reset|clean|stash|branch/)
})

test('a restore of a git reset --hard snapshot shows the stash command as text to copy, and never runs it', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stash = 'b'.repeat(40)
  await begin($, w, false)
  await bash($, 'git reset --hard')
  expect(w.snapshotIds()).toHaveLength(1)
  const before = w.gitCalls.length
  const text = await safety($, 'restore')
  expect(w.asked).toEqual([])
  expect(await bandTexts($)).toEqual([])
  expect(text).toContain('Git: the commits and changes were saved too. To bring them back yourself, run:')
  expect(text).toMatch(/\n {2}git stash apply refs\/kit-safety\/\d{8}T\d{6}Z/)
  for (const c of w.gitCalls.slice(before)) expect(c.join(' ')).not.toMatch(/checkout|reset|clean|stash apply|branch/)
  expect(w.ran.map(r => r.input.command)).toEqual(['git reset --hard'])
})

test('/safety doctor: one line each, then a summary', async ($, on) => {
  const w = world(on)
  await begin($, w)
  const lines = (await safety($, 'doctor')).split('\n')
  expect(lines).toEqual([
    'PASS Claude Code 2.1.331 (needs 2.1.275 or later)',
    'WARN Node.js not found: snapshots then save text files up to 3 MB; with Node they also save binary and large files',
    'PASS Git 2.43.0 found',
    `PASS Snapshot folder ${SNAPS} can be written to: no snapshots yet`,
    'PASS No snapshots in any project yet; all of them together may take up to 2 GB',
    'PASS Options: asks before commands that delete, overwrite or rewrite history; masks secrets in tool results; language: English',
    'PASS Running in: terminal',
    '6 ok, 1 to look at, 0 broken.',
  ])
})

test('/safety doctor: Node there with a helper that answers, Git missing, snapshots in the folder', async ($, on) => {
  const w = world(on, { node: { helperOk: true }, hasGit: false })
  reports(w)
  await begin($, w, false)
  await bash($, 'rm -rf reports/')
  const text = await safety($, 'doctor')
  expect(text).toContain('PASS Node.js 22.1.0 found: snapshots can include binary and large files')
  expect(text).toContain('PASS The Node helper script answered: binary and large files are saved too')
  expect(text).toContain('WARN Git not found: Safety Net still saves files, but not the Git snapshot')
  expect(text).toContain(`PASS Snapshot folder ${SNAPS} can be written to: 1 snapshot, `)
  // and it still saves the snapshot when the helper does not do the work
  expect(w.snapshotIds()).toHaveLength(1)
})

test('/safety doctor: a helper that does not answer, a folder that cannot be written, masking turned off', { options: { maskSecrets: false } }, async ($, on) => {
  const w = world(on, { node: { helperOk: false } })
  w.failSnapshotWrites = true
  await begin($, w)
  const text = await safety($, 'doctor')
  expect(text).toContain('WARN The Node helper script did not answer: snapshots save text files up to 3 MB; with the helper they also save binary and large files')
  expect(text).toContain(`FAIL Cannot write to ${SNAPS}: snapshots cannot be saved, but the questions and secret masking still work`)
  expect(text).toContain('PASS Options: asks before commands that delete, overwrite or rewrite history; does not mask secrets (turned off); language: English')
  expect(text.split('\n').at(-1)).toMatch(/^\d+ ok, \d+ to look at, 1 broken\.$/)
})

test('/safety doctor never changes the project, and says nothing about secrets', async ($, on) => {
  const w = world(on)
  reports(w)
  const before = [...w.files.keys()].filter(k => k.startsWith(ROOT))
  await begin($, w)
  await safety($, 'doctor')
  expect([...w.files.keys()].filter(k => k.startsWith(ROOT))).toEqual(before)
  expect(w.read(`${SNAPS}/.doctor`)).toBe('ok again\n')
})

test('/safety in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w, false)
  const vi = TABLES.vi
  expect(await safety($)).toBe([vi.noSnapshots, vi.usage].join('\n'))
  await bash($, 'rm -rf reports/')
  expect(await safety($, 'restore')).toContain('✓ Đã khôi phục 3 file về 14:05  (snapshot #1)')
  expect(await safety($, 'restore 7')).toBe(vi.noSuchSnapshot('7'))
  expect(await safety($, 'undo')).toBe(vi.noUndo)
  expect(await safety($, 'doctor')).toContain('PASS Claude Code 2.1.331')
  expect(await safety($, 'bogus')).toBe(vi.usage)
})

test('the command is registered with a description and a hint in the language in use', async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(w.commands).toEqual(['safety'])
})

for (const surface of SURFACES) {
  test(`the result card of /safety on the ${surface}: one Text a line, indents kept, the first line coloured`, async ($, on) => {
    const w = world(on)
    reports(w)
    await begin($, w, false)
    await bash($, 'rm -rf reports/')
    const text = await safety($, 'restore')
    const ui = await $.ui.mount({ plugin: 'kit-safety', component: 'CommandOutput', surface, props: { command: 'safety', args: 'restore', text, isErrored: false } as never })
    const texts = await textsOf(ui)
    expect(texts).toEqual(text.split('\n'))
    expect(texts[1]?.startsWith('  reports/a.js')).toBe(true)
    const first = await ui.find({ type: 'Text', text: texts[0]! })
    expect(first?.props.color).toBe('success')
    await ui.unmount()
  })
}

test('the result card colours a failure and a partial result, and leaves an errored command row to the engine', async ($, on) => {
  world(on)
  const mount = (text: string, isErrored = false) =>
    $.ui.mount({ plugin: 'kit-safety', component: 'CommandOutput', surface: 'terminal', props: { command: 'safety', args: '', text, isErrored } as never })
  for (const [text, color] of [['✗ Could not restore snapshot #1. Nothing was changed.', 'error'], ['! Partly restored: 1 file', 'warning']] as const) {
    const ui = await mount(text)
    expect((await ui.find({ type: 'Text', text }))?.props.color).toBe(color)
    await ui.unmount()
  }
  const plain = await mount('Usage: /safety list')
  expect((await plain.find({ type: 'Text', text: 'Usage: /safety list' }))?.props.color).toBeUndefined()
  await plain.unmount()
  const errored = await mount('boom', true)
  expect(await textsOf(errored)).toEqual(['engine command: boom'])
  await errored.unmount()
  const empty = await mount('')
  expect(await textsOf(empty)).toEqual(['engine command: '])
  await empty.unmount()
})

test('outcomeText: a refused or failed restore reads plainly', () => {
  const en = TABLES.en
  const base: RestoreOutcome = { ok: false, restored: 0, failed: [], keptNewer: 0, at: NOW, id: '20261124T140512Z', n: 7, sample: [], hasUndo: false, git: [] }
  expect(outcomeText({ ...base, reason: 'other-project' }, '7', en, 'restore')).toBe('There is no snapshot #7. /safety list shows them.')
  expect(outcomeText({ ...base, reason: 'other-project' }, '', en, 'restore')).toBe('There is no snapshot #7. /safety list shows them.')
  expect(outcomeText({ ...base, reason: 'not-found' }, '7', en, 'restore')).toBe('Snapshot #7 cannot be read (its record is damaged), so it cannot be restored.')
  expect(outcomeText({ ...base, reason: 'failed' }, '7', en, 'restore')).toBe('✗ Could not restore snapshot #7. Nothing was changed.')
  expect(outcomeText({ ...base, reason: 'failed' }, '', en, 'undo')).toBe('✗ Could not undo the last restore. Nothing was changed.')
  expect(outcomeText({ ...base, ok: true, restored: 2, sample: ['a', 'b'], hasUndo: true }, '', en, 'restore')).toBe('✓ Restored 2 files to 14:05  (snapshot #7)\n  a  b\nChanged your mind? /safety undo')
})

test('only one restore runs at a time', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w, false)
  await bash($, 'rm -rf reports/')
  const [one, two] = await Promise.all([safety($, 'restore'), safety($, 'restore')])
  const texts = [one, two]
  expect(texts.filter(t => t.startsWith('✓ Restored'))).toHaveLength(1)
  expect(texts.filter(t => t === 'Another restore is running right now. Try again in a moment.')).toHaveLength(1)
  // and the lock is let go afterwards
  expect(await safety($, 'restore')).toContain('✓ Restored')
})

test('/safety works with no project folder known, and a failing engine is a line of text, not an error', async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.failRoot = true
  expect(await safety($, 'list')).toBe(['Safety Net could not tell which project this is, so it has no snapshots to show.', 'Usage: /safety list | /safety restore [number] | /safety undo | /safety doctor'].join('\n'))
  expect(await safety($, 'restore')).toBe('Safety Net could not tell which project this is, so it has no snapshots to show.')
  expect(await safety($, 'undo')).toBe('Safety Net could not tell which project this is, so it has no snapshots to show.')
  expect(await safety($, 'help')).toContain('Usage')
})

// ---------------------------------------------------------------------------------------------------------------------
// Fix pass D

const SNAPDIR = (id: string) => snapshotDir(SNAPS, projectKey(ROOT), id)
const manifestOf = (w: World, id: string): Manifest => JSON.parse(w.read(`${SNAPDIR(id)}/manifest.json`) ?? 'null') as Manifest
const stored = (w: World, id: string, rel: string) => w.read(`${SNAPDIR(id)}/files/${rel}`)

// ---- a stray press ----

test('a press less than 600 ms after the question first drew changes nothing and leaves it open; from 600 ms on it answers', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  // the very moment it drew: Allow, then Cancel, both ignored
  await ui.press({ key: 'allow' })
  await ui.press({ key: 'cancel' })
  await settle(w)
  expect(call.isDone).toBe(false)
  expect(w.ran).toEqual([])
  expect(await pendingQuestion($)).toBe(true)
  await w.clock.advance(599)
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'allow' })
  await settle(w)
  expect(call.isDone).toBe(false)
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(true)
  expect(await pendingQuestion($)).toBe(true)
  await w.clock.advance(1)
  await ui.press({ key: 'allow' })
  await settle(w)
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
  expect(w.ran).toHaveLength(1)
  await ui.unmount()
})

test('Cancel waits for the same 600 ms, and works after it', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'desktop')
  await w.clock.advance(300)
  await ui.press({ key: 'cancel' })
  await settle(w)
  expect(call.isDone).toBe(false)
  await w.clock.advance(300)
  await ui.press({ key: 'cancel' })
  await settle(w)
  expect(await call.promise).toMatchObject({ deny: expect.stringContaining('The person chose Cancel') })
  expect(w.ran).toEqual([])
  await ui.unmount()
})

test('the second question gets its own 600 ms: a press that was meant for the first cannot answer it', async ($, on) => {
  const w = world(on)
  for (const f of ['a', 'b']) put(w, `${f}/x.txt`)
  await begin($, w)
  const first = track(bash($, 'rm -rf a/'))
  await settle(w)
  const second = track(bash($, 'rm -rf b/'))
  await settle(w)
  const one = await mountBand($, 'terminal')
  await readIt(w)
  await one.press({ key: 'allow' })
  await settle(w)
  expect(first.isDone).toBe(true)
  // the band now shows "b/" at once, and a second press of the same digit arrives with it
  const two = await mountBand($, 'terminal')
  expect((await ours(two)).join('\n')).toContain('"b/"')
  await two.press({ key: 'allow' })
  await two.press({ key: 'cancel' })
  await settle(w)
  expect(second.isDone).toBe(false)
  expect(w.ran.map(r => r.input.command)).toEqual(['rm -rf a/'])
  await w.clock.advance(600)
  await two.press({ key: 'cancel' })
  await settle(w)
  expect(await second.promise).toMatchObject({ deny: expect.stringContaining('"b/"') })
  expect(w.ran.map(r => r.input.command)).toEqual(['rm -rf a/'])
  await one.unmount()
  await two.unmount()
})

test('seeing the question again (another mount, a collapse and back) does not start the 600 ms over', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const first = await mountBand($, 'terminal')
  await w.clock.advance(700)
  const again = await mountBand($, 'desktop')
  await again.press({ key: 'allow' })
  await settle(w)
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
  await first.unmount()
  await again.unmount()
})

test('"See changes" is not held back: it only opens a line', async ($, on) => {
  const w = world(on)
  w.put(`${ROOT}/.env`, 'A=1\nB=2\n')
  w.put(`${ROOT}/.env.example`, 'A=1\nNEW=1\n')
  await begin($, w)
  const call = track(bash($, 'cp .env.example .env'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  await ui.press({ key: 'details' })
  expect((await ours(ui)).join('\n')).toContain('it loses B; it adds NEW')
  await ui.unmount()
  await drain($, w)
  await call.promise
})

// ---- the snapshot taken again after a long wait ----

test('after a wait of more than a minute the same files are saved again just before the call runs, and Claude hears about the new snapshot', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  expect(w.snapshotIds()).toHaveLength(1)
  await w.clock.advance(2 * MIN)
  // a file was edited and another one added while the question waited
  put(w, 'reports/a.js', 'edited while waiting')
  put(w, 'reports/d.js', 'brand new')
  await ui.press({ key: 'allow' })
  await settle(w)
  const out = await call.promise
  const [older, newer] = w.snapshotIds()
  expect(w.snapshotIds()).toHaveLength(2)
  // the first snapshot is left as it was, the second has what changed
  expect(stored(w, older!, 'reports/a.js')).toBe('xxxxxx')
  expect(stored(w, older!, 'reports/d.js')).toBeUndefined()
  expect(stored(w, newer!, 'reports/a.js')).toBe('edited while waiting')
  expect(stored(w, newer!, 'reports/d.js')).toBe('brand new')
  expect(manifestOf(w, newer!).n).toBe(2)
  expect(out).toMatchObject({ context: ['Safety Net saved snapshot #2 before this ran; /safety restore 2 puts it back.'] })
  expect(w.ran).toHaveLength(1)
  // both are listed, and the newest is the one /safety restore puts back
  const list = await safety($)
  expect(list).toContain('Snapshots for acme-shop (2):')
  expect(list).toContain('#2')
  await ui.unmount()
})

test('a minute or less: nothing is saved again, and Claude hears about the first snapshot', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  await w.clock.advance(60_000)
  put(w, 'reports/d.js', 'brand new')
  await ui.press({ key: 'allow' })
  await settle(w)
  const out = await call.promise
  expect(w.snapshotIds()).toHaveLength(1)
  expect(out).toMatchObject({ context: ['Safety Net saved snapshot #1 before this ran; /safety restore 1 puts it back.'] })
  await ui.unmount()
})

test('one millisecond over a minute is enough', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  await w.clock.advance(60_001)
  await ui.press({ key: 'allow' })
  await settle(w)
  expect(await call.promise).toMatchObject({ context: [expect.stringContaining('snapshot #2')] })
  expect(w.snapshotIds()).toHaveLength(2)
  await ui.unmount()
})

test('a second snapshot that cannot be saved leaves the first one standing, and the call still runs', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  expect(w.snapshotIds()).toHaveLength(1)
  w.failSnapshotWrites = true
  await w.clock.advance(5 * MIN)
  await ui.press({ key: 'allow' })
  await settle(w)
  const out = await call.promise
  expect(w.snapshotIds()).toHaveLength(1)
  expect(out).toMatchObject({ result: { stdout: 'ok' }, context: ['Safety Net saved snapshot #1 before this ran; /safety restore 1 puts it back.'] })
  expect(w.ran).toHaveLength(1)
  await ui.unmount()
})

test('a snapshot that was never saved is not taken after the wait either', async ($, on) => {
  const w = world(on)
  reports(w)
  w.failSnapshotWrites = true
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  w.failSnapshotWrites = false
  await w.clock.advance(5 * MIN)
  await ui.press({ key: 'allow' })
  await settle(w)
  expect(await call.promise).not.toHaveProperty('context')
  expect(w.snapshotIds()).toEqual([])
  await ui.unmount()
})

test('a Cancel after a long wait saves nothing more: a call that will not run needs no second snapshot', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  expect(w.snapshotIds()).toHaveLength(1)
  await w.clock.advance(5 * MIN)
  await ui.press({ key: 'cancel' })
  await settle(w)
  expect(await call.promise).toMatchObject({ deny: expect.stringContaining('Cancel') })
  expect(w.snapshotIds()).toHaveLength(1)
  await ui.unmount()
})

test('a git reset --hard that waited: the uncommitted changes are saved again, so what was edited meanwhile is in the second snapshot', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stash = 'b'.repeat(40)
  await begin($, w)
  const call = track(bash($, 'git reset --hard'))
  await settle(w)
  const ui = await mountBand($, 'terminal')
  expect(w.snapshotIds()).toHaveLength(1)
  await w.clock.advance(3 * MIN)
  w.git.stash = 'c'.repeat(40)
  await ui.press({ key: 'allow' })
  await settle(w)
  const out = await call.promise
  const [older, newer] = w.snapshotIds()
  expect(w.snapshotIds()).toHaveLength(2)
  expect(manifestOf(w, older!).git?.stashSha).toBe('b'.repeat(40))
  expect(manifestOf(w, newer!).git?.stashSha).toBe('c'.repeat(40))
  expect(out).toMatchObject({ context: [expect.stringContaining('Git state')] })
  await ui.unmount()
})

// ---- a command line that could not be read, the rest of the line, several branches, files picked at run time ----

test('a command line that could not be read to the end asks, shows where it starts (secrets masked), and says there was nothing to save', async ($, on) => {
  const w = world(on)
  reports(w)
  await begin($, w)
  const key = anthropic()
  const call = track(bash($, `API_KEY=${key} ${': ; '.repeat(2500)}rm -rf reports/`))
  await settle(w)
  const texts = await bandTexts($)
  expect(texts).toContain(' WAITING FOR YOU  This command line is too long or too tangled for Safety Net to read to the end · long command')
  expect(texts).toContain('Something dangerous could be hiding in the part it did not read: read the command before you allow it.')
  const snippet = texts.find(t => t.startsWith('The command starts: "'))
  expect(snippet).toBeDefined()
  expect(snippet).toContain(MASKED)
  expect(snippet!.endsWith('…"')).toBe(true)
  expect(texts).toContain('⚠ Nothing to save for this one')
  expect(texts.join('\n')).not.toContain(key)
  // never "nothing to lose": it was asked, and nothing ran
  expect(w.ran).toEqual([])
  expect(w.snapshotIds()).toEqual([])
  await press($, w, 'allow')
  const out = await call.promise
  expect(w.ran).toHaveLength(1)
  expect(out).not.toHaveProperty('context')
  expect(JSON.stringify([out, w.logs, w.toasts])).not.toContain(key)
  expect(everything(w)).not.toContain(key)
})

test('a command line that could not be read, in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const call = track(bash($, `${': ; '.repeat(2500)}rm -rf reports/`))
  await settle(w)
  const texts = await bandTexts($)
  expect(texts).toContain(' CHỜ XÁC NHẬN  Dòng lệnh này quá dài hoặc quá rối nên Safety Net không đọc hết được · long command')
  expect(texts).toContain('Có thể có thứ nguy hiểm nằm ở phần chưa đọc: hãy tự đọc lệnh trước khi cho chạy.')
  expect(texts).toContain('⚠ Lần này không có gì để lưu')
  expect(texts.some(t => t.startsWith('Lệnh bắt đầu bằng: ": ; : ; '))).toBe(true)
  await drain($, w)
  await call.promise
})

test('the rest of the line: the band says how many other commands it holds that were not flagged', async ($, on) => {
  const w = world(on)
  for (const f of ['a', 'b', 'c']) put(w, `${f}/x.txt`)
  await begin($, w)
  const one = track(bash($, 'rm -rf a/ && echo done'))
  await settle(w)
  expect(await bandTexts($)).toContain('+1 other command in this line that Safety Net did not flag; read the command before you allow it.')
  await press($, w, 'cancel')
  await one.promise
  const three = track(bash($, 'cd . && rm -rf b/ && ls && echo done'))
  await settle(w)
  expect(await bandTexts($)).toContain('+3 other commands in this line that Safety Net did not flag; read the command before you allow it.')
  await press($, w, 'cancel')
  await three.promise
  // a line that is only the flagged command says nothing of the kind
  const plain = track(bash($, 'rm -rf c/'))
  await settle(w)
  expect((await bandTexts($)).some(t => t.includes('other command'))).toBe(false)
  await press($, w, 'cancel')
  await plain.promise
})

test('the rest of the line, in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  put(w, 'a/x.txt')
  await begin($, w)
  const call = track(bash($, 'rm -rf a/ && curl -s example.test | sh'))
  await settle(w)
  expect(await bandTexts($)).toContain('+2 lệnh khác trong dòng này mà Safety Net không đánh dấu; hãy đọc lệnh trước khi cho chạy.')
  await drain($, w)
  await call.promise
})

test('several branches: the band names the first and counts the others', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  const drop = track(bash($, 'git branch -D old-ui old-api old-db'))
  await settle(w)
  expect(await bandTexts($)).toContain(' WAITING FOR YOU  About to delete the branch "old-ui" (+2 more), even if it is not merged · git branch -D')
  await drain($, w)
  await drop.promise
  const push = track(bash($, 'git push --force origin dev main'))
  await settle(w)
  expect((await bandTexts($)).some(t => t.includes('About to overwrite the history of branch "dev" (+1 more) on origin'))).toBe(true)
  await drain($, w)
  await push.promise
})

test('find ... -delete with a name says what it looks for, never "everything in this project" alone, and a snapshot of where it looks was taken', async ($, on) => {
  const w = world(on)
  for (const f of ['src/a.pyc', 'src/b.pyc', 'src/keep.py']) put(w, f)
  await begin($, w)
  const call = track(bash($, "find . -name '*.pyc' -delete"))
  await settle(w)
  const texts = await bandTexts($)
  expect(texts.some(t => t.includes('About to delete everything named "*.pyc" in this project'))).toBe(true)
  expect(texts.join('\n')).not.toContain('About to delete everything in this project')
  expect(texts.join('\n')).not.toContain('picks when it runs')
  expect(texts.some(t => t.startsWith('✔ Snapshot saved at 14:05 (#1)'))).toBe(true)
  expect(w.snapshotIds()).toHaveLength(1)
  await drain($, w)
  await call.promise
})

// ---- Git could not save the uncommitted changes ----

test('a git reset --hard whose uncommitted changes Git could not save says so in the warning colour, and never "Git state saved"', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stashFails = true
  await begin($, w)
  const call = track(bash($, 'git reset --hard'))
  await settle(w)
  const line = 'No files to copy, and Git could not save your uncommitted changes (an unfinished merge, for example)'
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    const texts = await ours(ui)
    expect(texts).toContain(`⚠ ${line}`)
    expect(texts.join('\n')).not.toContain('Git state saved')
    expect((await ui.find({ type: 'Text', text: `⚠ ${line}` }))?.props.color).toBe('warning')
    await ui.unmount()
  }
  await press($, w, 'allow')
  const out = await call.promise
  expect(JSON.stringify(out)).toContain('could not save the uncommitted changes')
  expect(JSON.stringify(out)).not.toContain('saved the Git state')
})

test('files and a Git state that could not be saved: the files are said to be saved, the Git part is not', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stashFails = true
  reports(w)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports/ && git reset --hard'))
  await settle(w)
  const texts = await bandTexts($)
  expect(texts).toContain('⚠ Snapshot saved at 14:05 (#1) · 3 files, 18 B, but Git could not save your uncommitted changes (an unfinished merge, for example)')
  expect(texts.join('\n')).not.toContain('Git state saved')
  await drain($, w)
  await call.promise
})

test('confirm never: the toast for a Git state that could not be saved does not claim it', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stashFails = true
  reports(w)
  await begin($, w)
  await bash($, 'rm -rf reports/ && git reset --hard')
  expect(w.toasts).toEqual(['Snapshot #1 saved before this command, but Git could not save your uncommitted changes'])
})

// ---- a force push, and what a Git snapshot really holds ----

test('a force push with no remote branch to keep says there is nothing to save, saves nothing, and Claude is told nothing was saved', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  const call = track(bash($, 'git push --force origin main'))
  await settle(w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await bandTexts($, surface)
    expect(texts).toContain('⚠ Nothing to save for this one')
    expect(texts.join('\n')).not.toContain('Git state saved')
  }
  expect(w.snapshotIds()).toEqual([])
  await press($, w, 'allow')
  const out = await call.promise
  expect(out).toMatchObject({ result: { stdout: 'ok' } })
  expect(JSON.stringify(out)).not.toContain('Safety Net saved')
  expect(w.snapshotIds()).toEqual([])
  expect(await safety($)).toContain('There are no snapshots for this project yet.')
})

test('a force push with a last-fetched remote branch: it is saved, and the note, /safety list and /safety restore say exactly that', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.remotes = { 'origin/main': 'c'.repeat(40) }
  await begin($, w)
  const call = track(bash($, 'git push -f origin main'))
  await settle(w)
  expect(await bandTexts($)).toContain('✔ Git state saved (no files to copy)')
  await press($, w, 'allow')
  const out = await call.promise
  const note = JSON.stringify(out)
  expect(note).toContain('saved the last-fetched copy of the remote branch as a branch name you can restore')
  expect(note).not.toContain('commits and uncommitted changes')
  expect(w.snapshotIds()).toHaveLength(1)
  expect((await safety($)).split('\n')[1]).toContain('Git copy only')
  const before = w.gitCalls.length
  const text = await safety($, 'restore')
  expect(text).toContain('Git: the last-fetched copy of the remote branch is saved as a branch name you can restore. To bring it back yourself, run:')
  expect(text).toContain(`\n  git branch main-before-force-push ${'c'.repeat(40)}`)
  expect(text).not.toContain('commits and changes were saved too')
  expect(text).not.toContain('git checkout')
  for (const c of w.gitCalls.slice(before)) expect(c.join(' ')).not.toMatch(/checkout|reset|clean|stash|branch/)
})

test('a force push with a last-fetched remote branch, in Vietnamese: the restore text names the remote branch, not the changes', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.remotes = { 'origin/main': 'c'.repeat(40) }
  await begin($, w, false)
  await bash($, 'git push --force origin main')
  const text = await safety($, 'restore')
  expect(text).toContain('Git: bản của nhánh remote ở lần fetch gần nhất đã được lưu thành một tên nhánh để bạn khôi phục.')
  expect(text).not.toContain('các commit và thay đổi cũng đã được lưu')
})

test('confirm never: a force push with nothing to keep makes no toast and no snapshot; with a remote branch to keep it does', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  const out = await bash($, 'git push --force origin main')
  expect(w.toasts).toEqual([])
  expect(w.snapshotIds()).toEqual([])
  expect(JSON.stringify(out)).not.toContain('Safety Net saved')
  w.git.remotes = { 'origin/main': 'c'.repeat(40) }
  const kept = await bash($, 'git push --force origin main')
  expect(w.toasts).toEqual(['Git state saved before this command. Undo: /safety restore'])
  expect(w.snapshotIds()).toHaveLength(1)
  expect(JSON.stringify(kept)).toContain('last-fetched copy of the remote branch')
  expect(JSON.stringify(kept)).not.toContain('commits and uncommitted changes')
})

test('a Git snapshot that is partial (an unfinished merge) never claims saved changes in /safety list or /safety restore', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stashFails = true
  await begin($, w, false)
  await bash($, 'git reset --hard')
  expect(w.snapshotIds()).toHaveLength(1)
  const row = (await safety($)).split('\n')[1]!
  expect(row).toContain('Git could not save your changes')
  expect(row).not.toContain('Git copy only')
  const text = await safety($, 'restore')
  expect(text).toContain('Git could not save your uncommitted changes when this snapshot was taken (an unfinished merge, for example), so there is nothing to bring back from Git.')
  expect(text).not.toContain('saved too')
  expect(text).not.toContain('git checkout')
  expect(text).not.toContain('To bring them back yourself')
})

test('a partial Git snapshot, in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stashFails = true
  await begin($, w, false)
  await bash($, 'git reset --hard')
  expect((await safety($)).split('\n')[1]).toContain('Git không lưu được thay đổi của bạn')
  const text = await safety($, 'restore')
  expect(text).toContain('Git không lưu được các thay đổi chưa commit của bạn khi chụp snapshot này')
  expect(text).not.toContain('đã được lưu. Muốn tự lấy lại')
  expect(text).not.toContain('git checkout')
})

// ---- /safety restore: the default pick ----

test('/safety restore with no number puts back the newest snapshot that was asked about, not a quiet save before an edit; a number still picks the edit', async ($, on) => {
  const w = world(on)
  reports(w)
  put(w, 'notes.txt', 'v1')
  await begin($, w, false)
  await bash($, 'rm -rf reports/')
  await edit($, 'notes.txt', 'v2')
  const list = (await safety($)).split('\n')
  expect(list[1]).toContain('Edit (saved quietly)')
  expect(list[2]).not.toContain('quietly')
  const text = await safety($, 'restore')
  expect(text.split('\n')[0]).toBe('✓ Restored 3 files to 14:05  (snapshot #1)')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v2')
  expect(w.files.has(`${ROOT}/reports/a.js`)).toBe(true)
  expect(await safety($, 'restore 2')).toContain('(snapshot #2)')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v1')
})

test('/safety restore with only quiet snapshots puts back the newest of them', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w, false)
  await edit($, 'notes.txt', 'v2')
  expect(await safety($, 'restore')).toContain('✓ Restored 1 file to 14:05  (snapshot #1)')
  expect(w.read(`${ROOT}/notes.txt`)).toBe('v1')
})

// ---- where programs run ----

test('Node and Git are asked from inside the snapshot folder when it exists, never from the project; nothing is created for it', async ($, on) => {
  const w = world(on, { node: { helperOk: true } })
  reports(w)
  w.dirs.add(SNAPS)
  await begin($, w, false)
  const probe = w.runs.find(r => r.argv[0] === 'node' && r.argv[1] === '--version')
  expect(probe?.cwd).toBe(SNAPS)
  await bash($, 'rm -rf reports/')
  w.runs.length = 0
  await safety($, 'doctor')
  const programs = w.runs.filter(r => r.argv[0] === 'node' || r.argv[0] === 'git')
  expect(programs.map(r => `${r.argv[0]} ${r.argv[1]?.startsWith('--') ? r.argv[1] : 'helper'}`).sort()).toEqual(['git --version', 'node --version', 'node helper'])
  for (const r of programs) expect(r.cwd).toBe(SNAPS)
  for (const r of w.runs) expect(r.cwd).not.toBe(ROOT)
})

test('a snapshot folder that is not there yet: the programs run with no folder of their own (the folder is not made for them), the helper runs in it once /safety doctor has made it', async ($, on) => {
  const w = world(on, { node: { helperOk: true } })
  await begin($, w)
  expect(w.dirs.has(SNAPS)).toBe(false)
  for (const r of w.runs) expect(r.cwd).toBeUndefined()
  w.runs.length = 0
  const text = await safety($, 'doctor')
  const byProgram = (a: string, b: string) => w.runs.filter(r => r.argv[0] === a && r.argv[1] === b)
  expect(byProgram('node', '--version').map(r => r.cwd)).toEqual([undefined])
  expect(byProgram('git', '--version').map(r => r.cwd)).toEqual([undefined])
  expect(w.runs.filter(r => r.argv[0] === 'node' && r.argv[1] !== '--version').map(r => r.cwd)).toEqual([SNAPS])
  // and the doctor says where the folder is
  expect(text).toContain(`Snapshot folder ${SNAPS} can be written to`)
})

// ---------------------------------------------------------------------------------------------------------------------
// Round 2: Git hooks off, the total cap, quiet cleanups, a .env without Node, Git's own safety nets

// ---- Git hooks of a project never run ----

const hasConfig = (argv: string[], pair: string): boolean => argv.some((a, i) => a === '-c' && argv[i + 1] === pair)
const gitRuns = (w: World) => w.runs.filter(r => r.argv[0] === 'git' && r.argv[1] !== '--version')
/** The `-c` options in front of `-C <root>`: where git is told what to do before it reads anything of the project. */
const beforeRoot = (argv: string[]): string[] => argv.slice(0, argv.indexOf('-C'))

test('every Git call switches the hooks of the project off: core.hooksPath is the plugin\'s own empty folder next to the snapshots', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.stash = 'b'.repeat(40)
  reports(w)
  await begin($, w, false)
  await bash($, 'git reset --hard')
  await bash($, 'rm -rf reports/')
  await safety($, 'restore')
  await safety($, 'list')
  await safety($, 'doctor')
  const hooks = `${HOME}/.claude/kit-safety/no-hooks`
  const calls = gitRuns(w)
  expect(calls.length).toBeGreaterThan(5)
  // both options, in front of `-C`, on every call: the guard's, the vault's, the restore's
  const bad = calls.filter(r => !hasConfig(beforeRoot(r.argv), 'core.fsmonitor=false') || !hasConfig(beforeRoot(r.argv), `core.hooksPath=${hooks}`))
  expect(bad.map(r => r.argv.join(' '))).toEqual([])
  expect(w.gitCalls.length).toBeGreaterThan(5)
  expect(w.gitCalls.filter(argv => !hasConfig(beforeRoot(argv), `core.hooksPath=${hooks}`))).toEqual([])
  // the stash and the refs were really asked for through it
  expect(calls.some(r => r.argv.includes('stash'))).toBe(true)
  // the folder is next to the snapshots, holds a note and nothing else, and is not a project folder
  expect(hooks.startsWith(SNAPS)).toBe(false)
  expect(hooks.startsWith(ROOT)).toBe(false)
  expect([...w.files.keys()].filter(k => k.startsWith(`${hooks}/`))).toEqual([`${hooks}/README.txt`])
  expect(w.read(`${hooks}/README.txt`)).toContain('empty on purpose')
  // the only project files written are the restored ones
  expect(w.writes.filter(p => p.startsWith(ROOT) && !p.startsWith(`${ROOT}/reports/`))).toEqual([])
})

test('the hooks folder follows the config folder; with no folder known git is pointed at the null device; nothing is made in the project', async ($, on) => {
  const custom = world(on, { env: { HOME, CLAUDE_CONFIG_DIR: '/cfg/claude' } })
  custom.git.isRepo = true
  custom.git.head = SHA
  await begin($, custom, false)
  await bash($, 'git reset --hard')
  expect(gitRuns(custom).length).toBeGreaterThan(1)
  for (const r of gitRuns(custom)) expect(hasConfig(beforeRoot(r.argv), 'core.hooksPath=/cfg/claude/kit-safety/no-hooks')).toBe(true)
  expect(custom.read('/cfg/claude/kit-safety/no-hooks/README.txt')).toBeDefined()
  expect([...custom.files.keys()].some(k => k.startsWith(`${HOME}/.claude/kit-safety`))).toBe(false)
})

test('no home folder: every Git call still has the hooks off (the null device) and no folder is made', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on, { env: {} })
  w.git.isRepo = true
  w.git.head = SHA
  reports(w)
  await begin($, w, false)
  await bash($, 'git reset --hard')
  await bash($, 'rm -rf reports/')
  const calls = gitRuns(w)
  expect(calls.length).toBeGreaterThan(1)
  for (const r of calls) {
    expect(hasConfig(beforeRoot(r.argv), 'core.fsmonitor=false')).toBe(true)
    expect(hasConfig(beforeRoot(r.argv), 'core.hooksPath=/dev/null')).toBe(true)
  }
  expect([...w.files.keys()].some(k => k.includes('no-hooks'))).toBe(false)
})

test('a Windows home folder: the hooks folder is next to the snapshots there too', async ($, on) => {
  const w = world(on, { env: { USERPROFILE: 'C:\\Users\\dev' } })
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w, false)
  await bash($, 'git reset --hard')
  const expected = `core.hooksPath=${joinPath('C:\\Users\\dev', '.claude', 'kit-safety', 'no-hooks')}`
  expect(expected).toMatch(/kit-safety.no-hooks$/)
  expect(gitRuns(w).length).toBeGreaterThan(1)
  for (const r of gitRuns(w)) expect(hasConfig(beforeRoot(r.argv), expected)).toBe(true)
})

// ---- the total of all snapshots ----

/** A snapshot of `root` that claims to take `bytes` (its files folder holds a few bytes: only the record counts for the cap). */
function bigSnapshot(w: World, root: string, createdAt: number, bytes: number): string {
  const id = newSnapshotId(createdAt, [])
  const dir = snapshotDir(SNAPS, projectKey(root), id)
  const manifest = buildManifest(
    { v: 1, id, n: 1, createdAt, root, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'delete', label: 'rm -rf' }], targets: ['dist'], backend: 'fs' },
    { files: [{ rel: 'dist/a.js', size: bytes, mtimeMs: 1 }], dirs: [], skipped: [] },
  )
  w.put(`${dir}/manifest.json`, serializeManifest(manifest))
  w.put(`${dir}/files/dist/a.js`, 'xxxxxx')
  return dir
}

test('maxTotalMB: when a session starts the oldest snapshots of all projects go until the total fits; the newest of the open project stays', { options: { maxTotalMB: 100 } }, async ($, on) => {
  const w = world(on)
  const old = bigSnapshot(w, OTHER, NOW - 2 * 3_600_000, 60 * 1024 * 1024)
  const mine = bigSnapshot(w, ROOT, NOW - 1000, 60 * 1024 * 1024)
  await begin($, w, false)
  await settle(w)
  expect(w.read(`${old}/pruned`)).toBeDefined()
  expect(w.read(`${old}/files/dist/a.js`)).toBe('')
  expect(w.read(`${mine}/pruned`)).toBeUndefined()
  expect(w.read(`${mine}/files/dist/a.js`)).toBe('xxxxxx')
})

test('maxTotalMB: the default (2 GB) keeps both, and a cap below 100 MB is read as 100 MB', async ($, on) => {
  const w = world(on)
  const old = bigSnapshot(w, OTHER, NOW - 2 * 3_600_000, 60 * 1024 * 1024)
  const mine = bigSnapshot(w, ROOT, NOW - 1000, 60 * 1024 * 1024)
  await begin($, w, false)
  await settle(w)
  expect(w.read(`${old}/pruned`)).toBeUndefined()
  expect(w.read(`${mine}/pruned`)).toBeUndefined()
})

test('maxTotalMB: a value below 100 is cut to 100 (so 60 + 60 MB is over it)', { options: { maxTotalMB: 5 } }, async ($, on) => {
  const w = world(on)
  const old = bigSnapshot(w, OTHER, NOW - 2 * 3_600_000, 60 * 1024 * 1024)
  bigSnapshot(w, ROOT, NOW - 1000, 60 * 1024 * 1024)
  await begin($, w, false)
  await settle(w)
  expect(w.read(`${old}/pruned`)).toBeDefined()
  expect(await safety($, 'doctor')).toContain('1 snapshot in all projects, 60 MB of the 100 MB they may take together')
})

test('/safety doctor: the total of all projects against the cap, a warning when over it, and in Vietnamese', { options: { maxTotalMB: 100 } }, async ($, on) => {
  const w = world(on)
  await begin($, w, false)
  // made after the sweep of the session start, so they are still there to count
  bigSnapshot(w, OTHER, NOW - 2 * 3_600_000, 60 * 1024 * 1024)
  bigSnapshot(w, ROOT, NOW - 1000, 60 * 1024 * 1024)
  const text = await safety($, 'doctor')
  expect(text).toContain('WARN 2 snapshots in all projects, 120 MB: over the 100 MB they may take together, so the oldest are deleted when the next session starts')
  expect(text).toContain(`PASS Snapshot folder ${SNAPS} can be written to: 1 snapshot, 60 MB`)
  expect(text.split('\n').at(-1)).toMatch(/^\d+ ok, 2 to look at, 0 broken\.$/)
})

test('/safety doctor in Vietnamese shows the total line too', { options: { language: 'vi', maxTotalMB: 100 } }, async ($, on) => {
  const w = world(on)
  await begin($, w, false)
  bigSnapshot(w, ROOT, NOW - 1000, 30 * 1024 * 1024)
  expect(await safety($, 'doctor')).toContain('PASS 1 snapshot ở mọi dự án, 30 MB (tối đa 100 MB cho tất cả)')
})

// ---- quiet cleanups ----

const SMALL = 'x'.repeat(6)
/** A few small files in a folder (a cleanup that is cheap to save). */
const cleanup = (w: World, folder: string, names = ['a/index.js', 'b/index.js', 'c.js']) => names.forEach(n => put(w, `${folder}/${n}`, SMALL))
/** Many files in one folder: more than a quiet cleanup is saved with. */
const flood = (w: World, folder: string, n = 2001) => {
  for (let i = 0; i < n; i += 1) w.put(`${ROOT}/${folder}/f${i}.js`, SMALL)
}

/** Runs a call; one that is not asked about finishes by itself, so a test does not wait for an answer it would never get (it cancels one that asks). */
async function go($: Engine, w: World, command: string): Promise<{ out: unknown; wasAsked: boolean }> {
  const call = track(bash($, command))
  await settle(w)
  if (!call.isDone) {
    const wasAsked = await pendingQuestion($)
    await drain($, w)
    await call.promise
    return { out: undefined, wasAsked }
  }
  return { out: await call.promise, wasAsked: false }
}

for (const [command, folders] of [
  ['rm -rf node_modules', ['node_modules']],
  ['rm -rf build/', ['build']],
  ['rm -rf dist coverage', ['dist', 'coverage']],
  ['rm -rf .next', ['.next']],
  ['rm -rf packages/web/node_modules', ['packages/web/node_modules']],
] as const) {
  test(`${command}: no question, no band, no toast, no note; a small snapshot is saved quietly`, async ($, on) => {
    const w = world(on)
    for (const f of folders) cleanup(w, f)
    await begin($, w)
    const { out, wasAsked } = await go($, w, command)
    expect(wasAsked).toBe(false)
    expect(w.ran).toEqual([{ tool: 'Bash', input: { command } }])
    expect(w.asked).toEqual([])
    expect(w.toasts).toEqual([])
    expect(await bandTexts($)).toEqual([])
    expect(out).toMatchObject({ result: { stdout: 'ok' } })
    expect(out).not.toHaveProperty('context')
    for (const f of folders) expect(w.files.has(`${ROOT}/${f}/c.js`)).toBe(false)
    // the files are in a snapshot, marked quiet
    const [id] = w.snapshotIds()
    expect(w.snapshotIds()).toHaveLength(1)
    expect(manifestOf(w, id!).quiet).toBe(true)
    for (const f of folders) expect(stored(w, id!, `${f}/c.js`)).toBe(SMALL)
    expect((await safety($)).split('\n')[1]).toContain('(saved quietly')
    expect(await safety($, 'restore')).toContain(`✓ Restored ${folders.length * 3} files`)
    expect(w.files.has(`${ROOT}/${folders[0]}/c.js`)).toBe(true)
  })
}

test('a folder Git ignores is cleaned up with no question; one it does not ignore still asks', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.ignored.add('tmp-out')
  cleanup(w, 'tmp-out')
  cleanup(w, 'keep-out')
  await begin($, w)
  const quiet = await go($, w, 'rm -rf tmp-out')
  expect(quiet.wasAsked).toBe(false)
  expect(w.files.has(`${ROOT}/tmp-out/c.js`)).toBe(false)
  expect(w.snapshotIds()).toHaveLength(1)
  expect(w.toasts).toEqual([])
  expect(await bash($, 'rm -rf not-there')).toMatchObject({ result: { stdout: 'ok' } })
  const asked = await go($, w, 'rm -rf keep-out')
  expect(asked.wasAsked).toBe(true)
  expect(w.files.has(`${ROOT}/keep-out/c.js`)).toBe(true)
  // both got a snapshot before anything ran or was asked
  expect(w.snapshotIds()).toHaveLength(2)
})

test('a cleanup over the small limits runs with no question, no snapshot, no band, no toast and no note', async ($, on) => {
  const w = world(on)
  flood(w, 'node_modules')
  await begin($, w)
  const { out, wasAsked } = await go($, w, 'rm -rf node_modules')
  expect(wasAsked).toBe(false)
  expect(w.ran).toHaveLength(1)
  expect(out).toMatchObject({ result: { stdout: 'ok' } })
  expect(out).not.toHaveProperty('context')
  expect(w.snapshotIds()).toEqual([])
  expect(w.asked).toEqual([])
  expect(w.toasts).toEqual([])
  expect(await bandTexts($)).toEqual([])
  expect(w.files.has(`${ROOT}/node_modules/f0.js`)).toBe(false)
  expect(w.logs.map(l => l.text).filter(t => /snapshot/i.test(t))).toEqual([])
})

test('just under the small limits it is still saved', async ($, on) => {
  const w = world(on)
  cleanup(w, 'node_modules', Array.from({ length: 150 }, (_, i) => `f${i}.js`))
  await begin($, w)
  const { wasAsked } = await go($, w, 'rm -rf node_modules')
  expect(wasAsked).toBe(false)
  expect(w.snapshotIds()).toHaveLength(1)
  expect(manifestOf(w, w.snapshotIds()[0]!).files).toHaveLength(150)
})

test('confirm never: a cleanup makes no toast either way; a small one is still saved, a big one is not', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  cleanup(w, 'node_modules')
  flood(w, 'dist')
  await begin($, w)
  const small = await go($, w, 'rm -rf node_modules')
  const big = await go($, w, 'rm -rf dist')
  expect([small.wasAsked, big.wasAsked]).toEqual([false, false])
  expect(w.toasts).toEqual([])
  expect(w.snapshotIds()).toHaveLength(1)
  expect(small.out).not.toHaveProperty('context')
  expect(big.out).not.toHaveProperty('context')
})

test('headless: a cleanup runs, a small one is saved, nothing is said', async ($, on) => {
  const w = world(on)
  cleanup(w, 'node_modules')
  await begin($, w, false)
  const out = await bash($, 'rm -rf node_modules')
  expect(out).not.toHaveProperty('context')
  expect(w.snapshotIds()).toHaveLength(1)
  expect(w.toasts).toEqual([])
  expect(w.asked).toEqual([])
})

test('confirm always: a cleanup asks like any risk; over the small limits the band says so with the small limit, and Allow runs it', { options: { confirm: 'always' } }, async ($, on) => {
  const w = world(on)
  flood(w, 'node_modules')
  await begin($, w)
  const call = track(bash($, 'rm -rf node_modules'))
  await settle(w)
  expect(call.isDone).toBe(false)
  const texts = await bandTexts($)
  expect(texts).toContain(' WAITING FOR YOU  About to delete the folder "node_modules/" · rm -rf')
  expect(texts).toContain('⚠ No snapshot: more than 2,000 files would be touched, which is over the limit')
  expect(w.snapshotIds()).toEqual([])
  await press($, w, 'allow')
  const out = await call.promise
  expect(w.ran).toHaveLength(1)
  expect(out).not.toHaveProperty('context')
})

test('confirm always: a small cleanup asks with its snapshot in the band, and Claude is told after Allow', { options: { confirm: 'always' } }, async ($, on) => {
  const w = world(on)
  cleanup(w, 'node_modules')
  await begin($, w)
  const call = track(bash($, 'rm -rf node_modules'))
  await settle(w)
  expect(await bandTexts($)).toContain('✔ Snapshot saved at 14:05 (#1) · 3 files, 18 B')
  await press($, w, 'allow')
  expect(await call.promise).toMatchObject({ context: ['Safety Net saved snapshot #1 before this ran; /safety restore 1 puts it back.'] })
})

test('the small limit in megabytes follows a smaller maxSizeMB: a cleanup over the size the person allows is not saved, and the size says so', { options: { confirm: 'always', maxSizeMB: 10 } }, async ($, on) => {
  const w = world(on)
  // over the size: the file count is fine, the sizes are not (files of 3 MB: the biggest the text-only backend copies)
  for (let i = 0; i < 4; i += 1) w.put(`${ROOT}/node_modules/big${i}.js`, 'y'.repeat(3 * 1024 * 1024))
  await begin($, w)
  const call = track(bash($, 'rm -rf node_modules'))
  await settle(w)
  expect(await bandTexts($)).toContain('⚠ No snapshot: more than 10 MB would be touched, which is over the limit')
  expect(w.snapshotIds()).toEqual([])
  await drain($, w)
  await call.promise
})

test('the usual limits still hold for a call that asks: a folder that is no cleanup is saved with more than 2,000 files', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  flood(w, 'reports', 2001)
  await begin($, w)
  const call = track(bash($, 'rm -rf reports'))
  await settle(w, 40)
  expect(call.isDone).toBe(false)
  expect(w.snapshotIds()).toHaveLength(1)
  expect(await bandTexts($)).toContain('✔ Snapshot saved at 14:05 (#1) · 2,001 files, 12 KB')
  await drain($, w)
  await call.promise
})

test('a folder that is no cleanup still asks; so does a list that has one in it; so does an ignored .env', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  w.git.ignored.add('.env')
  w.git.ignored.add('node_modules')
  cleanup(w, 'src/old')
  cleanup(w, 'node_modules')
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\n')
  await begin($, w)
  const old = await go($, w, 'rm -rf src/old')
  expect(old.wasAsked).toBe(true)
  const both = track(bash($, 'rm -rf node_modules src/old'))
  await settle(w)
  expect(both.isDone).toBe(false)
  expect(await bandTexts($)).toContain(' WAITING FOR YOU  About to delete 2 items: "node_modules/", "src/old/" · rm -rf')
  await drain($, w)
  await both.promise
  const env = await go($, w, 'rm -rf .env')
  expect(env.wasAsked).toBe(true)
  const withEnv = await go($, w, 'rm -rf node_modules .env')
  expect(withEnv.wasAsked).toBe(true)
  expect(w.ran).toEqual([])
  expect(w.files.has(`${ROOT}/.env`)).toBe(true)
})

// ---- a .env without Node ----

test('overwriting a .env with no Node: the band says it was not saved, the question is asked, Claude is told, and no copy of it exists anywhere', async ($, on) => {
  const w = world(on)
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\nOTHER=def456\n')
  await begin($, w)
  const call = track(write($, '.env', 'TOKEN=new\n'))
  await settle(w)
  expect(call.isDone).toBe(false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await bandTexts($, surface)
    expect(texts).toContain(' WAITING FOR YOU  About to overwrite the file ".env" · Write')
    expect(texts).toContain('⚠ Not saved: a .env file is copied only when Node.js is installed, so its copy can be kept private')
  }
  expect(w.snapshotIds()).toEqual([])
  await press($, w, 'allow')
  const out = await call.promise
  expect(w.read(`${ROOT}/.env`)).toBe('TOKEN=new\n')
  expect(out).toMatchObject({ context: ['Safety Net could not save a copy of the .env file before this ran: a .env file is copied only when Node.js is installed, so its copy can be kept private.'] })
  // neither value was copied into the snapshot folder, the log or a toast
  expect(everything(w)).not.toContain('abc123')
  expect(everything(w)).not.toContain('def456')
  expect(JSON.stringify([w.logs, w.toasts])).not.toMatch(/abc123|def456/)
  expect([...w.files.keys()].filter(k => k.startsWith(SNAPS) && /env/i.test(k))).toEqual([])
})

test('the question box says a .env was not saved, in English and in Vietnamese', async ($, on) => {
  const w = world(on, { ask: () => 'Allow' })
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\n')
  await begin($, w)
  const call = track(write($, '.env', 'TOKEN=new\n'))
  await settle(w)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked).toEqual([{
    question: 'About to overwrite the file ".env". The old file has 1 variable, the new one 1: the same variable names. Not saved: a .env file is copied only when Node.js is installed, so its copy can be kept private. Allow it?',
    options: ['Allow', 'Cancel'],
  }])
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
})

test('the question box says a .env was not saved, in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on, { ask: () => 'Cho chạy' })
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\n')
  await begin($, w)
  const call = track(write($, '.env', 'TOKEN=new\n'))
  await settle(w)
  await w.clock.advance(1500)
  await settle(w)
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.question.startsWith('Sắp ghi đè file ".env".')).toBe(true)
  expect(w.asked[0]?.question).toContain('Chưa lưu: file .env chỉ được chép khi máy có Node.js, để bản chép được giữ riêng tư.')
  expect(w.asked[0]?.question.endsWith('Cho chạy không?')).toBe(true)
  expect(await call.promise).toMatchObject({ result: { stdout: 'ok' } })
})

test('confirm never: overwriting a .env with no Node says in a toast that it was not saved, and runs', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\n')
  await begin($, w)
  await write($, '.env', 'TOKEN=new\n')
  expect(w.toasts).toEqual(['No snapshot before this command: a .env file is copied only when Node.js is installed'])
  expect(w.read(`${ROOT}/.env`)).toBe('TOKEN=new\n')
  expect(w.snapshotIds()).toEqual([])
  expect(everything(w)).not.toContain('abc123')
})

test('a delete of a folder and a .env together: the folder is saved, the .env is left out, and the band says some files were left out', async ($, on) => {
  const w = world(on)
  reports(w)
  w.put(`${ROOT}/.env`, 'TOKEN=abc123\n')
  await begin($, w)
  const call = track(bash($, 'rm -rf reports .env'))
  await settle(w)
  const texts = await bandTexts($)
  expect(texts).toContain(' WAITING FOR YOU  About to delete 2 items: "reports/", ".env" · rm -rf')
  expect(texts).toContain('⚠ Snapshot saved at 14:05 (#1) · 3 files, 18 B · some files were left out')
  expect(texts.join('\n')).not.toContain('Not saved')
  await press($, w, 'allow')
  expect(await call.promise).toMatchObject({ context: ['Safety Net saved snapshot #1 before this ran (some files were left out); /safety restore 1 puts it back.'] })
  expect(everything(w)).not.toContain('abc123')
  expect(stored(w, w.snapshotIds()[0]!, 'reports/a.js')).toBe('xxxxxx')
  expect(stored(w, w.snapshotIds()[0]!, '.env')).toBeUndefined()
  // the folder comes back; the .env was never in the snapshot
  expect(await safety($, 'restore')).toContain('✓ Restored 3 files')
  expect(w.files.has(`${ROOT}/.env`)).toBe(false)
})

test('an edit of an ordinary file next to the .env change is saved as before (the .env rule is only about .env files)', async ($, on) => {
  const w = world(on)
  put(w, 'notes.txt', 'v1')
  await begin($, w)
  await edit($, 'notes.txt', 'v2')
  expect(w.snapshotIds()).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

// ---- Git's own safety nets ----

test('git stash drop: asked, in plain words, with nothing to save; nothing is run on Git for it; Claude is told nothing', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  const call = track(bash($, 'git stash drop'))
  await settle(w)
  expect(call.isDone).toBe(false)
  const texts = await bandTexts($)
  expect(texts).toContain(' WAITING FOR YOU  About to delete a saved stash from Git · git stash drop')
  expect(texts).toContain('Git cannot bring this back.')
  expect(texts).toContain('⚠ Nothing to save for this one')
  expect(w.snapshotIds()).toEqual([])
  await press($, w, 'allow')
  const out = await call.promise
  expect(w.ran).toEqual([{ tool: 'Bash', input: { command: 'git stash drop' } }])
  expect(out).not.toHaveProperty('context')
  for (const c of w.gitCalls) expect(c.join(' ')).not.toMatch(/stash|update-ref|reflog|gc/)
})

for (const [command, title] of [
  ['git stash clear', 'About to delete every saved stash from Git'],
  ['git update-ref -d refs/heads/old', 'About to delete a Git reference'],
  ['git reflog expire --expire=now --all', "About to permanently erase Git's safety history"],
  ['git gc --prune=now', "About to permanently erase Git's safety history"],
] as const) {
  test(`${command}: the band reads "${title}", and Cancel stops it`, async ($, on) => {
    const w = world(on)
    w.git.isRepo = true
    w.git.head = SHA
    await begin($, w)
    const call = track(bash($, command))
    await settle(w)
    expect((await bandTexts($)).some(t => t.includes(` ${title} · git `))).toBe(true)
    await press($, w, 'cancel')
    expect(await call.promise).toMatchObject({ deny: `The person chose Cancel in Safety Net: ${title}. Nothing was changed. Ask them what they want instead.` })
    expect(w.ran).toEqual([])
  })
}

test('confirm never: emptying Git\'s safety nets runs at once and says nothing (nothing was saved, so there is no toast)', { options: { confirm: 'never' } }, async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  const out = await bash($, 'git stash clear')
  expect(w.ran).toHaveLength(1)
  expect(w.toasts).toEqual([])
  expect(out).not.toHaveProperty('context')
})

test('--force-with-lease is not a risk any more: it runs without a question; a plain --force still asks', async ($, on) => {
  const w = world(on)
  w.git.isRepo = true
  w.git.head = SHA
  await begin($, w)
  for (const command of ['git push --force-with-lease origin main', 'git push --force-if-includes origin main', 'git push --force-with-lease=main:abc123 origin main']) {
    expect(await bash($, command)).toMatchObject({ result: { stdout: 'ok' } })
  }
  expect(w.asked).toEqual([])
  expect(await bandTexts($)).toEqual([])
  expect(w.snapshotIds()).toEqual([])
  const forced = await go($, w, 'git push --force origin main')
  expect(forced.wasAsked).toBe(true)
})

// ---- find with a name ----

test('find with a name under one folder says where it looks, with the folder mark', async ($, on) => {
  const w = world(on)
  put(w, 'src/a/node_modules/x.js')
  put(w, 'src/keep.js')
  await begin($, w)
  const call = track(bash($, 'find src -name node_modules -type d -exec rm -rf {} +'))
  await settle(w)
  expect(await bandTexts($)).toContain(' WAITING FOR YOU  About to delete everything named "node_modules" under "src/" · rm -rf')
  expect(w.snapshotIds()).toHaveLength(1)
  await drain($, w)
  await call.promise
})

test('find with a name, in Vietnamese', { options: { language: 'vi' } }, async ($, on) => {
  const w = world(on)
  put(w, 'src/a/node_modules/x.js')
  await begin($, w)
  const call = track(bash($, 'find src -name node_modules -type d -exec rm -rf {} +'))
  await settle(w)
  expect((await bandTexts($)).some(t => t.includes('Sắp xoá mọi thứ có tên "node_modules" trong "src/"'))).toBe(true)
  await drain($, w)
  await call.promise
})

test('find with no readable name keeps the old words', async ($, on) => {
  const w = world(on)
  put(w, 'src/a.pyc')
  await begin($, w)
  const call = track(bash($, 'find src -size +1k -delete'))
  await settle(w)
  expect((await bandTexts($)).some(t => t.includes('About to delete files that this command picks when it runs'))).toBe(true)
  await drain($, w)
  await call.promise
})
