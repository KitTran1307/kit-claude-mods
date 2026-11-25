import type { EngineInterface, Register, ThemeResult } from 'claude-code'

import { chooseLanguage, describe, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'
import { CHOICES, colorsFor, effectiveChoice, parseChoice, unpainted } from './themes'
import type { Choice } from './themes'

/** The key in the plugin's store that remembers the choice between sessions. Unset means the `theme` option (default auto). */
const STORE_KEY = 'theme'

const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

const reasonOf = (set: ThemeResult) => ('reason' in set ? String(set.reason) : '')

/** What one loaded copy of the module remembers. */
type State = {
  choice: Choice
  option: unknown
  languageOption: unknown
  lang: Lang
  t: Strings
  /** This session set a theme (so `off` has something of ours to clear). */
  isThemeSet: boolean
  /** The engine said nothing here draws themes (a terminal-only session). */
  isNothingDrawn: boolean
}

async function settleLanguage($: EngineInterface, s: State) {
  let setting: unknown
  try { setting = (await $.settings.read({ key: 'language' }) as { language?: unknown } | string | undefined) } catch { /* English */ }
  const value = typeof setting === 'object' && setting !== null ? (setting as { language?: unknown }).language : setting
  s.lang = chooseLanguage(s.languageOption, value)
  s.t = stringsFor(s.lang)
}

async function readChoice($: EngineInterface, s: State) {
  let saved: unknown
  try { saved = await $.store.get(STORE_KEY) } catch { /* the option or auto applies */ }
  s.choice = effectiveChoice(saved, s.option)
}

/** Remembers a choice; false when it could not be saved (the session still uses it). */
async function remember($: EngineInterface, choice: Choice): Promise<boolean> {
  try { await $.store.set(STORE_KEY, choice); return true } catch (err) {
    $.ui.log(`kit-themes: could not remember the choice: ${reason(err)}`, { to: 'debug' })
    return false
  }
}

/** Sets the theme for the current choice. Resolves false when the engine refused it (never throws). */
async function applyTheme($: EngineInterface, s: State): Promise<boolean> {
  if (s.choice === 'off') return true
  try {
    const { colors, problems } = colorsFor(s.choice)
    for (const line of unpainted(problems)) $.ui.log(`kit-themes: ${line}`, { to: 'debug' })
    const set: ThemeResult = await $.theme.set({ colors })
    s.isThemeSet = true
    s.isNothingDrawn = !set.isDrawn && set.requestId === undefined
    if (s.isNothingDrawn) $.ui.log(`kit-themes: theme not drawn: ${reasonOf(set)}`, { to: 'debug' })
    return true
  } catch (err) {
    // An older Claude Code refuses the theme: keep its own look, and never fail a hook.
    $.ui.log(`kit-themes: theme not set: ${reason(err)}`, { to: 'debug' })
    return false
  }
}

async function runCommand($: EngineInterface, s: State, args: string): Promise<string> {
  const t = s.t
  const word = args.trim()
  const status = word === '' || word.toLowerCase() === 'status'
  const wanted = status ? null : parseChoice(word)
  if (!status && wanted === null) return t.usage

  let tail = ''
  let isSaved = true
  let isOffPending = false
  if (wanted !== null) {
    s.choice = wanted
    isSaved = await remember($, wanted)
    if (!isSaved) tail += t.notSaved
    if (wanted === 'off') {
      if (s.isThemeSet) {
        try {
          await $.theme.clear()
          s.isThemeSet = false
        } catch (err) {
          $.ui.log(`kit-themes: could not clear the theme: ${reason(err)}`, { to: 'debug' })
          isOffPending = true
        }
      }
    } else if (!(await applyTheme($, s))) {
      tail += t.nextSession
    }
  }
  const { name, blurb } = describe(t, s.choice)
  const head = wanted === null ? t.isCurrent(s.choice, name, blurb)
    : isOffPending ? t.offPending
    : t.isNow(s.choice, name, blurb, isSaved)
  const drawn = s.isNothingDrawn
  return [head + tail, ...(drawn && s.choice !== 'off' ? [t.terminal] : []), ...(status ? [t.options] : [])].join(' ')
}

export const register: Register = (on, options) => {
  const s: State = {
    choice: 'auto', option: options?.theme, languageOption: options?.language,
    lang: 'en', t: stringsFor('en'), isThemeSet: false, isNothingDrawn: false,
  }

  on('session.start', async ($, e, next) => {
    try {
      await readChoice($, s)
      await settleLanguage($, s)
      try {
        await $.command.register({ name: 'themes', description: s.t.commandDescription, argumentHint: s.t.commandHint })
      } catch (err) { $.ui.log(`kit-themes: no /themes command: ${reason(err)}`, { to: 'debug' }) }
      if (s.choice !== 'off') await applyTheme($, s)
      else $.ui.log('kit-themes: off by choice; no theme set', { to: 'debug' })
    } catch (err) {
      $.ui.log(`kit-themes: session start skipped: ${reason(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'themes' }, async ($, e) => {
    try {
      return { text: await runCommand($, s, String(e.args ?? '')) }
    } catch (err) {
      $.ui.log(`kit-themes: command failed: ${reason(err)}`, { to: 'debug' })
      return { text: s.t.failed }
    }
  })
}

export { CHOICES }
