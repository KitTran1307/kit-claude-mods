// kit-statusbar: a Tokyo Night status band above the prompt, three rows:
//   repo · model · EFFORT · ctx bar %
//   account badge · account email · session title
//   5H bar % ↻ reset · WEEK bar % / budget% ↻ reset
// (budget = a share of the weekly limit per day, current day included; display only.)
// A failed hook (the transcript records each one) adds a warning at the end of row 1; pressing it toasts the details.
// Drawn on the desktop surface. In the terminal, `auto` steps aside for a status line the person already has and asks
// once (the answer is saved as `surfaces`) whether to show both; desktop+terminal always draws there. Every hook is guarded: a failed lookup is logged to debug, never thrown.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Info, Limit } from '../types'
import { accountLabel, baseName, colorIndexOf, placeOf } from './account'
import type { Place } from './account'
import { STATUS_LINE_ANSWERS, drawsOn, hasStatusLine, readConfig, statusLineFiles, surfacesForAnswer } from './config'
import type { Config } from './config'
import {
  ACCOUNT_COLORS, NO_LIMIT, T, bar, countdown, fitText, levelColor, paceColor, prettyEffort, prettyModel, toLimit, weekBudget,
} from './format'
import { TABLES, languageFromSetting } from './i18n'
import type { Lang, Strings } from './i18n'
import { NO_HOOK_ERRORS, readLoginEmail, readTranscript } from './transcript'
import type { Memo, NodeState } from './transcript'

const EMPTY: Info = {
  repo: '', model: '', effort: null, ctx: null, five: NO_LIMIT, week: NO_LIMIT,
  email: '', label: 'default', colorIndex: 0, title: '', hookErrors: NO_HOOK_ERRORS,
}
const TICK_MS = 60_000

const info = atom({ plugin: 'kit-statusbar', key: 'info' } as const, EMPTY)
const now = atom({ plugin: 'kit-statusbar', key: 'now' } as const, 0)
// Whether a status line is configured for the terminal (auto mode then leaves the terminal to it); null: not looked
// at yet (a fresh load, a /reload-plugins), and the terminal is left alone until it is.
const statusLine = atom({ plugin: 'kit-statusbar', key: 'statusLine' } as const, null as boolean | null)

// The band's language when `language` is auto: what the `language` setting said at session start; null: not looked at yet.
const lang = atom({ plugin: 'kit-statusbar', key: 'lang' } as const, null as Lang | null)
const TOAST_MS = 10_000

/** Reads the `language` setting of Claude Code once; a failed read is English. */
async function readLanguage($: EngineInterface): Promise<Lang> {
  try {
    return languageFromSetting(await $.settings.read({ key: 'language' }))
  } catch (err) {
    warn($, 'language setting not read', err)
    return 'en'
  }
}

/** The language to draw in: the option when it names one, else the one looked up at session start (looked up now if a reload skipped it). */
async function languageOf($: EngineInterface, cfg: Config): Promise<Lang> {
  if (cfg.language !== 'auto') return cfg.language
  const known = await read($, lang)
  return known === 'en' || known === 'vi' ? known : readLanguage($)
}

async function ensureLanguage($: EngineInterface, cfg: Config): Promise<void> {
  if (cfg.language !== 'auto' || (await read($, lang)) !== null) return
  const found = await readLanguage($)
  await update($, lang, () => found)
}

const warn = ($: EngineInterface, what: string, err: unknown): void => $.ui.log(`${what}: ${String(err)}`, { to: 'debug' })

// What the module remembers between hooks (a reload starts it over).
type Remembered = { memo: Memo | null; lastId: string; loginEmail: string | undefined; node: NodeState }

async function whereIsConfig($: EngineInterface): Promise<Place> {
  return placeOf(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'), await $.env.get('USERPROFILE'))
}

// Account label and color, the session title, the account email. Only while a surface the band draws on is attached.
/** Reads the user and project settings for a status line; a file that is missing or unreadable says no. */
async function detectStatusLine($: EngineInterface, cwd: string): Promise<boolean> {
  const place = await whereIsConfig($)
  for (const file of statusLineFiles(place.configDir, cwd)) {
    try {
      if (hasStatusLine(await $.fs.read(file))) return true
    } catch { /* missing or unreadable: no status line from this file */ }
  }
  return false
}

/** Looks the status line up once per load (auto mode only) and remembers it; returns what is known. */
async function ensureStatusLine($: EngineInterface, cfg: Config, cwd?: string): Promise<boolean | null> {
  if (cfg.surfaces !== 'auto') return null
  const known = await read($, statusLine)
  if (known !== null) return known
  const found = await detectStatusLine($, cwd ?? (await $.session.cwd()))
  await update($, statusLine, () => found)
  return found
}

/**
 * auto mode found a status line in an attached terminal: ask once whether the band should join it there. The answer
 * is written to the `surfaces` option, so it is never asked again; a dismissed dialog (or a -p run) keeps auto, which
 * leaves the terminal to the status line. Not awaited by the caller: the session starts without waiting for it.
 */
async function confirmBesideStatusLine($: EngineInterface, cfg: Config): Promise<void> {
  try {
    if (cfg.surfaces !== 'auto' || (await read($, statusLine)) !== true) return
    if (!(await $.session.surfaces()).includes('terminal')) return
    const t = TABLES[await languageOf($, cfg)]
    const answer = await $.ui.ask(t.statusLineQuestion, { options: STATUS_LINE_ANSWERS.map(a => t[a.key]), header: t.askHeader })
    const surfaces = surfacesForAnswer(answer)
    if (!surfaces) return
    const set = await $.config.set({ key: 'kit-statusbar.surfaces', value: surfaces })
    if (set.deny) warn($, 'could not save the surfaces answer', set.deny)
  } catch (err) {
    warn($, 'status line question skipped', err)
  }
}

async function refreshSession($: EngineInterface, cfg: Config, mem: Remembered): Promise<void> {
  try {
    const line = await read($, statusLine)
    if (!(await $.session.surfaces()).some(s => drawsOn(cfg, s, line))) return
    const place = await whereIsConfig($)
    const label = accountLabel(place.configDir)
    const id = await $.session.id()
    if (id !== mem.lastId) {
      mem.lastId = id
      mem.memo = null
      mem.loginEmail = undefined
      await update($, info, s => ({ ...s, title: '', hookErrors: NO_HOOK_ERRORS }))
    }

    let title = ''
    let email = ''
    let hooks = NO_HOOK_ERRORS
    if (cfg.showTitle || cfg.showEmail || cfg.showHookErrors) {
      const cwd = await $.session.cwd()
      const found = await readTranscript($, { configDir: place.configDir, id, cwd, maxMB: cfg.maxTranscriptMB }, mem.memo, mem.node)
      mem.memo = found.memo
      title = found.facts.title
      email = found.facts.email
      hooks = found.facts.hooks
    }
    if (cfg.showEmail && !email) {
      mem.loginEmail ??= await readLoginEmail($, place.loginFile, mem.node)
      email = mem.loginEmail
    }
    const hasTranscript = mem.memo !== null
    await update($, info, s => ({
      ...s,
      label,
      colorIndex: colorIndexOf(label),
      title: hasTranscript ? title : s.title,
      email: cfg.showEmail ? email : '',
      hookErrors: !cfg.showHookErrors ? NO_HOOK_ERRORS : hasTranscript ? hooks : (s.hookErrors ?? NO_HOOK_ERRORS),
    }))
  } catch (err) {
    warn($, 'session lookup failed', err)
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const mem: Remembered = { memo: null, lastId: '', loginEmail: undefined, node: { missing: false } }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const repo = await $.session.repo().catch(() => null)
      const usage = await $.session.usage().catch(() => null)
      const model = prettyModel(await $.session.model().catch(() => ''))
      await update($, info, s => ({
        ...s,
        repo: baseName(repo?.root ?? started.cwd) || 'no-repo',
        model,
        ctx: usage?.context.percent ?? null,
        five: toLimit(usage?.rateLimits ?? [], 'five_hour'),
        week: toLimit(usage?.rateLimits ?? [], 'seven_day'),
      }))
      if (cfg.language === 'auto') await update($, lang, () => null)
      await ensureLanguage($, cfg)
      if (cfg.surfaces === 'auto') {
        await update($, statusLine, () => null)
        await ensureStatusLine($, cfg, started.cwd)
        void confirmBesideStatusLine($, cfg)
      }
      const startMs = await $.clock.now()
      await update($, now, () => startMs)
      $.clock.every(TICK_MS, async () => {
        const t = await $.clock.now()
        await update($, now, () => t)
      })
    } catch (err) {
      warn($, 'session.start failed', err)
    }
    await refreshSession($, cfg, mem)
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    try { await ensureStatusLine($, cfg) } catch (err) { warn($, 'status line lookup failed', err) }
    try { await ensureLanguage($, cfg) } catch (err) { warn($, 'language lookup failed', err) }
    await refreshSession($, cfg, mem)
    return attached
  })

  on('session.measure', async ($, e, next) => {
    try {
      // No rate-limit reading in this measurement: keep the last one rather than blanking the bars.
      const hasLimits = e.rateLimits.length > 0
      await update($, info, s => ({
        ...s,
        ctx: e.context.percent ?? s.ctx,
        five: hasLimits ? toLimit(e.rateLimits, 'five_hour') : s.five,
        week: hasLimits ? toLimit(e.rateLimits, 'seven_day') : s.week,
      }))
      const measuredMs = await $.clock.now()
      await update($, now, () => measuredMs)
    } catch (err) {
      warn($, 'session.measure failed', err)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        // A step without effort is a model without one: the pill goes.
        const effort = prettyEffort(e.effort)
        await update($, info, s => ({ ...s, model: prettyModel(e.model), effort }))
      } catch (err) {
        warn($, 'turn.step failed', err)
      }
    }
    return yield* next(e)
  })

  // The automatic title appears after the first answer; a /rename any time.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      try { await ensureStatusLine($, cfg) } catch (err) { warn($, 'status line lookup failed', err) }
      try { await ensureLanguage($, cfg) } catch (err) { warn($, 'language lookup failed', err) }
      await refreshSession($, cfg, mem)
    }
    return done
  })

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked, so several bands show together. A part that passes hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let passed = false
    const pass = (x: typeof e) => { passed = true; return next(x) }
    const mine = await ownBand($, e, pass, cfg)
    if (passed) return mine
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const used = 3
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - used) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
}

async function ownBand($: EngineInterface, e: any, next: (x: any) => Promise<any>, cfg: Config) {
  {
    // A load that saw no session.start (a /reload-plugins) looks the status line up here, before the first draw.
    // Drawing cannot write state, so it only reads; the next attach or finished turn stores what it finds.
    let line = await read($, statusLine)
    if (line === null && e.surface === 'terminal' && cfg.surfaces === 'auto') {
      try { line = await detectStatusLine($, await $.session.cwd()) } catch (err) { warn($, 'status line lookup failed', err) }
    }
    if (!drawsOn(cfg, e.surface, line) || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const t: Strings = TABLES[await languageOf($, cfg)]
    const s = await read($, info)
    const nowMs = (await read($, now)) || (await $.clock.now())
    const acc = ACCOUNT_COLORS[s.colorIndex % ACCOUNT_COLORS.length] ?? T.orange

    const pill = (bg: string, fg: string, text: string) => (
      <Text backgroundColor={bg} color={fg} weight="bold" mono>{` ${text} `}</Text>
    )
    const meter = (pct: number | null, color: string) => {
      const { on: full, off } = bar(pct)
      return (
        <Box flexDirection="row">
          <Text color={color} mono>{full}</Text>
          <Text color={T.hl2} mono>{off}</Text>
          <Text color={color} weight="bold" mono tabular>{` ${pct == null ? '--' : `${pct}%`}`}</Text>
        </Box>
      )
    }
    const limit = (label: string, accent: string, l: Limit, withBudget: boolean) => {
      const cd = countdown(l.resetsAt, nowMs)
      const budget = withBudget ? weekBudget(l.resetsAt, nowMs, cfg.weeklyBudgetPerDay) : null
      return (
        <Box flexDirection="row" gap={1}>
          {pill(accent, T.dark, label)}
          {meter(l.pct, budget == null ? levelColor(l.pct, accent) : paceColor(l.pct, budget, accent, cfg.weeklyBudgetPerDay))}
          {budget == null ? null : <Text color={T.comment} mono tabular>{`/ ${budget}%`}</Text>}
          {cd ? <Text color={T.comment} mono>{`↻ ${cd}`}</Text> : null}
        </Box>
      )
    }

    const email = cfg.showEmail ? s.email : ''
    const account = s.label === 'default' ? t.defaultAccount : s.label
    // Whatever the badge and the email leave of the band's width is the title's; a longer one is cut short.
    const room = (e.props.bodyColumns ?? Infinity) - (account.length + 2) - (email ? email.length + 1 : 0) - 1
    const title = cfg.showTitle ? fitText(s.title, room) : ''
    // The limits row needs data: none (API key, a third-party provider) hides it.
    const showFive = cfg.showLimits && s.five.pct != null
    const showWeek = cfg.showLimits && s.week.pct != null
    const failed = cfg.showHookErrors ? s.hookErrors : undefined
    const lastFailure = failed && failed.count > 0 ? failed.last : null

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {pill(T.blue, T.dark, s.repo || t.noRepo)}
          {pill(T.hl2, T.cyan, s.model || t.modelFallback)}
          {s.effort ? pill(T.hl, T.magenta, s.effort) : null}
          <Text color={T.comment} mono>{t.context}</Text>
          {meter(s.ctx, levelColor(s.ctx, T.green))}
          {failed && failed.count > 0 ? (
            <Button key="hook-errors" onPress={() => { if (lastFailure) $.ui.toast(t.hookToast(lastFailure), { timeoutMs: TOAST_MS }) }}>
              <Text color={T.yellow} weight="bold" mono>{t.hookErrors(failed.count, lastFailure?.hook ?? '')}</Text>
            </Button>
          ) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {pill(acc, T.dark, account)}
          {email ? <Text color={acc} weight="bold" mono>{email}</Text> : null}
          {title ? <Text color={T.comment} italic mono wrap="truncate-end">{title}</Text> : null}
        </Box>
        {showFive || showWeek ? (
          <Box flexDirection="row" gap={2}>
            {showFive ? limit(t.fiveHour, T.teal, s.five, false) : null}
            {showWeek ? limit(t.week, T.yellow, s.week, true) : null}
          </Box>
        ) : null}
      </Box>
    )
  }
}
