import { expect, mock, test } from 'claude-code/testing'

const T0 = new Date(2026, 10, 25, 13, 40).getTime()
const MIN = 60_000
const SOUNDS = '/plug/sounds'

type World = {
  clock: ReturnType<typeof mock.clock>
  failAll: boolean
  platform: string
  root: string | undefined
  language: unknown
  draft: string
  notifySent: boolean
  failSubmit: boolean
  cwd: string
  /** argv[0] values whose run fails (not installed) */
  missing: string[]
  /** exit code per argv[0] (default 0) */
  exits: Record<string, number>
  notes: { text: string; title?: string }[]
  toasts: string[]
  sounds: string[]
  runs: string[][]
  submitted: { text: string; asUser?: boolean }[]
  filled: string[]
  commands: { name: string; immediate?: boolean }[]
  audioFails: boolean
  logs: string[]
  fillFails: boolean
  notifyReason: string
  base: {}
}

function engine(on: any, over: Partial<World> = {}): World {
  const w: World = {
    clock: undefined as never, failAll: false, platform: 'windows', root: '/plug', language: undefined, draft: '', notifySent: true, failSubmit: false, cwd: 'D:\\Work\\acme-shop',
    missing: [], exits: {}, notes: [], toasts: [], sounds: [], runs: [], submitted: [], filled: [], commands: [], audioFails: false, logs: [], fillFails: false, notifyReason: 'no-channel', base: {}, ...over,
  }
  const no = (why: string) => ({ deny: why })
  w.clock = mock.clock(on, { now: T0 })
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('ui.log', (_: unknown, e: any) => { w.logs.push(JSON.stringify(e)); return { value: undefined } })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('settings.read', () => (w.failAll || w.language === undefined ? no('unset') : { value: { language: w.language } as never }))
  // The older way to learn the system and the plugin folder (the only way on a Claude Code without session.info).
  on('env.get', (_: unknown, e: any) => {
    if (w.failAll) return no('x')
    if (e.name === 'OS') return { value: w.platform === 'windows' ? 'Windows_NT' : undefined }
    if (e.name === 'CLAUDE_PLUGIN_ROOT') return { value: w.root }
    return { value: undefined }
  })
  on('command.register', (_: unknown, e: any) => { if (w.failAll) return no('x'); w.commands.push({ name: e.name, immediate: e.immediate }); return { value: { command: e.name } } })
  on('classic.Notification', () => ({}) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('classic.PostToolUse', () => ({}) as never)
  on('ui.notify', (_: unknown, e: any) => {
    if (w.failAll) return no('x')
    w.notes.push({ text: e.text, title: e.title })
    return { value: w.notifySent ? { isSent: true, channel: 'kitty' } : { isSent: false, reason: w.notifyReason } }
  })
  on('ui.toast', (_: unknown, e: any) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('audio.play', (_: unknown, e: any) => { if (w.audioFails || w.failAll) return no('no player'); w.sounds.push(String(e.clip?.asset ?? e.asset)); return { value: undefined } })
  on('process.run', (_: unknown, e: any) => {
    if (e.argv[0] === 'uname') {
      const name = { macos: 'Darwin 24.1.0', linux: 'Linux 6.8.0-generic', wsl: 'Linux 5.15.90.1-microsoft-standard-WSL2' }[w.platform]
      return name ? { value: { exitCode: 0, stdout: `${name}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : no('spawn uname ENOENT')
    }
    w.runs.push(e.argv)
    if (w.missing.includes(e.argv[0])) return no('spawn ENOENT')
    return { value: { exitCode: w.exits[e.argv[0]] ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', () => (w.failAll ? no('x') : { value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', (_: unknown, e: any) => {
    if (w.fillFails) return { isFilled: false } as never
    w.filled.push(String(e.text)); w.draft = String(e.text)
    return { isFilled: true }
  })
  on('prompt.edit', (_: unknown, e: any) => {
    w.draft = String(e.text).slice(0, e.start) + String(e.inputText) + String(e.text).slice(e.end)
    return { text: w.draft, cursor: w.draft.length } as never
  })
  on('session.cwd', () => ({ value: w.cwd }))
  on('prompt.submit', async ($: any, e: any) => {
    if (w.failSubmit) return { drop: 'busy' } as never
    w.submitted.push({ text: e.text, asUser: e.asUser })
    await beginTurn(current$) // a sent prompt starts a turn
    return { text: e.text }
  })
  on('prompt.change', () => ({ text: '', cursor: 0, origin: { kind: 'plugin' } }) as never)
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: any) => ({ text: String(e.answer) }))
  return w
}

let current$: any
const start = ($: any, cwd = 'D:\\Work\\acme-shop', surface: 'terminal' | 'desktop' = 'terminal') =>
  (current$ = $).session.start({ cwd, surface, isInteractive: true } as never)
const queue = async ($: any, args: string): Promise<string> => {
  const out: any = await $.command.run({ command: 'queue', args } as never)
  return String(out?.text ?? '')
}
let turn = 0
const beginTurn = ($: any) => $.turn.start({ text: 'go', turnId: `t${++turn}` } as never)
const endTurn = ($: any, over: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: 'Fixed the rounding: 14 tests pass.', durationMs: 60_000, isAborted: false, turnId: `t${turn}`, reason: 'answer', ...over } as never)
const emptied = ($: any) => $.prompt.edit({ origin: { kind: 'composer' }, text: 'x', cursor: 1, start: 0, end: 1, inputText: '' } as never)
const typeText = ($: any, text: string) => $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text } as never)
const typed = ($: any) => $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'x' } as never)
const BAND = { plugin: 'kit-notify', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const textsOf = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.text ?? ''))
const flush = async (w: World) => { await w.clock.advance(2_000) }

test('install is done: /queue is registered, mid-turn runnable, and the session needs no setup', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.commands).toEqual([{ name: 'queue', immediate: true }])
  expect(await queue($, '')).toBe('The queue is empty. Add one with /queue add <text>.')
})

test('a long answered turn plays the done sound and notifies with the project and the first line', async ($, on) => {
  const w = engine(on, { platform: 'macos' })
  await start($)
  await w.clock.set(T0 + 60_000)
  await beginTurn($)
  await w.clock.set(T0 + 3 * MIN)
  await endTurn($, { answer: '## Fixed the rounding\nMore detail below.', durationMs: 2 * MIN })
  expect(w.notes).toEqual([{ text: 'Fixed the rounding', title: 'Claude finished · acme-shop' }])
  expect(w.sounds).toEqual(['sounds/done.wav'])
  expect(w.runs).toEqual([]) // macOS plays through the engine
})

test('a turn shorter than notifyAfterSec makes no sound and no notification; the option moves the line', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { durationMs: 19_000 })
  expect(w.notes).toHaveLength(0)
  expect(w.sounds.length + w.runs.length).toBe(0)
  await endTurn($, { durationMs: 20_000 })
  expect(w.notes).toHaveLength(1)
})

test('notifyAfterSec 0 rings after every answered turn', { options: { notifyAfterSec: 0 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { durationMs: 100 })
  expect(w.notes).toHaveLength(1)
})

test('a stopped or failed turn never rings', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { reason: 'aborted', isAborted: true })
  await endTurn($, { reason: 'error' })
  expect(w.notes).toHaveLength(0)
  expect(w.runs).toHaveLength(0)
})

test('a subagent finishing is not a turn of the person', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { agentId: 'sub-1' })
  expect(w.notes).toHaveLength(0)
})

test('a permission prompt notifies with its own text and plays the needs-you sound, even for a short turn', async ($, on) => {
  const w = engine(on, { platform: 'macos' })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(w.notes).toEqual([{ text: 'Claude needs your permission to use Bash', title: 'Claude needs you · acme-shop' }])
  expect(w.sounds).toEqual(['sounds/needs-you.wav'])
})

test('idle, sign-in and our own plugin notifications never ring (no echo)', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  for (const type of ['idle_prompt', 'auth_success', 'plugin_notification']) {
    await $.classic.Notification({ message: 'hi', notification_type: type } as never)
  }
  expect(w.notes).toHaveLength(0)
})

test('the same prompt heard as a Notification and a PermissionRequest rings once', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' } as never)
  await w.clock.advance(1_000)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(w.notes).toHaveLength(1)
  expect(w.notes[0]?.text).toBe('Claude is asking permission to use Bash.')
})

test('notifyDetails off: the line says nothing about the work', { options: { notifyDetails: false } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { answer: 'Secret plan for the merger' })
  await $.classic.Notification({ message: 'Allow rm -rf secrets?', notification_type: 'permission_prompt' } as never)
  expect(w.notes.map(n => n.text)).toEqual(['The work is ready for you to look at.', 'Claude is waiting for your answer.'])
})

test('sound off and notify off are honoured separately', { options: { sound: false } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.notes).toHaveLength(1)
  expect(w.runs.length + w.sounds.length).toBe(0)
})

test('notify off keeps the sound', { options: { notify: false } }, async ($, on) => {
  const w = engine(on, { platform: 'macos' })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.notes).toHaveLength(0)
  expect(w.sounds).toEqual(['sounds/done.wav'])
})

test('quiet hours silence both; outside them both come', { options: { quietHours: '13:00-14:00' } }, async ($, on) => {
  const w = engine(on, { platform: 'macos' })
  await start($)
  await w.clock.set(T0 + 5 * MIN) // 13:45
  await endTurn($)
  expect(w.notes).toHaveLength(0)
  expect(w.sounds).toHaveLength(0)
  await w.clock.set(new Date(2026, 10, 25, 14, 0).getTime())
  await endTurn($)
  expect(w.notes).toHaveLength(1)
  expect(w.sounds).toHaveLength(1)
})

test('a bad quietHours value means never quiet', { options: { quietHours: 'after dinner' } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.notes).toHaveLength(1)
})

test('while the person is typing, nothing rings; a moment later it does', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await typed($)
  await w.clock.advance(3_000)
  await endTurn($)
  expect(w.notes).toHaveLength(0)
  await w.clock.advance(6_000)
  await endTurn($)
  expect(w.notes).toHaveLength(1)
})

test('no notification channel: a short in-app message shows instead', async ($, on) => {
  const w = engine(on, { notifySent: false })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.toasts).toEqual(['Claude finished · acme-shop: Fixed the rounding: 14 tests pass.'])
})

test('Windows plays the wav through PowerShell, once, with the plugin folder path', async ($, on) => {
  const w = engine(on, { platform: 'windows' })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.runs).toHaveLength(1)
  expect(w.runs[0]?.[0]).toBe('powershell')
  expect(w.runs[0]?.[4]).toBe(`(New-Object System.Media.SoundPlayer '${SOUNDS}/done.wav').PlaySync()`)
  expect(w.sounds).toHaveLength(0)
})

test('Linux tries paplay, then aplay, then canberra, and stops at the first that works', async ($, on) => {
  const w = engine(on, { platform: 'linux', missing: ['paplay'] })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.runs.map(r => r[0])).toEqual(['paplay', 'aplay'])
  expect(w.sounds).toHaveLength(0)
})

test('Linux with no player at all stays silent and says nothing', async ($, on) => {
  const w = engine(on, { platform: 'linux', missing: ['paplay', 'aplay', 'canberra-gtk-play'] })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.runs.map(r => r[0])).toEqual(['paplay', 'aplay', 'canberra-gtk-play'])
  expect(w.toasts).toHaveLength(0) // nothing the person has to act on
  expect(w.notes).toHaveLength(1) // the notification still came
})

test('a player that exits non-zero falls through to the next', async ($, on) => {
  const w = engine(on, { platform: 'linux', exits: { paplay: 1 } })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.runs.map(r => r[0])).toEqual(['paplay', 'aplay'])
})

test('without the plugin folder only the engine plays; a failing engine is silent', async ($, on) => {
  const w = engine(on, { platform: 'windows', root: undefined, audioFails: true })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.runs).toHaveLength(0)
  expect(w.notes).toHaveLength(1)
})

test('/queue add, list, remove and clear', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  expect(await queue($, 'add run the e2e tests')).toBe('Queued as number 1: run the e2e tests It is sent when Claude is free.')
  expect(await queue($, 'update the CHANGELOG')).toBe('Queued as number 2: update the CHANGELOG')
  expect(await queue($, 'list')).toBe('2 queued prompts, sent one at a time when Claude is free:\n1. run the e2e tests\n2. update the CHANGELOG')
  expect(await queue($, 'remove 1')).toBe('Removed number 1: run the e2e tests')
  expect(await queue($, 'remove 9')).toBe('There is no number 9 in the queue: /queue list shows the numbers.')
  expect(await queue($, 'remove')).toBe('There is no number (none given) in the queue: /queue list shows the numbers.')
  expect(await queue($, 'add')).toBe('Nothing to queue: type the prompt after /queue add.')
  expect(await queue($, 'clear')).toBe('Removed 1 queued prompt.')
  expect(await queue($, 'clear')).toBe('The queue was already empty.')
  expect(w.submitted).toHaveLength(0) // a turn was running the whole time
})

test('the queue holds 20 prompts and says so', async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  for (let i = 1; i <= 20; i++) await queue($, `add job ${i}`)
  expect(await queue($, 'add one too many')).toBe('The queue is full (20 prompts). Remove one or wait for Claude to work through them.')
})

test('when the turn ends, the next prompt is sent as the person\'s words, one at a time', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add first job')
  await queue($, 'add second job')
  await w.clock.set(T0 + 10 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['first job'])
  expect(await queue($, 'list')).toContain('1. second job')
  // the first job's turn runs and ends: the second goes out next
  await w.clock.advance(5_000)
  await beginTurn($)
  await endTurn($)
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['first job', 'second job'])
  expect(await queue($, 'list')).toBe('The queue is empty. Add one with /queue add <text>.')
})

test('nothing is sent while the person has half a prompt typed; it goes when the box is empty', async ($, on) => {
  const w = engine(on, { draft: 'half a thought' })
  await start($)
  await beginTurn($)
  await queue($, 'add queued job')
  await w.clock.set(T0 + 10 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  await flush(w) // the retry finds the box still full
  expect(w.submitted).toHaveLength(0)
  w.draft = ''
  await emptied($) // the person clears their draft
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['queued job'])
})

test('a paused queue sends nothing until resumed', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add job')
  expect(await queue($, 'pause')).toBe('Queue paused: nothing is sent until /queue resume.')
  await w.clock.set(T0 + 10 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  expect(await queue($, 'resume')).toBe('Queue resumed: the next prompt goes out when Claude is free.')
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['job'])
})

test('never sends while a permission prompt is open; sends once it is answered and the turn ends', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add job')
  await w.clock.set(T0 + 5 * MIN)
  await $.classic.Notification({ message: 'Allow Bash?', notification_type: 'permission_prompt' } as never)
  await $.command.run({ command: 'queue', args: 'next' } as never) // the person pushes it explicitly: that is their call
  await flush(w)
  expect(w.submitted).toHaveLength(1)
  await queue($, 'add second')
  // a drain attempt while the question is open (for instance a retry timer) does nothing
  await flush(w)
  expect(w.submitted).toHaveLength(1)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} } as never)
  await endTurn($, { durationMs: 1_000 })
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['job', 'second'])
})

test('a turn that ends with a question still open does not send the queue until the person answers', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add job')
  await w.clock.set(T0 + 5 * MIN)
  await $.classic.Notification({ message: 'Which branch?', notification_type: 'elicitation_dialog' } as never)
  // an async drain request arrives while the question is open
  await flush(w)
  expect(w.submitted).toHaveLength(0)
})

test('stopping Claude pauses the queue so it does not send behind the person\'s back', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add job')
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { reason: 'aborted', isAborted: true })
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  expect(w.toasts).toEqual(['You stopped Claude, so the queue is paused. /queue resume sends the rest.'])
  expect(await queue($, 'list')).toContain('(paused)')
})

test('a prompt the engine refuses goes back to the front and pauses the queue, with a message', async ($, on) => {
  const w = engine(on, { failSubmit: true })
  await start($)
  await beginTurn($)
  await queue($, 'add job')
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { durationMs: 1_000 })
  await flush(w)
  await flush(w)
  expect(w.toasts).toContain('The next queued prompt could not be sent, so the queue is paused. /queue resume tries again.')
  expect(await queue($, 'list')).toBe('1 queued prompt (paused):\n1. job')
})

test('/queue next sends the first now, even when paused', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add a')
  await queue($, 'add b')
  await queue($, 'pause')
  expect(await queue($, 'next')).toBe('Sending now: a')
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['a'])
  expect(await queue($, 'list')).toContain('1. b')
  expect(await queue($, 'clear')).toBe('Removed 1 queued prompt.')
  expect(await queue($, 'next')).toBe('The queue is empty, so there is nothing to send.')
})

test('a prompt queued while nothing runs goes out at once', async ($, on) => {
  const w = engine(on)
  await start($)
  await queue($, 'add do it')
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['do it'])
})

test('the queue band lists every prompt numbered with a remove button each, on terminal and desktop', async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add Re-run the e2e checkout tests')
  await queue($, 'add Update the CHANGELOG for v2.4')
  await queue($, 'add Open a PR and label it needs-review')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = await textsOf(ui)
    expect(texts).toContain('Queue · 3 prompts sent one at a time when Claude is free')
    for (const [i, line] of ['Re-run the e2e checkout tests', 'Update the CHANGELOG for v2.4', 'Open a PR and label it needs-review'].entries()) {
      expect(texts).toContain(String(i + 1))
      expect(texts).toContain(line)
    }
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3 + 4) // three ×, send now, pause, clear, queue what I typed
    expect(await ui.find({ type: 'Button', text: 'Send the first now' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Clear all' })).toBeDefined()
    await ui.unmount()
  }
})

test('pressing × removes that prompt; Pause becomes Resume; Clear all empties the queue', async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add one')
  await queue($, 'add two')
  await queue($, 'add three')
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const rm = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.label === '×')
  expect(rm).toHaveLength(3)
  await ui.press({ key: String(rm[1]!.props.key) })
  expect(await queue($, 'list')).toBe('2 queued prompts, sent one at a time when Claude is free:\n1. one\n2. three')
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'pause' })
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined()
  expect(await textsOf(ui)).toContain('Queue · 2 prompts paused')
  await ui.press({ key: 'clear' })
  await ui.unmount()
  expect(await queue($, 'list')).toBe('The queue is empty. Add one with /queue add <text>.')
})

test('"Queue what I typed" moves the prompt box into the queue and empties the box', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await typeText($, 'then deploy to staging')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'add-typed' })
  await ui.unmount()
  expect(await queue($, 'list')).toContain('1. then deploy to staging')
  expect(w.filled).toEqual([''])
  expect(w.draft).toBe('')
})

test('"Queue what I typed" with an empty box asks the person to type first and queues nothing', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add another job')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'add-typed' })
  await ui.unmount()
  expect(w.toasts).toEqual(['Type the prompt in the box first, then queue it.'])
  expect(await queue($, 'list')).toContain('1. another job')
  expect(await queue($, 'list')).not.toContain('2.')
})

test('"Queue what I typed" never loses text: a full queue or a too-long draft leaves it in the box, with a message', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  for (let i = 1; i <= 20; i++) await queue($, `add job ${i}`)
  await typeText($, 'job 3') // the same text as one already queued: must not be taken for "added"
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'add-typed' })
  await ui.unmount()
  expect(w.filled).toEqual([])
  expect(w.draft).toBe('job 3')
  expect(w.toasts.at(-1)).toBe('The queue is full (20 prompts). Remove one or wait for Claude to work through them.')
  await queue($, 'clear')
  await typeText($, 'z'.repeat(4001))
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await queue($, 'add one')
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'add-typed' })
  await ui.unmount()
  expect(w.draft).toHaveLength(4001)
  expect(w.toasts.at(-1)).toBe('That prompt is longer than 4000 characters, so it was not queued. Send it directly or split it.')
  expect(await queue($, 'add ' + 'z'.repeat(4001))).toBe('That prompt is longer than 4000 characters, so it was not queued. Send it directly or split it.')
})

test('if the box cannot be emptied the person is told, so the same text is not sent twice', async ($, on) => {
  const w = engine(on, { fillFails: true })
  await start($)
  await beginTurn($)
  await typeText($, 'queue me')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'add-typed' })
  await ui.unmount()
  expect(await queue($, 'list')).toContain('1. queue me')
  expect(w.toasts.at(-1)).toBe('Queued, but the prompt box could not be emptied: clear it yourself so the same text is not sent twice.')
})

test('the idle queue row shows only while Claude works AND something is typed; the plugins beneath are kept', async ($, on) => {
  engine(on)
  await start($)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine']) // idle, nothing queued: the plugins beneath only
  await ui.unmount()
  await beginTurn($)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine']) // working, but nothing typed: no extra row for everyone
  await ui.unmount()
  await typeText($, 'next thing')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = await textsOf(ui)
  expect(texts.some(t => t.includes('Queue what you typed to send it when Claude is free'))).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'add-typed' })).toBeDefined()
  expect(texts).toContain('engine')
  await ui.unmount()
  await emptied($) // the draft is gone: so is the row
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
})

test('showQueueButton off hides that row but a non-empty queue still shows', { options: { showQueueButton: false } }, async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  await typeText($, 'something')
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
  await queue($, 'add job')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'add-typed' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: '×' })).toBeDefined()
  await ui.unmount()
})

test('a short terminal gets one line with the next prompt, never a taller band than it has', async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add Re-run the e2e checkout tests')
  await queue($, 'add Second')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 4 } })
  const texts = await textsOf(ui)
  expect(texts.some(t => t.includes('Queue · 2 waiting · next: Re-run the e2e checkout tests'))).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Send the first now' })).toBeDefined()
  await ui.unmount()
})

test('huge prompts are cut in the band, never in what is sent', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  const huge = `${'x'.repeat(3000)}\nsecond line`
  await queue($, `add ${huge}`)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const shown = (await textsOf(ui)).find(t => t.startsWith('xxx'))!
  expect(shown.length).toBeLessThanOrEqual(120)
  await ui.unmount()
  await w.clock.set(T0 + 10 * MIN)
  await endTurn($)
  await flush(w)
  expect(w.submitted[0]?.text).toBe(huge)
})

test('the welcome-back card: while away 25 minutes, two tasks done and one question waiting', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 2 * MIN)
  await $.prompt.submit({ text: 'work on it', origin: { kind: 'composer' } } as never) // the person sends and leaves
  await beginTurn($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($, { answer: 'Fixed the cart rounding. PR #212, 14 tests pass.' })
  await beginTurn($)
  await w.clock.set(T0 + 9 * MIN)
  await endTurn($, { answer: 'Updated the CHANGELOG for v2.4.' })
  await beginTurn($)
  await w.clock.set(T0 + 12 * MIN)
  await $.classic.Notification({ message: 'Does the coupon apply before or after tax?', notification_type: 'elicitation_dialog' } as never)
  await w.clock.set(T0 + 27 * MIN)
  await typed($) // the person is back
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = await textsOf(ui)
  expect(texts).toContain('While you were away 25 min: 2 tasks done, 1 question waiting')
  expect(texts.some(t => t.startsWith('Welcome back'))).toBe(true)
  expect(texts.some(t => t.includes('away 25 min (13:42 → 14:07)'))).toBe(true)
  expect(texts.some(t => t.includes('Does the coupon apply before or after tax?'))).toBe(true)
  expect(texts.some(t => t.includes('Fixed the cart rounding. PR #212, 14 tests pass.'))).toBe(true)
  expect(texts.some(t => t.includes('Updated the CHANGELOG for v2.4.'))).toBe(true)
  await ui.press({ key: 'card-dismiss' })
  await ui.unmount()
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await textsOf(after)).some(t => t.startsWith('While you were away'))).toBe(false)
  await after.unmount()
})

test('no card for a short absence, for an absence with nothing in it, or for someone a notification already called back', async ($, on) => {
  const w = engine(on)
  await start($)
  // short absence: a turn ends 4 minutes later
  await w.clock.set(T0 + 4 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 6 * MIN)
  await typed($)
  // long absence, nothing happened
  await w.clock.set(T0 + 40 * MIN)
  await typed($)
  // the turn ends, a notification goes out, and the person is back within a minute
  await w.clock.set(T0 + 50 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 50 * MIN + 30_000)
  await typed($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await textsOf(ui)).some(t => t.includes('While you were away'))).toBe(false)
  await ui.unmount()
})

test('awayMin 0 turns the card off', { options: { awayMin: 0 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 3 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 90 * MIN)
  await typed($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await textsOf(ui)).some(t => t.includes('While you were away'))).toBe(false)
  await ui.unmount()
})

test('a question that was answered meanwhile does not count as waiting', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 3 * MIN)
  await $.classic.Notification({ message: 'Allow Bash?', notification_type: 'permission_prompt' } as never)
  await w.clock.set(T0 + 4 * MIN)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} } as never)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 30 * MIN)
  await typed($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toContain('While you were away 30 min: 1 task done')
  await ui.unmount()
})

test('Vietnamese: the card, the band and /queue speak Vietnamese when asked', { options: { language: 'vi' } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 3 * MIN)
  await endTurn($, { answer: 'Đã sửa xong.' })
  await w.clock.set(T0 + 30 * MIN)
  await typed($)
  expect(await queue($, 'add việc tiếp theo')).toBe('Đã xếp hàng, số 1: việc tiếp theo Sẽ gửi khi Claude rảnh.')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = await textsOf(ui)
  expect(texts).toContain('Trong lúc bạn đi 30 phút: xong 1 việc')
  expect(texts).toContain('Hàng chờ · 1 việc tự gửi lần lượt khi Claude rảnh')
  expect(await ui.find({ type: 'Button', text: 'Đóng' })).toBeDefined()
  await ui.unmount()
})

test('Claude Code in Vietnamese makes the auto language Vietnamese; notifications follow', async ($, on) => {
  const w = engine(on, { language: 'Vietnamese' })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.notes[0]?.title).toBe('Claude xong việc · acme-shop')
})

test('every capability missing at once: the session still starts and nothing throws', async ($, on) => {
  const w = engine(on, { failAll: true })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  await beginTurn($)
  await $.classic.Notification({ message: 'q', notification_type: 'permission_prompt' } as never)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} } as never)
  expect(await queue($, 'add still works')).toContain('Queued as number 1')
  expect(w.notes).toHaveLength(0)
})

test('/queue answers are shown to the person only, never handed to the model', async ($, on) => {
  engine(on)
  await start($)
  await beginTurn($)
  const out: any = await $.command.run({ command: 'queue', args: 'add secret plan' } as never)
  expect(out.isTextDisplayOnly).toBe(true)
  const list: any = await $.command.run({ command: 'queue', args: 'list' } as never)
  expect(list.isTextDisplayOnly).toBe(true)
})

test('a permission prompt right after the person sent a prompt still rings (only typing hides an alert)', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await $.prompt.submit({ text: 'do it', origin: { kind: 'composer' } } as never)
  await w.clock.advance(4_000)
  await $.classic.Notification({ message: 'Allow Bash?', notification_type: 'permission_prompt' } as never)
  expect(w.notes).toHaveLength(1)
})

test('a keystroke 2 seconds ago hides a needs-you alert; 4 seconds ago it rings', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await typed($)
  await w.clock.advance(2_000)
  await $.classic.Notification({ message: 'Allow Bash?', notification_type: 'permission_prompt' } as never)
  expect(w.notes).toHaveLength(0)
  await w.clock.advance(10_000)
  await typed($)
  await w.clock.advance(4_000)
  await $.classic.Notification({ message: 'Allow Edit?', notification_type: 'permission_prompt' } as never)
  expect(w.notes).toHaveLength(1)
})

test('a scheduled or background prompt is not the person coming back: the card waits for them', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 3 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 30 * MIN)
  await $.prompt.submit({ text: 'tick', origin: { kind: 'scheduled-trigger' } } as never)
  await $.prompt.submit({ text: 'done', origin: { kind: 'task-notification' } } as never)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textsOf(ui)).toEqual(['engine'])
  await ui.unmount()
  await typed($)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await textsOf(ui)).some(t => t.startsWith('While you were away 30 min'))).toBe(true)
  await ui.unmount()
})

test('after a reload there is no session.start: the language, project, system and /queue still come', async ($, on) => {
  const w = engine(on, { platform: 'windows', language: 'Vietnamese' })
  // no start($): the module was reloaded in a running session
  await w.clock.set(T0 + 5 * MIN)
  expect(await queue($, '')).toBe('Hàng chờ đang trống. Thêm bằng /queue add <nội dung>.')
  await endTurn($)
  await flush(w)
  expect(w.notes[0]?.title).toBe('Claude xong việc · acme-shop')
  expect(w.runs[0]?.[0]).toBe('powershell')
  expect(w.commands).toEqual([{ name: 'queue', immediate: true }])
})

for (const why of ['aborted', 'error', 'refusal'] as const) {
  test(`a ${why} turn pauses the queue so nothing is sent behind the person's back`, async ($, on) => {
    const w = engine(on)
    await start($)
    await beginTurn($)
    await queue($, 'add job')
    await w.clock.set(T0 + 5 * MIN)
    await endTurn($, { reason: why, isAborted: why === 'aborted', ...(why === 'refusal' ? { refusal: { category: null, explanation: null } } : {}) })
    await flush(w)
    expect(w.submitted).toHaveLength(0)
    expect(await queue($, 'list')).toContain('(paused)')
    await queue($, 'resume')
    await flush(w)
    expect(w.submitted.map(s => s.text)).toEqual(['job'])
  })
}

test('two quick presses of "send the first now" never send the same prompt twice', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add only one')
  await Promise.all([queue($, 'next'), queue($, 'next')])
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['only one'])
})

test('/queue clear while the turn ends never sends what was cleared', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await queue($, 'add a')
  await queue($, 'add b')
  await Promise.all([queue($, 'clear'), endTurn($, { durationMs: 1_000 })])
  await flush(w)
  expect(w.submitted.length).toBeLessThanOrEqual(1)
  expect(await queue($, 'list')).toBe('The queue is empty. Add one with /queue add <text>.')
})

test('a prompt held by an open question goes as soon as the question is answered', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await $.classic.Notification({ message: 'Allow Bash?', notification_type: 'permission_prompt' } as never)
  await queue($, 'add job') // nothing runs, but a question is open: it must wait
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} } as never)
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['job'])
})

test('a held prompt goes when the person empties the box; typing keeps it held', async ($, on) => {
  const w = engine(on)
  await start($)
  await beginTurn($)
  await typeText($, 'half a thought')
  await queue($, 'add job')
  await w.clock.set(T0 + 10 * MIN)
  await endTurn($, { durationMs: 1_000 })
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  await typed($) // more typing: still held
  await flush(w)
  expect(w.submitted).toHaveLength(0)
  w.draft = 'x'
  await emptied($)
  await flush(w)
  expect(w.submitted.map(s => s.text)).toEqual(['job'])
})

test('with details off the notification title names no project either', { options: { notifyDetails: false } }, async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.notes[0]?.title).toBe('Claude finished')
})

test('a notification turned off in Claude Code is respected: no in-app message either', async ($, on) => {
  const w = engine(on, { notifySent: false, notifyReason: 'disabled' })
  await start($)
  await w.clock.set(T0 + 5 * MIN)
  await endTurn($)
  expect(w.toasts).toHaveLength(0)
})

test('a short terminal gets the card as one line, never a taller band than it has', async ($, on) => {
  const w = engine(on)
  await start($)
  await w.clock.set(T0 + 3 * MIN)
  await endTurn($)
  await w.clock.set(T0 + 30 * MIN)
  await typed($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 3 } })
  const texts = await textsOf(ui)
  expect(texts.some(t => t.includes('While you were away 30 min: 1 task done'))).toBe(true)
  expect(texts.some(t => t.startsWith('Welcome back'))).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'card-dismiss' })).toBeDefined()
  await ui.unmount()
})
