# Changelog

## kit-cloud-pilot 1.2.0

The marketplace now installs kit-cloud-pilot 1.2.0 ([release notes](https://github.com/KitTran1307/kit-cloud-pilot/releases/tag/v1.2.0)):
`start --model` and `--effort`, a `questions` command that lists a PR's open questions with the hash `answer` needs,
and a PR merged outside GitHub is reported as merged instead of closed.

## kit-todos 1.3.0, kit-cloud 2.1.1, kit-statusbar 1.2.1

Fixes for issues reported by users. Thank you for the reports.

### kit-todos

- **No more lost changes.** Two sessions saving the list at the same moment could overwrite each other. Sessions now
  take turns using a small lock file (`todos.json.lock`). After saving, each session checks that its change is in the
  file and applies it again if someone else saved over it.
- **`/todo done <number>` marks the task you saw.** The number now refers to the last `/todo` list shown in this
  session, even if another session has changed the list since. In a new session, run `/todo` first.
- **Tasks stay with their repository.** Two repositories with the same folder name no longer share tasks, and
  renaming a folder keeps its tasks. New tasks record their repository (from the `origin` remote, or the folder
  path). Older tasks still match by folder name; run `/todo claim` to link them to the current repository.
  `/todo` tells you when this is needed.
- **The pane shows every task.** It starts with 50 open tasks; **Show more** adds 50 more.

### kit-cloud and kit-statusbar

- The install instructions now give the Claude Code version each command needs: 2.1.275 or later for
  `/plugin install … --marketplace` in a session, 2.1.292 or later for `claude plugin install … --marketplace` in a
  shell, and a two-step command for older versions.
- kit-cloud now states clearly that it uses the GitHub API through your `gh` login, and how to turn off automatic
  repository watching (`autoWatch`).

### Repository

- kit-cloud-pilot is pinned to an exact release (`v1.1.1`), so every install of this release gets the same code.
- CI uses a fixed Claude Code version on Windows, macOS and Linux, and installs every plugin from scratch on each.
  A separate job tests the newest Claude Code.
- The README lists what each plugin accesses over the network, and a new Feedback section and bug report form
  explain how to report problems.

## Repository: releases only

- This repository now holds releases only: one commit per release, with its notes here and on the Releases page.
  Pull requests are closed with a pointer to issues (see CONTRIBUTING.md); CI runs on every release. No plugin changed.

## kit-cloud 2.1.0

- The band (and `/cloud`) warns when this session owns live cloud tracks but no `cloud-pilot wait` runs for it (it
  ended, or was killed for low memory), with the number of unread events: they stay queued until a new wait takes
  them. Needs kit-cloud-pilot 1.1, which reports the waiters in its `state.json`; older versions show no warning.

## kit-todos 1.2.1, kit-statusbar 1.2.0

### kit-todos

- **Do it now** no longer sends a task whose `id` is outside letters, digits, `.`, `_` and `-` (64 at most) or whose
  text holds line breaks or invisible characters (control, zero-width, bidi): it drafts the whole prompt for you to read first, and
  such an id is quoted in the prompt. A todos file edited by someone else, or imported, could otherwise slip in
  instructions the card never showed. In the one-row-per-task list of a short terminal, a task wider than its row
  (cut with "…") is drafted the same way; band heights count wide characters (CJK, emoji) as two cells.
- Memories now come only from the current profile (`CLAUDE_CONFIG_DIR`, else `~/.claude`). The old behaviour (every
  `~/.claude-*` profile, newest wins) is the new `memoriesAllProfiles` option, off by default, so one account's
  memories never show in another account's session.

### kit-statusbar

- `surfaces: auto` asks once when the terminal already has a status line: keep only it, or show both. The answer is
  saved as `surfaces`.
- After `/reload-plugins` (no session start), `auto` no longer draws over a terminal status line before it has
  looked for one.
- The README and option help say plainly that the email and session title show by default and how to hide them for
  screen-sharing.

## kit-cloud 2.0.0

- KIT Hub moved out to its own project, [kit-cloud-pilot](https://github.com/KitTran1307/kit-cloud-pilot) (Claude Code CLI runs, tracks and answers its own
  cloud sessions). kit-cloud is now its band: it depends on kit-cloud-pilot, which installs with it, and finds it
  through `~/.claude/cloud-pilot/install.json`. Data folder `~/.claude/cloud-pilot`; settings `CLOUD_PILOT_*`
  (the `KIT_HUB_*` names still work).

## 1.1.0 (all three)

- Bands stack: with several plugins installed, each draws its part and hands the rest of the band, and the rows it
  leaves, to the plugins beneath. Before, only the top plugin's band showed.
- kit-cloud: `/cloud` table has a header and fits a 100-column terminal.
- README screenshots of the real plugins.

### kit-statusbar

- New default `surfaces: auto`: the band draws in the desktop app and in the CLI, where it steps aside only when
  a status line is already set up (user or project settings). `desktop` and `desktop+terminal` still work.

## 1.0.0

First public release of three mods that began as personal tools.

- **kit-cloud**: cloud-session band and `/cloud` commands, with KIT Hub bundled. New for the public release: `watch`
  (new `claude/*` branches tracked by themselves), `/cloud track|untrack|watch|unwatch|doctor`, notifications on
  macOS and Linux as well as Windows, merged-branch deletion made opt-in, signed-answer key made configurable.
- **kit-statusbar**: status bar for the desktop app; works with any Claude config folder, Node no longer required.
- **kit-todos**: to-do band and pane with `/todo`; the to-do file location is an option; a file that cannot be read is
  never overwritten.
