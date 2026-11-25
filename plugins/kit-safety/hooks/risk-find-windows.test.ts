import { describe, expect, test } from 'claude-code/testing'

import { classifyBash } from './risk'
import type { BashContext } from './risk'
import { ROOT, CTX, WIN, check, table, del, ow, push, reset } from '../tests/risk-helpers'
import type { Want } from '../tests/risk-helpers'

// The Bash classifier (risk.ts): Windows and PowerShell commands, and every form of `find` that deletes.

// ---------------------------------------------------------------------------------------------------------------------
describe('Windows and PowerShell', () => {
  describe('PowerShell Remove-Item', () => {
    const ri = (paths: string[]): Want[] => [del(paths, 'Remove-Item -Recurse')]
    table([
      ['Remove-Item -Recurse build', ri(['build']), WIN],
      ['Remove-Item -Recurse -Force build', ri(['build']), WIN],
      ['Remove-Item build -Recurse -Force', ri(['build']), WIN],
      ['remove-item -recurse build', ri(['build']), WIN],
      ['REMOVE-ITEM -RECURSE build', ri(['build']), WIN],
      ['ri -r build', ri(['build']), WIN],
      ['ri -Recurse build', ri(['build']), WIN],
      ['Remove-Item -rec build', ri(['build']), WIN],
      ['Remove-Item -r build', ri(['build']), WIN],
      ['Remove-Item -Path build -Recurse', ri(['build']), WIN],
      ['Remove-Item -LiteralPath build -Recurse', ri(['build']), WIN],
      ['Remove-Item -Path:build -Recurse', ri(['build']), WIN],
      ['Remove-Item -Recurse -Include *.tmp -Path build', ri(['build']), WIN],
      ['Remove-Item -Recurse a,b', ri(['a', 'b']), WIN],
      ["Remove-Item -Recurse 'a','b'", ri(['a', 'b']), WIN],
      ['Remove-Item -Recurse "C:\\proj\\build"', ri(['C:\\proj\\build']), WIN],
      ['Remove-Item -Recurse "C:\\proj\\build\\"', ri(['C:\\proj\\build\\']), WIN],
      ['Remove-Item -Recurse C:\\proj\\build', ri(['C:\\proj\\build']), WIN],
      ['Remove-Item -Recurse .\\build', ri(['.\\build']), WIN],
      ['Remove-Item -Recurse build\\*', ri(['build\\*']), WIN],
      ['Remove-Item -Recurse -Force .\\*', ri(['.\\*']), WIN],
      ['rm -Recurse -Force build', ri(['build']), WIN],
      ['del -Recurse build', ri(['build']), WIN],
      ['rmdir -Recurse build', ri(['build']), WIN],
      ['erase -Recurse build', ri(['build']), WIN],
      ['Remove-Item -Recurse -Force "$env:TEMP\\x"', [del([], 'Remove-Item -Recurse', true)], WIN],
      ['Remove-Item -Recurse $env:TEMP\\x', [del([], 'Remove-Item -Recurse', true)], WIN],
      ['Remove-Item -Recurse $Dir', [del([], 'Remove-Item -Recurse', true)], WIN],
      // the operands come from somewhere else
      ['Get-ChildItem build | Remove-Item -Recurse', [del([], 'Remove-Item -Recurse', true)], WIN],
      ['Remove-Item -Recurse -Path (Join-Path $root build)', [del([], 'Remove-Item -Recurse', true)], WIN],
      // not risky
      ['Remove-Item build', [], WIN],
      ['Remove-Item -Force x', [], WIN],
      ['Remove-Item -Recurse -WhatIf build', [], WIN],
      ['Remove-Item -Recurse:$false build', [], WIN],
      ['Remove-Item -Recurse C:\\other\\x', [], WIN],
      ['Remove-Item -Recurse ..\\x', [], WIN],
      ['Remove-Item -Recurse D:\\x', [], WIN],
      ['Get-ChildItem build', [], WIN],
      ['Write-Host "Remove-Item -Recurse build"', [], WIN],
    ])
  })
  describe('cmd.exe rd / rmdir / del / erase', () => {
    table([
      ['rd /s /q build', [del(['build'], 'rd /s')], WIN],
      ['rd /s build', [del(['build'], 'rd /s')], WIN],
      ['RD /S /Q build', [del(['build'], 'rd /s')], WIN],
      ['rd /s/q build', [del(['build'], 'rd /s')], WIN],
      ['rmdir /s /q build', [del(['build'], 'rmdir /s')], WIN],
      ['rmdir /q /s build', [del(['build'], 'rmdir /s')], WIN],
      ['rd /s /q C:\\proj\\build', [del(['C:\\proj\\build'], 'rd /s')], WIN],
      ['rd /s /q "C:\\proj\\build\\"', [del(['C:\\proj\\build\\'], 'rd /s')], WIN],
      ['rd /s /q "C:\\proj\\my build"', [del(['C:\\proj\\my build'], 'rd /s')], WIN],
      ['rd /s /q build out', [del(['build', 'out'], 'rd /s')], WIN],
      ['rd /s /q build\\cache', [del(['build\\cache'], 'rd /s')], WIN],
      ['rd /s /q c:\\PROJ\\build', [del(['c:\\PROJ\\build'], 'rd /s')], WIN],
      ['del /s *.log', [del(['*.log'], 'del /s')], WIN],
      ['del /s /q build\\*.tmp', [del(['build\\*.tmp'], 'del /s')], WIN],
      ['del /s/q *.log', [del(['*.log'], 'del /s')], WIN],
      ['erase /s x', [del(['x'], 'erase /s')], WIN],
      ['rd /s /q %TEMP%\\x', [del([], 'rd /s', true)], WIN],
      ['rd /s /q C:\\', [del(['C:\\'], 'rd /s')], WIN],
      ['cd /d C:\\proj\\build && rd /s /q out', [del(['C:/proj/build/out'], 'rd /s')], WIN],
      ['rd /s /q build & echo done', [del(['build'], 'rd /s')], WIN],
      // not risky
      ['rd build', [], WIN],
      ['rmdir build', [], WIN],
      ['rd /q build', [], WIN],
      ['del x', [], WIN],
      ['del /q x', [], WIN],
      ['del /f /q x', [], WIN],
      ['rd /s /q C:\\other', [], WIN],
      ['rd /s /q D:\\x', [], WIN],
      ['rd /s /q ..\\x', [], WIN],
      ['dir /s build', [], WIN],
    ])
  })
  describe('wrappers: powershell, pwsh, cmd', () => {
    table([
      ['powershell -Command "Remove-Item -Recurse build"', [del(['build'], 'Remove-Item -Recurse')], WIN],
      ['powershell -command "Remove-Item -Recurse build"', [del(['build'], 'Remove-Item -Recurse')], WIN],
      ['pwsh -NoProfile -c "Remove-Item -Recurse -Force build"', [del(['build'], 'Remove-Item -Recurse')], WIN],
      ['powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "rd /s /q build"', [del(['build'], 'rd /s')], WIN],
      ['powershell -Command Remove-Item -Recurse build', [del(['build'], 'Remove-Item -Recurse')], WIN],
      ['powershell -NoProfile -File clean.ps1', [], WIN],
      ['cmd /c "rd /s /q build"', [del(['build'], 'rd /s')], WIN],
      ['cmd.exe /c rd /s /q build', [del(['build'], 'rd /s')], WIN],
      ['cmd /c del /s /q *.log', [del(['*.log'], 'del /s')], WIN],
      ['cmd /k "rd /s /q build"', [del(['build'], 'rd /s')], WIN],
      ['cmd /c dir', [], WIN],
      ['cmd', [], WIN],
    ])
  })
  describe('Git Bash paths and a Windows project root', () => {
    table([
      ['rm -rf build', [del(['build'])], WIN],
      ['rm -rf /c/proj/build', [del(['/c/proj/build'])], WIN],
      ['rm -rf /c/proj', [del(['/c/proj'])], WIN],
      ['rm -rf /c/other', [], WIN],
      ['rm -rf /d/x', [], WIN],
      ['rm -rf /c', [del(['/c'])], WIN],
      ['rm -rf ../x', [], WIN],
      ['rm -rf C:/proj/build', [del(['C:/proj/build'])], WIN],
      ['rm -rf C:\\proj\\build', [del(['C:\\proj\\build'])], WIN],
      ['rm -rf c:/proj/build', [del(['c:/proj/build'])], WIN],
      ['rm -rf C:/other/build', [], WIN],
      ['rm -rf ~/x', [], WIN],
      ['cd /c/proj/build && rm -rf *', [del(['C:/proj/build/*'])], WIN],
      ['cd build && rm -rf out', [del(['C:/proj/build/out'])], WIN],
      ['git push --force origin main', [push('git push --force', 'origin', 'main')], WIN],
      ['git reset --hard', [reset], WIN],
      ['cp .env.example .env', [ow('cp .env.example', ['.env'], '.env.example')], WIN],
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('find: every delete form, and when the files are picked by a filter', () => {
  describe('-exec rm of any kind deletes what find picks, like -delete', () => {
    table([
      ['find . -exec rm {} \\;', [del(['.'], 'rm')]],
      ['find . -exec rm -f {} +', [del(['.'], 'rm -f')]],
      ['find build -exec rm -f {} \\;', [del(['build'], 'rm -f')]],
      ['find . -execdir rm -f {} +', [del(['.'], 'rm -f')]],
      ['find . -execdir rm {} \\;', [del(['.'], 'rm')]],
      ['find . -okdir rm -f {} \\;', [del(['.'], 'rm -f')]],
      ['find . -exec rm -rf {} +', [del(['.'])]],
      ['find . -exec rm -r {} +', [del(['.'], 'rm -r')]],
      ['find . -exec /bin/rm -f {} +', [del(['.'], 'rm -f')]],
      ['find . -exec sudo rm -f {} +', [del(['.'], 'rm -f')]],
      ['find . -exec r\\m -f {} +', [del(['.'], 'rm -f')]],
      ['find build dist -exec rm -f {} +', [del(['build', 'dist'], 'rm -f')]],
      ['find -exec rm -f {} +', [del(['.'], 'rm -f')]],
      ['find "$DIR" -exec rm -f {} +', [del([], 'rm -f', true)]],
      ['find . -exec rm -f {} + && echo done', [del(['.'], 'rm -f')]],
      // not deleting, or not here
      ['find /tmp -exec rm -f {} +', []],
      ['find ../x -exec rm {} \\;', []],
      ['find . -exec echo rm {} \\;', []],
      ['find . -exec ls {} +', []],
      ['find . -exec chmod -R a+r {} +', []],
      ['find . -exec rmdir {} +', []],
      ['find . -exec mv {} /tmp \\;', []],
    ])
    test('a plain rm is only a delete inside find, never on its own', () => {
      check('rm file.txt', [])
      check('rm -f file.txt', [])
      check('xargs rm -f', [])
    })
  })
  describe('picks: some predicate or option chooses the files', () => {
    const P = (label: string, paths: string[]): Want => del(paths, label, false, true)
    table([
      // nothing but start paths and the action: no picks
      ['find build -delete', [del(['build'], 'find -delete')]],
      ['find . -delete', [del(['.'], 'find -delete')]],
      ['find build dist -delete', [del(['build', 'dist'], 'find -delete')]],
      ['find -L . -delete', [del(['.'], 'find -delete')]],
      ['find . -depth -delete', [del(['.'], 'find -delete')]],
      ['find . -print -delete', [del(['.'], 'find -delete')]],
      ['find . -delete -print0', [del(['.'], 'find -delete')]],
      ['find . -exec rm -rf {} +', [del(['.'])]],
      ['find build -exec rm -f {} \\;', [del(['build'], 'rm -f')]],
      ['find . -execdir rm {} +', [del(['.'], 'rm')]],
      // any other predicate or option picks
      ["find . -name '*.pyc' -delete", [P('find -delete', ['.'])]],
      ["find . -iname '*.TMP' -delete", [P('find -delete', ['.'])]],
      ['find . -path ./build/x -delete', [P('find -delete', ['.'])]],
      ["find . -regex '.*x' -delete", [P('find -delete', ['.'])]],
      ['find . -type f -delete', [P('find -delete', ['.'])]],
      ['find . -type d -empty -delete', [P('find -delete', ['.'])]],
      ['find . -mtime +30 -delete', [P('find -delete', ['.'])]],
      ['find . -newer ref -delete', [P('find -delete', ['.'])]],
      ['find . -size +1M -delete', [P('find -delete', ['.'])]],
      ['find . -perm 600 -delete', [P('find -delete', ['.'])]],
      ['find . -user bob -delete', [P('find -delete', ['.'])]],
      ['find . -empty -delete', [P('find -delete', ['.'])]],
      ['find . -maxdepth 1 -delete', [P('find -delete', ['.'])]],
      ['find . -mindepth 1 -delete', [P('find -delete', ['.'])]],
      ['find . -prune -delete', [P('find -delete', ['.'])]],
      ['find . ! -name keep -delete', [P('find -delete', ['.'])]],
      ['find . -not -name keep -delete', [P('find -delete', ['.'])]],
      ['find . -name a -o -name b -delete', [P('find -delete', ['.'])]],
      ['find . -name a -a -type f -delete', [P('find -delete', ['.'])]],
      ['find . \\( -name a -o -name b \\) -delete', [P('find -delete', ['.'])]],
      ['find -name x -delete', [P('find -delete', ['.'])]],
      ['find build -type f -name x -delete', [P('find -delete', ['build'])]],
      ["find . -name '*.o' -exec rm -f {} +", [P('rm -f', ['.'])]],
      ["find . -type d -execdir rm -rf {} +", [P('rm -rf', ['.'])]],
      ["find . -name x -ok rm {} \\;", [P('rm', ['.'])]],
      ['find . -mtime +7 -exec rm {} \\;', [P('rm', ['.'])]],
      // another -exec before the deleting one is a test that filters
      ['find . -exec grep -q x {} \\; -exec rm {} \\;', [P('rm', ['.'])]],
      // a filter after the action still decides what the action reaches
      ['find . -exec rm {} \\; -name x', [P('rm', ['.'])]],
      ["find . -type f -exec sh -c 'rm \"$1\"' _ {} \\;", [{ ...del([], 'rm', true, true) }]],
    ])
    test('only deletes from find carry picks; an rm or a git call never does', () => {
      const bad: string[] = []
      for (const cmd of ['rm -rf build', 'rm -rf build/*.o', "rm -rf 'a b'", 'git clean -fd', 'git checkout -- .', 'git reset --hard', 'psql -c "drop table t"', 'cp x .env', 'git branch -D a', 'git push -f']) {
        for (const r of classifyBash(cmd, CTX)) if (r.picks !== undefined) bad.push(cmd)
      }
      expect(bad).toEqual([])
    })
    test('picks marks the deletes that come from the find, not the rm after it', () => {
      const got = classifyBash("find . -name '*.o' -delete -exec rm -f {} +; rm -rf dist", CTX)
      // the two deletes of find's files are one risk; the plain rm is its own and carries no picks
      expect(got.map(r => [r.paths, r.picks === true])).toEqual([[['.'], true], [['dist'], false]])
      const apart = classifyBash('find build -name x -delete; find dist -delete', CTX)
      expect(apart.map(r => [r.paths, r.picks === true])).toEqual([[['build'], true], [['dist'], false]])
    })
  })
  describe('match: the first name pattern of the filter', () => {
    /** Each delete as [paths, picks, match]. */
    const shape = (cmd: string, ctx: BashContext = CTX): Array<[string[], boolean, string | undefined]> => classifyBash(cmd, ctx).map(r => [r.paths, r.picks === true, r.match])
    const rows: Array<[string, Array<[string[], boolean, string | undefined]>]> = [
      // the form that matters most
      ['find . -name node_modules -prune -exec rm -rf {} +', [[['.'], true, 'node_modules']]],
      // a filter with no name pattern: picks, no match; no filter: neither
      ['find . -type f -mtime +30 -delete', [[['.'], true, undefined]]],
      ['find . -type f -mtime +30 -exec rm -f {} +', [[['.'], true, undefined]]],
      ['find . -newer ref -delete', [[['.'], true, undefined]]],
      ['find . -size +1M -delete', [[['.'], true, undefined]]],
      ['find . -maxdepth 2 -empty -delete', [[['.'], true, undefined]]],
      ['find . -delete', [[['.'], false, undefined]]],
      ['find build -delete', [[['build'], false, undefined]]],
      ['find . -exec rm -rf {} +', [[['.'], false, undefined]]],
      ['find . -depth -print -delete', [[['.'], false, undefined]]],
      // every test that carries a name pattern
      ["find . -name '*.pyc' -delete", [[['.'], true, '*.pyc']]],
      ["find . -iname '*.TMP' -delete", [[['.'], true, '*.TMP']]],
      ["find . -path './build/*' -delete", [[['.'], true, './build/*']]],
      ["find . -ipath './Build/*' -delete", [[['.'], true, './Build/*']]],
      ["find . -wholename './a/b' -delete", [[['.'], true, './a/b']]],
      ["find . -iwholename './A/B' -delete", [[['.'], true, './A/B']]],
      ["find . -regex '.*\\.o' -delete", [[['.'], true, '.*\\.o']]],
      // quoting is read like the shell reads it
      ['find . -name "*.log" -delete', [[['.'], true, '*.log']]],
      ["find . -name 'my file' -delete", [[['.'], true, 'my file']]],
      ['find . -name my\\ file -delete', [[['.'], true, 'my file']]],
      ['find . -name \\*.log -delete', [[['.'], true, '*.log']]],
      ["find . -name 'a\"b' -delete", [[['.'], true, 'a"b']]],
      // the first pattern wins
      ['find . -name a -name b -delete', [[['.'], true, 'a']]],
      ['find . -type f -name x -o -name y -delete', [[['.'], true, 'x']]],
      ["find . -iname a -path './b' -delete", [[['.'], true, 'a']]],
      ["find . -type f -path './b' -name a -delete", [[['.'], true, './b']]],
      ['find . \\( -name a -o -name b \\) -delete', [[['.'], true, 'a']]],
      // every delete form
      ['find . -name x -exec rm -f {} +', [[['.'], true, 'x']]],
      ['find . -name x -exec rm -f {} \\;', [[['.'], true, 'x']]],
      ['find . -name x -execdir rm -f {} +', [[['.'], true, 'x']]],
      ['find . -name x -ok rm {} \\;', [[['.'], true, 'x']]],
      ['find . -name x -okdir rm {} \\;', [[['.'], true, 'x']]],
      ['find . -name x -delete -exec rm -f {} +', [[['.'], true, 'x']]],
      ["find . -name '*.o' -exec sh -c 'rm \"$1\"' _ {} \\;", [[[], true, '*.o']]],
      ['find build dist -name x -delete', [[['build', 'dist'], true, 'x']]],
      ['find -name x -delete', [[['.'], true, 'x']]],
      ['find -L . -name x -delete', [[['.'], true, 'x']]],
      ['find . -name x -type f -delete', [[['.'], true, 'x']]],
      ['find . -name x -delete -print', [[['.'], true, 'x']]],
      ['find . -regextype posix-extended -regex ".*x" -delete', [[['.'], true, '.*x']]],
      // a name that is spared or negated does not say what is deleted
      ['find src -name "*.pyc" -prune -o -exec rm {} +', [[['src'], true, undefined]]],
      ['find . -name node_modules -prune -o -exec rm -rf {} +', [[['.'], true, undefined]]],
      ['find . -name node_modules -prune -o -type f -delete', [[['.'], true, undefined]]],
      ['find . \\( -name node_modules -prune \\) -o -exec rm -rf {} +', [[['.'], true, undefined]]],
      ['find . -name a -type d -prune -o -exec rm -rf {} +', [[['.'], true, undefined]]],
      ['find . -name a -prune -o -name b -exec rm -rf {} +', [[['.'], true, 'b']]],
      ['find . -name a -prune -o -name b -delete', [[['.'], true, 'b']]],
      ['find . ! -name keep -delete', [[['.'], true, undefined]]],
      ['find . -not -name keep -delete', [[['.'], true, undefined]]],
      ['find . ! -path "./keep/*" -delete', [[['.'], true, undefined]]],
      ['find . ! -name keep -name "*.tmp" -delete', [[['.'], true, '*.tmp']]],
      ['find . -not -name keep -iname "*.tmp" -delete', [[['.'], true, '*.tmp']]],
      ['find . -name "*.tmp" ! -name keep -delete', [[['.'], true, '*.tmp']]],
      // a pattern that cannot be read, is empty, or is only invisible characters
      ['find . -name "$X" -delete', [[['.'], true, undefined]]],
      ['find . -name "$(cat names)" -delete', [[['.'], true, undefined]]],
      ['find . -name "$X" -iname "*.o" -delete', [[['.'], true, '*.o']]],
      ["find . -name '' -delete", [[['.'], true, undefined]]],
      ["find . -name '' -iname x -delete", [[['.'], true, 'x']]],
      ['find . -name \u0001\u0002 -delete', [[['.'], true, undefined]]],
      ['find . -name', []],
      // the pattern text: control and direction characters out, at most 60 characters
      ["find . -name 'a\u0001b\u007fc' -delete", [[['.'], true, 'abc']]],
      ["find . -name 'a\u202eb\u200bc\u2066d\ufeffe\u00adf' -delete", [[['.'], true, 'abcdef']]],
      ["find . -name 'a\u0085b' -delete", [[['.'], true, 'ab']]],
      [`find . -name '${'x'.repeat(100)}' -delete`, [[['.'], true, 'x'.repeat(60)]]],
      [`find . -name '${'x'.repeat(60)}' -delete`, [[['.'], true, 'x'.repeat(60)]]],
      [`find . -name '${'x'.repeat(61)}' -delete`, [[['.'], true, 'x'.repeat(60)]]],
      [`find . -name '${'x'.repeat(59)}\u{1F600}' -delete`, [[['.'], true, 'x'.repeat(59)]]],
      [`find . -name '${'x'.repeat(58)}\u{1F600}' -delete`, [[['.'], true, 'x'.repeat(58) + '\u{1F600}']]],
      [`find . -name '${'\u0001'.repeat(100)}${'y'.repeat(70)}' -delete`, [[['.'], true, 'y'.repeat(60)]]],
      // other commands around
      ["find . -name '*.o' -delete; rm -rf dist", [[['.'], true, '*.o'], [['dist'], false, undefined]]],
      ["rm -rf dist; find . -name '*.o' -delete", [[['dist'], false, undefined], [['.'], true, '*.o']]],
      ["find . -name '*.o' -delete -exec rm -f {} +; rm -rf dist", [[['.'], true, '*.o'], [['dist'], false, undefined]]],
      ['find . -name a -delete; find . -name b -delete', [[['.'], true, 'a'], [['.'], true, 'b']]],
      ['find . -name a -delete; find . -name a -delete', [[['.'], true, 'a']]],
      ['find . -name a -delete; find . -type f -delete', [[['.'], true, 'a'], [['.'], true, undefined]]],
      ['find . -name a -delete; find . -delete', [[['.'], true, 'a'], [['.'], false, undefined]]],
      ['find build -name a -delete; find dist -name a -delete', [[['build'], true, 'a'], [['dist'], true, 'a']]],
      // through wrappers and chains
      ["sudo find . -name '*.o' -delete", [[['.'], true, '*.o']]],
      ['bash -c "find . -name node_modules -prune -exec rm -rf {} +"', [[['.'], true, 'node_modules']]],
      ["env A=1 find . -name '*.o' -delete", [[['.'], true, '*.o']]],
      ["find . -name '*.o' -delete && echo done", [[['.'], true, '*.o']]],
      ["(find . -name '*.o' -delete)", [[['.'], true, '*.o']]],
      ['find . -name x -exec sudo rm -f {} +', [[['.'], true, 'x']]],
      ["f\\ind . -n\\ame '*.o' -d\\elete", [[['.'], true, '*.o']]],
      ['cd build && find . -name x -delete', [[[`${ROOT}/build`], true, 'x']]],
    ]
    for (const [cmd, want] of rows) test(cmd.replace(/[\u0000-\u001f]/g, '?'), () => expect(shape(cmd), JSON.stringify(cmd)).toEqual(want))

    test('a name test inside -exec is the command\'s own argument, not the find\'s filter', () => {
      expect(shape("find . -exec grep -name x {} \\; -exec rm -f {} \\;")).toEqual([[['.'], true, undefined]])
      expect(shape("find . -type f -exec ls -name x {} \\; -delete")).toEqual([[['.'], true, undefined]])
    })
    test('no delete, no risk: a name pattern alone does nothing', () => {
      for (const cmd of ["find . -name '*.o'", "find . -name '*.o' -print", "find . -name '*.o' -exec ls {} +", "find . -name '*.o' | xargs ls"]) {
        expect(classifyBash(cmd, CTX), cmd).toEqual([])
      }
    })
    test('a delete that does not come from a find never has a match', () => {
      const bad: string[] = []
      for (const cmd of ["find . -name x -print0 | xargs -0 rm -rf", 'rm -rf build', 'rm -rf build/*.o', 'git clean -fd', 'git checkout -- .', 'git reset --hard', 'psql -c "drop table t"', 'cp x .env', 'git branch -D a', 'git push -f',
        'git stash drop', 'wrangler d1 execute db --command "DELETE FROM t"', 'cat names | xargs rm -rf']) {
        for (const r of classifyBash(cmd, CTX)) if (r.match !== undefined) bad.push(cmd)
      }
      expect(bad).toEqual([])
    })
    test('a match goes with picks, never alone', () => {
      const bad: string[] = []
      for (const [cmd] of rows) for (const r of classifyBash(cmd, CTX)) if (r.match !== undefined && r.picks !== true) bad.push(cmd)
      expect(bad).toEqual([])
    })
    test('a match never holds a control or direction character, and is at most 60 long', () => {
      const bad: string[] = []
      const hostile = ['\u0000', '\u0007', '\u001b', '\n', '\r\n', '\t', '\u007f', '\u0085', '\u200e', '\u200f', '\u202a', '\u202d', '\u202e', '\u2028', '\u2029', '\u2066', '\u2069', '\ufeff', '\u00ad', '\u2060']
      for (const ch of hostile) {
        const r = classifyBash(`find . -name 'a${ch}b${ch.repeat(80)}${'z'.repeat(80)}' -delete`, CTX)[0]
        const m = r?.match
        if (m === undefined || m.length > 60 || /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(m) || !m.startsWith('abz')) bad.push(JSON.stringify([ch, m]))
      }
      expect(bad).toEqual([])
    })
  })
  describe('every -prune -exec rm form is a filtered delete', () => {
    const forms = [
      'find . -name node_modules -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -exec rm -rf {} \\;',
      "find . -name node_modules -prune -exec rm -rf '{}' +",
      "find . -name node_modules -prune -exec rm -rf '{}' \\;",
      'find . -name node_modules -prune -exec rm -rf "{}" +',
      'find . -name node_modules -type d -prune -exec rm -rf {} +',
      'find . -type d -name node_modules -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -execdir rm -rf {} +',
      'find . -name node_modules -prune -ok rm -rf {} \\;',
      'find . -name node_modules -prune -okdir rm -rf {} \\;',
      'find . \\( -name node_modules -prune \\) -exec rm -rf {} +',
      'find . -name node_modules -a -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -a -exec rm -rf {} +',
      'find . -prune -exec rm -rf {} +',
      'find . -prune -exec rm {} +',
      'find . -name node_modules -prune -o -exec rm -rf {} +',
      'find . -name node_modules -prune -o -type f -exec rm -f {} +',
      "find src -name '*.pyc' -prune -o -exec rm {} +",
      "find src -name '*.pyc' -prune -o -exec rm -f {} \\;",
      "find src -name '*.pyc' -prune -o -exec rm -f {} + -print",
      'find build dist -name x -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -exec sudo rm -rf {} +',
      'find . -name node_modules -prune -exec /bin/rm -rf {} +',
      'find . -name node_modules -prune -exec rm -r {} +',
      'find . -name node_modules -prune -exec rm -f {} +',
      'find . -name node_modules -prune -exec rm {} +',
      'find -name node_modules -prune -exec rm -rf {} +',
      'find . -maxdepth 3 -name node_modules -prune -exec rm -rf {} +',
      'find . -depth -name node_modules -prune -exec rm -rf {} +',
      'find -L . -name node_modules -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -exec rm -rf {} + -print',
      'find . -name node_modules -prune -exec rm -rf -- {} +',
      'find . -name node_modules -prune -exec env A=1 rm -rf {} +',
      'find . -name node_modules -prune -exec nohup rm -rf {} +',
      "find . -name node_modules -prune -exec sh -c 'rm -rf \"$0\"' {} \\;",
      'sudo find . -name node_modules -prune -exec rm -rf {} +',
      'bash -c "find . -name node_modules -prune -exec rm -rf {} +"',
      'cd web && find . -name node_modules -prune -exec rm -rf {} +',
      'find . -name node_modules -prune -exec rm -rf {} + && echo ok',
      'echo go; find . -name node_modules -prune -exec rm -rf {} +',
    ]
    test('each gives a delete with picks (and the paths it reaches)', () => {
      const bad: string[] = []
      for (const cmd of forms) {
        const got = classifyBash(cmd, CTX)
        const dels = got.filter(r => r.kind === 'delete')
        if (dels.length !== 1 || got.length !== 1 || dels[0]!.picks !== true) bad.push(`${cmd}: ${JSON.stringify(got)}`)
      }
      expect(bad).toEqual([])
    })
    test('the exact forms of the review', () => {
      expect(classifyBash('find . -name node_modules -prune -exec rm -rf {} +', CTX)).toEqual([
        { kind: 'delete', tier: 'ask', label: 'rm -rf', paths: ['.'], picks: true, match: 'node_modules' },
      ])
      expect(classifyBash("find src -name '*.pyc' -prune -o -exec rm {} +", CTX)).toEqual([{ kind: 'delete', tier: 'ask', label: 'rm', paths: ['src'], picks: true }])
    })
    test('the same forms that are outside the project, or do not delete, stay quiet', () => {
      for (const cmd of ['find /tmp -name x -prune -exec rm -rf {} +', 'find ../x -name x -prune -exec rm -rf {} +', 'find . -name x -prune -exec ls {} +', 'find . -name x -prune -exec echo rm -rf {} +', 'find . -name x -prune -print']) {
        expect(classifyBash(cmd, CTX), cmd).toEqual([])
      }
    })
  })
})
