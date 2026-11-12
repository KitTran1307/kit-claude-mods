/** One task as the plugin shows it: an entry of the todos file that has an id and text. */
export type Todo = {
  id: string
  text: string
  /** What Claude needs to do the task; sent with "Do it now" / "Draft". */
  note?: string
  /** The project (repository folder name) the task belongs to; no project means it shows everywhere. */
  project?: string
  /** The repository's stable key (see repoKeyOf); when set, the task shows only in that repository. */
  repo?: string
  /** YYYY-MM-DD */
  due?: string
  done: boolean
  /** ISO time the task was marked done; done tasks stay visible for 24 hours. */
  doneAt?: string
  /** Position of the entry in the todos file, so "done" marks this entry even when ids repeat. Not part of the file. */
  index: number
}
/** One line of the numbered /todo list: the entry it named and its text. */
export type Shown = { id: string; index: number; text: string }
/** A task Claude proposed with propose_todo that waits for the person; saved only when they add it. Held in the session, not in the file. */
export type Suggestion = {
  id: string
  /** One line, 200 characters at most, cleaned of hidden characters: exactly what the card shows and Add saves. */
  text: string
  /** A real YYYY-MM-DD day. */
  due?: string
  /** One line, 300 characters at most. */
  note?: string
}
export type Memory = { title: string; hook: string; file: string; mtimeMs: number }
export type Snapshot = {
  todos: Todo[]
  memories: Memory[]
  project: string
  /** This session's repository key (see repoKeyOf). */
  repo?: string
  loadedAt: number
  /** Why the todos file could not be read, or null. Shown in the pane and by /todo. */
  problem: string | null
}

declare module 'claude-code' {
  /** The model tool Claude proposes a task with (registered at session start unless allowSuggestions is off). */
  interface McpToolInputs {
    'mcp__kit-todos__propose_todo': { text: string; due?: string; note?: string }
  }
  interface PluginState {
    'kit-todos': {
      hiddenDay: string | null
      snapshot: Shaped<Snapshot | null>
      /** The numbered list the last /todo printed in this session, so /todo done <n> marks what was seen. */
      shown: Shown[] | null
      /** Open tasks the pane draws; "Show more" raises it. */
      paneLimit: number
      /** Tasks Claude proposed that the person has not added or dismissed yet (10 at most). */
      suggestions: Suggestion[]
      /** Ids of the suggestions the last /todo suggestions printed, so /todo accept <n> adds what was seen. */
      suggestionsShown: string[] | null
    }
  }
}
