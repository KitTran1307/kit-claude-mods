import { expect, test } from 'claude-code/testing'

import { MIN_CLAUDE_CODE, countLevels, doctorLines, formatLine, parseVersion, summaryLine, versionAtLeast } from './doctor'
import type { DoctorFacts, Line } from './doctor'
import { countAllSnapshots } from './facts'
import { TABLES } from './i18n'
import { buildManifest, projectKey, serializeManifest, snapshotDir } from './snapshot'
import type { IO, VaultEnv } from './vault'

const EN = TABLES.en
const VI = TABLES.vi
const MB = 1024 * 1024
const DIR = '/home/x/.claude/kit-safety/snapshots'

const RLO = '\u{202E}'
const ZWSP = '\u{200B}'
const NUL = '\u{0}'
const ESC = '\u{1B}'
// Letters and signs that draw as blank (Hangul fillers, Khmer inherent vowels, the grapheme joiner, the blank braille pattern) count too.
const BLANKS = '\u{3164}\u{FFA0}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{34F}\u{2800}'
const CONTROL_OR_INVISIBLE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{34F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{2800}\u{3164}\u{FFA0}]/u

/** Facts for a machine where everything works. */
const facts = (o: Partial<DoctorFacts> = {}): DoctorFacts => ({
  claudeVersion: '2.1.331', node: 'v22.4.0', git: 'git version 2.43.0', snapshotsDir: DIR, isWritable: true, snapshotCount: 3, snapshotBytes: 12 * MB,
  helperAnswered: true, confirm: 'risky', maskSecrets: true, language: 'en', surface: 'terminal', ...o,
})
const text = (f: Partial<DoctorFacts>, t = EN) => doctorLines(facts(f), t).map(formatLine)
const hostile = <T>(value: unknown) => value as T

test('MIN_CLAUDE_CODE is the version the other plugins need', () => {
  expect(MIN_CLAUDE_CODE).toBe('2.1.275')
})

test('parseVersion: the first major.minor.patch in a text, or null', () => {
  expect(parseVersion('2.1.331')).toEqual([2, 1, 331])
  expect(parseVersion('2.1.331 (Claude Code)')).toEqual([2, 1, 331])
  expect(parseVersion('claude 2.1.280-dev.20260920')).toEqual([2, 1, 280])
  expect(parseVersion('v10.20.30')).toEqual([10, 20, 30])
  expect(parseVersion('1.2.3.4')).toEqual([1, 2, 3])
  expect(parseVersion('2.1')).toBeNull()
  expect(parseVersion('nonsense')).toBeNull()
  expect(parseVersion('')).toBeNull()
  for (const v of [undefined, null, 5, {}, [], true]) expect(parseVersion(v)).toBeNull()
  expect(parseVersion(`${'x'.repeat(100_000)}2.1.331`)).toBeNull()
})

test('versionAtLeast: major, minor and patch, equal counts, unreadable is false', () => {
  expect(versionAtLeast('2.1.331', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.1.275', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.1.274', '2.1.275')).toBe(false)
  expect(versionAtLeast('2.0.999', '2.1.275')).toBe(false)
  expect(versionAtLeast('2.2.0', '2.1.275')).toBe(true)
  expect(versionAtLeast('3.0.0', '2.1.275')).toBe(true)
  expect(versionAtLeast('1.99.999', '2.0.0')).toBe(false)
  expect(versionAtLeast('2.1.1000', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.1.331 (Claude Code)', '2.1.275')).toBe(true)
  expect(versionAtLeast('2.1.280-dev.20260920', '2.1.275')).toBe(true)
  expect(versionAtLeast('x', '2.1.275')).toBe(false)
  expect(versionAtLeast('', '2.1.275')).toBe(false)
  expect(versionAtLeast('2.1.331', 'x')).toBe(false)
  expect(versionAtLeast(hostile<string>(undefined), '2.1.275')).toBe(false)
  expect(versionAtLeast(hostile<string>(null), hostile<string>(undefined))).toBe(false)
})

test('formatLine: level and text on one line', () => {
  expect(formatLine({ level: 'PASS', text: 'all good' })).toBe('PASS all good')
  expect(formatLine({ level: 'WARN', text: '  two\n lines\tand   spaces ' })).toBe('WARN two lines and spaces')
  expect(formatLine({ level: 'FAIL', text: 'broken' })).toBe('FAIL broken')
  expect(formatLine({ level: 'PASS', text: '' })).toBe('PASS ')
  // broken lines still give a line
  expect(formatLine(hostile<Line>(undefined))).toBe('WARN ')
  expect(formatLine(hostile<Line>({ level: 'NOPE', text: 5 }))).toBe('WARN 5')
  expect(formatLine(hostile<Line>({ level: 'PASS' }))).toBe('PASS ')
})

test('countLevels and summaryLine', () => {
  const lines: Line[] = [
    { level: 'PASS', text: 'a' }, { level: 'PASS', text: 'b' }, { level: 'WARN', text: 'c' }, { level: 'FAIL', text: 'd' }, { level: 'PASS', text: 'e' },
  ]
  expect(countLevels(lines)).toEqual({ pass: 3, warn: 1, fail: 1 })
  expect(countLevels([])).toEqual({ pass: 0, warn: 0, fail: 0 })
  expect(countLevels(hostile<Line[]>(undefined))).toEqual({ pass: 0, warn: 0, fail: 0 })
  expect(countLevels(hostile<Line[]>([null, 1, {}, { level: 'PASS' }]))).toEqual({ pass: 1, warn: 0, fail: 0 })
  expect(summaryLine(lines, EN)).toBe('3 ok, 1 to look at, 1 broken.')
  expect(summaryLine(lines, VI)).toBe('3 ổn, 1 cần xem, 1 lỗi.')
  expect(summaryLine([], EN)).toBe('0 ok, 0 to look at, 0 broken.')
})

test('doctorLines: a machine where everything works gives seven passes, in English', () => {
  expect(text({})).toEqual([
    'PASS Claude Code 2.1.331 (needs 2.1.275 or later)',
    'PASS Node.js 22.4.0 found: snapshots can include binary and large files',
    'PASS Git 2.43.0 found',
    'PASS Snapshot folder /home/x/.claude/kit-safety/snapshots can be written to: 3 snapshots, 12 MB',
    'PASS The Node helper script answered: binary and large files are saved too',
    'PASS Options: asks before commands that delete, overwrite or rewrite history; masks secrets in tool results; language: English',
    'PASS Running in: terminal',
  ])
  expect(summaryLine(doctorLines(facts(), EN), EN)).toBe('7 ok, 0 to look at, 0 broken.')
})

test('doctorLines in Vietnamese', () => {
  expect(text({ language: 'vi' }, VI)).toEqual([
    'PASS Claude Code 2.1.331 (cần 2.1.275 trở lên)',
    'PASS Có Node.js 22.4.0: snapshot lưu được cả file nhị phân và file lớn',
    'PASS Có Git 2.43.0',
    'PASS Thư mục snapshot /home/x/.claude/kit-safety/snapshots ghi được: 3 snapshot, 12 MB',
    'PASS Script trợ giúp Node đã trả lời: file nhị phân và file lớn cũng được lưu',
    'PASS Tuỳ chọn: hỏi trước các lệnh xoá, ghi đè hoặc viết lại lịch sử; che bí mật trong kết quả của công cụ; ngôn ngữ: Tiếng Việt',
    'PASS Đang chạy trong: terminal',
  ])
})

test('doctorLines: the Claude Code version is a pass, a fail or a warning', () => {
  expect(text({ claudeVersion: '2.1.275' })[0]).toBe('PASS Claude Code 2.1.275 (needs 2.1.275 or later)')
  expect(text({ claudeVersion: '2.1.331 (Claude Code)' })[0]).toBe('PASS Claude Code 2.1.331 (needs 2.1.275 or later)')
  expect(text({ claudeVersion: '3.0.0' })[0]).toBe('PASS Claude Code 3.0.0 (needs 2.1.275 or later)')
  expect(text({ claudeVersion: '2.1.274' })[0]).toBe(
    'FAIL Claude Code 2.1.274 is older than 2.1.275, so parts of Safety Net may not run. A newer Claude Code turns them on.',
  )
  expect(text({ claudeVersion: '1.0.0' })[0]).toMatch(/^FAIL /)
  expect(text({ claudeVersion: '2.1.274' }, VI)[0]).toMatch(/^FAIL Claude Code 2\.1\.274 cũ hơn 2\.1\.275/)
  for (const v of [null, '', 'nonsense', '2.1', hostile<string>(undefined), hostile<string>(5)]) {
    expect(text({ claudeVersion: v })[0]).toBe(
      'WARN Could not tell which Claude Code version this is (needs 2.1.275 or later). Safety Net works as far as this version allows.',
    )
  }
  expect(text({ claudeVersion: null }, VI)[0]).toMatch(/^WARN Không xác định được phiên bản Claude Code/)
})

test('doctorLines: Node, Git and the helper script', () => {
  // no Node: a warning that says what still works, and no helper line at all
  for (const node of [null, '', '   ', hostile<string>(undefined), hostile<string>(22)]) {
    const lines = text({ node })
    expect(lines[1]).toBe('WARN Node.js not found: snapshots then save text files up to 3 MB; with Node they also save binary and large files')
    expect(lines).toHaveLength(6)
    expect(lines.some(l => l.includes('helper'))).toBe(false)
  }
  expect(text({ node: '22.4.0' })[1]).toBe('PASS Node.js 22.4.0 found: snapshots can include binary and large files')
  expect(text({ node: 'v18.20.4\n' })[1]).toBe('PASS Node.js 18.20.4 found: snapshots can include binary and large files')
  expect(text({ node: 'weird build' })[1]).toBe('PASS Node.js weird build found: snapshots can include binary and large files')
  // Git
  expect(text({ git: null })[2]).toBe('WARN Git not found: Safety Net still saves files, but not the Git snapshot')
  expect(text({ git: '' })[2]).toMatch(/^WARN Git not found/)
  expect(text({ git: '  ' })[2]).toMatch(/^WARN Git not found/)
  expect(text({ git: 'git version 2.39.5 (Apple Git-154)' })[2]).toBe('PASS Git 2.39.5 found')
  expect(text({ git: '2.43.0' })[2]).toBe('PASS Git 2.43.0 found')
  expect(text({ git: 'git version 2.50' })[2]).toBe('PASS Git 2.50 found')
  expect(text({ git: 'custom-git' })[2]).toBe('PASS Git custom-git found')
  expect(text({ git: null }, VI)[2]).toBe('WARN Không thấy Git: Safety Net vẫn lưu file, chỉ không chụp được trạng thái Git')
  // the helper
  expect(text({ helperAnswered: true })[4]).toBe('PASS The Node helper script answered: binary and large files are saved too')
  expect(text({ helperAnswered: false })[4]).toBe(
    'WARN The Node helper script did not answer: snapshots save text files up to 3 MB; with the helper they also save binary and large files',
  )
  expect(text({ helperAnswered: null })[4]).toBe('WARN The Node helper script has not been tried yet: until it answers, snapshots save text files up to 3 MB')
  expect(text({ helperAnswered: false }, VI)[4]).toMatch(/^WARN Script trợ giúp Node không trả lời/)
})

test('doctorLines: the snapshot folder', () => {
  expect(text({ snapshotCount: 0, snapshotBytes: 0 })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: no snapshots yet`)
  expect(text({ snapshotCount: 1, snapshotBytes: 2048 })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: 1 snapshot, 2 KB`)
  expect(text({ snapshotCount: 20, snapshotBytes: 1.5 * 1024 * MB })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: 20 snapshots, 1.5 GB`)
  expect(text({ snapshotCount: 3, snapshotBytes: null })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: 3 snapshots`)
  expect(text({ snapshotCount: 3, snapshotBytes: Number.NaN })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: 3 snapshots`)
  expect(text({ snapshotCount: Number.NaN })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: no snapshots yet`)
  expect(text({ snapshotCount: -4 })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: no snapshots yet`)
  expect(text({ snapshotCount: 2.9, snapshotBytes: 5 * MB })[3]).toBe(`PASS Snapshot folder ${DIR} can be written to: 2 snapshots, 5 MB`)
  expect(text({ snapshotCount: 1234, snapshotBytes: 5 * MB })[3]).toContain('1,234 snapshots')
  // a folder that cannot be written is the one FAIL, and says what still works
  expect(text({ isWritable: false })[3]).toBe(
    `FAIL Cannot write to ${DIR}: snapshots cannot be saved, but the questions and secret masking still work`,
  )
  expect(text({ isWritable: null })[3]).toBe(`WARN Snapshot folder ${DIR} could not be checked yet; it is made when the first snapshot is saved`)
  expect(text({ isWritable: false }, VI)[3]).toMatch(/^FAIL Không ghi được vào /)
  expect(text({ isWritable: null }, VI)[3]).toMatch(/^WARN Chưa kiểm tra được thư mục snapshot /)
  expect(text({ snapshotCount: 0 }, VI)[3]).toMatch(/chưa có snapshot nào$/)
  // an unknown folder name still reads, a hostile one is cleaned and a long one capped
  expect(text({ snapshotsDir: '' })[3]).toBe('PASS Snapshot folder ? can be written to: 3 snapshots, 12 MB')
  expect(text({ snapshotsDir: hostile<string>(undefined) })[3]).toMatch(/Snapshot folder \? /)
  const evil = text({ snapshotsDir: `/home/x${RLO}/${ZWSP}.claude${BLANKS}${NUL}\n${ESC}/${'d'.repeat(500)}` })[3] ?? ''
  expect(CONTROL_OR_INVISIBLE.test(evil)).toBe(false)
  expect(evil.length).toBeLessThan(400)
  expect(evil).toContain('/home/x/.claude')
})

test('doctorLines: the options in use', () => {
  const options = (f: Partial<DoctorFacts>, t = EN) => text(f, t)[5] ?? ''
  expect(options({ confirm: 'always' })).toBe(
    'PASS Options: asks before risky commands and before overwriting any file Git does not track; masks secrets in tool results; language: English',
  )
  expect(options({ confirm: 'never' })).toBe('PASS Options: never asks, but still saves a snapshot first; masks secrets in tool results; language: English')
  expect(options({ maskSecrets: false })).toBe(
    'PASS Options: asks before commands that delete, overwrite or rewrite history; does not mask secrets (turned off); language: English',
  )
  expect(options({ language: 'vi' })).toContain('language: Tiếng Việt')
  expect(options({ language: 'vi' }, VI)).toContain('ngôn ngữ: Tiếng Việt')
  expect(options({ language: 'en' }, VI)).toContain('ngôn ngữ: English')
  // a language that is not one of ours reads as English, even with a name that is also a property
  for (const language of ['fr', 'constructor', '__proto__', '', hostile<string>(undefined)]) expect(options({ language: hostile(language) })).toContain('language: English')
  // a `confirm` that is not one of the three is a warning, and says which choice is used
  expect(options({ confirm: 'sometimes' })).toBe(
    'WARN Options: "sometimes" is not one of risky, always or never, so it asks before risky commands; masks secrets in tool results; language: English',
  )
  expect(options({ confirm: '' })).toMatch(/^WARN Options: "" is not one of/)
  expect(options({ confirm: 'RISKY' })).toMatch(/^WARN /)
  expect(options({ confirm: hostile<string>(undefined) })).toMatch(/^WARN Options: "" is not one of/)
  expect(options({ confirm: hostile<string>(7) })).toMatch(/^WARN Options: "" is not one of/)
  const evil = options({ confirm: `ri${RLO}sky${NUL}${'x'.repeat(200)}` })
  expect(CONTROL_OR_INVISIBLE.test(evil)).toBe(false)
  expect(evil.length).toBeLessThan(300)
  expect(options({ confirm: 'sometimes' }, VI)).toMatch(/^WARN Tuỳ chọn: "sometimes" không phải risky, always hay never/)
  // maskSecrets that is not a boolean is read as the default, on
  expect(options({ maskSecrets: hostile<boolean>(undefined) })).toContain('masks secrets in tool results')
})

test('doctorLines: the surface', () => {
  expect(text({ surface: 'desktop' })[6]).toBe('PASS Running in: desktop')
  expect(text({ surface: null })[6]).toBe('PASS Where this session runs is not reported; nothing depends on it')
  expect(text({ surface: '' })[6]).toMatch(/not reported/)
  expect(text({ surface: hostile<string>(3) })[6]).toMatch(/not reported/)
  expect(text({ surface: 'mobile' }, VI)[6]).toBe('PASS Đang chạy trong: mobile')
  expect(text({ surface: `app${RLO}${NUL}${'x'.repeat(100)}` })[6]).toMatch(/^PASS Running in: app x{20,}…$/)
})

test('doctorLines: every combination of the facts gives lines that read and never throw', () => {
  const versions: (string | null)[] = ['2.1.331', '2.0.0', null]
  const nodes: (string | null)[] = ['v22.4.0', null]
  const gits: (string | null)[] = ['git version 2.43.0', null]
  const writable: (boolean | null)[] = [true, false, null]
  const helper: (boolean | null)[] = [true, false, null]
  const confirms = ['risky', 'always', 'never', 'odd']
  let combos = 0
  // Every combination is checked, but with plain conditions: a violation is written down and asserted once at the end. (One
  // `expect` per line and rule made this test 300 000 calls long, close to the kit's time limit on a slow machine.)
  const bad: string[] = []
  const levels = new Set(['PASS', 'WARN', 'FAIL'])
  for (const claudeVersion of versions) for (const node of nodes) for (const git of gits) for (const isWritable of writable) for (const helperAnswered of helper)
    for (const confirm of confirms) for (const maskSecrets of [true, false]) for (const language of ['en', 'vi'] as const) for (const surface of ['terminal', null]) {
      const f = facts({ claudeVersion, node, git, isWritable, helperAnswered, confirm, maskSecrets, language, surface })
      const where = JSON.stringify({ claudeVersion, node, git, isWritable, helperAnswered, confirm, maskSecrets, language, surface })
      for (const [name, t] of [['en', EN], ['vi', VI]] as const) {
        const lines = doctorLines(f, t)
        // helper line only where there is Node
        if (lines.length !== (node === null ? 6 : 7)) bad.push(`${name} ${where}: ${lines.length} lines`)
        for (const line of lines) {
          if (!levels.has(line.level)) bad.push(`${name} ${where}: level ${line.level}`)
          if (line.text.trim() !== line.text || line.text === '') bad.push(`${name} ${where}: untrimmed or empty "${line.text}"`)
          if (/undefined|NaN|\[object|\bnull\b/.test(line.text)) bad.push(`${name} ${where}: placeholder text in "${line.text}"`)
          if (line.text.includes('\n')) bad.push(`${name} ${where}: newline in "${line.text}"`)
        }
        // exactly the facts that are wrong are not passes
        const c = countLevels(lines)
        if (c.pass + c.warn + c.fail !== lines.length) bad.push(`${name} ${where}: counts do not add up`)
        if (c.fail !== (claudeVersion === '2.0.0' ? 1 : 0) + (isWritable === false ? 1 : 0)) bad.push(`${name} ${where}: ${c.fail} failures`)
        combos += 1
      }
    }
  expect(bad.slice(0, 5)).toEqual([])
  expect(combos).toBe(3 * 2 * 2 * 3 * 3 * 4 * 2 * 2 * 2 * 2)
})

test('doctorLines never tells the person to do something to keep using the plugin', () => {
  const worst = facts({ claudeVersion: '1.0.0', node: null, git: null, isWritable: false, helperAnswered: null, confirm: 'odd', surface: null })
  for (const t of [EN]) {
    for (const line of doctorLines(worst, t)) {
      expect(line.text).not.toMatch(/\b(you must|you need|please|install|run |set |fix)\b/i)
      expect(line.text).not.toMatch(/Fix:/)
    }
  }
  // every warning or failure says something still works or what is lost
  for (const line of doctorLines(worst, EN).filter(l => l.level !== 'PASS')) {
    expect(line.text).toMatch(/still|work|save|saves|made|asks|until|may not run/)
  }
})

test('doctorLines never throws on broken facts', () => {
  for (const f of [undefined, null, {}, 'facts', 5, [], { claudeVersion: 5, node: {}, git: [], snapshotsDir: 7, isWritable: 'yes', snapshotCount: 'x', snapshotBytes: 'y', confirm: null, language: 3, surface: {} }]) {
    for (const t of [EN, VI]) {
      const lines = doctorLines(hostile<DoctorFacts>(f), t)
      expect(lines.length).toBeGreaterThanOrEqual(6)
      for (const line of lines) {
        expect(line.text === '').toBe(false)
        expect(/undefined|NaN|\[object|\bnull\b/.test(line.text)).toBe(false)
      }
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// All snapshots of all projects, against the total cap

const GB = 1024 * MB
/** The facts of a machine with `count` snapshots taking `bytes` in all, and a cap of `maxTotalMB`. */
const total = (count: number, bytes: number, maxTotalMB = 2048, over: Partial<DoctorFacts> = {}): Partial<DoctorFacts> => ({ allCount: count, allBytes: bytes, maxTotalMB, ...over })

test('doctorLines: one more line says how many snapshots all projects hold and what they take against the total cap', () => {
  const lines = text(total(12, 340 * MB))
  expect(lines).toEqual([
    'PASS Claude Code 2.1.331 (needs 2.1.275 or later)',
    'PASS Node.js 22.4.0 found: snapshots can include binary and large files',
    'PASS Git 2.43.0 found',
    'PASS Snapshot folder /home/x/.claude/kit-safety/snapshots can be written to: 3 snapshots, 12 MB',
    'PASS 12 snapshots in all projects, 340 MB of the 2 GB they may take together',
    'PASS The Node helper script answered: binary and large files are saved too',
    'PASS Options: asks before commands that delete, overwrite or rewrite history; masks secrets in tool results; language: English',
    'PASS Running in: terminal',
  ])
  expect(summaryLine(doctorLines(facts(total(12, 340 * MB)), EN), EN)).toBe('8 ok, 0 to look at, 0 broken.')
  expect(text(total(12, 340 * MB), VI)[4]).toBe('PASS 12 snapshot ở mọi dự án, 340 MB (tối đa 2 GB cho tất cả)')
  expect(text(total(1, 2048, 100))[4]).toBe('PASS 1 snapshot in all projects, 2 KB of the 100 MB they may take together')
  expect(text(total(0, 0))[4]).toBe('PASS No snapshots in any project yet; all of them together may take up to 2 GB')
  expect(text(total(0, 0), VI)[4]).toBe('PASS Chưa có snapshot nào ở bất kỳ dự án nào; tất cả cộng lại được chiếm tối đa 2 GB')
  expect(text(total(1500, 1.5 * GB, 20000))[4]).toBe('PASS 1,500 snapshots in all projects, 1.5 GB of the 20 GB they may take together')
})

test('doctorLines: over the cap is a warning that says the oldest go at the next session start; at the cap it is a pass', () => {
  const at = (bytes: number, maxTotalMB = 2048) => text(total(40, bytes, maxTotalMB))[4] ?? ''
  expect(at(2048 * MB)).toMatch(/^PASS 40 snapshots in all projects, 2 GB of the 2 GB/)
  expect(at(2048 * MB + 1)).toMatch(/^WARN /)
  expect(at(3 * GB)).toBe('WARN 40 snapshots in all projects, 3 GB: over the 2 GB they may take together, so the oldest are deleted when the next session starts')
  expect(text(total(40, 3 * GB), VI)[4]).toBe('WARN 40 snapshot ở mọi dự án, 3 GB: vượt mức tối đa 2 GB cho tất cả, nên các snapshot cũ nhất sẽ bị xoá khi phiên sau bắt đầu')
  expect(at(100 * MB, 100)).toMatch(/^PASS /)
  expect(at(101 * MB, 100)).toMatch(/^WARN /)
  // it is a warning like any other: counted, and nothing else changes
  expect(summaryLine(doctorLines(facts(total(40, 3 * GB)), EN), EN)).toBe('7 ok, 1 to look at, 0 broken.')
  const line = doctorLines(facts(total(40, 3 * GB)), EN)[4]!
  expect(line.text).not.toMatch(/\b(you must|you need|please|install|run |set |fix)\b/i)
})

test('doctorLines: a count that stopped early says "at least"', () => {
  expect(text(total(1500, 900 * MB, 2048, { allIsCut: true }))[4]).toBe('PASS At least 1,500 snapshots in all projects, 900 MB of the 2 GB they may take together')
  expect(text(total(1500, 3 * GB, 2048, { allIsCut: true }))[4]).toMatch(/^WARN At least 1,500 snapshots in all projects, 3 GB: over the 2 GB/)
  expect(text(total(1500, 900 * MB, 2048, { allIsCut: true }), VI)[4]).toBe('PASS Ít nhất 1.500 snapshot ở mọi dự án, 900 MB (tối đa 2 GB cho tất cả)')
  // only `true` counts
  for (const odd of [false, 1, 'yes', null, undefined]) expect(text(total(5, MB, 2048, { allIsCut: hostile(odd) }))[4]).not.toMatch(/At least/)
})

test('doctorLines: the total line is left out when its facts are not there or are not numbers, and never prints a hole', () => {
  const plain = text({})
  expect(plain).toHaveLength(7)
  for (const f of [
    { allCount: 3 }, { allBytes: MB }, { maxTotalMB: 2048 }, { allCount: 3, allBytes: MB }, { allCount: 3, maxTotalMB: 2048 },
    { allCount: Number.NaN, allBytes: MB, maxTotalMB: 2048 }, { allCount: 3, allBytes: Number.NaN, maxTotalMB: 2048 },
    { allCount: 3, allBytes: MB, maxTotalMB: 0 }, { allCount: 3, allBytes: MB, maxTotalMB: -5 }, { allCount: 3, allBytes: MB, maxTotalMB: Number.NaN },
    { allCount: 3, allBytes: MB, maxTotalMB: Number.POSITIVE_INFINITY }, { allCount: Number.POSITIVE_INFINITY, allBytes: MB, maxTotalMB: 2048 },
    { allCount: hostile<number>('3'), allBytes: MB, maxTotalMB: 2048 }, { allCount: 3, allBytes: hostile<number>(null), maxTotalMB: 2048 },
  ] as Partial<DoctorFacts>[]) {
    expect(text(f)).toEqual(plain)
  }
  // a count or size that is odd but a number is read as the nearest sensible one
  expect(text(total(-4, 5 * MB))[4]).toMatch(/^PASS No snapshots in any project yet/)
  expect(text(total(2.9, -5))[4]).toBe('PASS 2 snapshots in all projects, 0 B of the 2 GB they may take together')
  for (const f of [total(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 20000), total(5, 1e300, 100), total(0, 1e300, 100)]) {
    for (const t of [EN, VI]) for (const line of doctorLines(facts(f), t)) expect(/undefined|NaN|\[object|\bnull\b|Infinity/.test(line.text)).toBe(false)
  }
})

// ---- counting them on the machine ----

const NOW = 1_800_000_000_000
const ROOT_A = '/work/acme-shop'
const ROOT_B = '/work/other-shop'
const SNAPS = '/home/x/.claude/kit-safety/snapshots'

/** An IO over a map of files, with just what the count calls (list, stat, readText, now). `clock` is what `now` answers; it can move on each call. */
function memIO(files: Map<string, string>, clock: () => number = () => NOW): IO {
  const children = (dir: string) => {
    const prefix = `${dir.replace(/\/$/, '')}/`
    const seen = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue
      const head = key.slice(prefix.length).split('/')
      seen.set(head[0]!, head.length === 1 ? 'file' : 'dir')
    }
    return seen
  }
  return {
    list: async (dir: string) => [...children(dir)].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    stat: async (path: string) => (files.has(path) ? { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false } : children(path).size > 0 ? { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } : null),
    readText: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    now: () => clock(),
  } as unknown as IO
}

/** A snapshot of `root` as the vault leaves it: its manifest in `<snapshots>/<project key>/<id>/`, taking `bytes`. */
function put(files: Map<string, string>, root: string, id: string, bytes: number, over: { pruned?: boolean; id?: string } = {}): void {
  const m = buildManifest(
    { v: 1, id: over.id ?? id, n: 1, createdAt: NOW, root, kind: 'before-command', tool: 'Bash', risks: [{ kind: 'delete', label: 'rm -rf' }], targets: ['out'], backend: 'fs' },
    { files: [{ rel: 'out/a.txt', size: bytes, mtimeMs: 1 }], dirs: [], skipped: [] },
  )
  const dir = snapshotDir(SNAPS, projectKey(root), id)
  files.set(`${dir}/manifest.json`, serializeManifest(m))
  if (over.pruned) files.set(`${dir}/pruned`, 'pruned\n')
}

const envOf = (files: Map<string, string>, clock?: () => number): VaultEnv => ({ io: memIO(files, clock), snapshotsRoot: SNAPS, helper: '/plugin/scripts/safety-fs.mjs' })

test('countAllSnapshots: every project of the snapshot folder, what the manifests say they take', async () => {
  const files = new Map<string, string>()
  put(files, ROOT_A, '20261124T140512Z', 1000)
  put(files, ROOT_A, '20261124T140600Z', 2000)
  put(files, ROOT_B, '20261124T150000Z', 5000)
  expect(await countAllSnapshots(envOf(files))).toEqual({ count: 3, bytes: 8000, isCut: false })
  expect(await countAllSnapshots(envOf(new Map()))).toEqual({ count: 0, bytes: 0, isCut: false })
})

test('countAllSnapshots: a deleted (marked), damaged, foreign or misnamed snapshot is not counted; a file or odd folder name is not looked at', async () => {
  const files = new Map<string, string>()
  put(files, ROOT_A, '20261124T140512Z', 1000)
  put(files, ROOT_A, '20261124T140600Z', 2000, { pruned: true })
  files.set(`${snapshotDir(SNAPS, projectKey(ROOT_A), '20261124T140700Z')}/manifest.json`, '{ not json')
  files.set(`${snapshotDir(SNAPS, projectKey(ROOT_A), '20261124T140800Z')}/files/x.txt`, 'no manifest at all')
  // a manifest that says it belongs to another snapshot id or another project
  put(files, ROOT_A, '20261124T140900Z', 4000, { id: '20261124T999999Z' })
  const foreign = snapshotDir(SNAPS, projectKey(ROOT_A), '20261124T141000Z')
  files.set(`${foreign}/manifest.json`, files.get(`${snapshotDir(SNAPS, projectKey(ROOT_B), '20261124T150000Z')}/manifest.json`) ?? '')
  put(files, ROOT_B, '20261124T150000Z', 300)
  files.set(`${SNAPS}/.doctor`, 'ok again\n')
  files.set(`${SNAPS}/not a project/20261124T140512Z/manifest.json`, '{}')
  files.set(`${snapshotDir(SNAPS, projectKey(ROOT_A), 'notes')}/manifest.json`, '{}')
  expect(await countAllSnapshots(envOf(files))).toEqual({ count: 2, bytes: 1300, isCut: false })
})

test('countAllSnapshots: it stops at the limit it is given and says so; a clock that runs out stops it too', async () => {
  const files = new Map<string, string>()
  for (let i = 0; i < 6; i += 1) put(files, ROOT_A, `20261124T14051${i}Z`, 100)
  expect(await countAllSnapshots(envOf(files), { manifests: 4 })).toEqual({ count: 4, bytes: 400, isCut: true })
  expect(await countAllSnapshots(envOf(files), { manifests: 6 })).toEqual({ count: 6, bytes: 600, isCut: false })
  expect(await countAllSnapshots(envOf(files), { manifests: 0 })).toEqual({ count: 0, bytes: 0, isCut: true })
  // every look at the clock is a second later: 2 s of budget allows a few manifests, and the count says it is a lower bound
  let t = NOW
  const slow = await countAllSnapshots(envOf(files, () => (t += 1000)), { budgetMs: 2500 })
  expect(slow?.isCut).toBe(true)
  expect(slow?.count).toBeGreaterThan(0)
  expect(slow?.count).toBeLessThan(6)
})

test('countAllSnapshots is total: a folder that is not usable, a failing IO or odd limits give null or a plain answer, never an exception', async () => {
  expect(await countAllSnapshots({ ...envOf(new Map()), snapshotsRoot: '' })).toBeNull()
  expect(await countAllSnapshots({ ...envOf(new Map()), snapshotsRoot: 'relative/path' })).toBeNull()
  expect(await countAllSnapshots({ ...envOf(new Map()), snapshotsRoot: hostile<string>(undefined) })).toBeNull()
  expect(await countAllSnapshots(hostile<VaultEnv>(undefined))).toBeNull()
  const broken = { ...envOf(new Map()), io: { list: () => Promise.reject(new Error('EIO')), now: () => NOW } as unknown as IO }
  expect(await countAllSnapshots(broken)).toBeNull()
  const files = new Map<string, string>()
  put(files, ROOT_A, '20261124T140512Z', 1000)
  for (const manifests of [Number.NaN, -3, Number.POSITIVE_INFINITY, hostile<number>('2'), hostile<number>(null)]) {
    expect((await countAllSnapshots(envOf(files), { manifests }))?.count).toBeLessThanOrEqual(1)
  }
  // a read that fails for one snapshot does not stop the others
  const flaky = new Map(files)
  put(flaky, ROOT_B, '20261124T150000Z', 50)
  const env = envOf(flaky)
  const readText = env.io.readText.bind(env.io)
  env.io.readText = (path: string) => (path.includes(projectKey(ROOT_A)) ? Promise.reject(new Error('EIO')) : readText(path))
  expect(await countAllSnapshots(env)).toEqual({ count: 1, bytes: 50, isCut: false })
})
