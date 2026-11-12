// Every word the person reads, in English and Vietnamese. Pure data and functions: no engine calls, so it is unit-tested
// without an engine. `vi` is typed as `Strings` (the shape of `en`), so a key missing from either table fails tsc.
// Not in here, on purpose: the prompt "Do it now" and "Draft" send to Claude (taskPrompt) and what the propose_todo tool
// tells the model, which stay English because Claude, not the person, reads them.

export type Lang = 'en' | 'vi'
export type StatusId = 'over' | 'soon' | 'plan' | 'none' | 'done'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const en = {
  status: { over: 'Overdue', soon: 'Due soon', plan: 'Scheduled', none: 'No date', done: 'Done' } as Record<StatusId, string>,
  buttons: {
    now: 'Do it now', draft: 'Draft', done: 'Done', open: 'Open list', hide: 'Hide today', more: 'Show more',
    add: 'Add', dismiss: 'Dismiss', review: 'Review',
  },

  // dates and counts
  dateText: (weekday: number, month: number, day: number) =>
    `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday] ?? ''} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] ?? ''} ${day}`,
  dueToday: (date: string) => `today, ${date}`,
  dueTomorrow: (date: string) => `tomorrow, ${date}`,
  dueOverdue: (days: number, date: string) => `overdue ${days} ${days === 1 ? 'day' : 'days'} (${date})`,
  count: (total: number, over: number, soon: number) =>
    `${total} ${total === 1 ? 'task' : 'tasks'}${over ? `, ${over} overdue` : soon ? `, ${soon} due soon` : ''}`,

  // the band and the pane
  bandTitle: (project: string) => `Tasks for ${project}`,
  moreInList: (n: number) => `${n} more in the list.`,
  latestMemoryPrefix: 'Latest memory: ',
  latestMemorySuffix: (saved: number) => `, ${saved} saved`,
  paneTitle: 'To-do list',
  noOpen: 'No open tasks. Add one with /todo add <task>.',
  recentMemories: 'Recent memories',
  addHint: 'Add a task: /todo add <task>',
  moreOpen: (n: number) => `${n} more open.`,
  problemUntouched: (problem: string) => `${problem} It is left untouched.`,

  // suggestions from Claude
  suggests: 'Claude suggests: ',
  suggestionsHeading: (n: number) => `Claude suggests (${n})`,
  noteLabel: 'Note: ',
  suggestionsMoreInBand: (n: number) => `${n} more ${n === 1 ? 'suggestion' : 'suggestions'}. Type /todo suggestions.`,
  suggestionsLine: (n: number) => `${plural(n, 'task', 'tasks')} suggested by Claude`,
  suggestionArrived: (text: string) => `Claude suggests a task: ${text}. Type /todo suggestions to review it.`,
  suggestionAdded: (text: string) => `Added: ${text}`,

  // /todo
  usage: (withSuggestions: boolean) =>
    `Usage: /todo | /todo add <task> | /todo done <number> | /todo claim${withSuggestions ? ' | /todo suggestions | /todo accept <number|all> | /todo reject <number|all>' : ''}`,
  commandDescription: (withSuggestions: boolean) =>
    `To-do list: open the pane, /todo add <task>, /todo done <number>, /todo claim${withSuggestions ? ', /todo suggestions' : ''}`,
  commandHint: (withSuggestions: boolean) =>
    `[add <task> | done <number> | claim${withSuggestions ? ' | suggestions | accept <number|all> | reject <number|all>' : ''}]`,
  usageAdd: 'Usage: /todo add <task>',
  added: (text: string) => `Added: ${text}`,
  addFailed: (why: string) => `Could not add the task: ${why}`,
  usageDone: 'Usage: /todo done <number> (the number in the /todo list)',
  doneFirst: 'Type /todo first to see the numbered list, then /todo done <number>.',
  noSuchTask: (n: string) => `There is no task ${n} in the last /todo list. Type /todo to see it again.`,
  doneOk: (text: string) => `Done: ${text}`,
  doneFailed: (text: string, why: string) => `Could not mark "${text}" done: ${why}`,
  claimFailed: (why: string) => `Could not claim the tasks: ${why}`,
  claimed: (n: number) => `Linked ${n} ${n === 1 ? 'task' : 'tasks'} to this repository.`,
  nothingToClaim: 'Nothing to claim: every task for this folder name is already linked to this repository.',
  repoUnknown: 'the repository of this session is unknown.',
  thisProject: 'this project',
  listHeader: (project: string, n: number) => `Tasks for ${project} (${n}):`,
  looseHint: (n: number) => `${plural(n, 'task is', 'tasks are')} matched by folder name only, so other folders with this name show ${n === 1 ? 'it' : 'them'} too.`,
  elsewhereHint: (n: number) => `${plural(n, 'task for this folder name is', 'tasks for this folder name are')} linked to another repository and hidden here (for example after you moved this repository or changed its remote).`,
  claimHint: 'Run /todo claim to link them to this repository.',
  warning: (problem: string) => `Warning: ${problem}`,
  listFile: (file: string) => `List file: ${file}`,
  unknownFile: '(unknown)',

  // /todo suggestions, accept, reject
  suggestNone: 'Claude has no suggestions waiting.',
  suggestHeader: (n: number) => `Claude suggests ${plural(n, 'task', 'tasks')} (nothing is saved until you add it):`,
  suggestFooter: 'Type /todo accept <number|all> to add, /todo reject <number|all> to dismiss.',
  suggestNoteInList: (note: string) => `note: ${note}`,
  usageAccept: 'Usage: /todo accept <number> | /todo accept all',
  usageReject: 'Usage: /todo reject <number> | /todo reject all',
  suggestFirst: (verb: string) => `Type /todo suggestions first to see the numbered list, then /todo ${verb} <number>.`,
  noSuchSuggestion: (n: string) => `There is no suggestion ${n} waiting in the last /todo suggestions list (it may be handled already). Type /todo suggestions to see it again.`,
  acceptedOne: (text: string) => `Added: ${text}`,
  acceptedMany: (n: number) => `Added ${plural(n, 'task', 'tasks')} from Claude's suggestions.`,
  acceptFailed: (text: string, why: string) => `Could not add "${text}": ${why}`,
  rejectedOne: (text: string) => `Dismissed: ${text}`,
  rejectedMany: (n: number) => `Dismissed ${plural(n, 'suggestion', 'suggestions')}.`,
  nothingToHandle: 'Nothing to do: those suggestions are already handled.',

  // problems with the file
  noHome: 'The home folder is unknown, so the to-do file cannot be placed. Set the todosFile option to a full path.',
  busy: 'another session is changing the list right now. Nothing was written; try again in a moment.',
  updateFailed: (why: string) => `Could not update your to-do list: ${why}`,
  cannotRead: (file: string, why: string) => `${file} could not be read: ${why}.`,
  taskGone: 'that task is no longer in the file, so nothing was changed.',
  keptChangingWrote: 'the file kept changing while it was being updated, and the change is not in it now. Check the file, then try again.',
  keptChangingNotWritten: 'the file kept changing while it was being updated. Nothing was written; try again.',
  theTodoFile: 'the to-do file',
  writeError: (file: string, wrote: boolean, why: string) =>
    `${file} ${wrote ? 'was written, but reading it back failed' : 'could not be changed'}: ${why}.${wrote ? ' Check the file.' : ' Nothing was written.'}`,
  reviewToast: 'The prompt holds more than the card shows (a note, long or multi-line text, an unusual id or hidden characters): read it in the prompt box, then send it.',
  handOffFailed: (why: string) => `Could not hand the task to Claude: ${why}`,
}

export type Strings = typeof en

const vi: Strings = {
  status: { over: 'Quá hạn', soon: 'Sắp đến hạn', plan: 'Đã lên lịch', none: 'Chưa có hạn', done: 'Xong' },
  buttons: {
    now: 'Làm ngay', draft: 'Soạn nháp', done: 'Xong', open: 'Mở danh sách', hide: 'Ẩn hôm nay', more: 'Xem thêm',
    add: 'Thêm', dismiss: 'Bỏ qua', review: 'Xem',
  },

  dateText: (weekday, month, day) => `${['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][weekday] ?? ''} ${day}/${month}`,
  dueToday: date => `hôm nay, ${date}`,
  dueTomorrow: date => `ngày mai, ${date}`,
  dueOverdue: (days, date) => `quá hạn ${days} ngày (${date})`,
  count: (total, over, soon) => `${total} việc${over ? `, ${over} quá hạn` : soon ? `, ${soon} sắp đến hạn` : ''}`,

  bandTitle: project => `Việc cần làm của ${project}`,
  moreInList: n => `Còn ${n} việc nữa trong danh sách.`,
  latestMemoryPrefix: 'Ghi nhớ mới nhất: ',
  latestMemorySuffix: saved => `, đã lưu ${saved}`,
  paneTitle: 'Danh sách việc cần làm',
  noOpen: 'Chưa có việc nào. Thêm bằng /todo add <việc>.',
  recentMemories: 'Ghi nhớ gần đây',
  addHint: 'Thêm việc: /todo add <việc>',
  moreOpen: n => `Còn ${n} việc nữa.`,
  problemUntouched: problem => `${problem} Tệp được giữ nguyên.`,

  suggests: 'Claude gợi ý: ',
  suggestionsHeading: n => `Claude gợi ý (${n})`,
  noteLabel: 'Ghi chú: ',
  suggestionsMoreInBand: n => `Còn ${n} gợi ý nữa. Gõ /todo suggestions.`,
  suggestionsLine: n => `Claude gợi ý ${n} việc`,
  suggestionArrived: text => `Claude gợi ý một việc: ${text}. Gõ /todo suggestions để xem và duyệt.`,
  suggestionAdded: text => `Đã thêm: ${text}`,

  usage: withSuggestions =>
    `Cách dùng: /todo | /todo add <việc> | /todo done <số> | /todo claim${withSuggestions ? ' | /todo suggestions | /todo accept <số|all> | /todo reject <số|all>' : ''}`,
  commandDescription: withSuggestions =>
    `Việc cần làm: mở bảng, /todo add <việc>, /todo done <số>, /todo claim${withSuggestions ? ', /todo suggestions' : ''}`,
  commandHint: withSuggestions =>
    `[add <việc> | done <số> | claim${withSuggestions ? ' | suggestions | accept <số|all> | reject <số|all>' : ''}]`,
  usageAdd: 'Cách dùng: /todo add <việc>',
  added: text => `Đã thêm: ${text}`,
  addFailed: why => `Không thêm được việc: ${why}`,
  usageDone: 'Cách dùng: /todo done <số> (số thứ tự trong danh sách /todo)',
  doneFirst: 'Hãy gõ /todo trước để xem danh sách có số, rồi gõ /todo done <số>.',
  noSuchTask: n => `Không có việc số ${n} trong danh sách /todo gần nhất. Gõ /todo để xem lại.`,
  doneOk: text => `Xong: ${text}`,
  doneFailed: (text, why) => `Không đánh dấu xong được "${text}": ${why}`,
  claimFailed: why => `Không gắn được các việc: ${why}`,
  claimed: n => `Đã gắn ${n} việc vào kho mã này.`,
  nothingToClaim: 'Không có gì để gắn: mọi việc của thư mục tên này đã gắn vào kho mã này.',
  repoUnknown: 'chưa biết kho mã của phiên này.',
  thisProject: 'dự án này',
  listHeader: (project, n) => `Việc cần làm của ${project} (${n}):`,
  looseHint: n => `${n} việc chỉ khớp theo tên thư mục, nên các thư mục khác cùng tên cũng hiện ${n === 1 ? 'việc này' : 'chúng'}.`,
  elsewhereHint: n => `${n} việc của thư mục tên này được gắn với kho mã khác nên bị ẩn ở đây (ví dụ sau khi bạn chuyển kho mã hoặc đổi remote).`,
  claimHint: 'Gõ /todo claim để gắn chúng vào kho mã này.',
  warning: problem => `Cảnh báo: ${problem}`,
  listFile: file => `Tệp danh sách: ${file}`,
  unknownFile: '(chưa rõ)',

  suggestNone: 'Claude chưa có gợi ý nào đang chờ.',
  suggestHeader: n => `Claude gợi ý ${n} việc (chưa lưu gì cho đến khi bạn thêm):`,
  suggestFooter: 'Gõ /todo accept <số|all> để thêm, /todo reject <số|all> để bỏ qua.',
  suggestNoteInList: note => `ghi chú: ${note}`,
  usageAccept: 'Cách dùng: /todo accept <số> | /todo accept all',
  usageReject: 'Cách dùng: /todo reject <số> | /todo reject all',
  suggestFirst: verb => `Hãy gõ /todo suggestions trước để xem danh sách có số, rồi gõ /todo ${verb} <số>.`,
  noSuchSuggestion: n => `Không có gợi ý số ${n} đang chờ trong danh sách /todo suggestions gần nhất (có thể đã xử lý rồi). Gõ /todo suggestions để xem lại.`,
  acceptedOne: text => `Đã thêm: ${text}`,
  acceptedMany: n => `Đã thêm ${n} việc từ gợi ý của Claude.`,
  acceptFailed: (text, why) => `Không thêm được "${text}": ${why}`,
  rejectedOne: text => `Đã bỏ qua: ${text}`,
  rejectedMany: n => `Đã bỏ qua ${n} gợi ý.`,
  nothingToHandle: 'Không có gì để làm: các gợi ý đó đã được xử lý rồi.',

  noHome: 'Không xác định được thư mục người dùng nên chưa đặt được tệp việc cần làm. Hãy đặt tùy chọn todosFile thành đường dẫn đầy đủ.',
  busy: 'phiên khác đang sửa danh sách. Chưa ghi gì cả; hãy thử lại sau giây lát.',
  updateFailed: why => `Không cập nhật được danh sách việc cần làm: ${why}`,
  cannotRead: (file, why) => `Không đọc được ${file}: ${why}.`,
  taskGone: 'việc đó không còn trong tệp nên chưa thay đổi gì.',
  keptChangingWrote: 'tệp liên tục bị thay đổi trong lúc cập nhật và thay đổi của bạn hiện không có trong tệp. Hãy kiểm tra tệp rồi thử lại.',
  keptChangingNotWritten: 'tệp liên tục bị thay đổi trong lúc cập nhật. Chưa ghi gì cả; hãy thử lại.',
  theTodoFile: 'tệp việc cần làm',
  writeError: (file, wrote, why) =>
    wrote ? `${file} đã được ghi nhưng đọc lại bị lỗi: ${why}. Hãy kiểm tra tệp.` : `Không thay đổi được ${file}: ${why}. Chưa ghi gì cả.`,
  reviewToast: 'Lời nhắc gửi cho Claude có nhiều hơn những gì thẻ hiển thị (ghi chú, văn bản dài hoặc nhiều dòng, mã lạ hay ký tự ẩn): hãy đọc trong ô nhập rồi mới gửi.',
  handOffFailed: why => `Không giao được việc cho Claude: ${why}`,
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
