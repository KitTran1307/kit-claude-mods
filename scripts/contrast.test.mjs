import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ratio, luminance, parseHex, parseUsageBarT } from './contrast.mjs'
import { PALETTES, PAIRS } from '../plugins/kit-themes/hooks/palettes.js'

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)

test('black on white is 21:1, in either order', () => {
  near(ratio('#000000', '#ffffff'), 21, 1e-9)
  near(ratio('#ffffff', '#000000'), 21, 1e-9)
})
test('a color on itself is 1:1', () => near(ratio('#336699', '#336699'), 1, 1e-9))
test('#777 on white is about 4.48:1 and #767676 just passes 4.5', () => {
  near(ratio('#777777', '#ffffff'), 4.48)
  assert.ok(ratio('#767676', '#ffffff') >= 4.5)
})
test('short hex and case are accepted', () => {
  assert.deepEqual(parseHex('#FFF'), [255, 255, 255])
  near(luminance('#fff'), 1, 1e-9)
})
test('a bad color throws', () => assert.throws(() => parseHex('red')))
test('parseUsageBarT reads the palette and fails loudly without it', () => {
  const src = "export const T = {\n  dark: '#16161e', hl: '#292e42', hl2: '#3b4261', comment: '#565f89', fg: '#c0caf5',\n  blue: '#7aa2f7', cyan: '#7dcfff', magenta: '#bb9af7', orange: '#ff9e64',\n  yellow: '#e0af68', green: '#9ece6a', teal: '#73daca', red: '#f7768e',\n} as const"
  assert.equal(parseUsageBarT(src).fg, '#c0caf5')
  assert.throws(() => parseUsageBarT('nothing', 'x.ts'), /x\.ts/)
})
test('kit-themes: High Contrast is AAA (7:1) on every pair, the others meet their own rule', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const [label, fg, bg, min] of PAIRS) {
      assert.ok(ratio(p[fg], p[bg]) >= (name === 'contrast' ? 7 : min), `${name}: ${label}`)
    }
  }
})
