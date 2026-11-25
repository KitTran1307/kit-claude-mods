// Types shared by the pure modules (risk.ts, mask.ts, snapshot.ts, vault.ts) and the hooks module. No code here.

/**
 * What kind of danger a call carries. The kind picks the plain-language sentence (i18n.ts) and the snapshot:
 * - delete: `rm -r`, `Remove-Item -Recurse`, `rmdir /s`: files and folders under `paths` would be deleted.
 * - overwrite: an existing file in `paths` would be replaced (Write/Edit, or `cp`/`mv`/`>` onto a `.env`-like file).
 * - force-push: `git push --force` / `-f` / `--mirror` / `+branch` (not `--force-with-lease`, which refuses to overwrite unseen work): history on `remote` would be rewritten.
 * - reset-hard: `git reset --hard`: uncommitted changes would be thrown away.
 * - clean: `git clean -f`: files git does not track would be deleted.
 * - discard: `git checkout -- .`, `git checkout .`, `git restore .`: uncommitted changes would be thrown away.
 * - branch-delete: `git branch -D`: branch `name` would be deleted even if not merged.
 * - db-drop: a database, schema or table would be dropped or reset through a command-line tool.
 * - unparsed: the command is too long or too tangled to read to the end (a parser limit tripped); something dangerous could be
 *   hiding in the part that was not read, so it is asked about like any risk. It carries no files.
 * - git-erase: Git's own safety nets would be emptied: `git stash drop|clear`, `git update-ref -d`, `git reflog expire` with
 *   `now`, `git gc --prune=now`. It carries no files; the label says which.
 */
export type RiskKind = 'delete' | 'overwrite' | 'force-push' | 'reset-hard' | 'clean' | 'discard' | 'branch-delete' | 'db-drop' | 'unparsed' | 'git-erase'

/** How firmly a risk is confirmed: `ask` = a confirmation under confirm=risky; `snapshot` = only saved quietly unless confirm=always. */
export type RiskTier = 'ask' | 'snapshot'

export type Risk = {
  kind: RiskKind
  tier: RiskTier
  /**
   * The words for the dim part of the band, no secrets and at most 40 characters: `rm -rf`, `git push --force`,
   * `cp .env.example`, `Write`. Built from the command's own program name and flags, never from its arguments' values
   * (except a file name).
   */
  label: string
  /**
   * Paths the call would delete or overwrite, as written in the command (relative, with `~`, with wildcards), for the
   * snapshot planner to resolve. Empty for kinds with no files of their own.
   */
  paths: string[]
  /** A path in the command that could not be read from its spelling (`rm -rf "$DIR"`): the target is unknown. */
  hasUnknownPath?: boolean
  /** git: the branch (`branch-delete`, `force-push`) or the database/table/schema name (`db-drop`), as written. */
  name?: string
  /** Every branch the call names (`git branch -D a b c`, `git push --force origin dev main`): `name` is the first. At most 20. */
  names?: string[]
  /**
   * A `delete` whose files are chosen at run time by a filter (`find . -name '*.pyc' -delete`): `paths` still names where it
   * looks, and the snapshot covers it, but the words must not say "everything in this folder".
   */
  picks?: true
  /** With `picks`: the first name pattern the filter holds (`-name node_modules` gives `node_modules`), at most 60 characters, quotes removed. */
  match?: string
  /** git `force-push`: the remote name when the command names one. */
  remote?: string
  /** `overwrite` through `cp`/`mv`: the source file, so the new content can be compared with the old. */
  source?: string
}

/** The options of the plugin, read once per load (register.tsx). */
export type Confirm = 'risky' | 'always' | 'never'
