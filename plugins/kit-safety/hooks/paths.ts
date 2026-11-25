// Pure path helpers, no engine calls, no Node: paths are plain strings and both POSIX (`/home/x/app`) and Windows
// (`C:\Users\x\app`, `C:/Users/x/app`, `\\server\share`, Git Bash's `/c/Users/x`) spellings are understood. Everything
// that decides "is this inside the project?" goes through here, so there is one place to get that right. These work on
// spellings only: a symbolic link is resolved by the caller (`$.fs.stat(path, { resolve: true })`) and checked again.

/** `C:\x`, `C:/x`, `C:` and `\\server\share` are Windows paths; `/x` is not. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || /^\\\\[^\\]/.test(p)
}

/** True for `/x`, `C:/x`, `C:\x` and `\\server\share`. A drive-relative `C:x` is not absolute. */
export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p)
}

/**
 * Collapses `.`, `..` and repeated separators, writes `/` between segments and drops a trailing one. `..` never climbs
 * above an absolute path's root. A relative path keeps leading `..`. Never throws.
 */
export function normalizePath(p: string): string {
  let s = isWindowsPath(p) ? p.replace(/\\/g, '/') : p
  let prefix = ''
  const drive = /^([A-Za-z]):(\/|$)/.exec(s)
  if (drive) {
    prefix = `${drive[1]}:/`
    s = s.slice(drive[0].length)
  } else if (s.startsWith('//') && s.charAt(2) !== '' && s.charAt(2) !== '/') {
    // \\server\share becomes //server/share: the first two segments are the root. (`//` and `///x` are the POSIX root.)
    const parts = s.slice(2).split('/').filter(Boolean)
    prefix = `//${parts.slice(0, 2).join('/')}/`
    s = parts.slice(2).join('/')
  } else if (s.startsWith('/')) {
    prefix = '/'
  }
  const out: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (prefix === '') out.push('..')
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  if (prefix === '') return body === '' ? '.' : body
  return body === '' ? prefix : prefix + body
}

/** Joins parts with `/` and normalizes the result. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(part => part !== '').join('/'))
}

/**
 * The absolute, normalized path `p` names when run from `base`, or null when that cannot be known from the spelling: an
 * empty path, one with a shell variable or command substitution (`$X`, `` `x` ``, `$(x)`), `~user`, `~` with no `home`,
 * a drive-relative `C:x`, or a relative one with no absolute `base`. `~` and `~/x` become `home`. Git Bash's `/c/x` is
 * read as `C:/x` when `base` is a Windows path. Wildcards are not expanded here (see snapshot.ts).
 */
export function resolvePath(base: string, p: string, home?: string): string | null {
  let q = p
  if (q === '' || /[$`\0]/.test(q)) return null
  if (q === '~' || q.startsWith('~/') || q.startsWith('~\\')) {
    if (!home) return null
    q = home.replace(/[\\/]+$/, '') + q.slice(1)
  } else if (q.startsWith('~')) {
    return null
  }
  // cmd.exe variables (%TEMP%) cannot be read from the spelling either; a lone % is an ordinary character.
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(q)) return null
  if (isWindowsPath(base)) {
    const msys = /^\/([A-Za-z])(\/.*)?$/.exec(q)
    if (msys) q = `${msys[1]!.toUpperCase()}:${msys[2] ?? '/'}`
    // A single leading backslash names the root of the base's drive (or share), not a folder of the base.
    if (/^\\(?!\\)/.test(q)) {
      const rootOfBase = /^([A-Za-z]:)/.exec(base)?.[1] ?? /^(?:\\\\|\/\/)([^\\/]+[\\/][^\\/]+)/.exec(base)?.[0]?.replace(/\\/g, '/')
      if (!rootOfBase) return null
      q = rootOfBase + q.replace(/\\/g, '/')
    }
  }
  if (!isAbsolute(q)) {
    if (/^[A-Za-z]:/.test(q) || !isAbsolute(base)) return null
    q = base.replace(/[\\/]+$/, '') + '/' + q
  }
  return normalizePath(q)
}

/** True for a filesystem root (`/`, `C:/`, `//server/share`) or an empty path: never a usable project root. */
export function isFilesystemRoot(p: string): boolean {
  const n = normalizePath(p)
  return n === '' || n === '.' || n === '/' || /^[A-Za-z]:\/$/.test(n) || /^\/\/[^/]+\/[^/]*\/?$/.test(n)
}

/** True when `abs` is `root` itself or below it, by spelling. Windows-style roots compare without regard to case. */
export function isInside(root: string, abs: string): boolean {
  const r = normalizePath(root)
  const a = normalizePath(abs)
  if (!isAbsolute(r) || !isAbsolute(a)) return false
  const ci = isWindowsPath(r) || r.startsWith('//') // //server/share is a UNC root (normalizePath keeps // for nothing else)
  const rr = ci ? r.toLowerCase() : r
  const aa = ci ? a.toLowerCase() : a
  if (aa === rr) return true
  return aa.startsWith(rr.endsWith('/') ? rr : rr + '/')
}

/** `abs` relative to `root` with `/` separators (`''` for the root itself), or null when it is not inside. */
export function relativeTo(root: string, abs: string): string | null {
  if (!isInside(root, abs)) return null
  const r = normalizePath(root)
  const a = normalizePath(abs)
  return a.slice(r.length).replace(/^\/+/, '')
}

/**
 * True for a path that is safe to join onto a root: relative, non-empty, no `..` or `.` segment, no empty segment, no
 * drive or NUL, no backslash. Manifest entries are checked with this before anything is written or restored.
 */
export function isSafeRelative(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || rel.includes('\0')) return false
  return rel.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
}

/** Last segment of a path (a trailing separator is ignored): `/a/b/` is `b`. */
export function baseName(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf('/')
  return i < 0 ? n : n.slice(i + 1) || n
}

/** The folder part of a path: `/a/b/c` is `/a/b`; a root's is itself. */
export function dirName(p: string): string {
  const n = normalizePath(p)
  const i = n.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  const head = n.slice(0, i)
  return /^[A-Za-z]:$/.test(head) ? head + '/' : head
}
