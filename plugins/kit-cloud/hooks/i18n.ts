// Every user-visible string of kit-cloud, in English and Vietnamese. Both tables have the same keys: the `Strings`
// type makes a missing key a type error. Command names, ids, URLs, `gh`, `node` and `claude/*` stay as they are.
import type { CloudState } from '../types'

export type Lang = 'en' | 'vi'
export type LanguageOption = 'auto' | 'en' | 'vi'

/** What a change in a session is called when it is announced. */
export type ChangeKind = 'asking' | 'ci-failed' | 'pr' | 'finished' | 'silent'

export type Strings = {
  // Band
  bandName: string
  hide: string
  showSessions: string
  openLink: string
  moreRows: (n: number) => string
  // Summary parts
  sumAsking: (n: number) => string
  sumWorking: (n: number) => string
  sumPr: (n: number, failing: number) => string
  sumSilent: (n: number) => string
  sumFinished: (n: number) => string
  sumUntracked: (n: number) => string
  // State words
  word: Record<CloudState, string>
  // Notes
  pilotNotPolled: string
  pilotStopped: (minutes: number) => string
  noWaiter: (owned: number, unread: number) => string
  // Table
  tableNone: (where: string) => string
  tableHead: (n: number, where: string) => string
  colId: string
  colAccount: string
  colRepo: string
  colTask: string
  colStatus: string
  colAge: string
  legend: string
  everyAccount: string
  listFooter: string
  // Commands
  commandDescription: string
  usage: string
  errUntrackId: string
  errTrackArgs: string
  errTrackBranch: (branch: string) => string
  errUnknown: (verb: string) => string
  installPilot: string
  noOrigin: string
  pilotFailed: (message: string) => string
  unknownError: string
  doctorReady: (node: string, gh: string, dir: string, running: boolean) => string
  doctorNeeds: (problems: string[]) => string
  doctorUnknown: string
  watching: (slug: string) => string
  unwatched: (slug: string, n: number) => string
  tracking: (what: string, slug: string, id: string) => string
  trackNoBranch: string
  untracked: (id: string) => string
  untrackMissing: (id: string) => string
  stateUnreadable: (message: string) => string
  nodeFailed: (message: string) => string
  // Notifications: what changed, then "<what>: <title> (<repo>)"
  changed: Record<ChangeKind, string>
  notifyTitle: string
}

const colon = (label: string, row: { title: string; repo: string }) => `${label}: ${row.title || '?'} (${row.repo})`
export const changeText = (t: Strings, kind: ChangeKind, row: { title: string; repo: string }) => colon(t.changed[kind], row)

const en: Strings = {
  bandName: '☁ Cloud ',
  hide: '  ▾ hide',
  showSessions: '  ▸ show sessions',
  openLink: 'open',
  moreRows: n => `… ${n} more: type /cloud`,
  sumAsking: n => `${n} asking`,
  sumWorking: n => `${n} working`,
  sumPr: (n, failing) => `${n} with PR` + (failing ? ` (${failing} CI failed)` : ''),
  sumSilent: n => `${n} silent`,
  sumFinished: n => `${n} finished`,
  sumUntracked: n => `${n} untracked`,
  word: { working: 'working', pr: 'PR open', question: 'asking', silent: 'silent', done: 'merged', closed: 'closed', ended: 'ended', untracked: 'untracked' },
  pilotNotPolled: 'cloud-pilot has not polled yet',
  pilotStopped: m => `cloud-pilot stopped ${m}m ago (status may be old)`,
  noWaiter: (owned, unread) => `no cloud-pilot wait running for ${owned} tracked session${owned > 1 ? 's' : ''}` + (unread ? ` (${unread} event${unread > 1 ? 's' : ''} unread)` : '') + ': ask Claude to start it again',
  tableNone: where => `No cloud sessions in the last 24 hours${where}.`,
  tableHead: (n, where) => `Cloud sessions, last 24 hours${where}: ${n}`,
  colId: 'id',
  colAccount: 'account',
  colRepo: 'repo',
  colTask: 'task',
  colStatus: 'status',
  colAge: 'age',
  legend: '● working · ? asking · ◐ PR open · ⚠ silent over 30m: open the link to look',
  everyAccount: 'every account and repo',
  listFooter: '/cloud all: every account and repo. /cloud help: all commands.',
  commandDescription: 'Cloud sessions of this account and repo (/cloud help for more)',
  usage: [
    '/cloud                      cloud sessions of this account and repo',
    '/cloud all                  every account and repo',
    '/cloud track <url> [branch] track a cloud session (its claude.ai link, and its claude/... branch when known)',
    '/cloud untrack <id>         stop tracking (ids are in /cloud)',
    '/cloud watch                track every new claude/* branch of this repo by itself',
    '/cloud unwatch              stop watching this repo',
    '/cloud doctor               check node, gh and the gh login',
  ].join('\n'),
  errUntrackId: 'Give the id from /cloud: /cloud untrack <id>',
  errTrackArgs: 'Give the session link or its claude/... branch: /cloud track <url> [branch]',
  errTrackBranch: b => `Not a claude/... branch name: ${b}`,
  errUnknown: v => `Unknown: /cloud ${v}`,
  installPilot: 'kit-cloud reads the sessions cloud-pilot tracks. Install it: /plugin install kit-cloud-pilot --marketplace KitTran1307/kit-claude-mods (then start a new session).',
  noOrigin: 'This folder has no GitHub "origin" remote, so there is no repo to track here.',
  pilotFailed: m => `cloud-pilot could not do it: ${m}\nTry /cloud doctor.`,
  unknownError: 'unknown error',
  doctorReady: (node, gh, dir, running) => `cloud-pilot is ready: node ${node}, gh ${gh} signed in. Data: ${dir}. Hub ${running ? 'running' : 'not running (starts when something is tracked)'}.`,
  doctorNeeds: problems => `cloud-pilot needs:\n${problems.map(p => `- ${p}`).join('\n')}`,
  doctorUnknown: 'unknown problem',
  watching: slug => `Watching ${slug}: each new claude/* branch is tracked by itself.`,
  unwatched: (slug, n) => `Stopped watching ${slug} (${n} watch track). Sessions already tracked go on.`,
  tracking: (what, slug, id) => `Tracking ${what} in ${slug} (id ${id}).`,
  trackNoBranch: '\nWithout its claude/... branch the hub can only show it as started; add the branch when you know it.',
  untracked: id => `Stopped tracking ${id}.`,
  untrackMissing: id => `No tracked session has id ${id}.`,
  stateUnreadable: m => `Could not read cloud-pilot's state: ${m}`,
  nodeFailed: m => `node did not run (${m}). Install Node 18+ and make sure node is on PATH.`,
  changed: { asking: 'asking you a question', 'ci-failed': 'CI failed', pr: 'PR opened', finished: 'finished', silent: 'went silent' },
  notifyTitle: 'Cloud',
}

const vi: Strings = {
  bandName: '☁ Cloud ',
  hide: '  ▾ ẩn',
  showSessions: '  ▸ xem các phiên',
  openLink: 'mở',
  moreRows: n => `… còn ${n} phiên: gõ /cloud`,
  sumAsking: n => `${n} đang hỏi bạn`,
  sumWorking: n => `${n} đang làm`,
  sumPr: (n, failing) => `${n} có PR` + (failing ? ` (${failing} CI lỗi)` : ''),
  sumSilent: n => `${n} im lặng`,
  sumFinished: n => `${n} đã xong`,
  sumUntracked: n => `${n} chưa theo dõi`,
  word: { working: 'đang làm', pr: 'có PR', question: 'đang hỏi bạn', silent: 'im lặng', done: 'đã gộp', closed: 'đã đóng', ended: 'đã dừng', untracked: 'chưa theo dõi' },
  pilotNotPolled: 'cloud-pilot chưa kiểm tra lần nào',
  pilotStopped: m => `cloud-pilot đã dừng ${m} phút trước (trạng thái có thể cũ)`,
  noWaiter: (owned, unread) => `không có cloud-pilot wait nào đang chạy cho ${owned} phiên đang theo dõi` + (unread ? ` (${unread} tin chưa đọc)` : '') + ': nhờ Claude chạy lại',
  tableNone: where => `Không có cloud session nào trong 24 giờ qua${where}.`,
  tableHead: (n, where) => `Cloud session trong 24 giờ qua${where}: ${n}`,
  colId: 'mã',
  colAccount: 'tài khoản',
  colRepo: 'repo',
  colTask: 'việc',
  colStatus: 'trạng thái',
  colAge: 'lâu',
  legend: '● đang làm · ? đang hỏi bạn · ◐ có PR · ⚠ im lặng quá 30 phút: mở link để xem',
  everyAccount: 'mọi tài khoản và repo',
  listFooter: '/cloud all: mọi tài khoản và repo. /cloud help: tất cả lệnh.',
  commandDescription: 'Cloud session của tài khoản và repo này (/cloud help để xem thêm)',
  usage: [
    '/cloud                      cloud session của tài khoản và repo này',
    '/cloud all                  mọi tài khoản và repo',
    '/cloud track <url> [branch] theo dõi một cloud session (link claude.ai của nó, và nhánh claude/... nếu biết)',
    '/cloud untrack <id>         ngừng theo dõi (mã id có trong /cloud)',
    '/cloud watch                tự theo dõi mọi nhánh claude/* mới của repo này',
    '/cloud unwatch              ngừng theo dõi repo này',
    '/cloud doctor               kiểm tra node, gh và đăng nhập gh',
  ].join('\n'),
  errUntrackId: 'Nhập mã id trong /cloud: /cloud untrack <id>',
  errTrackArgs: 'Nhập link phiên hoặc nhánh claude/... của nó: /cloud track <url> [branch]',
  errTrackBranch: b => `Không phải tên nhánh claude/...: ${b}`,
  errUnknown: v => `Không hiểu lệnh: /cloud ${v}`,
  installPilot: 'kit-cloud đọc các phiên mà cloud-pilot theo dõi. Hãy cài nó: /plugin install kit-cloud-pilot --marketplace KitTran1307/kit-claude-mods (rồi mở phiên mới).',
  noOrigin: 'Thư mục này không có remote "origin" trên GitHub, nên không có repo nào để theo dõi.',
  pilotFailed: m => `cloud-pilot không làm được: ${m}\nThử /cloud doctor.`,
  unknownError: 'lỗi không rõ',
  doctorReady: (node, gh, dir, running) => `cloud-pilot sẵn sàng: node ${node}, gh ${gh} đã đăng nhập. Dữ liệu: ${dir}. Hub ${running ? 'đang chạy' : 'chưa chạy (sẽ chạy khi có phiên được theo dõi)'}.`,
  doctorNeeds: problems => `cloud-pilot còn thiếu:\n${problems.map(p => `- ${p}`).join('\n')}`,
  doctorUnknown: 'lỗi không rõ',
  watching: slug => `Đang theo dõi ${slug}: mỗi nhánh claude/* mới sẽ tự được theo dõi.`,
  unwatched: (slug, n) => `Đã ngừng theo dõi ${slug} (${n} mục theo dõi). Các phiên đã theo dõi vẫn tiếp tục.`,
  tracking: (what, slug, id) => `Đang theo dõi ${what} trong ${slug} (id ${id}).`,
  trackNoBranch: '\nKhông có nhánh claude/..., hub chỉ báo được là phiên đã bắt đầu; hãy thêm nhánh khi bạn biết.',
  untracked: id => `Đã ngừng theo dõi ${id}.`,
  untrackMissing: id => `Không có phiên nào được theo dõi với id ${id}.`,
  stateUnreadable: m => `Không đọc được trạng thái của cloud-pilot: ${m}`,
  nodeFailed: m => `node không chạy được (${m}). Hãy cài Node 18+ và chắc chắn node có trong PATH.`,
  changed: { asking: 'đang hỏi bạn', 'ci-failed': 'CI lỗi', pr: 'có PR', finished: 'đã xong', silent: 'im lặng' },
  notifyTitle: 'Cloud',
}

export const STRINGS: Record<Lang, Strings> = { en, vi }

/**
 * Claude Code's own `language` setting ("vietnamese", "Tiếng Việt", "vi") to a language; anything else, or not a
 * string, is English.
 */
export function languageFromSetting(value: unknown): Lang {
  return typeof value === 'string' && /^(vi|viet|tiếng\s*việt)/i.test(value.trim()) ? 'vi' : 'en'
}

/** The `language` option: en and vi are taken as they are; anything else is auto, which follows Claude Code's own setting. */
export function languageOption(value: unknown): LanguageOption {
  return value === 'en' || value === 'vi' ? value : 'auto'
}
