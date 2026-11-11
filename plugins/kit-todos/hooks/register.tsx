import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Memory, Snapshot, Todo } from '../types'
import {
  needsReview, BAND_TEXT_MAX, COLORS, LABELS, PANE_TEXT_MAX, STATUSES, configDirCandidates, countText, dueText, localDay, markDoneAt, newId,
  openTodos, parseIndex, parseTodosForWrite, planBand, planRows, projectSlug, recentlyDone, resolveTodosPath, shortText, soonDaysFrom,
  statusOf, taskPrompt, usableTodos, validDue, listRowTextCells, textCells,
} from './data'
import type { Status } from './data'

const PANE = 'kit-todos'
const ACCENT = '#d77757'
const PANE_MAX = 50 // tasks drawn in the pane; the rest are in the file
const USAGE = 'Usage: /todo | /todo add <task> | /todo done <number>'
const NO_HOME = 'The home folder is unknown, so the to-do file cannot be placed. Set the todosFile option to a full path.'

const hiddenDay = atom({ plugin: 'kit-todos', key: 'hiddenDay' } as const, null as string | null)
const snapshot = atom({ plugin: 'kit-todos', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snap-1' })

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

/** The repo's folder name when the session is in a git repo (a subfolder still counts), else the folder's own. */
async function projectName($: EngineInterface, cwd: string): Promise<string> {
  try {
    const repo = await $.session.repo()
    if (repo?.root) return baseName(repo.root)
  } catch { /* not a repo */ }
  return baseName(cwd)
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

/**
 * Changes the todos file: reads it exactly as written (throws when it cannot, so nothing is overwritten), applies
 * `change` (null means the task is gone, so nothing is written) and writes it back. A failure toasts and says why.
 */
async function writeTodos($: EngineInterface, ctx: Ctx, change: (list: unknown[]) => unknown[] | null): Promise<Changed> {
  const file = await todosPath($, ctx)
  try {
    if (!file) throw new Error(NO_HOME)
    // Another session (or Claude, finishing a task) may write the file meanwhile: read, change, and write only if the
    // file is still the one that was read; otherwise read it again (a few times) so no one's change is lost.
    const stamp = async () => { try { const st = await $.fs.stat(file); return `${st.size}:${st.mtimeMs}` } catch { return 'none' } }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await stamp()
      const list = parseTodosForWrite((await $.fs.exists(file)) ? await $.fs.read(file) : null)
      const next = change(list)
      if (!next) return failed($, 'that task is no longer in the file, so nothing was changed.')
      if ((await stamp()) !== before) continue
      await $.fs.write(file, JSON.stringify(next, null, 2) + '\n')
      return { ok: true }
    }
    return failed($, 'the file kept changing while it was being updated. Nothing was written; try again.')
  } catch (err) {
    return failed($, `${file || 'the to-do file'} could not be changed: ${reason(err)}. Nothing was written.`)
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
    const [loaded, memories, project] = await Promise.all([
      loadTodos($, ctx),
      ctx.cfg.showMemories ? loadMemories($, ctx, cwd) : Promise.resolve([] as Memory[]),
      projectName($, cwd),
    ])
    const now = await $.clock.now()
    const snap: Snapshot = { todos: loaded.todos, problem: loaded.problem, memories, project, loadedAt: now }
    await update($, snapshot, () => snap)
    const open = openTodos(snap, now, ctx.cfg.soonDays)
    await $.ui.status(open.length ? `✻ ${countText(open, now, ctx.cfg.soonDays)}` : undefined)
  } catch { /* keep what was shown */ }
}

async function markDone($: EngineInterface, ctx: Ctx, todo: Todo): Promise<Changed> {
  const doneAt = new Date(await $.clock.now()).toISOString()
  const result = await writeTodos($, ctx, list => markDoneAt(list, todo.index, todo.id, doneAt))
  await refresh($, ctx)
  return result
}

async function addTodo($: EngineInterface, ctx: Ctx, text: string): Promise<Changed> {
  const project = await projectName($, await $.session.cwd())
  const now = await $.clock.now()
  const result = await writeTodos($, ctx, list => [...list, { id: newId(list, now), text, project, done: false }])
  await refresh($, ctx)
  return result
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
        description: 'To-do list: open the pane, /todo add <task>, /todo done <number>',
        argumentHint: '[add <task> | done <number>]',
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
    await refresh($, ctx)
    const todo = openTodos(await read($, snapshot), await $.clock.now(), ctx.cfg.soonDays)[Number(tail) - 1]
    if (!todo) return { text: `There is no task ${tail}. Type /todo to see the numbered list.` }
    const result = await markDone($, ctx, todo)
    return { text: result.ok ? `Done: ${todo.text}` : `Could not mark it done: ${result.why}` }
  }
  if (verb) return { text: USAGE }
  await update($, hiddenDay, () => null)
  await refresh($, ctx)
  await openPane($)
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const soonDays = ctx.cfg.soonDays
  const lines = openTodos(snap, now, soonDays).map((t, i) => {
    const label = STATUSES.find(s => s.id === statusOf(t, now, soonDays))?.label
    return `${i + 1}. [${label}] ${shortText(t.text, 200)}${validDue(t) ? ` - ${dueText(t, now)}` : ''}`
  })
  return {
    text: [
      `Tasks for ${snap?.project ?? 'this project'} (${lines.length}):`,
      ...(lines.length ? lines : ['No open tasks. Add one with /todo add <task>.']),
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
  const { Box, Text } = ui
  const snap = await read($, snapshot)
  const now = await $.clock.now()
  const colors = palette(e.surface)
  const todos = openTodos(snap, now, ctx.cfg.soonDays)
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
      {todos.slice(0, PANE_MAX).map(t => card($, ctx, ui, t, now, colors, { ...cardOpts, withDone: true }))}
      {todos.length > PANE_MAX && <Text dimColor>{todos.length - PANE_MAX} more are in the file.</Text>}
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
