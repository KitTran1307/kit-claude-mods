# Safety Net privacy policy

Last updated: 2026-11-24.

Safety Net is a Claude Code plugin that saves a copy of what a risky command would delete or overwrite, asks you before
the command runs, and hides well-known passwords and API keys in what Claude reads. It runs entirely on your own
computer, inside Claude Code.

## What it reads

Only on your computer, only to do the job above:

- **The tool calls Claude is about to make** (the Bash/PowerShell command text, or the file a Write/Edit names), to
  decide whether one is risky. The command text is looked at in memory only: it is **not stored**, not in the snapshot
  and not in the log. (When a command is too long for Safety Net to read to the end, the band shows its first 120
  characters, with known key shapes masked, so you can read what you are asked.)
- **The files and folders a risky call would delete or overwrite**, inside your project folder only, to copy them. For
  an overwrite of a `.env`-like file it also reads that file (and the new content, when it is a file you copy from) to
  say, in words, which variable *names* would be lost. Variable values are never shown, kept or compared.
- **Your project's Git state**, through `git` (is this a repository, whether a file is tracked or ignored, and, only for
  a Git risk such as `git reset --hard` or a force push, the current commit and branch and `git stash create`, which
  records your uncommitted changes without touching your files).
- **Tool results**, in memory, to replace well-known secret shapes with `sk-ant-•••• masked` in what Claude reads, in
  the stored message and on your screen. The original value is never written anywhere by Safety Net. Claude Code may
  still keep the tool's raw output in its own transcript file on your disk, and only well-known shapes are recognised.
- **Claude Code's language setting and the environment variables** `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE`, to
  choose the language and find the folder below.

It does not read your login or API tokens.

## What it stores

- **Snapshots**, on your own disk, in `kit-safety/snapshots/` inside your Claude config folder (`~/.claude`, or the
  folder named by `CLAUDE_CONFIG_DIR`). Each snapshot is a copy of the files a risky call was about to change, plus a
  `manifest.json` listing their paths, sizes and times, the tool name, the kind of risk (`rm -rf`, `git push --force`
  and so on) and, for a Git risk, the commit. It never holds the command text. The copy of a file is the file: if it held
  a secret, the copy holds it too, so the folder has the same sensitivity as your project (with Node.js, on macOS and
  Linux, it is created readable only by you). Safety Net keeps the newest 20 snapshots per project (20 more for quiet
  saves of edits, counted together, quiet ones going first) for 7 days and 2 GB in all (all adjustable) and, each time a
  session starts, deletes the older ones.
- **A Git ref** `refs/kit-safety/<id>` in your project's repository for a snapshot of a Git risk such as `git reset --hard`
  or a force push (a record of your uncommitted changes, the current commit and the tips of the branches at stake).
  Pruning removes it with the snapshot, only while you work in that project: Safety Net never runs `git` in a project you
  did not open.
- An empty folder `kit-safety/no-hooks` (with a `README.txt` saying so) that Safety Net points Git's hooks at, so a
  repository's own hooks never run while it looks at your project.
- Nothing else: no history of what you typed, no list of secrets that were masked.

To remove everything: delete the `kit-safety` folder in your Claude config folder, and run
`git for-each-ref --format='%(refname)' refs/kit-safety | xargs -n1 git update-ref -d` in a repository to drop its refs
(or just leave them: they are small).

## What it sends

Nothing. Safety Net makes no network requests and sends no data to the author, to Anthropic or to anyone else, and
collects no telemetry. The optional helper `scripts/safety-fs.mjs` runs on your computer with Node.js, copies files
between your project and the snapshot folder, and prints a short result to Claude Code. It does not use the network.

The `/safety doctor` command runs local checks (`node --version`, `git --version`, whether the snapshot folder can be
written, by writing and rewriting a tiny file called `.doctor` in it) and prints the result on your screen.

## What it shows

The band shows the command's program name and flags (`rm -rf`, `git push --force`) and the names of the files or
branches involved. It does not show file contents. For a command line too long for Safety Net to read to the end it also
shows the first 120 characters of the line, in which only well-known key shapes are masked (the same line is already on
your screen in the tool row). Cancelled and allowed answers are not recorded.

## Children

Safety Net is a developer tool, not directed at children, and collects no data about anyone.

## Changes and contact

Changes to this policy are listed in the repository's CHANGELOG. Questions or concerns: open an issue at
https://github.com/KitTran1307/kit-claude-mods/issues, or report a security problem privately as described in
https://github.com/KitTran1307/kit-claude-mods/blob/main/SECURITY.md.
