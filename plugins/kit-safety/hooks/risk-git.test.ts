import { describe, expect, test } from 'claude-code/testing'

import { classifyBash } from './risk'
import { ROOT, CTX, SUB_CTX, SENTINEL, table, quiet, del, push, discard, reset, clean, branch, erase } from '../tests/risk-helpers'
import type { Want } from '../tests/risk-helpers'

// The Bash classifier (risk.ts): git (force push, reset, clean, discard, branch delete), --force-with-lease, and git-erase (stash, reflog, gc).

// ---------------------------------------------------------------------------------------------------------------------
describe('git', () => {
  describe('force push', () => {
    table([
      ['git push --force', [push('git push --force')]],
      ['git push -f', [push('git push -f')]],
      ['git push --force origin main', [push('git push --force', 'origin', 'main')]],
      ['git push origin main --force', [push('git push --force', 'origin', 'main')]],
      ['git push -f origin main', [push('git push -f', 'origin', 'main')]],
      ['git push -fu origin main', [push('git push -fu', 'origin', 'main')]],
      ['git push -uf origin main', [push('git push -uf', 'origin', 'main')]],
      ['git push --mirror', [push('git push --mirror')]],
      ['git push --mirror backup', [push('git push --mirror', 'backup')]],
      ['git push origin +main', [push('git push +branch', 'origin', 'main')]],
      ['git push +main', [push('git push +branch', undefined, 'main')]],
      ['git push origin +HEAD:release', [push('git push +branch', 'origin', 'release')]],
      ['git push origin HEAD:refs/heads/release --force', [push('git push --force', 'origin', 'release')]],
      ['git push -f origin refs/heads/a:refs/heads/b', [push('git push -f', 'origin', 'b')]],
      ['git push -f origin HEAD', [push('git push -f', 'origin')]],
      ['git push -f origin $BRANCH', [push('git push -f', 'origin')]],
      ['git push --force --tags origin', [push('git push --force', 'origin')]],
      ['git push --force --all', [push('git push --force')]],
      ['git push -o ci.skip -f origin x', [push('git push -f', 'origin', 'x')]],
      ['git -C sub push -f', [push('git push -f')]],
      ['git -c core.editor=vim push -f', [push('git push -f')]],
      ['git --no-pager push -f', [push('git push -f')]],
      ['git --git-dir=.git push -f', [push('git push -f')]],
      ['git push -f && echo done', [push('git push -f')]],
      ['sudo git push -f', [push('git push -f')]],
      ['bash -c "git push --force origin main"', [push('git push --force', 'origin', 'main')]],
      ['git push -f https://github.com/acme/shop.git main', [push('git push -f', 'https://github.com', 'main')]],
      ['git push -f git@github.com:acme/shop.git main', [push('git push -f', 'github.com', 'main')]],
      ['git push -f ssh://git@host.example:2222/x.git', [push('git push -f', 'ssh://host.example')]],
      ['git push --repo=https://u:pw@host.example/x.git -f', [push('git push -f', 'https://host.example')]],
      ['git push --force "origin" "main"', [push('git push --force', 'origin', 'main')]],
      ['git push --force origin main:release', [push('git push --force', 'origin', 'release')]],
    ])
  })
  describe('push that is not a force push', () => {
    quiet([
      'git push', 'git push origin main', 'git push -u origin main', 'git push --set-upstream origin main', 'git push --tags', 'git push origin main:main',
      'git push --follow-tags', 'git push -o ci.skip origin main', 'git push --dry-run --force', 'git push -n -f', 'git push -fn', 'git push --force -n origin x',
      'git push --delete origin x', 'git push origin :x', 'git push -d origin x', 'git push --force --delete origin x', 'git push -f origin :x',
      'echo git push --force', 'git pull --force', 'git fetch -f', 'git fetch --force', 'git tag -f v1', 'git push origin HEAD',
    ])
  })
  describe('reset --hard', () => {
    table([
      ['git reset --hard', [reset]],
      ['git reset --hard HEAD~1', [reset]],
      ['git reset --hard origin/main', [reset]],
      ['git reset HEAD~1 --hard', [reset]],
      ['git -C sub reset --hard', [reset]],
      ['git reset --hard && git clean -fd', [reset, clean('git clean -fd')]],
      ['git stash && git reset --hard', [reset]],
      ['git reset --hard; git reset --hard', [reset]],
      ['(git reset --hard)', [reset]],
    ])
    quiet(['git reset', 'git reset --soft HEAD~1', 'git reset --mixed', 'git reset --keep HEAD~1', 'git reset HEAD file.txt', 'git reset -- file', 'git reset --merge', 'git reset -q', 'git restore --staged x'])
  })
  describe('clean', () => {
    table([
      ['git clean -f', [clean('git clean -f')]],
      ['git clean -fd', [clean('git clean -fd')]],
      ['git clean -xdf', [clean('git clean -xdf')]],
      ['git clean -fdx', [clean('git clean -fdx')]],
      ['git clean -ffd', [clean('git clean -ffd')]],
      ['git clean --force', [clean('git clean --force')]],
      ['git clean -d -f', [clean('git clean -d -f')]],
      ['git clean -f -d -x', [clean('git clean -f -d -x')]],
      ['git clean --force -d', [clean('git clean --force -d')]],
      ['git clean -fd -e keep.txt', [clean('git clean -fd -e')]],
      ['git clean -fd -- build', [clean('git clean -fd')]],
    ])
    quiet(['git clean', 'git clean -n', 'git clean -nd', 'git clean -fn', 'git clean -fdn', 'git clean --dry-run', 'git clean -f --dry-run', 'git clean -i', 'git clean -d', 'git clean -x'])
  })
  describe('checkout, restore and switch that throw changes away', () => {
    table([
      ['git checkout -- .', [discard('git checkout -- .')]],
      ['git checkout .', [discard('git checkout .')]],
      ['git checkout ./', [discard('git checkout ./')]],
      ['git checkout -- :/', [discard('git checkout -- :/')]],
      ['git checkout :/', [discard('git checkout :/')]],
      ['git checkout -f', [discard('git checkout -f')]],
      ['git checkout --force', [discard('git checkout --force')]],
      ['git checkout -f main', [discard('git checkout -f')]],
      ['git checkout HEAD -- .', [discard('git checkout -- .')]],
      ['git restore .', [discard('git restore .')]],
      ['git restore --worktree .', [discard('git restore --worktree .')]],
      ['git restore -- .', [discard('git restore -- .')]],
      ['git restore :/', [discard('git restore :/')]],
      ['git restore --staged --worktree .', [discard('git restore --worktree .')]],
      ['git restore -SW .', [discard('git restore --worktree .')]],
      ['git restore --source=HEAD~1 .', [discard('git restore .')]],
      ['git restore -s HEAD~1 .', [discard('git restore .')]],
      ['git switch -f main', [discard('git switch -f')]],
      ['git switch --force main', [discard('git switch --force')]],
      ['git switch --discard-changes main', [discard('git switch --discard-changes')]],
      ['git -C sub checkout -- .', [discard('git checkout -- .')]],
      ['git checkout -- . && git clean -fd', [discard('git checkout -- .'), clean('git clean -fd')]],
    ])
    quiet([
      'git checkout main', 'git checkout -b x', 'git checkout -b x origin/x', 'git checkout -B x', 'git checkout file.txt',
      'git checkout HEAD~1', 'git checkout -', 'git checkout -p', 'git checkout --patch .', 'git checkout feature/x',
      'git restore --staged .', 'git restore -S .', 'git restore --staged file', 'git restore -p .',
      'git switch main', 'git switch -c x', 'git switch -', 'git switch -C x', 'git switch --create y', 'git checkout',
    ])
  })
  describe('discarding named files is data loss too', () => {
    const co = (paths: string[], label = 'git checkout --', unknown = false): Want => discard(label, paths, unknown)
    table([
      ['git checkout -- a.ts', [co(['a.ts'])]],
      ['git checkout -- src/a.ts src/b.ts', [co(['src/a.ts', 'src/b.ts'])]],
      ['git checkout -- src/', [co(['src/'])]],
      ['git checkout -- file.txt', [co(['file.txt'])]],
      ['git checkout HEAD~1 -- src/a.ts', [co(['src/a.ts'])]],
      ['git checkout main -- a.ts b.ts', [co(['a.ts', 'b.ts'])]],
      ['git checkout abc1234 -- a.ts', [co(['a.ts'])]],
      ["git checkout -- 'my file.ts'", [co(['my file.ts'])]],
      ['git checkout -- "src/a b.ts" c.ts', [co(['src/a b.ts', 'c.ts'])]],
      ['git checkout -- src/*.ts', [co(['src/*.ts'])]],
      ['git checkout -- "*.ts"', [co(['*.ts'])]],
      ['git checkout -f -- a.ts', [co(['a.ts'], 'git checkout -f --')]],
      ['git checkout --force main -- a.ts', [co(['a.ts'], 'git checkout --force --')]],
      ['git checkout --ours -- a.ts', [co(['a.ts'])]],
      ['git checkout -q -- a.ts', [co(['a.ts'])]],
      ['git restore a.ts', [co(['a.ts'], 'git restore')]],
      ['git restore a.ts b.ts', [co(['a.ts', 'b.ts'], 'git restore')]],
      ['git restore src/ docs/', [co(['src/', 'docs/'], 'git restore')]],
      ['git restore src/*.ts', [co(['src/*.ts'], 'git restore')]],
      ['git restore --worktree a.ts', [co(['a.ts'], 'git restore --worktree')]],
      ['git restore -W a.ts', [co(['a.ts'], 'git restore --worktree')]],
      ['git restore --staged --worktree a.ts', [co(['a.ts'], 'git restore --worktree')]],
      ['git restore -SW a.ts', [co(['a.ts'], 'git restore --worktree')]],
      ['git restore --source=HEAD~1 a.ts', [co(['a.ts'], 'git restore')]],
      ['git restore --source HEAD~1 a.ts', [co(['a.ts'], 'git restore')]],
      ['git restore -s HEAD~1 -- a.ts', [co(['a.ts'], 'git restore --')]],
      ['git restore -- a.ts', [co(['a.ts'], 'git restore --')]],
      ['git restore --ours a.ts', [co(['a.ts'], 'git restore')]],
      // -C moves the base folder: the paths are then written in full
      ['git -C web checkout -- a.ts', [co([`${ROOT}/web/a.ts`])]],
      ['git -C web restore a.ts', [co([`${ROOT}/web/a.ts`], 'git restore')]],
      ['git -C web -C sub restore a.ts', [co([`${ROOT}/web/sub/a.ts`], 'git restore')]],
      ['git -C ./web checkout -- a.ts', [co([`${ROOT}/web/a.ts`])]],
      [`git -C ${ROOT}/web checkout -- a.ts`, [co([`${ROOT}/web/a.ts`])]],
      ['git -C ../other checkout -- a.ts', []],
      ['git -C "$D" checkout -- a.ts', [co([], 'git checkout --', true)]],
      ['git -C web checkout -- .', [discard('git checkout -- .')]],
      ['cd web && git checkout -- a.ts', [co([`${ROOT}/web/a.ts`])]],
      ['git checkout -- a.ts', [co(['a.ts'])], SUB_CTX],
      ['git -C .. checkout -- a.ts', [co([`${ROOT}/a.ts`])], SUB_CTX],
      // a path that cannot be read from its spelling, or git magic: the list is not complete
      ['git checkout -- "$F"', [co([], 'git checkout --', true)]],
      ['git checkout -- a.ts "$F"', [co(['a.ts'], 'git checkout --', true)]],
      ['git restore "$F"', [co([], 'git restore', true)]],
      ["git restore ':!keep' a.ts", [co(['a.ts'], 'git restore', true)]],
      ["git checkout -- ':(exclude)keep' a.ts", [co(['a.ts'], 'git checkout --', true)]],
      ['git restore --pathspec-from-file=list.txt', [co([], 'git restore', true)]],
      ['git restore --pathspec-from-file list.txt', [co([], 'git restore', true)]],
      ['git checkout --pathspec-from-file=list.txt', [co([], 'git checkout', true)]],
      // the whole tree keeps no paths, and wins over named files
      ['git checkout -- . a.ts', [discard('git checkout -- .')]],
      ['git restore . a.ts', [discard('git restore .')]],
      ['git checkout -f', [discard('git checkout -f')]],
      ['git checkout -f --', [discard('git checkout -f --')]],
      // paths outside the project are not ours
      ['git checkout -- /etc/hosts', []],
      ['git restore ../x', []],
      ['git checkout -- ../x a.ts', [co(['a.ts'])]],
    ])
    quiet([
      'git checkout --', 'git checkout main --', 'git checkout -p -- a.ts', 'git checkout --patch -- a.ts', 'git restore -p a.ts', 'git restore --patch -- a.ts',
      'git restore --staged a.ts', 'git restore --staged a.ts b.ts', 'git restore -S a.ts', 'git restore --staged --source=HEAD~1 a.ts', 'git restore', 'git restore --',
      'git checkout -b feature -q', 'git checkout --track origin/x', 'git checkout feature/x', 'git checkout abc1234', 'git checkout a.ts',
    ])
    test('more than 500 paths: 500 are kept, the rest is marked unknown', () => {
      const names = Array.from({ length: 600 }, (_, i) => `f${i}.ts`)
      for (const cmd of [`git checkout -- ${names.join(' ')}`, `git restore ${names.join(' ')}`]) {
        const got = classifyBash(cmd, CTX)
        expect(got.length, cmd.slice(0, 20)).toBe(1)
        expect(got[0]?.kind).toBe('discard')
        expect(got[0]?.paths).toEqual(names.slice(0, 500))
        expect(got[0]?.hasUnknownPath).toBe(true)
      }
      const exact = classifyBash(`git restore ${names.slice(0, 500).join(' ')}`, CTX)
      expect(exact[0]?.paths.length).toBe(500)
      expect(exact[0]?.hasUnknownPath).toBeUndefined()
    })
    test('the label never carries a path', () => {
      for (const r of classifyBash("git checkout -- 'secret-" + SENTINEL + ".txt'", CTX)) expect(r.label).not.toContain(SENTINEL)
      for (const r of classifyBash('git restore secret-' + SENTINEL + '.txt', CTX)) expect(r.label).not.toContain(SENTINEL)
    })
  })
  describe('branch delete', () => {
    table([
      ['git branch -D feature', [branch('git branch -D', 'feature')]],
      ['git branch -D a b', [branch('git branch -D', 'a', ['a', 'b'])]],
      ['git branch --delete --force x', [branch('git branch --delete --force', 'x')]],
      ['git branch -d -f x', [branch('git branch -d -f', 'x')]],
      ['git branch -fd x', [branch('git branch -fd', 'x')]],
      ['git branch -df x', [branch('git branch -df', 'x')]],
      ['git branch -rD origin/x', [branch('git branch -rD', 'origin/x')]],
      ['git branch -D $B', [branch('git branch -D')]],
      ['git branch --force --delete x', [branch('git branch --force --delete', 'x')]],
      ['git -C sub branch -D x', [branch('git branch -D', 'x')]],
    ])
    quiet([
      'git branch', 'git branch -d feature', 'git branch --delete feature', 'git branch -a', 'git branch -m old new', 'git branch -f x HEAD~1', 'git branch new',
      'git branch --list', 'git branch -vv', 'git branch -r', 'git branch --merged', 'git branch -u origin/x',
    ])
  })
  describe('other git commands are left alone', () => {
    quiet(['git status', 'git log --oneline', 'git diff', 'git add -A', 'git commit -m x', 'git stash', 'git stash pop', 'git rebase main', 'git merge x', 'git pull', 'git fetch', 'git rm -r --cached build', 'git tag v1', 'git remote add origin x', 'git'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('every branch a call names', () => {
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `b${i}`)
  describe('git branch -D', () => {
    table([
      ['git branch -D a b c', [branch('git branch -D', 'a', ['a', 'b', 'c'])]],
      ['git branch -D feature', [branch('git branch -D', 'feature', ['feature'])]],
      ['git branch -D a a b', [branch('git branch -D', 'a', ['a', 'b'])]],
      ['git branch -D a -f b', [branch('git branch -D -f', 'a', ['a', 'b'])]],
      ['git branch a b -D', [branch('git branch -D', 'a', ['a', 'b'])]],
      ['git branch -D $X b', [branch('git branch -D', 'b', ['b'])]],
      ['git branch -D $X $Y', [branch('git branch -D')]],
      ['git branch -D feature/x release/1.0', [branch('git branch -D', 'feature/x', ['feature/x', 'release/1.0'])]],
      ["git branch -D 'a b' c", [branch('git branch -D', 'a b', ['a b', 'c'])]],
      ['git branch -D a -- b', [branch('git branch -D', 'a', ['a', 'b'])]],
      ['git branch -d -f a b', [branch('git branch -d -f', 'a', ['a', 'b'])]],
      ['git branch -rD origin/x origin/y', [branch('git branch -rD', 'origin/x', ['origin/x', 'origin/y'])]],
    ])
    test('at most 20 names, each cleaned and cut like a single name', () => {
      const got = classifyBash(`git branch -D ${many(25).join(' ')}`, CTX)
      expect(got.length).toBe(1)
      expect(got[0]?.names).toEqual(many(20))
      expect(got[0]?.name).toBe('b0')
      const odd = classifyBash(`git branch -D a\u0001b ${'x'.repeat(100)}`, CTX)
      expect(odd[0]?.names).toEqual(['ab', 'x'.repeat(60)])
      expect(classifyBash(`git branch -D ${many(20).join(' ')}`, CTX)[0]?.names).toEqual(many(20))
    })
    test('two deletes that share the first branch are not merged into one', () => {
      expect(classifyBash('git branch -D a b; git branch -D a c', CTX).map(r => r.names)).toEqual([['a', 'b'], ['a', 'c']])
    })
  })
  describe('git push --force', () => {
    table([
      ['git push --force origin dev main release', [push('git push --force', 'origin', 'dev', ['dev', 'main', 'release'])]],
      ['git push -f origin main', [push('git push -f', 'origin', 'main', ['main'])]],
      ['git push -f origin +a:b c:d e', [push('git push -f', 'origin', 'b', ['b', 'd', 'e'])]],
      ['git push origin +main +dev', [push('git push +branch', 'origin', 'main', ['main', 'dev'])]],
      ['git push -f origin HEAD:main HEAD:dev', [push('git push -f', 'origin', 'main', ['main', 'dev'])]],
      ['git push -f origin refs/heads/a:refs/heads/b', [push('git push -f', 'origin', 'b', ['b'])]],
      ['git push -f origin main main dev', [push('git push -f', 'origin', 'main', ['main', 'dev'])]],
      ['git push -f origin HEAD x', [push('git push -f', 'origin', 'x', ['x'])]],
      ['git push -f origin $A dev', [push('git push -f', 'origin', 'dev', ['dev'])]],
      ['git push -f origin HEAD', [push('git push -f', 'origin')]],
      ['git push -f', [push('git push -f')]],
      ['git push -f +a:b origin', [push('git push -f', undefined, 'b', ['b', 'origin'])]],
    ])
    test('at most 20 names', () => {
      const got = classifyBash(`git push -f origin ${many(30).join(' ')}`, CTX)
      expect(got[0]?.names).toEqual(many(20))
      expect(got[0]?.name).toBe('b0')
    })
    test('two pushes that share the first branch are not merged into one', () => {
      expect(classifyBash('git push -f origin a b; git push -f origin a c', CTX).map(r => r.names)).toEqual([['a', 'b'], ['a', 'c']])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('--force-with-lease and --force-if-includes are not a risk on their own', () => {
  quiet([
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-with-lease=main origin main',
    'git push --force-if-includes origin main',
    'git push --force-with-lease --force-if-includes origin main',
    'git push --force-with-lease origin main:release',
    'git push -u --force-with-lease origin feature',
    'git push --force-with-lease origin HEAD',
    'git push --force-with-lease --tags',
    'git push --no-force-with-lease origin main',
    'git push --force-with-lease --dry-run origin main',
    'git -C sub push --force-with-lease',
    'git -c core.editor=vim push --force-with-lease origin main',
    'git push --force-with-lease && echo done',
    'sudo git push --force-with-lease origin main',
    'bash -c "git push --force-with-lease origin main"',
    'git push "--force-with-lease" origin main',
    "git push '--force-with-lease=main:abc' origin main",
    'echo git push --force',
  ])
  describe('next to a plain force, -f, --mirror or a +refspec the push is still forced', () => {
    table([
      ['git push --force-with-lease --force origin main', [push('git push --force', 'origin', 'main')]],
      ['git push --force --force-with-lease origin main', [push('git push --force', 'origin', 'main')]],
      ['git push --force-with-lease=main:abc123 --force origin main', [push('git push --force', 'origin', 'main')]],
      ['git push --force-if-includes --force origin main', [push('git push --force', 'origin', 'main')]],
      ['git push --force-with-lease --force-if-includes --force', [push('git push --force')]],
      ['git push --force-with-lease -f origin main', [push('git push -f', 'origin', 'main')]],
      ['git push -f --force-with-lease origin main', [push('git push -f', 'origin', 'main')]],
      ['git push -fu --force-with-lease origin main', [push('git push -fu', 'origin', 'main')]],
      ['git push -uf --force-with-lease=main:x origin main', [push('git push -uf', 'origin', 'main')]],
      ['git push --force-with-lease origin +main', [push('git push +branch', 'origin', 'main')]],
      ['git push --force-with-lease --force-if-includes origin +main:release', [push('git push +branch', 'origin', 'release')]],
      ['git push --force-with-lease --mirror', [push('git push --mirror')]],
      ['git push --force-with-lease=main:abc123 origin +HEAD:main', [push('git push +branch', 'origin', 'main')]],
      ['git push --force-with-lease -f && git branch -D x', [push('git push -f'), branch('git branch -D', 'x')]],
      ['sudo git push --force-with-lease --force', [push('git push --force')]],
    ])
  })
  test('a lease never shows up in a label, and a plain force push is the same as before', () => {
    const labels = ['git push --force-with-lease --force origin main', 'git push --force-if-includes -f', 'git push --force-with-lease origin +main'].flatMap(c => classifyBash(c, CTX).map(r => r.label))
    expect(labels).toEqual(['git push --force', 'git push -f', 'git push +branch'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('git-erase: Git\'s own safety nets', () => {
  describe('git stash drop and git stash clear', () => {
    table([
      ['git stash drop', [erase('git stash drop')]],
      ['git stash drop stash@{1}', [erase('git stash drop')]],
      ["git stash drop 'stash@{0}'", [erase('git stash drop')]],
      ['git stash drop -q', [erase('git stash drop')]],
      ['git stash drop $S', [erase('git stash drop')]],
      ['git stash clear', [erase('git stash clear')]],
      ['git -C sub stash drop', [erase('git stash drop')]],
      ['git -c core.editor=vim stash clear', [erase('git stash clear')]],
      ['git --no-pager stash drop', [erase('git stash drop')]],
      ['git --git-dir=.git stash clear', [erase('git stash clear')]],
      ['sudo git stash drop', [erase('git stash drop')]],
      ['GIT_DIR=x git stash drop', [erase('git stash drop')]],
      ['env A=1 git stash clear', [erase('git stash clear')]],
      ['nohup git stash clear', [erase('git stash clear')]],
      ['time git stash drop', [erase('git stash drop')]],
      ['bash -c "git stash drop"', [erase('git stash drop')]],
      ["sh -c 'git stash clear'", [erase('git stash clear')]],
      ['(git stash drop)', [erase('git stash drop')]],
      ['{ git stash clear; }', [erase('git stash clear')]],
      ['echo $(git stash drop)', [erase('git stash drop')]],
      ['git stash drop && echo done', [erase('git stash drop')]],
      ['echo start; git stash clear', [erase('git stash clear')]],
      ['git stash drop | cat', [erase('git stash drop')]],
      ['git stash drop # comment', [erase('git stash drop')]],
      ['echo x | xargs git stash drop', [erase('git stash drop')]],
      ['g\\it stash drop', [erase('git stash drop')]],
      ['git sta\\sh drop', [erase('git stash drop')]],
      ['git stash dr\\op', [erase('git stash drop')]],
      ["git stash 'drop'", [erase('git stash drop')]],
      ['git stash "clear"', [erase('git stash clear')]],
      ['/usr/bin/git stash drop', [erase('git stash drop')]],
      ['git stash drop\ngit stash clear', [erase('git stash drop'), erase('git stash clear')]],
      ['git stash drop && git stash clear', [erase('git stash drop'), erase('git stash clear')]],
      ['git stash drop; git stash drop', [erase('git stash drop')]],
      ['git stash drop stash@{1}; git stash drop stash@{2}', [erase('git stash drop')]],
      ['git stash drop && git stash drop && git stash clear', [erase('git stash drop'), erase('git stash clear')]],
      ['git stash clear; rm -rf build', [erase('git stash clear'), del(['build'])]],
      ['git stash drop && git reset --hard', [erase('git stash drop'), reset]],
    ])
    quiet([
      'git stash', 'git stash push', 'git stash push -m drop', 'git stash push -m "clear all"', 'git stash push -- drop', 'git stash save drop', 'git stash save "stash clear"',
      'git stash pop', 'git stash pop stash@{1}', 'git stash apply', 'git stash apply stash@{0}', 'git stash list', 'git stash show', 'git stash show -p stash@{0}',
      'git stash branch rescue', 'git stash create', 'git stash store abc123', 'git stash -u', 'git stash --include-untracked', 'git stash -k', 'git stash -- clear',
      'git stash drops', 'git stash Drop', 'git stash clear-all', 'git stashdrop', 'git stash $CMD', 'git stash "$CMD" stash@{0}', 'git stash -q drop',
      'echo git stash drop', 'echo "git stash clear"', 'git log --grep="stash drop"', 'git commit -m "git stash clear"', 'cat <<EOF\ngit stash drop\nEOF',
      'git stash;git stash pop', 'git', 'git stash --', "echo 'git stash drop' | cat",
    ])
  })

  describe('git update-ref -d', () => {
    table([
      ['git update-ref -d refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref --delete refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref -d refs/heads/x abc123', [erase('git update-ref -d')]],
      ['git update-ref -d refs/stash', [erase('git update-ref -d')]],
      ['git update-ref -d HEAD', [erase('git update-ref -d')]],
      ['git update-ref -d "$REF"', [erase('git update-ref -d')]],
      ['git update-ref refs/heads/x -d', [erase('git update-ref -d')]],
      ['git update-ref -m gone -d refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref -d -m gone refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref -dm gone refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref --no-deref -d HEAD', [erase('git update-ref -d')]],
      ['git update-ref --del refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref -d', [erase('git update-ref -d')]],
      ['git -C sub update-ref -d refs/heads/x', [erase('git update-ref -d')]],
      ['sudo git update-ref -d refs/heads/x', [erase('git update-ref -d')]],
      ['bash -c "git update-ref -d refs/heads/x"', [erase('git update-ref -d')]],
      ['git update-ref -d refs/heads/x && echo ok', [erase('git update-ref -d')]],
      ['git up\\date-ref -\\d refs/heads/x', [erase('git update-ref -d')]],
      ['git update-ref -d refs/heads/a; git update-ref -d refs/heads/b', [erase('git update-ref -d')]],
    ])
    quiet([
      'git update-ref refs/heads/x abc123', 'git update-ref HEAD abc123', 'git update-ref refs/heads/x HEAD~1', 'git update-ref -m "move it" refs/heads/x abc123',
      'git update-ref -m -d refs/heads/x HEAD', 'git update-ref -md refs/heads/x abc123', 'git update-ref -mdone refs/heads/x abc123', 'git update-ref --create-reflog refs/heads/x abc123',
      'git update-ref --stdin', 'git update-ref -z --stdin', 'git update-ref --no-deref HEAD abc123', 'git update-ref refs/x -- -d', 'git update-ref', 'git update-ref --dry-run',
      'git update-ref --deref refs/x abc', 'git update-refs -d x', 'echo git update-ref -d refs/heads/x', 'git branch x',
    ])
  })

  describe('git reflog expire', () => {
    table([
      ['git reflog expire --expire=now --all', [erase('git reflog expire')]],
      ['git reflog expire --all --expire=now', [erase('git reflog expire')]],
      ['git reflog expire --expire=now', [erase('git reflog expire')]],
      ['git reflog expire --expire=all --all', [erase('git reflog expire')]],
      ['git reflog expire --expire=NOW --all', [erase('git reflog expire')]],
      ['git reflog expire --expire-unreachable=now --all', [erase('git reflog expire')]],
      ['git reflog expire --expire-unreachable=all', [erase('git reflog expire')]],
      ['git reflog expire --expire-unreachable=now refs/heads/main', [erase('git reflog expire')]],
      ['git reflog expire --expire=now --expire-unreachable=now --all', [erase('git reflog expire')]],
      ['git reflog expire --expire now --all', [erase('git reflog expire')]],
      ['git reflog expire --expire-unreachable now', [erase('git reflog expire')]],
      ['git reflog expire --expire-u=now --all', [erase('git reflog expire')]],
      ['git reflog expire --stale-fix --expire=now --all', [erase('git reflog expire')]],
      ['git reflog expire --expire=now --all --verbose', [erase('git reflog expire')]],
      ['git reflog expire --expire=now refs/heads/main', [erase('git reflog expire')]],
      // --all next to any --expire*
      ['git reflog expire --all --expire=2.weeks.ago', [erase('git reflog expire')]],
      ['git reflog expire --expire=2.weeks.ago --all', [erase('git reflog expire')]],
      ['git reflog expire --all --expire-unreachable=90.days', [erase('git reflog expire')]],
      ['git -C sub reflog expire --expire=now --all', [erase('git reflog expire')]],
      ['sudo git reflog expire --expire=now --all', [erase('git reflog expire')]],
      ['bash -c "git reflog expire --expire=now --all"', [erase('git reflog expire')]],
      ['git re\\flog expire --expire=now --all', [erase('git reflog expire')]],
      ['git reflog expire --expire=now --all && git gc --prune=now', [erase('git reflog expire'), erase('git gc --prune=now')]],
      ['git reflog expire --expire=now --all; git reflog expire --expire-unreachable=now --all', [erase('git reflog expire')]],
    ])
    quiet([
      'git reflog', 'git reflog show', 'git reflog show HEAD', 'git reflog show --all', 'git reflog -n 5', 'git reflog exists refs/heads/x', 'git reflog delete HEAD@{1}',
      'git reflog expire', 'git reflog expire --all', 'git reflog expire --stale-fix', 'git reflog expire --stale-fix --all', 'git reflog expire --verbose --all',
      'git reflog expire --expire=2.weeks.ago', 'git reflog expire --expire=90.days.ago refs/heads/main', 'git reflog expire --expire-unreachable=30.days.ago',
      'git reflog expire --expire=never', 'git reflog expire --expire-unreachable=never refs/heads/main',
      'git reflog expire --dry-run --expire=now --all', 'git reflog expire --expire=now --all --dry-run', 'git reflog expire -n --expire=now --all', 'git reflog expire --expire=now -n',
      'git reflog expire --expire=nowhere refs/heads/main', 'git reflog expire --expire=now2 refs/x', 'git reflog expire --expire=$WHEN refs/x', 'git reflog expire -- --expire=now',
      'git reflog show --expire=now --all', 'git reflog --expire=now --all', 'git reflog $SUB --expire=now --all', 'echo git reflog expire --expire=now --all', 'git reflogs expire --expire=now',
    ])
  })

  describe('git gc --prune', () => {
    table([
      ['git gc --prune=now', [erase('git gc --prune=now')]],
      ['git gc --prune=all', [erase('git gc --prune=now')]],
      ['git gc --prune=NOW', [erase('git gc --prune=now')]],
      ['git gc --aggressive --prune=now', [erase('git gc --prune=now')]],
      ['git gc --prune=now --aggressive', [erase('git gc --prune=now')]],
      ['git gc --prune=now --auto', [erase('git gc --prune=now')]],
      ['git gc --auto --prune=now', [erase('git gc --prune=now')]],
      ['git gc --quiet --prune=all', [erase('git gc --prune=now')]],
      ['git gc --pru=now', [erase('git gc --prune=now')]],
      ['git -C sub gc --prune=now', [erase('git gc --prune=now')]],
      ['git -c gc.auto=0 gc --prune=now', [erase('git gc --prune=now')]],
      ['sudo git gc --prune=now', [erase('git gc --prune=now')]],
      ['bash -c "git gc --prune=now"', [erase('git gc --prune=now')]],
      ['git gc --prune=now && echo done', [erase('git gc --prune=now')]],
      ['git g\\c --prune=now', [erase('git gc --prune=now')]],
      ['git gc --pr\\une=now', [erase('git gc --prune=now')]],
      ['git gc --prune=now; git gc --prune=all', [erase('git gc --prune=now')]],
    ])
    quiet([
      'git gc', 'git gc --auto', 'git gc --aggressive', 'git gc --quiet', 'git gc --prune', 'git gc --prune=2.weeks.ago', 'git gc --prune=1.hour.ago', 'git gc --prune=never',
      'git gc --prune=nowhere', 'git gc --prune=now2', 'git gc --prune=$WHEN', 'git gc --no-prune', 'git gc --prune now', 'git gc -- --prune=now', 'git gc --cruft',
      'git gc --keep-largest-pack', 'git gcc --prune=now', 'git prune', 'git prune --expire=now', 'git repack -ad', 'echo git gc --prune=now', 'git commit -m "git gc --prune=now"',
    ])
  })

  describe('what the label and the risk hold', () => {
    const FIXED = new Set(['git stash drop', 'git stash clear', 'git update-ref -d', 'git reflog expire', 'git gc --prune=now'])
    test('only the fixed words, never an argument, a name, a path or a remote', () => {
      const T = SENTINEL
      const bad: string[] = []
      for (const cmd of [
        `git stash drop ${T}`,
        `git stash drop stash@{${T}}`,
        `git update-ref -d refs/heads/${T}`,
        `git update-ref -m ${T} -d refs/heads/${T} ${T}`,
        `git reflog expire --expire=now --all ${T}`,
        `git reflog expire --expire=${T} --all`,
        `git gc --prune=now ${T}`,
        `git -C ${T} stash clear`,
        `git -c user.name=${T} gc --prune=all`,
        `GIT_AUTHOR_NAME=${T} git stash drop`,
        `git stash drop "${T}\u0001\u202e"`,
        `echo ${T} | xargs git update-ref -d`,
      ]) {
        const got = classifyBash(cmd, CTX)
        if (got.length === 0) bad.push(`nothing for ${cmd}`)
        for (const r of got) {
          if (r.kind !== 'git-erase' || r.tier !== 'ask' || !FIXED.has(r.label)) bad.push(`${cmd}: ${JSON.stringify(r)}`)
          if (r.paths.length > 0 || r.name !== undefined || r.names !== undefined || r.remote !== undefined || r.source !== undefined || r.picks !== undefined || r.match !== undefined || r.hasUnknownPath !== undefined) bad.push(`${cmd}: extra ${JSON.stringify(r)}`)
          if (JSON.stringify(r).includes(T)) bad.push(`${cmd}: leaks the word`)
        }
      }
      expect(bad).toEqual([])
    })
    test('different words are different risks; the same words are one', () => {
      expect(classifyBash('git stash drop; git stash clear; git stash drop; git gc --prune=now; git gc --prune=all; git update-ref -d a; git update-ref -d b', CTX).map(r => r.label)).toEqual([
        'git stash drop', 'git stash clear', 'git gc --prune=now', 'git update-ref -d',
      ])
    })
    test('every one is a git-erase with no files, so no snapshot has anything to copy', () => {
      const got = classifyBash('git stash drop && git update-ref -d x && git reflog expire --expire=now --all && git gc --prune=now', CTX)
      expect(got.map(r => [r.kind, r.tier, r.paths.length])).toEqual([['git-erase', 'ask', 0], ['git-erase', 'ask', 0], ['git-erase', 'ask', 0], ['git-erase', 'ask', 0]])
    })
  })
})
