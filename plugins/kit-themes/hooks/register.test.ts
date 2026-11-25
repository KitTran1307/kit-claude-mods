import { expect, test } from 'claude-code/testing'

type World = {
  store: Record<string, unknown> | 'broken'
  storeWritesFail: boolean
  setFails: boolean
  clearFails: boolean
  commandFails: boolean
  themeResult: object
  language: string | undefined
  sets: any[]
  clears: number
  commands: string[]
}

function engine(on: any, over: Partial<World> = {}): World {
  const w: World = {
    store: {}, storeWritesFail: false, setFails: false, clearFails: false, commandFails: false,
    themeResult: { isDrawn: true, requestId: 'theme' }, language: undefined, sets: [], clears: 0, commands: [], ...over,
  }
  const no = (why: string) => ({ deny: why })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('theme.set', (_: unknown, e: any) => { w.sets.push(e); return w.setFails ? no('refused') : { value: w.themeResult as never } })
  on('theme.clear', () => { w.clears += 1; return w.clearFails ? no('cannot clear') : { value: { isDrawn: false, reason: 'cleared' } } })
  on('command.register', (_: unknown, e: any) => { w.commands.push(String(e.name)); return w.commandFails ? no('no') : { value: { command: e.name } } })
  on('store.get', (_: unknown, e: any) => (w.store === 'broken' ? no('store unreadable') : { value: w.store[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    if (w.store === 'broken' || w.storeWritesFail) return no('store unwritable')
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('settings.read', () => (w.language === undefined ? no('unset') : { value: { language: w.language } as never }))
  return w
}

const start = ($: any, surface: 'desktop' | 'terminal' | 'mobile' = 'desktop') =>
  $.session.start({ cwd: '/w', surface, isInteractive: true } as never)
const themes = async ($: any, args: string): Promise<string> => {
  const out: any = await $.command.run({ command: 'themes', args } as never)
  return String(out?.text ?? '')
}
const modes = (set: any) => Object.keys(set.colors.inputs).sort()

test('install is done: a fresh store sets the auto theme (both modes) and registers /themes', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.sets).toHaveLength(1)
  expect(modes(w.sets[0])).toEqual(['dark', 'light'])
  expect(w.commands).toEqual(['themes'])
  expect(await themes($, '')).toContain('Theme: Auto (Paper in light mode, Night in dark mode).')
})

test('/themes night sets only the dark half, says so, and remembers it', async ($, on) => {
  const w = engine(on)
  await start($)
  const text = await themes($, 'night')
  expect(text).toBe('Theme: Night (a dark, low-blue-light palette in warm browns and amber, for evenings). Saved for your next sessions.')
  expect(modes(w.sets[1])).toEqual(['dark'])
  expect(w.store).toEqual({ theme: 'night' })
})

test('/themes paper and contrast each set their own single mode', async ($, on) => {
  const w = engine(on)
  await start($)
  await themes($, 'paper')
  expect(modes(w.sets[1])).toEqual(['light'])
  await themes($, 'High Contrast')
  expect(modes(w.sets[2])).toEqual(['dark'])
  expect(w.sets[2].colors.inputs.dark['bg-user-message']).toBe('#1c1c1c')
  expect(w.store).toEqual({ theme: 'contrast' })
})

test('the saved choice is applied at the next session start', async ($, on) => {
  const w = engine(on, { store: { theme: 'paper' } })
  await start($)
  expect(w.sets).toHaveLength(1)
  expect(modes(w.sets[0])).toEqual(['light'])
  expect(await themes($, 'status')).toContain('Theme: Paper')
})

test('off is remembered: no theme at start; /themes off clears the one this session set', async ($, on) => {
  const w = engine(on, { store: { theme: 'off' } })
  await start($)
  expect(w.sets).toHaveLength(0)
  expect(await themes($, '')).toBe("Themes are off: Claude's own look shows. Options: paper, contrast, night, auto (follow light or dark mode), off.")
  expect(w.clears).toBe(0)
  await themes($, 'paper')
  expect(w.sets).toHaveLength(1)
  expect(await themes($, 'off')).toBe("Themes are off. Claude's own look is back.")
  expect(w.clears).toBe(1)
  expect(w.store).toEqual({ theme: 'off' })
})

test('/themes off never clears a theme this module did not set (another mod keeps its look)', async ($, on) => {
  const w = engine(on, { store: { theme: 'off' } })
  await start($)
  await themes($, 'off')
  expect(w.clears).toBe(0)
})

test('/themes auto after a pick goes back to following the mode', async ($, on) => {
  const w = engine(on, { store: { theme: 'night' } })
  await start($)
  await themes($, 'auto')
  expect(modes(w.sets[1])).toEqual(['dark', 'light'])
  expect(w.store).toEqual({ theme: 'auto' })
})

test('the theme option is the starting choice', { options: { theme: 'contrast' } }, async ($, on) => {
  const w = engine(on)
  await start($)
  expect(modes(w.sets[0])).toEqual(['dark'])
  expect(w.sets[0].colors.inputs.dark['bg-user-message']).toBe('#1c1c1c')
})

test('a saved choice wins over the theme option', { options: { theme: 'contrast' } }, async ($, on) => {
  const w = engine(on, { store: { theme: 'paper' } })
  await start($)
  expect(modes(w.sets[0])).toEqual(['light'])
})

test('theme option off: nothing is set at start', { options: { theme: 'off' } }, async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.sets).toHaveLength(0)
})

test('language option vi wins over Claude Code\'s English', { options: { language: 'vi' } }, async ($, on) => {
  engine(on, { language: 'English' })
  await start($)
  expect(await themes($, '')).toContain('Giao diện: Tự động')
})

test('a wrong word shows the usage and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(await themes($, 'purple')).toBe('Usage: /themes paper | contrast | night | auto | off. Send /themes alone to see the current choice.')
  expect(w.sets).toHaveLength(1)
  expect(w.store).toEqual({})
})

test('the terminal: /themes says plainly that nothing is drawn there', async ($, on) => {
  engine(on, { themeResult: { isDrawn: false, reason: 'a terminal draws no themes' } })
  await start($, 'terminal')
  const text = await themes($, 'paper')
  expect(text).toContain('A terminal draws no theme, so nothing changes here')
  expect(await themes($, '')).toContain('A terminal draws no theme')
})

test('an old Claude Code that refuses themes: start stays quiet, /themes says what happens and keeps the choice', async ($, on) => {
  const w = engine(on, { setFails: true })
  await start($)
  const text = await themes($, 'night')
  expect(text).toContain('cannot draw the theme right now')
  expect(w.store).toEqual({ theme: 'night' })
})

test('a broken store: the default applies, the choice still works for the session, and the failure is said', async ($, on) => {
  const w = engine(on, { store: 'broken' })
  await start($)
  expect(w.sets).toHaveLength(1)
  const text = await themes($, 'night')
  expect(text).toContain('could not be saved')
  expect(text).not.toContain('Saved for your next sessions')
  expect(modes(w.sets[1])).toEqual(['dark'])
})

test('a failing /themes command registration does not stop the theme', async ($, on) => {
  const w = engine(on, { commandFails: true })
  await start($)
  expect(w.sets).toHaveLength(1)
})

test('clear failing on off: the choice is saved and the next session is promised', async ($, on) => {
  engine(on, { clearFails: true })
  await start($)
  expect(await themes($, 'off')).toContain("Themes are off. Claude's own look returns from the next session.")
})

test('Vietnamese: Claude Code language Vietnamese gives Vietnamese words', async ($, on) => {
  engine(on, { language: 'Vietnamese' })
  await start($)
  expect(await themes($, 'paper')).toContain('Giao diện: Giấy')
  expect(await themes($, 'purple')).toContain('Cách dùng')
})
