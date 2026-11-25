// Fixtures shared by mask.test.ts, mask-perf.test.ts and mask-perf-settings.test.ts. Every secret-shaped value is assembled at run time from fragments: no key, token, JWT or PEM
// block is ever written out contiguously in these files (secret scanners reject files that hold one). Nothing here registers a test.

export const MARK = '•••• masked'
export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const URLSAFE = `${ALNUM}-_`
export const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export const B64 = `${ALNUM}+/`
export const HEX = '0123456789abcdef'
export const DIGITS = '0123456789'

/** Deterministic pseudo-random text over an alphabet: the same seed always gives the same body. */
export function fill(n: number, seed = 1, alphabet = ALNUM): string {
  let x = (seed * 7919 + 17) >>> 0
  let out = ''
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out += alphabet.charAt((x >>> 8) % alphabet.length)
  }
  return out
}

export type Fx = { name: string; kind: string; value: string; body: string; masked: string }

/** One realistic secret of every shape: `value` is what a tool prints, `body` the part that must never come back. */
export function tokens(): Fx[] {
  const list: Fx[] = []
  const add = (name: string, kind: string, masked: string, head: string, body: string) => list.push({ name, kind, masked, body, value: head + body })
  add('anthropic api03', 'anthropic-key', 'sk-ant-•••• masked', ['sk', 'ant', 'api03', ''].join('-'), fill(60, 1, URLSAFE))
  add('anthropic admin01', 'anthropic-key', 'sk-ant-•••• masked', ['sk', 'ant', 'admin01', ''].join('-'), fill(50, 2, URLSAFE))
  add('anthropic oat01', 'anthropic-key', 'sk-ant-•••• masked', ['sk', 'ant', 'oat01', ''].join('-'), fill(30, 3, URLSAFE))
  add('anthropic sid01', 'anthropic-key', 'sk-ant-•••• masked', ['sk', 'ant', 'sid01', ''].join('-'), fill(24, 4, URLSAFE))
  add('openai bare', 'openai-key', 'sk-•••• masked', ['sk', ''].join('-'), fill(48, 5))
  add('openai proj', 'openai-key', 'sk-proj-•••• masked', ['sk', 'proj', ''].join('-'), fill(120, 6, URLSAFE))
  add('openai svcacct', 'openai-key', 'sk-svcacct-•••• masked', ['sk', 'svcacct', ''].join('-'), fill(90, 7, URLSAFE))
  add('openai admin', 'openai-key', 'sk-admin-•••• masked', ['sk', 'admin', ''].join('-'), fill(60, 8, URLSAFE))
  for (const [i, letter] of ['p', 'o', 'u', 's', 'r'].entries()) {
    add(`github gh${letter}`, 'github-token', `gh${letter}_•••• masked`, `gh${letter}_`, fill(36 + i, 10 + i))
  }
  add('github fine-grained', 'github-token', 'github_pat_•••• masked', ['github', 'pat', ''].join('_'), fill(82, 15, `${ALNUM}_`))
  add('aws AKIA', 'aws-access-key', 'AKIA•••• masked', ['AK', 'IA'].join(''), fill(16, 16, UPPER_DIGITS))
  add('aws ASIA', 'aws-access-key', 'ASIA•••• masked', ['AS', 'IA'].join(''), fill(16, 17, UPPER_DIGITS))
  const stripe: [string, string][] = [['sk', 'live'], ['sk', 'test'], ['rk', 'live'], ['rk', 'test']]
  for (const [i, [a, b]] of stripe.entries()) {
    add(`stripe ${a}_${b}`, 'stripe-key', `${a}_${b}_•••• masked`, [a, b, ''].join('_'), fill(24 + i, 20 + i))
  }
  add('stripe webhook', 'stripe-key', 'whsec_•••• masked', ['whsec', ''].join('_'), fill(32, 25))
  add('jwt', 'jwt', 'eyJ•••• masked', 'eyJ', [fill(33, 26, URLSAFE), `eyJ${fill(40, 27, URLSAFE)}`, fill(43, 28, URLSAFE)].join('.'))
  add('google', 'google-api-key', 'AIza•••• masked', ['AI', 'za'].join(''), fill(35, 29, URLSAFE))
  for (const [i, letter] of ['b', 'a', 'p', 'o', 's', 'r'].entries()) {
    add(`slack xox${letter}`, 'slack-token', `xox${letter}-•••• masked`, `xox${letter}-123456789012-1234567890123-`, fill(24, 30 + i))
  }
  add('npm', 'npm-token', 'npm_•••• masked', ['npm', ''].join('_'), fill(36, 40))
  add('gitlab', 'gitlab-token', 'glpat-•••• masked', ['glpat', ''].join('-'), fill(20, 41, URLSAFE))
  add('huggingface', 'huggingface-token', 'hf_•••• masked', ['hf', ''].join('_'), fill(34, 42))
  add('sendgrid', 'sendgrid-key', 'SG.•••• masked', 'SG.', [fill(22, 43, URLSAFE), fill(43, 44, URLSAFE)].join('.'))
  add('age', 'age-key', 'AGE-SECRET-KEY-•••• masked', ['AGE', 'SECRET', 'KEY', '1'].join('-'), fill(58, 45, UPPER_DIGITS))
  add('slack app', 'slack-app-token', 'xapp-•••• masked', ['xapp', '1', `A${fill(10, 46, UPPER_DIGITS)}`, fill(13, 47, DIGITS), ''].join('-'), fill(64, 48, HEX))
  add('google oauth', 'google-oauth-token', 'ya29.•••• masked', ['ya29', ''].join('.'), fill(60, 49, URLSAFE))
  add('supabase', 'supabase-token', 'sbp_•••• masked', ['sbp', ''].join('_'), fill(40, 50, HEX))
  for (const [i, kind] of ['dop', 'doo', 'dor'].entries()) {
    add(`digitalocean ${kind}`, 'digitalocean-token', `${kind}_v1_•••• masked`, [kind, 'v1', ''].join('_'), fill(64, 51 + i, HEX))
  }
  add('pypi', 'pypi-token', 'pypi-•••• masked', ['pypi', 'AgEIcHlwaS5vcmc'].join('-'), fill(70, 54, URLSAFE))
  add('pypi test', 'pypi-token', 'pypi-•••• masked', ['pypi', 'AgENdGVzdC5weXBpLm9yZw'].join('-'), fill(70, 55, URLSAFE))
  add('telegram', 'telegram-bot-token', '•••• masked', `${fill(9, 56, DIGITS)}:`, fill(35, 57, URLSAFE))
  add('telegram bot', 'telegram-bot-token', 'bot•••• masked', `bot${fill(10, 58, DIGITS)}:`, fill(35, 59, URLSAFE))
  return list
}

export const TOKENS = tokens()

/** Where a secret turns up in real tool output. `hits` is how many secrets the wrapper holds. */
export const CONTEXTS: { name: string; hits: number; wrap: (s: string) => string }[] = [
  { name: 'alone', hits: 1, wrap: s => s },
  { name: '.env dump', hits: 1, wrap: s => `NODE_ENV=production\nAPI_KEY=${s}\nPORT=3000\n` },
  { name: 'json', hits: 1, wrap: s => `{"apiKey":"${s}","retries":3}` },
  { name: 'curl', hits: 1, wrap: s => `curl -H 'x-api-key: ${s}' https://api.acme-shop.vn/v1/orders` },
  { name: 'log line', hits: 1, wrap: s => `2026-11-24T10:00:00Z INFO request ok key=${s} took=42ms` },
  { name: 'stack trace', hits: 1, wrap: s => `Error: 401 Unauthorized (key ${s})\n    at call (/app/src/api.ts:10:5)\n    at main (/app/src/index.ts:3:1)` },
  { name: 'markdown block', hits: 1, wrap: s => `Run:\n\`\`\`sh\nexport KEY=${s}\n\`\`\`\nthen retry.` },
  { name: 'CRLF', hits: 1, wrap: s => `KEY=${s}\r\nNEXT=1\r\n` },
  { name: 'at the start', hits: 1, wrap: s => `${s} is the key` },
  { name: 'at the end', hits: 1, wrap: s => `the key is ${s}` },
  { name: 'both quote styles', hits: 2, wrap: s => `'${s}' and "${s}"` },
  { name: 'unicode around', hits: 1, wrap: s => `khóa: ${s} — xong ✓ 🎉` },
  { name: 'two lines', hits: 2, wrap: s => `a=${s}\nb=${s}` },
]

export const pem = {
  begin: (label: string) => ['-----', 'BEGIN ', label, '-----'].join(''),
  end: (label: string) => ['-----', 'END ', label, '-----'].join(''),
  body: (lines = 3, seed = 50) => Array.from({ length: lines }, (_, i) => fill(64, seed + i, B64)).join('\n'),
}
export const LABELS = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK', 'DSA PRIVATE KEY']

export const url = (scheme: string, user: string, password: string, rest: string) => `${scheme}://${user}:${password}@${rest}`
export const query = (name: string, value: string, base = 'https://api.acme-shop.vn/v1/orders') => `${base}?${name}=${value}`
export const bearer = (scheme: string, value: string) => ['Authorization', `${scheme} ${value}`].join(': ')
export const big = (unit: string, size = 1_000_000) => unit.repeat(Math.ceil(size / unit.length))
export const timed = <R>(run: () => R): { ms: number; result: R } => {
  const t = Date.now()
  const result = run()
  return { ms: Date.now() - t, result }
}

/** The shapes of the newer rules (named settings, connection strings, headers, URL passwords with a slash), one of each. */
export const NEW_SHAPES = [
  'PASSWORD=hunter2', 'DB_PASSWORD: "hunter2"', '{"apiKey":"abc12345"}', "'password' => 'hunter2'", 'password := "hunter2"', 'mysql --password hunter2', 'AUTH=Bearer abc123def', 'Server=x;Password=a b;Trust=1', 'AccountKey=abc==;',
  'x-api-key: abcd1234efgh', 'postgres://u:pa/ss@h/db', '\\"password\\":\\"hunter2\\"', 'spring.datasource.password=hunter2', 'PASSWORD=12345678', 'token: "abc"', `Authorization: ${'Bearer'} ${fill(20, 470)}`,
]
