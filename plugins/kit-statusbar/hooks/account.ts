// The account the session runs as, read from the Claude config directory (no profile naming convention assumed):
// CLAUDE_CONFIG_DIR when set, else <home>/.claude. Pure helpers: the module reads the environment and the files.

export const PALETTE_SIZE = 8

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

// base + parts with forward slashes: Windows takes them as well, so one spelling works on every system.
export const joinPath = (base: string, ...parts: string[]): string => `${base.replace(/[\\/]+$/, '')}/${parts.join('/')}`

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

// On Windows USERPROFILE is the home; HOME there may be a Git Bash path (/c/Users/...) the system cannot open.
export function pickHome(home: string | undefined, userProfile: string | undefined): string {
  const profile = userProfile?.trim() ?? ''
  if (profile && isWindowsPath(profile)) return profile
  return home?.trim() || profile
}

export type Place = {
  /** The Claude config directory ('' when neither CLAUDE_CONFIG_DIR nor a home directory is known). */
  configDir: string
  /** Where the login record lives: <CLAUDE_CONFIG_DIR>/.claude.json when set, else <home>/.claude.json. */
  loginFile: string
  isCustom: boolean
}

export function placeOf(custom: string | undefined, home: string | undefined, userProfile: string | undefined): Place {
  const dir = custom?.trim() ?? ''
  if (dir) return { configDir: dir, loginFile: joinPath(dir, '.claude.json'), isCustom: true }
  const h = pickHome(home, userProfile)
  if (!h) return { configDir: '', loginFile: '', isCustom: false }
  return { configDir: joinPath(h, '.claude'), loginFile: joinPath(h, '.claude.json'), isCustom: false }
}

// `.claude` -> default, `.claude-work` -> work, any other folder name -> that name without a leading dot.
export function accountLabel(configDir: string): string {
  const name = baseName(configDir.trim())
  if (!name || /^\.claude$/i.test(name)) return 'default'
  const suffix = /^\.claude-(.+)$/i.exec(name)?.[1]
  if (suffix) return suffix
  return name.replace(/^\.+/, '') || 'default'
}

// A stable slot of the 8-color palette for a label: default is slot 0, every other label slots 1 to 7 (FNV-1a).
export function colorIndexOf(label: string): number {
  if (label === 'default') return 0
  let h = 0x811c9dc5
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 1 + ((h >>> 0) % (PALETTE_SIZE - 1))
}

const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/

// oauthAccount.emailAddress of a login record (.claude.json); '' when the text is not JSON or holds none.
export function parseLoginEmail(text: string): string {
  try {
    const email: unknown = JSON.parse(text)?.oauthAccount?.emailAddress
    return typeof email === 'string' && EMAIL.test(email) ? email : ''
  } catch {
    return ''
  }
}
