// Safety Net: before a risky tool call it saves a snapshot of what would be lost, asks the person in plain words in a band above
// the prompt, and masks well-known secret shapes in tool results. `/safety` lists, restores and undoes.
//
// Rules this file keeps:
//   - It never blocks the person's work because of a fault of its own: whatever goes wrong while looking at a call (a lookup that
//     rejects, a snapshot that fails) lets the call go on. Only the person's answer, or no answer, can deny.
//   - A risky call is never run unattended: no answer in 15 minutes denies it.
//   - Every engine call is guarded; a missing capability (no Node, no git, no band on this surface, an old Claude Code) leaves what
//     still works and shows no error.
//   - Nothing is kept in the module itself: the state of one load lives in `register`'s closure (a hot reload starts clean), and
//     what the band draws from is in `$.state`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Hook, Register, Timer, ToolCallResult } from 'claude-code'

import type { Pending, SnapshotView } from '../types'
import { bandRow, maskedRow, resultCard } from './band'
import type { Handlers } from './band'
import { runSafety } from './command'
import { allowNote, denyAborted, denyReason, denyTimeout, maskedNotice, questionText, toastSnapshot } from './describe'
import { gatherFacts } from './facts'
import {
  DENY_COULD_NOT_FINISH, QUESTION_TIMEOUT_MS, answerOfDialog, buildPending, catchVerdict, coalesceKeys, createAsked, createDecisions, dequeue, dirKey, enqueue,
  fallbackDelay, fallbackId, frontOf, hasNothingToLose, isEarlyPress, isSnapshotStale, maskBlocks, needsFallback, othersIn, pathsToCheck, planCall, readOptions,
  limitsOf, remember, riskViewsOf, savedView, snapshotView, toggledDetail, vaultCfg, withNote,
} from './flow'
import type { Answer, CallPlan, Limits } from './flow'
import { assess, isWatched } from './guard'
import type { Place } from './guard'
import { languageFromSetting, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'
import { maskDeep } from './mask'
import { dirName, joinPath } from './paths'
import { createSnapshot, ioFromEngine, probeNode, pruneAll } from './vault'
import type { IO, SnapshotOutcome, SnapshotRequest, VaultEnv } from './vault'

const pendingAtom = atom({ plugin: 'kit-safety', key: 'pending' } as const, [] as Pending[])
const detailAtom = atom({ plugin: 'kit-safety', key: 'detail' } as const, null as string | null)

/** Everything one load of the plugin keeps. */
type Runtime = {
  cfg: ReturnType<typeof readOptions>
  lang: Lang
  t: Strings
  /** Whether the language was looked up (session.start does it; a hot reload skips that, so the first use does). */
  isLangSettled: boolean
  /** From session.start; undefined until then. */
  interactive: boolean | undefined
  node: Promise<boolean> | undefined
  /**
   * The snapshot folder, the helper's path and the folder every Git call gets as `core.hooksPath` (so that no hook of a project can
   * run), once the environment has told where home is (they do not change in a session).
   */
  where: { snapshotsRoot: string; helper: string; hooksDir: string | undefined } | undefined
  /** The files saved so far this session, by absolute path (one snapshot per file, not one per edit). */
  saved: Map<string, SnapshotView>
  /**
   * The ids of the questions in the order they wait (the band shows the first). Kept here as well as in the state because a
   * timer reads the state as it stood when its hook began, which is too old to tell who is first now.
   */
  order: string[]
  /** The questions the band has drawn (and is showing), and the ones Claude Code's own question box was asked about. */
  drawn: Set<string>
  asking: Set<string>
  /** When the band first drew each question (ms): a press that comes sooner is not an answer (see isEarlyPress). */
  shownAt: Map<string, number>
  /** The calls a question was raised for and that nobody answered yet; the hook's `.catch` refuses these (see catchVerdict). */
  asked: ReturnType<typeof createAsked>
  /** The id a call was asked under, by the event object (a call without a `tool_use_id` gets one of ours). */
  ids: WeakMap<object, string>
  decisions: ReturnType<typeof createDecisions>
  /** Snapshots are made one at a time (two calls at once would take the same number). */
  queue: Promise<unknown>
  lock: { busy: boolean }
  /** The tool results whose masked notice was shown as a toast. */
  toasted: Set<string>
}

const reasonOf = (err: unknown): string => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

/** A line in the debug log (never the transcript); never throws. No secret goes in: only what failed. */
function debug($: EngineInterface, text: string, err?: unknown): void {
  try {
    $.ui.log(`kit-safety: ${text}${err === undefined ? '' : `: ${reasonOf(err)}`}`, { to: 'debug' })
  } catch {
    // nowhere to write
  }
}

async function homeOf($: EngineInterface): Promise<string> {
  try {
    return (((await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))) ?? '').trim().replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

/** The words in use: the `language` option, or for `auto` Claude Code's own `language` setting (English when it cannot be read). */
async function settleLanguage($: EngineInterface, rt: Runtime): Promise<void> {
  let lang: Lang = rt.cfg.language === 'auto' ? 'en' : rt.cfg.language
  if (rt.cfg.language === 'auto') {
    try {
      lang = languageFromSetting(await $.settings.read({ key: 'language' }))
    } catch {
      // English
    }
  }
  rt.lang = lang
  rt.t = stringsFor(lang)
  rt.isLangSettled = true
}

async function ensureLanguage($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.isLangSettled) await settleLanguage($, rt).catch(() => undefined)
}

/** The IO over the engine. Every one has the plugin's own folder for Git hooks, so that no Git call can run a hook of a project. */
function ioOf($: EngineInterface, hooksDir: string | undefined): IO {
  return ioFromEngine($, hooksDir === undefined ? undefined : { hooksDir })
}

/** The vault's world: the snapshot folder in the config folder of this account, the helper script, and whether Node is there. */
async function vaultEnv($: EngineInterface, rt: Runtime): Promise<VaultEnv> {
  if (!rt.where) {
    const home = await homeOf($)
    let configDir = ''
    try {
      configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '').trim()
    } catch {
      // the default folder
    }
    const base = configDir !== '' ? configDir : home !== '' ? joinPath(home, '.claude') : ''
    const snapshotsRoot = base === '' ? '' : joinPath(base, 'kit-safety', 'snapshots')
    // `<config folder>/kit-safety/no-hooks`: next to the snapshots, never inside a project
    const hooksDir = snapshotsRoot === '' ? undefined : joinPath(dirName(snapshotsRoot), 'no-hooks')
    const where = { snapshotsRoot, helper: joinPath($.plugin.root, 'scripts', 'safety-fs.mjs'), hooksDir }
    // Nothing is remembered while no folder is known: a later call may find the environment answering.
    if (where.snapshotsRoot === '') {
      const io = ioOf($, hooksDir)
      return { io, snapshotsRoot, helper: where.helper, node: await nodeOf(rt, io, snapshotsRoot) }
    }
    rt.where = where
  }
  const { snapshotsRoot, helper, hooksDir } = rt.where
  const io = ioOf($, hooksDir)
  return { io, snapshotsRoot, helper, node: await nodeOf(rt, io, snapshotsRoot) }
}

/** Whether Node 18 or later runs here: asked once, from inside the snapshot folder (never from the project, which may hold a hostile `node`). */
function nodeOf(rt: Runtime, io: IO, snapshotsRoot: string): Promise<boolean> {
  rt.node ??= probeNode(io, snapshotsRoot === '' ? undefined : snapshotsRoot)
  return rt.node
}

async function placeOf($: EngineInterface): Promise<Place> {
  const [root, cwd, home] = await Promise.all([$.session.root(), $.session.cwd(), homeOf($)])
  return { root, cwd, home }
}

/** Whether a person can answer: what session.start said, else whether anything draws (a `-p` run draws nowhere). */
async function isInteractive($: EngineInterface, rt: Runtime): Promise<boolean> {
  if (rt.interactive !== undefined) return rt.interactive
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return true
  }
}

/** Runs `job` after every earlier one has finished (whatever became of them). */
function serial<T>(rt: Runtime, job: () => Promise<T>): Promise<T> {
  const run = rt.queue.then(job, job)
  rt.queue = run.catch(() => undefined)
  return run
}

// ---------------------------------------------------------------------------------------------------------------------
// The guard

/** What it takes to save the same files again just before an allowed call runs (a question that waited a long time). */
type Again = { env: VaultEnv; req: SnapshotRequest; limits: Limits; keys: string[] }

type Prepared = {
  plan: CallPlan
  view: SnapshotView
  pending: Pending | null
  again: Again | null
  /** The kinds of risk of the call: what a note to Claude may say a snapshot holds depends on them (a force push keeps no uncommitted changes). */
  kinds: string[]
  /** The call deletes the project's `.git` folder too (never in a snapshot). */
  gitLost: boolean
}

/** Looks at the call, saves what a snapshot should, and builds the question when one is to be asked. Null: nothing to do. */
async function prepare($: EngineInterface, rt: Runtime, tool: string, input: Record<string, unknown>): Promise<Prepared | null> {
  const place = await placeOf($)
  const env = await vaultEnv($, rt)
  const a = await assess(env.io, { tool, input }, place)
  if (a.risks.length === 0 || hasNothingToLose(a, place.root, place.home)) return null
  await ensureLanguage($, rt)
  const interactive = await isInteractive($, rt)
  const keys = coalesceKeys(place.root, a.targets)
  // A call that is only a cleanup of things that are cheap to regenerate (`rm -rf node_modules`) is saved with small limits; when it
  // is over them it simply goes on with no snapshot (it was not asked about, so nothing is said either).
  const limits = limitsOf(rt.cfg, a.cheap)
  const protectIds = (await read($, pendingAtom)).flatMap(p => (p.snapshot.state === 'saved' ? [p.snapshot.id] : []))

  const done = await serial(rt, async () => {
    // Decided here, one call at a time, so two edits of one file at once make one snapshot.
    const earlier = savedView(keys, rt.saved)
    const plan = planCall({ confirm: rt.cfg.confirm, risks: a.risks, interactive, coalesced: earlier !== null })
    if (!plan.snapshot) return { plan, view: earlier ?? ({ state: 'failed' } as SnapshotView), req: null }
    // The command text is not passed on: a manifest holds labels (masked), paths and Git facts, never the command line.
    const req: SnapshotRequest = { root: place.root, tool, risks: a.risks, targets: a.targets, kind: 'before-command', protectIds }
    let outcome: SnapshotOutcome | null = null
    try {
      outcome = await createSnapshot(env, req, limits.cfg)
    } catch (err) {
      // Not expected (the vault gives a result, never an error). The question, if one is due, still comes, saying no snapshot.
      debug($, 'the snapshot failed', err)
    }
    const view = snapshotView(outcome, limits.view)
    remember(rt.saved, keys, view)
    return { plan, view, req }
  })
  // Taken again after a long wait only where one was saved for this call (files, or the Git state of a reset).
  const wasSaved = done.view.state === 'saved' || (done.view.state === 'none' && done.view.hasGit)
  const again: Again | null = done.req !== null && wasSaved ? { env, req: done.req, limits, keys } : null
  const kinds = a.risks.map(r => r.kind)
  const gitLost = a.losesGit === true
  if (!done.plan.ask) return { plan: done.plan, view: done.view, pending: null, again: null, kinds, gitLost }

  // Which of the paths are folders ("the folder build/" and not "the file build")
  const dirs = new Set<string>()
  await Promise.all(
    pathsToCheck(a.risks, a.targets, place).map(async p => {
      const st = await env.io.stat(p)
      if (st?.kind === 'dir') dirs.add(dirKey(p))
    }),
  )
  const id = typeof input.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : fallbackId(await $.clock.now())
  const pending = buildPending({
    id,
    at: await $.clock.now(),
    tool,
    risks: riskViewsOf(a.risks, a.targets, place, dirs),
    snapshot: done.view,
    env: a.env,
    isAgent: typeof input.agentId === 'string' && input.agentId !== '',
    others: othersIn(tool, input.command, a.risks.length),
    gitLost,
    command: typeof input.command === 'string' ? input.command : undefined,
  })
  return { plan: done.plan, view: done.view, pending, again, kinds, gitLost }
}

async function clockNow($: EngineInterface): Promise<number | null> {
  try {
    const now = await $.clock.now()
    return typeof now === 'number' && Number.isFinite(now) ? now : null
  } catch {
    return null
  }
}

/**
 * The snapshot of the same files again, for a question that waited a while (the files may have changed meanwhile). The older
 * snapshot stays; null when the new one could not be made (then the older one is what Claude is told about).
 */
async function snapshotAgain($: EngineInterface, rt: Runtime, again: Again, firstId: string | undefined): Promise<SnapshotView | null> {
  try {
    const protectIds = [...(again.req.protectIds ?? []), ...(firstId !== undefined ? [firstId] : [])]
    const outcome = await serial(rt, () => createSnapshot(again.env, { ...again.req, protectIds }, again.limits.cfg))
    if (!outcome.ok) return null
    const view = snapshotView(outcome, again.limits.view)
    remember(rt.saved, again.keys, view)
    return view
  } catch (err) {
    debug($, 'the snapshot could not be taken again; the first one stands', err)
    return null
  }
}

/** Takes a question out of the queue (and closes its details). Never throws. */
async function drop($: EngineInterface, id: string): Promise<void> {
  try {
    await update($, pendingAtom, list => dequeue(list, id))
    await update($, detailAtom, d => (d === id ? null : d))
  } catch {
    // the band draws from what is left
  }
}

/** Claude Code's own question box, for a question the band did not draw (collapsed, a survey, a surface with no band). Asked once. */
async function askInBox($: EngineInterface, rt: Runtime, p: Pending): Promise<void> {
  rt.asking.add(p.id)
  try {
    const label = await $.ui.ask(questionText(p, rt.t), [rt.t.buttons.allow, rt.t.buttons.cancel])
    rt.decisions.answer(p.id, answerOfDialog(label, rt.t.buttons.allow))
  } catch {
    // dismissed: the person did not say yes
    rt.decisions.answer(p.id, 'cancel')
  }
}

/**
 * Holds the call until the person answers in the band (or in the question box when the band cannot show it), says no, or does not
 * answer for 15 minutes, or the call is interrupted. Whatever happens, the question leaves the queue.
 */
async function waitForAnswer($: EngineInterface, rt: Runtime, p: Pending, signal: AbortSignal): Promise<Answer> {
  const id = p.id
  const waiting = rt.decisions.open(id)
  let timeout: Timer | undefined
  let poll: Timer | undefined
  let isOver = false
  let ticks = 0
  const onAbort = () => {
    rt.decisions.answer(id, 'aborted')
  }
  // Every 1.5 s until answered: is this the question the band should show, and has the band drawn it? If not, ask in the box.
  const check = async () => {
    try {
      if (isOver || !rt.decisions.has(id)) return
      if (needsFallback({ isOpen: true, isFront: rt.order[0] === id, isDrawn: rt.drawn.has(id), isAsking: rt.asking.has(id) })) await askInBox($, rt, p)
    } catch (err) {
      debug($, 'question box skipped', err)
    }
    if (!isOver && rt.decisions.has(id)) arm()
  }
  const arm = () => {
    try {
      poll = $.clock.after(fallbackDelay(ticks++), () => {
        void check()
      })
    } catch (err) {
      // no timer: ask in the box at once, so that somebody can still answer
      debug($, 'no timer for the question box', err)
      void askInBox($, rt, p)
    }
  }
  try {
    rt.order.push(id)
    try {
      await update($, pendingAtom, list => enqueue(list, p))
    } catch (err) {
      // The band cannot show it, so the question box will (nothing is denied or run because of this).
      debug($, 'the question could not be put in the band', err)
    }
    try {
      timeout = $.clock.after(QUESTION_TIMEOUT_MS, () => {
        rt.decisions.answer(id, 'timeout')
      })
    } catch (err) {
      debug($, 'no timer for the time-out', err)
    }
    arm()
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    return await waiting
  } finally {
    isOver = true
    timeout?.cancel()
    poll?.cancel()
    try {
      signal.removeEventListener('abort', onAbort)
    } catch {
      // nothing to remove
    }
    rt.decisions.answer(id, 'aborted')
    rt.drawn.delete(id)
    rt.asking.delete(id)
    rt.shownAt.delete(id)
    rt.order = rt.order.filter(x => x !== id)
    await drop($, id)
  }
}

type CallHook = Hook<'tool.call'>
type CallEvent = Parameters<CallHook>[1]
type CallNext = Parameters<CallHook>[2]

/** The guard: `next` runs the tool. */
async function guard(rt: Runtime, $: EngineInterface, e: CallEvent, next: CallNext): Promise<ToolCallResult> {
  const tool = String(e.tool)
  let prepared: Prepared | null = null
  try {
    prepared = await prepare($, rt, tool, e as unknown as Record<string, unknown>)
  } catch (err) {
    // Not the person's problem: the call goes on, as if Safety Net were not there.
    debug($, `could not look at a ${tool.slice(0, 30)} call; it goes on`, err)
  }
  if (!prepared) return next(e)

  const { plan, pending, again, kinds, gitLost } = prepared
  let view = prepared.view
  if (plan.toast) {
    try {
      const text = toastSnapshot(view, rt.t)
      if (text !== '') await $.ui.toast(text)
    } catch {
      // the note below still tells Claude
    }
  }
  if (pending === null) {
    const out = await next(e)
    return withNote(out, plan.note ? allowNote(view, kinds, gitLost) : null)
  }
  // From here a question exists for this call: if this hook fails before the person answered, its `.catch` refuses the call.
  rt.ids.set(e, pending.id)
  rt.asked.mark(pending.id)
  const answer = await waitForAnswer($, rt, pending, next.signal)
  // An interruption keeps the mark (the engine may ask the `.catch` after it); an answer of any other kind settles it.
  if (answer !== 'aborted') rt.asked.clear(pending.id)
  if (answer !== 'allow') return { deny: answer === 'timeout' ? denyTimeout(pending) : answer === 'aborted' ? denyAborted(pending) : denyReason(pending) }
  // The person waited a while: what the snapshot holds may be out of date, so the same files are saved again just before the call.
  if (again !== null) {
    const now = await clockNow($)
    if (now !== null && isSnapshotStale(pending.at, now)) {
      const fresh = await snapshotAgain($, rt, again, view.state === 'saved' ? view.id : undefined)
      if (fresh !== null) view = fresh
    }
  }
  const out = await next(e)
  return withNote(out, plan.note ? allowNote(view, kinds, gitLost) : null)
}

/** The id a call was asked under: the one the guard recorded for this event, else the call's own `tool_use_id`. */
function askedId(rt: Runtime, e: CallEvent): string {
  const known = rt.ids.get(e as unknown as object)
  if (known !== undefined) return known
  const id = (e as unknown as { tool_use_id?: unknown }).tool_use_id
  return typeof id === 'string' ? id : ''
}

/**
 * A press answers the question it was drawn for, whatever the band shows by then; the question leaves the queue either way. A press
 * that comes less than 600 ms after the question first drew is ignored and leaves it open (a stray digit, a double press).
 */
function handlers($: EngineInterface, rt: Runtime): Handlers {
  const settle = async (id: string, answer: Answer) => {
    const now = await clockNow($)
    if (now !== null && isEarlyPress(rt.shownAt.get(id), now)) return
    rt.decisions.answer(id, answer)
    await drop($, id)
  }
  return {
    allow: id => settle(id, 'allow'),
    cancel: id => settle(id, 'cancel'),
    toggle: id => update($, detailAtom, d => toggledDetail(d, id)).catch(() => undefined),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

export const register: Register = (on, options) => {
  const cfg = readOptions(options)
  const rt: Runtime = {
    cfg,
    lang: 'en',
    t: stringsFor('en'),
    isLangSettled: false,
    interactive: undefined,
    node: undefined,
    where: undefined,
    saved: new Map(),
    order: [],
    drawn: new Set(),
    asking: new Set(),
    shownAt: new Map(),
    asked: createAsked(),
    ids: new WeakMap(),
    decisions: createDecisions(),
    queue: Promise.resolve(),
    lock: { busy: false },
    toasted: new Set(),
  }

  on('session.start', async ($, e, next) => {
    // Safety Net never blocks a session from starting.
    try {
      await settleLanguage($, rt)
    } catch {
      // English
    }
    rt.interactive = typeof e.isInteractive === 'boolean' ? e.isInteractive : undefined
    try {
      await $.command.register({ name: 'safety', description: rt.t.commandDescription, argumentHint: rt.t.commandHint })
    } catch {
      // no command; the band and the masking still work
    }
    // A reload loses the waiters, so a question left in the state would show a band that answers nothing.
    try {
      rt.order = []
      rt.shownAt.clear()
      await update($, pendingAtom, () => [])
      await update($, detailAtom, () => null)
    } catch {
      // nothing to clear
    }
    // Old snapshots of every project go in the background (the open project first); the session does not wait for it.
    void (async () => {
      try {
        let root: string | undefined
        try {
          root = await $.session.root()
        } catch {
          // the sweep still covers every project
        }
        await pruneAll(await vaultEnv($, rt), vaultCfg(rt.cfg), root)
      } catch (err) {
        debug($, 'old snapshots were not cleaned up', err)
      }
    })()
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Nobody can answer a question any more: end every wait, which takes each question out of the queue.
    try {
      rt.decisions.abortAll()
    } catch {
      // nothing waits
    }
    return next(e)
  })

  // --- the guard: every tool, then `isWatched` decides (builds with PowerShell or MultiEdit work too) ---
  on('tool.call', async ($, e, next) => {
    if (!isWatched(String(e.tool))) return next(e)
    return guard(rt, $, e, next)
  }).catch(($, e, next) => {
    // Where the hook had run the tool, that result stands. Where the person had been asked and the hook failed (it ran out of time
    // after a long wait, say), the call is refused: a risky call is never run unanswered. Anywhere else the fault is ours and the call goes on.
    const verdict = catchVerdict({ called: next.called, wasAsked: rt.asked.has(askedId(rt, e)) })
    return verdict === 'deny' ? { deny: DENY_COULD_NOT_FINISH } : next(e)
  })

  // --- the band above the prompt ---
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pendingAtom)
    const head = frontOf(list)
    if (!head) return next(e)
    // A survey or a collapsed band shows nothing of ours: the question box asks instead.
    if (e.props.hasSurvey) {
      rt.drawn.delete(head.id)
      return next(e)
    }
    await ensureLanguage($, rt)
    const row = bandRow($.ui.resolve(e), { pending: list, detail: await read($, detailAtom), t: rt.t, lang: rt.lang, surface: e.surface }, handlers($, rt))
    if (!row) return next(e)
    if (e.props.isCollapsed) {
      rt.drawn.delete(head.id)
    } else {
      rt.drawn.add(head.id)
      // The moment the question first drew on screen: Allow and Cancel ignore presses for a short while after it.
      if (!rt.shownAt.has(head.id)) {
        const now = await clockNow($)
        if (now !== null) rt.shownAt.set(head.id, now)
      }
    }
    return row
  }).catch(($, e, next) => next(e))

  // --- masking secrets ---
  if (cfg.maskSecrets) {
    // What Claude reads and what the transcript stores.
    on('session.append', { door: 'tool-result' }, async ($, e, next) => {
      let masked: ReturnType<typeof maskBlocks> | null = null
      try {
        const found = maskBlocks(e.message.content)
        if (found.count > 0) masked = found
      } catch {
        // stored as it is
      }
      if (masked === null) return next(e)
      return next({ ...e, message: { ...e.message, content: masked.value as typeof e.message.content } })
    }).catch(($, e, next) => next(e))

    // What the screen draws: the masked result, and under it one dim line saying so.
    on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
      const found = maskDeep(e.props.output)
      if (found.count === 0) return next(e)
      await ensureLanguage($, rt)
      const shown = await next({ ...e, props: { ...e.props, output: found.value } })
      return maskedRow($.ui.resolve(e), shown, maskedNotice(found.count, rt.t))
    }).catch(($, e, next) => {
      // The wrapper was refused (or something failed after the masked result was handed on): the masked result alone stands, and the
      // notice is a toast, once for each result.
      try {
        const found = maskDeep(e.props.output)
        if (next.called && found.count > 0 && !rt.toasted.has(e.props.tool_use_id)) {
          rt.toasted.add(e.props.tool_use_id)
          $.ui.toast(maskedNotice(found.count, rt.t))
        }
      } catch {
        // no notice
      }
      return next(e)
    })
  }

  // --- /safety ---
  on('command.run', { command: 'safety' }, async ($, e) => {
    try {
      await ensureLanguage($, rt)
      let root = ''
      try {
        root = await $.session.root()
      } catch {
        // the project is not known: the command says so
      }
      const env = await vaultEnv($, rt)
      return await runSafety(e.args, {
        env,
        root,
        cfg: vaultCfg(rt.cfg),
        t: rt.t,
        now: await $.clock.now(),
        facts: () => gatherFacts($, { env, root, confirm: rt.cfg.confirmText, maskSecrets: rt.cfg.maskSecrets, language: rt.lang, maxTotalMB: rt.cfg.maxTotalMB }),
        changed: () => rt.saved.clear(),
        lock: rt.lock,
      })
    } catch (err) {
      return { text: rt.t.failed(reasonOf(err)) }
    }
  })

  // The result card: the same text, with columns and indents kept (the transcript row would read it as markdown).
  on('ui.render', { component: 'CommandOutput', props: { command: 'safety' } }, async ($, e, next) => {
    const text = e.props.text
    if (e.props.isErrored || typeof text !== 'string' || text === '') return next(e)
    return resultCard($.ui.resolve(e), text)
  }).catch(($, e, next) => next(e))
}
