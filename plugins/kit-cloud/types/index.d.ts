export type CloudState = 'working' | 'pr' | 'question' | 'silent' | 'done' | 'closed' | 'ended' | 'untracked'

export type CloudRow = {
  /** The hub's track id (for /cloud untrack). */
  id: string
  account: string
  repo: string
  title: string
  /** The session's https link, else its PR's; '' when there is none. */
  url: string
  sessionId: string
  startedEpoch: number
  state: CloudState
  /** Detail shown after the state, e.g. "pushed 3 min ago", "PR #88 · CI running". */
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    'kit-cloud': { rows: Shaped<CloudRow[]>; expanded: boolean; updatedAt: number; error: string; stale: string; noWaiter: string }
  }
}
