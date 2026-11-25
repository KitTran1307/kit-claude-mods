export type Limit = { pct: number | null; resetsAt: number | null }

export type HookFailure = { hook: string; command: string; reason: string }
export type HookErrors = { count: number; last: HookFailure | null }

export type Info = {
  repo: string
  model: string
  effort: string | null
  ctx: number | null
  five: Limit
  week: Limit
  email: string
  label: string
  colorIndex: number
  title: string
  /** Hook failures this session; absent in a value stored by an older version. */
  hookErrors?: HookErrors
  /** Last main-thread reply: when it was written and how long its prompt cache lives; absent when unknown or in a value stored by an older version. */
  cache?: { at: number; ttlMs: number } | null
  /** When a measurement last carried rate limits (ms); absent when unknown or in a value stored by an older version. */
  limitsAt?: number | null
  /** When the main thread last ran a turn step or finished a turn (ms); absent when none ran this session. */
  turnAt?: number | null
  /** Whether the 1 s timer runs (the cache clock counts seconds); absent or false: the 60 s tick (whole minutes). */
  fastClock?: boolean
  /** Whether the main thread is in the middle of a turn (the cache clock is hidden meanwhile); absent or false: not. */
  busy?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { info: Info; now: number; statusLine: boolean | null; lang: 'en' | 'vi' | null }
  }
}
