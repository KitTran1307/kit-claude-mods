/** One prompt waiting in the queue. */
export type QueueItem = {
  id: string
  /** The prompt exactly as it will be sent (trimmed, 4000 characters at most). */
  text: string
}
/** Something that happened while the person was away. */
export type AwayEvent = {
  id: string
  kind: 'done' | 'question'
  /** Epoch milliseconds. */
  at: number
  /** One short line: the start of Claude's answer, or what it asked. */
  text: string
}
/** The welcome-back card the person has not dismissed. */
export type AwayCard = {
  /** Epoch milliseconds of the person's last typing or sending, and of their return. */
  from: number
  to: number
  /** Finished turns and questions still waiting, oldest first. */
  events: AwayEvent[]
}

declare module 'claude-code' {
  interface PluginState {
    'kit-notify': {
      queue: QueueItem[]
      /** The queue is held: nothing is sent until the person resumes it. */
      isPaused: boolean
      /** A turn of the main conversation is running. */
      isRunning: boolean
      /** The prompt box holds text (only where the surface reports edits): the idle queue row shows then. */
      hasDraft: boolean
      card: AwayCard | null
    }
  }
}
