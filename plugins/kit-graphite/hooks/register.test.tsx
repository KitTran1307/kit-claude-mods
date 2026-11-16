import { expect, test } from 'claude-code/testing'

import type { On } from 'claude-code'

type World = { looks: any[]; statuses: string[]; toasts: string[] }

// Stands in for the engine: records what the plugin asks of it, and answers theme.set with `answer`.
function engine(on: On, answer: object | 'refuse'): World {
  const w: World = { looks: [], statuses: [], toasts: [] }
  on('theme.set', (_: unknown, e: any) => { w.looks.push(e); if (answer === 'refuse') throw new Error('theme.set: refused (host check)'); return { value: answer } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: any) => { w.statuses.push(String(e.text)); return { value: undefined } })
  on('ui.toast', (_: unknown, e: any) => { w.toasts.push(String(e.text)); return { value: undefined } })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  return w
}

const BACKDROP = (scene: string) => ({
  plugin: 'kit-graphite',
  component: 'Backdrop',
  requestId: 'backdrop',
  props: { scene, plugin: 'kit-graphite', glass: { blur: 0, opacity: 0.45 } },
}) as const

test('session start sets the graphite colors and the dot-wave backdrop', async ($, on) => {
  const w = engine(on, { isDrawn: true, requestId: 'backdrop' })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  expect(w.looks).toHaveLength(1)
  expect(w.looks[0].backdrop.scene).toBe('kit-graphite-waves')
  expect(Object.keys(w.looks[0].colors).length).toBeGreaterThan(0)
  expect(w.statuses).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

test('no status line while the desktop client is still attaching', async ($, on) => {
  const w = engine(on, { isDrawn: false, requestId: 'backdrop', reason: 'not attached yet' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  expect(w.statuses).toHaveLength(0)
})

test('a terminal-only session (nothing will draw the theme) says nothing to the person', async ($, on) => {
  const w = engine(on, { isDrawn: false, reason: 'no client draws themes' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
  expect(w.statuses).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

test('a Claude Code that refuses the theme leaves the session start alone and says nothing', async ($, on) => {
  const w = engine(on, 'refuse')
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  expect(w.statuses).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

for (const surface of ['desktop', 'mobile'] as const) {
  test(`the backdrop draws the scene on ${surface}`, { options: { surfaces: 'desktop+terminal' } } as never, async ($, on) => {
    engine(on, { isDrawn: true, requestId: 'backdrop' })
    const ui = await $.ui.mount({ ...BACKDROP('kit-graphite-waves'), surface } as never)
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs).toHaveLength(1)
    expect(String(svgs[0]!.props.alt)).toContain('comet')
    await ui.unmount()
  })
}

test('another scene is left to the engine', async ($, on) => {
  engine(on, { isDrawn: true, requestId: 'backdrop' })
  const ui = await $.ui.mount({ ...BACKDROP('someone-else'), surface: 'desktop' } as never)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('engine')
  await ui.unmount()
})
