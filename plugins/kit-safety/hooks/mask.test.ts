import { expect, test } from 'claude-code/testing'

import { KINDS, hasSecretShape, maskDeep, maskText } from './mask'
import {
  MARK, ALNUM, URLSAFE, UPPER_DIGITS, B64, HEX, DIGITS, fill, TOKENS, CONTEXTS, pem, LABELS, url, query, bearer, timed, NEW_SHAPES,
} from '../tests/mask-helpers'

// What the masker finds and what it leaves alone. The big and slow inputs are in mask-perf.test.ts.

// --- every kind, in context -------------------------------------------------------------------------------------------

for (const fx of TOKENS) {
  test(`mask: ${fx.name} is masked in every context, with the exact visible format`, () => {
    expect(maskText(fx.value)).toEqual({ text: fx.masked, count: 1, kinds: [fx.kind] })
    for (const ctx of CONTEXTS) {
      const out = maskText(ctx.wrap(fx.value))
      expect(out.text).toBe(ctx.wrap(fx.masked))
      expect(out.count).toBe(ctx.hits)
      expect(out.kinds).toEqual([fx.kind])
      expect(JSON.stringify(out)).not.toContain(fx.body)
      expect(hasSecretShape(ctx.wrap(fx.value))).toBe(true)
      // idempotent: what was masked is not masked again, and no longer looks like a secret
      expect(maskText(out.text)).toEqual({ text: out.text, count: 0, kinds: [] })
      expect(hasSecretShape(out.text)).toBe(false)
      expect(KINDS).toContain(fx.kind)
    }
  })
}

test('mask: the visible format is prefix, four bullets, a space and the word masked', () => {
  expect(MARK).toBe('\u2022\u2022\u2022\u2022 masked')
  expect(maskText(TOKENS[0]!.value).text).toBe('sk-ant-\u2022\u2022\u2022\u2022 masked')
  expect(maskText(`x ${TOKENS[0]!.value} y`).text).toBe('x sk-ant-\u2022\u2022\u2022\u2022 masked y')
})

test('mask: an Anthropic key is never reported as an OpenAI one, and its body is long enough for both rules', () => {
  const key = ['sk', 'ant', 'api03', fill(80, 60, URLSAFE)].join('-')
  expect(maskText(key)).toEqual({ text: 'sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
  expect(maskText(`a ${key} b`).kinds).toEqual(['anthropic-key'])
})

test('mask: a token body ends at the first character outside its alphabet', () => {
  const gh = TOKENS.find(t => t.name === 'github ghp')!
  expect(maskText(`${gh.value}_tail`).text).toBe('ghp_•••• masked_tail')
  expect(maskText(`${gh.value}.`).text).toBe('ghp_•••• masked.')
  expect(maskText(`${gh.value}-next`).text).toBe('ghp_•••• masked-next')
  const anthropic = TOKENS[0]!
  expect(maskText(`${anthropic.value}.`).text).toBe('sk-ant-•••• masked.')
  expect(maskText(`${anthropic.value}!`).text).toBe('sk-ant-•••• masked!')
  expect(maskText(`(${anthropic.value})`).text).toBe('(sk-ant-•••• masked)')
  const google = TOKENS.find(t => t.name === 'google')!
  expect(maskText(`${google.value}&x=1`).text).toBe('AIza•••• masked&x=1')
  const jwt = TOKENS.find(t => t.name === 'jwt')!
  expect(maskText(`${jwt.value}.`).text).toBe('eyJ•••• masked.')
  expect(maskText(`${jwt.value},`).text).toBe('eyJ•••• masked,')
})

test('mask: a JWT with and without surrounding quotes, in a header, a cookie and a URL fragment', () => {
  const jwt = TOKENS.find(t => t.name === 'jwt')!
  for (const wrap of [(s: string) => s, (s: string) => `"${s}"`, (s: string) => `'${s}'`, (s: string) => `Bearer ${s}`, (s: string) => `session=${s}; Path=/`, (s: string) => `https://app.acme-shop.vn/cb#id=${s}`, (s: string) => `{"jwt":"${s}"}`]) {
    const out = maskText(wrap(jwt.value))
    expect(out.text).toBe(wrap('eyJ•••• masked'))
    expect(out.kinds).toEqual(['jwt'])
    expect(JSON.stringify(out)).not.toContain(jwt.body)
  }
})

test('mask: the minimum body lengths: one short of the minimum is left alone, the minimum is masked', () => {
  const cases: [string, string, number, string][] = [
    ['sk-ant-', ['sk', 'ant', ''].join('-'), 20, URLSAFE],
    ['sk-', ['sk', ''].join('-'), 40, URLSAFE],
    ['sk-proj-', ['sk', 'proj', ''].join('-'), 20, URLSAFE],
    ['ghp_', 'gh' + 'p_', 36, ALNUM],
    ['github_pat_', ['github', 'pat', ''].join('_'), 50, `${ALNUM}_`],
    ['AKIA', ['AK', 'IA'].join(''), 16, UPPER_DIGITS],
    ['sk_live_', ['sk', 'live', ''].join('_'), 16, ALNUM],
    ['whsec_', ['whsec', ''].join('_'), 20, ALNUM],
    ['AIza', ['AI', 'za'].join(''), 35, URLSAFE],
    ['xoxb-', 'xo' + 'xb-', 10, ALNUM],
    ['npm_', ['npm', ''].join('_'), 36, ALNUM],
    ['glpat-', ['glpat', ''].join('-'), 20, URLSAFE],
    ['hf_', ['hf', ''].join('_'), 34, ALNUM],
    ['AGE-SECRET-KEY-', ['AGE', 'SECRET', 'KEY', '1'].join('-'), 58, UPPER_DIGITS],
    ['ya29.', ['ya29', ''].join('.'), 20, URLSAFE],
    ['sbp_', ['sbp', ''].join('_'), 40, HEX],
    ['dop_v1_', ['dop', 'v1', ''].join('_'), 64, HEX],
    ['pypi-', ['pypi', 'AgEIcHlwaS5vcmc'].join('-'), 50, URLSAFE],
  ]
  for (const [label, head, min, alphabet] of cases) {
    const short = `${head}${fill(min - 1, 70, alphabet)}`
    const exact = `${head}${fill(min, 71, alphabet)}`
    expect(maskText(`k=${short}`)).toEqual({ text: `k=${short}`, count: 0, kinds: [] })
    expect(hasSecretShape(`k=${short}`)).toBe(false)
    expect(maskText(`k=${exact}`).text).toBe(`k=${label}${MARK}`)
    expect(hasSecretShape(`k=${exact}`)).toBe(true)
  }
})

test('mask: AWS access key ids are exactly 16 characters after the prefix', () => {
  const head = ['AK', 'IA'].join('')
  expect(maskText(`${head}${fill(15, 72, UPPER_DIGITS)}`).count).toBe(0)
  expect(maskText(`${head}${fill(17, 73, UPPER_DIGITS)}`).count).toBe(0) // a longer id is something else
  expect(maskText(`${head}${fill(16, 74, UPPER_DIGITS)}`).count).toBe(1)
  expect(maskText(`${head}${fill(16, 75, UPPER_DIGITS)} next`).text).toBe('AKIA•••• masked next')
  expect(maskText(`${head.toLowerCase()}${fill(16, 76, UPPER_DIGITS)}`).count).toBe(0)
  expect(maskText(`${head}${fill(16, 77, UPPER_DIGITS)}x`).count).toBe(1) // the lower-case letter is outside the alphabet
})

test('mask: SendGrid keys need the 22 + 43 shape', () => {
  const ok = ['S' + 'G', fill(22, 78, URLSAFE), fill(43, 79, URLSAFE)].join('.')
  expect(maskText(ok).text).toBe('SG.•••• masked')
  expect(maskText(['S' + 'G', fill(21, 80, URLSAFE), fill(43, 81, URLSAFE)].join('.')).count).toBe(0)
  expect(maskText(['S' + 'G', fill(22, 82, URLSAFE), fill(42, 83, URLSAFE)].join('.')).count).toBe(0)
  expect(maskText('SG.x.y').count).toBe(0)
})

test('mask: Stripe publishable keys are public and stay as they are', () => {
  for (const mode of ['live', 'test']) {
    const pk = ['pk', mode, fill(30, 84)].join('_')
    expect(maskText(`NEXT_PUBLIC_KEY=${pk}`)).toEqual({ text: `NEXT_PUBLIC_KEY=${pk}`, count: 0, kinds: [] })
  }
  expect(maskText(['rk', 'live', fill(30, 85)].join('_')).text).toBe('rk_live_•••• masked')
})

// --- false positives --------------------------------------------------------------------------------------------------

test('mask: hashes, UUIDs, git SHAs, base64 blobs and lockfile integrity strings are not secrets', () => {
  const sha256 = fill(64, 90, HEX)
  const sha1 = fill(40, 91, HEX)
  const integrity = `sha512-${fill(86, 92, B64)}==`
  const sha1Integrity = `sha1-${fill(27, 93, B64)}=`
  const blob = fill(400, 94, B64)
  const urlSafeBlob = fill(300, 95, URLSAFE)
  const samples = [
    sha256, sha1, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', integrity, sha1Integrity, blob, urlSafeBlob,
    `commit ${sha1}\nAuthor: Ana <ana@acme-shop.vn>\n    fix: retry`,
    `  resolution: {integrity: ${integrity}}`,
    `"node_modules/left-pad": {"version": "1.3.0", "integrity": "${integrity}"}`,
    `data:image/png;base64,${blob}`,
    `Image sha256:${sha256}`,
    `etag: "${fill(32, 96, HEX)}"`,
    `{"id":"msg_${fill(24, 97)}","model":"claude-sonnet-5-5"}`,
  ]
  for (const s of samples) {
    expect(maskText(s)).toEqual({ text: s, count: 0, kinds: [] })
    expect(hasSecretShape(s)).toBe(false)
  }
})

test('mask: sk- in ordinary prose, ids and names is not a key', () => {
  const samples = [
    'Install sk-learn with pip', 'pip install scikit-learn and sk-image', 'The sk- prefix is used by one vendor.', 'sk-', 'sk-ant-', 'sk-ant-short', 'sk-image-2024-final',
    'class="sk-circle sk-child sk-circle-1"', 'a risk-averse strategy', 'ask-me-anything', 'sk_live_', 'sk_live_abc', 'whsec_', 'ghp_', 'AKIA', 'eyJ', 'AIza', 'xoxb-', 'npm_', 'glpat-', 'hf_', 'SG.',
    'npm_config_registry=https://registry.npmjs.org/', 'npm_package_name=shop', 'npm_lifecycle_event=build', 'process.env.npm_execpath', 'hf_transformers_cache_dir=/tmp/x', 'ghp_token_name', 'github_pat_placeholder',
    `sk-${fill(39, 98, URLSAFE)}`, `sk-ant-${fill(19, 99, URLSAFE)}`,
  ]
  for (const s of samples) {
    expect(maskText(s)).toEqual({ text: s, count: 0, kinds: [] })
    expect(hasSecretShape(s)).toBe(false)
  }
})

test('mask: a token glued to word characters on its left is not a token', () => {
  const sk = `${['sk', ''].join('-')}${fill(48, 100)}`
  const live = `${['sk', 'live', ''].join('_')}${fill(24, 101)}`
  const gh = `gh${'p_'}${fill(36, 102)}`
  const akia = `${['AK', 'IA'].join('')}${fill(16, 103, UPPER_DIGITS)}`
  const jwt = TOKENS.find(t => t.name === 'jwt')!.value
  const samples = [`de${sk}`, `ri${sk}`, `ta${live}`, `x${gh}`, `_${gh}`, `MY_${gh}`, `Q${akia}`, `9${akia}`, `e${jwt}`, `-${jwt}`, `_${jwt}`, `desk-${fill(48, 104)}`, `task_live_${fill(24, 105)}`]
  for (const s of samples) {
    expect(maskText(s)).toEqual({ text: s, count: 0, kinds: [] })
    expect(hasSecretShape(s)).toBe(false)
  }
  // a boundary that is not a word character is a boundary
  for (const edge of [' ', '=', ':', '"', "'", '(', ',', '\n', '\t', '/', '>', '[']) {
    expect(maskText(`${edge}${sk}`).text).toBe(`${edge}sk-•••• masked`)
  }
})

test('mask: a JWT needs three segments and two of them starting eyJ', () => {
  const head = `eyJ${fill(30, 106, URLSAFE)}`
  const payload = `eyJ${fill(40, 107, URLSAFE)}`
  const sig = fill(43, 108, URLSAFE)
  for (const s of [head, `${head}.${payload}`, `${head}.${fill(40, 109, URLSAFE)}.${sig}`, `${fill(30, 110, URLSAFE)}.${payload}.${sig}`, `${head}..${sig}`, 'eyJ.eyJ.', 'a.b.c', '1.2.3', 'v1.2.3-beta.4']) {
    expect(maskText(s)).toEqual({ text: s, count: 0, kinds: [] })
  }
  expect(maskText(`${head}.${payload}.${sig}`).count).toBe(1)
})

test('mask: public keys and certificates are not private keys', () => {
  for (const label of ['PUBLIC KEY', 'CERTIFICATE', 'RSA PUBLIC KEY', 'CERTIFICATE REQUEST']) {
    const text = `${pem.begin(label)}\n${pem.body()}\n${pem.end(label)}\n`
    expect(maskText(text)).toEqual({ text, count: 0, kinds: [] })
  }
})

test('mask: text with no secret comes back byte for byte (spacing, newlines, unicode, control characters)', () => {
  const samples = [
    '', ' ', '\n', '\r\n\r\n', '\t  \t', 'hello', 'Xin chào, thế giới ✓ 你好 🎉', 'a\u0000b\u0007c\u001b[31mred\u001b[0m', '\ud800 lone surrogate', 'line1\r\nline2\nline3\rline4',
    '   leading and trailing   ', '•••• masked', '••••', 'masked', 'a'.repeat(100_000), '=?&:@/\\"\'`<>{}[]()', '://', '://@', ':@', '?token=', '&password=', 'Authorization:', 'Authorization: Bearer', 'aws_secret_access_key',
  ]
  for (const s of samples) {
    const out = maskText(s)
    expect(out.text).toBe(s)
    expect(out.count).toBe(0)
    expect(out.kinds).toEqual([])
    expect(hasSecretShape(s)).toBe(false)
  }
})

test('mask: only the secret changes, every other byte of the text stays', () => {
  const key = TOKENS[0]!.value
  const text = `  \t ${key}\r\n\n  \u00a0é\u200b ${key}\t`
  expect(maskText(text).text).toBe('  \t sk-ant-•••• masked\r\n\n  \u00a0é\u200b sk-ant-•••• masked\t')
  expect(maskText(text).count).toBe(2)
  const lines = ['first line', `second ${key} line`, '', 'fourth line  ', ''].join('\r\n')
  expect(maskText(lines).text).toBe(lines.replace(key, 'sk-ant-•••• masked'))
})

// --- URL passwords ----------------------------------------------------------------------------------------------------

test('mask: a password in a URL is masked and the rest of the URL is kept', () => {
  const cases: [string, string][] = [
    [url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn/app'), 'postgres://shop:•••• masked@db.acme-shop.vn/app'],
    [url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn:5432/app'), 'postgres://shop:•••• masked@db.acme-shop.vn:5432/app'],
    [url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn:5432'), 'postgres://shop:•••• masked@db.acme-shop.vn:5432'],
    [url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn'), 'postgres://shop:•••• masked@db.acme-shop.vn'],
    [url('postgres', 'shop', 'hunter2', '[2001:db8::1]:5432/app'), 'postgres://shop:•••• masked@[2001:db8::1]:5432/app'],
    [url('redis', '', 'hunter2', 'cache.acme-shop.vn:6379'), 'redis://:•••• masked@cache.acme-shop.vn:6379'],
    [url('mysql', 'root', 'hunter2', '127.0.0.1:3306?ssl=true'), 'mysql://root:•••• masked@127.0.0.1:3306?ssl=true'],
    [url('https', 'john.doe%40acme', 'hunter2', 'git.acme-shop.vn/x.git'), 'https://john.doe%40acme:•••• masked@git.acme-shop.vn/x.git'],
    [url('https', 'we!rd+user~1', 'hunter2', 'host.acme-shop.vn/'), 'https://we!rd+user~1:•••• masked@host.acme-shop.vn/'],
    [url('amqp', 'guest', 'p%40ss%21w0rd', 'mq.acme-shop.vn:5672/%2f'), 'amqp://guest:•••• masked@mq.acme-shop.vn:5672/%2f'],
    [url('postgres', 'shop', 'p@ss', 'db.acme-shop.vn/app'), 'postgres://shop:•••• masked@db.acme-shop.vn/app'],
    [url('mongodb+srv', 'shop', 'Zx9!pQ%23', 'cluster0.acme-shop.vn/app'), 'mongodb+srv://shop:•••• masked@cluster0.acme-shop.vn/app'],
    [url('ftp', 'anonymous', 'me@acme-shop.vn', 'ftp.acme-shop.vn/pub'), 'ftp://anonymous:•••• masked@ftp.acme-shop.vn/pub'],
  ]
  for (const [input, expected] of cases) {
    const out = maskText(input)
    expect(out.text).toBe(expected)
    expect(out.count).toBe(1)
    expect(out.kinds).toEqual(['url-password'])
    expect(maskText(out.text).count).toBe(0)
  }
})

test('mask: a URL password inside quotes, JSON and a command, with other URLs and e-mails next to it', () => {
  const pw = 'hunter2'
  const u = url('postgres', 'shop', pw, 'db.acme-shop.vn/app')
  expect(maskText(`DATABASE_URL="${u}"`).text).toBe('DATABASE_URL="postgres://shop:•••• masked@db.acme-shop.vn/app"')
  expect(maskText(`{"db":"${url('redis', 'u', 'pw12', 'h')}","email":"a@b.co"}`).text).toBe('{"db":"redis://u:•••• masked@h","email":"a@b.co"}')
  expect(maskText(`psql '${u}' -c "select 1"`).text).toBe(`psql 'postgres://shop:•••• masked@db.acme-shop.vn/app' -c "select 1"`)
  expect(maskText(`see [the db](${url('https', 'u', 'pw12', 'h.acme-shop.vn/x')}) and https://acme-shop.vn/docs`).text).toBe('see [the db](https://u:•••• masked@h.acme-shop.vn/x) and https://acme-shop.vn/docs')
  const two = `${u} ${url('mysql', 'root', 'pw3456', 'm.acme-shop.vn/db')}`
  expect(maskText(two)).toEqual({ text: 'postgres://shop:•••• masked@db.acme-shop.vn/app mysql://root:•••• masked@m.acme-shop.vn/db', count: 2, kinds: ['url-password'] })
  expect(JSON.stringify(maskText(u))).not.toContain(pw)
  expect(JSON.stringify(maskText(`x\r\n${u}\r\ny`))).not.toContain(pw)
})

test('mask: a token used as a URL password keeps its own prefix', () => {
  const gh = TOKENS.find(t => t.name === 'github ghp')!
  const out = maskText(url('https', 'x-access-token', gh.value, 'github.com/acme/shop.git'))
  expect(out).toEqual({ text: 'https://x-access-token:ghp_•••• masked@github.com/acme/shop.git', count: 1, kinds: ['github-token'] })
  const gl = TOKENS.find(t => t.name === 'gitlab')!
  expect(maskText(url('https', 'oauth2', gl.value, 'gitlab.com/acme/shop.git')).text).toBe('https://oauth2:glpat-•••• masked@gitlab.com/acme/shop.git')
})

test('mask: placeholders and non-passwords in a URL are left alone', () => {
  // Only shapes that cannot be a credential: weak words such as `password` or `changeme` are real passwords (see below).
  const placeholders = [
    '${DB_PASSWORD}', '$DB_PASSWORD', '$1', '$(cat /run/secrets/db)', '<password>', '<your-password>', '{{password}}', '{{x}}', '[YOUR-PASSWORD]', '%PASSWORD%', '%s', ':password',
    '****', '********', '....', '----', '____', 'xxxx', 'XXXX', 'x', 'xxxxxxxx', '•', '••••', '•••• masked', 'redacted', 'REDACTED', 'masked', 'null', 'none', 'nil', 'undefined', 'true', 'false', '',
  ]
  const wrong: string[] = []
  for (const p of placeholders) {
    const input = url('postgres', 'shop', p, 'db.acme-shop.vn/app')
    if (maskText(input).text !== input || maskText(input).count !== 0 || hasSecretShape(input)) wrong.push(p)
  }
  expect(wrong).toEqual([])
  for (const input of [
    'postgres://shop@db.acme-shop.vn/app', 'https://acme-shop.vn:8080/x', 'git@github.com:acme/shop.git', 'ssh://git@github.com/acme/shop.git', 'http://[::1]:8080/x@y', 'file:///C:/Users/ana/x.txt',
    'https://acme-shop.vn/path:with@colon', 'https://acme-shop.vn/a?next=http://h:80/p@q', 'mailto:ana@acme-shop.vn', 'user:pass', 'a:b@c.d', 'https://acme-shop.vn/a@b:c',
  ]) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

test('mask: a real-looking password is masked even when it is not random (hunter2, postgres, and the weak words too)', () => {
  expect(maskText(url('postgres', 'postgres', 'postgres', 'localhost/app')).text).toBe('postgres://postgres:•••• masked@localhost/app')
  expect(maskText(url('postgres', 'shop', 'x'.repeat(12), 'db/app')).count).toBe(1)
  expect(maskText(url('postgres', 'shop', 'a', 'db/app')).count).toBe(1)
})

test('mask: weak words are real development passwords, not placeholders: masked in URLs, query parameters and headers', () => {
  // the four forms that leaked before: they are the most common default passwords of a dev database
  for (const [input, expected] of [
    [url('postgres', 'postgres', 'password', 'host'), 'postgres://postgres:•••• masked@host'],
    [url('postgres', 'app', 'secret', 'host'), 'postgres://app:•••• masked@host'],
    [url('mysql', 'root', 'pass', 'host'), 'mysql://root:•••• masked@host'],
    [url('redis', '', 'changeme', 'host'), 'redis://:•••• masked@host'],
  ] as [string, string][]) {
    expect(maskText(input)).toEqual({ text: expected, count: 1, kinds: ['url-password'] })
    expect(hasSecretShape(input)).toBe(true)
    expect(maskText(expected).count).toBe(0)
  }
  const weak = [
    'password', 'Password', 'PASSWORD', 'passwd', 'pass', 'pwd', 'secret', 'Secret', 'token', 'changeme', 'ChangeMe', 'change-me', 'change_me', 'placeholder', 'yourpassword', 'your-password', 'your_password_here', 'YOUR_API_KEY',
  ]
  const leaked: string[] = []
  for (const w of weak) {
    const checks: [string, string][] = [
      [url('postgres', 'shop', w, 'db.acme-shop.vn/app'), 'postgres://shop:•••• masked@db.acme-shop.vn/app'],
      [url('amqp', '', w, 'mq:5672'), 'amqp://:•••• masked@mq:5672'],
      [query('password', w), 'https://api.acme-shop.vn/v1/orders?password=•••• masked'],
      [query('token', w), 'https://api.acme-shop.vn/v1/orders?token=•••• masked'],
      [query('api_key', w), 'https://api.acme-shop.vn/v1/orders?api_key=•••• masked'],
      [`${query('secret', w)}.`, 'https://api.acme-shop.vn/v1/orders?secret=•••• masked.'], // a sentence's full stop is not part of it
    ]
    for (const [input, expected] of checks) {
      const out = maskText(input)
      if (out.text !== expected || out.count !== 1 || !hasSecretShape(input) || maskText(out.text).count !== 0) leaked.push(`${w}: ${input}`)
    }
  }
  expect(leaked).toEqual([])
  // an Authorization value is at least 16 characters: the long doc placeholders are masked too (only a word is hidden)
  for (const v of ['YOUR_API_KEY_GOES_HERE', 'your-token-goes-here', 'change-me-change-me', 'yourpasswordgoeshere']) {
    expect(maskText(bearer('Bearer', v))).toEqual({ text: 'Authorization: Bearer •••• masked', count: 1, kinds: ['auth-header'] })
  }
  // the structural neighbours stay as they are
  for (const input of [url('postgres', 'postgres', '', 'host'), url('postgres', 'postgres', '<password>', 'host'), url('postgres', 'postgres', '${PGPASSWORD}', 'host'), url('postgres', 'postgres', '$PGPASSWORD', 'host'), query('password', ''), query('password', '[REDACTED]')]) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

// --- secret-named query parameters ------------------------------------------------------------------------------------

test('mask: secret-named query parameters keep the name and lose the value', () => {
  const names = ['password', 'passwd', 'pwd', 'secret', 'token', 'access_token', 'api_key', 'apikey', 'client_secret', 'refresh_token']
  for (const name of names) {
    for (const sep of ['?', '&']) {
      const input = `https://api.acme-shop.vn/v1/orders${sep === '?' ? '' : '?page=2'}${sep}${name}=${fill(24, 120)}&limit=10`
      const out = maskText(input)
      expect(out.text).toBe(`https://api.acme-shop.vn/v1/orders${sep === '?' ? '' : '?page=2'}${sep}${name}=${MARK}&limit=10`)
      expect(out.kinds).toEqual(['url-secret'])
      expect(JSON.stringify(out)).not.toContain(fill(24, 120))
      expect(maskText(out.text).count).toBe(0)
    }
  }
  expect(maskText(query('token', 'abc123def456')).text).toBe('https://api.acme-shop.vn/v1/orders?token=•••• masked')
})

test('mask: query parameter names are case-insensitive and the value stops at the URL delimiters', () => {
  expect(maskText(query('Token', 'abc123')).text).toBe('https://api.acme-shop.vn/v1/orders?Token=•••• masked')
  expect(maskText(query('API_KEY', 'abc123')).text).toBe('https://api.acme-shop.vn/v1/orders?API_KEY=•••• masked')
  expect(maskText(`${query('ApiKey', 'abc123')}#top`).text).toBe('https://api.acme-shop.vn/v1/orders?ApiKey=•••• masked#top')
  expect(maskText(`"${query('token', 'abc123')}"`).text).toBe('"https://api.acme-shop.vn/v1/orders?token=•••• masked"')
  expect(maskText(`'${query('token', 'abc123')}' next`).text).toBe(`'https://api.acme-shop.vn/v1/orders?token=•••• masked' next`)
  expect(maskText(`GET ${query('token', 'abc123')} HTTP/1.1`).text).toBe('GET https://api.acme-shop.vn/v1/orders?token=•••• masked HTTP/1.1')
  expect(maskText(`<a href="${query('token', 'abc123')}">x</a>`).text).toBe('<a href="https://api.acme-shop.vn/v1/orders?token=•••• masked">x</a>')
  expect(maskText(`[x](${query('token', 'abc123')})`).text).toBe('[x](https://api.acme-shop.vn/v1/orders?token=•••• masked)')
  expect(maskText(`${query('token', 'abc123')}.`).text).toBe('https://api.acme-shop.vn/v1/orders?token=•••• masked.')
  expect(maskText(`${query('token', 'abc123')}, then`).text).toBe('https://api.acme-shop.vn/v1/orders?token=•••• masked, then')
  expect(maskText(`${query('token', 'YWJjMTIz==')}`).text).toBe('https://api.acme-shop.vn/v1/orders?token=•••• masked')
  expect(maskText('/cb?code=1&token=abc123;path=/').text).toBe('/cb?code=1&token=•••• masked;path=/')
  expect(maskText('user=ana&password=pw12345&next=%2F').text).toBe('user=ana&password=•••• masked&next=%2F')
})

test('mask: other query parameters and placeholders in a token position are left alone', () => {
  // `my_token=…`, a bare `token=…` and `password=…` used to stay (only a ?/& parameter by an exact name was masked); the setting
  // rule below now masks them: see 'a name that holds a credential masks its value'.
  for (const input of [
    query('page', '2'), query('tokenizer', 'bert'), query('tokens', '100'), query('author', 'ana'), query('key', 'abc'), query('secretary', 'ana'), query('passwords', 'abc'),
    query('token', ''), query('token', '${TOKEN}'), query('token', '$TOKEN'), query('token', '<token>'), query('token', '{{token}}'), query('token', '[REDACTED]'), query('token', 'redacted'), query('token', 'none'),
    query('token', '****'), query('token', 'xxxx'), query('token', '•'), query('token', '•••• masked'), query('token', 'undefined'), query('token', 'null'), query('token', 'false'), query('token', ':token'), query('token', '%s'),
    query('apikey', '<your-api-key>'), query('secret', '$SECRET_VALUE'),
  ]) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
    expect(hasSecretShape(input)).toBe(false)
  }
})

// --- Authorization headers --------------------------------------------------------------------------------------------

test('mask: Authorization header values keep the scheme', () => {
  const value = fill(32, 130, `${ALNUM}._~+/=-`)
  for (const scheme of ['Bearer', 'Basic', 'Token', 'bearer', 'BEARER']) {
    const out = maskText(bearer(scheme, value))
    expect(out.text).toBe(`Authorization: ${scheme} ${MARK}`)
    expect(out.kinds).toEqual(['auth-header'])
    expect(JSON.stringify(out)).not.toContain(value)
    expect(maskText(out.text).count).toBe(0)
  }
  expect(maskText(`curl -H "${bearer('Bearer', value)}" https://api.acme-shop.vn`).text).toBe('curl -H "Authorization: Bearer •••• masked" https://api.acme-shop.vn')
  expect(maskText(`curl -H '${bearer('Basic', 'dXNlcjpwYXNzd29yZDEyMzQ1Njc4')}'`).text).toBe("curl -H 'Authorization: Basic •••• masked'")
  expect(maskText(`> authorization: bearer ${value}\r\n> accept: */*`).text).toBe('> authorization: bearer •••• masked\r\n> accept: */*')
  expect(maskText(`{"Authorization": "Bearer ${value}"}`).text).toBe('{"Authorization": "Bearer •••• masked"}')
  expect(maskText(`headers = {'Authorization': 'Token ${value}'}`).text).toBe("headers = {'Authorization': 'Token •••• masked'}")
  expect(maskText(`Proxy-Authorization: Basic ${value}`).text).toBe('Proxy-Authorization: Basic •••• masked')
})

test('mask: an Authorization value needs at least 16 characters and a real value', () => {
  expect(maskText(bearer('Bearer', 'abcdefghijklmno')).count).toBe(0) // 15
  expect(maskText(bearer('Bearer', 'abcdefghijklmnop')).count).toBe(1) // 16
  expect(maskText(bearer('Basic', 'dXNlcjpwYXNz')).count).toBe(0)
  for (const v of ['${TOKEN}', '$TOKEN', '<token>', '{{token}}', '$(cat token.txt)', '<your-api-key-goes-here>', '[YOUR_TOKEN_GOES_HERE]', '-'.repeat(20), '.'.repeat(20), '_'.repeat(20)]) {
    expect(maskText(bearer('Bearer', v)).count).toBe(0)
  }
  // a long run of x is a plausible fixture, not an obvious placeholder (only short runs are)
  expect(maskText(bearer('Bearer', 'x'.repeat(24))).text).toBe('Authorization: Bearer •••• masked')
  expect(maskText('Authorization: Bearer').count).toBe(0)
  expect(maskText('Authorization: Digest abcdefghijklmnopqrstuvwxyz').count).toBe(0)
  expect(maskText('The Authorization header carries a Bearer token').count).toBe(0)
})

test('mask: a recognised token in a header is named for what it is', () => {
  const key = TOKENS[0]!
  expect(maskText(bearer('Bearer', key.value))).toEqual({ text: 'Authorization: Bearer sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
  const jwt = TOKENS.find(t => t.name === 'jwt')!
  expect(maskText(bearer('Bearer', jwt.value)).text).toBe('Authorization: Bearer eyJ•••• masked')
  expect(maskText(query('token', jwt.value)).text).toBe('https://api.acme-shop.vn/v1/orders?token=eyJ•••• masked')
})

// --- AWS secret access keys -------------------------------------------------------------------------------------------

test('mask: aws secret access key assignments mask the value only', () => {
  const secret = fill(40, 140, B64)
  const cases: [string, string][] = [
    [`aws_secret_access_key = "${secret}"`, `aws_secret_access_key = "${MARK}"`],
    [`aws_secret_access_key = ${secret}`, `aws_secret_access_key = ${MARK}`],
    [`AWS_SECRET_ACCESS_KEY=${secret}`, `AWS_SECRET_ACCESS_KEY=${MARK}`],
    [`export AWS_SECRET_ACCESS_KEY='${secret}'`, `export AWS_SECRET_ACCESS_KEY='${MARK}'`],
    [`{"SecretAccessKey": "${secret}", "AccessKeyId": "x"}`, `{"SecretAccessKey": "${MARK}", "AccessKeyId": "x"}`],
    [`aws_secret_access_key: ${secret}\nregion: eu`, `aws_secret_access_key: ${MARK}\nregion: eu`],
    [`secret_access_key=${secret}\r\n`, `secret_access_key=${MARK}\r\n`],
    [`aws_secret_key = "${secret}"`, `aws_secret_key = "${MARK}"`],
  ]
  for (const [input, expected] of cases) {
    const out = maskText(input)
    expect(out.text).toBe(expected)
    expect(out.kinds).toEqual(['aws-secret-key'])
    expect(JSON.stringify(out)).not.toContain(secret)
    expect(maskText(out.text).count).toBe(0)
  }
  // 39 characters is not an AWS secret (the aws rule needs 40), but the name holds a credential: the setting rule masks it instead
  expect(maskText(`aws_secret_access_key = "${fill(39, 141, B64)}"`)).toEqual({ text: `aws_secret_access_key = "${MARK}"`, count: 1, kinds: ['secret-setting'] })
  expect(maskText(`secret_key = "${secret}"`)).toEqual({ text: `secret_key = "${MARK}"`, count: 1, kinds: ['secret-setting'] }) // not an AWS name, still a secret one
  expect(maskText('aws_secret_access_key = "${SECRET}"').count).toBe(0)
  expect(maskText('aws_secret_access_key=$AWS_SECRET').count).toBe(0)
  expect(maskText('aws_secret_access_key = <your secret key>').count).toBe(0)
})

// --- private keys -----------------------------------------------------------------------------------------------------

test('mask: a PEM private key keeps its BEGIN and END lines and loses the body', () => {
  for (const [i, label] of LABELS.entries()) {
    const body = pem.body(3, 150 + i * 3)
    const block = `${pem.begin(label)}\n${body}\n${pem.end(label)}`
    const expected = `${pem.begin(label)}\n${MARK}\n${pem.end(label)}`
    const out = maskText(block)
    expect(out).toEqual({ text: expected, count: 1, kinds: ['private-key'] })
    expect(JSON.stringify(out)).not.toContain(body.split('\n')[0]!)
    expect(maskText(out.text)).toEqual({ text: expected, count: 0, kinds: [] })
    expect(hasSecretShape(block)).toBe(true)
    expect(hasSecretShape(expected)).toBe(false)
    // inside a log, with text before and after and a final newline
    const log = `deploying...\n${block}\nuploaded 1 file\n`
    expect(maskText(log).text).toBe(`deploying...\n${expected}\nuploaded 1 file\n`)
    // CRLF output keeps its line endings
    const crlf = block.replace(/\n/g, '\r\n')
    expect(maskText(crlf).text).toBe(expected.replace(/\n/g, '\r\n'))
  }
})

test('mask: a PEM key inside a JSON string (escaped newlines) stays valid JSON', () => {
  const label = 'PRIVATE KEY'
  const body = pem.body(2, 170)
  const json = JSON.stringify({ type: 'service_account', private_key: `${pem.begin(label)}\n${body}\n${pem.end(label)}\n`, client_email: 'bot@acme-shop.vn' })
  const out = maskText(json)
  expect(out.count).toBe(1)
  expect(out.text).toBe(JSON.stringify({ type: 'service_account', private_key: `${pem.begin(label)}\n${MARK}\n${pem.end(label)}\n`, client_email: 'bot@acme-shop.vn' }))
  expect((JSON.parse(out.text) as { client_email: string }).client_email).toBe('bot@acme-shop.vn')
  expect(JSON.stringify(out)).not.toContain(body.split('\n')[0]!)
  expect(maskText(out.text).count).toBe(0)
})

test('mask: a PEM key in a YAML block and flattened onto one line', () => {
  const label = 'RSA PRIVATE KEY'
  const body = pem.body(2, 180).split('\n').map(l => `    ${l}`).join('\n')
  const yaml = `key: |\n    ${pem.begin(label)}\n${body}\n    ${pem.end(label)}\nnext: 1\n`
  expect(maskText(yaml).text).toBe(`key: |\n    ${pem.begin(label)}\n    ${MARK}\n    ${pem.end(label)}\nnext: 1\n`)
  const flat = `PRIVATE_KEY="${pem.begin('PRIVATE KEY')} ${pem.body(2, 185).replace(/\n/g, ' ')} ${pem.end('PRIVATE KEY')}"`
  expect(maskText(flat)).toEqual({ text: `PRIVATE_KEY="${pem.begin('PRIVATE KEY')} ${MARK} ${pem.end('PRIVATE KEY')}"`, count: 1, kinds: ['private-key'] })
})

test('mask: a PEM key with headers (encrypted, PGP) is masked as a whole', () => {
  const enc = `${pem.begin('RSA PRIVATE KEY')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${fill(32, 190, '0123456789ABCDEF')}\n\n${pem.body(2, 191)}\n${pem.end('RSA PRIVATE KEY')}`
  expect(maskText(enc).text).toBe(`${pem.begin('RSA PRIVATE KEY')}\n${MARK}\n${pem.end('RSA PRIVATE KEY')}`)
  const pgp = `${pem.begin('PGP PRIVATE KEY BLOCK')}\nVersion: GnuPG v2\n\n${pem.body(2, 195)}\n=${fill(4, 196)}\n${pem.end('PGP PRIVATE KEY BLOCK')}`
  expect(maskText(pgp).text).toBe(`${pem.begin('PGP PRIVATE KEY BLOCK')}\n${MARK}\n${pem.end('PGP PRIVATE KEY BLOCK')}`)
})

test('mask: a key cut off before its END line is masked to the end of the text', () => {
  for (const label of LABELS) {
    const cut = `${pem.begin(label)}\n${pem.body(2, 200)}\n${fill(20, 202, B64)}`
    const out = maskText(cut)
    expect(out).toEqual({ text: `${pem.begin(label)}\n${MARK}`, count: 1, kinds: ['private-key'] })
    expect(maskText(out.text).count).toBe(0)
  }
  const label = 'PRIVATE KEY'
  expect(maskText(`log start\n${pem.begin(label)}\n${pem.body(1, 205)}\n`).text).toBe(`log start\n${pem.begin(label)}\n${MARK}\n`)
  expect(maskText(`${pem.begin(label)}\r\n${pem.body(1, 206)}\r\n`).text).toBe(`${pem.begin(label)}\r\n${MARK}\r\n`)
  expect(maskText(`${pem.begin(label)}\n${fill(8, 207, B64)}`).text).toBe(`${pem.begin(label)}\n${MARK}`)
  // output cut in the middle of a JSON string
  expect(maskText(`{"k":"${pem.begin(label)}\\n${fill(40, 208, B64)}`).text).toBe(`{"k":"${pem.begin(label)}\\n${MARK}`)
  // an END line of another kind of key does not close it
  const mismatch = `${pem.begin('RSA PRIVATE KEY')}\n${pem.body(1, 209)}\n${pem.end('PRIVATE KEY')}\nmore`
  expect(maskText(mismatch).text).toBe(`${pem.begin('RSA PRIVATE KEY')}\n${MARK}`)
})

test('mask: two keys in one text are two secrets, and a text after a complete key is kept', () => {
  const a = `${pem.begin('PRIVATE KEY')}\n${pem.body(2, 210)}\n${pem.end('PRIVATE KEY')}`
  const b = `${pem.begin('EC PRIVATE KEY')}\n${pem.body(2, 214)}\n${pem.end('EC PRIVATE KEY')}`
  const out = maskText(`one\n${a}\ntwo\n${b}\nthree`)
  expect(out.count).toBe(2)
  expect(out.kinds).toEqual(['private-key'])
  expect(out.text).toBe(`one\n${pem.begin('PRIVATE KEY')}\n${MARK}\n${pem.end('PRIVATE KEY')}\ntwo\n${pem.begin('EC PRIVATE KEY')}\n${MARK}\n${pem.end('EC PRIVATE KEY')}\nthree`)
})

test('mask: a BEGIN line that holds no key is left alone', () => {
  const label = 'PRIVATE KEY'
  for (const text of [
    pem.begin(label), `${pem.begin(label)}\n`, `${pem.begin(label)}\n${pem.end(label)}`, `${pem.begin(label)}\n...\n${pem.end(label)}`, `${pem.begin(label)}\n<your key here>\n${pem.end(label)}`, `${pem.begin(label)}\n${MARK}\n${pem.end(label)}`,
    `Paste the ${pem.begin(label)} line first`, `if (line === '${pem.begin(label)}') start = true`, `const re = '${pem.begin(label)}'; const end = '${pem.end(label)}'`, `${pem.begin(label)} markers delimit a PEM block`,
    `${pem.begin(label)}\nfoo bar baz`, `${pem.begin(label)}\n// comment`, `-----BEGIN-----`, `-----BEGIN PRIVATE-----`, `-----BEGIN PRIVATE KEY----`, `BEGIN PRIVATE KEY`,
  ]) {
    expect(maskText(text)).toEqual({ text, count: 0, kinds: [] })
    expect(hasSecretShape(text)).toBe(false)
  }
})

test('mask: an END line closes the BEGIN line of its own label only, and each END closes one block', () => {
  const [plain, rsa, ec] = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY']
  const body = pem.body(2, 400)
  const body2 = pem.body(2, 410)
  const kinds = ['private-key']
  const cases: [string, string, number][] = [
    // interleaved labels: the first BEGIN closes at its own END, the inner BEGIN is part of the secret
    [`${pem.begin(rsa!)}\n${body}\n${pem.begin(ec!)}\n${body2}\n${pem.end(rsa!)}\n${pem.end(ec!)}\n`, `${pem.begin(rsa!)}\n${MARK}\n${pem.end(rsa!)}\n${pem.end(ec!)}\n`, 1],
    // an END before its BEGIN closes nothing: the key is cut off, so it is masked to the end
    [`${pem.end(plain!)}\n${pem.begin(plain!)}\n${body}`, `${pem.end(plain!)}\n${pem.begin(plain!)}\n${MARK}`, 1],
    // the END of another label is skipped, the one of its own label closes it
    [`${pem.begin(rsa!)}\n${body}\n${pem.end(ec!)}\n${body2}\n${pem.end(rsa!)}\nafter`, `${pem.begin(rsa!)}\n${MARK}\n${pem.end(rsa!)}\nafter`, 1],
    // two BEGIN lines of one label and one END: the second BEGIN sits inside the first block
    [`${pem.begin(plain!)}\n${body}\n${pem.begin(plain!)}\n${body2}\n${pem.end(plain!)}\n`, `${pem.begin(plain!)}\n${MARK}\n${pem.end(plain!)}\n`, 1],
    // a block with its END, then a second one of the same label that has none: the used END is not used twice
    [`${pem.begin(plain!)}\n${body}\n${pem.end(plain!)}\n${pem.begin(plain!)}\n${body2}`, `${pem.begin(plain!)}\n${MARK}\n${pem.end(plain!)}\n${pem.begin(plain!)}\n${MARK}`, 2],
    // two complete blocks of one label, a different label between them
    [`${pem.begin(plain!)}\n${body}\n${pem.end(plain!)}\n${pem.begin(ec!)}\n${body}\n${pem.end(ec!)}\n${pem.begin(plain!)}\n${body2}\n${pem.end(plain!)}`, `${pem.begin(plain!)}\n${MARK}\n${pem.end(plain!)}\n${pem.begin(ec!)}\n${MARK}\n${pem.end(ec!)}\n${pem.begin(plain!)}\n${MARK}\n${pem.end(plain!)}`, 3],
  ]
  const wrong: string[] = []
  for (const [input, expected, count] of cases) {
    const out = maskText(input)
    if (out.text !== expected || out.count !== count || out.kinds.join() !== kinds.join() || !hasSecretShape(input) || maskText(out.text).count !== 0) wrong.push(JSON.stringify(input.slice(0, 60)))
    if (JSON.stringify(out).includes(body.split('\n')[0]!) || JSON.stringify(out).includes(body2.split('\n')[0]!)) wrong.push(`leak: ${JSON.stringify(input.slice(0, 60))}`)
  }
  expect(wrong).toEqual([])
  // a stray `-----END ` right before a real END line is part of the secret and does not hide the real one
  const stray = `${pem.begin(plain!)}\n${body}\n-----END ${pem.end(plain!)}\nafter`
  const out = maskText(stray)
  expect(out.count).toBe(1)
  expect(out.text.endsWith(`${pem.end(plain!)}\nafter`)).toBe(true)
  expect(JSON.stringify(out)).not.toContain(body.split('\n')[0]!)
})

// --- idempotence, kinds, KINDS ----------------------------------------------------------------------------------------

test('mask: masking twice changes nothing more, for every shape at once', () => {
  const everything = [
    ...TOKENS.map(t => t.value),
    url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn/app'), query('token', 'abc123'), bearer('Bearer', fill(30, 220)), `aws_secret_access_key = "${fill(40, 221, B64)}"`,
    `${pem.begin('PRIVATE KEY')}\n${pem.body()}\n${pem.end('PRIVATE KEY')}`, `${pem.begin('OPENSSH PRIVATE KEY')}\n${pem.body()}`,
  ].join('\n')
  const first = maskText(everything)
  expect(first.count).toBe(TOKENS.length + 6)
  const second = maskText(first.text)
  expect(second).toEqual({ text: first.text, count: 0, kinds: [] })
  expect(maskText(second.text).text).toBe(first.text)
  expect(hasSecretShape(everything)).toBe(true)
  expect(hasSecretShape(first.text)).toBe(false)
  for (const kind of first.kinds) expect(KINDS).toContain(kind)
})

test('mask: already masked text is never masked again', () => {
  for (const text of [
    'sk-ant-•••• masked', 'sk-•••• masked', 'sk-proj-•••• masked', 'ghp_•••• masked', 'github_pat_•••• masked', 'AKIA•••• masked', 'sk_live_•••• masked', 'eyJ•••• masked', 'AIza•••• masked', 'xoxb-•••• masked',
    'npm_•••• masked', 'glpat-•••• masked', 'hf_•••• masked', 'SG.•••• masked', 'whsec_•••• masked', 'postgres://shop:•••• masked@db.acme-shop.vn/app', 'https://x.io/?token=•••• masked', 'Authorization: Bearer •••• masked',
    'aws_secret_access_key = "•••• masked"', `${pem.begin('PRIVATE KEY')}\n${MARK}\n${pem.end('PRIVATE KEY')}`, `${pem.begin('PRIVATE KEY')}\n${MARK}`, 'Authorization: Bearer sk-ant-•••• masked',
    'https://x-access-token:ghp_•••• masked@github.com/acme/shop.git',
  ]) {
    expect(maskText(text)).toEqual({ text, count: 0, kinds: [] })
    expect(hasSecretShape(text)).toBe(false)
  }
})

test('mask: kinds are distinct and come in the order of first appearance in the text', () => {
  const jwt = TOKENS.find(t => t.name === 'jwt')!.value
  const gh = TOKENS.find(t => t.name === 'github ghp')!.value
  const claude = TOKENS[0]!.value
  const aws = TOKENS.find(t => t.name === 'aws AKIA')!.value
  const out = maskText(`1 ${jwt}\n2 ${gh}\n3 ${claude}\n4 ${gh}\n5 ${aws}\n6 ${claude}`)
  expect(out.count).toBe(6)
  expect(out.kinds).toEqual(['jwt', 'github-token', 'anthropic-key', 'aws-access-key'])
  const reversed = maskText(`${aws} ${claude} ${gh} ${jwt}`)
  expect(reversed.kinds).toEqual(['aws-access-key', 'anthropic-key', 'github-token', 'jwt'])
  // a key printed before a URL password comes first even though the URL rule is a different pass
  const mixed = maskText(`${url('postgres', 'shop', 'hunter2', 'db/app')} then ${claude}`)
  expect(mixed.kinds).toEqual(['url-password', 'anthropic-key'])
})

test('mask: a whole .env dump: every secret goes, every other line stays', () => {
  const find = (name: string) => TOKENS.find(t => t.name === name)!
  const claude = find('anthropic api03')
  const openai = find('openai bare')
  const aws = find('aws AKIA')
  const live = find('stripe sk_live')
  const awsSecret = fill(40, 330, B64)
  const dump = (secrets: boolean) => [
    `ANTHROPIC_API_KEY=${secrets ? claude.value : claude.masked}`,
    `OPENAI_API_KEY=${secrets ? openai.value : openai.masked}`,
    'NODE_ENV=production',
    `DATABASE_URL=${secrets ? url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn:5432/app') : 'postgres://shop:•••• masked@db.acme-shop.vn:5432/app'}`,
    `AWS_ACCESS_KEY_ID=${secrets ? aws.value : aws.masked}`,
    `AWS_SECRET_ACCESS_KEY=${secrets ? awsSecret : MARK}`,
    'PORT=3000',
    `STRIPE_SECRET_KEY=${secrets ? live.value : live.masked}`,
    'PUBLIC_URL=https://acme-shop.vn',
    '',
  ].join('\n')
  const out = maskText(dump(true))
  expect(out.text).toBe(dump(false))
  expect(out.count).toBe(6)
  expect(out.kinds).toEqual(['anthropic-key', 'openai-key', 'url-password', 'aws-access-key', 'aws-secret-key', 'stripe-key'])
  expect(JSON.stringify(out)).not.toContain(awsSecret)
  expect(JSON.stringify(out)).not.toContain('hunter2')
  expect(maskText(out.text).count).toBe(0)
})

test('mask: results are fresh objects, changing one never changes the next answer', () => {
  const text = `k ${TOKENS[0]!.value}`
  const first = maskText(text)
  first.kinds.push('changed')
  first.text = 'changed'
  expect(maskText(text)).toEqual({ text: 'k sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
  const deep = maskDeep({ a: text })
  deep.kinds.length = 0
  expect(maskDeep({ a: text }).kinds).toEqual(['anthropic-key'])
  expect(maskText('clean').kinds).not.toBe(maskText('clean').kinds)
})

test('mask: KINDS lists every kind id the module can report', () => {
  expect([...KINDS]).toEqual([
    'private-key', 'anthropic-key', 'openai-key', 'github-token', 'aws-access-key', 'stripe-key', 'jwt', 'google-api-key', 'slack-token', 'npm-token', 'gitlab-token', 'huggingface-token', 'sendgrid-key',
    'age-key', 'slack-app-token', 'google-oauth-token', 'supabase-token', 'digitalocean-token', 'pypi-token', 'telegram-bot-token',
    'url-password', 'url-secret', 'auth-header', 'aws-secret-key', 'connection-string', 'api-key-header', 'secret-setting',
  ])
  expect(new Set(KINDS).size).toBe(KINDS.length)
  expect(Object.isFrozen(KINDS)).toBe(true)
  for (const fx of TOKENS) expect(KINDS).toContain(fx.kind)
})

test('mask: two secrets that overlap are one secret, and nothing of either is left', () => {
  // a token that is also the value of a secret-named parameter: one hit, not two
  const key = TOKENS[0]!
  const out = maskText(query('token', key.value))
  expect(out.count).toBe(1)
  expect(JSON.stringify(out)).not.toContain(key.body)
  // a password that is longer than the token inside it is masked whole
  const odd = url('https', 'u', `${key.value}!tail`, 'h.acme-shop.vn/x')
  const oddOut = maskText(odd)
  expect(oddOut.count).toBe(1)
  expect(JSON.stringify(oddOut)).not.toContain(key.body)
  expect(JSON.stringify(oddOut)).not.toContain('tail')
})

test('mask: never leaks, never throws on odd input', () => {
  for (const fx of TOKENS) {
    const out = maskText(`${fx.value}\n${fx.value}`)
    expect(JSON.stringify(out)).not.toContain(fx.body)
    expect(JSON.stringify(maskDeep({ a: [fx.value], b: { c: fx.value } }))).not.toContain(fx.body)
  }
  const odd = [undefined, null, 5, true, {}, [], Symbol.iterator] as unknown[]
  for (const value of odd) {
    expect(() => maskText(value as string)).not.toThrow()
    expect(maskText(value as string).count).toBe(0)
    expect(hasSecretShape(value as string)).toBe(false)
    expect(() => maskDeep(value)).not.toThrow()
  }
  expect(maskText(undefined as unknown as string).text).toBe(undefined as unknown as string)
  expect(maskText('\u0000'.repeat(1000) + TOKENS[0]!.value).text).toBe('\u0000'.repeat(1000) + 'sk-ant-•••• masked')
})

// --- maskDeep ---------------------------------------------------------------------------------------------------------

test('maskDeep: strings anywhere inside plain data are masked and the shape is kept', () => {
  const key = TOKENS[0]!
  const gh = TOKENS.find(t => t.name === 'github ghp')!
  const input = {
    id: 'toolu_1',
    is_error: false,
    content: [
      { type: 'text', text: `key is ${key.value}` },
      { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: `again ${key.value} and ${gh.value}` }, { type: 'image', source: { type: 'base64', data: fill(200, 230, B64) } }] },
    ],
    meta: { n: 1, ok: true, none: null, nope: undefined, nested: { list: ['clean', key.value, 7] } },
  }
  const out = maskDeep(input)
  expect(out.count).toBe(4)
  expect(out.kinds).toEqual(['anthropic-key', 'github-token'])
  expect(out.value.content[0]).toEqual({ type: 'text', text: 'key is sk-ant-•••• masked' })
  const nested = out.value.content[1] as { content: { text?: string }[] }
  expect(nested.content[0]!.text).toBe('again sk-ant-•••• masked and ghp_•••• masked')
  expect(out.value.meta.nested.list).toEqual(['clean', 'sk-ant-•••• masked', 7])
  expect(out.value.meta.n).toBe(1)
  expect(out.value.meta.ok).toBe(true)
  expect(out.value.meta.none).toBe(null)
  expect(out.value.meta.nope).toBe(undefined)
  expect(Object.keys(out.value)).toEqual(['id', 'is_error', 'content', 'meta'])
  expect(JSON.stringify(out)).not.toContain(key.body)
  expect(JSON.stringify(out)).not.toContain(gh.body)
})

test('maskDeep: roots that are strings, arrays and scalars', () => {
  const key = TOKENS[0]!
  expect(maskDeep(`k ${key.value}`)).toEqual({ value: 'k sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
  expect(maskDeep([key.value, 'clean', [key.value]])).toEqual({ value: ['sk-ant-•••• masked', 'clean', ['sk-ant-•••• masked']], count: 2, kinds: ['anthropic-key'] })
  for (const scalar of [0, 1.5, NaN, -0, true, false, null, undefined, 10n, 'plain']) {
    const out = maskDeep(scalar)
    expect(Object.is(out.value, scalar)).toBe(true)
    expect(out.count).toBe(0)
    expect(out.kinds).toEqual([])
  }
  const fn = () => 1
  expect(maskDeep(fn).value).toBe(fn)
  expect(maskDeep([NaN, 1]).value).toEqual([NaN, 1])
})

test('maskDeep: object keys are never masked, only values', () => {
  const key = TOKENS[0]!
  const out = maskDeep({ [key.value]: 'clean', other: { [key.value]: key.value } })
  expect(Object.keys(out.value)).toEqual([key.value, 'other'])
  expect(out.value[key.value]).toBe('clean')
  expect(Object.keys(out.value.other)).toEqual([key.value])
  expect(out.value.other[key.value]).toBe('sk-ant-•••• masked')
  expect(out.count).toBe(1)
})

test('maskDeep: returns a new structure, shares what it did not change and never mutates the input', () => {
  const key = TOKENS[0]!
  const clean = { a: [1, 2, { b: 'x' }], c: 'text' }
  const dirty = { s: key.value, list: [key.value] }
  const input = { clean, dirty, same: [clean] }
  const before = JSON.stringify(input)
  const out = maskDeep(input)
  expect(JSON.stringify(input)).toBe(before)
  expect(input.dirty.s).toBe(key.value)
  expect(out.value).not.toBe(input)
  expect(out.value.dirty).not.toBe(dirty)
  expect(out.value.dirty.list).not.toBe(dirty.list)
  expect(out.value.clean).toBe(clean)
  expect(out.value.clean.a).toBe(clean.a)
  expect(out.value.same[0]).toBe(clean)
  expect(out.value.same).toBe(input.same)
  // nothing to mask: the very same value comes back
  const none = { a: [{ b: 'x' }], c: { d: 'y' } }
  expect(maskDeep(none).value).toBe(none)
  expect(maskDeep(none).count).toBe(0)
  const arr = ['a', ['b']]
  expect(maskDeep(arr).value).toBe(arr)
  // running it again on the result finds nothing
  expect(maskDeep(out.value)).toEqual({ value: out.value, count: 0, kinds: [] })
  expect(maskDeep(out.value).value).toBe(out.value)
})

test('maskDeep: a container met twice (shared, not cyclic) is masked once, counted once and stays shared', () => {
  const key = TOKENS[0]!
  const shared = { s: key.value }
  const out = maskDeep({ a: shared, b: shared, c: [shared] })
  expect(out.count).toBe(1)
  expect(out.value.a).toBe(out.value.b)
  expect(out.value.c[0]).toBe(out.value.a)
  expect(out.value.a.s).toBe('sk-ant-•••• masked')
  expect(shared.s).toBe(key.value)
  // a wide diamond of shared nodes does not blow up
  let node: Record<string, unknown> = { leaf: 'x' }
  for (let i = 0; i < 24; i++) node = { left: node, right: node }
  expect(timed(() => maskDeep(node)).ms).toBeLessThan(1000)
})

test('maskDeep: a cycle does not hang and the rest is still masked', () => {
  const key = TOKENS[0]!
  const a: Record<string, unknown> = { name: 'a', s: key.value }
  const b: Record<string, unknown> = { name: 'b', s: key.value, a }
  a.b = b
  a.self = a
  const out = maskDeep(a)
  const result = out.value as Record<string, unknown>
  expect(result.s).toBe('sk-ant-•••• masked')
  expect((result.b as Record<string, unknown>).s).toBe('sk-ant-•••• masked')
  expect(out.count).toBe(2)
  expect(a.s).toBe(key.value)
  const list: unknown[] = ['x', key.value]
  list.push(list)
  const listOut = maskDeep(list).value as unknown[]
  expect(listOut[1]).toBe('sk-ant-•••• masked')
  expect(listOut).toHaveLength(3)
})

test('maskDeep: containers nested 24 levels deep are masked, deeper ones are returned as they are', () => {
  const key = TOKENS[0]!
  const nest = (levels: number, leaf: unknown, asArray = false) => {
    let value: unknown = leaf
    for (let i = 0; i < levels; i++) value = asArray ? [value] : { next: value }
    return value
  }
  const dig = (value: unknown, levels: number): unknown => {
    let v = value
    for (let i = 0; i < levels; i++) v = Array.isArray(v) ? v[0] : (v as { next: unknown }).next
    return v
  }
  for (const asArray of [false, true]) {
    const inside = maskDeep(nest(24, key.value, asArray))
    expect(dig(inside.value, 24)).toBe('sk-ant-•••• masked')
    expect(inside.count).toBe(1)
    const beyond = nest(25, key.value, asArray)
    const outside = maskDeep(beyond)
    expect(dig(outside.value, 25)).toBe(key.value)
    expect(outside.count).toBe(0)
    expect(outside.value).toBe(beyond)
  }
  expect(() => maskDeep(nest(100_000, key.value))).not.toThrow()
  expect(maskDeep(nest(100_000, key.value)).count).toBe(0)
})

test('maskDeep: class instances, Date, Map, Set, typed arrays and the like are returned unchanged', () => {
  const key = TOKENS[0]!
  class Holder {
    s: string
    constructor(s: string) {
      this.s = s
    }
  }
  const holder = new Holder(key.value)
  const date = new Date(0)
  const map = new Map([['k', key.value]])
  const set = new Set([key.value])
  const bytes = new Uint8Array(4)
  const pattern = /x/
  const error = new Error(key.value)
  const input = { holder, date, map, set, bytes, pattern, error }
  const out = maskDeep(input)
  expect(out.count).toBe(0)
  expect(out.value).toBe(input)
  const mixed = maskDeep({ holder, date, map, s: key.value })
  expect(mixed.count).toBe(1)
  expect(mixed.value.holder).toBe(holder)
  expect(mixed.value.date).toBe(date)
  expect(mixed.value.map).toBe(map)
  expect(mixed.value.s).toBe('sk-ant-•••• masked')
  expect(holder.s).toBe(key.value)
  expect(map.get('k')).toBe(key.value)
  expect(maskDeep(holder).value).toBe(holder)
  expect(maskDeep(date).value).toBe(date)
})

test('maskDeep: null-prototype objects, a __proto__ key and a throwing getter', () => {
  const key = TOKENS[0]!
  const bare = Object.create(null) as Record<string, unknown>
  bare.s = key.value
  const bareOut = maskDeep(bare).value
  expect(Object.getPrototypeOf(bareOut)).toBe(null)
  expect(bareOut.s).toBe('sk-ant-•••• masked')
  const parsed = JSON.parse(`{"__proto__":{"s":"${key.value}"},"ok":1}`) as Record<string, unknown>
  const parsedOut = maskDeep(parsed).value
  expect(Object.getPrototypeOf(parsedOut)).toBe(Object.prototype)
  expect(Object.keys(parsedOut)).toEqual(['__proto__', 'ok'])
  expect((Object.getOwnPropertyDescriptor(parsedOut, '__proto__')!.value as { s: string }).s).toBe('sk-ant-•••• masked')
  const hostile = {}
  Object.defineProperty(hostile, 'x', { enumerable: true, get() { throw new Error('boom') } })
  const out = maskDeep({ a: hostile, s: key.value })
  expect(out.value.a === hostile).toBe(true) // compared by hand: a failing toBe would print the getter and throw
  expect(out.value.s).toBe('sk-ant-•••• masked')
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const withRevoked = maskDeep({ p: revoked.proxy, s: key.value })
  expect(withRevoked.value.p === revoked.proxy).toBe(true)
  expect(withRevoked.value.s).toBe('sk-ant-•••• masked')
  expect(withRevoked.count).toBe(1)
})

// --- hasSecretShape agrees with maskText ------------------------------------------------------------------------------

test('hasSecretShape: cheap answers for the plain cases', () => {
  expect(hasSecretShape('')).toBe(false)
  expect(hasSecretShape('just some words')).toBe(false)
  expect(hasSecretShape(TOKENS[0]!.value)).toBe(true)
  expect(hasSecretShape(`x ${url('postgres', 'shop', 'hunter2', 'db/app')}`)).toBe(true)
  expect(hasSecretShape(query('token', 'abc123'))).toBe(true)
  expect(hasSecretShape(bearer('Bearer', fill(20, 310)))).toBe(true)
  expect(hasSecretShape(`${pem.begin('PRIVATE KEY')}\n${pem.body(1, 311)}`)).toBe(true)
  expect(hasSecretShape(`${pem.begin('PRIVATE KEY')}\n`)).toBe(false)
  expect(hasSecretShape('sk-ant-•••• masked')).toBe(false)
  expect(hasSecretShape(null as unknown as string)).toBe(false)
  expect(hasSecretShape(undefined as unknown as string)).toBe(false)
  expect(hasSecretShape(12 as unknown as string)).toBe(false)
})

// --- the newer prefixes -----------------------------------------------------------------------------------------------

test('mask: the newer prefixes need their whole shape: words, neighbours and near misses are left alone', () => {
  const lower = 'ghijklmnopqrstuvwxyz'
  const samples = [
    'AGE-SECRET-KEY-', 'AGE-SECRET-KEY-1', `AGE-SECRET-KEY-1${fill(57, 400, UPPER_DIGITS)}`, `age-secret-key-1${fill(58, 401, UPPER_DIGITS).toLowerCase()}`, 'Generate one with age-keygen', 'AGE-PLUGIN-YUBIKEY-1',
    'ya29.', 'ya29.short', `ya29.${fill(19, 402, URLSAFE)}`, `Ya29.${fill(30, 403, URLSAFE)}`, 'sbp_', `sbp_${fill(39, 404, HEX)}`, `sbp_${fill(40, 405, lower)}`,
    'dop_v1_', `dop_v1_${fill(63, 406, HEX)}`, `dop_v1_${fill(64, 407, lower)}`, 'dox_v1_' + fill(64, 408, HEX), 'pypi-', 'pypi-package-name', 'pip install pypi-cli', `pypi-AgEIcHlwaS5vcmc${fill(49, 409, URLSAFE)}`,
    `pypi-AgXXXXXXXXXXXXXXX${fill(60, 410, URLSAFE)}`, 'xapp-', 'xapp-1-A1-22-short', 'xapp-component-library-for-the-dashboard-user-interface-kit', `xapp-x-${fill(10, 411, UPPER_DIGITS)}-${fill(10, 412, DIGITS)}-${fill(30, 413)}`,
  ]
  for (const s of samples) {
    expect(maskText(s)).toEqual({ text: s, count: 0, kinds: [] })
    expect(hasSecretShape(s)).toBe(false)
  }
})

test('mask: a Telegram bot token is masked alone and inside the Bot API URL', () => {
  const id = fill(9, 420, DIGITS)
  const secret = fill(35, 421, URLSAFE)
  const token = `${id}:${secret}`
  expect(maskText(`https://api.telegram.org/bot${token}/getMe`)).toEqual({ text: 'https://api.telegram.org/bot•••• masked/getMe', count: 1, kinds: ['telegram-bot-token'] })
  expect(maskText(`TELEGRAM_BOT_TOKEN=${token}`)).toEqual({ text: 'TELEGRAM_BOT_TOKEN=•••• masked', count: 1, kinds: ['telegram-bot-token'] })
  for (const digits of [8, 10]) expect(maskText(` ${fill(digits, 422 + digits, DIGITS)}:${secret} `).text).toBe(' •••• masked ')
  expect(maskText(`${token}\n${token}`).count).toBe(2)
  expect(JSON.stringify(maskText(`https://api.telegram.org/bot${token}/sendMessage?chat_id=1`))).not.toContain(secret)
})

test('mask: digits and a colon are not a Telegram token unless both halves have the right length and stand alone', () => {
  const secret = fill(35, 430, URLSAFE)
  const samples = [
    `${fill(7, 431, DIGITS)}:${secret}`, `${fill(11, 432, DIGITS)}:${secret}`, `${fill(9, 433, DIGITS)}:${fill(34, 434, URLSAFE)}`, `${fill(9, 435, DIGITS)}:${fill(36, 436, URLSAFE)}`, `x${fill(9, 437, DIGITS)}:${secret}`,
    `${fill(9, 438, DIGITS)}:${secret}x`, `${fill(9, 439, DIGITS)}_${secret}`, `${fill(9, 440, DIGITS)}::${secret}`, 'host:8080/path', '10.0.0.1:8080', '12:30:45', '2026-11-24T10:00:00Z', '1700000000:short', '1234567890:', ':',
    `https://acme-shop.vn:8080/${secret}`, `sha256:${fill(64, 441, HEX)}`, `${fill(9, 442, DIGITS)}:${fill(35, 443, DIGITS)}${fill(1, 444, 'x')}-tail`,
  ]
  const wrong: string[] = []
  for (const s of samples) if (maskText(s).text !== s || hasSecretShape(s)) wrong.push(s.slice(0, 40))
  expect(wrong).toEqual([])
})

// --- named settings -----------------------------------------------------------------------------------------------------

/** Where a setting turns up in real tool output: `wrap(name, value)`, and the masked form is `wrap(name, MARK)`. */
const SETTING_CONTEXTS: { name: string; wrap: (n: string, v: string) => string }[] = [
  { name: 'env dump', wrap: (n, v) => `NODE_ENV=production\n${n}=${v}\nPORT=3000\n` },
  { name: 'export', wrap: (n, v) => `export ${n}=${v}` },
  { name: 'double quotes', wrap: (n, v) => `${n}="${v}"` },
  { name: 'single quotes', wrap: (n, v) => `${n}='${v}'` },
  { name: 'blanks around =', wrap: (n, v) => `${n} = "${v}"` },
  { name: 'json', wrap: (n, v) => `{"${n}":"${v}","retries":3}` },
  { name: 'json spaced', wrap: (n, v) => `{ "${n}": "${v}" }` },
  { name: 'json inside json', wrap: (n, v) => JSON.stringify(`{"${n}":"${v}"}`) },
  { name: 'yaml', wrap: (n, v) => `db:\n  ${n}: ${v}\n  port: 5432\n` },
  { name: 'yaml quoted', wrap: (n, v) => `${n}: "${v}"\nnext: 1` },
  { name: 'curl header', wrap: (n, v) => `curl -H '${n}: ${v}' https://api.acme-shop.vn/v1/orders` },
  { name: 'curl body', wrap: (n, v) => `curl -d '${n}=${v}&x=1' https://api.acme-shop.vn/v1/orders` },
  { name: 'log line', wrap: (n, v) => `2026-11-24T10:00:00Z INFO login ok user=ana ${n}=${v} took=42ms` },
  { name: 'markdown', wrap: (n, v) => `Run:\n\`\`\`sh\n${n}=${v} npm start\n\`\`\`\nthen retry.` },
  { name: 'CRLF', wrap: (n, v) => `${n}=${v}\r\nNEXT=1\r\n` },
  { name: 'python', wrap: (n, v) => `cfg = dict(${n}="${v}", retries=3)` },
  { name: 'js object', wrap: (n, v) => `const cfg = { ${n}: '${v}', retries: 3 }` },
  { name: 'ruby hash', wrap: (n, v) => `{ '${n}' => '${v}' }` },
  { name: 'go', wrap: (n, v) => `${n} := "${v}"` },
]

const STRONG_NAMES = [
  'PASSWORD', 'password', 'Password', 'DB_PASSWORD', 'POSTGRES_PASSWORD', 'dbPassword', 'passwd', 'PASSWD', 'pwd', 'PWD', 'passphrase', 'PASSWORD_HASH', 'password_confirmation', 'new_password',
  'SECRET', 'secret', 'CLIENT_SECRET', 'clientSecret', 'JWT_SECRET', 'SECRET_KEY', 'SECRET_KEY_BASE', 'secret_value', 'TOKEN', 'token', 'AUTH_TOKEN', 'authToken', 'accessToken', 'access_token', 'refresh_token',
  'GITHUB_TOKEN', 'X-Auth-Token', 'csrf_token', 'API_KEY', 'apiKey', 'api-key', 'APIKEY', 'api.key', 'OPENAI_API_KEY', 'STRIPE_API_KEY_2', 'ACCESS_KEY', 'accessKey', 'access-key', 'PRIVATE_KEY', 'privateKey',
  'APIKey', 'ApiKey', 'SECRET_ACCESS_KEY', 'api_key_secret',
]
const WEAK_NAMES = ['CREDENTIAL', 'CREDENTIALS', 'credentials', 'AUTH', 'auth', 'BASIC_AUTH', 'basicAuth', 'http-auth']
const SECRET_VALUES = ['hunter2', 'Zx9!pQ%23', 's3cr3t-value', 'correct-horse-battery-staple']

test('mask: a name that holds a credential masks its value in every context and keeps name, separator and quotes', () => {
  const wrong: string[] = []
  let checked = 0
  const check = (name: string, value: string, ctx: (typeof SETTING_CONTEXTS)[number]) => {
    checked++
    const input = ctx.wrap(name, value)
    const out = maskText(input)
    const expected = ctx.wrap(name, MARK)
    if (out.text !== expected || out.count !== 1 || out.kinds.join() !== 'secret-setting' || !hasSecretShape(input)) wrong.push(`${ctx.name}: ${JSON.stringify(input)} -> ${JSON.stringify(out.text)}`)
    if (maskText(out.text).count !== 0 || hasSecretShape(out.text)) wrong.push(`not idempotent: ${ctx.name}: ${JSON.stringify(out.text)}`)
    if (value.length > 5 && /[a-z]/.test(value) && out.text.includes(value)) wrong.push(`leak: ${ctx.name}: ${JSON.stringify(input)}`)
  }
  for (const ctx of SETTING_CONTEXTS) {
    for (const name of STRONG_NAMES) for (const value of [...SECRET_VALUES, '12345678', 'true', 'False']) check(name, value, ctx)
    for (const name of WEAK_NAMES) for (const value of SECRET_VALUES) check(name, value, ctx)
  }
  expect(wrong.slice(0, 12)).toEqual([])
  expect(checked).toBe(SETTING_CONTEXTS.length * (STRONG_NAMES.length * 7 + WEAK_NAMES.length * 4))
})

const PLAIN_NAMES = [
  'author', 'authors', 'AUTHOR', 'authority', 'authenticate', 'authenticated', 'authorization_server', 'max_tokens', 'tokens', 'MAX_TOKENS', 'token_count', 'token_limit', 'tokenizer', 'num_tokens', 'prompt_tokens',
  'PASSWORD_MIN_LENGTH', 'password_policy', 'passwordless', 'secret_santa', 'secretary', 'TOKEN_URL', 'TOKEN_ENDPOINT', 'AUTH_URL', 'PASSWORD_FILE', 'TOKEN_FILE', 'SECRET_PATH', 'SECRET_NAME', 'TOKEN_ID', 'API_KEY_ID',
  'ACCESS_KEY_ID', 'PRIVATE_KEY_PATH', 'PRIVATE_KEY_ID', 'monkey', 'keyboard', 'key', 'KEY', 'api_keys', 'primary_key', 'foreign_key', 'sort_key', 'cache_key', 'token_ttl', 'TOKEN_EXPIRY', 'token_timeout',
  'SECRET_ROTATION_DAYS', 'AUTH_TYPE', 'auth_provider', 'AUTH_ENABLED', 'credentials_file', 'credential_helper', 'next_page_token', 'nextPageToken', 'page_token', 'next_token', 'password_reset_url', 'passport', 'bypass',
  'compass', 'passed', 'passenger', 'oauth_provider', 'tokenType', 'token_type', 'token_usage', 'x_authenticated_user', 'Authorization', 'WWW-Authenticate', 'max_password_length', 'secret_count', 'token_size', 'password_retries',
]

test('mask: names that only look like a credential are left alone: author, max_tokens, token_url, secret_santa and the like', () => {
  const wrong: string[] = []
  for (const ctx of SETTING_CONTEXTS) {
    for (const name of PLAIN_NAMES) {
      for (const value of ['abc123', 'Kit', 'hunter2', '100']) {
        const input = ctx.wrap(name, value)
        if (maskText(input).text !== input || hasSecretShape(input)) wrong.push(`${ctx.name}: ${JSON.stringify(input)}`)
      }
    }
  }
  expect(wrong.slice(0, 12)).toEqual([])
  for (const input of ['AUTHOR=Kit', 'Author: Ana <ana@acme-shop.vn>', 'max_tokens: 4096', 'token_count=17', 'PASSWORD_MIN_LENGTH=12', 'secret_santa: Ana', 'TOKEN_URL=https://acme-shop.vn/oauth/token']) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

test('mask: structural placeholders after a credential name are left alone', () => {
  const placeholders = [
    '${DB_PASSWORD}', '$DB_PASSWORD', '$1', '$(cat /run/secrets/db)', '<password>', '<your-password>', '{{password}}', '{{ vault_password }}', '[YOUR-PASSWORD]', '%PASSWORD%', '%s', '%(password)s', ':password', '****', '********', '....',
    '----', 'xxxx', 'XXXX', '•', '••••', '•••• masked', 'redacted', 'REDACTED', 'masked', 'null', 'none', 'nil', 'undefined', '', '#{ENV["X"]}', '${{ secrets.DB }}',
  ]
  const wrong: string[] = []
  for (const ctx of SETTING_CONTEXTS) {
    for (const name of ['PASSWORD', 'api_key', 'AUTH_TOKEN', 'credentials', 'x-auth-token']) {
      for (const p of placeholders) {
        if (p === '' && (ctx.name === 'log line' || ctx.name === 'markdown')) continue // `NAME= took=42ms`: see the test below
        const input = ctx.wrap(name, p)
        if (maskText(input).text !== input || hasSecretShape(input)) wrong.push(`${ctx.name}: ${JSON.stringify(input)}`)
      }
    }
  }
  expect(wrong.slice(0, 12)).toEqual([])
})

test('mask: code that reads or passes on a credential is not a credential: calls, subscripts, chains, types, keywords', () => {
  const snippets = [
    'password = input("Password: ")', 'password = getpass.getpass()', 'if token == None:', 'if (token === undefined) {', 'if (token != null) return', 'const apiKey = process.env.API_KEY', 'const apiKey = process.env.API_KEY || ""',
    'password = os.environ["DB_PASSWORD"]', 'password = os.environ.get("DB_PASSWORD")', "token = os.getenv('TOKEN')", 'token = None', 'self.token = token', 'this.apiKey = apiKey', 'const token = this.token',
    'token = await getToken()', 'const secret = new Secret()', 'password: string;', 'password: str = ""', 'token: Option<String>,', 'let token: &str = value;', 'private apiKey: string', 'auth => auth.ok', 'getToken()',
    'password = (a + b)', 'token: Bearer', 'secret = System.getenv("SECRET")', "api_key = ENV['API_KEY']", '$token = $_ENV["TOKEN"];', 'Password = Environment.GetEnvironmentVariable("PW")', 'password = $env:DB_PASSWORD',
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}', 'password: !secret db_password', 'password: *default_password', 'token: !!str', 'password: |', 'private_key: >-',
    'token => token.trim()', 'api_key = env!("API_KEY")', 'password = this.config.db.password', 'secret = self._load_secret()', 'const { password } = req.body', 'function login(user, password) {', 'def login(user, password=None):',
    'def login(user, password: str):', 'token = req.headers.authorization', 'let password = String::new();', 'password = lambda: 1', 'token: number | undefined', 'secret: Buffer,', 'password = Optional[str]',
    'password == "x"', 'token <= 5', 'secret != "x"', 'Foo::password()', '--password', '--token --verbose', '--password-file /run/secrets/pw', '-p hunter2',
  ]
  const wrong: string[] = []
  for (const s of snippets) if (maskText(s).text !== s || hasSecretShape(s)) wrong.push(`${s} -> ${maskText(s).text}`)
  expect(wrong).toEqual([])
})

test('mask: a literal after a credential name is masked: a quoted string, a bare word, a number, true and false', () => {
  const cases: [string, string][] = [
    ['password = "hunter2"', 'password = "•••• masked"'], ["password = 'hunter2'", "password = '•••• masked'"], ['const apiKey = "abc123def456"', 'const apiKey = "•••• masked"'], ['token: "abc"', 'token: "•••• masked"'],
    ["connect(password='hunter2')", "connect(password='•••• masked')"], ['{"password": "hunter2", "user": "ana"}', '{"password": "•••• masked", "user": "ana"}'], ['password := "hunter2"', 'password := "•••• masked"'],
    ["'password' => 'hunter2'", "'password' => '•••• masked'"], ['$password = "x1"', '$password = "•••• masked"'], ['password=hunter2', 'password=•••• masked'], ['password = hunter2', 'password = •••• masked'],
    ['token: abc', 'token: •••• masked'], ['PASSWORD=password', 'PASSWORD=•••• masked'], ['SECRET=secret', 'SECRET=•••• masked'], ['password: password', 'password: •••• masked'], ['PASSWORD=12345678', 'PASSWORD=•••• masked'],
    ['token: 12345', 'token: •••• masked'], ['"secret": 42', '"secret": •••• masked'], ['password=true', 'password=•••• masked'], ['PASSWORD: false', 'PASSWORD: •••• masked'], ['AUTH_TOKEN=1', 'AUTH_TOKEN=•••• masked'],
    ['api_key=0', 'api_key=•••• masked'], ['spring.datasource.password=hunter2', 'spring.datasource.password=•••• masked'], ['spring.datasource.password = hunter2', 'spring.datasource.password = •••• masked'],
    ['self.password = hunter2', 'self.password = •••• masked'], ['spring.datasource.password=password', 'spring.datasource.password=•••• masked'], ['db.password: hunter2', 'db.password: •••• masked'],
    ['password = pw', 'password = •••• masked'], // a variable is a bare word too: told apart only when it is the name itself (below)
  ]
  const wrong: string[] = []
  for (const [input, expected] of cases) {
    const out = maskText(input)
    if (out.text !== expected || out.count !== 1 || !hasSecretShape(input) || maskText(expected).count !== 0) wrong.push(`${input} -> ${out.text}`)
  }
  expect(wrong).toEqual([])
  // handing a variable on under its own name, written like code (blanks around a plain =), is not a literal
  for (const input of ['self.password = password', 'this.apiKey = apiKey', 'password = password', 'self.api_key = api_key', 'token = token', 'this.token = Token', 'client_secret = clientSecret']) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

test('mask: a weak name (auth, credentials) skips yes/no, numbers and client settings, a strong name does not', () => {
  for (const input of [
    'auth=true', 'AUTH=1', 'credentials: include', 'auth: none', 'auth = off', '"auth": false', 'AUTH=yes', 'credentials: omit', 'auth: oauth2', 'credentials: same-origin', "auth: 'ldap'", 'CREDENTIALS=0', 'auth: basic', 'auth: Bearer',
    "fetch(url, { credentials: 'include' })", 'auth: required', 'AUTH=disabled', '"credentials": "include"', 'basic_auth: false', query('token', 'true'), query('password', 'false'),
  ]) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
  for (const [input, expected] of [
    ['AUTH=hunter2', 'AUTH=•••• masked'], ['basic_auth: ana:hunter2', 'basic_auth: •••• masked'], ['credentials: hunter2', 'credentials: •••• masked'], ['"auth": "s3cr3t"', '"auth": "•••• masked"'],
    ['REDIS_AUTH=abc123', 'REDIS_AUTH=•••• masked'], ['CREDENTIALS=correct-horse', 'CREDENTIALS=•••• masked'],
  ] as [string, string][]) {
    expect(maskText(input).text).toBe(expected)
  }
})

test('mask: status words, URLs, paths and file names after a credential name are not credentials', () => {
  const inputs = [
    'Token: expired', 'password: required', 'auth: failed', 'secret: missing', 'password: invalid', 'token: valid', 'password: optional', 'api_key: unset', 'token: ok', 'password: n/a',
    'GOOGLE_APPLICATION_CREDENTIALS=/home/ana/key.json', 'credentials: ./creds.json', 'credentials = "credentials.json"', 'SECRET=/run/secrets/db', 'TOKEN=https://acme-shop.vn/token', 'PWD=/home/ana/acme-shop', 'PWD=/workspace/acme-shop',
    'OLDPWD=/x', 'cwd: PWD=/tmp/x', 'KEY_FILE: secrets/api.key', 'SSL_PRIVATE_KEY=C:\\certs\\site.pem', 'secret: ~/.config/acme/secret', 'token: ../token.txt', 'password: "tokens.yaml"', 'api_key: ./keys/api_key.pub',
    'token: https://user:pw@host', 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}', 'token={{ .Values.token }}', 'token: "{{ .Values.token }}"', 'token=%(token)s', 'password: "${DB_PASSWORD:-}"', 'password: `${db.password}`',
  ].filter(s => !s.includes('user:pw'))
  const wrong: string[] = []
  for (const s of inputs) if (maskText(s).text !== s || hasSecretShape(s)) wrong.push(`${s} -> ${maskText(s).text}`)
  expect(wrong).toEqual([])
  // a URL value keeps its own rule: the password in it is still masked
  expect(maskText('token: https://user:pw12@host/x').text).toBe('token: https://user:•••• masked@host/x')
})

test('mask: where a bare value ends: blank, comma, semicolon, quote, closing bracket, & and a sentence full stop', () => {
  const cases: [string, string][] = [
    ['password=abc,next=1', 'password=•••• masked,next=1'], ['password=abc;next=1', 'password=•••• masked;next=1'], ['(password=abc)', '(password=•••• masked)'], ['[token=abc]', '[token=•••• masked]'], ['{token=abc}', '{token=•••• masked}'],
    ['password=abc.', 'password=•••• masked.'], ['token=abc:', 'token=•••• masked:'], ['password=ab!', 'password=•••• masked'], ['password=ab?', 'password=•••• masked'], ['password=abc def', 'password=•••• masked def'],
    ['password=a.b-c_d+e/f=g', 'password=•••• masked'], ['password="a b c" next', 'password="•••• masked" next'], ['password=\'a "b" c\'', "password='•••• masked'"], ['password="pa\\"ss" next', 'password="•••• masked" next'],
    ['{"log":"login password=hunter2\\nnext line"}', '{"log":"login password=•••• masked\\nnext line"}'], ['{"log":"x token=abc\\"y"}', '{"log":"x token=•••• masked\\"y"}'],
    ['\\"password\\":\\"hunter2\\"', '\\"password\\":\\"•••• masked\\"'], ['password="abc def', 'password="•••• masked def'], ['password="', 'password="'], ['password=', 'password='], ['password=\nnext=1', 'password=\nnext=1'],
    ['password:   \t', 'password:   \t'], ['user=ana&password=pw1&x=2', 'user=ana&password=•••• masked&x=2'], ['password=pw1&token=pw2', 'password=•••• masked&token=•••• masked'], ['password=pw1&x=1&y=2', 'password=•••• masked&x=1&y=2'],
    ['password=ab&cd', 'password=•••• masked'], ['password=pw1 token=pw2', 'password=•••• masked token=•••• masked'], ['password=a\tb', 'password=•••• masked\tb'], ['password=pw1\r\ntoken=pw2\r\n', 'password=•••• masked\r\ntoken=•••• masked\r\n'],
  ]
  const wrong: string[] = []
  for (const [input, expected] of cases) {
    const out = maskText(input)
    if (out.text !== expected || maskText(out.text).count !== 0 || hasSecretShape(input) !== (expected !== input)) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(out.text)}`)
  }
  expect(wrong).toEqual([])
})

test('mask: an Authorization-like scheme before the value is kept and the value after it is masked', () => {
  for (const [input, expected] of [
    ['AUTH=Bearer abc123def', 'AUTH=Bearer •••• masked'], ['X-Auth-Token: Bearer abc123', 'X-Auth-Token: Bearer •••• masked'], ['auth: Basic dXNlcjpwdw==', 'auth: Basic •••• masked'], ['token: token abc123', 'token: token •••• masked'],
    ['api_key: bearer "abc123"', 'api_key: bearer "•••• masked"'],
  ] as [string, string][]) {
    expect(maskText(input).text).toBe(expected)
  }
  expect(maskText('token: Bearer').count).toBe(0)
  expect(maskText('token: Bearer\nnext: x').count).toBe(0)
})

test('mask: flags take their value after a blank too, and only a name that holds a credential', () => {
  for (const [input, expected] of [
    ['mysql --password hunter2 -h db', 'mysql --password •••• masked -h db'], ['mysql --password=hunter2 -h db', 'mysql --password=•••• masked -h db'], ['tool --api-key abc123 --verbose', 'tool --api-key •••• masked --verbose'],
    ['tool --client-secret=abc123', 'tool --client-secret=•••• masked'], ['tool --token abc123', 'tool --token •••• masked'], ['tool --access-token "abc 123"', 'tool --access-token "•••• masked"'],
  ] as [string, string][]) {
    expect(maskText(input).text).toBe(expected)
  }
  for (const input of ['mysql --password-file /run/secrets/pw', 'tool --token --verbose', 'tool --password', 'tool --password\nnext', 'tool --token-url https://x.y', '-p hunter2', 'tool -password hunter2 -x', 'tool --tokens 5', 'tool --author Kit']) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

test('mask: comparisons, scope operators and a name glued to other characters are not settings', () => {
  for (const input of ['token == "abc"', "password === 'x'", 'if (secret != "x") {', 'a::password', 'x.token::y', 'tokens = [a, b]', 'SECRETS: [a]', 'author: Ana', 'xpassword=abc', 'passwordx=abc', 'ｐａｓｓｗｏｒｄ=abc', 'password：abc', 'mật_khẩu: abc']) {
    expect(maskText(input)).toEqual({ text: input, count: 0, kinds: [] })
  }
})

test('mask: a setting inside a URL user info is left to the URL rule, one next to it is masked', () => {
  expect(maskText('https://x-access-token:abc123@github.com/acme/shop.git')).toEqual({ text: 'https://x-access-token:•••• masked@github.com/acme/shop.git', count: 1, kinds: ['url-password'] })
  expect(maskText('git clone https://ci-token:abc123@git.acme-shop.vn/x.git --token=abc123').text).toBe('git clone https://ci-token:•••• masked@git.acme-shop.vn/x.git --token=•••• masked')
  expect(maskText('{"url":"postgres://shop:hunter2@db/app","password":"hunter2"}').text).toBe('{"url":"postgres://shop:•••• masked@db/app","password":"•••• masked"}')
})

test('mask: a setting that holds a PEM key leaves the key to the private-key rule', () => {
  const label = 'PRIVATE KEY'
  const body = pem.body(2, 450)
  const expected = `${pem.begin(label)}\n${MARK}\n${pem.end(label)}`
  for (const wrap of [(s: string) => `PRIVATE_KEY=${s}\nNEXT=1`, (s: string) => `PRIVATE_KEY="${s}"\nNEXT=1`, (s: string) => `private_key: |\n${s}\nnext: 1`]) {
    const out = maskText(wrap(`${pem.begin(label)}\n${body}\n${pem.end(label)}`))
    expect(out.text).toBe(wrap(expected))
    expect(out.kinds).toEqual(['private-key'])
    expect(out.count).toBe(1)
  }
  const json = JSON.stringify({ private_key_id: 'abc123', private_key: `${pem.begin(label)}\n${body}\n${pem.end(label)}\n` })
  const out = maskText(json)
  expect(out.kinds).toEqual(['private-key'])
  expect(out.text).toContain('"private_key_id":"abc123"')
})

test('mask: a token in a setting is named for what it is, and the setting masks what the token rule cannot see', () => {
  const claude = TOKENS[0]!
  expect(maskText(`ANTHROPIC_API_KEY=${claude.value}`)).toEqual({ text: 'ANTHROPIC_API_KEY=sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
  expect(maskText(`API_KEY=${claude.value}.tail`).count).toBe(1)
  expect(JSON.stringify(maskText(`API_KEY=${claude.value}.tail`))).not.toContain(claude.body)
  expect(maskText(`API_KEY=${claude.value} PASSWORD=hunter2`)).toEqual({ text: 'API_KEY=sk-ant-•••• masked PASSWORD=•••• masked', count: 2, kinds: ['anthropic-key', 'secret-setting'] })
})

test('mask: settings and the other rules in one text: every secret goes, kinds come in the order of the text', () => {
  const text = [
    'DB_PASSWORD=hunter2', `API_KEY=${TOKENS[0]!.value}`, 'Server=x;Password=a b;', 'x-api-key: abcdefghij', url('postgres', 'shop', 'pa/ss', 'db/app'), 'max_tokens=4096', 'AUTHOR=Kit',
  ].join('\n')
  const out = maskText(text)
  expect(out.text).toBe(['DB_PASSWORD=•••• masked', 'API_KEY=sk-ant-•••• masked', 'Server=x;Password=•••• masked;', 'x-api-key: •••• masked', 'postgres://shop:•••• masked@db/app', 'max_tokens=4096', 'AUTHOR=Kit'].join('\n'))
  expect(out.kinds).toEqual(['secret-setting', 'anthropic-key', 'connection-string', 'api-key-header', 'url-password'])
  expect(out.count).toBe(5)
  expect(maskText(out.text).count).toBe(0)
})

test('mask: settings in plain data: maskDeep masks the value of a setting in any string', () => {
  const out = maskDeep({ content: [{ type: 'text', text: 'PASSWORD=hunter2\nPORT=3000' }], env: { PASSWORD: 'hunter2' } })
  expect(out.value.content[0]).toEqual({ type: 'text', text: 'PASSWORD=•••• masked\nPORT=3000' })
  expect(out.value.env.PASSWORD).toBe('hunter2') // values only, keys are not text: a bare value has no name next to it
  expect(out.count).toBe(1)
  expect(out.kinds).toEqual(['secret-setting'])
})

test('mask: hostile text around names and values never throws and keeps the rest', () => {
  const samples = [
    `${'a'.repeat(5000)}password=hunter2`, `password=${'\u0000'.repeat(50)}x`, 'password=\u202ehunter2', 'password=\ud800', 'password=hunter2\u2028next', `${'password '.repeat(2000)}`, `${'token:'.repeat(100)}x`, '\u0000password=x\u0000',
    `${'_'.repeat(70)}password=x`, `${'a-'.repeat(40)}token=x`, 'PASSWORD'.repeat(100), `password = ${'"'.repeat(30)}`, `password='${'\\'.repeat(31)}`, 'password=\\', 'password="\\', '\\"password\\"', '\\"password\\":\\"', 'token="\\"',
  ]
  for (const s of samples) {
    let out = { text: s, count: 0, kinds: [] as string[] }
    expect(() => {
      out = maskText(s)
    }).not.toThrow()
    expect(hasSecretShape(s)).toBe(out.count > 0)
    expect(maskText(out.text).count).toBe(0)
  }
  expect(maskText('password=\u0000hunter2').text).toBe('password=•••• masked')
  expect(maskText(`${'x'.repeat(100)} password=hunter2 ${'y'.repeat(100)}`).text).toBe(`${'x'.repeat(100)} password=•••• masked ${'y'.repeat(100)}`)
})

// --- connection strings -----------------------------------------------------------------------------------------------

test('mask: Password, Pwd, AccountKey and SharedAccess values in a Key=Value;Key=Value string are masked up to the next ;', () => {
  const key = fill(60, 460, B64) + '=='
  const cases: [string, string][] = [
    ['Server=db.acme-shop.vn;Database=shop;User Id=sa;Password=hunter2;Encrypt=yes;', 'Server=db.acme-shop.vn;Database=shop;User Id=sa;Password=•••• masked;Encrypt=yes;'],
    ['Server=x;Password=my pass word;Trust=1', 'Server=x;Password=•••• masked;Trust=1'], ['Server=x; Password = a b ;Trust=1', 'Server=x; Password = •••• masked ;Trust=1'], ['Server=x;pwd=hunter2;', 'Server=x;pwd=•••• masked;'],
    ['Server=x;PWD=hunter2', 'Server=x;PWD=•••• masked'], ['Password=hunter2;User=sa', 'Password=•••• masked;User=sa'], ['Server=x;Password=p,a)s(s;', 'Server=x;Password=•••• masked;'],
    [`DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${key};EndpointSuffix=core.windows.net`, 'DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=•••• masked;EndpointSuffix=core.windows.net'],
    [`Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${key}`, 'Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=•••• masked'],
    ['Endpoint=sb://x/;SharedAccessSignature=SharedAccessSignature sr=a&sig=b%3D&se=1;Other=1', 'Endpoint=sb://x/;SharedAccessSignature=•••• masked;Other=1'], ["Server=x;Password='a;b';Trust=1", "Server=x;Password='•••• masked';Trust=1"],
    ['ACCOUNTKEY=abc123;', 'ACCOUNTKEY=•••• masked;'], ['sharedaccesskey=abc123;', 'sharedaccesskey=•••• masked;'],
  ]
  const wrong: string[] = []
  for (const [input, expected] of cases) {
    const out = maskText(input)
    if (out.text !== expected || out.count !== 1 || out.kinds.join() !== 'connection-string' || !hasSecretShape(input) || maskText(out.text).count !== 0) wrong.push(`${input.slice(0, 60)} -> ${out.text.slice(0, 80)}`)
    if (out.text.includes(key.slice(0, 20))) wrong.push(`leak ${input.slice(0, 40)}`)
  }
  expect(wrong).toEqual([])
})

test('mask: a connection string in quotes, JSON, YAML, a command, CRLF and an escaped JSON string', () => {
  const cs = 'Server=db;User Id=sa;Password=hunter two;Encrypt=yes'
  const masked = 'Server=db;User Id=sa;Password=•••• masked;Encrypt=yes'
  for (const wrap of [
    (s: string) => `"${s}"`, (s: string) => `'${s}'`, (s: string) => `{"cs":"${s}"}`, (s: string) => `cs: ${s}\nnext: 1`, (s: string) => `CONN=${s}\r\nNEXT=1\r\n`, (s: string) => `sqlcmd -C "${s}" -Q "select 1"`,
    (s: string) => JSON.stringify({ cs: s }), (s: string) => `x ${s};`, (s: string) => `\\"${s}\\"`, (s: string) => `ConnectionStrings__Db="${s}"`, (s: string) => `<add connectionString="${s}" />`,
  ]) {
    const out = maskText(wrap(cs))
    expect(out.text).toBe(wrap(masked))
    expect(out.count).toBe(1)
    expect(out.text).not.toContain('hunter')
    expect(maskText(out.text).count).toBe(0)
  }
  // the connection string rule wins the name over the plain setting rule when both see the value
  expect(maskText('Server=x;Password=hunter2;').kinds).toEqual(['connection-string'])
  expect(maskText('Server=x;SharedAccessKey=abc123;').kinds).toEqual(['connection-string'])
})

test('mask: Password= outside a connection string is a plain setting; empty values, placeholders and paths stay', () => {
  expect(maskText('The Password=hunter2 to host')).toEqual({ text: 'The Password=•••• masked to host', count: 1, kinds: ['secret-setting'] })
  expect(maskText('Password=hunter2')).toEqual({ text: 'Password=•••• masked', count: 1, kinds: ['secret-setting'] })
  for (const input of [
    'Password=', 'Password=;', 'Server=x;Password=;Trust=1', 'Server=x;Password=${DB_PASSWORD};', 'Server=x;Password=$DB_PASSWORD;', 'Server=x;Password=<your password>;', 'Server=x;Password=*****;', 'Server=x;Password=•••• masked;',
    'Server=x;Password={your password};', 'Server=x;Password=%DB_PASSWORD%;', 'Server=x;Password=redacted;', 'FOO=1; PWD=/home/ana;', 'PWD=/home/ana\nOLDPWD=/tmp', 'Server=x;Password="', 'a = "Password=" + pw + ";"',
    'SharedAccessKeyName=RootManageSharedAccessKey', 'AccountName=acme;EndpointSuffix=x', 'Server=x;PasswordPolicy=strict;', 'Server=x;Passwords=a;',
  ]) {
    const out = maskText(input)
    expect(out.text, input).toBe(input)
    expect(out.count).toBe(0)
  }
})

// --- x-api-key --------------------------------------------------------------------------------------------------------

test('mask: an x-api-key header or setting is masked from 8 characters on, in any letter case', () => {
  const v = 'abcd1234efgh'
  for (const [input, expected] of [
    [`x-api-key: ${v}`, `x-api-key: ${MARK}`], [`X-API-KEY: ${v}`, `X-API-KEY: ${MARK}`], [`X-Api-Key:${v}`, `X-Api-Key:${MARK}`], [`"x-api-key": "${v}"`, `"x-api-key": "${MARK}"`], [`'x-api-key': '${v}'`, `'x-api-key': '${MARK}'`],
    [`curl -H "x-api-key: ${v}" https://api.acme-shop.vn`, `curl -H "x-api-key: ${MARK}" https://api.acme-shop.vn`], [`curl -H 'X-API-Key: ${v}'`, `curl -H 'X-API-Key: ${MARK}'`], [`x_api_key=${v}`, `x_api_key=${MARK}`],
    [`> x-api-key: ${v}\r\n> accept: */*`, `> x-api-key: ${MARK}\r\n> accept: */*`], [`headers = {'x-api-key': '${v}'}`, `headers = {'x-api-key': '${MARK}'}`], [`{"headers":{"x-api-key":"${v}"}}`, `{"headers":{"x-api-key":"${MARK}"}}`],
    ['x-api-key: 12345678', `x-api-key: ${MARK}`], [`xApiKey: ${v}`, `xApiKey: ${MARK}`],
  ] as [string, string][]) {
    const out = maskText(input)
    expect(out.text).toBe(expected)
    expect(out.kinds).toEqual(['api-key-header'])
    expect(maskText(out.text).count).toBe(0)
    expect(hasSecretShape(input)).toBe(true)
  }
})

test('mask: an x-api-key value under 8 characters, a placeholder or code is left alone; a token in it is named for what it is', () => {
  for (const input of [
    'x-api-key: abcdefg', 'x-api-key: ', 'x-api-key:', 'x-api-key: ${KEY}', 'x-api-key: <key>', 'x-api-key: ********', 'x-api-key: xxxxxxxx', 'x-api-key: $API_KEY', 'x-api-key: •••• masked', "'x-api-key': process.env.API_KEY", 'x-api-key: redacted',
    'x-api-key: null', 'x-api-key-id: abcdefghijkl', 'x-api-keys: abcdefghijkl', 'x-api-keyx: abcdefghijkl', 'The x-api-key header is required', "headers['x-api-key'] = apiKey", 'x-api-key: {{ key }}',
  ]) {
    expect(maskText(input), input).toEqual({ text: input, count: 0, kinds: [] })
  }
  const claude = TOKENS[0]!
  expect(maskText(`x-api-key: ${claude.value}`)).toEqual({ text: 'x-api-key: sk-ant-•••• masked', count: 1, kinds: ['anthropic-key'] })
})

// --- URL passwords with a slash -----------------------------------------------------------------------------------------

test('mask: a URL password that holds slashes is masked up to the last @, and the rest of the URL stays', () => {
  const cases: [string, string][] = [
    ['postgres://user:pa/ss/word@host/db', 'postgres://user:•••• masked@host/db'], ['redis://:a/b@h:6379', 'redis://:•••• masked@h:6379'], ['amqp://guest:p/q%2F@mq:5672/%2f', 'amqp://guest:•••• masked@mq:5672/%2f'],
    ['postgres://u:/leading@h/db', 'postgres://u:•••• masked@h/db'], ['postgres://u:trailing/@h/db', 'postgres://u:•••• masked@h/db'], ['mongodb://u:a/b/c/d/e@h/db?x=1', 'mongodb://u:•••• masked@h/db?x=1'],
['https://ana:Zx9!/pQ@git.acme-shop.vn/x.git', 'https://ana:•••• masked@git.acme-shop.vn/x.git'], ['ftp://anonymous:me/x@acme-shop.vn/pub', 'ftp://anonymous:•••• masked@acme-shop.vn/pub'],
    ['postgres://john.doe:a1/b@h/db', 'postgres://john.doe:•••• masked@h/db'],
  ]
  for (const [input, expected] of cases) {
    const out = maskText(input)
    expect(out.text, input).toBe(expected)
    expect(out.count).toBe(1)
    expect(out.kinds).toEqual(['url-password'])
    expect(maskText(out.text).count).toBe(0)
    expect(hasSecretShape(input)).toBe(true)
  }
  const two = `${cases[0]![0]} ${url('mysql', 'root', 'x/y', 'm/db')}`
  expect(maskText(two)).toEqual({ text: 'postgres://user:•••• masked@host/db mysql://root:•••• masked@m/db', count: 2, kinds: ['url-password'] })
  expect(maskText(`psql '${cases[0]![0]}' -c "select 'a@b'"`).text).toBe(`psql 'postgres://user:•••• masked@host/db' -c "select 'a@b'"`)
  expect(maskText(`DATABASE_URL="${cases[0]![0]}"`).text).toBe('DATABASE_URL="postgres://user:•••• masked@host/db"')
  expect(maskText(`{"db":"${cases[1]![0]}","email":"a@b.co"}`).text).toBe('{"db":"redis://:•••• masked@h:6379","email":"a@b.co"}')
})

test('mask: host:port/path@x is a host, a port and a path, never a user and a password', () => {
  const hosts = [
    'https://host:8080/@scope/pkg', 'https://registry.example.com:443/@a/b', 'http://localhost:3000/users/@me', 'git@github.com:org/repo.git', 'https://registry.npmjs.org:443/@types%2fnode', 'http://[::1]:8080/@x/y', 'http://[::1]:8080/x@y',
    'https://api.example.com:8080/v1/users/@me', 'ws://host:9000/ws/@user', 'https://example.com:80/@a', 'ssh://git@github.com:22/org/repo.git', 'https://a.b.c:1/@x', 'http://10.0.0.1:8080/@scope/pkg', 'http://localhost:65535/@x/y@z',
    'npm view https://registry.example.com:443/@a/b@1.0.0', 'curl http://localhost:3000/users/@me -H "x: y"', 'see https://host:8080/@scope/pkg and https://host:9090/@other/pkg',
  ]
  // the second list: a host with a dot and a "password" that starts with digits and holds a path
  const dotted = ['https://api.example.com:8080path/@x', 'https://svc.example.org:5432abc/x@y', 'http://registry.example.com:4873v2/@a/b']
  for (const input of [...hosts, ...dotted]) expect(maskText(input), input).toEqual({ text: input, count: 0, kinds: [] })
  // the neighbours that are real credentials
  expect(maskText('https://host:8080/@scope/pkg https://u:pw12@host/@scope/pkg').text).toBe('https://host:8080/@scope/pkg https://u:•••• masked@host/@scope/pkg')
  expect(maskText('postgres://john.doe:12345@host/db').text).toBe('postgres://john.doe:•••• masked@host/db') // digits without a slash: as before
  expect(maskText('https://svc.example.org:5432@host/db').text).toBe('https://svc.example.org:•••• masked@host/db')
})

// --- new shapes: idempotence, agreement, speed ---------------------------------------------------------------------------


test('mask: the new shapes are idempotent: masked text is never masked again, in any order or mixture', () => {
  const everything = [...NEW_SHAPES, ...TOKENS.map(t => `API_KEY=${t.value}`)].join('\n')
  const first = maskText(everything)
  expect(first.count).toBeGreaterThanOrEqual(NEW_SHAPES.length + TOKENS.length)
  expect(maskText(first.text)).toEqual({ text: first.text, count: 0, kinds: [] })
  expect(hasSecretShape(first.text)).toBe(false)
  for (const kind of first.kinds) expect(KINDS).toContain(kind)
  for (const shape of NEW_SHAPES) {
    const out = maskText(shape)
    expect(out.count, shape).toBeGreaterThan(0)
    expect(maskText(out.text).count, shape).toBe(0)
    expect(maskText(`${shape} ${shape}`).count).toBeGreaterThanOrEqual(1)
  }
})

test('mask: text that was already masked by the new rules is never masked again', () => {
  for (const text of [
    'AGE-SECRET-KEY-•••• masked', 'xapp-•••• masked', 'ya29.•••• masked', 'sbp_•••• masked', 'dop_v1_•••• masked', 'pypi-•••• masked', 'bot•••• masked', 'PASSWORD=•••• masked', 'password: "•••• masked"', 'Server=x;Password=•••• masked;',
    'x-api-key: •••• masked', 'postgres://u:•••• masked@h/db', '--password •••• masked', 'AUTH=Bearer •••• masked', '{"apiKey":"•••• masked"}', "'password' => '•••• masked'", 'API_KEY=sk-ant-•••• masked', 'AccountKey=•••• masked;',
    '\\"password\\":\\"•••• masked\\"', 'password="•••• masked def',
  ]) {
    expect(maskText(text), text).toEqual({ text, count: 0, kinds: [] })
    expect(hasSecretShape(text)).toBe(false)
  }
})

// --- masking one thing must not change what else is found ----------------------------------------------------------------

test('mask: a value that is kept does not hide the names inside it, so a second pass finds nothing new', () => {
  // Found by fuzzing: a kept value (a URL, a placeholder) that holds a name after another rule masked something in it
  const token = ['pypi', 'AgEIcHlwaS5vcmc'].join('-') + fill(60, 490, URLSAFE)
  const cases: [string, string][] = [
    ['Password=pncB7kpostgres://u:pa/ss@h/dbtoken=password: string=-vGC9WbJt9', 'Password=pncB7kpostgres://u:•••• masked@h/dbtoken=password: •••• masked'],
    ['token=AGE-SECRET-KEY-1postgres://u:pa/ss@h/db.-password: x1', 'token=AGE-SECRET-KEY-1postgres://u:•••• masked@h/db.-password: •••• masked'],
    ['accountkey= abc123 AccountKey=def456;', 'accountkey= •••• masked AccountKey=•••• masked;'],
    ['token= --token password= AccountKey=abc==;', 'token= --token •••• masked AccountKey=•••• masked;'],
    ['password:  password= accountkey= ya29. password PASSWORD=12345678', 'password:  •••• masked accountkey= •••• masked password PASSWORD=•••• masked'],
    [`${token}self.password = hello1`, 'pypi-•••• masked.password = •••• masked'],
    [`${token}.password=hunter2`, 'pypi-•••• masked.password=•••• masked'],
    [`${TOKENS[0]!.value}.password=hunter2`, 'sk-ant-•••• masked.password=•••• masked'],
    [`${TOKENS[0]!.value}passwordspring.datasource.password=hunter2`, 'sk-ant-•••• masked.datasource.password=•••• masked'],
  ]
  const wrong: string[] = []
  for (const [input, expected] of cases) {
    const out = maskText(input)
    const again = maskText(out.text)
    if (out.text !== expected || again.count !== 0 || hasSecretShape(out.text)) wrong.push(`${input.slice(0, 50)} -> ${out.text.slice(0, 80)} (again ${again.count})`)
  }
  expect(wrong).toEqual([])
})

test('mask: a URL password with slashes ends at the first @ after them, so text after the URL cannot move it', () => {
  expect(maskText('postgres://u:pa/ss@h/db•x@y').text).toBe('postgres://u:•••• masked@h/db•x@y')
  expect(maskText('postgres://u:pa/ss@h/dbpassword=@x').text).toBe('postgres://u:•••• masked@h/dbpassword=@x')
  expect(maskText('postgres://u:pa/ss@h/db').text).toBe('postgres://u:•••• masked@h/db')
  // without a slash before the first @, the last @ before the first / is the end, as it always was
  expect(maskText('postgres://shop:p@ss@db.acme-shop.vn/app').text).toBe('postgres://shop:•••• masked@db.acme-shop.vn/app')
})

test('mask: shell expansions and the next setting after a blank are not values', () => {
  for (const input of ['POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}', 'x=${TOKEN:?missing}', 'echo ${API_KEY:=none}', 'PASSWORD= took=42ms', '2026-11-24 INFO PASSWORD= user=ana']) {
    expect(maskText(input), input).toEqual({ text: input, count: 0, kinds: [] })
  }
  // after a `:` (or a `=` that has a blank before it too) a blank is the usual separator, so the next word is the value
  expect(maskText('token: took').text).toBe('token: •••• masked')
  expect(maskText('TOKEN= npm start').text).toBe('TOKEN= •••• masked start')
  // a quote right after `Password=` that closes the string the name opened is not the start of a value
  expect(maskText('a = "Password=" + pw + ";"')).toEqual({ text: 'a = "Password=" + pw + ";"', count: 0, kinds: [] })
  expect(maskText('Password="hunter2"').text).toBe('Password="•••• masked"')
})
