# Changelog

## kit-turn 1.0.1

- kit-turn's own tests now pass on Linux and macOS too (a test used a Windows-only folder path). Nothing changes in the plugin itself.

## kit-cloud 2.8.0, usage-bar 2.1.0, kit-todos 1.7.0, kit-graphite 1.3.0, kit-safety 1.0.0, kit-status 1.0.0, quota-coach 1.0.0, kit-notify 1.0.0, kit-pet 1.0.0, kit-themes 1.0.0, kit-turn 1.0.0, kit-agents 1.0.0

Nine new plugins and updates to the four existing ones.

### kit-safety 1.0.0

- **New: kit-safety ("Safety Net").** Before a risky command (`rm -r`, `git push --force`, `git reset --hard`,
  `git clean -f`, `git checkout -- .`, `git branch -D`, dropping a database or table) or an edit that overwrites a `.env`
  file, it saves a snapshot of what would be lost, then asks in plain words in a band above the prompt: **Waiting for you:
  About to delete the folder "data/" · Snapshot saved #7 · Allow / Cancel**. Overwriting other files Git does not track
  is saved quietly, once per file per session. **`/safety list`**, **`/safety restore [n]`** and **`/safety undo`** put it
  back in one step ("Restored 14 files to 14:05"); Git snapshots are offered as an exact command, never run silently.
  Well-known key shapes (Anthropic, OpenAI, GitHub, AWS and Stripe keys, private keys, JWTs, passwords in URLs) are
  masked, with password-like settings (`DB_PASSWORD=...`, `"token": "..."`), in tool output as `sk-ant-•••• masked` in
  what Claude reads and on your screen. Option `confirm` (`risky`, `always`,
  `never`; `never` still snapshots). Snapshots live under the Claude config folder, newest 20 per project for 7 days, with
  Node.js binary files too and without it text files up to 3 MB. English and Vietnamese; `/safety doctor` checks what it needs.
- **Safe by default.** `git` and `node` always start from Safety Net's own folder, never your project (on Windows a `git.exe`
  inside a repository could otherwise run). Deleting a whole project says in yellow that its `.git` (unpushed commits,
  local branches, stashes) is not part of the snapshot. `/safety restore` never overwrites a file it could not save first:
  it restores only what is missing and says what it left alone; when nothing was overwritten it says there is no undo point
  to take restored files away. A file with a name that cannot be saved safely is asked about, never let through.

### kit-status 1.0.0

- **New: Status Dot (`kit-status`).** A colored dot at the start of each session name in the desktop app sidebar: 🔵 working,
  ⏳ waiting for a background command or agent, 🟠 waiting for your answer, ✅ done. It renames the session through the app's
  own session tools, does nothing outside the desktop app, and stops instead of asking when a rename would need approval.

### quota-coach 1.0.0

- **New: Quota Coach (`quota-coach`).** Tells you what is using your plan's limits and what to do about it. A one-line tip
  above the prompt when a saving is available (a full context: `/compact`; many subagents; a cold prompt cache before a big
  context; a strong model on light work), with a button where Claude Code can do it for you and never acting by itself.
  `/quota why` (or the tip's Why? button) explains the last turn's cost: context, model, subagents, cache. While you type,
  a pre-send estimate (`This turn ~3% of 5H (2-4%)`) once it has learnt your rate from a few turns. `/quota report` is a
  daily report by session, model and hour, in a side pane where the terminal has room, from your local transcripts and its
  own per-day totals. Plans without a 5-hour window, API keys and third-party providers see tokens only, never an error.
  No model calls, no network. Vietnamese and English.

### kit-notify 1.0.0

- **New: Notify (`kit-notify`).** A sound and a system notification when Claude finishes a turn that ran at least `notifyAfterSec`
  seconds (20 by default) and when it needs you (a permission prompt or a question), with two original sounds, quiet hours and
  nothing while you are typing. A queue for prompts typed while Claude works: a numbered list above the prompt with a **×** on each,
  **Send the first now**, **Pause**, **Clear all** and **Queue what I typed**, plus `/queue add|list|remove|clear|pause|resume|next`; the next
  one is sent when Claude is free, you are not typing and no permission prompt is open, and stopping Claude pauses it. A welcome-back
  card ("While you were away 25 min: 2 tasks done, 1 question waiting") after `awayMin` minutes away. Works with the engine's
  own audio on macOS and the system's player on Windows and Linux, and does nothing quietly where none exists. English and Vietnamese.

### kit-pet 1.0.0

- **New: Pet.** A small original pixel pet above the prompt, in three kinds (Moss, Bun, Jelly). It reacts to what Claude does (working, done, error, low limit), grows in three stages as you finish turns and shows an achievement toast for a few first milestones, at most one a day. See [plugins/kit-pet](plugins/kit-pet).

### kit-themes 1.0.0

- **New: Themes (`kit-themes`).** Three original themes for the Claude desktop and mobile apps. Paper is warm light paper,
  High Contrast is black and white with a yellow accent and reaches WCAG AAA (7:1) on its text and status colors, Night is a dark
  low-blue-light palette in warm browns and amber. By default it is on auto: Paper in light mode, Night in dark mode, so
  installing it already shows a theme. `/themes paper|contrast|night|auto|off` picks another or turns it off, and the
  choice is remembered. Nothing animates. In a terminal `/themes` says that nothing is drawn there. Vietnamese and English.

### kit-turn 1.0.0, kit-agents 1.0.0

- New: **kit-turn** (Turn Card), a plain-language summary at the end of each turn (card or timeline style), a turn clock and `/turn changes`.
- New: **kit-agents** (Agent Board), one card per running subagent with model, step, context bar, time and state.

### kit-cloud 2.8.0, usage-bar 2.1.0, kit-todos 1.7.0, kit-graphite 1.3.0

- kit-cloud 2.8.0 uses kit-cloud-pilot 1.7.0 (phone alerts, CI-failure and conflict self-handling, `nudge`).

#### usage-bar 2.1.0

- **Cache clock.** After the context meter, `◷ cache 4:07` counts down how long Claude's prompt cache for this session
  stays warm (green; yellow and bold in the last minute). When it runs out it says `◷ cache cold` in red. It is hidden
  before the first reply and whenever the transcript does not say. Turn it off with `showCacheClock`.
- **5-hour forecast.** `→ 72%` after the 5H percentage is where the window ends at your current pace, shown once a tenth
  of the window has passed (yellow from 80%, red from 100%). Turn it off with `showForecast`.
- **Old numbers are marked.** When the limits have not refreshed for over 5 minutes the row is dimmed and ends with
  `⟳ old 6m`.
- **Easier to read.** Four colors are a little lighter (secondary text, red, and the model and effort pills) so the text
  meets WCAG contrast.
- **`/usage-bar doctor`** checks Claude Code's version, Node, the transcript, the settings that hide the band and the
  rate-limit data, one line each.

#### kit-cloud 2.8.0

- **`/cloud nudge <n|id> [text]`** tells a cloud session to carry on, **`/cloud questions`** lists the open questions
  on this repo's tracked pull requests and **`/cloud reply <n> <text>`** answers one. They need kit-cloud-pilot 1.7.0;
  with an older one they say so and everything else keeps working.
- **`/cloud doctor`** now prints one line per check (PASS, WARN or FAIL, with a fix): kit-cloud-pilot, node, gh and its
  sign-in, Claude Code, the hub's files, stale lock files and the settings that hide the band.

#### kit-todos 1.7.0

- **`/todo doctor`** checks Claude Code's version, Node, the todos file and folder, the lock file, the memories and the
  settings that hide the band.

#### kit-graphite 1.3.0

- **`/graphite off`, `/graphite on`, `/graphite status`.** Off draws Claude's default look; the choice is remembered
  across sessions. **`/graphite doctor`** checks Claude Code's version, the theme and the optional terminal files.

#### All four

- Each plugin now has a `displayName`, and the repository checks the colors' contrast (`scripts/contrast.mjs`).

## kit-cloud 2.7.2

- Uses kit-cloud-pilot 1.6.1: answers also wake cloud sessions started from the desktop app, the web or a plain
  `claude --cloud`, with one account or several and with Remote Control on or off.

## kit-cloud 2.7.1

- **Answers reach a cloud session that stopped looking.** Uses kit-cloud-pilot 1.6.0: when Claude answers a cloud
  session's question, the session that asked is told to read the answer now, even when its turn had ended. Before, an
  answer could sit unread on the pull request for hours while the session looked stuck.

## kit-cloud 2.7.0

- **A clearer band, in Claude Code's own style.** Folded, the band names the repo and puts a colored dot before each
  count (orange for what needs you). Open, the sessions hang under the band as a tree, the way a tool's output hangs
  under its call: `⎿` before the first group, `├` `└` before each session, then its mark, task, status, age and an
  `Open ↗` link. The repo (and account) appear on each session only when the band spans several.
- **Finished sessions are listed** while there is room; on a short terminal they fold into one line first, and what
  still does not fit becomes "n more: type /cloud". The band never takes more rows than Claude Code gives it.
- **`/cloud` reads the same way:** grouped (Needs you, Working, In review, Finished) with a count each, one line per
  session and a dim line under it with its id and link.
- One-cell marks only (`◌` for silent instead of `⚠`, which some terminals draw as a wide emoji), so the columns stay in
  line everywhere. Links are drawn only when they hold no control characters.

## kit-cloud 2.6.0

- **The band says when an account cannot use the cloud.** When cloud-pilot sets your account aside (a session it
  started pushed nothing, most often because the account's GitHub connection on claude.ai lapsed), the band says so
  and how to reconnect. Uses kit-cloud-pilot 1.5.1, which then refuses to start more cloud sessions on that account
  and gives Claude what it needs to continue the work on your machine.

## kit-cloud 2.5.0

- **Claude hears from its cloud sessions by itself.** When a cloud session your session started asks a question, opens
  a PR, merges, fails CI, goes silent or pushes nothing, kit-cloud now hands that news to Claude in your session as a
  message, once Claude is idle (`wakeSession`, on by default). Before, Claude heard only while a `cloud-pilot wait` ran,
  and that wait ends after each batch: a merge that came after a "silent" notice could go unread. Branches found by
  watching the repo are not sent, since they were not started from your session.
- The band no longer asks you to restart a wait while `wakeSession` is on.
- Uses kit-cloud-pilot 1.4.0 (the marketplace installs it), which also reports a started session that pushed nothing
  in its first 20 minutes, a common sign that its account lost its GitHub connection.

## usage-bar 2.0.1

- **A privacy policy of its own** ([PRIVACY.md](plugins/usage-bar/PRIVACY.md)): what Usage Bar reads on your computer
  (Claude Code's session figures, this session's transcript, the email in your login record, your settings files),
  the one option it saves, and that it sends nothing anywhere. The README's privacy section links to it.
- Shown as "Usage Bar" wherever Claude Code lists plugins by their display name.

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
