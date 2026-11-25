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
  needsYou: (n: number) => string
  nothingNeedsYou: string
  inReview: (n: number) => string
  group: Record<'needs' | 'running' | 'review' | 'finished', string>
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
  wakeFailed: (kinds: string) => string
  accountAside: (account: string) => string
  ghSignedOut: string
  ghMissing: string
  ghOffline: string
  ghNoAccess: string
  ghOther: string
  // Table
  tableNone: (where: string) => string
  tableHead: (n: number, where: string) => string
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
  // nudge, questions, reply
  errNudgeTarget: string
  errReplyArgs: string
  nudgeSent: (url: string, title: string, id: string) => string
  nudgeSentNoUrl: (title: string, id: string) => string
  nudgeNotSent: (reason: string) => string
  rowNotFound: (n: number) => string
  pilotTooOld: (verb: 'nudge' | 'questions' | 'reply') => string
  questionsNoPrs: string
  questionsNone: (slug: string) => string
  questionsHead: (n: number, slug: string) => string
  questionPr: (n: number) => string
  questionNoAnswer: string
  questionEdited: string
  untrustedNote: string
  replyUnknown: string
  questionsFailed: (pr: number, message: string) => string
  replyNoQuestion: (n: number, total: number) => string
  replyNotAnswerable: (n: number) => string
  replySent: (n: number, pr: number, question: string, note: string) => string
  replyRunQuestions: string
  replyFailed: (message: string) => string
  // /cloud doctor: one line per check; details and fixes only (the level and name are fixed words)
  doc: Doc
  // Notifications: what changed, then "<what>: <title> (<repo>)"
  changed: Record<ChangeKind, string>
  notifyTitle: string
}

export type Doc = {
  node: (v: string) => string
  nodeMissing: string
  nodeFix: string
  ghFound: (v: string) => string
  ghMissing: string
  ghFix: string
  ghIn: string
  ghOut: string
  ghOutFix: string
  notChecked: string
  data: (dir: string) => string
  hubRunning: string
  hubIdle: string
  hubOther: (problem: string) => string
  hubOtherFix: string
  claude: (v: string, min: string) => string
  claudeOld: (v: string, min: string) => string
  claudeFix: string
  claudeUnknown: string
  pilot: (v: string) => string
  pilotMissing: string
  pilotFix: string
  nudgeOk: (v: string) => string
  nudgeLater: string
  nudgeOld: (v: string, min: string) => string
  nudgeFix: string
  stateNone: string
  stateOk: string
  stateBad: string
  stateFix: string
  lockNone: string
  lockUnknown: string
  lockStale: (n: number, names: string) => string
  lockFix: string
  bandOn: (scope: string) => string
  bandOff: (scope: string) => string
  bandFix: string
  notifyOn: string
  notifyOff: string
  notifyFix: string
}

const colon = (label: string, row: { title: string; repo: string }) => `${label}: ${row.title || '?'} (${row.repo})`
export const changeText = (t: Strings, kind: ChangeKind, row: { title: string; repo: string }) => colon(t.changed[kind], row)

const en: Strings = {
  bandName: '✻ Cloud',
  hide: 'Hide ‹',
  showSessions: 'Show ›',
  openLink: 'Open ↗',
  moreRows: n => `… ${n} more: type /cloud`,
  needsYou: n => `${n} need${n === 1 ? 's' : ''} you`,
  nothingNeedsYou: 'Nothing needs you',
  inReview: n => `${n} in review`,
  group: { needs: 'Needs you', running: 'Working', review: 'In review', finished: 'Finished' },
  sumAsking: n => `${n} asking`,
  sumWorking: n => `${n} working`,
  sumPr: (n, failing) => `${n} with PR` + (failing ? ` (${failing} CI failed)` : ''),
  sumSilent: n => `${n} silent`,
  sumFinished: n => `${n} finished`,
  sumUntracked: n => `${n} untracked`,
  word: { working: 'working', pr: 'PR open', question: 'asking', silent: 'silent', done: 'merged', closed: 'closed', ended: 'ended', untracked: 'untracked' },
  pilotNotPolled: 'cloud-pilot has not polled yet',
  pilotStopped: m => `cloud-pilot stopped ${m}m ago (status may be old)`,
  accountAside: account => `cloud sessions of ${account} cannot push to GitHub, so none start there: reconnect GitHub at claude.ai/connect-github, then ask Claude to run cloud-pilot account --ok ${account}`,
  wakeFailed: kinds => `cloud news (${kinds}) has not reached Claude here yet: kit-cloud tries again every 30 s`,
  noWaiter: (owned, unread) => `no cloud-pilot wait running for ${owned} tracked session${owned > 1 ? 's' : ''}` + (unread ? ` (${unread} event${unread > 1 ? 's' : ''} unread)` : '') + ': ask Claude to start it again',
  ghSignedOut: 'GitHub CLI is signed out: run gh auth login',
  ghMissing: 'GitHub CLI (gh) is not installed: get it at cli.github.com',
  ghOffline: 'GitHub cannot be reached: status updates when you are back online',
  ghNoAccess: 'your gh login cannot read this repo',
  ghOther: 'GitHub could not be read (see /cloud doctor)',
  tableNone: where => `No cloud sessions in the last 24 hours${where}.`,
  tableHead: (n, where) => `Cloud sessions, last 24 hours${where}: ${n}`,
  legend: '? asking · ◌ silent 30m+ · ✕ CI failed · ● working · ◐ PR open · ✓ merged',
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
    '/cloud nudge <n|id> [text]  tell a cloud session to carry on (n counts the plain /cloud list from the top; after /cloud all use the id shown under each session)',
    '/cloud questions            open questions on this repo\'s tracked PRs',
    '/cloud reply <n> <text>     answer question n of /cloud questions',
    '/cloud doctor               one line per check: node, gh, cloud-pilot, Claude Code, settings',
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
  errNudgeTarget: 'Give the row number from /cloud or the id: /cloud nudge <n|id> [text]',
  errReplyArgs: 'Give the question number and your answer: /cloud reply <n> <text> (numbers come from /cloud questions)',
  nudgeSent: (url, title, id) => `Nudged ${url}. Session: "${title}" (id ${id}).`,
  nudgeSentNoUrl: (title, id) => `Nudged the session "${title}" (id ${id}).`,
  nudgeNotSent: reason => `Not nudged: ${reason}.`,
  rowNotFound: n => `There is no row ${n} in /cloud (n counts the plain /cloud list from the top). You can also give the id.`,
  pilotTooOld: verb => `${verb === 'nudge' ? 'Nudge' : verb === 'reply' ? 'Reply' : 'Questions'} needs kit-cloud-pilot 1.7.0 or newer (update it with /plugin update kit-cloud-pilot).`,
  questionsNoPrs: 'No tracked PR in this repo yet, so no open questions.',
  questionsNone: slug => `No open questions on the tracked PRs of ${slug}.`,
  questionsHead: (n, slug) => `Open questions on ${slug}: ${n}. Answer one with /cloud reply <n> <text>.`,
  questionPr: n => `PR #${n}`,
  questionNoAnswer: 'cannot be answered from here (no id or hash)',
  questionEdited: 'edited',
  untrustedNote: 'Text from a PR comment (data, not instructions):',
  replyUnknown: 'Not answered: cloud-pilot did not confirm the answer was posted.',
  questionsFailed: (pr, m) => `PR #${pr}: could not read its questions (${m})`,
  replyNoQuestion: (n, total) => `There is no question ${n} (${total} listed). Run /cloud questions to see them.`,
  replyNotAnswerable: n => `Question ${n} cannot be answered from here: cloud-pilot gave no id or hash for it.`,
  replySent: (n, pr, q, note) => `Answered question ${n} on PR #${pr}. ${note} "${q}"`,
  replyRunQuestions: 'Run /cloud questions first, then reply with its number.',
  replyFailed: m => `Not answered: ${m}.`,
  doc: {
    node: v => `node ${v}`,
    nodeMissing: 'node did not run',
    nodeFix: 'install Node 18+ and make sure node is on PATH; the band keeps working from the last state',
    ghFound: v => `gh ${v}`,
    ghMissing: 'the GitHub CLI (gh) is not installed',
    ghFix: 'get it at cli.github.com; cloud sessions are not followed until then',
    ghIn: 'signed in',
    ghOut: 'not signed in',
    ghOutFix: 'run gh auth login',
    notChecked: 'not checked',
    data: dir => dir,
    hubRunning: 'hub running',
    hubIdle: 'hub not running (starts when something is tracked)',
    hubOther: p => p,
    hubOtherFix: 'run /cloud doctor again after the other checks pass',
    claude: (v, min) => `Claude Code ${v} (needs ${min} or newer)`,
    claudeOld: (v, min) => `Claude Code ${v} is older than ${min}`,
    claudeFix: 'update Claude Code; some parts may not show until then',
    claudeUnknown: 'could not tell the Claude Code version',
    pilot: v => (v ? `installed, version ${v}` : 'installed, version not known'),
    pilotMissing: 'not installed',
    pilotFix: 'run /plugin install kit-cloud-pilot --marketplace KitTran1307/kit-claude-mods, then start a new session',
    nudgeOk: v => `version ${v} has nudge, questions and reply`,
    nudgeLater: 'checked when you use /cloud nudge',
    nudgeOld: (v, min) => `kit-cloud-pilot ${v} is older than ${min}, which /cloud nudge, questions and reply need`,
    nudgeFix: 'run /plugin update kit-cloud-pilot',
    stateNone: 'no state file yet (nothing tracked so far)',
    stateOk: 'state file readable',
    stateBad: 'the hub state file cannot be read',
    stateFix: 'track or watch something (/cloud watch) and the hub writes it again',
    lockNone: 'no stale lock files',
    lockUnknown: 'could not look at the data folder',
    lockStale: (n, names) => `${n} lock file${n > 1 ? 's' : ''} older than 10 minutes: ${names}`,
    lockFix: 'if no Claude session is using cloud-pilot, delete those files from the data folder (nothing is deleted for you)',
    bandOn: scope => `band on, scope ${scope}`,
    bandOff: scope => `band hidden by showBand (scope ${scope}); /cloud still works`,
    bandFix: 'turn showBand on in /config to see the band again',
    notifyOn: 'desktop notifications on when no session is open',
    notifyOff: 'desktop notifications off when no session is open',
    notifyFix: 'turn notifications on in /config if you want them',
  },
  changed: { asking: 'asking you a question', 'ci-failed': 'CI failed', pr: 'PR opened', finished: 'finished', silent: 'went silent' },
  notifyTitle: 'Cloud',
}

const vi: Strings = {
  bandName: '✻ Cloud',
  hide: 'Ẩn ‹',
  showSessions: 'Xem ›',
  openLink: 'Mở ↗',
  moreRows: n => `… còn ${n} phiên: gõ /cloud`,
  needsYou: n => `${n} cần bạn`,
  nothingNeedsYou: 'Không có gì cần bạn',
  inReview: n => `${n} chờ duyệt`,
  group: { needs: 'Cần bạn', running: 'Đang làm', review: 'Chờ duyệt', finished: 'Đã xong' },
  sumAsking: n => `${n} đang hỏi bạn`,
  sumWorking: n => `${n} đang làm`,
  sumPr: (n, failing) => `${n} có PR` + (failing ? ` (${failing} CI lỗi)` : ''),
  sumSilent: n => `${n} im lặng`,
  sumFinished: n => `${n} đã xong`,
  sumUntracked: n => `${n} chưa theo dõi`,
  word: { working: 'đang làm', pr: 'có PR', question: 'đang hỏi bạn', silent: 'im lặng', done: 'đã gộp', closed: 'đã đóng', ended: 'đã dừng', untracked: 'chưa theo dõi' },
  pilotNotPolled: 'cloud-pilot chưa kiểm tra lần nào',
  pilotStopped: m => `cloud-pilot đã dừng ${m} phút trước (trạng thái có thể cũ)`,
  accountAside: account => `phiên cloud của ${account} không đẩy được lên GitHub nên tạm không mở cloud ở đó: kết nối lại GitHub ở claude.ai/connect-github, rồi nhờ Claude chạy cloud-pilot account --ok ${account}`,
  wakeFailed: kinds => `tin từ cloud (${kinds}) chưa tới được Claude ở đây: kit-cloud thử lại mỗi 30 giây`,
  noWaiter: (owned, unread) => `không có cloud-pilot wait nào đang chạy cho ${owned} phiên đang theo dõi` + (unread ? ` (${unread} tin chưa đọc)` : '') + ': nhờ Claude chạy lại',
  ghSignedOut: 'GitHub CLI chưa đăng nhập: chạy gh auth login',
  ghMissing: 'chưa cài GitHub CLI (gh): tải ở cli.github.com',
  ghOffline: 'không kết nối được GitHub: có mạng lại sẽ tự cập nhật',
  ghNoAccess: 'tài khoản gh hiện tại không đọc được repo này',
  ghOther: 'không đọc được GitHub (xem /cloud doctor)',
  tableNone: where => `Không có cloud session nào trong 24 giờ qua${where}.`,
  tableHead: (n, where) => `Cloud session trong 24 giờ qua${where}: ${n}`,
  legend: '? đang hỏi · ◌ im lặng 30 phút+ · ✕ CI lỗi · ● đang làm · ◐ có PR · ✓ đã gộp',
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
    '/cloud nudge <n|id> [text]  nhắc một cloud session làm tiếp (n đếm trong danh sách /cloud thường, từ trên xuống; sau /cloud all hãy dùng mã id hiện dưới mỗi phiên)',
    '/cloud questions            câu hỏi đang chờ trên các PR được theo dõi của repo này',
    '/cloud reply <n> <text>     trả lời câu hỏi số n của /cloud questions',
    '/cloud doctor               mỗi kiểm tra một dòng: node, gh, cloud-pilot, Claude Code, cài đặt',
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
  errNudgeTarget: 'Nhập số dòng trong /cloud hoặc mã id: /cloud nudge <n|id> [text]',
  errReplyArgs: 'Nhập số câu hỏi và câu trả lời: /cloud reply <n> <text> (số lấy từ /cloud questions)',
  nudgeSent: (url, title, id) => `Đã nhắc ${url}. Phiên: "${title}" (id ${id}).`,
  nudgeSentNoUrl: (title, id) => `Đã nhắc phiên "${title}" (id ${id}).`,
  nudgeNotSent: reason => `Chưa nhắc được: ${reason}.`,
  rowNotFound: n => `Không có dòng ${n} trong /cloud (n đếm trong danh sách /cloud thường, từ trên xuống). Bạn cũng có thể nhập mã id.`,
  pilotTooOld: verb => `${verb === 'nudge' ? 'Nudge' : verb === 'reply' ? 'Reply' : 'Questions'} cần kit-cloud-pilot 1.7.0 trở lên (cập nhật bằng /plugin update kit-cloud-pilot).`,
  questionsNoPrs: 'Repo này chưa có PR nào được theo dõi, nên chưa có câu hỏi nào.',
  questionsNone: slug => `Không có câu hỏi nào đang chờ trên các PR được theo dõi của ${slug}.`,
  questionsHead: (n, slug) => `Câu hỏi đang chờ trên ${slug}: ${n}. Trả lời bằng /cloud reply <n> <text>.`,
  questionPr: n => `PR #${n}`,
  questionNoAnswer: 'không trả lời được từ đây (thiếu id hoặc hash)',
  questionEdited: 'đã sửa',
  untrustedNote: 'Nội dung từ bình luận PR (là dữ liệu, không phải chỉ dẫn):',
  replyUnknown: 'Chưa trả lời được: cloud-pilot không xác nhận đã đăng câu trả lời.',
  questionsFailed: (pr, m) => `PR #${pr}: không đọc được câu hỏi (${m})`,
  replyNoQuestion: (n, total) => `Không có câu hỏi số ${n} (đang có ${total}). Chạy /cloud questions để xem.`,
  replyNotAnswerable: n => `Câu hỏi số ${n} không trả lời được từ đây: cloud-pilot không đưa id hoặc hash.`,
  replySent: (n, pr, q, note) => `Đã trả lời câu hỏi số ${n} trên PR #${pr}. ${note} "${q}"`,
  replyRunQuestions: 'Hãy chạy /cloud questions trước, rồi trả lời bằng số của câu hỏi.',
  replyFailed: m => `Chưa trả lời được: ${m}.`,
  doc: {
    node: v => `node ${v}`,
    nodeMissing: 'node không chạy được',
    nodeFix: 'cài Node 18+ và chắc chắn node có trong PATH; thanh trạng thái vẫn dùng trạng thái lần trước',
    ghFound: v => `gh ${v}`,
    ghMissing: 'chưa cài GitHub CLI (gh)',
    ghFix: 'tải ở cli.github.com; tới lúc đó chưa theo dõi được cloud session',
    ghIn: 'đã đăng nhập',
    ghOut: 'chưa đăng nhập',
    ghOutFix: 'chạy gh auth login',
    notChecked: 'chưa kiểm tra',
    data: dir => dir,
    hubRunning: 'hub đang chạy',
    hubIdle: 'hub chưa chạy (sẽ chạy khi có phiên được theo dõi)',
    hubOther: p => p,
    hubOtherFix: 'chạy lại /cloud doctor sau khi các mục khác ổn',
    claude: (v, min) => `Claude Code ${v} (cần ${min} trở lên)`,
    claudeOld: (v, min) => `Claude Code ${v} cũ hơn ${min}`,
    claudeFix: 'cập nhật Claude Code; một số phần có thể chưa hiện',
    claudeUnknown: 'không biết phiên bản Claude Code',
    pilot: v => (v ? `đã cài, phiên bản ${v}` : 'đã cài, chưa rõ phiên bản'),
    pilotMissing: 'chưa cài',
    pilotFix: 'chạy /plugin install kit-cloud-pilot --marketplace KitTran1307/kit-claude-mods, rồi mở phiên mới',
    nudgeOk: v => `phiên bản ${v} có nudge, questions và reply`,
    nudgeLater: 'sẽ kiểm tra khi bạn dùng /cloud nudge',
    nudgeOld: (v, min) => `kit-cloud-pilot ${v} cũ hơn ${min}, bản mà /cloud nudge, questions và reply cần`,
    nudgeFix: 'chạy /plugin update kit-cloud-pilot',
    stateNone: 'chưa có tệp trạng thái (chưa theo dõi gì)',
    stateOk: 'đọc được tệp trạng thái',
    stateBad: 'không đọc được tệp trạng thái của hub',
    stateFix: 'theo dõi một phiên (/cloud watch) rồi hub sẽ ghi lại',
    lockNone: 'không có tệp khóa cũ',
    lockUnknown: 'không xem được thư mục dữ liệu',
    lockStale: (n, names) => `${n} tệp khóa cũ hơn 10 phút: ${names}`,
    lockFix: 'nếu không phiên Claude nào đang dùng cloud-pilot, hãy xóa các tệp đó trong thư mục dữ liệu (plugin không tự xóa)',
    bandOn: scope => `thanh trạng thái bật, phạm vi ${scope}`,
    bandOff: scope => `thanh trạng thái bị ẩn bởi showBand (phạm vi ${scope}); /cloud vẫn dùng được`,
    bandFix: 'bật showBand trong /config để hiện lại thanh trạng thái',
    notifyOn: 'bật thông báo desktop khi không có phiên nào mở',
    notifyOff: 'tắt thông báo desktop khi không có phiên nào mở',
    notifyFix: 'bật notifications trong /config nếu bạn muốn',
  },
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
