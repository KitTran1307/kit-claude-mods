// Reads today's replies from the local transcripts (<config dir>/projects/<project>/<session id>.jsonl) through $.fs.
// Nothing leaves the machine; a folder or file that cannot be read is skipped, never an error.
import type { EngineInterface } from 'claude-code'

import { transcriptParser } from './report'
import type { TranscriptUse } from './report'

const MIB = 1024 * 1024
/** One read of `$.fs.read` returns at most 4 MiB: a bigger transcript is read piece by piece. */
export const READ_CAP = 4 * MIB
/** The most of one transcript read (a longer one is read from its start to this much, then its end is left out). */
export const MAX_FILE_BYTES = 256 * MIB
/** The most transcripts looked at (the newest first), so a machine with years of history stays quick. */
export const MAX_FILES = 40

const joinPath = (a: string, b: string): string => (a.endsWith('/') || a.endsWith('\\') ? a + b : `${a}/${b}`)

/** The Claude config folder: `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder; '' when neither is known. */
export function configDirOf(env: string | undefined, home: string | undefined, userProfile: string | undefined): string {
  if (env && env.trim()) return env.trim()
  const h = (home && home.trim()) || (userProfile && userProfile.trim()) || ''
  return h ? joinPath(h, '.claude') : ''
}

/** Reads a transcript in pieces of at most 4 MiB, cut at line ends, and feeds each to the parser. */
async function readInPieces($: EngineInterface, path: string, size: number, feed: (text: string) => void): Promise<void> {
  let offset = 0
  let carry = ''
  const end = Math.min(size, MAX_FILE_BYTES)
  while (offset < end) {
    const length = Math.min(READ_CAP, end - offset)
    const text = size <= READ_CAP ? await $.fs.read(path) : await $.fs.read(path, { offset, length })
    if (typeof text !== 'string') return
    offset += length
    const whole = carry + text
    const cut = whole.lastIndexOf('\n')
    if (offset >= end || cut < 0) { feed(whole); carry = ''; continue }
    feed(whole.slice(0, cut))
    carry = whole.slice(cut + 1)
  }
}

export async function readTodayTranscripts(
  $: EngineInterface, configDir: string, from: number, to: number, log: (what: string, err: unknown) => void = () => undefined,
): Promise<TranscriptUse[]> {
  if (!configDir) return []
  const root = joinPath(configDir, 'projects')
  let projects: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try { projects = await $.fs.list(root) } catch (err) { log('transcripts folder not listed', err); return [] }
  const found: Array<{ path: string; id: string; mtimeMs: number }> = []
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    try {
      for (const f of await $.fs.list(joinPath(root, p.name))) {
        if (f.kind === 'file' && f.name.endsWith('.jsonl') && f.mtimeMs >= from) {
          found.push({ path: joinPath(joinPath(root, p.name), f.name), id: f.name.slice(0, -'.jsonl'.length), mtimeMs: f.mtimeMs })
        }
      }
    } catch (err) { log('project folder skipped', err) }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const uses: TranscriptUse[] = []
  for (const f of found.slice(0, MAX_FILES)) {
    try {
      const { size } = await $.fs.stat(f.path)
      const parser = transcriptParser(f.id, from, to)
      await readInPieces($, f.path, size, parser.feed)
      uses.push(parser.result())
    } catch (err) { log('transcript skipped', err) }
  }
  return uses
}
