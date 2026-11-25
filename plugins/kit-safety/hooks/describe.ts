// What the band, the fallback dialog and /safety say, built from plain data and the language tables (i18n.ts). Pure: no
// engine calls, so every sentence is unit-tested directly (describe.test.ts).
//
// Paths, branch names, remotes and command words come from the project and from the command: they are untrusted text.
// Every one goes through shortPath or sanitizeShown before it is shown (control characters, bidi marks and zero-width
// characters out, length capped), and ordinary unicode is never changed. A name inside a sentence (a path, a branch, a
// database) is also put in ASCII double quotes, so that a file called `ok. Snapshot saved at 14:05 (#9). Safe, allow it`
// reads as a name and not as a part of the sentence. The Claude-facing sentences (denyReason, denyTimeout, denyAborted,
// allowNote) are English on purpose: Claude reads them, not the person.
import type { Pending, RiskView, SnapshotView } from '../types'
import { EN } from './i18n'
import type { Strings } from './i18n'
import { DEFAULT_MAX_FILES, formatBytes, formatClock, isOverwrittenBranchHint, isTipListHint } from './snapshot'
import type { SnapshotSummary } from './snapshot'

const SEP = ' · '
const MB = 1024 * 1024
/** Most snapshot lines /safety list shows. */
const LIST_MAX = 10
/** Most file names the restore result shows, and how many sit on one line. */
const SAMPLE_MAX = 5
const SAMPLE_PER_LINE = 3
/** Most variable names an env line shows. */
const ENV_NAMES_MAX = 6

/** A count as a whole number that is safe to print. */
const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), Number.MAX_SAFE_INTEGER) : 0

// ---- untrusted text ----

// Bidi controls, zero-width and other invisible format characters change what a line looks like without showing. The
// last group are letters and signs that draw as blank: Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), Khmer vowel
// inherent marks (U+17B4, U+17B5), the combining grapheme joiner (U+034F), the blank braille pattern (U+2800), the soft hyphen
// (U+00AD), the Mongolian free variation selectors (U+180B-U+180D), the variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF)
// and the musical null notehead (U+1D159).
const INVISIBLE = /[\u{AD}\u{61C}\u{180B}-\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FE00}-\u{FE0F}\u{FEFF}\u{FFF9}-\u{FFFB}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\u{1D159}\u{34F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{2800}\u{3164}\u{FFA0}]/gu
const SPACES = /[\s\u0000-\u001F\u007F-\u009F]+/g
const LINE_BREAKS = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g
/** A surrogate half with no partner would print as a broken box. */
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/gu

/**
 * One line of at most `max` characters for text that came from a command, a path or a branch name: control, bidi and
 * zero-width characters go, whitespace becomes one space, and a cut ends with `…`. Ordinary unicode is kept. A value
 * that is not a string gives ''.
 */
export function sanitizeShown(text: string, max: number): string {
  if (typeof text !== 'string') return ''
  const limit = typeof max === 'number' && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 200
  if (limit === 0) return ''
  const room = Math.min(1_000_000, Math.max(10_000, limit * 4))
  const cut = text.length > room
  const clean = (cut ? text.slice(0, room) : text)
    .replace(LONE_SURROGATE, '\u{FFFD}')
    .replace(INVISIBLE, '')
    .replace(SPACES, ' ')
    .trim()
  if (clean === '') return ''
  const chars = Array.from(clean)
  if (!cut && chars.length <= limit) return clean
  return limit === 1 ? '…' : `${chars.slice(0, limit - 1).join('').trimEnd()}…`
}

/** A path with its controls and invisible characters taken out; spaces inside a name stay as they are. */
function cleanPath(p: string): string {
  // A path of 20 000+ characters keeps both ends, so that its last segment survives.
  const text = p.length > 20_000 ? p.slice(0, 8000) + p.slice(-8000) : p
  return text.replace(LONE_SURROGATE, '\u{FFFD}').replace(INVISIBLE, '').replace(LINE_BREAKS, ' ').replace(CONTROLS, '')
}

const isSep = (c: string | undefined) => c === '/' || c === '\\'

/**
 * A path for one line, at most `max` characters (8 at least): a long one loses its middle (`/home/…/Button.tsx`) and always
 * keeps its last segment (and its trailing separator, which marks a folder); a last segment that is itself too long is
 * cut in its middle and keeps its end. Control characters and bidi marks are taken out. A value that is not a string
 * gives ''. Works with `/` and `\` alike.
 */
export function shortPath(p: string, max = 48): string {
  if (typeof p !== 'string') return ''
  const limit = typeof max === 'number' && Number.isFinite(max) ? Math.min(Math.max(Math.floor(max), 8), 2000) : 48
  const clean = cleanPath(p)
  if (clean.trim() === '') return ''
  const chars = Array.from(clean)
  if (chars.length <= limit) return clean
  const lastSep = (from: number) => {
    for (let i = from; i >= 0; i -= 1) if (isSep(chars[i])) return i
    return -1
  }
  // the last segment starts after `cut`; the separators that end the path belong to it
  let end = chars.length - 1
  while (end > 0 && isSep(chars[end])) end -= 1
  const cut1 = lastSep(end)
  const cut2 = cut1 > 0 ? lastSep(cut1 - 1) : -1
  // the parent folder goes along when it fits in about half of the room
  const cut = cut2 >= 0 && chars.length - cut2 - 1 <= Math.floor(limit * 0.55) ? cut2 : cut1
  let tail = chars.slice(cut + 1)
  if (tail.length + 2 > limit) {
    tail = chars.slice(cut1 + 1)
    if (tail.length + 2 <= limit) return `…/${tail.join('')}`
    // one name longer than the line: keep its start and its end (the extension)
    const keepEnd = Math.min(12, limit - 2)
    const keepStart = limit - 1 - keepEnd
    return `${tail.slice(0, keepStart).join('')}…${tail.slice(tail.length - keepEnd).join('')}`
  }
  const sep = chars.includes('/') ? '/' : chars.includes('\\') ? '\\' : '/'
  let best = -1
  for (let i = 0; i < cut; i += 1) {
    if (isSep(chars[i]) && i + 3 + tail.length <= limit) best = i
  }
  const head = best >= 0 ? chars.slice(0, best).join('') : ''
  return best >= 0 ? `${head}${sep}…${sep}${tail.join('')}` : `…${sep}${tail.join('')}`
}

/**
 * A name in ASCII double quotes. A `"` inside the name becomes `'`, so that the name cannot close the quotes and go on as a
 * part of the sentence.
 */
const quoted = (name: string): string => `"${name.replace(/"/g, "'")}"`

/** A name from the call (branch, database, table) or '' when there is none. */
function nameOf(name: unknown): string {
  return typeof name === 'string' ? sanitizeShown(name, 60) : ''
}

/** A name for a sentence, quoted; '' when there is none. */
const quotedName = (name: unknown): string => {
  const text = nameOf(name)
  return text === '' ? '' : quoted(text)
}

/**
 * The remote of a force push for a sentence. A name (`origin`) stays as it is; an address shows only its host, never a user,
 * a password or a path, and the well-known hosts get their own spelling (`GitHub`).
 */
export function remoteLabel(remote: unknown): string {
  if (typeof remote !== 'string') return ''
  const text = sanitizeShown(remote, 120)
  if (text === '') return ''
  if (!text.includes('://') && !text.includes('@')) return sanitizeShown(text, 40)
  // the host is what follows the last `@` of the part before the first `/` (`https://user:pw@host/x`, `git@host:x/y`)
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text)
  const authority = (scheme ? text.slice(scheme[0].length).split('/')[0] : text.split(/[:/]/)[0]) ?? ''
  const host = (authority.slice(authority.lastIndexOf('@') + 1).split(':')[0] ?? '').toLowerCase().replace(/^www\./, '')
  if (host === 'github.com') return 'GitHub'
  if (host === 'gitlab.com') return 'GitLab'
  if (host === 'bitbucket.org') return 'Bitbucket'
  return sanitizeShown(host, 40)
}

// ---- the risk ----

function pathsOf(r: RiskView): string[] {
  return Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : []
}

/** `.`, `./` and '' name the project folder itself (a name of nothing but blanks does not: it is some file with an odd name). */
const isProjectRoot = (p: string) => p === '' || /^\.[\\/]*$/.test(p.trim())

const isFolder = (p: string) => /[\\/]$/.test(cleanPath(p))

/**
 * `find . -name node_modules -exec rm -rf {} +`: what the filter looks for and where it looks, in quotes. '' when the name or the
 * place is not known (the caller then says "files that this command picks").
 */
function namedTitle(r: RiskView, paths: string[], t: Strings): string {
  const name = quotedName(r.match)
  if (name === '' || paths.length === 0) return ''
  // the project folder among the places it looks: it can reach anywhere in the project
  if (paths.some(isProjectRoot)) return t.title.deleteNamedHere(name)
  const n = Math.max(whole(r.count), paths.length)
  return t.title.deleteNamedUnder(name, `${quoted(shortPath(paths[0] ?? '', 40) || '…')}${n > 1 ? t.title.listMore(n - 1) : ''}`)
}

function pathTitle(r: RiskView, t: Strings, kind: 'delete' | 'overwrite'): string {
  const del = kind === 'delete'
  const paths = pathsOf(r)
  // `find ... -delete`: the files are chosen at run time, so it is not "everything in this folder" even if it looks there; a name
  // pattern the filter holds says what it deletes
  if (r.picks === true) return (del ? namedTitle(r, paths, t) : '') || (del ? t.title.deletePicked : t.title.overwritePicked)
  if (paths.some(isProjectRoot)) return del ? t.title.deleteEverything : t.title.overwriteEverything
  if (paths.length === 0) return del ? t.title.deletePicked : t.title.overwritePicked
  const n = Math.max(whole(r.count), paths.length)
  const show = (p: string, max: number) => quoted(shortPath(p, max) || '…')
  if (n === 1) {
    const only = paths[0] ?? ''
    if (!del) return t.title.overwriteFile(show(only, 48))
    return isFolder(only) ? t.title.deleteFolder(show(only, 48)) : t.title.deleteFile(show(only, 48))
  }
  const shown = paths.slice(0, 3)
  const list = shown.map(p => show(p, 28)).join(', ') + (n > shown.length ? t.title.listMore(n - shown.length) : '')
  return del ? t.title.deleteItems(n, list) : t.title.overwriteItems(n, list)
}

/** A remote in a sentence: a plain name or host (`origin`, `GitHub`, `git.acme.example`) as it is, anything with spaces or signs in quotes. */
const remoteText = (remote: unknown): string => {
  const text = remoteLabel(remote)
  return text === '' || /^[\p{L}\p{N}._-]+$/u.test(text) ? text : quoted(text)
}

/** `(+2 more)` after a name when the call names more than one branch. */
const extraOf = (r: RiskView, t: Strings): string => (whole(r.extra) > 0 ? t.title.plusMore(whole(r.extra)) : '')

/** "About to delete the folder "build/"": the first sentence for one risk. */
export function riskTitle(r: RiskView, t: Strings): string {
  if (!r || typeof r !== 'object') return t.title.unknown
  switch (r.kind) {
    case 'delete': return pathTitle(r, t, 'delete')
    case 'overwrite': return pathTitle(r, t, 'overwrite')
    case 'force-push': {
      const name = quotedName(r.name)
      return t.title.forcePush(name === '' ? '' : `${name}${extraOf(r, t)}`, remoteText(r.remote))
    }
    case 'reset-hard': return t.title.resetHard
    case 'clean': return t.title.clean
    case 'discard': return t.title.discard
    case 'branch-delete': {
      const name = quotedName(r.name)
      return t.title.branchDelete(name === '' ? '' : `${name}${extraOf(r, t)}`)
    }
    case 'db-drop': return t.title.dbDrop(quotedName(r.name))
    case 'unparsed': return t.title.unparsed
    case 'git-erase': return gitEraseTitle(r.label, t)
    default: return t.title.unknown
  }
}

/** The title of a `git-erase` risk by its label (fixed words from risk.ts); any other label gets the general sentence. */
function gitEraseTitle(label: unknown, t: Strings): string {
  switch (typeof label === 'string' ? label.trim() : '') {
    case 'git stash drop': return t.title.gitStashDrop
    case 'git stash clear': return t.title.gitStashClear
    case 'git update-ref -d': return t.title.gitRefDelete
    case 'git reflog expire':
    case 'git gc --prune=now': return t.title.gitHistoryErase
    default: return t.title.gitErase
  }
}

/** The second sentence for one risk (why it is hard to undo), or '' when there is nothing more to say. */
export function riskNote(r: RiskView, t: Strings): string {
  if (!r || typeof r !== 'object') return ''
  switch (r.kind) {
    case 'force-push': return t.note.forcePush
    case 'reset-hard':
    case 'discard': return t.note.uncommitted
    case 'branch-delete': return t.note.branchDelete
    case 'db-drop': return t.note.dbDrop
    case 'unparsed': return t.note.unparsed
    case 'git-erase': return t.note.gitErase
    default: return ''
  }
}

// ---- the snapshot ----

/** Time as the band shows it, or '' when it is not a time. */
function clockOf(ms: unknown): string {
  const clock = typeof ms === 'number' ? formatClock(ms) : '--:--'
  return clock === '--:--' ? '' : clock
}

/** The snapshot number as text, or '' when it is not a usable number. */
function numberOf(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? String(whole(n)) : ''
}

/**
 * A `too-big` view of a call that was saved with the small limits of a quiet cleanup (flow.ts `quietLimits`) also names the number
 * of files that tripped; the contract (types/index.d.ts) has no field for it, so it travels as an optional extra.
 */
export type TooBigView = Extract<SnapshotView, { state: 'too-big' }> & { limitFiles?: number }

/** The file limit a `too-big` view names: its own when it has one, else the usual one. */
const fileLimitOf = (s: Extract<SnapshotView, { state: 'too-big' }>): number => {
  const own = whole((s as TooBigView).limitFiles)
  return own > 0 ? own : DEFAULT_MAX_FILES
}

/** "Snapshot saved at 14:05 (#7) · 342 files, 18 MB" with how the band should colour it. The size shows from 2 files up (or a big one). */
export function snapshotLine(s: SnapshotView, t: Strings): { text: string; level: 'ok' | 'warn' } {
  switch (s?.state) {
    case 'saved': {
      const files = whole(s.files)
      // Git was asked to keep the uncommitted changes and could not: never say "saved" without saying that
      if (s.isGitPartial === true && files === 0) return { text: t.snapshot.gitPartialNoFiles, level: 'warn' }
      const parts = [t.snapshot.saved(clockOf(s.at), numberOf(s.n))]
      if (files >= 2 || (files === 1 && whole(s.bytes) >= MB)) parts.push(t.snapshot.size(files, formatBytes(s.bytes)))
      if (s.isPartial) parts.push(t.snapshot.partial)
      const text = parts.join(SEP)
      if (s.isGitPartial === true) return { text: `${text}, ${t.snapshot.gitPartial}`, level: 'warn' }
      return { text, level: s.isPartial ? 'warn' : 'ok' }
    }
    case 'none':
      return s.hasGit ? { text: t.snapshot.gitOnly, level: 'ok' } : { text: t.snapshot.nothing, level: 'warn' }
    case 'too-big':
      return { text: s.byFiles === true ? t.snapshot.tooMany(fileLimitOf(s)) : t.snapshot.tooBig(whole(s.limitMB)), level: 'warn' }
    case 'needs-node':
      return { text: t.snapshot.needsNode, level: 'warn' }
    default:
      return { text: t.snapshot.failed, level: 'warn' }
  }
}

/** Variable names for a line: names only (anything from an `=` on is dropped), cleaned, at most 6 and then "and N more". */
function nameList(names: unknown, t: Strings): string {
  const list = (Array.isArray(names) ? names : [])
    .filter((n): n is string => typeof n === 'string')
    .map(n => sanitizeShown(n.split('=')[0] ?? '', 40))
    .filter(n => n !== '')
  return list.slice(0, ENV_NAMES_MAX).join(', ') + (list.length > ENV_NAMES_MAX ? t.env.more(list.length - ENV_NAMES_MAX) : '')
}

/** "The old file has 12 variables, the new one 9: it loses A, B, C." Names only, never a value. */
export function envLine(env: NonNullable<Pending['env']>, t: Strings): string {
  const lost = nameList(env?.removed, t)
  const added = nameList(env?.added, t)
  const tail = lost && added ? t.env.both(lost, added) : lost ? t.env.loses(lost) : added ? t.env.adds(added) : t.env.same
  return `${t.env.head(whole(env?.before), whole(env?.after))}: ${tail}.`
}

// ---- the card ----

export type Card = {
  title: string
  command: string
  note: string
  /** The start of a command that could not be read to the end ("The command starts: ..."), or ''. */
  snippet: string
  snapshot: { text: string; level: 'ok' | 'warn' }
  env: string
  more: number
}

function risksOf(p: Pending): RiskView[] {
  return Array.isArray(p?.risks) ? p.risks.filter(r => r && typeof r === 'object') : []
}

/** The title of a confirmation: the first risk, and "(+N more)" when the call carries others. */
function titleOf(p: Pending, t: Strings): string {
  const risks = risksOf(p)
  const first = risks[0]
  const base = first ? riskTitle(first, t) : t.title.unknown
  return risks.length > 1 ? `${base}${t.title.plusMore(risks.length - 1)}` : base
}

/**
 * The snapshot line of a card. A call whose only risks are a command that could not be read, force pushes that found no remote
 * branch to keep, or the emptying of Git's own safety nets, has nothing to save, and says so.
 */
function cardSnapshot(p: Pending, risks: RiskView[], t: Strings): Card['snapshot'] {
  const s = p?.snapshot
  if (s?.state === 'none' && !s.hasGit && risks.length > 0 && risks.every(r => r.kind === 'unparsed' || r.kind === 'force-push' || r.kind === 'git-erase')) {
    return { text: t.snapshot.nothingToSave, level: 'warn' }
  }
  const line = snapshotLine(s, t)
  // The delete takes the repository's own .git with it and a snapshot never holds it: never leave "saved" standing alone.
  if (p?.gitLost === true) return { text: `${line.text}${SEP}${t.snapshot.gitLost}`, level: 'warn' }
  return line
}

/** The first words of the command for a question about a command that could not be read to the end, in quotes (a `"` in it becomes `'`). */
function snippetText(p: Pending, t: Strings): string {
  if (typeof p?.snippet !== 'string') return ''
  const text = sanitizeShown(p.snippet, 120)
  return text === '' ? '' : t.snippet(text.replace(/"/g, "'"))
}

/** Everything the band shows for the confirmation at the front of the queue. `queued` is how many others wait behind it. */
export function cardOf(p: Pending, queued: number, t: Strings): Card {
  const risks = risksOf(p)
  const labels = [...new Set(risks.map(r => sanitizeShown(r.label, 40)).filter(label => label !== ''))]
  // two risks that read the same (rm -rf a && rm -rf b) show their label once
  const notes: string[] = []
  for (const r of risks) {
    const note = riskNote(r, t)
    if (note && !notes.includes(note)) notes.push(note)
    if (notes.length >= 2) break
  }
  // the other commands of the line that were not flagged (not said when the line could not be read to the end: that note says more)
  const others = whole(p?.others)
  if (others > 0 && !risks.some(r => r.kind === 'unparsed')) notes.push(t.note.others(others))
  const note = notes.join(' ')
  return {
    title: titleOf(p, t),
    command: sanitizeShown(labels.join(SEP), 120),
    note: p?.isAgent ? (note ? `${note} ${t.byAgent}` : t.byAgent) : note,
    snippet: snippetText(p, t),
    snapshot: cardSnapshot(p, risks, t),
    env: p?.env ? envLine(p.env, t) : '',
    more: whole(queued),
  }
}

/** A sentence that ends in a full stop (or another stop), for text that is joined into a paragraph. */
const sentence = (text: string) => (text === '' || /[.!?…]$/.test(text) ? text : `${text}.`)

/** The fallback dialog (where there is no band): title, note, the start of the command, variable names, snapshot, then "Allow it?". */
export function questionText(p: Pending, t: Strings): string {
  const c = cardOf(p, 0, t)
  return [sentence(c.title), c.note, c.snippet === '' ? '' : sentence(c.snippet), c.env, sentence(c.snapshot.text), t.allowIt]
    .filter(part => part !== '')
    .join(' ')
}

// ---- what Claude reads (English) ----

/** Sent to Claude when the person chooses Cancel. */
export function denyReason(p: Pending): string {
  return `The person chose Cancel in Safety Net: ${titleOf(p, EN)}. Nothing was changed. Ask them what they want instead.`
}

/** Sent to Claude when the question got no answer in time. */
export function denyTimeout(p: Pending): string {
  return `Safety Net asked the person to confirm this and got no answer in time: ${titleOf(p, EN)}. Nothing was changed. Ask them whether to go ahead.`
}

/** Sent to Claude when the call was interrupted (the person pressed Escape, the session ended) before anyone answered. */
export function denyAborted(p: Pending): string {
  return `The call was interrupted before the person answered in Safety Net: ${titleOf(p, EN)}. Nothing was changed.`
}

/** What a Git-only snapshot holds, by the kinds of risk the call carried (unknown kinds: no claim about uncommitted changes). */
function gitSavedNote(kinds: unknown): string {
  const list = Array.isArray(kinds) ? kinds : []
  if (list.includes('reset-hard') || list.includes('discard')) {
    return 'Safety Net saved the Git state (commits and uncommitted changes) before this ran; /safety restore shows how to bring it back.'
  }
  // a force push throws nothing local away: only the last-fetched copy of the remote branch is kept
  if (list.length > 0 && list.every(k => k === 'force-push')) {
    return 'Before this ran, Safety Net saved the last-fetched copy of the remote branch as a branch name you can restore. It does not hold your uncommitted changes; /safety restore shows how to bring the branch back.'
  }
  return 'Safety Net saved the Git state before this ran; /safety restore shows how to bring it back.'
}

/**
 * The context line for Claude after an allowed call, or null when nothing was saved. `kinds` are the kinds of risk the call
 * carried: they say what a snapshot that holds only Git state holds (a force push keeps no uncommitted changes).
 */
export function allowNote(s: SnapshotView, kinds?: readonly unknown[], isGitLost?: boolean): string | null {
  const note = allowNoteOf(s, kinds)
  if (isGitLost !== true) return note
  const lost = 'The call deletes the project\'s .git folder too: Safety Net never copies it, so commits that were not pushed, local branches and stashes cannot be brought back with /safety restore.'
  return note === null ? lost : `${note} ${lost}`
}

function allowNoteOf(s: SnapshotView, kinds?: readonly unknown[]): string | null {
  switch (s?.state) {
    case 'saved': {
      const n = numberOf(s.n)
      const left = s.isPartial ? ' (some files were left out)' : ''
      if (s.isGitPartial === true) {
        // never claim the Git state was saved when Git could not keep the uncommitted changes
        if (whole(s.files) === 0) return 'Safety Net could not save the uncommitted changes with Git (an unfinished merge, for example) and there were no files to copy, so nothing was saved before this ran.'
        return n
          ? `Safety Net saved snapshot #${n} before this ran${left}, but Git could not save the uncommitted changes (an unfinished merge, for example), so /safety restore ${n} cannot bring those back.`
          : `Safety Net saved a snapshot before this ran${left}, but Git could not save the uncommitted changes (an unfinished merge, for example), so /safety restore cannot bring those back.`
      }
      return n
        ? `Safety Net saved snapshot #${n} before this ran${left}; /safety restore ${n} puts it back.`
        : `Safety Net saved a snapshot before this ran${left}; /safety restore puts it back.`
    }
    case 'none':
      return s.hasGit ? gitSavedNote(kinds) : null
    case 'needs-node':
      return 'Safety Net could not save a copy of the .env file before this ran: a .env file is copied only when Node.js is installed, so its copy can be kept private.'
    default:
      return null
  }
}

// ---- days and lists ----

/** "today 14:05", "yesterday 14:05", "Nov 20 14:05" in local time; '--:--' when `ms` is not a time. */
export function dayLabel(ms: number, nowMs: number, t: Strings): string {
  const clock = typeof ms === 'number' ? formatClock(ms) : '--:--'
  if (clock === '--:--') return clock
  const d = new Date(ms)
  if (typeof nowMs === 'number' && Number.isFinite(nowMs) && !Number.isNaN(new Date(nowMs).getTime())) {
    const now = new Date(nowMs)
    // local calendar days, built from local-time constructors so a time zone or a DST change cannot shift them
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    if (day === new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) return `${t.day.today} ${clock}`
    if (day === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return `${t.day.yesterday} ${clock}`
  }
  return `${t.day.dateShort(d.getMonth() + 1, d.getDate())} ${clock}`
}

/** The /safety list text: newest first, at most 10 lines and then "... and N more". An empty list says so. */
export function listText(items: SnapshotSummary[], project: string, nowMs: number, t: Strings): string {
  const all = (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object')
  if (all.length === 0) return t.noSnapshots
  const time = (i: SnapshotSummary) => (typeof i.createdAt === 'number' && Number.isFinite(i.createdAt) ? i.createdAt : 0)
  const sorted = [...all].sort((a, b) => time(b) - time(a) || whole(b.n) - whole(a.n))
  const rows = sorted.slice(0, LIST_MAX).map(i => {
    const label = sanitizeShown(i.label, 30)
    const mark = i.kind === 'before-restore' ? t.list.undoPoint : i.quiet === true ? t.list.quiet : ''
    const files = whole(i.files)
    return {
      ref: `#${whole(i.n)}`,
      when: dayLabel(i.createdAt, nowMs, t),
      what: [label, mark].filter(part => part !== '').join(' '),
      size: files > 0 ? t.snapshot.size(files, formatBytes(i.bytes)) : i.gitPartial === true ? t.list.gitPartial : i.hasGit ? t.list.gitOnly : t.list.noFiles,
    }
  })
  // columns line up: number, when, what ran, size
  const wide = (pick: (r: (typeof rows)[number]) => string) => Math.max(...rows.map(r => Array.from(pick(r)).length))
  const [wRef, wWhen, wWhat] = [wide(r => r.ref), wide(r => r.when), wide(r => r.what)]
  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - Array.from(text).length))
  const lines = rows.map(r => [pad(r.ref, wRef), pad(r.when, wWhen), pad(r.what, wWhat), r.size].join('  ').trimEnd())
  const name = sanitizeShown(project, 60) || t.thisProject
  const out = [t.list.header(name, sorted.length), ...lines]
  if (sorted.length > LIST_MAX) out.push(t.list.more(sorted.length - LIST_MAX))
  out.push(t.list.hint)
  return out.join('\n')
}

// ---- restore and undo ----

export type RestoreView = {
  ok: boolean
  restored: number
  failed: { rel: string; reason: string }[]
  keptNewer: number
  at: number
  n: number
  id: string
  sample: string[]
  hasUndo: boolean
  /** Existing files left alone because their current versions could not be saved first (see RestoreOutcome.leftAsIs). */
  leftAsIs?: number
  /** Nothing was overwritten, so there is no undo point (see RestoreOutcome.noneOverwritten). */
  noneOverwritten?: boolean
  git: { label: string; command: string }[]
  /** Git could not save the uncommitted changes when the snapshot was taken (an unfinished merge, for example). */
  gitPartial?: boolean
}

/**
 * What the Git part of a restore says: commands to run by hand, never run by Safety Net. The intro says what was really kept: the
 * commits and changes of a reset, only the last-fetched copy of a remote branch for a force push, and, when Git could not save
 * the uncommitted changes, that nothing of them can come back (never "the commits and changes were saved too").
 */
function gitLines(r: RestoreView, t: Strings): string[] {
  const hints = (Array.isArray(r?.git) ? r.git : []).map(g => sanitizeShown(g?.command, 600)).filter(c => c !== '')
  const list = hints.filter(isTipListHint)
  const commands = hints.filter(c => !isTipListHint(c))
  const indent = (c: string) => `  ${c}`
  if (r?.gitPartial === true) {
    return hints.length === 0 ? [t.restore.gitPartial] : [t.restore.gitPartialSome, ...hints.map(indent)]
  }
  const out: string[] = []
  if (commands.length > 0) out.push(commands.every(isOverwrittenBranchHint) ? t.restore.gitIntroRemote : t.restore.gitIntro, ...commands.map(indent))
  if (list.length > 0) out.push(t.restore.otherTips, ...list.map(indent))
  return out
}

/** The multi-line result of a restore or an undo (the two differ in the words of the first and the last line only). */
function resultText(r: RestoreView, t: Strings, mode: 'restore' | 'undo'): string {
  const restored = whole(r?.restored)
  const failed = (Array.isArray(r?.failed) ? r.failed : []).filter(f => f && typeof f.rel === 'string')
  const n = numberOf(r?.n)
  const at = clockOf(r?.at)
  const problem = r?.ok === false || failed.length > 0
  const ref = n ? `  ${t.restore.ref(n)}` : ''
  const words = mode === 'restore' ? t.restore : t.undo
  const lines: string[] = []

  if (restored === 0) {
    lines.push(problem ? `✗ ${mode === 'restore' ? t.restore.failedAll(n) : t.undo.failedAll}` : `✓ ${words.nothing(n)}`)
  } else {
    lines.push(problem ? `! ${words.partial(restored, at)}${ref}` : `✓ ${words.done(restored, at)}${ref}`)
    // a few of the restored names, three to a line, then how many more there were
    const sample = (Array.isArray(r.sample) ? r.sample : [])
      .filter((s): s is string => typeof s === 'string')
      .slice(0, Math.min(SAMPLE_MAX, restored))
      .map(s => shortPath(s, 40) || '…')
    for (let i = 0; i < sample.length; i += SAMPLE_PER_LINE) lines.push(`  ${sample.slice(i, i + SAMPLE_PER_LINE).join('  ')}`)
    if (sample.length > 0 && restored > sample.length) lines[lines.length - 1] += `  ${t.restore.more(restored - sample.length)}`
  }

  if (failed.length > 0) {
    const names = failed.slice(0, SAMPLE_MAX).map(f => {
      const why = sanitizeShown(f.reason, 40)
      const name = shortPath(f.rel, 40) || '…'
      return why ? `${name} (${why})` : name
    })
    const more = failed.length > SAMPLE_MAX ? t.title.listMore(failed.length - SAMPLE_MAX) : ''
    lines.push(`${t.restore.failedFiles(failed.length)} ${names.join(', ')}${more}`)
  }
  if (whole(r?.keptNewer) > 0) lines.push(t.restore.kept(whole(r.keptNewer), at))
  const leftAsIs = whole(r?.leftAsIs)
  if (leftAsIs > 0) lines.push(words.leftAsIs(leftAsIs))
  if (restored > 0) {
    if (mode === 'restore') lines.push(r.hasUndo ? t.restore.undoHint : r.noneOverwritten === true ? t.restore.noneOverwritten : t.restore.noUndo)
    else lines.push(r.hasUndo ? t.undo.again : r.noneOverwritten === true ? t.undo.noneOverwritten : t.undo.noAgain)
  }

  lines.push(...gitLines(r, t))
  return lines.join('\n')
}

/** The result of /safety restore. */
export function restoreText(r: RestoreView, t: Strings): string {
  return resultText(r, t, 'restore')
}

/** The result of /safety undo. */
export function undoText(r: RestoreView, t: Strings): string {
  return resultText(r, t, 'undo')
}

// ---- small notices ----

/** "◈ 3 secret values were masked before they entered the conversation." ('' for none, so the caller shows nothing.) */
export function maskedNotice(n: number, t: Strings): string {
  const count = whole(n)
  return count < 1 ? '' : t.masked(count)
}

/** The toast for confirm=never, or '' when there is nothing worth saying (no files, no Git state). */
export function toastSnapshot(s: SnapshotView, t: Strings): string {
  switch (s?.state) {
    case 'saved': {
      const n = numberOf(s.n)
      if (s.isGitPartial === true && n) return t.toast.savedGitPartial(n)
      return n ? t.toast.saved(n) : t.toast.savedNoNumber
    }
    case 'none': return s.hasGit ? t.toast.gitSaved : ''
    case 'too-big': return s.byFiles === true ? t.toast.tooMany(fileLimitOf(s)) : t.toast.tooBig(whole(s.limitMB))
    case 'needs-node': return t.toast.needsNode
    default: return t.toast.failed
  }
}
