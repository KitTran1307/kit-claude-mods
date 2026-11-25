// Every word the person reads, in English and Vietnamese. Pure data and functions: no engine calls, so it is
// unit-tested without an engine. `vi` is typed as `Strings` (the shape of `en`), so a key missing from either table fails tsc.
// Not in here, on purpose: the prompt "Push now" puts in the box (PUSH_PROMPT in data.ts), which stays English
// because Claude, not the person, reads it.

import type { TestRun } from '../types'

export type Lang = 'en' | 'vi'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const runnerName: Record<TestRun['runner'], string> = {
  node: 'node --test', jest: 'Jest', vitest: 'Vitest', pytest: 'pytest', cargo: 'cargo test', go: 'go test',
}

const en = {
  runner: runnerName,
  title: 'Last turn',
  range: (from: string, to: string) => `${from} -> ${to}`,
  sectionDone: 'Done',
  sectionChanges: 'Changes',
  sectionChecks: 'Checks',
  sectionTime: 'Time',
  asked: (text: string) => `You asked: ${text}`,
  stopped: 'Stopped before it finished',
  failed: 'Ended with an error',
  noAnswer: 'No written answer.',

  // changes
  changedFiles: (n: number, added: number, removed: number) => `Changed ${plural(n, 'file', 'files')} (+${added}/-${removed})`,
  changedFilesApprox: (n: number, added: number, removed: number) => `Changed about ${plural(n, 'file', 'files')} (+${added}/-${removed})`,
  noFilesChanged: 'No files changed',
  commitsMade: (n: number) => `${plural(n, 'commit', 'commits')} made`,
  newFile: 'new',
  binaryFile: 'binary',
  moreFiles: (n: number) => `+${n} more`,

  // checks
  testsShort: (t: TestRun) => `tests: ${testCounts(t, 'passed', 'failed', 'skipped')}`,
  testsLong: (t: TestRun, runs: number) =>
    `${runnerName[t.runner]}: ${t.passed} passed${t.unit ? ' (packages)' : ''} - ${t.failed} failed${t.skipped ? ` - ${t.skipped} skipped` : ''}${runs > 1 ? ` (last of ${runs} runs)` : ''}`,

  // time
  started: (clock: string) => `started ${clock}`,
  ended: (clock: string, dur: string) => `ended ${clock} (${dur})`,
  underASecond: 'under 1 s',
  seconds: (s: number) => `${s} s`,
  minutes: (m: number, s: number) => (s ? `${m} min ${s} s` : `${m} min`),
  hours: (h: number, m: number) => (m ? `${h} h ${m} min` : `${h} h`),
  elapsedUnderMinute: 'under 1 min',
  elapsedMinutes: (m: number) => `${m} min`,
  elapsedHours: (h: number, m: number) => (m ? `${h} h ${m} min` : `${h} h`),
  working: (start: string, elapsed: string) => `Working - started ${start} - ${elapsed}`,

  // unpushed commits
  unpushed: (n: number, upstream: string | null) =>
    upstream ? `${plural(n, 'commit', 'commits')} not pushed to ${upstream}` : `${plural(n, 'commit', 'commits')} not on any remote`,
  unpushedShort: (n: number) => `${n} not pushed`,
  buttons: { push: 'Push now', commits: 'View commits', details: 'Details', hide: 'Hide', files: 'Files', filesOpen: 'Files', pane: 'Details' },
  fileMarkClosed: '▸',
  fileMarkOpen: '▾',

  // timeline
  stepStart: (text: string) => (text ? `Started: "${text}"` : 'Started'),
  stepRead: (files: number, searches: number) =>
    [files ? `Read ${plural(files, 'file', 'files')}` : '', searches ? `${files ? 'searched' : 'Searched'} ${plural(searches, 'time', 'times')}` : ''].filter(Boolean).join(', '),
  stepEdit: (file: string) => `Edited ${file}`,
  stepCreate: (file: string) => `Created ${file}`,
  stepTest: (t: TestRun) => `Ran tests: ${testCounts(t, 'passed', 'failed', 'skipped')}`,
  stepCommit: (subject: string) => (subject ? `Made a commit: ${subject}` : 'Made a commit'),
  stepCommand: (n: number) => `Ran ${plural(n, 'command', 'commands')}`,
  stepHelper: (n: number) => `Asked ${plural(n, 'helper', 'helpers')} to work on a part`,
  stepWeb: (n: number) => `Looked up ${plural(n, 'web page', 'web pages')}`,
  stepOther: (n: number) => `Ran ${plural(n, 'other action', 'other actions')}`,
  moreSteps: (n: number) => `... ${plural(n, 'more step', 'more steps')}`,

  // the pane
  paneTitle: 'Turn Card',
  paneSession: 'This session',
  paneSessionNone: 'No files changed in this session yet.',
  paneUnpushed: 'Commits not pushed',
  paneNoTurn: 'No turn has finished in this session yet. The card appears here when one does.',
  paneSteps: 'What happened',
  sessionFiles: (n: number, added: number, removed: number) => `${plural(n, 'file', 'files')} changed since the session started (+${added}/-${removed})`,
  sessionCommits: (n: number) => `${plural(n, 'commit', 'commits')} made in this session`,

  // the prompt box and toasts
  pushFilled: 'Written in the prompt box. Press Enter to send it; nothing is pushed until Claude runs it.',
  pushNotFilled: (text: string) => `The prompt box could not take it. To push, tell Claude: ${text}`,
  commitsList: (n: number) => `${plural(n, 'commit', 'commits')} not pushed:`,
  noCommits: 'No commits are waiting to be pushed.',

  // /turn
  noTurnYet: 'No turn has finished in this session yet.',
  usage: 'Usage: /turn | /turn changes | /turn pane | /turn doctor',
  commandDescription: 'Summary of the last turn: /turn, /turn changes, /turn pane, /turn doctor',
  commandHint: '[changes | pane | doctor]',
  textRequest: (text: string) => `Request: ${text}`,
  textDone: (text: string) => `Done: ${text}`,
  textUnpushedFooter: 'Press "Push now" in the card, or ask Claude to push.',
  changesHeader: 'Changes in this session:',
  noRepo: 'This folder is not in a repository, so changes cannot be listed.',
  paneOpened: 'Opened the Turn Card pane.',
  paneFailed: 'Could not open the pane here.',

  // /turn doctor
  doctor: {
    header: 'Turn Card health:',
    git: 'git',
    gitFound: (v: string) => v,
    gitMissing: 'git was not found; the card still shows Claude\'s edits, tests and times.',
    gitFix: 'Install git to see changed files and unpushed commits.',
    repo: 'repository',
    repoFound: (vcs: string, branch: string | null) => `${vcs}${branch ? `, branch ${branch}` : ''}`,
    repoNone: 'this folder is not in a repository; changed files come from Claude\'s own edits.',
    upstream: 'upstream',
    upstreamFound: (u: string) => `pushes go to ${u}`,
    upstreamNone: 'no upstream branch; commits are compared with every remote.',
    upstreamNoRemote: 'no remote; unpushed commits are not checked.',
    baseline: 'session start',
    baselineFound: (rev: string) => `recorded at ${rev}`,
    baselineNone: 'not recorded (no repository at start).',
    language: 'language',
    surface: 'turns seen',
    seen: (n: number) => `${plural(n, 'turn', 'turns')} summarised`,
    fixLabel: 'Fix:',
  },
}

function testCounts(t: TestRun, passed: string, failed: string, skipped: string): string {
  const parts = [t.failed ? `${t.failed} ${failed}` : '', `${t.passed} ${passed}`, t.skipped ? `${t.skipped} ${skipped}` : '']
  return parts.filter(Boolean).join(', ')
}

export type Strings = typeof en

const viPlural = (n: number, word: string) => `${n} ${word}`

const vi: Strings = {
  runner: runnerName,
  title: 'Lượt vừa rồi',
  range: (from, to) => `${from} -> ${to}`,
  sectionDone: 'Đã làm',
  sectionChanges: 'Thay đổi',
  sectionChecks: 'Kiểm tra',
  sectionTime: 'Thời gian',
  asked: text => `Bạn nhờ: ${text}`,
  stopped: 'Dừng trước khi xong',
  failed: 'Kết thúc vì lỗi',
  noAnswer: 'Claude không trả lời bằng chữ.',

  changedFiles: (n, added, removed) => `Sửa ${viPlural(n, 'file')} (+${added}/-${removed})`,
  changedFilesApprox: (n, added, removed) => `Sửa khoảng ${viPlural(n, 'file')} (+${added}/-${removed})`,
  noFilesChanged: 'Không sửa file nào',
  commitsMade: n => `đã tạo ${viPlural(n, 'commit')}`,
  newFile: 'mới',
  binaryFile: 'nhị phân',
  moreFiles: n => `+${n} file nữa`,

  testsShort: t => `chạy test: ${testCounts(t, 'đạt', 'lỗi', 'bỏ qua')}`,
  testsLong: (t, runs) =>
    `${runnerName[t.runner]}: ${t.passed} đạt${t.unit ? ' (gói)' : ''} - ${t.failed} lỗi${t.skipped ? ` - ${t.skipped} bỏ qua` : ''}${runs > 1 ? ` (lần chạy cuối trong ${runs} lần)` : ''}`,

  started: clock => `bắt đầu ${clock}`,
  ended: (clock, dur) => `kết thúc ${clock} (${dur})`,
  underASecond: 'dưới 1 giây',
  seconds: s => `${s} giây`,
  minutes: (m, s) => (s ? `${m} phút ${s} giây` : `${m} phút`),
  hours: (h, m) => (m ? `${h} giờ ${m} phút` : `${h} giờ`),
  elapsedUnderMinute: 'dưới 1 phút',
  elapsedMinutes: m => `${m} phút`,
  elapsedHours: (h, m) => (m ? `${h} giờ ${m} phút` : `${h} giờ`),
  working: (start, elapsed) => `Đang làm - bắt đầu ${start} - ${elapsed}`,

  unpushed: (n, upstream) => (upstream ? `${n} commit chưa push lên ${upstream}` : `${n} commit chưa có trên nhánh từ xa nào`),
  unpushedShort: n => `${n} chưa push`,
  buttons: { push: 'Push ngay', commits: 'Xem commit', details: 'Chi tiết', hide: 'Ẩn', files: 'File', filesOpen: 'File', pane: 'Chi tiết' },
  fileMarkClosed: '▸',
  fileMarkOpen: '▾',

  stepStart: text => (text ? `Bắt đầu: "${text}"` : 'Bắt đầu'),
  stepRead: (files, searches) =>
    [files ? `Đọc ${viPlural(files, 'file')}` : '', searches ? `${files ? 'tìm' : 'Tìm'} ${viPlural(searches, 'lần')}` : ''].filter(Boolean).join(', '),
  stepEdit: file => `Sửa ${file}`,
  stepCreate: file => `Tạo ${file}`,
  stepTest: t => `Chạy test: ${testCounts(t, 'đạt', 'lỗi', 'bỏ qua')}`,
  stepCommit: subject => (subject ? `Tạo commit: ${subject}` : 'Tạo commit'),
  stepCommand: n => `Chạy ${viPlural(n, 'lệnh')}`,
  stepHelper: n => `Nhờ ${viPlural(n, 'trợ lý')} làm một phần`,
  stepWeb: n => `Tra ${viPlural(n, 'trang web')}`,
  stepOther: n => `Chạy ${viPlural(n, 'thao tác khác')}`,
  moreSteps: n => `... còn ${viPlural(n, 'bước')}`,

  paneTitle: 'Thẻ tổng kết',
  paneSession: 'Phiên này',
  paneSessionNone: 'Phiên này chưa sửa file nào.',
  paneUnpushed: 'Commit chưa push',
  paneNoTurn: 'Phiên này chưa có lượt nào kết thúc. Thẻ sẽ hiện ở đây khi có.',
  paneSteps: 'Diễn biến',
  sessionFiles: (n, added, removed) => `Từ đầu phiên đã sửa ${viPlural(n, 'file')} (+${added}/-${removed})`,
  sessionCommits: n => `Trong phiên này đã tạo ${viPlural(n, 'commit')}`,

  pushFilled: 'Đã điền vào ô nhập. Nhấn Enter để gửi; chỉ khi Claude chạy lệnh thì mới push.',
  pushNotFilled: text => `Ô nhập không nhận được chữ. Muốn push, hãy nhắn Claude: ${text}`,
  commitsList: n => `${viPlural(n, 'commit')} chưa push:`,
  noCommits: 'Không có commit nào đang chờ push.',

  noTurnYet: 'Phiên này chưa có lượt nào kết thúc.',
  usage: 'Cách dùng: /turn | /turn changes | /turn pane | /turn doctor',
  commandDescription: 'Tổng kết lượt vừa rồi: /turn, /turn changes, /turn pane, /turn doctor',
  commandHint: '[changes | pane | doctor]',
  textRequest: text => `Yêu cầu: ${text}`,
  textDone: text => `Đã làm: ${text}`,
  textUnpushedFooter: 'Bấm "Push ngay" trên thẻ, hoặc nhờ Claude push.',
  changesHeader: 'Thay đổi trong phiên này:',
  noRepo: 'Thư mục này không nằm trong kho mã, nên không liệt kê được thay đổi.',
  paneOpened: 'Đã mở khung Thẻ tổng kết.',
  paneFailed: 'Không mở được khung ở đây.',

  doctor: {
    header: 'Tình trạng của Thẻ tổng kết:',
    git: 'git',
    gitFound: v => v,
    gitMissing: 'không tìm thấy git; thẻ vẫn cho biết Claude đã sửa gì, test và thời gian.',
    gitFix: 'Cài git để thấy file đã sửa và commit chưa push.',
    repo: 'kho mã',
    repoFound: (vcs, branch) => `${vcs}${branch ? `, nhánh ${branch}` : ''}`,
    repoNone: 'thư mục này không thuộc kho mã; file đã sửa lấy từ các lần sửa của Claude.',
    upstream: 'nhánh từ xa',
    upstreamFound: u => `push sẽ lên ${u}`,
    upstreamNone: 'chưa có nhánh từ xa; commit được so với mọi remote.',
    upstreamNoRemote: 'chưa có remote; không kiểm tra commit chưa push.',
    baseline: 'điểm đầu phiên',
    baselineFound: rev => `ghi tại ${rev}`,
    baselineNone: 'chưa ghi (lúc đầu không có kho mã).',
    language: 'ngôn ngữ',
    surface: 'lượt đã thấy',
    seen: n => `đã tổng kết ${viPlural(n, 'lượt')}`,
    fixLabel: 'Cách sửa:',
  },
}

export const TABLES: Record<Lang, Strings> = { en, vi }
export const EN = en

export const stringsFor = (lang: Lang): Strings => TABLES[lang]

/** The `language` option: `en` and `vi` as they are, anything else (or a missing value) is `auto`. */
export function languageOption(value: unknown): 'auto' | Lang {
  return value === 'en' || value === 'vi' ? value : 'auto'
}

/** Claude Code's own `language` setting ("Vietnamese", "vi", "Tiếng Việt", "vi-VN") as a UI language; anything else is English. */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.normalize('NFC').trim()) ? 'vi' : 'en'
}
