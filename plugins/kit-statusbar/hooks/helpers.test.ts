import { expect, test } from 'claude-code/testing'

import { accountLabel, baseName, colorIndexOf, joinPath, parseLoginEmail, pickHome, placeOf } from './account'
import { drawsOn, hasStatusLine, readConfig, statusLineFiles } from './config'
import { countdown, fitText, levelColor, paceColor, prettyEffort, prettyModel, toLimit, weekBudget } from './format'
import { isSessionId, lastTitle, projectSlug, transcriptEmail } from './transcript'

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
  expect(levelColor(95, '#000000')).toBe('#f7768e')
  expect(levelColor(null, '#000000')).toBe('#565f89')
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
  expect(paceColor(45, 28, '#000000')).toBe('#f7768e')
  expect(paceColor(95, 98, '#000000')).toBe('#f7768e')
  expect(paceColor(30, null, '#000000')).toBe('#000000')
  // a "day" is the configured per-day step
  expect(paceColor(45, 28, '#000000', 20)).toBe('#e0af68')
  expect(paceColor(48, 28, '#000000', 20)).toBe('#f7768e')
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
    surfaces: 'auto', weeklyBudgetPerDay: 14, showEmail: true, showTitle: true, showLimits: true, maxTranscriptMB: 8,
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

test('surfaces: the desktop always, the terminal only on desktop+terminal, nothing else', () => {
  const desktopOnly = readConfig({ surfaces: 'desktop' })
  const both = readConfig({ surfaces: 'desktop+terminal' })
  expect(drawsOn(desktopOnly, 'desktop')).toBe(true)
  expect(drawsOn(desktopOnly, 'terminal')).toBe(false)
  expect(drawsOn(both, 'desktop')).toBe(true)
  expect(drawsOn(both, 'terminal')).toBe(true)
  for (const surface of ['mobile', 'vscode', 'something-new']) {
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

test('surfaces: auto draws in the terminal only without a status line; desktop always; unknown never', () => {
  const auto = readConfig({})
  expect(drawsOn(auto, 'desktop', true)).toBe(true)
  expect(drawsOn(auto, 'terminal', false)).toBe(true)
  expect(drawsOn(auto, 'terminal', true)).toBe(false)
  expect(drawsOn(readConfig({ surfaces: 'desktop' }), 'terminal', false)).toBe(false)
  expect(drawsOn(readConfig({ surfaces: 'desktop+terminal' }), 'terminal', true)).toBe(true)
  expect(drawsOn(auto, 'mobile', false)).toBe(false)
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
