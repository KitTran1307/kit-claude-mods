import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AwayCard, AwayEvent, QueueItem } from '../types'
import {
  NEEDS_LOOKING_MS, QUEUE_MAX, TEXT_MAX, addEvent, addToQueue, awayMinutes, cardEvents, clampOption, clockText, cleanPrompt,
  countEvents, decideDrain, detectPlatform, flag, isCardCompact, isLooking, isNeedsYou, isPerson, isQuiet, minuteOfDay, oneLine,
  parseQuietHours, parseQueueArgs, planQueue, playerCommands, removeById, removeNth, resolveQuestions, shortLine,
  shouldAlertDone, shouldShowCard, soundFile,
} from './core'
import type { Platform, Quiet } from './core'
import { chooseLanguage, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'

const ACCENT = '#4f7be0'
const ASK = '#d9822b'
const DONE = '#3f9d5a'
const SENT_GAP_MS = 1_500 // two prompts are never sent closer together than this
// A send asked for from a command or a press waits for a later event: the engine refuses a prompt submitted from inside
// a command.run hook (it would wait on the turn that hook holds). A send from turn.complete or a timer is allowed.
const SOON_MS = 50
const LINE_MAX = 200
const WIDE = 90 // columns from which one row holds all the queue's buttons

const queueAtom = atom({ plugin: 'kit-notify', key: 'queue' } as const, [] as QueueItem[])
const pausedAtom = atom({ plugin: 'kit-notify', key: 'isPaused' } as const, false)
const runningAtom = atom({ plugin: 'kit-notify', key: 'isRunning' } as const, false)
const draftAtom = atom({ plugin: 'kit-notify', key: 'hasDraft' } as const, false)
const cardAtom = atom({ plugin: 'kit-notify', key: 'card' } as const, null as AwayCard | null)

/** The options, read once per load (a change in /config reloads the module with new ones). */
type Config = {
  sound: boolean; notify: boolean; notifyAfterSec: number; notifyDetails: boolean; quiet: Quiet; awayMin: number
  showQueueButton: boolean; language: unknown
}

function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return {
    sound: flag(o.sound), notify: flag(o.notify), notifyAfterSec: clampOption(o.notifyAfterSec, 20, 0, 3600),
    notifyDetails: flag(o.notifyDetails), quiet: parseQuietHours(o.quietHours), awayMin: clampOption(o.awayMin, 10, 0, 1440),
    showQueueButton: flag(o.showQueueButton), language: o.language,
  }
}

/** What one loaded copy of the module remembers; what the band draws lives in the atoms above. */
type Ctx = {
  cfg: Config; lang: Lang; t: Strings; project: string; platform: Platform; root?: string
  /** Set up once per load (language, system, project, the /queue command): a reload starts without a session.start. */
  isReady: boolean
  /** When the person last typed, sent or pressed something (-1: not yet known); the start of an absence. */
  lastActive: number
  /** When the person last edited the prompt box (0: never): they are looking at the session. */
  lastTyped: number
  /** What happened since they were last here, oldest first. */
  events: AwayEvent[]
  /** A permission prompt or question is open (its text, when it came). */
  question: { text: string; at: number } | null
  /** Main-loop turns started, to see whether a send began one. */
  turns: number
  lastSentAt: number
  isDraining: boolean
  /** A drain was asked for while one ran: go round again. */
  again: boolean
  timer?: { cancel: () => void }
  timers: Set<{ cancel: () => void }>
  serial: number
}

const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
const newId = (ctx: Ctx, now: number) => `${now.toString(36)}${(ctx.serial++).toString(36)}`

/** One try of something optional: a missing capability or a refusal is not an error the person has to act on. */
const quietly = <T,>(work: () => Promise<T> | T): Promise<T | undefined> => Promise.resolve().then(work).catch(() => undefined)

// --- set up once per load ---------------------------------------------------------------------------------------------

/**
 * Which system this is and where the plugin's folder is, for playing its sound file. A Claude Code that lacks the
 * newer calls (`session.info`, `process.hookEnv`) is asked the older way; whatever stays unknown leaves only the
 * engine's own player (macOS), and the notification still shows.
 */
async function settlePlatform($: EngineInterface, ctx: Ctx) {
  // @ts-ignore session.info is newer than the oldest Claude Code this runs on; a missing one throws and is caught
  const fromEngine = (await quietly(() => $.session.info()))?.platform
  let os: unknown
  let uname = ''
  if (fromEngine === undefined) {
    os = await quietly(() => $.env.get('OS'))
    if (os !== 'Windows_NT') uname = String((await quietly(() => $.process.run(['uname', '-sr'], { timeoutMs: 3_000 })))?.stdout ?? '')
  }
  ctx.platform = detectPlatform(fromEngine, os, uname)
  // @ts-ignore process.hookEnv is newer than the oldest Claude Code this runs on; a missing one throws and is caught
  ctx.root = (await quietly(() => $.process.hookEnv()))?.CLAUDE_PLUGIN_ROOT || undefined
  if (!ctx.root) ctx.root = (await quietly(() => $.env.get('CLAUDE_PLUGIN_ROOT'))) || undefined
}

async function ensureReady($: EngineInterface, ctx: Ctx) {
  if (ctx.isReady) return
  ctx.isReady = true
  const setting = await quietly(() => $.settings.read({ key: 'language' }))
  const value = typeof setting === 'object' && setting !== null ? (setting as { language?: unknown }).language : setting
  ctx.lang = chooseLanguage(ctx.cfg.language, value)
  ctx.t = stringsFor(ctx.lang)
  ctx.project = baseName(String((await quietly(() => $.session.cwd())) ?? ''))
  if (ctx.lastActive < 0) ctx.lastActive = (await quietly(() => $.clock.now())) ?? 0
  await settlePlatform($, ctx)
  try {
    await $.command.register({ name: 'queue', description: ctx.t.commandDescription, argumentHint: ctx.t.commandHint, immediate: true })
  } catch (err) { $.ui.log(`kit-notify: no /queue command: ${reason(err)}`, { to: 'debug' }) }
}

// --- sound and notification -----------------------------------------------------------------------------------------

/** Plays a clip with what the system has; every failure is silent. Never awaited by a hook. */
async function playSound($: EngineInterface, ctx: Ctx, kind: 'done' | 'needs') {
  const rel = `sounds/${soundFile(kind)}`
  if (ctx.root) {
    for (const argv of playerCommands(ctx.platform, `${ctx.root.replace(/[\\/]+$/, '')}/${rel}`)) {
      try {
        const r = await $.process.run(argv, { timeoutMs: 8_000 })
        if (r.exitCode === 0) return
      } catch { /* that player is not here: the next one */ }
    }
  }
  try { await $.audio.play({ asset: rel }) } catch { /* nothing can play here: stay silent */ }
}

/** One alert: dropped in quiet hours or while the person is typing, else a notification and a sound. */
async function alert($: EngineInterface, ctx: Ctx, kind: 'done' | 'needs', body: string) {
  await ensureReady($, ctx)
  const now = await $.clock.now()
  if (isQuiet(ctx.cfg.quiet, minuteOfDay(now)) || isLooking(now, ctx.lastTyped, kind === 'needs' ? NEEDS_LOOKING_MS : undefined)) return
  // With details off nothing says what the work is about, the project's name included.
  const project = ctx.cfg.notifyDetails ? ctx.project : ''
  const title = kind === 'done' ? ctx.t.doneTitle(project) : ctx.t.needsTitle(project)
  if (ctx.cfg.sound) void playSound($, ctx, kind).catch(() => undefined)
  if (ctx.cfg.notify) {
    try {
      const sent = await $.ui.notify(body, { title, key: `kit-notify-${kind}` })
      // Turned off in Claude Code's own settings is the person's call; no channel at all gets an in-app line instead.
      if (!sent.isSent && sent.reason !== 'disabled') $.ui.toast(`${title}: ${body}`)
    } catch (err) { $.ui.log(`kit-notify: no notification: ${reason(err)}`, { to: 'debug' }) }
  }
}

// --- presence and the welcome-back card -------------------------------------------------------------------------------

/** The person typed, sent or pressed something: the end of an absence, and maybe a card about it. */
async function noteActive($: EngineInterface, ctx: Ctx, isTyping = false) {
  await ensureReady($, ctx)
  const now = await $.clock.now()
  const last = ctx.lastActive
  ctx.lastActive = now
  if (isTyping) ctx.lastTyped = now
  if (now - last < 1_000 && ctx.events.length === 0) return
  const events = ctx.events
  ctx.events = [] // everything so far is seen now
  if (events.length === 0) return
  if (shouldShowCard({ awayMin: ctx.cfg.awayMin, lastActive: last, now, events })) {
    await update($, cardAtom, () => ({ from: last, to: now, events }))
  }
}

/** The open question is answered, or the turn moved on without it; a held queue may go on. */
function questionDone($: EngineInterface, ctx: Ctx, isDrainWanted = true) {
  const had = ctx.question !== null
  ctx.question = null
  ctx.events = resolveQuestions(ctx.events)
  if (had && isDrainWanted) scheduleDrain($, ctx)
}

async function needsYou($: EngineInterface, ctx: Ctx, text: string, detail: string) {
  await ensureReady($, ctx)
  const now = await $.clock.now()
  if (ctx.question && now - ctx.question.at < 5_000) return // the same prompt, heard twice
  ctx.question = { text, at: now }
  ctx.events = addEvent(ctx.events, { id: newId(ctx, now), kind: 'question', at: now, text })
  await alert($, ctx, 'needs', ctx.cfg.notifyDetails ? detail : ctx.t.needsBody)
}

// --- the queue --------------------------------------------------------------------------------------------------------

/** Runs `fn` from a timer: a later event, which is where the engine lets a plugin submit a prompt. */
function defer($: EngineInterface, ctx: Ctx, ms: number, fn: () => Promise<unknown>): boolean {
  try {
    const timer = $.clock.after(ms, () => { ctx.timers.delete(timer); void fn().catch(() => undefined) })
    ctx.timers.add(timer)
    return true
  } catch { return false }
}

/** Tries the queue soon (or after a pause when two sends would come too close together). */
function scheduleDrain($: EngineInterface, ctx: Ctx, ms = SOON_MS) {
  try { ctx.timer?.cancel() } catch { /* an old timer is gone */ }
  const before = ctx.timers.size
  defer($, ctx, ms, () => drain($, ctx))
  ctx.timer = ctx.timers.size > before ? [...ctx.timers].pop() : undefined
}

/** Takes the first queued prompt out in one step, so two callers never get the same one. */
async function takeFirst($: EngineInterface): Promise<QueueItem | undefined> {
  let taken: QueueItem | undefined
  await update($, queueAtom, q => { taken = q[0]; return taken ? q.slice(1) : q })
  return taken
}

/** Puts a prompt back at the front (a send that did not happen) and holds the queue, with a message. */
async function putBack($: EngineInterface, ctx: Ctx, item: QueueItem, why: string) {
  $.ui.log(`kit-notify: queued prompt not sent: ${why}`, { to: 'debug' })
  await quietly(() => update($, queueAtom, q => (q.some(x => x.id === item.id) ? q : [item, ...q])))
  await quietly(() => update($, pausedAtom, () => true))
  try { $.ui.toast(ctx.t.notSent) } catch { /* nothing to tell */ }
}

/** Sends a queued prompt as the person's own words. A refusal puts it back and pauses the queue. */
async function send($: EngineInterface, ctx: Ctx, item: QueueItem) {
  ctx.lastSentAt = await $.clock.now()
  const turns = ctx.turns
  $.prompt.submit({ text: item.text, asUser: true }).then(
    (result: unknown) => {
      // A hook above dropped it: put it back, as for a rejection.
      if (result && typeof result === 'object' && 'drop' in result) return putBack($, ctx, item, String((result as { drop: unknown }).drop))
      // A prompt that started no turn (a slash command) will not call us back: go on with the next one.
      if (ctx.turns === turns) scheduleDrain($, ctx)
    },
    (err: unknown) => putBack($, ctx, item, reason(err)),
  )
}

/** Sends the next queued prompt when it is allowed: not paused, no permission prompt open, no turn running, no typing. */
async function drain($: EngineInterface, ctx: Ctx) {
  if (ctx.isDraining) { ctx.again = true; return }
  ctx.isDraining = true
  try {
    const queue = await read($, queueAtom)
    let draft = ''
    try { draft = String((await $.prompt.read())?.text ?? '') } catch { /* no box: nothing is being typed */ }
    const now = await $.clock.now()
    const verdict = decideDrain({
      queueLength: queue.length, isPaused: await read($, pausedAtom), isRunning: await read($, runningAtom),
      hasQuestion: ctx.question !== null, draft,
    })
    if (verdict !== 'send') return // typing, a question or a running turn each end with an event that drains again
    if (now - ctx.lastSentAt < SENT_GAP_MS) { scheduleDrain($, ctx, SENT_GAP_MS); return }
    const item = await takeFirst($)
    if (item) await send($, ctx, item)
  } finally {
    ctx.isDraining = false
    if (ctx.again) { ctx.again = false; scheduleDrain($, ctx) }
  }
}

type Added = { ok: boolean; text: string }

async function addPrompt($: EngineInterface, ctx: Ctx, text: unknown): Promise<Added> {
  const t = ctx.t
  const now = await $.clock.now()
  let result = addToQueue([], text, '')
  await update($, queueAtom, q => { result = addToQueue(q, text, newId(ctx, now)); return result.queue })
  if (result.problem === 'empty') return { ok: false, text: t.nothingToAdd }
  if (result.problem === 'long') return { ok: false, text: t.tooLong(TEXT_MAX) }
  if (result.problem === 'full') return { ok: false, text: t.full(QUEUE_MAX) }
  const isPaused = await read($, pausedAtom)
  if (!(await read($, runningAtom)) && !isPaused) scheduleDrain($, ctx) // nothing is running: it goes out at once
  return { ok: true, text: t.queued(result.queue.length, oneLine(result.added!.text, 120), isPaused) }
}

async function sendFirstNow($: EngineInterface, ctx: Ctx): Promise<string> {
  const item = await takeFirst($)
  if (!item) return ctx.t.nothingToSend
  // The engine holds a plugin's prompt until the session is idle. If no timer can be set the prompt goes back, never lost.
  if (!defer($, ctx, SOON_MS, () => send($, ctx, item))) {
    await update($, queueAtom, q => [item, ...q])
    return ctx.t.notSent
  }
  return ctx.t.sentNow(oneLine(item.text, 120))
}

async function clearQueue($: EngineInterface, ctx: Ctx): Promise<string> {
  let n = 0
  await update($, queueAtom, q => { n = q.length; return [] })
  return ctx.t.cleared(n)
}

async function setPaused($: EngineInterface, ctx: Ctx, isPaused: boolean): Promise<string> {
  await update($, pausedAtom, () => isPaused)
  if (isPaused) return ctx.t.paused
  const n = (await read($, queueAtom)).length
  if (n > 0) scheduleDrain($, ctx)
  return ctx.t.resumed(n)
}

/** "Queue what I typed": moves the prompt box's text into the queue; the box is emptied only when the text is really queued. */
async function addTyped($: EngineInterface, ctx: Ctx) {
  let draft = ''
  try { draft = cleanPrompt((await $.prompt.read())?.text) } catch { /* no box */ }
  const toast = (text: string) => { try { $.ui.toast(text) } catch { /* nothing to tell */ } }
  if (draft === '') return toast(ctx.t.typeFirst)
  const added = await addPrompt($, ctx, draft)
  if (!added.ok) return toast(added.text) // the text stays in the box
  let isCleared = false
  try { isCleared = (await $.prompt.fill({ text: '' })).isFilled } catch { /* the box keeps the text */ }
  if (!isCleared) toast(ctx.t.boxNotCleared)
}

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<string> {
  const t = ctx.t
  const { verb, rest } = parseQueueArgs(args)
  switch (verb) {
    case 'add': return (await addPrompt($, ctx, rest)).text
    case 'list': {
      const queue = await read($, queueAtom)
      if (queue.length === 0) return t.listEmpty
      const isPaused = await read($, pausedAtom)
      return [t.listHead(queue.length, isPaused), ...queue.map((q, i) => `${i + 1}. ${oneLine(q.text, 160)}`)].join('\n')
    }
    case 'remove': {
      const n = /^\d+$/.test(rest) ? Number(rest) : 0
      let out = removeNth([], n)
      await update($, queueAtom, q => { out = removeNth(q, n); return out.queue })
      return out.removed ? t.removed(n, oneLine(out.removed.text, 120)) : t.noSuchItem(rest)
    }
    case 'clear': return clearQueue($, ctx)
    case 'pause': return setPaused($, ctx, true)
    case 'resume': return setPaused($, ctx, false)
    case 'next': return sendFirstNow($, ctx)
    default: return t.usage
  }
}

/** The prompt box has text or not; the atom changes (and the band redraws) only when that flips. */
async function setHasDraft($: EngineInterface, has: boolean) {
  if ((await read($, draftAtom)) !== has) await update($, draftAtom, () => has)
}

// --- the band ---------------------------------------------------------------------------------------------------------

/** A button's action, run so that a failure is logged and never reaches the person. */
const press = ($: EngineInterface, fn: () => Promise<unknown>) => () => {
  void fn().catch(err => $.ui.log(`kit-notify: press failed: ${reason(err)}`, { to: 'debug' }))
}

function cardNode($: EngineInterface, ctx: Ctx, ui: any, card: AwayCard, rows: number, cols: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  const { done, questions } = countEvents(card.events)
  const min = awayMinutes(card.to - card.from)
  const dismiss = <Button key="card-dismiss" label={t.buttons.dismiss} onPress={press($, () => update($, cardAtom, () => null))} />
  if (isCardCompact(rows)) {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>☾</Text> {t.cardSummary(min, done, questions)}</Text></Box>
        {dismiss}
      </Box>
    )
  }
  const { shown, hidden } = cardEvents(card.events, rows)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text wrap="truncate-end"><Text color={ACCENT}>☾</Text> <Text bold>{t.cardTitle}</Text> <Text dimColor>{t.cardAway(min, clockText(card.from), clockText(card.to))}</Text></Text>
      <Text bold wrap="truncate-end">{t.cardSummary(min, done, questions)}</Text>
      {shown.map(ev => (
        <Text key={`ev-${ev.id}`} wrap="truncate-end">
          {ev.kind === 'question'
            ? <Text color={ASK}>{`? ${t.questionRow(oneLine(ev.text, Math.max(20, cols - 8)))}`}</Text>
            : <Text><Text color={DONE}>✓</Text>{` ${t.doneRow(oneLine(ev.text, Math.max(20, cols - 8)))}`}</Text>}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>{t.cardMore(hidden)}</Text>}
      <Box flexDirection="row" columnGap={1}>{dismiss}</Box>
    </Box>
  )
}

/** Rows the card takes for the room it is given. */
const cardRows = (card: AwayCard, rows: number) => {
  if (isCardCompact(rows)) return 1
  const { shown, hidden } = cardEvents(card.events, rows)
  return 5 + shown.length + (hidden > 0 ? 1 : 0)
}

const buttonRowsFor = (cols: number) => (cols >= WIDE ? 1 : 2)

function queueNode($: EngineInterface, ctx: Ctx, ui: any, queue: QueueItem[], isPaused: boolean, isRunning: boolean, rows: number, cols: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  const plan = planQueue(rows, queue.length, buttonRowsFor(cols))
  const addButton = ctx.cfg.showQueueButton && isRunning
    ? <Button key="add-typed" label={t.buttons.addTyped} onPress={press($, () => addTyped($, ctx))} />
    : null
  if (queue.length === 0) {
    // Claude is working, nothing is queued and something is typed: one row that offers to queue it.
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>⏳</Text> {t.idleLine}</Text></Box>
        {addButton}
      </Box>
    )
  }
  if (plan.mode === 'line') {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>⏳</Text> {t.queueLine(queue.length, oneLine(queue[0]!.text, 60), isPaused)}</Text></Box>
        <Button key="send-now" label={t.buttons.sendNow} onPress={press($, () => sendFirstNow($, ctx))} />
        <Button key="clear" label={t.buttons.clear} onPress={press($, () => clearQueue($, ctx))} />
      </Box>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text wrap="truncate-end"><Text color={ACCENT}>⏳</Text> <Text bold>{t.queueTitle(queue.length, isPaused)}</Text></Text>
      {queue.slice(0, plan.shown).map((q, i) => (
        <Box key={`row-${q.id}`} flexDirection="row" columnGap={1}>
          <Text dimColor>{String(i + 1)}</Text>
          <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end">{oneLine(q.text, Math.max(20, cols - 14))}</Text></Box>
          <Button key={`rm-${q.id}`} label={t.buttons.remove} onPress={press($, () => update($, queueAtom, list => removeById(list, q.id)))} />
        </Box>
      ))}
      {plan.hidden > 0 && <Text dimColor>{t.moreItems(plan.hidden)}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="send-now" label={t.buttons.sendNow} onPress={press($, () => sendFirstNow($, ctx))} />
        {isPaused
          ? <Button key="resume" variant="primary" label={t.buttons.resume} onPress={press($, () => setPaused($, ctx, false))} />
          : <Button key="pause" label={t.buttons.pause} onPress={press($, () => setPaused($, ctx, true))} />}
        <Button key="clear" label={t.buttons.clear} onPress={press($, () => clearQueue($, ctx))} />
        {addButton}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    cfg: readConfig(options), lang: 'en', t: stringsFor('en'), project: '', platform: 'unknown', isReady: false,
    lastActive: -1, lastTyped: 0, events: [], question: null, turns: 0, lastSentAt: 0, isDraining: false, again: false,
    timers: new Set(), serial: 0,
  }

  on('session.start', async ($, e, next) => {
    try {
      await ensureReady($, ctx)
      await update($, runningAtom, () => false)
    } catch (err) {
      $.ui.log(`kit-notify: session start skipped: ${reason(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    for (const timer of ctx.timers) { try { timer.cancel() } catch { /* already gone */ } }
    ctx.timers.clear()
    return next(e)
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    try {
      await ensureReady($, ctx)
      await noteActive($, ctx)
      // Shown to the person only: what is queued must not reach the model before it is sent.
      return { text: await runCommand($, ctx, String(e.args ?? '')), isTextDisplayOnly: true as const }
    } catch (err) {
      $.ui.log(`kit-notify: command failed: ${reason(err)}`, { to: 'debug' })
      return { text: ctx.t.failed, isTextDisplayOnly: true as const }
    }
  })

  // Typing is a prompt edit: the person is here and looking, and an emptied box lets a held prompt go.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    try {
      await noteActive($, ctx, true)
      const has = String(box?.text ?? '').trim() !== ''
      await setHasDraft($, has)
      if (!has && (await read($, queueAtom)).length > 0) scheduleDrain($, ctx)
    } catch { /* presence is best effort */ }
    return box
  })

  // The box emptied by something other than an edit (a clear, a submit, an undo).
  on('prompt.change', async ($, e, next) => {
    try {
      if (e.origin?.kind !== 'plugin') {
        const has = String(e.text ?? '').trim() !== ''
        await setHasDraft($, has)
        if (!has && (await read($, queueAtom)).length > 0) scheduleDrain($, ctx)
      }
    } catch { /* best effort */ }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      // Only the person's own prompts count as "back": a schedule, a task or a peer is not them.
      if (isPerson(e.origin)) {
        await noteActive($, ctx)
        await setHasDraft($, false)
        questionDone($, ctx, false)
      }
    } catch { /* presence is best effort */ }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      ctx.turns += 1
      try { await update($, runningAtom, () => true) } catch { /* the band only misses a row */ }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      await ensureReady($, ctx)
      await update($, runningAtom, () => false)
      questionDone($, ctx, false)
      const now = await $.clock.now()
      if (e.reason === 'answer') {
        const line = shortLine(e.answer, LINE_MAX)
        ctx.events = addEvent(ctx.events, { id: newId(ctx, now), kind: 'done', at: now, text: line })
        if (shouldAlertDone(e, ctx.cfg.notifyAfterSec)) {
          await alert($, ctx, 'done', ctx.cfg.notifyDetails && line ? shortLine(line, 120) : ctx.t.doneBody)
        }
      } else if ((await read($, queueAtom)).length > 0) {
        // Stopped, failed or refused: do not send the next prompt behind the person's back.
        await update($, pausedAtom, () => true)
        $.ui.toast(ctx.t.stoppedPause)
      }
    } catch (err) {
      $.ui.log(`kit-notify: turn end not handled: ${reason(err)}`, { to: 'debug' })
    }
    const result = await next(e)
    try { await drain($, ctx) } catch (err) { $.ui.log(`kit-notify: queue not sent: ${reason(err)}`, { to: 'debug' }) }
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    try {
      if (isNeedsYou(e.notification_type)) {
        const message = shortLine(e.message, LINE_MAX)
        await needsYou($, ctx, message, message || ctx.t.needsBody)
      }
    } catch (err) { $.ui.log(`kit-notify: notification not handled: ${reason(err)}`, { to: 'debug' }) }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      await ensureReady($, ctx)
      const tool = shortLine(e.tool_name, 60)
      const text = tool ? ctx.t.needsTool(tool) : ctx.t.needsBody
      await needsYou($, ctx, text, text)
    } catch (err) { $.ui.log(`kit-notify: permission prompt not handled: ${reason(err)}`, { to: 'debug' }) }
    return next(e)
  })

  // A tool ran after an ask: the prompt was answered.
  on('classic.PostToolUse', ($, e, next) => {
    try { questionDone($, ctx) } catch { /* best effort */ }
    return next(e)
  })

  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the plugins beneath.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await ensureReady($, ctx)
    const queue = await read($, queueAtom)
    const isPaused = await read($, pausedAtom)
    const isRunning = await read($, runningAtom)
    const card = await read($, cardAtom)
    const showQueue = queue.length > 0 || (isRunning && ctx.cfg.showQueueButton && (await read($, draftAtom)))
    if (!card && !showQueue) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const rows: number = e.props.maxRows ?? 40
    const cols: number = e.props.bodyColumns ?? 100
    const forCard = card ? cardRows(card, rows) : 0
    const forQueue = Math.max(1, rows - forCard)
    const queueRows = showQueue ? (queue.length === 0 ? 1 : planQueue(forQueue, queue.length, buttonRowsFor(cols)).rows) : 0
    const mine = (
      <Box flexDirection="column">
        {card && cardNode($, ctx, ui, card, rows, cols)}
        {showQueue && queueNode($, ctx, ui, queue, isPaused, isRunning, forQueue, cols)}
      </Box>
    )
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, rows - forCard - queueRows) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
}
