export type Limit = { pct: number | null; resetsAt: number | null }

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
}

declare module 'claude-code' {
  interface PluginState {
    'kit-statusbar': { info: Info; now: number; statusLine: boolean | null }
  }
}
