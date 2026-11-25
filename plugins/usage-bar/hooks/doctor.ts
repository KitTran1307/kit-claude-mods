// `/usage-bar doctor`: one line per check, `PASS <name> - <detail>`, `WARN <name> - <detail> Fix: <hint>` or
// `FAIL ...`. The facts are gathered by register.tsx (never a token, an email, file contents or a credential path);
// this file only turns them into lines, so every outcome is testable without an engine.
import type { Config } from './config'
import type { Strings } from './i18n'

/** The oldest Claude Code the plugin is documented to work on (see the README's requirements). */
export const MIN_CLAUDE_VERSION = '2.1.275'

export type Facts = {
  /** The Claude Code version (`2.1.319`); null when it could not be told. */
  version: string | null
  /** The Node version found; null when there is none. */
  node: string | null
  transcript: 'none' | 'ok' | 'large' | 'unreadable'
  /** Surfaces attached to this session. */
  surfaces: readonly string[]
  /** Whether the settings files configure a terminal status line; null: not looked at. */
  statusLine: boolean | null
  /** Whether rate-limit numbers have arrived; null: not known. */
  rateData: boolean | null
  /** The account label, and whether CLAUDE_CONFIG_DIR named the folder. */
  label: string
  fromEnv: boolean
  /** Whether the config folder exists; null: not known. */
  configFound: boolean | null
}

type Level = 'PASS' | 'WARN' | 'FAIL'
const line = (level: Level, name: string, detail: string, fix = '', t?: Strings): string =>
  `${level} ${name} - ${detail}${fix && t ? ` ${t.command.fix} ${fix}` : ''}`

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
  const c = t.command
  const out: string[] = []

  const order = f.version === null ? null : compareVersions(f.version, MIN_CLAUDE_VERSION)
  out.push(
    f.version === null || order === null ? line('WARN', 'version', c.versionUnknown, c.versionUnknownFix, t)
      : order < 0 ? line('FAIL', 'version', c.versionOld(f.version, MIN_CLAUDE_VERSION), c.versionFix, t)
        : line('PASS', 'version', c.versionOk(f.version, MIN_CLAUDE_VERSION)),
  )

  out.push(f.node === null ? line('WARN', 'node', c.nodeMissing, c.nodeFix, t) : line('PASS', 'node', c.nodeOk(f.node)))

  out.push(
    f.transcript === 'ok' ? line('PASS', 'transcript', c.transcriptOk)
      : f.transcript === 'large' ? (f.node === null ? line('WARN', 'transcript', c.transcriptLarge, c.nodeFix, t) : line('PASS', 'transcript', c.transcriptLarge))
        : f.transcript === 'none' ? line('WARN', 'transcript', c.transcriptNone, c.transcriptNoneFix, t)
          : line('FAIL', 'transcript', c.transcriptBad, c.transcriptBadFix, t),
  )

  const reasons: string[] = []
  const terminalOnly = f.surfaces.length > 0 && f.surfaces.every(s => s === 'terminal')
  if (terminalOnly && cfg.surfaces === 'desktop') reasons.push(c.reasonSurfaces)
  if (terminalOnly && cfg.surfaces === 'auto' && f.statusLine === true) reasons.push(c.reasonStatusLine)
  const options: Array<[string, boolean]> = [
    ['showLimits', cfg.showLimits], ['showCacheClock', cfg.showCacheClock], ['showForecast', cfg.showForecast],
    ['showTitle', cfg.showTitle], ['showEmail', cfg.showEmail], ['showHookErrors', cfg.showHookErrors],
  ]
  for (const [name, on] of options) if (!on) reasons.push(c.reasonOption(name))
  out.push(
    reasons.length > 0 ? line('WARN', 'band', c.bandHidden(reasons.join(', ')), c.bandFix, t)
      : line('PASS', 'band', c.bandOk(f.surfaces.length > 0 ? f.surfaces.join(', ') : '-')),
  )

  out.push(
    f.rateData === null ? line('WARN', 'limits', c.rateUnknown, c.rateUnknownFix, t)
      : line('PASS', 'limits', f.rateData ? c.rateOk : c.rateNone),
  )

  out.push(
    f.configFound === false ? line('WARN', 'config', c.configMissing, c.configFix, t)
      : line('PASS', 'config', f.fromEnv ? c.configEnv(f.label) : c.configDefault),
  )
  return out
}
