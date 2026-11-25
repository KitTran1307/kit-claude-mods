// /graphite doctor helpers: pure, no engine calls. One line per check, "PASS|WARN|FAIL <name> - <detail>", a WARN or
// FAIL ending in " Fix: <hint>". Names, counts and sizes only.

export type Level = 'PASS' | 'WARN' | 'FAIL'
export type Line = { level: Level; name: string; detail: string; fix?: string }

/** The oldest Claude Code that accepts a theme; on an earlier one the app keeps its own look, with no error. */
export const MIN_CLAUDE_CODE = '2.1.323'

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

export function formatLine(line: Line): string {
  const base = `${line.level} ${line.name} - ${line.detail.replace(/\s+/g, ' ').trim()}`
  return line.level === 'PASS' || !line.fix ? base : `${base} Fix: ${line.fix.replace(/\s+/g, ' ').trim()}`
}

export function summary(lines: Line[], fmt: (pass: number, warn: number, fail: number) => string = (p, w, f) => `${p} ok, ${w} to look at, ${f} broken.`): string {
  const n = (level: Level) => lines.filter(l => l.level === level).length
  return fmt(n('PASS'), n('WARN'), n('FAIL'))
}
