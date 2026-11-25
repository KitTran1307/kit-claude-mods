import { expect, test } from 'claude-code/testing'

import { NAMES, PAIRS, PALETTES } from './palettes.js'
import { chooseLanguage, describe, languageFromSetting, stringsFor, TABLES } from './i18n'
import { CHOICES, colorsFor, definitionFor, effectiveChoice, parseChoice, unpainted } from './themes'

const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }

test('parseChoice: names, aliases, case, spaces, Vietnamese words; anything else is null', () => {
  expect(parseChoice('paper')).toBe('paper')
  expect(parseChoice('  PAPER ')).toBe('paper')
  expect(parseChoice('High Contrast')).toBe('contrast')
  expect(parseChoice('high-contrast')).toBe('contrast')
  expect(parseChoice('hc')).toBe('contrast')
  expect(parseChoice('Đêm')).toBe('night')
  expect(parseChoice('giấy')).toBe('paper')
  expect(parseChoice('tự động')).toBe('auto')
  expect(parseChoice('tắt')).toBe('off')
  expect(parseChoice('dark')).toBe('night')
  expect(parseChoice('')).toBeNull()
  expect(parseChoice('purple')).toBeNull()
  expect(parseChoice('constructor')).toBeNull()
  expect(parseChoice('__proto__')).toBeNull()
  expect(parseChoice(undefined)).toBeNull()
  expect(parseChoice(3)).toBeNull()
})

test('effectiveChoice: saved wins, then the option, then auto; junk falls through', () => {
  expect(effectiveChoice('night', 'paper')).toBe('night')
  expect(effectiveChoice(undefined, 'paper')).toBe('paper')
  expect(effectiveChoice(undefined, undefined)).toBe('auto')
  expect(effectiveChoice('???', 'contrast')).toBe('contrast')
  expect(effectiveChoice(false, 'nonsense')).toBe('auto')
  expect(effectiveChoice('off', 'paper')).toBe('off')
  expect([...CHOICES]).toEqual(['auto', 'paper', 'contrast', 'night', 'off'])
})

test('palettes: every color is six-digit hex and each pair meets its WCAG rule (High Contrast: all AAA)', () => {
  for (const name of NAMES) {
    const p = PALETTES[name] as Record<string, unknown>
    for (const k of ['bg', 'side', 'surf', 'bd', 'tx', 'tx2', 'ac', 'acx', 'code', 'kw', 'fn', 'st', 'cm', 'user', 'band']) {
      expect(p[k]).toMatch(/^#[0-9a-f]{6}$/)
    }
    for (const [label, fg, bg, min] of PAIRS) {
      const need = name === 'contrast' ? 7 : min
      expect(ratio(p[fg] as string, p[bg] as string), `${name}: ${label}`).toBeGreaterThanOrEqual(need)
    }
  }
})

test('palettes: the mock-up numbers hold (hand-checked ratios)', () => {
  const r = (n: 'paper' | 'contrast' | 'night', fg: string, bg: string) => ratio((PALETTES[n] as never)[fg], (PALETTES[n] as never)[bg])
  expect(Math.round(r('paper', 'tx', 'bg') * 10) / 10).toBe(14.3)
  expect(Math.round(r('paper', 'tx2', 'bg') * 10) / 10).toBe(8.9)
  expect(Math.round(r('contrast', 'tx', 'bg') * 10) / 10).toBe(21)
  expect(Math.round(r('night', 'tx', 'bg') * 10) / 10).toBe(13.9)
  expect(Math.round(r('night', 'tx2', 'bg') * 10) / 10).toBe(8.0)
})

test('definitionFor: auto holds both halves (Paper light, Night dark) and no only; the rest are one mode', () => {
  const auto = definitionFor('auto') as Record<string, any>
  expect(auto.only).toBeUndefined()
  expect(auto.light.gray.anchors['text-primary']).toBe('#262019')
  expect(auto.dark.gray.anchors['text-primary']).toBe('#ecdcc2')
  const paper = definitionFor('paper') as Record<string, any>
  expect(paper.only).toBe('light')
  expect(paper.dark).toBeUndefined()
  const hc = definitionFor('contrast') as Record<string, any>
  expect(hc.only).toBe('dark')
  expect(hc.contrast).toBe('more')
  expect(hc.dark.roles.accent.seed).toBe('#ffe14d')
  expect((definitionFor('night') as Record<string, any>).only).toBe('dark')
})

test('colorsFor: every theme builds, the desktop would paint it, and the bubble colors follow the palette', () => {
  for (const t of ['auto', 'paper', 'contrast', 'night'] as const) {
    const { colors, problems } = colorsFor(t)
    expect(unpainted(problems), t).toEqual([])
    expect(colors).toBeDefined()
  }
  const night = colorsFor('night').colors as any
  expect(night.inputs.dark['bg-user-message']).toBe('#2a1f16')
  expect(night.inputs.light).toBeUndefined()
  const auto = colorsFor('auto').colors as any
  expect(auto.inputs.light['bg-user-message']).toBe('#ece3d0')
  expect(auto.inputs.dark['text-user-message']).toBe('#ecdcc2')
})

test('unpainted keeps only the lines that mean the whole theme is ignored', () => {
  expect(unpainted(["Desktop won't paint this theme: x", 'border is low'])).toEqual(["Desktop won't paint this theme: x"])
  expect(unpainted([])).toEqual([])
})

test('language: the option wins, else Claude Code\'s own setting, else English', () => {
  expect(languageFromSetting('Vietnamese')).toBe('vi')
  expect(languageFromSetting('vi-VN')).toBe('vi')
  expect(languageFromSetting('Tiếng Việt')).toBe('vi')
  expect(languageFromSetting('French')).toBe('en')
  expect(languageFromSetting(undefined)).toBe('en')
  expect(chooseLanguage('en', 'Vietnamese')).toBe('en')
  expect(chooseLanguage('vi', undefined)).toBe('vi')
  expect(chooseLanguage('auto', 'Vietnamese')).toBe('vi')
  expect(chooseLanguage(undefined, undefined)).toBe('en')
})

test('describe: names and blurbs exist for every choice in both languages', () => {
  for (const lang of ['en', 'vi'] as const) {
    const t = stringsFor(lang)
    for (const c of CHOICES) {
      const d = describe(t, c)
      expect(d.name.length).toBeGreaterThan(0)
      expect(d.blurb.length).toBeGreaterThan(0)
    }
  }
  expect(describe(TABLES.en, 'contrast').name).toBe('High Contrast')
  expect(describe(TABLES.vi, 'paper').name).toBe('Giấy')
})
