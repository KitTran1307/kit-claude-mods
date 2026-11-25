import { describe, expect, test } from 'claude-code/testing'

import { classifyBash, commandCount, splitCommands } from './risk'
import type { BashContext } from './risk'
import type { Risk, RiskKind } from './types'
import { CTX, timed } from '../tests/risk-helpers'

// The Bash classifier (risk.ts): the parser limits fail closed (a command cut by a limit is asked about, never waved through), and the
// limits of find, git-erase, wrangler and commandCount on big inputs. Sizes tied to a limit stay; the rest is 256 KB.

// ---------------------------------------------------------------------------------------------------------------------
describe('parser limits fail closed', () => {
  const unparsedCount = (cmd: string, ctx: BashContext = CTX): number => classifyBash(cmd, ctx).filter(r => r.kind === 'unparsed').length
  const lastKind = (cmd: string, ctx: BashContext = CTX): string | undefined => classifyBash(cmd, ctx).at(-1)?.kind
  const nest = (n: number): string => {
    let s = 'rm -rf x'
    for (let i = 0; i < n; i++) s = `bash -c ${JSON.stringify(s)}`
    return s
  }
  const padded = (extra: number): string => ': ; '.repeat(extra) + 'rm -rf build'
  const names = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

  test('the unparsed risk has one fixed shape', () => {
    expect(classifyBash(padded(2500), CTX).at(-1)).toEqual({ kind: 'unparsed', tier: 'ask', label: 'long command', paths: [] })
  })

  // Each one used to return no risk at all, with `rm -rf build` or a force push as the last command.
  const hidden: Array<[string, string]> = [
    ['2001 simple commands before the rm', padded(2001)],
    ['5000 simple commands before the rm', padded(5000)],
    ['129 pass-through wrappers', 'nohup '.repeat(129) + 'rm -rf build'],
    ['200 sudo', 'sudo '.repeat(200) + 'rm -rf build'],
    ['200 env -C', 'env -C a '.repeat(200) + 'rm -rf build'],
    ['$( nested 70 deep', '$('.repeat(70) + 'rm -rf build' + ')'.repeat(70)],
    ['{ nested 70 deep', '{ '.repeat(70) + 'rm -rf build' + '; }'.repeat(70)],
    ['( nested 70 deep', '( '.repeat(70) + 'rm -rf build' + ' )'.repeat(70)],
    ['bash -c nested 7 deep', nest(7)],
    ['bash -c nested 9 deep', nest(9)],
    ['xargs nested 8 deep', 'xargs '.repeat(8) + 'rm -rf build'],
    ['find -exec find nested 8 deep', 'find . -exec '.repeat(8) + 'rm -rf {} +'],
    ['rm with 50,001 words, flags last', 'rm ' + names(50001) + ' -rf build'],
    ['git push with 50,001 words, --force last', 'git push origin ' + names(50001) + ' --force'],
    ['psql with 1,000,001 filler characters', 'psql -c "' + 'x'.repeat(1_000_001) + ' drop table users"'],
    ['mysql with a very long statement', 'mysql -e "' + 'x'.repeat(1_100_000) + '; drop database shop"'],
    ['here-doc body with $( after the budget ran out', ': ; '.repeat(1999) + 'cat <<EOF\n$(rm -rf build)\nEOF'],
    ['a command in `bash -c` after the budget ran out', ': ; '.repeat(1999) + "bash -c 'rm -rf build'"],
  ]
  test('padding past any limit is asked about, never waved through', { timeoutMs: 30_000 }, () => {
    const bad: string[] = []
    for (const [why, cmd] of hidden) {
      const got = classifyBash(cmd, CTX)
      if (got.at(-1)?.kind !== 'unparsed' || got.filter(r => r.kind === 'unparsed').length !== 1) bad.push(`${why}: ${got.map(r => r.kind).join(',')}`)
    }
    expect(bad).toEqual([])
  })

  // The same commands, one step inside the raised limits: the real risk is found, nothing is unparsed.
  const within: Array<[string, string, RiskKind]> = [
    ['1,998 simple commands before the rm', padded(1998), 'delete'],
    ['exactly 2,000 simple commands', padded(1999), 'delete'],
    ['500 simple commands before the rm', padded(500), 'delete'],
    ['120 pass-through wrappers', 'nohup '.repeat(120) + 'rm -rf build', 'delete'],
    ['127 wrappers', 'nohup '.repeat(127) + 'rm -rf build', 'delete'],
    ['sudo env time nice nohup mixed 100 deep', 'sudo env time nice nohup '.repeat(20) + 'rm -rf build', 'delete'],
    ['$( nested 60 deep', '$('.repeat(60) + 'rm -rf build' + ')'.repeat(60), 'delete'],
    ['{ nested 60 deep', '{ '.repeat(60) + 'rm -rf build' + '; }'.repeat(60), 'delete'],
    ['( nested 60 deep', '( '.repeat(60) + 'rm -rf build' + ' )'.repeat(60), 'delete'],
    ['bash -c nested 5 deep', nest(5), 'delete'],
    ['bash -c nested 6 deep', nest(6), 'delete'],
    ['rm with 40,000 words, flags last', 'rm ' + names(40000) + ' -rf build', 'delete'],
    ['git push with 40,000 words, --force last', 'git push origin ' + names(40000) + ' --force', 'force-push'],
    ['psql with 900,000 filler characters', 'psql -c "' + 'x'.repeat(900_000) + ' drop table users"', 'db-drop'],
  ]
  test('the same commands inside the raised limits are still read to the end', { timeoutMs: 30_000 }, () => {
    const bad: string[] = []
    for (const [why, cmd, kind] of within) {
      const got = classifyBash(cmd, CTX)
      if (got.some(r => r.kind === 'unparsed') || !got.some(r => r.kind === kind)) bad.push(`${why}: ${got.map(r => r.kind).join(',')}`)
    }
    expect(bad).toEqual([])
  })

  test('the risk behind padding keeps its own shape next to the unparsed one', () => {
    const got = classifyBash(': ; '.repeat(2000) + 'rm -rf build; ' + 'git push -f origin main', CTX)
    expect(got.map(r => r.kind)).toEqual(['unparsed'])
    const early = classifyBash('rm -rf build; ' + ': ; '.repeat(3000) + 'git push -f origin main', CTX)
    expect(early.map(r => r.kind)).toEqual(['delete', 'unparsed'])
    expect(early[0]?.paths).toEqual(['build'])
    const both = classifyBash('git reset --hard; rm -rf a; ' + 'nohup '.repeat(200) + 'rm -rf b', CTX)
    expect(both.map(r => r.kind)).toEqual(['reset-hard', 'delete', 'unparsed'])
  })

  test('never more than one unparsed, however many limits trip', { timeoutMs: 30_000 }, () => {
    const cmd = [padded(3000), 'nohup '.repeat(300) + 'x', '$('.repeat(100), nest(9), 'rm ' + names(60000), 'psql -c "' + 'x'.repeat(1_100_000) + '"'].join('\n')
    expect(unparsedCount(cmd)).toBe(1)
    expect(lastKind(cmd)).toBe('unparsed')
  })

  test('ordinary long input is not unparsed', { timeoutMs: 30_000 }, () => {
    const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n')
    const heredoc = `cat <<EOF > notes.txt\n${'a line of ordinary text, nothing to see\n'.repeat(500)}EOF`
    const rows: Array<[string, string, RiskKind[]]> = [
      ['a 600-command script', lines(600, i => `echo step ${i}`), []],
      ['a 600-command script ending in a delete', lines(600, i => `echo step ${i}`) + '\nrm -rf build', ['delete']],
      ['a 600-command script with `&&` chains', lines(600, i => `mkdir -p d${i} && ls d${i}`), []],
      ['a 20,000-character here-doc', heredoc, []],
      ['a 20,000-character here-doc, then a delete', heredoc + '\nrm -rf build', ['delete']],
      ['a here-doc with a few substitutions', `cat <<EOF\n${'now: $(date)\n'.repeat(50)}EOF\nrm -rf build`, ['delete']],
      ['a 20,000-character quoted string', `echo "${'x'.repeat(20000)}" && rm -rf build`, ['delete']],
      ['a 500,000-character double-quoted string', `echo "${'x y '.repeat(125000)}" && rm -rf build`, ['delete']],
      ['a 500,000-character single-quoted string', `echo '${'x y '.repeat(125000)}' && rm -rf build`, ['delete']],
      ['a long commit message', `git commit -m "${'fix a thing. '.repeat(5000)}"`, []],
      ['a long commit message from a here-doc', `git commit -m "$(cat <<'EOF'\n${'fix a thing.\n'.repeat(3000)}EOF\n)"`, []],
      ['a long pipeline', 'cat f' + ' | grep x'.repeat(300), []],
      ['a long argument list', 'echo ' + names(20000), []],
      ['a long rm list', 'rm -rf ' + names(20000), ['delete']],
      ['a long psql script on the command line', 'psql -c "' + 'select 1; '.repeat(50000) + '"', []],
      ['nesting a script can have', 'echo $(echo $(echo $(echo $(echo $(echo $(ls))))))', []],
      ['a function with a long body', 'f() {\n' + lines(300, i => `  echo ${i}`) + '\n}\nf', []],
      ['a long comment', '# ' + 'x'.repeat(100000) + '\nrm -rf build', ['delete']],
      ['a very long word', 'echo ' + 'x'.repeat(500000), []],
      ['a very long path', 'ls ' + 'a/'.repeat(100000), []],
    ]
    const bad: string[] = []
    for (const [why, cmd, kinds] of rows) {
      const got = classifyBash(cmd, CTX).map(r => r.kind)
      if (JSON.stringify(got) !== JSON.stringify(kinds)) bad.push(`${why}: ${got.join(',') || 'none'}`)
    }
    expect(bad).toEqual([])
  })

  // Each case: what it is, the command, and whether a limit must trip (exactly one `unparsed`) or not (none).
  type Hostile = Array<[why: string, cmd: string, cut: boolean]>
  const runHostile = (cases: Hostile): void => {
    const bad: string[] = []
    for (const [why, cmd, cut] of cases) {
      const t0 = Date.now()
      const got = classifyBash(cmd, CTX)
      const ms = Date.now() - t0
      if (ms > 1500) bad.push(`${why}: ${ms} ms`)
      if (got.filter(r => r.kind === 'unparsed').length !== (cut ? 1 : 0)) bad.push(`${why}: unparsed x${got.filter(r => r.kind === 'unparsed').length}`)
    }
    expect(bad).toEqual([])
  }
  const MB = 1 << 20 // past the 1,000,000 characters of SQL that are read
  const BIG = 1 << 18 // 256 KB: a scan that is quadratic would need minutes at this size

  test('hostile padding, nesting and wrappers: fast, and unparsed when cut', { timeoutMs: 30_000 }, () => {
    runHostile([
      ['256 KB of ": ; "', ': ; '.repeat(BIG / 4), true],
      ['256 KB of "a;"', 'a;'.repeat(BIG / 2), true],
      ['256 KB of "a\\n"', 'a\n'.repeat(BIG / 2), true],
      ['10k nested $(', '$('.repeat(10000) + 'rm -rf build' + ')'.repeat(10000), true],
      ['10k nested (', '( '.repeat(10000) + 'rm -rf build' + ' )'.repeat(10000), true],
      ['10k nested {', '{ '.repeat(10000) + 'rm -rf build' + '; }'.repeat(10000), true],
      ['10k nested "$(', '"$('.repeat(10000), true],
      ['10k nohup', 'nohup '.repeat(10000) + 'rm -rf build', true],
      ['10k sudo', 'sudo '.repeat(10000) + 'rm -rf x', true],
      ['10k env -C', 'env -C a '.repeat(10000) + 'rm -rf x', true],
      ['10k xargs', 'xargs '.repeat(10000) + 'rm -rf x', true],
      ['10k find -exec', 'find . -exec '.repeat(10000) + 'rm {} +', true],
      ['256 KB of "bash -c a;"', 'bash -c a;'.repeat(BIG / 10), true],
      ['10k su -c', 'su -c '.repeat(10000) + 'x', false],
    ])
  })

  test('hostile words, strings, here-docs and redirects: fast, and unparsed when cut', { timeoutMs: 30_000 }, () => {
    runHostile([
      ['25k start paths and 25k {}', 'find ' + 'a '.repeat(25000) + '-exec rm ' + '{} '.repeat(25000) + '+', true],
      ['200k rm words', 'rm -rf ' + 'a '.repeat(100_000), true],
      ['200k git push words', 'git push --force ' + 'a '.repeat(100_000), true],
      ['1 MB psql string', 'psql -c "' + 'x'.repeat(MB + 10) + ' DROP TABLE t"', true],
      ['here-doc with 256 KB of $()', 'cat <<EOF\n' + '$()'.repeat(BIG / 3) + '\nEOF', false],
      ['here-doc with 200 KB of $(a)', 'cat <<EOF\n' + '$(a)'.repeat(50_000) + '\nEOF', true],
      ['100 KB of redirects', 'echo ' + '>.env '.repeat(20_000), true],
    ])
  })

  test('a stack overflow or any throw inside is not a pass either', () => {
    // 500,000 empty substitutions inside one here-doc body used to spread into one huge push(...) call
    const got = classifyBash('cat <<EOF\n' + '$()'.repeat(500_000) + '\nEOF\nrm -rf build', CTX)
    expect(got.some(r => r.kind === 'delete')).toBe(true)
  })

  test('limits do not change what splitCommands returns for ordinary lines', () => {
    expect(splitCommands(padded(1998)).length).toBe(1999)
    expect(splitCommands(padded(1998)).at(-1)).toEqual(['rm', '-rf', 'build'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('find: every delete form, and when the files are picked by a filter', () => {
  describe('match: the first name pattern of the filter', () => {
    test('hostile find: fast, and a match is still read', { timeoutMs: 30_000 }, () => {
      timed('256 KB pattern', () => expect(classifyBash(`find . -name '${'x'.repeat(1 << 18)}' -delete`, CTX)[0]?.match).toBe('x'.repeat(60)))
      timed('256 KB of invisible characters', () => expect(classifyBash(`find . -name '${'\u202e'.repeat(1 << 18)}' -delete`, CTX)[0]?.match).toBeUndefined())
      timed('20k -name tests', () => expect(classifyBash('find . ' + '-name x '.repeat(10000) + '-delete', CTX)[0]?.match).toBe('x'))
      timed('5k excluded -name tests', () => expect(classifyBash('find . ' + '-name x -prune -o '.repeat(5000) + '-delete', CTX).map(r => [r.kind, r.match])).toEqual([['delete', undefined]]))
      timed('10k negated -name tests', () => expect(classifyBash('find . ' + '! -name x '.repeat(10000) + '-delete', CTX).map(r => [r.kind, r.match])).toEqual([['delete', undefined]]))
      timed('one name test then 20k predicates', () => expect(classifyBash('find . -name x ' + '-type f '.repeat(10000) + '-delete', CTX)[0]?.match).toBe('x'))
      timed('100k -o', () => expect(classifyBash('find . ' + '-o '.repeat(100000) + '-name x -delete', CTX).map(r => r.kind)).toEqual(['unparsed']))
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('git-erase: Git\'s own safety nets', () => {
  describe('hostile input', () => {
    test('fast, total, and a limit says so', { timeoutMs: 30_000 }, () => {
      const MB = 1 << 20
      timed('5k stash drops', () => expect(classifyBash('git stash drop;'.repeat(5000), CTX).map(r => r.kind)).toEqual(['git-erase', 'unparsed']))
      timed('10k -m', () => expect(classifyBash('git update-ref ' + '-m '.repeat(10000), CTX)).toEqual([]))
      timed('10k -d', () => expect(classifyBash('git update-ref ' + '-d '.repeat(10000), CTX).map(r => r.kind)).toEqual(['git-erase']))
      timed('10k --expire', () => expect(classifyBash('git reflog expire ' + '--expire '.repeat(10000), CTX)).toEqual([]))
      timed('10k --expire=now', () => expect(classifyBash('git reflog expire --all ' + '--expire=now '.repeat(10000), CTX).map(r => r.kind)).toEqual(['git-erase']))
      timed('10k --prune=', () => expect(classifyBash('git gc ' + '--prune= '.repeat(10000), CTX)).toEqual([]))
      timed('one huge word', () => expect(classifyBash('git gc --prune=' + 'x'.repeat(MB / 4), CTX)).toEqual([]))
      timed('one huge word with a long value', () => expect(classifyBash('git reflog expire --all --expire=' + 'x'.repeat(MB / 4), CTX).map(r => r.kind)).toEqual(['git-erase']))
      timed('the flag past the word limit is not read, and that is said', () => expect(classifyBash('git gc ' + 'a '.repeat(60000) + '--prune=now', CTX).map(r => r.kind)).toEqual(['unparsed']))
      timed('nested wrappers', () => expect(classifyBash('sudo '.repeat(100) + 'git stash drop', CTX).map(r => r.kind)).toEqual(['git-erase']))
    })
    test('odd forms never throw', () => {
      for (const cmd of ['git stash', 'git stash drop', 'git update-ref', 'git reflog', 'git reflog expire', 'git gc', 'git stash ""', 'git gc --prune=', 'git gc --=now', 'git gc =now',
        'git reflog expire --expire=', 'git reflog expire --expire', 'git reflog expire --', 'git reflog expire -', 'git update-ref -', 'git update-ref -m', 'git update-ref --', 'git stash \u0000',
        'git reflog \u202eexpire --expire=now --all']) {
        expect(Array.isArray(classifyBash(cmd, CTX)), cmd).toBe(true)
      }
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('wrangler d1 execute: SQL on the command line', () => {
  const W = 'wrangler d1 execute'
  describe('label and hostile input', () => {
    test('fast and total on huge or odd input', { timeoutMs: 30_000 }, () => {
      const MB = 1 << 20
      const N = 200_000 // under the SQL limit (1,000,000): the whole text is read
      const run = (sql: string): Risk[] => classifyBash(`${W} shop --command "${sql}"`, CTX)
      timed('1 MB of "drop " is past the limit: said so', () => expect(run('drop '.repeat(MB / 5)).map(r => r.kind)).toEqual(['unparsed']))
      timed('long sql, then a drop past the limit: said so', () => expect(run('x'.repeat(1_000_001) + ' DROP TABLE t').map(r => r.kind)).toEqual(['unparsed']))
      timed('900k filler, then a drop (just under the limit)', () => expect(run('x'.repeat(900_000) + ' DROP TABLE t').map(r => r.kind)).toEqual(['db-drop']))
      timed('200 KB of "drop "', () => expect(run('drop '.repeat(N / 5)).map(r => r.kind)).toEqual([]))
      timed('200 KB of "delete "', () => expect(run('delete '.repeat(N / 7)).map(r => r.kind)).toEqual([]))
      timed('200 KB of "delete   "', () => expect(run('delete   '.repeat(N / 9)).map(r => r.kind)).toEqual([]))
      timed('drop and 200 KB of spaces', () => expect(run('drop' + ' '.repeat(N)).map(r => r.kind)).toEqual([]))
      timed('delete and 200 KB of spaces', () => expect(run('delete' + ' '.repeat(N) + 'x').map(r => r.kind)).toEqual([]))
      timed('truncate and 200 KB of spaces', () => expect(run('truncate' + ' '.repeat(N) + '(').map(r => r.kind)).toEqual([]))
      timed('200 KB of /*', () => expect(run('/*'.repeat(N / 2)).map(r => r.kind)).toEqual([]))
      timed('200 KB of --', () => expect(run('--'.repeat(N / 2)).map(r => r.kind)).toEqual([]))
      timed('200 KB of /**/', () => expect(run('/**/'.repeat(N / 4)).map(r => r.kind)).toEqual([]))
      timed('200 KB of comments around a drop', () => expect(run('/**/'.repeat(N / 8) + 'DROP/**/TABLE t').map(r => r.kind)).toEqual(['db-drop']))
      timed('200 KB of "-- \\n"', () => expect(run('-- x\n'.repeat(N / 5) + 'select 1').map(r => r.kind)).toEqual([]))
      timed('10k commands', () => expect(classifyBash(`${W} shop --command "DROP TABLE t";`.repeat(10000), CTX).map(r => r.kind)).toEqual(['db-drop', 'unparsed']))
      timed('10k --command words', () => expect(classifyBash(`${W} shop ` + '--command '.repeat(10000), CTX).map(r => r.kind)).toEqual([]))
      timed('105k --command words are cut, and say so', () => expect(classifyBash(`${W} shop ` + '--command '.repeat(MB / 10), CTX).map(r => r.kind)).toEqual(['unparsed']))
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('commandCount', () => {
  test('counts past the cap of splitCommands, and stops at 100,000', () => {
    expect(commandCount('a;'.repeat(5000))).toBe(5000)
    expect(commandCount('rm -rf x;'.repeat(3000))).toBe(3000)
    timed('300 KB of commands', () => expect(commandCount('a;'.repeat(150_000))).toBe(100000))
  })
  test('odd input is total and quick', () => {
    expect(commandCount(undefined as unknown as string)).toBe(0)
    expect(commandCount(null as unknown as string)).toBe(0)
    expect(commandCount(42 as unknown as string)).toBe(0)
    timed('256 KB of ;', () => expect(commandCount(';'.repeat(1 << 18))).toBe(0))
    timed('10k $(', () => commandCount('$('.repeat(10000) + 'x' + ')'.repeat(10000)))
    timed('10k (', () => commandCount('('.repeat(10000)))
    timed('300 KB of "$(a "', () => commandCount('$(a "'.repeat(1 << 16)))
  })
})
