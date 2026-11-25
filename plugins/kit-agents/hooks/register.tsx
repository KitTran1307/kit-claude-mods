import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Board, BoardAgent } from '../types'
import {
  anyLongRunning, barCells, boardAgents, compactText, contextBar, countLevels, countWaiting, elapsedOf, formatLine, listLine, maxCardsFrom,
  metaText, paletteFor, planBoard, planRows,
} from './data'
import type { BoardPlan, Line, Palette } from './data'
import { languageFromSetting, languageOption, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'

const PANE = 'kit-agents'
const COMMAND = 'board'
const TICK_MS = 1_000 // how often the board redraws (running time moves) while a subagent runs
const PANE_ROWS = 1_000 // the pane scrolls, so it is planned with all the rows it can need

const board = atom({ plugin: 'kit-agents', key: 'board' } as const, null as Board | null, { shape: 'board-1' })

/** The options, read once per load (a change in /config reloads the module with new ones). */
type Config = { showBand: boolean; usePane: boolean; maxCards: number; language: 'auto' | Lang }

/**
 * `lang` and `t` are the words in use (session.start settles them; English until then). `surface` is where the session
 * draws. `timerOn` and `gen` say whether the one-second timer runs (a stale timer of an older generation does nothing),
 * `paneOpen` that this plugin opened its pane and `paneDeclined` that the person closed it by hand.
 */
type Ctx = {
  cfg: Config; lang: Lang; t: Strings; surface: string | null
  timer?: { cancel?: () => void } | null; timerOn: boolean; gen: number; starting: boolean; busy: boolean
  paneOpen: boolean; paneDeclined: boolean
  /** When the board first saw each agent that has no start time of its own (id to epoch ms), for the pane's delay. */
  firstSeen: Record<string, number>
}

function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return { showBand: o.showBand !== false, usePane: o.usePane !== false, maxCards: maxCardsFrom(o.maxCards), language: languageOption(o.language) }
}

const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

/** The words in use: the `language` option, or for `auto` Claude Code's own `language` setting (read once; English when it cannot be). */
async function settleLanguage($: EngineInterface, ctx: Ctx) {
  let lang: Lang = ctx.cfg.language === 'auto' ? 'en' : ctx.cfg.language
  if (ctx.cfg.language === 'auto') {
    try { lang = languageFromSetting(await $.settings.read({ key: 'language' })) } catch { /* English */ }
  }
  ctx.lang = lang
  ctx.t = stringsFor(lang)
}

async function toast($: EngineInterface, text: string) {
  try { await $.ui.toast(text) } catch { /* nothing to tell it with */ }
}

// --- refreshing ------------------------------------------------------------------------------------------------

/**
 * Opens the pane once a subagent has run for PANE_AFTER_MS (terminal only, once) and closes it when they are done. A short
 * job never opens it, so the layout does not jump for nothing; the band shows the board meanwhile. Never throws.
 */
async function syncPane($: EngineInterface, ctx: Ctx, agents: BoardAgent[], now: number) {
  if (ctx.surface !== 'terminal' || !ctx.cfg.usePane) return
  if (agents.length > 0) {
    if (ctx.paneOpen || ctx.paneDeclined || !anyLongRunning(agents, now, ctx.firstSeen)) return
    ctx.paneOpen = true
    try { await $.ui.open({ id: PANE, title: ctx.t.paneTitle }) } catch { ctx.paneOpen = false; ctx.paneDeclined = true }
    return
  }
  ctx.paneDeclined = false
  if (!ctx.paneOpen) return
  ctx.paneOpen = false
  try { await $.ui.close({ id: PANE }) } catch { /* already gone */ }
}

function stopTimer(ctx: Ctx) {
  ctx.timerOn = false
  ctx.gen += 1
  try { if (typeof ctx.timer?.cancel === 'function') ctx.timer.cancel() } catch { /* the generation check stops it */ }
  ctx.timer = null
}

/**
 * Reads the agent list into the board, keeps the pane in step, and starts the one-second timer while at least one
 * subagent runs and stops it when none does. Returns how many run, or -1 when the list cannot be read. Never throws.
 */
async function refresh($: EngineInterface, ctx: Ctx): Promise<number> {
  try {
    const agents = boardAgents(await $.agent.list())
    const now = await $.clock.now()
    const before = await read($, board)
    const seen: Record<string, number> = {}
    for (const a of agents) seen[a.id] = ctx.firstSeen[a.id] ?? now
    ctx.firstSeen = seen
    // Nothing running and nothing shown: no write, so no redraw.
    if (agents.length > 0 || (before?.agents.length ?? 0) > 0) await update($, board, () => ({ agents, at: now }))
    await syncPane($, ctx, agents, now)
    if (agents.length === 0) {
      if (ctx.timerOn) stopTimer(ctx)
    } else if (!ctx.timerOn && !ctx.starting) {
      ctx.starting = true
      try {
        const gen = ctx.gen + 1
        ctx.gen = gen
        ctx.timerOn = true
        const handle = (await $.clock.every(TICK_MS, () => {
          if (gen !== ctx.gen || !ctx.timerOn || ctx.busy) return
          ctx.busy = true
          refresh($, ctx).then(n => { if (n < 0 && gen === ctx.gen) stopTimer(ctx) }, () => undefined).finally(() => { ctx.busy = false })
        })) as Ctx['timer']
        // stopTimer ran while the timer was being made: this handle belongs to a generation that is gone.
        if (gen === ctx.gen) ctx.timer = handle
        else try { if (typeof handle?.cancel === 'function') handle.cancel() } catch { /* the generation check stops it */ }
      } catch {
        stopTimer(ctx) // no timer here: the board still redraws at each agent event
      } finally {
        ctx.starting = false
      }
    }
    return agents.length
  } catch {
    // The list cannot be read: do not leave the last board standing as if it were current.
    if (ctx.timerOn) stopTimer(ctx)
    try {
      if (((await read($, board))?.agents.length ?? 0) > 0) {
        const now = await $.clock.now().catch(() => 0)
        await update($, board, () => ({ agents: [], at: now }))
        await syncPane($, ctx, [], now)
      }
    } catch { /* nothing more to clear */ }
    return -1
  }
}

/** Looks again at once and shortly after: an agent is in the list a moment after its spawn is heard. Never throws. */
function refreshSoon($: EngineInterface, ctx: Ctx) {
  void refresh($, ctx)
  for (const ms of [400, 2_000]) {
    try { $.clock.after(ms, () => { void refresh($, ctx) }) } catch { /* the timer's own refresh covers it */ }
  }
}

/** The Reply button: the agent's conversation in the main view. Works only for the person's own press; says so when it cannot. */
async function openAgent($: EngineInterface, ctx: Ctx, id: string) {
  try {
    const shown = await $.ui.view({ agentId: id })
    if (shown?.deny) await toast($, ctx.t.openDenied(String(shown.deny)))
  } catch {
    await toast($, ctx.t.openUnavailable)
  }
}

// --- drawing ---------------------------------------------------------------------------------------------------

const dotOf = (a: BoardAgent) => (a.state === 'waiting' ? '◆' : '●')

function replyButton($: EngineInterface, ctx: Ctx, ui: any, a: BoardAgent) {
  const { Button } = ui
  return <Button key={`reply-${a.id}`} variant="primary" label={ctx.t.buttons.reply} onPress={() => openAgent($, ctx, a.id)} />
}

/** One whole card: name and running time, state and model, task, context bar, and for an agent that waits, Reply. */
function card($: EngineInterface, ctx: Ctx, ui: any, a: BoardAgent, now: number, pal: Palette, cells: number) {
  const { Box, Text } = ui
  const t = ctx.t
  const waiting = a.state === 'waiting'
  const color = pal[a.state]
  const meta = metaText(a, t)
  const elapsed = elapsedOf(a, now)
  return (
    <Box key={`card-${a.id}`} flexDirection="column" borderStyle="round" borderColor={waiting ? pal.waiting : pal.border} paddingX={1}>
      <Box flexDirection="row" columnGap={1} justifyContent="space-between">
        <Box flexShrink={1}><Text wrap="truncate-end"><Text color={color}>{dotOf(a)} </Text><Text bold>{a.name}</Text></Text></Box>
        {elapsed ? <Text dimColor>{elapsed}</Text> : null}
      </Box>
      <Text wrap="truncate-end"><Text color={color} bold={waiting}>{meta.state}</Text><Text dimColor>{meta.rest}</Text></Text>
      {a.label ? <Text wrap="truncate-end">{a.label}</Text> : null}
      {a.pct !== undefined
        ? <Text wrap="truncate-end"><Text dimColor>{t.ctx} </Text><Text color={a.pct >= 90 ? pal.warn : color}>{contextBar(a.pct, cells)}</Text><Text> {a.pct}%</Text></Text>
        : null}
      {waiting
        ? (
          <Box flexDirection="row" columnGap={1}>
            {replyButton($, ctx, ui, a)}
            <Box flexShrink={1}><Text dimColor wrap="truncate-end">{t.replyHint}</Text></Box>
          </Box>
        )
        : null}
    </Box>
  )
}

/** One agent on one line; the one that waits keeps its Reply button. */
function compactRow($: EngineInterface, ctx: Ctx, ui: any, a: BoardAgent, now: number, pal: Palette) {
  const { Box, Text } = ui
  const line = (
    <Text wrap="truncate-end"><Text color={pal[a.state]}>{dotOf(a)} </Text><Text bold>{a.name}</Text><Text dimColor> {compactText(a, now, ctx.t)}</Text></Text>
  )
  if (a.state !== 'waiting') return <Box key={`row-${a.id}`}>{line}</Box>
  return (
    <Box key={`row-${a.id}`} flexDirection="row" columnGap={1}>
      <Box flexShrink={1}>{line}</Box>
      {replyButton($, ctx, ui, a)}
    </Box>
  )
}

function header(ctx: Ctx, ui: any, pal: Palette, agents: BoardAgent[]) {
  const { Text } = ui
  return (
    <Text wrap="truncate-end"><Text color={pal.accent}>✻</Text> <Text bold>{ctx.t.title}</Text> <Text dimColor>{ctx.t.count(agents.length, countWaiting(agents))}</Text></Text>
  )
}

/** The board for a plan: header, whole cards, one-line agents, "+N more". */
function boardNode($: EngineInterface, ctx: Ctx, ui: any, agents: BoardAgent[], plan: BoardPlan, now: number, surface: unknown, columns: number) {
  const { Box, Text } = ui
  const pal = paletteFor(surface)
  if (plan.mode === 'none') return <Box />
  if (plan.mode === 'line') {
    const waiting = agents.find(a => a.state === 'waiting')
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}>{header(ctx, ui, pal, agents)}</Box>
        {waiting ? replyButton($, ctx, ui, waiting) : null}
      </Box>
    )
  }
  const cells = barCells(columns)
  const listed = agents.slice(0, plan.full + plan.compact)
  return (
    <Box flexDirection="column">
      {header(ctx, ui, pal, agents)}
      {listed.slice(0, plan.full).map(a => card($, ctx, ui, a, now, pal, cells))}
      {listed.slice(plan.full).map(a => compactRow($, ctx, ui, a, now, pal))}
      {plan.hidden > 0 ? <Text dimColor>{ctx.t.more(plan.hidden)}</Text> : null}
    </Box>
  )
}

/** Whether this plugin's pane is drawn right now (terminal only): the band steps aside for it. */
async function paneDrawn($: EngineInterface, ctx: Ctx, surface: unknown): Promise<boolean> {
  if (surface !== 'terminal' || !ctx.cfg.usePane) return false
  try { return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced) } catch { return false }
}

// Rows the last drawn band took, for the bands of the plugins beneath (set by renderBand, read right after it).
let bandRows = 0

async function renderBand($: EngineInterface, ctx: Ctx, e: any, next: any): Promise<any> {
  bandRows = 0
  if (!ctx.cfg.showBand || e.props.hasSurvey) return next(e)
  const agents = (await read($, board))?.agents ?? []
  if (agents.length === 0) return next(e)
  if (await paneDrawn($, ctx, e.surface)) return next(e)
  const now = await $.clock.now()
  const rows: number = e.props.maxRows ?? 40
  const columns: number = e.props.bodyColumns ?? 80
  const plan = planBoard(rows, agents, ctx.cfg.maxCards)
  bandRows = planRows(plan)
  return boardNode($, ctx, $.ui.resolve(e), agents, plan, now, e.surface, columns)
}

async function renderPane($: EngineInterface, ctx: Ctx, e: any) {
  const ui = $.ui.resolve(e)
  const { Box, Text } = ui
  const agents = (await read($, board))?.agents ?? []
  if (agents.length === 0) return <Box><Text dimColor>{ctx.t.paneEmpty}</Text></Box>
  const now = await $.clock.now()
  // A widget (a small desktop seat) is a glance; a docked or inline pane scrolls, so it gets every row it needs.
  const rows = e.props.placement === 'widget' ? 1 : PANE_ROWS
  const plan = planBoard(rows, agents, ctx.cfg.maxCards)
  return boardNode($, ctx, ui, agents, plan, now, e.surface, e.props.bodyColumns ?? 80)
}

// --- /board ----------------------------------------------------------------------------------------------------

async function doctor($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const d = ctx.t.doctor
  const lines: Line[] = []
  const check = async (name: string, run: () => Promise<Line | Line[]>) => {
    try { lines.push(...[await run()].flat()) } catch (err) {
      lines.push({ level: 'WARN', name, detail: reason(err), fix: d.checkFailedFix })
    }
  }

  await check('claude-code', async () => {
    let v: string | undefined
    try {
      const got = await $.session.version()
      v = String(got?.base ?? got?.version ?? '') || undefined
    } catch { /* unknown */ }
    return v
      ? { level: 'PASS', name: 'claude-code', detail: d.versionOk(v) }
      : { level: 'WARN', name: 'claude-code', detail: d.versionUnknown, fix: d.versionUnknownFix }
  })

  await check('agent-list', async () => {
    let list: unknown
    try { list = await $.agent.list() } catch { list = undefined }
    if (!Array.isArray(list)) return { level: 'WARN', name: 'agent-list', detail: d.listMissing, fix: d.listMissingFix }
    return { level: 'PASS', name: 'agent-list', detail: d.listOk(list.length, boardAgents(list).length) }
  })

  await check('limits', async () => {
    const limits = await $.agent.limits()
    return { level: 'PASS', name: 'limits', detail: d.limitsOk(Number(limits.concurrent) || 0, limits.isBackgroundEnabled === true) }
  })

  await check('surface', async () => ({
    level: 'PASS', name: 'surface', detail: ctx.surface ? d.surfaceIs(ctx.surface) : d.surfaceUnknown,
  }))

  await check('pane', async () => {
    if (ctx.surface !== 'terminal' || !ctx.cfg.usePane) return { level: 'PASS', name: 'pane', detail: d.paneNotUsed }
    const mine = (await $.ui.panes()).find(p => p.id === PANE)
    return { level: 'PASS', name: 'pane', detail: mine ? d.paneOpen(mine.isPlaced) : d.paneNone }
  })

  await check('settings', async () => {
    const off = [...(ctx.cfg.showBand ? [] : ['showBand']), ...(ctx.cfg.usePane ? [] : ['usePane'])]
    return off.length
      ? { level: 'WARN', name: 'settings', detail: d.settingsOff(off.join(', ')), fix: d.settingsOffFix }
      : { level: 'PASS', name: 'settings', detail: d.settingsAllOn }
  })

  await check('max-cards', async () => ({ level: 'PASS', name: 'max-cards', detail: d.maxCardsIs(ctx.cfg.maxCards) }))

  await check('language', async () => ({
    level: 'PASS', name: 'language', detail: d.languageIs(ctx.lang === 'vi' ? 'Tiếng Việt' : 'English', ctx.cfg.language),
  }))

  const n = countLevels(lines)
  return [...lines.map(formatLine), d.summary(n.pass, n.warn, n.fail)]
}

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<{ text: string }> {
  const t = ctx.t
  const verb = args.toLowerCase()
  if (verb === 'doctor') return { text: (await doctor($, ctx)).join('\n') }
  if (verb === 'pane') {
    if (!ctx.cfg.usePane) return { text: t.paneOff }
    if (ctx.surface !== 'terminal') return { text: t.paneNotHere }
    if ((await refresh($, ctx)) <= 0) return { text: t.paneNone }
    ctx.paneDeclined = false
    try {
      const opened = await $.ui.open({ id: PANE, title: t.paneTitle })
      ctx.paneOpen = true
      return { text: opened.isPlaced ? t.paneOpened : t.paneWaits(opened.reason) }
    } catch {
      return { text: t.paneFailed }
    }
  }
  if (verb) return { text: t.usage }
  let listed: unknown
  try { listed = await $.agent.list() } catch { return { text: t.listUnknown } }
  if (!Array.isArray(listed)) return { text: t.listUnknown }
  const agents = boardAgents(listed)
  await refresh($, ctx)
  if (agents.length === 0) return { text: t.listEmpty }
  const now = await $.clock.now()
  return { text: [t.listHeader(agents.length, countWaiting(agents)), ...agents.map((a, i) => listLine(a, i, now, t))].join('\n') }
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    cfg: readConfig(options), lang: 'en', t: stringsFor('en'), surface: null,
    timer: null, timerOn: false, gen: 0, starting: false, busy: false, paneOpen: false, paneDeclined: false, firstSeen: {},
  }

  on('session.start', async ($, e, next) => {
    // The board never blocks a session from starting.
    try { ctx.surface = e.surface ?? null } catch { /* unknown: the band is used */ }
    try { await settleLanguage($, ctx) } catch { /* English */ }
    try {
      await $.command.register({ name: COMMAND, description: ctx.t.commandDescription, argumentHint: ctx.t.commandHint })
    } catch { /* no command, the board still works */ }
    await refresh($, ctx)
    return next(e)
  })

  // A subagent shows up in the agent list a moment after its spawn is heard: look then, and start the timer.
  on('agent.spawn', async ($, e, next) => {
    refreshSoon($, ctx)
    const out = await next(e)
    void refresh($, ctx)
    return out
  })
  on('agent.report', async ($, e, next) => {
    const out = await next(e)
    refreshSoon($, ctx)
    return out
  })
  on('turn.complete', async ($, e, next) => {
    void refresh($, ctx)
    return next(e)
  })

  // The person closing the pane by hand keeps it closed until the subagents are done.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin?.kind === 'person') { ctx.paneOpen = false; ctx.paneDeclined = true }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, ctx, String(e.args ?? '').trim()))

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked. A part that passes hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let passed = false
    const pass = (x: typeof e) => { passed = true; return next(x) }
    let mine: any
    try {
      mine = await renderBand($, ctx, e, pass)
    } catch {
      return passed ? mine : next(e) // a drawing that fails leaves the band to the others
    }
    if (passed) return mine
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - bandRows) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, ctx, e))
}
