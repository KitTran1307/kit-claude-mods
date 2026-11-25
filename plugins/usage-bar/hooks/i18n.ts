// Every word the band shows, in English and Vietnamese. Both tables have the same keys (`Strings`), so a key missing
// from one fails tsc. Model names, repo names, numbers and units (`2h13m`, `42%`) are not words and stay as they are.

export type Lang = 'en' | 'vi'

export type HookFailure = { hook: string; command: string; reason: string }

export type Strings = {
  /** Label before the context bar. */
  context: string
  /** Pills of the two limit windows. */
  fiveHour: string
  week: string
  /** Shown when the working folder has no name, and before the model is known. */
  noRepo: string
  modelFallback: string
  /** The default account's label (the Claude config folder `.claude`). */
  defaultAccount: string
  /** The warning segment: how many hook failures this session, and the hook that failed last. */
  hookErrors: (count: number, hook: string) => string
  /** The toast the segment shows when pressed. */
  hookToast: (last: HookFailure) => string
  /** The question asked once when the terminal already has a status line, its two answers and the dialog's header. */
  statusLineQuestion: string
  answerKeepMine: string
  answerShowBoth: string
  askHeader: string
  /** The prompt-cache clock: `◷ cache 4:07` ("cache" is a technical term and stays), and its word once it ran out. */
  cacheCold: string
  /** The stale marker at the end of the limits row: `⟳ old 6m`. */
  stale: (minutes: number) => string
  /** The `/usage-bar` command: what the menu shows, the usage line and the doctor's sentences (check names stay English). */
  command: CommandStrings
}

export type CommandStrings = {
  description: string
  usage: string
  /** Prefix of a fix hint. */
  fix: string
  versionOk: (v: string, min: string) => string
  versionOld: (v: string, min: string) => string
  versionFix: string
  versionUnknown: string
  versionUnknownFix: string
  nodeOk: (v: string) => string
  nodeMissing: string
  nodeFix: string
  transcriptOk: string
  transcriptLarge: string
  transcriptNone: string
  transcriptNoneFix: string
  transcriptBad: string
  transcriptBadFix: string
  bandOk: (where: string) => string
  bandHidden: (reasons: string) => string
  bandFix: string
  reasonSurfaces: string
  reasonStatusLine: string
  reasonOption: (name: string) => string
  rateOk: string
  rateNone: string
  rateUnknown: string
  rateUnknownFix: string
  configEnv: (label: string) => string
  configDefault: string
  configMissing: string
  configFix: string
}

const joinParts = (parts: readonly string[]): string => parts.filter(Boolean).join(' · ')

export const en: Strings = {
  context: 'ctx',
  fiveHour: '5H',
  week: 'WEEK',
  noRepo: 'no-repo',
  modelFallback: 'model',
  defaultAccount: 'default',
  hookErrors: (count, hook) => `⚠ ${count} hook ${count === 1 ? 'error' : 'errors'}${hook ? ` (${hook})` : ''}`,
  hookToast: ({ hook, command, reason }) => joinParts([hook ? `${hook} hook failed` : 'A hook failed', command, reason]),
  statusLineQuestion: 'Usage Bar: you already have a status line in this terminal. Show the Usage Bar here as well?',
  answerKeepMine: 'Keep only my status line',
  answerShowBoth: 'Show both',
  askHeader: 'Status bar',
  cacheCold: 'cache cold',
  stale: minutes => `⟳ old ${minutes}m`,
  command: {
    description: 'Check that the Usage Bar can work here',
    usage: 'Usage: /usage-bar doctor - runs a few checks and says what, if anything, to fix.',
    fix: 'Fix:',
    versionOk: (v, min) => `Claude Code ${v} (needs ${min} or later)`,
    versionOld: (v, min) => `Claude Code ${v} is older than ${min}.`,
    versionFix: 'Update Claude Code (claude update), then /reload-plugins.',
    versionUnknown: 'could not tell which Claude Code version this is.',
    versionUnknownFix: 'Run claude --version in a terminal and compare it with the README.',
    nodeOk: v => `Node ${v} found (only used for transcripts over 4 MB)`,
    nodeMissing: 'Node not found; the plugin still works, only a very long session keeps its last known title and cache clock.',
    nodeFix: 'Install Node.js 18 or later if you want those to keep updating in huge sessions.',
    transcriptOk: "this session's transcript is readable",
    transcriptLarge: "this session's transcript is over 4 MB and is read by the Node helper",
    transcriptNone: 'no transcript for this session yet.',
    transcriptNoneFix: 'Send a message; the title and cache clock appear after the first reply.',
    transcriptBad: "this session's transcript exists but could not be read.",
    transcriptBadFix: 'Check that the Claude config folder is readable, then /reload-plugins.',
    bandOk: where => `the band is drawn on: ${where}`,
    bandHidden: reasons => `something hides part of the band: ${reasons}.`,
    bandFix: 'Change the listed options in /config (usage-bar.<option>).',
    reasonSurfaces: 'surfaces leaves out the terminal',
    reasonStatusLine: 'a terminal status line is set up (auto steps aside)',
    reasonOption: name => `${name} is off`,
    rateOk: 'rate-limit numbers are present',
    rateNone: 'no rate-limit data yet (normal with an API key or a third-party provider; the limits row stays hidden)',
    rateUnknown: 'could not tell whether rate-limit data is present.',
    rateUnknownFix: 'Send a message; the numbers arrive with the reply.',
    configEnv: label => `CLAUDE_CONFIG_DIR is set; account label "${label}"`,
    configDefault: 'default config folder (.claude in your home folder)',
    configMissing: 'the config folder was not found.',
    configFix: 'Check CLAUDE_CONFIG_DIR, or start Claude Code once to create the folder.',
  },
}

export const vi: Strings = {
  context: 'ngữ cảnh',
  fiveHour: '5 GIỜ',
  week: 'TUẦN',
  noRepo: 'chưa có repo',
  modelFallback: 'mô hình',
  defaultAccount: 'mặc định',
  hookErrors: (count, hook) => `⚠ ${count} lỗi hook${hook ? ` (${hook})` : ''}`,
  hookToast: ({ hook, command, reason }) => joinParts([hook ? `Hook ${hook} lỗi` : 'Một hook lỗi', command, reason]),
  statusLineQuestion: 'Usage Bar: terminal này đã có status line. Hiện thêm Usage Bar ở đây không?',
  answerKeepMine: 'Chỉ giữ status line của tôi',
  answerShowBoth: 'Hiện cả hai',
  askHeader: 'Thanh trạng thái',
  cacheCold: 'cache nguội',
  stale: minutes => `⟳ cũ ${minutes}m`,
  command: {
    description: 'Kiểm tra Usage Bar có chạy được ở đây không',
    usage: 'Cách dùng: /usage-bar doctor - chạy vài bước kiểm tra và cho biết cần sửa gì (nếu có).',
    fix: 'Cách sửa:',
    versionOk: (v, min) => `Claude Code ${v} (cần ${min} trở lên)`,
    versionOld: (v, min) => `Claude Code ${v} cũ hơn ${min}.`,
    versionFix: 'Cập nhật Claude Code (claude update), rồi /reload-plugins.',
    versionUnknown: 'không xác định được phiên bản Claude Code.',
    versionUnknownFix: 'Chạy claude --version trong terminal và so với README.',
    nodeOk: v => `Có Node ${v} (chỉ dùng cho transcript trên 4 MB)`,
    nodeMissing: 'Không thấy Node; plugin vẫn chạy, chỉ phiên rất dài sẽ giữ tiêu đề và đồng hồ cache cũ.',
    nodeFix: 'Cài Node.js 18 trở lên nếu muốn chúng vẫn cập nhật trong phiên rất dài.',
    transcriptOk: 'đọc được transcript của phiên này',
    transcriptLarge: 'transcript của phiên này trên 4 MB và được Node đọc',
    transcriptNone: 'phiên này chưa có transcript.',
    transcriptNoneFix: 'Gửi một tin nhắn; tiêu đề và đồng hồ cache hiện sau câu trả lời đầu tiên.',
    transcriptBad: 'transcript của phiên này có nhưng không đọc được.',
    transcriptBadFix: 'Kiểm tra thư mục cấu hình Claude có đọc được không, rồi /reload-plugins.',
    bandOk: where => `thanh được vẽ trên: ${where}`,
    bandHidden: reasons => `có thứ đang ẩn một phần thanh: ${reasons}.`,
    bandFix: 'Đổi các tùy chọn nêu trên trong /config (usage-bar.<tùy chọn>).',
    reasonSurfaces: 'surfaces không gồm terminal',
    reasonStatusLine: 'terminal đã có status line (auto nhường chỗ)',
    reasonOption: name => `${name} đang tắt`,
    rateOk: 'có số liệu giới hạn',
    rateNone: 'chưa có số liệu giới hạn (bình thường với API key hoặc nhà cung cấp bên thứ ba; hàng giới hạn được ẩn)',
    rateUnknown: 'không xác định được có số liệu giới hạn hay không.',
    rateUnknownFix: 'Gửi một tin nhắn; số liệu đến cùng câu trả lời.',
    configEnv: label => `đã đặt CLAUDE_CONFIG_DIR; nhãn tài khoản "${label}"`,
    configDefault: 'thư mục cấu hình mặc định (.claude trong thư mục chính)',
    configMissing: 'không tìm thấy thư mục cấu hình.',
    configFix: 'Kiểm tra CLAUDE_CONFIG_DIR, hoặc mở Claude Code một lần để tạo thư mục.',
  },
}

export const TABLES: Readonly<Record<Lang, Strings>> = { en, vi }

/**
 * The language a `language` value from the settings names: Vietnamese ("vi", "vi-VN", "Vietnamese", "Tiếng Việt"),
 * anything else, a missing value or a value that is not text: English.
 */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.trim().normalize('NFC')) ? 'vi' : 'en'
}
