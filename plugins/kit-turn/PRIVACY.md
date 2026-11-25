# Turn Card privacy policy

Last updated: 2026-11-25.

Turn Card is a Claude Code plugin that draws a summary card above the prompt box at the end of each turn. It runs
entirely on your own computer, inside Claude Code.

## What it reads

Only on your computer, only to build the summary:

- **This session's tool calls and results**, through Claude Code's plugin interface (the conversation rows of the
  current turn): which files Claude read or edited, the output of the tools it ran (to find test counts such as "12 passed"
  and git's own "commit made" line), and the time each step ended. Only counts, file names and the first line of
  Claude's final answer or of your request are kept, for the current session, in Claude Code's plugin state.
- **What changed in your working folder**, through Claude Code's version-control interface and read-only git commands
  (`git diff --numstat`, `git rev-list --count`, `git log`, `git rev-parse`, `git remote`, `git --version`):
  the names of changed files, lines added and removed, and the commits that are not pushed yet. It never changes the
  repository: no add, commit, checkout, stash or push.
- **Claude Code's `language` setting**, only to choose English or Vietnamese when the option is `auto`.

## What it stores

Nothing outside Claude Code. While a session runs it keeps the latest summary in Claude Code's plugin state for that
session. It writes no file.

## What it sends

Nothing. Turn Card makes no network requests and sends no data to the author, to Anthropic or to anyone else.

The "Push now" button only writes a sentence into your prompt box ("Push my commits to the remote (git push) and tell
me the result."). Nothing is pushed unless you send it and Claude runs the command, which Claude Code's normal
permission prompt then covers.

## Contact

Questions or problems: https://github.com/KitTran1307/kit-claude-mods/issues
