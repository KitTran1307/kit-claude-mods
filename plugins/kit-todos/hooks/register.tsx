import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Memory, Shown, Snapshot, Todo } from '../types'
import {
  claimIds, needsReview, repoKeyOf, unclaimed, BAND_TEXT_MAX, COLORS, LABELS, PANE_TEXT_MAX, STATUSES, configDirCandidates, countText, dueText, localDay, markDoneAt, newId,
  openTodos, parseIndex, parseTodosForWrite, planBand, planRows, projectSlug, recentlyDone, resolveTodosPath, shortText, soonDaysFrom,
  statusOf, taskPrompt, usableTodos, validDue, listRowTextCells, textCells,
} from './data'
import type { Status } from './data'

const PANE = 'kit-todos'
const ACCENT = '#d77757'
const PANE_STEP = 50 // tasks the pane draws at first, and how many more each "Show more" adds
const USAGE = 'Usage: /todo | /todo add <task> | /todo done <number> | /todo claim'
const LOCK_TTL = 10_000 // a lock older than this is a stopped writer's and is taken over
const BUSY = 'another session is changing the list right now. Nothing was written; try again in a moment.'
const NO_HOME = 'The home folder is unknown, so the to-do file cannot be placed. Set the todosFile option to a full path.'

const hiddenDay = atom({ plugin: 'kit-todos', key: 'hiddenDay' } as const, null as string | null)
const snapshot = atom({ plugin: 'kit-todos', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snap-2' })
const shown = atom({ plugin: 'kit-todos', key: 'shown' } as const, null as Shown[] | null)
const paneLimit = atom({ plugin: 'kit-todos', key: 'paneLimit' } as const, PANE_STEP)

/** The options, read once per load (a change in /config reloads the module with new ones) plus what is looked up once. */
type Config = { file: string; soonDays: number; showBand: boolean; showMemories: boolean; memoriesAllProfiles: boolean }
type Ctx = { cfg: Config; home: string; dirs: string[] | null }

function readConfig(options: PluginOptions | undefined): Config {
  const o = options ?? {}
  return {
    file: typeof o.todosFile === 'string' ? o.todosFile : '',
    soonDays: soonDaysFrom(o.soonDays),
    showBand: o.showBand !== false,
    showMemories: o.showMemories !== false,
    memoriesAllProfiles: o.memoriesAllProfiles === true,
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
  if (!file) return { todos: [], problem: NO_HOME }
  try {
    if (!(await $.fs.exists(file))) return { todos: [], problem: null }
    return { todos: usableTodos(parseTodosForWrite(await $.fs.read(file))), problem: null }
  } catch (err) {
    return { todos: [], problem: `${file} could not be read: ${reason(err)}.` }
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
    if (!file) throw new Error(NO_HOME)
    // Sessions of this plugin take turns through the lock. Anyone else (Claude finishing a task, an editor) may still
    // write meanwhile: write only if the file is still the one that was read, and read it back after writing; when
    // the change is not there, someone wrote over it, so apply it again to what they wrote.
    const token = await acquireLock($, `${file}.lock`)
    if (!token) return failed($, BUSY)
    lock = { path: `${file}.lock`, token }
    const stamp = async () => { try { const st = await $.fs.stat(file); return `${st.size}:${st.mtimeMs}` } catch { return 'none' } }
    const readList = async () => parseTodosForWrite((await $.fs.exists(file)) ? await $.fs.read(file) : null)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await stamp()
      const list = await readList()
      if (applied(list)) return { ok: true }
      const next = change(list)
      if (!next) return failed($, 'that task is no longer in the file, so nothing was changed.')
      if ((await stamp()) !== before) continue
      if ((await readLock($, lock.path))?.token !== token) return failed($, BUSY)
      await $.fs.write(file, JSON.stringify(next, null, 2) + '\n')
      wrote = true
      if (applied(await readList())) return { ok: true }
    }
    return failed($, wrote
      ? 'the file kept changing while it was being updated, and the change is not in it now. Check the file, then try again.'
      : 'the file kept changing while it was being updated. Nothing was written; try again.')
  } catch (err) {
    const what = wrote ? 'was written, but reading it back failed' : 'could not be changed'
    return failed($, `${file || 'the to-do file'} ${what}: ${reason(err)}.${wrote ? ' Check the file.' : ' Nothing was written.'}`)
  } finally {
    if (lock) await releaseLock($, lock.path, lock.token)
  }
}

async function failed($: EngineInterface, why: string): Promise<Changed> {
  try { await $.ui.toast(`Could not update your to-do list: ${why}`) } catch { /* the reply still says why */ }
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
    await $.ui.status(open.length ? `✻ ${countText(open, now, ctx.cfg.soonDays)}` : undefined)
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

async function addTodo($: EngineInterface, ctx: Ctx, text: string): Promise<Changed> {
  const { project, repo } = await placeOf($, await $.session.cwd())
  const now = await $.clock.now()
  let id = ''
  const result = await writeTodos($, ctx, (list) => {
    id ||= newId(list, now) // one id for every attempt, so a read-back finds the entry this write added
    return [...list, { id, text, project, repo, done: false }]
  }, list => !!id && list.some(t => entryOf(t).id === id && entryOf(t).text === text))
  await refresh($, ctx)
  return result
}

/** Links the open tasks for this folder name to this repository (`/todo claim`). */
async function claimTodos($: EngineInterface, ctx: Ctx): Promise<{ result: Changed; count: number }> {
  await refresh($, ctx)
  const snap = await read($, snapshot)
  const repo = snap?.repo
  if (!snap || !repo) return { result: { ok: false, why: 'the repository of this session is unknown.' }, count: 0 }
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
    try { await $.ui.toast('The prompt holds more than the card shows (a note, long or multi-line text, an unusual id or hidden characters): read it in the prompt box, then send it.') } catch { /* drafted anyway */ }
    return
  }
  await hideToday($)
  $.prompt.submit({ text: taskPrompt(todo, file) }).catch(err => $.ui.toast(`Could not hand the task to Claude: ${String(err)}`))
}

async function draft($: EngineInterface, ctx: Ctx, todo: Todo) {
  await $.prompt.fill({ text: taskPrompt(todo, await todosPath($, ctx)), mode: 'replace' })
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'To-do list' })
}

export const register: Register = (on, options) => {
  const ctx: Ctx = { cfg: readConfig(options), home: '', dirs: null }

  on('session.start', async ($, e, next) => {
    // The to-do list never blocks a session from starting.
    try {
      await $.command.register({
        name: 'todo',
        description: 'To-do list: open the pane, /todo add <task>, /todo done <number>, /todo claim',
        argumentHint: '[add <task> | done <number> | claim]',
      })
    } catch { /* no command, the band still works */ }
    try {
      await refresh($, ctx)
      await $.clock.every(60_000, () => { void refresh($, ctx) })
    } catch { /* no refresh timer */ }
    return next(e)
  })

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

async function runCommand($: EngineInterface, ctx: Ctx, args: string): Promise<{ text: string }> {
  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args)
  const verb = (parts?.[1] ?? '').toLowerCase()
  const tail = (parts?.[2] ?? '').trim()
  if (verb === 'add') {
    if (!tail) return { text: 'Usage: /todo add <task>' }
    const result = await addTodo($, ctx, tail)
    return { text: result.ok ? `Added: ${tail}` : `Could not add the task: ${result.why}` }
  }
  if (verb === 'done') {
    if (!/^\d+$/.test(tail)) return { text: 'Usage: /todo done <number> (the number in the /todo list)' }
    // The number is the one the last /todo of this session printed. The list may have changed since (another session
    // added an overdue task), and the task the person saw at that number is the one to mark.
    const list = await read($, shown)
    if (!list) return { text: 'Type /todo first to see the numbered list, then /todo done <number>.' }
    const picked = list[Number(tail) - 1]
    if (!picked) return { text: `There is no task ${tail} in the last /todo list. Type /todo to see it again.` }
    const result = await markDone($, ctx, picked)
    return { text: result.ok ? `Done: ${picked.text}` : `Could not mark "${shortText(picked.text, 80)}" done: ${result.why}` }
  }
  if (verb === 'claim') {
    if (tail) return { text: USAGE }
    const { result, count } = await claimTodos($, ctx)
    if (!result.ok) return { text: `Could not claim the tasks: ${result.why}` }
    return { text: count ? `Linked ${count} ${count === 1 ? 'task' : 'tasks'} to this repository.` : 'Nothing to claim: every task for this folder name is already linked to this repository.' }
  }
  if (verb) return { text: USAGE }
  await update($, hiddenDay, () => null)
  await refresh($, ctx)
  await openPane($)
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const soonDays = ctx.cfg.soonDays
  const open = openTodos(snap, now, soonDays)
  await update($, shown, () => open.map(t => ({ id: t.id, index: t.index, text: t.text })))
  const lines = open.map((t, i) => {
    const label = STATUSES.find(s => s.id === statusOf(t, now, soonDays))?.label
    return `${i + 1}. [${label}] ${shortText(t.text, 200)}${validDue(t) ? ` - ${dueText(t, now)}` : ''}`
  })
  const claimable = snap ? unclaimed(snap.todos, snap) : []
  const loose = claimable.filter(t => !t.repo).length // shown here by folder name only
  const elsewhere = claimable.length - loose // named for this folder but tied to another repository key, so hidden
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const hints = [
    ...(loose ? [`${n(loose, 'task is', 'tasks are')} matched by folder name only, so other folders with this name show ${loose === 1 ? 'it' : 'them'} too.`] : []),
    ...(elsewhere ? [`${n(elsewhere, 'task for this folder name is', 'tasks for this folder name are')} linked to another repository and hidden here (for example after you moved this repository or changed its remote).`] : []),
  ]
  return {
    text: [
      `Tasks for ${snap?.project ?? 'this project'} (${lines.length}):`,
      ...(lines.length ? lines : ['No open tasks. Add one with /todo add <task>.']),
      ...(hints.length ? [...hints, 'Run /todo claim to link them to this repository.'] : []),
      ...(snap?.problem ? [`Warning: ${snap.problem}`] : []),
      `List file: ${await todosPath($, ctx) || '(unknown)'}`,
    ].join('\n'),
  }
}

function palette(surface: string): Record<Status, string> {
  return surface === 'terminal' ? COLORS.dark : COLORS.light
}

function legend(ui: any, colors: Record<Status, string>) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {STATUSES.map(s => <Text key={`lg-${s.id}`} color={colors[s.id]}>● {s.label}</Text>)}
    </Box>
  )
}

function card($: EngineInterface, ctx: Ctx, ui: any, todo: Todo, now: number, colors: Record<Status, string>, opts: { width?: number; textMax: number; withDone: boolean }) {
  const { Box, Button, Text } = ui
  const status = statusOf(todo, now, ctx.cfg.soonDays)
  const label = STATUSES.find(s => s.id === status)?.label ?? ''
  return (
    <Box key={`card-${todo.index}`} flexDirection="column" borderStyle="round" borderColor={colors[status]} paddingX={1} width={opts.width}>
      <Text color={colors[status]}>● {label}</Text>
      <Text bold={status !== 'done'} strikethrough={status === 'done'} dimColor={status === 'done'}>{shortText(todo.text, opts.textMax)}</Text>
      {validDue(todo) && status !== 'done' && <Text dimColor>{dueText(todo, now)}</Text>}
      {status !== 'done' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key={`now-${todo.index}`} variant="primary" label={LABELS.now} onPress={() => doNow($, ctx, todo)} />
          <Button key={`draft-${todo.index}`} label={LABELS.draft} onPress={() => draft($, ctx, todo)} />
          {opts.withDone && <Button key={`done-${todo.index}`} label={LABELS.done} onPress={() => markDone($, ctx, todo)} />}
        </Box>
      )}
    </Box>
  )
}

// Rows the last drawn band took, for the bands of the plugins beneath (set by renderBand, read right after it).
let bandRows = 0

async function renderBand($: EngineInterface, ctx: Ctx, e: any, next: any) {
  if (!ctx.cfg.showBand) return next(e)
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const todos = openTodos(snap, now, ctx.cfg.soonDays)
  if (e.props.hasSurvey || e.props.isWorking || !snap || todos.length === 0 || (await read($, hiddenDay)) === localDay(now)) return next(e)
  const ui = $.ui.resolve(e)
  // Sized to the room the engine gives the band, so the band never scrolls (it caps at half the terminal).
  const plan = planBand(e.props.maxRows ?? 40, e.props.bodyColumns ?? 100, todos)
  bandRows = planRows(plan, todos)
  const colors = palette(e.surface)
  if (plan.mode === 'line') return bandLine($, ctx, ui, todos, now)
  const { Box, Text } = ui
  const newest = ctx.cfg.showMemories ? snap.memories[0] : undefined
  const shown = plan.mode === 'cards' ? plan.perRow : plan.shown
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end"><Text color={ACCENT}>✻</Text> <Text bold>Tasks for {snap.project}</Text></Text>
        <Text dimColor>{countText(todos, now, ctx.cfg.soonDays)}</Text>
      </Box>
      {plan.mode === 'cards'
        ? <Box flexDirection="row" columnGap={1}>{todos.slice(0, shown).map(t => card($, ctx, ui, t, now, colors, { width: plan.cardWidth, textMax: BAND_TEXT_MAX, withDone: false }))}</Box>
        : todos.slice(0, shown).map(t => listRow($, ctx, ui, t, now, colors, plan.rowButtons, e.props.bodyColumns ?? 100))}
      {todos.length > shown && <Text dimColor>{todos.length - shown} more in the list.</Text>}
      {plan.mode === 'cards' && plan.showLegend && legend(ui, colors)}
      {plan.showMemory && newest && <Text dimColor wrap="truncate-end">Latest memory: <Text bold dimColor={false}>{shortText(newest.title, 80)}</Text>, {snap.memories.length} saved</Text>}
      {bandActions($, ui)}
    </Box>
  )
}

function bandActions($: EngineInterface, ui: any) {
  const { Box, Button } = ui
  return (
    <Box flexDirection="row" columnGap={1}>
      <Button key="open" label={LABELS.open} onPress={() => openPane($)} />
      <Button key="hide" label={LABELS.hide} onPress={() => hideToday($)} />
    </Box>
  )
}

/** One task per row: coloured dot, text cut to the width, due date, and the two buttons when they fit. */
function listRow($: EngineInterface, ctx: Ctx, ui: any, todo: Todo, now: number, colors: Record<Status, string>, withButtons: boolean, cols: number) {
  const { Box, Button, Text } = ui
  const status = statusOf(todo, now, ctx.cfg.soonDays)
  // The row cuts the text to its width: a text wider than that was not seen whole, so "Do it now" drafts it.
  const room = listRowTextCells(cols, validDue(todo) ? textCells(dueText(todo, now)) : 0, withButtons)
  return (
    <Box key={`row-${todo.index}`} flexDirection="row" columnGap={1}>
      <Text color={colors[status]}>●</Text>
      <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end">{shortText(todo.text, BAND_TEXT_MAX)}</Text></Box>
      {validDue(todo) && <Text color={colors[status]}>{dueText(todo, now)}</Text>}
      {withButtons && <Button key={`now-${todo.index}`} variant="primary" label={LABELS.now} onPress={() => doNow($, ctx, todo, room)} />}
      {withButtons && <Button key={`draft-${todo.index}`} label={LABELS.draft} onPress={() => draft($, ctx, todo)} />}
    </Box>
  )
}

/** The smallest band: one line, no border. */
function bandLine($: EngineInterface, ctx: Ctx, ui: any, todos: Todo[], now: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexShrink={1}><Text wrap="truncate-end"><Text color={ACCENT}>✻</Text> {countText(todos, now, ctx.cfg.soonDays)}</Text></Box>
      {bandActions($, ui)}
    </Box>
  )
}

async function renderPane($: EngineInterface, ctx: Ctx, e: any) {
  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const colors = palette(e.surface)
  const todos = openTodos(snap, now, ctx.cfg.soonDays)
  const limit = await read($, paneLimit)
  const done = recentlyDone(snap, now).slice(0, 10)
  const memories = ctx.cfg.showMemories ? (snap?.memories ?? []).slice(0, 3) : []
  const cardOpts = { textMax: PANE_TEXT_MAX }
  return (
    <Box flexDirection="column" rowGap={0}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text><Text color={ACCENT}>✻</Text> <Text bold>To-do list</Text></Text>
        <Text dimColor>{countText(todos, now, ctx.cfg.soonDays)}</Text>
      </Box>
      {legend(ui, colors)}
      {snap?.problem ? <Text color={colors.over}>{shortText(`${snap.problem} It is left untouched.`, 300)}</Text> : null}
      {todos.length === 0 && <Text dimColor>No open tasks. Add one with /todo add &lt;task&gt;.</Text>}
      {todos.slice(0, limit).map(t => card($, ctx, ui, t, now, colors, { ...cardOpts, withDone: true }))}
      {todos.length > limit && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{todos.length - limit} more open.</Text>
          <Button key="more" label={LABELS.more} onPress={() => update($, paneLimit, n => n + PANE_STEP)} />
        </Box>
      )}
      {done.map(t => card($, ctx, ui, t, now, colors, { ...cardOpts, withDone: false }))}
      {memories.length > 0 && <Text bold>Recent memories</Text>}
      {memories.map(m => (
        <Box key={`m-${m.file}`} flexDirection="column">
          <Text>{shortText(m.title, 120)}</Text>
          <Text dimColor>{shortText(m.hook, 200)}</Text>
        </Box>
      ))}
      <Text dimColor>Add a task: /todo add &lt;task&gt;</Text>
    </Box>
  )
}
