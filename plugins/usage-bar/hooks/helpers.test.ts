import { expect, test } from 'claude-code/testing'

import { accountLabel, baseName, colorIndexOf, joinPath, parseLoginEmail, pickHome, placeOf } from './account'
import { STATUS_LINE_ANSWERS, drawsOn, hasStatusLine, readConfig, statusLineFiles, surfacesForAnswer } from './config'
import { MIN_CLAUDE_VERSION, compareVersions, report } from './doctor'
import type { Facts } from './doctor'
import {
  CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, FIVE_HOUR_MS, T, cacheClock, countdown, fitText, forecastPct, forecastStyle, levelColor, paceColor,
  prettyEffort, prettyModel, staleMinutes, toLimit, weekBudget,
} from './format'
import { TABLES, en, languageFromSetting, vi } from './i18n'
import { hookErrors, isSessionId, lastCacheStamp, lastTitle, projectSlug, transcriptEmail } from './transcript'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

test('model ids read as their names', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-20260101')).toBe('Sonnet 5')
  expect(prettyModel('claude-haiku-5-5-20261001')).toBe('Haiku 5.5')
  expect(prettyModel('some-gateway/model-x')).toBe('some-gateway/model-x')
  expect(prettyModel('')).toBe('')
})

test('effort: a level is upper-cased, a number is a budget, anything else is none', () => {
  expect(prettyEffort('xhigh')).toBe('XHIGH')
  expect(prettyEffort(' high ')).toBe('HIGH')
  expect(prettyEffort(16000)).toBe('16K')
  expect(prettyEffort(12500)).toBe('12.5K')
  expect(prettyEffort(800)).toBe('800')
  expect(prettyEffort(0)).toBe(null)
  expect(prettyEffort(NaN)).toBe(null)
  expect(prettyEffort('')).toBe(null)
  expect(prettyEffort(undefined)).toBe(null)
})

test('countdowns and level colors follow the CLI status line', () => {
  expect(countdown(NOW + 45 * 60_000, NOW)).toBe('45m')
  expect(countdown(NOW + 133 * 60_000, NOW)).toBe('2h13m')
  expect(countdown(NOW + 8 * 3_600_000, NOW)).toBe('8h')
  expect(countdown(NOW + (3 * 24 + 3) * 3_600_000, NOW)).toBe('3d03h')
  expect(countdown(NOW - 1, NOW)).toBe(null)
  expect(countdown(null, NOW)).toBe(null)
  expect(levelColor(50, '#000000')).toBe('#000000')
  expect(levelColor(75, '#000000')).toBe('#e0af68')
  expect(levelColor(95, '#000000')).toBe('#ffa3b5')
  expect(levelColor(null, '#000000')).toBe('#8a93bd')
})

test('the weekly budget steps per day, current day included, and 14 is the default', () => {
  expect(weekBudget(NOW + 6.5 * DAY, NOW)).toBe(14)
  expect(weekBudget(NOW + 5.58 * DAY, NOW)).toBe(28)
  expect(weekBudget(NOW + 5 * DAY, NOW)).toBe(42)
  expect(weekBudget(NOW + 0.5 * DAY, NOW)).toBe(98)
  expect(weekBudget(NOW - DAY, NOW)).toBe(98)
  expect(weekBudget(null, NOW)).toBe(null)
})

test('weeklyBudgetPerDay: another step, capped at 100, and 0 or less hides the budget', () => {
  expect(weekBudget(NOW + 6.5 * DAY, NOW, 10)).toBe(10)
  expect(weekBudget(NOW + 5.58 * DAY, NOW, 10)).toBe(20)
  expect(weekBudget(NOW + 0.5 * DAY, NOW, 20)).toBe(100)
  expect(weekBudget(NOW + 2 * DAY, NOW, 0)).toBe(null)
  expect(weekBudget(NOW + 2 * DAY, NOW, -5)).toBe(null)
  expect(weekBudget(NOW + 2 * DAY, NOW, NaN)).toBe(null)
})

test('pace colors: on budget keeps the accent, over is yellow, a day over is red', () => {
  expect(paceColor(20, 28, '#000000')).toBe('#000000')
  expect(paceColor(30, 28, '#000000')).toBe('#e0af68')
  expect(paceColor(45, 28, '#000000')).toBe('#ffa3b5')
  expect(paceColor(95, 98, '#000000')).toBe('#ffa3b5')
  expect(paceColor(30, null, '#000000')).toBe('#000000')
  // a "day" is the configured per-day step
  expect(paceColor(45, 28, '#000000', 20)).toBe('#e0af68')
  expect(paceColor(48, 28, '#000000', 20)).toBe('#ffa3b5')
})

test('rate limits: a reading becomes percent and reset time; no reading is none', () => {
  const at = new Date(NOW).toISOString()
  expect(toLimit([{ kind: 'five_hour', percentUsed: 61.4, resetsAt: at }] as never, 'five_hour')).toEqual({ pct: 61, resetsAt: NOW })
  expect(toLimit([{ kind: 'five_hour', percentUsed: 10 }] as never, 'five_hour')).toEqual({ pct: 10, resetsAt: null })
  expect(toLimit([], 'seven_day')).toEqual({ pct: null, resetsAt: null })
})

test('fitText keeps one line and cuts a long one with an ellipsis; no room is no text', () => {
  expect(fitText('short', 40)).toBe('short')
  expect(fitText('a  b\n c', 40)).toBe('a b c')
  expect(fitText('abcdefghij', 6)).toBe('abcde…')
  expect(fitText('abcdefghij', 10)).toBe('abcdefghij')
  expect(fitText('abcdefghij', 3)).toBe('')
  expect(fitText('abcdefghij', Infinity)).toBe('abcdefghij')
  expect(fitText('', 20)).toBe('')
})

test('account label: the config folder\'s name, Windows and POSIX, with or without a trailing slash', () => {
  const table: Array<[string, string]> = [
    ['/home/ann/.claude', 'default'],
    ['/home/ann/.claude/', 'default'],
    ['C:\\Users\\Ann\\.claude', 'default'],
    ['C:\\Users\\Ann\\.claude\\', 'default'],
    ['C:\\Users\\Ann\\.Claude', 'default'],
    ['/home/ann/.claude-work', 'work'],
    ['/home/ann/.claude-work/', 'work'],
    ['C:\\Users\\Ann\\.claude-work\\', 'work'],
    ['C:\\Users\\Ann\\.claude-acc2', 'acc2'],
    ['/Users/ann/.claude-acc2//', 'acc2'],
    ['/Users/ann/.claude-Team-A', 'Team-A'],
    ['/srv/ai/team-a', 'team-a'],
    ['D:\\ai\\profiles\\research\\', 'research'],
    ['/home/ann/.myclaude', 'myclaude'],
    ['/home/ann/claude-home', 'claude-home'],
    ['/', 'default'],
    ['', 'default'],
  ]
  for (const [dir, label] of table) expect(accountLabel(dir)).toBe(label)
})

test('account color: default is orange (slot 0), any other label a stable slot from 1 to 7', () => {
  expect(colorIndexOf('default')).toBe(0)
  expect(colorIndexOf('work')).toBe(2)
  expect(colorIndexOf('acc2')).toBe(4)
  expect(colorIndexOf('acc1')).toBe(5)
  expect(colorIndexOf('work')).toBe(colorIndexOf('work'))
  for (const label of ['a', 'b', 'work', 'client', 'team-a', 'x'.repeat(300), 'Ünï']) {
    const i = colorIndexOf(label)
    expect(i).toBeGreaterThanOrEqual(1)
    expect(i).toBeLessThanOrEqual(7)
  }
})

test('config directory: CLAUDE_CONFIG_DIR, else <home>/.claude; the login record beside it', () => {
  expect(placeOf('/data/cfg-work', '/home/ann', undefined)).toEqual({
    configDir: '/data/cfg-work', loginFile: '/data/cfg-work/.claude.json', isCustom: true,
  })
  expect(placeOf('/data/cfg-work/', '/home/ann', undefined).loginFile).toBe('/data/cfg-work/.claude.json')
  expect(placeOf(undefined, '/home/ann', undefined)).toEqual({
    configDir: '/home/ann/.claude', loginFile: '/home/ann/.claude.json', isCustom: false,
  })
  expect(placeOf('  ', '/home/ann/', undefined).configDir).toBe('/home/ann/.claude')
  expect(placeOf(undefined, undefined, 'C:\\Users\\Ann')).toEqual({
    configDir: 'C:\\Users\\Ann/.claude', loginFile: 'C:\\Users\\Ann/.claude.json', isCustom: false,
  })
  expect(placeOf(undefined, undefined, undefined)).toEqual({ configDir: '', loginFile: '', isCustom: false })
})

test('home: USERPROFILE on Windows (HOME may be a Git Bash path), HOME elsewhere', () => {
  expect(pickHome('/c/Users/Ann', 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann')
  expect(pickHome('C:\\Users\\Ann', 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann')
  expect(pickHome('/home/ann', undefined)).toBe('/home/ann')
  expect(pickHome(undefined, 'C:\\Users\\Ann')).toBe('C:\\Users\\Ann')
  expect(pickHome(undefined, undefined)).toBe('')
  expect(baseName('C:\\Users\\Ann\\notes\\')).toBe('notes')
  expect(baseName('/home/ann/notes')).toBe('notes')
  expect(joinPath('C:\\x\\', 'a', 'b')).toBe('C:\\x/a/b')
})

test('login record: oauthAccount.emailAddress; missing field, invalid JSON or a non-email is none', () => {
  expect(parseLoginEmail('{"oauthAccount":{"emailAddress":"ann@example.com"}}')).toBe('ann@example.com')
  expect(parseLoginEmail('{"oauthAccount":{}}')).toBe('')
  expect(parseLoginEmail('{"userID":"u1"}')).toBe('')
  expect(parseLoginEmail('{"oauthAccount":{"emailAddress":42}}')).toBe('')
  expect(parseLoginEmail('{"oauthAccount":{"emailAddress":"not an email"}}')).toBe('')
  expect(parseLoginEmail('{ nope')).toBe('')
  expect(parseLoginEmail('')).toBe('')
  expect(parseLoginEmail('null')).toBe('')
})

test('options: defaults, and a bad value falls back to the default', () => {
  expect(readConfig({})).toEqual({
    surfaces: 'auto', language: 'auto', weeklyBudgetPerDay: 14, showEmail: true, showTitle: true, showLimits: true,
    showHookErrors: true, showCacheClock: true, showForecast: true, maxTranscriptMB: 8,
  })
  expect(readConfig(undefined).weeklyBudgetPerDay).toBe(14)
  expect(readConfig({ surfaces: 'desktop+terminal' }).surfaces).toBe('desktop+terminal')
  expect(readConfig({ surfaces: 'desktop' }).surfaces).toBe('desktop')
  expect(readConfig({ surfaces: 'everywhere' }).surfaces).toBe('auto')
  expect(readConfig({ weeklyBudgetPerDay: 0 }).weeklyBudgetPerDay).toBe(0)
  expect(readConfig({ weeklyBudgetPerDay: 'lots' }).weeklyBudgetPerDay).toBe(14)
  expect(readConfig({ showEmail: false, showTitle: false, showLimits: false })).toMatchObject({
    showEmail: false, showTitle: false, showLimits: false,
  })
  expect(readConfig({ maxTranscriptMB: 0 }).maxTranscriptMB).toBe(1)
  expect(readConfig({ maxTranscriptMB: 2 }).maxTranscriptMB).toBe(2)
})

test('surfaces: the desktop and mobile apps always, the terminal only on desktop+terminal, nothing else', () => {
  const desktopOnly = readConfig({ surfaces: 'desktop' })
  const both = readConfig({ surfaces: 'desktop+terminal' })
  expect(drawsOn(desktopOnly, 'desktop')).toBe(true)
  expect(drawsOn(desktopOnly, 'terminal')).toBe(false)
  expect(drawsOn(both, 'desktop')).toBe(true)
  expect(drawsOn(both, 'terminal')).toBe(true)
  expect(drawsOn(desktopOnly, 'mobile')).toBe(true)
  // VS Code draws no band above the prompt at all (the engine raises AbovePrompt on terminal, desktop, mobile).
  for (const surface of ['vscode', 'something-new']) {
    expect(drawsOn(both, surface)).toBe(false)
  }
})

test('transcript slug and session ids', () => {
  expect(projectSlug('/home/ann/my project')).toBe('-home-ann-my-project')
  expect(projectSlug('C:\\Users\\Ann\\notes')).toBe('C--Users-Ann-notes')
  expect(isSessionId('0f9e8d7c-1111-4222-8333-444455556666')).toBe(true)
  expect(isSessionId('../../etc/passwd')).toBe(false)
  expect(isSessionId('abc')).toBe(false)
})

const row = (o: object) => `${JSON.stringify(o)}\n`

test('title: a rename beats the automatic title, the latest of each wins', () => {
  const text = row({ type: 'user', message: { content: 'hi' } }) + row({ type: 'ai-title', aiTitle: 'Old auto' })
    + row({ type: 'custom-title', customTitle: 'First rename' }) + row({ type: 'ai-title', aiTitle: 'New auto' })
    + row({ type: 'custom-title', customTitle: 'Second rename' })
  expect(lastTitle(text)).toBe('Second rename')
  expect(lastTitle(row({ type: 'ai-title', aiTitle: 'Old' }) + row({ type: 'ai-title', aiTitle: 'New' }))).toBe('New')
})

test('title: no entries is no title', () => {
  expect(lastTitle(row({ type: 'user', message: { content: 'hello' } }))).toBe('')
  expect(lastTitle('')).toBe('')
  expect(lastTitle(row({ type: 'ai-title', aiTitle: '  ' }))).toBe('')
})

test('title: text quoting an entry inside a message (escaped) never counts', () => {
  const quoted = row({ type: 'user', message: { content: 'see {"type":"ai-title","aiTitle":"Quoted"} and {"type":"custom-title","customTitle":"Fake"}' } })
  expect(quoted).toContain('\\"type\\":\\"ai-title\\"')
  expect(lastTitle(quoted)).toBe('')
  expect(lastTitle(row({ type: 'ai-title', aiTitle: 'Real' }) + quoted)).toBe('Real')
})

test('title: an entry cut short is skipped for the one before it', () => {
  expect(lastTitle(`${row({ type: 'ai-title', aiTitle: 'Whole' })}{"type":"ai-title","aiTitle":"Cu`)).toBe('Whole')
})

test('email: the session context\'s own address; quoted text and a missing key give none', () => {
  const ctx = row({ attachment: { userEmail: 'The user\'s email address is ann@example.com. Use it.' } })
  expect(transcriptEmail(ctx)).toBe('ann@example.com')
  expect(transcriptEmail(row({ type: 'user', message: { content: '"userEmail":"The user\'s email address is fake@example.com."' } }))).toBe('')
  expect(transcriptEmail(row({ type: 'user' }))).toBe('')
})

test('surfaces: auto draws in the terminal only without a status line; desktop and mobile always; unknown never', () => {
  const auto = readConfig({})
  expect(drawsOn(auto, 'desktop', true)).toBe(true)
  expect(drawsOn(auto, 'terminal', false)).toBe(true)
  expect(drawsOn(auto, 'terminal', true)).toBe(false)
  expect(drawsOn(readConfig({ surfaces: 'desktop' }), 'terminal', false)).toBe(false)
  expect(drawsOn(readConfig({ surfaces: 'desktop+terminal' }), 'terminal', true)).toBe(true)
  expect(drawsOn(auto, 'mobile', true)).toBe(true)
  expect(drawsOn(auto, 'vscode', false)).toBe(false)
})

test('a status line counts only when a settings file sets a command', () => {
  expect(hasStatusLine('{"statusLine":{"type":"command","command":"node ~/.claude/statusline.mjs"}}')).toBe(true)
  expect(hasStatusLine('\uFEFF{"statusLine":{"command":"x"}}')).toBe(true)
  expect(hasStatusLine('{"statusLine":{"type":"command","command":"  "}}')).toBe(false)
  expect(hasStatusLine('{"statusLine":null}')).toBe(false)
  expect(hasStatusLine('{"model":"opus"}')).toBe(false)
  expect(hasStatusLine('{ broken')).toBe(false)
  expect(hasStatusLine('')).toBe(false)
  expect(statusLineFiles('C:\\Users\\ann\\.claude\\', 'C:\\work\\notes')).toEqual([
    'C:\\Users\\ann\\.claude/settings.json', 'C:\\work\\notes/.claude/settings.json', 'C:\\work\\notes/.claude/settings.local.json',
  ])
})

// ---------- hook failures ----------
const failure = (o: object, type = 'hook_non_blocking_error') => row({ type: 'attachment', attachment: { type, ...o }, timestamp: '2026-11-12T08:00:00Z' })
const STOP = { hookName: 'Stop', command: 'bash scripts/x.sh', stderr: 'Failed with non-blocking status code: bash: scripts/x.sh: No such file or directory' }

test('hook failures: none in a transcript without any', () => {
  expect(hookErrors('')).toEqual({ count: 0, last: null })
  expect(hookErrors(row({ type: 'user', message: { content: 'hello' } }) + row({ type: 'attachment', attachment: { type: 'hook_success' } }))).toEqual({ count: 0, last: null })
})

test('hook failures: one failure gives the hook, the command and the reason without the status prefix', () => {
  expect(hookErrors(row({ type: 'user' }) + failure(STOP))).toEqual({
    count: 1,
    last: { hook: 'Stop', command: 'bash scripts/x.sh', reason: 'bash: scripts/x.sh: No such file or directory' },
  })
})

test('hook failures: a line packed with keys is read once, fast, and the next line still counts', () => {
  const packed = `{"input":{${Array.from({ length: 40_000 }, (_, i) => `"k${i}":{"type":"hook_non_blocking_error"}`).join(',')}}}`
  const real = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookName: 'Stop', command: 'x', stderr: 'boom' } })
  const started = Date.now()
  const out = hookErrors(`${packed}\n${real}\n`)
  expect(Date.now() - started).toBeLessThan(500)
  expect(out.count).toBe(1)
})

test('hook failures: many, of both kinds, are counted and the latest one is reported', () => {
  const text = failure(STOP) + failure({ ...STOP, hookName: 'PreToolUse' }) + row({ type: 'user' })
    + failure({ hookEvent: 'SessionStart', command: 'node gone.js', content: 'Cannot find module\nat line 2' }, 'hook_blocking_error')
  expect(hookErrors(text)).toEqual({ count: 3, last: { hook: 'SessionStart', command: 'node gone.js', reason: 'Cannot find module' } })
})

test('hook failures: a long command and reason are shortened, only the first line of the reason is kept', () => {
  const found = hookErrors(failure({ hookName: 'Stop', command: `node ${'x'.repeat(200)}`, stderr: `\n  ${'y'.repeat(200)}\nsecond line` })).last
  expect(found?.command.length).toBe(60)
  expect(found?.command.endsWith('…')).toBe(true)
  expect(found?.reason.length).toBe(80)
  expect(found?.reason).not.toContain('second')
})

test('hook failures: text quoting an entry inside a message (escaped) never counts', () => {
  const quoted = row({ type: 'user', message: { content: 'see {"type":"hook_non_blocking_error","hookName":"Fake"} and {"type":"hook_blocking_error"}' } })
  expect(quoted).toContain('\\"type\\":\\"hook_non_blocking_error\\"')
  expect(hookErrors(quoted)).toEqual({ count: 0, last: null })
  expect(hookErrors(failure(STOP) + quoted)).toMatchObject({ count: 1, last: { hook: 'Stop' } })
})

test('hook failures: a stack trace shows the line naming the error, not where it was thrown', () => {
  // The shape Claude Code writes when a hook's node script is missing (seen in real transcripts).
  const stderr = "Failed with non-blocking status code: node:internal/modules/cjs/loader:1568\r\n  throw err;\r\n  ^\r\n\r\nError: Cannot find module 'x/guard.mjs'\r\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)"
  expect(hookErrors(failure({ hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', stderr })).last)
    .toEqual({ hook: 'PreToolUse:Bash', command: '', reason: "Error: Cannot find module 'x/guard.mjs'" })
})

test('hook failures: a line cut short or that is not such an entry is skipped; missing fields read as empty', () => {
  const cut = '{"type":"attachment","attachment":{"type":"hook_non_blocking_error","hookName":"Cu'
  expect(hookErrors(failure(STOP) + cut)).toMatchObject({ count: 1, last: { hook: 'Stop' } })
  expect(hookErrors(cut)).toEqual({ count: 0, last: null })
  expect(hookErrors(row({ type: 'user', data: { type: 'hook_non_blocking_error' } }))).toEqual({ count: 0, last: null })
  expect(hookErrors(failure({}))).toEqual({ count: 1, last: { hook: '', command: '', reason: '' } })
})

// ---------- language ----------
test('options: language and showHookErrors', () => {
  expect(readConfig({}).language).toBe('auto')
  expect(readConfig({ language: 'vi' }).language).toBe('vi')
  expect(readConfig({ language: 'en' }).language).toBe('en')
  expect(readConfig({ language: 'fr' }).language).toBe('auto')
  expect(readConfig({}).showHookErrors).toBe(true)
  expect(readConfig({ showHookErrors: false }).showHookErrors).toBe(false)
})

test('language setting: Vietnamese in its usual spellings is vi; anything else, or no text, is en', () => {
  for (const v of ['vi', 'VI', 'vi-VN', 'vi_VN', 'Vietnamese', 'vietnamese', 'Tiếng Việt', ' tiếng  việt ', 'Viet']) {
    expect(languageFromSetting(v)).toBe('vi')
  }
  for (const v of ['en', 'English', 'japanese', 'visual', 'vim', '', undefined, null, 5, {}]) {
    expect(languageFromSetting(v)).toBe('en')
  }
})

test('both languages have the same keys, every word is translated', () => {
  expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort())
  expect(TABLES.en).toBe(en)
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    if (typeof en[key] !== 'string') continue
    expect(vi[key]).not.toBe('')
    expect(vi[key]).not.toBe(en[key])
  }
  expect(en.hookErrors(1, 'Stop')).toBe('⚠ 1 hook error (Stop)')
  expect(en.hookErrors(3, 'Stop')).toBe('⚠ 3 hook errors (Stop)')
  expect(en.hookErrors(2, '')).toBe('⚠ 2 hook errors')
  expect(vi.hookErrors(3, 'Stop')).toBe('⚠ 3 lỗi hook (Stop)')
  expect(vi.hookToast({ hook: 'Stop', command: 'bash x.sh', reason: 'not found' })).toBe('Hook Stop lỗi · bash x.sh · not found')
})

test('the status line answers are understood in either language', () => {
  expect(surfacesForAnswer(en.answerKeepMine)).toBe('desktop')
  expect(surfacesForAnswer(` ${vi.answerShowBoth} `)).toBe('desktop+terminal')
  expect(surfacesForAnswer(vi.answerKeepMine)).toBe('desktop')
  expect(surfacesForAnswer('something else')).toBe(null)
  expect(STATUS_LINE_ANSWERS.map(a => a.surfaces)).toEqual(['desktop', 'desktop+terminal'])
})

// ---------- cache clock ----------
const MIN = 60_000
const stamp5 = { at: NOW, ttlMs: CACHE_TTL_5M_MS }
const stamp1h = { at: NOW, ttlMs: CACHE_TTL_1H_MS }

test('cache clock: warm counts m:ss when the band redraws every second', () => {
  expect(cacheClock(stamp5, NOW, 1000)).toEqual({ state: 'warm', value: '5:00' })
  expect(cacheClock(stamp5, NOW + 53_000, 1000)).toEqual({ state: 'warm', value: '4:07' })
  expect(cacheClock(stamp5, NOW + 53_500, 1000)).toEqual({ state: 'warm', value: '4:07' })
  expect(cacheClock(stamp5, NOW + 240_000, 1000)).toEqual({ state: 'warm', value: '1:00' })
})

test('cache clock: under 60 s left is flagged low; zero is cold', () => {
  expect(cacheClock(stamp5, NOW + 240_001, 1000)).toEqual({ state: 'low', value: '1:00' })
  expect(cacheClock(stamp5, NOW + 241_000, 1000)).toEqual({ state: 'low', value: '0:59' })
  expect(cacheClock(stamp5, NOW + 299_000, 1000)).toEqual({ state: 'low', value: '0:01' })
  expect(cacheClock(stamp5, NOW + 300_000, 1000)).toEqual({ state: 'cold', value: '' })
  expect(cacheClock(stamp5, NOW + 3_000_000, 1000)).toEqual({ state: 'cold', value: '' })
})

test('cache clock: a 1 hour cache lasts an hour, a 5 minute one five minutes', () => {
  expect(cacheClock(stamp1h, NOW + 10 * MIN, 1000)).toEqual({ state: 'warm', value: '50:00' })
  expect(cacheClock(stamp1h, NOW, 1000)).toEqual({ state: 'warm', value: '60:00' })
  expect(cacheClock(stamp5, NOW + 10 * MIN, 1000)?.state).toBe('cold')
  expect(cacheClock(stamp1h, NOW + 61 * MIN, 1000)?.state).toBe('cold')
})

test('cache clock: with a slower tick it shows whole minutes, never seconds', () => {
  expect(cacheClock(stamp5, NOW + 53_000, 60_000)).toEqual({ state: 'warm', value: '4m' })
  expect(cacheClock(stamp5, NOW + 4 * MIN, 60_000)).toEqual({ state: 'warm', value: '1m' })
  expect(cacheClock(stamp5, NOW + 4 * MIN + 1, 60_000)).toEqual({ state: 'low', value: '<1m' })
  expect(cacheClock(stamp1h, NOW + MIN, 60_000)).toEqual({ state: 'warm', value: '59m' })
  expect(cacheClock(stamp5, NOW + 5 * MIN, 60_000)).toEqual({ state: 'cold', value: '' })
  expect(cacheClock(stamp5, NOW + 53_000, 1001)?.value).toBe('4m')
})

test('cache clock: unknown, bad or future stamps show nothing', () => {
  expect(cacheClock(null, NOW, 1000)).toBe(null)
  expect(cacheClock(undefined, NOW, 1000)).toBe(null)
  expect(cacheClock({ at: NaN, ttlMs: CACHE_TTL_5M_MS }, NOW, 1000)).toBe(null)
  expect(cacheClock({ at: NOW, ttlMs: NaN }, NOW, 1000)).toBe(null)
  expect(cacheClock({ at: NOW, ttlMs: 0 }, NOW, 1000)).toBe(null)
  expect(cacheClock(stamp5, NaN, 1000)).toBe(null)
  expect(cacheClock({ at: NOW + 10 * MIN, ttlMs: CACHE_TTL_5M_MS }, NOW, 1000)).toBe(null)
  // a little clock skew is forgiven and never shows more than the full life
  expect(cacheClock({ at: NOW + 5_000, ttlMs: CACHE_TTL_5M_MS }, NOW, 1000)).toEqual({ state: 'warm', value: '5:00' })
})

// ---------- the transcript's cache stamp ----------
const asst = (o: object = {}, usage: object | null = { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } }) =>
  `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-12T08:00:00.000Z', isSidechain: false, message: { role: 'assistant', usage }, ...o })}\n`
const T0 = Date.parse('2026-11-12T08:00:00.000Z')

const W1H = { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9 }, cache_read_input_tokens: 0 }
const W5M = { cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0 }
const READ = { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 500 }
const IDLE = { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0 }
const T1 = '2026-11-12T09:00:00.000Z'
const T2 = '2026-11-12T10:00:00.000Z'

test('cache stamp: a 1 h write then a read-only reply keeps the 1 h life', () => {
  expect(lastCacheStamp(asst({}, W1H) + asst({ timestamp: T1 }, READ))).toEqual({ at: Date.parse(T1), ttlMs: CACHE_TTL_1H_MS })
  expect(lastCacheStamp(asst({}, W1H) + asst({ timestamp: T1 }, READ) + asst({ timestamp: T2 }, READ))).toEqual({ at: Date.parse(T2), ttlMs: CACHE_TTL_1H_MS })
})

test('cache stamp: a 5 minute write then a read-only reply keeps 5 minutes; a later 1 h write wins', () => {
  expect(lastCacheStamp(asst({}, W5M) + asst({ timestamp: T1 }, READ))).toEqual({ at: Date.parse(T1), ttlMs: CACHE_TTL_5M_MS })
  expect(lastCacheStamp(asst({}, W5M) + asst({ timestamp: T1 }, W1H) + asst({ timestamp: T2 }, READ))).toEqual({ at: Date.parse(T2), ttlMs: CACHE_TTL_1H_MS })
  expect(lastCacheStamp(asst({}, W1H) + asst({ timestamp: T1 }, W5M))).toEqual({ at: Date.parse(T1), ttlMs: CACHE_TTL_5M_MS })
})

test('cache stamp: a read-only or idle reply with no earlier writer is 5 minutes (unknown life)', () => {
  expect(lastCacheStamp(asst({}, READ))).toEqual({ at: T0, ttlMs: CACHE_TTL_5M_MS })
  expect(lastCacheStamp(asst({}, IDLE))).toEqual({ at: T0, ttlMs: CACHE_TTL_5M_MS })
})

test('cache stamp: subagent and synthetic writers do not set the life', () => {
  const side = asst({ isSidechain: true }, W1H)
  const synthetic = asst({ message: { model: '<synthetic>', usage: W1H } })
  expect(lastCacheStamp(side + synthetic + asst({ timestamp: T1 }, READ))).toEqual({ at: Date.parse(T1), ttlMs: CACHE_TTL_5M_MS })
})

test('cache stamp: the last main-thread reply; 5 minutes, or 1 hour when it wrote 1-hour tokens', () => {
  expect(lastCacheStamp(asst())).toEqual({ at: T0, ttlMs: CACHE_TTL_5M_MS })
  expect(lastCacheStamp(asst({}, { cache_creation: { ephemeral_1h_input_tokens: 7 } }))).toEqual({ at: T0, ttlMs: CACHE_TTL_1H_MS })
  const later = asst({ timestamp: '2026-11-12T09:00:00.000Z' })
  expect(lastCacheStamp(asst() + later)?.at).toBe(Date.parse('2026-11-12T09:00:00.000Z'))
})

test('cache stamp: subagent replies, other entries and error stand-ins are skipped', () => {
  const side = asst({ isSidechain: true, timestamp: '2026-11-12T10:00:00.000Z' })
  const user = `${JSON.stringify({ type: 'user', timestamp: '2026-11-12T11:00:00.000Z' })}\n`
  const synthetic = asst({ timestamp: '2026-11-12T12:00:00.000Z', message: { model: '<synthetic>', usage: { cache_creation: { ephemeral_1h_input_tokens: 0 } } } })
  expect(lastCacheStamp(asst() + side + user + synthetic)?.at).toBe(T0)
  expect(lastCacheStamp(side + user)).toBe(null)
  expect(lastCacheStamp('')).toBe(null)
})

test('cache stamp: a field missing from the last reply is unknown, never an earlier reply', () => {
  const noTime = asst({ timestamp: undefined })
  const badTime = asst({ timestamp: 'yesterday' })
  expect(lastCacheStamp(asst() + noTime)).toBe(null)
  expect(lastCacheStamp(asst() + badTime)).toBe(null)
  expect(lastCacheStamp(asst() + asst({}, null))).toBe(null)
  expect(lastCacheStamp(asst() + asst({}, {}))).toBe(null)
  expect(lastCacheStamp(asst() + asst({}, { cache_creation: {} }))).toBe(null)
  expect(lastCacheStamp(asst() + asst({}, { cache_creation: { ephemeral_1h_input_tokens: 'many' } }))).toBe(null)
})

test('cache stamp: a cut line is skipped, quoted text never counts, a huge pile of lines stays bounded', () => {
  expect(lastCacheStamp(`${asst()}{"type":"assistant","timestamp":"2026-11-12T`)).toEqual({ at: T0, ttlMs: CACHE_TTL_5M_MS })
  const quoted = `${JSON.stringify({ type: 'user', message: { content: '{"type":"assistant","timestamp":"2030-01-01T00:00:00Z"}' } })}\n`
  expect(quoted).toContain('\\"type\\":\\"assistant\\"')
  expect(lastCacheStamp(quoted)).toBe(null)
  expect(lastCacheStamp(asst() + quoted)?.at).toBe(T0)
  const cut = '{"type":"assistant","isSidechain":true,\n'.repeat(5000)
  expect(lastCacheStamp(asst() + cut)).toBe(null)
})

// ---------- 5H forecast ----------
const FIVE = FIVE_HOUR_MS
// a window of which `fraction` has passed
const at = (fraction: number) => ({ resetsAt: NOW + Math.round(FIVE * (1 - fraction)), nowMs: NOW })

test('forecast: pct divided by the share of the window gone, rounded', () => {
  expect(forecastPct(30, at(0.5).resetsAt, NOW)).toBe(60)
  expect(forecastPct(20, at(0.25).resetsAt, NOW)).toBe(80)
  expect(forecastPct(10, at(0.3).resetsAt, NOW)).toBe(33)
  expect(forecastPct(10, at(0.6).resetsAt, NOW)).toBe(17)
  expect(forecastPct(50, at(1).resetsAt, NOW)).toBe(50)
})

test('forecast: nothing before a tenth of the window has passed', () => {
  expect(forecastPct(5, at(0.0999).resetsAt, NOW)).toBe(null)
  expect(forecastPct(5, at(0.1).resetsAt, NOW)).toBe(50)
  expect(forecastPct(5, at(0.05).resetsAt, NOW)).toBe(null)
  expect(forecastPct(5, at(0).resetsAt, NOW)).toBe(null)
})

test('forecast: missing, empty or impossible data shows nothing', () => {
  expect(forecastPct(null, at(0.5).resetsAt, NOW)).toBe(null)
  expect(forecastPct(30, null, NOW)).toBe(null)
  expect(forecastPct(0, at(0.5).resetsAt, NOW)).toBe(null)
  expect(forecastPct(-3, at(0.5).resetsAt, NOW)).toBe(null)
  expect(forecastPct(NaN, at(0.5).resetsAt, NOW)).toBe(null)
  expect(forecastPct(30, NaN, NOW)).toBe(null)
  expect(forecastPct(30, at(0.5).resetsAt, NaN)).toBe(null)
  expect(forecastPct(30, NOW - 1000, NOW)).toBe(null) // the window is over
  expect(forecastPct(30, NOW + 6 * 3_600_000, NOW)).toBe(null) // reset further away than a window
})

test('forecast: absurd values are clamped', () => {
  expect(forecastPct(100, at(0.1).resetsAt, NOW)).toBe(999)
  expect(forecastPct(1e9, at(0.5).resetsAt, NOW)).toBe(999)
})

test('forecast: calm below 80, yellow from 80, bold red from 100', () => {
  expect(forecastStyle(79)).toEqual({ color: T.comment, bold: false })
  expect(forecastStyle(80)).toEqual({ color: T.yellow, bold: false })
  expect(forecastStyle(99)).toEqual({ color: T.yellow, bold: false })
  expect(forecastStyle(100)).toEqual({ color: T.red, bold: true })
  expect(forecastStyle(250)).toEqual({ color: T.red, bold: true })
})

// ---------- stale limits ----------
test('stale: exactly 5 minutes is not stale; past it the whole minutes show (a turn ran after the refresh)', () => {
  const at = (age: number) => staleMinutes(NOW - age, NOW - age + 1000, NOW)
  expect(at(5 * MIN)).toBe(null)
  expect(at(5 * MIN + 1)).toBe(5)
  expect(at(6 * MIN)).toBe(6)
  expect(at(6 * MIN + 59_000)).toBe(6)
  expect(at(125 * MIN)).toBe(125)
})

test('stale: an unknown refresh time, a future one or junk is not stale', () => {
  expect(staleMinutes(null, NOW, NOW)).toBe(null)
  expect(staleMinutes(undefined, NOW, NOW)).toBe(null)
  expect(staleMinutes(NaN, NOW, NOW)).toBe(null)
  expect(staleMinutes(NOW + MIN, NOW + 2 * MIN, NOW)).toBe(null)
  expect(staleMinutes(NOW - 9 * MIN, NOW - 8 * MIN, NaN)).toBe(null)
})

test('stale: idle with no turn since the refresh is never stale, however long', () => {
  expect(staleMinutes(NOW - 10 * MIN, null, NOW)).toBe(null)
  expect(staleMinutes(NOW - 600 * MIN, undefined, NOW)).toBe(null)
})

test('stale: a turn after the refresh and over 5 minutes is stale', () => {
  expect(staleMinutes(NOW - 6 * MIN, NOW - 2 * MIN, NOW)).toBe(6)
  expect(staleMinutes(NOW - 4 * MIN, NOW - 2 * MIN, NOW)).toBe(null)
})

test('stale: a turn before (or at) the refresh is not stale; a junk turn time is not either', () => {
  expect(staleMinutes(NOW - 6 * MIN, NOW - 7 * MIN, NOW)).toBe(null)
  expect(staleMinutes(NOW - 6 * MIN, NOW - 6 * MIN, NOW)).toBe(null)
  expect(staleMinutes(NOW - 6 * MIN, NaN, NOW)).toBe(null)
})

test('options: showCacheClock and showForecast are on unless set to false', () => {
  expect(readConfig({})).toMatchObject({ showCacheClock: true, showForecast: true })
  expect(readConfig({ showCacheClock: false, showForecast: false })).toMatchObject({ showCacheClock: false, showForecast: false })
  expect(readConfig({ showCacheClock: 'no', showForecast: 0 })).toMatchObject({ showCacheClock: true, showForecast: true })
})

test('words: the stale marker and the cold cache in both languages', () => {
  expect(en.stale(6)).toBe('⟳ old 6m')
  expect(vi.stale(6)).toBe('⟳ cũ 6m')
  expect(en.cacheCold).toBe('cache cold')
  expect(vi.cacheCold).toBe('cache nguội')
  expect(Object.keys(vi.command).sort()).toEqual(Object.keys(en.command).sort())
})

// ---------- the doctor ----------
const OK: Facts = {
  version: '2.1.319', node: '22.1.0', transcript: 'ok', surfaces: ['desktop'], statusLine: false, rateData: true,
  label: 'default', fromEnv: false, configFound: true,
}
const ALL_ON = readConfig({})
const names = (lines: string[]) => lines.map(l => l.split(' ')[1])
const lineOf = (lines: string[], name: string) => lines.find(l => l.split(' ')[1] === name) ?? ''

test('doctor: everything fine is six PASS lines in the shared shape', () => {
  const lines = report(OK, ALL_ON, en)
  expect(names(lines)).toEqual(['version', 'node', 'transcript', 'band', 'limits', 'config'])
  for (const l of lines) expect(l).toMatch(/^PASS [a-z]+ - \S/)
  expect(lines.join('\n')).not.toContain('Fix:')
})

test('doctor: versions compare as numbers, a dev suffix is ignored', () => {
  expect(compareVersions('2.1.319', '2.1.275')).toBe(1)
  expect(compareVersions('2.1.275', '2.1.275')).toBe(0)
  expect(compareVersions('2.1.99', '2.1.275')).toBe(-1)
  expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
  expect(compareVersions('2.1.280-dev.20260920', '2.1.275')).toBe(1)
  expect(compareVersions('soon', '2.1.275')).toBe(null)
})

test('doctor: version older than the minimum FAILs, unknown only WARNs quietly', () => {
  const old = lineOf(report({ ...OK, version: '2.0.1' }, ALL_ON, en), 'version')
  expect(old).toMatch(new RegExp(`^FAIL version - Claude Code 2\\.0\\.1 is older than ${MIN_CLAUDE_VERSION}\\. Fix: \\S`))
  expect(lineOf(report({ ...OK, version: MIN_CLAUDE_VERSION }, ALL_ON, en), 'version')).toMatch(/^PASS version/)
  const unknown = lineOf(report({ ...OK, version: null }, ALL_ON, en), 'version')
  expect(unknown).toMatch(/^WARN version - could not tell .* Fix: \S/)
  expect(lineOf(report({ ...OK, version: 'weird' }, ALL_ON, en), 'version')).toMatch(/^WARN version/)
})

test('doctor: no Node is a WARN with a hint, never a FAIL', () => {
  expect(lineOf(report({ ...OK, node: null }, ALL_ON, en), 'node')).toMatch(/^WARN node - Node not found.* Fix: Install Node\.js/)
  expect(lineOf(report(OK, ALL_ON, en), 'node')).toMatch(/^PASS node - Node 22\.1\.0/)
})

test('doctor: transcript PASS, large (needs Node: WARN without it), none WARN, unreadable FAIL', () => {
  expect(lineOf(report(OK, ALL_ON, en), 'transcript')).toMatch(/^PASS transcript/)
  expect(lineOf(report({ ...OK, transcript: 'large' }, ALL_ON, en), 'transcript')).toMatch(/^PASS transcript .*Node helper/)
  expect(lineOf(report({ ...OK, transcript: 'large', node: null }, ALL_ON, en), 'transcript')).toMatch(/^WARN transcript .*Fix:/)
  expect(lineOf(report({ ...OK, transcript: 'none' }, ALL_ON, en), 'transcript')).toMatch(/^WARN transcript - no transcript .*Fix:/)
  expect(lineOf(report({ ...OK, transcript: 'unreadable' }, ALL_ON, en), 'transcript')).toMatch(/^FAIL transcript .*Fix:/)
})

test('doctor: what hides the band is listed, each reason', () => {
  const cfg = readConfig({ surfaces: 'desktop', showLimits: false, showCacheClock: false, showForecast: false, showTitle: false, showEmail: false, showHookErrors: false })
  const l = lineOf(report({ ...OK, surfaces: ['terminal'] }, cfg, en), 'band')
  expect(l).toMatch(/^WARN band - /)
  for (const r of ['surfaces leaves out the terminal', 'showLimits is off', 'showCacheClock is off', 'showForecast is off', 'showTitle is off', 'showEmail is off', 'showHookErrors is off']) expect(l).toContain(r)
  expect(l).toContain('Fix: Change the listed options')
  const sl = lineOf(report({ ...OK, surfaces: ['terminal'], statusLine: true }, ALL_ON, en), 'band')
  expect(sl).toMatch(/^WARN band .*status line/)
  expect(lineOf(report({ ...OK, surfaces: ['terminal'], statusLine: true }, readConfig({ surfaces: 'desktop+terminal' }), en), 'band')).toMatch(/^PASS band/)
  expect(lineOf(report({ ...OK, surfaces: ['terminal', 'desktop'], statusLine: true }, ALL_ON, en), 'band')).toMatch(/^PASS band/)
  expect(lineOf(report(OK, ALL_ON, en), 'band')).toBe('PASS band - the band is drawn on: desktop')
})

test('doctor: no rate-limit data is a PASS with a note; unknown WARNs', () => {
  expect(lineOf(report({ ...OK, rateData: false }, ALL_ON, en), 'limits')).toMatch(/^PASS limits - no rate-limit data yet \(normal with an API key/)
  expect(lineOf(report({ ...OK, rateData: null }, ALL_ON, en), 'limits')).toMatch(/^WARN limits .*Fix:/)
})

test('doctor: the config folder is named by label only, a missing one WARNs', () => {
  expect(lineOf(report({ ...OK, fromEnv: true, label: 'work' }, ALL_ON, en), 'config')).toBe('PASS config - CLAUDE_CONFIG_DIR is set; account label "work"')
  expect(lineOf(report(OK, ALL_ON, en), 'config')).toMatch(/^PASS config - default config folder/)
  expect(lineOf(report({ ...OK, configFound: false }, ALL_ON, en), 'config')).toMatch(/^WARN config .*Fix:/)
})

test('doctor: Vietnamese keeps the status words and the check names', () => {
  const lines = report({ ...OK, version: '2.0.0', node: null }, ALL_ON, vi)
  expect(lines[0]).toMatch(/^FAIL version - Claude Code 2\.0\.0 cũ hơn .* Cách sửa: \S/)
  expect(lines[1]).toMatch(/^WARN node - Không thấy Node.* Cách sửa: /)
  expect(names(lines)).toEqual(['version', 'node', 'transcript', 'band', 'limits', 'config'])
})

test('hook failures: control characters are stripped from the hook, command and reason; a long hook name is cut', () => {
  const row = JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'hook_non_blocking_error', hookName: `St\u001b]0;x\u0007op${'p'.repeat(100)}`,
      command: 'bash \u001b]0;x\u0007 run.sh', stderr: 'Failed with non-blocking status code: \u001b[31mbash: gone: No such file\u001b[0m\u0007',
    },
  })
  const last = hookErrors(`${row}\n`).last
  for (const v of [last?.hook, last?.command, last?.reason]) expect(v).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  expect(last?.hook.length).toBe(40)
  expect(last?.command).toBe('bash ]0;x run.sh')
  expect(last?.reason).toBe('[31mbash: gone: No such file[0m')
})

test('cache clock: busy hides it, whatever the stamp says', () => {
  const stamp = { at: NOW - 400_000, ttlMs: CACHE_TTL_5M_MS }
  expect(cacheClock(stamp, NOW, 1000)?.state).toBe('cold')
  expect(cacheClock(stamp, NOW, 1000, true)).toBe(null)
  expect(cacheClock({ at: NOW - 1000, ttlMs: CACHE_TTL_5M_MS }, NOW, 1000, true)).toBe(null)
  expect(cacheClock({ at: NOW - 1000, ttlMs: CACHE_TTL_5M_MS }, NOW, 1000, false)?.state).toBe('warm')
})
