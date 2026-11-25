// quota-coach: tells the person what is using their plan's limits and what to do about it.
//  - a one-line tip above the prompt when a saving is available (full context, cold cache, many subagents, a strong
//    model on light work), with a button where an engine call exists; it never acts by itself;
//  - a "why did the last turn cost this" card (/quota why, or the tip's Why? button);
//  - a pre-send estimate ("This turn ~3% of 5H") once a few turns have taught it the person's rate;
//  - a daily report (/quota report): by session, model and hour, from this plugin's own store and the local transcripts.
// No model calls, no network. Every hook is guarded: a failed lookup is logged to debug, never thrown.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Day, Facts, Report, TurnStat, Ui } from '../types'
import {
  KEEP_TURNS, NO_CALIBRATION_VALUE, activeTips, addTurn, cacheInfo, credit, estimateTurn, livePct, pickTip, rearm, stampOf, totalTokens, weighted, whyOf,
} from './calc'
import { bar, fmtLow, fmtPoints, fmtTokens, wholeMinutes } from './calc'
import type { Estimate, HighWater, Tip, TipFacts, Usage, Why } from './calc'
import type { Line } from './report'
import { readConfig } from './config'
import type { Config } from './config'
import { configDirOf, readTodayTranscripts } from './files'
import { TABLES, languageFromSetting } from './i18n'
import type { Lang, Strings } from './i18n'
import { prettyModel, tierLabel, tierOf } from './model'
import { addToDay, buildReport, dateOfKey, dayKey, dayStart, dayStoreKey, emptyDay, expiredKeys, mergeDays, reportLines, sanitizeDay } from './report'
import { C, reportPlain, tipText } from './view'
import type { TipHandlers, WhyHandlers, EstimateView } from './view'

type Els = ReturnType<EngineInterface['ui']['resolve']>

const PANE = 'quota-report'
const NOTICE_MS = 8000
const TICK_MS = 60_000

const EMPTY_FACTS: Facts = {
  ctxTokens: null, window: null, ctxPct: null, model: '', fivePct: null, fiveResetsAt: null, agents: 0, cache: null,
  calibration: NO_CALIBRATION_VALUE, recent: [], working: false,
}
const EMPTY_UI: Ui = { card: false, dismissed: [], draft: false, notice: '' }

// Change a tag when the fields of its value change: the engine declines what an earlier version stored.
const facts = atom({ plugin: 'quota-coach', key: 'facts' } as const, EMPTY_FACTS, { shape: 'facts-2' })
const ui = atom({ plugin: 'quota-coach', key: 'ui' } as const, EMPTY_UI, { shape: 'ui-1' })
const now = atom({ plugin: 'quota-coach', key: 'now' } as const, 0)
const lang = atom({ plugin: 'quota-coach', key: 'lang' } as const, null as Lang | null)
const report = atom({ plugin: 'quota-coach', key: 'report' } as const, null as Report | null, { shape: 'report-1' })
const reportDate = atom({ plugin: 'quota-coach', key: 'reportDate' } as const, '')

const warn = ($: EngineInterface, what: string, err: unknown): void => $.ui.log(`${what}: ${String(err)}`, { to: 'debug' })

async function readLanguage($: EngineInterface): Promise<Lang> {
  try {
    return languageFromSetting(await $.settings.read({ key: 'language' }))
  } catch (err) {
    warn($, 'language setting not read', err)
    return 'en'
  }
}

async function languageOf($: EngineInterface, cfg: Config): Promise<Lang> {
  if (cfg.language !== 'auto') return cfg.language
  const known = await read($, lang)
  return known === 'en' || known === 'vi' ? known : readLanguage($)
}

async function stringsOf($: EngineInterface, cfg: Config): Promise<Strings> {
  return TABLES[await languageOf($, cfg)]
}

/** What one turn adds up while it runs (a reload starts it over). */
type Turn = {
  open: boolean; basePct: number | null; baseResets: string | null; spent: number; tokens: number; steps: number; agents: Set<string>; model: string
}
type Remembered = { turn: Turn; gen: number; pruned: boolean }

const CLOSED: Turn = { open: false, basePct: null, baseResets: null, spent: 0, tokens: 0, steps: 0, agents: new Set(), model: '' }
const newTurn = (basePct: number | null, baseResets: string | null, model: string): Turn => ({ ...CLOSED, open: true, basePct, baseResets, model })

const tipFactsOf = (f: Facts, at: number, cfg: Config): TipFacts => ({
  ctxPct: f.ctxPct, ctxTokens: f.ctxTokens, window: f.window, model: f.model, agentsRunning: f.agents, cache: cacheInfo(f.cache, at),
  recent: f.recent, contextThreshold: cfg.contextTipPercent,
})

type Usage5 = Awaited<ReturnType<EngineInterface['session']['usage']>>

/** The facts as a usage reading says them. After a compaction or before the first response the context has no figure: it is unknown, not what it was. */
const withUsage = (f: Facts, usage: Usage5): Facts => {
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  return {
    ...f,
    ctxTokens: usage.context.tokens ?? null,
    window: usage.context.window,
    ctxPct: usage.context.percent ?? null,
    fivePct: five ? five.percentUsed : null,
    fiveResetsAt: five?.resetsAt ?? null,
  }
}

/** How many subagents are running; null when the engine cannot say. */
async function runningAgents($: EngineInterface): Promise<number | null> {
  try { return (await $.agent.list()).filter(a => a.status === 'running' && a.kind === 'local_agent').length } catch { return null }
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const count = await runningAgents($)
  if (count === null) return
  if ((await read($, facts)).agents !== count) await update($, facts, f => ({ ...f, agents: count }))
}

/** Reads what the engine knows now (context, the 5-hour window, running subagents, the model) into the facts. Every part is optional. */
async function refreshFacts($: EngineInterface): Promise<void> {
  let usage: Usage5 | null = null
  try { usage = await $.session.usage() } catch (err) { warn($, 'usage not read', err) }
  const agents = await runningAgents($)
  let model: string | null = null
  try { model = await $.session.model() } catch { /* keep the model */ }
  await update($, facts, f => ({ ...(usage ? withUsage(f, usage) : f), agents: agents ?? f.agents, model: model || f.model }))
}

/** A dismissal lasts while its tip keeps applying: once it stops, the dismissed list drops it. */
async function rearmTips($: EngineInterface, cfg: Config): Promise<void> {
  const f = await read($, facts)
  const at = (await $.clock.now()) || 0
  const active = activeTips(tipFactsOf(f, at, cfg))
  const u = await read($, ui)
  if (rearm(u.dismissed, active).length !== u.dismissed.length) await update($, ui, s => ({ ...s, dismissed: rearm(s.dismissed, active) }))
}

async function notice($: EngineInterface, text: string): Promise<void> {
  await update($, ui, s => ({ ...s, notice: text }))
  try {
    $.clock.after(NOTICE_MS, async () => {
      try { await update($, ui, s => (s.notice === text ? { ...s, notice: '' } : s)) } catch (err) { warn($, 'notice not cleared', err) }
    })
  } catch (err) { warn($, 'notice timer not started', err) }
}

async function compactNow($: EngineInterface, cfg: Config): Promise<void> {
  let t = TABLES.en
  try {
    t = await stringsOf($, cfg)
    const done = await $.session.compact()
    if (done.skip !== undefined) { await notice($, t.compactSkipped(done.skip)); return }
    // The engine reads the new size with the next response: until then it is unknown, and the old tip must not stay.
    const after = done.tokensAfter ?? null
    await update($, facts, f => ({ ...f, ctxTokens: after, ctxPct: after !== null && f.window ? Math.round((after / f.window) * 100) : null }))
    await notice($, t.compactDone)
  } catch (err) {
    warn($, 'compact failed', err)
    try { await notice($, t.compactFailed) } catch { /* nothing more to do */ }
  }
}

/** Types /model sonnet into the prompt, never sends it, and never writes over what the person already typed. */
async function fillSonnet($: EngineInterface, cfg: Config): Promise<void> {
  let t = TABLES.en
  try {
    t = await stringsOf($, cfg)
    const box = await $.prompt.read()
    if (box.text.trim()) { await notice($, t.fillBusy); return }
    // insert: if the person typed in the meantime, the command goes in beside it instead of over it.
    const filled = await $.prompt.fill({ text: '/model sonnet', mode: 'insert' })
    await notice($, filled.isFilled ? t.fillNotice : t.fillFailed)
  } catch (err) {
    warn($, 'prompt not filled', err)
    try { await notice($, t.fillFailed) } catch { /* nothing more to do */ }
  }
}

// ---------- the turn's books ----------
async function finishTurn($: EngineInterface, mem: Remembered, usage: Usage | undefined, cfg: Config): Promise<void> {
  const turn = mem.turn
  mem.turn = { ...turn, open: false }
  const at = await $.clock.now()
  if (usage) { turn.spent += weighted(usage); turn.tokens += totalTokens(usage) }
  await refreshFacts($)
  const after = await read($, facts)
  // The window the turn started in: when it is another window now, the totals start over; when the starting percentage is unknown the turn teaches nothing.
  const windowChanged = turn.baseResets !== null && after.fiveResetsAt !== null && turn.baseResets !== after.fiveResetsAt
  const measured = !windowChanged && turn.basePct !== null && after.fivePct !== null && after.fivePct >= turn.basePct ? after.fivePct - turn.basePct : 0
  const model = usage?.model || turn.model || after.model
  const stat: TurnStat = {
    steps: Math.max(1, turn.steps), output: usage?.output_tokens ?? 0, subagents: turn.agents.size, spent: turn.spent, tokens: turn.tokens, model, at, pct: measured,
  }
  await update($, facts, f => ({
    ...f,
    working: mem.turn.open,
    model: model || f.model,
    cache: stampOf(usage, at, f.cache),
    calibration: windowChanged ? NO_CALIBRATION_VALUE : turn.spent > 0 ? addTurn(f.calibration, turn.spent, turn.basePct, after.fivePct) : f.calibration,
    recent: turn.spent > 0 ? [...f.recent, stat].slice(-KEEP_TURNS) : f.recent,
  }))
  try { await recordDay($, mem, stat, windowChanged ? null : turn.basePct, after.fivePct, after.fiveResetsAt) } catch (err) { warn($, 'day not recorded', err) }
  await rearmTips($, cfg)
}

/**
 * The day's books, in this plugin's own store: the share of the 5-hour window each turn moved, by session, model and hour.
 * One record per session and day (two sessions never write one value); a window's high-water mark keeps two sessions
 * from both crediting the same rise.
 */
async function recordDay(
  $: EngineInterface, mem: Remembered, stat: TurnStat, base: number | null, after: number | null, resetsAt: string | null,
): Promise<void> {
  const id = await $.session.id().catch(() => '')
  if (!id || stat.tokens <= 0) return
  const tz = new Date(stat.at).getTimezoneOffset()
  const date = dayKey(stat.at, tz)
  const water = await $.store.get('highWater').catch(() => undefined) as HighWater | undefined
  const hw = water && typeof water.resetsAt === 'string' && typeof water.pct === 'number' ? water : null
  const credited = credit(base, after, resetsAt, hw)
  if (credited.hw && credited.hw !== hw) await $.store.set('highWater', credited.hw)
  const key = dayStoreKey(date, id)
  const day = sanitizeDay(await $.store.get(key)) ?? emptyDay()
  await $.store.set(key, addToDay(day, { id, title: '', tier: tierOf(stat.model), pct: credited.points, tokens: stat.tokens, at: stat.at, resetsAt }, tz))
  if (!mem.pruned) {
    mem.pruned = true
    for (const old of expiredKeys(await $.store.keys())) await $.store.delete(old)
  }
}

async function buildTodaysReport($: EngineInterface, cfg: Config): Promise<{ report: Report; date: string }> {
  const t = TABLES[await languageOf($, cfg)]
  const at = await $.clock.now()
  const tz = new Date(at).getTimezoneOffset()
  const key = dayKey(at, tz)
  let day: Day | undefined
  try {
    const days: Day[] = []
    for (const k of await $.store.keys()) {
      if (dateOfKey(k) !== key) continue
      const d = sanitizeDay(await $.store.get(k))
      if (d) days.push(d)
    }
    day = days.length ? mergeDays(days) : undefined
  } catch (err) { warn($, 'day store not read', err) }
  const place = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'), await $.env.get('USERPROFILE'))
  const from = dayStart(at, tz)
  // The next local midnight (a day with a clock change is 23 or 25 hours long).
  const next = dayStart(from + 36 * 3_600_000, new Date(from + 36 * 3_600_000).getTimezoneOffset())
  const uses = await readTodayTranscripts($, place, from, next, (what, err) => warn($, what, err)).catch(() => [])
  const label = (tier: ReturnType<typeof tierOf>, model: string): string => (tier === 'other' ? prettyModel(model) || t.untitled : tierLabel(tier))
  return { report: buildReport(day, uses, tz, label), date: key }
}

// ---------- the command ----------
async function runCommand($: EngineInterface, cfg: Config, args: string): Promise<{ text: string }> {
  const t = await stringsOf($, cfg)
  const word = args.trim().toLowerCase()
  if (word === 'why') {
    await refreshFacts($)
    await update($, ui, s => ({ ...s, card: true }))
    return { text: t.whyOpened }
  }
  if (word === 'report') {
    const built = await buildTodaysReport($, cfg)
    await update($, report, () => built.report)
    await update($, reportDate, () => built.date)
    try {
      const opened = await $.ui.open({ id: PANE, title: t.reportTitle })
      if (opened.isPlaced) return { text: t.reportPaneOpened }
      // Open but undrawn (a surface that seats none): close it so it does not appear later with an old report.
      await $.ui.close({ id: PANE })
    } catch (err) { warn($, 'report pane not opened', err) }
    return { text: reportPlain(reportLines(t, built.report, built.date)) }
  }
  return { text: t.commandUsage }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const mem: Remembered = { turn: CLOSED, gen: 0, pruned: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      mem.gen += 1
      const gen = mem.gen
      mem.turn = CLOSED
      await update($, facts, () => EMPTY_FACTS)
      await update($, ui, () => EMPTY_UI)
      await update($, lang, () => null)
      const found = cfg.language === 'auto' ? await readLanguage($) : null
      if (found) await update($, lang, () => found)
      await update($, now, () => 0)
      await refreshFacts($)
      const t = TABLES[await languageOf($, cfg)]
      try { await $.command.register({ name: 'quota', description: t.commandDescription, argumentHint: '[why|report]' }) } catch (err) { warn($, 'quota command not registered', err) }
      // The cache goes cold on its own, and the idle minutes grow: one tick a minute redraws the band.
      $.clock.every(TICK_MS, async () => {
        if (mem.gen !== gen) return
        try {
          const at = await $.clock.now()
          await update($, now, () => at)
          await refreshAgents($)
        } catch (err) { warn($, 'tick failed', err) }
      })
    } catch (err) {
      warn($, 'session.start failed', err)
    }
    return started
  })

  // A /clear or a resume ends the conversation without a new start in between: what was learnt about it goes with it.
  on('session.end', async ($, e, next) => {
    try {
      mem.turn = CLOSED
      await update($, facts, () => EMPTY_FACTS)
      await update($, ui, () => EMPTY_UI)
    } catch (err) {
      warn($, 'session.end failed', err)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      const five = e.rateLimits.find(r => r.kind === 'five_hour')
      const moved = e.changed.includes('context')
      await update($, facts, f => ({
        ...f,
        ctxTokens: moved ? (e.context.tokens ?? null) : f.ctxTokens,
        ctxPct: moved ? (e.context.percent ?? null) : f.ctxPct,
        window: e.context.window,
        fivePct: e.rateLimits.length > 0 ? (five ? five.percentUsed : null) : f.fivePct,
        fiveResetsAt: e.rateLimits.length > 0 ? (five?.resetsAt ?? null) : f.fiveResetsAt,
      }))
      await refreshAgents($)
      await rearmTips($, cfg)
    } catch (err) {
      warn($, 'session.measure failed', err)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    try {
      if (e.agentId === undefined) {
        if (!mem.turn.open) {
          const f = await read($, facts)
          mem.turn = newTurn(f.fivePct, f.fiveResetsAt, e.model)
          await update($, ui, s => ({ ...s, draft: false, notice: '' }))
        }
        mem.turn.steps += 1
        mem.turn.model = e.model
        await update($, facts, f => ({ ...f, working: true, model: e.model }))
      } else {
        if (mem.turn.open) mem.turn.agents.add(e.agentId)
        await refreshAgents($)
      }
    } catch (err) {
      warn($, 'turn.step failed', err)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      const usage = e.usage as Usage | undefined
      if (e.agentId !== undefined) {
        if (mem.turn.open && usage) { mem.turn.spent += weighted(usage); mem.turn.tokens += totalTokens(usage) }
        await refreshAgents($)
      } else if (mem.turn.open) {
        await finishTurn($, mem, usage, cfg)
      }
    } catch (err) {
      warn($, 'turn.complete failed', err)
    }
    return done
  })

  // Typing and pasting are edits (prompt.edit); history, a clear, an undo and another plugin's fill are changes (prompt.change).
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await noteDraft($, typeof box?.text === 'string' ? box.text : e.text)
    return box
  })
  on('prompt.change', async ($, e, next) => {
    await noteDraft($, e.text)
    return next(e)
  })

  on('command.run', { command: 'quota' }, async ($, e) => {
    try {
      return await runCommand($, cfg, String(e.args ?? ''))
    } catch (err) {
      warn($, 'quota command failed', err)
      try { return { text: (await stringsOf($, cfg)).commandUsage } } catch { return { text: TABLES.en.commandUsage } }
    }
  })

  // The band above the prompt is one site shared by every plugin: draw this plugin's rows, then the rows of the
  // plugins beneath it, stacked. With nothing to say this plugin hands the site on untouched.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    let own: { rows: RenderChildren[]; lines: number } = { rows: [], lines: 0 }
    try { own = await ownRows($, e, cfg, e.props.maxRows) } catch (err) { warn($, 'band not drawn', err) }
    if (own.rows.length === 0) return next(e)
    const { Box } = $.ui.resolve(e)
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - own.lines) } })
    return <Box flexDirection="column">{own.rows}{rest}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const t = await stringsOf($, cfg)
    const r = await read($, report)
    const date = await read($, reportDate)
    const lines = r ? reportLines(t, r, date) : [{ kind: 'note' as const, text: t.reportEmpty }]
    return reportView(els, lines, () => { void $.ui.close({ id: PANE }).catch(err => warn($, 'pane not closed', err)) }, t.btnClose)
  })
}

/** Whether the prompt holds typed text: the estimate is for the message about to be sent. */
async function noteDraft($: EngineInterface, text: string): Promise<void> {
  try {
    const typing = text.trim().length > 0
    if ((await read($, ui)).draft !== typing) await update($, ui, s => ({ ...s, draft: typing }))
  } catch (err) {
    warn($, 'draft not noted', err)
  }
}

/** Runs a press handler without letting a failure escape: it is logged to debug. */
const guarded = ($: EngineInterface, what: string, fn: () => Promise<unknown>) => (): void => {
  void fn().catch(err => warn($, what, err))
}

async function ownRows($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], cfg: Config, maxRows: number): Promise<{ rows: RenderChildren[]; lines: number }> {
  const els = $.ui.resolve(e)
  const t = await stringsOf($, cfg)
  const f = await read($, facts)
  const u = await read($, ui)
  const at = (await read($, now)) || (await $.clock.now())
  const tf = tipFactsOf(f, at, cfg)
  const rows: RenderChildren[] = []
  let lines = 0
  if (u.card) {
    const last = f.recent.length ? (f.recent[f.recent.length - 1] ?? null) : null
    // A short band drops the card's explanations and keeps the facts and the buttons.
    const card = whyCard(els, t, whyOf(tf, f.calibration, last), f.fivePct !== null, maxRows < 14, {
      onCompact: guarded($, 'compact press failed', () => compactNow($, cfg)),
      onSonnet: guarded($, 'fill press failed', () => fillSonnet($, cfg)),
      onClose: guarded($, 'close press failed', () => update($, ui, s => ({ ...s, card: false }))),
    })
    rows.push(card.node)
    lines += card.lines
  } else if (cfg.tips) {
    // While a turn runs only the subagent tip is useful (compacting or switching waits for the turn to end).
    const tip: Tip | null = pickTip(activeTips(tf).filter(x => !f.working || x.kind === 'agents'), u.dismissed)
    if (tip) {
      rows.push(tipRow(els, t, tip, f.model, {
        onAction: f.working ? null : tip.kind === 'context' || tip.kind === 'cache' ? guarded($, 'compact press failed', () => compactNow($, cfg)) : tip.kind === 'model' ? guarded($, 'fill press failed', () => fillSonnet($, cfg)) : null,
        actionLabel: tip.kind === 'model' ? t.btnSonnet : t.btnCompact,
        onWhy: guarded($, 'why press failed', () => update($, ui, s => ({ ...s, card: true }))),
        onDismiss: guarded($, 'dismiss press failed', () => update($, ui, s => ({ ...s, dismissed: s.dismissed.includes(tip.kind) ? s.dismissed : [...s.dismissed, tip.kind] }))),
      }))
      lines += 1
    }
  }
  if (u.notice) { rows.push(noticeRow(els, u.notice)); lines += 1 }
  const five = livePct(f.fivePct, f.fiveResetsAt, at)
  if (cfg.estimate && u.draft && !f.working && five !== null) {
    const est = estimateTurn(f.calibration, f.ctxTokens, f.recent, cacheInfo(f.cache, at).state, f.model)
    if (est && f.ctxTokens !== null) {
      rows.push(estimateRow(els, t, { est, fivePct: five, model: f.model, ctxTokens: f.ctxTokens, cold: cacheInfo(f.cache, at).state === 'cold' }))
      lines += 2
    }
  }
  return { rows, lines }
}

// ---------- the trees ----------
function tipRow(els: Els, t: Strings, tip: Tip, model: string, act: TipHandlers) {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={C.orange} weight="bold" mono>✦</Text>
      <Text color={C.fg} mono wrap="truncate-end">{tipText(t, tip, model)}</Text>
      {act.onAction ? <Button key="tip-action" onPress={act.onAction}><Text color={C.green} weight="bold" mono>{`[ ${act.actionLabel} ]`}</Text></Button> : null}
      <Button key="tip-why" onPress={act.onWhy}><Text color={C.cyan} mono>{`[ ${t.btnWhy} ]`}</Text></Button>
      <Button key="tip-dismiss" onPress={act.onDismiss}><Text color={C.comment} mono>[ × ]</Text></Button>
    </Box>
  )
}

/** The card: the cost of the last turn, then one row per cause with a short reason, then the actions. */
function whyCard(els: Els, t: Strings, w: Why, hasWindow: boolean, compact: boolean, act: WhyHandlers): { node: RenderChildren; lines: number } {
  const { Box, Text, Button } = els
  const model = prettyModel(w.model) || '?'
  const turnRow = w.lastTurn ? [{ name: t.rowTurn, value: t.turnValue(w.lastTurn.steps, fmtTokens(w.lastTurn.tokens)), note: '', hot: false }] : []
  const all: Array<{ name: string; value: string; note: string; hot: boolean }> = [
    {
      name: t.rowContext,
      value: w.ctxTokens !== null && w.window !== null ? t.contextValue(fmtTokens(w.ctxTokens), fmtTokens(w.window), String(Math.round(w.ctxPct ?? 0))) : t.contextUnknown,
      note: w.ctxTokens !== null ? t.contextNote(fmtTokens(w.ctxTokens)) : '',
      hot: (w.ctxPct ?? 0) >= 70,
    },
    { name: t.rowModel, value: model, note: w.timesSonnet > 1.2 ? t.modelNote(Math.round(w.timesSonnet * 10) / 10) : t.modelNoteCheap, hot: w.timesSonnet > 1.2 },
    { name: t.rowAgents, value: t.agentsValue(w.agentsRunning, w.agentsLastTurn), note: w.agentsRunning + w.agentsLastTurn > 0 ? t.agentsNote : '', hot: w.agentsRunning >= 3 },
    {
      name: t.rowCache,
      value: w.cache.state === 'warm' ? t.cacheWarm(Math.max(1, wholeMinutes(w.cache.leftMs))) : w.cache.state === 'cold' ? t.cacheCold(wholeMinutes(w.cache.idleMs)) : t.cacheUnknown,
      note: w.cache.state === 'warm' ? t.cacheNoteWarm : w.cache.state === 'cold' ? t.cacheNoteCold : '',
      hot: w.cache.state === 'cold',
    },
    ...turnRow,
  ]
  const rows = compact ? all.map(r => ({ ...r, note: '' })) : all
  const lines = 2 + (hasWindow ? 0 : 1) + rows.reduce((n, r) => n + (r.note ? 2 : 1), 0)
  const cost = t.whyCost(w.lastTurnPct === null ? null : fmtPoints(w.lastTurnPct), w.avgTurnPct === null ? null : fmtPoints(w.avgTurnPct))
  const node = (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={C.orange} weight="bold" mono>✦</Text>
        <Text color={C.fg} weight="bold" mono>{t.whyTitle}</Text>
        <Text color={C.yellow} weight="bold" mono>{cost}</Text>
      </Box>
      {hasWindow ? null : <Text color={C.comment} mono>{`  ${t.whyUnknown}`}</Text>}
      {rows.map(r => (
        <Box key={r.name} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={r.hot ? C.red : C.green} mono>●</Text>
            <Text color={C.comment} mono>{r.name.padEnd(10)}</Text>
            <Text color={C.fg} weight="bold" mono>{r.value}</Text>
          </Box>
          {r.note ? <Text color={C.comment} mono>{`    ${r.note}`}</Text> : null}
        </Box>
      ))}
      <Box flexDirection="row" gap={1}>
        {w.savePct > 0 ? <Button key="why-compact" onPress={act.onCompact}><Text color={C.green} weight="bold" mono>{`[ ${t.btnCompactSave(w.savePct)} ]`}</Text></Button> : null}
        {w.canSwitch ? <Button key="why-sonnet" onPress={act.onSonnet}><Text color={C.cyan} mono>{`[ ${t.btnSonnet} ]`}</Text></Button> : null}
        <Button key="why-close" onPress={act.onClose}><Text color={C.comment} mono>{`[ ${t.btnClose} ]`}</Text></Button>
      </Box>
    </Box>
  )
  return { node, lines }
}

/** The pre-send estimate: the range, the bar before and after, and what it was worked out from. */
function estimateRow(els: Els, t: Strings, v: EstimateView) {
  const { Box, Text } = els
  const after = Math.min(100, v.fivePct + v.est.mid)
  const { on, off } = bar(after, 100, 8)
  const extra = v.cold && v.est.coldExtra >= 0.5 ? fmtPoints(v.est.coldExtra) : null
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={C.yellow} weight="bold" mono>≈</Text>
        <Text color={C.fg} weight="bold" mono>{t.estimate(fmtPoints(v.est.mid), fmtLow(v.est.low), fmtPoints(v.est.high))}</Text>
        <Text color={C.teal} mono>{on}</Text>
        <Text color={C.hl2} mono>{off}</Text>
        <Text color={C.comment} mono tabular>{`${Math.round(v.fivePct)}% → ${Math.round(after)}%`}</Text>
      </Box>
      <Text color={C.comment} mono>{`  ${t.estimateTail(prettyModel(v.model) || tierLabel(tierOf(v.model)), fmtTokens(v.ctxTokens), extra)}`}</Text>
    </Box>
  )
}

function noticeRow(els: Els, text: string) {
  const { Text } = els
  return <Text color={C.green} mono>{`✦ ${text}`}</Text>
}

/** The report in a pane: one Text per line, the bars coloured. */
function reportView(els: Els, lines: readonly Line[], onClose: (() => void) | null, closeLabel: string) {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => {
        if (l.kind === 'blank') return <Text key={String(i)}> </Text>
        if (l.kind === 'row') {
          return (
            <Box key={String(i)} flexDirection="row">
              <Text color={C.fg} mono>{l.label ?? ''}</Text>
              {l.tag ? <Text color={C.cyan} mono>{` ${l.tag}`}</Text> : null}
              {l.bar ? <Text color={C.teal} mono>{` ${l.bar.on}`}</Text> : null}
              {l.bar ? <Text color={C.hl2} mono>{l.bar.off}</Text> : null}
              <Text color={C.yellow} weight="bold" mono>{` ${l.value ?? ''}`}</Text>
            </Box>
          )
        }
        const color = l.kind === 'title' ? C.fg : l.kind === 'head' ? C.blue : l.kind === 'tip' ? C.orange : C.comment
        return <Text key={String(i)} color={color} weight={l.kind === 'title' || l.kind === 'head' ? 'bold' : undefined} mono>{l.text}</Text>
      })}
      {onClose ? <Button key="report-close" onPress={onClose}><Text color={C.comment} mono>{`[ ${closeLabel} ]`}</Text></Button> : null}
    </Box>
  )
}
