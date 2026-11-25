import { expect, test } from 'claude-code/testing'

import { TERMINAL_COLUMNS, TERMINAL_ROWS, spriteGrid, svgOf, terminalRows, terminalSprite } from './sprite'
import type { Cell, Grid } from './sprite'
import { SPRITES, TERMINAL_SPRITES } from './sprites'
import type { PetId, PetState, Stage } from './types'

const PETS: PetId[] = ['moss', 'bun', 'jelly']
const STAGES: Stage[] = [1, 2, 3]
const STATES: PetState[] = ['idle', 'working', 'done', 'error', 'quota']

const flat = (g: Grid): string => g.map((r) => r.map((c) => c ?? '.').join(',')).join('/')

test('every pet, stage and state is a 16x22 grid using only palette colors', () => {
  for (const p of PETS) {
    for (const stage of STAGES) {
      for (const s of STATES) {
        const g = spriteGrid(p, stage, s)
        expect(g.length).toBe(16)
        for (const row of g) {
          expect(row.length).toBe(22)
          for (const c of row) if (c !== null) expect(SPRITES[p].palette.includes(c)).toBe(true)
        }
      }
    }
  }
})

test('each state looks different from idle at stage 2, and the stages differ', () => {
  for (const p of PETS) {
    const idle = flat(spriteGrid(p, 2, 'idle'))
    for (const s of STATES) if (s !== 'idle') expect(flat(spriteGrid(p, 2, s)) === idle).toBe(false)
    const seen = new Set(STAGES.map((st) => flat(spriteGrid(p, st, 'idle'))))
    expect(seen.size).toBe(3)
  }
})

test('svgOf is a small script-free svg with only #rrggbb fills', () => {
  for (const p of PETS) {
    for (const stage of STAGES) {
      for (const s of STATES) {
        const svg = svgOf(spriteGrid(p, stage, s))
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg.includes('<script')).toBe(false)
        expect(svg.includes('http') && !svg.includes('xmlns="http://www.w3.org/2000/svg"')).toBe(false)
        expect(svg.length < 20000).toBe(true)
        const fills = svg.match(/fill="[^"]*"/g) ?? []
        expect(fills.length > 0).toBe(true)
        for (const f of fills) expect(/^fill="#[0-9a-f]{6}"$/.test(f)).toBe(true)
      }
    }
  }
})

test('terminalRows is 3 rows of 10 cells with only half-block characters', () => {
  expect(TERMINAL_ROWS).toBe(3)
  expect(TERMINAL_COLUMNS).toBe(10)
  for (const p of PETS) {
    for (const stage of STAGES) {
      for (const s of STATES) {
        const rows = terminalRows(spriteGrid(p, stage, s))
        expect(rows.length).toBe(3)
        for (const row of rows) {
          expect(row.length).toBe(10)
          for (const c of row) {
            expect(['▀', '▄', ' '].includes(c.ch)).toBe(true)
            for (const col of [c.fg, c.bg]) if (col !== undefined) expect(/^#[0-9a-f]{6}$/.test(col)).toBe(true)
            if (c.ch === ' ') expect(c.fg === undefined && c.bg === undefined).toBe(true)
          }
        }
      }
    }
  }
})

const cellsKey = (rows: Cell[][]): string => JSON.stringify(rows)

/** The 10x6 pixel picture behind 3 rows of half blocks (upper pixel is fg of the upper half, lower is bg). */
function pixelsOf(rows: Cell[][]): (string | null)[][] {
  const out: (string | null)[][] = []
  for (const row of rows) {
    out.push(row.map((c) => (c.ch === '▀' ? (c.fg ?? null) : null)))
    out.push(row.map((c) => (c.ch === '▀' ? (c.bg ?? null) : c.ch === '▄' ? (c.fg ?? null) : null)))
  }
  return out
}

test('the hand-tuned table is 6 rows of 10 palette indices for every pet, stage and state', () => {
  for (const p of PETS) {
    for (const stage of STAGES) {
      for (const s of STATES) {
        const rows = TERMINAL_SPRITES[p][stage][s]
        expect(rows.length).toBe(6)
        for (const r of rows) {
          expect(r.length).toBe(10)
          for (const ch of r) expect(ch === '.' || (parseInt(ch, 36) < SPRITES[p].palette.length)).toBe(true)
        }
      }
    }
  }
})

test('terminalSprite is 3 rows of 10 half-block cells using only the pet palette', () => {
  for (const p of PETS) {
    for (const stage of STAGES) {
      for (const s of STATES) {
        const rows = terminalSprite(p, stage, s)
        expect(rows.length).toBe(TERMINAL_ROWS)
        let painted = 0
        for (const row of rows) {
          expect(row.length).toBe(TERMINAL_COLUMNS)
          for (const c of row) {
            expect(['▀', '▄', ' '].includes(c.ch)).toBe(true)
            for (const col of [c.fg, c.bg]) if (col !== undefined) expect(SPRITES[p].palette.includes(col)).toBe(true)
            // a visible half block always has a foreground; a blank cell has no colors at all
            if (c.ch === ' ') expect(c.fg === undefined && c.bg === undefined).toBe(true)
            else {
              expect(c.fg !== undefined).toBe(true)
              painted++
            }
            // a lower-half block never carries a background (that would paint the upper half)
            if (c.ch === '▄') expect(c.bg === undefined).toBe(true)
          }
        }
        expect(painted > 15).toBe(true)
      }
    }
  }
})

test('terminalSprite: every state differs from idle at every stage, and the stages differ', () => {
  for (const p of PETS) {
    for (const stage of STAGES) {
      const idle = cellsKey(terminalSprite(p, stage, 'idle'))
      for (const s of STATES) if (s !== 'idle') expect(cellsKey(terminalSprite(p, stage, s)) === idle).toBe(false)
    }
    for (const s of STATES) {
      const seen = new Set(STAGES.map((stage) => cellsKey(terminalSprite(p, stage, s))))
      expect(seen.size).toBe(3)
    }
  }
})

test('terminalSprite keeps the face: two separate dark eyes with a gap, and a mouth below them (stage 2 idle)', () => {
  for (const p of PETS) {
    const dark = SPRITES[p].palette.find((c) => c === '#16161e')
    expect(dark !== undefined).toBe(true)
    const px = pixelsOf(terminalSprite(p, 2, 'idle'))
    const spots: { x: number; y: number }[] = []
    px.forEach((row, y) => row.forEach((c, x) => c === dark && spots.push({ x, y })))
    // the eyes are the topmost dark pixels, both on one row and not touching; the mouth is below
    const eyeRow = Math.min(...spots.map((d) => d.y))
    const eyes = spots.filter((d) => d.y === eyeRow).map((d) => d.x)
    expect(eyes.length).toBe(2)
    expect((eyes[1] ?? 0) - (eyes[0] ?? 0) >= 2).toBe(true)
    expect(spots.some((d) => d.y > eyeRow)).toBe(true)
    // the face is not smeared: very few dark pixels
    expect(spots.length <= 5).toBe(true)
  }
})

test('terminalSprite is deterministic and falls back to moss, stage 2, idle', () => {
  expect(cellsKey(terminalSprite('bun', 3, 'done'))).toBe(cellsKey(terminalSprite('bun', 3, 'done')))
  const base = cellsKey(terminalSprite('moss', 2, 'idle'))
  expect(cellsKey(terminalSprite('nope' as PetId, 2, 'idle'))).toBe(base)
  expect(cellsKey(terminalSprite('moss', 9 as Stage, 'idle'))).toBe(base)
  expect(cellsKey(terminalSprite('moss', 2, 'sleepy' as PetState))).toBe(base)
})

test('the same input gives the same output', () => {
  const a = spriteGrid('bun', 3, 'done')
  const b = spriteGrid('bun', 3, 'done')
  expect(flat(a)).toBe(flat(b))
  expect(svgOf(a)).toBe(svgOf(b))
  expect(JSON.stringify(terminalRows(a))).toBe(JSON.stringify(terminalRows(b)))
})

test('unknown input falls back to moss, stage 2, idle', () => {
  const base = flat(spriteGrid('moss', 2, 'idle'))
  expect(flat(spriteGrid('nope' as PetId, 2, 'idle'))).toBe(base)
  expect(flat(spriteGrid('moss', 9 as Stage, 'idle'))).toBe(base)
  expect(flat(spriteGrid('moss', 2, 'sleepy' as PetState))).toBe(base)
})
