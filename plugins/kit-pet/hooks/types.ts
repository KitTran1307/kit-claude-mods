// Types shared by every module of kit-pet. No code here.

/** The three pets, as the `pet` option names them. */
export type PetId = 'moss' | 'bun' | 'jelly'

/** What the pet is doing, from real events. */
export type PetState = 'idle' | 'working' | 'done' | 'error' | 'quota'

/** Growth stage: 1 sprout, 2 grown, 3 fully grown. */
export type Stage = 1 | 2 | 3

export type Lang = 'en' | 'vi'

export type AchievementId = 'streak7' | 'turns100' | 'firstTest' | 'firstCommit'

/** A rate-limit reading reduced to what the pet needs. */
export type Quota = { pct: number | null; resetsAt: number | null }
