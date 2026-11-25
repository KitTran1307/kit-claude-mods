# Quota Coach

**See what is using your Claude plan's limits, and what to do about it.** Quota Coach watches the size of your
conversation, the model, the prompt cache and your subagents, and tells you in one line above the prompt when a saving is
available. It never acts by itself: every suggestion is a button you press or a command you type.

```
/plugin install quota-coach --marketplace KitTran1307/kit-claude-mods
```

Install is all there is to it: every option has a working default, and there is nothing to configure or sign in to. It
makes no model calls and no network requests.

## What it shows

**A one-line tip** above the prompt when something is using your limits needlessly (only one at a time, most useful
first):

```
 ✦ Context is 78% full and every message re-reads it: /compact could make later turns up to ~85% cheaper.  [ Compact ] [ Why? ] [ × ]
```

- **Context above 70%** (the `contextTipPercent` option): suggests `/compact` with an estimate of how much cheaper later
  turns get. **Compact** runs it for you.
- **Three or more subagents at once**: each one reads its own copy of the context.
- **Cold prompt cache before a big context**: Claude keeps your conversation in a short-lived cache (5 minutes, or an
  hour); after it has run out, the next message re-reads everything at full price.
- **A strong model on light work**: three light turns in a row on Opus (short answers, few steps, no subagents).
  **Fill /model sonnet** types the command into the prompt for you to send; it never overwrites what you have typed and
  never sends it.

**×** dismisses a tip for as long as it keeps applying (once the condition clears, for example after a compaction, it can
come back). **Why?** opens the card below.

**A "why did the last turn cost this?" card** (`/quota why`, or the tip's **Why?** button): the context size, the model
and how much more it uses than Sonnet, running subagents, whether the cache is warm or cold, the share of your 5-hour
limit the last turn used (once Quota Coach has learnt your rate), and one or two buttons (`/compact · saves up to ~80%`,
`Fill /model sonnet`).

```
 ✦ Why did the last turn cost this?  ~4% of 5H · average 1%
 ● Context   156k / 200k tokens (78%)
     Every step re-sends the whole conversation (156k tokens).
 ● Model     Opus 5.5
     About 1.7x Sonnet for the same amount of work.
 ● Subagents 3 running now
 ● Cache     cold (idle 7 min)
     The cache has expired: re-reading is not discounted.
 [ /compact · saves up to ~85% ] [ Fill /model sonnet ] [ Close ]
```

**A pre-send estimate** while you type a message: how much of your 5-hour limit the turn is expected to use, as a range,
with the bar before and after, and what it was worked out from:

```
 ≈ This turn ~3% of 5H (2-4%)  ▬▬▬▬▬▬▭▭ 62% → 65%
   Opus 5.5 · ctx 156k · cache cold +1%
```

It is hidden until it has learnt your rate in this session: once at least three turns have run and your 5-hour
percentage has moved by at least three points in total, it divides the points your limit moved by the work those turns
did (cache reads count little, cache writes and output count more, a model counts by its price relative to Sonnet). A
turn that started when the percentage was not known yet teaches nothing. The range is wider the less it has measured.
Terminals have no row under the prompt, so the estimate is drawn in the band directly above it, only while you have
typed something and nothing is running. It starts over when a new 5-hour window begins, and it is hidden once the
window it was learnt in has ended.

**A daily report** (`/quota report`): today's sessions, models and hours, with small bars. It opens in a side pane (docked
beside the conversation on a wide terminal, above the prompt on a narrow one); where no pane can be seated the command
prints it as text instead.

```
 Today's report
 2026-11-25 · 5H used 51% · 3 windows
 5 sessions · 1.8M tokens

 SESSIONS
 Refactor the checkout flow      Opus   ▬▬▬▬▬▬▬▬▬▬  22%
 Fix the cart rounding           Opus   ▬▬▬▬▬▬▭▭▭▭  14%
 Flaky checkout test             Sonnet ▬▬▬▬▭▭▭▭▭▭   9%

 BY MODEL
 Opus     ▬▬▬▬▬▬▬▬▬▬  36%
 Sonnet   ▬▬▬▬▭▭▭▭▭▭  13%

 BY HOUR
 14h  ▬▬▬▬▬▬▬▬▬▬  11%
 15h  ▬▬▬▬▬▬▬▭▭▭   8%

 14h is the busiest hour (11%). Opus is 71% of today's use.
```

*(The blocks above are text renderings of what the band, card and pane draw, with sample data.)* The percentages are the share of your 5-hour window that moved while Quota Coach was
running, attributed to the session, model and hour in which it moved (with several sessions open at once, a rise is
credited once, to the first turn that ends above it). The session list and token counts are read from your local
transcripts (every project's, today's newest 40), so sessions that ran without Quota Coach still appear, with tokens only.

## Commands

| Command | What it does |
| --- | --- |
| `/quota why` | Opens the "why did the last turn cost this?" card above the prompt. |
| `/quota report` | Opens today's report in a side pane, or prints it as text where no pane can be seated. |
| `/quota` | Says what the two commands are. |

## Options

All optional; the defaults are what most people want. Change them in `/config` or the plugin's settings.

| Option | Default | What it does |
| --- | --- | --- |
| `language` | `auto` | `auto`: Vietnamese when Claude Code's own language setting is Vietnamese, English otherwise. `en` or `vi` to force one. |
| `tips` | `true` | Show the one-line saving tips. |
| `estimate` | `true` | Show the pre-send estimate once it has learnt your rate. |
| `contextTipPercent` | `70` | How full the context window must be before the compact tip appears (30 to 95). |

## When something is missing

Quota Coach shows what it knows and stays quiet about the rest, never an error:

- **No 5-hour window** (an API key, a third-party provider, a plan without one): no percentages and no estimate. Tips that
  depend only on the conversation (full context, cold cache, subagents, model) still work, and the card and report count
  tokens.
- **No subagent list, no usage reading, a transcript that cannot be read**: that part is left out.
- **No pane** (an app or terminal that seats none): `/quota report` prints text instead.
- **Several Claude Code surfaces**: the band draws in the terminal, the desktop app and the mobile app.

## Requirements

A Claude Code with plugin function hooks; written and tested on 2.1.331. Older versions that do not know them simply do
not load it. Works on Windows, macOS and Linux. Needs nothing else: no Node, no git, no network.

## Privacy

Everything stays on your computer. Quota Coach reads your session's usage figures, and the local transcripts of today's
sessions (model, time and token counts of each reply, and each session's title) for the report; it keeps small
per-day totals in Claude Code's own plugin store. It sends nothing anywhere. Details in [PRIVACY.md](PRIVACY.md).
