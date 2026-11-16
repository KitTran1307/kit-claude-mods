// kit-todos MCP relay (server.mjs runs it): gives Claude the propose_todo tool without a tool.call hook, so the plugin also works in
// Code Mode (which refuses mods whose hooks check tool calls).
//
// Claude Code starts one copy of this server per session. A proposal waits here until the kit-todos band, polling
// relay_suggestions every second, takes it, checks it and answers it; that answer is what Claude reads. Nothing is
// written to disk: proposals live in this process's memory only, as before.
//
// Plain Node (18+), no dependencies: newline-delimited JSON-RPC 2.0 over stdio.

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

// Keep in step with SUGGESTION_TEXT_MAX / SUGGESTION_NOTE_MAX in hooks/data.ts (the band checks them again).
const TEXT_MAX = 200
const NOTE_MAX = 300
/** How long a proposal waits for the band before Claude is told it was not picked up. */
export const WAIT_MS = Number(process.env.KIT_TODOS_WAIT_MS) > 0 ? Number(process.env.KIT_TODOS_WAIT_MS) : 20_000
/** The allowSuggestions option as plugin.json hands it over: only an explicit false turns suggestions off. */
export const enabledFrom = (value) => String(value ?? 'true').trim().toLowerCase() !== 'false'
const ENABLED = enabledFrom(process.env.KIT_TODOS_SUGGEST)

export const PROPOSE_TOOL = {
  name: 'propose_todo',
  description: [
    `Propose one follow-up task for the person's to-do list. Use it for work you found but are not doing now: it is out of scope, too large, or needs the person's decision.`,
    'Call it once per task. Never use it for work you are about to do in this session.',
    'Nothing is saved by this call: the person sees the task on a card and must approve it before it is written to their list.',
    `text is one short line (${TEXT_MAX} characters at most); due (YYYY-MM-DD) and note (${NOTE_MAX} characters at most, detail for whoever does the task) are optional.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: TEXT_MAX, description: 'The task, in one short line.' },
      due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional due day, YYYY-MM-DD.' },
      note: { type: 'string', maxLength: NOTE_MAX, description: 'Optional detail for whoever does the task.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
}
export const RELAY_TOOL = {
  name: 'relay_suggestions',
  description: 'Internal to the kit-todos to-do band, which calls it by itself every second. Never call it: it does nothing useful for you.',
  inputSchema: {
    type: 'object',
    properties: {
      settled: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, result: { type: 'string' }, deny: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    additionalProperties: false,
  },
}
export const NOT_PICKED_UP = 'The to-do band did not pick this suggestion up (kit-todos is not running in this session). Mention the follow-up in your final message instead.'

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })

/** The relay between Claude's propose_todo calls and the band; one per server process. */
export function createRelay({ waitMs = WAIT_MS } = {}) {
  /** Proposals the band has not taken yet, in arrival order. */
  const queue = []
  /** Proposals taken by the band and waiting for its answer, by id. */
  const waiting = new Map()

  function propose(input) {
    return new Promise((resolve) => {
      const id = randomUUID()
      const entry = { id, input: input && typeof input === 'object' ? input : {}, resolve }
      entry.timer = setTimeout(() => {
        const i = queue.indexOf(entry)
        if (i >= 0) queue.splice(i, 1)
        waiting.delete(id)
        resolve(text(NOT_PICKED_UP, true))
      }, waitMs)
      entry.timer.unref?.()
      queue.push(entry)
    })
  }

  function relay(args) {
    const settled = Array.isArray(args?.settled) ? args.settled : []
    for (const s of settled) {
      const entry = waiting.get(String(s?.id))
      if (!entry) continue
      waiting.delete(entry.id)
      clearTimeout(entry.timer)
      entry.resolve(typeof s.deny === 'string' ? text(s.deny, true) : text(String(s.result ?? '')))
    }
    const taken = queue.splice(0)
    for (const entry of taken) waiting.set(entry.id, entry)
    return text(JSON.stringify({ proposals: taken.map(e => ({ id: e.id, input: e.input })) }))
  }

  return { propose, relay, pending: () => queue.length + waiting.size }
}

/** Answers one JSON-RPC message; resolves the response object, or null for a notification. */
export async function handle(msg, relay, enabled = ENABLED) {
  const { id, method, params } = msg ?? {}
  const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result })
  const fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } })
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kit-todos', version: '1.5.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: enabled ? [PROPOSE_TOOL, RELAY_TOOL] : [] })
    case 'tools/call': {
      const name = params?.name
      if (!enabled) return reply(text('Suggestions are turned off in kit-todos (allowSuggestions).', true))
      if (name === PROPOSE_TOOL.name) return reply(await relay.propose(params?.arguments))
      if (name === RELAY_TOOL.name) return reply(relay.relay(params?.arguments))
      return fail(-32602, `Unknown tool: ${String(name)}`)
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return null
      return fail(-32601, `Method not found: ${String(method)}`)
  }
}

/** Serves the relay over stdio until Claude Code closes the pipe. */
export function serve() {
  const relay = createRelay()
  const send = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj) + '\n') }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
    handle(msg, relay).then(send, (err) => send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } }))
  })
  lines.on('close', () => process.exit(0))
}
