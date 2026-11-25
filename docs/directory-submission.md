# Directory submission text

Text for the owner to paste into the claude.ai/directory submission form. Nothing here has been submitted.
Repository: https://github.com/KitTran1307/kit-claude-mods. Author: Kit Tran.

## The four plugins

### kit-cloud

kit-cloud shows your Claude Code cloud sessions in a band right above the prompt, in the terminal and in the desktop
app. For each session you see whether it is working, asking you a question, has opened a pull request, has failing
checks, or has gone quiet, with a link to open it. Type `/cloud` for a list, and `/cloud doctor` to check that
everything it needs is in place. In this release it also nudges you when a session needs you, can show the questions
a cloud session is asking, and lets you reply to one from `/cloud`. It works together with kit-cloud-pilot, a separate
open-source tool (https://github.com/KitTran1307/kit-cloud-pilot) that does the tracking and is installed with it.

- Reads: the cloud-pilot state files in its data folder (`~/.claude/cloud-pilot`, or the folder named by
  `CLOUD_PILOT_DIR`), including the per-session event queue; the repository's git remote (`git -C <folder> ...`) to
  find the GitHub repo; Claude Code's `language` setting; the environment variables `CLAUDE_CONFIG_DIR`, `HOME`,
  `USERPROFILE`, `CLOUD_PILOT_DIR`.
- Writes: its data folder (tracked sessions, hub state, event queue). It starts a local Node helper
  (kit-cloud-pilot), which calls GitHub through the GitHub CLI. Only when you type `/cloud nudge`, it sends your
  message to a cloud session, and only when you type `/cloud reply`, it posts your answer to the pull request. If you
  turn on `deleteMergedBranches` (off by default) it deletes a `claude/*` branch you tracked after its pull request
  merged. `/cloud doctor` only reads (it may run `claude --version`) and never deletes anything.
- Sends: requests to GitHub, made by kit-cloud-pilot through your own `gh` login: to read branches, pull requests,
  check results and open questions, and, on your command, to post a reply or nudge a session. Nothing goes anywhere
  else. Optional system notifications are shown on your computer.

### usage-bar

Usage Bar draws a slim band above the prompt that shows, at a glance, which repo and model you are using, how full the
conversation is, which account you are signed in as, and how much of your 5-hour and weekly limits you have used, with
countdowns to the reset and a daily pace for the week. In this release it also shows a cache clock (how long until
the prompt cache goes cold), a forecast of when the 5-hour limit will run out, a marker when the figures are stale,
and `/usage-bar doctor`, which checks what it can and cannot read. It works in the terminal and in the desktop app.

- Reads: Claude Code's own session figures (model, effort, context, limits); this session's transcript file
  (session title, account email, failed hooks, and the time and cache counters of the last reply, for the cache clock); the `emailAddress` field of the local login record (`.claude.json`),
  only when the transcript does not name the account; the user and project `settings.json` files, only to see whether
  a status line exists; the environment variables `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`; Claude Code's
  `language` setting. A small bundled Node helper does the same reading for very large transcripts. `/usage-bar doctor` may run
  `node --version` and `claude --version`, which print a version and nothing else.
- Writes: nothing to disk. It keeps its figures in Claude Code's plugin state for the session, and saves one option
  (`surfaces`) in your Claude Code settings when you answer its one question.
- Sends: nothing. No network requests.

### kit-todos

kit-todos keeps your to-do list for the current project in view. A band above the prompt shows what is open and what
is due soon, with one-press buttons to hand a task to Claude, mark it done or draft a message about it. There is also
a pane with every task, a `/todo` command, the latest notes Claude saved for the project, and a place where Claude can
suggest follow-up tasks that you approve or dismiss (nothing is saved until you add it). In this release `/todo
doctor` checks the file and settings. English and Vietnamese are built in.

- Reads: your todos file (`~/.claude/kit-todos/todos.json` by default, path configurable); the project's memory index
  (`MEMORY.md`) and the memory files it lists, in the current profile (or every profile, if you turn on
  `memoriesAllProfiles`); Claude Code's `language` setting; the environment variables `CLAUDE_CONFIG_DIR`, `HOME`,
  `USERPROFILE`.
- Writes: the todos file (add, done, claim; it never deletes or reorders entries and never overwrites a file it cannot
  parse) and a short-lived lock file beside it (`<todos file>.lock`) so two sessions do not collide. Suggestions from
  Claude stay in memory until you add them.
- Sends: nothing. No network requests. It runs a tiny local Node helper (to offer Claude the suggestion tool and to
  check the Node version); text in the todos file is treated as data and never as instructions to Claude.

### kit-graphite

kit-graphite gives the Claude desktop and mobile apps a calm graphite look: neutral charcoal grays, a black accent by
day and an ivory one at night, a field of dots frozen mid-wave behind the conversation with small specks drifting
through it, and a small clay-colored pixel comet circling the middle of the screen. With the system's reduce-motion
setting on, everything stands still. In this release `/graphite on`, `/graphite off` and `/graphite doctor` turn the
theme on or off and check why it is not showing. A matching color scheme for Windows Terminal is included separately.

- Reads: nothing from your files or accounts. At session start it sets its theme through Claude Code.
- Writes: one on/off flag (the choice made with `/graphite on|off`). The optional Windows Terminal helper
  (`terminal/add-to-windows-terminal.py`, run by you) edits Windows Terminal's settings file after making a backup.
- Sends: nothing. No network requests.

## Privacy (all four plugins)

- Nothing leaves your computer, except kit-cloud's own calls to GitHub (reading, and on your command posting a reply or nudge), which go through your own `gh` login.
- No telemetry, no analytics, no data sent to the author or to Anthropic.
- No tokens or passwords are read, shown or kept. usage-bar opens the login record only to read one field, the account
  email (you can turn that off with `showEmail`), and opens Claude Code's settings files only to see whether a status
  line is set; neither's other contents are printed, stored or sent.
- Text that comes from GitHub or from your files is shown as data and is never run or followed as instructions.
- Policies: plugins/usage-bar/PRIVACY.md and SECURITY.md in the repository. Security reports go through the private
  route in SECURITY.md.

## Screenshots

Existing files in `docs/images/` (all real Claude Code sessions on demo data):

| File | Size | Shows |
| --- | --- | --- |
| `terminal-bands.png` | 1360x478 | The kit-cloud band with usage-bar and kit-todos under it, in the CLI |
| `cloud-command.png` | 1360x357 | `/cloud` listing this repo's cloud sessions with links |
| `todo-pane.png` | 810x610 | The kit-todos pane: open tasks with Do it now, Draft, Done |
| `usage-bar.gif` | 1000x210 | The usage band, limits filling with reset countdowns |
| `statusbar-terminal.png` | 750x75 | The usage band in the CLI |
| `social-preview.png` | 1280x640 | Repository social card (not a product screenshot) |

Missing, for the owner to capture:

1. **kit-graphite, light mode** (about 1600x1000, desktop app): a conversation with a short exchange, showing the dot
   field, the pane behind the messages and the comet. Both sidebars visible.
2. **kit-graphite, dark mode**: the same view in dark mode (ivory accent).
3. **Usage Bar with the cache clock and 5-hour forecast** (about 1000x210, PNG or GIF): one band showing the 5-hour
   bar with its reset countdown and forecast, the weekly bar with the pace, the cache clock counting down, and one
   stale-marked value if possible. Hide the email (`showEmail: false`). The existing `usage-bar.gif` predates the new
   row and should be replaced.
4. **`/usage-bar doctor`, `/cloud doctor`, `/todo doctor`, `/graphite doctor`** (optional, one image each or a
   combined one, about 1000 wide): the output of each doctor command.
5. **kit-cloud with a question and a reply** (about 1360x400): the band showing a session that asks a question, and
   the `/cloud` question and reply view.

## Pre-submission checklist

- [x] `displayName` is present in every `plugins/*/.claude-plugin/plugin.json`.
- [ ] Versions match across `plugin.json`, the marketplace file and CHANGELOG (this release: kit-cloud 2.8.0, usage-bar
  2.1.0, kit-todos 1.7.0, kit-graphite 1.3.0).
- [ ] `claude plugin validate .` and `claude plugin validate plugins/<name>` pass for all four: ___ of ___.
- [ ] `claude plugin test plugins/<name>` passes for all four: ___ tests.
- [ ] `node --test scripts/*.test.mjs` and the usage-bar helper tests pass: ___ tests.
- [ ] `node scripts/contrast.mjs` exits 0. At last recording (docs/contrast.md) usage-bar has 14 failing pairs; fix
  the colors or accept them knowingly before submitting.
- [ ] CI is green on all three operating systems.
- [ ] Missing screenshots above are captured and linked from the READMEs.
- [ ] README, PRIVACY.md and this text agree on what is read, written and sent.
- [ ] No private names, accounts, machines or client names in any public file.
