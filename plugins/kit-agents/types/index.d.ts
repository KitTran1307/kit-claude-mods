/** Where a subagent stands for the board: it works, it is held (waiting), or it has not started its first turn. */
export type AgentState = 'running' | 'waiting' | 'starting'
/** One subagent as the board shows it, cleaned from what `$.agent.list()` gives. A field the engine does not give is left out. */
export type BoardAgent = {
  id: string
  /** What the agent is called: its name, else its type, else a short id. One line. */
  name: string
  /** The agent type (`Explore`, `general-purpose`); empty when unknown. One line. */
  type: string
  /** The model as the person reads it ("Sonnet 4.5"); absent when the engine does not say. */
  model?: string
  state: AgentState
  /** What it is doing now: one line, cleaned of hidden characters; empty when there is none. */
  label: string
  /** When it started, in milliseconds since the epoch; absent when unknown. */
  startTime?: number
  /** Share of its context window used, 0 to 100; absent when the window is unknown. */
  pct?: number
}
/** The agents the last refresh found running, and when. The board draws from it. */
export type Board = { agents: BoardAgent[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'kit-agents': {
      board: Shaped<Board | null>
    }
  }
}
