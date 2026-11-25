// The values Quota Coach keeps and draws from. Everything is plain JSON.
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'other'

/** The prompt cache of the last reply: when it was written and how long it lives. */
export type CacheStamp = { at: number; ttlMs: number }

/** What the 5-hour window has moved while the weighted tokens were spent: running totals since the window started. */
export type Calibration = { pct: number; weighted: number; turns: number }

export type TurnStat = {
  /** Model steps the turn took (each re-reads the context). */
  steps: number
  /** Output tokens of the main loop. */
  output: number
  /** Subagents that ran during the turn. */
  subagents: number
  /** Weighted tokens the turn and its subagents used. */
  spent: number
  /** Total tokens, for display. */
  tokens: number
  /** Model of the last step. */
  model: string
  /** Points of the 5-hour window the turn moved, as measured; 0 when none moved or it is unknown. */
  pct: number
  /** When the turn ended (ms). */
  at: number
}

/** Share of the 5-hour window used, by session, family and hour, as this plugin measured it. */
export type DaySession = { title: string; pct: number; tokens: number; models: Partial<Record<Tier, number>> }
export type Day = {
  sessions: Record<string, DaySession>
  hours: number[]
  models: Partial<Record<Tier, number>>
  /** The `resetsAt` of each 5-hour window seen today. */
  windows: string[]
}

export type ReportRow = { id: string; title: string; tier: Tier | null; pct: number | null; tokens: number }
export type Report = {
  /** Points of the 5-hour window used today, as measured by this plugin; null when it measured none. */
  totalPct: number | null
  totalTokens: number
  sessions: ReportRow[]
  models: Array<{ tier: Tier; label: string; pct: number | null; tokens: number }>
  /** Hours with something to show, in order; `pct` null where only tokens are known. */
  hours: Array<{ hour: number; pct: number | null; tokens: number }>
  windows: number
  /** Whether percentages are known at all. */
  hasPct: boolean
  busiestHour: number | null
  topTier: Tier | null
  /** Share of the day's measure the top family used, 0-100. */
  topShare: number
}

export type Facts = {
  /** Context tokens, window and percent as the last response reported them; null before the first response. */
  ctxTokens: number | null
  window: number | null
  ctxPct: number | null
  /** The model id of the session. */
  model: string
  /** The 5-hour window: percent used and when it resets (ISO); null where the plan has none. */
  fivePct: number | null
  fiveResetsAt: string | null
  /** Running subagents. */
  agents: number
  cache: CacheStamp | null
  calibration: Calibration
  /** The most recent finished turns, oldest first. */
  recent: TurnStat[]
  working: boolean
}

export type Ui = {
  /** Whether the "why" card is open. */
  card: boolean
  /** Tip kinds the person dismissed that still apply. */
  dismissed: string[]
  /** Whether the prompt holds typed text (the estimate shows then). */
  draft: boolean
  /** A short line after an action (compacted, typed into the prompt); '' for none. */
  notice: string
}

declare module 'claude-code' {
  interface PluginState {
    'quota-coach': {
      facts: Shaped<Facts>
      ui: Shaped<Ui>
      now: number
      lang: 'en' | 'vi' | null
      report: Shaped<Report | null>
      reportDate: string
    }
  }
}
