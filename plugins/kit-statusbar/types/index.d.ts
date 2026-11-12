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
}

declare module 'claude-code' {
  interface PluginState {
    'kit-statusbar': { info: Info; now: number; statusLine: boolean | null; lang: 'en' | 'vi' | null }
  }
}
