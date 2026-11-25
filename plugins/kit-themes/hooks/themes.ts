// The theme logic, pure: no engine calls. Parses what a person types, picks the theme to show and builds the
// definition that make-colors turns into the app's colors.
import { definitionFor } from './definition.js'
import { makeColors } from './make-colors.js'
import { NAMES, PALETTES } from './palettes.js'
import type { Palette } from './palettes.js'

export type ThemeName = (typeof NAMES)[number]

/** What a person can pick: one of the three themes, auto (Paper in light mode, Night in dark mode) or off. */
export type Choice = ThemeName | 'auto' | 'off'

export const CHOICES: readonly Choice[] = ['auto', 'paper', 'contrast', 'night', 'off']

/** The default when nothing was ever picked, and the fallback for anything unreadable. */
export const DEFAULT_CHOICE: Choice = 'auto'

const ALIASES: Record<string, Choice> = {
  auto: 'auto', automatic: 'auto', 'tự động': 'auto', 'tu dong': 'auto', tudong: 'auto',
  paper: 'paper', light: 'paper', 'giấy': 'paper', giay: 'paper',
  contrast: 'contrast', 'high-contrast': 'contrast', highcontrast: 'contrast', 'high contrast': 'contrast', hc: 'contrast',
  'tương phản cao': 'contrast', 'tuong phan cao': 'contrast', 'tương phản': 'contrast', 'tuong phan': 'contrast',
  night: 'night', dark: 'night', 'đêm': 'night', dem: 'night',
  off: 'off', none: 'off', 'tắt': 'off', tat: 'off',
}

/** A word a person types (or a saved value) as a choice; null when it is not one. Case, spaces and accents are forgiven. */
export function parseChoice(value: unknown): Choice | null {
  if (typeof value !== 'string') return null
  const key = value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? null) : null
}

/** The choice in force: the one saved by /themes, else the plugin option, else auto. Anything unreadable falls back. */
export function effectiveChoice(saved: unknown, option: unknown): Choice {
  return parseChoice(saved) ?? parseChoice(option) ?? DEFAULT_CHOICE
}

const rgb = (hex: string): string => hex.toLowerCase()

export { definitionFor }

/** The finished colors for a theme, with the user-message bubble colors of the palette added, and what make-colors objected to. */
export function colorsFor(theme: ThemeName | 'auto'): { colors: ReturnType<typeof makeColors>['theme']; problems: string[] } {
  const { theme: colors, problems } = makeColors(definitionFor(theme) as never)
  const pairs: [mode: 'light' | 'dark', p: Palette][] =
    theme === 'auto' ? [['light', PALETTES.paper], ['dark', PALETTES.night]] : [[PALETTES[theme].mode, PALETTES[theme]]]
  const inputs = (colors as { inputs?: Record<string, Record<string, string>> }).inputs
  for (const [mode, p] of pairs) {
    if (!inputs?.[mode]) continue
    inputs[mode]['bg-user-message'] = rgb(p.user)
    inputs[mode]['text-user-message'] = rgb(p.tx)
  }
  return { colors, problems }
}

/** Lines of `problems` that mean the desktop app would ignore the whole theme. */
export const unpainted = (problems: string[]): string[] => problems.filter(l => l.startsWith("Desktop won't paint"))
