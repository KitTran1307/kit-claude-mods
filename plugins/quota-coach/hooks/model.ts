// Model names: which family a model id belongs to, how much more or less a turn on it uses of the plan, a readable name.
// The ratios are rough list-price ratios, only ever shown as "about" and used to scale a measured rate between models.

import type { Tier } from '../types'

export type { Tier }

const FAMILY = /(opus|sonnet|haiku)/i

export function tierOf(model: string | null | undefined): Tier {
  const m = FAMILY.exec(model ?? '')?.[1]?.toLowerCase()
  return m === 'opus' || m === 'sonnet' || m === 'haiku' ? m : 'other'
}

/** Major and minor version in a model id (`claude-opus-4-5`, `claude-3-opus-20240229`, `claude-sonnet-5-5[1m]`); null when there is none. */
export function versionOf(model: string): { major: number; minor: number } | null {
  const id = model.toLowerCase().replace(/\[.*?\]/g, '')
  const after = /(?:opus|sonnet|haiku)-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/.exec(id)
  const before = /claude-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?-(?:opus|sonnet|haiku)/.exec(id)
  const hit = after ?? before
  if (!hit) return null
  return { major: Number(hit[1]), minor: hit[2] === undefined ? 0 : Number(hit[2]) }
}

/**
 * How much of the plan one unit of work on this model uses, Sonnet = 1. Opus before 4.5 was about 5 times Sonnet, from
 * 4.5 on about 1.7 times; an Opus whose version is unknown counts as the newer. Haiku about a third. Unknown: 1.
 */
export function tierWeight(model: string | null | undefined): number {
  const tier = tierOf(model)
  if (tier === 'haiku') return 0.33
  if (tier === 'opus') {
    const v = model ? versionOf(model) : null
    const isOld = v !== null && (v.major < 4 || (v.major === 4 && v.minor < 5))
    return isOld ? 5 : 1.7
  }
  return 1
}

const NAMES: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', other: '' }

/** `claude-opus-5-5` becomes `Opus 5.5`; an id with no family stays as it is (cut at 24 characters). */
export function prettyModel(model: string | null | undefined): string {
  const id = (model ?? '').trim()
  if (!id) return ''
  const tier = tierOf(id)
  if (tier === 'other') return id.length > 24 ? id.slice(0, 23) + '…' : id
  const v = versionOf(id)
  if (!v) return NAMES[tier]
  return `${NAMES[tier]} ${v.major}${v.minor ? `.${v.minor}` : ''}`
}

/** The family name for a report row (`Opus`, `Sonnet`, `Haiku`); other models keep their id. */
export const tierLabel = (tier: Tier, fallback = ''): string => (tier === 'other' ? fallback || '?' : NAMES[tier])
