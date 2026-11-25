/** What a waiting confirmation says about one risk (a call can carry several). Plain data: the band words it, in the person's language. */
export type RiskView = {
  kind: 'delete' | 'overwrite' | 'force-push' | 'reset-hard' | 'clean' | 'discard' | 'branch-delete' | 'db-drop' | 'unparsed' | 'git-erase'
  /** The command words for the dim part of the band (`rm -rf`, `git push --force`). No secrets. */
  label: string
  /** The branch, database or table the call names, when it names one. */
  name?: string
  /** The git remote of a force push, without credentials. */
  remote?: string
  /** How many more branches the call names besides `name` (`git branch -D a b c`: 2). */
  extra?: number
  /** The files are chosen at run time by a filter (`find ... -delete`): say so instead of naming the folder. */
  picks?: true
  /** With `picks`: the name pattern the filter looks for (`node_modules`), so the words can say what is deleted. */
  match?: string
  /** Up to 3 project-relative paths the call would touch (a folder ends with `/`). */
  paths: string[]
  /** How many paths there were in all. */
  count: number
}

/** What happened to the snapshot taken before the call. */
export type SnapshotView =
  | { state: 'saved'; id: string; n: number; at: number; files: number; bytes: number; isPartial: boolean; hasGit: boolean; /** Git state was asked for but the uncommitted changes could not be saved (an unfinished merge, a time-out). */ isGitPartial?: true }
  /** Nothing in the project to copy (a database, a remote branch); `hasGit` when a Git snapshot was recorded. */
  | { state: 'none'; hasGit: boolean }
  /** More than the size limit (`limitMB`), or than the file-count limit (`byFiles`): not saved. */
  | { state: 'too-big'; limitMB: number; byFiles?: true; /** The file limit when it is lower than the default (a quiet cleanup uses a small one). */ limitFiles?: number }
  | { state: 'failed' }
  /** Only a `.env`-like file was to be saved and Node.js is not there to keep its copy private: not saved. */
  | { state: 'needs-node' }

/** One confirmation waiting for the person. */
export type Pending = {
  /** The tool call's id: what Allow and Cancel answer. */
  id: string
  /** When the question was raised (ms since 1970). */
  at: number
  tool: string
  risks: RiskView[]
  snapshot: SnapshotView
  /** For an overwrite of a `.env`-like file: which variable names the new file loses or adds (names only, never values). */
  env?: { before: number; after: number; removed: string[]; added: string[] }
  /** A subagent made the call. */
  isAgent?: boolean
  /** The call deletes the project's own `.git` folder too: a snapshot never holds it, so unpushed commits, branches and stashes cannot come back. The band says so. */
  gitLost?: true
  /** How many other commands the same command line holds besides the flagged ones (`rm -rf build && curl ... | sh`: 1 or more). */
  others?: number
  /** For a command Safety Net could not read to the end (`unparsed`): the first 120 characters, secrets masked, so the person can read what is asked. */
  snippet?: string
}

declare module 'claude-code' {
  interface PluginState {
    'kit-safety': {
      /** Questions waiting for the person, oldest first; the band shows the first. */
      pending: Pending[]
      /** The id of the question whose details (variable names) are open, or null. */
      detail: string | null
    }
  }
}
