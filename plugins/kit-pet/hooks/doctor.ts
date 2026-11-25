// `/pet doctor`: one line per check, `PASS <name> - <detail>`, `WARN <name> - <detail>` or `FAIL ...`, the same shape as
// usage-bar's. register.tsx gathers the facts (never a token, a path or file contents); this file only turns them into
// lines, so every outcome is testable without an engine. Unknown limit data is informational: it is never a WARN.
import type { Config } from './config'
import type { Strings } from './i18n'

/** The oldest Claude Code the pet is documented to work on (the same engine features as usage-bar uses). */
export const MIN_CLAUDE_VERSION = '2.1.275'

export type Facts = {
  /** The Claude Code version (`2.1.319`); null when it could not be told. */
  version: string | null
  /** Surfaces attached to this session (empty: none, or not known). */
  surfaces: readonly string[]
  /** Whether the saved progress could be read back (and the last save went through). */
  store: 'ok' | 'bad'
  /** Percent used of the fullest limit window; null: no limit data (API key, third-party provider, this surface). */
  quotaPct: number | null
}

type Level = 'PASS' | 'WARN' | 'FAIL'
const line = (level: Level, name: string, detail: string): string => `${level} ${name} - ${detail}`

/** -1, 0 or 1; null when either is not `N.N.N`-ish. Anything after the numbers (`-dev...`) is ignored. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 4).map(Number)
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  return 0
}

export function report(f: Facts, cfg: Config, t: Strings): string[] {
  const d = t.command.doctor
  const out: string[] = []

  const order = f.version === null ? null : compareVersions(f.version, MIN_CLAUDE_VERSION)
  out.push(
    f.version === null || order === null ? line('WARN', 'version', d.versionUnknown)
      : order < 0 ? line('FAIL', 'version', d.versionOld(f.version, MIN_CLAUDE_VERSION))
        : line('PASS', 'version', d.versionOk(f.version)),
  )

  out.push(f.surfaces.length > 0 ? line('PASS', 'surfaces', d.surfaces(f.surfaces.join(', '))) : line('WARN', 'surfaces', d.noSurface))

  out.push(f.store === 'ok' ? line('PASS', 'save', d.storeOk) : line('WARN', 'save', d.storeBad))

  // Not a problem either way: without limit data the low-quota state is simply never shown.
  out.push(f.quotaPct === null ? line('PASS', 'limits', d.quotaUnknown) : line('PASS', 'limits', d.quotaKnown(f.quotaPct)))

  if (!cfg.showPet) out.push(line('WARN', 'band', d.hidden('showPet')))
  return out
}
