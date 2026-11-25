// Drawing: the band above the prompt (clock while a turn runs, then the card, the timeline or one line) and the pane.

import type { EngineInterface } from 'claude-code'

import type { FileChange, Summary } from '../types'
import {
  COLORS, changesText, clockTime, commitText, fitSteps, formatDuration, formatElapsed, oneLine, planBand, shortPath, stepText, textCells, totals,
} from './data'
import type { Palette, Plan } from './data'
import type { Ctx, View } from './state'

export const palette = (surface: unknown): Palette => (surface === 'terminal' ? COLORS.dark : COLORS.light)

const unpushedText = (ctx: Ctx, s: Summary) => ctx.t.unpushed(s.unpushed?.count ?? 0, s.unpushed?.upstream ?? null)
const hasUnpushed = (s: Summary) => !!s.unpushed && s.unpushed.count > 0

/** The clock row while a turn runs. */
function clockRow(ctx: Ctx, ui: any, c: Palette, run: { startedAt: number; now: number }) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row">
      <Text wrap="truncate-end"><Text color={c.accent}>✻</Text> {ctx.t.working(clockTime(run.startedAt), formatElapsed(run.now - run.startedAt, ctx.t))}</Text>
    </Box>
  )
}

function fileRow(ctx: Ctx, ui: any, c: Palette, f: FileChange, inner: number, key: string) {
  const { Box, Text } = ui
  const word = f.isBinary ? ctx.t.binaryFile : f.isNew && !f.added ? ctx.t.newFile : ''
  const countCells = word ? textCells(word) : textCells(`+${f.added}`) + textCells(`-${f.removed}`) + 1
  const room = Math.max(8, inner - countCells - 1)
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}><Text wrap="truncate-end">{shortPath(f.path, room)}</Text></Box>
      {word ? <Text dimColor>{word}</Text> : <Text color={c.add}>{`+${f.added}`}</Text>}
      {!word && <Text color={c.del}>{`-${f.removed}`}</Text>}
    </Box>
  )
}

function warningRow(ctx: Ctx, ui: any, c: Palette, s: Summary) {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexShrink={1}><Text wrap="truncate-end" color={c.warn}>⚠ {unpushedText(ctx, s)}</Text></Box>
      <Button key="push" variant="primary" label={ctx.t.buttons.push} onPress={() => ctx.actions.push()} />
    </Box>
  )
}

function buttonsRow(ctx: Ctx, ui: any, s: Summary) {
  const { Box, Button } = ui
  const t = ctx.t
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {hasUnpushed(s) && <Button key="push" variant="primary" label={t.buttons.push} onPress={() => ctx.actions.push()} />}
      {hasUnpushed(s) && <Button key="commits" label={t.buttons.commits} onPress={() => ctx.actions.commits()} />}
      <Button key="details" label={t.buttons.details} onPress={() => ctx.actions.openPane()} />
      <Button key="hide" label={t.buttons.hide} onPress={() => ctx.actions.hide()} />
    </Box>
  )
}

function stepRow(ctx: Ctx, ui: any, c: Palette, st: Summary['steps'][number], key: string, wrap: 'wrap' | 'truncate-end') {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Text dimColor>{clockTime(st.at)}</Text>
      <Box flexShrink={1}><Text wrap={wrap}>{stepText(st, ctx.t)}</Text></Box>
      {st.file && <Text color={c.add}>{`+${st.added ?? 0}`}</Text>}
      {st.file && <Text color={c.del}>{`-${st.removed ?? 0}`}</Text>}
    </Box>
  )
}

function card(ctx: Ctx, ui: any, c: Palette, s: Summary, plan: Plan, cols: number) {
  const { Box, Text } = ui
  const t = ctx.t
  const inner = Math.max(1, cols - 4)
  const files = s.files ?? []
  const shown = files.slice(0, plan.files)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={s.outcome === 'done' ? c.accent : c.warn} paddingX={1}>
      <Text wrap="truncate-end"><Text color={c.accent}>✻</Text> <Text bold>{t.title}</Text>  <Text dimColor>{t.range(clockTime(s.startedAt), clockTime(s.endedAt))}</Text></Text>
      <Text bold>{t.sectionDone}</Text>
      <Text wrap="wrap">{s.what || (s.asked ? t.asked(s.asked) : t.noAnswer)}</Text>
      {s.files && <Text bold>{t.sectionChanges}</Text>}
      {s.files && <Text wrap="wrap">{changesText(s, t)}</Text>}
      {shown.map((f, i) => fileRow(ctx, ui, c, f, inner, `file-${i}`))}
      {shown.length > 0 && files.length > shown.length && <Text dimColor>{t.moreFiles(files.length - shown.length)}</Text>}
      {s.tests && <Text bold>{t.sectionChecks}</Text>}
      {s.tests && <Text wrap="wrap" color={s.tests.failed ? c.bad : c.ok}>{t.testsLong(s.tests, s.testRuns)}</Text>}
      <Text bold>{t.sectionTime}</Text>
      <Text wrap="wrap">{formatDuration(s.durationMs, t)} - {t.started(clockTime(s.startedAt))}</Text>
      {hasUnpushed(s) && <Text wrap="wrap" color={c.warn}>⚠ {unpushedText(ctx, s)}</Text>}
      {buttonsRow(ctx, ui, s)}
    </Box>
  )
}

function timeline(ctx: Ctx, ui: any, c: Palette, s: Summary, plan: Plan) {
  const { Box, Text } = ui
  const t = ctx.t
  const { shown, hidden } = fitSteps(s.steps, plan.steps)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap" color={s.outcome === 'done' ? c.ok : c.warn}>{oneLine(s, t)}</Text>
      {shown.map((st, i) => stepRow(ctx, ui, c, st, `step-${i}`, 'truncate-end'))}
      {hidden > 0 && <Text dimColor>{t.moreSteps(hidden)}</Text>}
      {hasUnpushed(s) && <Text wrap="wrap" color={c.warn}>⚠ {unpushedText(ctx, s)}</Text>}
      {buttonsRow(ctx, ui, s)}
      <Text dimColor>{t.ended(clockTime(s.endedAt), formatDuration(s.durationMs, t))}</Text>
    </Box>
  )
}

function lineMode(ctx: Ctx, ui: any, c: Palette, s: Summary, plan: Plan, isOpen: boolean, cols: number) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  const files = s.files ?? []
  const shown = files.slice(0, plan.files)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}><Text wrap="truncate-end" color={s.outcome === 'done' ? c.ok : c.warn}>{oneLine(s, t)}</Text></Box>
        {files.length > 0 && <Button key="files" label={`${t.buttons.files} ${isOpen ? t.fileMarkOpen : t.fileMarkClosed}`} onPress={() => ctx.actions.toggleFiles()} />}
        <Button key="hide" label={t.buttons.hide} onPress={() => ctx.actions.hide()} />
      </Box>
      {shown.map((f, i) => fileRow(ctx, ui, c, f, cols, `file-${i}`))}
      {shown.length > 0 && files.length > shown.length && <Text dimColor>{t.moreFiles(files.length - shown.length)}</Text>}
      {hasUnpushed(s) && warningRow(ctx, ui, c, s)}
    </Box>
  )
}

/** One row: the warning first (it is what must not be missed), then the summary; a Push button when there is a warning. */
function line1(ctx: Ctx, ui: any, c: Palette, s: Summary) {
  const { Box, Button, Text } = ui
  const t = ctx.t
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end" color={hasUnpushed(s) ? c.warn : s.outcome === 'done' ? c.ok : c.warn}>
          {hasUnpushed(s) ? `⚠ ${t.unpushedShort(s.unpushed?.count ?? 0)} - ` : ''}{oneLine(s, t)}
        </Text>
      </Box>
      {hasUnpushed(s) && <Button key="push" variant="primary" label={t.buttons.push} onPress={() => ctx.actions.push()} />}
    </Box>
  )
}

/** What the band draws and the rows it takes; null when it has nothing to show (the band is handed on). */
export function renderBand($: EngineInterface, ctx: Ctx, e: any, view: View): { node: unknown; rows: number } | null {
  if (!ctx.cfg.showBand || e.props.hasSurvey || e.props.isCollapsed) return null
  const ui = $.ui.resolve(e) as any
  const c = palette(e.surface)
  const rows: number = e.props.maxRows ?? 40
  const cols: number = e.props.bodyColumns ?? 100
  if (e.props.isWorking) {
    const run = view.running
    if (!ctx.cfg.showClock || !run || rows < 1) return null
    return { node: clockRow(ctx, ui, c, run), rows: 1 }
  }
  const { last: s, visible: isShown, expanded: isOpen } = view
  if (!s || !isShown) return null
  const plan = planBand(s, { rows, cols, style: ctx.cfg.style, expanded: isOpen, maxFiles: ctx.cfg.maxFiles }, ctx.t)
  switch (plan.mode) {
    case 'card': return { node: card(ctx, ui, c, s, plan, cols), rows: plan.rows }
    case 'timeline': return { node: timeline(ctx, ui, c, s, plan), rows: plan.rows }
    case 'line': return { node: lineMode(ctx, ui, c, s, plan, isOpen, cols), rows: plan.rows }
    case 'line1': return { node: line1(ctx, ui, c, s), rows: 1 }
    default: return null
  }
}

/** The pane: everything, with no row limit (the pane scrolls). */
export function renderPane($: EngineInterface, ctx: Ctx, e: any, view: View) {
  const ui = $.ui.resolve(e) as any
  const { Box, Button, Text } = ui
  const t = ctx.t
  const c = palette(e.surface)
  const inner: number = Math.max(20, (e.props.bodyColumns ?? 80) - 2)
  const { last: s, session: sess } = view
  const sessionFiles = sess?.files ?? []
  const sessionTotals = totals(sessionFiles)
  const u = s?.unpushed && s.unpushed.count > 0 ? s.unpushed : sess?.unpushed && sess.unpushed.count > 0 ? sess.unpushed : null
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text><Text color={c.accent}>✻</Text> <Text bold>{t.paneTitle}</Text></Text>
      {!s && <Text dimColor wrap="wrap">{t.paneNoTurn}</Text>}
      {s && <Text wrap="wrap" color={s.outcome === 'done' ? c.ok : c.warn}>{oneLine(s, t)}</Text>}
      {s && <Text bold>{t.sectionDone}</Text>}
      {s && <Text wrap="wrap">{s.what || (s.asked ? t.asked(s.asked) : t.noAnswer)}</Text>}
      {s?.files && <Text bold>{t.sectionChanges}</Text>}
      {s?.files && <Text wrap="wrap">{changesText(s, t)}</Text>}
      {s?.files?.slice(0, 200).map((f, i) => fileRow(ctx, ui, c, f, inner, `file-${i}`))}
      {s?.tests && <Text bold>{t.sectionChecks}</Text>}
      {s?.tests && <Text wrap="wrap" color={s.tests.failed ? c.bad : c.ok}>{t.testsLong(s.tests, s.testRuns)}</Text>}
      {s && <Text bold>{t.paneSteps}</Text>}
      {s?.steps.map((st, i) => stepRow(ctx, ui, c, st, `step-${i}`, 'wrap'))}
      {s && <Text dimColor>{t.ended(clockTime(s.endedAt), formatDuration(s.durationMs, t))}</Text>}
      <Text bold>{t.paneSession}</Text>
      {(!sess || (sess.files && sessionFiles.length === 0)) && <Text dimColor>{t.paneSessionNone}</Text>}
      {sess?.files && sessionFiles.length > 0 && <Text wrap="wrap">{t.sessionFiles(sessionTotals.n, sessionTotals.added, sessionTotals.removed)}</Text>}
      {sess?.files?.slice(0, 200).map((f, i) => fileRow(ctx, ui, c, f, inner, `sfile-${i}`))}
      {sess && sess.commitsMade > 0 && <Text wrap="wrap">{t.sessionCommits(sess.commitsMade)}</Text>}
      {u && <Text bold color={c.warn}>{t.paneUnpushed}</Text>}
      {u && <Text wrap="wrap" color={c.warn}>⚠ {t.unpushed(u.count, u.upstream)}</Text>}
      {u?.commits.map((cm, i) => <Text key={`commit-${i}`} wrap="truncate-end">{commitText(cm)}</Text>)}
      {u && <Box flexDirection="row" columnGap={1}><Button key="push" variant="primary" label={t.buttons.push} onPress={() => ctx.actions.push()} /></Box>}
    </Box>
  )
}
