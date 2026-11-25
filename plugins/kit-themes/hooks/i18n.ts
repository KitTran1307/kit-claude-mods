// Every word /themes says, in English and Vietnamese. Pure data and functions: no engine calls. `vi` is typed as
// `Strings` (the shape of `en`), so a key missing from either table fails tsc.
import type { Choice, ThemeName } from './themes'

export type Lang = 'en' | 'vi'

const en = {
  commandDescription: 'Pick a theme for the Claude desktop and mobile apps: /themes paper | contrast | night | auto | off',
  commandHint: '[paper | contrast | night | auto | off]',
  usage: 'Usage: /themes paper | contrast | night | auto | off. Send /themes alone to see the current choice.',
  failed: 'Something went wrong with that, so nothing was changed.',
  names: { paper: 'Paper', contrast: 'High Contrast', night: 'Night' } as Record<ThemeName, string>,
  blurbs: {
    paper: 'warm light paper, easy on the eyes by day',
    contrast: 'black and white with a yellow accent, text and status colors at WCAG AAA (7:1 or better)',
    night: 'a dark, low-blue-light palette in warm browns and amber, for evenings',
  } as Record<ThemeName, string>,
  autoName: 'Auto',
  autoBlurb: 'Paper in light mode, Night in dark mode',
  offName: 'Off',
  offBlurb: "Claude's own look",
  isCurrent: (choice: Choice, name: string, blurb: string) =>
    choice === 'off' ? "Themes are off: Claude's own look shows." : `Theme: ${name} (${blurb}).`,
  isNow: (choice: Choice, name: string, blurb: string, isSaved: boolean) =>
    choice === 'off' ? "Themes are off. Claude's own look is back." : `Theme: ${name} (${blurb}).${isSaved ? ' Saved for your next sessions.' : ''}`,
  options: 'Options: paper, contrast, night, auto (follow light or dark mode), off.',
  terminal: 'A terminal draws no theme, so nothing changes here; the choice shows in the Claude desktop and mobile apps.',
  notSaved: ' The choice could not be saved, so a new session may start with the previous one.',
  nextSession: " This version of Claude Code cannot draw the theme right now, so the app keeps its own look.",
  offPending: "Themes are off. Claude's own look returns from the next session.",
}

export type Strings = typeof en

const vi: Strings = {
  commandDescription: 'Chọn giao diện cho ứng dụng Claude trên máy tính và điện thoại: /themes paper | contrast | night | auto | off',
  commandHint: '[paper | contrast | night | auto | off]',
  usage: 'Cách dùng: /themes paper | contrast | night | auto | off. Gõ /themes một mình để xem lựa chọn hiện tại.',
  failed: 'Có lỗi nên chưa đổi gì.',
  names: { paper: 'Giấy', contrast: 'Tương phản cao', night: 'Đêm' },
  blurbs: {
    paper: 'giấy sáng ấm, dịu mắt ban ngày',
    contrast: 'đen trắng với điểm nhấn vàng, chữ và màu trạng thái đạt WCAG AAA (từ 7:1)',
    night: 'tông nâu ấm và hổ phách tối, ít ánh sáng xanh, cho buổi tối',
  },
  autoName: 'Tự động',
  autoBlurb: 'Giấy khi chế độ sáng, Đêm khi chế độ tối',
  offName: 'Tắt',
  offBlurb: 'giao diện gốc của Claude',
  isCurrent: (choice, name, blurb) =>
    choice === 'off' ? 'Giao diện đang tắt: hiện giao diện gốc của Claude.' : `Giao diện: ${name} (${blurb}).`,
  isNow: (choice, name, blurb, isSaved) =>
    choice === 'off' ? 'Đã tắt giao diện. Giao diện gốc của Claude đã trở lại.' : `Giao diện: ${name} (${blurb}).${isSaved ? ' Đã lưu cho các phiên sau.' : ''}`,
  options: 'Lựa chọn: paper, contrast, night, auto (theo chế độ sáng hoặc tối), off.',
  terminal: 'Cửa sổ dòng lệnh (terminal) không vẽ giao diện nên ở đây chưa thấy gì đổi; lựa chọn hiện trong ứng dụng Claude trên máy tính và điện thoại.',
  notSaved: ' Chưa lưu được lựa chọn nên phiên mới có thể dùng lại lựa chọn cũ.',
  nextSession: ' Bản Claude Code này chưa vẽ được giao diện, nên ứng dụng giữ giao diện gốc.',
  offPending: 'Đã tắt giao diện. Giao diện gốc của Claude trở lại từ phiên sau.',
}

export const TABLES: Record<Lang, Strings> = { en, vi }

export const stringsFor = (lang: Lang): Strings => TABLES[lang]

/** Claude Code's own `language` setting ("Vietnamese", "vi", "Tiếng Việt", "vi-VN") as a UI language; anything else is English. */
export function languageFromSetting(value: unknown): Lang {
  if (typeof value !== 'string') return 'en'
  return /^(vi(?![a-z])|viet|tiếng\s*việt)/i.test(value.normalize('NFC').trim()) ? 'vi' : 'en'
}

/** The language option (auto | en | vi) and Claude Code's setting, as the language in use. */
export function chooseLanguage(option: unknown, setting: unknown): Lang {
  return option === 'en' || option === 'vi' ? option : languageFromSetting(setting)
}

/** The display name and one-line description of a choice. */
export function describe(t: Strings, choice: Choice): { name: string; blurb: string } {
  if (choice === 'auto') return { name: t.autoName, blurb: t.autoBlurb }
  if (choice === 'off') return { name: t.offName, blurb: t.offBlurb }
  return { name: t.names[choice], blurb: t.blurbs[choice] }
}
