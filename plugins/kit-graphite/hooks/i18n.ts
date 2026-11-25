// Every word /graphite says, in English and Vietnamese. Pure data and functions: no engine calls. `vi` is typed as
// `Strings` (the shape of `en`), so a key missing from either table fails tsc. Check names (PASS/WARN/FAIL, claude-code,
// setting, theme, ...) stay English on purpose; details and fix hints are translated.

export type Lang = 'en' | 'vi'

const en = {
  usage: 'Usage: /graphite off | /graphite on | /graphite status | /graphite doctor',
  commandDescription: 'Turn the Graphite look off or on, or check it: /graphite off | on | status | doctor',
  commandHint: '[off | on | status | doctor]',
  failed: 'Something went wrong with that, so nothing was changed. Graphite keeps its current state.',

  statusIs: (isOn: boolean, known: boolean) =>
    `Graphite is ${isOn ? 'on' : 'off'}.${known ? '' : ' (The saved choice could not be read, so the default, on, applies.)'}`,
  offNotSaved: ' The choice could not be saved, so a new session starts with Graphite on again.',
  offNextSession: (keep: string) => `Graphite is off. Claude's default look from the next session.${keep}`,
  offAlready: (keep: string) => `Graphite is already off. Claude's default look shows.${keep}`,
  offDone: (keep: string) => `Graphite is off. Claude's default look is back.${keep}`,
  onNotSaved: ' The choice could not be saved, so it may not carry over to the next session.',
  onDone: (keep: string) => `Graphite is on.${keep}`,
  onNextSession: (keep: string) => `Graphite is on from the next session.${keep}`,

  doctor: {
    summary: (pass: number, warn: number, fail: number) => `${pass} ok, ${warn} to look at, ${fail} broken.`,
    checkFailedFix: 'Nothing needed; this check could not run.',
    versionUnknown: (min: string) => `could not tell which Claude Code version this is (the theme needs ${min} or later)`,
    versionUnknownFix: 'Run claude --version in a terminal to see it.',
    versionOk: (v: string, min: string) => `Claude Code ${v} (the theme needs ${min} or later)`,
    versionOld: (v: string, min: string) => `Claude Code ${v} is older than ${min}, so the app keeps its own look`,
    updateFix: 'Update Claude Code (run: claude update).',
    settingUnreadable: 'the saved on/off choice could not be read, so Graphite stays on',
    settingUnreadableFix: 'Nothing needed; /graphite off tries to save the choice again.',
    settingOk: (isOn: boolean) => `Graphite is ${isOn ? 'on' : 'off'} (saved choice readable)`,
    themeOff: 'no theme is set, because Graphite is off',
    themeDrawn: 'accepted, and an app is drawing it',
    themeWaiting: 'accepted; it draws once the desktop or mobile app attaches (a terminal draws no theme)',
    themeNothing: 'accepted, but nothing in this session draws themes (a terminal-only session)',
    themeNothingFix: 'Use the desktop or mobile app to see the look.',
    themeRefused: (why: string) => `this Claude Code did not accept the theme (${why})`,
    themeUntried: 'not tried yet in this session',
    terminalNotNeeded: 'only used with Windows Terminal; not needed on this system',
    terminalFound: (rel: string) => `${rel} is there (optional, for Windows Terminal)`,
    terminalMissing: (rel: string) => `${rel} was not found (optional, only for Windows Terminal)`,
    terminalMissingFix: 'Nothing needed unless you use Windows Terminal; reinstall the plugin to get it back.',
  },
}

export type Strings = typeof en

const vi: Strings = {
  usage: 'Cách dùng: /graphite off | /graphite on | /graphite status | /graphite doctor',
  commandDescription: 'Tắt hoặc bật giao diện Graphite, hoặc kiểm tra nó: /graphite off | on | status | doctor',
  commandHint: '[off | on | status | doctor]',
  failed: 'Có lỗi xảy ra nên chưa thay đổi gì. Graphite giữ nguyên trạng thái hiện tại.',

  statusIs: (isOn, known) =>
    `Graphite đang ${isOn ? 'bật' : 'tắt'}.${known ? '' : ' (Không đọc được lựa chọn đã lưu nên áp dụng mặc định là bật.)'}`,
  offNotSaved: ' Không lưu được lựa chọn nên phiên mới sẽ lại bắt đầu với Graphite bật.',
  offNextSession: keep => `Graphite đã tắt. Giao diện mặc định của Claude sẽ hiện từ phiên sau.${keep}`,
  offAlready: keep => `Graphite đã tắt từ trước. Đang hiện giao diện mặc định của Claude.${keep}`,
  offDone: keep => `Graphite đã tắt. Giao diện mặc định của Claude đã trở lại.${keep}`,
  onNotSaved: ' Không lưu được lựa chọn nên có thể sẽ không giữ sang phiên sau.',
  onDone: keep => `Graphite đã bật.${keep}`,
  onNextSession: keep => `Graphite sẽ bật từ phiên sau.${keep}`,

  doctor: {
    summary: (pass, warn, fail) => `${pass} ổn, ${warn} cần xem, ${fail} lỗi.`,
    checkFailedFix: 'Không cần làm gì; không chạy được bước kiểm tra này.',
    versionUnknown: min => `không xác định được phiên bản Claude Code (giao diện cần ${min} trở lên)`,
    versionUnknownFix: 'Chạy claude --version trong terminal để xem.',
    versionOk: (v, min) => `Claude Code ${v} (giao diện cần ${min} trở lên)`,
    versionOld: (v, min) => `Claude Code ${v} cũ hơn ${min} nên ứng dụng giữ giao diện riêng của nó`,
    updateFix: 'Cập nhật Claude Code (chạy: claude update).',
    settingUnreadable: 'không đọc được lựa chọn bật/tắt đã lưu nên Graphite vẫn bật',
    settingUnreadableFix: 'Không cần làm gì; /graphite off sẽ thử lưu lại lựa chọn.',
    settingOk: isOn => `Graphite đang ${isOn ? 'bật' : 'tắt'} (đọc được lựa chọn đã lưu)`,
    themeOff: 'chưa đặt giao diện nào, vì Graphite đang tắt',
    themeDrawn: 'đã được chấp nhận và một ứng dụng đang vẽ nó',
    themeWaiting: 'đã được chấp nhận; nó sẽ được vẽ khi ứng dụng máy tính hoặc di động kết nối (terminal không vẽ giao diện)',
    themeNothing: 'đã được chấp nhận, nhưng không có gì trong phiên này vẽ giao diện (phiên chỉ có terminal)',
    themeNothingFix: 'Dùng ứng dụng máy tính hoặc di động để xem giao diện.',
    themeRefused: why => `Claude Code này không chấp nhận giao diện (${why})`,
    themeUntried: 'chưa thử trong phiên này',
    terminalNotNeeded: 'chỉ dùng với Windows Terminal; không cần trên hệ thống này',
    terminalFound: rel => `có ${rel} (tùy chọn, dành cho Windows Terminal)`,
    terminalMissing: rel => `không thấy ${rel} (tùy chọn, chỉ dành cho Windows Terminal)`,
    terminalMissingFix: 'Không cần làm gì trừ khi bạn dùng Windows Terminal; cài lại plugin để có lại tệp này.',
  },
}

export const TABLES: Record<Lang, Strings> = { en, vi }
export const EN = en
export const stringsFor = (lang: Lang): Strings => TABLES[lang]

/** Claude Code's own `language` setting ("Vietnamese", "vi", "Tiếng Việt", "vi-VN") as a UI language; anything else is English. */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.normalize('NFC').trim()) ? 'vi' : 'en'
}
