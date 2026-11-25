// Every word the person reads, in English and Vietnamese. Pure data and functions: no engine calls, so it is unit-tested
// without an engine. `vi` is typed as `Strings` (the shape of `en`), so a key missing from either table fails tsc.

export type Lang = 'en' | 'vi'
export type StateId = 'running' | 'waiting' | 'starting'

const en = {
  state: { running: 'Running', waiting: 'Waiting', starting: 'Starting' } as Record<StateId, string>,
  buttons: { reply: 'Reply' },

  // the board
  title: 'Agent Board',
  count: (total: number, waiting: number) => `${total} running${waiting ? `, ${waiting} waiting` : ''}`,
  ctx: 'context',
  replyHint: 'opens its conversation',
  more: (n: number) => `+${n} more`,
  paneTitle: 'Agent Board',
  paneEmpty: 'No subagents are running.',
  openDenied: (why: string) => `Could not open that agent from here (${why}). Open it from Claude Code's agent list instead.`,
  openUnavailable: "This version of Claude Code cannot open an agent from the board. Open it from Claude Code's agent list instead.",

  // /board
  commandDescription: 'Agent Board: list the running subagents, /board pane, /board doctor',
  commandHint: '[pane | doctor]',
  usage: 'Usage: /board | /board pane | /board doctor',
  listHeader: (total: number, waiting: number) => `Subagents (${total} running${waiting ? `, ${waiting} waiting` : ''}):`,
  listEmpty: 'No subagents are running.',
  listUnknown: 'This Claude Code does not list its subagents, so the board stays empty.',
  paneNone: 'No subagents are running. The board opens by itself when one starts.',
  paneOpened: 'Opened the Agent Board pane.',
  paneWaits: (why: string) => `The pane is open but not drawn yet: ${why}. The band shows the board meanwhile.`,
  paneNotHere: 'The pane is for the terminal. Here the board is the band above the prompt.',
  paneOff: 'The pane is turned off (usePane), so the band is used.',
  paneFailed: 'This Claude Code could not open a pane. The band shows the board instead.',

  // /board doctor
  doctor: {
    summary: (pass: number, warn: number, fail: number) => `${pass} ok, ${warn} to look at, ${fail} broken.`,
    checkFailedFix: 'Nothing needed; this check could not run.',
    versionOk: (v: string) => `Claude Code ${v}`,
    versionUnknown: 'could not tell which Claude Code version this is',
    versionUnknownFix: 'Run claude --version in a terminal to see it.',
    listOk: (total: number, running: number) => `the engine lists ${total} ${total === 1 ? 'agent' : 'agents'}, ${running} running or waiting`,
    listMissing: 'the engine does not list its subagents, so the board stays empty',
    listMissingFix: 'Update Claude Code (run: claude update).',
    limitsOk: (concurrent: number, background: boolean) =>
      `up to ${concurrent} subagents at once; background subagents are ${background ? 'on' : 'off here'}`,
    surfaceIs: (surface: string) => `surface: ${surface}`,
    surfaceUnknown: 'surface unknown; the band is used',
    paneNone: 'the pane is not open',
    paneOpen: (placed: boolean): string => (placed ? 'the pane is open and drawn' : 'the pane is open but waits undrawn (the terminal is narrow)'),
    paneNotUsed: 'not used here: the pane is for a terminal with usePane on; the band is used',
    settingsAllOn: 'the band and the pane are on',
    settingsOff: (names: string) => `turned off: ${names}`,
    settingsOffFix: 'Turn them back on in the plugin options (claude plugin configure kit-agents) if you want them.',
    maxCardsIs: (n: number) => `shows up to ${n} ${n === 1 ? 'subagent' : 'subagents'}, the rest on a "+N more" line`,
    languageIs: (lang: string, setting: string) => `${lang} (option: ${setting})`,
  },
}

export type Strings = typeof en

const vi: Strings = {
  state: { running: 'Đang chạy', waiting: 'Đang chờ', starting: 'Đang khởi động' },
  buttons: { reply: 'Trả lời' },

  title: 'Bảng subagent',
  count: (total, waiting) => `${total} đang chạy${waiting ? `, ${waiting} đang chờ` : ''}`,
  ctx: 'ngữ cảnh',
  replyHint: 'mở cuộc trò chuyện của nó',
  more: n => `+${n} nữa`,
  paneTitle: 'Bảng subagent',
  paneEmpty: 'Không có subagent nào đang chạy.',
  openDenied: why => `Không mở được subagent này từ đây (${why}). Hãy mở nó từ danh sách agent của Claude Code.`,
  openUnavailable: 'Phiên bản Claude Code này không mở được subagent từ bảng. Hãy mở nó từ danh sách agent của Claude Code.',

  commandDescription: 'Bảng subagent: liệt kê subagent đang chạy, /board pane, /board doctor',
  commandHint: '[pane | doctor]',
  usage: 'Cách dùng: /board | /board pane | /board doctor',
  listHeader: (total, waiting) => `Subagent (${total} đang chạy${waiting ? `, ${waiting} đang chờ` : ''}):`,
  listEmpty: 'Không có subagent nào đang chạy.',
  listUnknown: 'Claude Code này không liệt kê được subagent nên bảng để trống.',
  paneNone: 'Không có subagent nào đang chạy. Bảng tự mở khi có subagent bắt đầu.',
  paneOpened: 'Đã mở khung Bảng subagent.',
  paneWaits: why => `Khung đã mở nhưng chưa được vẽ: ${why}. Trong lúc đó bảng hiện ở phía trên ô nhập.`,
  paneNotHere: 'Khung chỉ dành cho terminal. Ở đây bảng nằm phía trên ô nhập.',
  paneOff: 'Khung đang tắt (usePane) nên dùng bảng phía trên ô nhập.',
  paneFailed: 'Claude Code này không mở được khung. Bảng hiện ở phía trên ô nhập.',

  doctor: {
    summary: (pass, warn, fail) => `${pass} ổn, ${warn} cần xem, ${fail} lỗi.`,
    checkFailedFix: 'Không cần làm gì; không chạy được bước kiểm tra này.',
    versionOk: v => `Claude Code ${v}`,
    versionUnknown: 'không xác định được phiên bản Claude Code',
    versionUnknownFix: 'Chạy claude --version trong terminal để xem.',
    listOk: (total, running) => `engine liệt kê ${total} agent, ${running} đang chạy hoặc đang chờ`,
    listMissing: 'engine không liệt kê subagent nên bảng để trống',
    listMissingFix: 'Cập nhật Claude Code (chạy: claude update).',
    limitsOk: (concurrent, background) => `tối đa ${concurrent} subagent cùng lúc; subagent chạy nền đang ${background ? 'bật' : 'tắt ở đây'}`,
    surfaceIs: surface => `bề mặt: ${surface}`,
    surfaceUnknown: 'chưa rõ bề mặt; dùng bảng phía trên ô nhập',
    paneNone: 'khung chưa mở',
    paneOpen: placed => (placed ? 'khung đang mở và đã được vẽ' : 'khung đang mở nhưng chưa vẽ (terminal hẹp)'),
    paneNotUsed: 'không dùng ở đây: khung dành cho terminal khi usePane bật; dùng bảng phía trên ô nhập',
    settingsAllOn: 'bảng phía trên ô nhập và khung đều bật',
    settingsOff: names => `đang tắt: ${names}`,
    settingsOffFix: 'Bật lại trong tùy chọn plugin (claude plugin configure kit-agents) nếu bạn muốn.',
    maxCardsIs: n => `hiện tối đa ${n} subagent, phần còn lại ở dòng "+N nữa"`,
    languageIs: (lang, setting) => `${lang} (tùy chọn: ${setting})`,
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
