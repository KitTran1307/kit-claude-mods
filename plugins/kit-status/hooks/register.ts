import type { EngineInterface, Register } from 'claude-code'

export type Status = 'run' | 'wait' | 'ask' | 'done'
const DOT: Record<Status, string> = { run: '🔵', wait: '⏳', ask: '🟠', done: '✅' }
const SERVER = 'ccd_session_mgmt'
// A background shell nobody heard back from in this long no longer counts.
const STALE_MS = 2 * 60 * 60 * 1000
// Subagent states that will still wake the session.
const LIVE = new Set(['pending', 'running', 'waiting'])

// Strip a dot this mod put there earlier, so a title carries at most one.
export function withDot(title: string, status: Status): string {
  const bare = title.replace(/^(🔵|⏳|🟠|✅)\s*/u, '')
  return `${DOT[status]} ${bare}`
}

// A reply that ends on a question waits on the person.
export function endsOnQuestion(text: string): boolean {
  return text.trim().slice(-300).includes('?')
}

export function isBackgroundShell(e: { tool: string; run_in_background?: unknown }): boolean {
  return e.tool === 'Bash' && e.run_in_background === true
}

// The task id a background Bash call answers with, as its notification names it later.
export function taskIdOf(result: unknown): string | undefined {
  return /with ID: ([A-Za-z0-9_-]+)/.exec(JSON.stringify(result ?? ''))?.[1]
}

// The task ids a turn's text reports as finished.
export function finishedIn(text: string): string[] {
  return [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1] ?? '')
}

export function statusAtEnd(asked: boolean, answer: string, background: number): Status {
  if (asked || endsOnQuestion(answer)) return 'ask'
  return background > 0 ? 'wait' : 'done'
}

let last: Status | undefined
let offline = false

async function mark($: EngineInterface, status: Status) {
  if (offline || status === last) return
  try {
    const got = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
    const text = got.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    const title = (JSON.parse(text) as { title?: string }).title
    if (got.isError || !title) return
    const next = withDot(title, status)
    if (next !== title) {
      const set = await $.mcp.call(SERVER, 'set_session_title', { session_id: 'self', title: next })
      // Declined (a title the person set, outside bypass mode): stop asking for this session.
      if (set.isError) {
        offline = true
        return
      }
    }
    last = status
  } catch {
    // Not in the desktop app (terminal, cloud): nothing to color.
    offline = true
  }
}

async function liveAgents($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => LIVE.has(a.status)).length
  } catch {
    return 0
  }
}

let asked = false
let mainTurn: string | undefined
// Background shells still running: task id to when it started.
const shells = new Map<string, number>()

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      asked = false
      mainTurn = e.turnId
      for (const id of finishedIn(e.text)) shells.delete(id)
      await mark($, 'run')
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.tool === 'AskUserQuestion') {
      await mark($, 'ask')
      try {
        return await next(e)
      } finally {
        await mark($, 'run')
      }
    }
    if (isBackgroundShell(e as { tool: string; run_in_background?: unknown })) {
      const out = await next(e)
      const at = await $.clock.now()
      shells.set(taskIdOf(out) ?? `unknown-${at}`, at)
      return out
    }
    if (e.tool === 'mcp__ccd_turn__wrap_up' && typeof (e as { ask?: unknown }).ask === 'string') asked = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.turnId === mainTurn) {
      const now = await $.clock.now()
      for (const [id, at] of shells) if (now - at > STALE_MS) shells.delete(id)
      await mark($, statusAtEnd(asked, out.text, shells.size + (await liveAgents($))))
    }
    return out
  })
}
