import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { SessionChanges, Summary } from '../types'
import { changesSince, git, newestRow, readUnpushed, rowsAfter, sessionChanges, snapshotOf } from './collect'
import {
  CLOCK_TICK_MS, PUSH_PROMPT, applyFileStats, buildSteps, clockTime, commitText, firstLine, formatElapsed, formatLine, maxFilesFrom, shortText, styleOption,
  summaryText, totals, fileText,
} from './data'
import type { Line } from './data'
import { languageFromSetting, languageOption, stringsFor } from './i18n'
import type { Lang } from './i18n'
import { renderBand, renderPane } from './render'
import { PANE } from './state'
import type { Actions, Ctx, View } from './state'

const MAX_TIMES = 500

const last = atom({ plugin: 'kit-turn', key: 'last' } as const, null as Summary | null, { shape: 'last-1' })
const visible = atom({ plugin: 'kit-turn', key: 'visible' } as const, false)
const running = atom({ plugin: 'kit-turn', key: 'running' } as const, null as { startedAt: number; now: number } | null)
const expanded = atom({ plugin: 'kit-turn', key: 'expanded' } as const, false)
const session = atom({ plugin: 'kit-turn', key: 'session' } as const, null as SessionChanges | null, { shape: 'session-1' })

async function readView($: EngineInterface): Promise<View> {
  const [l, v, r, x, s] = await Promise.all([read($, last), read($, visible), read($, running), read($, expanded), read($, session)])
  return { last: l, visible: v, running: r, expanded: x, session: s }
}

function readConfig(options: PluginOptions | undefined): Ctx['cfg'] {
  const o = options ?? {}
  return {
    style: styleOption(o.style),
    showClock: o.showClock !== false,
    showBand: o.showBand !== false,
    language: languageOption(o.language),
    maxFiles: maxFilesFrom(o.maxFiles),
  }
}

const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

/** The words in use: the language option, or for auto Claude Code's own language setting (read once; English when it cannot be). */
async function settleLanguage($: EngineInterface, ctx: Ctx) {
  let lang: Lang = ctx.cfg.language === 'auto' ? 'en' : ctx.cfg.language
  if (ctx.cfg.language === 'auto') {
    try { lang = languageFromSetting(await $.settings.read({ key: 'language' })) } catch { /* English */ }
  }
  ctx.lang = lang
  ctx.t = stringsFor(lang)
}

async function toast($: EngineInterface, text: string) {
  try { await $.ui.toast(text) } catch { /* nothing to tell it to */ }
}

async function openPane($: EngineInterface, ctx: Ctx): Promise<boolean> {
  try {
    await $.ui.open({ id: PANE, title: ctx.t.paneTitle })
    return true
  } catch {
    return false
  }
}

function makeActions($: EngineInterface, ctx: Ctx): Actions {
  return {
    // Only fills the prompt box: nothing is pushed unless the person sends it and Claude runs git push.
    push: async () => {
      try {
        // 'append' adds at the end of the draft: start a new line when there is one, so the request is not glued to it.
        let lead = ''
        try {
          const box = await $.prompt.read()
          if (typeof box?.text === 'string' && box.text.trim() !== '' && !box.text.endsWith('\n')) lead = '\n'
        } catch { /* no draft known: nothing to separate from */ }
        const r = await $.prompt.fill({ text: lead + PUSH_PROMPT, mode: 'append' })
        await toast($, r.isFilled ? ctx.t.pushFilled : ctx.t.pushNotFilled(PUSH_PROMPT))
      } catch {
        await toast($, ctx.t.pushNotFilled(PUSH_PROMPT))
      }
    },
    commits: async () => {
      const s = await read($, last)
      const u = s?.unpushed && s.unpushed.count > 0 ? s.unpushed : null
      if (!(await openPane($, ctx)) || !u) {
        await toast($, u ? [ctx.t.commitsList(u.count), ...u.commits.slice(0, 5).map(commitText)].join('\n') : ctx.t.noCommits)
      }
    },
    openPane: async () => { if (!(await openPane($, ctx))) await toast($, ctx.t.paneFailed) },
    hide: async () => { await update($, visible, () => false) },
    toggleFiles: async () => { await update($, expanded, v => !v) },
  }
}

// --- the turn -----------------------------------------------------------------------------------------------

function statusText(ctx: Ctx, startedAt: number, now: number): string {
  return ctx.t.working(clockTime(startedAt), formatElapsed(now - startedAt, ctx.t))
}

async function begin($: EngineInterface, ctx: Ctx, prompt: string) {
  // The conversation's newest row first, before any other call: the model is already working, and the rows after this one are the turn's.
  const row = newestRow($)
  const now = await $.clock.now()
  let cwd = ''
  try { cwd = await $.session.cwd() } catch { /* no folder known */ }
  ctx.times = {}
  ctx.lastMinute = 0
  ctx.run = { startedAt: now, prompt, baseline: cwd ? snapshotOf($, cwd).catch(() => null) : Promise.resolve(null), row }
  await update($, visible, () => false)
  await update($, expanded, () => false)
  await update($, running, () => ({ startedAt: now, now }))
  if (!ctx.cfg.showClock) return
  try { ctx.timer?.cancel?.() } catch { /* already stopped */ }
  ctx.lastStatus = statusText(ctx, now, now)
  $.ui.status(ctx.lastStatus)
  try {
    // The tick runs only while a turn does: it is cancelled when the turn ends.
    ctx.timer = (await $.clock.every(CLOCK_TICK_MS, () => { void tick($, ctx).catch(() => undefined) })) as Ctx['timer']
  } catch { /* no clock timer: the clock shows the start time and updates at the next draw */ }
}

async function tick($: EngineInterface, ctx: Ctx) {
  const run = ctx.run
  if (!run) return
  const now = await $.clock.now()
  const minute = Math.floor((now - run.startedAt) / 60_000)
  if (minute === ctx.lastMinute) return
  ctx.lastMinute = minute
  await update($, running, () => ({ startedAt: run.startedAt, now }))
  const text = statusText(ctx, run.startedAt, now)
  if (text !== ctx.lastStatus) { ctx.lastStatus = text; $.ui.status(text) }
}

function stopClock($: EngineInterface, ctx: Ctx) {
  try { ctx.timer?.cancel?.() } catch { /* already stopped */ }
  ctx.timer = null
  if (ctx.lastStatus !== undefined) { ctx.lastStatus = undefined; try { $.ui.status(undefined) } catch { /* nothing shown */ } }
}

/**
 * Builds the summary of the turn that just ended. Everything it needs from the context is taken before its first await, so a
 * new turn that starts while it is still reading git cannot disturb it (and it does not hold the turn's end up: see turn.complete).
 */
async function finish($: EngineInterface, ctx: Ctx, e: { answer: string; durationMs: number; isAborted: boolean; reason: string }) {
  stopClock($, ctx)
  const run = ctx.run
  ctx.run = null
  const times = ctx.times
  const endedAt = await $.clock.now()
  const startedAt = run?.startedAt ?? endedAt - Math.max(0, e.durationMs)
  let cwd = ''
  try { cwd = await $.session.cwd() } catch { /* no folder known */ }
  const baseline = run ? await run.baseline.catch(() => null) : null
  const row = run ? await run.row.catch(() => null) : null
  const changed = cwd ? await changesSince($, cwd, baseline) : { files: null, commitsMade: 0, vcs: null, root: null, branch: null }
  const asked = shortText(run?.prompt ?? '', 80)
  // With no turn start seen (no run), the rows are not guessed at: the steps are then just the start.
  const built = buildSteps({ messages: await rowsAfter($, run ? row : null), times, startedAt, endedAt, asked })
  // Version control's numbers when it can give them; Claude's own edits otherwise (marked as estimates).
  const fromGit = changed.files !== null && !(changed.files.length === 0 && built.editedFiles.length > 0)
  const files = fromGit ? changed.files : built.editedFiles.length > 0 ? built.editedFiles : changed.files
  const unpushed = await readUnpushed($, changed.vcs === 'git' ? changed.root : null)
  const summary: Summary = {
    startedAt, endedAt, durationMs: Math.max(0, e.durationMs || endedAt - startedAt),
    outcome: e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'error' : 'done',
    what: firstLine(e.answer), asked,
    files, filesApprox: !fromGit && files !== null, commitsMade: changed.commitsMade,
    tests: built.tests, testRuns: built.testRuns,
    steps: applyFileStats(built.steps, fromGit ? changed.files : null), unpushed,
  }
  ctx.turns += 1
  await update($, last, () => summary)
  // A turn that started meanwhile owns the clock and the card: leave them alone.
  if (!ctx.run) {
    await update($, running, () => null)
    await update($, visible, () => true)
  }
}

/**
 * The session's own change list, for the pane and /turn changes. It is read only when the pane is drawn and has no list yet or
 * one older than the last turn, never at the end of every turn.
 */
async function refreshSession($: EngineInterface, ctx: Ctx) {
  try {
    const l = await read($, last)
    // ctx.sessionFor is the turn the list was last read for (0: before any turn); a draw never reads it twice for one turn.
    const turnAt = l?.endedAt ?? 0
    if (ctx.sessionBusy || (ctx.sessionFor !== null && ctx.sessionFor >= turnAt)) return
    ctx.sessionBusy = true
    ctx.sessionFor = turnAt
    let cwd = ''
    try { cwd = await $.session.cwd() } catch { /* no folder known */ }
    const base = ctx.sessionBase ? await ctx.sessionBase.catch(() => null) : null
    const sess = cwd ? await sessionChanges($, cwd, base, await $.clock.now()) : { at: await $.clock.now(), files: null, commitsMade: 0, unpushed: null }
    await update($, session, () => sess)
  } catch { /* the pane then shows no session list */ }
  ctx.sessionBusy = false
}

// --- /turn --------------------------------------------------------------------------------------------------

async function changesCommand($: EngineInterface, ctx: Ctx): Promise<string> {
  const t = ctx.t
  let cwd = ''
  try { cwd = await $.session.cwd() } catch { /* none */ }
  const base = ctx.sessionBase ? await ctx.sessionBase.catch(() => null) : null
  const sess = cwd ? await sessionChanges($, cwd, base, await $.clock.now()) : null
  if (sess) await update($, session, () => sess)
  if (!sess || sess.files === null) return `${t.changesHeader}\n${t.noRepo}`
  const tot = totals(sess.files)
  const lines = [t.changesHeader, sess.files.length ? t.sessionFiles(tot.n, tot.added, tot.removed) : t.paneSessionNone]
  for (const f of sess.files.slice(0, 40)) lines.push(`  ${fileText(f, t)}`)
  if (sess.files.length > 40) lines.push(`  ${t.moreFiles(sess.files.length - 40)}`)
  if (sess.commitsMade > 0) lines.push(t.sessionCommits(sess.commitsMade))
  if (sess.unpushed && sess.unpushed.count > 0) {
    lines.push(`⚠ ${t.unpushed(sess.unpushed.count, sess.unpushed.upstream)}:`)
    for (const c of sess.unpushed.commits.slice(0, 30)) lines.push(`  ${commitText(c)}`)
  }
  return lines.join('\n')
}

async function doctor($: EngineInterface, ctx: Ctx): Promise<string> {
  const d = ctx.t.doctor
  const lines: Line[] = []
  const v = await git($, ['--version'])
  lines.push(v.ok ? { level: 'PASS', name: d.git, detail: d.gitFound(v.out.trim()) } : { level: 'WARN', name: d.git, detail: d.gitMissing, fix: d.gitFix })
  let cwd = ''
  try { cwd = await $.session.cwd() } catch { /* none */ }
  const snap = cwd ? await snapshotOf($, cwd) : null
  lines.push(snap ? { level: 'PASS', name: d.repo, detail: d.repoFound(snap.vcs, snap.branch) } : { level: 'WARN', name: d.repo, detail: d.repoNone })
  if (snap && snap.vcs === 'git') {
    const up = await git($, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], snap.root)
    if (up.ok) lines.push({ level: 'PASS', name: d.upstream, detail: d.upstreamFound(up.out.trim()) })
    else {
      const remotes = await git($, ['remote'], snap.root)
      lines.push({ level: 'WARN', name: d.upstream, detail: remotes.ok && remotes.out.trim() ? d.upstreamNone : d.upstreamNoRemote })
    }
  }
  const base = ctx.sessionBase ? await ctx.sessionBase.catch(() => null) : null
  lines.push(base ? { level: 'PASS', name: d.baseline, detail: d.baselineFound((base.rev ?? '-').slice(0, 10)) } : { level: 'WARN', name: d.baseline, detail: d.baselineNone })
  lines.push({ level: 'PASS', name: d.language, detail: ctx.lang })
  lines.push({ level: 'PASS', name: d.surface, detail: d.seen(ctx.turns) })
  return [d.header, ...lines.map(l => formatLine(l, d.fixLabel))].join('\n')
}

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<{ text: string }> {
  const t = ctx.t
  try {
    const word = args.trim().toLowerCase()
    if (word === '') {
      const s = await read($, last)
      return { text: s ? summaryText(s, t, ctx.cfg.maxFiles) : t.noTurnYet }
    }
    if (word === 'changes') return { text: await changesCommand($, ctx) }
    if (word === 'doctor') return { text: await doctor($, ctx) }
    if (word === 'pane') return { text: (await openPane($, ctx)) ? t.paneOpened : t.paneFailed }
    return { text: t.usage }
  } catch (err) {
    return { text: `${t.usage} (${reason(err)})` }
  }
}

// --- the module ---------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    cfg: readConfig(options), lang: 'en', t: stringsFor('en'), sessionBase: null, run: null, times: {},
    timer: null, lastStatus: undefined, lastMinute: 0, turns: 0, pending: null, sessionBusy: false, sessionFor: null, actions: undefined as unknown as Actions,
  }

  on('session.start', async ($, e, next) => {
    // The card never blocks a session from starting.
    try { await settleLanguage($, ctx) } catch { /* English */ }
    ctx.actions = makeActions($, ctx)
    try {
      await $.command.register({ name: 'turn', description: ctx.t.commandDescription, argumentHint: ctx.t.commandHint })
    } catch { /* no command; the card still works */ }
    try {
      const cwd = await $.session.cwd()
      ctx.sessionBase = snapshotOf($, cwd).catch(() => null)
    } catch { ctx.sessionBase = Promise.resolve(null) }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        if (!ctx.actions) ctx.actions = makeActions($, ctx)
        await begin($, ctx, typeof e.text === 'string' ? e.text : '')
      } catch (err) { $.ui.log(`kit-turn: turn start not recorded: ${reason(err)}`, { to: 'debug' }) }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        if (!ctx.actions) ctx.actions = makeActions($, ctx)
        // The summary is built beside the turn's end, not before it: git reads never delay the turn. Errors are kept, never thrown.
        ctx.pending = finish($, ctx, e).catch(async err => {
          if (!ctx.run) { try { await update($, running, () => null) } catch { /* nothing to reset */ } }
          try { $.ui.log(`kit-turn: summary not built: ${reason(err)}`, { to: 'debug' }) } catch { /* no log */ }
        })
      } catch (err) {
        stopClock($, ctx)
        try { $.ui.log(`kit-turn: summary not built: ${reason(err)}`, { to: 'debug' }) } catch { /* no log */ }
      }
    }
    return next(e)
  })

  // Only the time a tool call ended is taken from this row, so the timeline can show clock times; the row passes on unchanged.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      if (e.agentId === undefined && ctx.run) {
        const now = await $.clock.now()
        for (const block of e.message.content) {
          const id = block.type === 'tool_result' ? block.tool_use_id : undefined
          if (typeof id === 'string' && Object.keys(ctx.times).length < MAX_TIMES) ctx.times[id] = now
        }
      }
    } catch { /* the timeline then spreads the steps evenly */ }
    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'turn' }, async ($, e) => runCommand($, ctx, String(e.args ?? '').trim()))

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked. A part with nothing to show hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let mine: { node: unknown; rows: number } | null = null
    try { mine = renderBand($, ctx, e, await readView($)) } catch { mine = null }
    if (!mine) return next(e)
    const { Box } = $.ui.resolve(e)
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - mine.rows) } })
    return <Box flexDirection="column">{mine.node as never}{rest}</Box>
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await refreshSession($, ctx)
    return renderPane($, ctx, e, await readView($))
  })
}
