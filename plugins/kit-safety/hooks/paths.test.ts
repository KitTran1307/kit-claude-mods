import { expect, test } from 'claude-code/testing'

import {
  baseName, dirName, isAbsolute, isFilesystemRoot, isInside, isSafeRelative, isWindowsPath, joinPath, normalizePath, relativeTo,
  resolvePath,
} from './paths'

// ---- isWindowsPath / isAbsolute ----

test('isWindowsPath: drive letters and backslash UNC are Windows paths, POSIX and relative ones are not', () => {
  for (const p of ['C:\\x', 'C:/x', 'c:\\', 'C:', 'z:/a/b', '\\\\server\\share', '\\\\server\\share\\dir', '\\\\?\\C:\\x']) {
    expect(isWindowsPath(p), p).toBe(true)
  }
  for (const p of ['/x', '/c/Users', 'x', '', '.', 'C', 'CC:/x', 'C:x', '1:/x', '\\x', '\\\\', '//server/share', '~/x']) {
    expect(isWindowsPath(p), p).toBe(false)
  }
})

test('isAbsolute: root-anchored, drive-anchored and UNC; a drive-relative path is not', () => {
  for (const p of ['/', '/x', '/x/y', 'C:\\', 'C:/x', 'c:\\x\\y', '\\\\server\\share', '//server/share']) expect(isAbsolute(p), p).toBe(true)
  for (const p of ['', 'x', './x', '../x', 'C:', 'C:x', '~', '~/x', '\\x', '\\\\', 'a/b', '$HOME']) expect(isAbsolute(p), p).toBe(false)
})

// ---- normalizePath ----

test('normalizePath: separators, dots and trailing slashes of POSIX paths', () => {
  const table: [string, string][] = [
    ['/a/b/c', '/a/b/c'],
    ['/a//b///c/', '/a/b/c'],
    ['/a/./b/.', '/a/b'],
    ['/a/b/../c', '/a/c'],
    ['/a/b/../../c', '/c'],
    ['/', '/'],
    ['/.', '/'],
    ['/a/..', '/'],
    ['/..', '/'],
    ['/../../x', '/x'],
    ['/a/b/../../../..', '/'],
    ['a/b/', 'a/b'],
    ['a/./b', 'a/b'],
    ['a/../b', 'b'],
    ['a/..', '.'],
    ['./', '.'],
    ['', '.'],
    ['.', '.'],
    ['..', '..'],
    ['../..', '../..'],
    ['../a/../..', '../..'],
    ['a/../../b', '../b'],
    ['./a', 'a'],
    ['/home/user/my project/file name.txt', '/home/user/my project/file name.txt'],
    ['/tmp/ünï/日本語/', '/tmp/ünï/日本語'],
  ]
  for (const [input, want] of table) expect(normalizePath(input), input).toBe(want)
})

test('normalizePath: Windows paths use forward slashes, a drive root and clamp .. at the root', () => {
  const table: [string, string][] = [
    ['C:\\Users\\x\\app', 'C:/Users/x/app'],
    ['C:/Users/x/app/', 'C:/Users/x/app'],
    ['C:\\', 'C:/'],
    ['C:/', 'C:/'],
    ['C:', 'C:/'],
    ['c:\\a\\..\\b', 'c:/b'],
    ['C:\\a\\..\\..\\..\\b', 'C:/b'],
    ['C:\\a\\.\\b\\\\c', 'C:/a/b/c'],
    ['C:\\Program Files (x86)\\App', 'C:/Program Files (x86)/App'],
    ['C:\\Users\\Nguyễn\\dự án', 'C:/Users/Nguyễn/dự án'],
    ['\\\\server\\share\\dir\\file', '//server/share/dir/file'],
    ['\\\\server\\share', '//server/share/'],
    ['\\\\server\\share\\', '//server/share/'],
    ['\\\\server\\share\\a\\..\\..\\..\\b', '//server/share/b'],
    ['\\\\server', '//server/'],
  ]
  for (const [input, want] of table) expect(normalizePath(input), input).toBe(want)
})

test('normalizePath: a relative path with backslashes is left alone (a POSIX name may contain one)', () => {
  expect(normalizePath('a\\b')).toBe('a\\b')
  expect(normalizePath('/home/x/a\\b')).toBe('/home/x/a\\b')
  expect(normalizePath('C:foo')).toBe('C:foo')
})

test('normalizePath never throws and is idempotent on odd input', () => {
  const odd = ['\0', 'a\0b', ' ', '   ', '\n', '\t/\t', '/'.repeat(500), 'a/'.repeat(5000), '../'.repeat(2000), '\\'.repeat(100), '%', '*', '?', '[', '日本語', '\u202e/x', '//?/C:/x', '\\\\?\\C:\\x']
  for (const p of odd) {
    const once = normalizePath(p)
    expect(typeof once, JSON.stringify(p.slice(0, 20))).toBe('string')
    expect(normalizePath(once), JSON.stringify(p.slice(0, 20))).toBe(once)
  }
  expect(normalizePath('a/'.repeat(5000))).toBe('a/'.repeat(5000).slice(0, -1))
  expect(normalizePath('../'.repeat(2000))).toBe(Array(2000).fill('..').join('/'))
})

// ---- joinPath ----

test('joinPath joins with / and normalizes; an empty part is dropped; a later absolute part does not reset', () => {
  expect(joinPath('/a', 'b', 'c')).toBe('/a/b/c')
  expect(joinPath('/a/', '/b/')).toBe('/a/b')
  expect(joinPath('/a', '', 'b')).toBe('/a/b')
  expect(joinPath('/a', '..', 'b')).toBe('/b')
  expect(joinPath('a', 'b')).toBe('a/b')
  expect(joinPath('C:\\a', 'b\\c')).toBe('C:/a/b/c')
  expect(joinPath('C:\\', 'x')).toBe('C:/x')
  expect(joinPath('/')).toBe('/')
  expect(joinPath()).toBe('.')
  expect(joinPath('', '')).toBe('.')
  expect(joinPath('/a', '../../..', 'x')).toBe('/x')
})

// ---- baseName / dirName ----

test('baseName: last segment, a trailing separator is ignored', () => {
  const table: [string, string][] = [
    ['/a/b/c', 'c'],
    ['/a/b/', 'b'],
    ['/a', 'a'],
    ['a', 'a'],
    ['a/b', 'b'],
    ['C:\\Users\\x\\My App', 'My App'],
    ['C:\\Users\\x\\', 'x'],
    ['/home/x/dự án', 'dự án'],
    ['/a/b/..', 'a'],
  ]
  for (const [input, want] of table) expect(baseName(input), input).toBe(want)
  // Roots have no folder name: the root itself comes back, never an empty string.
  expect(baseName('/')).toBe('/')
  expect(baseName('C:\\')).toBe('C:/')
  expect(baseName('')).toBe('.')
  expect(baseName('.')).toBe('.')
})

test('dirName: the folder part; a root is its own folder', () => {
  const table: [string, string][] = [
    ['/a/b/c', '/a/b'],
    ['/a/b/', '/a'],
    ['/a', '/'],
    ['/', '/'],
    ['a', '.'],
    ['a/b', 'a'],
    ['', '.'],
    ['C:\\a\\b', 'C:/a'],
    ['C:\\a', 'C:/'],
    ['C:\\', 'C:/'],
    ['\\\\server\\share\\x\\y', '//server/share/x'],
    ['/a/b/../c', '/a'],
  ]
  for (const [input, want] of table) expect(dirName(input), input).toBe(want)
})

// ---- isFilesystemRoot ----

test('isFilesystemRoot: roots, drives, UNC shares and empty paths are never a project root', () => {
  for (const p of ['/', '/.', '/..', '/a/..', '/a/../..', '', '.', './', 'C:\\', 'C:/', 'c:\\', 'C:', 'C:\\a\\..', '\\\\server\\share', '\\\\server\\share\\', '\\\\server']) {
    expect(isFilesystemRoot(p), JSON.stringify(p)).toBe(true)
  }
  for (const p of ['/home', '/a', '/a/b', 'x', '../x', 'C:\\Users', 'C:/Users/x', 'D:\\proj', '\\\\server\\share\\dir', '\\\\server\\share\\a\\b', '/home/x/..hidden', '..']) {
    expect(isFilesystemRoot(p), JSON.stringify(p)).toBe(false)
  }
})

// ---- resolvePath ----

const HOME = '/home/user'
const WHOME = 'C:\\Users\\user'

test('resolvePath: relative paths resolve against the base, absolute ones ignore it', () => {
  expect(resolvePath('/proj', 'build')).toBe('/proj/build')
  expect(resolvePath('/proj', './build/')).toBe('/proj/build')
  expect(resolvePath('/proj', 'build/../dist')).toBe('/proj/dist')
  expect(resolvePath('/proj/app', '../lib')).toBe('/proj/lib')
  expect(resolvePath('/proj', '/etc/hosts')).toBe('/etc/hosts')
  expect(resolvePath('/proj', '.')).toBe('/proj')
  expect(resolvePath('/proj/', 'a')).toBe('/proj/a')
  expect(resolvePath('/proj', 'my folder/file name.txt')).toBe('/proj/my folder/file name.txt')
  expect(resolvePath('/proj', 'dự án/tệp.txt')).toBe('/proj/dự án/tệp.txt')
  expect(resolvePath('/proj', 'build/*.js')).toBe('/proj/build/*.js') // wildcards are not expanded here
})

test('resolvePath: .. never climbs above the root', () => {
  expect(resolvePath('/proj', '../../../../..')).toBe('/')
  expect(resolvePath('/proj', '../../etc')).toBe('/etc')
  expect(resolvePath('C:\\proj', '..\\..\\..\\x')).toBe('C:/x')
  expect(resolvePath('/', '..')).toBe('/')
})

test('resolvePath: Windows bases and spellings', () => {
  expect(resolvePath('C:\\proj', 'src\\main.c')).toBe('C:/proj/src/main.c')
  expect(resolvePath('C:\\proj\\', 'src/main.c')).toBe('C:/proj/src/main.c')
  expect(resolvePath('C:\\proj', 'D:\\other\\x')).toBe('D:/other/x')
  expect(resolvePath('C:/proj', 'd:/other')).toBe('d:/other')
  expect(resolvePath('C:\\proj', '\\\\server\\share\\x')).toBe('//server/share/x')
  expect(resolvePath('/proj', 'C:\\Users\\x')).toBe('C:/Users/x')
  expect(resolvePath('C:\\proj', '.')).toBe('C:/proj')
  expect(resolvePath('C:\\proj', 'a b\\c d.txt')).toBe('C:/proj/a b/c d.txt')
})

test('resolvePath: a drive-relative path (C:x) cannot be known from its spelling', () => {
  expect(resolvePath('C:\\proj', 'D:x')).toBeNull()
  expect(resolvePath('C:\\proj', 'C:x')).toBeNull()
  expect(resolvePath('/proj', 'C:x')).toBeNull()
})

test('resolvePath: Git Bash /c/Users is C:/Users only when the base is a Windows path', () => {
  expect(resolvePath('C:\\proj', '/c/Users/x')).toBe('C:/Users/x')
  expect(resolvePath('C:\\proj', '/d/data')).toBe('D:/data')
  expect(resolvePath('C:\\proj', '/c')).toBe('C:/')
  expect(resolvePath('C:\\proj', '/c/')).toBe('C:/')
  expect(resolvePath('C:\\proj', '/C/Users')).toBe('C:/Users')
  expect(resolvePath('C:\\proj', '/c/Users/../../..')).toBe('C:/')
  // A longer first segment is a POSIX path even on Windows; on POSIX bases nothing is rewritten.
  expect(resolvePath('C:\\proj', '/tmp/x')).toBe('/tmp/x')
  expect(resolvePath('C:\\proj', '/cc/x')).toBe('/cc/x')
  expect(resolvePath('/proj', '/c/Users/x')).toBe('/c/Users/x')
})

test('resolvePath: ~ and ~/x use the home folder; ~name, and ~ without a home, are unknown', () => {
  expect(resolvePath('/proj', '~', HOME)).toBe('/home/user')
  expect(resolvePath('/proj', '~/', HOME)).toBe('/home/user')
  expect(resolvePath('/proj', '~/Downloads/x', HOME)).toBe('/home/user/Downloads/x')
  expect(resolvePath('/proj', '~/a/../../..', HOME)).toBe('/')
  expect(resolvePath('/proj', '~/x', '/home/user/')).toBe('/home/user/x')
  expect(resolvePath('/proj', '~/x', '/home/user///')).toBe('/home/user/x')
  expect(resolvePath('C:\\proj', '~', WHOME)).toBe('C:/Users/user')
  expect(resolvePath('C:\\proj', '~\\Desktop', WHOME)).toBe('C:/Users/user/Desktop')
  expect(resolvePath('C:\\proj', '~/Desktop', WHOME + '\\')).toBe('C:/Users/user/Desktop')
  expect(resolvePath('/proj', '~', undefined)).toBeNull()
  expect(resolvePath('/proj', '~', '')).toBeNull()
  expect(resolvePath('/proj', '~/x')).toBeNull()
  expect(resolvePath('/proj', '~bob/x', HOME)).toBeNull()
  expect(resolvePath('/proj', '~root', HOME)).toBeNull()
  expect(resolvePath('/proj', '~+', HOME)).toBeNull()
  expect(resolvePath('/proj', 'a~b', HOME)).toBe('/proj/a~b')
  expect(resolvePath('/proj', 'dir/~', HOME)).toBe('/proj/dir/~')
})

test('resolvePath: shell variables, command substitution and backticks are unknown', () => {
  for (const p of ['$HOME/x', '${HOME}/x', '$HOME', '$(pwd)/x', '`pwd`/x', 'a/$B/c', '$env:TEMP\\x', '~/$X', '"$DIR"', 'a/b$', '$', '${', 'x`', '$((1+1))']) {
    expect(resolvePath('/proj', p, HOME), p).toBeNull()
    expect(resolvePath('C:\\proj', p, WHOME), p).toBeNull()
  }
})

test('resolvePath: empty paths, NUL and a relative base are unknown', () => {
  expect(resolvePath('/proj', '')).toBeNull()
  expect(resolvePath('/proj', 'a\0b')).toBeNull()
  expect(resolvePath('/proj', '\0')).toBeNull()
  expect(resolvePath('relative/base', 'x')).toBeNull()
  expect(resolvePath('', 'x')).toBeNull()
  expect(resolvePath('relative', '/abs/x')).toBe('/abs/x') // an absolute path needs no base
  expect(resolvePath('relative', '~/x', HOME)).toBe('/home/user/x')
})

test('resolvePath never throws on odd input', () => {
  const odd = [' ', '\n', '\t', '/'.repeat(300), '../'.repeat(500), '日本語/..', '%', '*', '[', '\u202e', '//', '///x', '\\\\', '?']
  for (const p of odd) {
    const got = resolvePath('/proj', p, HOME)
    expect(got === null || typeof got === 'string', JSON.stringify(p.slice(0, 10))).toBe(true)
  }
  expect(resolvePath('/proj', 'x'.repeat(100_000))).toBe('/proj/' + 'x'.repeat(100_000))
})

// ---- isInside / relativeTo ----

test('isInside: the root itself and anything below it, by spelling', () => {
  expect(isInside('/proj', '/proj')).toBe(true)
  expect(isInside('/proj', '/proj/')).toBe(true)
  expect(isInside('/proj', '/proj/a/b')).toBe(true)
  expect(isInside('/proj/', '/proj/a')).toBe(true)
  expect(isInside('/proj', '/proj/a/../b')).toBe(true)
  expect(isInside('/proj', '/proj/..')).toBe(false)
  expect(isInside('/proj', '/proj/../etc')).toBe(false)
  expect(isInside('/proj', '/proj/a/../../etc')).toBe(false)
  expect(isInside('/proj', '/project')).toBe(false) // a sibling that shares a prefix
  expect(isInside('/proj', '/pro')).toBe(false)
  expect(isInside('/proj', '/')).toBe(false)
  expect(isInside('/proj', '/etc/proj')).toBe(false)
  expect(isInside('/', '/anything')).toBe(true)
  expect(isInside('/', '/')).toBe(true)
  expect(isInside('/proj/app', '/proj')).toBe(false)
})

test('isInside: both paths must be absolute', () => {
  expect(isInside('/proj', 'a/b')).toBe(false)
  expect(isInside('proj', '/proj/a')).toBe(false)
  expect(isInside('', '/a')).toBe(false)
  expect(isInside('/proj', '')).toBe(false)
  expect(isInside('proj', 'proj/a')).toBe(false)
  expect(isInside('.', './a')).toBe(false)
})

test('isInside: case matters on POSIX roots and not on Windows-style ones', () => {
  expect(isInside('/Proj', '/proj/a')).toBe(false)
  expect(isInside('/proj', '/PROJ')).toBe(false)
  expect(isInside('C:\\Proj', 'c:/proj/Sub')).toBe(true)
  expect(isInside('c:/proj', 'C:\\PROJ\\sub\\file.TXT')).toBe(true)
  expect(isInside('C:\\Proj', 'C:\\Project')).toBe(false)
  expect(isInside('C:\\Proj', 'D:\\Proj')).toBe(false)
  expect(isInside('C:\\', 'C:\\Windows')).toBe(true)
  expect(isInside('C:\\proj', 'C:\\proj\\..\\other')).toBe(false)
  expect(isInside('C:\\proj', '/proj/a')).toBe(false) // different spelling families: resolvePath converts first
})

test('relativeTo: the path below the root with / separators, empty for the root itself, null outside', () => {
  expect(relativeTo('/proj', '/proj/a/b.txt')).toBe('a/b.txt')
  expect(relativeTo('/proj', '/proj')).toBe('')
  expect(relativeTo('/proj', '/proj/')).toBe('')
  expect(relativeTo('/proj/', '/proj/a')).toBe('a')
  expect(relativeTo('/proj', '/proj/a/../b')).toBe('b')
  expect(relativeTo('/proj', '/project/a')).toBeNull()
  expect(relativeTo('/proj', '/etc/passwd')).toBeNull()
  expect(relativeTo('/proj', '/proj/../etc')).toBeNull()
  expect(relativeTo('/', '/x/y')).toBe('x/y')
  expect(relativeTo('C:\\proj', 'C:\\proj\\src\\main.c')).toBe('src/main.c')
  expect(relativeTo('C:\\proj', 'c:/PROJ/Src/Main.c')).toBe('Src/Main.c') // the case of the path is kept
  expect(relativeTo('C:\\', 'C:\\x\\y')).toBe('x/y')
  expect(relativeTo('C:\\proj', 'D:\\proj\\x')).toBeNull()
  expect(relativeTo('/proj', 'relative')).toBeNull()
})

test('relativeTo results are accepted by isSafeRelative (the two fit together)', () => {
  for (const abs of ['/proj/a', '/proj/a/b/c.txt', '/proj/dự án/tệp 1.txt', '/proj/.hidden/x', '/proj/a/../b']) {
    const rel = relativeTo('/proj', abs)
    expect(rel !== null && isSafeRelative(rel), abs).toBe(true)
  }
})

// ---- isSafeRelative ----

test('isSafeRelative accepts plain relative paths', () => {
  for (const rel of ['a', 'a/b', 'a/b/c.txt', '.hidden', 'a/.hidden/b', 'dir with spaces/file name.txt', 'dự án/tệp.txt', '日本語/ファイル.txt', '...', 'a/...', '..a', 'a..', 'a..b', 'a/..b/c', '-rf', 'a/-b', "it's.txt", 'ab:c/d', 'a/b:c', '%2e%2e/x', '$HOME/x', '~/x', '*', 'a/*.js', 'x'.repeat(5000), 'a b ']) {
    expect(isSafeRelative(rel), rel.slice(0, 40)).toBe(true)
  }
})

test('isSafeRelative refuses every hostile spelling', () => {
  const hostile = [
    '', '/', '/etc/passwd', '//server/share', '/a', '.', '..', './', '../', './a', '../a', 'a/..', 'a/../b', 'a/../../b', '../../etc/passwd',
    'a/./b', 'a/.', 'a//b', 'a/', '/a/b', 'a/b/', '\\a', 'a\\b', 'a\\..\\b', '..\\x', '.\\x', 'C:', 'C:x', 'C:\\x', 'C:/x', 'c:/x', 'z:\\', 'D:foo/bar', 'a:b/c',
    '\\\\server\\share', 'a\0b', '\0', 'a/\0', '\0/a', 'a/b\0/c', ' \0',
  ]
  for (const rel of hostile) expect(isSafeRelative(rel), JSON.stringify(rel)).toBe(false)
  // A deeply nested escape is as bad as a short one.
  expect(isSafeRelative('a/'.repeat(1000) + '..')).toBe(false)
  expect(isSafeRelative('../'.repeat(1000) + 'x')).toBe(false)
})

// ---- cases that were bugs in the first version of paths.ts (found while writing these tests); kept as regressions ----

test('three or more leading slashes are one slash on POSIX, and // is the root', () => {
  expect(normalizePath('///')).toBe('/')
  expect(normalizePath('///a/b')).toBe('/a/b')
  expect(normalizePath('////a')).toBe('/a')
  expect(normalizePath('//')).toBe('/')
  expect(isFilesystemRoot('//')).toBe(true)
  expect(isFilesystemRoot('///')).toBe(true)
  expect(isInside('/a', '///a/b')).toBe(true)
  expect(resolvePath('/proj', '///etc/x')).toBe('/etc/x')
})

test('cmd.exe style %VAR% paths are unknown, not a folder literally named %VAR%', () => {
  expect(resolvePath('C:\\proj', '%TEMP%\\build')).toBeNull()
  expect(resolvePath('C:\\proj', '%USERPROFILE%')).toBeNull()
  expect(resolvePath('C:\\proj', 'a\\%APPDATA%\\b')).toBeNull()
  expect(resolvePath('C:\\proj', '100%')).toBe('C:/proj/100%') // a lone % is an ordinary character
})

test('a UNC root compares without regard to case like every other Windows path', () => {
  expect(isInside('\\\\SERVER\\Share\\proj', '\\\\server\\share\\proj\\x')).toBe(true)
  expect(relativeTo('\\\\SERVER\\Share\\proj', '\\\\server\\share\\PROJ\\Sub')).toBe('Sub')
})

test('on a Windows base a leading single backslash names the drive root, not a folder of the base', () => {
  expect(resolvePath('C:\\proj', '\\temp\\x')).toBe('C:/temp/x')
  expect(resolvePath('D:\\work\\app', '\\x')).toBe('D:/x')
  expect(isInside('C:\\proj', resolvePath('C:\\proj', '\\temp') ?? '')).toBe(false)
})
