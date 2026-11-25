import { expect, test } from 'claude-code/testing'

import { MIN_CLAUDE_CODE, formatLine, parseVersion, summary, versionAtLeast } from './doctor'

type World = {
  store: Record<string, unknown> | 'broken' // what the plugin store holds, or a store that fails
  storeWritesFail: boolean
  clearFails: boolean
  setFails: boolean
  commandFails: boolean
  themeResult: object
  version: string | 'throw'
  cliVersion: string | 'none'
  platform: string | 'throw' // what session.info reports
  language: string | undefined // Claude Code's own language setting
  files: string[] // paths (tails) that exist
  looks: number
  clears: number
  commands: string[]
  writes: string[]
}

function engine(on: any, over: Partial<World> = {}): World {
  const w: World = {
    store: {}, storeWritesFail: false, clearFails: false, setFails: false, commandFails: false, themeResult: { isDrawn: true, requestId: 'backdrop' },
    platform: 'windows', language: undefined, version: '2.1.331', cliVersion: '2.1.331 (Claude Code)',
    files: ['/terminal/terminal-backdrop.png', '/terminal/add-to-windows-terminal.py'],
    looks: 0, clears: 0, commands: [], writes: [], ...over,
  }
  const no = (why: string) => ({ deny: why })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('theme.set', () => { w.looks += 1; return w.setFails ? no('refused') : { value: w.themeResult as never } })
  on('theme.clear', () => { w.clears += 1; return w.clearFails ? no('cannot clear') : { value: { isDrawn: false, reason: 'cleared' } } })
  on('command.register', (_: unknown, e: any) => { w.commands.push(String(e.name)); return w.commandFails ? no('no') : { value: { command: e.name } } })
  on('store.get', (_: unknown, e: any) => (w.store === 'broken' ? no('store unreadable') : { value: w.store[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    if (w.store === 'broken' || w.storeWritesFail) return no('store unwritable')
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: any) => {
    if (w.store === 'broken' || w.storeWritesFail) return no('store unwritable')
    delete w.store[e.key]
    return { value: undefined }
  })
  on('session.info', () => (w.platform === 'throw' ? no('no info') : { value: { platform: w.platform } as never }))
  on('settings.read', () => (w.language === undefined ? no('unset') : { value: { language: w.language } as never }))
  on('session.version', () => (w.version === 'throw' ? no('no version') : { value: { version: w.version, base: w.version } }))
  on('process.run', (_: unknown, e: any) => (e.argv?.[0] === 'claude' && w.cliVersion !== 'none'
    ? { value: { exitCode: 0, stdout: `${w.cliVersion}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    : no('not available')))
  on('fs.exists', (_: unknown, e: any) => ({ value: w.files.some(f => String(e.path).replace(/\\/g, '/').endsWith(f)) }))
  on('fs.write', (_: unknown, e: any) => { w.writes.push(String(e.path)); return { value: undefined } })
  return w
}

const start = ($: any, surface: 'desktop' | 'terminal' = 'desktop') => $.session.start({ cwd: '/w', surface, isInteractive: true } as never)
const graphite = async ($: any, args: string): Promise<string> => {
  const out: any = await $.command.run({ command: 'graphite', args } as never)
  return String(out?.text ?? '')
}
const BACKDROP = {
  plugin: 'kit-graphite', component: 'Backdrop', requestId: 'backdrop', surface: 'desktop',
  props: { scene: 'kit-graphite-waves', plugin: 'kit-graphite', glass: { blur: 0, opacity: 0.45 } },
} as const
const line = (lines: string[], name: string) => lines.find(l => l.split(' ')[1] === name) ?? ''

test('default is on: a fresh store sets the look and registers /graphite', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.looks).toBe(1)
  expect(w.commands).toEqual(['graphite'])
  expect(await graphite($, 'status')).toBe('Graphite is on.')
  expect(await graphite($, '')).toBe('Graphite is on.')
})

test('off is remembered across sessions: the next session sets no theme, and the backdrop steps aside', async ($, on) => {
  const w = engine(on, { store: { enabled: false } })
  await start($)
  expect(w.looks).toBe(0)
  expect(await graphite($, 'status')).toBe('Graphite is off.')
  const ui = await $.ui.mount(BACKDROP as never)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('/graphite off clears the look at once, saves the choice, and says so in plain English', async ($, on) => {
  const w = engine(on)
  await start($)
  const reply = await graphite($, 'off')
  expect(reply).toBe("Graphite is off. Claude's default look is back.")
  expect(w.clears).toBe(1)
  expect(w.store).toEqual({ enabled: false })
  expect(await graphite($, 'status')).toBe('Graphite is off.')
  const ui = await $.ui.mount(BACKDROP as never)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('/graphite off when the look cannot be cleared this session says it takes effect from the next one', async ($, on) => {
  const w = engine(on, { clearFails: true })
  await start($)
  expect(await graphite($, 'off')).toBe("Graphite is off. Claude's default look from the next session.")
  expect(w.store).toEqual({ enabled: false })
})

test('/graphite off in a session that never set the look needs nothing cleared', async ($, on) => {
  const w = engine(on, { store: { enabled: false } })
  await start($)
  expect(await graphite($, 'off')).toBe("Graphite is already off. Claude's default look shows.")
  expect(w.clears).toBe(0)
})

test('/graphite on sets the look again and forgets the off choice', async ($, on) => {
  const w = engine(on, { store: { enabled: false } })
  await start($)
  expect(w.looks).toBe(0)
  expect(await graphite($, 'on')).toBe('Graphite is on.')
  expect(w.looks).toBe(1)
  expect(w.store).toEqual({})
  const ui = await $.ui.mount(BACKDROP as never)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('/graphite on with a Claude Code that refuses the theme says from the next session, without an error', async ($, on) => {
  engine(on, { store: { enabled: false }, setFails: true })
  await start($)
  expect(await graphite($, 'on')).toBe('Graphite is on from the next session.')
})

test('a store that cannot be read stays on, quietly', async ($, on) => {
  const w = engine(on, { store: 'broken' })
  await start($)
  expect(w.looks).toBe(1)
  expect(await graphite($, 'status')).toContain('Graphite is on.')
  const ui = await $.ui.mount(BACKDROP as never)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('a store that cannot be written still turns Graphite off for this session and says the choice was not saved', async ($, on) => {
  const w = engine(on, { storeWritesFail: true })
  await start($)
  const reply = await graphite($, 'off')
  expect(reply).toContain('Graphite is off.')
  expect(reply).toContain('could not be saved')
  expect(w.clears).toBe(1)
  expect(await graphite($, 'status')).toBe('Graphite is off.')
})

test('an unknown argument prints the usage and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(await graphite($, 'blue')).toBe('Usage: /graphite off | /graphite on | /graphite status | /graphite doctor')
  expect(w.store).toEqual({})
  expect(w.clears).toBe(0)
})

test('a failing /graphite command registration does not stop the look', async ($, on) => {
  const w = engine(on, { commandFails: true })
  await start($)
  expect(w.looks).toBe(1)
})

test('doctor helpers: version compare and line format', () => {
  expect(parseVersion('2.1.331 (Claude Code)')).toEqual([2, 1, 331])
  expect(versionAtLeast('2.1.322', MIN_CLAUDE_CODE)).toBe(false)
  expect(versionAtLeast('2.1.323', MIN_CLAUDE_CODE)).toBe(true)
  expect(versionAtLeast('', MIN_CLAUDE_CODE)).toBe(null)
  expect(formatLine({ level: 'WARN', name: 'x', detail: 'a  b', fix: 'do it' })).toBe('WARN x - a b Fix: do it')
  expect(formatLine({ level: 'PASS', name: 'x', detail: 'ok' })).toBe('PASS x - ok')
  expect(summary([{ level: 'PASS', name: 'a', detail: '' }, { level: 'WARN', name: 'b', detail: '' }])).toBe('1 ok, 1 to look at, 0 broken.')
})

test('doctor: everything fine prints PASS lines and a summary, and writes nothing', async ($, on) => {
  const w = engine(on)
  await start($)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(lines.slice(0, -1).map(l => l.split(' ')[1])).toEqual(['claude-code', 'setting', 'theme', 'terminal-image', 'terminal-script'])
  expect(lines.slice(0, -1).every(l => l.startsWith('PASS '))).toBe(true)
  expect(line(lines, 'theme')).toBe('PASS theme - accepted, and an app is drawing it')
  expect(lines.at(-1)).toBe('5 ok, 0 to look at, 0 broken.')
  expect(w.writes).toEqual([])
})

test('doctor claude-code: old is a WARN, the command is the fallback, unknown is a quiet WARN', async ($, on) => {
  const w = engine(on, { version: '2.1.200' })
  await start($)
  expect(line((await graphite($, 'doctor')).split('\n'), 'claude-code')).toMatch(/^WARN claude-code - Claude Code 2\.1\.200 is older than 2\.1\.323.* Fix: Update/)
  w.version = 'throw'
  expect(line((await graphite($, 'doctor')).split('\n'), 'claude-code')).toMatch(/^PASS claude-code - Claude Code 2\.1\.331/)
  w.cliVersion = 'none'
  expect(line((await graphite($, 'doctor')).split('\n'), 'claude-code')).toMatch(/^WARN claude-code - could not tell.* Fix: /)
})

test('doctor theme: waiting for an app, nothing drawing (terminal only), refused, and off', async ($, on) => {
  const w = engine(on, { themeResult: { isDrawn: false, requestId: 'backdrop', reason: 'not attached yet' } })
  await start($)
  expect(line((await graphite($, 'doctor')).split('\n'), 'theme')).toMatch(/^PASS theme - accepted; it draws once the desktop or mobile app attaches/)
  await graphite($, 'off')
  expect(line((await graphite($, 'doctor')).split('\n'), 'theme')).toBe('PASS theme - no theme is set, because Graphite is off')
  expect(w.clears).toBe(1)
})

test('doctor theme: a terminal-only session is a WARN with a plain hint', async ($, on) => {
  engine(on, { themeResult: { isDrawn: false, reason: 'no client draws themes' } })
  await start($, 'terminal')
  expect(line((await graphite($, 'doctor')).split('\n'), 'theme')).toMatch(/^WARN theme - accepted, but nothing in this session draws themes.* Fix: Use the desktop or mobile app/)
})

test('doctor theme: a refusal at session start is remembered and reported', async ($, on) => {
  engine(on, { setFails: true })
  await start($)
  expect(line((await graphite($, 'doctor')).split('\n'), 'theme')).toMatch(/^WARN theme - this Claude Code did not accept the theme \(.*refused.*\) Fix: Update Claude Code/)
})

test('doctor setting: an unreadable store is a WARN that says Graphite stays on', async ($, on) => {
  engine(on, { store: 'broken' })
  await start($)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(line(lines, 'setting')).toMatch(/^WARN setting - the saved on\/off choice could not be read, so Graphite stays on Fix: /)
})

test('doctor terminal extras: missing files are a WARN (never a FAIL) and are only looked for, never run', async ($, on) => {
  const w = engine(on, { files: [] })
  await start($)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(line(lines, 'terminal-image')).toMatch(/^WARN terminal-image - terminal\/terminal-backdrop\.png was not found \(optional, only for Windows Terminal\) Fix: /)
  expect(line(lines, 'terminal-script')).toMatch(/^WARN terminal-script - terminal\/add-to-windows-terminal\.py was not found/)
  expect(lines.some(l => l.startsWith('FAIL'))).toBe(false)
  expect(w.writes).toEqual([])
  w.files = ['/terminal/terminal-backdrop.png']
  const again = (await graphite($, 'doctor')).split('\n')
  expect(line(again, 'terminal-image')).toMatch(/^PASS terminal-image/)
  expect(line(again, 'terminal-script')).toMatch(/^WARN/)
})

for (const platform of ['macos', 'linux', 'wsl', 'unknown', 'throw']) {
  test(`doctor terminal extras on ${platform}: not needed (PASS, never WARN), files not even looked for`, async ($, on) => {
    engine(on, { files: [], platform })
    await start($)
    const lines = (await graphite($, 'doctor')).split('\n')
    expect(line(lines, 'terminal-image')).toBe('PASS terminal-image - only used with Windows Terminal; not needed on this system')
    expect(line(lines, 'terminal-script')).toMatch(/^PASS terminal-script - only used with Windows Terminal/)
    expect(lines.some(l => l.startsWith('WARN'))).toBe(false)
  })
}

test('doctor terminal extras on Windows still warn about missing files', async ($, on) => {
  engine(on, { files: [], platform: 'windows' })
  await start($)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(line(lines, 'terminal-image')).toMatch(/^WARN terminal-image/)
})

test('Vietnamese: /graphite status, on, off and doctor follow the language setting', async ($, on) => {
  const w = engine(on, { language: 'Tiếng Việt', files: [], platform: 'linux' })
  await start($)
  expect(await graphite($, 'status')).toBe('Graphite đang bật.')
  expect(await graphite($, 'off')).toBe('Graphite đã tắt. Giao diện mặc định của Claude đã trở lại.')
  expect(await graphite($, 'off')).toMatch(/^Graphite đã tắt từ trước/)
  expect(await graphite($, 'status')).toBe('Graphite đang tắt.')
  expect(await graphite($, 'on')).toBe('Graphite đã bật.')
  expect(await graphite($, 'nope')).toMatch(/^Cách dùng: /)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(line(lines, 'claude-code')).toMatch(/^PASS claude-code - Claude Code 2\.1\.331 \(giao diện cần/)
  expect(line(lines, 'terminal-image')).toBe('PASS terminal-image - chỉ dùng với Windows Terminal; không cần trên hệ thống này')
  expect(lines[lines.length - 1]).toBe('5 ổn, 0 cần xem, 0 lỗi.')
  void w
})

test('Vietnamese doctor: fix hints and the failed-check fallback are translated; check names stay English', async ($, on) => {
  engine(on, { language: 'vi', version: 'throw', cliVersion: 'none', platform: 'windows', files: [] })
  await start($)
  const lines = (await graphite($, 'doctor')).split('\n')
  expect(line(lines, 'claude-code')).toMatch(/^WARN claude-code - không xác định được .* Fix: Chạy claude --version/)
  expect(line(lines, 'terminal-image')).toMatch(/^WARN terminal-image - không thấy .* Fix: Không cần làm gì trừ khi/)
})

test('an unreadable language setting keeps English', async ($, on) => {
  engine(on, { language: undefined })
  await start($)
  expect(await graphite($, 'status')).toBe('Graphite is on.')
})
