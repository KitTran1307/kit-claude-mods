// The plugin's state: its atoms and the per-load context shared by the hooks and the drawing.

import type { EngineInterface } from 'claude-code'

import type { SessionChanges, Summary } from '../types'
import type { Snapshot } from './collect'
import type { Style } from './data'
import type { Lang, Strings } from './i18n'

export const PANE = 'kit-turn'

/** What the drawing reads from the atoms (read in register.tsx, where the atoms are declared). */
export type View = {
  last: Summary | null
  visible: boolean
  running: { startedAt: number; now: number } | null
  expanded: boolean
  session: SessionChanges | null
}

/** The options, read once per load (a change in /config reloads the module with new ones). */
export type Config = { style: Style; showClock: boolean; showBand: boolean; language: 'auto' | Lang; maxFiles: number }

/** What the card's buttons do; set by register.tsx so the drawing stays free of engine calls. */
export type Actions = {
  push: () => Promise<void>
  commits: () => Promise<void>
  openPane: () => Promise<void>
  hide: () => Promise<void>
  toggleFiles: () => Promise<void>
}

export type Ctx = {
  cfg: Config
  lang: Lang
  t: Strings
  /** The working copy at session start (a promise: it is read without holding the start up). */
  sessionBase: Promise<Snapshot | null> | null
  /** The turn in progress. */
  run: {
    startedAt: number; prompt: string; baseline: Promise<Snapshot | null>
    /** Id of the newest conversation row when the turn started (read first, before any git work); undefined when the conversation had no rows, null when it could not be read. */
    row: Promise<string | null | undefined>
  } | null
  /** When each tool call of this turn ended (tool_use_id to epoch ms). */
  times: Record<string, number>
  timer: { cancel?: () => void } | null
  lastStatus: string | undefined
  /** The minute the clock atom last showed, so a tick that changes nothing visible draws nothing. */
  lastMinute: number
  turns: number
  /** The summary being built for the turn that just ended (finish runs without holding the turn's end up). */
  pending: Promise<void> | null
  /** Marks a session-changes read in progress, so a burst of pane draws reads it once. */
  sessionBusy: boolean
  /** The end time of the turn the session list was last read for (0: before any turn); null: never read. */
  sessionFor: number | null
  actions: Actions
}

export type Engine = EngineInterface
