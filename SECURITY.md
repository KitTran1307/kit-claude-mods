# Security

## What each plugin touches

| Plugin | Reads | Writes | Runs | Network |
| --- | --- | --- | --- | --- |
| kit-statusbar | this session's transcript, the Claude login record (`.claude.json`, for the account email only) | nothing | `node scripts/session-info.mjs` only for very large transcripts, when Node exists | none |
| kit-todos | your to-do file, the `MEMORY.md` index of the current Claude config folder (every profile only with `memoriesAllProfiles`) | your to-do file (only when you add or finish a task) | nothing | none |
| kit-cloud | cloud-pilot's `state.json` and `install.json` | nothing directly | `git` (repo root, origin), the `cloud-pilot` CLI | the hub calls the GitHub API through `gh` |

The GitHub side (tokens, the one possible write: deleting a merged `claude/*` branch when you opt in) belongs to
[kit-cloud-pilot](https://github.com/KitTran1307/kit-cloud-pilot); see its SECURITY.md.

Text that comes from GitHub (PR titles, comments, questions) is treated as data: shown, never executed, invisible
characters stripped, only `https://` links drawn.

## Reporting a problem

Please open a [private security advisory](https://github.com/KitTran1307/kit-claude-mods/security/advisories/new)
rather than a public issue. Include the plugin, your OS and Claude Code version, and the steps to reproduce.
