// /todo doctor: pure helpers (no engine calls). One line per check, "PASS|WARN|FAIL <name> - <detail>", a WARN or FAIL
// ending in " Fix: <hint>". Lines carry names, counts and sizes only, never file contents.

export type Level = 'PASS' | 'WARN' | 'FAIL'
export type Line = { level: Level; name: string; detail: string; fix?: string }

/** The oldest Claude Code this plugin is meant for (hooks modules, plugin installs from a marketplace). */
export const MIN_CLAUDE_CODE = '2.1.275'

/** The first `major.minor.patch` in a text ("2.1.331 (Claude Code)", "2.1.280-dev.2026..."), or null. */
export function parseVersion(text: unknown): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether `version` is at least `min`; null when either cannot be read. */
export function versionAtLeast(version: unknown, min: string): boolean | null {
  const a = parseVersion(version)
  const b = parseVersion(min)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** `PASS name - detail` or `WARN name - detail Fix: hint`, on one line. */
export function formatLine(line: Line): string {
  const base = `${line.level} ${line.name} - ${line.detail.replace(/\s+/g, ' ').trim()}`
  return line.level === 'PASS' || !line.fix ? base : `${base} Fix: ${line.fix.replace(/\s+/g, ' ').trim()}`
}

export const countLevels = (lines: Line[]) => ({
  pass: lines.filter(l => l.level === 'PASS').length,
  warn: lines.filter(l => l.level === 'WARN').length,
  fail: lines.filter(l => l.level === 'FAIL').length,
})

/**
 * The lock beside the todos file, by the plugin's own rule (a lock is live while its time is ahead and at most
 * `ttl` away; any other lock that names a writer is a stopped writer's, which the next change takes over).
 * `msLeft` is how long a live lock has left, `msAgo` how long ago a stale one ran out.
 */
export function lockState(held: { until: number } | null, now: number, ttl: number):
  { state: 'none' } | { state: 'live'; msLeft: number } | { state: 'stale'; msAgo: number } {
  if (!held) return { state: 'none' }
  if (held.until > now && held.until - now <= ttl) return { state: 'live', msLeft: held.until - now }
  return { state: 'stale', msAgo: Math.max(0, now - held.until) }
}

/** The folder part of a path (either slash); empty when there is none. */
export function folderOf(path: string): string {
  const p = path.replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return cut <= 0 ? (cut === 0 ? '/' : '') : p.slice(0, cut)
}
