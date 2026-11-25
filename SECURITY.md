# Security

## What each plugin touches

| Plugin | Reads | Writes | Runs | Network |
| --- | --- | --- | --- | --- |
| usage-bar | this session's transcript, the Claude login record (`.claude.json`, for the account email only) | nothing | `node scripts/session-info.mjs` only for very large transcripts, when Node exists | none |
| kit-todos | your to-do file, the `MEMORY.md` index of the current Claude config folder (every profile only with `memoriesAllProfiles`) | your to-do file (only when you add or finish a task) | nothing | none |
| quota-coach | this session's usage figures, today's session transcripts (reply time, model, token counts and the session title, only for `/quota report`), Claude Code's `language` setting, the environment variables `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` (to find the transcripts), whether your prompt is empty (never its text) | its own per-day totals and one window marker in Claude Code's plugin store (14 days) | nothing | none |
| kit-themes | Claude Code's own `language` setting (to pick English or Vietnamese), its own saved theme choice | its own saved theme choice (only when you use `/themes`) | nothing | none |
| kit-turn | the session's tool calls and results (file names, test output), read-only `git` (status, diff, log, rev-parse, rev-list, remote) of the current folder | nothing (its Push now button only fills the prompt; you send it) | read-only `git` | none |
| kit-agents | the session's live subagent list (names, models, state) | nothing | nothing | none |
| kit-notify | events Claude Code reports (turn finished and its first answer line, permission prompts, questions), the text of the prompt box (to see whether you are typing, and to queue it on request; queued prompts are shown to you only), Claude Code's `language` setting | nothing on disk (the queue and the welcome-back card live in the session's memory) | the system's own sound player on its bundled sound file: `powershell` (Windows) or `paplay`, `aplay`, `canberra-gtk-play` (Linux); `uname -sr` once on an older Claude Code | none |
| kit-cloud | cloud-pilot's `state.json` and `install.json` | nothing directly | `git` (repo root, origin), the `cloud-pilot` CLI | the hub calls the GitHub API through `gh` |
| kit-pet | nothing outside the session's own events (finished turns, which tool ran and whether it failed, the command of a shell call to spot a test run or a commit (never stored), the limit readings Claude Code already has, its `language` setting) | its own small counter file in the plugin's store (turn count, active days, which achievements were shown) | nothing | none |
| kit-safety | the files or folders a risky command or edit names (to copy them), the variable names in a `.env` it would overwrite, `git` state of the project, tool results (to mask secrets in memory only); never the command text for storage | its own snapshot folder `kit-safety/snapshots` under the Claude config folder (and a tiny `.doctor` file there for `/safety doctor`); `refs/kit-safety/*` in the open project's Git repository for Git risks; an empty `kit-safety/no-hooks` folder; the files you ask `/safety restore` to put back | `git` (hooks and fsmonitor off, only in the open project); `node scripts/safety-fs.mjs` for binary-safe copies, only when Node exists; `node --version` and `git --version` for `/safety doctor` | none |

The GitHub side (tokens, the one possible write: deleting a merged `claude/*` branch when you opt in) belongs to
[kit-cloud-pilot](https://github.com/KitTran1307/kit-cloud-pilot); see its SECURITY.md.

Text that comes from GitHub (PR titles, comments, questions) is treated as data: shown, never executed, invisible
characters stripped, only `https://` links drawn.

## Reporting a problem

Please open a [private security advisory](https://github.com/KitTran1307/kit-claude-mods/security/advisories/new)
rather than a public issue. Include the plugin, your OS and Claude Code version, and the steps to reproduce.
