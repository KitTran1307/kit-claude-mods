// The trees Safety Net draws, as functions of the surface's element table (`$.ui.resolve(e)`): the band above the prompt with the
// question that waits for the person, the card around the result of `/safety`, and the line under a masked tool result. They
// use only Box, Text and Button with props that every surface takes (terminal, desktop, vscode, mobile), take every word from
// the language tables and build nothing from the engine's state, so band.test.tsx mounts them on all four surfaces.
import type { Elements, RenderElement } from 'claude-code'

import type { Pending } from '../types'
import { cardOf } from './describe'
import { frontOf, waitingBehind } from './flow'
import type { Lang, Strings } from './i18n'

/** The elements every surface has and these trees use. */
export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** What a press does. Each one answers the question `id`; they run the engine's calls, so the caller binds `$`. */
export type Handlers = {
  allow: (id: string) => unknown
  cancel: (id: string) => unknown
  toggle: (id: string) => unknown
}

export type BandInput = {
  pending: readonly Pending[]
  /** The id of the question whose variable names are open, or null. */
  detail: string | null
  t: Strings
  lang: Lang
  /** `e.surface`: the hint about keys is for the terminal. */
  surface: string
}

/** How to answer from the keyboard: the band takes a bare digit while the prompt is empty (or after a click on it). Plain words. */
export function keysHint(lang: Lang, hasDetails: boolean): string {
  if (lang === 'vi') {
    return hasDetails
      ? 'Gõ 1 để cho chạy, 2 để huỷ hoặc 3 để xem khác biệt khi ô nhập đang trống, hoặc bấm nút.'
      : 'Gõ 1 để cho chạy hoặc 2 để huỷ khi ô nhập đang trống, hoặc bấm nút.'
  }
  return hasDetails
    ? 'Press 1 to allow, 2 to cancel or 3 to see changes while the prompt is empty, or click a button.'
    : 'Press 1 to allow or 2 to cancel while the prompt is empty, or click a button.'
}

/**
 * The band for the question at the front of the queue, or null when nothing waits. Row 1: the pill, what is about to happen and
 * the command words. Row 2: what happened to the snapshot, then the buttons (Allow 1, Cancel 2, See changes 3 when there are
 * variable names to show) and how many more wait. Then, only when there is something to say: the note on why it is hard to undo
 * (and how many other commands the line holds), the start of a command that could not be read, the variable names (details open)
 * and, on the terminal, how to answer with the keys.
 */
export function bandRow(ui: Ui, input: BandInput, on: Handlers): RenderElement | null {
  const { Box, Text, Button } = ui
  const head = frontOf(input.pending)
  if (!head) return null
  const t = input.t
  const card = cardOf(head, waitingBehind(input.pending), t)
  const hasDetails = card.env !== ''
  const isOpen = hasDetails && input.detail === head.id
  const snapshotColor = card.snapshot.level === 'ok' ? 'success' : 'warning'
  const mark = card.snapshot.level === 'ok' ? '✔' : '⚠'
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold inverse color="error">{` ${t.pill} `}</Text>
        {' '}
        <Text bold>{card.title}</Text>
        {card.command === '' ? null : <Text dimColor>{` · ${card.command}`}</Text>}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
        <Text color={snapshotColor} wrap="wrap">{`${mark} ${card.snapshot.text}`}</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="allow" hotkey="1" variant="primary" label={t.buttons.allow} onPress={() => on.allow(head.id)} />
          <Button key="cancel" hotkey="2" label={t.buttons.cancel} onPress={() => on.cancel(head.id)} />
          {hasDetails ? <Button key="details" hotkey="3" label={isOpen ? t.buttons.hideDetails : t.buttons.details} onPress={() => on.toggle(head.id)} /> : null}
          {card.more > 0 ? <Text dimColor>{t.moreWaiting(card.more)}</Text> : null}
        </Box>
      </Box>
      {card.note === '' ? null : <Text dimColor wrap="wrap">{card.note}</Text>}
      {card.snippet === '' ? null : <Text dimColor wrap="wrap">{card.snippet}</Text>}
      {isOpen ? <Text wrap="wrap">{card.env}</Text> : null}
      {input.surface === 'terminal' ? <Text dimColor wrap="wrap">{keysHint(input.lang, hasDetails)}</Text> : null}
    </Box>
  )
}

/** The theme colour of a result's first line: ✓ done, ✗ failed, ! partly done. */
export function toneOf(text: string): 'success' | 'error' | 'warning' | 'subtle' {
  const mark = text.trimStart().charAt(0)
  return mark === '✓' ? 'success' : mark === '✗' ? 'error' : mark === '!' ? 'warning' : 'subtle'
}

/** The result of a `/safety` command as a bordered card, one Text for each line so that columns and indents stay where they are. */
export function resultCard(ui: Ui, text: string): RenderElement {
  const { Box, Text } = ui
  const lines = String(text ?? '').split('\n').slice(0, 200)
  const first = lines[0] ?? ''
  const tone = toneOf(first)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Text wrap="wrap" bold {...(tone === 'subtle' ? {} : { color: tone })}>{first === '' ? ' ' : first}</Text>
      {lines.slice(1).map(line => <Text wrap="wrap">{line === '' ? ' ' : line}</Text>)}
    </Box>
  )
}

/** The dim line under a tool result whose secrets were masked. `shown` is what the engine drew for the result itself. */
export function maskedRow(ui: Ui, shown: RenderElement, notice: string): RenderElement {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {shown}
      <Text dimColor wrap="wrap">{notice}</Text>
    </Box>
  )
}
