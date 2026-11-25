/** One changed file with the lines added and removed. */
export type FileChange = {
  /** Relative to the repository root, with "/". */
  path: string
  added: number
  removed: number
  isBinary?: boolean
  /** On disk but not yet known to git: its lines are not counted. */
  isNew?: boolean
}

/** A test run read from a runner's output. */
export type TestRun = {
  runner: 'node' | 'jest' | 'vitest' | 'pytest' | 'cargo' | 'go'
  passed: number
  failed: number
  skipped: number
  /** Go without -v counts packages, not tests. */
  unit?: 'packages'
}

/** One line of the timeline. Words come from the language table, so a step holds data only. */
export type Step = {
  /** Epoch ms; always set (a step without a measured time gets an even share of the turn). */
  at: number
  kind: 'start' | 'read' | 'edit' | 'create' | 'test' | 'commit' | 'command' | 'helper' | 'web' | 'other'
  /** Files read (read), commands run (command), helpers asked (helper), pages looked up (web), other tool calls (other). */
  n?: number
  /** Searches made (read). */
  m?: number
  file?: string
  added?: number
  removed?: number
  /** The request (start) or the commit message (commit). */
  text?: string
  test?: TestRun
}

export type Commit = { hash: string; subject: string }

/** Commits that no remote holds yet. */
export type Unpushed = {
  count: number
  /** The branch it is counted against ("origin/main"), or null: not on any remote branch. */
  upstream: string | null
  commits: Commit[]
}

export type Summary = {
  startedAt: number
  endedAt: number
  durationMs: number
  outcome: 'done' | 'stopped' | 'error'
  /** First line of Claude's final answer, or "". */
  what: string
  /** The request, shortened. */
  asked: string
  /** Files changed during the turn; null when there is no way to tell (no repository). */
  files: FileChange[] | null
  /** True when the files come from Claude's edit calls instead of version control, so the numbers are estimates. */
  filesApprox: boolean
  commitsMade: number
  tests: TestRun | null
  testRuns: number
  steps: Step[]
  unpushed: Unpushed | null
}

/** What the session changed since it started. */
export type SessionChanges = {
  at: number
  files: FileChange[] | null
  commitsMade: number
  unpushed: Unpushed | null
}

declare module 'claude-code' {
  interface PluginState {
    'kit-turn': {
      /** The latest finished turn of the main conversation. */
      last: Shaped<Summary | null>
      /** Whether the card shows: from the end of a turn until the next turn starts or the person hides it. */
      visible: boolean
      /** A turn in progress: when it started and the time of the last tick. */
      running: { startedAt: number; now: number } | null
      /** The one-line summary's file list is open. */
      expanded: boolean
      session: Shaped<SessionChanges | null>
    }
  }
}
