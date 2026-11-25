// The three palettes, as plain data: every color is six-digit hex. The first fifteen keys of each are the approved
// design (Paper, High Contrast, Night); `roles` are the status colors (alert, success, warning, pro) tuned to each.
// scripts/contrast.mjs reads this file, so CI holds every pair below to its WCAG rule.
//
//   bg     the page                       side  the sidebar                surf  the message box (input)
//   tx     main text                      tx2   secondary text             cm    code comments and muted text
//   ac     accent (buttons, links)        acx   text on the accent         code  code block background
//   kw fn st   code: keywords, functions, strings                         user  your messages     band  rows above the prompt
//   bd     borders (not text)

export const PALETTES = {
  paper: {
    mode: 'light',
    bg: '#f6f1e6', side: '#ebe3d0', surf: '#fffcf4', bd: '#d6c9ad',
    tx: '#262019', tx2: '#4a4134', ac: '#a33f1a', acx: '#fffaf0', code: '#ece3cf',
    kw: '#8a3a12', fn: '#1d5f73', st: '#4d6b1f', cm: '#5c5241', user: '#ece3d0', band: '#ebe3d0',
    roles: { danger: '#a82c24', success: '#4d6b1f', warning: '#80540a', pro: '#6a4a8c' },
  },
  contrast: {
    mode: 'dark',
    bg: '#000000', side: '#0a0a0a', surf: '#0f0f0f', bd: '#a8a8a8',
    tx: '#ffffff', tx2: '#dcdcdc', ac: '#ffe14d', acx: '#000000', code: '#000000',
    kw: '#ffb86b', fn: '#7fe3ff', st: '#9dff9d', cm: '#c8c8c8', user: '#1c1c1c', band: '#0f0f0f',
    roles: { danger: '#ff9a9a', success: '#9dff9d', warning: '#ffb86b', pro: '#dcc2ff' },
  },
  night: {
    mode: 'dark',
    bg: '#17110c', side: '#100b07', surf: '#211810', bd: '#43332a',
    tx: '#ecdcc2', tx2: '#bba78b', ac: '#e6a55d', acx: '#17110c', code: '#0f0a06',
    kw: '#e6a55d', fn: '#d9c28f', st: '#b5c27a', cm: '#b8a58a', user: '#2a1f16', band: '#211810',
    roles: { danger: '#ec9a86', success: '#b5c27a', warning: '#e0b25a', pro: '#c9aee6' },
  },
}

export const NAMES = ['paper', 'contrast', 'night']

/**
 * The pairs CI checks: [label, foreground key, background key, minimum ratio].
 * Main text 7:1 and secondary text 4.5:1 everywhere; High Contrast is held to 7:1 for every pair (AAA).
 */
export const PAIRS = [
  ['main text on page', 'tx', 'bg', 7],
  ['secondary text on page', 'tx2', 'bg', 4.5],
  ['main text on sidebar', 'tx', 'side', 7],
  ['secondary text on sidebar', 'tx2', 'side', 4.5],
  ['main text on message box', 'tx', 'surf', 7],
  ['main text on your messages', 'tx', 'user', 7],
  ['main text on bands', 'tx', 'band', 7],
  ['secondary text on bands', 'tx2', 'band', 4.5],
  ['accent on page', 'ac', 'bg', 4.5],
  ['text on accent button', 'acx', 'ac', 4.5],
  ['code comment on code block', 'cm', 'code', 4.5],
  ['code keyword on code block', 'kw', 'code', 4.5],
  ['code function on code block', 'fn', 'code', 4.5],
  ['code string on code block', 'st', 'code', 4.5],
]
