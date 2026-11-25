import { expect, test } from 'claude-code/testing'

import { hasSecretShape, maskDeep, maskText } from './mask'
import { MARK, URLSAFE, B64, fill, TOKENS, pem, big, timed } from '../tests/mask-helpers'

// Big and pathological inputs for the masker's private-key and token rules: linear time, still correct, never a throw.

test('maskDeep: a string over 20 MB is returned unchanged (masking it would stall the session), one under is masked', () => {
  const key = TOKENS[0]!
  const huge = `${'a '.repeat(10_000_001)}${key.value}`
  expect(huge.length).toBeGreaterThan(20_000_000)
  const out = maskDeep({ t: huge })
  expect(out.value.t).toBe(huge)
  expect(out.count).toBe(0)
  const under = maskDeep({ t: `${'a '.repeat(1_000_000)}${key.value}` })
  expect(under.count).toBe(1)
  expect(under.value.t.endsWith('sk-ant-•••• masked')).toBe(true)
})

// --- performance and safety -------------------------------------------------------------------------------------------

test('mask: a 1 MB text finishes well under a second, with and without a secret in it', { timeoutMs: 30_000 }, () => {
  const line = 'GET /api/v1/orders?page=2&limit=50 200 12ms user=ana@acme-shop.vn sha=3f2504e04f8941d39a0c0305e82c3301 ✓\n'
  const plain = big(line, 1_000_000)
  const clean = timed(() => maskText(plain))
  expect(clean.result.count).toBe(0)
  expect(clean.result.text).toBe(plain)
  expect(clean.ms).toBeLessThan(1000)
  const probe = timed(() => hasSecretShape(plain))
  expect(probe.result).toBe(false)
  expect(probe.ms).toBeLessThan(1000)
  const withKey = `${plain}${TOKENS[0]!.value}\n`
  const dirty = timed(() => maskText(withKey))
  expect(dirty.result.count).toBe(1)
  expect(dirty.result.text.endsWith('sk-ant-•••• masked\n')).toBe(true)
  expect(dirty.ms).toBeLessThan(1000)
  expect(timed(() => hasSecretShape(withKey)).result).toBe(true)
})

test('mask: pathological 512 KB texts are linear, not quadratic', { timeoutMs: 60_000 }, () => {
  const units = [
    ['BEGIN repeated', pem.begin('PRIVATE KEY')], ['BEGIN lines', `${pem.begin('PRIVATE KEY')}\n`], ['BEGIN header-like', `${pem.begin('PRIVATE KEY')}\nA: `], ['sk- repeated', 'sk-'], ['sk-ant- repeated', 'sk-ant-'], ['eyJ. repeated', 'eyJ.'],
    ['eyJ run', 'eyJ'], ['eyJ- run', 'eyJaaaaa-'], ['a: repeated', 'a:'], ['a:// repeated', 'a://'], ['://a: repeated', '://a:'], ['://: repeated', '://:'], ['@ repeated', '@'], ['? repeated', '?'], ['&token= repeated', '&token='],
    ['?token= repeated', '?token='], ['Authorization repeated', 'Authorization: Bearer '], ['authorization spaces', 'authorization    '], ['aws name repeated', 'aws_secret_access_key='], ['secret= repeated', 'secret='], ['AKIA repeated', 'AKIA'],
    ['SG. repeated', 'SG.'], ['ghp_ repeated', 'ghp_'], ['xoxb- repeated', 'xoxb-'], ['one letter', 'a'], ['dashes', '-'], ['newlines', '\n'], ['bullets', '•'],
    ['BEGIN literal repeated', '-----BEGIN '], ['END literal repeated', '-----END '], ['END lines repeated', `${pem.end('PRIVATE KEY')}\n`], ['BEGIN and END pairs', `${pem.begin('PRIVATE KEY')}\n${pem.end('PRIVATE KEY')}\n`],
    ['BEGIN and foreign END', `${pem.begin('RSA PRIVATE KEY')}\n${pem.end('EC PRIVATE KEY')}\n`],
  ]
  for (const [name, unit] of units) {
    const text = big(unit as string, 512_000)
    const run = timed(() => maskText(text))
    expect(run.ms, name).toBeLessThan(2000)
    const probe = timed(() => hasSecretShape(text))
    expect(probe.ms, name).toBeLessThan(2000)
    expect(probe.result, name).toBe(run.result.count > 0)
  }
})

test('mask: many secrets in one large text are all masked, in time', { timeoutMs: 30_000 }, () => {
  const key = TOKENS[0]!
  const text = `before ${key.value} after\n`.repeat(60_000)
  const run = timed(() => maskText(text))
  expect(run.result.count).toBe(60_000)
  expect(run.result.text).toBe('before sk-ant-•••• masked after\n'.repeat(60_000))
  expect(run.ms).toBeLessThan(2000)
  expect(JSON.stringify(run.result.kinds)).toBe('["anthropic-key"]')
})

test('mask: a huge key body and a huge PEM block are masked whole', { timeoutMs: 30_000 }, () => {
  const label = 'PRIVATE KEY'
  const body = big(`${fill(64, 320, B64)}\n`, 1_000_000)
  const block = `${pem.begin(label)}\n${body}${pem.end(label)}\ntail`
  const run = timed(() => maskText(block))
  expect(run.result.text).toBe(`${pem.begin(label)}\n${MARK}\n${pem.end(label)}\ntail`)
  expect(run.ms).toBeLessThan(2000)
  const longKey = `sk-${fill(1_000_000, 321, URLSAFE)}`
  const keyRun = timed(() => maskText(`k=${longKey} tail`))
  expect(keyRun.result.text).toBe('k=sk-•••• masked tail')
  expect(keyRun.ms).toBeLessThan(2000)
})

/** BEGIN lines whose labels are all different (`A000001 B000001`), none with an END line of its own; optionally an END line of yet another label after each. */
function distinctBegins(size: number, withEnds = false): string {
  const parts: string[] = []
  let length = 0
  for (let i = 0; length < size; i++) {
    const n = String(i).padStart(6, '0')
    const line = `${pem.begin(`A${n} B${n} PRIVATE KEY`)}\n${withEnds ? `${pem.end(`C${n} D${n} PRIVATE KEY`)}\n` : ''}`
    parts.push(line)
    length += line.length
  }
  return parts.join('')
}

test('mask: BEGIN lines with many different labels and no END are scanned in linear time', { timeoutMs: 60_000 }, () => {
  // A search from every BEGIN line to the end of the text took 0.26 s at 152 KB, 3.7 s at 608 KB and 14.5 s at 1.2 MB.
  const problems: string[] = []
  for (const size of [152_000, 608_000, 1_200_000]) {
    for (const withEnds of [false, true]) {
      const text = distinctBegins(size, withEnds)
      const run = timed(() => maskText(text))
      const probe = timed(() => hasSecretShape(text))
      if (run.result.text !== text || run.result.count !== 0 || probe.result) problems.push(`${size} ${withEnds}: changed or found`)
      if (run.ms > 1000 || probe.ms > 1000) problems.push(`${size} ${withEnds}: ${run.ms} ms and ${probe.ms} ms`)
    }
  }
  expect(problems).toEqual([])
})

test('mask: after many unrelated BEGIN lines a whole key and a cut-off key are still found and masked', { timeoutMs: 30_000 }, () => {
  const noise = distinctBegins(600_000, true)
  const tail = distinctBegins(10_000)
  const whole = (body: string) => `${pem.begin('PRIVATE KEY')}\n${body}\n${pem.end('PRIVATE KEY')}\n`
  const cutOff = (body: string) => `${pem.begin('EC PRIVATE KEY')}\n${body}\n`
  const bodyA = pem.body(2, 420)
  const bodyB = pem.body(2, 430)
  const text = `${noise}${whole(bodyA)}${tail}${cutOff(bodyB)}`
  const run = timed(() => maskText(text))
  expect(run.result.count).toBe(2)
  expect(run.result.kinds).toEqual(['private-key'])
  expect(run.result.text).toBe(`${noise}${whole(MARK)}${tail}${cutOff(MARK)}`)
  expect(JSON.stringify(run.result)).not.toContain(bodyA.split('\n')[0]!)
  expect(JSON.stringify(run.result)).not.toContain(bodyB.split('\n')[0]!)
  expect(run.ms).toBeLessThan(1000)
  expect(hasSecretShape(text)).toBe(true)
  // the same pair with a matching END found far away: the first BEGIN of a label closes at that END
  const far = `${pem.begin('Z PRIVATE KEY')}\n${bodyA}\n${distinctBegins(600_000, true)}${pem.end('Z PRIVATE KEY')}\nafter`
  const farRun = timed(() => maskText(far))
  expect(farRun.result.text).toBe(`${pem.begin('Z PRIVATE KEY')}\n${MARK}\n${pem.end('Z PRIVATE KEY')}\nafter`)
  expect(farRun.ms).toBeLessThan(1000)
})

test('mask: a BEGIN line followed by a megabyte of END lines or END markers stays linear', { timeoutMs: 60_000 }, () => {
  const cases: [string, string][] = [
    ['other END lines', `${pem.begin('PRIVATE KEY')}\n${big(`${pem.end('EC PRIVATE KEY')}\n`)}`],
    ['END markers', `${pem.begin('PRIVATE KEY')}\n${big('-----END ')}`],
    ['END markers, glued', `${pem.begin('PRIVATE KEY')}\n${big('-----END -----END PRIVATE KEY')}`],
    ['own END lines', `${pem.begin('PRIVATE KEY')}\n${big(`${pem.end('PRIVATE KEY')}\n`)}`],
  ]
  const problems: string[] = []
  for (const [name, text] of cases) {
    const run = timed(() => maskText(text))
    const probe = timed(() => hasSecretShape(text))
    if (run.result.count !== 0 || run.result.text !== text || probe.result) problems.push(`${name}: changed or found`)
    if (run.ms > 2000 || probe.ms > 2000) problems.push(`${name}: ${run.ms} ms and ${probe.ms} ms`)
  }
  expect(problems).toEqual([])
})
