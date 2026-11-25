// /safety doctor: pure helpers (no engine calls). One line per check, "PASS|WARN|FAIL <text>". The words come from the
// language tables (i18n.ts); this file only decides which sentence a fact deserves. Every WARN says what still works:
// nothing here tells the person to do something to keep using the plugin. Lines carry names, counts and sizes only.
import { sanitizeShown } from './describe'
import type { Lang, Strings } from './i18n'
import { formatBytes } from './snapshot'

export type Level = 'PASS' | 'WARN' | 'FAIL'
export type Line = { level: Level; text: string }

/** What the command found out about the machine and the options; `null` is "could not be told". */
export type DoctorFacts = {
  claudeVersion: string | null
  node: string | null
  git: string | null
  snapshotsDir: string
  isWritable: boolean | null
  snapshotCount: number
  snapshotBytes: number | null
  /** Snapshots of ALL projects, their total size and whether the count stopped early; the line is left out when they are not given. */
  allCount?: number
  allBytes?: number
  allIsCut?: boolean
  /** The option: all snapshots of all projects together may take this many MB. */
  maxTotalMB?: number
  helperAnswered: boolean | null
  confirm: string
  maskSecrets: boolean
  language: Lang
  surface: string | null
}

/** The oldest Claude Code this plugin is meant for (hooks modules, plugin installs from a marketplace). */
export const MIN_CLAUDE_CODE = '2.1.275'

/** The first `major.minor.patch` in a text ("2.1.331 (Claude Code)", "2.1.280-dev.2026..."), or null. */
export function parseVersion(text: unknown): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(typeof text === 'string' ? text.slice(0, 200) : '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether `have` is at least `need`; false when either cannot be read as a version. */
export function versionAtLeast(have: string, need: string): boolean {
  const a = parseVersion(have)
  const b = parseVersion(need)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** `PASS <text>` on one line. */
export function formatLine(l: Line): string {
  const level: Level = l?.level === 'PASS' || l?.level === 'FAIL' ? l.level : 'WARN'
  return `${level} ${String(l?.text ?? '').replace(/\s+/g, ' ').trim()}`
}

export function countLevels(lines: Line[]): { pass: number; warn: number; fail: number } {
  const list = Array.isArray(lines) ? lines : []
  return {
    pass: list.filter(l => l?.level === 'PASS').length,
    warn: list.filter(l => l?.level === 'WARN').length,
    fail: list.filter(l => l?.level === 'FAIL').length,
  }
}

/** "5 ok, 1 to look at, 0 broken." */
export function summaryLine(lines: Line[], t: Strings): string {
  const c = countLevels(lines)
  return t.doctor.summary(c.pass, c.warn, c.fail)
}

/** Text from the machine that goes into a sentence: cleaned, one line, short. */
const shown = (text: unknown, max: number) => (typeof text === 'string' ? sanitizeShown(text, max) : '')

/** The version number inside a tool's own answer ("git version 2.43.0" gives "2.43.0"), else the cleaned answer. */
function versionText(text: unknown): string {
  const raw = shown(text, 60)
  return /\d+(?:\.\d+)+/.exec(raw)?.[0] ?? raw.replace(/^v/i, '')
}

const MB = 1024 * 1024

/** "12 snapshots in all projects, 340 MB of the 2 GB they may take together"; WARN when over the cap; null when the facts are not there. */
function totalLine(f: DoctorFacts, t: Strings): Line | null {
  const count = f?.allCount
  const bytes = f?.allBytes
  const capMB = f?.maxTotalMB
  if (typeof count !== 'number' || !Number.isFinite(count) || typeof bytes !== 'number' || !Number.isFinite(bytes)) return null
  if (typeof capMB !== 'number' || !Number.isFinite(capMB) || capMB <= 0) return null
  const n = Math.max(0, Math.floor(count))
  const used = Math.max(0, bytes)
  const cap = formatBytes(capMB * MB)
  const isCut = f.allIsCut === true
  if (n === 0 && !isCut) return { level: 'PASS', text: t.doctor.totalNone(cap) }
  const size = formatBytes(used)
  return used > capMB * MB ? { level: 'WARN', text: t.doctor.totalOver(n, size, cap, isCut) } : { level: 'PASS', text: t.doctor.totalOk(n, size, cap, isCut) }
}

export function doctorLines(f: DoctorFacts, t: Strings): Line[] {
  const d = t.doctor
  const lines: Line[] = []

  // Claude Code: older than the minimum is a FAIL (parts of the plugin will not run), unknown a WARN
  const have = parseVersion(f?.claudeVersion)
  if (have === null) {
    lines.push({ level: 'WARN', text: d.claudeUnknown(MIN_CLAUDE_CODE) })
  } else {
    const version = have.join('.')
    lines.push(
      versionAtLeast(version, MIN_CLAUDE_CODE)
        ? { level: 'PASS', text: d.claudeOk(version, MIN_CLAUDE_CODE) }
        : { level: 'FAIL', text: d.claudeOld(version, MIN_CLAUDE_CODE) },
    )
  }

  // Node: without it the plugin copies small text files itself
  const hasNode = typeof f?.node === 'string' && f.node.trim() !== ''
  lines.push(hasNode ? { level: 'PASS', text: d.nodeOk(versionText(f.node)) } : { level: 'WARN', text: d.nodeMissing })

  // Git: without it there is no Git snapshot
  const hasGit = typeof f?.git === 'string' && f.git.trim() !== ''
  lines.push(hasGit ? { level: 'PASS', text: d.gitOk(versionText(f.git)) } : { level: 'WARN', text: d.gitMissing })

  // the snapshot folder
  const dir = shown(f?.snapshotsDir, 200) || '?'
  if (f?.isWritable === true) {
    const count = typeof f.snapshotCount === 'number' && Number.isFinite(f.snapshotCount) ? Math.max(0, Math.floor(f.snapshotCount)) : 0
    const size = count > 0 && typeof f.snapshotBytes === 'number' && Number.isFinite(f.snapshotBytes) ? formatBytes(f.snapshotBytes) : ''
    lines.push({ level: 'PASS', text: d.folderOk(dir, d.snapshotCount(count, size)) })
  } else if (f?.isWritable === false) {
    lines.push({ level: 'FAIL', text: d.folderFail(dir) })
  } else {
    lines.push({ level: 'WARN', text: d.folderUnknown(dir) })
  }

  // all snapshots of all projects against the total cap
  const total = totalLine(f, t)
  if (total) lines.push(total)

  // the helper script only matters where Node exists
  if (hasNode) {
    lines.push(
      f.helperAnswered === true ? { level: 'PASS', text: d.helperOk }
        : f.helperAnswered === false ? { level: 'WARN', text: d.helperNo }
        : { level: 'WARN', text: d.helperUnknown },
    )
  }

  // the options in use; a `confirm` that is not one of the three is read as `risky`
  const confirm = f?.confirm
  const confirmText =
    confirm === 'risky' ? d.confirmRisky
      : confirm === 'always' ? d.confirmAlways
      : confirm === 'never' ? d.confirmNever
      : d.confirmUnknown(shown(confirm, 30))
  const known = confirm === 'risky' || confirm === 'always' || confirm === 'never'
  const language = f?.language === 'vi' ? d.languageNames.vi : d.languageNames.en
  lines.push({ level: known ? 'PASS' : 'WARN', text: d.options(confirmText, f?.maskSecrets === false ? d.maskOff : d.maskOn, language) })

  // the surface (terminal, desktop app, ...) changes nothing in what the plugin does
  const surface = shown(f?.surface, 30)
  lines.push({ level: 'PASS', text: surface ? d.surface(surface) : d.surfaceUnknown })
  return lines
}
