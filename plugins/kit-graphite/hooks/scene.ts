// The backdrop: a field of dots over graphite, frozen mid-wave, with a drift of
// small bright motes rising through it on a slow sway, like dust streaming past on
// the way into space, and the clay-colored traveller (character.ts) among them.
//
// The field's shading follows Codex CLI's dot animations, where dot size (· ○ ● ◉)
// carries the light: curved wave crests are big bright dots, troughs tiny dim ones,
// with a little per-dot jitter. It does not move.
//
// Why it moves this way: nothing inside an SVG is composited on its own, so a
// change repaints the area around what changed, and in the desktop app that shares
// a thread with the app's own interface. A field that changes everywhere repaints
// the whole screen every frame and drags the app down. Here only small things move
// (each mote, the traveller), so each frame repaints a few small patches, and
// everything runs smoothly at the display's own rate.
//
// Dots are drawn only between the app's sidebars, which cover the sides anyway.
// Behind the message column sits a frosted pane with crisp square edges, so text
// reads easily while the dots stay sharp outside it (the app's own glass blur
// smears past the panels' edges, so it is off).
// Light by default, charcoal when the app is dark.

import { CHARACTER, CHARACTER_CSS } from './character'

const W = 1600
const H = 1000
const PITCH = 24
const X_FROM = 280
const X_TO = 1360
const LEVELS = 4
const RADIUS = [1.1, 1.6, 2.3, 3.1]
// The frosted pane behind the message column, in viewBox units: the column sits a
// little right of centre, the app's left sidebar being wider than its right panel.
const PANE = { x: 500, width: 640 }

// A fixed pseudo-random number in [0, 1) per cell.
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

// The frozen wave: rings spreading from beyond the top right corner, bent by a slow
// swell, as light 0..1 per point (a sharp crest and a long settle behind it).
const lightAt = (x: number, y: number) => {
  const d = Math.hypot(x - 1900, y + 300)
  const bend = 60 * Math.sin(x / 260) + 45 * Math.sin((x + y) / 410)
  const p = (d + bend) / 300 + (noise(x, y) - 0.5) * 0.06
  const f = p - Math.floor(p)
  return f < 0.35 ? 0 : f < 0.55 ? (f - 0.35) / 0.2 : Math.max(0, 1 - (f - 0.55) / 0.4)
}

const levels: string[][] = Array.from({ length: LEVELS }, () => [])
for (let y = PITCH / 2; y < H; y += PITCH) {
  for (let x = X_FROM + PITCH / 2; x < X_TO; x += PITCH) {
    const level = Math.min(LEVELS - 1, Math.floor(lightAt(x, y) * LEVELS * 0.999))
    levels[level]?.push(`M${x} ${y}h0`)
  }
}
const field = levels
  .map((d, i) => `<path class="f${i}" stroke-width="${(RADIUS[i] ?? 1) * 2}" d="${d.join('')}"/>`)
  .join('\n')

// The motes: each rises up and to the right across the middle column on a sway,
// fading in and out, on its own time. Two nested groups: the outer drifts, the
// inner sways, so one shared pair of keyframes serves every mote.
const MOTES = 34
const motes: string[] = []
for (let i = 0; i < MOTES; i++) {
  const x = X_FROM + 40 + noise(i, 1) * (X_TO - X_FROM - 340)
  const y = 620 + noise(i, 2) * 480
  const r = 1.4 + noise(i, 3) * 2
  const drift = 14 + noise(i, 4) * 12 // seconds to cross
  const sway = 2.6 + noise(i, 5) * 2.4 // seconds per sway
  const startAt = -(noise(i, 6) * drift) // spread them along their paths
  const tone = noise(i, 7) < 0.3 ? 'm2' : 'm1'
  motes.push(
    `<g class="dr" style="animation-duration:${drift.toFixed(1)}s;animation-delay:${startAt.toFixed(1)}s">` +
      `<g class="sw" style="animation-duration:${sway.toFixed(1)}s;animation-delay:${(-noise(i, 8) * sway).toFixed(1)}s">` +
      `<circle class="${tone}" cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}"/></g></g>`,
  )
}

export const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<style>
svg{--bg:#e3e3e2;--f0:#d2d2d0;--f1:#b9b9b7;--f2:#8c8c8a;--f3:#4a4a49;--m1:#2a2a2a;--m2:#c96a4a}
@media (prefers-color-scheme: dark){svg{--bg:#121212;--f0:#222222;--f1:#333333;--f2:#5a5a5a;--f3:#9a9a9a;--m1:#f2f2f2;--m2:#e9a07f}}
.bg{fill:var(--bg)}
.field path{fill:none;stroke-linecap:round}
.f0{stroke:var(--f0)}.f1{stroke:var(--f1)}.f2{stroke:var(--f2)}.f3{stroke:var(--f3)}
.m1{fill:var(--m1)}.m2{fill:var(--m2)}
.pane{fill:var(--bg);fill-opacity:.78;stroke:var(--f2);stroke-opacity:.5;stroke-width:1}
@keyframes dr{0%{transform:translate(0,0);opacity:0}12%{opacity:.9}80%{opacity:.9}100%{transform:translate(300px,-760px);opacity:0}}
@keyframes sw{0%,100%{transform:translateX(-22px)}50%{transform:translateX(22px)}}
.dr{animation:dr 18s linear infinite}
.sw{animation:sw 3s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.dr,.sw{animation:none}}${CHARACTER_CSS}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<g class="field">
${field}
</g>
<g class="motes">
${motes.join('\n')}
</g>
<rect class="pane" x="${PANE.x}" y="-2" width="${PANE.width}" height="${H + 4}"/>
${CHARACTER}
</svg>`
