export type Palette = {
  mode: 'light' | 'dark'
  bg: string; side: string; surf: string; bd: string
  tx: string; tx2: string; ac: string; acx: string; code: string
  kw: string; fn: string; st: string; cm: string; user: string; band: string
  roles: { danger: string; success: string; warning: string; pro: string }
}
export const PALETTES: Record<'paper' | 'contrast' | 'night', Palette>
export const NAMES: ['paper', 'contrast', 'night']
export const PAIRS: [label: string, fg: string, bg: string, min: number][]
