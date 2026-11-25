# kit-agents (Agent Board)

A live board of your running subagents. When Claude starts subagents, the board shows one card for each: its name, the
model it runs on (Sonnet, Haiku, Opus), what it is doing now, how much of its context window it has used, how long it
has run and its state. A subagent that is waiting gets an orange border and a **Reply** button that opens its
conversation, so you can look at it or answer it without hunting for it. The board appears when a subagent starts and goes away when the
last one is done.

Install: `/plugin install kit-agents --marketplace KitTran1307/kit-claude-mods` (Claude Code 2.1.330 or later).

```
✻ Agent Board 3 running, 1 waiting
╭────────────────────────────────────────╮
│ ◆ test-writer                    04:37 │
│ Waiting · Sonnet 4.5                   │
│ Write tests for the coupon code        │
│ context ▰▰▰▰▰▰▱▱▱▱ 61%                 │
│ [ Reply ] opens its conversation       │
╰────────────────────────────────────────╯
╭────────────────────────────────────────╮
│ ● explore-cart                   01:12 │
│ Running · Haiku 4.5 · Explore          │
│ Find the cart total                    │
│ context ▰▰▰▱▱▱▱▱▱▱ 34%                 │
╰────────────────────────────────────────╯
● code-reviewer 00:48 Sonnet 4.5 18% Review PR 482
```

## Where it shows

- **Wide terminal:** in a pane beside the conversation, opened by itself once a subagent has run for 5 seconds (a
  short job never opens it, so the layout does not jump; the band shows the board meanwhile). The engine opens an
  unrequested pane only when the terminal is wide enough, 144 columns. Close it by hand and it stays closed until the
  subagents are done. `/board pane` opens it on request at any width.
- **Everywhere else** (a narrow terminal, the desktop app, VS Code, mobile): a band above the prompt. When the pane is
  drawn the band steps aside, so nothing shows twice.

The board sizes itself to the rows it is given and never scrolls: the most urgent subagents (the ones waiting,
then the longest running) are whole cards, the next ones shrink to one line each, and the rest are counted on a
"+N more" line. With almost no room it is one line with the count. It stacks with other plugins' bands.

## The /board command

- `/board` lists the running subagents as text.
- `/board pane` opens the pane (terminal only).
- `/board doctor` checks what this Claude Code offers and prints one line per check.

## Options

Every option has a working default; install is the whole setup.

| Option | Default | What it does |
|---|---|---|
| `showBand` | on | The band above the prompt. Off hides it; the pane and `/board` keep working. |
| `usePane` | on | In a wide terminal, open the pane by itself and let the band step aside. Off: always the band. |
| `maxCards` | 4 | Most subagents shown (1 to 12; outside that it is cut to it). The rest are counted on "+N more". |
| `language` | auto | `auto` follows Claude Code's own language setting (Vietnamese or English), `en`, `vi`. |

## Requirements and behavior

- A recent Claude Code with plugin hooks modules (the same as the other plugins in this marketplace). Windows, macOS
  and Linux; terminal, desktop app, VS Code and mobile.
- No Node.js, git, account or network is needed. It adds no tool, so it works with Code Mode.
- It redraws once a second only while at least one subagent runs, and stops its timer when none does.
- "Waiting" is the engine's `waiting` state: a subagent held on work of its own (a background job or another
  agent), on a plan's approval, or on a question. The engine does not say which of these it is, so the board does not
  claim the subagent needs you; it only highlights it and offers Reply so you can look.
- **Reply** opens the subagent's conversation in the main view. Claude Code allows that only while you press the
  button yourself; if it cannot (an older Claude Code, a stopped subagent, a teammate in its own pane) a short
  message says so and points to Claude Code's own agent list. Nothing breaks.
- A field the engine does not give is simply left out: no model, no model label; no context window, no bar.
- If the agent list cannot be read, the board clears itself and stops its timer instead of showing a stale list.

## Privacy

It reads only the session's live agent list. Nothing is stored and nothing leaves your machine. See [PRIVACY.md](PRIVACY.md).
