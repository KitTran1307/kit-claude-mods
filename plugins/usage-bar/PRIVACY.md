# Usage Bar privacy policy

Last updated: 2026-11-24.

Usage Bar is a Claude Code plugin that draws a status band above the prompt box. It runs entirely on your own
computer, inside Claude Code.

## What it reads

Only on your computer, only to draw the band:

- **Claude Code's own session figures** (model, effort, context use, your plan's 5-hour and weekly usage windows),
  through Claude Code's plugin interface.
- **This session's transcript** (`<config folder>/projects/<project>/<session id>.jsonl`), to find the session title,
  the account email and failed hooks, and the time and prompt-cache counters of its last reply, for the cache clock
  (just a timestamp and whether a one-hour cache was written; the conversation text is not used for it). All of it is
  read locally and nothing is sent anywhere.
- **Your local login record** (`.claude.json`), only its `oauthAccount.emailAddress` field, and only when the
  transcript does not name the account.
- **Your Claude Code settings files** (user and project `settings.json`), only to see whether you already have a
  status line, so the band does not show the same facts twice.
- **The environment variables** `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE`, to find those files and name the
  account (for example `.claude-work` shows as "work").

## What it stores

- Nothing outside Claude Code. While a session runs, it keeps the figures it shows in Claude Code's plugin state for
  that session.
- When it asks once whether to show the band beside your own status line, it saves your answer as its own `surfaces`
  option in your Claude Code settings. You can change or clear it with `/config`.

## What it sends

Nothing. Usage Bar makes no network requests and sends no data to the author, to Anthropic or to anyone else. The
optional helper `scripts/session-info.mjs` runs on your computer with Node.js, reads the same transcript and login
record, and hands its results only to the plugin.

The `/usage-bar doctor` command runs local checks and prints the result on your screen. To do so it executes
`node --version` and, if Claude Code does not report its own version, `claude --version`; they print a version number
only, and nothing is sent anywhere. It also checks whether this session's transcript can be read. It never prints your
email, tokens or file contents.

## What it shows

Your account email and session title appear in the band. Turn them off with the `showEmail` and `showTitle` options
(for example before you share your screen).

## Children

Usage Bar is a developer tool, not directed at children, and collects no data about anyone.

## Changes and contact

Changes to this policy are listed in the repository's CHANGELOG. Questions or concerns: open an issue at
https://github.com/KitTran1307/kit-claude-mods/issues, or report a security problem privately as described in
https://github.com/KitTran1307/kit-claude-mods/blob/main/SECURITY.md.
