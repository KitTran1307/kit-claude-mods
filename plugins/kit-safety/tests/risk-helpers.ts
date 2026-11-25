import { expect, test } from 'claude-code/testing'

import { classifyBash } from '../hooks/risk'
import type { BashContext } from '../hooks/risk'
import type { RiskKind } from '../hooks/types'

// The helpers of the hooks/risk*.test.ts files: contexts, the `check` of one command against the risks it must give, and `table` / `quiet`
// that register one test per row in the file that calls them. Nothing here registers a test on its own.

export const ROOT = '/work/acme-shop'
export const CTX: BashContext = { cwd: ROOT, root: ROOT, home: '/home/dev' }
// A project under the home folder, so `~` is above it.
export const HOME_CTX: BashContext = { cwd: '/home/dev/acme-shop', root: '/home/dev/acme-shop', home: '/home/dev' }
// A command run from a sub-folder of the project.
export const SUB_CTX: BashContext = { cwd: `${ROOT}/web`, root: ROOT, home: '/home/dev' }
// No home folder known.
export const NOHOME_CTX: BashContext = { cwd: ROOT, root: ROOT }
export const WIN: BashContext = { cwd: 'C:\\proj', root: 'C:\\proj', home: 'C:\\Users\\dev' }
export const TAGS = new Map<BashContext, string>([[HOME_CTX, ' [home]'], [SUB_CTX, ' [sub]'], [NOHOME_CTX, ' [nohome]'], [WIN, ' [win]']])

// A word that stands for a password or a token: it must never reach a label or a remote.
export const SENTINEL = 'zzsentinelzz'

export type Want = {
  kind: RiskKind
  label?: string
  paths?: string[]
  unknown?: boolean
  name?: string
  /** Every branch of a `force-push` / `branch-delete`; when left out, it must be `[name]` (or absent when there is no name). */
  names?: string[]
  remote?: string
  source?: string
  tier?: 'ask' | 'snapshot'
  /** A `delete` from `find` whose files are chosen by a filter. */
  picks?: boolean
  /** With `picks`: the first name pattern of the find (only checked when given; the `match` describe checks the absence). */
  match?: string
}

export function check(cmd: string, want: Want[], ctx: BashContext = CTX): void {
  const got = classifyBash(cmd, ctx)
  const why = `${JSON.stringify(cmd)} gave ${JSON.stringify(got)}`
  expect(got.length, why).toBe(want.length)
  want.forEach((w, i) => {
    const r = got[i]
    if (!r) return
    expect(r.kind, why).toBe(w.kind)
    expect(r.tier, why).toBe(w.tier ?? 'ask')
    if (w.label !== undefined) expect(r.label, why).toBe(w.label)
    expect(r.label.length, why).toBeLessThanOrEqual(40)
    expect(r.paths, why).toEqual(w.paths ?? [])
    expect(r.hasUnknownPath === true, why).toBe(w.unknown === true)
    expect(r.name, why).toBe(w.name)
    expect(r.remote, why).toBe(w.remote)
    expect(r.source, why).toBe(w.source)
    expect(r.picks === true, why).toBe(w.picks === true)
    if (w.match !== undefined) expect(r.match, why).toBe(w.match)
    if (w.kind === 'force-push' || w.kind === 'branch-delete') {
      expect(r.names, why).toEqual(w.names ?? (w.name === undefined ? undefined : [w.name]))
    }
  })
}

/** Table row: command, then every risk it must give in order (`[]` = none), then the context. */
export type Row = [cmd: string, want: Want[], ctx?: BashContext]

export function table(rows: Row[]): void {
  for (const [cmd, want, ctx] of rows) test(cmd.replace(/\n/g, '\\n') + (ctx ? (TAGS.get(ctx) ?? '') : ''), () => check(cmd, want, ctx))
}

/** Commands that must give nothing. */
export function quiet(cmds: string[], ctx: BashContext = CTX): void {
  for (const cmd of cmds) test(cmd.replace(/\n/g, '\\n') + (TAGS.get(ctx) ?? ''), () => check(cmd, [], ctx))
}

export const del = (paths: string[], label = 'rm -rf', unknown = false, picks = false): Want => ({ kind: 'delete', label, paths, unknown, picks })
export const unk = (label = 'rm -rf'): Want => del([], label, true)
export const UNPARSED: Want = { kind: 'unparsed', label: 'long command' }
export const ow = (label: string, paths: string[], source?: string): Want => ({ kind: 'overwrite', label, paths, source })
export const db = (label: string, name?: string, paths: string[] = [], unknown = false): Want => ({ kind: 'db-drop', label, name, paths, unknown })
export const push = (label: string, remote?: string, name?: string, names?: string[]): Want => ({ kind: 'force-push', label, remote, name, names })
export const discard = (label: string, paths: string[] = [], unknown = false): Want => ({ kind: 'discard', label, paths, unknown })
export const reset: Want = { kind: 'reset-hard', label: 'git reset --hard' }
export const clean = (label: string): Want => ({ kind: 'clean', label })
export const branch = (label: string, name?: string, names?: string[]): Want => ({ kind: 'branch-delete', label, name, names })
export const erase = (label: string): Want => ({ kind: 'git-erase', label })

export function timed(label: string, fn: () => void, limitMs = 3000): void {
  const t0 = Date.now()
  fn()
  expect(Date.now() - t0, `${label} took too long`).toBeLessThan(limitMs)
}
