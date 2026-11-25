#!/usr/bin/env node
// WCAG 2.x contrast check for the colors the plugins draw text with. No dependencies; Node 22; any OS.
//
//   node scripts/contrast.mjs
//
// Prints every pair with its ratio and PASS/FAIL, and exits 1 when an asserted pair fails (or a color source
// cannot be read: the script then says which file).
//
// Rules ("main" and "secondary" are decided here):
//   main      >= 7:1    body text and anything you must read to act: kit-graphite text-primary, the accent button
//                       label, usage-bar's T.fg, the bold percentages and warning text (green/yellow/red/teal),
//                       and every pill label (bold, small).
//   secondary >= 4.5:1  de-emphasised text: kit-graphite text-secondary and text-muted, the status role labels
//                       (danger/success/warning/pro on their fills), usage-bar's T.comment (budget, reset
//                       countdown, "context" label, session title).
// Excluded as non-text: the meter's empty cells (T.hl2 on the band), the decorative backdrop (scene.ts dots,
// motes and the comet in character.ts), and borders.
//
// Sources, read from the plugin files, never copied here:
//   plugins/kit-graphite/hooks/palette.js      imported; makeColors() from make-colors.js builds the fills/"on" colors
//   plugins/usage-bar/hooks/format.ts          the T object is parsed with a regex
//   plugins/kit-themes/hooks/palettes.js       imported; Paper, High Contrast (AAA on every pair) and Night
//   plugins/kit-turn/hooks/data.ts             the COLORS table (dark, light) is parsed with a regex
//   plugins/kit-agents/hooks/data.ts           the same; its border color is not text and is left out
//
// Turn Card and Agent Board draw text in the terminal (dark) palette on the terminal's own background, checked against the
// same dark list as Usage Bar, and in the light palette on the desktop, VS Code and mobile surfaces, checked against white
// and a cream (#f0eee6). Every text color of both holds main (7:1).
//
// Usage Bar's band sits on the app's own background, which the plugin cannot know. It is checked against a
// reference list: T.dark (#16161e, the palette's own dark) and common dark terminal/desktop backgrounds
// (pure black, Windows Terminal #0c0c0c, #121212, Tokyo Night #1a1b26, VS Code #1e1e1e, One Dark #282c34).
// A color must pass on every one of them to pass.
//
// Current values: see docs/contrast.md.

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

export const MAIN = 7
export const SECONDARY = 4.5

const toLinear = c => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function parseHex(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) throw new Error(`not a hex color: ${hex}`)
  let h = m[1]
  if (h.length === 3) h = [...h].map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}

export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseUsageBarT(src, file = 'format.ts') {
  const body = /export const T = \{([\s\S]*?)\}\s*as const/.exec(src)
  if (!body) throw new Error(`${file}: cannot find "export const T = {...} as const"`)
  const T = {}
  for (const [, k, v] of body[1].matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)) T[k] = v
  for (const k of ['dark', 'hl', 'hl2', 'comment', 'fg', 'blue', 'cyan', 'magenta', 'orange', 'yellow', 'green', 'teal', 'red']) {
    if (!T[k]) throw new Error(`${file}: T.${k} not found`)
  }
  return T
}

function parseAccountColors(src, T, file) {
  const m = /ACCOUNT_COLORS = \[([^\]]*)\]/.exec(src)
  if (!m) throw new Error(`${file}: cannot find ACCOUNT_COLORS`)
  return [...m[1].matchAll(/T\.(\w+)/g)].map(([, k]) => {
    if (!T[k]) throw new Error(`${file}: ACCOUNT_COLORS names unknown T.${k}`)
    return [k, T[k]]
  })
}

/**
 * The `COLORS` table of a plugin's data.ts as { dark: { role: '#rrggbb' }, light: {...} }. A value may name a
 * `const NAME = '#rrggbb'` of the same file.
 */
export function parsePluginColors(src, file) {
  const start = src.indexOf('export const COLORS')
  const eq = start < 0 ? -1 : src.indexOf('=', start)
  if (eq < 0) throw new Error(`${file}: cannot find "export const COLORS"`)
  const body = src.slice(eq)
  const names = Object.fromEntries([...src.matchAll(/const (\w+) = '(#[0-9a-fA-F]{6})'/g)].map(m => [m[1], m[2]]))
  const out = {}
  for (const mode of ['dark', 'light']) {
    const m = new RegExp(`${mode}:\\s*\\{([^}]*)\\}`).exec(body)
    if (!m) throw new Error(`${file}: COLORS.${mode} not found`)
    out[mode] = {}
    for (const [, role, hex, name] of m[1].matchAll(/(\w+):\s*(?:'(#[0-9a-fA-F]{6})'|(\w+))/g)) {
      const value = hex ?? names[name]
      if (!value) throw new Error(`${file}: COLORS.${mode}.${role} is not a hex color`)
      out[mode][role] = value
    }
  }
  return out
}

async function collect() {
  const pairs = [] // { group, label, fg, bg, min }

  // kit-graphite
  const gFile = 'plugins/kit-graphite/hooks/palette.js'
  let DEF, theme
  try {
    ;({ DEF } = await import(pathToFileURL(join(root, gFile)).href))
    const { makeColors } = await import(pathToFileURL(join(root, 'plugins/kit-graphite/hooks/make-colors.js')).href)
    ;({ theme } = makeColors(DEF))
    if (!theme?.inputs) throw new Error('makeColors returned no theme.inputs')
  } catch (err) {
    throw new Error(`${gFile} (or make-colors.js): ${err.message}`)
  }
  for (const mode of ['light', 'dark']) {
    const a = DEF[mode]?.gray?.anchors
    if (!a) throw new Error(`${gFile}: no ${mode}.gray.anchors`)
    const inputs = theme.inputs[mode]
    const surfaces = Object.keys(a).filter(k => k.startsWith('surface-'))
    const texts = [['text-primary', MAIN], ['text-secondary', SECONDARY], ['text-muted', SECONDARY]]
    for (const s of surfaces) {
      for (const [t, min] of texts) {
        if (!a[t]) throw new Error(`${gFile}: ${mode} ${t} missing`)
        pairs.push({ group: `kit-graphite ${mode}`, label: `${t} on ${s}`, fg: a[t], bg: a[s], min })
      }
    }
    for (const role of ['accent', 'danger', 'success', 'warning', 'pro']) {
      const fill = inputs[`role-${role}-fill`]
      const on = inputs[`role-${role}-on`]
      if (!fill || !on) throw new Error(`${gFile}: makeColors gave no role-${role}-fill/on for ${mode}`)
      pairs.push({ group: `kit-graphite ${mode}`, label: `${role} label on ${role} fill`, fg: on, bg: fill, min: role === 'accent' ? MAIN : SECONDARY })
    }
  }

  // kit-themes: the three palettes (data only). Main text 7:1, secondary 4.5:1 (PAIRS in palettes.js); High Contrast
  // must reach AAA (7:1) on every pair, status colors included.
  const tFile = 'plugins/kit-themes/hooks/palettes.js'
  try {
    const { PALETTES, PAIRS } = await import(pathToFileURL(join(root, tFile)).href)
    const labels = { paper: 'Paper', contrast: 'High Contrast', night: 'Night' }
    for (const [name, p] of Object.entries(PALETTES)) {
      for (const [label, fg, bg, min] of PAIRS) {
        if (!p[fg] || !p[bg]) throw new Error(`${name}: ${fg} or ${bg} missing`)
        pairs.push({ group: `kit-themes ${labels[name] ?? name}`, label, fg: p[fg], bg: p[bg], min: name === 'contrast' ? MAIN : min })
      }
      for (const role of ['danger', 'success', 'warning', 'pro']) {
        if (!p.roles?.[role]) throw new Error(`${name}: roles.${role} missing`)
        pairs.push({ group: `kit-themes ${labels[name] ?? name}`, label: `${role} on page`, fg: p.roles[role], bg: p.bg, min: name === 'contrast' ? MAIN : SECONDARY })
      }
    }
    // What the app paints: the same definition the plugin sends, built by make-colors. Status-color labels on their
    // fills, and the gray text on every surface. High Contrast must reach 7:1 on all of them.
    const { definitionFor } = await import(pathToFileURL(join(root, 'plugins/kit-themes/hooks/definition.js')).href)
    const { makeColors } = await import(pathToFileURL(join(root, 'plugins/kit-themes/hooks/make-colors.js')).href)
    for (const name of Object.keys(PALETTES)) {
      const def = definitionFor(name)
      const { theme } = makeColors(def)
      const mode = PALETTES[name].mode
      const inputs = theme.inputs?.[mode]
      if (!inputs) throw new Error(`${name}: makeColors gave no ${mode} inputs`)
      const group = `kit-themes ${labels[name]} (painted)`
      const need = (strong, soft) => (name === 'contrast' ? MAIN : soft ?? strong)
      for (const role of ['accent', 'danger', 'success', 'warning', 'pro']) {
        const fill = inputs[`role-${role}-fill`]
        const on = inputs[`role-${role}-on`]
        if (!fill || !on) throw new Error(`${name}: no role-${role}-fill/on`)
        pairs.push({ group, label: `${role} label on ${role} fill`, fg: on, bg: fill, min: need(MAIN, SECONDARY) })
      }
      const a = def[mode].gray.anchors
      for (const s of Object.keys(a).filter(k => k.startsWith('surface-'))) {
        pairs.push({ group, label: `text-primary on ${s}`, fg: a['text-primary'], bg: a[s], min: MAIN })
        pairs.push({ group, label: `text-secondary on ${s}`, fg: a['text-secondary'], bg: a[s], min: need(SECONDARY) })
        pairs.push({ group, label: `text-muted on ${s}`, fg: a['text-muted'], bg: a[s], min: need(SECONDARY) })
      }
    }
  } catch (err) {
    throw new Error(`${tFile}: ${err.message}`)
  }

  // usage-bar
  const uFile = 'plugins/usage-bar/hooks/format.ts'
  let src
  try { src = readFileSync(join(root, uFile), 'utf8') } catch (err) { throw new Error(`${uFile}: ${err.message}`) }
  const T = parseUsageBarT(src, uFile)
  const accounts = parseAccountColors(src, T, uFile)
  const backgrounds = [
    ['T.dark', T.dark], ['black', '#000000'], ['Windows Terminal', '#0c0c0c'], ['#121212', '#121212'],
    ['Tokyo Night', '#1a1b26'], ['VS Code', '#1e1e1e'], ['One Dark', '#282c34'],
  ]
  const bandText = [['fg', MAIN], ['green', MAIN], ['yellow', MAIN], ['red', MAIN], ['teal', MAIN], ['comment', SECONDARY]]
  for (const [name, bg] of backgrounds) {
    for (const [k, min] of bandText) pairs.push({ group: 'usage-bar band', label: `T.${k} on ${name}`, fg: T[k], bg, min })
  }
  for (const [k, c] of accounts) pairs.push({ group: 'usage-bar pill', label: `T.dark on account T.${k}`, fg: T.dark, bg: c, min: MAIN })
  for (const k of ['blue', 'teal', 'yellow']) {
    if (!accounts.some(([n]) => n === k)) pairs.push({ group: 'usage-bar pill', label: `T.dark on T.${k}`, fg: T.dark, bg: T[k], min: MAIN })
  }
  pairs.push({ group: 'usage-bar pill', label: 'T.cyan on T.hl2 (model)', fg: T.cyan, bg: T.hl2, min: MAIN })
  pairs.push({ group: 'usage-bar pill', label: 'T.magenta on T.hl (effort)', fg: T.magenta, bg: T.hl, min: MAIN })
  // The limits pill while the numbers are stale: drawn dim on purpose, so it is held to the secondary rule.
  pairs.push({ group: 'usage-bar pill', label: 'T.fg on T.hl2 (stale limits pill)', fg: T.fg, bg: T.hl2, min: SECONDARY })
  // Turn Card and Agent Board
  const LIGHT_BACKGROUNDS = [['white', '#ffffff'], ['cream', '#f0eee6']]
  for (const [plugin, skip] of [['kit-turn', []], ['kit-agents', ['border']]]) {
    const file = `plugins/${plugin}/hooks/data.ts`
    let colors
    try { colors = parsePluginColors(readFileSync(join(root, file), 'utf8'), file) } catch (err) { throw new Error(`${file}: ${err.message}`) }
    for (const mode of ['dark', 'light']) {
      const bgs = mode === 'dark' ? backgrounds : LIGHT_BACKGROUNDS
      for (const [role, fg] of Object.entries(colors[mode])) {
        if (skip.includes(role)) continue
        for (const [name, bg] of bgs) pairs.push({ group: `${plugin} ${mode}`, label: `${role} on ${name}`, fg, bg, min: MAIN })
      }
    }
  }
  return pairs
}

async function main() {
  let pairs
  try { pairs = await collect() } catch (err) {
    console.error(`contrast: cannot read colors: ${err.message}`)
    process.exit(1)
  }
  let failed = 0
  const rows = pairs.map(p => {
    const r = ratio(p.fg, p.bg)
    const ok = r >= p.min
    if (!ok) failed++
    return { ...p, r, ok }
  })
  const w = Math.max(...rows.map(r => r.label.length))
  let group = ''
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`\n${group}`) }
    console.log(`  ${r.label.padEnd(w)}  ${r.fg} on ${r.bg}  ${r.r.toFixed(2).padStart(5)}:1  need ${String(r.min).padEnd(3)} ${r.ok ? 'PASS' : 'FAIL'}`)
  }
  console.log(`\n${rows.length - failed}/${rows.length} pairs pass${failed ? `, ${failed} FAIL` : ''}`)
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
