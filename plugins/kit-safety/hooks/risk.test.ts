import { describe, expect, test } from 'claude-code/testing'

import { classifyBash, safeRemote, splitCommands } from './risk'
import type { BashContext } from './risk'
import {
  ROOT, CTX, HOME_CTX, SUB_CTX, NOHOME_CTX, SENTINEL, table, quiet, del, unk, ow, db, push, discard, reset, clean, branch,
} from '../tests/risk-helpers'

// The Bash classifier (risk.ts), part 1: the shell reader, rm, cd tracking, several risks in one line, and credentials that never reach a label.
// The other parts: risk-wrappers, risk-find-windows, risk-git, risk-db, risk-env (by topic) and risk-limits, risk-hostile (limits and hostile input).

// ---------------------------------------------------------------------------------------------------------------------
describe('splitCommands (the shell reader)', () => {
  const rows: Array<[string, string[][]]> = [
    ['', []],
    ['   \t  ', []],
    ['ls -la', [['ls', '-la']]],
    ['a && b || c; d | e & f', [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]],
    ['a\nb\r\nc', [['a'], ['b'], ['c']]],
    ['a;;b', [['a'], ['b']]],
    ['echo "a b" \'c d\' e\\ f', [['echo', 'a b', 'c d', 'e f']]],
    ['echo "it\'s"', [['echo', "it's"]]],
    ['echo \'say "hi"\'', [['echo', 'say "hi"']]],
    ['echo "a\\"b"', [['echo', 'a"b']]],
    ['echo "a\\\\b"', [['echo', 'a\\b']]],
    ["echo 'a\\b'", [['echo', 'a\\b']]],
    ['echo "a"b\'c\'', [['echo', 'abc']]],
    ['echo \\; \\&', [['echo', ';', '&']]],
    ['echo $(ls)', [['ls'], ['echo', '$()']]],
    ['echo `ls`', [['ls'], ['echo', '``']]],
    ['echo "$(ls | wc -l)"', [['ls'], ['wc', '-l'], ['echo', '$()']]],
    ['echo "a $(echo b) c"', [['echo', 'b'], ['echo', 'a $() c']]],
    ['(cd x; ls)', [['cd', 'x'], ['ls']]],
    ['{ a; b; }', [['a'], ['b']]],
    ['x=$(a) b', [['a'], ['x=$()', 'b']]],
    ['echo a > f', [['echo', 'a']]],
    ['echo a>f', [['echo', 'a']]],
    ['echo a 2>&1', [['echo', 'a']]],
    ['echo a >>f 2>/dev/null', [['echo', 'a']]],
    ['cmd <in >out', [['cmd']]],
    ['cmd &> all', [['cmd']]],
    ['ls # a comment', [['ls']]],
    ['# only a comment', []],
    ['echo a#b', [['echo', 'a#b']]],
    ['ls \\\n  -la', [['ls', '-la']]],
    ["echo $'a b'", [['echo', 'a b']]],
    ['echo ${HOME}/x', [['echo', '${HOME}/x']]],
    ['echo ${A:-${B}}/x', [['echo', '${A:-${B}}/x']]],
    ['echo $((1 << 3)); ls', [['echo', '$((1 << 3))'], ['ls']]],
    ['(( x = 1 << 2 )); ls', [['ls']]],
    ['cat <<EOF\nline one\nrm -rf x\nEOF\nls', [['cat'], ['ls']]],
    ["cat <<'EOF'\nrm -rf x\nEOF\nls", [['cat'], ['ls']]],
    ['cat <<\\EOF\nrm -rf x\nEOF\nls', [['cat'], ['ls']]],
    ['cat <<-EOF\n\trm -rf x\n\tEOF\nls', [['cat'], ['ls']]],
    ['cat <<"EOF" | grep x\nbody\nEOF', [['cat'], ['grep', 'x']]],
    ['cat <<A <<B\none\nA\ntwo\nB\nls', [['cat'], ['ls']]],
    ['cat <<EOF\r\nbody\r\nEOF\r\nls', [['cat'], ['ls']]],
    ['cat <<EOF\nnever closed\nrm -rf x', [['cat']]],
    ['cat <<< "rm -rf x"', [['cat']]],
    ['cat <<EOF\n$(date)\nEOF', [['date'], ['cat']]],
    ["cat <<'EOF'\n$(date)\nEOF", [['cat']]],
    ['git commit -m "$(cat <<\'EOF\'\nFix the user\'s bug (really)\nEOF\n)"', [['cat'], ['git', 'commit', '-m', '$()']]],
    ['rd /s /q C:\\proj\\build', [['rd', '/s', '/q', 'C:\\proj\\build']]],
    ['rd /s /q "C:\\proj\\build\\"', [['rd', '/s', '/q', 'C:\\proj\\build\\']]],
    ['Remove-Item .\\build\\* -Recurse', [['Remove-Item', '.\\build\\*', '-Recurse']]],
    ['echo \\\\server\\share', [['echo', '\\\\server\\share']]],
    ['diff <(ls a) <(ls b)', [['ls', 'a'], ['ls', 'b'], ['diff', '<()', '<()']]],
  ]
  for (const [src, want] of rows) test(JSON.stringify(src), () => expect(splitCommands(src), src).toEqual(want))
  test('for-loop headers with (( )) do not break the reader', () => {
    const cmds = splitCommands('for ((i=0;i<3;i++)); do echo $i; done')
    expect(cmds.some(c => c.includes('echo'))).toBe(true)
  })
  test('functions and if/while bodies are read', () => {
    expect(splitCommands('if x; then y; else z; fi').map(c => c[c.length - 1])).toEqual(['x', 'y', 'z', 'fi'])
    expect(splitCommands('f() { a; }').some(c => c[0] === 'a')).toBe(true)
  })
  test('at most 2000 commands are read', () => {
    expect(splitCommands('a;'.repeat(10000)).length).toBe(2000)
    expect(splitCommands('a;'.repeat(1999)).length).toBe(1999)
  })
  test('never throws', () => {
    expect(splitCommands(undefined as unknown as string)).toEqual([])
    expect(splitCommands('"')).toEqual([['']])
    expect(splitCommands('$(')).toEqual([['$()']])
    expect(splitCommands(')')).toEqual([])
    expect(splitCommands('}')).toEqual([['}']])
    expect(splitCommands('<<')).toEqual([])
    expect(splitCommands('\\')).toEqual([['\\']])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('rm', () => {
  describe('risky forms', () => {
    table([
      ['rm -rf build', [del(['build'])]],
      ['rm -r build', [del(['build'], 'rm -r')]],
      ['rm -R build', [del(['build'], 'rm -r')]],
      ['rm -fr build', [del(['build'])]],
      ['rm -Rf build', [del(['build'])]],
      ['rm -rfv build', [del(['build'])]],
      ['rm -vr build', [del(['build'], 'rm -r')]],
      ['rm -rI build', [del(['build'], 'rm -r')]],
      ['rm --recursive build', [del(['build'], 'rm -r')]],
      ['rm --recursive --force build', [del(['build'])]],
      ['rm --force --recursive build', [del(['build'])]],
      ['rm -r -f build', [del(['build'])]],
      ['rm -f -r build', [del(['build'])]],
      ['rm build -rf', [del(['build'])]],
      ['rm build -r', [del(['build'], 'rm -r')]],
      ['rm a -r b', [del(['a', 'b'], 'rm -r')]],
      ['rm -rf -- build', [del(['build'])]],
      ['rm -rf -- -rf', [del(['-rf'])]],
      ['rm -rf a b c', [del(['a', 'b', 'c'])]],
      ['rm -rf ./dist', [del(['./dist'])]],
      ['rm -rf build/', [del(['build/'])]],
      ['rm -rf build/cache', [del(['build/cache'])]],
      ['rm -rf node_modules/.cache', [del(['node_modules/.cache'])]],
      ['rm -rf "build dir"', [del(['build dir'])]],
      ["rm -rf 'build dir'", [del(['build dir'])]],
      ['rm -rf build\\ dir', [del(['build dir'])]],
      ['rm -rf "a"\'b\'c', [del(['abc'])]],
      ['rm -rf 日本語/ビルド', [del(['日本語/ビルド'])]],
      ['rm -rf --no-preserve-root build', [del(['build'])]],
      ['rm -rf --one-file-system -v build', [del(['build'])]],
    ])
  })
  describe('the project folder itself and the folders above it', () => {
    table([
      ['rm -rf .', [del(['.'])]],
      ['rm -rf ./', [del(['./'])]],
      ['rm -rf ./.', [del(['./.'])]],
      ['rm -rf build/..', [del(['build/..'])]],
      [`rm -rf ${ROOT}`, [del([ROOT])]],
      [`rm -rf ${ROOT}/`, [del([`${ROOT}/`])]],
      [`rm -rf ${ROOT}/build`, [del([`${ROOT}/build`])]],
      ['rm -rf ..', [del(['..'])]],
      ['rm -rf ../', [del(['../'])]],
      ['rm -rf ../*', [del(['../*'])]],
      ['rm -rf /work', [del(['/work'])]],
      ['rm -rf /', [del(['/'])]],
      ['rm -rf /*', [del(['/*'])]],
      ['rm -rf --no-preserve-root /', [del(['/'])]],
      ['rm -rf //', [del(['//'])]],
      ['rm -rf /work/*', [del(['/work/*'])]],
      ['rm -rf ~', [del(['~'])], HOME_CTX],
      ['rm -rf ~/', [del(['~/'])], HOME_CTX],
      ['rm -rf ~/*', [del(['~/*'])], HOME_CTX],
      ['rm -rf ~/acme-shop/build', [del(['~/acme-shop/build'])], HOME_CTX],
      ['rm -rf /home/dev', [del(['/home/dev'])], HOME_CTX],
    ])
  })
  describe('wildcards keep their spelling; the folder part decides', () => {
    table([
      ['rm -rf *', [del(['*'])]],
      ['rm -rf ./*', [del(['./*'])]],
      ['rm -rf build/*', [del(['build/*'])]],
      ['rm -rf *.log', [del(['*.log'])]],
      ['rm -rf build/*.o', [del(['build/*.o'])]],
      ['rm -rf src/*/dist', [del(['src/*/dist'])]],
      ['rm -rf build/?', [del(['build/?'])]],
      ['rm -rf [ab]*', [del(['[ab]*'])]],
      ['rm -rf build/{a,b}', [del(['build/{a,b}'])]],
      ['rm -rf .[a-z]*', [del(['.[a-z]*'])]],
      ['rm -rf ../acme-shop/*', [del(['../acme-shop/*'])]],
      [`rm -rf ${ROOT}/build/*`, [del([`${ROOT}/build/*`])]],
      // outside: the folder part is outside the project
      ['rm -rf /tmp/*', []],
      ['rm -rf ../x/*', []],
      ['rm -rf /var/log/*.log', []],
      ['rm -rf ~/*', [], CTX],
      ['rm -rf /tmp/*/x /tmp/y', []],
      // quoted wildcards are plain characters in a shell: the real name `src/app/[id]`
      ['rm -rf "src/app/[id]"', [del(['src/app/[id]'])]],
      ["rm -rf 'build/*'", [del(['build/*'])]],
    ])
  })
  describe('outside the project is not our business', () => {
    table([
      ['rm -rf ../x', []],
      ['rm -rf ../../x', []],
      ['rm -rf ../acme-shop-old', []],
      ['rm -rf /tmp/x', []],
      ['rm -rf /etc', []],
      ['rm -rf /var/tmp/a /tmp/b', []],
      ['rm -rf /work/other', []],
      ['rm -rf /work/acme-shop-old', []],
      ['rm -rf ~/x', [], CTX],
      ['rm -rf ~/.cache', [], CTX],
      ['rm -rf ~', [], CTX],
      ['rm -rf ~/.cache', [], HOME_CTX],
      ['rm -rf "/tmp/x-$RANDOM"', []],
      ['rm -rf /tmp/build-$$', []],
      ['rm -rf /tmp/$(date +%s)', []],
      ['rm -rf "/tmp/${NAME}"', []],
      ['rm -rf ~/.cache/$X', [], CTX],
      // partly outside: only the inside part is reported
      ['rm -rf build /tmp/x', [del(['build'])]],
      ['rm -rf /tmp/x build', [del(['build'])]],
      ['rm -rf ../x dist ../y', [del(['dist'])]],
      // a `..` that comes back in is inside
      ['rm -rf ../acme-shop/build', [del(['../acme-shop/build'])]],
      ['rm -rf build/../../x', []],
      ['rm -rf build/../dist', [del(['build/../dist'])]],
    ])
  })
  describe('from a folder outside the project', () => {
    const away: BashContext = { cwd: '/tmp/scratch', root: ROOT, home: '/home/dev' }
    table([
      ['rm -rf x', [], away],
      ['rm -rf *', [], away],
      ['rm -rf ../scratch', [], away],
      [`rm -rf ${ROOT}/build`, [del([`${ROOT}/build`])], away],
      ['rm -rf /tmp', [], away],
    ])
  })
  describe('from a sub-folder of the project', () => {
    table([
      ['rm -rf ../x', [del(['../x'])], SUB_CTX],
      ['rm -rf ..', [del(['..'])], SUB_CTX],
      ['rm -rf ../../x', [], SUB_CTX],
      ['rm -rf dist', [del(['dist'])], SUB_CTX],
      ['rm -rf .', [del(['.'])], SUB_CTX],
    ])
  })
  describe('paths that cannot be read from their spelling', () => {
    table([
      ['rm -rf "$DIR"', [unk()]],
      ['rm -rf $DIR', [unk()]],
      ['rm -rf ${DIR}', [unk()]],
      ['rm -rf $DIR/build', [unk()]],
      ['rm -rf "$DIR"/*', [unk()]],
      ['rm -rf $(cat list.txt)', [unk()]],
      ['rm -rf `cat list.txt`', [unk()]],
      ['rm -rf "$(pwd)/build"', [unk()]],
      ['rm -rf $HOME/x', [unk()]],
      ['rm -rf "$@"', [unk()]],
      ['rm -rf $1', [unk()]],
      ['rm -rf ~user/x', [unk()]],
      ['rm -rf "$HOME"/../x', [unk()]],
      ['rm -rf /work/acme-shop-$X/y', [unk()]],
      ['rm -rf $DIR /tmp/x', [unk()]],
      // known and unknown together: the known one is still listed
      ['rm -rf build "$DIR"', [del(['build'], 'rm -rf', true)]],
      ['rm -rf "$DIR" build', [del(['build'], 'rm -rf', true)]],
      // no home folder given: `~` cannot be read
      ['rm -rf ~/x', [unk()], NOHOME_CTX],
      ['rm -rf ~', [unk()], NOHOME_CTX],
      // a command substitution inside an operand runs on its own
      ['rm -rf $(rm -rf a)', [del(['a']), unk()]],
    ])
  })
  describe('not risky', () => {
    quiet([
      'rm file', 'rm -f file', 'rm -i file', 'rm a b c', 'rm -v a', 'rm -d dir', 'rm -I file', 'rm --force file', 'rm -rf', 'rm', 'rm -r', 'rm -rf --',
      'rmdir build', 'rmdir -p a/b/c', 'rmdir --ignore-fail-on-non-empty x', 'unlink file', 'shred -u x', 'rm -- -r', 'rm ./-r', 'rm -f -- -rf',
      'ls -r build', 'cp -r a b', 'mv -r a b', 'grep -rf pat dir', 'chmod -R 755 build', 'echo rm -rf build', 'man rm',
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('cd tracking', () => {
  const B = `${ROOT}/build`
  table([
    ['cd build && rm -rf *', [del([`${B}/*`])]],
    ['cd build && rm -rf out', [del([`${B}/out`])]],
    ['cd build; rm -rf out', [del([`${B}/out`])]],
    ['cd build\nrm -rf out', [del([`${B}/out`])]],
    ['cd build/ && rm -rf ./*', [del([`${B}/*`])]],
    ['cd build && rm -rf ../dist', [del([`${ROOT}/dist`])]],
    ['cd build && rm -rf .', [del([B])]],
    ['cd build && rm -rf /tmp/x', []],
    ['cd build && rm -rf ~/x', []],
    ['cd build && rm -rf $(cat x)', [unk()]],
    ['cd -P build && rm -rf *', [del([`${B}/*`])]],
    ['cd -- build && rm -rf *', [del([`${B}/*`])]],
    ['cd "build" && rm -rf "*"', [del([`${B}/*`])]],
    ['cd build && cd .. && rm -rf x', [del(['x'])]],
    ['cd . && rm -rf x', [del(['x'])]],
    ['cd .. && rm -rf x', []],
    ['cd .. && rm -rf acme-shop/build', [del([`${ROOT}/build`])]],
    // `rm -rf *` in the folder above the project takes the project with it
    ['cd .. && rm -rf *', [del(['/work/*'])]],
    ['cd /tmp && rm -rf *', []],
    ['cd /tmp && rm -rf build', []],
    [`cd /tmp && rm -rf ${ROOT}/build`, [del([`${ROOT}/build`])]],
    ['cd "$X" && rm -rf build', [unk()]],
    ['cd $X; rm -rf /work/acme-shop/x', [del(['/work/acme-shop/x'])]],
    ['cd "$(mktemp -d)" && rm -rf *', [unk()]],
    ['cd build* && rm -rf x', [unk()]],
    ['cd ~ && rm -rf x', []],
    ['cd ~ && rm -rf acme-shop/build', [del(['/home/dev/acme-shop/build'])], HOME_CTX],
    ['cd && rm -rf acme-shop/build', [del(['/home/dev/acme-shop/build'])], HOME_CTX],
    ['cd && rm -rf x', [unk()], NOHOME_CTX],
    ['cd ~/acme-shop/build && rm -rf *', [del(['/home/dev/acme-shop/build/*'])], HOME_CTX],
    // groups, subshells, pipes
    ['(cd build && rm -rf *); rm -rf dist', [del([`${B}/*`]), del(['dist'])]],
    ['(cd /tmp && rm -rf x); rm -rf dist', [del(['dist'])]],
    ['{ cd build; rm -rf *; }', [del([`${B}/*`])]],
    ['{ cd build; }; rm -rf out', [del([`${B}/out`])]],
    ['cd build && (rm -rf *)', [del([`${B}/*`])]],
    ["cd build && bash -c 'rm -rf *'", [del([`${B}/*`])]],
    ['cd build | cat; rm -rf x', [del(['x'])]],
    ['cd build & rm -rf x', [del(['x'])]],
    ['echo $(cd build; pwd); rm -rf x', [del(['x'])]],
    ['echo `cd build`; rm -rf x', [del(['x'])]],
    // pushd / popd / cd -
    ['pushd build && rm -rf * && popd && rm -rf x', [del([`${B}/*`]), del(['x'])]],
    ['pushd build; popd; rm -rf x', [del(['x'])]],
    ['pushd build; pushd ..; popd; rm -rf x', [del([`${B}/x`])]],
    ['popd; rm -rf x', [unk()]],
    ['pushd; rm -rf x', [unk()]],
    ['pushd -n build; rm -rf x', [del(['x'])]],
    ['cd build; cd -; rm -rf x', [del(['x'])]],
    ['cd /tmp && cd - && rm -rf x', [del(['x'])]],
    ['cd -; rm -rf x', [unk()]],
    ['cd build; cd /tmp; cd -; rm -rf x', [del([`${B}/x`])]],
    // a keyword in front of cd
    ['if true; then cd build; rm -rf *; fi', [del([`${B}/*`])]],
    // `env -C` moves the working folder for one command
    ['env -C build rm -rf *', [del([`${B}/*`])]],
    ['env -C /tmp rm -rf *', []],
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
describe('several risks in one line', () => {
  table([
    ['rm -rf a; rm -rf b', [del(['a']), del(['b'])]],
    ['rm -rf a; git reset --hard; rm -rf b', [del(['a']), reset, del(['b'])]],
    ['git reset --hard && git clean -fd && git checkout -- .', [reset, clean('git clean -fd'), discard('git checkout -- .')]],
    ['git push -f && git branch -D x', [push('git push -f'), branch('git branch -D', 'x')]],
    ['psql -c "DROP TABLE t" && rm -rf build', [db('psql', 't'), del(['build'])]],
    ['echo a > .env && rm -rf build', [ow('> .env', ['.env']), del(['build'])]],
    // the same risk twice is one risk
    ['rm -rf a; rm -rf a', [del(['a'])]],
    ['git reset --hard; git reset --hard', [reset]],
    ['git push -f origin a; git push -f origin a', [push('git push -f', 'origin', 'a')]],
    ['echo a > .env; echo b > .env', [ow('> .env', ['.env'])]],
    ['rm -rf a b; rm -rf b a', [del(['a', 'b'])]],
    ['rm -rf "$X"; rm -rf "$Y"', [unk()]],
    // different targets stay apart
    ['rm -rf a && rm -rf a/', [del(['a']), del(['a/'])]],
    ['git push -f origin a; git push -f upstream b', [push('git push -f', 'origin', 'a'), push('git push -f', 'upstream', 'b')]],
    ['git push -f origin a; git push -f origin b', [push('git push -f', 'origin', 'a'), push('git push -f', 'origin', 'b')]],
    ['git branch -D a; git branch -D b', [branch('git branch -D', 'a'), branch('git branch -D', 'b')]],
    ['psql -c "DROP TABLE a"; psql -c "DROP TABLE b"', [db('psql', 'a'), db('psql', 'b')]],
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
describe('credentials never leak into what is shown', () => {
  const T = SENTINEL
  // A token-shaped string, assembled so that no secret-shaped literal sits in this file.
  const ghToken = ['gh' + 'p', 'x'.repeat(36)].join('_')
  const cmds = [
    `git push --force https://user:${T}@github.com/acme/shop.git main`,
    `git push -f https://${T}@github.com/acme/shop.git`,
    `git -c http.extraheader="Authorization: ${T}" push -f origin main`,
    `git push --force --force-with-lease=main:${T} origin main`,
    `git push --repo=https://u:${T}@h.example/x.git -f`,
    `git push -f https://${T}:${T}@host.example:8443/p.git`,
    `git push --force ssh://${T}@host.example/x.git`,
    `git push --force https://x:${ghToken}@github.com/acme/shop.git`,
    `git push -f ${T}@github.com:acme/shop.git`,
    `mysql -p${T} -e "DROP DATABASE shop"`,
    `mysqladmin -p${T} drop shop`,
    `psql postgres://u:${T}@h.example/db -c "DROP TABLE users"`,
    `redis-cli -a ${T} FLUSHALL`,
    `PGPASSWORD=${T} dropdb shop`,
    `MYSQL_PWD=${T} mysql -e "DROP TABLE t"`,
    `sudo -u ${T} rm -rf build`,
    `rm -rf ${T}-dir`,
    `sqlite3 app.db "DROP TABLE t" -cmd ".key ${T}"`,
  ]
  for (const cmd of cmds) {
    test(cmd.replace(T, '<secret>').replace(ghToken, '<token>'), () => {
      const got = classifyBash(cmd, CTX)
      expect(got.length, JSON.stringify(got)).toBeGreaterThan(0)
      for (const r of got) {
        expect(r.label, 'label').not.toContain(T)
        expect(r.label, 'label').not.toContain(ghToken)
        expect(r.label.length).toBeLessThanOrEqual(40)
        expect(r.remote ?? '', 'remote').not.toContain(T)
        expect(r.remote ?? '', 'remote').not.toContain(ghToken)
        expect(r.remote ?? '', 'remote').not.toContain('@')
        expect(r.name ?? '', 'name').not.toContain(T)
      }
    })
  }
  describe('safeRemote', () => {
    const rows: Array<[string, string | undefined]> = [
      ['origin', 'origin'],
      ['upstream', 'upstream'],
      ['https://github.com/acme/shop.git', 'https://github.com'],
      [`https://user:${SENTINEL}@github.com/acme/shop.git`, 'https://github.com'],
      [`https://${SENTINEL}@github.com/x`, 'https://github.com'],
      ['https://user:pw@host.example:8443/x', 'https://host.example'],
      ['ssh://git@host.example:2222/x.git', 'ssh://host.example'],
      ['git@github.com:acme/shop.git', 'github.com'],
      ['user:pw@host', 'host'],
      ['file:///srv/git/x.git', 'file://'],
      ['../repo.git', '../repo.git'],
      ['C:\\repos\\x.git', 'C:\\repos\\x.git'],
      ['a'.repeat(100), 'a'.repeat(60)],
      ['', undefined],
      ['   ', undefined],
      ['$REMOTE', undefined],
      ['@', undefined],
      ['origin\n', 'origin'],
    ]
    for (const [input, want] of rows) test(JSON.stringify(input).slice(0, 60), () => expect(safeRemote(input)).toBe(want))
    test('odd input', () => {
      expect(safeRemote(undefined as unknown as string)).toBeUndefined()
      expect(safeRemote('https://' + '@'.repeat(1000) + 'x')).toBe('https://x')
    })
  })
})
