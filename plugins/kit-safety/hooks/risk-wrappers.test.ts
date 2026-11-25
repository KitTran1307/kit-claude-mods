import { describe, expect, test } from 'claude-code/testing'

import { commandCount, splitCommands } from './risk'
import { ROOT, WIN, check, table, quiet, del, unk, UNPARSED, ow, db, push, discard, reset, clean, branch } from '../tests/risk-helpers'

// The Bash classifier (risk.ts), wrappers (sudo, env, bash -c, xargs...), quoting and here-docs, backslashes, and commandCount.

// ---------------------------------------------------------------------------------------------------------------------
describe('wrappers are looked through', () => {
  describe('prefixes and sudo', () => {
    for (const cmd of [
      'env FOO=1 rm -rf x', 'FOO=1 rm -rf x', 'FOO=1 BAR="a b" rm -rf x', 'env -i rm -rf x', 'env -u FOO rm -rf x', 'env -- rm -rf x', 'env A=1 B=2 rm -rf x',
      'command rm -rf x', 'command -p rm -rf x', 'builtin rm -rf x', 'time rm -rf x', 'time -p rm -rf x', 'nohup rm -rf x', 'nohup rm -rf x &',
      'nice rm -rf x', 'nice -n 10 rm -rf x', 'nice -10 rm -rf x', 'ionice -c 3 rm -rf x', 'timeout 10 rm -rf x', 'timeout 10s rm -rf x',
      'timeout -k 5 10s rm -rf x', 'timeout --signal=KILL 5 rm -rf x', 'exec rm -rf x', 'exec -a name rm -rf x', 'stdbuf -oL rm -rf x', 'setsid rm -rf x',
      'busybox rm -rf x', 'sudo rm -rf x', 'sudo -u deploy rm -rf x', 'sudo -E -u deploy rm -rf x', 'sudo -- rm -rf x', 'sudo -n rm -rf x',
      'sudo --user=deploy rm -rf x', 'doas rm -rf x', 'sudo env A=1 nohup rm -rf x', 'sudo -u root -H rm -rf x', 'sudo A=1 rm -rf x',
      '/bin/rm -rf x', '/usr/bin/rm -rf x', '\\rm -rf x', '"rm" -rf x', "'rm' -rf x", '/usr/bin/env rm -rf x', 'sudo /bin/rm -rf x',
      'if true; then rm -rf x; fi', 'while true; do rm -rf x; done', '! rm -rf x', 'true && rm -rf x', 'false || rm -rf x', 'echo a; rm -rf x',
      'echo a | rm -rf x', 'echo a & rm -rf x', 'rm -rf x &', '(rm -rf x)', '{ rm -rf x; }', 'f() { rm -rf x; }; f', 'rm -rf x # clean',
    ]) test(cmd, () => check(cmd, [del(['x'])]))
  })
  describe('shells, eval, su', () => {
    for (const cmd of [
      "bash -c 'rm -rf x'", 'sh -c "rm -rf x"', "zsh -c 'rm -rf x'", "dash -c 'rm -rf x'", "bash -lc 'rm -rf x'", "bash -ec 'rm -rf x'",
      "bash --norc -c 'rm -rf x'", "bash -o pipefail -c 'rm -rf x'", "sudo bash -c 'rm -rf x'", "sudo -u root sh -c 'rm -rf x'",
      "bash -c 'bash -c \"rm -rf x\"'", "env A=1 bash -c 'rm -rf x'", "eval 'rm -rf x'", 'eval rm -rf x', 'eval "rm -rf x"',
      "su -c 'rm -rf x'", "su root -c 'rm -rf x'", "/bin/bash -c 'rm -rf x'", "bash -c 'echo a; rm -rf x'", "bash -c 'true && rm -rf x'",
      'bash -c "rm -rf \\"x\\""', "sh -c 'sudo rm -rf x'",
    ]) test(cmd, () => check(cmd, [del(['x'])]))
    quiet(['bash script.sh', 'bash -c', 'bash -x script.sh rm -rf x', 'sh', 'bash -c "echo rm -rf x"', "su -c 'echo hi'", 'eval', "eval 'echo rm -rf x'"])
  })
  describe('nesting depth is bounded at 6', () => {
    // Each level wraps the command in `bash -c "..."` with the quotes escaped the way a shell reads them.
    const nest = (n: number): string => {
      let s = 'rm -rf x'
      for (let i = 0; i < n; i++) s = `bash -c ${JSON.stringify(s)}`
      return s
    }
    test('1 to 6 levels are read', () => {
      for (let n = 1; n <= 6; n++) check(nest(n), [del(['x'])])
    })
    test('deeper nesting is not read, and says so (it does not hang)', () => {
      check(nest(7), [UNPARSED])
      check(nest(8), [UNPARSED])
    })
  })
  describe('npx, pnpm, yarn, bundle, poetry', () => {
    table([
      ['npx rm -rf x', [del(['x'])]],
      ['npx --yes rm -rf x', [del(['x'])]],
      ['pnpm exec rm -rf x', [del(['x'])]],
      ['yarn dlx rm -rf x', [del(['x'])]],
      ['npm exec -- rm -rf x', [del(['x'])]],
      ['bunx rm -rf x', [del(['x'])]],
      ['bundle exec rm -rf x', [del(['x'])]],
      ['poetry run rm -rf x', [del(['x'])]],
      ['uv run rm -rf x', [del(['x'])]],
      ['pnpm run build', []],
      ['npm run clean', []],
      ['yarn install', []],
      ['bundle install', []],
    ])
  })
  describe('xargs', () => {
    table([
      // the operands arrive on stdin: unknown
      ["find . -name '*.tmp' | xargs rm -rf", [unk()]],
      ['xargs rm -rf', [unk()]],
      ['git ls-files | xargs rm -rf', [unk()]],
      ['ls | xargs rm -rf build', [del(['build'], 'rm -rf', true)]],
      ['xargs -I{} rm -rf {}', [unk()]],
      ['xargs -I % rm -rf %', [unk()]],
      ['xargs -i rm -rf {}', [unk()]],
      ['xargs -I{} rm -rf build/{}', [unk()]],
      ['xargs -0 -n1 rm -rf', [unk()]],
      ['xargs -n 1 -P 4 rm -rf', [unk()]],
      ['xargs --null rm -rf', [unk()]],
      ['xargs --max-args=1 rm -rf', [unk()]],
      ['xargs -r rm -rf', [unk()]],
      ['xargs -d "\\n" rm -rf', [unk()]],
      ['xargs sudo rm -rf', [unk()]],
      ["xargs -I{} sh -c 'rm -rf x'", [del(['x'], 'rm -rf', true)]],
      ['xargs rm -r -- ', [unk('rm -r')]],
      // nothing risky
      ['xargs rm -f', []],
      ['xargs rm', []],
      ['xargs echo', []],
      ['xargs', []],
      ['xargs -n1', []],
      ['xargs -I{} echo {}', []],
      ['xargs grep foo', []],
    ])
  })
  describe('find', () => {
    table([
      ['find . -delete', [del(['.'], 'find -delete')]],
      ["find build -name '*.o' -delete", [del(['build'], 'find -delete', false, true)]],
      ['find -name x -delete', [del(['.'], 'find -delete', false, true)]],
      ['find build dist -type f -delete', [del(['build', 'dist'], 'find -delete', false, true)]],
      ['find -L . -delete', [del(['.'], 'find -delete')]],
      ['find "$DIR" -delete', [del([], 'find -delete', true)]],
      ['find /tmp -delete', []],
      ['find ../x -delete', []],
      ['find . -exec rm -rf {} +', [del(['.'])]],
      ['find build -exec rm -rf {} \\;', [del(['build'])]],
      ["find . -name node_modules -type d -prune -exec rm -rf {} +", [del(['.'], 'rm -rf', false, true)]],
      ['find . -execdir rm -rf {} +', [del(['.'])]],
      ['find . -ok rm -r {} \\;', [del(['.'], 'rm -r')]],
      ['find /tmp -exec rm -rf {} +', []],
      ["find . -type f -exec sh -c 'rm -rf \"$1\"' _ {} \\;", [del([], 'rm -rf', true, true)]],
      ["find . -name '*.pyc' -delete && rm -rf build", [del(['.'], 'find -delete', false, true), del(['build'])]],
      // not risky
      ['find . -name x', []],
      ['find . -type f -exec chmod +x {} +', []],
      ['find . -type f -print', []],
      ['find', []],
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('quoting, here-docs and what is only text', () => {
  describe('text that mentions a command is not a command', () => {
    quiet([
      'echo "rm -rf /"', "echo 'rm -rf build'", 'echo rm -rf build', 'printf "%s\\n" "git push --force"', 'git commit -m "git reset --hard"',
      "git commit -m 'rm -rf x; git push -f'", "grep 'git push --force' f", 'grep -r "rm -rf" .', 'echo "a;rm -rf x"', "echo $'rm -rf x'",
      '# rm -rf build', 'echo hi # rm -rf build', "echo '$(rm -rf x)'", 'echo "\\$(rm -rf x)"', 'echo "git clean -fd"', "echo 'git branch -D x'",
      'echo "a && rm -rf x"', 'echo "a | rm -rf x"', 'echo "psql -c \'DROP TABLE x\'"', 'echo "cp .env.example .env"', 'echo "> .env"',
      "echo 'echo hi > .env'", 'grep "DROP TABLE" schema.sql', 'cat drop-tables.sql', 'git log --grep="reset --hard"', 'git tag -m "push --force"',
      'ls "rm -rf"', 'man git-push', 'less "git push -f.txt"', 'python -c "print(1)"', 'node -e "console.log(1)"',
    ])
  })
  describe('command substitutions run', () => {
    table([
      ['echo "$(rm -rf x)"', [del(['x'])]],
      ['echo `rm -rf x`', [del(['x'])]],
      ['echo "`rm -rf x`"', [del(['x'])]],
      ['y=$(rm -rf x)', [del(['x'])]],
      ['export Y=$(rm -rf x)', [del(['x'])]],
      ['echo <(rm -rf x)', [del(['x'])]],
      ['diff <(ls a) <(rm -rf x)', [del(['x'])]],
      ['echo "a $(git reset --hard) b"', [reset]],
      ['echo $(echo $(rm -rf x))', [del(['x'])]],
      ['x=`git clean -fd`', [clean('git clean -fd')]],
      // text the reader skips whole (arithmetic, parameter defaults) still runs the substitutions inside
      ['echo $(( $(rm -rf x) + 1 ))', [del(['x'])]],
      ['echo "$(( `rm -rf x` ))"', [del(['x'])]],
      ['y=$(( $(git reset --hard; echo 1) ))', [reset]],
      ['(( $(rm -rf x) ))', [del(['x'])]],
      ['if (( $(rm -rf x) )); then :; fi', [del(['x'])]],
      ['echo ${X:-$(rm -rf x)}', [del(['x'])]],
      ['echo "${X:-$(rm -rf x)}"', [del(['x'])]],
      ['echo ${X:-`git clean -fd`}', [clean('git clean -fd')]],
      ['echo ${X:-${Y:-$(rm -rf x)}}', [del(['x'])]],
    ])
    quiet(['echo $((1 + 2))', '(( x = 1 + 2 ))', 'echo ${X:-fallback}', 'echo "${X:-$Y}"', 'echo $(( x * 2 )) ${Y}', "echo '$(( $(rm -rf x) ))'", "echo '${X:-$(rm -rf x)}'"])
    test('the skipped text is still shown as a dynamic word, and nothing else changes', () => {
      expect(splitCommands('echo $((1 << 3)); ls')).toEqual([['echo', '$((1 << 3))'], ['ls']])
      expect(splitCommands('(( x = 1 << 2 )); ls')).toEqual([['ls']])
      expect(splitCommands('echo $(( $(date) + 1 ))')).toEqual([['date'], ['echo', '$(( $(date) + 1 ))']])
    })
  })
  describe('here-docs', () => {
    table([
      // the body of a here-doc is data
      ['cat <<EOF\nrm -rf x\nEOF', []],
      ["cat <<'EOF'\nrm -rf x\ngit push -f\nEOF", []],
      ['cat <<"EOF"\nrm -rf x\nEOF', []],
      ['cat <<\\EOF\nrm -rf x\nEOF', []],
      ['cat <<-EOF\n\trm -rf x\n\tEOF', []],
      ['cat > notes.txt <<EOF\ngit reset --hard\nEOF', []],
      ['bash <<EOF\nrm -rf x\nEOF', []],
      ['cat <<EOF\nrm -rf x', []],
      ['cat <<< "rm -rf x"', []],
      // ... and the command that follows is read again
      ['cat <<EOF\ndata\nEOF\nrm -rf x', [del(['x'])]],
      ['cat <<EOF && rm -rf x\ndata\nEOF', [del(['x'])]],
      ['cat <<EOF | tee .env\nA=1\nEOF', [ow('tee .env', ['.env'])]],
      ['cat <<A <<B\none\nA\ntwo\nB\nrm -rf x', [del(['x'])]],
      ['cat <<EOF\r\nbody\r\nEOF\r\nrm -rf x', [del(['x'])]],
      // an unquoted body runs `$( )`; a quoted one does not
      ['cat <<EOF\n$(rm -rf x)\nEOF', [del(['x'])]],
      ['cat <<EOF\n`rm -rf x`\nEOF', [del(['x'])]],
      ["cat <<'EOF'\n$(rm -rf x)\nEOF", []],
      ['cat <<EOF\n\\$(rm -rf x)\nEOF', []],
      // the usual way to pass a commit message
      ['git commit -m "$(cat <<\'EOF\'\nFix the user\'s bug (really)\nrm -rf /work/acme-shop\ngit reset --hard\nEOF\n)"', []],
      ['git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && git push --force', [push('git push --force')]],
      ['git add -A && git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && rm -rf build', [del(['build'])]],
    ])
  })
  describe('arithmetic is not a here-doc', () => {
    table([
      ['echo $((1 << 3))\nrm -rf x', [del(['x'])]],
      ['(( x = 1 << 2 ))\nrm -rf x', [del(['x'])]],
      ['x=$((2<<3)); rm -rf x', [del(['x'])]],
    ])
  })
  describe('separators and line breaks', () => {
    table([
      ['rm -rf a\nrm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a\r\nrm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a && rm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a || rm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a | rm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a; rm -rf b;', [del(['a']), del(['b'])]],
      ['rm -rf a & rm -rf b', [del(['a']), del(['b'])]],
      ['rm -rf a \\\n  b', [del(['a', 'b'])]],
      ['rm -rf a # not b', [del(['a'])]],
      ['rm -rf a#b', [del(['a#b'])]],
      ['rm -rf a>log', [del(['a'])]],
      ['rm -rf a 2>&1 | tee log', [del(['a'])]],
      ['rm -rf a >/dev/null 2>&1', [del(['a'])]],
      ['rm -rf a </dev/null', [del(['a'])]],
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('a backslash in a command name or an option is an escape', () => {
  table([
    ['r\\m -rf build', [del(['build'])]],
    ['rm -r\\f build', [del(['build'])]],
    ['rm \\-rf build', [del(['build'])]],
    ['rm -\\rf build', [del(['build'])]],
    ['rm -\\r\\f build', [del(['build'])]],
    ['rm -\\r build', [del(['build'], 'rm -r')]],
    ['rm --rec\\ursive build', [del(['build'], 'rm -r')]],
    ['rm --recursive --for\\ce build', [del(['build'])]],
    ['\\rm -rf build', [del(['build'])]],
    ['r\\m\\ -rf build', []],
    ['sudo r\\m -rf build', [del(['build'])]],
    ['/bin/r\\m -rf build', [del(['build'])]],
    ['/usr/bin/r\\m -r\\f build', [del(['build'])]],
    ['env A=1 r\\m -rf build', [del(['build'])]],
    ['A=1 r\\m -rf build', [del(['build'])]],
    ['nohup r\\m -rf build', [del(['build'])]],
    ['xargs r\\m -rf', [unk()]],
    ["bash -c 'r\\m -rf build'", [del(['build'])]],
    ['echo a && r\\m -rf build', [del(['build'])]],
    ['rm -rf build; r\\m -rf dist', [del(['build']), del(['dist'])]],
    ['git push -\\f origin main', [push('git push -f', 'origin', 'main')]],
    ['git push --for\\ce origin main', [push('git push --force', 'origin', 'main')]],
    ['git push --force-with-\\lease', []],
    ['git push --force-with-\\lease --for\\ce', [push('git push --force')]],
    ['g\\it push -f', [push('git push -f')]],
    ['git re\\set --hard', [reset]],
    ['git reset --h\\ard', [reset]],
    ['git cl\\ean -fd', [clean('git clean -fd')]],
    ['git clean -f\\d', [clean('git clean -fd')]],
    ['git branch -\\D x', [branch('git branch -D', 'x')]],
    ['git ch\\eckout -- .', [discard('git checkout -- .')]],
    ['git checkout -\\-force', [discard('git checkout --force')]],
    ['find . -d\\elete', [del(['.'], 'find -delete')]],
    ['f\\ind . -delete', [del(['.'], 'find -delete')]],
    ['p\\sql -c "drop table t"', [db('psql', 't')]],
    ['c\\d build && r\\m -rf x', [del([`${ROOT}/build/x`])]],
    ['rm -rf bu\\ild', [del(['bu\\ild'])]],
  ])
  describe('what must not change', () => {
    table([
      // operands keep their backslashes (Windows paths), only options and command names are escapes
      ['rm -rf C:\\proj\\build', [del(['C:\\proj\\build'])], WIN],
      ['rm -rf build\\sub', [del(['build\\sub'])]],
      ['rm -rf .\\build', [del(['.\\build'])]],
      ['Remove-Item -Recurse -Path:C:\\proj\\build', [del(['C:\\proj\\build'], 'Remove-Item -Recurse')], WIN],
      ['Remove-Item -Recurse -Path C:\\proj\\build', [del(['C:\\proj\\build'], 'Remove-Item -Recurse')], WIN],
      ['rd /s /q C:\\proj\\build', [del(['C:\\proj\\build'], 'rd /s')], WIN],
      ['C:\\Git\\bin\\rm.exe -rf build', [del(['build'])], WIN],
      ['C:\\Git\\usr\\bin\\rm -r\\f build', [del(['build'])], WIN],
      ['"C:\\Git\\bin\\rm.exe" -rf build', [del(['build'])], WIN],
      ['.\\rm -rf build', [del(['build'])]],
      ['..\\bin\\rm.exe -rf build', [del(['build'])]],
      ['\\\\server\\share\\rm.exe -rf build', [del(['build'])]],
      ['cmd /c "rd /s /q C:\\proj\\build"', [del(['C:\\proj\\build'], 'rd /s')], WIN],
      // quoted backslashes are literal, as in the shell
      ["rm '-r\\f' build", []],
      ['rm "-r\\f" build', []],
      ["'r\\m' -rf build", []],
      ['"r\\m" -rf build', []],
    ])
    quiet(['echo r\\m -rf build', 'echo \\-rf', 'ls -l\\a', 'git push\\ -f', 'rm\\ -rf build', 'rm \\build', 'rm -f\\i build'])
    test('splitCommands still keeps operand backslashes and escapes the rest as before', () => {
      expect(splitCommands('rm -r\\f C:\\proj\\build')).toEqual([['rm', '-rf', 'C:\\proj\\build']])
      expect(splitCommands('echo a\\b \\-x')).toEqual([['echo', 'a\\b', '-x']])
      expect(splitCommands('C:\\Git\\bin\\rm.exe x')).toEqual([['C:\\Git\\bin\\rm.exe', 'x']])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('commandCount', () => {
  test('counts the simple commands of a line', () => {
    const rows: Array<[string, number]> = [
      ['', 0],
      ['   \t\n ', 0],
      ['ls', 1],
      ['a; b && c | d\nrm x', 5],
      ['echo $(ls)', 2],
      ['echo "$(ls | wc -l)"', 3],
      ['(a; b)', 2],
      ['{ a; b; }', 2],
      ['cat <<EOF\nrm x\nEOF', 1],
      ['cat <<EOF\n$(date)\nEOF\nls', 3],
      ['echo a > f', 1],
      ['> f', 0],
      ['# a comment', 0],
      ['a # b; c', 1],
      ['rm -rf a; git push -f; git reset --hard', 3],
    ]
    const bad = rows.filter(([cmd, n]) => commandCount(cmd) !== n).map(([cmd]) => cmd)
    expect(bad).toEqual([])
  })
  test('agrees with splitCommands whenever that is not capped', () => {
    const bad: string[] = []
    for (const cmd of [
      'ls -la', 'a && b || c; d | e & f', 'echo "a b" \'c d\'', 'x=$(a) b', 'diff <(ls a) <(ls b)', 'if x; then y; else z; fi', 'f() { a; }',
      'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"', 'for ((i=0;i<3;i++)); do echo $i; done', 'echo $((1 << 3)); ls', 'a;;b', 'a\nb\r\nc',
    ]) {
      if (commandCount(cmd) !== splitCommands(cmd).length) bad.push(cmd)
    }
    expect(bad).toEqual([])
  })
})
