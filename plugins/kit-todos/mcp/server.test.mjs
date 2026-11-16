// node --test plugins/kit-todos/mcp/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createRelay, enabledFrom, handle, NOT_PICKED_UP, PROPOSE_TOOL, RELAY_TOOL } from './relay.mjs'

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))

/** Starts the real server over stdio; `call` sends one request and resolves its response. */
function start(env = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  let buf = ''
  let next = 1
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  const call = (method, params) => new Promise((resolve) => {
    const id = next++
    waiting.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  const stop = () => new Promise((resolve) => { child.on('exit', resolve); child.stdin.end() })
  return { call, notify, stop }
}

const relayed = (res) => JSON.parse(res.result.content[0].text).proposals

test('the server starts, lists propose_todo and the internal relay, and exits when the pipe closes', async () => {
  const s = start()
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  s.notify('notifications/initialized')
  const list = await s.call('tools/list', {})
  assert.deepEqual(list.result.tools.map(t => t.name), ['propose_todo', 'relay_suggestions'])
  const propose = list.result.tools[0]
  assert.match(propose.description, /not doing now/)
  assert.match(propose.description, /must approve/)
  assert.deepEqual(propose.inputSchema.required, ['text'])
  assert.equal(propose.inputSchema.properties.text.maxLength, 200)
  assert.match(list.result.tools[1].description, /Never call it/)
  assert.equal((await s.call('nope', {})).error.code, -32601)
  assert.equal(await s.stop(), 0)
})

test('a proposal waits for the band; Claude reads the answer the band gives', async () => {
  const s = start()
  await s.call('initialize', {})
  const pending = s.call('tools/call', { name: 'propose_todo', arguments: { text: 'Rotate the keys', due: '2026-12-01' } })
  // The band polls: it takes the proposal, then answers it on its next call.
  let taken = []
  for (let i = 0; i < 50 && taken.length === 0; i++) taken = relayed(await s.call('tools/call', { name: 'relay_suggestions', arguments: {} }))
  assert.equal(taken.length, 1)
  assert.deepEqual(taken[0].input, { text: 'Rotate the keys', due: '2026-12-01' })
  const again = await s.call('tools/call', { name: 'relay_suggestions', arguments: { settled: [{ id: taken[0].id, result: 'Proposed to the person.' }] } })
  assert.deepEqual(relayed(again), []) // taken once, never handed out twice
  const out = await pending
  assert.deepEqual(out.result, { content: [{ type: 'text', text: 'Proposed to the person.' }], isError: false })
  await s.stop()
})

test('a refusal from the band reaches Claude as an error with its reason', async () => {
  const relay = createRelay({ waitMs: 5_000 })
  const pending = relay.propose({ text: 'x'.repeat(300) })
  const [p] = JSON.parse(relay.relay({}).content[0].text).proposals
  relay.relay({ settled: [{ id: p.id, deny: 'text is 300 characters; the limit is 200.' }] })
  assert.deepEqual(await pending, { content: [{ type: 'text', text: 'text is 300 characters; the limit is 200.' }], isError: true })
  assert.equal(relay.pending(), 0)
})

test('with no band to pick it up, Claude is told so after the wait instead of being told it was proposed', async () => {
  const s = start({ KIT_TODOS_WAIT_MS: '200' })
  await s.call('initialize', {})
  const out = await s.call('tools/call', { name: 'propose_todo', arguments: { text: 'Nobody listens' } })
  assert.equal(out.result.isError, true)
  assert.equal(out.result.content[0].text, NOT_PICKED_UP)
  // A late band finds nothing: the proposal is gone, not shown after Claude was told it failed.
  assert.deepEqual(relayed(await s.call('tools/call', { name: 'relay_suggestions', arguments: {} })), [])
  await s.stop()
})

test('a taken proposal the band never answers also ends after the wait, and a late answer is ignored', async () => {
  const relay = createRelay({ waitMs: 100 })
  const pending = relay.propose({ text: 'Taken then lost' })
  const [p] = JSON.parse(relay.relay({}).content[0].text).proposals
  assert.equal((await pending).content[0].text, NOT_PICKED_UP)
  relay.relay({ settled: [{ id: p.id, result: 'late' }] })
  assert.equal(relay.pending(), 0)
})

test('allowSuggestions false: no tools listed, and a call is refused', async () => {
  const s = start({ KIT_TODOS_SUGGEST: 'false' })
  await s.call('initialize', {})
  assert.deepEqual((await s.call('tools/list', {})).result.tools, [])
  const out = await s.call('tools/call', { name: 'propose_todo', arguments: { text: 'x' } })
  assert.equal(out.result.isError, true)
  await s.stop()
})

test('only an explicit false turns suggestions off; a missing or unsubstituted option leaves them on', async () => {
  for (const value of [undefined, '', '${user_config.allowSuggestions}', 'true', 'TRUE']) assert.equal(enabledFrom(value), true)
  for (const value of ['false', ' FALSE ', false]) assert.equal(enabledFrom(value), false)
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, createRelay(), true)
  assert.deepEqual(list.result.tools.map(t => t.name), [PROPOSE_TOOL.name, RELAY_TOOL.name])
})
