import { expect, test } from 'claude-code/testing'

import { hasSecretShape, maskText } from './mask'
import { URLSAFE, UPPER_DIGITS, B64, fill, TOKENS, pem, url, query, bearer, big, timed, NEW_SHAPES } from '../tests/mask-helpers'

// Big, pathological and generated inputs for the setting, connection string, header and URL rules, and the generated
// strings on which `hasSecretShape` must agree with `maskText`.

test('hasSecretShape: true exactly when maskText would change the text, on 4000 generated strings', () => {
  const near = [
    `sk-${fill(39, 300, URLSAFE)}`, `ghp_${fill(35, 301)}`, ['AK', 'IA'].join('') + fill(15, 302, UPPER_DIGITS), `eyJ${fill(20, 303)}.eyJ${fill(20, 304)}`, 'Authorization: Bearer short', '?token=', '&password=changeme',
    url('postgres', 'shop', '${PW}', 'db/app'), url('postgres', 'shop', 'x'.repeat(4), 'db/app'), pem.begin('PRIVATE KEY'), `${pem.begin('PRIVATE KEY')}\n...\n${pem.end('PRIVATE KEY')}`,
  ]
  const pool = [
    ...TOKENS.map(t => t.value), ...near,
    url('postgres', 'shop', 'hunter2', 'db.acme-shop.vn/app'), query('token', 'abc123'), '&apikey=abc123', bearer('Bearer', fill(30, 305)), `aws_secret_access_key = "${fill(40, 306, B64)}"`,
    `${pem.begin('PRIVATE KEY')}\n${pem.body(2, 307)}\n${pem.end('PRIVATE KEY')}`, `${pem.begin('RSA PRIVATE KEY')}\n${pem.body(1, 309)}`, `${pem.begin('EC PRIVATE KEY')}\n`,
    'sk-', 'sk-ant-', 'eyJ', '.', ':', '://', '@', '?', '&', '=', '#', '/', ' ', '\n', '\r\n', '\t', '"', "'", '\\n', '\\', '•', '••••', ' masked', 'password=', 'token=', 'Authorization: ', 'Bearer ', 'x', '-', '_', '0',
    '-----BEGIN ', '-----END PRIVATE KEY-----', 'AKIA', 'ghp_', 'SG.', 'xoxb-', 'whsec_', 'sk_live_',
    // the newer rules: every shape, its near misses (names that are not credentials, values that are code, short values) and the fragments they are made of
    ...NEW_SHAPES, 'max_tokens=5', 'author=Kit', 'Password=;', 'x-api-key: short', 'token == None', 'password = input("x")', 'process.env.API_KEY', 'token=', 'password: ', 'self.password = password', 'https://host:8080/@a/b',
    'PWD=/home/ana', 'Server=x;', 'TOKEN_URL=https://acme-shop.vn', 'credentials: include', 'password: string', '${PASSWORD}', 'AUTH_TYPE=basic', 'sbp_', 'ya29.', 'xapp-1-', 'AGE-SECRET-KEY-1', 'pypi-AgEIcHlwaS5vcmc', 'dop_v1_',
    'password', 'token', 'api_key', 'AUTH', 'secret', 'x-api-key', 'Password=', '--password ', '--token', 'accountkey=', '`', '\\"', ',', '(', ')', '{', '}', '[', ']', 'None', '$', '${', '<', '>', '=>', ':=', '==', '::', '%s',
  ]
  let x = 12345
  const next = (n: number) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return (x >>> 8) % n
  }
  let positives = 0
  const wrong: string[] = []
  for (let i = 0; i < 4000; i++) {
    const parts: string[] = []
    const n = 1 + next(10)
    for (let j = 0; j < n; j++) parts.push(next(5) === 0 ? fill(1 + next(60), next(1000), URLSAFE) : pool[next(pool.length)]!)
    const s = parts.join(next(3) === 0 ? ' ' : '')
    const masked = maskText(s)
    if (hasSecretShape(s) !== masked.count > 0) wrong.push(`shape disagrees: ${JSON.stringify(s).slice(0, 120)}`)
    if ((masked.text === s) !== (masked.count === 0)) wrong.push(`text and count disagree: ${JSON.stringify(s).slice(0, 120)}`)
    if (maskText(masked.text).count !== 0) wrong.push(`not idempotent: ${JSON.stringify(s).slice(0, 120)}`)
    if (masked.kinds.length > masked.count) wrong.push(`more kinds than hits: ${JSON.stringify(s).slice(0, 120)}`)
    if (masked.count > 0) positives++
  }
  expect(wrong.slice(0, 5)).toEqual([])
  expect(positives).toBeGreaterThan(1000)
  expect(positives).toBeLessThan(4000)
})
test('mask: 256 KB pathological texts for the setting, connection string, header and URL rules are linear', { timeoutMs: 120_000 }, () => {
  const units: [string, string][] = [
    ['password= repeated', 'password='], ['token: repeated', 'token:'], ['Password=; repeated', 'Password=;'], ['a:b/c@ repeated', 'a:b/c@'], ['://a:b/c@ repeated', '://a:b/c@'], ['x://u: repeated', 'x://u:'], ['://u:p/ repeated', '://u:p/'],
    ['digits and colons', '1234567890:'], ['digits colon letters', '1234567890:abcdefghijklmnopqrstuvwxyz0123456789 '], ['x-api-key: repeated', 'x-api-key: '], ['x-api-key blanks', 'x-api-key           '],
    ['--password repeated', '--password '], ['PASSWORD_ run', 'PASSWORD_'], ['token run', 'token'], ['"password": " repeated', '"password": "'], ['password=" repeated', 'password="'], ["password=' repeated", "password='"],
    ['password=` repeated', 'password=`'], ['escaped password repeated', '\\"password\\":\\"'], ['auth: repeated', 'auth: '], ['api_key= repeated', 'api_key='], ['key= repeated', 'key='], ['ya29. repeated', 'ya29.'], ['xapp- repeated', 'xapp-'],
    ['xapp-1- repeated', 'xapp-1-A'], ['sbp_ repeated', 'sbp_'], ['dop_v1_ repeated', 'dop_v1_'], ['pypi- header repeated', 'pypi-AgEIcHlwaS5vcmc'], ['AGE key head repeated', 'AGE-SECRET-KEY-1'], ['bot digits repeated', 'bot1234567890:'],
    ['SharedAccessKey= repeated', 'SharedAccessKey='], ['AccountKey=; repeated', 'AccountKey=;'], ['token: Bearer repeated', 'token: Bearer '], ['name and newline', 'password=\n'], ['name and blanks', 'password =   '],
    ['password with quote and name', 'password="a" password='], ['names glued', 'tokentokenpassword'], ['dots in names', 'a.b.c.password.'], ['password=a&b= repeated', 'password=a&b='], ['// then name', '//password:'],
    ['name colon colon', 'password::'], ['name double equals', 'token=='], ['long names', `${'a'.repeat(70)}password=`], ['flag then name', '--token --password '],
  ]
  const slow: string[] = []
  for (const [name, unit] of units) {
    const text = big(unit, 256_000)
    const run = timed(() => maskText(text))
    const probe = timed(() => hasSecretShape(text))
    if (run.ms > 2500 || probe.ms > 2500) slow.push(`${name}: ${run.ms} ms and ${probe.ms} ms`)
    if (probe.result !== run.result.count > 0) slow.push(`${name}: hasSecretShape disagrees`)
  }
  expect(slow).toEqual([])
})

test('mask: one huge value, a huge connection string and a huge URL password are masked whole, in time', { timeoutMs: 60_000 }, () => {
  const huge = fill(500_000, 480, URLSAFE)
  const checks: [string, string, string][] = [
    [`password=${huge} next`, 'password=•••• masked next', 'setting'], [`password="${huge}" next`, 'password="•••• masked" next', 'quoted'],
    [`Server=x;Password=${huge};Trust=1`, 'Server=x;Password=•••• masked;Trust=1', 'connection'], [`x-api-key: ${huge}\n`, 'x-api-key: •••• masked\n', 'header'],
    [`postgres://u:${huge.replace(/_/g, 'a')}/x@h/db`, 'postgres://u:•••• masked@h/db', 'url slash'],
  ]
  for (const [input, expected, name] of checks) {
    const run = timed(() => maskText(input))
    expect(run.result.text.length, name).toBeLessThan(200)
    expect(run.result.text, name).toBe(expected)
    expect(run.ms, name).toBeLessThan(2000)
  }
})

test('mask: a quoted value with no closing quote on the line is read as a word, and a line of them stays linear', { timeoutMs: 60_000 }, () => {
  const unclosed = `password="${'ab '.repeat(100_000)}`
  const run = timed(() => maskText(unclosed))
  expect(run.result.text.startsWith('password="•••• masked ab')).toBe(true)
  expect(run.ms).toBeLessThan(2000)
  const many = `${'token="a b\n'.repeat(50_000)}`
  const manyRun = timed(() => maskText(many))
  expect(manyRun.result.count).toBe(50_000)
  expect(manyRun.ms).toBeLessThan(2000)
})

test('mask: random mixtures of names, separators, values and glue are consistent and idempotent (no quotes), 3000 strings', () => {
  const names = ['password', 'token', 'api_key', 'Password', 'AUTH', 'x-api-key', 'accountkey', '--password', 'PWD', 'secret', 'DB_PASSWORD', 'apiKey', 'auth_token', 'max_tokens', 'author', 'credentials', 'Server', 'a', 'x.y', 'sharedaccesskey', 'private_key']
  const seps = ['=', ': ', ' = ', '=>', ' => ', ':=', ':', '==', '::', ' ', '= ', ':  ', '=\n']
  const vals = [
    'hunter2', 'abc.def', 'process.env.X', 'None', '${X}', '12345', 'true', 'Bearer abc', '•••• masked', 'https://h/x', '/home/x', 'string', 'foo(', 'a;b', '', 'a b c', 'x&y=1', 'a,b', 'a.', 'k=v', 'Basic dXNlcg==',
    'postgres://u:p/q@h/d', `${pem.begin('PRIVATE KEY')} ${fill(30, 495, B64)} ${pem.end('PRIVATE KEY')}`, 'ya29.', 'a', '$1', '<x>', '[x]', '{x}',
  ]
  const glue = [' ', '\n', ',', ';', '&', '', '.', '\r\n', '\t', '?', '#', '/', '//', '://', '@']
  let x = 4242
  const next = (n: number) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return (x >>> 8) % n
  }
  const wrong: string[] = []
  let positives = 0
  for (let i = 0; i < 3000; i++) {
    let s = ''
    for (let j = 1 + next(6); j > 0; j--) s += names[next(names.length)]! + seps[next(seps.length)]! + vals[next(vals.length)]! + glue[next(glue.length)]!
    const out = maskText(s)
    if (hasSecretShape(s) !== out.count > 0 || (out.text === s) !== (out.count === 0) || maskText(out.text).count !== 0) wrong.push(JSON.stringify(s).slice(0, 120))
    if (out.count > 0) positives++
  }
  expect(wrong.slice(0, 5)).toEqual([])
  expect(positives).toBeGreaterThan(1000)
  expect(positives).toBeLessThan(3000)
})
