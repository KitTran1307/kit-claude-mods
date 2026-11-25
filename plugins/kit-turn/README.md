# Turn Card (kit-turn)

At the end of every turn Turn Card shows a short, plain-language summary above the prompt: what Claude did, which files
it changed (+ and - per file), which tests ran and how many passed, how long it took, and a warning when you have
commits that are not pushed yet. You do not need to read code to know "is it done, and is it safe".

While Claude is working it shows a small clock instead: "Working - started 14:02 - 3 min".

Install it and you are done: every option has a working default.

Install: `/plugin install kit-turn --marketplace KitTran1307/kit-claude-mods` (Claude Code 2.1.330 or later).

## Two styles

Choose with the `style` option (`card` is the default).

**card**: sections for Done, Changes (each file with +/-), Checks and Time.

```
╭───────────────────────────────────────────────────╮
│ ✻ Last turn  14:02 -> 14:05                       │
│ Done                                              │
│ Fixed the rounding of the cart total at checkout. │
│ Changes                                           │
│ Changed 3 files (+40/-12)                         │
│ src/cart/checkout.ts                      +22 -5  │
│ src/cart/discount.ts                      +14 -6  │
│ tests/checkout.test.ts                     +4 -1  │
│ Checks                                            │
│ node --test: 12 passed - 0 failed                 │
│ Time                                              │
│ 3 min 12 s - started 14:02                        │
│ ⚠ 2 commits not pushed to origin/main             │
│ [ Push now ] [ View commits ] [ Details ] [ Hide ]│
╰───────────────────────────────────────────────────╯
```

**timeline**: one line per step with its clock time, then the result and the Push now button.

```
✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s - started 14:02
14:02 Started: "Fix the rounding of the cart total"
14:03 Read 6 files
14:03 Edited checkout.ts +22 -5
14:04 Edited discount.ts +14 -6
14:05 Ran tests: 12 passed
14:05 Made a commit: Fix cart rounding
⚠ 2 commits not pushed to origin/main
[ Push now ] [ View commits ] [ Details ] [ Hide ]
ended 14:05 (3 min 12 s)
```

Both fit the room they are given and never scroll the band. A card gives up its file rows first; in a short window, or on
a phone, either style becomes the one-line summary (`✔ Changed 3 files (+40/-12) - tests: 12 passed - 3 min 12 s -
started 14:02`) with a **Files** button that opens the list. With a single row left, the unpushed warning comes first.

## Push now

When commits are not pushed yet, the card says so and offers **Push now**. It only writes "Push my commits to the
remote (git push) and tell me the result." into your prompt box (on a new line when you already have a draft there). Nothing is pushed until you press Enter and Claude runs
the command (your normal permission prompt still applies). **View commits** opens the pane with the list.

## Commands

- `/turn`: the last summary as text.
- `/turn changes`: every file changed since the session started, and the unpushed commits.
- `/turn pane`: opens the pane (the full card, the timeline of the turn, the session's changes and the commits).
- `/turn doctor`: a one-line-per-check health report (git found, repository, upstream, language).

## Options

All optional; set them with `/config` or at install.

| Option | Default | What it does |
| --- | --- | --- |
| `style` | `card` | `card` or `timeline`. |
| `showClock` | on | The turn clock in the band and the status line while Claude works. |
| `showBand` | on | The band above the prompt. Off: `/turn` and the pane still work. |
| `language` | `auto` | `auto` follows Claude Code's own language setting (Vietnamese or English), `en` or `vi` to force one. |
| `maxFiles` | 8 | Files listed in the card before "+N more" (1 to 30; other numbers are cut to that range). |

## How it works, and what it needs

- Claude Code with plugin hooks modules (2.1.330 or later), the CLI or the desktop app, on Windows, macOS or Linux.
- It reads the turn's tool calls through the session's rows (it hooks no tool calls, so it does not change how tools run), asks Claude Code's
  version-control interface what changed, and runs read-only git for unpushed commits. Nothing leaves your computer: see
  [PRIVACY.md](PRIVACY.md). No network, no account, no Node.js needed.
- Without git or outside a repository it degrades quietly: the card then lists the files from Claude's own edits (marked
  "about"), and the unpushed warning is simply absent.
- File counts come from git (Claude's own edit calls are used, marked "about", only when git cannot say), so they are the
  same with or without Code Mode. The step list is built from the tool calls it knows (read, edit, shell, helper agents,
  web lookups); a tool it does not know, and everything inside a Code Mode script, shows as "Ran N other actions", so under
  Code Mode the timeline is coarser.
- Test counts are read from the output of node --test, Jest, Vitest, pytest, cargo test and go test, from a shell or from
  any other tool's printed result (a script run, an MCP tool). Output it does not recognise just shows no Checks line.
- The session-wide list of changes is read only when you open the pane or run `/turn changes`, not after every turn.
- Changes are measured against the working tree when the turn started: files that were already modified before the
  turn are left out unless they changed again.
- Only the main conversation is summarised; helper agents' turns are not.

## License

MIT
