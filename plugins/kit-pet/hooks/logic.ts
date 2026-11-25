// Pure logic of kit-pet: growth, the state machine, days and streaks, the save, command recognition, formatting.
// No engine imports, no Date.now, no I/O: time is always a parameter, so every piece is unit-tested.
import type { AchievementId, PetState, Quota, Stage } from './types'

/** Finished turns at which the pet reaches stage 1, 2 and 3. */
export const STAGE_AT = [0, 50, 300] as const
export const DONE_MS = 8000
export const TOOL_ERROR_MS = 6000
// A turn that ended in an error or refusal shows the error state for this long (or until the next turn starts).
export const TURN_ERROR_MS = 60_000
// A limit reading that came without a reset time cannot tell when it stops being true, so it is trusted this long.
export const QUOTA_STALE_MS = 6 * 3600_000
export const QUOTA_PCT = 85
export const STREAK_GOAL = 7
export const TURNS_GOAL = 100
export const BAR_CELLS = 6
export const ACHIEVEMENT_ORDER: readonly AchievementId[] = ['firstCommit', 'firstTest', 'turns100', 'streak7']
// Enough history for a streak of over a year (the /pet streak is counted from these days) and still a small save.
export const MAX_DAYS = 400

// ---------------------------------------------------------------- growth

// Anything that is not a finite positive number counts as no turns, so a damaged save still shows a sprout.
function wholeTurns(turns: unknown): number {
  return typeof turns === 'number' && Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0
}

export function stageOf(turns: number): Stage {
  const t = wholeTurns(turns)
  return t >= STAGE_AT[2] ? 3 : t >= STAGE_AT[1] ? 2 : 1
}

export function growth(turns: number): { stage: Stage; into: number; span: number | null; filled: number; left: number | null } {
  const t = wholeTurns(turns)
  const stage = stageOf(t)
  if (stage === 3) return { stage, into: t - STAGE_AT[2], span: null, filled: BAR_CELLS, left: null }
  const start = STAGE_AT[stage - 1] as number
  const span = (STAGE_AT[stage] as number) - start
  const into = t - start
  // floor, so a full bar only ever means "grown".
  return { stage, into, span, filled: Math.min(BAR_CELLS, Math.floor((into / span) * BAR_CELLS)), left: span - into }
}

// ---------------------------------------------------------------- state machine

export type EndReason = 'answer' | 'error' | 'refusal' | 'aborted'

export type Model = {
  working: boolean
  workingSince: number | null
  endedAt: number | null
  endReason: EndReason | null
  toolErrorAt: number | null
  quotaPct: number | null
}

export type Ev =
  | { t: 'turnStart'; at: number }
  | { t: 'turnEnd'; at: number; reason: EndReason }
  | { t: 'toolFail'; at: number }
  | { t: 'toolOk'; at: number }
  | { t: 'quota'; pct: number | null }

export function emptyModel(): Model {
  return { working: false, workingSince: null, endedAt: null, endReason: null, toolErrorAt: null, quotaPct: null }
}

export function step(m: Model, ev: Ev): Model {
  switch (ev.t) {
    case 'turnStart':
      // A new turn wipes the last outcome, so a sticky error ends when the user tries again.
      return { ...m, working: true, workingSince: ev.at, endedAt: null, endReason: null, toolErrorAt: null }
    case 'turnEnd':
      return { ...m, working: false, workingSince: null, endedAt: ev.at, endReason: ev.reason, toolErrorAt: null }
    case 'toolFail':
      return { ...m, toolErrorAt: ev.at }
    case 'toolOk':
      return { ...m, toolErrorAt: null }
    case 'quota': {
      const p = ev.pct
      return { ...m, quotaPct: typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : null }
    }
  }
}

export function deriveState(m: Model, now: number): PetState {
  if (m.working) {
    // A clock that went backwards must not keep the error showing, so the age has to be >= 0.
    if (m.toolErrorAt !== null) {
      const age = now - m.toolErrorAt
      if (age >= 0 && age < TOOL_ERROR_MS) return 'error'
    }
    return 'working'
  }
  if ((m.endReason === 'error' || m.endReason === 'refusal') && m.endedAt !== null) {
    // Sticky until the next turn starts, but only for a minute: a pet stuck on ERROR for hours says nothing.
    // A clock that went backwards is not an error either, so the age has to be >= 0.
    const age = now - m.endedAt
    if (age >= 0 && age < TURN_ERROR_MS) return 'error'
  }
  if (m.endReason === 'answer' && m.endedAt !== null) {
    const age = now - m.endedAt
    if (age >= 0 && age < DONE_MS) return 'done'
  }
  if (m.quotaPct !== null && m.quotaPct >= QUOTA_PCT) return 'quota'
  return 'idle'
}

// ---------------------------------------------------------------- days

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function utcKey(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** True for a real calendar day written YYYY-MM-DD (2025-02-30 is not one). */
export function isDay(key: unknown): key is string {
  if (typeof key !== 'string' || !DAY_RE.test(key)) return false
  const d = new Date(0)
  d.setUTCFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
  return utcKey(d) === key
}

/** The local calendar day of `ms`. tzOffsetMin is what getTimezoneOffset() returns (UTC minus local). */
export function dayKey(ms: number, tzOffsetMin: number): string {
  const t = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
  const off = typeof tzOffsetMin === 'number' && Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0
  const d = new Date(t - off * 60000)
  return Number.isNaN(d.getTime()) ? '1970-01-01' : utcKey(d)
}

/** The day before `key`, or '' when `key` is not a real day. */
export function prevDay(key: string): string {
  if (!isDay(key)) return ''
  const d = new Date(0)
  d.setUTCFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)) - 1)
  return utcKey(d)
}

function cleanDays(days: readonly unknown[]): string[] {
  // YYYY-MM-DD sorts as text in date order, so a plain sort is enough.
  return [...new Set(days.filter(isDay))].sort().slice(-MAX_DAYS)
}

export function addDay(days: readonly string[], key: string): string[] {
  return cleanDays(isDay(key) ? [...days, key] : days)
}

export function streakOf(days: readonly string[], today: string): number {
  if (!isDay(today)) return 0
  const set = new Set(days.filter(isDay))
  // A day with no turn yet does not break the streak; it only ends when yesterday is missing too.
  let cur = set.has(today) ? today : prevDay(today)
  let n = 0
  while (cur !== '' && set.has(cur)) {
    n++
    cur = prevDay(cur)
  }
  return n
}

// ---------------------------------------------------------------- save

export type Save = {
  v: 1
  turns: number
  days: string[]
  testGreen: boolean
  committed: boolean
  earned: Partial<Record<AchievementId, string>>
  announced: AchievementId[]
  lastToastDay: string | null
  today: { day: string | null; turns: number }
}

export function emptySave(): Save {
  return { v: 1, turns: 0, days: [], testGreen: false, committed: false, earned: {}, announced: [], lastToastDay: null, today: { day: null, turns: 0 } }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isAchievement = (x: unknown): x is AchievementId => typeof x === 'string' && (ACHIEVEMENT_ORDER as readonly string[]).includes(x)
const count = (x: unknown): number => wholeTurns(x)

/** Accepts anything and always returns a valid Save: a damaged file must never break the pet. */
export function sanitizeSave(raw: unknown): Save {
  const out = emptySave()
  if (!isRecord(raw)) return out
  out.turns = count(raw.turns)
  out.days = Array.isArray(raw.days) ? cleanDays(raw.days) : []
  out.testGreen = raw.testGreen === true
  out.committed = raw.committed === true
  if (isRecord(raw.earned)) {
    for (const id of ACHIEVEMENT_ORDER) {
      const d = raw.earned[id]
      if (isDay(d)) out.earned[id] = d
    }
  }
  if (Array.isArray(raw.announced)) {
    out.announced = ACHIEVEMENT_ORDER.filter(id => (raw.announced as unknown[]).includes(id))
  }
  out.lastToastDay = isDay(raw.lastToastDay) ? raw.lastToastDay : null
  if (isRecord(raw.today)) out.today = { day: isDay(raw.today.day) ? raw.today.day : null, turns: count(raw.today.turns) }
  return out
}

// Every record* helper copies, so the caller's save is never changed under it.
function copy(s: Save): Save {
  return { ...s, days: [...s.days], earned: { ...s.earned }, announced: [...s.announced], today: { ...s.today } }
}

/** Count one finished turn on `day`. A malformed `day` is ignored entirely (the save comes back unchanged). */
export function recordTurn(s: Save, day: string): Save {
  const n = copy(s)
  if (!isDay(day)) return n
  n.turns = count(s.turns) + 1
  n.days = addDay(s.days, day)
  n.today = s.today.day === day ? { day, turns: count(s.today.turns) + 1 } : { day, turns: 1 }
  if (n.turns >= TURNS_GOAL && !n.earned.turns100) n.earned.turns100 = day
  if (!n.earned.streak7 && streakOf(n.days, day) >= STREAK_GOAL) n.earned.streak7 = day
  return n
}

export function recordTest(s: Save, day: string): Save {
  const n = copy(s)
  n.testGreen = true
  if (!n.earned.firstTest && isDay(day)) n.earned.firstTest = day
  return n
}

export function recordCommit(s: Save, day: string): Save {
  const n = copy(s)
  n.committed = true
  if (!n.earned.firstCommit && isDay(day)) n.earned.firstCommit = day
  return n
}

/**
 * Several sessions share one saved file, so a session never writes its own stale save over the others.
 * `stored` is what the store holds now (sanitised), `local` this session's save, `baseTurns` the turns this session
 * last loaded or wrote: only what it added since then is counted on top of the stored turns.
 */
export function mergeSave(stored: Save, local: Save, baseTurns: number): Save {
  const out = emptySave()
  out.turns = count(stored.turns) + Math.max(0, count(local.turns) - count(baseTurns))
  out.days = cleanDays([...stored.days, ...local.days])
  for (const id of ACHIEVEMENT_ORDER) {
    // The earlier valid day wins, so the day an achievement was first earned never moves forward.
    const days = [stored.earned[id], local.earned[id]].filter(isDay).sort()
    if (days[0] !== undefined) out.earned[id] = days[0]
  }
  out.announced = ACHIEVEMENT_ORDER.filter(id => stored.announced.includes(id) || local.announced.includes(id))
  const toasts = [stored.lastToastDay, local.lastToastDay].filter(isDay).sort()
  out.lastToastDay = toasts.length > 0 ? (toasts[toasts.length - 1] as string) : null
  out.testGreen = stored.testGreen || local.testGreen
  out.committed = stored.committed || local.committed
  const sd = isDay(stored.today.day) ? stored.today.day : null
  const ld = isDay(local.today.day) ? local.today.day : null
  if (sd !== null && (ld === null || sd > ld)) out.today = { day: sd, turns: count(stored.today.turns) }
  else if (sd !== null && sd === ld) out.today = { day: ld, turns: Math.max(count(stored.today.turns), count(local.today.turns)) }
  else out.today = { day: ld, turns: count(local.today.turns) }
  return out
}

/** The next achievement to cheer: at most one toast a day, so a burst of milestones is spread out. */
export function pickToast(s: Save, day: string): AchievementId | null {
  if (s.lastToastDay === day) return null
  return ACHIEVEMENT_ORDER.find(id => s.earned[id] && !s.announced.includes(id)) ?? null
}

export function markAnnounced(s: Save, id: AchievementId, day: string): Save {
  const n = copy(s)
  if (!n.announced.includes(id)) n.announced.push(id)
  if (isDay(day)) n.lastToastDay = day
  return n
}

// ---------------------------------------------------------------- command recognition

// The command text comes from the model, so everything here is linear and capped:
// no backtracking regex over the whole line, a bounded number of segments and words.
const MAX_CMD = 10000
const MAX_SEGMENTS = 40
const MAX_WORDS = 64
// How deep `bash -c "bash -c '...'"` is followed.
const MAX_DEPTH = 2

/** One command of a line: its words, the operator before it and the operator after it ('' at the line's ends). */
type Seg = { words: string[]; before: string; after: string }

/**
 * Split a shell line into segments (on && || ; | & newline, parens, backticks) of words, honouring quotes.
 * Heredoc bodies are skipped, because they are text for a program and not commands. `complete` is false when the
 * line was cut by a cap, so nobody takes the last segment seen for the last one there is.
 */
function segments(cmd: string): { segs: Seg[]; complete: boolean } {
  const text = cmd.length > MAX_CMD ? cmd.slice(0, MAX_CMD) : cmd
  let complete = cmd.length <= MAX_CMD
  const segs: Seg[] = []
  let words: string[] = []
  let cur = ''
  let has = false
  let quote: '' | '"' | "'" = ''
  // The operator that came last; it becomes the `before` of the next segment.
  let lastOp = ''
  // Heredocs opened on this line, whose bodies start after the next newline.
  const pending: Array<{ word: string; dash: boolean }> = []
  const endWord = () => {
    if (has && words.length < MAX_WORDS) words.push(cur)
    cur = ''
    has = false
  }
  const endSeg = (op: string) => {
    endWord()
    if (words.length > 0) {
      if (segs.length < MAX_SEGMENTS) segs.push({ words, before: lastOp, after: op })
      else complete = false
      lastOp = op
    } else if (op === '(' || (op === '\n' && (lastOp === '&&' || lastOp === '||' || lastOp === '|'))) {
      // An opening paren, or a line break after && || |, continues the operator before it.
    } else lastOp = op
    words = []
  }
  // The index after the heredoc body that starts at `from`: the line that is exactly `word` ends it.
  const bodyEnd = (from: number, word: string, dash: boolean): number => {
    let pos = from
    while (pos < text.length) {
      let eol = text.indexOf('\n', pos)
      if (eol < 0) eol = text.length
      let line = text.slice(pos, eol)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (dash) line = line.replace(/^\t+/, '')
      if (line === word) return Math.min(text.length, eol + 1)
      pos = eol + 1
    }
    return text.length
  }
  let i = 0
  for (; i < text.length && segs.length < MAX_SEGMENTS; i++) {
    const c = text.charAt(i)
    const next = text.charAt(i + 1)
    if (quote === "'") {
      if (c === "'") quote = ''
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && (next === '"' || next === '\\')) {
        cur += next
        i++
      } else cur += c
      continue
    }
    // Only an escaped space, quote or operator is an escape; a Windows path like C:\tools\x keeps its backslashes.
    if (c === '\\') {
      if (next === '\n') i++
      else if (next === ' ' || next === '"' || next === "'" || next === '\\' || next === ';' || next === '&' || next === '|') {
        cur += next
        has = true
        i++
      } else {
        cur += c
        has = true
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (c === '#' && !has) {
      while (i + 1 < text.length && text.charAt(i + 1) !== '\n') i++
      continue
    }
    if (c === '<' && next === '<' && text.charAt(i + 2) !== '<' && text.charAt(i - 1) !== '<') {
      // << WORD, <<-WORD, <<'WORD', <<"WORD": remember the word, the body is skipped at the next newline.
      endWord()
      let j = i + 2
      const dash = text.charAt(j) === '-'
      if (dash) j++
      while (text.charAt(j) === ' ' || text.charAt(j) === '\t') j++
      let word = ''
      let q = ''
      for (; j < text.length; j++) {
        const d = text.charAt(j)
        if (q !== '') {
          if (d === q) q = ''
          else word += d
        } else if (d === '"' || d === "'") q = d
        else if (d === '\\' && j + 1 < text.length) word += text.charAt(++j)
        else if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === ';' || d === '|' || d === '&' || d === '(' || d === ')' || d === '<' || d === '>') break
        else word += d
      }
      if (word !== '' && pending.length < 8) pending.push({ word, dash })
      i = j - 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      continue
    }
    if (c === '\n') {
      endSeg('\n')
      for (const h of pending.splice(0)) i = bodyEnd(i + 1, h.word, h.dash) - 1
      continue
    }
    if (c === ';' || c === '(' || c === ')' || c === '`') {
      endSeg(c)
      continue
    }
    if (c === '|') {
      // || is "or"; | and |& feed the next command.
      if (next === '|') {
        endSeg('||')
        i++
      } else {
        endSeg('|')
        if (next === '&') i++
      }
      continue
    }
    if (c === '&') {
      // 2>&1 and &> are redirects, not a separator.
      if (text.charAt(i - 1) === '>' || next === '>' || text.charAt(i - 1) === '<') {
        cur += c
        has = true
      } else if (next === '&') {
        endSeg('&&')
        i++
      } else endSeg('&')
      continue
    }
    cur += c
    has = true
  }
  if (i < text.length) complete = false
  endSeg('')
  return { segs, complete }
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const SUFFIX = /\.(cmd|exe|bat|ps1)$/i
// Words that come before the real command and do not change what runs.
// (`command` is not one: `command -v jest` only looks the program up.)
const WRAPPERS = new Set([
  'time', 'sudo', 'nice', 'nohup', 'exec', 'env', 'xvfb-run', 'npx', 'bunx',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!',
])
// Options of a wrapper whose next word is their value, so the value is not taken for the command.
const WRAPPER_VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot', '--role', '--type', '--other-user', '--command-timeout']),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  'xvfb-run': new Set(['-s', '-n', '-e', '-f', '--server-args', '--server-num', '--error-file', '--auth-file']),
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const PY = /^(python|pypy)\d*(\.\d+)*$|^py$/

/** `./vendor/bin/phpunit` and `C:\tools\pytest.exe` are `phpunit` and `pytest`. Case matters, the suffix does not. */
function base(word: string): string {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  return (cut >= 0 ? word.slice(cut + 1) : word).replace(SUFFIX, '')
}

/** Skips the options that start at `from`, and the values of those in `valueOpts` (written as a separate word). */
function skipOptions(words: readonly string[], from: number, valueOpts?: ReadonlySet<string>): number {
  let i = from
  while ((words[i] ?? '').startsWith('-')) i += valueOpts !== undefined && valueOpts.has(words[i] as string) ? 2 : 1
  return i
}

type Unwrapped = { cmd: string; args: string[]; script?: string }

/** Peel wrappers (env vars, time, sudo, npx, uv run, python -m, bash -c ...) to find the command that really runs. */
function unwrap(words: readonly string[]): Unwrapped | null {
  let i = 0
  for (let guard = 0; guard < 24; guard++) {
    const w = words[i]
    if (w === undefined) return null
    if (ENV_ASSIGN.test(w)) {
      i++
      continue
    }
    const b = base(w)
    const n = words[i + 1]
    if (b === 'timeout') {
      // timeout [options] DURATION command
      i = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS.timeout) + 1
      continue
    }
    if (WRAPPERS.has(b)) {
      i = skipOptions(words, i + 1, WRAPPER_VALUE_OPTS[b])
      continue
    }
    if ((b === 'npm' || b === 'pnpm' || b === 'yarn' || b === 'bun') && (n === 'dlx' || n === 'exec' || n === 'x')) {
      i = skipOptions(words, i + 2)
      continue
    }
    if ((b === 'uv' || b === 'poetry' || b === 'pipenv' || b === 'pdm' || b === 'hatch') && n === 'run') {
      i = skipOptions(words, i + 2)
      continue
    }
    if (b === 'bundle' && n === 'exec') {
      i = skipOptions(words, i + 2)
      continue
    }
    if (SHELLS.has(b)) {
      // bash -c "script": the quoted script is a command line of its own. A short-option cluster with a c (-c, -lc, -ec) names it.
      for (let j = i + 1; j < words.length && (words[j] as string).startsWith('-'); j++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j] as string)) {
          const script = words[j + 1]
          return script === undefined ? { cmd: b, args: [] } : { cmd: b, args: [], script }
        }
      }
      return { cmd: b, args: words.slice(i + 1) }
    }
    if (PY.test(b)) {
      let j = i + 1
      while ((words[j] ?? '').startsWith('-') && words[j] !== '-m') j++
      const mod = words[j + 1]
      if (words[j] === '-m' && mod !== undefined) return { cmd: base(mod), args: words.slice(j + 2) }
      // python manage.py test (Django)
      if (words[j] !== undefined && base(words[j] as string) === 'manage.py') return { cmd: 'manage.py', args: words.slice(j + 1) }
      return { cmd: b, args: words.slice(i + 1) }
    }
    return { cmd: b, args: words.slice(i + 1) }
  }
  return null
}

// Options that mean the runner starts but runs no tests.
const NO_RUN = new Set([
  '--help', '-h', '--version', '--list', '--collect-only', '--co', '--dry-run', '-dry-run', '--listTests', '--list-tests', '--no-run',
  '--fixtures', '--markers', '--listenvs', '--listenvs-all', '--show-config', '--trace-config', '--setup-plan',
])
// Short options that list or only print, but mean something else for other programs (pytest -n 4 is the xdist worker
// count, nice -n a priority), so each only counts for the command that owns it.
const NO_RUN_FOR: Record<string, ReadonlySet<string>> = {
  go: new Set(['-list']),
  ctest: new Set(['-N']),
  make: new Set(['-n', '--just-print', '--recon']),
  gmake: new Set(['-n', '--just-print', '--recon']),
}
// tox and nox environments (sessions) that check code instead of running tests.
const NOT_TEST_ENV = /^(lint|docs?|types?|typing|typecheck|mypy|flake8|format|fmt|style|pylint|ruff)$/i
const ENV_OPTS = new Set(['-e', '--env', '-s', '--session'])

/** True when tox or nox is told to run only checkers: any selected environment (`-e py311,lint`, `-s lint`) that is one makes it so. */
function selectsNonTestEnv(args: readonly string[]): boolean {
  const names: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') break
    const eq = a.indexOf('=')
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    if (!ENV_OPTS.has(flag)) continue
    if (flag !== a) names.push(a.slice(eq + 1))
    // nox takes several sessions after one -s, so every word up to the next option is a name.
    else while (i + 1 < args.length && !(args[i + 1] as string).startsWith('-')) names.push(args[++i] as string)
  }
  // py311-lint and lint-py are factors of one name: any factor that is a checker makes it one.
  return names.some(n => n.split(',').some(env => env.split(/[-_:]/).some(f => NOT_TEST_ENV.test(f))))
}
// -l lists environments for tox and nox, but is --showlocals for pytest, so it only counts there.
const LIST_RUNNERS = new Set(['tox', 'nox'])
// Options whose next word is a value, so it must not be read as a subcommand.
const VALUE_OPTS = new Set(['--filter', '-F', '--prefix', '-C', '--cwd', '--workspace'])
// node options that take a separate value (so `node --import x --test` finds --test).
const NODE_VALUE_OPTS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type'])
const JS_RUNNERS = new Set(['jest', 'vitest', 'mocha', 'ava'])
const ALWAYS_TESTS = new Set([
  'jest', 'vitest', 'mocha', 'ava', 'pytest', 'py.test', 'unittest', 'tox', 'nox', 'rspec', 'phpunit', 'ctest',
])

/** The words that are not options, skipping option values and cargo's +toolchain. */
function positional(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (VALUE_OPTS.has(a)) i++
    else if (!a.startsWith('-') && !a.startsWith('+')) out.push(a)
  }
  return out
}

const isTestScript = (s: string | undefined): boolean => s === 'test' || (s !== undefined && s.startsWith('test:'))

function runsTests(cmd: string, args: readonly string[]): boolean {
  if (args.some(a => NO_RUN.has(a))) return false
  const own = NO_RUN_FOR[cmd]
  if (own !== undefined && args.some(a => own.has(a))) return false
  if ((cmd === 'tox' || cmd === 'nox') && selectsNonTestEnv(args)) return false
  if (LIST_RUNNERS.has(cmd) && args.includes('-l')) return false
  if (ALWAYS_TESTS.has(cmd)) return true
  const pos = positional(args)
  const first = pos[0]
  switch (cmd) {
    case 'npm':
    case 'yarn':
    case 'pnpm':
    case 'bun': {
      if (first === 'run' || first === 'run-script') return isTestScript(pos[1])
      if (cmd === 'npm' && (first === 't' || first === 'tst')) return true
      if (cmd === 'yarn' && first === 'workspace') return pos[2] === 'run' ? isTestScript(pos[3]) : isTestScript(pos[2])
      if ((cmd === 'yarn' || cmd === 'pnpm') && first !== undefined && JS_RUNNERS.has(first)) return true
      return isTestScript(first)
    }
    case 'playwright': return first === 'test'
    case 'cypress': return first === 'run'
    case 'go':
    case 'dotnet':
    case 'deno':
    case 'swift':
    case 'flutter':
    case 'dart':
    case 'mix':
    case 'lein':
    case 'manage.py':
      return first === 'test'
    case 'cargo': return first === 'test' || (first === 'nextest' && pos[1] === 'run')
    case 'mvn':
    case 'mvnw': return pos.some(a => a === 'test' || a === 'verify')
    case 'gradle':
    case 'gradlew': return pos.some(a => /(^|:)(test|check)$/.test(a))
    case 'rake': return first === 'test' || first === 'spec'
    case 'composer': return first === 'test' || (first === 'run' && pos[1] === 'test') || (first === 'run-script' && pos[1] === 'test')
    case 'make':
    case 'gmake': return pos.some(a => a === 'test' || a === 'check')
    case 'sbt': return pos.some(a => a === 'test' || a === 'testOnly')
    case 'node': {
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string
        if (a === '--test') return true
        if (NODE_VALUE_OPTS.has(a)) i++
        else if (!a.startsWith('-')) return false
      }
      return false
    }
    case 'claude': return first === 'plugin' && pos[1] === 'test'
    case 'ruby': return args.some(a => /^-I.*test/.test(a))
    default: return false
  }
}

const JS_PACKAGE_RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'bun'])

/** A test run that never ends by itself (watch mode) cannot decide anything. */
function watches(cmd: string, args: readonly string[]): boolean {
  for (const a of args) {
    const m = /^--(watch|watchAll|watch-all)(?:=(.*))?$/.exec(a)
    // A bare flag watches; --watch=false (0, no, off) says it does not.
    if (m !== null && !(m[2] !== undefined && /^(false|0|no|off)$/i.test(m[2]))) return true
  }
  // -w is watch for vitest and mocha, but a workspace for npm and the worker count for jest.
  if ((cmd === 'vitest' || cmd === 'mocha') && args.includes('-w')) return true
  // A script named test:watch (test-watch, watch:test) is a watcher by its name.
  if (JS_PACKAGE_RUNNERS.has(cmd)) return positional(args).some(a => /watch/i.test(a))
  return false
}

/** True when the command line runs a test suite with a common runner (not merely mentions one). */
export function isTestCommand(cmd: string, depth = 0): boolean {
  if (typeof cmd !== 'string') return false
  return segments(cmd).segs.some(seg => {
    const u = unwrap(seg.words)
    if (u === null) return false
    if (u.script !== undefined) return depth < MAX_DEPTH && isTestCommand(u.script, depth + 1)
    return runsTests(u.cmd, u.args)
  })
}

// The operators after which a command's exit status becomes the line's: the first command, or after && ; or a newline.
const DECIDING_BEFORE = new Set(['', '&&', ';', '\n'])

// Whether the last command of the line, one that decides the line's exit status, is one `is` accepts.
function lastDecides(cmd: string, depth: number, is: (u: Unwrapped) => boolean): boolean {
  const { segs, complete } = segments(cmd)
  const last = segs[segs.length - 1]
  if (!complete || last === undefined) return false
  // Not after || (it may never run), and not piped or backgrounded (something else decides, or nobody waits).
  if (!DECIDING_BEFORE.has(last.before) || last.after === '|' || last.after === '&') return false
  const u = unwrap(last.words)
  if (u === null) return false
  if (u.script !== undefined) return depth < MAX_DEPTH && lastDecides(u.script, depth + 1, is)
  return is(u)
}

/**
 * True when the command line runs tests AND the exit status of the whole line is the test's: the test is the last
 * command, joined by && ; or a newline (not ||), and nothing pipes it on. `npm test || true` or `npm test; echo done`
 * can succeed with failing tests, and a watcher never ends, so they do not count as a green run.
 */
export function isGreenTestCommand(cmd: string): boolean {
  if (typeof cmd !== 'string') return false
  return lastDecides(cmd, 0, u => runsTests(u.cmd, u.args) && !watches(u.cmd, u.args))
}

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix'])

/** True when an unwrapped command is `git commit` (global options like -C path or -c k=v may sit between). */
function commits(u: Unwrapped): boolean {
  if (u.cmd !== 'git') return false
  let i = 0
  while (i < u.args.length && (u.args[i] as string).startsWith('-')) i += GIT_VALUE_OPTS.has(u.args[i] as string) ? 2 : 1
  if (u.args[i] !== 'commit') return false
  return !u.args.slice(i + 1).some(a => a === '--dry-run' || a === '--help' || a === '-h')
}

/** True when a segment is `git commit`. */
export function isCommitCommand(cmd: string): boolean {
  if (typeof cmd !== 'string') return false
  return segments(cmd).segs.some(seg => {
    const u = unwrap(seg.words)
    return u !== null && commits(u)
  })
}

/**
 * True when the commit is the command that decides the line's exit status (same rule as isGreenTestCommand), so
 * `git commit -m x || echo nothing` or `git commit -m x | cat` cannot count a commit that may have failed.
 */
export function isGreenCommitCommand(cmd: string): boolean {
  if (typeof cmd !== 'string') return false
  return lastDecides(cmd, 0, commits)
}

/** The Bash command of a tool call's input, or '' when it is not a string. */
export function testCommandFromTool(input: unknown): string {
  if (!isRecord(input)) return ''
  return typeof input.command === 'string' ? input.command : ''
}

// ---------------------------------------------------------------- quota and formatting

type Window = 'five_hour' | 'seven_day'

export function quotaOf(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Quota & { kind: Window | null } {
  let best: { kind: Window; pct: number; resetsAt?: string } | null = null
  if (Array.isArray(limits)) {
    for (const l of limits) {
      if (!l || (l.kind !== 'five_hour' && l.kind !== 'seven_day')) continue
      if (typeof l.percentUsed !== 'number' || !Number.isFinite(l.percentUsed)) continue
      if (best === null || l.percentUsed > best.pct) best = { kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt }
    }
  }
  if (best === null) return { pct: null, resetsAt: null, kind: null }
  const at = typeof best.resetsAt === 'string' ? Date.parse(best.resetsAt) : NaN
  return { pct: Math.min(100, Math.max(0, Math.round(best.pct))), resetsAt: Number.isFinite(at) ? at : null, kind: best.kind }
}

const secs = (ms: number): number => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0)

/** m:ss under an hour, h:mm:ss from an hour. */
export function clock(ms: number): string {
  const s = secs(ms)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** 45s, 2m 41s, 1h 05m. */
export function durationText(ms: number): string {
  const s = secs(ms)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}

/** Time until a limit resets: 1h49m, 49m, 3d 4h; '' when unknown or already past. */
export function countdown(resetsAt: number | null, now: number): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || !Number.isFinite(now)) return ''
  const left = resetsAt - now
  if (left <= 0) return ''
  const mins = Math.floor(left / 60000)
  if (mins < 1) return '<1m'
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${pad(mins % 60)}m`
  return `${mins}m`
}

export function bar(filled: number, cells: number = BAR_CELLS): { on: string; off: string } {
  const c = typeof cells === 'number' && Number.isFinite(cells) ? Math.min(64, Math.max(0, Math.floor(cells))) : BAR_CELLS
  const f = typeof filled === 'number' && Number.isFinite(filled) ? Math.min(c, Math.max(0, Math.floor(filled))) : 0
  return { on: '▰'.repeat(f), off: '▱'.repeat(c - f) }
}

/** Make outside text safe for one row: no control characters, one space between words, cut at `room` code points. */
export function fitText(text: string, room: number): string {
  if (typeof text !== 'string' || typeof room !== 'number' || !(room >= 1)) return ''
  const clean = text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    // Controls (ESC, BEL, C1) and invisible direction marks that can reorder or hide text.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cps = Array.from(clean)
  const max = Math.floor(room)
  if (cps.length <= max) return clean
  return max === 1 ? '…' : cps.slice(0, max - 1).join('') + '…'
}
