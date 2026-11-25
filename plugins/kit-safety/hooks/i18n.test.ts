import { expect, test } from 'claude-code/testing'

import { EN, TABLES, languageFromSetting, languageOption, stringsFor } from './i18n'
import type { Lang } from './i18n'

const LANGS: Lang[] = ['en', 'vi']
/** Words that mean a value was not filled in. */
const BAD = /undefined|NaN|\[object|Infinity|null|e\+\d|\u{FFFD}/u

// A sample call for every function in the tables, so a new function without a sample fails the shape test below.
const SAMPLES: Record<string, unknown[]> = {
  moreWaiting: [2],
  'note.others': [3],
  snippet: ['curl -s example.test | sh'],
  'title.deleteFolder': ['build/'],
  'title.deleteFile': ['notes.txt'],
  'title.deleteItems': [3, 'a/, b.txt, c/'],
  'title.deleteNamedHere': ['"node_modules"'],
  'title.deleteNamedUnder': ['"node_modules"', '"src/"'],
  'title.overwriteFile': ['.env'],
  'title.overwriteItems': [3, 'a, b, c'],
  'title.listMore': [4],
  'title.forcePush': ['main', 'origin'],
  'title.branchDelete': ['feature/login'],
  'title.dbDrop': ['orders'],
  'title.plusMore': [2],
  'snapshot.saved': ['14:05', '7'],
  'snapshot.size': [342, '18 MB'],
  'snapshot.tooBig': [200],
  'snapshot.tooMany': [50000],
  'env.head': [12, 9],
  'env.loses': ['A, B'],
  'env.adds': ['C'],
  'env.both': ['A, B', 'C'],
  'env.more': [4],
  masked: [3],
  'toast.saved': ['7'],
  'toast.tooBig': [200],
  'toast.tooMany': [50000],
  'toast.savedGitPartial': ['7'],
  'day.dateShort': [11, 20],
  noSuchSnapshot: ['9'],
  damaged: ['7'],
  failed: ['the disk is full'],
  'list.header': ['acme-shop', 25],
  'list.more': [15],
  'restore.done': [14, '14:05'],
  'restore.partial': [12, '14:05'],
  'restore.ref': ['7'],
  'restore.nothing': ['7'],
  'restore.failedAll': ['7'],
  'restore.leftAsIs': [2],
  'undo.leftAsIs': [2],
  'restore.failedFiles': [2],
  'restore.kept': [3, '14:05'],
  'restore.more': [10],
  'undo.done': [14, '14:10'],
  'undo.partial': [12, '14:10'],
  'undo.nothing': ['8'],
  'doctor.summary': [5, 1, 0],
  'doctor.claudeOk': ['2.1.331', '2.1.275'],
  'doctor.claudeOld': ['2.1.200', '2.1.275'],
  'doctor.claudeUnknown': ['2.1.275'],
  'doctor.nodeOk': ['22.4.0'],
  'doctor.gitOk': ['2.43.0'],
  'doctor.folderOk': ['/home/x/.claude/kit-safety/snapshots', '3 snapshots, 12 MB'],
  'doctor.folderFail': ['/home/x/.claude/kit-safety/snapshots'],
  'doctor.folderUnknown': ['/home/x/.claude/kit-safety/snapshots'],
  'doctor.snapshotCount': [3, '12 MB'],
  'doctor.totalNone': ['2 GB'],
  'doctor.totalOk': [12, '340 MB', '2 GB', false],
  'doctor.totalOver': [12, '2.5 GB', '2 GB', true],
  'doctor.options': ['asks first', 'masks secrets', 'English'],
  'doctor.confirmUnknown': ['sometimes'],
  'doctor.surface': ['terminal'],
}

/** Every leaf of a table with its dotted path. */
function leaves(value: unknown, prefix = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k))
  }
  return [[prefix, value]]
}

const lookup = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value)

test('both tables have the same keys, the same kinds of value and the same number of arguments', () => {
  const en = leaves(TABLES.en)
  const vi = leaves(TABLES.vi)
  expect(vi.map(([k]) => k)).toEqual(en.map(([k]) => k))
  for (const [path, value] of en) {
    const other = lookup(TABLES.vi, path)
    expect(typeof other).toBe(typeof value)
    if (typeof value === 'function') expect((other as (...a: unknown[]) => unknown).length).toBe(value.length)
    if (typeof value === 'string') expect(other === '').toBe(false)
  }
  expect(en.length).toBeGreaterThan(100)
})

test('every function in the tables has a sample, and every sample belongs to a function', () => {
  const functions = leaves(TABLES.en).filter(([, v]) => typeof v === 'function').map(([k]) => k)
  expect(functions.filter(k => SAMPLES[k] === undefined)).toEqual([])
  expect(Object.keys(SAMPLES).filter(k => !functions.includes(k))).toEqual([])
})

test('every string and every function answer is non-empty plain text in both languages', () => {
  for (const lang of LANGS) {
    for (const [path, value] of leaves(TABLES[lang])) {
      const text = typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...(SAMPLES[path] ?? [])) : value
      expect(typeof text).toBe('string')
      expect((text as string).trim() === '').toBe(false)
      expect(BAD.test(text as string)).toBe(false)
    }
  }
})

test('numbers that are not usable counts never print as NaN, a minus sign or an exponent', () => {
  const hostile = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 1.5, 1e21, 0]
  for (const lang of LANGS) {
    for (const [path, value] of leaves(TABLES[lang])) {
      if (typeof value !== 'function') continue
      const sample = SAMPLES[path] ?? []
      if (!sample.some(a => typeof a === 'number')) continue
      for (const bad of hostile) {
        const args = sample.map(a => (typeof a === 'number' ? bad : a))
        const text = (value as (...a: unknown[]) => string)(...args)
        expect(typeof text).toBe('string')
        expect(BAD.test(text)).toBe(false)
        expect(/-\d/.test(text)).toBe(false)
      }
    }
  }
})

test('the pill, the buttons and the three scenes use the owner-approved wording', () => {
  expect(TABLES.en.pill).toBe('WAITING FOR YOU')
  expect(TABLES.en.buttons).toEqual({ allow: 'Allow', cancel: 'Cancel', details: 'See changes', hideDetails: 'Hide changes' })
  expect(TABLES.vi.pill).toBe('CHỜ XÁC NHẬN')
  expect(TABLES.vi.buttons.allow).toBe('Cho chạy')
  expect(TABLES.vi.buttons.cancel).toBe('Huỷ')
  expect(TABLES.vi.buttons.details).toBe('Xem khác biệt')
  expect(TABLES.vi.title.deleteFolder('build/')).toBe('Sắp xoá thư mục build/')
  expect(TABLES.vi.title.overwriteFile('.env')).toBe('Sắp ghi đè file .env')
  expect(TABLES.vi.snapshot.saved('14:05', '7')).toBe('Đã chụp lại trạng thái lúc 14:05 (#7)')
  expect(TABLES.vi.restore.undoHint).toBe('Đổi ý? /safety undo')
  expect(TABLES.vi.restore.kept(3, '14:05')).toBe('Giữ nguyên 3 file mới tạo sau 14:05.')
  expect(TABLES.vi.masked(3)).toBe('◈ 3 giá trị bí mật đã được che trước khi vào cuộc trò chuyện.')
  expect(TABLES.en.masked(3)).toBe('◈ 3 secret values were masked before they entered the conversation.')
  expect(TABLES.en.noSnapshots).toBe('There are no snapshots for this project yet.')
  expect(TABLES.en.noSuchSnapshot('9')).toBe('There is no snapshot #9. /safety list shows them.')
})

test('the words added for the fix pass: an unreadable line, other commands, a file count, a Git state that was not saved', () => {
  const en = TABLES.en
  const vi = TABLES.vi
  expect(en.title.unparsed).toBe('This command line is too long or too tangled for Safety Net to read to the end')
  expect(en.note.unparsed).toBe('Something dangerous could be hiding in the part it did not read: read the command before you allow it.')
  expect(en.note.others(1)).toBe('+1 other command in this line that Safety Net did not flag; read the command before you allow it.')
  expect(en.note.others(2)).toBe('+2 other commands in this line that Safety Net did not flag; read the command before you allow it.')
  expect(en.note.others(1234)).toBe('+1,234 other commands in this line that Safety Net did not flag; read the command before you allow it.')
  expect(vi.note.others(1)).toBe('+1 lệnh khác trong dòng này mà Safety Net không đánh dấu; hãy đọc lệnh trước khi cho chạy.')
  expect(vi.note.others(1234)).toBe('+1.234 lệnh khác trong dòng này mà Safety Net không đánh dấu; hãy đọc lệnh trước khi cho chạy.')
  expect(en.snippet('rm -rf x')).toBe('The command starts: "rm -rf x"')
  expect(vi.snippet('rm -rf x')).toBe('Lệnh bắt đầu bằng: "rm -rf x"')
  expect(en.snapshot.tooMany(50000)).toBe('No snapshot: more than 50,000 files would be touched, which is over the limit')
  expect(vi.snapshot.tooMany(50000)).toBe('Không có snapshot: sẽ động đến hơn 50.000 file, vượt giới hạn')
  expect(en.snapshot.tooBig(200)).toBe('No snapshot: more than 200 MB would be touched, which is over the limit')
  expect(en.snapshot.nothingToSave).toBe('Nothing to save for this one')
  expect(en.snapshot.gitPartial).toBe('but Git could not save your uncommitted changes (an unfinished merge, for example)')
  expect(en.snapshot.gitPartialNoFiles).toBe('No files to copy, and Git could not save your uncommitted changes (an unfinished merge, for example)')
  expect(vi.snapshot.gitPartial.startsWith('nhưng Git không lưu được')).toBe(true)
  expect(en.toast.savedGitPartial('7')).toBe('Snapshot #7 saved before this command, but Git could not save your uncommitted changes')
  expect(en.toast.tooMany(50000)).toBe('No snapshot before this command: it touches more than 50,000 files')
  expect(en.list.quiet).toBe('(saved quietly)')
  expect(vi.list.quiet).toBe('(lưu ngầm)')
  // Vietnamese has its own words for each, none left in English
  for (const [path, value] of leaves(vi)) {
    if (!/^(title|note|snapshot|toast|list)\.(unparsed|others|tooMany|gitPartial|gitPartialNoFiles|nothingToSave|savedGitPartial|quiet)$|^snippet$/.test(path)) continue
    const text = typeof value === 'function' ? (value as (...a: unknown[]) => string)(...(SAMPLES[path] ?? [])) : String(value)
    expect(text).toMatch(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i)
  }
})

test('English plural forms: one is singular, zero and many are plural, thousands get a comma', () => {
  const t = TABLES.en
  expect(t.snapshot.size(1, '4 KB')).toBe('1 file, 4 KB')
  expect(t.snapshot.size(0, '0 B')).toBe('0 files, 0 B')
  expect(t.snapshot.size(2, '4 KB')).toBe('2 files, 4 KB')
  expect(t.snapshot.size(1234567, '9 GB')).toBe('1,234,567 files, 9 GB')
  expect(t.masked(1)).toBe('◈ 1 secret value was masked before it entered the conversation.')
  expect(t.masked(2)).toBe('◈ 2 secret values were masked before they entered the conversation.')
  expect(t.restore.done(1, '14:05')).toBe('Restored 1 file to 14:05')
  expect(t.restore.done(2, '')).toBe('Restored 2 files')
  expect(t.restore.failedFiles(1)).toBe('Could not restore 1 file:')
  expect(t.restore.failedFiles(2)).toBe('Could not restore 2 files:')
  expect(t.env.head(1, 9)).toBe('The old file has 1 variable, the new one 9')
  expect(t.doctor.snapshotCount(0, '')).toBe('no snapshots yet')
  expect(t.doctor.snapshotCount(1, '2 MB')).toBe('1 snapshot, 2 MB')
  expect(t.doctor.snapshotCount(3, '')).toBe('3 snapshots')
  expect(t.moreWaiting(1000)).toBe('1,000 more waiting')
})

test('Vietnamese does not inflect and groups thousands with a dot', () => {
  const t = TABLES.vi
  expect(t.snapshot.size(1, '4 KB')).toBe('1 file, 4 KB')
  expect(t.snapshot.size(342, '18 MB')).toBe('342 file, 18 MB')
  expect(t.snapshot.size(1234567, '9 GB')).toBe('1.234.567 file, 9 GB')
  expect(t.masked(1).startsWith('◈ 1 giá trị bí mật')).toBe(true)
  expect(t.doctor.snapshotCount(0, '')).toBe('chưa có snapshot nào')
  expect(t.doctor.snapshotCount(12, '3 MB')).toBe('12 snapshot, 3 MB')
})

test('texts that name a missing part leave no hole', () => {
  for (const t of [TABLES.en, TABLES.vi]) {
    expect(t.snapshot.saved('', '')).not.toMatch(/\(#\)| at $|lúc $/)
    expect(t.snapshot.saved('14:05', '')).not.toMatch(/\(#/)
    expect(t.snapshot.saved('', '7')).toMatch(/#7/)
    expect(t.title.forcePush('', '')).not.toMatch(/ {2}|of branch\s*$/)
    expect(t.title.forcePush('', 'origin')).toMatch(/origin/)
    expect(t.title.branchDelete('')).not.toMatch(/ {2}/)
    expect(t.title.dbDrop('')).not.toMatch(/ {2}/)
    expect(t.restore.done(2, '')).not.toMatch(/ {2}| $/)
    expect(t.restore.kept(2, '')).not.toMatch(/ {2}/)
    expect(t.restore.failedAll('')).not.toMatch(/#/)
    expect(t.restore.nothing('')).not.toMatch(/#/)
    expect(t.day.dateShort(0, 5).startsWith(' ')).toBe(false)
  }
})

test('the English table words things for people who are not developers', () => {
  // the two titles about a saved stash are the one place the word is needed: the command it answers is `git stash drop`
  const text = leaves(TABLES.en).filter(([path]) => !/^title\.gitStash(Drop|Clear)$/.test(path)).map(([, v]) => (typeof v === 'string' ? v : '')).join('\n')
  expect(/\bstash\b/i.test(text)).toBe(false)
  expect(/untracked/i.test(text)).toBe(false)
  expect(TABLES.en.title.clean).toBe('About to delete the files Git does not track')
  expect(TABLES.en.snapshot.size(3, '1 KB')).not.toMatch(/stash/)
})

test('languageOption: en and vi stay, everything else is auto', () => {
  expect(languageOption('en')).toBe('en')
  expect(languageOption('vi')).toBe('vi')
  for (const v of ['auto', 'EN', 'Vi', 'fr', '', ' en', undefined, null, 3, true, {}, [], ['en']]) expect(languageOption(v)).toBe('auto')
})

test('languageFromSetting: Vietnamese spellings give vi, anything else gives en', () => {
  const vi = ['vi', 'vi-VN', 'vi_VN', 'VI', 'Vi', ' vi ', 'Vietnamese', 'vietnamese', 'VIETNAMESE', 'Viet', 'Việt', 'Tiếng Việt',
    'tiếng việt', 'TIẾNG VIỆT', 'Tiếng  Việt', 'Tieng Viet', 'Tiếng Việt'.normalize('NFD'), 'Tiếng Việt'.normalize('NFC')]
  for (const v of vi) expect(languageFromSetting(v)).toBe('vi')
  const en = ['en', 'en-US', 'English', 'english', '', ' ', 'fr', 'vim', 'video', 'Viking', 'visual', 'ja', 'zh-CN', 'avi', 'Tiếng Anh', 'auto',
    undefined, null, 3, true, {}, [], ['vi']]
  for (const v of en) expect(languageFromSetting(v)).toBe('en')
  expect(languageFromSetting('vi'.repeat(100_000))).toBe('en')
  expect(languageFromSetting(`vi${'x'.repeat(100_000)}`)).toBe('en')
})

test('stringsFor gives the table of the language, and English for anything else', () => {
  expect(stringsFor('en')).toBe(TABLES.en)
  expect(stringsFor('vi')).toBe(TABLES.vi)
  expect(stringsFor('xx' as Lang)).toBe(TABLES.en)
  expect(EN).toBe(TABLES.en)
})

test('the Git sentences of a restore say what was really kept: the remote branch of a force push, never the uncommitted changes', () => {
  const en = TABLES.en
  const vi = TABLES.vi
  expect(en.restore.gitIntro).toBe('Git: the commits and changes were saved too. To bring them back yourself, run:')
  expect(en.restore.gitIntroRemote).toBe('Git: the last-fetched copy of the remote branch is saved as a branch name you can restore. To bring it back yourself, run:')
  expect(en.restore.otherTips).toBe('Other saved branch tips (their names cannot be shown here). To list them, run:')
  expect(en.restore.gitPartial).toBe(
    'Git could not save your uncommitted changes when this snapshot was taken (an unfinished merge, for example), so there is nothing to bring back from Git.',
  )
  expect(en.list.gitPartial).toBe('Git could not save your changes')
  expect(vi.list.gitPartial).toBe('Git không lưu được thay đổi của bạn')
  for (const t of [en, vi]) {
    // the force push sentence is about the remote branch only
    expect(t.restore.gitIntroRemote).not.toBe(t.restore.gitIntro)
    expect(t.restore.gitIntroRemote).not.toMatch(/uncommitted|commit và thay đổi|chưa commit/)
    // the partial sentences never say that something was saved too, and keep to "could not"
    for (const text of [t.restore.gitPartial, t.restore.gitPartialSome]) expect(text).not.toBe(t.restore.gitIntro)
    expect(t.restore.gitPartial).not.toMatch(/saved too|đã được lưu/)
    expect(t.list.gitPartial).not.toBe(t.list.gitOnly)
  }
  // plain words in English (no developer jargon the person would not know), and Vietnamese has its own words for each
  expect(/\bstash\b|untracked/i.test([en.restore.gitIntroRemote, en.restore.otherTips, en.restore.gitPartial, en.restore.gitPartialSome, en.list.gitPartial].join('\n'))).toBe(false)
  for (const text of [vi.restore.gitIntroRemote, vi.restore.otherTips, vi.restore.gitPartial, vi.restore.gitPartialSome, vi.list.gitPartial]) {
    expect(text).toMatch(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i)
  }
})

test('the words for emptying Git\'s own safety nets, a name the filter looks for, a .env without Node and the total of all snapshots', () => {
  const en = TABLES.en
  const vi = TABLES.vi
  expect(en.title.gitStashDrop).toBe('About to delete a saved stash from Git')
  expect(en.title.gitStashClear).toBe('About to delete every saved stash from Git')
  expect(en.title.gitRefDelete).toBe('About to delete a Git reference')
  expect(en.title.gitHistoryErase).toBe('About to permanently erase Git\'s safety history')
  expect(en.title.gitErase).toBe('About to erase part of Git\'s own safety nets')
  expect(en.note.gitErase).toBe('Git cannot bring this back.')
  expect(en.title.deleteNamedHere('"node_modules"')).toBe('About to delete everything named "node_modules" in this project')
  expect(en.title.deleteNamedUnder('"node_modules"', '"src/"')).toBe('About to delete everything named "node_modules" under "src/"')
  expect(en.snapshot.needsNode).toBe('Not saved: a .env file is copied only when Node.js is installed, so its copy can be kept private')
  expect(en.toast.needsNode).toBe('No snapshot before this command: a .env file is copied only when Node.js is installed')
  expect(en.doctor.totalNone('2 GB')).toBe('No snapshots in any project yet; all of them together may take up to 2 GB')
  expect(en.doctor.totalOk(12, '340 MB', '2 GB', false)).toBe('12 snapshots in all projects, 340 MB of the 2 GB they may take together')
  expect(en.doctor.totalOk(1, '4 KB', '100 MB', false)).toBe('1 snapshot in all projects, 4 KB of the 100 MB they may take together')
  expect(en.doctor.totalOk(1500, '1 GB', '2 GB', true)).toBe('At least 1,500 snapshots in all projects, 1 GB of the 2 GB they may take together')
  expect(en.doctor.totalOver(12, '2.5 GB', '2 GB', false)).toBe('12 snapshots in all projects, 2.5 GB: over the 2 GB they may take together, so the oldest are deleted when the next session starts')
  expect(vi.title.deleteNamedHere('"node_modules"')).toBe('Sắp xoá mọi thứ có tên "node_modules" trong dự án này')
  expect(vi.title.deleteNamedUnder('"node_modules"', '"src/"')).toBe('Sắp xoá mọi thứ có tên "node_modules" trong "src/"')
  expect(vi.note.gitErase).toBe('Git không thể khôi phục việc này.')
  expect(vi.doctor.totalOk(12, '340 MB', '2 GB', false)).toBe('12 snapshot ở mọi dự án, 340 MB (tối đa 2 GB cho tất cả)')
  expect(vi.doctor.totalOk(1500, '1 GB', '2 GB', true)).toBe('Ít nhất 1.500 snapshot ở mọi dự án, 1 GB (tối đa 2 GB cho tất cả)')
  // Vietnamese has its own words for each of them, none left in English
  const accent = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i
  for (const key of ['gitStashDrop', 'gitStashClear', 'gitRefDelete', 'gitHistoryErase', 'gitErase'] as const) {
    expect(vi.title[key]).toMatch(accent)
    expect(vi.title[key]).not.toBe(en.title[key])
  }
  for (const text of [vi.snapshot.needsNode, vi.toast.needsNode, vi.doctor.totalNone('2 GB'), vi.doctor.totalOver(2, '3 GB', '2 GB', false)]) expect(text).toMatch(accent)
  // the .env line says the one thing the person can act on (Node.js) and nothing alarming; no secret word, no path
  for (const t of [en, vi]) {
    expect(t.snapshot.needsNode).toMatch(/Node\.js/)
    expect(t.toast.needsNode).toMatch(/Node\.js/)
  }
  // a name from a command never closes its own quotes: the sentence takes the name already quoted, and adds none of its own
  for (const t of [en, vi]) expect([t.title.deleteNamedHere('X'), t.title.deleteNamedUnder('X', 'Y')].join('')).not.toMatch(/["'\u201C\u201D]/)
  // the unreadable-count words never print a hole
  for (const t of [en, vi]) {
    for (const text of [t.doctor.totalOk(Number.NaN, '0 B', '2 GB', false), t.doctor.totalOver(-3, '0 B', '2 GB', true), t.doctor.totalNone('2 GB')]) expect(BAD.test(text)).toBe(false)
  }
})
