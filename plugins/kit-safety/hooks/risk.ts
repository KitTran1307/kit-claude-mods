// "What is risky?": pure functions that read a Bash command (or a file path) and say which dangerous things it would
// do. No engine calls, no Node. It must be conservative: ordinary `rm file`, `git push`, `git reset --soft` and text
// that only mentions a command (`echo "rm -rf /"`) are not risky, yet the common real forms are not missed.
//
// classifyBash reads the command like a shell would (quotes, escapes, `;` `&&` `|`, `( )`, `$( )`, backticks,
// here-docs, `bash -c '...'`, `sudo`, `xargs`, `find -exec`, `cd` in a chain) and then looks at each real command.
// Everything is total: any string in, a value out, linear scanning, bounded work. It also fails closed: when a limit stops
// the reading before the end, the answer says so (an `unparsed` risk) instead of looking safe.

import { baseName, isAbsolute, isInside, isWindowsPath, joinPath, normalizePath, resolvePath } from './paths'
import type { Risk } from './types'

// ---------------------------------------------------------------------------------------------------------------------
// Limits (hostile input must stay fast)

// Fail closed: when any limit below trips and part of the command was left unread, classifyBash adds one `unparsed` risk
// (see `Budget.cut`), so a risky command hidden behind padding is asked about instead of looking safe. The limits are
// generous enough for ordinary long scripts and keep the work linear for hostile input.
const MAX_COMMANDS = 2_000 // simple commands read in one call, nested strings included
const MAX_NEST = 64 // nesting of `$( )`, `( )`, `{ }` while reading
const MAX_WORDS = 50_000 // words kept per command
const MAX_RUN_DEPTH = 6 // `bash -c '...'` inside `bash -c '...'` (also `xargs` / `find -exec` inside each other)
const MAX_WRAPPERS = 128 // `sudo`, `nohup`, `env` ... in front of one command
const MAX_PATHS = 500
const MAX_NAMES = 20 // branch names kept on one risk
const MAX_RISKS = 5_000
const COUNT_MAX = 100_000 // commandCount stops counting here
const LABEL_MAX = 40
const SQL_MAX = 1_000_000

// ---------------------------------------------------------------------------------------------------------------------
// .env files

// The last part of `.env.<x>` that makes the file a template with no real values.
const ENV_TEMPLATE = new Set(['example', 'sample', 'template', 'dist', 'defaults', 'schema'])

/** Base name of a path with either separator, ignoring trailing separators. */
function lastSegment(path: string): string {
  let end = path.length
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--
  const start = Math.max(path.lastIndexOf('/', end - 1), path.lastIndexOf('\\', end - 1)) + 1
  return path.slice(start, end)
}

/**
 * True for `.env`, `.env.<anything>`, `<anything>.env` and `.envrc` (case-insensitive) but not for templates such as
 * `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`, `.env.schema`. Judged by name only: a
 * folder called `.env` also counts (the caller checks what exists).
 */
export function isEnvLike(path: string): boolean {
  if (typeof path !== 'string' || path === '') return false
  const base = lastSegment(path).toLowerCase()
  if (base === '.env' || base === '.envrc') return true
  if (base.startsWith('.env.')) {
    const rest = base.slice(5)
    if (rest === '') return false
    return !ENV_TEMPLATE.has(rest.slice(rest.lastIndexOf('.') + 1))
  }
  return base.length > 4 && base.endsWith('.env')
}

export type EnvDiff = { before: number; after: number; removed: string[]; added: string[] }

const ENV_KEY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/
const ENV_LIST_MAX = 50
const ENV_MULTILINE_LOOKAHEAD = 200

/** True when the quote `q` (at index 0 of `rest`) is closed on the same line. */
function quoteCloses(rest: string, q: string, from: number): boolean {
  for (let i = from; i < rest.length; i++) {
    const c = rest[i]
    if (q === '"' && c === '\\') i++
    else if (c === q) return true
  }
  return false
}

/** Distinct key names of a dotenv text, in order of first appearance. Values are never kept. */
function envKeys(text: string): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trimStart()
    if (line === '' || line[0] === '#') continue
    const m = ENV_KEY.exec(line)
    if (!m) continue
    const key = m[1]!
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
    // A quoted value can run over several lines; its lines are not keys.
    const rest = line.slice(m[0].length).trimStart()
    const q = rest[0]
    if ((q === '"' || q === "'") && !quoteCloses(rest, q, 1)) {
      for (let k = li + 1; k < lines.length && k <= li + ENV_MULTILINE_LOOKAHEAD; k++) {
        if (quoteCloses(lines[k]!, q, 0)) {
          li = k
          break
        }
      }
    }
  }
  return keys
}

/** Which variable names a `.env` change removes or adds. Key names only, never a value. */
export function envDiff(oldText: string, newText: string): EnvDiff {
  const before = envKeys(typeof oldText === 'string' ? oldText : '')
  const after = envKeys(typeof newText === 'string' ? newText : '')
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    before: before.length,
    after: after.length,
    removed: before.filter(k => !afterSet.has(k)).slice(0, ENV_LIST_MAX),
    added: after.filter(k => !beforeSet.has(k)).slice(0, ENV_LIST_MAX),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Write / Edit

export type FileFacts = { isInsideRoot: boolean; exists: boolean; isTracked: boolean | undefined; isIgnored: boolean | undefined }

/**
 * The risk of a Write/Edit-style tool replacing the file at `path`, or null. Only an existing file inside the project
 * counts. A `.env`-like file always asks; a file git tracks is safe (git has it); anything else (untracked, ignored, or git
 * unknown) is saved quietly first. An ignored file is not exempt: it is where local config, keys and databases live, and git
 * has no copy of it.
 */
export function classifyFile(tool: string, path: string, facts: FileFacts): Risk | null {
  if (!facts || !facts.isInsideRoot || !facts.exists) return null
  const label = cap(cleanText(typeof tool === 'string' ? tool : ''))
  if (isEnvLike(path)) return { kind: 'overwrite', tier: 'ask', label, paths: [path] }
  if (facts.isTracked === true) return null
  return { kind: 'overwrite', tier: 'snapshot', label, paths: [path] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Small text helpers

/** Drops control characters (labels and names end up on screen). */
function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '')
}

function cap(label: string): string {
  return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX - 1) + '\u2026' : label
}

/** A flag as safe label text (`-rf`, `--force`), without any `=value`; '' when it does not look like a plain flag. */
function flagText(t: string): string {
  const eq = t.indexOf('=')
  const head = eq >= 0 ? t.slice(0, eq) : t
  return head.length <= 24 && /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(head) ? head : ''
}

function shortName(path: string): string {
  return cap(cleanText(baseName(path)).slice(0, 30))
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the shell: text -> a tree of commands

type Budget = {
  /** Simple commands that may still be read. */
  left: number
  /** A limit tripped (commands, nesting, words, depth, wrappers, SQL size, risks) and some input was left unread. */
  cut: boolean
}
type Word = {
  /** The value with quotes and escapes removed. Command substitutions stay as written (they contain `$` or a backtick). */
  text: string
  /**
   * The value as a POSIX shell reads an unquoted word: a backslash before any character is dropped (`r\m` is `rm`). Only set
   * when it differs from `text`, which keeps such backslashes so Windows paths (`C:\proj\build`) read correctly.
   */
  uni?: string
  /** The value depends on the shell at run time: `$VAR`, `$(...)`, a backtick, `<(...)` (outside single quotes). */
  dyn: boolean
  /** An unquoted `*`, `?`, `[` or brace list. */
  glob: boolean
  /** Some quoting or escaping was used. */
  quoted: boolean
  /** Commands inside `$( )`, backticks, `<( )` and an unquoted here-doc body. */
  subs: Seq[]
}
type Redir = { fd: string; op: string; target: Word | null }
type Simple = { type: 'simple'; words: Word[]; redirs: Redir[] }
type Block = { type: 'sub' | 'group'; body: Seq; redirs: Redir[] }
type Node = Simple | Block
type Item = { node: Node; sep: string }
type Seq = Item[]
type Pending = { delim: string; strip: boolean; expand: boolean; sink: Seq[] }
type P = { s: string; i: number; n: number; nest: number; budget: Budget; stop: boolean; pending: Pending[] }

type WState = { text: string; dyn: boolean; glob: boolean; quoted: boolean; brace: boolean; subs: Seq[] }

const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f'
const isDelim = (c: string): boolean =>
  isBlank(c) || c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>'
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
const isVarStart = (c: string | undefined): boolean => c !== undefined && (isLetter(c) || isDigit(c) || '_@*#?$!-'.includes(c))

// After a backslash these characters stand for themselves. Any other letter keeps its backslash, so Windows paths
// (`C:\proj\build`) survive.
const ESCAPABLE = new Set([' ', '\t', '\n', "'", '"', '`', '$', '\\', ';', '&', '|', '(', ')', '<', '>', '*', '?', '[', ']', '{', '}', '#', '!'])

/** `{a,b}` or `{1..3}`: a brace list that expands to several names. One pass, no backtracking. */
function hasBraceList(t: string): boolean {
  let open = -1
  let sep = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '{') {
      open = i
      sep = false
    } else if (c === '}') {
      if (open >= 0 && sep) return true
      open = -1
    } else if (open >= 0 && (c === ',' || (c === '.' && t[i + 1] === '.'))) sep = true
  }
  return false
}

function newParser(s: string, budget: Budget, nest: number): P {
  return { s, i: 0, n: s.length, nest, budget, stop: false, pending: [] }
}

function parseText(s: string, budget: Budget, nest = 0): Seq {
  const p = newParser(s, budget, nest)
  return parseSeq(p, null)
}

function skipBlanks(p: P): void {
  const s = p.s
  while (p.i < p.n) {
    const c = s[p.i]!
    if (isBlank(c)) p.i++
    else if (c === '\\' && s[p.i + 1] === '\n') p.i += 2
    else if (c === '\\' && s[p.i + 1] === '\r' && s[p.i + 2] === '\n') p.i += 3
    else break
  }
}

function skipComment(p: P): void {
  const e = p.s.indexOf('\n', p.i)
  p.i = e < 0 ? p.n : e
}

/** `(( ... ))` and `$(( ... ))`: arithmetic, not commands. `from` is the index of the first `(`. Returns the end index. */
function arithEnd(p: P, from: number): number {
  let depth = 0
  let j = from
  while (j < p.n) {
    const c = p.s[j]!
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return p.n
}

function setSep(items: Seq, op: string): void {
  const last = items[items.length - 1]
  if (last && last.sep === '') last.sep = op
}

function parseSeq(p: P, closer: ')' | '}' | null): Seq {
  const items: Seq = []
  if (p.nest >= MAX_NEST) {
    p.stop = true
    p.budget.cut = true
    return items
  }
  p.nest++
  const s = p.s
  while (!p.stop && p.i < p.n) {
    skipBlanks(p)
    if (p.i >= p.n) break
    const c = s[p.i]!
    if (c === '#') {
      skipComment(p)
      continue
    }
    if (c === '\n') {
      p.i++
      readHeredocs(p)
      setSep(items, '\n')
      continue
    }
    if (c === ';') {
      p.i++
      if (s[p.i] === ';' || s[p.i] === '&') p.i++
      setSep(items, ';')
      continue
    }
    if (c === '&' && s[p.i + 1] !== '>') {
      if (s[p.i + 1] === '&') {
        p.i += 2
        setSep(items, '&&')
      } else {
        p.i++
        setSep(items, '&')
      }
      continue
    }
    if (c === '|') {
      const op = s[p.i + 1] === '|' ? '||' : s[p.i + 1] === '&' ? '|&' : '|'
      p.i += op.length
      setSep(items, op)
      continue
    }
    if (c === ')') {
      p.i++
      if (closer === ')') break
      continue
    }
    if (c === '}' && closer === '}' && (p.i + 1 >= p.n || isDelim(s[p.i + 1]!))) {
      p.i++
      break
    }
    const node = parseCommand(p)
    if (node) items.push({ node, sep: '' })
  }
  p.nest--
  return items
}

function parseCommand(p: P): Node | null {
  const s = p.s
  const c = s[p.i]!
  if (c === '(') {
    if (s[p.i + 1] === '(') {
      const e = arithEnd(p, p.i)
      const text = s.slice(p.i, e)
      p.i = e
      // `(( $(cmd) ))` still runs `cmd`; a plain `(( x = 1 ))` is not a command at all.
      if (!text.includes('$(') && !text.includes('`')) return null
      return { type: 'simple', words: [{ text: '((', dyn: true, glob: false, quoted: false, subs: bodyExpansions(text, p) }], redirs: [] }
    }
    p.i++
    const body = parseSeq(p, ')')
    return { type: 'sub', body, redirs: parseTrailingRedirs(p) }
  }
  if (c === '{' && (p.i + 1 >= p.n || isDelim(s[p.i + 1]!))) {
    p.i++
    const body = parseSeq(p, '}')
    return { type: 'group', body, redirs: parseTrailingRedirs(p) }
  }
  return parseSimple(p)
}

function parseTrailingRedirs(p: P): Redir[] {
  const redirs: Redir[] = []
  for (;;) {
    skipBlanks(p)
    if (p.i >= p.n || p.stop || !isRedirStart(p)) break
    const r = parseRedirect(p)
    if (r) redirs.push(r)
  }
  return redirs
}

function parseSimple(p: P): Simple | null {
  const s = p.s
  const words: Word[] = []
  const redirs: Redir[] = []
  while (!p.stop) {
    skipBlanks(p)
    if (p.i >= p.n) break
    const c = s[p.i]!
    if (c === '\n' || c === ';' || c === '|' || c === ')' || c === '(') break
    if (c === '&' && s[p.i + 1] !== '>') break
    if (c === '#') {
      skipComment(p)
      continue
    }
    if (isRedirStart(p)) {
      const r = parseRedirect(p)
      if (r) redirs.push(r)
      continue
    }
    const before = p.i
    const w = parseWord(p)
    if (w) {
      if (words.length < MAX_WORDS) words.push(w)
      else p.budget.cut = true
    }
    if (p.i === before) p.i++ // never stand still
  }
  if (words.length === 0 && redirs.length === 0) return null
  if (--p.budget.left < 0) {
    p.stop = true
    p.budget.cut = true
    return null
  }
  return { type: 'simple', words, redirs }
}

function isRedirStart(p: P): boolean {
  const s = p.s
  const c = s[p.i]!
  if (c === '<' || c === '>') return s[p.i + 1] !== '('
  if (c === '&') return s[p.i + 1] === '>'
  if (isDigit(c)) {
    let j = p.i
    while (j < p.n && isDigit(s[j])) j++
    const d = s[j]
    return (d === '<' || d === '>') && s[j + 1] !== '('
  }
  return false
}

function parseRedirect(p: P): Redir | null {
  const s = p.s
  let fd = ''
  let op = ''
  if (s[p.i] === '&') {
    op = s[p.i + 1] === '>' && s[p.i + 2] === '>' ? '&>>' : '&>'
    p.i += op.length
  } else {
    while (isDigit(s[p.i])) {
      fd += s[p.i]
      p.i++
    }
    const c = s[p.i]!
    const n1 = s[p.i + 1]
    if (c === '>') op = n1 === '>' ? '>>' : n1 === '|' ? '>|' : n1 === '&' ? '>&' : '>'
    else if (n1 === '<') op = s[p.i + 2] === '<' ? '<<<' : s[p.i + 2] === '-' ? '<<-' : '<<'
    else op = n1 === '&' ? '<&' : n1 === '>' ? '<>' : '<'
    p.i += op.length
  }
  skipBlanks(p)
  const target = parseWord(p)
  if ((op === '<<' || op === '<<-') && target) {
    const escaped = target.text.startsWith('\\') // <<\EOF quotes the delimiter too
    p.pending.push({ delim: escaped ? target.text.slice(1) : target.text, strip: op === '<<-', expand: !target.quoted && !escaped, sink: target.subs })
  }
  return { fd, op, target }
}

/** Reads the here-doc bodies that wait for the line that just ended. The body is data; only an unquoted body can run `$( )`. */
function readHeredocs(p: P): void {
  const s = p.s
  while (p.pending.length > 0) {
    const h = p.pending.shift()!
    const from = p.i
    let bodyEnd = p.n
    while (p.i < p.n) {
      const e = s.indexOf('\n', p.i)
      const lineEnd = e < 0 ? p.n : e
      let line = s.slice(p.i, lineEnd)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (h.strip) line = line.replace(/^\t+/, '')
      const here = p.i
      p.i = e < 0 ? p.n : e + 1
      if (line === h.delim) {
        bodyEnd = here
        break
      }
    }
    if (h.expand) {
      const body = s.slice(from, bodyEnd)
      if (body.includes('$(') || body.includes('`')) {
        if (p.budget.left > 0) for (const sq of bodyExpansions(body, p)) h.sink.push(sq)
        else p.budget.cut = true // the commands inside the body are not read
      }
    }
  }
}

/** The commands an unquoted here-doc body runs through `$( )` and backticks. */
function bodyExpansions(body: string, parent: P): Seq[] {
  const q = newParser(body, parent.budget, parent.nest)
  const out: Seq[] = []
  while (q.i < q.n && !q.stop) {
    const c = body[q.i]!
    if (c === '\\') q.i += 2
    else if (c === '$' && body[q.i + 1] === '(' && body[q.i + 2] !== '(') {
      q.i += 2
      out.push(parseSeq(q, ')'))
    } else if (c === '`') {
      q.i++
      out.push(readBacktick(q))
    } else q.i++
  }
  return out
}

/** Reads to the closing backtick (`p.i` is just after the opening one) and reads the inside as commands. */
function readBacktick(p: P): Seq {
  const s = p.s
  let j = p.i
  let inner = ''
  while (j < p.n) {
    const c = s[j]!
    if (c === '\\' && j + 1 < p.n) {
      const nx = s[j + 1]!
      if (nx === '`' || nx === '\\' || nx === '$') {
        inner += nx
        j += 2
        continue
      }
    } else if (c === '`') break
    inner += c
    j++
  }
  p.i = Math.min(j + 1, p.n)
  if (p.nest >= MAX_NEST) {
    p.stop = true
    p.budget.cut = true
    return []
  }
  return parseSeq(newParser(inner, p.budget, p.nest + 1), null)
}

/** `$( )` and backticks inside text that is skipped whole (`$(( ))`, `${x:-$(cmd)}`) still run: read them as commands. */
function innerSubs(p: P, w: WState, text: string): void {
  if (!text.includes('$(') && !text.includes('`')) return
  for (const sq of bodyExpansions(text, p)) w.subs.push(sq)
}

function readDollar(p: P, w: WState, inDq: boolean): void {
  const s = p.s
  const nx = s[p.i + 1]
  if (nx === '(') {
    if (s[p.i + 2] === '(') {
      const e = arithEnd(p, p.i + 1)
      const text = s.slice(p.i, e)
      w.dyn = true
      w.text += text
      innerSubs(p, w, text)
      p.i = e
      return
    }
    p.i += 2
    w.dyn = true
    w.text += '$('
    w.subs.push(parseSeq(p, ')'))
    w.text += ')'
    return
  }
  if (nx === '{') {
    let depth = 1
    let j = p.i + 2
    while (j < p.n && depth > 0) {
      const ch = s[j]!
      if (ch === '\\') j++
      else if (ch === '{') depth++
      else if (ch === '}') depth--
      j++
    }
    const text = s.slice(p.i, Math.min(j, p.n))
    w.dyn = true
    w.text += text
    innerSubs(p, w, text)
    p.i = Math.min(j, p.n)
    return
  }
  if (!inDq && nx === "'") {
    // $'...' keeps escapes inside; a plain read is enough for paths.
    p.i += 2
    w.quoted = true
    while (p.i < p.n) {
      const ch = s[p.i]!
      if (ch === '\\' && p.i + 1 < p.n) {
        w.text += s[p.i + 1]!
        p.i += 2
      } else if (ch === "'") {
        p.i++
        break
      } else {
        w.text += ch
        p.i++
      }
    }
    return
  }
  if (!inDq && nx === '"') {
    p.i++ // $"..." is a plain double-quoted string; the quote is read next
    return
  }
  if (isVarStart(nx)) w.dyn = true
  w.text += '$'
  p.i++
}

function readDouble(p: P, w: WState): void {
  const s = p.s
  // "C:\proj\build\" is a Windows path: its backslashes are not escapes.
  const win = /^[A-Za-z]:[\\/]/.test(s.slice(p.i, p.i + 3)) || s.startsWith('\\\\', p.i)
  while (p.i < p.n && !p.stop) {
    const c = s[p.i]!
    if (c === '"') {
      p.i++
      return
    }
    if (c === '\\') {
      const nx = s[p.i + 1]
      if (!win && nx !== undefined && (nx === '$' || nx === '`' || nx === '"' || nx === '\\')) {
        w.text += nx
        p.i += 2
      } else if (!win && nx === '\n') {
        p.i += 2
      } else {
        w.text += '\\'
        p.i++
      }
      continue
    }
    if (c === '$') {
      readDollar(p, w, true)
      continue
    }
    if (c === '`') {
      p.i++
      w.dyn = true
      w.text += '`'
      w.subs.push(readBacktick(p))
      w.text += '`'
      continue
    }
    w.text += c
    p.i++
  }
}

/** `text` without the characters at the (ascending) indexes `at`. */
function dropAt(text: string, at: readonly number[]): string {
  let out = ''
  let from = 0
  for (const k of at) {
    out += text.slice(from, k)
    from = k + 1
  }
  return out + text.slice(from)
}

function parseWord(p: P): Word | null {
  const s = p.s
  const start = p.i
  const w: WState = { text: '', dyn: false, glob: false, quoted: false, brace: false, subs: [] }
  // Where in `w.text` an unquoted backslash was kept (it came before an ordinary character): a POSIX shell drops those.
  const kept: number[] = []
  while (p.i < p.n && !p.stop) {
    const c = s[p.i]!
    if (isDelim(c)) {
      if ((c === '<' || c === '>') && s[p.i + 1] === '(') {
        // process substitution: <(cmd) >(cmd)
        p.i += 2
        w.dyn = true
        w.text += c + '('
        w.subs.push(parseSeq(p, ')'))
        w.text += ')'
        continue
      }
      break
    }
    if (c === '\\') {
      const nx = s[p.i + 1]
      if (nx === undefined) {
        w.text += '\\'
        p.i++
      } else if (nx === '\n') {
        p.i += 2
      } else if (nx === '\r' && s[p.i + 2] === '\n') {
        p.i += 3
      } else if ((nx === '*' || nx === '?' || nx === '[') && w.text !== '') {
        kept.push(w.text.length)
        w.text += '\\' // build\* is a Windows folder and a wildcard (in a POSIX shell it would be a rare literal name)
        p.i++
      } else if (ESCAPABLE.has(nx)) {
        if (nx === '\\' && w.text === '' && isLetter(s[p.i + 2])) {
          w.text += '\\\\' // \\server\share
          p.i += 2
        } else {
          w.text += nx
          w.quoted = true
          p.i += 2
        }
      } else {
        kept.push(w.text.length)
        w.text += '\\'
        p.i++
      }
      continue
    }
    if (c === "'") {
      w.quoted = true
      const e = s.indexOf("'", p.i + 1)
      w.text += s.slice(p.i + 1, e < 0 ? p.n : e)
      p.i = e < 0 ? p.n : e + 1
      continue
    }
    if (c === '"') {
      w.quoted = true
      p.i++
      readDouble(p, w)
      continue
    }
    if (c === '$') {
      readDollar(p, w, false)
      continue
    }
    if (c === '`') {
      p.i++
      w.dyn = true
      w.text += '`'
      w.subs.push(readBacktick(p))
      w.text += '`'
      continue
    }
    if (c === '*' || c === '?' || c === '[') w.glob = true
    else if (c === '{') w.brace = true
    w.text += c
    p.i++
  }
  if (p.i === start) return null
  if (w.brace && hasBraceList(w.text)) w.glob = true
  const word: Word = { text: w.text, dyn: w.dyn, glob: w.glob, quoted: w.quoted, subs: w.subs }
  if (kept.length > 0) {
    const uni = dropAt(w.text, kept)
    if (uni[0] === '-') {
      // An option (`rm -r\f`, `rm \-rf`): the shell drops the backslashes, except in a value after `:` or `=` (`-Path:C:\x`).
      const v = w.text.search(/[:=]/)
      word.text = v < 0 ? uni : dropAt(w.text, kept.filter(k => k < v))
    } else if (uni !== w.text) word.uni = uni
  }
  return word
}

function flattenSeq(seq: Seq, out: string[][]): void {
  for (const item of seq) flattenNode(item.node, out)
}

function flattenNode(node: Node, out: string[][]): void {
  if (node.type === 'simple') {
    for (const w of node.words) for (const s of w.subs) flattenSeq(s, out)
    for (const r of node.redirs) if (r.target) for (const s of r.target.subs) flattenSeq(s, out)
    if (node.words.length > 0) out.push(node.words.map(w => w.text))
  } else {
    flattenSeq(node.body, out)
  }
}

/**
 * The simple commands of a shell line as lists of words (quotes and escapes removed), in the order they run: a command
 * substitution comes before the command that holds it. Text in quotes is one word, never a command; a here-doc body is
 * skipped. For tests and tools; classifyBash uses the same reader.
 */
export function splitCommands(command: string): string[][] {
  const out: string[][] = []
  try {
    if (typeof command !== 'string') return out
    flattenSeq(parseText(command, { left: MAX_COMMANDS, cut: false }), out)
  } catch {
    // total: whatever was read stays
  }
  return out
}

function countSeq(seq: Seq): number {
  let n = 0
  for (const item of seq) {
    const node = item.node
    if (node.type === 'simple') {
      for (const w of node.words) for (const sq of w.subs) n += countSeq(sq)
      for (const r of node.redirs) if (r.target) for (const sq of r.target.subs) n += countSeq(sq)
      if (node.words.length > 0) n++
    } else n += countSeq(node.body)
  }
  return n
}

/**
 * How many simple commands the line holds: the length of what `splitCommands` returns, but counted past its cap (up to
 * 100,000), so the band can say "+N other commands in this line". 0 for a blank or odd input.
 */
export function commandCount(command: string): number {
  try {
    if (typeof command !== 'string' || command === '') return 0
    return Math.min(COUNT_MAX, countSeq(parseText(command, { left: COUNT_MAX, cut: false })))
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Walking the commands

export type BashContext = { cwd: string; root: string; home?: string }

type St = {
  home: string | undefined
  root: string | null // the project root when it is a usable absolute path
  base0: string | null // the folder the command line starts in
  cwd: string | null // the folder the current command runs in; null = cannot be known
  prev: string | null // for `cd -`
  stack: Array<string | null> // pushd / popd
  out: Risk[]
  budget: Budget
  depth: number
  repl: string | null // the `{}` of `xargs -I{}` / `find -exec`: an operand holding it comes from somewhere else
  fromStdin: boolean // `xargs`: more operands arrive on stdin
  find: { hit: boolean } | null // inside `find -exec`: a plain `rm` there deletes what find picks; `hit` tells find it did
}

function fork(st: St): St {
  return { ...st, stack: st.stack.slice() }
}

function addRisk(st: St, r: Risk): void {
  if (st.out.length < MAX_RISKS) st.out.push(r)
  else st.budget.cut = true
}

/** A copy of the state one level further in (`bash -c`, `xargs`, `find -exec`), or null at the depth limit (the rest stays unread). */
function deeper(st: St): St | null {
  if (st.depth >= MAX_RUN_DEPTH) {
    st.budget.cut = true
    return null
  }
  const inner = fork(st)
  inner.depth = st.depth + 1
  return inner
}

function walkSeq(seq: Seq, st: St): void {
  let prevSep = ''
  for (const item of seq) {
    // A pipeline element or a background job runs in its own shell: its `cd` does not stay.
    const own = item.sep === '|' || item.sep === '|&' || item.sep === '&' || prevSep === '|' || prevSep === '|&'
    const saved = own ? { cwd: st.cwd, prev: st.prev, stack: st.stack.slice() } : null
    walkNode(item.node, st)
    if (saved) {
      st.cwd = saved.cwd
      st.prev = saved.prev
      st.stack = saved.stack
    }
    prevSep = item.sep
  }
}

function walkNode(node: Node, st: St): void {
  if (node.type === 'simple') {
    for (const w of node.words) for (const sub of w.subs) walkSeq(sub, fork(st))
    for (const r of node.redirs) redirectRisk(r, st)
    runTop(node.words, st)
    return
  }
  for (const r of node.redirs) redirectRisk(r, st)
  walkSeq(node.body, node.type === 'sub' ? fork(st) : st)
}

/** `cmd > .env` replaces a `.env`-like file. `>>`, `2>` and `> /dev/null` do not. */
function redirectRisk(r: Redir, st: St): void {
  const t = r.target
  if (!t) return
  for (const sub of t.subs) walkSeq(sub, fork(st))
  const replaces = ((r.op === '>' || r.op === '>|') && (r.fd === '' || r.fd === '1')) || (r.op === '&>' && r.fd === '')
  if (!replaces || t.dyn || t.text === '' || !isEnvLike(t.text)) return
  addRisk(st, { kind: 'overwrite', tier: 'ask', label: cap(`> ${shortName(t.text)}`), paths: [emitPath(t.text, st)] })
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const isAssign = (w: Word): boolean => ASSIGN.test(w.text)
// Shell keywords that can stand in front of a command.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!'])

/** Index of the first word at or after `from` that is the command, past `VAR=x` and keywords like `then`. */
function commandStart(words: readonly Word[], from = 0): number {
  let i = from
  for (;;) {
    while (i < words.length && isAssign(words[i]!)) i++
    const w = words[i]
    if (w && !w.quoted && KEYWORDS.has(w.text)) i++
    else return i
  }
}

function runTop(words: readonly Word[], st: St): void {
  const i = commandStart(words)
  const w = words[i]
  if (w && !w.dyn) {
    const name = nameText(w).toLowerCase()
    if (name === 'cd' || name === 'chdir' || name === 'sl' || name === 'set-location') return applyCd('cd', words.slice(i + 1), st)
    if (name === 'pushd' || name === 'push-location') return applyCd('pushd', words.slice(i + 1), st)
    if (name === 'popd' || name === 'pop-location') return applyCd('popd', words.slice(i + 1), st)
  }
  runCommand(words, i, st)
}

function applyCd(kind: 'cd' | 'pushd' | 'popd', args: readonly Word[], st: St): void {
  if (kind === 'popd') {
    st.prev = st.cwd
    st.cwd = st.stack.length > 0 ? st.stack.pop() ?? null : null
    return
  }
  let target: Word | undefined
  let noCd = false
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    const lower = t.toLowerCase()
    if (t === '--') {
      target = args[k + 1]
      break
    }
    if (lower === '-path' || lower === '-literalpath') {
      target = args[k + 1]
      break
    }
    if (kind === 'pushd' && t === '-n') noCd = true
    if (t.length > 1 && (t[0] === '-' || lower === '/d') && t !== '-') continue
    target = args[k]
    break
  }
  const before = st.cwd
  let next: string | null
  if (!target) {
    next = kind === 'cd' ? (st.home ? resolvePath('/', '~', st.home) : null) : null
  } else if (target.text === '-' && kind === 'cd') {
    next = st.prev
  } else if (target.dyn || target.glob || target.text === '') {
    next = null
  } else {
    next = resolveIn(st, target.text)
  }
  if (kind === 'pushd') {
    st.stack.push(before)
    if (noCd) return
  }
  st.prev = before
  st.cwd = next
}

// ---------------------------------------------------------------------------------------------------------------------
// Judging a path operand

type Verdict = 'inside' | 'outside' | 'unknown' | 'skip'

/** The folder part of a wildcard path: the leading segments without a wildcard (`build/*.o` -> `build`). */
function globDir(t: string): string {
  let first = t.length
  for (const ch of ['*', '?', '[', '{']) {
    const k = t.indexOf(ch)
    if (k >= 0 && k < first) first = k
  }
  const cut = Math.max(t.lastIndexOf('/', first), t.lastIndexOf('\\', first))
  if (cut < 0) return ''
  if (cut === 0) return '/'
  const dir = t.slice(0, cut)
  return /^[A-Za-z]:$/.test(dir) ? dir + '/' : dir
}

/** `resolvePath` with a project-aware fix: on POSIX a path may start with several slashes (`//`), still the root. */
function resolveIn(st: St, p: string): string | null {
  const q = p.startsWith('//') && !isWindowsPath(st.root ?? st.base0 ?? '') ? '/' + p.replace(/^\/+/, '') : p
  return resolvePath(st.cwd ?? '', q, st.home)
}

/** Inside the project, or above it (deleting a parent folder takes the project with it). */
function relevant(st: St, abs: string): boolean {
  if (st.root === null) return true
  return isInside(st.root, abs) || isInside(abs, st.root)
}

function judge(w: Word, st: St): Verdict {
  const t = w.text
  if (st.repl !== null && t.includes(st.repl)) return 'unknown'
  if (w.dyn) return judgeDynamic(t, st)
  if (t === '') return 'skip'
  const target = w.glob ? globDir(t) : t
  const abs = resolveIn(st, target === '' ? '.' : target)
  if (abs === null) return 'unknown'
  return relevant(st, abs) ? 'inside' : 'outside'
}

/** `/tmp/build-$$` is certainly outside a project; `$DIR` or `$(cat x)` is not known. */
function judgeDynamic(t: string, st: St): Verdict {
  const d = t.indexOf('$')
  const b = t.indexOf('`')
  const k = d < 0 ? b : b < 0 ? d : Math.min(d, b)
  if (k <= 0 || !(isAbsolute(t) || t.startsWith('~/'))) return 'unknown'
  const cut = Math.max(t.lastIndexOf('/', k), t.lastIndexOf('\\', k))
  if (cut <= 0) return 'unknown'
  const abs = resolveIn(st, t.slice(0, cut))
  if (abs === null || st.root === null) return 'unknown'
  return relevant(st, abs) ? 'unknown' : 'outside'
}

/** The path as the planner should read it: as written, unless a `cd` moved the base (then absolute). */
function emitPath(text: string, st: St): string {
  if (st.cwd === null || st.cwd === st.base0) return text
  if (isAbsolute(text) || text.startsWith('~')) return text
  return normalizePath(st.cwd + '/' + text)
}

/** One `delete` risk for the operands that are inside the project (or unknown). Nothing when all are elsewhere. */
function deleteFromOperands(label: string, operands: readonly Word[], st: St, extraUnknown: boolean): Risk | null {
  const paths: string[] = []
  let unknown = extraUnknown
  for (const w of operands) {
    if (paths.length >= MAX_PATHS) {
      unknown = true // more operands than paths we keep: the rest is not looked at
      break
    }
    const v = judge(w, st)
    if (v === 'unknown') unknown = true
    else if (v === 'inside') paths.push(emitPath(w.text, st))
  }
  if (paths.length === 0 && !unknown) return null
  const risk: Risk = { kind: 'delete', tier: 'ask', label: cap(label), paths }
  if (unknown) risk.hasUnknownPath = true
  addRisk(st, risk)
  return risk
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

const WIN_START = /^(?:[A-Za-z]:\\|\\\\|\.{1,2}\\)/

/**
 * The word as a command name or a subcommand: a POSIX shell drops a backslash before any character (`r\m` is `rm`, `\rm`
 * bypasses an alias), but a Windows path (`C:\x\rm.exe`, `.\rm`) keeps its backslashes.
 */
function nameText(w: Word): string {
  return w.uni !== undefined && !WIN_START.test(w.text) ? w.uni : w.text
}

/** Program name without folder or Windows extension: `/bin/rm` -> `rm`, `C:\x\Git\bin\rm.exe` -> `rm`. */
function progName(text: string): string {
  const k = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return (k >= 0 ? text.slice(k + 1) : text).replace(/\.(?:exe|cmd|bat|com|ps1)$/i, '')
}

function clusterTakesNext(t: string, valueLetters: string): boolean {
  for (let k = 1; k < t.length; k++) {
    if (valueLetters.includes(t[k]!)) return k === t.length - 1
  }
  return false
}

/** Index after a wrapper's own options (`sudo -u bob`, `timeout -k 5`). */
function skipOptions(words: readonly Word[], from: number, shortValue: string, longValue: readonly string[]): number {
  let i = from
  while (i < words.length) {
    const t = words[i]!.text
    if (t === '--') return i + 1
    if (t.length < 2 || t[0] !== '-') return i
    if (t[1] === '-') i += !t.includes('=') && longValue.includes(t) ? 2 : 1
    else i += clusterTakesNext(t, shortValue) ? 2 : 1
  }
  return i
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'csh', 'tcsh'])
const PASS_THROUGH = new Set(['builtin', 'busybox', 'nohup', 'setsid', 'unbuffer', 'chronic', 'coproc'])
const SQL_TOOLS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'mongo', 'redis-cli'])
const DB_RUNNER_TOOLS = new Set(['prisma', 'drizzle-kit', 'typeorm', 'sequelize', 'sequelize-cli', 'knex', 'supabase', 'rails', 'rake', 'wrangler'])
const SUDO_SHORT = 'ughCDpRrTtU'
const SUDO_LONG = ['--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--chroot', '--role', '--type', '--other-user', '--command-timeout']
const XARGS_LONG = ['--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--process-slot-var']

/** Looks through wrappers to the real command and classifies it. `words[start]` is the first word of the command. */
function runCommand(words: readonly Word[], start: number, st0: St): void {
  let st = st0
  if (st.depth > MAX_RUN_DEPTH) {
    st.budget.cut = true
    return
  }
  let i = start
  const rest = (): Word[] => words.slice(i + 1)
  for (let guard = 0; guard < MAX_WRAPPERS; guard++) {
    i = commandStart(words, i)
    const w = words[i]
    if (!w || w.dyn) return
    const name = progName(nameText(w)).toLowerCase()
    if (PASS_THROUGH.has(name)) {
      i++
      continue
    }
    switch (name) {
      case 'sudo':
      case 'doas':
        i = skipOptions(words, i + 1, SUDO_SHORT, SUDO_LONG)
        continue
      case 'command': {
        let j = i + 1
        while (j < words.length && words[j]!.text.startsWith('-') && words[j]!.text !== '--') {
          if (/[vV]/.test(words[j]!.text)) return // `command -v x` only looks
          j++
        }
        i = j
        continue
      }
      case 'exec':
        i = skipOptions(words, i + 1, 'a', [])
        continue
      case 'time':
        i = skipOptions(words, i + 1, 'of', ['--output', '--format'])
        continue
      case 'nice':
        i = skipOptions(words, i + 1, 'n', ['--adjustment'])
        continue
      case 'ionice':
        i = skipOptions(words, i + 1, 'cnp', ['--class', '--classdata'])
        continue
      case 'stdbuf':
        i = skipOptions(words, i + 1, 'ioe', ['--input', '--output', '--error'])
        continue
      case 'timeout':
        i = skipOptions(words, i + 1, 'ks', ['--kill-after', '--signal']) + 1
        continue
      case 'env': {
        let j = i + 1
        let dir: Word | undefined
        while (j < words.length) {
          const t = words[j]!.text
          if (t === '--') {
            j++
            break
          }
          if (t === '-C' || t === '--chdir') {
            dir = words[j + 1]
            j += 2
          } else if (t === '-u' || t === '-S' || t === '--unset' || t === '--split-string') j += 2
          else if (t.length > 1 && t[0] === '-') j++
          else if (isAssign(words[j]!)) j++
          else break
        }
        if (dir) {
          const base = st.cwd
          st = fork(st)
          st.cwd = dir.dyn || dir.text === '' ? null : resolvePath(base ?? '', dir.text, st.home)
        }
        i = j
        continue
      }
      case 'npx':
      case 'bunx':
      case 'pnpx':
        i = skipOptions(words, i + 1, 'p', ['--package'])
        continue
      case 'pnpm':
      case 'yarn':
      case 'npm':
      case 'bun': {
        const j = skipOptions(words, i + 1, '', [])
        const sub = words[j]?.text
        if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
          i = skipOptions(words, j + 1, 'p', ['--package'])
          continue
        }
        if (name !== 'npm' && sub !== undefined && DB_RUNNER_TOOLS.has(sub)) {
          i = j
          continue
        }
        return
      }
      case 'bundle':
      case 'bundler':
        if (words[i + 1]?.text !== 'exec') return
        i += 2
        continue
      case 'poetry':
      case 'pipenv':
      case 'uv':
      case 'pdm':
      case 'rye':
      case 'hatch': {
        const j = skipOptions(words, i + 1, '', [])
        if (words[j]?.text !== 'run') return
        i = skipOptions(words, j + 1, '', [])
        continue
      }
      case 'xargs':
        return handleXargs(rest(), st)
      case 'find':
        return handleFind(rest(), st)
      case 'eval':
      case 'invoke-expression':
      case 'iex':
        return walkString(rest().map(a => a.text).join(' '), st)
      case 'su': {
        const args = rest()
        const k = args.findIndex(a => a.text === '-c' || a.text === '--command')
        const script = k >= 0 ? args[k + 1] : undefined
        if (script) walkString(script.text, st)
        return
      }
      case 'powershell':
      case 'pwsh':
        return handlePwsh(rest(), st)
      case 'cmd':
        return handleCmd(rest(), st)
      case 'rm':
      case 'remove-item':
      case 'ri':
      case 'del':
      case 'erase':
      case 'rd':
      case 'rmdir':
        return handleRemove(name, rest(), st)
      case 'git':
        return handleGit(rest(), st)
      case 'cp':
      case 'mv':
      case 'install':
        return handleCopy(name, rest(), st)
      case 'tee':
        return handleTee(rest(), st)
      case 'sed':
        return handleSed(rest(), st)
      default:
        if (SHELLS.has(name)) return handleShell(rest(), st)
        return handleDatabase(name, w, rest(), st)
    }
  }
  st.budget.cut = true // more wrappers than MAX_WRAPPERS: the command behind them was not reached
}

/** Reads text that a wrapper runs as a command line (`bash -c '...'`, `eval '...'`). */
function walkString(text: string, st: St): void {
  if (st.budget.left < 0) return // the budget already ran out (and said so)
  const inner = deeper(st)
  if (inner) walkSeq(parseText(text, st.budget), inner)
}

/** The command line given after `-c` / `-Command` / `/c`: one word is a command line, several are the command itself. */
function walkCommandArgs(rest: readonly Word[], st: St): void {
  if (rest.length === 1) walkString(rest[0]!.text, st)
  else if (rest.length > 1) {
    const sub = deeper(st)
    if (sub) runCommand(rest, 0, sub)
  }
}

function handleShell(args: readonly Word[], st: St): void {
  let i = 0
  while (i < args.length) {
    const t = args[i]!.text
    if (t === '--') return
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t[0] === '-' && t.includes('c')) {
        const script = args[i + 1]
        if (script) walkString(script.text, st)
        return
      }
      i += t === '-o' || t === '+o' ? 2 : 1
    } else if (t === '--rcfile' || t === '--init-file') i += 2
    else if (t.startsWith('--')) i++
    else return // a script file: nothing to read here
  }
}

function handlePwsh(args: readonly Word[], st: St): void {
  const valued = ['executionpolicy', 'ep', 'windowstyle', 'w', 'outputformat', 'o', 'inputformat', 'in', 'file', 'f', 'version', 'v', 'workingdirectory', 'wd']
  let i = 0
  while (i < args.length) {
    const t = args[i]!.text
    if (t[0] !== '-' && t[0] !== '/') return
    const name = t.slice(1).toLowerCase()
    if (name !== '' && 'command'.startsWith(name)) return walkCommandArgs(args.slice(i + 1), st)
    i += valued.includes(name) ? 2 : 1
  }
}

function handleCmd(args: readonly Word[], st: St): void {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text.toLowerCase()
    if (t === '/c' || t === '/k' || t === '/r') return walkCommandArgs(args.slice(i + 1), st)
    if (t[0] !== '/') return
  }
}

function handleXargs(args: readonly Word[], st: St): void {
  let i = 0
  let repl: string | null = null
  while (i < args.length) {
    const t = args[i]!.text
    if (t === '--') {
      i++
      break
    }
    if (t.length < 2 || t[0] !== '-') break
    if (t[1] === '-') {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--replace') repl = eq >= 0 ? t.slice(eq + 1) : '{}'
      else if (eq < 0 && XARGS_LONG.includes(name)) i++
      i++
      continue
    }
    for (let k = 1; k < t.length; k++) {
      const ch = t[k]!
      if (ch === 'I' || ch === 'J' || ch === 'R') {
        const attached = t.slice(k + 1)
        if (attached !== '') repl = attached
        else {
          repl = args[i + 1]?.text ?? '{}'
          i++
        }
        break
      }
      if (ch === 'i') {
        repl = t.slice(k + 1) || '{}'
        break
      }
      if ('nPLsdEaS'.includes(ch)) {
        if (k === t.length - 1) i++
        break
      }
    }
    i++
  }
  const sub = deeper(st)
  if (!sub) return
  sub.fromStdin = true
  if (repl) sub.repl = repl
  runCommand(args, i, sub)
}

const dotWord: Word = { text: '.', dyn: false, glob: false, quoted: false, subs: [] }
// What a `find` expression may hold without narrowing which files its action reaches.
const FIND_NO_FILTER = new Set(['-depth', '-print', '-print0'])
// The tests whose value is a name pattern; the first readable one becomes `Risk.match`.
const FIND_NAME_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex'])
// Control characters, soft hyphen, zero-width and direction marks: not shown, they could make the band say something else.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g

/** A find name pattern as text for the band: invisible characters removed, at most 60 characters (never half of a surrogate pair). */
function matchText(pattern: string): string {
  const s = pattern.replace(INVISIBLE, '')
  if (s.length <= 60) return s
  const c = s.charCodeAt(59)
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? 59 : 60)
}

function handleFind(args: readonly Word[], st: St): void {
  let i = 0
  while (i < args.length) {
    const t = args[i]!.text
    if (t === '-H' || t === '-L' || t === '-P' || t === '-E' || t === '-X' || t === '-x' || t === '-s' || /^-O\d?$/.test(t)) i++
    else if (t === '-D' || t === '-f') i += 2
    else break
  }
  const starts: Word[] = []
  while (i < args.length) {
    const t = args[i]!.text
    if ((t.length > 1 && t[0] === '-') || t === '!' || t === '(' || t === ')' || t === ',') break
    starts.push(args[i]!)
    i++
  }
  const roots = starts.length > 0 ? starts : [dotWord]
  let del = false
  let picks = false // some predicate or option chooses which files the action reaches
  const deletes: Risk[] = []
  // The first name pattern. It is read per `-o` branch: a branch that ends in `-prune` and then `-o` (`-name x -prune -o -exec rm {} +`)
  // spares what the pattern names, and `! -name x` is the opposite of the pattern: neither says what the delete reaches.
  let match: string | undefined
  let branch: string | undefined
  let last = ''
  for (let k = i; k < args.length; k++) {
    const t = args[k]!.text
    if (t === '-o' || t === '-or' || t === ',') {
      if (last !== '-prune') match ??= branch
      branch = undefined
    } else if (branch === undefined && FIND_NAME_TESTS.has(t)) {
      const v = args[k + 1]
      const before = k > i ? args[k - 1]!.text : ''
      if (v && !v.dyn && before !== '!' && before !== '-not') branch = matchText(v.text) || undefined
    }
    if (t !== ')') last = t
    if (t === '-delete') del = true
    else if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const inner: Word[] = []
      let m = k + 1
      while (m < args.length && args[m]!.text !== ';' && args[m]!.text !== '+') {
        if (args[m]!.text === '{}' && inner.length + roots.length <= MAX_WORDS) for (const r of roots) inner.push(r)
        else {
          if (args[m]!.text === '{}') st.budget.cut = true // no room to spell out every start path here
          inner.push(args[m]!)
        }
        m++
      }
      k = m
      const sub = deeper(st)
      if (!sub) {
        picks = true
        continue
      }
      sub.repl = '{}'
      const mark = { hit: false }
      sub.find = mark
      const before = st.out.length
      runCommand(inner, 0, sub)
      // A group that deletes is the action; any other `-exec` is a test that can filter.
      if (mark.hit) {
        for (const r of st.out.slice(before)) if (r.kind === 'delete') deletes.push(r)
      } else picks = true
    } else if (!FIND_NO_FILTER.has(t)) picks = true
  }
  if (del) {
    const r = deleteFromOperands('find -delete', roots, st, false)
    if (r) deletes.push(r)
  }
  match ??= branch
  if (picks) {
    for (const r of deletes) {
      r.picks = true
      if (match !== undefined) r.match = match
    }
  }
}

// --- rm and its Windows cousins ---------------------------------------------------------------------------------------

const PS_VALUE_PARAMS = new Set([
  'path', 'literalpath', 'lp', 'pspath', 'include', 'exclude', 'filter', 'stream', 'credential', 'erroraction', 'ea', 'warningaction', 'wa',
  'informationaction', 'ia', 'errorvariable', 'ev', 'warningvariable', 'wv', 'outvariable', 'ov', 'outbuffer', 'ob', 'pipelinevariable', 'pv',
  'informationvariable', 'iv',
])

function mkWord(text: string, glob: boolean): Word {
  return { text, dyn: false, glob, quoted: true, subs: [] }
}

function handleRemove(prog: string, args: readonly Word[], st: St): void {
  // Under `find -exec`, even a plain `rm` deletes everything find picks (like `find -delete`).
  const implied = st.find !== null && prog === 'rm'
  const winProg = prog !== 'rm'
  const cmdFlags = prog === 'del' || prog === 'erase' || prog === 'rd' || prog === 'rmdir'
  let recursive = false
  let via: 'posix' | 'ps' | 'cmd' = 'posix'
  let force = false
  let whatIf = false
  let psSeen = false
  let endOpts = false
  const operands: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    const t = w.text
    if (endOpts) {
      operands.push(w)
      continue
    }
    if (t === '--') {
      endOpts = true
      continue
    }
    if (t.length > 1 && t[0] === '-') {
      if (t[1] === '-') {
        const name = t.slice(2).split('=')[0]
        if (name === 'recursive') {
          recursive = true
          via = 'posix'
        } else if (name === 'force') force = true
        continue
      }
      if (/^-[fiIrRdvxPW]+$/.test(t)) {
        if (/[rR]/.test(t)) {
          recursive = true
          via = 'posix'
        }
        if (t.includes('f')) force = true
        continue
      }
      const m = /^-([A-Za-z]+)(?::(.*))?$/s.exec(t)
      if (m) {
        // PowerShell parameter: -Recurse, -Path x, -WhatIf, abbreviations allowed
        psSeen = true
        const name = m[1]!.toLowerCase()
        const inline = m[2]
        if ('recurse'.startsWith(name)) {
          if (inline === undefined || !/^\$?(?:false|0)$/i.test(inline)) {
            recursive = true
            via = 'ps'
          }
        } else if (name.length >= 2 && 'whatif'.startsWith(name)) whatIf = true
        else if (name === 'force' || name === 'fo') force = true
        else if (PS_VALUE_PARAMS.has(name) || (name.length >= 2 && ('path'.startsWith(name) || 'literalpath'.startsWith(name)))) {
          const isPath = name === 'lp' || name === 'pspath' || 'path'.startsWith(name) || 'literalpath'.startsWith(name)
          let value: Word | undefined
          if (inline !== undefined) value = mkWord(inline, false)
          else {
            value = args[k + 1]
            k++
          }
          if (isPath && value) operands.push(value)
        }
      }
      continue
    }
    if (cmdFlags && /^\/[A-Za-z?](?::[^/]*)?(?:\/[A-Za-z?](?::[^/]*)?)*$/.test(t)) {
      // cmd.exe flags: /s /q /f /a:h, written together or apart
      for (const f of t.slice(1).split('/')) {
        const l = f[0]!.toLowerCase()
        if (l === 's') {
          recursive = true
          via = 'cmd'
        }
      }
      continue
    }
    operands.push(w)
  }
  if ((!recursive && !implied) || whatIf) return
  if (st.find) st.find.hit = true

  // PowerShell and cmd take comma lists and always expand wildcards; `%VAR%` is a variable.
  let list: Word[] = operands
  if (winProg || psSeen) {
    list = []
    for (const w of operands) {
      const parts = w.dyn ? [w.text] : w.text.split(',')
      for (const part of parts) {
        if (part === '') continue
        const word: Word = { ...w, text: part, glob: /[*?[]/.test(part) }
        if (/%[A-Za-z_][^%]*%/.test(part)) word.dyn = true
        list.push(word)
      }
    }
  }
  // No operand at all means they come from elsewhere (`Get-ChildItem | Remove-Item -Recurse`, `-Path (Join-Path ...)`).
  const fromElsewhere = (winProg || psSeen) && list.length === 0
  let label: string
  if (prog === 'rm' && via === 'posix') label = recursive ? (force ? 'rm -rf' : 'rm -r') : force ? 'rm -f' : 'rm'
  else if (via === 'cmd') label = `${prog} /s`
  else label = 'Remove-Item -Recurse'
  deleteFromOperands(label, list, st, st.fromStdin || fromElsewhere)
}

// --- git --------------------------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])

function handleGit(args: readonly Word[], st0: St): void {
  let st = st0
  let i = 0
  while (i < args.length) {
    const t = args[i]!.text
    if (t.length < 2 || t[0] !== '-') break
    if (t === '-C') {
      // `git -C dir ...` runs in `dir`: the paths it names are relative to that folder.
      const d = args[i + 1]
      if (d && d.text !== '') {
        if (st === st0) st = fork(st0)
        st.cwd = d.dyn || d.glob ? null : resolveIn(st, d.text)
      }
      i += 2
      continue
    }
    i += GIT_GLOBAL_VALUE.has(t) ? 2 : 1
  }
  const sub = args[i]
  if (!sub || sub.dyn) return
  const rest = args.slice(i + 1)
  switch (sub.uni ?? sub.text) {
    case 'push':
      return gitPush(rest, st)
    case 'reset':
      if (rest.some(w => w.text === '--hard')) addRisk(st, { kind: 'reset-hard', tier: 'ask', label: 'git reset --hard', paths: [] })
      return
    case 'clean':
      return gitClean(rest, st)
    case 'checkout':
      return gitCheckout(rest, st)
    case 'restore':
      return gitRestore(rest, st)
    case 'switch':
      return gitSwitch(rest, st)
    case 'branch':
      return gitBranch(rest, st)
    case 'stash':
      return gitStash(rest, st)
    case 'update-ref':
      return gitUpdateRef(rest, st)
    case 'reflog':
      return gitReflog(rest, st)
    case 'gc':
      return gitGc(rest, st)
  }
}

const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const SCP_LIKE = /^[^\s@:/]+@[^\s:/]+:/

/** A remote as safe text: a name stays, a URL keeps only scheme and host, credentials never. */
export function safeRemote(remote: string): string | undefined {
  let r = typeof remote === 'string' ? cleanText(remote).trim() : ''
  if (r === '') return undefined
  if (URL_LIKE.test(r)) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(r)
    const authority = m ? m[2]! : ''
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '')
    r = m ? `${m[1]}://${host}` : ''
  } else if (SCP_LIKE.test(r)) {
    r = r.slice(r.lastIndexOf('@', r.indexOf(':')) + 1, r.indexOf(':'))
  } else if (r.includes('@')) {
    r = r.slice(r.lastIndexOf('@') + 1)
  }
  r = r.slice(0, 60)
  return r === '' || r.includes('@') || /[$`]/.test(r) ? undefined : r
}

function looksLikeRefspec(p: string): boolean {
  return p.startsWith('+') || (p.includes(':') && !URL_LIKE.test(p) && !SCP_LIKE.test(p) && !/^[A-Za-z]:[\\/]/.test(p))
}

function branchOf(refspec: string): string | undefined {
  let r = refspec.startsWith('+') ? refspec.slice(1) : refspec
  const c = r.indexOf(':')
  if (c >= 0) r = r.slice(c + 1)
  r = r.replace(/^refs\/(?:heads|tags)\//, '')
  r = cleanText(r)
  return r === '' || r === 'HEAD' || /[$`]/.test(r) ? undefined : r.slice(0, 60)
}

function gitPush(args: readonly Word[], st: St): void {
  let forceFlag = ''
  let dry = false
  let del = false
  let endOpts = false
  let repo: string | undefined
  const pos: string[] = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    if (!endOpts && t === '--') {
      endOpts = true
      continue
    }
    if (!endOpts && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      const val = eq >= 0 ? t.slice(eq + 1) : undefined
      // `--force-with-lease` and `--force-if-includes` refuse to overwrite work the pusher has not seen: alone they are safe.
      // Next to a plain `--force`, `-f` or `+refspec` the push is still forced (those set the flag on their own).
      if (name === '--force' || name === '--mirror') forceFlag ||= name
      else if (name === '--dry-run') dry = true
      else if (name === '--delete') del = true
      else if (name === '--repo') {
        if (val !== undefined) repo = val
        else {
          repo = args[k + 1]?.text
          k++
        }
      } else if ((name === '--push-option' || name === '--receive-pack' || name === '--exec') && val === undefined) k++
      continue
    }
    if (!endOpts && t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'f') forceFlag ||= t
        else if (ch === 'n') dry = true
        else if (ch === 'd') del = true
        else if (ch === 'o') {
          if (c === t.length - 1) k++ // -o <option>
          break
        }
      }
      continue
    }
    pos.push(t)
  }
  if (dry || del) return
  const plus = pos.some(p => p.startsWith('+'))
  if (forceFlag === '' && !plus) return
  if (pos.some(p => p.startsWith(':'))) return // deleting a branch on the remote is out of scope
  let remote: string | undefined
  let refs = pos
  if (repo !== undefined) remote = repo
  else if (pos.length > 0 && !looksLikeRefspec(pos[0]!)) {
    remote = pos[0]
    refs = pos.slice(1)
  }
  const risk: Risk = {
    kind: 'force-push',
    tier: 'ask',
    label: cap(`git push ${forceFlag === '' ? '+branch' : flagText(forceFlag) || '--force'}`),
    paths: [],
  }
  const safe = remote === undefined ? undefined : safeRemote(remote)
  if (safe !== undefined) risk.remote = safe
  const names: string[] = []
  for (const ref of refs) {
    const n = branchOf(ref)
    if (n !== undefined && !names.includes(n)) names.push(n)
    if (names.length >= MAX_NAMES) break
  }
  if (names.length > 0) {
    risk.name = names[0]
    risk.names = names
  }
  addRisk(st, risk)
}

function gitClean(args: readonly Word[], st: St): void {
  let force = false
  let dry = false
  const flags: string[] = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    if (t === '--') break
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--force') force = true
      else if (name === '--dry-run') dry = true
      else if (name === '--exclude' && eq < 0) k++
      const f = flagText(t)
      if (f !== '' && name !== '--exclude') flags.push(f)
      continue
    }
    if (t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'f') force = true
        else if (ch === 'n') dry = true
        else if (ch === 'e') {
          if (c === t.length - 1) k++
          break
        }
      }
      const f = flagText(t)
      if (f !== '') flags.push(f)
    }
  }
  if (!force || dry) return
  addRisk(st, { kind: 'clean', tier: 'ask', label: cap(['git clean', ...flags].join(' ')), paths: [] })
}

/** `.`, `./`, `:/` and `:/.` name the whole working tree. */
const isWholeTree = (t: string): boolean => t === '.' || t === './' || t === ':/' || t === ':/.' || t === ':(top)' || t === ':(top).'

/**
 * The paths a `git checkout -- a b` / `git restore a b` names that lie inside the project (as written, or absolute when
 * `git -C dir` moved the base), and whether some could not be read: a variable, a pathspec with magic (`:!x`), or too many.
 */
function gitPaths(words: readonly Word[], st: St): { paths: string[]; unknown: boolean } {
  const paths: string[] = []
  let unknown = false
  for (const w of words) {
    if (paths.length >= MAX_PATHS) {
      unknown = true // more paths than we keep
      break
    }
    if (w.text.startsWith(':') && !w.dyn) {
      unknown = true
      continue
    }
    const v = judge(w, st)
    if (v === 'unknown') unknown = true
    else if (v === 'inside') paths.push(emitPath(w.text, st))
  }
  return { paths, unknown }
}

/** A `discard` for the named files only: their uncommitted changes are thrown away. */
function discardPaths(label: string, words: readonly Word[], st: St): void {
  const { paths, unknown } = gitPaths(words, st)
  if (paths.length === 0 && !unknown) return
  const risk: Risk = { kind: 'discard', tier: 'ask', label: cap(label), paths }
  if (unknown) risk.hasUnknownPath = true
  addRisk(st, risk)
}

function gitCheckout(args: readonly Word[], st: St): void {
  let force = ''
  let dd = false
  let whole = ''
  let patch = false
  let fromFile = false
  const named: Word[] = [] // after `--`: always paths
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    const t = w.text
    if (!dd && t === '--') {
      dd = true
      continue
    }
    if (!dd && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--force') force ||= '--force'
      else if (name === '--patch') patch = true
      else if (name === '--pathspec-from-file') {
        fromFile = true
        if (eq < 0) k++
      } else if ((name === '--conflict' || name === '--orphan') && eq < 0) k++
      continue
    }
    if (!dd && t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'f') force ||= flagText(t) || '-f'
        else if (ch === 'p') patch = true
        else if (ch === 'b' || ch === 'B') {
          if (c === t.length - 1) k++
          break
        }
      }
      continue
    }
    if (dd) named.push(w)
    if (!w.dyn && isWholeTree(t) && whole === '') whole = t
  }
  if (patch) return
  if (whole !== '') {
    addRisk(st, { kind: 'discard', tier: 'ask', label: cap(['git checkout', force, dd ? '--' : '', whole].filter(Boolean).join(' ')), paths: [] })
  } else if (fromFile) {
    addRisk(st, { kind: 'discard', tier: 'ask', label: cap(['git checkout', force].filter(Boolean).join(' ')), paths: [], hasUnknownPath: true })
  } else if (named.length > 0) {
    discardPaths(['git checkout', force, '--'].filter(Boolean).join(' '), named, st)
  } else if (force !== '') {
    addRisk(st, { kind: 'discard', tier: 'ask', label: cap(['git checkout', force, dd ? '--' : ''].filter(Boolean).join(' ')), paths: [] })
  }
}

function gitRestore(args: readonly Word[], st: St): void {
  let staged = false
  let worktree = false
  let dd = false
  let whole = ''
  let patch = false
  let fromFile = false
  const named: Word[] = [] // `git restore` takes no tree-ish: every plain word is a path
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    const t = w.text
    if (!dd && t === '--') {
      dd = true
      continue
    }
    if (!dd && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--staged') staged = true
      else if (name === '--worktree') worktree = true
      else if (name === '--patch') patch = true
      else if (name === '--pathspec-from-file') {
        fromFile = true
        if (eq < 0) k++
      } else if (name === '--source' && eq < 0) k++
      continue
    }
    if (!dd && t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'S') staged = true
        else if (ch === 'W') worktree = true
        else if (ch === 'p') patch = true
        else if (ch === 's') {
          if (c === t.length - 1) k++
          break
        }
      }
      continue
    }
    named.push(w)
    if (!w.dyn && isWholeTree(t) && whole === '') whole = t
  }
  if (patch || (staged && !worktree)) return // `--staged` alone only touches the index
  const prefix = ['git restore', worktree ? '--worktree' : '', dd ? '--' : '']
  if (whole !== '') {
    addRisk(st, { kind: 'discard', tier: 'ask', label: cap([...prefix, whole].filter(Boolean).join(' ')), paths: [] })
  } else if (fromFile) {
    addRisk(st, { kind: 'discard', tier: 'ask', label: cap(['git restore', worktree ? '--worktree' : ''].filter(Boolean).join(' ')), paths: [], hasUnknownPath: true })
  } else if (named.length > 0) {
    discardPaths(prefix.filter(Boolean).join(' '), named, st)
  }
}

function gitSwitch(args: readonly Word[], st: St): void {
  let flag = ''
  for (const w of args) {
    const t = w.text
    if (t === '--') break
    if (t === '--force' || t === '--discard-changes') flag ||= t
    else if (t.length > 1 && t[0] === '-' && t[1] !== '-' && t.includes('f')) flag ||= flagText(t) || '-f'
  }
  if (flag === '') return
  addRisk(st, { kind: 'discard', tier: 'ask', label: cap(`git switch ${flag}`), paths: [] })
}

function gitBranch(args: readonly Word[], st: St): void {
  let big = false
  let del = false
  let force = false
  const names: string[] = []
  const flags: string[] = []
  let endOpts = false
  for (const w of args) {
    const t = w.text
    if (!endOpts && t === '--') {
      endOpts = true
      continue
    }
    if (!endOpts && t.startsWith('--')) {
      const base = t.split('=')[0]!
      if (base === '--delete') del = true
      else if (base === '--force') force = true
      const f = flagText(t)
      if (f !== '') flags.push(f)
      continue
    }
    if (!endOpts && t.length > 1 && t[0] === '-') {
      if (t.includes('D')) big = true
      if (t.includes('d')) del = true
      if (t.includes('f')) force = true
      const f = flagText(t)
      if (f !== '') flags.push(f)
      continue
    }
    if (!w.dyn && names.length < MAX_NAMES) {
      const n = cleanText(t).slice(0, 60)
      if (n !== '' && !names.includes(n)) names.push(n)
    }
  }
  if (!(big || (del && force))) return
  const risk: Risk = { kind: 'branch-delete', tier: 'ask', label: cap(['git branch', ...flags].join(' ')), paths: [] }
  if (names.length > 0) {
    risk.name = names[0]
    risk.names = names
  }
  addRisk(st, risk)
}

// --- git: emptying Git's own safety nets ----------------------------------------------------------------------------------

/** A long option's name is `full`, or a short start of it that git also accepts (`--expire-u` for `--expire-unreachable`). */
const longIs = (name: string, full: string, min: number): boolean => name === full || (name.length >= min && full.startsWith(name))

/** `now` and `all` throw everything away at once; a date such as `2.weeks.ago` keeps the recent part. */
const WIPES_AT_ONCE = /^(?:now|all)$/i

/** The label is one of a few fixed phrases, never an argument. */
function gitErase(label: string, st: St): void {
  addRisk(st, { kind: 'git-erase', tier: 'ask', label, paths: [] })
}

/** `git stash drop [<stash>]` and `git stash clear` lose stashed work. `git stash`, `push`, `pop`, `apply`, `list`, `show` do not. */
function gitStash(args: readonly Word[], st: St): void {
  const first = args[0]
  if (!first || first.dyn) return
  const sub = first.uni ?? first.text
  if (sub === 'drop' || sub === 'clear') gitErase(`git stash ${sub}`, st)
}

/** `git update-ref -d <ref>` / `--delete` removes a ref (a branch or tag with no safety copy). Setting a ref is not a loss. */
function gitUpdateRef(args: readonly Word[], st: St): void {
  let del = false
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    if (t === '--') break
    if (t.startsWith('--')) {
      if (longIs(t, '--delete', 3)) del = true
    } else if (t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'd') del = true
        else if (ch === 'm') {
          if (c === t.length - 1) k++ // `-m <reason>`: the reason may itself look like a flag
          break
        } else if (ch !== 'z') break
      }
    }
  }
  if (del) gitErase('git update-ref -d', st)
}

/**
 * `git reflog expire` empties the undo history: with `--expire=now|all` or `--expire-unreachable=now|all` (also written as two
 * words), or with `--all` next to any `--expire*`. `--dry-run` / `-n` changes nothing. Showing, `exists` and `delete` are out of scope.
 */
function gitReflog(args: readonly Word[], st: St): void {
  const sub = args[0]
  if (!sub || sub.dyn || (sub.uni ?? sub.text) !== 'expire') return
  let all = false
  let expiring = false
  let wipes = false
  let dry = false
  for (let k = 1; k < args.length; k++) {
    const t = args[k]!.text
    if (t === '--') break
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (longIs(name, '--all', 3)) all = true
      else if (longIs(name, '--dry-run', 3)) dry = true
      else if (name === '--expire' || (name.startsWith('--expire-') && '--expire-unreachable'.startsWith(name))) {
        expiring = true
        const value = eq >= 0 ? t.slice(eq + 1) : args[k + 1]?.text
        if (eq < 0) k++ // git takes the next word as the value, whatever it looks like
        if (value !== undefined && WIPES_AT_ONCE.test(value)) wipes = true
      }
    } else if (t.length > 1 && t[0] === '-' && t.includes('n')) dry = true
  }
  if (!dry && (wipes || (all && expiring))) gitErase('git reflog expire', st)
}

/** `git gc --prune=now` (or `all`) deletes every unreachable object at once, the last copy of lost commits. Plain `git gc` keeps two weeks. */
function gitGc(args: readonly Word[], st: St): void {
  for (const w of args) {
    const t = w.text
    if (t === '--') return
    const eq = t.indexOf('=')
    if (eq < 0 || !t.startsWith('--')) continue
    if (longIs(t.slice(0, eq), '--prune', 3) && WIPES_AT_ONCE.test(t.slice(eq + 1))) return gitErase('git gc --prune=now', st)
  }
}

// --- databases --------------------------------------------------------------------------------------------------------

const SQL_DROP = /\bdrop\s+(?:table|database|schema)\b/i
const SQL_TRUNCATE = /\btruncate\s+(?![\s(])/i
const SQL_MONGO = /\bdropDatabase\s*\(|\.drop\s*\(/i
const SQL_FLUSH = /\bflush(?:all|db)\b/i
const SQL_NAME = /^\s+(?:if\s+exists\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.$-]+))/i
const SQL_TRUNCATE_NAME = /^(?:table\s+)?(?:only\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.$-]+))/i
const MONGO_COLLECTION = /\bdb\.([\w$-]+)\.drop\s*\(/i

function nameFrom(m: RegExpExecArray | null): string | undefined {
  if (!m) return undefined
  const n = m[1] ?? m[2] ?? m[3] ?? m[4]
  return n === undefined || n === '' ? undefined : cleanText(n).slice(0, 60)
}

/** A destructive statement in a piece of SQL or a database-shell command: what it drops when that can be read. */
export function sqlDrop(text: string): { name?: string } | null {
  if (typeof text !== 'string') return null
  const t = text.length > SQL_MAX ? text.slice(0, SQL_MAX) : text
  let m = SQL_DROP.exec(t)
  if (m) {
    const name = nameFrom(SQL_NAME.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 200)))
    return name === undefined ? {} : { name }
  }
  m = SQL_TRUNCATE.exec(t)
  if (m) {
    const name = nameFrom(SQL_TRUNCATE_NAME.exec(t.slice(m.index + m[0].length, m.index + m[0].length + 200)))
    return name === undefined ? {} : { name }
  }
  if (SQL_MONGO.test(t)) {
    const name = nameFrom(MONGO_COLLECTION.exec(t))
    return name === undefined ? {} : { name }
  }
  if (SQL_FLUSH.test(t)) return {}
  return null
}

const D1_DROP = /\bdrop\s+(?:table|database|schema|view|index)\b/i
const D1_DELETE = /\bdelete\s+from\b/i

/** `text` with every SQL comment (block or line) turned into one space: `DROP`, a block comment, then `TABLE t` is a valid statement. Linear. */
function blankSqlComments(text: string): string {
  let out = ''
  let from = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const block = c === '/' && text[i + 1] === '*'
    if (block || (c === '-' && text[i + 1] === '-')) {
      out += text.slice(from, i) + ' '
      const end = block ? text.indexOf('*/', i + 2) : text.indexOf('\n', i + 2)
      i = end < 0 ? text.length : block ? end + 2 : end
      from = i
    } else i++
  }
  return out + text.slice(from)
}

/** The earliest `DROP TABLE|DATABASE|SCHEMA|VIEW|INDEX`, `TRUNCATE` or `DELETE FROM` in `t`, with the name after it when readable. */
function d1Look(t: string): { name?: string } | null {
  const hits: Array<{ at: number; end: number; nameRe: RegExp }> = []
  const add = (m: RegExpExecArray | null, nameRe: RegExp): void => {
    if (m) hits.push({ at: m.index, end: m.index + m[0].length, nameRe })
  }
  add(D1_DROP.exec(t), SQL_NAME)
  add(SQL_TRUNCATE.exec(t), SQL_TRUNCATE_NAME)
  add(D1_DELETE.exec(t), SQL_NAME)
  if (hits.length === 0) return null
  hits.sort((x, y) => x.at - y.at)
  const h = hits[0]!
  const name = nameFrom(h.nameRe.exec(t.slice(h.end, h.end + 200)))
  return name === undefined ? {} : { name }
}

/**
 * A statement in SQL given to `wrangler d1 execute --command` that destroys data: the drops of `sqlDrop` plus `DROP VIEW|INDEX`
 * and `DELETE FROM` (D1 is SQLite: there is no flushall or collection drop to look for). Comments are read as blanks too.
 */
function d1Danger(text: string): { name?: string } | null {
  const t = text.length > SQL_MAX ? text.slice(0, SQL_MAX) : text
  return d1Look(t) ?? d1Look(blankSqlComments(t))
}

/** Words that are not options (no leading dash), with the values of the listed options skipped. */
function positionals(args: readonly Word[], valued: readonly string[]): Word[] {
  const out: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    if (t.length > 1 && t[0] === '-') {
      if (valued.includes(t)) k++
      continue
    }
    out.push(args[k]!)
  }
  return out
}

const isPython = (name: string): boolean => /^python(?:\d+(?:\.\d+)*)?$/.test(name) || name === 'py'

// Options of `wrangler d1 execute` (and the global ones) that take a value as the next word.
const WRANGLER_VALUED = ['--command', '-c', '--sql', '--file', '--persist-to', '--batch-size', '--config', '--env', '-e', '--env-file', '--cwd']
const WRANGLER_SQL_FLAGS = new Set(['--command', '--sql', '-c'])

/**
 * `wrangler d1 execute <db> --command "<sql>"` (also `--sql`, `-c`, and `--command=...`): a db-drop when the SQL drops, truncates or
 * deletes rows (see `d1Danger`). `--file` runs SQL that is not on the command line, so it is not read; selects, inserts, creates and updates are fine.
 * The name is the table the SQL names, else the database argument.
 */
function handleWrangler(args: readonly Word[], st: St): void {
  const d1 = args.findIndex(a => a.text === 'd1')
  if (d1 < 0) return
  let j = d1 + 1
  while (j < args.length && args[j]!.text.startsWith('-')) j++
  if (args[j]?.text !== 'execute') return
  const rest = args.slice(j + 1)
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]!
    const t = w.text
    if (t[0] !== '-') continue
    const eq = t.indexOf('=')
    if (!WRANGLER_SQL_FLAGS.has(eq >= 0 ? t.slice(0, eq) : t)) continue
    const value: Word | undefined = eq >= 0 ? { ...w, text: t.slice(eq + 1) } : rest[k + 1]
    if (eq < 0) k++
    if (!value) continue
    const hit = d1Danger(value.text)
    if (!hit) {
      if (value.text.length > SQL_MAX) st.budget.cut = true // d1Danger read only the first SQL_MAX characters
      continue
    }
    // A table written as `$T` in a double-quoted command is a variable, not a name.
    let name = hit.name !== undefined && value.dyn && /[$`]/.test(hit.name) ? undefined : hit.name
    if (name === undefined) {
      const db = positionals(rest, WRANGLER_VALUED)[0]
      if (db && !db.dyn) name = cleanText(db.text).slice(0, 60) || undefined
    }
    const risk: Risk = { kind: 'db-drop', tier: 'ask', label: 'wrangler d1 execute', paths: [] }
    if (name) risk.name = name
    addRisk(st, risk)
    return
  }
}

function handleDatabase(name: string, prog: Word, args: readonly Word[], st: St): void {
  const risk = (label: string, dbName?: string): void => {
    const r: Risk = { kind: 'db-drop', tier: 'ask', label: cap(label), paths: [] }
    if (dbName) r.name = dbName
    addRisk(st, r)
  }
  if (SQL_TOOLS.has(name)) {
    for (const a of args) {
      const hit = sqlDrop(a.text)
      if (!hit) {
        if (a.text.length > SQL_MAX) st.budget.cut = true // sqlDrop read only the first SQL_MAX characters
        continue
      }
      const r: Risk = { kind: 'db-drop', tier: 'ask', label: cap(progName(nameText(prog))), paths: [] }
      if (hit.name) r.name = hit.name
      if (name === 'sqlite3') {
        const file = positionals(args, ['-cmd', '-init', '-separator', '-newline', '-nullvalue', '-vfs'])[0]
        if (file) {
          if (file.dyn) r.hasUnknownPath = true
          else if (file.text !== '' && file.text !== ':memory:') r.paths.push(emitPath(file.text, st))
        }
      }
      addRisk(st, r)
      return
    }
    return
  }
  const pos = positionals(args, [])
  const first = pos[0]?.text
  const second = pos[1]?.text
  switch (name) {
    case 'dropdb': {
      const target = positionals(args, ['-h', '-p', '-U', '--host', '--port', '--username', '--maintenance-db'])[0]
      if (target) risk('dropdb', target.dyn ? undefined : cleanText(target.text).slice(0, 60))
      return
    }
    case 'mysqladmin': {
      const k = pos.findIndex(w => w.text.toLowerCase() === 'drop')
      const target = k >= 0 ? pos[k + 1] : undefined
      if (k >= 0) risk('mysqladmin drop', target && !target.dyn ? cleanText(target.text).slice(0, 60) : undefined)
      return
    }
    case 'wrangler':
      return handleWrangler(args, st)
    case 'prisma':
      if (first === 'migrate' && second === 'reset') risk('prisma migrate reset')
      else if (first === 'db' && second === 'push' && args.some(a => a.text === '--force-reset')) risk('prisma db push --force-reset')
      return
    case 'rails':
    case 'rake': {
      const task = pos.find(w => /^db:(?:drop|reset|migrate:reset)(?::\w+)?$/.test(w.text))
      if (task) risk(`${name} ${task.text}`)
      return
    }
    case 'sequelize':
    case 'sequelize-cli': {
      const task = pos.find(w => w.text === 'db:drop' || w.text === 'db:migrate:undo:all')
      if (task) risk(`${name} ${task.text}`)
      return
    }
    case 'drizzle-kit':
      if (first === 'drop') risk('drizzle-kit drop')
      return
    case 'supabase':
      if (first === 'db' && second === 'reset') risk('supabase db reset')
      return
    case 'knex':
      if (pos.some(w => w.text === 'migrate:rollback') && args.some(a => a.text === '--all')) risk('knex migrate:rollback --all')
      return
    case 'django-admin':
    case 'django-admin.py':
    case 'manage.py':
      if (first === 'flush' || first === 'reset_db') risk(`${name} ${first}`)
      return
    case 'php':
      if (first === 'artisan' && (second === 'migrate:fresh' || second === 'db:wipe')) risk(`php artisan ${second}`)
      return
    default:
      if (name.startsWith('wrangler@')) {
        handleWrangler(args, st) // `npx wrangler@latest ...`
      } else if (name.startsWith('typeorm')) {
        if (pos.some(w => w.text === 'schema:drop')) risk('typeorm schema:drop')
      } else if (isPython(name)) {
        const m = args.findIndex(a => a.text === '-m')
        if (m >= 0) {
          const sub = args[m + 1]?.text === 'django' ? args[m + 2]?.text : undefined
          if (sub === 'flush' || sub === 'reset_db') risk(`django ${sub}`)
        } else if (pos[0] && baseName(pos[0].text) === 'manage.py' && (pos[1]?.text === 'flush' || pos[1]?.text === 'reset_db')) {
          risk(`manage.py ${pos[1].text}`)
        }
      }
  }
}

// --- overwriting .env-like files from Bash -----------------------------------------------------------------------------

function handleCopy(prog: string, args: readonly Word[], st: St): void {
  const operands: Word[] = []
  let target: Word | undefined
  let endOpts = false
  let dirsOnly = false
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    const t = w.text
    if (!endOpts && t === '--') {
      endOpts = true
      continue
    }
    if (!endOpts && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--target-directory') {
        if (eq >= 0) target = mkWord(t.slice(eq + 1), false)
        else {
          target = args[k + 1]
          k++
        }
      } else if (eq < 0 && ['--suffix', '--mode', '--owner', '--group', '--context'].includes(name)) k++
      continue
    }
    if (!endOpts && t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (prog === 'install' && ch === 'd') dirsOnly = true
        if ('tSmogZ'.includes(ch)) {
          const attached = t.slice(c + 1)
          if (ch === 't') {
            if (attached !== '') target = mkWord(attached, false)
            else {
              target = args[k + 1]
              k++
            }
          } else if (attached === '') k++
          break
        }
      }
      continue
    }
    operands.push(w)
  }
  if (dirsOnly) return
  const candidates: string[] = []
  const add = (p: string): void => {
    if (isEnvLike(p)) candidates.push(emitPath(p, st))
  }
  let sources: Word[]
  if (target) {
    sources = operands
    if (!target.dyn) for (const s of sources) if (!s.dyn) add(joinPath(target.text, baseName(s.text)))
  } else if (operands.length >= 2) {
    const last = operands[operands.length - 1]!
    sources = operands.slice(0, -1)
    if (!last.dyn) {
      add(last.text)
      const dirLike = sources.length > 1 || /[\\/]$/.test(last.text) || /(?:^|[\\/])\.{1,2}$/.test(last.text)
      if (dirLike) for (const s of sources) if (!s.dyn) add(joinPath(last.text, baseName(s.text)))
    }
  } else return
  if (candidates.length === 0) return
  const single = sources.length === 1 && !sources[0]!.dyn ? sources[0]! : undefined
  const risk: Risk = {
    kind: 'overwrite',
    tier: 'ask',
    label: cap(single ? `${prog} ${shortName(single.text)}` : prog),
    paths: candidates,
  }
  if (single) risk.source = emitPath(single.text, st)
  addRisk(st, risk)
}

function handleTee(args: readonly Word[], st: St): void {
  const files: Word[] = []
  let append = false
  let endOpts = false
  for (const w of args) {
    const t = w.text
    if (!endOpts && t === '--') endOpts = true
    else if (!endOpts && t.startsWith('--')) {
      if (t === '--append') append = true
    } else if (!endOpts && t.length > 1 && t[0] === '-') {
      if (t.includes('a')) append = true
    } else files.push(w)
  }
  if (append) return
  const envs = files.filter(w => !w.dyn && isEnvLike(w.text))
  if (envs.length === 0) return
  addRisk(st, {
    kind: 'overwrite',
    tier: 'ask',
    label: envs.length === 1 ? cap(`tee ${shortName(envs[0]!.text)}`) : 'tee',
    paths: envs.map(w => emitPath(w.text, st)),
  })
}

function handleSed(args: readonly Word[], st: St): void {
  let inPlace = false
  let scriptGiven = false
  let endOpts = false
  const pos: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!
    const t = w.text
    if (!endOpts && t === '--') {
      endOpts = true
      continue
    }
    if (!endOpts && t.startsWith('--')) {
      const eq = t.indexOf('=')
      const name = eq >= 0 ? t.slice(0, eq) : t
      if (name === '--in-place') inPlace = true
      else if (name === '--expression' || name === '--file') {
        scriptGiven = true
        if (eq < 0) k++
      }
      continue
    }
    if (!endOpts && t.length > 1 && t[0] === '-') {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c]!
        if (ch === 'i') {
          inPlace = true // the rest of the word is a backup suffix
          break
        }
        if (ch === 'e' || ch === 'f') {
          scriptGiven = true
          if (c === t.length - 1) k++
          break
        }
        if (!'nEsrzu'.includes(ch)) break
      }
      continue
    }
    if (t !== '') pos.push(w)
  }
  if (!inPlace) return
  const files = scriptGiven ? pos : pos.slice(1)
  const envs = files.filter(w => !w.dyn && isEnvLike(w.text))
  if (envs.length === 0) return
  addRisk(st, {
    kind: 'overwrite',
    tier: 'ask',
    label: envs.length === 1 ? cap(`sed -i ${shortName(envs[0]!.text)}`) : 'sed -i',
    paths: envs.map(w => emitPath(w.text, st)),
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point

function mergeRisks(list: readonly Risk[]): Risk[] {
  const seen = new Map<string, Risk>()
  for (const r of list) {
    const key = [
      r.kind,
      r.tier,
      [...r.paths].sort().join('\u0000'),
      r.name ?? '',
      (r.names ?? []).join('\u0000'),
      r.remote ?? '',
      r.source ?? '',
      r.hasUnknownPath ? '1' : '0',
      r.picks ? '1' : '0',
      r.match ?? '',
      // `git-erase` has no paths or names: the fixed words are what tells `git stash drop` from `git gc --prune=now`.
      r.kind === 'git-erase' ? r.label : '',
    ].join('\u0001')
    if (!seen.has(key)) seen.set(key, r)
  }
  return [...seen.values()]
}

/** What `classifyBash` adds, once and last, when a limit stopped the reading: something unread could be dangerous. */
const UNPARSED: Risk = { kind: 'unparsed', tier: 'ask', label: 'long command', paths: [] }

/**
 * The risks a Bash command carries, in the order they appear. Reads quoting, chaining, subshells, `$( )`, here-docs,
 * wrappers (`sudo`, `bash -c`, `xargs`, `find -exec`, ...) and `cd` in a chain. Never throws. Fails closed: when a limit
 * (commands, nesting, words, depth, wrappers, SQL size) stopped the reading before the end, one `unparsed` risk comes last.
 */
export function classifyBash(command: string, ctx: BashContext): Risk[] {
  const out: Risk[] = []
  const budget: Budget = { left: MAX_COMMANDS, cut: false }
  try {
    if (typeof command !== 'string' || command === '') return []
    const rootRaw = typeof ctx?.root === 'string' ? ctx.root : ''
    const cwdRaw = typeof ctx?.cwd === 'string' ? ctx.cwd : ''
    const root = isAbsolute(rootRaw) ? normalizePath(rootRaw) : null
    const base0 = isAbsolute(cwdRaw) ? normalizePath(cwdRaw) : root
    const st: St = {
      home: typeof ctx?.home === 'string' && ctx.home !== '' ? ctx.home : undefined,
      root,
      base0,
      cwd: base0,
      prev: null,
      stack: [],
      out,
      budget,
      depth: 0,
      repl: null,
      fromStdin: false,
      find: null,
    }
    walkSeq(parseText(command, budget), st)
  } catch {
    budget.cut = true // something went wrong part-way (a stack limit, say): what was read stays, the rest is unknown
  }
  const merged = mergeRisks(out)
  if (budget.cut) merged.push({ ...UNPARSED })
  return merged
}
