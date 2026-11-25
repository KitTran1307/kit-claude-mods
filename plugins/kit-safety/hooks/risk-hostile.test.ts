import { describe, expect, test } from 'claude-code/testing'

import { classifyBash } from './risk'
import type { BashContext } from './risk'
import type { Risk } from './types'
import { ROOT, CTX, WIN, timed } from '../tests/risk-helpers'

// The Bash classifier (risk.ts) on hostile input: empty, odd and huge text never throws, stays fast and every risk is well formed.
// 256 KB is enough to show linear time (a quadratic scan of it takes minutes); the SQL past its limit keeps a size over that limit.

// ---------------------------------------------------------------------------------------------------------------------
describe('hostile input', () => {
  const SIZE = 1 << 18 // 256 KB: a scan that is quadratic would need minutes at this size
  const PAST_SQL_LIMIT = 1 << 20 // more than the 1,000,000 characters of SQL that are read
  const ok = (cmd: string, ctx: BashContext = CTX): Risk[] => {
    const got = classifyBash(cmd, ctx)
    expect(Array.isArray(got)).toBe(true)
    return got
  }
  test('empty and blank input', () => {
    expect(ok('')).toEqual([])
    expect(ok(' ')).toEqual([])
    expect(ok('\n\n\t\r\n')).toEqual([])
    expect(ok(undefined as unknown as string)).toEqual([])
    expect(ok(null as unknown as string)).toEqual([])
    expect(ok(42 as unknown as string)).toEqual([])
  })
  test('a missing or empty context does not throw', () => {
    expect(ok('git push -f', undefined as unknown as BashContext).length).toBe(1)
    expect(ok('rm -rf x', undefined as unknown as BashContext).length).toBe(1)
    expect(ok('rm -rf /tmp/x', { cwd: '', root: '' }).length).toBe(1)
    expect(ok('git reset --hard', { cwd: '', root: '' }).length).toBe(1)
    expect(ok('rm -rf x', { cwd: 'relative', root: 'relative' })[0]?.hasUnknownPath).toBe(true)
  })
  for (const ch of [';', '&', '|', '\n', '(', ')', '{', '}', '<', '>', '`', "'", '"', '\\', '$', '#', ' ', '*', '\0']) {
    test(`256 KB of ${JSON.stringify(ch)}`, () => timed('256 KB', () => ok(ch.repeat(SIZE))))
  }
  for (const unit of ['$(', '<<', '<<<', '`$(', '${', '$((', '((', 'cat <<EOF\n', '\\\n', ';;', '&&', '||', ' -rf ', '{,', '{a,', '{', '}{', '..{', '%a', '/s:']) {
    test(`256 KB of ${JSON.stringify(unit)}`, () => timed('256 KB', () => ok(unit.repeat(SIZE / unit.length))))
  }
  test('many commands are capped, and the cap says so', () => {
    timed('rm x 100k', () => {
      const got = ok(Array.from({ length: 100000 }, (_, i) => `rm -rf d${i}`).join(';'))
      expect(got.length).toBe(2001) // 2000 commands read, then one `unparsed`
      expect(got.at(-1)?.kind).toBe('unparsed')
    })
    timed('same command 100k', () => expect(ok('rm -rf x;'.repeat(100000)).map(r => r.kind)).toEqual(['delete', 'unparsed']))
  })
  test('deep nesting does not overflow the stack', () => {
    timed('10k $(', () => ok('$('.repeat(10000) + 'rm -rf build' + ')'.repeat(10000)))
    timed('10k (', () => ok('('.repeat(10000) + 'rm -rf build' + ')'.repeat(10000)))
    timed('10k {', () => ok('{ '.repeat(10000) + 'rm -rf build' + '; }'.repeat(10000)))
    timed('10k backticks', () => ok('`'.repeat(10000) + 'rm -rf build' + '`'.repeat(10000)))
    timed('10k quotes in $(', () => ok('$("'.repeat(10000)))
    timed('10k bash -c', () => ok('bash -c '.repeat(10000) + 'rm -rf x'))
    timed('10k sudo', () => ok('sudo '.repeat(10000) + 'rm -rf x'))
    // a sane nesting is still read
    expect(ok('echo $(echo $(echo $(rm -rf build)))').length).toBe(1)
  })
  test('a very long operand list and a very long word', () => {
    timed('many operands', () => {
      const got = ok('rm -rf ' + 'a '.repeat(SIZE / 2))
      expect(got.map(r => r.kind)).toEqual(['delete', 'unparsed'])
      expect(got[0]?.paths.length).toBeLessThanOrEqual(500)
    })
    timed('one long word', () => expect(ok('rm -rf ' + 'a'.repeat(SIZE)).length).toBe(1))
    timed('slashes', () => expect(ok('rm -rf ' + '/'.repeat(SIZE)).length).toBe(1))
    timed('dots', () => ok('rm -rf ' + '../'.repeat(SIZE / 3)))
    timed('one brace and commas', () => ok('rm -rf {' + ','.repeat(SIZE)))
    timed('braces without end', () => ok('rm -rf ' + '{a'.repeat(SIZE / 2)))
    timed('cmd flags', () => ok('rd /s' + ':a'.repeat(SIZE / 2) + ' x', WIN))
    timed('percent signs', () => ok('rd /s /q ' + '%a'.repeat(SIZE / 2), WIN))
    timed('PowerShell parameter', () => ok('Remove-Item -Recurse -' + 'a'.repeat(SIZE) + ' x', WIN))
    timed('long sql', () => expect(ok('psql -c "' + 'x'.repeat(PAST_SQL_LIMIT) + ' DROP TABLE t"').map(r => r.kind)).toEqual(['unparsed']))
  })
  test('NUL and control characters', () => {
    expect(ok('rm -rf \0x')[0]?.hasUnknownPath).toBe(true)
    expect(ok('rm -rf x\0y').length).toBe(1)
    expect(ok('rm\0 -rf x')).toEqual([])
    let all = ''
    for (let i = 0; i < 32; i++) all += String.fromCharCode(i)
    ok(all + 'rm -rf x' + all)
    ok(`git push \x1b[31m--force\x1b[0m`)
    for (const r of ok('rm -rf "a\x07b" ; git push -f "ori\x00gin"')) expect(/[\u0000-\u001f]/.test(r.label)).toBe(false)
    expect(/[\u0000-\u001f]/.test(ok('git push -f "ori\x01gin"')[0]?.remote ?? '')).toBe(false)
  })
  test('unterminated quotes, substitutions and here-docs', () => {
    for (const cmd of ['rm -rf "build', "rm -rf 'build", 'echo $(rm -rf x', 'echo `rm -rf x', 'cat <<EOF\nrm -rf x', 'git push --force "', "git push -f '", 'echo ${x', 'echo $((1', '(', ')', '{', '}', '((', '<<', '<<-', '>', '>>', '|', '||', '&&', '&', ';', ';;', '$', '$(', '`', '\\', 'x=']) {
      ok(cmd)
    }
    expect(ok('echo $(rm -rf x').length).toBe(1)
    expect(ok('cat <<EOF\nrm -rf x')).toEqual([])
  })
  test('unicode', () => {
    expect(ok('rm -rf 日本語 ビルド').length).toBe(1)
    expect(ok('rm -rf "\u202e build \u202c"').length).toBe(1)
    expect(ok('rm -rf ' + '😀'.repeat(1000)).length).toBe(1)
    expect(ok('echo ñ && rm -rf café')[0]?.paths).toEqual(['café'])
    expect(ok('git push --force origin ブランチ')[0]?.name).toBe('ブランチ')
    expect(ok('rm\u00a0-rf x')).toEqual([])
  })
  test('random shell soup never throws and every risk is well formed', () => {
    let seed = 12345
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const atoms = [
      'rm', '-rf', '-r', '-f', 'git', 'push', '--force', 'reset', '--hard', 'clean', '-fd', 'checkout', '--', '.', 'branch', '-D', 'psql', '-c', 'DROP TABLE t',
      'cp', '.env', '.env.example', 'sudo', 'bash', '-c', 'xargs', 'find', '-delete', '-exec', '{}', '+', ';', '&&', '||', '|', '&', '\n', '(', ')', '{', '}', '$(', '`',
      '"', "'", '\\', '>', '>>', '<', '<<EOF', 'EOF', '$X', '*', '~', '..', '/', 'cd', 'build', 'Remove-Item', '-Recurse', 'rd', '/s', 'C:\\x', ' ', ' ', ' ',
    ]
    timed('3000 random lines', () => {
      for (let n = 0; n < 3000; n++) {
        let cmd = ''
        for (let k = rnd(24); k >= 0; k--) cmd += atoms[rnd(atoms.length)] + (rnd(4) === 0 ? '' : ' ')
        for (const r of ok(cmd)) {
          expect(r.tier, cmd).toBe('ask')
          expect(r.label.length > 0 && r.label.length <= 40, cmd).toBe(true)
          expect(Array.isArray(r.paths), cmd).toBe(true)
          expect(r.paths.every(p => typeof p === 'string'), cmd).toBe(true)
          expect(r.paths.length, cmd).toBeLessThanOrEqual(500)
        }
      }
    })
  })
  test('random soup of the newer forms (git-erase, wrangler, find match) never throws and every risk is well formed', () => {
    let seed = 987654
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const atoms = [
      'git', 'git', 'stash', 'drop', 'clear', 'update-ref', '-d', '--delete', '-m', 'reflog', 'expire', '--expire=now', '--expire', 'now', 'all', '--all', 'gc', '--prune=now', '--prune=all',
      '--prune', 'refs/heads/x', 'wrangler', 'wrangler', 'd1', 'execute', 'shop', '--command', '-c', '--sql', '--file', 'DELETE FROM t', 'DROP TABLE t', 'TRUNCATE x', 'DROP/**/INDEX i',
      'find', 'find', '.', '-name', '-iname', '-regex', '-path', "'*.o'", 'node_modules', '-prune', '-o', '!', '-not', '-delete', '-exec', 'rm', '-rf', '{}', '+', ';', '&&', '|', '(', ')',
      '"', "'", '$X', '\n', 'sudo', 'npx', 'bash', '-c', ' ', ' ', ' ',
    ]
    const FIXED = new Set(['git stash drop', 'git stash clear', 'git update-ref -d', 'git reflog expire', 'git gc --prune=now'])
    const ctrl = /[\u0000-\u001f\u007f]/
    timed('3000 random lines', () => {
      for (let n = 0; n < 3000; n++) {
        let cmd = ''
        for (let k = rnd(24); k >= 0; k--) cmd += atoms[rnd(atoms.length)] + (rnd(4) === 0 ? '' : ' ')
        for (const r of ok(cmd)) {
          expect(r.tier, cmd).toBe('ask')
          expect(r.label.length > 0 && r.label.length <= 40, cmd).toBe(true)
          expect(Array.isArray(r.paths), cmd).toBe(true)
          if (r.kind === 'git-erase') expect(FIXED.has(r.label) && r.paths.length === 0 && r.name === undefined && r.picks === undefined && r.match === undefined, cmd).toBe(true)
          if (r.label === 'wrangler d1 execute') expect(r.kind, cmd).toBe('db-drop')
          if (r.match !== undefined) {
            expect(r.picks === true && r.kind === 'delete' && r.match.length > 0 && r.match.length <= 60 && !ctrl.test(r.match), cmd).toBe(true)
          }
          expect(ctrl.test(r.label) || ctrl.test(r.name ?? ''), cmd).toBe(false)
        }
      }
    })
  })
  test('the same input gives the same answer, and the context is left alone', () => {
    const ctx: BashContext = { cwd: ROOT, root: ROOT, home: '/home/dev' }
    const before = JSON.stringify(ctx)
    const cmd = 'cd build && rm -rf * ; git push -f origin main'
    expect(classifyBash(cmd, ctx)).toEqual(classifyBash(cmd, ctx))
    expect(JSON.stringify(ctx)).toBe(before)
  })
})
