import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { settingsFrom } from '../hooks/register'
import { STRINGS, changeText, languageFromSetting, languageOption } from '../hooks/i18n'
import {
  HUB_STALE_MS, accountName, agoText, changes, fit, fromHub, ghSlug, inScope, parseCommand, safeUrl, snapshot, staleNote, stateWord, summary, table, waiterNote,
} from '../hooks/status'
import type { HubRow } from '../hooks/status'

const NOW_MS = 1_794_210_000_000
const row = (over: Partial<HubRow> = {}): HubRow => ({
  id: 'a1b2c3d4e5', kind: 'branch', repo: 'octo/demo', branch: 'claude/hud', url: 'https://claude.ai/code/session_A',
  title: 'Fix the HUD', active: true, account: 'work', repoRoot: '/work/demo', createdMs: NOW_MS - 300_000,
  state: 'working', detail: 'just started', ...over,
})
const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} }

type Engine = { argv: string[][]; env: Record<string, string>[]; text: () => string; toasts: string[]; notes: Array<{ text: string; title?: string }> }

/** Stands in for the engine: env, git, node (the hub CLI), the hub's state file, the clock. */
const CLI = '/opt/kit-cloud-pilot/bin/cloud-pilot.mjs'

function engine(on: On, over: { state?: () => string; origin?: string; nodeMissing?: boolean; hubOut?: (argv: string[]) => string; noPilot?: boolean; language?: unknown; languageFails?: boolean } = {}): Engine {
  const seen: Engine = { argv: [], env: [], text: () => '', toasts: [], notes: [] }
  // Claude Code's own settings: only the language matters here.
  on('settings.read', () => {
    if (over.languageFails) throw new Error('settings unreadable')
    return { value: over.language === undefined ? {} : { language: over.language } }
  })
  on('ui.toast', (_, e) => { seen.toasts.push((e as { text: string }).text); return { value: undefined } })
  on('ui.notify', (_, e) => {
    const { text, title } = e as { text: string; title?: string }
    seen.notes.push({ text, title })
    return { value: { isSent: true, channel: 'test' } } as never
  })
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('command.register', () => ({ value: { command: 'cloud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('clock.now', () => ({ value: NOW_MS }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: ({ CLAUDE_CONFIG_DIR: '/home/x/.claude-work', HOME: '/home/x' } as Record<string, string>)[e.name] }))
  // cloud-pilot's data folder: its install.json (written by the kit-cloud-pilot plugin) and the hub's state.json.
  on('fs.exists', (_, e) => ({ value: !(over.noPilot && /install\.json$/.test(String((e as { path: string }).path))) }))
  on('fs.read', (_, e) => {
    if (/install\.json$/.test(String((e as { path: string }).path))) return { value: JSON.stringify({ cli: CLI, version: '1.0.0' }) }
    return { value: over.state ? over.state() : JSON.stringify({ hub: { polledMs: NOW_MS - 60_000 }, rows: [] }) }
  })
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { env?: Record<string, string> } }
    const env = init?.env
    seen.argv.push([...argv])
    seen.env.push({ ...(env ?? {}) })
    if (argv[0] === 'git') {
      if (argv.includes('--show-toplevel')) return ok('/work/demo\n')
      return over.origin === undefined ? ok('git@github.com:octo/demo.git\n') : ok(over.origin, over.origin ? 0 : 2)
    }
    if (over.nodeMissing) throw new Error('spawn node ENOENT')
    return ok(over.hubOut ? over.hubOut(argv) : '{"ok":true,"id":"f00dfeed00"}\n')
  })
  return seen
}

test('fromHub maps hub states, keeps only https links and survives junk', async () => {
  expect(fromHub(row()).state).toBe('working')
  expect(fromHub(row({ state: 'question' })).state).toBe('question')
  expect(fromHub(row({ state: 'abandoned' })).state).toBe('ended')
  expect(fromHub(row({ state: 'weird' })).state).toBe('untracked')
  expect(fromHub(row()).repo).toBe('demo')
  expect(fromHub(row({ url: 'javascript:alert(1)' })).url).toBe('')
  expect(fromHub(row({ url: '', prUrl: 'https://github.com/octo/demo/pull/7' })).url).toBe('https://github.com/octo/demo/pull/7')
  expect(safeUrl('http://insecure.example')).toBe('')
  expect(fromHub({ id: 'x', kind: 'branch' } as HubRow).repo).toBe('?')
  expect(fromHub(row({ createdMs: undefined })).startedEpoch).toBe(0)
})

test('scope: account+repo, repo, all; account names; GitHub remotes', async () => {
  const scope = { account: 'work', repoRoot: '/work/demo', repo: 'demo' }
  expect(inScope(row(), scope)).toBe(true)
  expect(inScope(row({ account: 'home' }), scope)).toBe(false)
  expect(inScope(row({ account: 'home' }), scope, 'repo')).toBe(true)
  expect(inScope(row({ repoRoot: '/work/other', repo: 'octo/other' }), scope, 'repo')).toBe(false)
  expect(inScope(row({ repoRoot: '/work/other', repo: 'octo/other' }), scope, 'all')).toBe(true)
  expect(inScope(row({ repoRoot: 'C:\\Work\\Demo\\' }), { ...scope, repoRoot: 'c:/work/demo' })).toBe(true)
  expect(inScope({ account: 'work' }, { account: 'work', repoRoot: '', repo: '' })).toBe(false)
  // By GitHub slug when known: another clone or a worktree of the same repo still matches, a same-named fork does not.
  const bySlug = { ...scope, repoRoot: '/elsewhere/demo-worktree', slug: 'OCTO/demo' }
  expect(inScope(row(), bySlug)).toBe(true)
  expect(inScope(row({ repo: 'someone/demo' }), bySlug)).toBe(false)
  // Found by watching: its account is unknown, so it shows for every account in the repo.
  expect(inScope(row({ account: 'home', discovered: true }), bySlug)).toBe(true)
  expect(inScope(row({ account: 'home' }), bySlug)).toBe(false)
  expect(accountName('C:\\Users\\x\\.claude-work\\')).toBe('work')
  expect(accountName('/home/x/.claude')).toBe('default')
  expect(accountName('')).toBe('default')
  expect(ghSlug('git@github.com:octo/demo.git')).toBe('octo/demo')
  expect(ghSlug('https://github.com/octo/my.repo')).toBe('octo/my.repo')
  expect(ghSlug('ssh://git@github.com/octo/demo.git/')).toBe('octo/demo')
  expect(ghSlug('https://gitlab.com/octo/demo.git')).toBe('')
})

test('commands parse strictly', async () => {
  expect(parseCommand('')).toEqual({ verb: 'list', all: false })
  expect(parseCommand(' ALL ')).toEqual({ verb: 'list', all: true })
  expect(parseCommand('track https://claude.ai/code/session_X claude/fix-1')).toEqual({ verb: 'track', url: 'https://claude.ai/code/session_X', branch: 'claude/fix-1' })
  expect(parseCommand('track claude/a..b').verb).toBe('help')
  expect(parseCommand('track').verb).toBe('help')
  expect(parseCommand('untrack nope!').verb).toBe('help')
  expect(parseCommand('untrack a1b2c3d4e5')).toEqual({ verb: 'untrack', id: 'a1b2c3d4e5' })
  expect(parseCommand('watch').verb).toBe('watch')
  expect(parseCommand('frobnicate')).toEqual({ verb: 'help', error: 'Unknown: /cloud frobnicate' })
  expect(settingsFrom({ scope: 'bogus', autoWatch: 'yes' } as never)).toEqual({ scope: 'account+repo', autoWatch: true, showBand: true, notifications: true, notifyInSession: true, deleteMergedBranches: false, language: 'auto' })
})

test('summary, table, stale notes and widths', async () => {
  const rows = [fromHub(row()), fromHub(row({ id: 't2', state: 'pr', detail: 'PR #7 · CI failed' })), fromHub(row({ id: 't3', state: 'question' }))]
  expect(summary(rows).map(p => p.text)).toEqual(['1 asking', '1 working', '1 with PR (1 CI failed)'])
  expect(table(rows, NOW_MS / 1000)).toContain('https://claude.ai/code/session_A')
  expect(table([], NOW_MS / 1000)).toContain('No cloud sessions')
  const t = table([fromHub(row({ createdMs: undefined }))], NOW_MS / 1000)
  expect(t).toMatch(/ age\n/)
  expect(t).toMatch(/ \?\n/)
  // Rows fit a 100-column terminal (command output is indented about 6 columns).
  expect(Math.max(...t.split('\n').filter(l => !l.startsWith('  http')).map(l => [...l].length))).toBeLessThanOrEqual(94)
  expect(agoText(NOW_MS / 1000 - 300, NOW_MS / 1000)).toBe('5m')
  expect(agoText(NOW_MS / 1000 - 3 * 86400, NOW_MS / 1000)).toBe('3d')
  expect(staleNote(NOW_MS - 60_000, NOW_MS, true)).toBe('')
  expect(staleNote(NOW_MS - HUB_STALE_MS - 60_000, NOW_MS, true)).toContain('cloud-pilot stopped')
  expect(staleNote(NOW_MS - HUB_STALE_MS - 60_000, NOW_MS, false)).toBe('')
  expect(fit('line\nbreak', 20)).toBe('line break'.padEnd(20))
  expect(fit('🚀🚀🚀🚀', 3)).toBe('🚀🚀…')
})

test('the band shows this account and repo only, and a click expands it', async ($, on) => {
  engine(on, {
    state: () => JSON.stringify({
      hub: { polledMs: NOW_MS - 60_000 },
      rows: [
        row(),
        row({ id: 'b0000000b', account: 'home', url: 'https://claude.ai/code/session_B' }),
        row({ id: 'c0000000c', repo: 'octo/other', repoRoot: '/work/other', url: 'https://claude.ai/code/session_C' }),
        row({ id: 'r0000000r', kind: 'repo', url: '' }),
      ],
    }),
  })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  const out = JSON.stringify(await $.command.run({ command: 'cloud' } as never))
  expect(out).toContain('session_A')
  expect(out).not.toContain('session_B')
  expect(out).not.toContain('session_C')
  const all = JSON.stringify(await $.command.run({ command: 'cloud', args: 'all' } as never))
  expect(all).toContain('session_B')
  expect(all).toContain('session_C')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'kit-cloud', component: 'AbovePrompt', surface, props: BAND })
    expect((await ui.find({ type: 'Text', text: /1 working/ }))?.text).toContain('1 working')
    // The bands of the plugins beneath (here the engine's stand-in) still show, under this one.
    expect((await ui.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.press({ key: 'cloud-toggle' })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.press({ key: 'cloud-toggle' })
    await ui.unmount()
  }
})

test('session start watches the repo through the hub, as this session', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  const call = seen.argv.find(a => a[0] === 'node')
  expect(call?.slice(-3)).toEqual(['watch', '--repo', 'octo/demo'])
  expect(call?.[1]).toBe(CLI)
  expect(seen.env[seen.argv.indexOf(call!)]?.CLAUDE_CODE_SESSION_ID).toBe('sess-1')
})

test('autoWatch off never starts the hub; deleteMergedBranches and notifications reach it', { options: { autoWatch: false, notifications: false, deleteMergedBranches: true } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(seen.argv.some(a => a[0] === 'node')).toBe(false)
  await $.command.run({ command: 'cloud', args: 'track claude/fix-1' } as never)
  const i = seen.argv.findIndex(a => a[0] === 'node')
  expect(seen.argv[i]?.slice(2)).toEqual(['track', '--repo', 'octo/demo', '--branch', 'claude/fix-1'])
  expect(seen.env[i]).toEqual({ CLAUDE_CODE_SESSION_ID: 'sess-1', CLOUD_PILOT_DIR: '/home/x/.claude/cloud-pilot', CLOUD_PILOT_NOTIFY: '0', CLOUD_PILOT_DELETE_MERGED: '1' })
})

test('no node, no origin, a broken hub file: each says what to do and nothing throws', async ($, on) => {
  let text = '{"rows": [ {"id"'
  engine(on, { nodeMissing: true, origin: '', state: () => text })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'watch' } as never))).toContain('no GitHub')
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'doctor' } as never))).toContain('Install Node 18+')
  expect(JSON.stringify(await $.command.run({ command: 'cloud' } as never))).toContain("Could not read cloud-pilot's state")
  text = JSON.stringify({ hub: { polledMs: NOW_MS - 3_600_000 }, rows: [row()] })
  const out = JSON.stringify(await $.command.run({ command: 'cloud' } as never))
  expect(out).toContain('session_A')
  expect(out).toContain('cloud-pilot stopped')
})

test('scope all and a hidden band', { options: { scope: 'all', showBand: false } }, async ($, on) => {
  engine(on, { state: () => JSON.stringify({ hub: { polledMs: NOW_MS }, rows: [row({ account: 'home', repo: 'octo/other', repoRoot: '/x' })] }) })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  await $.session.start({ cwd: '/work/demo', surface: 'desktop', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud' } as never))).toContain('every account and repo')
  const ui = await $.ui.mount({ plugin: 'kit-cloud', component: 'AbovePrompt', surface: 'desktop', props: BAND })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('doctor reports what the hub found; help lists the commands', async ($, on) => {
  engine(on, { hubOut: a => (a.includes('doctor') ? JSON.stringify({ ok: false, problems: ['gh is not signed in: run gh auth login'] }) : '{"ok":true}') })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'doctor' } as never))).toContain('gh auth login')
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'help' } as never))).toContain('/cloud untrack <id>')
})

test('without cloud-pilot installed: no hub call, the commands say how to install it', async ($, on) => {
  const seen = engine(on, { noPilot: true })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(seen.argv.some(a => a[0] === 'node')).toBe(false)
  for (const args of ['doctor', 'watch', 'track claude/x']) {
    expect(JSON.stringify(await $.command.run({ command: 'cloud', args } as never))).toContain('kit-cloud-pilot')
  }
})

test('waiterNote: only for this session\'s live tracks with no waiter, and only from a hub that reports waiters', () => {
  const mine = row({ ownerSessionId: 'sess-1' })
  expect(waiterNote([mine], 'sess-1', [], {})).toContain('no cloud-pilot wait running for 1 tracked session')
  expect(waiterNote([mine, row({ id: 'x', ownerSessionId: 'sess-1' })], 'sess-1', [], { 'sess-1': 3 })).toContain('2 tracked sessions (3 events unread)')
  expect(waiterNote([mine], 'sess-1', ['sess-1'], {})).toBe('')
  expect(waiterNote([mine], 'sess-1', undefined, {})).toBe('')
  expect(waiterNote([row({ ownerSessionId: 'other' })], 'sess-1', [], {})).toBe('')
  expect(waiterNote([row({ ownerSessionId: 'sess-1', active: false })], 'sess-1', [], {})).toBe('')
})

test('the band warns when this session owns live tracks but nothing waits for their events', async ($, on) => {
  let waiting: string[] = []
  engine(on, { state: () => JSON.stringify({ hub: { polledMs: NOW_MS - 60_000 }, rows: [row({ ownerSessionId: 'sess-1' })], waiting, queued: { 'sess-1': 2 } }) })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ plugin: 'kit-cloud', component: 'AbovePrompt', surface: 'terminal', props: BAND })
  expect((await ui.find({ type: 'Text', text: /no cloud-pilot wait/ }))?.text).toContain('2 events unread')
  await ui.unmount()
  expect(JSON.stringify(await $.command.run({ command: 'cloud' } as never))).toContain('no cloud-pilot wait')
  waiting = ['sess-1']
  await $.command.run({ command: 'cloud' } as never)
  ui = await $.ui.mount({ plugin: 'kit-cloud', component: 'AbovePrompt', surface: 'terminal', props: BAND })
  expect(await ui.find({ type: 'Text', text: /no cloud-pilot wait/ })).toBeUndefined()
  await ui.unmount()
})

const cr = (over: Partial<HubRow> = {}) => fromHub(row(over))

test('changes: the first look seeds and says nothing; a new session is announced only when it is asking', () => {
  const asking = cr({ id: 'ask', state: 'question' })
  expect(changes(null, [asking, cr({ id: 'z', state: 'done' })])).toEqual([])
  const seeded = snapshot([cr({ id: 'old', state: 'working' })])
  expect(changes(seeded, [cr({ id: 'old', state: 'working' }), asking, cr({ id: 'n1', state: 'done' }), cr({ id: 'n2', state: 'pr' }), cr({ id: 'n3', state: 'silent' })])
    .map(c => [c.row.id, c.kind])).toEqual([['ask', 'asking']])
})

test('changes: asking, ci-failed, pr, finished and silent, once each, and nothing on the next identical refresh', () => {
  const step = (from: Partial<HubRow>, to: Partial<HubRow>) => changes(snapshot([cr(from)]), [cr(to)]).map(c => c.kind)
  expect(step({ state: 'working' }, { state: 'question' })).toEqual(['asking'])
  expect(step({ state: 'working' }, { state: 'pr', detail: 'PR #7 · CI running' })).toEqual(['pr'])
  expect(step({ state: 'pr', detail: 'PR #7 · CI running' }, { state: 'pr', detail: 'PR #7 · CI failed' })).toEqual(['ci-failed'])
  // One announcement per session: a PR that opens with CI already failed is "ci-failed", not also "pr".
  expect(step({ state: 'working' }, { state: 'pr', detail: 'PR #7 · CI failed' })).toEqual(['ci-failed'])
  expect(step({ state: 'working' }, { state: 'silent' })).toEqual(['silent'])
  for (const done of ['done', 'closed', 'abandoned']) expect(step({ state: 'pr' }, { state: done })).toEqual(['finished'])
  // Not announced: staying put, finished to finished, going back to work, a detail change that is not a CI failure.
  expect(step({ state: 'question' }, { state: 'question' })).toEqual([])
  expect(step({ state: 'done' }, { state: 'closed' })).toEqual([])
  expect(step({ state: 'question' }, { state: 'working' })).toEqual([])
  expect(step({ state: 'pr', detail: 'PR #7 · CI running' }, { state: 'pr', detail: 'PR #7 · CI passed' })).toEqual([])
  expect(step({ state: 'pr', detail: 'PR #7 · CI failed' }, { state: 'pr', detail: 'PR #7 · CI failed again' })).toEqual([])
  // The same rows seen twice announce once.
  const before = snapshot([cr({ state: 'working' })])
  const now = [cr({ state: 'question' })]
  expect(changes(before, now)).toHaveLength(1)
  expect(changes(snapshot(now), now)).toEqual([])
})

test('notification text carries the title and repo, in both languages', () => {
  const r = cr({ title: 'Fix the HUD' })
  expect(changeText(STRINGS.en, 'asking', r)).toBe('asking you a question: Fix the HUD (demo)')
  expect(changeText(STRINGS.en, 'ci-failed', r)).toBe('CI failed: Fix the HUD (demo)')
  expect(changeText(STRINGS.vi, 'asking', r)).toBe('đang hỏi bạn: Fix the HUD (demo)')
  expect(changeText(STRINGS.vi, 'ci-failed', r)).toBe('CI lỗi: Fix the HUD (demo)')
  expect(changeText(STRINGS.vi, 'finished', r)).toBe('đã xong: Fix the HUD (demo)')
  expect(changeText(STRINGS.vi, 'silent', r)).toBe('im lặng: Fix the HUD (demo)')
  expect(changeText(STRINGS.vi, 'pr', r)).toBe('có PR: Fix the HUD (demo)')
})

test('a live session announces a change once with a toast and a notification, and not on its first look', async ($, on) => {
  let rows: HubRow[] = [row()]
  const seen = engine(on, { state: () => JSON.stringify({ hub: { polledMs: NOW_MS - 60_000 }, rows }) })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(seen.toasts).toEqual([])
  await $.command.run({ command: 'cloud' } as never)
  expect(seen.notes).toEqual([])
  rows = [row({ state: 'question', title: 'Fix the HUD' })]
  await $.command.run({ command: 'cloud' } as never)
  expect(seen.toasts).toEqual(['☁ asking you a question: Fix the HUD (demo)'])
  expect(seen.notes).toEqual([{ text: 'asking you a question: Fix the HUD (demo)', title: 'Cloud' }])
  await $.command.run({ command: 'cloud' } as never)
  expect(seen.toasts).toHaveLength(1)
  rows = [row({ state: 'done' })]
  await $.command.run({ command: 'cloud' } as never)
  expect(seen.notes.map(n => n.text)).toEqual(['asking you a question: Fix the HUD (demo)', 'finished: Fix the HUD (demo)'])
})

test('notifyInSession off keeps the band and says nothing', { options: { notifyInSession: false } }, async ($, on) => {
  let rows: HubRow[] = [row()]
  const seen = engine(on, { state: () => JSON.stringify({ hub: { polledMs: NOW_MS - 60_000 }, rows }) })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  rows = [row({ state: 'question' })]
  expect(JSON.stringify(await $.command.run({ command: 'cloud' } as never))).toContain('session_A')
  expect(seen.toasts).toEqual([])
  expect(seen.notes).toEqual([])
})

test('language: the setting maps to vi or en, the option overrides it', () => {
  for (const v of ['vi', 'VI', 'vietnamese', 'Vietnamese', 'Viet', 'tiếng việt', 'Tiếng Việt', ' vi-VN']) expect(languageFromSetting(v)).toBe('vi')
  for (const v of ['en', 'english', 'japanese', 'french', '', undefined, null, 42, {}]) expect(languageFromSetting(v)).toBe('en')
  expect([languageOption('vi'), languageOption('en'), languageOption('auto'), languageOption('fr'), languageOption(undefined)]).toEqual(['vi', 'en', 'auto', 'auto', 'auto'])
  expect(settingsFrom({ language: 'vi', notifyInSession: false } as never)).toMatchObject({ language: 'vi', notifyInSession: false })
})

test('both languages have the same keys and the Vietnamese one reads naturally', () => {
  expect(Object.keys(STRINGS.vi).sort()).toEqual(Object.keys(STRINGS.en).sort())
  const rows = [cr({ state: 'question' }), cr({ id: 'b', state: 'working' }), cr({ id: 'c', state: 'pr', detail: 'CI failed' }), cr({ id: 'd', state: 'silent' }), cr({ id: 'e', state: 'done' })]
  expect(summary(rows, STRINGS.vi).map(p => p.text)).toEqual(['1 đang hỏi bạn', '1 đang làm', '1 có PR (1 CI lỗi)', '1 im lặng', '1 đã xong'])
  expect(stateWord('working', STRINGS.vi)).toBe('đang làm')
  expect(stateWord('working')).toBe('working')
  expect(parseCommand('frobnicate', STRINGS.vi)).toEqual({ verb: 'help', error: 'Không hiểu lệnh: /cloud frobnicate' })
  const t = table([cr()], NOW_MS / 1000, 'work · demo', STRINGS.vi)
  expect(t).toContain('trạng thái')
  expect(t).toContain('https://claude.ai/code/session_A')
  expect(Math.max(...t.split('\n').filter(l => !l.startsWith('  http')).map(l => [...l].length))).toBeLessThanOrEqual(94)
  // Command names, ids and branches stay as they are.
  expect(STRINGS.vi.usage).toContain('/cloud track <url> [branch]')
  expect(STRINGS.vi.usage).toContain('claude/*')
})

test('language auto follows the Claude Code language setting: Vietnamese band, command replies and errors', { options: { language: 'auto' } }, async ($, on) => {
  engine(on, { language: 'Vietnamese', state: () => JSON.stringify({ hub: { polledMs: NOW_MS - 60_000 }, rows: [row(), row({ id: 'q0000000q', state: 'question', url: 'https://claude.ai/code/session_Q' })] }) })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  const list = JSON.stringify(await $.command.run({ command: 'cloud' } as never))
  expect(list).toContain('trạng thái')
  expect(list).toContain('tất cả lệnh')
  expect(list).not.toContain('last 24 hours')
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'help' } as never))).toContain('theo dõi')
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'nope' } as never))).toContain('Không hiểu lệnh: /cloud nope')
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'untrack a1b2c3d4e5' } as never))).toContain('Đã ngừng theo dõi a1b2c3d4e5')
  const ui = await $.ui.mount({ plugin: 'kit-cloud', component: 'AbovePrompt', surface: 'terminal', props: BAND })
  expect((await ui.find({ type: 'Text', text: /1 đang hỏi bạn/ }))?.text).toContain('1 đang hỏi bạn')
  expect((await ui.find({ type: 'Text', text: /1 đang làm/ }))?.text).toContain('1 đang làm')
  expect((await ui.find({ type: 'Text', text: /xem các phiên/ }))?.text).toContain('xem các phiên')
  await ui.press({ key: 'cloud-toggle' })
  expect((await ui.find({ type: 'Link' }))?.text).toContain('mở')
  await ui.unmount()
})

test('language auto: an unreadable setting means English', async ($, on) => {
  engine(on, { languageFails: true })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'nope' } as never))).toContain('Unknown: /cloud nope')
})

test('language en forced beats a Vietnamese setting', { options: { language: 'en' } }, async ($, on) => {
  engine(on, { language: 'Vietnamese' })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'nope' } as never))).toContain('Unknown: /cloud nope')
})

test('language vi forced: Vietnamese although Claude Code says nothing', { options: { language: 'vi' } }, async ($, on) => {
  engine(on, { languageFails: true })
  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  expect(JSON.stringify(await $.command.run({ command: 'cloud', args: 'nope' } as never))).toContain('Không hiểu lệnh')
})
