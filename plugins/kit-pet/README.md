# Pet

**A small pixel pet that keeps you company while Claude works.** It sits in a band above the prompt box, works when
Claude works, cheers when a turn finishes, droops when something fails or your plan limit is almost used up, and
grows a little as you finish more turns. It costs nothing to run: no model calls, no network, no setup.

```
/plugin install kit-pet --marketplace KitTran1307/kit-claude-mods
```

## What it looks like

*(Description of the band; the pixel art is original and drawn by the plugin itself.)*

In the Claude desktop and mobile apps the band is a small card: the pet's 16x16 pixel art on the left, then two
lines. The first line has a colored name tag, a state tag and a short sentence, for example
`Moss` `WORKING` `Moss is on it · 2:41`. The second line, dimmer, says what is going on: `3 steps so far · last: Bash`.
While idle it shows the day's count, the growth stage and a six-cell bar with the count towards the next stage,
`4 turns finished today · Sprout ▰▰▰▱▱▱ 28/50`.

In a terminal the same band is three rows tall: the pet is drawn with half-block characters (a smaller, chunkier
version of the same art) with the two lines beside it. In a narrow window it shrinks to one line, and when the
window is very narrow, to a short `Moss · WORKING` label. It never takes more than three rows, never grabs the
keyboard, and steps aside when Claude Code shows a survey or you collapse the band.

## The pets

| Option value | Pet | What it is |
| --- | --- | --- |
| `moss` (default) | Moss | A round, leafy moss ball with a sprout; grows a flower. |
| `bun` | Bun | A friendly steamed bun with a fold on top; ends up golden with a little steam. |
| `jelly` | Jelly | A small jellyfish with a dome and tentacles; ends up with a soft glow. |

All three are original characters, drawn for this plugin.

## What it reacts to

| State | When | Shown |
| --- | --- | --- |
| Idle | nothing is running | the pet resting, today's finished turns and the growth bar |
| Working | Claude is in a turn | a running clock, the number of steps so far and the last tool used |
| Done | a turn just finished | `All done! Took 2m 41s` for about 8 seconds, then idle again |
| Error | a step failed (for a few seconds) or the turn ended in an error (for about a minute) | a sad pet and a hint |
| Low quota | your 5-hour or weekly limit is at 85% or more | a tired pet and when the limit refills |

The low-quota state needs the limit figures Claude Code reports for subscription plans. With an API key, a
third-party provider or any setup that reports none, that state simply never shows; nothing breaks. A limit reading goes away by itself once its reset time has passed, or
after 6 hours when it carries no reset time. If you press
Esc to stop a turn, the pet just goes back to idle.

## Growing

Every finished turn (one where Claude answered, across all your sessions and projects) counts. The pet has three
stages: a sprout from the start, a grown pet at 50 finished turns and a fully grown one at 300 (each pet has its own stage
names, such as Sprout, Little Moss and Blooming Moss). Stopped and failed
turns do not count. The count survives restarts and updates. If you run several sessions at once they add their turns
together, but Claude Code's plugin store has no atomic update, so two sessions that finish a turn in the very same
instant can occasionally count as one: a tiny undercount, never an overcount.

## Achievements

A short toast for each of these, shown once, and at most one a day (the next one waits for another day):

- **Seven-day streak**: you finished at least one turn on each of 7 days in a row.
- **100 turns finished**.
- **First green test run**: a test command (for example `npm test`, `pytest`, `go test`, `cargo test`) that Claude
  ran and that passed. Only a run whose result is the tests' own counts: a piped run (`npm test | tail`), one followed
  by `|| true` or by more commands after `;`, a watch-mode run and a run left in the background are not counted, and
  neither are dry runs or listings (`go test -list`, `make -n test`, `ctest -N`, `tox -e lint`).
- **First commit**: Claude made a git commit for you (counted when Claude Code reports the commit, or when the commit
  command was the last thing on the line).

Turn them off with `achievements`.

## Commands

`/pet` shows your pet's status: stage, turns, streak and achievements. `/pet doctor` checks, one line each,
whether everything the pet needs is there. Nothing in it needs fixing by hand: a missing piece just means that part
stays hidden.

## Options

Every option has a default that works; change them in `/plugin` or the plugin's settings.

| Option | Default | What it does |
| --- | --- | --- |
| `showPet` | on | Turn off to hide the pet. Growth and achievements are still counted. |
| `pet` | `moss` | `moss`, `bun` or `jelly`. Anything else shows Moss. |
| `achievements` | on | Show the achievement toasts. |
| `language` | `auto` | `auto` follows Claude Code's own language setting (Vietnamese or else English), `en` and `vi` force one. |

## Works with

- The `claude` CLI in a terminal, and the Claude desktop and mobile apps. The VS Code extension draws no band above
  the prompt, so nothing shows there (the pet still counts).
- Windows, macOS and Linux. No Node.js or other tools needed.
- Together with other bands (Usage Bar, kit-todos, kit-cloud): the bands stack above the prompt and share its height.
- Claude Code 2.1.275 or later. The plugin uses Claude Code's function-hooks interface, which is early access and may
  change between releases.

## Privacy

Everything stays on your computer: no network requests, no telemetry, no model calls. The pet only watches events
Claude Code already has (turns starting and ending, which tool ran, whether it failed, the limit percentages) and keeps
a small counter file in its own plugin store: how many turns you finished, which days you were active, and which
achievements it has shown. It never stores a command, a file name, a prompt or any output, and it does not read
your login or tokens. Details: [PRIVACY.md](PRIVACY.md).

## Install and remove

```
/plugin install kit-pet --marketplace KitTran1307/kit-claude-mods
/plugin uninstall kit-pet
```

In the desktop app: **+** next to the prompt box → **Plugins** → add the marketplace
`KitTran1307/kit-claude-mods` → **Add plugin**.
