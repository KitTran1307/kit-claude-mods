// `/safety`: the text each subcommand answers with. Engine-free: the vault, the clock and the doctor's facts come in as
// `deps`, so register.tsx binds them to the engine and the tests to an in-memory world. The answer is what the person reads and
// what the model reads too, so it stays factual. Nothing here asks for confirmation (a restore saves an undo point first) and
// nothing runs a git command: git hints are only text (describe.ts).
import { listText, restoreText, sanitizeShown, undoText } from './describe'
import { doctorLines, formatLine, summaryLine } from './doctor'
import type { DoctorFacts } from './doctor'
import { parseArgs } from './flow'
import type { Strings } from './i18n'
import { baseName, isAbsolute, isFilesystemRoot } from './paths'
import { summarize } from './snapshot'
import { findSnapshot, listSnapshots, restoreSnapshot, undoRestore } from './vault'
import type { RestoreOutcome, VaultCfg, VaultEnv } from './vault'

export type SafetyDeps = {
  env: VaultEnv
  /** The project root; '' when it is not known. */
  root: string
  cfg: VaultCfg
  t: Strings
  /** The time now (ms), for "today 14:05". */
  now: number
  /** What `/safety doctor` found out about the machine. */
  facts: () => Promise<DoctorFacts>
  /** Called after files were put back: what the guard remembers about saved files no longer holds. */
  changed: () => void
  /** One restore at a time: set while a restore or undo runs. */
  lock: { busy: boolean }
}

/** The words for a restore or an undo that was refused or did not start (`reason`), else the usual result text. */
export function outcomeText(o: RestoreOutcome, arg: string, t: Strings, mode: 'restore' | 'undo'): string {
  if (o.reason === 'other-project') return t.noSuchSnapshot(arg !== '' ? arg : String(o.n))
  if (o.reason === 'not-found') return t.damaged(String(o.n))
  // `failed` is a result like any other: nothing was restored, and the text says so.
  return mode === 'restore' ? restoreText(o, t) : undoText(o, t)
}

const usable = (root: string): boolean => typeof root === 'string' && isAbsolute(root) && !isFilesystemRoot(root)

/** The reason a call failed as one short plain line (no stack, no path). */
function whyText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return sanitizeShown(text, 80) || 'something went wrong'
}

/** Runs `/safety <args>`. Never throws: a failure is a line of text. */
export async function runSafety(args: unknown, d: SafetyDeps): Promise<{ text: string }> {
  const t = d.t
  try {
    const { verb, tail } = parseArgs(args)
    if (verb === 'help' || verb === '--help' || verb === '-h' || verb === '?') return { text: [t.usage, t.usageRestore].join('\n') }
    if (verb === '' || verb === 'list') {
      if (tail !== '') return { text: t.usage }
      if (!usable(d.root)) return { text: [t.projectUnknown, t.usage].join('\n') }
      const items = (await listSnapshots(d.env, d.root)).map(summarize)
      return { text: [listText(items, baseName(d.root), d.now, t), t.usage].join('\n') }
    }
    if (verb === 'restore') {
      if (!usable(d.root)) return { text: t.projectUnknown }
      if (d.lock.busy) return { text: t.busy }
      d.lock.busy = true
      try {
        const arg = sanitizeShown(tail.replace(/^#/, ''), 40)
        const m = await findSnapshot(d.env, d.root, tail)
        if (!m) return { text: tail === '' ? t.noSnapshots : t.noSuchSnapshot(arg) }
        const outcome = await restoreSnapshot(d.env, d.root, m, d.cfg)
        if (outcome.reason === undefined) d.changed()
        return { text: outcomeText(outcome, arg, t, 'restore') }
      } finally {
        d.lock.busy = false
      }
    }
    if (verb === 'undo') {
      if (tail !== '') return { text: t.usage }
      if (!usable(d.root)) return { text: t.projectUnknown }
      if (d.lock.busy) return { text: t.busy }
      d.lock.busy = true
      try {
        const outcome = await undoRestore(d.env, d.root, d.cfg)
        if (outcome === null) return { text: t.noUndo }
        if (outcome.reason === undefined) d.changed()
        return { text: outcomeText(outcome, '', t, 'undo') }
      } finally {
        d.lock.busy = false
      }
    }
    if (verb === 'doctor') {
      if (tail !== '') return { text: t.usage }
      const lines = doctorLines(await d.facts(), t)
      return { text: [...lines.map(formatLine), summaryLine(lines, t)].join('\n') }
    }
    return { text: t.usage }
  } catch (error) {
    return { text: t.failed(whyText(error)) }
  }
}
