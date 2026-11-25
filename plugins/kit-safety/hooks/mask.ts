// Secret masker for tool results. Pure: no engine calls, no state kept between calls, and nothing here ever stores, logs
// or returns a secret itself, only the masked text, a count and kind ids.
//
// How it works: every rule scans the text and reports hits (a span of the text and what to put there instead). The hits
// are sorted, overlaps are merged and the spans are replaced in one pass, so everything outside them stays byte for byte
// and the kinds come out in the order they appear in the text. A rule is skipped without a regex pass when the text lacks
// the literal it needs (`heads`).
//
// Regex safety (a 5 MB tool result must not stall the session): no nested quantifiers on overlapping classes, no
// assertion after an open-ended quantifier (that would backtrack through the whole run), and a token only starts at a
// boundary (the start of the text or a character outside its alphabet), so a long run of word characters is scanned once
// and not once per position. No lookbehind either: an engine that does not know it would refuse the whole module.
// The rules that read a `name = value` pair or a URL are scanned by hand (a few characters left and right of a literal
// hit, every character read once), because a regex that is allowed to run to the end of a 5 MB line from every
// candidate start would be quadratic.

export type MaskResult = { text: string; count: number; kinds: string[] }

/** What a masked secret becomes after its recognisable prefix: `sk-ant-•••• masked`. */
const MARK = '•••• masked'

type Hit = { start: number; end: number; text: string; kind: string; rank: number }
/** Reports one span; answers true when the caller has seen enough (hasSecretShape needs one hit only). */
type Emit = (start: number, end: number, replacement: string) => boolean
type Rule = {
  kind: string
  /** At least one of these literals must be in the text (in its lower-cased form when `ci`) for the rule to match. */
  heads: readonly string[]
  ci?: boolean
  run: (text: string, emit: Emit) => void
}

// A token must stand on its own: the character before it is not a word character. The boundary is matched as a group
// (not a lookbehind) and its length is taken off the match start.
const WORD_EDGE = '(^|[^A-Za-z0-9_])'
// The same for base64url-shaped tokens, whose own alphabet holds `-` and `_`: the start is a run start only.
const RUN_EDGE = '(^|[^A-Za-z0-9_-])'

function tokenRule(kind: string, heads: readonly string[], pattern: string, prefix: (token: string) => string, edge = WORD_EDGE): Rule {
  const re = new RegExp(`${edge}(${pattern})`, 'g')
  return {
    kind,
    heads,
    run(text, emit) {
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const token = m[2] ?? ''
        const start = m.index + (m[1]?.length ?? 0)
        if (emit(start, start + token.length, prefix(token) + MARK)) return
      }
    },
  }
}

// Only shapes that cannot be a credential stand in for one: environment references, `<...>` slots, stars, what an
// earlier masking left behind and the empty words of a config file. Weak words such as `password`, `secret` or
// `changeme` are NOT here: they are very common real development passwords, and masking a documentation placeholder
// only hides a word, while leaking a real default password is the failure this module exists to prevent.
const EMPTY_WORDS = new Set(['redacted', 'masked', 'null', 'none', 'nil', 'undefined', 'true', 'false'])

function isPlaceholder(value: string): boolean {
  if (value === '' || value.includes('•')) return true
  if (value.length > 256) return false
  const first = value.charCodeAt(0)
  const last = value.charCodeAt(value.length - 1)
  // <password>, [YOUR-PASSWORD], {{x}}, {x}
  if ((first === 60 && last === 62) || (first === 91 && last === 93) || (first === 123 && last === 125)) return true
  // ${VAR}, $(cmd), $VAR, $1
  if (first === 36 && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|\([^)]*\)|\d)$/.test(value)) return true
  // %PASSWORD% (Windows), %s, :token (route parameter)
  if (first === 37 && (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value) || /^%[sdv]$/.test(value))) return true
  if (first === 58 && /^:[A-Za-z_]\w*$/.test(value)) return true
  if (/^[*.#_-]+$/.test(value) || /^[xX]{1,8}$/.test(value)) return true
  return EMPTY_WORDS.has(value.toLowerCase())
}

// --- Private keys -----------------------------------------------------------------------------------------------------
// Scanned by hand: a lazy `[\s\S]*?` regex from every BEGIN would be quadratic on a text full of BEGIN lines.

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]{1,12} ){0,2}PRIVATE KEY(?: BLOCK)?-----/y
const PEM_END = /-----END ((?:[A-Z0-9]{1,12} ){0,2}PRIVATE KEY(?: BLOCK)?)-----/y
const PEM_HEADER = /[A-Za-z][A-Za-z0-9-]{0,30}: [^\r\n\\]{0,200}/y
const BASE64_LINE = /[A-Za-z0-9+/]{8}/y // key material on the line after BEGIN
const BASE64_INLINE = /[A-Za-z0-9+/]{24}/y // on the same line: long enough that it cannot be an ordinary word
const BEGIN_LITERAL = '-----BEGIN '
const END_LITERAL = '-----END '

/** The line break right after `from` (after spaces): a real one, or the `\n` two-character escape a JSON string holds. */
function lineBreakAfter(text: string, from: number): string | null {
  let p = from
  while (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9) p++
  if (text.startsWith('\r\n', p)) return '\r\n'
  if (text.startsWith('\\r\\n', p)) return '\\r\\n'
  if (text.startsWith('\\n', p)) return '\\n'
  const c = text.charCodeAt(p)
  if (c === 10) return '\n'
  if (c === 13) return '\r'
  return null
}

function skipBlank(text: string, from: number): number {
  let p = from
  for (;;) {
    const c = text.charCodeAt(p)
    if (c === 32 || c === 9 || c === 10 || c === 13) p++
    else if (c === 92 && (text.charCodeAt(p + 1) === 110 || text.charCodeAt(p + 1) === 114)) p += 2
    else return p
  }
}

/** After a BEGIN line with no END: does key material follow (optional `Name: value` headers, then base64)? */
function looksLikeKeyBody(text: string, from: number, sameLine: boolean): boolean {
  let p = skipBlank(text, from)
  for (let n = 0; n < 8; n++) {
    PEM_HEADER.lastIndex = p
    const header = PEM_HEADER.exec(text)
    if (!header) break
    p = skipBlank(text, p + header[0].length)
  }
  const base64 = sameLine ? BASE64_INLINE : BASE64_LINE
  base64.lastIndex = p
  return base64.test(text)
}

type EndQueue = { at: number[]; next: number }

/**
 * Every END line of a private key in the text, as the start positions per label, found in one pass. A BEGIN line then asks
 * for the first END of its own label after it: the BEGIN lines come in increasing order, so each label's queue is only
 * ever walked forward and the whole scan stays linear, however many BEGIN lines with different labels the text holds
 * (a search from each BEGIN line to the end of the text would be quadratic).
 */
function findEndLines(text: string): Map<string, EndQueue> {
  const queues = new Map<string, EndQueue>()
  for (let at = text.indexOf(END_LITERAL); at >= 0; at = text.indexOf(END_LITERAL, at + 1)) {
    PEM_END.lastIndex = at
    const end = PEM_END.exec(text)
    if (!end) continue
    const label = end[1] ?? ''
    const queue = queues.get(label)
    if (queue) queue.at.push(at)
    else queues.set(label, { at: [at], next: 0 })
  }
  return queues
}

/** The first START of an END line in `queue` at or after `from`, or -1. */
function endAfter(queue: EndQueue | undefined, from: number): number {
  if (!queue) return -1
  while (queue.next < queue.at.length && (queue.at[queue.next] as number) < from) queue.next++
  return queue.at[queue.next] ?? -1
}

function runPrivateKey(text: string, emit: Emit): void {
  let ends: Map<string, EndQueue> | null = null // found when the first BEGIN line is met
  let from = 0
  for (;;) {
    const at = text.indexOf(BEGIN_LITERAL, from)
    if (at < 0) return
    PEM_BEGIN.lastIndex = at
    const begin = PEM_BEGIN.exec(text)
    if (!begin) {
      from = at + BEGIN_LITERAL.length
      continue
    }
    const label = begin[0].slice(BEGIN_LITERAL.length, begin[0].length - 5)
    const afterBegin = at + begin[0].length
    const brk = lineBreakAfter(text, afterBegin)
    const endLine = `-----END ${label}-----`
    ends ??= findEndLines(text)
    const endAt = endAfter(ends.get(label), afterBegin)
    if (endAt >= 0) {
      from = endAt + endLine.length
      const body = text.slice(afterBegin, endAt)
      // A short body that is not base64 (`...`, `<key>`, an earlier masking, code between two markers) hides nothing.
      if (body.length <= 96 && !/^[A-Za-z0-9+/=]+$/.test(body.replace(/\\[nr]|\s+/g, ''))) continue
      // Keep the END line's own indentation (a key inside a YAML block), put the marker on a line of its own.
      let k = endAt
      if (brk) while (k > afterBegin && (text.charCodeAt(k - 1) === 32 || text.charCodeAt(k - 1) === 9)) k--
      const sep = brk ?? ' '
      if (emit(afterBegin, k, sep + text.slice(k, endAt) + MARK + sep)) return
      continue
    }
    from = afterBegin
    // Cut-off output: no END line. Mask to the end when key material follows, keep trailing blank space as it was.
    if (!looksLikeKeyBody(text, afterBegin, brk === null)) continue
    let end = text.length
    while (end > afterBegin && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9 || text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end--
    emit(afterBegin, end, (brk ?? '\n') + MARK)
    return
  }
}

// --- URL passwords ----------------------------------------------------------------------------------------------------

/** What `\s` matches in a regex, for the scans below that read character codes. */
function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
}

/** Ends a user name or a password in a URL: a space, `?`, `#`, a quote, `<`, `>` or `\`. */
function isUrlStop(c: number): boolean {
  return isSpace(c) || c === 63 || c === 35 || c === 34 || c === 39 || c === 96 || c === 60 || c === 62 || c === 92
}

/** `https://host:8080/@scope/pkg` is a host, a port and a path, not a user and a password. */
function slashPasswordIsPort(user: string, password: string): boolean {
  return user.startsWith('[') || /^\d{1,5}\//.test(password) || (user.includes('.') && /^\d/.test(password))
}

/**
 * `scheme://user:password@host`: the password runs to the last `@` before the first `/` (what a URL allows). When there is no
 * `@` there, the password may still hold slashes (`postgres://u:pa/ss@host/db`): it then runs to the first `@` after them (the
 * first, so that text after the URL, which another rule may mask, cannot change where it ends), unless the text before it is
 * a host with a port and a path (`host:8080/@scope/pkg`). Each scan stops at a space, a quote, `?`, `#` or the next `://`, so
 * the text is read once however many URLs it holds.
 */
function runUrlPassword(text: string, emit: Emit): void {
  const n = text.length
  let from = 0
  for (;;) {
    const at = text.indexOf('://', from)
    if (at < 0) return
    from = at + 1
    const userStart = at + 3
    let i = userStart
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 58 || c === 47 || c === 64 || isUrlStop(c)) break
      i++
    }
    if (text.charCodeAt(i) !== 58) continue
    const user = text.slice(userStart, i)
    const pwStart = i + 1
    let lastAt = -1
    for (i = pwStart; i < n; i++) {
      const c = text.charCodeAt(i)
      if (c === 47 || isUrlStop(c)) break
      if (c === 64) lastAt = i
    }
    let slash = false
    if (lastAt < 0 && text.charCodeAt(i) === 47) {
      slash = true
      for (; i < n; i++) {
        const c = text.charCodeAt(i)
        if (isUrlStop(c)) break
        if (c === 47 && text.charCodeAt(i + 1) === 47 && text.charCodeAt(i - 1) === 58) break
        if (c === 64) {
          lastAt = i
          break
        }
      }
    }
    if (lastAt < 0) continue
    const password = text.slice(pwStart, lastAt)
    if (isPlaceholder(password) || (slash && slashPasswordIsPort(user, password))) continue
    if (emit(pwStart, lastAt, MARK)) return
    from = lastAt + 1
  }
}

// --- Connection strings -----------------------------------------------------------------------------------------------

const CONN_NAME = /(^|[;\s"'`])(password|pwd|accountkey|sharedaccesskey|sharedaccesssignature)[ \t]*=/gi
const NEXT_PAIR = /;[ \t]*[A-Za-z][A-Za-z0-9 _.-]{0,40}=/y
const MAX_QUOTED = 8192

/**
 * `Key=Value;Key=Value`: the value of Password, Pwd, AccountKey, SharedAccessKey and SharedAccessSignature runs to the next `;`
 * (a quote, a line break or the end of the text also end it), so it may hold spaces. It must stand in such a string: after a
 * `;`, or before a `;` that is followed by another `Key=`. `Password=hunter2 to host` in a sentence and `Password = pw;` in code
 * are left to the plain `name=value` rule, which takes one word and reads code. The three key names are specific enough to be
 * taken anywhere, but outside such a string only the first word.
 * A value is only skipped over (and a later name inside it never looked at) once it is masked; where the next end of a value
 * is, and where the blanks before it begin, is found once for every name that shares it.
 */
function runConnectionString(text: string, emit: Emit): void {
  const n = text.length
  let stopFrom = 1
  let stopAt = 0
  let blankFrom = 0
  const stop = (from: number): number => {
    if (from >= stopFrom && from <= stopAt) return stopAt
    let i = from
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 59 || c === 34 || c === 39 || c === 96 || c === 10 || c === 13) break
      if (c === 92) {
        const e = text.charCodeAt(i + 1)
        if (e === 110 || e === 114 || e === 116 || e === 34 || e === 39 || e === 92) break
      }
      i++
    }
    stopFrom = from
    stopAt = i
    blankFrom = i
    while (blankFrom > from && (text.charCodeAt(blankFrom - 1) === 32 || text.charCodeAt(blankFrom - 1) === 9)) blankFrom--
    return i
  }
  CONN_NAME.lastIndex = 0
  for (let m = CONN_NAME.exec(text); m; m = CONN_NAME.exec(text)) {
    let start = m.index + m[0].length
    for (let k = 0; k < MAX_BLANKS && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9); k++) start++
    let before = m.index + (m[1]?.length ?? 0) - 1
    while (before >= 0 && (text.charCodeAt(before) === 32 || text.charCodeAt(before) === 9)) before--
    const afterSemicolon = before >= 0 && text.charCodeAt(before) === 59
    let valueStart = start
    let end = start
    let after = start // where the value stopped
    let quoted = false
    if (text.charCodeAt(start) === 39) {
      // 'a;b': a value in single quotes runs to the closing quote
      const close = text.indexOf("'", start + 1)
      if (close > 0 && close - start <= MAX_QUOTED && !/[\r\n]/.test(text.slice(start, close))) {
        quoted = true
        valueStart = start + 1
        end = close
        after = close + 1
      }
    }
    if (!quoted) {
      after = stop(start)
      end = Math.max(start, blankFrom)
    }
    if (end <= valueStart) continue
    let sure = afterSemicolon
    if (!sure && text.charCodeAt(after) === 59) {
      NEXT_PAIR.lastIndex = after
      sure = NEXT_PAIR.test(text)
    }
    if (!sure) {
      if (/^p/i.test(m[2] ?? '')) continue
      // a specific name outside a connection string: the first word only (a word of 257 characters or more is taken whole)
      for (let i = valueStart, last = Math.min(end, valueStart + LONG_VALUE + 1); i < last; i++) {
        if (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9) {
          end = i
          break
        }
      }
    }
    if (end <= valueStart || !isCredential(text.slice(valueStart, Math.min(end, valueStart + LONG_VALUE + 1)), quoted, true, false)) continue
    CONN_NAME.lastIndex = Math.max(CONN_NAME.lastIndex, quoted ? after : end)
    if (emit(valueStart, end, MARK)) return
  }
}

// --- Named settings ---------------------------------------------------------------------------------------------------
//
// Grammar of `NAME = VALUE` (a `.env` line, shell `NAME="value"`, JSON `"name": "value"`, YAML `name: value`, a header, a flag):
//
// NAME   a run of letters, digits, `_`, `-` and `.` (up to 64, may start with `--`), split into words at `_`, `-`, `.`, between
//        digits and letters and at camelCase (`apiKey`, `X-Auth-Token`, `APIKey` -> api key). It holds a credential when a word
//        is secret, token, password, passwd, pwd, passphrase, passcode or apikey, or the pair api/access/private + key (strong),
//        or auth, credential(s) (weak), and every word AFTER it is one that stays a credential (key, secret, token, value, hash,
//        salt, string, base, a number...): `AUTH_TOKEN`, `secret_key_base`, `db_password`, `API_KEY_2` hold one, while
//        `token_url`, `password_min_length`, `secret_santa`, `token_ttl`, `auth_type`, `credentials_file` and `max_tokens` do not
//        (a word after it that says where, how long, how many or which one makes the value something else). The word before it
//        must not be max, min, num, total, count, limit, page, next, prev, cursor...: `next_page_token` is a bookmark.
//        `tokens`, `author`, `authority`, `passwordless`, `monkey`, a bare `key` are other words and never match. A count or size
//        word after the trigger word is covered by the rule above: those names are never credentials, with any value.
// SEP    `=`, `:`, `=>` (hash rocket), `:=`; after the NAME's own closing quote, blanks allowed. Not `==`, `===`, `::`.
//        A `--flag` may take its value after blanks instead (`--password hunter2`).
// VALUE  a "double", 'single' or `back-tick` quoted string (also the JSON-escaped \"...\"), or a bare run up to a blank, `,`, `;`,
//        a quote or a closing bracket (and, in a URL query, `&` and `#`; anywhere, `&name=`). The quotes stay, the inside goes.
//        An unclosed quote reads the first word after it. A bare run loses a trailing `.` or `:` (the end of a sentence).
// A value is NOT a credential when it is: empty; a structural placeholder (see isPlaceholder); a PEM key (the private-key rule
//        takes that); a URL, a path or a file name; a template (`${X}`, `{{x}}`, `%(x)s`); a status word (required, expired...);
//        for weak names a yes/no/number or a config word (include, ldap...). A BARE value that is code is not one either: a call
//        or subscript (`input(`, `os.environ[`), a dotted chain (`process.env.API_KEY`, `this.token`), `$VAR`, a type (`string`,
//        `Option<String>`, `&str`), a YAML tag, anchor or block marker, a keyword (`await`, `new`). Bare words, quoted strings,
//        numbers and `true`/`false` after a strong name (`PASSWORD=12345678`) are credentials: the reader cannot tell a weak real
//        password from a word, and hiding a word costs nothing. In a URL query (`?token=false`) true and false stay, as they
//        always did. Left alone too: `self.password = password` (a variable handed on under its own name, blanks around `=`),
//        `PASSWORD= took=42ms` (the next setting), `${PASSWORD:-x}` (a shell expansion), `//user:pw@` (the URL rule's) and
//        `"Password=" + pw` (the quote closes the string the name opened).
// Known limits: a bare value stops at the first blank (a password with spaces is masked up to it, quote it), a dotted chain of
//        plain words (`my.pass.word`) reads as code, and a quote inside a masked quoted value can change how the text around it
//        is read on a second pass.

type Cls = 'strong' | 'weak' | 'xapikey'

const STRONG_WORDS = new Set(['secret', 'token', 'password', 'passwd', 'pwd', 'passphrase', 'passcode', 'apikey', 'accesskey', 'privatekey'])
const WEAK_WORDS = new Set(['auth', 'credential', 'credentials'])
const KEY_OWNERS = new Set(['api', 'access', 'private'])
const TAIL_WORDS = new Set([
  'key', 'secret', 'token', 'value', 'hash', 'hashed', 'salt', 'string', 'text', 'data', 'base', 'confirm', 'confirmation', 'repeat', 'again', 'phrase', 'code', 'pass', 'pwd',
  'digest', 'plain', 'plaintext', 'cleartext', 'encoded', 'encrypted', 'raw', 'pem', 'b64', 'base64', 'hex', 'bcrypt', 'jwt', 'bearer',
])
const BEFORE_WORDS = new Set(['max', 'min', 'num', 'number', 'total', 'count', 'limit', 'avg', 'page', 'next', 'prev', 'previous', 'continuation', 'cursor'])

/** The words of a name: `apiKey`, `API_KEY`, `x-api-key` and `APIKey` all give api, key. */
function splitWords(name: string): string[] {
  const words: string[] = []
  let cur = ''
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c === 95 || c === 45 || c === 46) {
      if (cur) words.push(cur.toLowerCase())
      cur = ''
      continue
    }
    const digit = c >= 48 && c <= 57
    const upper = c >= 65 && c <= 90
    if (cur) {
      const last = cur.charCodeAt(cur.length - 1)
      const lastDigit = last >= 48 && last <= 57
      const lastUpper = last >= 65 && last <= 90
      if (digit !== lastDigit || (upper && !lastUpper)) {
        words.push(cur.toLowerCase())
        cur = ''
      } else if (!upper && !digit && lastUpper && cur.length > 1 && cur.charCodeAt(cur.length - 2) >= 65 && cur.charCodeAt(cur.length - 2) <= 90) {
        // `APIKey`: the last capital of a run of capitals starts the next word
        words.push(cur.slice(0, -1).toLowerCase())
        cur = cur.slice(-1)
      }
    }
    cur += name.charAt(i)
  }
  if (cur) words.push(cur.toLowerCase())
  return words
}

function classifyWords(words: readonly string[]): Cls | null {
  if (words.join('') === 'xapikey') return 'xapikey'
  let found: Cls | null = null
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    let first = i
    let strong = STRONG_WORDS.has(word)
    if (!strong && word === 'key' && i > 0 && KEY_OWNERS.has(words[i - 1] ?? '')) {
      strong = true
      first = i - 1
    }
    if (!strong && !WEAK_WORDS.has(word)) continue
    let tail = true
    for (let j = i + 1; j < words.length && tail; j++) {
      const w = words[j] ?? ''
      tail = TAIL_WORDS.has(w) || /^\d+$/.test(w)
    }
    if (!tail || BEFORE_WORDS.has(words[first - 1] ?? '')) continue
    if (strong) return 'strong'
    found = 'weak'
  }
  return found
}

const nameCache = new Map<string, Cls | null>()

/** Names repeat (a log has the same few thousand), so the answer is kept; the cache is dropped when it grows. */
function classify(name: string): Cls | null {
  const known = nameCache.get(name)
  if (known !== undefined) return known
  const cls = classifyWords(splitWords(name))
  if (nameCache.size >= 2000) nameCache.clear()
  nameCache.set(name, cls)
  return cls
}

// Words that are never a credential, whatever the name.
const STATUS_WORDS = new Set([
  'required', 'optional', 'expired', 'invalid', 'missing', 'valid', 'empty', 'unset', 'failed', 'ok', 'error', 'denied', 'ignored', 'hidden', 'unknown', 'enabled', 'disabled', 'skipped',
  'provided', 'present', 'absent', 'n/a', 'bearer', 'basic', 'digest', 'negotiate',
])
// After a weak name (auth, credentials) these are settings of a client, not a credential: `credentials: 'include'`.
const WEAK_ONLY_WORDS = new Set([
  'yes', 'no', 'on', 'off', 'y', 'n', 'include', 'omit', 'same-origin', 'oauth', 'oauth2', 'jwt', 'ntlm', 'kerberos', 'saml', 'sso', 'ldap', 'default', 'auto', 'manual', 'internal', 'external', 'token', 'password',
  'apikey', 'api_key', 'none',
])
// A bare word after the name that is code or a type, not a literal: `token = await getToken()`, `password: string`.
const CODE_WORDS = new Set([
  'await', 'async', 'new', 'function', 'lambda', 'return', 'typeof', 'this', 'self', 'cls', 'super', 'if', 'else', 'and', 'or', 'not', 'in', 'is', 'var', 'let', 'const', 'def', 'class', 'import', 'from',
  'yield', 'void', 'delete', 'throw', 'try', 'catch', 'case', 'switch', 'while', 'for', 'do', 'with', 'as',
  'string', 'str', 'number', 'int', 'integer', 'bool', 'boolean', 'bytes', 'bytearray', 'any', 'object', 'unknown', 'never', 'char', 'float', 'double', 'long', 'short', 'usize', 'u8', 'u16', 'u32', 'u64',
  'i8', 'i16', 'i32', 'i64', 'secretstr', 'securestring', 'buffer', 'uint8array',
])
const SCHEMES = new Set(['bearer', 'basic', 'digest', 'negotiate', 'token'])
const URL_VALUE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const PATH_VALUE = /^(?:~\/|\.{1,2}\/|[A-Za-z]:[\\/]|\\\\|\/(?:home|usr|opt|tmp|var|etc|run|root|mnt|srv|Users|app|data|workspace|proc|dev|lib|bin|sbin|snap|nix|private|Volumes)\/)/
const FILE_VALUE = /\.(?:json|pem|key|crt|cer|p12|pfx|txt|ya?ml|env|cfg|conf|ini|toml|jks|keystore|pub)$/i
const TEMPLATE_VALUE = /\$\{|\{\{|%\(\w+\)|#\{/
const CHAIN = /[A-Za-z_$][\w$]*(?:(?:\?\.|\.|::|->)[A-Za-z_$][\w$]*)*/y

/** A URL, a path or a file name: where something is, not what it is. */
function isAddress(value: string, strong: boolean): boolean {
  if (URL_VALUE.test(value) || PATH_VALUE.test(value)) return true
  if (!strong && value.charCodeAt(0) === 47) return true
  return value.length <= 256 && FILE_VALUE.test(value)
}

/** A bare value that is source code and not a literal (callers pass at most 256 characters). */
function looksLikeCode(value: string): boolean {
  if (/^[{[(<]/.test(value) || /^[|>][+-]?$/.test(value) || /^--[A-Za-z]/.test(value)) return true
  if (/^[&*][A-Za-z_]\w*$/.test(value) || /^!{1,2}[A-Za-z]/.test(value) || value.startsWith('#{') || value.startsWith('%(')) return true
  // $VAR, ${X}, $(cmd), $this->x, $_ENV['x'], $HOME/x; not `$2y$10$…` or `$argon2id$v=19$…`, which are hashes
  if (/^\$(?:[A-Za-z_]\w*(?:[[./>:-]|$)|[{(])/.test(value)) return true
  CHAIN.lastIndex = 0
  const m = CHAIN.exec(value)
  if (!m) return false
  const end = m[0].length
  const next = value.charCodeAt(end)
  if (next === 40 || next === 91) return true // a call or a subscript: input(, os.environ[
  if (next === 33 && value.charCodeAt(end + 1) === 40) return true // a macro: env!(
  if (next === 60 && /[A-Za-z]/.test(value.charAt(end + 1))) return true // a generic type: Option<String>
  // process.env.API_KEY, this.token: a dotted chain of names (a long one with digits is a random token, not code)
  return end === value.length && /[.:>]/.test(m[0]) && !(value.length >= 24 && /\d/.test(value))
}

function isCredential(value: string, quoted: boolean, strong: boolean, urlQuery: boolean): boolean {
  if (value === '' || value.startsWith('-----BEGIN')) return false
  const word = value.length <= 32 ? value.toLowerCase() : ''
  // `PASSWORD=true` is hidden (a flag in that place is rare, a password called `true` is not); in a URL query it stays, as
  // the url-secret rule has always left `?token=false` alone
  if (strong && !urlQuery && (word === 'true' || word === 'false')) return true
  if (isPlaceholder(value)) return false
  if (word !== '' && (STATUS_WORDS.has(word) || (!strong && (WEAK_ONLY_WORDS.has(word) || /^\d+$/.test(word))))) return false
  if (value.length <= 512 && TEMPLATE_VALUE.test(value)) return false
  if (isAddress(value, strong)) return false
  if (quoted) return true
  if (word !== '' && CODE_WORDS.has(word)) return false
  return value.length > 256 || !looksLikeCode(value)
}

/** `apiKey` and `api_key` and `API-KEY` are one word for this purpose. */
function sameWord(a: string, b: string): boolean {
  return a.length <= MAX_NAME && a.replace(/[_-]/g, '').toLowerCase() === b.replace(/[_-]/g, '').toLowerCase()
}

const NAME_HINT = /secret|token|pass|pwd|auth|credential|(?:api|access|private)[_.-]?key/gi
const AMP_PARAM = /&[A-Za-z_][A-Za-z0-9_.-]{0,40}=/y
const MAX_NAME = 64
const MAX_BLANKS = 32

const isNameChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 46
const isQuoteChar = (c: number): boolean => c === 34 || c === 39 || c === 96
const isBlank = (c: number): boolean => c === 32 || c === 9

type Value = { start: number; end: number; scan: number; quoted: boolean; truncated: boolean }

const LONG_VALUE = 256

/**
 * The value that starts at `from`: a quoted string or a bare run (see the grammar above). `scan` is where reading stopped. A bare
 * run is read to 257 characters at most (`truncated`) unless `whole`: whether a value is a credential is decided on its first
 * 257 characters, and only one that is masked is read to its end (once, as nothing inside it is looked at again).
 */
function readValue(text: string, from: number, urlStyle: boolean, whole = false): Value | null {
  const n = text.length
  const c = text.charCodeAt(from)
  let begin = from
  let q = c
  let open = from + 1
  let escaped = false
  if (c === 92 && isQuoteChar(text.charCodeAt(from + 1))) {
    q = text.charCodeAt(from + 1)
    open = from + 2
    escaped = true
  }
  if (isQuoteChar(q)) {
    const limit = Math.min(n, open + MAX_QUOTED)
    for (let i = open; i < limit; i++) {
      const d = text.charCodeAt(i)
      if (d === 10 || d === 13) break
      if (d === 92) {
        if (escaped && text.charCodeAt(i + 1) === q) return { start: open, end: i, scan: i + 2, quoted: true, truncated: false }
        i++
      } else if (d === q && !escaped) {
        return { start: open, end: i, scan: i + 1, quoted: true, truncated: false }
      }
    }
    begin = open // no closing quote on this line: read what follows the quote as a bare value
  }
  let i = begin
  const stopAt = whole ? n : Math.min(n, begin + LONG_VALUE + 1)
  scan: while (i < stopAt) {
    const d = text.charCodeAt(i)
    switch (d) {
      case 32: case 9: case 10: case 13: case 44: case 59: case 34: case 39: case 96: case 41: case 93: case 125:
        break scan
    }
    if (d === 92) {
      const e = text.charCodeAt(i + 1)
      if (e === 110 || e === 114 || e === 116 || e === 34 || e === 39 || e === 92) break
    } else if (d === 38) {
      if (urlStyle) break
      AMP_PARAM.lastIndex = i
      if (AMP_PARAM.test(text)) break
    } else if (urlStyle && (d === 35 || d === 60 || d === 62)) {
      break
    }
    i++
  }
  const truncated = i === stopAt && stopAt < n
  let end = i
  while (end > begin && (text.charCodeAt(end - 1) === 46 || text.charCodeAt(end - 1) === 58)) end--
  return end > begin ? { start: begin, end, scan: i, quoted: false, truncated } : null
}

/**
 * Calls `visit(start, end)` for the value of every setting whose NAME holds a credential (and `want` accepts), see the grammar above.
 * Driven by the words in the NAME_HINT regex: only text around such a word is read. The end of a name's run is found once for all
 * the hits in it, a value is read to 257 characters at most to decide, and a value that is masked is read to its end once and
 * not scanned again, so a 5 MB line of `password=` or `token:` stays linear. A value that is kept is not skipped over: a name
 * inside it is looked at too, so that masking something else inside it (another rule) cannot change what is found.
 */
function scanSettings(text: string, want: (cls: Cls) => boolean, minLength: number, visit: (start: number, end: number) => boolean): void {
  const n = text.length
  NAME_HINT.lastIndex = 0
  let floor = 0
  let runEnd = 0
  for (let m = NAME_HINT.exec(text); m; m = NAME_HINT.exec(text)) {
    const floor0 = floor
    // The whole name around the hit, at most 64 characters. The end of the run the hit sits in is found once for all the hits
    // in it. A name glued to a longer run on its left (a token, then `.password`) starts after the first `_`, `-` or `.` that
    // leaves it 64 characters or fewer: its words are what matter, and the text before it may be masked by another rule (which
    // shortens it) without changing the answer.
    const hitEnd = m.index + m[0].length
    if (m.index >= runEnd) {
      runEnd = hitEnd
      while (runEnd < n && isNameChar(text.charCodeAt(runEnd))) runEnd++
    }
    const b = runEnd
    if (b - m.index > MAX_NAME) {
      NAME_HINT.lastIndex = hitEnd // a name that long does not exist, but one that starts after a separator further on might
      continue
    }
    let a = m.index
    const lowest = Math.max(floor0, b - MAX_NAME)
    while (a > lowest && isNameChar(text.charCodeAt(a - 1))) a--
    if (a > 0 && isNameChar(text.charCodeAt(a - 1))) {
      let s = a + 1
      while (s <= m.index) {
        const c = text.charCodeAt(s - 1)
        if (c === 95 || c === 45 || c === 46) break
        s++
      }
      if (s > m.index) {
        NAME_HINT.lastIndex = hitEnd // glued on the left with no separator: a later hit in the same run may still be a name
        continue
      }
      a = s
    }
    floor = b
    NAME_HINT.lastIndex = b
    if (a >= 2 && text.charCodeAt(a - 1) === 47 && text.charCodeAt(a - 2) === 47) continue // `//user:pw@`: the URL rule's
    if (a >= 2 && text.charCodeAt(a - 1) === 123 && text.charCodeAt(a - 2) === 36) continue // `${PASSWORD:-default}`: a shell expansion
    const name = text.slice(a, b)
    const cls = classify(name)
    if (cls === null || !want(cls)) continue
    // the name's own closing quote (`"name":`, `\"name\":`), blanks, then the separator
    let p = b
    if (text.charCodeAt(p) === 92 && isQuoteChar(text.charCodeAt(p + 1))) p += 2
    else if (isQuoteChar(text.charCodeAt(p))) p++
    const quotedName = p > b
    let blanks = 0
    while (isBlank(text.charCodeAt(p)) && blanks < MAX_BLANKS) {
      p++
      blanks++
    }
    const c = text.charCodeAt(p)
    const d = text.charCodeAt(p + 1)
    let valueFrom: number
    if (c === 61) {
      if (d === 61) continue // `==`, `===`: a comparison
      valueFrom = d === 62 ? p + 2 : p + 1 // `=>`
    } else if (c === 58) {
      if (d === 58) continue // `::`
      valueFrom = d === 61 ? p + 2 : p + 1 // `:=`
    } else if (blanks > 0 && !quotedName && text.charCodeAt(a) === 45 && text.charCodeAt(a + 1) === 45) {
      valueFrom = p // `--password hunter2`
    } else {
      continue
    }
    const spacedBefore = blanks > 0
    const afterSeparator = valueFrom
    blanks = 0
    while (isBlank(text.charCodeAt(valueFrom)) && blanks < MAX_BLANKS) {
      valueFrom++
      blanks++
    }
    // `self.password = password`, `this.apiKey = apiKey`: code that hands a variable on, written with blanks around a plain `=`
    const spacedAssignment = c === 61 && d !== 62 && spacedBefore && blanks > 0
    const first = text.charCodeAt(valueFrom)
    if (!(first >= 0) || first === 10 || first === 13) continue
    // `"Password=" + pw`: the quote that follows is the one that closes the string the name opened, not a value
    if (valueFrom === afterSeparator && !quotedName && a > 0 && isQuoteChar(first) && text.charCodeAt(a - 1) === first) continue
    const urlStyle = a > 0 && (text.charCodeAt(a - 1) === 38 || text.charCodeAt(a - 1) === 63)
    let value = readValue(text, valueFrom, urlStyle)
    if (!value) continue
    if (!value.quoted && SCHEMES.has(text.slice(value.start, value.end).toLowerCase())) {
      // `Bearer <value>`: the scheme is no secret, what follows it is
      let q = value.scan
      let k = 0
      while (isBlank(text.charCodeAt(q)) && k < 8) {
        q++
        k++
      }
      const second = k > 0 ? readValue(text, q, urlStyle) : null
      if (second) value = second
    }
    // A value that is masked is skipped over: a name inside it is part of it. One that is kept stays open to the names inside it,
    // so masking something else in it cannot change what is found.
    const literal = text.slice(value.start, value.end)
    const ok =
      value.end - value.start >= minLength &&
      // `PASSWORD= took=42ms`: what follows a blank after the `=` is the next setting, not a value
      !(c === 61 && blanks > 0 && !value.quoted && /^[A-Za-z_][\w.-]{0,63}=/.test(literal.slice(0, 80))) &&
      !(spacedAssignment && !value.quoted && sameWord(literal, name.slice(name.lastIndexOf('.') + 1))) &&
      isCredential(literal, value.quoted, cls !== 'weak', urlStyle)
    if (!ok) continue
    if (value.truncated) value = readValue(text, value.start, urlStyle, true) ?? value
    floor = NAME_HINT.lastIndex = Math.max(floor, value.scan)
    if (visit(value.start, value.end)) return
  }
}

// --- Rules ------------------------------------------------------------------------------------------------------------

const URL_SECRET_PARAM = /([?&])(?:password|passwd|pwd|secret|token|access_token|api[_-]?key|client_secret|refresh_token|auth_token)=([^\s&#"'`<>\\;)]*)/gi
const AUTH_HEADER = /authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+([A-Za-z0-9._~+/=-]{16,})/gi
const AWS_SECRET = /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|secret[_-]?access[_-]?key)["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9/+=]{40,})/gi
const TRAILING_PUNCTUATION = ',.;:!?]}'

// Rules in priority order: when two rules report the same span the first one wins, so a token is named for what it is
// (an Anthropic key never reports as OpenAI, a token in a clone URL stays `ghp_…`).
const RULES: readonly Rule[] = [
  { kind: 'private-key', heads: [BEGIN_LITERAL], run: runPrivateKey },
  tokenRule('anthropic-key', ['sk-ant-'], 'sk-ant-[A-Za-z0-9_-]{20,}', () => 'sk-ant-'),
  tokenRule('openai-key', ['sk-'], 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{40,}', token => /^sk-(?:proj|svcacct|admin)-/.exec(token)?.[0] ?? 'sk-'),
  tokenRule('github-token', ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'], 'gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}', token => (token.startsWith('github_pat_') ? 'github_pat_' : token.slice(0, 4))),
  tokenRule('aws-access-key', ['AKIA', 'ASIA'], '(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])', token => token.slice(0, 4)),
  tokenRule('stripe-key', ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'whsec_'], '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}', token => (token.startsWith('whsec_') ? 'whsec_' : token.slice(0, 8))),
  tokenRule('jwt', ['eyJ'], 'eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]+', () => 'eyJ', RUN_EDGE),
  tokenRule('google-api-key', ['AIza'], 'AIza[A-Za-z0-9_-]{35,}', () => 'AIza'),
  tokenRule('slack-token', ['xox'], 'xox[abposr]-[A-Za-z0-9-]{10,}', token => token.slice(0, 5)),
  tokenRule('npm-token', ['npm_'], 'npm_[A-Za-z0-9]{36,}', () => 'npm_'),
  tokenRule('gitlab-token', ['glpat-'], 'glpat-[A-Za-z0-9_-]{20,}', () => 'glpat-'),
  tokenRule('huggingface-token', ['hf_'], 'hf_[A-Za-z0-9]{34,}', () => 'hf_'),
  tokenRule('sendgrid-key', ['SG.'], 'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43,}', () => 'SG.'),
  tokenRule('age-key', ['AGE-SECRET-KEY-1'], 'AGE-SECRET-KEY-1[A-Z0-9]{58,}', () => 'AGE-SECRET-KEY-'),
  tokenRule('slack-app-token', ['xapp-'], 'xapp-\\d-[A-Za-z0-9]{6,16}-\\d{6,16}-[A-Za-z0-9]{20,}', () => 'xapp-'),
  tokenRule('google-oauth-token', ['ya29.'], 'ya29\\.[0-9A-Za-z_-]{20,}', () => 'ya29.'),
  tokenRule('supabase-token', ['sbp_'], 'sbp_[0-9a-f]{40,}', () => 'sbp_'),
  tokenRule('digitalocean-token', ['dop_v1_', 'doo_v1_', 'dor_v1_'], 'do[opr]_v1_[0-9a-f]{64,}', token => token.slice(0, 7)),
  // The two real token prefixes (pypi.org and test.pypi.org): the first bytes of every PyPI token are the same macaroon header.
  tokenRule('pypi-token', ['pypi-'], 'pypi-Ag(?:EIcHlwaS5vcmc|ENdGVzdC5weXBpLm9yZw)[A-Za-z0-9_-]{50,}', () => 'pypi-'),
  // `<bot id>:<35 characters>`, also inside `https://api.telegram.org/bot<token>/getMe`. Alone: the digits are not the tail of a
  // longer run or of a word, and the 35 characters are not the head of a longer one.
  tokenRule('telegram-bot-token', [':'], '(?:bot)?\\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])', token => (token.startsWith('bot') ? 'bot' : '')),
  {
    // `scheme://user:password@host`: the password is everything up to the last `@` of the authority.
    kind: 'url-password',
    heads: ['://'],
    run: runUrlPassword,
  },
  {
    // `?token=…`, `&password=…`: the name stays, the value goes. Punctuation that ends a sentence is not part of it.
    kind: 'url-secret',
    heads: ['password=', 'passwd=', 'pwd=', 'secret=', 'token=', 'key='],
    ci: true,
    run(text, emit) {
      URL_SECRET_PARAM.lastIndex = 0
      for (let m = URL_SECRET_PARAM.exec(text); m; m = URL_SECRET_PARAM.exec(text)) {
        const raw = m[2] ?? ''
        if (isPlaceholder(raw)) continue // `${TOKEN}` and `[REDACTED]` end in punctuation that the trim below would eat
        let n = raw.length
        while (n > 0 && TRAILING_PUNCTUATION.includes(raw.charAt(n - 1))) n--
        if (isPlaceholder(raw.slice(0, n))) continue
        const start = m.index + m[0].length - raw.length
        if (emit(start, start + n, MARK)) return
      }
    },
  },
  {
    kind: 'auth-header',
    heads: ['authorization'],
    ci: true,
    run(text, emit) {
      AUTH_HEADER.lastIndex = 0
      for (let m = AUTH_HEADER.exec(text); m; m = AUTH_HEADER.exec(text)) {
        const value = m[1] ?? ''
        if (isPlaceholder(value)) continue
        const start = m.index + m[0].length - value.length
        if (emit(start, start + value.length, MARK)) return
      }
    },
  },
  {
    kind: 'aws-secret-key',
    heads: ['secret'],
    ci: true,
    run(text, emit) {
      AWS_SECRET.lastIndex = 0
      for (let m = AWS_SECRET.exec(text); m; m = AWS_SECRET.exec(text)) {
        const value = m[1] ?? ''
        const start = m.index + m[0].length - value.length
        if (emit(start, start + value.length, MARK)) return
      }
    },
  },
  {
    // `Server=db;User Id=sa;Password=hunter2;Encrypt=yes`: the value runs to the next `;`, so it may hold spaces.
    kind: 'connection-string',
    heads: ['password', 'pwd', 'accountkey', 'sharedaccess'],
    ci: true,
    run: runConnectionString,
  },
  {
    // `x-api-key: <value>` (also `"x-api-key": "<value>"`): the header of the APIs that have no Authorization scheme.
    kind: 'api-key-header',
    heads: ['x-api-key', 'x_api_key', 'xapikey'],
    ci: true,
    run(text, emit) {
      scanSettings(text, cls => cls === 'xapikey', 8, (start, end) => emit(start, end, MARK))
    },
  },
  {
    // `PASSWORD=…`, `"apiKey": "…"`, `--token …`, `secret: …`: any setting whose NAME says it holds a credential.
    kind: 'secret-setting',
    heads: ['secret', 'token', 'pass', 'pwd', 'auth', 'credential', 'key'],
    ci: true,
    run(text, emit) {
      scanSettings(text, cls => cls === 'strong' || cls === 'weak', 1, (start, end) => emit(start, end, MARK))
    },
  },
]

/** Every kind id this module can report, in rule priority order. */
export const KINDS: readonly string[] = Object.freeze(RULES.map(rule => rule.kind))

function collect(text: string, firstOnly: boolean): Hit[] {
  const hits: Hit[] = []
  let lower: string | null = null
  for (let rank = 0; rank < RULES.length; rank++) {
    const rule = RULES[rank]
    if (!rule) continue
    let haystack = text
    if (rule.ci) {
      lower ??= text.toLowerCase()
      haystack = lower
    }
    if (!rule.heads.some(head => haystack.includes(head))) continue
    rule.run(text, (start, end, replacement) => {
      hits.push({ start, end, text: replacement, kind: rule.kind, rank })
      return firstOnly
    })
    if (firstOnly && hits.length > 0) break
  }
  return hits
}

/**
 * Replaces every secret-shaped value in `text` by its recognisable prefix, `••••` and the word `masked`. Everything else
 * stays byte for byte. Masked text is never masked again. Total: a non-string comes back as it is, a failure inside
 * (not expected, the rules only read the text) leaves the text as it was.
 */
export function maskText(text: string): MaskResult {
  if (typeof text !== 'string') return { text, count: 0, kinds: [] }
  try {
    const hits = collect(text, false)
    if (hits.length === 0) return { text, count: 0, kinds: [] }
    hits.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank)
    // Spans that overlap are one secret: the first one (longest, then highest priority) names it, the span widens.
    const spans: Hit[] = []
    for (const hit of hits) {
      const last = spans[spans.length - 1]
      if (last && hit.start < last.end) {
        if (hit.end > last.end) last.end = hit.end
        continue
      }
      spans.push(hit)
    }
    const parts: string[] = []
    const kinds: string[] = []
    let at = 0
    for (const span of spans) {
      parts.push(text.slice(at, span.start), span.text)
      at = span.end
      if (!kinds.includes(span.kind)) kinds.push(span.kind)
    }
    parts.push(text.slice(at))
    return { text: parts.join(''), count: spans.length, kinds }
  } catch {
    return { text, count: 0, kinds: [] }
  }
}

/** True exactly when `maskText(text)` would change the text. Stops at the first hit and skips rules the text cannot match. */
export function hasSecretShape(text: string): boolean {
  if (typeof text !== 'string') return false
  try {
    return collect(text, true).length > 0
  } catch {
    return false
  }
}

// --- Plain data -------------------------------------------------------------------------------------------------------

const MAX_DEPTH = 24
/**
 * A string above this size is returned as it is: a value of 20 MB is a file dump or an inlined blob, not text a person
 * reads, and masking it would cost the session a visible stall (and a copy of the blob) for a result that is almost never
 * a credential. Tool output is capped far below this by Claude Code itself.
 */
const MAX_STRING = 20_000_000
const OBJECT_SOURCE = Function.prototype.toString.call(Object)

/** An object literal or `JSON.parse` result, also one made in another realm; not a class instance, Date, Map or Set. */
function isPlainObject(value: object): boolean {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto === null || proto === Object.prototype) return true
  if (Object.getPrototypeOf(proto) !== null || !Object.prototype.hasOwnProperty.call(proto, 'constructor')) return false
  const ctor = (proto as { constructor?: unknown }).constructor
  return typeof ctor === 'function' && Function.prototype.toString.call(ctor) === OBJECT_SOURCE
}

type Walk = {
  count: number
  kinds: string[]
  done: Map<object, unknown> // a container met twice (shared, not cyclic) is masked once and counted once
  active: Set<object> // containers on the path being walked: meeting one again is a cycle, kept as it is
}

function walk(value: unknown, depth: number, st: Walk): unknown {
  if (depth > MAX_DEPTH) return value
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) return value
    const r = maskText(value)
    if (r.count === 0) return value
    st.count += r.count
    for (const kind of r.kinds) if (!st.kinds.includes(kind)) st.kinds.push(kind)
    return r.text
  }
  if (value === null || typeof value !== 'object') return value
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
    if (!isArray && !isPlainObject(value)) return value
  } catch {
    return value // a revoked proxy: this node stays as it is
  }
  if (st.done.has(value)) return st.done.get(value)
  if (st.active.has(value)) return value
  st.active.add(value)
  try {
    let result: unknown = value
    if (isArray) {
      const items = value as unknown[]
      let next: unknown[] | null = null
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const masked = walk(item, depth + 1, st)
        if (next === null && !Object.is(masked, item)) next = items.slice(0, i)
        if (next !== null) next.push(masked)
      }
      if (next !== null) result = next
    } else {
      const source = value as Record<string, unknown>
      const keys = Object.keys(source)
      const values = keys.map(key => source[key])
      let next: unknown[] | null = null
      for (let i = 0; i < values.length; i++) {
        const masked = walk(values[i], depth + 1, st)
        if (next === null && !Object.is(masked, values[i])) next = values.slice(0, i)
        if (next !== null) next.push(masked)
      }
      if (next !== null) {
        // defineProperty: a key called `__proto__` stays a key instead of changing the prototype.
        const out: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {}
        for (let i = 0; i < keys.length; i++) {
          Object.defineProperty(out, keys[i] as string, { value: next[i], enumerable: true, writable: true, configurable: true })
        }
        result = out
      }
    }
    st.done.set(value, result)
    return result
  } catch {
    return value // a throwing getter: this node stays as it is
  } finally {
    st.active.delete(value)
  }
}

/**
 * Masks every string inside plain data (arrays and object literals, so also the content blocks of a tool result), values
 * only, never keys. Returns a new structure that shares every branch it did not change; the input is never mutated.
 * Containers nested deeper than 24 levels, class instances, Dates, Maps and the like are returned as they are. `count` is
 * the number of masked values; a container reached twice counts once.
 */
export function maskDeep<T>(value: T): { value: T; count: number; kinds: string[] } {
  const st: Walk = { count: 0, kinds: [], done: new Map(), active: new Set() }
  try {
    const out = walk(value, 0, st) as T
    return { value: out, count: st.count, kinds: st.kinds }
  } catch {
    return { value, count: 0, kinds: [] }
  }
}
