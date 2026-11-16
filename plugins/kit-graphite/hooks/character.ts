// A small clay-colored pixel comet, in the spirit of Claude (our own drawing, not
// Anthropic's logo or mascot): a round pixel head with blinking eyes that stays
// upright, and a pixel tail that always streams back along the flight. It rises from the bottom left of the middle
// column, shrinking as it goes into the distance, then circles the middle of the
// screen for good: the sides are under the app's sidebars, which hide the backdrop.
//
// Motion is plain CSS: keyframes sampled along the flight, two animations per
// element (the swoop, then the orbit, which takes over once its delay is up).
// It covers a small area, so it moves smoothly at the display's own rate: only its
// own small patch repaints (see clock.ts for why the dot field steps instead).

type Point = { x: number; y: number }

const ENTER_SECONDS = 7.2
const ORBIT_SECONDS = 16
const ENTER_STEPS = 36
const ORBIT_STEPS = 48

// The orbit: an ellipse around the middle, entered at its left end heading up.
const CX = 800
const CY = 360
const RX = 230
const RY = 90
const START: Point = { x: 380, y: 1070 }
const BEND: Point = { x: 560, y: 760 }
const END: Point = { x: CX - RX, y: CY }
const SCALE_FROM = 1.6
const SCALE_TO = 0.85

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

const bezier = (t: number): Point => ({
  x: (1 - t) ** 2 * START.x + 2 * (1 - t) * t * BEND.x + t * t * END.x,
  y: (1 - t) ** 2 * START.y + 2 * (1 - t) * t * BEND.y + t * t * END.y,
})

const bezierHeading = (t: number) => {
  const dx = 2 * (1 - t) * (BEND.x - START.x) + 2 * t * (END.x - BEND.x)
  const dy = 2 * (1 - t) * (BEND.y - START.y) + 2 * t * (END.y - BEND.y)
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

// Counterclockwise on screen from the left end, so it carries on upward.
const orbit = (t: number): Point => {
  const a = Math.PI + t * Math.PI * 2
  return { x: CX + RX * Math.cos(a), y: CY - RY * Math.sin(a) + 10 * Math.sin(a * 3) }
}

const orbitHeading = (t: number) => {
  const a = Math.PI + t * Math.PI * 2
  const dx = -RX * Math.sin(a)
  const dy = -RY * Math.cos(a) + 30 * Math.cos(a * 3)
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

// Keep angles continuous so a keyframe never spins the long way round.
const unwrap = (angles: number[]) => {
  const out: number[] = []
  for (const a of angles) {
    const prev = out[out.length - 1]
    let v = a
    if (prev !== undefined) {
      while (v - prev > 180) v -= 360
      while (v - prev < -180) v += 360
    }
    out.push(v)
  }
  return out
}

const f = (n: number) => n.toFixed(1)
const pct = (share: number) => (share * 100).toFixed(4)

const enterT = Array.from({ length: ENTER_STEPS + 1 }, (_, i) => ease(i / ENTER_STEPS))
const orbitT = Array.from({ length: ORBIT_STEPS + 1 }, (_, i) => i / ORBIT_STEPS)

const enterHeadings = unwrap(enterT.map(bezierHeading))
const orbitHeadings = unwrap(orbitT.map(orbitHeading))

// Where it is and how big.
const moveEnter = enterT
  .map((t, i) => {
    const p = bezier(t)
    const s = SCALE_FROM + (SCALE_TO - SCALE_FROM) * t
    return `${pct(i / ENTER_STEPS)}%{transform:translate(${f(p.x)}px,${f(p.y)}px) scale(${s.toFixed(3)})}`
  })
  .join('')
const moveOrbit = orbitT
  .map((t, i) => {
    const p = orbit(t)
    const s = SCALE_TO * (1 + 0.06 * Math.sin(t * Math.PI * 2))
    return `${pct(i / ORBIT_STEPS)}%{transform:translate(${f(p.x)}px,${f(p.y)}px) scale(${s.toFixed(3)})}`
  })
  .join('')

// The trail points back along the flight.
const trailEnter = enterHeadings.map((h, i) => `${pct(i / ENTER_STEPS)}%{transform:rotate(${f(h)}deg)}`).join('')
const trailOrbit = orbitHeadings.map((h, i) => `${pct(i / ORBIT_STEPS)}%{transform:rotate(${f(h)}deg)}`).join('')

// The body stays upright and banks a little into the turn.
const bank = (h: number) => Math.max(-22, Math.min(22, Math.cos((h * Math.PI) / 180) * 18))
const tiltEnter = enterHeadings.map((h, i) => `${pct(i / ENTER_STEPS)}%{transform:rotate(${f(bank(h))}deg)}`).join('')
const tiltOrbit = orbitHeadings.map((h, i) => `${pct(i / ORBIT_STEPS)}%{transform:rotate(${f(bank(h))}deg)}`).join('')

const two = (name: string) =>
  `animation:${name}E ${ENTER_SECONDS}s linear forwards,` +
  `${name}O ${ORBIT_SECONDS}s linear ${ENTER_SECONDS}s infinite`

export const CHARACTER_CSS = `
.cl{--clay:#d97757;--clay2:#f0a37f;--shade:#b85c3e;--spark:#f6cf9f;--eye:#1b1b1b}
@keyframes mvE{${moveEnter}}
@keyframes mvO{${moveOrbit}}
@keyframes trE{${trailEnter}}
@keyframes trO{${trailOrbit}}
@keyframes tiE{${tiltEnter}}
@keyframes tiO{${tiltOrbit}}
.mv{${two('mv')}}
.tr{${two('tr')}}
.ti{${two('ti')}}
@keyframes blink{0%{transform:scaleY(1)}93.333%{transform:scaleY(.1)}97.778%{transform:scaleY(1)}}
.eye{transform-box:fill-box;transform-origin:center;animation:blink 4.5s step-end infinite}
@keyframes flick{0%,100%{opacity:.95}50%{opacity:.35}}
.sp{animation:flick .6s ease-in-out infinite}
@keyframes glow{0%,100%{opacity:.16}50%{opacity:.3}}
.glow{animation:glow 2.4s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){
.mv,.tr,.ti,.eye,.sp,.glow{animation:none}
.mv{transform:translate(${END.x}px,${END.y}px) scale(${SCALE_TO})}
}`

// Drawn in pixels around (0, 0); one pixel is PX units.
const PX = 4.5

// The head, upright: # body, l light, d shade, e eye, w eye glint.
const HEAD = [
  '  ####  ',
  ' #l###d ',
  '#l#####d',
  '#ew##ewd',
  '#ee##eed',
  '########',
  ' #####d ',
  '  #  #  ',
]
const COLORS: Record<string, string> = { '#': 'var(--clay)', l: 'var(--clay2)', d: 'var(--shade)', e: 'var(--eye)', w: '#ffffff' }

const pixels = (rows: string[], keep: (ch: string) => boolean, cls = '') => {
  const h = rows.length
  const w = Math.max(...rows.map(r => r.length))
  const out: string[] = []
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const fill = COLORS[ch]
      if (fill && keep(ch)) {
        out.push(`<rect${cls ? ` class="${cls}"` : ''} x="${f((x - w / 2) * PX)}" y="${f((y - h / 2) * PX)}" width="${PX}" height="${PX}" fill="${fill}"/>`)
      }
    }),
  )
  return out.join('')
}

// The tail: pixel squares streaming back, fading, flickering out of step.
// [x, y, size in pixels, color, flicker delay]
const TAIL = [
  [-24, -4, 2, 'var(--spark)', 0],
  [-24, 4, 2, 'var(--clay2)', 0.1],
  [-34, 0, 2, 'var(--spark)', 0.2],
  [-42, -6, 1.5, 'var(--clay2)', 0.3],
  [-44, 5, 1.5, 'var(--spark)', 0.4],
  [-54, -1, 1.5, 'var(--clay2)', 0.5],
  [-62, 6, 1, 'var(--spark)', 0.15],
  [-66, -6, 1, 'var(--clay2)', 0.25],
  [-76, 1, 1, 'var(--spark)', 0.35],
  [-88, -3, 1, 'var(--clay2)', 0.45],
] as const

export const CHARACTER = `<g class="cl"><g class="mv">
<g class="tr">${TAIL.map(
  ([x, y, size, color, delay]) =>
    `<rect class="sp" x="${f(x - (size * PX) / 2)}" y="${f(y - (size * PX) / 2)}" width="${f(size * PX)}" height="${f(size * PX)}" fill="${color}" style="animation-delay:-${delay}s"/>`,
).join('')}</g>
<g class="ti">
<circle class="glow" r="30" fill="var(--clay)"/>
${pixels(HEAD, ch => ch !== 'e' && ch !== 'w')}
${pixels(HEAD, ch => ch === 'e' || ch === 'w', 'eye')}
</g>
</g></g>`
