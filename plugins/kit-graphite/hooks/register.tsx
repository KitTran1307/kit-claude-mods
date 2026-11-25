import type { EngineInterface, Register, ThemeResult, ThemeSetArgs } from 'claude-code'

import { MIN_CLAUDE_CODE, formatLine, parseVersion, summary, versionAtLeast } from './doctor'
import type { Line } from './doctor'
import { languageFromSetting, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'
import { makeColors } from './make-colors.js'
import { DEF } from './palette.js'
import { SCENE } from './scene'

const { theme, problems } = makeColors(DEF)

const LOOK: ThemeSetArgs = {
  colors: theme,
  backdrop: { scene: 'kit-graphite-waves', glass: { blur: 0, opacity: 0.45 } },
}

/** The key in the plugin's store that remembers the choice between sessions: false means off. Unset means on. */
const STORE_KEY = 'enabled'
const BACKDROP_IMAGE = 'terminal/terminal-backdrop.png'
const BACKDROP_SCRIPT = 'terminal/add-to-windows-terminal.py'

const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

/** What this session knows about the theme it set (for /graphite doctor). */
type ThemeNote =
  | { kind: 'untried' }
  | { kind: 'drawn' }
  | { kind: 'waiting' } // accepted, drawn once the desktop or mobile app attaches
  | { kind: 'nothing'; why: string } // accepted, but nothing here draws themes (a terminal-only session)
  | { kind: 'refused'; why: string }

/** The choice as the store holds it: `known` is false when the store could not be read (the plugin then stays on). */
type Flag = { on: boolean; known: boolean }

/** What one loaded copy of the module remembers: the choice (read once), what the theme set said, and whether this session set the look. */
type State = { flag?: Promise<Flag>; note: ThemeNote; isLookSet: boolean; lang: Lang; t: Strings }

/** The words in use: Claude Code's own `language` setting, read once at session start (English when it cannot be read). */
async function settleLanguage($: EngineInterface, s: State) {
  let lang: Lang = 'en'
  try { lang = languageFromSetting(await $.settings.read({ key: 'language' })) } catch { /* English */ }
  s.lang = lang
  s.t = stringsFor(lang)
}

/** Whether the engine runs on Windows; false on any other or unknown platform (read without running anything). */
async function isWindows($: EngineInterface): Promise<boolean> {
  try { return (await $.session.info())?.platform === 'windows' } catch { return false }
}

async function readFlag($: EngineInterface): Promise<Flag> {
  try {
    return { on: (await $.store.get(STORE_KEY)) !== false, known: true }
  } catch {
    return { on: true, known: false }
  }
}

function currentFlag($: EngineInterface, s: State): Promise<Flag> {
  s.flag ??= readFlag($)
  return s.flag
}

/** Sets the look and remembers what the engine said. Never throws. */
async function applyLook($: EngineInterface, s: State): Promise<boolean> {
  try {
    const set: ThemeResult = await $.theme.set(LOOK)
    s.isLookSet = true
    // A requestId means the theme stands and draws once the desktop or mobile client attaches (after session.start).
    // With none, nothing here draws themes (a terminal-only session): the reason goes to the debug log only.
    if (set.isDrawn) s.note = { kind: 'drawn' }
    else if (set.requestId !== undefined) s.note = { kind: 'waiting' }
    else {
      s.note = { kind: 'nothing', why: reason(set.reason) }
      $.ui.log(`kit-graphite: theme not drawn: ${set.reason}`, { to: 'debug' })
    }
    return true
  } catch (err) {
    // An older Claude Code refuses the theme: keep its own look, and never fail the session's start hook.
    s.note = { kind: 'refused', why: reason(err) }
    $.ui.log(`kit-graphite: theme not set: ${String(err)}`, { to: 'debug' })
    return false
  }
}

async function remember($: EngineInterface, s: State, isOn: boolean): Promise<boolean> {
  s.flag = Promise.resolve({ on: isOn, known: true })
  try {
    if (isOn) await $.store.delete(STORE_KEY)
    else await $.store.set(STORE_KEY, false)
    return true
  } catch (err) {
    $.ui.log(`kit-graphite: could not remember the choice: ${String(err)}`, { to: 'debug' })
    return false
  }
}


async function runCommand($: EngineInterface, s: State, args: string): Promise<string> {
  const t = s.t
  if (args === '' || args === 'status') {
    const { on: isOn, known } = await currentFlag($, s)
    return t.statusIs(isOn, known)
  }
  if (args === 'off') {
    const wasOn = (await currentFlag($, s)).on
    const saved = await remember($, s, false)
    const keep = saved ? '' : t.offNotSaved
    if (!s.isLookSet) {
      return wasOn
        ? t.offNextSession(keep)
        : t.offAlready(keep)
    }
    try {
      await $.theme.clear()
      s.isLookSet = false
      s.note = { kind: 'untried' }
      return t.offDone(keep)
    } catch (err) {
      $.ui.log(`kit-graphite: could not clear the theme: ${String(err)}`, { to: 'debug' })
      return t.offNextSession(keep)
    }
  }
  if (args === 'on') {
    const saved = await remember($, s, true)
    const keep = saved ? '' : t.onNotSaved
    if (s.isLookSet) return t.onDone(keep)
    return (await applyLook($, s))
      ? t.onDone(keep)
      : t.onNextSession(keep)
  }
  if (args === 'doctor') return (await doctor($, s)).join('\n')
  return t.usage
}


async function claudeVersion($: EngineInterface): Promise<string | null> {
  try {
    const v = await $.session.version()
    if (parseVersion(v?.base ?? v?.version)) return String(v.base ?? v.version)
  } catch { /* try the command */ }
  try {
    const r = await $.process.run(['claude', '--version'], { timeoutMs: 10_000 })
    const found = r.exitCode === 0 ? parseVersion(r.stdout) : null
    if (found) return found.join('.')
  } catch { /* unknown */ }
  return null
}


/** `/graphite doctor`: read-only, one line per check, then a summary. Nothing is run or changed. */
async function doctor($: EngineInterface, s: State): Promise<string[]> {
  const d = s.t.doctor
  const lines: Line[] = []
  const check = async (name: string, run: () => Promise<Line | Line[]>) => {
    try { lines.push(...[await run()].flat()) } catch (err) {
      lines.push({ level: 'WARN', name, detail: reason(err), fix: d.checkFailedFix })
    }
  }

  await check('claude-code', async () => {
    const v = await claudeVersion($)
    const ok = v === null ? null : versionAtLeast(v, MIN_CLAUDE_CODE)
    if (v === null || ok === null) {
      return { level: 'WARN', name: 'claude-code', detail: d.versionUnknown(MIN_CLAUDE_CODE), fix: d.versionUnknownFix }
    }
    return ok
      ? { level: 'PASS', name: 'claude-code', detail: d.versionOk(v, MIN_CLAUDE_CODE) }
      : { level: 'WARN', name: 'claude-code', detail: d.versionOld(v, MIN_CLAUDE_CODE), fix: d.updateFix }
  })

  await check('setting', async () => {
    const f = await currentFlag($, s)
    if (!f.known) {
      return { level: 'WARN', name: 'setting', detail: d.settingUnreadable, fix: d.settingUnreadableFix }
    }
    return { level: 'PASS', name: 'setting', detail: d.settingOk(f.on) }
  })

  await check('theme', async () => {
    if (!(await currentFlag($, s)).on) return { level: 'PASS', name: 'theme', detail: d.themeOff }
    switch (s.note.kind) {
      case 'drawn': return { level: 'PASS', name: 'theme', detail: d.themeDrawn }
      case 'waiting': return { level: 'PASS', name: 'theme', detail: d.themeWaiting }
      case 'nothing': return { level: 'WARN', name: 'theme', detail: d.themeNothing, fix: d.themeNothingFix }
      case 'refused': return { level: 'WARN', name: 'theme', detail: d.themeRefused(s.note.why), fix: d.updateFix }
      default: return { level: 'PASS', name: 'theme', detail: d.themeUntried }
    }
  })

  // Optional extras for Windows Terminal: only looked for, never run.
  const root = String($.plugin.root ?? '').replace(/[\\/]+$/, '')
  const windows = await isWindows($)
  for (const [name, rel] of [['terminal-image', BACKDROP_IMAGE], ['terminal-script', BACKDROP_SCRIPT]] as const) {
    await check(name, async () => {
      if (!windows) return { level: 'PASS', name, detail: d.terminalNotNeeded }
      const found = root !== '' && await $.fs.exists(`${root}/${rel}`)
      return found
        ? { level: 'PASS', name, detail: d.terminalFound(rel) }
        : { level: 'WARN', name, detail: d.terminalMissing(rel), fix: d.terminalMissingFix }
    })
  }

  return [...lines.map(formatLine), summary(lines, d.summary)]
}


export const register: Register = on => {
  const s: State = { note: { kind: 'untried' }, isLookSet: false, lang: 'en', t: stringsFor('en') }

  on('session.start', async ($, e, next) => {
    try {
      s.flag = readFlag($)
      await settleLanguage($, s)
      const { on: isOn, known } = await s.flag
      if (!known) $.ui.log('kit-graphite: could not read the on/off choice; staying on', { to: 'debug' })
      try {
        await $.command.register({
          name: 'graphite',
          description: s.t.commandDescription,
          argumentHint: s.t.commandHint,
        })
      } catch (err) { $.ui.log(`kit-graphite: no /graphite command: ${String(err)}`, { to: 'debug' }) }

      if (isOn) {
        const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))

        if (unpainted !== undefined) {
          $.ui.toast(unpainted)
        }
        await applyLook($, s)
      } else {
        $.ui.log('kit-graphite: off by choice; no theme set', { to: 'debug' })
      }
    } catch (err) {
      $.ui.log(`kit-graphite: session start skipped: ${String(err)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('command.run', { command: 'graphite' }, async ($, e) => {
    try {
      return { text: await runCommand($, s, String(e.args ?? '').trim().toLowerCase()) }
    } catch (err) {
      $.ui.log(`kit-graphite: command failed: ${String(err)}`, { to: 'debug' })
      return { text: s.t.failed }
    }
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== 'kit-graphite-waves') {
      return next(e)
    }
    // Off: draw nothing, and leave the site to the engine.
    try { if (!(await currentFlag($, s)).on) return next(e) } catch { /* stays on */ }
    const { Svg } = $.ui.resolve(e)

    return <Svg source={SCENE} alt="A graphite dot field frozen mid-wave, with a small clay-colored pixel comet circling the middle" isInteractive />
  })
}
