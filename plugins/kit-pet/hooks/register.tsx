// kit-pet: a small pixel pet in a band above the prompt. It reacts to what Claude does (working, done, error, low
// quota), grows with finished turns and cheers a few first milestones with one toast.
//   wide:   [sprite] [name pill][STATE pill] message          (3 rows: the sprite is 3 terminal rows tall)
//                    dim line (idle: today's turns, stage, a growth bar)
//   medium: [name pill][STATE pill] message                   (1 row, no sprite)
//   narrow: name · STATE · clock                              (1 row)
// Every hook is guarded: a failed lookup or write is logged to debug and never thrown, and every event is passed on.
// Only observation events are used (turn.*, classic.PostToolUse*, session.measure): a `tool.call` or `tool.run` hook
// would turn off background-moving and live output of Bash. Nothing is sent anywhere, nothing reads a login or a secret.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PetView, QuotaView } from '../types'
import { readConfig } from './config'
import type { Config } from './config'
import { report } from './doctor'
import type { Facts } from './doctor'
import { TABLES, languageFromSetting } from './i18n'
import type { Strings } from './i18n'
import {
  ACHIEVEMENT_ORDER, DONE_MS, QUOTA_STALE_MS, TOOL_ERROR_MS, TURN_ERROR_MS, bar, clock, countdown, dayKey, deriveState, durationText, emptyModel, emptySave,
  fitText, growth, isGreenCommitCommand, isGreenTestCommand, markAnnounced, mergeSave, pickToast, quotaOf, recordCommit, recordTest,
  recordTurn, sanitizeSave, step, streakOf, testCommandFromTool,
} from './logic'
import type { EndReason, Model, Save } from './logic'
import { spriteGrid, svgOf, terminalSprite, TERMINAL_COLUMNS } from './sprite'
import type { Cell } from './sprite'
import type { AchievementId, Lang, PetId, PetState } from './types'

const NO_QUOTA: QuotaView = { pct: null, resetsAt: null, kind: null, at: null }
const EMPTY: PetView = {
  model: emptyModel(), save: emptySave(), loaded: false, quota: NO_QUOTA, steps: 0, lastTool: '', lastDurationMs: 0, errorKind: 'tool',
}
const view = atom({ plugin: 'kit-pet', key: 'view' } as const, EMPTY)
const now = atom({ plugin: 'kit-pet', key: 'now' } as const, 0)
// The band's language when `language` is auto: what Claude Code's `language` setting said; null: not looked at yet.
const lang = atom({ plugin: 'kit-pet', key: 'lang' } as const, null as Lang | null)

const TOAST_MS = 10_000
const TICK_MS = 1000
// A timer lands a little after the moment a state ends, so the redraw never reads the old state.
const FLIP_SLACK_MS = 50
const TOOL_NAME_MAX = 20
// An MCP tool name carries the server's name, which must not end up in a screenshot, so only the kind is shown.
const MCP_PREFIX = 'mcp__'
const toolLabel = (name: unknown): string => (String(name ?? '').startsWith(MCP_PREFIX) ? 'MCP' : fitText(String(name ?? ''), TOOL_NAME_MAX))
const SPRITE_PX = 48

// Tokyo Night (the same colors as usage-bar's band).
const T = {
  dark: '#16161e', comment: '#8a93bd', fg: '#c0caf5', blue: '#7aa2f7', magenta: '#d4bcff', orange: '#ff9e64',
  yellow: '#e0af68', green: '#9ece6a', teal: '#73daca', red: '#ffa3b5', off: '#3b4261',
} as const
const ACCENT: Record<PetId, string> = { moss: T.teal, bun: T.orange, jelly: T.magenta }
const STATE_COLOR: Record<PetState, string> = { idle: T.blue, working: T.yellow, done: T.green, error: T.red, quota: T.orange }

const warn = ($: EngineInterface, what: string, err: unknown): void => {
  try { $.ui.log(`${what}: ${String(err)}`, { to: 'debug' }) } catch { /* nothing left to tell */ }
}

// ---------------------------------------------------------------- defensive reads

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
// A field the engine filled in (any value but absent, null or false).
const present = (x: unknown): boolean => x !== undefined && x !== null && x !== false
const count = (x: unknown): number => { const n = num(x); return n !== null && n > 0 ? Math.floor(n) : 0 }

function cleanModel(raw: unknown): Model {
  const m = emptyModel()
  if (!isRecord(raw)) return m
  const reason = raw.endReason
  return {
    working: raw.working === true,
    workingSince: num(raw.workingSince),
    endedAt: num(raw.endedAt),
    endReason: reason === 'answer' || reason === 'error' || reason === 'refusal' || reason === 'aborted' ? reason : null,
    toolErrorAt: num(raw.toolErrorAt),
    quotaPct: num(raw.quotaPct),
  }
}

/** Whatever the atom holds (an older version's value, a damaged one) becomes a valid view: a draw must never throw. */
function cleanView(raw: unknown): PetView {
  if (!isRecord(raw)) return EMPTY
  const q = isRecord(raw.quota) ? raw.quota : {}
  const kind = q.kind === 'five_hour' || q.kind === 'seven_day' ? q.kind : null
  return {
    model: cleanModel(raw.model),
    save: sanitizeSave(raw.save),
    loaded: raw.loaded === true,
    // `at` is missing in a view written by an older version: the age is then unknown (see `expired`).
    quota: { pct: num(q.pct), resetsAt: num(q.resetsAt), kind, at: num(q.at) },
    steps: count(raw.steps),
    lastTool: typeof raw.lastTool === 'string' ? fitText(raw.lastTool, TOOL_NAME_MAX) : '',
    lastDurationMs: count(raw.lastDurationMs),
    errorKind: raw.errorKind === 'turn' ? 'turn' : 'tool',
  }
}

const readView = async ($: EngineInterface): Promise<PetView> => cleanView(await read($, view))

/** Reads the view, changes it and writes it back (retried by `update` when another event wrote first). Returns what was written. */
async function mutate($: EngineInterface, change: (v: PetView) => PetView): Promise<PetView> {
  let written = EMPTY
  await update($, view, s => { written = change(cleanView(s)); return written })
  return written
}

/**
 * A reading that says nothing about now: its limit has reset, or it came without a reset time and is too old to trust.
 * A reading without `at` (an older version wrote it) and without a reset time has an unknown age, so it counts as expired
 * until the next measure brings a fresh one.
 */
const expired = (q: QuotaView, at: number): boolean =>
  q.resetsAt !== null ? q.resetsAt <= at : q.at === null || at - q.at > QUOTA_STALE_MS

/** The clock, or the last bumped time when the clock is refused. */
async function nowOf($: EngineInterface): Promise<number> {
  try { return await $.clock.now() } catch { return read($, now) }
}
const localDay = (ms: number): string => dayKey(ms, new Date(ms).getTimezoneOffset())

// ---------------------------------------------------------------- language, save

async function readLanguage($: EngineInterface): Promise<Lang> {
  try {
    return languageFromSetting(await $.settings.read({ key: 'language' }))
  } catch (err) {
    warn($, 'language setting not read', err)
    return 'en'
  }
}

/** The language to draw in: the option when it names one, else what was looked up (looked up now if a reload skipped it). */
async function languageOf($: EngineInterface, cfg: Config): Promise<Lang> {
  if (cfg.language !== 'auto') return cfg.language
  const known = await read($, lang)
  return known === 'en' || known === 'vi' ? known : readLanguage($)
}

/** The saved progress; anything unreadable is an empty save, so the pet always starts. */
async function loadSave($: EngineInterface): Promise<Save> {
  try {
    return sanitizeSave(await $.store.get('save'))
  } catch (err) {
    warn($, 'saved progress not read, starting fresh', err)
    return emptySave()
  }
}

/** A reload without session.start has the view but no save in it: read it the first time an event needs it. */
async function ensureLoaded($: EngineInterface, mem: Remembered): Promise<void> {
  if ((await readView($)).loaded) return
  const save = await loadSave($)
  await mutate($, v => (v.loaded ? v : { ...v, save, loaded: true }))
  mem.baseTurns = save.turns
}

/**
 * Writes the save. Other sessions write the same file, so the store is read again first and this session's save is
 * merged into what it holds (only the turns this session added since it last loaded or wrote are counted on top).
 * The merged save goes back into the view. A store that refuses is not an error: progress then lives in memory
 * until the next write works, and nothing about the view or the base changes, so the next merge counts it once.
 */
async function persist($: EngineInterface, mem: Remembered, local: Save): Promise<void> {
  let merged = local
  let stored: Save | null = null
  try {
    stored = sanitizeSave(await $.store.get('save'))
  } catch (err) {
    // Unreadable: this session's save alone is better than none.
    warn($, 'saved progress not re-read, writing this session alone', err)
  }
  if (stored !== null) {
    // After a reload there is no base: nothing of this session's can be told apart, so the larger turns win and nothing is counted twice.
    merged = mergeSave(stored, local, mem.baseTurns ?? stored.turns)
  }
  try {
    await $.store.set('save', merged)
    mem.saveFailed = false
  } catch (err) {
    mem.saveFailed = true
    warn($, 'progress not saved', err)
    return
  }
  // Anything this session recorded while the write was under way is kept on top of the merged save.
  try {
    await mutate($, v => ({ ...v, save: mergeSave(merged, v.save, local.turns) }))
    mem.baseTurns = merged.turns
  } catch (err) {
    warn($, 'merged progress not shown', err)
  }
}

// ---------------------------------------------------------------- timers

// What the module remembers between hooks (a reload starts it over; the timers stop with it).
// baseTurns: the turns this session last loaded or wrote (null after a reload that skipped session.start).
type Remembered = { gen: number; flip: Timer | null; tick: Timer | null; tickId: number; saveFailed: boolean; baseTurns: number | null }

const cancel = (timer: Timer | null): void => {
  try { timer?.cancel() } catch { /* already gone */ }
}

/** The state may flip by itself (done -> idle, an error flash ends): how long from `at`, or null when nothing will. */
function nextFlipMs(m: Model, at: number): number | null {
  if (!m.working && (m.endReason === 'error' || m.endReason === 'refusal') && m.endedAt !== null) {
    const left = TURN_ERROR_MS - (at - m.endedAt)
    return left > 0 ? left : null
  }
  if (m.working && m.toolErrorAt !== null) {
    const left = TOOL_ERROR_MS - (at - m.toolErrorAt)
    return left > 0 ? left : null
  }
  if (!m.working && m.endReason === 'answer' && m.endedAt !== null) {
    const left = DONE_MS - (at - m.endedAt)
    return left > 0 ? left : null
  }
  return null
}

async function bumpNow($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
}

/** One timer at most: it redraws the band when a timed state ends. A newer schedule (or session) makes an old one do nothing. */
async function scheduleFlip($: EngineInterface, mem: Remembered, m: Model, at: number): Promise<void> {
  mem.gen += 1
  const gen = mem.gen
  cancel(mem.flip)
  mem.flip = null
  const wait = nextFlipMs(m, at)
  if (wait === null) return
  try {
    const timer = await $.clock.after(wait + FLIP_SLACK_MS, () => {
      if (mem.gen !== gen) return
      bumpNow($).catch(err => warn($, 'redraw timer failed', err))
    })
    if (mem.gen === gen) mem.flip = timer
    else cancel(timer)
  } catch (err) {
    warn($, 'redraw timer not started', err)
  }
}

function stopTick(mem: Remembered): void {
  mem.tickId += 1
  cancel(mem.tick)
  mem.tick = null
}

/**
 * The working clock counts seconds, so while a turn runs the band redraws once a second; the timer is stopped at the
 * end of the turn and nothing ticks otherwise. A timer that cannot start leaves the clock moving only with events.
 */
async function startTick($: EngineInterface, mem: Remembered): Promise<void> {
  stopTick(mem)
  const id = mem.tickId
  try {
    const timer = await $.clock.every(TICK_MS, () => {
      if (mem.tickId !== id) return
      readView($).then(async v => {
        if (!v.model.working) {
          if (mem.tickId === id) stopTick(mem)
          return
        }
        await bumpNow($)
      }).catch(err => warn($, '1 s clock tick failed', err))
    })
    if (mem.tickId === id) mem.tick = timer
    else cancel(timer)
  } catch (err) {
    warn($, '1 s clock not started, the working clock moves with each step', err)
  }
}

// ---------------------------------------------------------------- achievements

/** After a record: at most one toast a day (logic.ts decides), then it is marked announced. Option off: nothing at all. */
async function checkAchievements($: EngineInterface, cfg: Config, mem: Remembered, today: string): Promise<void> {
  if (!cfg.achievements) return
  if (pickToast((await readView($)).save, today) === null) return
  // Marked before it is shown, so two events racing cannot show it twice.
  const hit: { id: AchievementId | null } = { id: null }
  const after = await mutate($, v => {
    hit.id = pickToast(v.save, today)
    return hit.id === null ? v : { ...v, save: markAnnounced(v.save, hit.id, today) }
  })
  const id = hit.id
  if (id === null) return
  // Written before the toast, so another session that reads the store next does not cheer the same milestone.
  await persist($, mem, after.save)
  const t = TABLES[await languageOf($, cfg)]
  try {
    await $.ui.toast(t.toast(t.achievement[id].title, t.achievement[id].text(t.petName[cfg.pet])), { timeoutMs: TOAST_MS })
  } catch (err) {
    warn($, 'achievement toast not shown', err)
  }
}

// ---------------------------------------------------------------- command

async function gatherFacts($: EngineInterface, mem: Remembered): Promise<Facts> {
  let version: string | null = null
  try { version = (await $.session.version()).version || null } catch { /* unknown */ }
  let surfaces: string[] = []
  try { surfaces = [...(await $.session.surfaces())] } catch { /* unknown */ }
  let store: Facts['store'] = 'ok'
  try {
    const raw = await $.store.get('save')
    // A damaged value is recovered silently when the next turn is saved, but the doctor says so.
    if (raw !== undefined && !isRecord(raw)) store = 'bad'
  } catch { store = 'bad' }
  if (mem.saveFailed) store = 'bad'
  // The same rule as the band: a reading whose window has reset (or that is too old to trust) counts as unknown.
  let quotaPct: number | null = null
  try {
    const q = (await readView($)).quota
    quotaPct = expired(q, await $.clock.now()) ? null : q.pct
  } catch { /* unknown */ }
  return { version, surfaces, store, quotaPct }
}

async function runCommand($: EngineInterface, cfg: Config, mem: Remembered, args: string): Promise<{ text: string }> {
  const t = TABLES[await languageOf($, cfg)]
  const word = args.trim().toLowerCase()
  try {
    if (word === 'doctor') return { text: report(await gatherFacts($, mem), cfg, t).join('\n') }
    if (word !== '' && word !== 'status') return { text: t.command.usage }
    await ensureLoaded($, mem)
    const v = await readView($)
    const at = await $.clock.now()
    const g = growth(v.save.turns)
    const q = expired(v.quota, at) ? NO_QUOTA : v.quota
    const cd = countdown(q.resetsAt, at)
    return {
      text: t.command.status({
        name: t.petName[cfg.pet],
        stage: t.stageName[cfg.pet][g.stage - 1] ?? '',
        turns: v.save.turns,
        left: g.left,
        streak: streakOf(v.save.days, localDay(at)),
        unlocked: ACHIEVEMENT_ORDER.filter(id => v.save.earned[id]).map(id => t.achievement[id].title),
        quota: q.pct === null ? '' : `${q.pct}%${cd ? ` · ↻ ${cd}` : ''}`,
      }),
    }
  } catch (err) {
    warn($, 'pet command failed', err)
    return { text: t.command.usage }
  }
}

// ---------------------------------------------------------------- the register

const reasonOf = (reason: string): EndReason => (reason === 'answer' || reason === 'error' || reason === 'refusal' ? reason : 'aborted')

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  const mem: Remembered = { gen: 0, flip: null, tick: null, tickId: 0, saveFailed: false, baseTurns: null }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      // A new session start (a resume, say; /clear fires session.end and no session.start) starts over: timers of an older start do nothing.
      mem.gen += 1
      cancel(mem.flip)
      mem.flip = null
      stopTick(mem)
      if (cfg.language === 'auto') {
        const found = await readLanguage($)
        await update($, lang, () => found)
      }
      const save = await loadSave($)
      mem.baseTurns = save.turns
      const usage = await $.session.usage().catch(() => null)
      const at = await $.clock.now()
      const quota = { ...quotaOf(usage?.rateLimits ?? []), at }
      await update($, view, () => ({ ...EMPTY, save, loaded: true, quota, model: step(emptyModel(), { t: 'quota', pct: quota.pct }) }))
      await update($, now, () => at)
      try {
        await $.command.register({ name: 'pet', description: TABLES[await languageOf($, cfg)].command.description, argumentHint: '[doctor]' })
      } catch (err) { warn($, 'pet command not registered', err) }
    } catch (err) {
      warn($, 'session.start failed', err)
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await ensureLoaded($, mem)
        const at = await $.clock.now()
        const v = await mutate($, s => ({ ...s, model: step(s.model, { t: 'turnStart', at }), steps: 0, lastTool: '', lastDurationMs: 0 }))
        await update($, now, () => at)
        // With the pet hidden nothing can be shown, so no timer is started either.
        if (cfg.showPet) {
          await scheduleFlip($, mem, v.model, at)
          await startTick($, mem)
        }
      } catch (err) {
        warn($, 'turn.start failed', err)
      }
    }
    return next(e)
  })

  // The in-memory state is updated first and the event is passed on next; the store write and the toast come after,
  // so a slow disk never holds up the turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let recorded: { save: Save; day: string } | null = null
    try {
      stopTick(mem)
      await ensureLoaded($, mem)
      const at = await $.clock.now()
      const reason = reasonOf(e.reason)
      const day = localDay(at)
      const ms = num(e.durationMs) ?? 0
      const v = await mutate($, s => ({
        ...s,
        model: step(s.model, { t: 'turnEnd', at, reason }),
        // Only an answer is a finished turn: an error, a refusal or an interruption counts nothing.
        save: reason === 'answer' ? recordTurn(s.save, day) : s.save,
        lastDurationMs: ms > 0 ? ms : 0,
        errorKind: reason === 'error' || reason === 'refusal' ? 'turn' : s.errorKind,
      }))
      await update($, now, () => at)
      if (cfg.showPet) await scheduleFlip($, mem, v.model, at)
      if (reason === 'answer') recorded = { save: v.save, day }
    } catch (err) {
      warn($, 'turn.complete failed', err)
    }
    try {
      return await next(e)
    } finally {
      if (recorded !== null) {
        try {
          await persist($, mem, recorded.save)
          await checkAchievements($, cfg, mem, recorded.day)
        } catch (err) {
          warn($, 'turn.complete saving failed', err)
        }
      }
    }
  })

  // A step that worked or failed. Observation only: nothing is returned but the pass-through.
  on('classic.PostToolUse', async ($, e, next) => {
    let recorded: { save: Save; day: string } | null = null
    try {
      await ensureLoaded($, mem)
      const at = await $.clock.now()
      const tool = toolLabel(e.tool_name)
      let isTest = false
      let isCommit = false
      if (e.tool_name === 'Bash') {
        // Only the command's kind is looked at (and then forgotten): it is never stored or shown.
        const command = testCommandFromTool(e.tool_input)
        const response = isRecord(e.tool_response) ? e.tool_response : {}
        // A command that went to the background, timed out or was interrupted has not finished: nothing is learned from it.
        const backgrounded = present(response.backgroundTaskId) || present(response.backgroundedByUser)
        const unfinished = backgrounded || present(response.timedOutAfterMs) || response.interrupted === true
        isTest = !unfinished && isGreenTestCommand(command)
        // The engine's own report of a commit is the proof. Only when it reports nothing at all is the command line read,
        // and then the commit has to decide the line's exit status (`git commit || echo` may have committed nothing).
        const git = isRecord(response.gitOperation) ? response.gitOperation : null
        isCommit = !backgrounded && (git !== null ? isRecord(git.commit) : !unfinished && isGreenCommitCommand(command))
      }
      // A subagent's tool counts as a step, but must neither flash the error nor clear the main loop's error flash.
      const fromSubagent = typeof e.agent_id === 'string'
      const day = localDay(at)
      const v = await mutate($, s => {
        let save = s.save
        if (isTest) save = recordTest(save, day)
        if (isCommit) save = recordCommit(save, day)
        return { ...s, model: fromSubagent ? s.model : step(s.model, { t: 'toolOk', at }), steps: s.steps + 1, lastTool: tool, save }
      })
      await update($, now, () => at)
      if (isTest || isCommit) recorded = { save: v.save, day }
    } catch (err) {
      warn($, 'tool result not noticed', err)
    }
    const result = await next(e)
    if (recorded !== null) {
      try {
        await persist($, mem, recorded.save)
        await checkAchievements($, cfg, mem, recorded.day)
      } catch (err) {
        warn($, 'tool result saving failed', err)
      }
    }
    return result
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    try {
      // The person pressing Esc is not a failure.
      if (e.is_interrupt !== true) {
        await ensureLoaded($, mem)
        const at = await $.clock.now()
        const tool = toolLabel(e.tool_name)
        // A tool that failed inside a subagent is usually retried by it: it counts as a step but does not make the pet sad.
        const fromSubagent = typeof e.agent_id === 'string'
        const v = await mutate($, s => ({
          ...s,
          model: fromSubagent ? s.model : step(s.model, { t: 'toolFail', at }),
          steps: s.steps + 1,
          lastTool: tool,
          errorKind: 'tool',
        }))
        await update($, now, () => at)
        if (cfg.showPet) await scheduleFlip($, mem, v.model, at)
      }
    } catch (err) {
      warn($, 'tool failure not noticed', err)
    }
    return next(e)
  })

  // The limit reading: an empty one (API key, third-party provider, nothing yet) keeps the last, so a band never flickers.
  on('session.measure', async ($, e, next) => {
    try {
      if (Array.isArray(e.rateLimits) && e.rateLimits.length > 0) {
        // The time of the reading lets a reading without a reset time be dropped when it gets old.
        const quota = { ...quotaOf(e.rateLimits), at: await nowOf($) }
        await mutate($, s => ({ ...s, quota, model: step(s.model, { t: 'quota', pct: quota.pct }) }))
      }
    } catch (err) {
      warn($, 'session.measure failed', err)
    }
    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    try {
      return await runCommand($, cfg, mem, String(e.args ?? ''))
    } catch (err) {
      warn($, 'pet command failed', err)
      return { text: TABLES.en.command.usage }
    }
  })

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked. A part that passes hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let mine: { tree: unknown; rows: number } | null = null
    try {
      mine = await ownBand($, e, cfg)
    } catch (err) {
      warn($, 'pet band not drawn', err)
    }
    if (mine === null) return next(e)
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - mine.rows) } })
    return <Box flexDirection="column">{mine.tree as never}{rest}</Box>
  })
}

// ---------------------------------------------------------------- drawing

type Run = { text: string; fg?: string; bg?: string }

/** Neighbouring cells with the same look become one Text, so a sprite row is a handful of elements, not ten. */
function runsOf(cells: readonly Cell[]): Run[] {
  const runs: Run[] = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last && last.fg === c.fg && last.bg === c.bg) last.text += c.ch
    else runs.push({ text: c.ch, fg: c.fg, bg: c.bg })
  }
  return runs
}

const textLength = (s: string): number => Array.from(s).length

/** The three layouts, by what the band is given. `rows` is what the drawn part takes (the plugins beneath get the rest). */
export type Tier = 'wide' | 'medium' | 'narrow'
export function tierOf(columns: number, maxRows: number): Tier {
  if (columns < 24) return 'narrow'
  return columns >= 44 && maxRows >= 3 ? 'wide' : 'medium'
}

async function ownBand($: EngineInterface, e: any, cfg: Config): Promise<{ tree: unknown; rows: number } | null> {
  const props = e.props ?? {}
  const columns: number = num(props.bodyColumns) ?? 80
  const maxRows: number = num(props.maxRows) ?? 3
  // Yield (null) to a survey, a collapsed band, the option off, or no room at all.
  if (props.hasSurvey || props.isCollapsed || !cfg.showPet || maxRows < 1) return null
  const { Box, Text, Svg } = $.ui.resolve(e)
  const t: Strings = TABLES[await languageOf($, cfg)]

  let v = await readView($)
  // A reload that saw no session.start has no save in the view yet: read it for this draw (a draw never writes).
  if (!v.loaded) v = { ...v, save: await loadSave($) }
  const atomNow = await read($, now)
  let at = atomNow
  try { at = await $.clock.now() } catch { /* the last bump will do */ }

  // A limit that has reset since the last reading says nothing about now: it counts as unknown until the next reading.
  const lapsed = expired(v.quota, at)
  const quota = lapsed ? NO_QUOTA : v.quota
  const state = deriveState(lapsed ? { ...v.model, quotaPct: null } : v.model, at)
  const name = t.petName[cfg.pet]
  const label = t.stateLabel[state]
  const g = growth(v.save.turns)
  const stageName = t.stageName[cfg.pet][g.stage - 1] ?? ''
  const todayTurns = v.save.today.day === localDay(at) ? v.save.today.turns : 0
  const clockText = v.model.working && v.model.workingSince !== null ? clock(at - v.model.workingSince) : ''

  let message = ''
  let dim = ''
  let showBar = false
  switch (state) {
    case 'idle':
      message = t.idle(name)
      dim = t.lineIdle(todayTurns, stageName)
      showBar = true
      break
    case 'working':
      message = t.working(name, clockText)
      dim = t.lineWorking(v.steps, v.lastTool)
      break
    case 'done':
      message = t.done(name, durationText(v.lastDurationMs))
      dim = t.lineDone(v.save.turns, g.left, name)
      break
    case 'error':
      message = v.errorKind === 'turn' ? t.errorTurn(name) : t.errorTool(name)
      dim = t.lineError()
      break
    case 'quota':
      message = t.quota(name, quota.pct ?? v.model.quotaPct ?? 0, quota.kind ?? 'five_hour')
      dim = t.lineQuota(countdown(quota.resetsAt, at))
      break
  }

  const pill = (bg: string, text: string) => <Text backgroundColor={bg} color={T.dark} weight="bold" mono>{` ${text} `}</Text>
  const tier = tierOf(columns, maxRows)

  if (tier === 'narrow') {
    const one = fitText(t.narrow(name, label, clockText), columns - 2) || ' '
    return { tree: <Text color={ACCENT[cfg.pet]} wrap="truncate-end" mono>{one}</Text>, rows: 1 }
  }

  const pills = (
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {pill(ACCENT[cfg.pet], name)}
      {pill(STATE_COLOR[state], label)}
    </Box>
  )
  const pillsWidth = textLength(name) + 2 + 1 + textLength(label) + 2
  const messageRow = (room: number) => {
    const text = fitText(message, room - pillsWidth - 1)
    return (
      <Box flexDirection="row" gap={1}>
        {pills}
        {text ? <Text wrap="truncate-end" color={T.fg} mono>{text}</Text> : null}
      </Box>
    )
  }

  if (tier === 'medium') return { tree: messageRow(columns), rows: 1 }

  // Wide: the sprite on the left (terminal: half blocks; a surface with Svg: a picture; otherwise none), two rows beside it.
  const surface: string = e.surface
  const sprite =
    surface === 'terminal'
      ? (
        <Box flexDirection="column" width={TERMINAL_COLUMNS} flexShrink={0}>
          {terminalSprite(cfg.pet, g.stage, state).map(cells => (
            <Box flexDirection="row">
              {runsOf(cells).map(r => <Text color={r.fg} backgroundColor={r.bg} mono>{r.text}</Text>)}
            </Box>
          ))}
        </Box>
      )
      : Svg
        ? <Box flexShrink={0}><Svg source={svgOf(spriteGrid(cfg.pet, g.stage, state))} alt={`${name}, ${label.toLowerCase()}`} height={SPRITE_PX} /></Box>
        : null
  const room = columns - (sprite ? TERMINAL_COLUMNS + 2 : 0)
  const barCells = showBar ? bar(g.filled) : null
  const counts = showBar ? (g.span === null ? String(v.save.turns) : `${g.into}/${g.span}`) : ''
  // The growth bar and its counts keep their place; the text before them gives way.
  const tail = barCells ? textLength(barCells.on + barCells.off) + 1 + textLength(counts) + 1 : 0
  const second = (
    <Box flexDirection="row">
      <Text color={T.comment} wrap="truncate-end" mono>{fitText(dim, room - tail)}</Text>
      {barCells ? <Text color={T.green} mono>{` ${barCells.on}`}</Text> : null}
      {barCells ? <Text color={T.off} mono>{barCells.off}</Text> : null}
      {barCells ? <Text color={T.comment} mono tabular>{` ${counts}`}</Text> : null}
    </Box>
  )
  const text = (
    <Box flexDirection="column" flexShrink={1} justifyContent={surface === 'terminal' ? 'flex-start' : 'center'}>
      {messageRow(room)}
      {second}
    </Box>
  )
  return {
    tree: sprite ? <Box flexDirection="row" gap={1}>{sprite}{text}</Box> : text,
    rows: sprite ? 3 : 2,
  }
}
