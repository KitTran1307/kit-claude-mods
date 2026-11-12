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
  statusLineQuestion: 'kit-statusbar: you already have a status line in this terminal. Show the kit-statusbar band here as well?',
  answerKeepMine: 'Keep only my status line',
  answerShowBoth: 'Show both',
  askHeader: 'Status bar',
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
  statusLineQuestion: 'kit-statusbar: terminal này đã có status line. Hiện thêm thanh kit-statusbar ở đây không?',
  answerKeepMine: 'Chỉ giữ status line của tôi',
  answerShowBoth: 'Hiện cả hai',
  askHeader: 'Thanh trạng thái',
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
