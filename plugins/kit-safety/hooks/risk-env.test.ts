import { describe, expect, test } from 'claude-code/testing'

import { classifyFile, envDiff, isEnvLike } from './risk'
import type { FileFacts } from './risk'
import type { Risk } from './types'
import { ROOT, SENTINEL, table, quiet, ow, timed } from '../tests/risk-helpers'

// isEnvLike, envDiff, classifyFile (Write and Edit on .env-like files), and overwriting .env-like files from Bash.

// ---------------------------------------------------------------------------------------------------------------------
describe('isEnvLike', () => {
  const yes = [
    '.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.staging.local', '.env.production.local',
    'prod.env', 'staging.env', 'a.env', '.envrc', '.ENV', '.Env.Local', 'PROD.ENV', '.env.backup', '.env.bak', '.env.old',
    '/work/acme-shop/.env', 'config/.env.local', 'C:\\proj\\.env', 'C:\\proj\\config\\prod.env', '/x/.env/', '.env/', 'apps/web/.envrc',
  ]
  const no = [
    '', '/', 'env', '.environment', '.venv', 'env.txt', 'envfile', '.env.example', '.env.sample', '.env.template', '.env.dist',
    '.env.defaults', '.env.schema', '.ENV.EXAMPLE', '.env.local.example', '.env.production.sample', 'prod.env.example', 'a.env.sample',
    '.envrc.example', 'src/env.ts', '.gitignore', 'package.json', 'my.environment', '.env.', 'README.env.md', '/x/.env/lib/foo.py',
    'C:\\proj\\.env.example',
  ]
  for (const p of yes) test(`yes: ${p}`, () => expect(isEnvLike(p), p).toBe(true))
  for (const p of no) test(`no: ${JSON.stringify(p)}`, () => expect(isEnvLike(p), p).toBe(false))
  test('odd input does not throw', () => {
    expect(isEnvLike(undefined as unknown as string)).toBe(false)
    expect(isEnvLike(null as unknown as string)).toBe(false)
    expect(isEnvLike(42 as unknown as string)).toBe(false)
    expect(isEnvLike('\0.env')).toBe(true)
    expect(isEnvLike('\0')).toBe(false)
    timed('slashes', () => expect(isEnvLike('/'.repeat(1 << 20))).toBe(false))
    timed('deep', () => expect(isEnvLike('a/'.repeat(1 << 19) + '.env')).toBe(true))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('envDiff', () => {
  test('same keys: nothing removed or added', () => {
    expect(envDiff('A=1\nB=2\n', 'B=9\nA=8\n')).toEqual({ before: 2, after: 2, removed: [], added: [] })
  })
  test('removed and added keys, in order of first appearance', () => {
    const d = envDiff('A=1\nB=2\nC=3\n', 'C=3\nD=4\nA=1\nE=5\n')
    expect(d.before).toBe(3)
    expect(d.after).toBe(4)
    expect(d.removed).toEqual(['B'])
    expect(d.added).toEqual(['D', 'E'])
  })
  test('everything removed', () => {
    expect(envDiff('A=1\nB=2\n', '')).toEqual({ before: 2, after: 0, removed: ['A', 'B'], added: [] })
  })
  test('everything added', () => {
    expect(envDiff('', 'A=1\nB=2\n')).toEqual({ before: 0, after: 2, removed: [], added: ['A', 'B'] })
  })
  test('export, quotes, spaces around =, comments, blank lines', () => {
    const text = '# header\n\nexport A="x y"\nB=\'q\'\n  C = 3\n#D=4\nE=5 # trailing\n'
    expect(envDiff(text, '').removed).toEqual(['A', 'B', 'C', 'E'])
  })
  test('CRLF line ends', () => {
    expect(envDiff('A=1\r\nB=2\r\n', 'A=1\r\n')).toEqual({ before: 2, after: 1, removed: ['B'], added: [] })
  })
  test('duplicate keys count once', () => {
    expect(envDiff('A=1\nA=2\nB=3\n', 'A=1\n')).toEqual({ before: 2, after: 1, removed: ['B'], added: [] })
  })
  test('keys may hold dots and dashes; lowercase is fine', () => {
    expect(envDiff('my.key-1=a\nlower=b\n_X=c\n', '').removed).toEqual(['my.key-1', 'lower', '_X'])
  })
  test('lines that are not keys are ignored', () => {
    expect(envDiff('1BAD=x\n=y\nA B=c\nplain words\nGOOD=1\n', '').removed).toEqual(['GOOD'])
  })
  test('a value that contains = is one key', () => {
    expect(envDiff('URL=a=b=c\n', '').removed).toEqual(['URL'])
  })
  test('an empty value is still a key', () => {
    expect(envDiff('EMPTY=\n', '').removed).toEqual(['EMPTY'])
  })
  test('a multi-line quoted value does not produce keys', () => {
    expect(envDiff('A="line one\nB=not_a_key\nend"\nC=3\n', '').removed).toEqual(['A', 'C'])
    expect(envDiff("A='x\nB=y\n'\n", '').removed).toEqual(['A'])
  })
  test('an unclosed quote does not swallow the file', () => {
    expect(envDiff('A="oops\nB=2\nC=3\n', '').removed).toEqual(['A', 'B', 'C'])
  })
  test('text with no keys gives zeros', () => {
    expect(envDiff('', '')).toEqual({ before: 0, after: 0, removed: [], added: [] })
    expect(envDiff('hello world\nthis is not dotenv\n', 'neither')).toEqual({ before: 0, after: 0, removed: [], added: [] })
    expect(envDiff('{"json": true}', '[1,2]')).toEqual({ before: 0, after: 0, removed: [], added: [] })
  })
  test('lists are capped at 50, counts are not', () => {
    const many = Array.from({ length: 120 }, (_, i) => `K${i}=v`).join('\n')
    const d = envDiff(many, '')
    expect(d.before).toBe(120)
    expect(d.removed).toHaveLength(50)
    expect(d.removed[0]).toBe('K0')
    expect(envDiff('', many).added).toHaveLength(50)
  })
  test('values never appear in the result', () => {
    const oldText = `A=${SENTINEL}one\nB="${SENTINEL}two"\nexport C='${SENTINEL}three'\nD=${SENTINEL}four # ${SENTINEL}c\n`
    const newText = `A=${SENTINEL}five\nE=${SENTINEL}six\n`
    const json = JSON.stringify(envDiff(oldText, newText))
    expect(json).not.toContain(SENTINEL)
    expect(json).toContain('"B"')
    expect(json).toContain('"E"')
    expect(JSON.stringify(envDiff(`A="${SENTINEL}\nB=${SENTINEL}\n"\n`, ''))).not.toContain(SENTINEL)
  })
  test('odd input is total', () => {
    expect(envDiff(undefined as unknown as string, null as unknown as string)).toEqual({ before: 0, after: 0, removed: [], added: [] })
    expect(envDiff('\0\0=\0', 'A=\0')).toEqual({ before: 0, after: 1, removed: [], added: ['A'] })
    timed('many lines', () => envDiff('A=1\n'.repeat(1 << 18), 'B=2\n'.repeat(1 << 18)))
    timed('one long line', () => envDiff('A=' + 'x'.repeat(1 << 20), 'export' + ' '.repeat(1 << 20)))
    timed('quotes', () => envDiff('A="\n'.repeat(1 << 17), ''))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('classifyFile', () => {
  const f = (over: Partial<FileFacts> = {}): FileFacts => ({ isInsideRoot: true, exists: true, isTracked: undefined, isIgnored: undefined, ...over })
  const snap = (path: string, tool = 'Write'): Risk => ({ kind: 'overwrite', tier: 'snapshot', label: tool, paths: [path] })
  const ask = (path: string, tool = 'Write'): Risk => ({ kind: 'overwrite', tier: 'ask', label: tool, paths: [path] })

  test('outside the project: nothing', () => {
    expect(classifyFile('Write', 'src/a.ts', f({ isInsideRoot: false }))).toBeNull()
    expect(classifyFile('Write', '.env', f({ isInsideRoot: false }))).toBeNull()
    expect(classifyFile('Write', 'src/a.ts', f({ isInsideRoot: false, isTracked: false, isIgnored: false }))).toBeNull()
  })
  test('a file that does not exist yet: nothing', () => {
    expect(classifyFile('Write', 'src/new.ts', f({ exists: false }))).toBeNull()
    expect(classifyFile('Write', '.env', f({ exists: false }))).toBeNull()
    expect(classifyFile('Write', 'a.ts', f({ exists: false, isTracked: false, isIgnored: false }))).toBeNull()
  })
  test('a .env-like file always asks, whatever git says', () => {
    for (const tracked of [true, false, undefined]) {
      for (const ignored of [true, false, undefined]) {
        expect(classifyFile('Write', '.env', f({ isTracked: tracked, isIgnored: ignored }))).toEqual(ask('.env'))
      }
    }
    expect(classifyFile('Edit', 'config/.env.production', f())).toEqual(ask('config/.env.production', 'Edit'))
    expect(classifyFile('MultiEdit', 'prod.env', f({ isIgnored: true }))).toEqual(ask('prod.env', 'MultiEdit'))
  })
  test('a tracked file is safe: git has it', () => {
    expect(classifyFile('Write', 'src/a.ts', f({ isTracked: true }))).toBeNull()
    expect(classifyFile('Edit', 'src/a.ts', f({ isTracked: true, isIgnored: false }))).toBeNull()
    expect(classifyFile('Edit', 'src/a.ts', f({ isTracked: true, isIgnored: true }))).toBeNull()
  })
  test('an ignored file is not exempt: it can hold local config, keys and databases, so it is saved quietly', () => {
    expect(classifyFile('Write', 'dist/a.js', f({ isTracked: false, isIgnored: true }))).toEqual(snap('dist/a.js'))
    expect(classifyFile('Write', 'dist/a.js', f({ isTracked: undefined, isIgnored: true }))).toEqual(snap('dist/a.js'))
    expect(classifyFile('Edit', 'config/secrets.json', f({ isTracked: false, isIgnored: true }))).toEqual(snap('config/secrets.json', 'Edit'))
    expect(classifyFile('Write', 'data/app.sqlite', f({ isIgnored: true }))).toEqual(snap('data/app.sqlite'))
  })
  test('tracked still wins over ignored, and a .env-like file still asks', () => {
    expect(classifyFile('Write', 'dist/a.js', f({ isTracked: true, isIgnored: true }))).toBeNull()
    expect(classifyFile('Write', '.env.local', f({ isTracked: false, isIgnored: true }))).toEqual(ask('.env.local'))
    expect(classifyFile('Write', 'dist/a.js', f({ isInsideRoot: false, isIgnored: true }))).toBeNull()
    expect(classifyFile('Write', 'dist/a.js', f({ exists: false, isIgnored: true }))).toBeNull()
  })
  test('an untracked file, or git unknown, is saved quietly', () => {
    expect(classifyFile('Write', 'notes.md', f({ isTracked: false, isIgnored: false }))).toEqual(snap('notes.md'))
    expect(classifyFile('Write', 'notes.md', f({ isTracked: false }))).toEqual(snap('notes.md'))
    expect(classifyFile('Write', 'notes.md', f())).toEqual(snap('notes.md'))
    expect(classifyFile('Edit', 'notes.md', f({ isIgnored: false }))).toEqual(snap('notes.md', 'Edit'))
  })
  test('templates are not .env files', () => {
    expect(classifyFile('Write', '.env.example', f())).toEqual(snap('.env.example'))
    expect(classifyFile('Write', '.env.example', f({ isTracked: true }))).toBeNull()
  })
  test('the label is the tool name, at most 40 characters', () => {
    expect(classifyFile('NotebookEdit', 'a.ipynb', f())?.label).toBe('NotebookEdit')
    expect(classifyFile('x'.repeat(100), 'a.ts', f())?.label.length).toBe(40)
    expect(classifyFile('Wr\nite\0', 'a.ts', f())?.label).toBe('Write')
  })
  test('odd input is total', () => {
    expect(classifyFile(undefined as unknown as string, 'a.ts', f())?.label).toBe('')
    expect(classifyFile('Write', 'a.ts', undefined as unknown as FileFacts)).toBeNull()
    expect(classifyFile('Write', '\0'.repeat(1000), f())?.tier).toBe('snapshot')
    timed('long path', () => classifyFile('Write', 'a/'.repeat(1 << 19), f()))
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('overwriting .env-like files from Bash', () => {
  describe('cp, mv, install', () => {
    table([
      ['cp .env.example .env', [ow('cp .env.example', ['.env'], '.env.example')]],
      ['cp .env.example .env.local', [ow('cp .env.example', ['.env.local'], '.env.example')]],
      ['cp backup/.env .env', [ow('cp .env', ['.env'], 'backup/.env')]],
      ['mv .env.new .env', [ow('mv .env.new', ['.env'], '.env.new')]],
      ['mv .env.bak .env', [ow('mv .env.bak', ['.env'], '.env.bak')]],
      ['mv .env .env.bak', [ow('mv .env', ['.env.bak'], '.env')]],
      ['install -m 600 .env.example .env', [ow('install .env.example', ['.env'], '.env.example')]],
      ['cp -f .env.example .env', [ow('cp .env.example', ['.env'], '.env.example')]],
      ['cp -p .env.example .env', [ow('cp .env.example', ['.env'], '.env.example')]],
      ['cp --force a.txt .env', [ow('cp a.txt', ['.env'], 'a.txt')]],
      ['cp -- a.txt .env', [ow('cp a.txt', ['.env'], 'a.txt')]],
      ['cp -t . .env.backup', [ow('cp .env.backup', ['.env.backup'], '.env.backup')]],
      ['cp --target-directory=. .env.backup', [ow('cp .env.backup', ['.env.backup'], '.env.backup')]],
      ['cp .env.example config/.env', [ow('cp .env.example', ['config/.env'], '.env.example')]],
      ['cp ../shared/.env .', [ow('cp .env', ['.env'], '../shared/.env')]],
      ['cp ../shared/.env ./', [ow('cp .env', ['.env'], '../shared/.env')]],
      ['cp .env backup/', [ow('cp .env', ['backup/.env'], '.env')]],
      ['cp ~/secrets/.env .', [ow('cp .env', ['.env'], '~/secrets/.env')]],
      ['cp .env .env.local backup/', [ow('cp', ['backup/.env', 'backup/.env.local'])]],
      ['sudo cp .env.example .env', [ow('cp .env.example', ['.env'], '.env.example')]],
      ['cd config && cp .env.example .env', [ow('cp .env.example', [`${ROOT}/config/.env`], `${ROOT}/config/.env.example`)]],
      ['cp prod.env staging.env', [ow('cp prod.env', ['staging.env'], 'prod.env')]],
    ])
    quiet([
      'cp .env .env.example', 'cp .env .env.sample', 'cp .env.local .env.template', 'cp a.txt b.txt', 'cp -r src dist', 'mv a b', 'mv a.txt dir/', 'cp a b/', 'install -m 755 a /usr/local/bin/a',
      'install -d .env', 'cp x', 'cp', 'mv .env', 'cp x "$DEST"', 'cp "$SRC" "$DEST"', 'cp -t', 'ln -s a .env', 'rm .env', 'cat .env', 'grep KEY .env', 'cp .env.example notes.txt',
    ])
  })
  describe('redirects', () => {
    table([
      ['echo A=1 > .env', [ow('> .env', ['.env'])]],
      ['echo A=1 >.env', [ow('> .env', ['.env'])]],
      ['cat x > .env.local', [ow('> .env.local', ['.env.local'])]],
      ['echo A=1 >| .env', [ow('> .env', ['.env'])]],
      ['> .env', [ow('> .env', ['.env'])]],
      ['printf x>.env', [ow('> .env', ['.env'])]],
      ['echo A=1 1> .env', [ow('> .env', ['.env'])]],
      ['echo A=1 &> .env', [ow('> .env', ['.env'])]],
      ['cat a > config/prod.env', [ow('> prod.env', ['config/prod.env'])]],
      ["sudo sh -c 'echo A=1 > .env'", [ow('> .env', ['.env'])]],
      ['echo a > .envrc', [ow('> .envrc', ['.envrc'])]],
      ['echo A=1 > .env && echo done', [ow('> .env', ['.env'])]],
      ['echo $(cat x) > .env', [ow('> .env', ['.env'])]],
      ['(echo a > .env)', [ow('> .env', ['.env'])]],
      ['{ echo a; } > .env', [ow('> .env', ['.env'])]],
      ['cd config && echo A=1 > .env', [ow('> .env', [`${ROOT}/config/.env`])]],
      ['echo a > .env; echo b > .env', [ow('> .env', ['.env'])]],
      ['echo a > "my.env"', [ow('> my.env', ['my.env'])]],
    ])
    quiet([
      'echo A=1 >> .env', 'echo x 2> .env', 'echo x &> /dev/null', 'echo x > /dev/null', 'echo x > notes.txt', 'echo x > .env.example', 'echo x > .gitignore',
      'echo x > "$F"', 'echo x >> .env.local', 'echo x 2>> .env', 'cat < .env', 'cat .env > /dev/null', 'echo x &>> .env', 'echo x > .env.sample', 'echo x > env', 'echo x > .environment',
    ])
  })
  describe('tee and sed -i', () => {
    table([
      ['echo A=1 | tee .env', [ow('tee .env', ['.env'])]],
      ['tee .env < x', [ow('tee .env', ['.env'])]],
      ['echo x | tee .env .env.local', [ow('tee', ['.env', '.env.local'])]],
      ['echo A | sudo tee .env', [ow('tee .env', ['.env'])]],
      ['echo A | tee -i .env', [ow('tee .env', ['.env'])]],
      ['echo A | tee -p .env', [ow('tee .env', ['.env'])]],
      ["sed -i 's/a/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed -i.bak 's/a/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed -i '' 's/a/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed -i -e 's/a/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed --in-place 's/a/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed --in-place=.bak -e 's/a/b/' .env.local", [ow('sed -i .env.local', ['.env.local'])]],
      ["sed -ni 'p' .env", [ow('sed -i .env', ['.env'])]],
      ["sed -Ei 's/a+/b/' .env", [ow('sed -i .env', ['.env'])]],
      ["sed -i 's/a/b/' .env .env.local", [ow('sed -i', ['.env', '.env.local'])]],
      ["sed -i 's/a/b/' a.txt .env", [ow('sed -i .env', ['.env'])]],
    ])
    quiet([
      'tee -a .env', 'tee --append .env', 'tee -ia .env', 'tee notes.txt', 'tee .env.example', 'tee',
      "sed 's/a/b/' .env", "sed -n '1p' .env", "sed -i 's/a/b/' notes.txt", "sed -i 's/a/b/' .env.example", "sed -e 's/a/b/' .env", "sed -i 's/a/b/' .env.sample", 'sed -i',
      "sed -i 's/.env/x/' notes.txt",
    ])
  })
})
