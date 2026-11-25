import { expect, test } from 'claude-code/testing'

import {
  AWAY_EVENTS_MAX, QUEUE_MAX, TEXT_MAX, addEvent, addToQueue, awayMinutes, cardEvents, cleanPrompt, clampOption, clockText, countEvents,
  decideDrain, detectPlatform, flag, isCardCompact, isLooking, isNeedsYou, isPerson, NEEDS_LOOKING_MS, isQuiet, oneLine, parseQueueArgs, parseQuietHours, planQueue, playerCommands, psQuote,
  removeById, removeNth, resolveQuestions, shortLine, shouldAlertDone, shouldShowCard, soundFile,
} from './core'
import { TABLES, chooseLanguage, languageFromSetting } from './i18n'
import type { AwayEvent } from '../types'

const MIN = 60_000
const ev = (kind: 'done' | 'question', at: number, text = 'x'): AwayEvent => ({ id: `${kind}${at}`, kind, at, text })

test('number options are whole numbers inside their range, else the default', () => {
  expect(clampOption(20, 5, 0, 3600)).toBe(20)
  expect(clampOption('45', 5, 0, 3600)).toBe(45)
  expect(clampOption(-4, 5, 0, 3600)).toBe(0)
  expect(clampOption(99999, 5, 0, 3600)).toBe(3600)
  expect(clampOption(2.6, 5, 0, 3600)).toBe(3)
  for (const bad of [undefined, null, NaN, Infinity, '', 'abc', {}, []]) expect(clampOption(bad, 7, 0, 10)).toBe(7)
})

test('a boolean option is off only when it says so', () => {
  expect(flag(undefined)).toBe(true)
  expect(flag(false)).toBe(false)
  expect(flag('false')).toBe(false)
  expect(flag('true', false)).toBe(true)
  expect(flag('maybe')).toBe(true)
  expect(flag(undefined, false)).toBe(false)
})

test('quiet hours parse from the usual spellings and ignore the rest', () => {
  expect(parseQuietHours('22:00-07:00')).toEqual({ from: 1320, to: 420 })
  expect(parseQuietHours(' 22 - 7 ')).toEqual({ from: 1320, to: 420 })
  expect(parseQuietHours('22:30 to 06:15')).toEqual({ from: 1350, to: 375 })
  expect(parseQuietHours('13:00–14:30')).toEqual({ from: 780, to: 870 })
  expect(parseQuietHours('00:00-24:00')).toBeNull() // 24:00 is midnight, so from === to: no range
  for (const bad of ['', '   ', 'night', '25:00-07:00', '22:61-07:00', '22:00', '22:00-07:00-09:00', '9:5-10:00', 7, null, undefined]) {
    expect(parseQuietHours(bad)).toBeNull()
  }
  expect(parseQuietHours('08:00-08:00')).toBeNull()
})

test('quiet hours cross midnight and exclude the end minute', () => {
  const night = parseQuietHours('22:00-07:00')
  expect(isQuiet(night, 22 * 60)).toBe(true)
  expect(isQuiet(night, 23 * 60 + 59)).toBe(true)
  expect(isQuiet(night, 0)).toBe(true)
  expect(isQuiet(night, 6 * 60 + 59)).toBe(true)
  expect(isQuiet(night, 7 * 60)).toBe(false)
  expect(isQuiet(night, 12 * 60)).toBe(false)
  expect(isQuiet(night, 22 * 60 - 1)).toBe(false)
  const day = parseQuietHours('13:00-14:30')
  expect(isQuiet(day, 13 * 60)).toBe(true)
  expect(isQuiet(day, 14 * 60 + 29)).toBe(true)
  expect(isQuiet(day, 14 * 60 + 30)).toBe(false)
  expect(isQuiet(day, 12 * 60 + 59)).toBe(false)
  expect(isQuiet(null, 3 * 60)).toBe(false)
})

test('clock text is local HH:MM', () => {
  expect(clockText(new Date(2026, 10, 25, 9, 5).getTime())).toBe('09:05')
  expect(clockText(new Date(2026, 10, 25, 23, 59).getTime())).toBe('23:59')
})

test('a prompt is cleaned of hidden characters, trimmed and capped', () => {
  expect(cleanPrompt('  fix the build  ')).toBe('fix the build')
  expect(cleanPrompt('a\r\nb\rc')).toBe('a\nb\nc')
  expect(cleanPrompt('x\u0000y\u202ez\u200bw')).toBe('xyzw')
  expect(cleanPrompt('tab\there')).toBe('tab\there')
  expect(cleanPrompt('y'.repeat(TEXT_MAX + 50))).toHaveLength(TEXT_MAX + 50) // never cut here: addToQueue refuses it
  expect(cleanPrompt('a\u200d\u200cb')).toBe('a\u200d\u200cb') // joiners are kept (Persian, Indic scripts, emoji)
  expect(cleanPrompt('👨‍👩‍👧')).toBe('👨‍👩‍👧')
  for (const bad of [undefined, null, 5, {}, '', '   \n ']) expect(cleanPrompt(bad)).toBe('')
})

test('one-line text drops markdown marks, joins or cuts, and never splits a character', () => {
  expect(shortLine('## Done: the build passes\nmore text', 80)).toBe('Done: the build passes')
  expect(shortLine('\n\n- **Fixed** the `cart` total', 80)).toBe('Fixed the cart total')
  expect(shortLine('abcdefghij', 5)).toBe('abcd…')
  expect(shortLine('😀'.repeat(10), 4)).toBe('😀😀😀…')
  expect(shortLine(42, 10)).toBe('')
  expect(oneLine('first\n  second\tthird', 80)).toBe('first second third')
  expect(oneLine('a'.repeat(30), 10)).toHaveLength(10)
  expect(oneLine(undefined, 10)).toBe('')
})

test('a finished turn rings only when answered and long enough', () => {
  expect(shouldAlertDone({ reason: 'answer', durationMs: 20_000 }, 20)).toBe(true)
  expect(shouldAlertDone({ reason: 'answer', durationMs: 19_999 }, 20)).toBe(false)
  expect(shouldAlertDone({ reason: 'answer', durationMs: 0 }, 0)).toBe(true)
  expect(shouldAlertDone({ reason: 'aborted', durationMs: 99_000 }, 20)).toBe(false)
  expect(shouldAlertDone({ reason: 'error', durationMs: 99_000 }, 20)).toBe(false)
  expect(shouldAlertDone({ reason: 'refusal', durationMs: 99_000 }, 20)).toBe(false)
  expect(shouldAlertDone({ reason: 'answer' }, 20)).toBe(false)
  expect(shouldAlertDone({ reason: 'answer', durationMs: NaN }, 20)).toBe(false)
})

test('only a permission prompt or a question needs the person; the looking window is eight seconds', () => {
  expect(isNeedsYou('permission_prompt')).toBe(true)
  expect(isNeedsYou('elicitation_dialog')).toBe(true)
  for (const other of ['idle_prompt', 'auth_success', 'plugin_notification', '', undefined, null]) expect(isNeedsYou(other)).toBe(false)
  expect(isLooking(1_000_000, 1_000_000 - 7_999)).toBe(true)
  expect(isLooking(1_000_000, 1_000_000 - 8_000)).toBe(false)
  expect(isLooking(1_000_000, 0)).toBe(false) // never typed
  expect(isLooking(1_000_000, 1_000_000 - 2_999, NEEDS_LOOKING_MS)).toBe(true)
  expect(isLooking(1_000_000, 1_000_000 - 3_000, NEEDS_LOOKING_MS)).toBe(false)
})

test('only the person\'s own prompts count as the person', () => {
  expect(isPerson({ kind: 'composer' })).toBe(true)
  expect(isPerson({ kind: 'bridge' })).toBe(true)
  for (const other of ['plugin', 'scheduled-trigger', 'task-notification', 'peer', 'channel', 'sdk', 'auto-continuation', 'unclassified', 'slack-ping']) {
    expect(isPerson({ kind: other })).toBe(false)
  }
  for (const bad of [undefined, null, 'composer', {}, 5]) expect(isPerson(bad)).toBe(false)
})

test('adding to the queue trims, refuses empty text and stops at the limit', () => {
  const one = addToQueue([], '  run the tests ', 'a')
  expect(one.added).toEqual({ id: 'a', text: 'run the tests' })
  expect(one.queue).toEqual([{ id: 'a', text: 'run the tests' }])
  expect(addToQueue(one.queue, '   ', 'b').problem).toBe('empty')
  const long = addToQueue(one.queue, 'z'.repeat(TEXT_MAX + 1), 'b')
  expect(long.problem).toBe('long') // refused, never cut short
  expect(long.queue).toHaveLength(1)
  expect(addToQueue([], 'z'.repeat(TEXT_MAX), 'b').added?.text).toHaveLength(TEXT_MAX)
  expect(addToQueue([], '😀'.repeat(TEXT_MAX), 'b').problem).toBeUndefined() // counted in characters, not code units
  expect(addToQueue(one.queue, undefined, 'b').problem).toBe('empty')
  const full = Array.from({ length: QUEUE_MAX }, (_, i) => ({ id: String(i), text: 't' }))
  const refused = addToQueue(full, 'more', 'z')
  expect(refused.problem).toBe('full')
  expect(refused.queue).toHaveLength(QUEUE_MAX)
  expect(addToQueue(one.queue, 'next', 'b').queue.map(q => q.id)).toEqual(['a', 'b'])
})

test('removing by number is 1-based and refuses numbers that are not there; removing by id keeps order', () => {
  const q = ['a', 'b', 'c'].map(id => ({ id, text: id }))
  expect(removeNth(q, 2).queue.map(x => x.id)).toEqual(['a', 'c'])
  expect(removeNth(q, 2).removed?.id).toBe('b')
  for (const bad of [0, 4, -1, 1.5, NaN]) {
    const out = removeNth(q, bad)
    expect(out.removed).toBeUndefined()
    expect(out.queue).toHaveLength(3)
  }
  expect(removeById(q, 'a').map(x => x.id)).toEqual(['b', 'c'])
  expect(removeById(q, 'zzz')).toHaveLength(3)
  expect(q).toHaveLength(3) // never changed in place
})

test('the drain decision: a permission prompt always wins, then pause, running and typing', () => {
  const ok = { queueLength: 2, isPaused: false, isRunning: false, hasQuestion: false, draft: '' }
  expect(decideDrain(ok)).toBe('send')
  expect(decideDrain({ ...ok, queueLength: 0 })).toBe('empty')
  expect(decideDrain({ ...ok, isPaused: true })).toBe('paused')
  expect(decideDrain({ ...ok, isRunning: true })).toBe('running')
  expect(decideDrain({ ...ok, draft: ' half a thought' })).toBe('typing')
  expect(decideDrain({ ...ok, draft: '   ' })).toBe('send')
  expect(decideDrain({ ...ok, hasQuestion: true })).toBe('question')
  expect(decideDrain({ ...ok, hasQuestion: true, isPaused: false, isRunning: true, draft: 'x' })).toBe('question')
  expect(decideDrain({ ...ok, queueLength: 0, hasQuestion: true })).toBe('empty')
})

test('/queue arguments: verbs act alone, anything else is a prompt to add', () => {
  expect(parseQueueArgs('')).toEqual({ verb: 'list', rest: '' })
  expect(parseQueueArgs('  list ')).toEqual({ verb: 'list', rest: '' })
  expect(parseQueueArgs('add fix the build')).toEqual({ verb: 'add', rest: 'fix the build' })
  expect(parseQueueArgs('ADD')).toEqual({ verb: 'add', rest: '' })
  expect(parseQueueArgs('fix the build')).toEqual({ verb: 'add', rest: 'fix the build' })
  expect(parseQueueArgs('remove 2')).toEqual({ verb: 'remove', rest: '2' })
  expect(parseQueueArgs('rm 3')).toEqual({ verb: 'remove', rest: '3' })
  expect(parseQueueArgs('remove')).toEqual({ verb: 'remove', rest: '' })
  expect(parseQueueArgs('clear')).toEqual({ verb: 'clear', rest: '' })
  expect(parseQueueArgs('clear the logs please')).toEqual({ verb: 'add', rest: 'clear the logs please' })
  expect(parseQueueArgs('add clear the logs')).toEqual({ verb: 'add', rest: 'clear the logs' })
  expect(parseQueueArgs('pause')).toEqual({ verb: 'pause', rest: '' })
  expect(parseQueueArgs('resume')).toEqual({ verb: 'resume', rest: '' })
  expect(parseQueueArgs('next')).toEqual({ verb: 'next', rest: '' })
  expect(parseQueueArgs('help').verb).toBe('help')
})

test('the card shows after a long absence with something unseen, never right after a notification', () => {
  const base = { awayMin: 10, lastActive: 0, now: 25 * MIN, events: [ev('done', 3 * MIN)] }
  expect(shouldShowCard(base)).toBe(true)
  expect(shouldShowCard({ ...base, now: 10 * MIN })).toBe(true)
  expect(shouldShowCard({ ...base, now: 10 * MIN - 1 })).toBe(false) // not away long enough
  expect(shouldShowCard({ ...base, events: [] })).toBe(false) // nothing happened
  expect(shouldShowCard({ ...base, awayMin: 0 })).toBe(false) // turned off
  expect(shouldShowCard({ ...base, events: [ev('done', 25 * MIN - 59_000)] })).toBe(false) // a notification just told them
  expect(shouldShowCard({ ...base, events: [ev('done', 25 * MIN - 61_000)] })).toBe(true)
  // the oldest event decides: a fresh second one does not hide the first
  expect(shouldShowCard({ ...base, events: [ev('done', 3 * MIN), ev('done', 25 * MIN - 5_000)] })).toBe(true)
})

test('events are counted by kind, capped, and answered questions drop out', () => {
  const events = [ev('done', 1), ev('question', 2), ev('done', 3)]
  expect(countEvents(events)).toEqual({ done: 2, questions: 1 })
  expect(resolveQuestions(events).map(e => e.kind)).toEqual(['done', 'done'])
  let many: AwayEvent[] = []
  for (let i = 0; i < AWAY_EVENTS_MAX + 10; i++) many = addEvent(many, ev('done', i))
  expect(many).toHaveLength(AWAY_EVENTS_MAX)
  expect(many[0]?.at).toBe(10)
  expect(awayMinutes(25 * MIN)).toBe(25)
  expect(awayMinutes(10_000)).toBe(1)
  expect(awayMinutes(90 * MIN + 20_000)).toBe(90)
})

test('the card lists questions first and says how many more when the room is short', () => {
  const events = [ev('done', 1, 'd1'), ev('done', 2, 'd2'), ev('question', 3, 'q'), ev('done', 4, 'd3')]
  expect(cardEvents(events, 40).shown.map(e => e.text)).toEqual(['q', 'd1', 'd2', 'd3'])
  expect(cardEvents(events, 40).hidden).toBe(0)
  const tight = cardEvents(events, 8) // room 3: two events and a "more" row
  expect(tight.shown.map(e => e.text)).toEqual(['q', 'd1'])
  expect(tight.hidden).toBe(2)
  const none = cardEvents(events, 3)
  expect(none.shown).toHaveLength(0)
  expect(none.hidden).toBe(4)
  const six = Array.from({ length: 12 }, (_, i) => ev('done', i, String(i)))
  expect(cardEvents(six, 100).shown.length + 1).toBe(6)
})

test('the queue plan shows the whole numbered list when it fits and a single line when it cannot', () => {
  expect(planQueue(40, 3)).toEqual({ mode: 'box', shown: 3, hidden: 0, rows: 7 })
  expect(planQueue(7, 3)).toEqual({ mode: 'box', shown: 3, hidden: 0, rows: 7 })
  expect(planQueue(6, 3)).toEqual({ mode: 'box', shown: 1, hidden: 2, rows: 6 })
  expect(planQueue(5, 3)).toEqual({ mode: 'line', rows: 1 })
  expect(planQueue(7, 3, 2)).toEqual({ mode: 'box', shown: 1, hidden: 2, rows: 7 }) // two rows of buttons on a narrow screen
  expect(planQueue(6, 3, 2)).toEqual({ mode: 'line', rows: 1 })
  expect(isCardCompact(5)).toBe(true)
  expect(isCardCompact(6)).toBe(false)
  expect(isCardCompact(NaN)).toBe(true)
  expect(planQueue(40, 0)).toEqual({ mode: 'line', rows: 1 })
  for (const rows of [1, 2, 3, 5, 6, 7, 9, 12, 24, 60]) {
    for (const length of [1, 2, 5, 20]) {
      const plan = planQueue(rows, length)
      expect(plan.rows).toBeLessThanOrEqual(Math.max(1, rows))
    }
  }
  expect(planQueue(NaN, 2).mode).toBe('box')
})

test('sound players: Windows uses PowerShell with a quoted path, Linux tries three players, macOS none', () => {
  const win = playerCommands('windows', "C:/Users/o'brien/p/sounds/done.wav")
  expect(win).toHaveLength(1)
  expect(win[0]?.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(win[0]?.[4]).toBe("(New-Object System.Media.SoundPlayer 'C:/Users/o''brien/p/sounds/done.wav').PlaySync()")
  expect(psQuote("a'b")).toBe("'a''b'")
  expect(psQuote('C:/Users/O\u2019Brien/p.wav')).toBe("'C:/Users/O\u2019\u2019Brien/p.wav'") // curly quotes quote too in PowerShell
  expect(psQuote('\u2018\u201a\u201b')).toBe("'\u2018\u2018\u201a\u201a\u201b\u201b'")
  expect(playerCommands('linux', '/p/done.wav').map(c => c[0])).toEqual(['paplay', 'aplay', 'canberra-gtk-play'])
  expect(playerCommands('wsl', '/p/done.wav')).toHaveLength(3)
  expect(playerCommands('macos', '/p/done.wav')).toEqual([])
  expect(playerCommands('unknown', '/p/done.wav')).toEqual([])
  expect(soundFile('done')).toBe('done.wav')
  expect(soundFile('needs')).not.toBe(soundFile('done'))
})

test('the English and Vietnamese tables say the same things', () => {
  const en = TABLES.en
  const vi = TABLES.vi
  expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort())
  expect(en.cardSummary(25, 2, 1)).toBe('While you were away 25 min: 2 tasks done, 1 question waiting')
  expect(en.cardSummary(5, 1, 0)).toBe('While you were away 5 min: 1 task done')
  expect(en.cardSummary(65, 0, 2)).toBe('While you were away 1 h 5 min: 2 questions waiting')
  expect(en.cardSummary(120, 1, 0)).toBe('While you were away 2 h: 1 task done')
  expect(vi.cardSummary(25, 2, 1)).toBe('Trong lúc bạn đi 25 phút: xong 2 việc, 1 câu hỏi chờ bạn')
  expect(vi.cardSummary(90, 0, 1)).toBe('Trong lúc bạn đi 1 giờ 30 phút: 1 câu hỏi chờ bạn')
  expect(en.cardAway(25, '13:40', '14:05')).toBe('away 25 min (13:40 → 14:05)')
  expect(vi.cardAway(25, '13:40', '14:05')).toBe('vắng 25 phút (13:40 → 14:05)')
  expect(en.doneTitle('acme-shop')).toBe('Claude finished · acme-shop')
  expect(en.needsTitle('')).toBe('Claude needs you')
  expect(vi.needsTitle('acme-shop')).toBe('Claude cần bạn trả lời · acme-shop')
  expect(en.queueTitle(3, false)).toBe('Queue · 3 prompts sent one at a time when Claude is free')
  expect(en.queueTitle(1, true)).toBe('Queue · 1 prompt paused')
  expect(vi.queueTitle(3, false)).toBe('Hàng chờ · 3 việc tự gửi lần lượt khi Claude rảnh')
  expect(en.cleared(0)).toBe('The queue was already empty.')
  expect(en.cleared(1)).toBe('Removed 1 queued prompt.')
  expect(vi.cleared(4)).toBe('Đã xoá 4 việc đang chờ.')
})

test('language: the option wins, else Claude Code\'s own setting, else English', () => {
  expect(chooseLanguage('vi', 'English')).toBe('vi')
  expect(chooseLanguage('en', 'Vietnamese')).toBe('en')
  expect(chooseLanguage('auto', 'Vietnamese')).toBe('vi')
  expect(chooseLanguage(undefined, 'Tiếng Việt')).toBe('vi')
  expect(chooseLanguage('auto', 'vi-VN')).toBe('vi')
  expect(chooseLanguage('auto', 'French')).toBe('en')
  expect(languageFromSetting(undefined)).toBe('en')
  expect(languageFromSetting('vietnamese')).toBe('vi')
  expect(languageFromSetting('visual')).toBe('en')
})

test('the platform comes from the engine, else the OS variable, else uname; unknown when nothing says', () => {
  expect(detectPlatform('windows', undefined, '')).toBe('windows')
  expect(detectPlatform('macos', 'Windows_NT', 'Linux')).toBe('macos') // the engine's word wins
  expect(detectPlatform('weird', undefined, '')).toBe('unknown')
  expect(detectPlatform(undefined, 'Windows_NT', '')).toBe('windows')
  expect(detectPlatform(undefined, undefined, 'Darwin 24.1.0\n')).toBe('macos')
  expect(detectPlatform(undefined, undefined, 'Linux 6.8.0-generic')).toBe('linux')
  expect(detectPlatform(undefined, undefined, 'Linux 5.15.90.1-microsoft-standard-WSL2')).toBe('wsl')
  expect(detectPlatform(undefined, undefined, 'MINGW64_NT-10.0 3.4')).toBe('windows')
  for (const none of ['', '   ', 'FreeBSD 14', undefined, null, 5]) expect(detectPlatform(undefined, undefined, none)).toBe('unknown')
})
