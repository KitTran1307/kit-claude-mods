// What `/safety doctor` looks at on the real machine: the Claude Code version, Node, Git, whether the snapshot folder can be
// written, how much is saved, whether the Node helper answers. Engine-bound (the wording is doctor.ts). Read-only apart from the
// tiny `.doctor` file in the snapshot folder. Each look is guarded: a fact that cannot be found out is `null`, never an error.
// Every program runs with the snapshot folder as its working directory when that folder exists, never the project: on Windows a
// program is looked for in the working directory first, and a project may hold a `node.exe` or `git.exe` of its own.
import type { EngineInterface } from 'claude-code'

import { parseVersion } from './doctor'
import type { DoctorFacts } from './doctor'
import type { Lang } from './i18n'
import { isAbsolute, joinPath } from './paths'
import { MANIFEST_FILE, isProjectKey, isSnapshotId, parseManifest, projectKey } from './snapshot'
import { listSnapshots, nowOf } from './vault'
import type { VaultEnv } from './vault'

export type FactsInput = {
  env: VaultEnv
  root: string
  /** The `confirm` option as written. */
  confirm: string
  maskSecrets: boolean
  language: Lang
  /** The option: all snapshots of all projects together may take this many MB. */
  maxTotalMB: number
}

const SHORT_MS = 5_000

/** The snapshot folder when it exists (so a program runs there and not in the project), else undefined. Never creates it. */
async function runFolder(env: VaultEnv): Promise<string | undefined> {
  try {
    if (!isAbsolute(env.snapshotsRoot)) return undefined
    const st = await env.io.stat(env.snapshotsRoot)
    return st !== null && st !== undefined && st.kind === 'dir' ? env.snapshotsRoot : undefined
  } catch {
    return undefined
  }
}

/** The first line a program printed for `--version`, or null when it does not run or says nothing. */
async function versionOf($: EngineInterface, program: string, cwd: string | undefined): Promise<string | null> {
  try {
    const r = await $.process.run([program, '--version'], { timeoutMs: SHORT_MS, ...(cwd !== undefined ? { cwd } : {}) })
    const line = r.exitCode === 0 ? r.stdout.trim().split('\n')[0]?.trim() ?? '' : ''
    return line === '' ? null : line
  } catch {
    return null
  }
}

async function claudeVersion($: EngineInterface, cwd: string | undefined): Promise<string | null> {
  try {
    const v = await $.session.version()
    const text = v?.base ?? v?.version
    if (parseVersion(text)) return String(text)
  } catch {
    // ask the program instead
  }
  const printed = await versionOf($, 'claude', cwd)
  return parseVersion(printed) ? printed : null
}

/** Writes and rewrites a tiny file in the snapshot folder (made if it is not there yet): true when both worked and it reads back. */
async function canWrite($: EngineInterface, dir: string): Promise<boolean | null> {
  if (!isAbsolute(dir)) return null
  try {
    const file = joinPath(dir, '.doctor')
    await $.fs.write(file, 'ok\n')
    await $.fs.write(file, 'ok again\n')
    return (await $.fs.read(file)) === 'ok again\n'
  } catch {
    return false
  }
}

/** Whether the Node helper script answers `hello`. */
async function helperAnswers($: EngineInterface, helper: string, cwd: string | undefined): Promise<boolean> {
  try {
    const r = await $.process.run(['node', helper], { stdin: '{"cmd":"hello"}', timeoutMs: SHORT_MS, ...(cwd !== undefined ? { cwd } : {}) })
    if (r.exitCode !== 0) return false
    const last = r.stdout.trim().split('\n').pop() ?? ''
    const answer: unknown = JSON.parse(last)
    return typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

/** Most projects and snapshots one count looks at, and how long it may take: the doctor must answer, not wait on a huge folder. */
const COUNT_PROJECTS = 200
const COUNT_PER_PROJECT = 500
const COUNT_MANIFESTS = 2_000
const COUNT_BUDGET_MS = 4_000

/** The marker the vault leaves in a snapshot it has deleted (the folder may stay): such a snapshot does not count. */
const PRUNED_MARKER = 'pruned'

/**
 * How many snapshots there are in ALL projects and how much they take together (what the manifests say), the same figure the cap
 * `maxTotalMB` is held against. Read-only. A damaged or deleted snapshot is not counted. `isCut` is true when the count stopped early
 * (too many projects, snapshots or time), so the numbers are a lower bound. null when the snapshot folder is not usable.
 */
export async function countAllSnapshots(env: VaultEnv, limits: { manifests?: number; budgetMs?: number } = {}): Promise<{ count: number; bytes: number; isCut: boolean } | null> {
  try {
    const { io, snapshotsRoot } = env
    if (typeof snapshotsRoot !== 'string' || !isAbsolute(snapshotsRoot)) return null
    const room = typeof limits.manifests === 'number' && limits.manifests >= 0 ? Math.floor(limits.manifests) : COUNT_MANIFESTS
    const budget = typeof limits.budgetMs === 'number' && limits.budgetMs >= 0 ? limits.budgetMs : COUNT_BUDGET_MS
    const started = await nowOf(io)
    const out = { count: 0, bytes: 0, isCut: false }
    let read = 0
    const keys = (await io.list(snapshotsRoot)).filter(e => e.kind === 'dir' && !e.isLink && isProjectKey(e.name))
    if (keys.length > COUNT_PROJECTS) out.isCut = true
    for (const k of keys.slice(0, COUNT_PROJECTS)) {
      const ids = (await io.list(joinPath(snapshotsRoot, k.name))).filter(e => e.kind === 'dir' && !e.isLink && isSnapshotId(e.name))
      if (ids.length > COUNT_PER_PROJECT) out.isCut = true
      for (const e of ids.slice(0, COUNT_PER_PROJECT)) {
        if (read >= room || (await nowOf(io)) - started > budget) return { ...out, isCut: true }
        read += 1
        try {
          const dir = joinPath(snapshotsRoot, k.name, e.name)
          const m = parseManifest(await io.readText(joinPath(dir, MANIFEST_FILE)))
          if (!m || m.id !== e.name || projectKey(m.root) !== k.name || (await io.stat(joinPath(dir, PRUNED_MARKER)))) continue
          out.count += 1
          out.bytes += Number.isFinite(m.totalBytes) && m.totalBytes > 0 ? m.totalBytes : 0
        } catch {
          // a damaged one is not counted
        }
      }
    }
    return out
  } catch {
    return null
  }
}

export async function gatherFacts($: EngineInterface, i: FactsInput): Promise<DoctorFacts> {
  const cwd = await runFolder(i.env)
  const [claude, node, git] = await Promise.all([claudeVersion($, cwd), versionOf($, 'node', cwd), versionOf($, 'git', cwd)])
  let surface: string | null = null
  try {
    const surfaces = await $.session.surfaces()
    surface = surfaces.length > 0 ? surfaces.join(', ') : null
  } catch {
    // not reported
  }
  const isWritable = await canWrite($, i.env.snapshotsRoot)
  let snapshotCount = 0
  let snapshotBytes: number | null = null
  try {
    const items = isAbsolute(i.root) ? await listSnapshots(i.env, i.root) : []
    snapshotCount = items.length
    snapshotBytes = items.reduce((sum, m) => sum + m.totalBytes, 0)
  } catch {
    // counted as none
  }
  let all: Awaited<ReturnType<typeof countAllSnapshots>> = null
  try {
    all = await countAllSnapshots(i.env)
  } catch {
    // the line is left out
  }
  return {
    claudeVersion: claude,
    node,
    git,
    snapshotsDir: i.env.snapshotsRoot,
    isWritable,
    snapshotCount,
    snapshotBytes,
    ...(all === null ? {} : { allCount: all.count, allBytes: all.bytes, allIsCut: all.isCut }),
    maxTotalMB: i.maxTotalMB,
    // the check above may have made the snapshot folder: the helper runs in it too
    helperAnswered: node === null ? null : await helperAnswers($, i.env.helper, (await runFolder(i.env)) ?? cwd),
    confirm: i.confirm,
    maskSecrets: i.maskSecrets,
    language: i.language,
    surface,
  }
}
