// The pet's shared state (see hooks/register.tsx). `view` is everything the band draws from; `now` is the clock the
// band reads (bumped by events and by the few timers that exist); `lang` is the language looked up at session start.
// Self-contained on purpose (the contract may not import): the Model and Save shapes repeat hooks/logic.ts.
export type PetModel = {
  working: boolean
  workingSince: number | null
  endedAt: number | null
  endReason: 'answer' | 'error' | 'refusal' | 'aborted' | null
  toolErrorAt: number | null
  quotaPct: number | null
}

export type AchievementName = 'streak7' | 'turns100' | 'firstTest' | 'firstCommit'

export type PetSave = {
  v: 1
  turns: number
  days: string[]
  testGreen: boolean
  committed: boolean
  earned: Partial<Record<AchievementName, string>>
  announced: AchievementName[]
  lastToastDay: string | null
  today: { day: string | null; turns: number }
}

/** A rate-limit reading: the highest window used, and which window it is (null: no reading). */
export type QuotaView = {
  pct: number | null
  resetsAt: number | null
  kind: 'five_hour' | 'seven_day' | null
  /** When the reading was taken (ms); null when unknown (an older version's value). Bounds a reading that has no resetsAt. */
  at: number | null
}

export type PetView = {
  /** The state machine (working, ended, tool error, quota). */
  model: PetModel
  /** Growth, days, achievements; what is also kept in the store. */
  save: PetSave
  /** False until the save was read from the store (a reload without session.start reads it on first need). */
  loaded: boolean
  quota: QuotaView
  /** Tool calls in the current turn. */
  steps: number
  /** Name of the last tool, cleaned and short; '' when none. Never a command or file content. */
  lastTool: string
  /** How long the last finished turn took (ms). */
  lastDurationMs: number
  /** Which kind of error the error state shows: a failed step, or a turn that did not finish. */
  errorKind: 'tool' | 'turn'
}

declare module 'claude-code' {
  interface PluginState {
    'kit-pet': { view: PetView; now: number; lang: 'en' | 'vi' | null }
  }
}
