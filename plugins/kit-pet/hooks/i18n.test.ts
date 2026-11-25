import { expect, test } from 'claude-code/testing'

import { TABLES, en, languageFromSetting, vi } from './i18n'

/** Every path to a leaf of a table (strings and functions), so two tables can be compared key by key. */
const paths = (value: unknown, prefix = ''): string[] => {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k))
    .sort()
}

/** Every leaf of a table, called with sample arguments when it is a function. */
const leaves = (value: unknown, prefix = ''): Array<[string, string]> => {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value === 'function') return samples(value as (...a: never[]) => unknown).map(s => [prefix, s] as [string, string])
  if (typeof value !== 'object' || value === null) return [[prefix, String(value)]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k))
}

const samples = (fn: (...a: never[]) => unknown): string[] => {
  const f = fn as (...a: unknown[]) => unknown
  const argSets: unknown[][] = [
    ['Moss', 'x'],
    ['Moss', 0],
    ['Moss', 'five_hour'],
    ['Moss', 92, 'seven_day'],
    ['Moss', 92, 'five_hour'],
    [0, 'Little Moss'],
    [1, 'Little Moss'],
    [7, 'Little Moss'],
    [null, 'Moss'],
    [15, 'Moss'],
    [0, ''],
    [3, 'Bash'],
    [35, 15, 'Moss'],
    [350, null, 'Moss'],
    [],
    [''],
    ['1h49m'],
    ['Moss', '02:41'],
    ['Moss', 'IDLE', ''],
    ['Moss', 'IDLE', 'extra'],
    ['Title', 'Text'],
    ['1.2.3', '2.0.0'],
    [{ name: 'Moss', stage: 'Sprout', turns: 5, left: 3, streak: 2, unlocked: ['A'], quota: '' }],
    [{ name: 'Moss', stage: 'Sprout', turns: 5, left: null, streak: 0, unlocked: [], quota: '92%' }],
  ]
  const out: string[] = []
  for (const args of argSets) {
    try {
      const r = f(...args)
      if (typeof r === 'string') out.push(r)
    } catch {
      // wrong shape of arguments for this function: not a sample for it
    }
  }
  return out
}

test('both languages have the same keys, all the way down', () => {
  expect(paths(vi)).toEqual(paths(en))
  expect(TABLES.en).toBe(en)
  expect(TABLES.vi).toBe(vi)
})

test('every string and every function returns text that is not empty', () => {
  for (const table of [en, vi]) {
    const all = leaves(table)
    expect(all.length).toBeGreaterThan(40)
    for (const [key, text] of all) {
      expect(text.trim(), key).not.toBe('')
    }
  }
})

test('every function gives a result for its documented arguments', () => {
  for (const t of [en, vi]) {
    expect(t.idle('Moss')).not.toBe('')
    expect(t.working('Moss', '02:41')).toContain('02:41')
    expect(t.done('Moss', '2m 41s')).toContain('2m 41s')
    expect(t.errorTool('Moss')).toContain('Moss')
    expect(t.errorTurn('Moss')).toContain('Moss')
    expect(t.quota('Moss', 92, 'five_hour')).toContain('92%')
    expect(t.quota('Moss', 80, 'seven_day')).toContain('80%')
    expect(t.lineIdle(0, 'Little Moss')).not.toBe('')
    expect(t.lineProgress(null, 'Moss')).not.toBe('')
    expect(t.lineWorking(0, '')).not.toBe('')
    expect(t.lineDone(350, null, 'Moss')).toContain('350')
    expect(t.lineError()).not.toBe('')
    expect(t.lineQuota('')).not.toBe('')
    expect(t.command.status({ name: 'Moss', stage: 'Sprout', turns: 0, left: null, streak: 0, unlocked: [], quota: '' })).toContain('Moss')
  }
})

test('english: exact lines from the design', () => {
  expect(en.idle('Moss')).toBe('Moss is waiting for your next task')
  expect(en.working('Moss', '02:41')).toBe('Moss is on it · 02:41')
  expect(en.done('Moss', '2m 41s')).toBe('All done! Took 2m 41s')
  expect(en.errorTool('Moss')).toBe('A step failed. Moss looks a little sad')
  expect(en.errorTurn('Moss')).toBe('That turn did not finish. Moss looks a little sad')
  expect(en.quota('Moss', 92, 'five_hour')).toBe('5-hour limit is 92% used. Moss is out of breath')
  expect(en.quota('Moss', 92, 'seven_day')).toBe('Weekly limit is 92% used. Moss is out of breath')
  expect(en.lineError()).toBe('Ask Claude to fix it, or just send a new message')
  expect(en.stateLabel).toEqual({ idle: 'IDLE', working: 'WORKING', done: 'DONE', error: 'ERROR', quota: 'LOW QUOTA' })
  expect(en.command.usage).toBe('Usage: /pet  or  /pet doctor')
})

test('english: singular and plural, zero and full growth', () => {
  expect(en.lineIdle(7, 'Little Moss')).toBe('7 turns finished today · Little Moss')
  expect(en.lineIdle(1, 'Little Moss')).toBe('1 turn finished today · Little Moss')
  expect(en.lineIdle(0, 'Sprout')).toBe('Nothing finished yet today · Sprout')
  expect(en.lineProgress(15, 'Moss')).toBe('15 more turns until Moss grows')
  expect(en.lineProgress(1, 'Moss')).toBe('1 more turn until Moss grows')
  expect(en.lineProgress(null, 'Moss')).toBe('Fully grown')
  expect(en.lineWorking(0, 'Bash')).toBe('Getting started…')
  expect(en.lineWorking(3, 'Bash')).toBe('3 steps so far · last: Bash')
  expect(en.lineWorking(1, '')).toBe('1 step so far')
  expect(en.lineDone(35, 15, 'Moss')).toBe('Turn #35 · 15 more until Moss grows')
  expect(en.lineDone(350, null, 'Moss')).toBe('Turn #350')
  expect(en.lineQuota('1h49m')).toBe('Refills in 1h49m · a good time for a break or a light task')
  expect(en.lineQuota('')).toBe('a good time for a break or a light task')
  expect(en.narrow('Moss', 'IDLE', '')).toBe('Moss · IDLE')
  expect(en.narrow('Moss', 'WORKING', '02:41')).toBe('Moss · WORKING · 02:41')
})

test('names: three pets, three stages each, in both languages', () => {
  expect(en.petName).toEqual({ moss: 'Moss', bun: 'Bun', jelly: 'Jelly' })
  expect(vi.petName).toEqual({ moss: 'Rêu', bun: 'Bao', jelly: 'Sứa' })
  for (const t of [en, vi]) {
    for (const id of ['moss', 'bun', 'jelly'] as const) {
      expect(t.stageName[id]).toHaveLength(3)
      expect(new Set(t.stageName[id]).size).toBe(3)
    }
  }
  expect(en.stageName.moss).toEqual(['Sprout', 'Little Moss', 'Blooming Moss'])
  expect(vi.stageName.jelly).toEqual(['Giọt nước', 'Sứa con', 'Sứa phát sáng'])
})

test('vietnamese: real diacritics, and no English left over', () => {
  expect(vi.stateLabel).toEqual({ idle: 'RẢNH', working: 'ĐANG LÀM', done: 'XONG', error: 'LỖI', quota: 'SẮP HẾT' })
  expect(vi.idle('Rêu')).toBe('Rêu đang ngồi chờ bạn giao việc')
  expect(vi.working('Rêu', '02:41')).toBe('Rêu đang chạy · 02:41')
  expect(vi.done('Rêu', '2m 41s')).toBe('Xong rồi! Mất 2m 41s')
  expect(vi.errorTool('Rêu')).toContain('hơi buồn')
  expect(vi.quota('Rêu', 92, 'five_hour')).toContain('92%')
  expect(vi.quota('Rêu', 92, 'five_hour')).toContain('thở dốc')
  expect(vi.lineWorking(0, '')).toBe('Đang bắt đầu…')
  expect(vi.lineProgress(null, 'Rêu')).toBe('Đã lớn hết cỡ')
  expect(vi.toast('A', 'B')).toBe('★ Thành tựu mới: A. B')
  expect(en.toast('A', 'B')).toBe('★ Achievement: A. B')
  expect(vi.achievement.streak7.title).toBe('7 ngày liên tục')
  expect(vi.achievement.streak7.text('Rêu')).toBe('Bạn dùng Claude 7 ngày liền, Rêu vui lắm.')
  expect(en.achievement.streak7.text('Moss')).toBe('You used Claude 7 days in a row. Moss is cheering you on.')
  expect(vi.command.description).toMatch(/[ăâêôơưđáàảãạéèíóòúùý]/i)
  expect(vi.command.doctor.quotaUnknown).not.toBe(en.command.doctor.quotaUnknown)
})

test('command: status lines and doctor sentences', () => {
  const base = { name: 'Moss', stage: 'Little Moss', turns: 35, left: 15, streak: 3, unlocked: ['First commit'], quota: '' }
  const text = en.command.status(base)
  expect(text).toContain('35')
  expect(text).toContain('15 more')
  expect(text).toContain('First commit')
  expect(text).not.toContain('Limit:')
  expect(en.command.status({ ...base, quota: '92% of 5-hour' })).toContain('Limit: 92% of 5-hour')
  expect(en.command.status({ ...base, left: null, unlocked: [] })).toContain('none yet')
  expect(vi.command.status({ ...base, left: null, unlocked: [], quota: '92%' })).toContain('chưa có')
  expect(en.command.doctor.versionOld('1.0.0', '2.0.0')).toContain('2.0.0')
  expect(en.command.doctor.quotaKnown(40)).toContain('40%')
  expect(en.command.doctor.quotaUnknown).toContain('nothing to fix')
  expect(en.command.doctor.hidden('showPet is off')).toContain('showPet is off')
})

test('texts carry no stray emoji and nothing about telemetry', () => {
  for (const table of [en, vi]) {
    for (const [key, text] of leaves(table)) {
      expect(text.replace('★', ''), key).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(text.toLowerCase(), key).not.toContain('telemetry')
    }
  }
})

test('language setting: Vietnamese in its usual spellings is vi; anything else, or no text, is en', () => {
  for (const v of ['vi', 'VI', 'vi-VN', 'vi_VN', 'Vietnamese', 'vietnamese', 'Tiếng Việt', ' tiếng  việt ', 'Viet']) {
    expect(languageFromSetting(v)).toBe('vi')
  }
  for (const v of ['en', 'English', 'japanese', 'visual', 'vim', '', 'auto', undefined, null, 5, true, {}, ['vi']]) {
    expect(languageFromSetting(v)).toBe('en')
  }
})
