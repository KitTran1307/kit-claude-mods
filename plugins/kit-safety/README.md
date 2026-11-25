# Safety Net

**A safety net for the commands you would regret.** Before Claude deletes a folder, rewrites Git history or overwrites
your `.env`, Safety Net saves a snapshot of what would be lost, asks you in plain words, and lets you put everything
back with one command. It also hides well-known key formats and password-like settings in what Claude reads, so a key
that shows up in a tool's output reaches Claude as `sk-ant-•••• masked` and not as the key.

```
/plugin install kit-safety --marketplace KitTran1307/kit-claude-mods
```

You do not have to set anything up: install it and it works, in the terminal and in the Claude desktop app, on
Windows, macOS and Linux.

## What it looks like

*A description of the screen (the band is drawn by Claude Code, so there is no image to paste here).* When Claude is
about to run something risky, a band appears directly above the prompt and stays there until you answer:

```
 WAITING FOR YOU  About to delete the folder "data/"  · rm -rf
 ✔ Snapshot saved at 14:05 (#7) · 342 files, 18 MB                   [ Allow ] [ Cancel ]
   Press 1 to allow or 2 to cancel while the prompt is empty, or click a button.
```

```
 WAITING FOR YOU  About to overwrite the file ".env"  · cp .env.example
 ✔ Snapshot saved at 14:05 (#9)                         [ Allow ] [ Cancel ] [ See changes ]
   Press 1 to allow, 2 to cancel or 3 to see changes while the prompt is empty, or click a button.
```

*See changes* opens one more line: `The old file has 12 variables, the new one 9: it loses DATABASE_URL, STRIPE_SECRET,
SENTRY_DSN.` (names only, never values). In the desktop app the same band is drawn with clickable buttons and without
the key hint.

*Allow* lets the command run, *Cancel* stops it and tells Claude that you said no. A press in the first moment after a
question appears is ignored, so a stray key cannot answer a question you have not read. If you wait more than a minute
before answering, the files are saved again just before the command runs, so work you did meanwhile is in the snapshot. If you do not answer for 15 minutes
the command is cancelled, never run on its own. If the band cannot be drawn where you are (a phone viewing a session, a
collapsed band, a survey on screen), Claude Code's own question box asks instead after a second or two, so a risky
command is never left waiting for a button you cannot see. In Claude Code's default permission mode its own permission
question can follow for a command you have not already allowed; Safety Net's question comes first and tells you what is
at stake and where the snapshot is.

After something went wrong:

```
> /safety restore
✓ Restored 14 files to 14:05  (snapshot #7)
  data/users.csv  data/orders.csv  data/archive/2024.csv
  data/archive/2023.csv  … and 10 more
Kept 3 files created after 14:05.
Changed your mind? /safety undo
```

And when a tool prints a key, Claude only sees this (and your screen shows the same, with one dim line under it):

```
ANTHROPIC_API_KEY=sk-ant-•••• masked
DATABASE_URL=postgres://shop:•••• masked@db.acme-shop.example/app
◈ 2 secret values were masked before they entered the conversation.
```

## What counts as risky

Safety Net only looks at your **project folder** and keeps the list short, so it does not nag.

| Asks first | What it saves |
| --- | --- |
| `rm -r` / `rm -rf` (also `Remove-Item -Recurse`, `rd /s`, `find ... -delete`, `find ... -exec rm`) on something in the project, or on a folder above it | the files and folders it would delete |
| overwriting a `.env`-like file (a `Write`/`Edit`, or `cp`, `mv`, `>` onto it) | the old file; the band lists which variable *names* the new one would lose (never the values) |
| `git push --force`, `-f`, `+branch`, `--mirror` (not `--force-with-lease` or `--force-if-includes`, which refuse to overwrite work you have not seen) | the last-fetched copy of the remote branch (for example `origin/main`), saved under a branch name you can restore; when there is none the band says there is nothing to save |
| `git reset --hard`, `git checkout -- .` / `git restore .`, or the same for named files | a Git snapshot of your uncommitted changes (`git stash create`), and, for named files, a copy of the files |
| `git clean -f`, `git branch -D` | the untracked files, or the tips of the branches |
| `git stash drop`, `git stash clear`, `git update-ref -d`, `git reflog expire --expire=now`, `git gc --prune=now` | nothing (Git cannot give these back), but it asks |
| dropping a database or table through `psql`, `mysql`, `sqlite3`, `wrangler d1 execute`, `prisma migrate reset`, `rails db:drop` and similar | the database file when it is one in your project; a database server itself cannot be copied |
| a command line too long or tangled for Safety Net to read to the end | nothing (it cannot know what to save), but it asks, because something dangerous could hide in the part it did not read |

**Cleaning up what can be rebuilt is quiet.** Deleting `node_modules`, `dist`, `build`, `.next`, `.cache`, `target`,
`__pycache__` or `coverage`, or any folder Git ignores, does not ask: a small snapshot is taken when the folder is small
(under about 2,000 files and 50 MB) and none otherwise, without scanning a big tree. A `.env` is never treated this way, a
command that also deletes something else still asks, and `confirm: always` asks about these too (an ignored folder can
hold local data that no build brings back).

**Edits are saved quietly.** Overwriting an existing file that Git does not track (a file you never committed, or one
Git ignores) saves a snapshot without asking, so ordinary work is not interrupted. It does this once for each file in a
session: the first time Claude changes it, so you can always get back the version from before Claude touched it, but not
every step in between. Choose `confirm: always` to be asked about these too. Quiet snapshots count with the others toward
`keepSnapshots` but are the first to go, so a flurry of edits does not push out the snapshot of a deleted folder.

**What it does not cover.** Commands Safety Net cannot read from their text: anything built at run time
(`eval`, a variable as the command name), scripts and tools that delete on their own (`./clean.sh`, `make clean`,
`npm run clean`, `python -c ...`), `rsync --delete`, `mv x /dev/null`, `truncate`, `dd`, and editing a tracked file
that has uncommitted changes (Claude Code's own `/rewind` covers its edits). Plain `rm file`, `git push`,
`git reset --soft`, `git commit -m "git reset --hard"` and `echo "rm -rf /"` are not risky.

For a filtered `find` the band says what is looked for, for example `About to delete everything named "node_modules" in this
project`. The band shows what Safety Net recognised, not the whole command line: when the line holds other commands it adds
`+2 other commands in this line that Safety Net did not flag; read the command before you allow it.`, and when a command
carries several branches it says how many more (`branch "dev" (+2 more)`). For a line too long to read, the band shows its
first 120 characters. In a mode where Claude Code asks nothing else (auto, accept-edits, bypass), the band is the only
question: read the line.

## Commands

| Command | What it does |
| --- | --- |
| `/safety` or `/safety list` | the latest snapshots of this project: number, time, what was saved (quiet saves are marked) |
| `/safety restore [n]` | puts the files of snapshot *n* back, and keeps what you created since. With no number it takes the newest snapshot of a command you were asked about (a quiet save of an edit only when there is nothing else) |
| `/safety undo` | puts back the files the last restore overwrote (every restore that would overwrite something saves the current files first). Files the restore created where nothing was before stay: undo does not remove them, so delete those yourself if you do not want them |
| `/safety doctor` | checks what Safety Net needs, one line each: PASS, WARN or FAIL, and what still works; also where the snapshot folder is and how much all projects' snapshots take against `maxTotalMB` |

For `git reset --hard` and a discard (`git checkout -- .`) the snapshot also records your commit and uncommitted changes
under `refs/kit-safety/<id>`; for a force push it records the last-fetched copy of the remote branch, and for a deleted
branch the branch's tip, under `refs/kit-safety/<id>.b/N`. Safety Net **never runs a Git command that changes your work**:
`/safety restore` prints the exact command (for example `git stash apply refs/kit-safety/20261124T140512Z`) for you to
run. When Git could not save your uncommitted changes (an unfinished merge, say) the band, `/safety list` and
`/safety restore` say so in yellow instead of claiming a Git snapshot.

**Restore never overwrites what it cannot save first.** Before a restore writes over a file that exists now, Safety Net saves
the current version as the undo point. When that is not possible (the disk is full, or the files are over the size limit)
it overwrites nothing: it puts back only the files and folders that are missing, leaves the ones already there as they are,
and says so ("Not overwritten: 2 files already there ..."). Free some disk space or move those files away, then run
`/safety restore` again. When every place the restore writes to is empty nothing is overwritten, so no undo point is
needed and none is made.

**Deleting a whole project deletes its Git history too.** `rm -rf .` (or the project folder, or a folder above it) takes the
`.git` folder with it, and a snapshot never copies `.git` (the Git state it keeps lives inside it). The band then adds
"The Git history (.git) goes too and is not saved: commits you have not pushed, local branches and stashes cannot come back"
in yellow instead of letting "Snapshot saved" stand alone: only your working files are saved. Push what you want to keep first.

## Options

Change them in `/config` or in `~/.claude/settings.json`. Every option has a working default.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `confirm` | `risky`, `always`, `never` | `risky` | `risky`: ask before the commands in the table above. `always`: also before overwriting any file Git does not track. `never`: never ask. Every choice still saves a snapshot first (except when cleaning up something large that can be rebuilt). |
| `maskSecrets` | boolean | `true` | Mask well-known secret shapes in tool output (below). Turn off to see and store output unchanged. |
| `keepSnapshots` | number | `20` | Newest snapshots kept per project, 1 to 200. Quiet saves of edits and the ones you were asked about count together; when there are too many the quiet ones go first. |
| `keepDays` | number | `7` | Days a snapshot is kept, 1 to 90. Older ones are deleted when a session starts (in projects other than the open one only the snapshots without Git refs; the rest wait until you open that project). |
| `maxTotalMB` | number | `2048` | All snapshots of all projects together may take this much disk space, 100 to 20000; the oldest are deleted first when a session starts. |
| `maxSizeMB` | number | `200` | A call that would touch more than this is not snapshotted (the band says so, and still asks), 10 to 2000. A call that touches more than 50,000 files is not snapshotted either, whatever its size (without Node.js a smaller limit applies). |
| `language` | `auto`, `en`, `vi` | `auto` | `auto`: Vietnamese when Claude Code's language setting is Vietnamese, English otherwise. `en` or `vi` to force one. What Claude itself reads stays English. |

## Secrets that are masked

Two kinds of things are masked, in the tool result that Claude reads and that the conversation stores, and on your screen:

- **Well-known key formats:** Anthropic, OpenAI, GitHub, AWS, Stripe, Slack, Google (API keys and OAuth tokens), npm, GitLab,
  Hugging Face, SendGrid, Supabase, DigitalOcean, PyPI and Telegram bot tokens, `age` secret keys, private key blocks, JWTs.
  They become `<start of the key>•••• masked` (a private key block keeps its BEGIN and END lines and loses the key).
- **Password-like settings:** the value after a name that holds *secret*, *token*, *password*, *passwd*, *pwd*, *api key*,
  *access key*, *private key*, *credential* or *auth* (`DB_PASSWORD=hunter2`, `"token": "..."`, `secret: ...`,
  `X-Auth-Token: ...`), `x-api-key:` and `Authorization: Bearer ...` headers, connection strings (`Password=...;`,
  `AccountKey=...;`) and passwords in URLs (`postgres://user:password@host`), which become `NAME=•••• masked`. Names that only
  look similar are left alone (`max_tokens`, `author`, `token_count`, `TOKEN_URL`, `PASSWORD_MIN_LENGTH`), and so are
  code (`process.env.API_KEY`, `input("password: ")`) and placeholders (`${TOKEN}`, `<password>`, `****`).

It cannot know every secret: a setting whose name it does not recognise (`DB_PASS=...`) is not masked, a secret split across
two tool results is not joined, and Claude Code may still keep the tool's raw output in its own transcript file on your disk.
Treat this as a seat belt, not a vault.

## Where snapshots live, and how much they save

Snapshots go to `kit-safety/snapshots/` inside your Claude config folder (`~/.claude`, or the folder `CLAUDE_CONFIG_DIR`
names, so each account keeps its own), in a folder for each project. They are deleted after `keepDays` days or when there
are more than `keepSnapshots`. Each time a session starts, Safety Net cleans up: completely in the project you opened
(including its `refs/kit-safety/*` Git refs); in up to 200 other projects only the snapshots without Git refs (the others
wait until you open that project, because Safety Net runs Git only where you are working); and it deletes the oldest
snapshots of all projects when the total is over `maxTotalMB`.

- **With Node.js 18 or later on your PATH** (most developers have it), files of any kind and size up to `maxSizeMB`
  are copied, with their times and permissions, into folders that, on macOS and Linux, only you can open, and checked with
  a SHA-256 when restoring.
- **Without Node.js**, Safety Net still works and quietly saves what it can with Claude Code alone: text files up to
  3 MB each. Binary files and larger ones are not copied (and `/safety restore` says so), and old snapshots are emptied
  rather than deleted. A `.env`-like file is not copied at all, because without Node.js its copy cannot be made private;
  the band says "Not saved: a .env file is copied only when Node.js is installed, so its copy can be kept private". A Git snapshot of your uncommitted changes covers every tracked file either way.
- It never follows symbolic links (a link inside a deleted folder is not saved and not restored: it is only a pointer, and
  the file it pointed to is untouched), never copies or restores anything outside the project, and skips what it cannot read.
- Safety Net runs `git` with its hooks and `core.fsmonitor` switched off (an empty folder, `kit-safety/no-hooks`, stands in
  for the hooks), so a repository's own configuration cannot run code while Safety Net looks at it. `git` and `node` are
  started from Safety Net's own folders, never from your project (on Windows a program is looked for in the working folder
  first, so a `git.exe` inside a repository would otherwise run).
- A file or folder whose name cannot be written as a safe relative path (a backslash in the name on macOS or Linux, for
  example) cannot be copied; a command that touches one is always asked about, never let through as harmless.
  A snapshot holds copies of your files, secrets included (a `.env` is copied as it is): keep your Claude config folder as
  private as your project. Copying a very large tree (tens of thousands of files) takes a few seconds, and the question
  waits for it.

## Requirements

Claude Code 2.1.275 or later. Nothing else is required; Node.js 18+ and Git make it more complete.

When nobody can answer (a headless `claude -p` run), Safety Net cannot ask: it saves the snapshot and lets the command
go on under your normal permission rules.

## Privacy

No network, no telemetry, nothing sent anywhere, and it never reads your login or API tokens. To do its job it does read
the files a risky command would delete or overwrite (a `.env` included: to copy it, and to list which variable names a new
one would lose), your Git state, and tool results (in memory, to mask them). Snapshots stay on your disk. Details in
[PRIVACY.md](PRIVACY.md).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| No band appears on a risky command | Run `/safety doctor`. The band is hidden while a survey is open or after you collapsed it (ctrl+x ctrl+a); Claude Code's own question box asks instead. |
| "No snapshot: more than 200 MB" or "more than 50,000 files" | The call touches more than the limit; raise `maxSizeMB` for the size one, or accept that this one is not saved (a `node_modules` folder can be reinstalled). |
| "Binary files were not saved" | Install Node.js 18 or later, or use Git for those files. |
| `/safety restore` says a file could not be restored | The file was changed or is open in another program; close it and run the command again. `/safety doctor` shows where the snapshot folder is. |
| A question appears twice | Claude Code asked its own permission question after Safety Net's (see above); answer both. |

## Uninstall

```
/plugin uninstall kit-safety
```

Snapshots stay until you delete the `kit-safety` folder in your Claude config folder. To drop the Git refs in a
repository: `git for-each-ref --format='%(refname)' refs/kit-safety | xargs -n1 git update-ref -d`.

## Development

```
claude --plugin-dir plugins/kit-safety        # run it from this folder
claude plugin validate plugins/kit-safety     # what the engine sees and would refuse
claude plugin test plugins/kit-safety         # the plugin's tests
node --test plugins/kit-safety/scripts/*.test.mjs   # the Node helper's tests
```
