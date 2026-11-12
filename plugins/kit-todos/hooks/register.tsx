import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Memory, Shown, Snapshot, Suggestion, Todo } from '../types'
import {
  addSuggestion, checkProposal, claimIds, needsReview, planSuggestions, repoKeyOf, unclaimed, BAND_TEXT_MAX, COLORS, PANE_TEXT_MAX, STATUSES,
  SUGGESTION_NOTE_MAX, SUGGESTION_TEXT_MAX, configDirCandidates, countText, dueText, localDay, markDoneAt, newId,
  openTodos, parseIndex, parseTodosForWrite, planBand, planRows, projectSlug, recentlyDone, resolveTodosPath, shortText, soonDaysFrom,
  statusOf, taskPrompt, usableTodos, validDue, listRowTextCells, textCells,
} from './data'
import type { Status, SuggestionPlan } from './data'
import { languageFromSetting, languageOption, stringsFor } from './i18n'
import type { Lang, Strings } from './i18n'

const PANE = 'kit-todos'
const ACCENT = '#d77757'
const PANE_STEP = 50 // tasks the pane draws at first, and how many more each "Show more" adds
const LOCK_TTL = 10_000 // a lock older than this is a stopped writer's and is taken over

/** The model tool Claude proposes tasks with, and its full name as a `tool.call` hook matches it. */
const PROPOSE_TOOL = 'propose_todo'
const PROPOSE_FULL = 'mcp__kit-todos__propose_todo'
// What the model reads and is told stays English: Claude, not the person, reads it.
const PROPOSED = 'Proposed to the person; it is saved only if they approve.'
const PROPOSED_AGAIN = 'Already proposed and waiting for the person; nothing more to do.'
const PROPOSE_FULL_LIST = 'Too many suggestions are already waiting for the person. Do not propose more now; mention the remaining follow-ups in your final message instead.'
const PROPOSE_DESCRIPTION = [
  `Propose one follow-up task for the person's to-do list. Use it for work you found but are not doing now: it is out of scope, too large, or needs the person's decision.`,
  'Call it once per task. Never use it for work you are about to do in this session.',
  'Nothing is saved by this call: the person sees the task on a card and must approve it before it is written to their list.',
  `text is one short line (${SUGGESTION_TEXT_MAX} characters at most); due (YYYY-MM-DD) and note (${SUGGESTION_NOTE_MAX} characters at most, detail for whoever does the task) are optional.`,
].join(' ')
const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: SUGGESTION_TEXT_MAX, description: 'The task, in one short line.' },
    due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional due day, YYYY-MM-DD.' },
    note: { type: 'string', maxLength: SUGGESTION_NOTE_MAX, description: 'Optional detail for whoever does the task.' },
  },
  required: ['text'],
  additionalProperties: false,
}

const hiddenDay = atom({ plugin: 'kit-todos', key: 'hiddenDay' } as const, null as string | null)
const snapshot = atom({ plugin: 'kit-todos', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snap-2' })
const shown = atom({ plugin: 'kit-todos', key: 'shown' } as const, null as Shown[] | null)
const paneLimit = atom({ plugin: 'kit-todos', key: 'paneLimit' } as const, PANE_STEP)
const suggestions = atom({ plugin: 'kit-todos', key: 'suggestions' } as const, [] as Suggestion[])
const suggestionsShown = atom({ plugin: 'kit-todos', key: 'suggestionsShown' } as const, null as string[] | null)

/** The options, read once per load (a change in /config reloads the module with new ones) plus what is looked up once. */
type Config = {
  file: string; soonDays: number; showBand: boolean; showMemories: boolean; memoriesAllProfiles: boolean
  allowSuggestions: boolean; language: 'auto' | Lang
}
/** `lang` and `t` are the words in use; session.start settles them (English until then). `accepting` holds suggestions being added. */
type Ctx = { cfg: Config; home: string; dirs: string[] | null; lang: Lang; t: Strings; accepting: Set<string> }

function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return {
    file: typeof o.todosFile === 'string' ? o.todosFile : '',
    soonDays: soonDaysFrom(o.soonDays),
    showBand: o.showBand !== false,
    showMemories: o.showMemories !== false,
    memoriesAllProfiles: o.memoriesAllProfiles === true,
    allowSuggestions: o.allowSuggestions !== false,
    language: languageOption(o.language),
  }
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160)

/** The user's home folder; empty when the environment does not say. */
async function homeDir($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.home) return ctx.home
  try {
    ctx.home = ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/[\\/]+$/, '')
  } catch { /* no home known */ }
  return ctx.home
}

async function todosPath($: EngineInterface, ctx: Ctx): Promise<string> {
  return resolveTodosPath(ctx.cfg.file, await homeDir($, ctx))
}

/** Config folders that may hold this project's memories (see configDirCandidates), looked up once. */
async function findConfigDirs($: EngineInterface, ctx: Ctx): Promise<string[]> {
  if (ctx.dirs) return ctx.dirs
  let configDir: string | undefined
  try { configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || undefined } catch { /* unset */ }
  const home = await homeDir($, ctx)
  let names: string[] = []
  let isComplete = true
  if (home && ctx.cfg.memoriesAllProfiles) {
    try { names = (await $.fs.list(home)).map(entry => entry.name) } catch { isComplete = false }
  }
  const dirs = configDirCandidates(configDir, home, names, ctx.cfg.memoriesAllProfiles)
  if (isComplete) ctx.dirs = dirs
  return dirs
}

/**
 * Where the session is: the repo's folder name when it is in a git repo (a subfolder still counts), else the
 * folder's own, and the repository's stable key (repoKeyOf: its origin remote, else its root path).
 */
async function placeOf($: EngineInterface, cwd: string): Promise<{ project: string; repo?: string }> {
  try {
    const repo = await $.session.repo()
    if (repo?.root) return { project: baseName(repo.root), repo: repoKeyOf(repo.remote, repo.root) }
    return { project: baseName(cwd), repo: repoKeyOf(null, cwd) }
  } catch {
    // Unknown whether this is a repository: no key, so a task added now matches by folder name (claimable later).
    return { project: baseName(cwd) }
  }
}

/** The project's newest memories: the MEMORY.md with the newest modified time among the config folders wins. Never throws. */
async function loadMemories($: EngineInterface, ctx: Ctx, cwd: string): Promise<Memory[]> {
  try {
    let best: { dir: string; mtimeMs: number } | null = null
    for (const base of await findConfigDirs($, ctx)) {
      const dir = `${base}/projects/${projectSlug(cwd)}/memory`
      try {
        const st = await $.fs.stat(`${dir}/MEMORY.md`)
        if (!best || st.mtimeMs > best.mtimeMs) best = { dir, mtimeMs: st.mtimeMs }
      } catch { /* this folder has no memory for the project */ }
    }
    if (!best) return []
    const dir = best.dir
    const entries = parseIndex(await $.fs.read(`${dir}/MEMORY.md`)).slice(0, 200)
    const withTimes = await Promise.all(entries.map(async (one) => {
      try { return { ...one, mtimeMs: (await $.fs.stat(`${dir}/${one.file}`)).mtimeMs } } catch { return { ...one, mtimeMs: 0 } }
    }))
    return withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

/** For showing: a missing file is an empty list; one that cannot be read shows as no tasks, with the reason kept. */
async function loadTodos($: EngineInterface, ctx: Ctx): Promise<{ todos: Todo[]; problem: string | null }> {
  const file = await todosPath($, ctx)
  if (!file) return { todos: [], problem: ctx.t.noHome }
  try {
    if (!(await $.fs.exists(file))) return { todos: [], problem: null }
    return { todos: usableTodos(parseTodosForWrite(await $.fs.read(file))), problem: null }
  } catch (err) {
    return { todos: [], problem: ctx.t.cannotRead(file, reason(err)) }
  }
}

type Changed = { ok: true } | { ok: false; why: string }

type Lock = { token: string; until: number }

async function readLock($: EngineInterface, path: string): Promise<Lock | null> {
  try {
    const raw = JSON.parse(await $.fs.read(path)) as Partial<Lock>
    return typeof raw?.token === 'string' && raw.token && typeof raw.until === 'number' ? { token: raw.token, until: raw.until } : null
  } catch { return null }
}

/**
 * Takes the lock beside the todos file (`<file>.lock`), so sessions of this plugin change the list one at a time.
 * The engine has no exclusive create, so a session writes its token, waits a moment and reads it back: whoever wrote
 * last holds it, and the others wait. A lock past its time belongs to a writer that stopped and is taken over.
 * Null when it stayed busy.
 */
async function acquireLock($: EngineInterface, path: string): Promise<string | null> {
  const token = `${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const now = await $.clock.now()
    const held = await readLock($, path)
    if (held && held.token !== token && held.until > now && held.until - now <= LOCK_TTL) {
      await $.clock.sleep(50)
      continue
    }
    await $.fs.write(path, JSON.stringify({ token, until: now + LOCK_TTL }))
    await $.clock.sleep(25)
    if ((await readLock($, path))?.token === token) return token
  }
  return null
}

async function releaseLock($: EngineInterface, path: string, token: string) {
  try {
    if ((await readLock($, path))?.token === token) await $.fs.write(path, JSON.stringify({ token: '', until: 0 }))
  } catch { /* it expires */ }
}

/**
 * Changes the todos file: reads it exactly as written (throws when it cannot, so nothing is overwritten), applies
 * `change` (null means the task is gone, so nothing is written) and writes it back. `applied` says whether a list
 * already holds the change, so a change is never made twice. A failure toasts and says why.
 */
async function writeTodos(
  $: EngineInterface, ctx: Ctx, change: (list: unknown[]) => unknown[] | null, applied: (list: unknown[]) => boolean,
): Promise<Changed> {
  const file = await todosPath($, ctx)
  let lock: { path: string; token: string } | null = null
  let wrote = false
  try {
    if (!file) throw new Error(ctx.t.noHome)
    // Sessions of this plugin take turns through the lock. Anyone else (Claude finishing a task, an editor) may still
    // write meanwhile: write only if the file is still the one that was read, and read it back after writing; when
    // the change is not there, someone wrote over it, so apply it again to what they wrote.
    const token = await acquireLock($, `${file}.lock`)
    if (!token) return failed($, ctx, ctx.t.busy)
    lock = { path: `${file}.lock`, token }
    const stamp = async () => { try { const st = await $.fs.stat(file); return `${st.size}:${st.mtimeMs}` } catch { return 'none' } }
    const readList = async () => parseTodosForWrite((await $.fs.exists(file)) ? await $.fs.read(file) : null)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await stamp()
      const list = await readList()
      if (applied(list)) return { ok: true }
      const next = change(list)
      if (!next) return failed($, ctx, ctx.t.taskGone)
      if ((await stamp()) !== before) continue
      if ((await readLock($, lock.path))?.token !== token) return failed($, ctx, ctx.t.busy)
      await $.fs.write(file, JSON.stringify(next, null, 2) + '\n')
      wrote = true
      if (applied(await readList())) return { ok: true }
    }
    return failed($, ctx, wrote ? ctx.t.keptChangingWrote : ctx.t.keptChangingNotWritten)
  } catch (err) {
    return failed($, ctx, ctx.t.writeError(file || ctx.t.theTodoFile, wrote, reason(err)))
  } finally {
    if (lock) await releaseLock($, lock.path, lock.token)
  }
}

async function failed($: EngineInterface, ctx: Ctx, why: string): Promise<Changed> {
  try { await $.ui.toast(ctx.t.updateFailed(why)) } catch { /* the reply still says why */ }
  return { ok: false, why }
}

/** Reloads the file and the memories into the snapshot and the status line. Never throws; a failure keeps the last snapshot. */
async function refresh($: EngineInterface, ctx: Ctx) {
  try {
    const cwd = await $.session.cwd()
    const [loaded, memories, place] = await Promise.all([
      loadTodos($, ctx),
      ctx.cfg.showMemories ? loadMemories($, ctx, cwd) : Promise.resolve([] as Memory[]),
      placeOf($, cwd),
    ])
    const now = await $.clock.now()
    const snap: Snapshot = { todos: loaded.todos, problem: loaded.problem, memories, ...place, loadedAt: now }
    await update($, snapshot, () => snap)
    const open = openTodos(snap, now, ctx.cfg.soonDays)
    await $.ui.status(open.length ? `✻ ${countText(open, now, ctx.cfg.soonDays, ctx.t)}` : undefined)
  } catch { /* keep what was shown */ }
}

const entryOf = (t: unknown): Record<string, unknown> => (t && typeof t === 'object' ? t as Record<string, unknown> : {})

async function markDone($: EngineInterface, ctx: Ctx, todo: Pick<Todo, 'id' | 'index'>): Promise<Changed> {
  const doneAt = new Date(await $.clock.now()).toISOString()
  const result = await writeTodos($, ctx, list => markDoneAt(list, todo.index, todo.id, doneAt),
    list => list.some(t => entryOf(t).id === todo.id && entryOf(t).done === true && entryOf(t).doneAt === doneAt))
  await refresh($, ctx)
  return result
}

/** Adds a task to the file. `extra`: the due day and note of an approved suggestion, saved with it as the card showed them. */
async function addTodo($: EngineInterface, ctx: Ctx, text: string, extra: { due?: string; note?: string } = {}): Promise<Changed> {
  const { project, repo } = await placeOf($, await $.session.cwd())
  const now = await $.clock.now()
  let id = ''
  const result = await writeTodos($, ctx, (list) => {
    id ||= newId(list, now) // one id for every attempt, so a read-back finds the entry this write added
    return [...list, { id, text, project, repo, ...(extra.due ? { due: extra.due } : {}), ...(extra.note ? { note: extra.note } : {}), done: false }]
  }, list => !!id && list.some(t => entryOf(t).id === id && entryOf(t).text === text))
  await refresh($, ctx)
  return result
}

/** Links the open tasks for this folder name to this repository (`/todo claim`). */
async function claimTodos($: EngineInterface, ctx: Ctx): Promise<{ result: Changed; count: number }> {
  await refresh($, ctx)
  const snap = await read($, snapshot)
  const repo = snap?.repo
  if (!snap || !repo) return { result: { ok: false, why: ctx.t.repoUnknown }, count: 0 }
  const ids = new Set(unclaimed(snap.todos, snap).map(t => t.id))
  if (!ids.size) return { result: { ok: true }, count: 0 }
  const place = { project: snap.project, repo }
  // Found by id, not position, so entries added or removed above them meanwhile change nothing; `count` is what was tied.
  let count = 0
  const result = await writeTodos($, ctx, (list) => {
    const out = claimIds(list, ids, place)
    count = out.tied
    return out.list
  }, list => claimIds(list, ids, place).tied === 0)
  await refresh($, ctx)
  return { result, count }
}

/** Hides the band until tomorrow, by the clock at the moment of the press. */
async function hideToday($: EngineInterface) {
  const now = await $.clock.now()
  await update($, hiddenDay, () => localDay(now))
}

async function doNow($: EngineInterface, ctx: Ctx, todo: Todo, shownCells = Infinity) {
  const file = await todosPath($, ctx)
  if (needsReview(todo, shownCells)) {
    // The prompt holds text the card did not show: put it in the prompt box to read first.
    await $.prompt.fill({ text: taskPrompt(todo, file), mode: 'replace' })
    try { await $.ui.toast(ctx.t.reviewToast) } catch { /* drafted anyway */ }
    return
  }
  await hideToday($)
  $.prompt.submit({ text: taskPrompt(todo, file) }).catch(err => $.ui.toast(ctx.t.handOffFailed(String(err))))
}

async function draft($: EngineInterface, ctx: Ctx, todo: Todo) {
  await $.prompt.fill({ text: taskPrompt(todo, await todosPath($, ctx)), mode: 'replace' })
}

async function openPane($: EngineInterface, ctx: Ctx) {
  await $.ui.open({ id: PANE, title: ctx.t.paneTitle })
}

/** The words in use: the `language` option, or for `auto` Claude Code's own `language` setting (read once; English when it cannot be). */
async function settleLanguage($: EngineInterface, ctx: Ctx) {
  let lang: Lang = ctx.cfg.language === 'auto' ? 'en' : ctx.cfg.language
  if (ctx.cfg.language === 'auto') {
    try { lang = languageFromSetting(await $.settings.read({ key: 'language' })) } catch { /* English */ }
  }
  ctx.lang = lang
  ctx.t = stringsFor(lang)
}

// --- suggestions from Claude -----------------------------------------------------------------------------------

/** Adds a suggestion to the list file exactly as the person saw it, then drops it. Null when it is gone or already being added. */
async function acceptSuggestion($: EngineInterface, ctx: Ctx, id: string): Promise<{ s: Suggestion; result: Changed } | null> {
  const s = (await read($, suggestions)).find(x => x.id === id)
  if (!s || ctx.accepting.has(id)) return null
  ctx.accepting.add(id)
  try {
    const result = await addTodo($, ctx, s.text, { due: s.due, note: s.note })
    if (result.ok) await update($, suggestions, list => list.filter(x => x.id !== id))
    return { s, result }
  } finally {
    ctx.accepting.delete(id)
  }
}

async function dismissSuggestion($: EngineInterface, id: string) {
  await update($, suggestions, list => list.filter(x => x.id !== id))
}

/** The Add button of a suggestion: the same path as /todo add, then a toast with the result (a failure toasts its own reason). */
async function addButton($: EngineInterface, ctx: Ctx, id: string) {
  const out = await acceptSuggestion($, ctx, id)
  if (out?.result.ok) { try { await $.ui.toast(ctx.t.suggestionAdded(out.s.text)) } catch { /* it is in the list anyway */ } }
}

/** Serves the propose_todo tool: validates, keeps the proposal in the session until the person decides, writes nothing. */
async function proposeTodo($: EngineInterface, ctx: Ctx, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const checked = checkProposal(input)
  if (!checked.ok) return { deny: checked.why }
  const now = await $.clock.now()
  const verdict: { status: 'added' | 'duplicate' | 'full' } = { status: 'added' }
  await update($, suggestions, (list) => {
    const out = addSuggestion(list, checked.proposal, `s${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
    verdict.status = out.status
    return out.list
  })
  if (verdict.status === 'full') return { deny: PROPOSE_FULL_LIST }
  if (verdict.status === 'duplicate') return { result: PROPOSED_AGAIN }
  try { await $.ui.toast(ctx.t.suggestionArrived(checked.proposal.text)) } catch { /* the band still shows it */ }
  return { result: PROPOSED }
}

// --- the module ------------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const ctx: Ctx = { cfg: readConfig(options), home: '', dirs: null, lang: 'en', t: stringsFor('en'), accepting: new Set() }

  on('session.start', async ($, e, next) => {
    // The to-do list never blocks a session from starting.
    try { await settleLanguage($, ctx) } catch { /* English */ }
    const withSuggestions = ctx.cfg.allowSuggestions
    try {
      await $.command.register({
        name: 'todo',
        description: ctx.t.commandDescription(withSuggestions),
        argumentHint: ctx.t.commandHint(withSuggestions),
      })
    } catch { /* no command, the band still works */ }
    if (withSuggestions) {
      try {
        await $.tool.register({ name: PROPOSE_TOOL, description: PROPOSE_DESCRIPTION, inputSchema: PROPOSE_SCHEMA, isDeferred: false })
      } catch { /* Claude cannot propose tasks; the rest works */ }
    }
    try {
      await refresh($, ctx)
      await $.clock.every(60_000, () => { void refresh($, ctx) })
    } catch { /* no refresh timer */ }
    return next(e)
  })

  if (ctx.cfg.allowSuggestions) {
    on('tool.call', { tool: PROPOSE_FULL }, async ($, e) => proposeTodo($, ctx, e as unknown as Record<string, unknown>))
      .catch(() => ({ deny: 'The suggestion could not be recorded. Mention it in your final message instead.' }))
  }

  on('turn.complete', async ($, e, next) => {
    await refresh($, ctx)
    return next(e)
  })

  on('command.run', { command: 'todo' }, async ($, e) => runCommand($, ctx, String(e.args ?? '').trim()))
  // The band above the prompt is one site shared by every plugin: draw this plugin's part, then the parts of the
  // plugins beneath it (next), stacked, so several bands show together. A part that passes hands the site on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let passed = false
    const pass = (x: typeof e) => { passed = true; return next(x) }
    const mine = await renderBand($, ctx, e, pass)
    if (passed) return mine
    const { Box } = $.ui.resolve(e)
    // The plugins beneath get the rows this part leaves, so the stacked band fits without scrolling.
    const used = bandRows
    const rest = await next({ ...e, props: { ...e.props, maxRows: Math.max(1, e.props.maxRows - used) } })
    return <Box flexDirection="column">{mine}{rest}</Box>
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, ctx, e))
}

/** `/todo accept|reject <number|all>`: the ids of the suggestions it names, from the last /todo suggestions list. */
async function pickedSuggestions($: EngineInterface, ctx: Ctx, verb: 'accept' | 'reject', tail: string): Promise<{ ids: string[] } | { text: string }> {
  const usage = verb === 'accept' ? ctx.t.usageAccept : ctx.t.usageReject
  if (!/^(\d+|all)$/i.test(tail)) return { text: usage }
  const listed = await read($, suggestionsShown)
  if (!listed) return { text: ctx.t.suggestFirst(verb) }
  const pending = new Set((await read($, suggestions)).map(s => s.id))
  if (/^all$/i.test(tail)) {
    const ids = listed.filter(id => pending.has(id))
    return ids.length ? { ids } : { text: ctx.t.nothingToHandle }
  }
  const id = listed[Number(tail) - 1]
  if (!id) return { text: ctx.t.noSuchSuggestion(tail) }
  return pending.has(id) ? { ids: [id] } : { text: ctx.t.nothingToHandle }
}

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<{ text: string }> {
  const t = ctx.t
  const usage = t.usage(ctx.cfg.allowSuggestions)
  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args)
  const verb = (parts?.[1] ?? '').toLowerCase()
  const tail = (parts?.[2] ?? '').trim()
  if (verb === 'add') {
    if (!tail) return { text: t.usageAdd }
    const result = await addTodo($, ctx, tail)
    return { text: result.ok ? t.added(tail) : t.addFailed(result.why) }
  }
  if (verb === 'done') {
    if (!/^\d+$/.test(tail)) return { text: t.usageDone }
    // The number is the one the last /todo of this session printed. The list may have changed since (another session
    // added an overdue task), and the task the person saw at that number is the one to mark.
    const list = await read($, shown)
    if (!list) return { text: t.doneFirst }
    const picked = list[Number(tail) - 1]
    if (!picked) return { text: t.noSuchTask(tail) }
    const result = await markDone($, ctx, picked)
    return { text: result.ok ? t.doneOk(picked.text) : t.doneFailed(shortText(picked.text, 80), result.why) }
  }
  if (verb === 'claim') {
    if (tail) return { text: usage }
    const { result, count } = await claimTodos($, ctx)
    if (!result.ok) return { text: t.claimFailed(result.why) }
    return { text: count ? t.claimed(count) : t.nothingToClaim }
  }
  if (ctx.cfg.allowSuggestions && verb === 'suggestions') {
    if (tail) return { text: usage }
    const pending = await read($, suggestions)
    await update($, suggestionsShown, () => pending.map(s => s.id))
    if (!pending.length) return { text: t.suggestNone }
    const now = await $.clock.now()
    // The whole text and note, as Add will save them: nothing is cut.
    const lines = pending.map((s, i) =>
      `${i + 1}. ${s.text}${validDue(s) ? ` - ${dueText(s, now, t)}` : ''}${s.note ? ` (${t.suggestNoteInList(s.note)})` : ''}`)
    return { text: [t.suggestHeader(pending.length), ...lines, t.suggestFooter].join('\n') }
  }
  if (ctx.cfg.allowSuggestions && (verb === 'accept' || verb === 'reject')) {
    const picked = await pickedSuggestions($, ctx, verb, tail)
    if ('text' in picked) return picked
    if (verb === 'reject') {
      const texts = (await read($, suggestions)).filter(s => picked.ids.includes(s.id)).map(s => s.text)
      await update($, suggestions, list => list.filter(s => !picked.ids.includes(s.id)))
      return { text: texts.length === 1 ? t.rejectedOne(texts[0] ?? '') : t.rejectedMany(texts.length) }
    }
    // One at a time: each add takes the file's lock in turn.
    const added: string[] = []
    const problems: string[] = []
    for (const id of picked.ids) {
      const out = await acceptSuggestion($, ctx, id)
      if (!out) continue
      if (out.result.ok) added.push(out.s.text)
      else problems.push(t.acceptFailed(shortText(out.s.text, 80), out.result.why))
    }
    const head = added.length === 1 ? [t.acceptedOne(added[0] ?? '')] : added.length ? [t.acceptedMany(added.length)] : []
    return { text: [...head, ...problems].join('\n') || t.nothingToHandle }
  }
  if (verb) return { text: usage }
  await update($, hiddenDay, () => null)
  await refresh($, ctx)
  await openPane($, ctx)
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const soonDays = ctx.cfg.soonDays
  const open = openTodos(snap, now, soonDays)
  await update($, shown, () => open.map(x => ({ id: x.id, index: x.index, text: x.text })))
  const lines = open.map((x, i) => {
    const label = t.status[statusOf(x, now, soonDays)]
    return `${i + 1}. [${label}] ${shortText(x.text, 200)}${validDue(x) ? ` - ${dueText(x, now, t)}` : ''}`
  })
  const claimable = snap ? unclaimed(snap.todos, snap) : []
  const loose = claimable.filter(x => !x.repo).length // shown here by folder name only
  const elsewhere = claimable.length - loose // named for this folder but tied to another repository key, so hidden
  const hints = [
    ...(loose ? [t.looseHint(loose)] : []),
    ...(elsewhere ? [t.elsewhereHint(elsewhere)] : []),
  ]
  return {
    text: [
      t.listHeader(snap?.project ?? t.thisProject, lines.length),
      ...(lines.length ? lines : [t.noOpen]),
      ...(hints.length ? [...hints, t.claimHint] : []),
      ...(snap?.problem ? [t.warning(snap.problem)] : []),
      t.listFile(await todosPath($, ctx) || t.unknownFile),
    ].join('\n'),
  }
}

function palette(surface: string): Record<Status, string> {
  return surface === 'terminal' ? COLORS.dark : COLORS.light
}

function legend(ctx: Ctx, ui: any, colors: Record<Status, string>) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {STATUSES.map(s => <Text key={`lg-${s.id}`} color={colors[s.id]}>● {ctx.t.status[s.id]}</Text>)}
    </Box>
  )
}

function card($: EngineInterface, ctx: Ctx, ui: any, todo: Todo, now: number, colors: Record<Status, string>, opts: { width?: number; textMax: number; withDone: boolean }) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  const status = statusOf(todo, now, ctx.cfg.soonDays)
  return (
    <Box key={`card-${todo.index}`} flexDirection="column" borderStyle="round" borderColor={colors[status]} paddingX={1} width={opts.width}>
      <Text color={colors[status]}>● {t.status[status]}</Text>
      <Text bold={status !== 'done'} strikethrough={status === 'done'} dimColor={status === 'done'}>{shortText(todo.text, opts.textMax)}</Text>
      {validDue(todo) && status !== 'done' && <Text dimColor>{dueText(todo, now, t)}</Text>}
      {status !== 'done' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key={`now-${todo.index}`} variant="primary" label={t.buttons.now} onPress={() => doNow($, ctx, todo)} />
          <Button key={`draft-${todo.index}`} label={t.buttons.draft} onPress={() => draft($, ctx, todo)} />
          {opts.withDone && <Button key={`done-${todo.index}`} label={t.buttons.done} onPress={() => markDone($, ctx, todo)} />}
        </Box>
      )}
    </Box>
  )
}

// Rows the last drawn band took, for the bands of the plugins beneath (set by renderBand, read right after it).
let bandRows = 0

async function renderBand($: EngineInterface, ctx: Ctx, e: any, next: any) {
  if (!ctx.cfg.showBand) return next(e)
  const t = ctx.t
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const todos = openTodos(snap, now, ctx.cfg.soonDays)
  const pending = await read($, suggestions)
  if (e.props.hasSurvey || e.props.isWorking) return next(e)
  // Suggestions wait for a decision, so "Hide today" (which hides the task list) leaves them showing.
  const showTasks = !!snap && todos.length > 0 && (await read($, hiddenDay)) !== localDay(now)
  if (!showTasks && pending.length === 0) return next(e)
  const ui = $.ui.resolve(e)
  const rows: number = e.props.maxRows ?? 40
  const cols: number = e.props.bodyColumns ?? 100
  // Suggestions come first; the tasks get the rows they leave, so the whole band never scrolls (it caps at half the terminal).
  const sugPlan = planSuggestions(rows, cols, pending, showTasks, now, t)
  const sugNode = sugPlan.mode === 'none' ? null : suggestionBand($, ctx, ui, pending, sugPlan, now)
  if (!showTasks || !snap) {
    if (!sugNode) return next(e)
    bandRows = sugPlan.rows
    return sugNode
  }
  const plan = planBand(Math.max(1, rows - sugPlan.rows), cols, todos, t)
  bandRows = sugPlan.rows + planRows(plan, todos, t)
  const colors = palette(e.surface)
  let tasksNode
  if (plan.mode === 'line') {
    tasksNode = bandLine($, ctx, ui, todos, now)
  } else {
    const { Box, Text } = ui
    const newest = ctx.cfg.showMemories ? snap.memories[0] : undefined
    const shown = plan.mode === 'cards' ? plan.perRow : plan.shown
    tasksNode = (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end"><Text color={ACCENT}>✻</Text> <Text bold>{t.bandTitle(snap.project)}</Text></Text>
          <Text dimColor>{countText(todos, now, ctx.cfg.soonDays, t)}</Text>
        </Box>
        {plan.mode === 'cards'
          ? <Box flexDirection="row" columnGap={1}>{todos.slice(0, shown).map(x => card($, ctx, ui, x, now, colors, { width: plan.cardWidth, textMax: BAND_TEXT_MAX, withDone: false }))}</Box>
          : todos.slice(0, shown).map(x => listRow($, ctx, ui, x, now, colors, plan.rowButtons, cols))}
        {todos.length > shown && <Text dimColor>{t.moreInList(todos.length - shown)}</Text>}
        {plan.mode === 'cards' && plan.showLegend && legend(ctx, ui, colors)}
        {plan.showMemory && newest && <Text dimColor wrap="truncate-end">{t.latestMemoryPrefix}<Text bold dimColor={false}>{shortText(newest.title, 80)}</Text>{t.latestMemorySuffix(snap.memories.length)}</Text>}
        {bandActions($, ctx, ui)}
      </Box>
    )
  }
  if (!sugNode) return tasksNode
  const { Box } = ui
  return <Box flexDirection="column">{sugNode}{tasksNode}</Box>
}

function bandActions($: EngineInterface, ctx: Ctx, ui: any) {
  const { Box, Button } = ui
  return (
    <Box flexDirection="row" columnGap={1}>
      <Button key="open" label={ctx.t.buttons.open} onPress={() => openPane($, ctx)} />
      <Button key="hide" label={ctx.t.buttons.hide} onPress={() => hideToday($)} />
    </Box>
  )
}

/** The text of a suggestion as the person reads it, and as Add saves it: nothing hidden, nothing cut. */
function suggestionLine(ctx: Ctx, s: Suggestion, now: number): string {
  return `${ctx.t.suggests}${s.text}${validDue(s) ? ` (${dueText(s, now, ctx.t)})` : ''}`
}

/** Pending suggestions above the task band: one row each with Add and Dismiss, or one line when there is no room for a whole one. */
function suggestionBand($: EngineInterface, ctx: Ctx, ui: any, pending: Suggestion[], plan: SuggestionPlan, now: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  if (plan.mode === 'line') {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>✻</Text> {t.suggestionsLine(pending.length)}</Text></Box>
        <Button key="sug-review" label={t.buttons.review} onPress={() => openPane($, ctx)} />
      </Box>
    )
  }
  const count = plan.mode === 'box' ? plan.shown : 0
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      {pending.slice(0, count).map(s => (
        <Box key={`sug-${s.id}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box flexGrow={1} flexShrink={1}><Text wrap="wrap">{suggestionLine(ctx, s, now)}</Text></Box>
            <Button key={`sug-add-${s.id}`} variant="primary" label={t.buttons.add} onPress={() => addButton($, ctx, s.id)} />
            <Button key={`sug-no-${s.id}`} label={t.buttons.dismiss} onPress={() => dismissSuggestion($, s.id)} />
          </Box>
          {s.note && <Text dimColor wrap="wrap">{`${t.noteLabel}${s.note}`}</Text>}
        </Box>
      ))}
      {pending.length > count && <Text dimColor>{t.suggestionsMoreInBand(pending.length - count)}</Text>}
    </Box>
  )
}

/** One suggestion in the pane, whole. */
function suggestionCard($: EngineInterface, ctx: Ctx, ui: any, s: Suggestion, now: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  return (
    <Box key={`sugcard-${s.id}`} flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold wrap="wrap">{suggestionLine(ctx, s, now)}</Text>
      {s.note && <Text dimColor wrap="wrap">{`${t.noteLabel}${s.note}`}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key={`sug-add-${s.id}`} variant="primary" label={t.buttons.add} onPress={() => addButton($, ctx, s.id)} />
        <Button key={`sug-no-${s.id}`} label={t.buttons.dismiss} onPress={() => dismissSuggestion($, s.id)} />
      </Box>
    </Box>
  )
}

/** One task per row: coloured dot, text cut to the width, due date, and the two buttons when they fit. */
function listRow($: EngineInterface, ctx: Ctx, ui: any, todo: Todo, now: number, colors: Record<Status, string>, withButtons: boolean, cols: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  const status = statusOf(todo, now, ctx.cfg.soonDays)
  // The row cuts the text to its width: a text wider than that was not seen whole, so "Do it now" drafts it.
  const room = listRowTextCells(cols, validDue(todo) ? textCells(dueText(todo, now, t)) : 0, withButtons, t)
  return (
    <Box key={`row-${todo.index}`} flexDirection="row" columnGap={1}>
      <Text color={colors[status]}>●</Text>
      <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end">{shortText(todo.text, BAND_TEXT_MAX)}</Text></Box>
      {validDue(todo) && <Text color={colors[status]}>{dueText(todo, now, t)}</Text>}
      {withButtons && <Button key={`now-${todo.index}`} variant="primary" label={t.buttons.now} onPress={() => doNow($, ctx, todo, room)} />}
      {withButtons && <Button key={`draft-${todo.index}`} label={t.buttons.draft} onPress={() => draft($, ctx, todo)} />}
    </Box>
  )
}

/** The smallest band: one line, no border. */
function bandLine($: EngineInterface, ctx: Ctx, ui: any, todos: Todo[], now: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>✻</Text> {countText(todos, now, ctx.cfg.soonDays, ctx.t)}</Text></Box>
      {bandActions($, ctx, ui)}
    </Box>
  )
}

async function renderPane($: EngineInterface, ctx: Ctx, e: any) {
  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  const t = ctx.t
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const colors = palette(e.surface)
  const todos = openTodos(snap, now, ctx.cfg.soonDays)
  const pending = await read($, suggestions)
  const limit = await read($, paneLimit)
  const done = recentlyDone(snap, now).slice(0, 10)
  const memories = ctx.cfg.showMemories ? (snap?.memories ?? []).slice(0, 3) : []
  const cardOpts = { textMax: PANE_TEXT_MAX }
  return (
    <Box flexDirection="column" rowGap={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text><Text color={ACCENT}>✻</Text> <Text bold>{t.paneTitle}</Text></Text>
        <Text dimColor>{countText(todos, now, ctx.cfg.soonDays, t)}</Text>
      </Box>
      {legend(ctx, ui, colors)}
      {snap?.problem ? <Text color={colors.over}>{shortText(t.problemUntouched(snap.problem), 300)}</Text> : null}
      {pending.length > 0 && <Text bold>{t.suggestionsHeading(pending.length)}</Text>}
      {pending.map(s => suggestionCard($, ctx, ui, s, now))}
      {todos.length === 0 && <Text dimColor>{t.noOpen}</Text>}
      {todos.slice(0, limit).map(x => card($, ctx, ui, x, now, colors, { ...cardOpts, withDone: true }))}
      {todos.length > limit && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{t.moreOpen(todos.length - limit)}</Text>
          <Button key="more" label={t.buttons.more} onPress={() => update($, paneLimit, n => n + PANE_STEP)} />
        </Box>
      )}
      {done.map(x => card($, ctx, ui, x, now, colors, { ...cardOpts, withDone: false }))}
      {memories.length > 0 && <Text bold>{t.recentMemories}</Text>}
      {memories.map(m => (
        <Box key={`m-${m.file}`} flexDirection="column">
          <Text>{shortText(m.title, 120)}</Text>
          <Text dimColor>{shortText(m.hook, 200)}</Text>
        </Box>
      ))}
      <Text dimColor>{t.addHint}</Text>
    </Box>
  )
}
