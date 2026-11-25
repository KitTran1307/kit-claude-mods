// Pure sprite helpers: build the grid for a pet / stage / state, and turn a grid into an SVG
// or into terminal cells. No engine imports, plain JS only.

import { SPRITES, TERMINAL_SPRITES } from './sprites'
import type { PetSprites } from './sprites'
import type { PetId, PetState, Stage } from './types'

export type Grid = (string | null)[][]
export type Cell = { ch: string; fg?: string; bg?: string }

export const TERMINAL_ROWS = 3
export const TERMINAL_COLUMNS = 10

const WIDTH = 22
const HEIGHT = 16
// The pet body sits in these columns; everything outside is the state's side effects.
const BODY_FIRST = 3
const BODY_LAST = 18
// Stage 3 swaps only the top of the body (the crown / flower / glow).
const CROWN_ROWS = 5

const STATES: PetState[] = ['idle', 'working', 'done', 'error', 'quota']

function decode(pet: PetSprites, rows: string[]): Grid {
  return rows.map((row) => {
    const out: (string | null)[] = []
    for (let x = 0; x < WIDTH; x++) {
      const ch = row.charAt(x)
      out.push(ch === '.' || ch === '' ? null : (pet.palette[parseInt(ch, 36)] ?? null))
    }
    return out
  })
}

const isSide = (x: number): boolean => x < BODY_FIRST || x > BODY_LAST

/** One pixel of a grid; outside the grid is transparent, so an index can never be undefined. */
function pixel(grid: readonly (readonly (string | null)[])[], y: number, x: number): string | null {
  return grid[y]?.[x] ?? null
}

/** The sprite for a pet at a stage in a state. Unknown input falls back to moss / 2 / idle. */
export function spriteGrid(pet: PetId, stage: Stage, state: PetState): Grid {
  const sprites = SPRITES[pet] ?? SPRITES.moss
  const known = SPRITES[pet] !== undefined
  const st: PetState = known && STATES.includes(state) ? state : 'idle'
  const stg: Stage = known && (stage === 1 || stage === 3) ? stage : 2
  const base = decode(sprites, sprites.states[st])
  if (stg === 2) return base
  if (stg === 3) {
    const top = decode(sprites, sprites.stage3)
    return base.map((row, y) => row.map((c, x) => (y < CROWN_ROWS && !isSide(x) ? pixel(top, y, x) : c)))
  }
  const seed = decode(sprites, sprites.stage1)
  return seed.map((row, y) => row.map((c, x) => (isSide(x) ? pixel(base, y, x) : c)))
}

/** One small SVG: runs of the same color in a row become a single rect. */
export function svgOf(grid: Grid): string {
  const rects: string[] = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? []
    let x = 0
    while (x < row.length) {
      const c = row[x]
      if (!c) {
        x++
        continue
      }
      let end = x + 1
      while (end < row.length && row[end] === c) end++
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${c}"/>`)
      x = end
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

const DARK = 0.2
const DARK_SHARE = 0.28

const PIXEL_ROWS = TERMINAL_ROWS * 2
const SRC = BODY_LAST - BODY_FIRST + 1

/**
 * Squeeze the 16x16 body into 10 columns x 6 pixel rows. Per target pixel the dominant color by
 * area wins, except that a dark pixel (eye, mouth, outline) wins when it covers about a quarter of the
 * block, so faces survive. A block that is mostly empty stays transparent.
 */
function downsample(grid: Grid): Grid {
  const out: Grid = []
  const bw = SRC / TERMINAL_COLUMNS
  const bh = HEIGHT / PIXEL_ROWS
  for (let ty = 0; ty < PIXEL_ROWS; ty++) {
    const row: (string | null)[] = []
    for (let tx = 0; tx < TERMINAL_COLUMNS; tx++) {
      const x0 = tx * bw
      const x1 = x0 + bw
      const y0 = ty * bh
      const y1 = y0 + bh
      const area = new Map<string, number>()
      let empty = 0
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * (Math.min(y + 1, y1) - Math.max(y, y0))
          const c = pixel(grid, y, x + BODY_FIRST)
          if (c) area.set(c, (area.get(c) ?? 0) + w)
          else empty += w
        }
      }
      const total = bw * bh
      let filled = 0
      let best: string | null = null
      let bestArea = 0
      let dark: string | null = null
      let darkArea = 0
      for (const [c, a] of area) {
        filled += a
        if (a > bestArea || (a === bestArea && best !== null && c < best)) {
          best = c
          bestArea = a
        }
        if (luminance(c) < DARK) darkArea += a
        if (luminance(c) < DARK && (dark === null || a > (area.get(dark) ?? 0))) dark = c
      }
      if (empty > filled) row.push(null)
      else if (dark !== null && darkArea >= total * DARK_SHARE) row.push(dark)
      else row.push(best)
    }
    out.push(row)
  }
  return out
}

/** 6 pixel rows x 10 columns to 3 rows x 10 cells of half blocks: the upper pixel is fg of '▀', the lower is bg. */
function halfBlocks(px: Grid): Cell[][] {
  const rows: Cell[][] = []
  for (let r = 0; r < TERMINAL_ROWS; r++) {
    const cells: Cell[] = []
    for (let x = 0; x < TERMINAL_COLUMNS; x++) {
      const up = pixel(px, r * 2, x)
      const low = pixel(px, r * 2 + 1, x)
      if (up && low) cells.push({ ch: '▀', fg: up, bg: low })
      else if (up) cells.push({ ch: '▀', fg: up })
      else if (low) cells.push({ ch: '▄', fg: low })
      else cells.push({ ch: ' ' })
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Generic fallback: terminal cells from any sprite grid by squeezing it (area downsample, 1.6 x 2.67).
 * It blurs faces; the pets use the hand-tuned `terminalSprite` instead.
 */
export function terminalRows(grid: Grid): Cell[][] {
  return halfBlocks(downsample(grid))
}

function decodeTerminal(pet: PetSprites, rows: readonly string[]): Grid {
  return rows.map((row) => {
    const out: (string | null)[] = []
    for (let x = 0; x < TERMINAL_COLUMNS; x++) {
      const ch = row.charAt(x)
      out.push(ch === '.' || ch === '' ? null : (pet.palette[parseInt(ch, 36)] ?? null))
    }
    return out
  })
}

/**
 * The hand-tuned terminal sprite for a pet at a stage in a state: 3 rows x 10 cells of half blocks
 * (a 10x6 pixel picture whose face reads at this size). Unknown input falls back to moss / 2 / idle.
 */
export function terminalSprite(pet: PetId, stage: Stage, state: PetState): Cell[][] {
  const known = SPRITES[pet] !== undefined && TERMINAL_SPRITES[pet] !== undefined
  const id: PetId = known ? pet : 'moss'
  const st: PetState = known && STATES.includes(state) ? state : 'idle'
  const stg: Stage = known && (stage === 1 || stage === 3) ? stage : 2
  const rows = TERMINAL_SPRITES[id][stg][st]
  return halfBlocks(decodeTerminal(SPRITES[id], rows))
}
