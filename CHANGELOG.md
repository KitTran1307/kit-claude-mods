# Changelog

## usage-bar 2.0.0, kit-cloud 2.4.2, kit-todos 1.6.2

### usage-bar (was kit-statusbar)

- **kit-statusbar is now Usage Bar** (`usage-bar`), named for what most people install it for: seeing your 5-hour and
  weekly limits, with reset countdowns and a daily pace, before you hit them. Everything else works as before; the
  plugin now has its own icon, and the README opens with what it looks like.
- **If you had kit-statusbar installed**, switch once (your options start from their defaults again):

  ```
  claude plugin uninstall kit-statusbar
  claude plugin install usage-bar --marketplace KitTran1307/kit-claude-mods
  ```

### kit-cloud, kit-todos

- Test data only (the band's props now carry `isCollapsed`, as Claude Code's types expect). No change in behaviour.

## kit-cloud 2.4.1, kit-statusbar 1.4.1, kit-todos 1.6.1, kit-cloud-pilot 1.3.2

Security fixes from a full review. Updating is recommended.

### kit-todos

- **A reply can only finish the task you handed over.** The `kit-todos done <id>` line now counts only for a task
  this session sent to Claude with **Do it now** or **Draft**, only once, and only as the last line of the reply,
  outside a code block. Text in a repository that talks Claude into printing the line can no longer mark other tasks.
- **Hidden text is caught more widely.** A task that carries characters the card does not show (by Unicode category,
  plus invisible letters such as variation-selector runs that can hide bytes) is drafted for you to read instead of
  sent in one press, and such characters are removed from Claude's suggestions. Everyday emoji (❤️ ✔️ 👨‍👩‍👧) stay as they are.

### kit-statusbar, kit-todos, kit-cloud

- **No terminal control codes on screen.** Text the bands draw (task text, titles, hook errors, GitHub details) has
  control characters removed, so it cannot move the cursor or change the terminal's title.
- kit-statusbar: a transcript line packed with hook-error markers is read in linear time.

### kit-cloud-pilot 1.3.2 (installed with kit-cloud)

- `gh` is always started by its full path from your home folder, never from the repository folder; branch names that
  break the `claude/…` rule are ignored; merged-branch cleanup needs a merge into the default branch; data files are
  private on macOS and Linux; the Windows terminal helper never starts a batch file and keeps non-English briefs intact.

## kit-cloud 2.4.0

- **A calmer cloud band, sorted by what needs you.** Folded, it reads like a sentence: "✻ Cloud  Nothing needs you ·
  1 working · 3 in review", with what needs you first, in Claude's orange. Open, sessions are grouped: **Needs you**
  (asking, silent or CI failed), **Running**, **In review**, then one quiet line for the finished ones (`/cloud`
  lists them). Each row shows the repo, the task (without repeating the repo's name) and its state, using the
  width the window has; the account shows only when the band mixes accounts. Colors come from your Claude Code theme.

## kit-cloud 2.3.0, kit-statusbar 1.4.0, kit-todos 1.6.0, kit-cloud-pilot 1.3.0

Fewer errors and fewer steps, in more situations.

### kit-cloud

- **Says why the band is not updating.** When the GitHub CLI is signed out, not installed, offline, or cannot read the
  repo, the band and `/cloud` say so in one plain line with what to do (for example "run gh auth login"), instead of
  staying silently old.
- **Installs kit-cloud-pilot 1.3.0:** starting a cloud session on Windows needs no Python any more (Windows' own
  pseudo-console is used), and branches the watch found on its own no longer raise error notifications.

### kit-statusbar

- **Shows in the Claude mobile app too.** (The VS Code extension draws no band above the prompt, so nothing shows
  there; the README says so.)

### kit-todos

- **"Do it now" no longer edits your todos file through Claude.** Claude ends its reply with `kit-todos done <id>`
  and the plugin marks the task done itself, so there is no permission prompt for a file outside your project.
- **No error without Node.js.** Without Node 18+, the suggestion server is held back (`/mcp` lists it as disabled)
  instead of failing at every start; everything else works and Claude simply has no suggestion tool.
- A suggestion poll that ends with the session no longer leaves an unhandled error behind.

## kit-cloud-pilot 1.2.2

kit-cloud installs kit-cloud-pilot 1.2.2: with Claude Code's Code Mode on, starting a cloud session no longer waits
on Code Mode's one-time question until it times out; it says right away how to answer it once.

## kit-cloud 2.2.1, kit-statusbar 1.3.1, kit-todos 1.5.1, kit-graphite 1.2.3

Fewer errors and fewer steps for you, in more situations.

### kit-cloud

- **No false "no cloud-pilot wait running" warning.** Cloud sessions the watch finds on its own no longer ask you to
  start a waiter you never needed.
- **Starts faster, and works on the first session after install.** Watching your repo no longer holds up the
  session's start, and when kit-cloud-pilot loads a moment later, the watch starts anyway.

### kit-statusbar

- **Asked once, really.** Closing the "show the bar beside your status line?" question now keeps your status line
  and is remembered, so it is not asked again at every start; a `claude -p` run is never asked.

### kit-graphite

- **No error on an older Claude Code.** Before 2.1.323 the theme is refused; the app now simply keeps its own look
  and no failed hook is reported.
- **Quiet in the terminal.** A terminal-only session no longer shows a "theme not drawn" status line.
- **Windows Terminal script works out of the box.** It finds Windows Terminal's settings for the Store, Preview,
  Canary and unpackaged installs, reads settings files with comments, uses PowerShell 7 when installed or else
  Windows PowerShell, opens in your home folder, uses the bundled backdrop by default, and explains a problem in
  plain words instead of a traceback.
- **English description** of the backdrop for screen readers.

### kit-todos

- **Says that suggestions need Node.js 18+**, in the option, the README and the install guide.

### Docs

- The README and install guide list all four plugins, kit-graphite included.

## kit-graphite 1.2.2

- **Needs Claude Code 2.1.323 or later.** Earlier versions refuse to set the theme, so the README now says so. The
  plugin itself is unchanged.

## kit-todos 1.5.0, kit-graphite 1.2.1

### kit-graphite (new)

- **A graphite theme for the desktop and mobile apps.** Neutral charcoal grays with a black accent (ivory in dark
  mode), a field of dots frozen mid-wave behind the conversation with small motes drifting through it, and a small
  clay-colored pixel comet circling the middle of the screen. With reduce-motion on, everything stands still.
- **Windows Terminal look.** `terminal/` holds a matching "Kit Graphite" color scheme and a still backdrop, with a
  script that adds them to Windows Terminal after backing up its settings.

### kit-todos

- **Works with Code Mode.** Claude Code's Code Mode refused to start while kit-todos was installed, because the
  plugin answered Claude's task suggestions by checking tool calls. The suggestion tool now comes from a small local
  MCP server inside the plugin, and the band picks suggestions up from it every second, so Code Mode starts. Cards,
  **Add**, **Dismiss** and the `/todo` commands work as before.
- **Needs Node.js for suggestions.** That server runs on Node.js 18 or later. Without Node, everything else still
  works and Claude has no suggestion tool. When nothing in the session picks a suggestion up, Claude is told so after
  20 seconds instead of being told it was proposed.

## Install: pick the plugins you want

Asking Claude to install from this marketplace now starts with a question: which of kit-cloud, kit-statusbar and
kit-todos you want, with what each one does and needs. Only the ones you pick are installed. Each plugin still
installs, updates and uninstalls on its own by hand. No plugin changed.

## kit-cloud 2.2.0, kit-statusbar 1.3.0, kit-todos 1.4.0

New features, and the mods now speak Vietnamese as well as English.

### kit-todos

- **Claude can suggest tasks.** When Claude finds follow-up work it is not doing now (out of scope, too large, or
  waiting for your decision), it can suggest it as a task. The suggestion shows above the prompt with **Add** and
  **Dismiss**, or run `/todo suggestions`, then `/todo accept <number>` or `/todo reject <number>` (or `all`).
  Nothing is saved until you add it, and the card shows exactly what will be saved. Turn it off with the
  `allowSuggestions` option.

### kit-cloud

- **Told when it matters.** While a Claude Code session is open, a cloud session that starts asking you something,
  opens a PR, fails CI, goes silent or finishes now raises a short message and a system notification. Turn it off
  with the `notifyInSession` option.

### kit-statusbar

- **Failing hooks no longer go unnoticed.** When hooks fail in this session, the status bar shows a warning such as
  `⚠ 3 hook errors (Stop)`. Click it to see which hook failed, its command and why. Turn it off with the
  `showHookErrors` option.

### All three

- **Vietnamese.** A new `language` option (`auto`, `en`, `vi`). `auto` follows Claude Code's own `language`
  setting; anything other than Vietnamese stays English.

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
