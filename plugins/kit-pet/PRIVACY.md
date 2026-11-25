# Pet privacy policy

Last updated: 2026-11-24.

Pet is a Claude Code plugin that draws a small pixel pet in a band above the prompt box. It runs entirely on your own
computer, inside Claude Code.

## What it reads

Only on your computer, only to draw the pet and count your progress:

- **Claude Code's own events**: that a turn started or ended (and whether it finished, failed or was stopped), how
  long it took, which tool ran and whether it failed.
- **The command of a shell tool call**, only to recognise a test run (such as `npm test`) or a git commit for the
  first-test and first-commit achievements. The command is checked in memory and is never stored or shown.
- **Your plan's usage windows** (the 5-hour and weekly percentages and their reset times), through Claude Code's plugin
  interface, for the low-quota state.
- **Claude Code's own `language` setting**, to choose English or Vietnamese when `language` is `auto`.

It does not read your prompts, replies, files, transcript, login record, account email or tokens.

## What it stores

A small counter file in the plugin's own store (a JSON file under your Claude Code configuration folder): the number of
finished turns, the dates (not times) of the last days you were active, whether you have had a green test run and a
commit, and which achievements were already shown. No commands, file names, project names, prompts or output are
stored. Uninstalling the plugin and removing its data folder removes everything.

## What it sends

Nothing. Pet makes no network requests, uses no model calls and sends no data to the author, to Anthropic or to
anyone else.

## Children

Pet is a developer tool, not directed at children, and collects no data about anyone.

## Changes and contact

Changes to this policy are listed in the repository's CHANGELOG. Questions or concerns: open an issue at
https://github.com/KitTran1307/kit-claude-mods/issues, or report a security problem privately as described in
https://github.com/KitTran1307/kit-claude-mods/blob/main/SECURITY.md.
