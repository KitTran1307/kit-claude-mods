import { expect, test } from 'claude-code/testing'

import { MIN_CLAUDE_CODE, countLevels, folderOf, formatLine, lockState, parseVersion, versionAtLeast } from './doctor'
import { TABLES } from './i18n'

const NOW = new Date(2026, 10, 9, 12).getTime()
const FILE = '/home/x/.claude/kit-todos/todos.json'

type Files = Record<string, { text?: string; kind?: 'file' | 'dir' }>
type World = {
  version: 'throw' | string // what session.version answers (full version), or refuse
  cliVersion: 'none' | string // what `claude --version` prints
  node: number | null
  files: Files
  language?: string
  existsFails?: boolean
  cwd?: string | null
  home?: string | null
  writes: string[]
}

function engine(on: any, over: Partial<World> = {}): World {
  const w: World = {
    version: '2.1.331', cliVersion: '2.1.331 (Claude Code)', node: 22,
    files: { '/home/x/.claude/kit-todos': { kind: 'dir' }, [FILE]: { text: '[{"id":"a","text":"A"},{"id":"","text":"bad"}]' } },
    cwd: '/work/app', home: '/home/x', writes: [], ...over,
  }
  const no = (why: string) => ({ deny: why })
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('session.version', () => (w.version === 'throw' ? no('no version') : { value: { version: w.version, base: w.version } }))
  on('process.run', (_: unknown, e: any) => {
    const [cmd] = e.argv ?? []
    if (cmd === 'node') return w.node === null ? no('spawn node ENOENT') : { value: { exitCode: 0, stdout: `${w.node}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'claude') return w.cliVersion === 'none' ? no('spawn claude ENOENT') : { value: { exitCode: 0, stdout: `${w.cliVersion}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return no('not stubbed')
  })
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' && w.home ? w.home : undefined }))
  on('settings.read', () => ({ value: w.language === undefined ? {} : { language: w.language } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: {} }))
  on('session.cwd', () => (w.cwd === null ? no('none') : { value: w.cwd }))
  on('session.repo', () => ({ value: null }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const norm = (p: unknown) => String(p).replace(/\\/g, '/')
  const key = (p: unknown) => Object.keys(w.files).find(k => norm(p).endsWith(k))
  on('fs.exists', (_: unknown, e: any) => w.existsFails ? no('boom') : ({ value: key(e.path) !== undefined }))
  on('fs.read', (_: unknown, e: any) => { const k = key(e.path); return k === undefined ? no('ENOENT') : { value: w.files[k]?.text ?? '' } })
  on('fs.stat', (_: unknown, e: any) => {
    const k = key(e.path)
    return k === undefined ? no('ENOENT') : { value: { kind: w.files[k]?.kind ?? 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.write', (_: unknown, e: any) => { w.writes.push(norm(e.path)); return { value: undefined } })
  return w
}

const doctor = async ($: any): Promise<string[]> => {
  const out: any = await $.command.run({ command: 'todo', args: 'doctor' } as never)
  return String(out?.text ?? '').split('\n')
}
const line = (lines: string[], name: string) => lines.find(l => l.split(' ')[1] === name) ?? ''
const start = ($: any) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

test('doctor helpers: versions, lock rule, line format, folders', () => {
  expect(parseVersion('2.1.331 (Claude Code)')).toEqual([2, 1, 331])
  expect(parseVersion('2.1.280-dev.20260920')).toEqual([2, 1, 280])
  expect(parseVersion('nonsense')).toBe(null)
  expect(versionAtLeast('2.1.331', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.1.275', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.0.999', '2.1.275')).toBe(false)
  expect(versionAtLeast('3.0.0', '2.1.275')).toBe(true)
  expect(versionAtLeast('x', '2.1.275')).toBe(null)
  expect(lockState(null, 1000, 10_000)).toEqual({ state: 'none' })
  expect(lockState({ until: 1000 + 5000 }, 1000, 10_000)).toEqual({ state: 'live', msLeft: 5000 })
  expect(lockState({ until: 1000 - 3000 }, 1000, 10_000)).toEqual({ state: 'stale', msAgo: 3000 })
  expect(lockState({ until: 1000 + 60_000 }, 1000, 10_000).state).toBe('stale')
  expect(formatLine({ level: 'PASS', name: 'a', detail: 'fine', fix: 'ignored' })).toBe('PASS a - fine')
  expect(formatLine({ level: 'WARN', name: 'a', detail: 'odd', fix: 'do this' })).toBe('WARN a - odd Fix: do this')
  expect(countLevels([{ level: 'PASS', name: 'a', detail: '' }, { level: 'FAIL', name: 'b', detail: '' }])).toEqual({ pass: 1, warn: 0, fail: 1 })
  expect(folderOf('/a/b/c.json')).toBe('/a/b')
  expect(folderOf('C:\\a\\c.json')).toBe('C:/a')
  expect(folderOf('c.json')).toBe('')
  expect(MIN_CLAUDE_CODE).toMatch(/^\d+\.\d+\.\d+$/)
})

test('doctor: a healthy setup passes every check, one line each, and ends with a summary', async ($, on) => {
  engine(on)
  await start($)
  const lines = await doctor($)
  expect(lines.slice(0, -1).every(l => /^(PASS|WARN|FAIL) [a-z-]+ - \S/.test(l))).toBe(true)
  expect(lines.slice(0, -1).map(l => l.split(' ')[1])).toEqual(['claude-code', 'node', 'todos-file', 'todos-folder', 'lock', 'memories', 'settings', 'language'])
  expect(lines.filter(l => !l.startsWith('PASS')).length).toBe(1) // only the summary
  expect(line(lines, 'todos-file')).toContain('1 usable task out of 2 entries')
  expect(lines.at(-1)).toBe('8 ok, 0 to look at, 0 broken.')
})

test('doctor: it never writes anything and never prints file contents', async ($, on) => {
  const w = engine(on, { files: { '/home/x/.claude/kit-todos': { kind: 'dir' }, [FILE]: { text: '[{"id":"a","text":"SECRET-TEXT"}]' } } })
  await start($)
  const lines = await doctor($)
  expect(w.writes).toEqual([])
  expect(lines.join('\n')).not.toContain('SECRET-TEXT')
})

test('doctor claude-code: old is WARN, unknown is a quiet WARN, the command is the fallback', async ($, on) => {
  const w = engine(on, { version: '2.0.5' })
  await start($)
  expect(line(await doctor($), 'claude-code')).toMatch(/^WARN claude-code - Claude Code 2\.0\.5 is older than 2\.1\.275.* Fix: Update Claude Code/)
  w.version = 'throw'
  w.cliVersion = '2.1.300 (Claude Code)'
  expect(line(await doctor($), 'claude-code')).toMatch(/^PASS claude-code - Claude Code 2\.1\.300 /)
  w.cliVersion = 'none'
  const unknown = line(await doctor($), 'claude-code')
  expect(unknown).toMatch(/^WARN claude-code - could not tell which Claude Code version.* Fix: /)
  expect(countLevels([])).toEqual({ pass: 0, warn: 0, fail: 0 })
})

test('doctor node: present passes; missing is a WARN that says suggestions turn off, or a PASS when they are off already', async ($, on) => {
  const w = engine(on, { node: null })
  await start($)
  expect(line(await doctor($), 'node')).toMatch(/^WARN node - Node\.js 18 or later was not found, so Claude suggestions are switched off.* Fix: /)
  w.node = 16
  expect(line(await doctor($), 'node')).toMatch(/^WARN node/)
})

test('doctor node: a stale cached "missing" followed by a working probe reports PASS', async ($, on) => {
  const w = engine(on, { node: null })
  await start($)
  expect(line(await doctor($), 'node')).toMatch(/^WARN node/)
  w.node = 22
  expect(line(await doctor($), 'node')).toMatch(/^PASS node/)
  w.node = null
  expect(line(await doctor($), 'node')).toMatch(/^PASS node/) // the fresh answer replaced the cache
})

test('doctor node: with suggestions off, no Node is fine', { options: { allowSuggestions: false } }, async ($, on) => {
  engine(on, { node: null })
  await start($)
  const lines = await doctor($)
  expect(line(lines, 'node')).toMatch(/^PASS node - not needed/)
  expect(line(lines, 'settings')).toMatch(/^WARN settings - turned off: allowSuggestions Fix: /)
})

test('doctor todos-file: missing is an empty list (PASS), unreadable JSON is FAIL, not a list is FAIL', async ($, on) => {
  const w = engine(on, { files: { '/home/x/.claude/kit-todos': { kind: 'dir' } } })
  await start($)
  expect(line(await doctor($), 'todos-file')).toMatch(/^PASS todos-file - .*does not exist yet, which is an empty list$/)
  w.files[FILE] = { text: '[{"id": "a", ' }
  expect(line(await doctor($), 'todos-file')).toMatch(/^FAIL todos-file - .*not valid JSON Fix: /)
  w.files[FILE] = { text: '{"id":"a"}' }
  expect(line(await doctor($), 'todos-file')).toMatch(/^FAIL todos-file - .*not a JSON list.* Fix: /)
  w.files[FILE] = { text: '' }
  expect(line(await doctor($), 'todos-file')).toMatch(/^PASS todos-file - .*0 usable tasks out of 0 entries/)
})

test('doctor todos-file: no home folder is a FAIL that names the option', async ($, on) => {
  engine(on, { home: null })
  await start($)
  const lines = await doctor($)
  expect(line(lines, 'todos-file')).toMatch(/^FAIL todos-file - the home folder is unknown.* Fix: Set the todosFile option/)
  expect(lines.at(-1)).toMatch(/1 broken\.$/)
})

test('doctor todos-folder: a folder passes, a missing one is created later, a file in its place is FAIL', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(line(await doctor($), 'todos-folder')).toMatch(/^PASS todos-folder - .*exists/)
  delete w.files['/home/x/.claude/kit-todos']
  expect(line(await doctor($), 'todos-folder')).toMatch(/^PASS todos-folder - .*does not exist yet; \/todo add creates it/)
  w.files['/home/x/.claude/kit-todos'] = { kind: 'file' }
  expect(line(await doctor($), 'todos-folder')).toMatch(/^FAIL todos-folder - .*is a file, not a folder Fix: /)
})

test('doctor lock: none, live, stale (read-only, never deleted) and an unreadable lock is ignored', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(line(await doctor($), 'lock')).toMatch(/^PASS lock - no lock/)
  w.files[`${FILE}.lock`] = { text: JSON.stringify({ token: 't', until: NOW + 4000 }) }
  expect(line(await doctor($), 'lock')).toMatch(/^PASS lock - another session is changing the list right now \(4s left/)
  w.files[`${FILE}.lock`] = { text: JSON.stringify({ token: 't', until: NOW - 30_000 }) }
  expect(line(await doctor($), 'lock')).toMatch(/^WARN lock - a lock left by a stopped writer ran out 30s ago.* Fix: /)
  w.files[`${FILE}.lock`] = { text: JSON.stringify({ token: 't', until: NOW + 90_000 }) }
  expect(line(await doctor($), 'lock')).toMatch(/^WARN lock - a lock left/)
  w.files[`${FILE}.lock`] = { text: JSON.stringify({ token: '', until: 0 }) }
  expect(line(await doctor($), 'lock')).toMatch(/^PASS lock - no lock/)
  w.files[`${FILE}.lock`] = { text: 'garbage' }
  expect(line(await doctor($), 'lock')).toMatch(/^PASS lock/)
  expect(w.writes).toEqual([])
})

test('doctor memories: counts the config folders that hold memories for this project', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(line(await doctor($), 'memories')).toBe('PASS memories - 0 of 1 config folder has memories for this project')
  w.files['/home/x/.claude/projects/-work-app/memory/MEMORY.md'] = { text: '- [T](t.md) - hook' }
  expect(line(await doctor($), 'memories')).toBe('PASS memories - 1 of 1 config folder has memories for this project')
  w.cwd = null
  expect(line(await doctor($), 'memories')).toMatch(/^WARN memories - the project folder could not be looked up Fix: /)
})

test('doctor memories and settings: switched off options are reported', { options: { showMemories: false, showBand: false } }, async ($, on) => {
  engine(on)
  await start($)
  const lines = await doctor($)
  expect(line(lines, 'memories')).toBe('PASS memories - turned off (showMemories)')
  expect(line(lines, 'settings')).toMatch(/^WARN settings - turned off: showBand, showMemories Fix: /)
})

test('doctor language: shows the language in use, and the lines are Vietnamese in Vietnamese', async ($, on) => {
  engine(on, { language: 'Vietnamese' })
  await start($)
  const lines = await doctor($)
  expect(line(lines, 'language')).toBe('PASS language - Tiếng Việt (tùy chọn: auto)')
  expect(line(lines, 'claude-code')).toContain('cần 2.1.275 trở lên')
  expect(lines.at(-1)).toMatch(/ổn/)
})

test('doctor: the English and Vietnamese tables hold the same doctor keys, and the other subcommands still work', async ($, on) => {
  expect(Object.keys(TABLES.vi.doctor).sort()).toEqual(Object.keys(TABLES.en.doctor).sort())
  engine(on)
  await start($)
  const out: any = await $.command.run({ command: 'todo', args: 'doctor now' } as never)
  expect(String(out.text)).toContain('Usage: /todo')
  const list: any = await $.command.run({ command: 'todo', args: '' } as never)
  expect(String(list.text)).toContain('List file:')
})

test('doctor: a check that cannot run shows the fallback fix, in Vietnamese when the language is Vietnamese', async ($, on) => {
  engine(on, { language: 'vi', existsFails: true })
  await start($)
  const lines = await doctor($)
  expect(lines.some(l => l.endsWith('Fix: Không cần làm gì; không chạy được bước kiểm tra này.'))).toBe(true)
  expect(lines.join('\n')).not.toContain('this check could not run')
})
