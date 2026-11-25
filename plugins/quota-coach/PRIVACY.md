# Quota Coach privacy policy

Last updated: 2026-11-25.

Quota Coach is a Claude Code plugin that shows tips, an estimate and a daily report about your plan's usage. It runs
entirely on your own computer, inside Claude Code.

## What it reads

Only on your computer, only to draw what it shows:

- **Claude Code's own session figures** (model, context size, your plan's 5-hour usage window, the running subagents, the
  size and end of each turn), through Claude Code's plugin interface.
- **Local session transcripts** (`<config folder>/projects/<project>/<session id>.jsonl`), only when you run
  `/quota report`: of every project, the 40 newest transcripts changed since local midnight. From each it reads the time,
  model and token counts of today's replies, and the session's title. The conversation text is not used. Everything is read
  locally and nothing is sent anywhere.
- **The environment variables** `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE`, to find the transcripts.
- **Claude Code's `language` setting**, to pick English or Vietnamese.
- **The text of your prompt as you type**, only to know whether it is empty (the estimate is for the message you are about
  to send). The text itself is not kept or used.

## What it stores

- While a session runs, the figures it shows, in Claude Code's plugin state for that session.
- Small per-day totals in Claude Code's own plugin store, for the last 14 days: one record per session and day with the
  share of the 5-hour window and the token count (by session id), per model family and per hour, and one value remembering
  the highest 5-hour percentage already counted in the current window. No conversation text, no file names, no prompts.
  They stay on your computer, in the plugin's own store, and old days are removed automatically.

## What it sends

Nothing. Quota Coach makes no network requests, makes no model calls, runs no programs and sends no data to the author, to
Anthropic or to anyone else.

## Children

Quota Coach is a developer tool, not directed at children, and collects no data about anyone.

## Changes and contact

Changes to this policy are listed in the repository's CHANGELOG. Questions or concerns: open an issue at
https://github.com/KitTran1307/kit-claude-mods/issues, or report a security problem privately as described in
https://github.com/KitTran1307/kit-claude-mods/blob/main/SECURITY.md.
