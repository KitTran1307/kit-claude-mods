# Notify (kit-notify)

Look away while Claude works. Notify rings when it finishes or needs you, holds the prompts you type while it is busy
and sends them one at a time, and sums up what happened when you come back.

| What | How it looks |
| --- | --- |
| **A sound and a system notification** | When a turn that ran a while is done: "Claude finished · my-project" with the first line of Claude's answer. When Claude needs you (a permission prompt or a question): "Claude needs you · my-project" with what it asks. Two short original sounds, one for each. |
| **A queue for your next prompts** | While Claude works, put prompts in a list above the prompt box: numbered, a **×** button on each, **Send the first now**, **Pause** and **Clear all**. When Claude is free and you are not typing, the next one is sent, one at a time. |
| **A welcome-back card** | Come back after 10 minutes or more and something happened: "While you were away 25 min: 2 tasks done, 1 question waiting", one line each, with a **Dismiss** button. |

Screenshot description: the terminal with Claude mid-task and a rounded box above the prompt titled "Queue · 3 prompts
sent one at a time when Claude is free", three numbered rows each ending in a **×**, and the buttons *Send the first
now*, *Pause*, *Clear all* and *Queue what I typed* underneath; below it a second box, "Welcome back · away 25 min
(13:40 → 14:05)", with the summary line, two green check rows and one orange question row. Real screenshots come with
the first release.

## Install

```
/plugin install kit-notify --marketplace KitTran1307/kit-claude-mods
```

That is all: it works from the next session, with nothing to set up. In the desktop app: click + next to the prompt
box, then Plugins, Add marketplace with `KitTran1307/kit-claude-mods`, then Add plugin.

## The queue

While a turn runs you can add a prompt to the queue in either way:

- **Type it in the prompt box and press the button "Queue what I typed"** in the band. While Claude works and the box
  holds text, the band offers it in one row; once the queue has something the button is part of the list. The text moves
  into the queue and the box is emptied, only when it really was queued (a full queue or a prompt over 4000 characters leaves
  it in the box and says why).
- **`/queue add <text>`**, or just `/queue <text>`. It runs at once, even in the middle of a turn.

Then it sends itself. Each queued prompt goes out when the turn ends, **only when**:

- the queue is not paused,
- no permission prompt or question is open,
- you are not in the middle of typing something (it waits until the box is empty),
- you did not stop Claude (pressing Escape pauses the queue, so nothing is sent behind your back).

| Command | What it does |
| --- | --- |
| `/queue add <text>` (or `/queue <text>`) | Adds a prompt (up to 20, 4000 characters each). Idle Claude takes it at once. |
| `/queue` or `/queue list` | Shows the numbered list. |
| `/queue remove <n>` | Removes number `n`. |
| `/queue clear` | Removes all. |
| `/queue pause` and `/queue resume` | Holds the queue, and lets it go on. |
| `/queue next` | Sends the first one now (it still waits for Claude to be idle), even when paused. |

A queued prompt is sent as your own words, exactly as typed. (Like any prompt sent by a plugin, `@file` mentions and pasted
images are not expanded in it.) `/queue` answers are shown to you only and are not added to what Claude reads, so a queued
prompt stays private until it is sent. The queue lives in the session: it is gone when the session ends. On a short terminal the band shrinks to one line (the next prompt, *Send the first now*, *Clear all*).

## Notifications and sounds

- **Done:** only when the turn ran at least `notifyAfterSec` seconds (20 by default), so quick answers stay quiet. Not for a
  turn you stopped or one that failed.
- **Needs you:** a permission prompt or a question waiting for you. Always, however short the turn.
- **Not while you are typing:** if you edited the prompt box in the last 8 seconds (3 for a question waiting for you),
  nothing rings. Claude Code does not tell a plugin whether its window is in front, so a keystroke is the closest it can
  know; where an app reports no edits, this never applies and alerts always ring.
- **Quiet hours:** set `quietHours` (for example `22:00-07:00`) and nothing rings then.

The notification goes through your terminal's or the app's own notification channel. If there is none, a short message
shows inside Claude Code instead. The sound plays with what your system already has, and stays silent where it cannot:

| System | How the sound plays |
| --- | --- |
| macOS | Claude Code's own audio player. |
| Windows | Windows' built-in sound player (PowerShell). |
| Linux | `paplay`, `aplay` or `canberra-gtk-play`, the first that is installed. |
| Anything else | Silent; the notification still shows. |

Both sounds are small original tones made for this plugin (`sounds/make-sounds.mjs` generates them).

## Welcome back

When you type or send something after at least `awayMin` minutes of not doing either (10 by default; a prompt from a schedule,
a background task or another session does not count as you), and a task
finished or a question came while you were gone, a card sums it up: the minutes away and the times, the counts, then one
line per question (first) and finished task, built from what Claude Code reported on this computer. **Dismiss** closes it.
It does not show when you came back within a minute of the notification, when nothing happened, or for a short
break. A question you already answered is not counted.

## Options

Set in `/config` or the plugin's settings. Every option has a working default.

| Option | Default | What it does |
| --- | --- | --- |
| `sound` | on | Play a sound when Claude finishes or needs you. |
| `notify` | on | Show a system notification (an in-app message when there is no channel). |
| `notifyAfterSec` | 20 | A finished turn rings only after at least this many seconds. 0 rings after every turn. Needs-you always rings. |
| `notifyDetails` | on | Put the first line of Claude's answer or question in the notification. Off: a fixed line that says nothing about your work. |
| `quietHours` | empty | No sound or notification between these local times, e.g. `22:00-07:00`. Empty means never quiet; text that is not two times is ignored. |
| `awayMin` | 10 | Minutes away before the welcome-back card can show. 0 turns the card off. |
| `showQueueButton` | on | Show the "Queue what I typed" row while Claude works. Off: only `/queue` and a non-empty queue show. |
| `language` | auto | `auto` follows Claude Code's own language setting (Vietnamese or else English), `en` or `vi` forces one. |

## Good to know

- **Terminal, desktop app, mobile:** the band and card draw in all of them. Where the app has no notification channel or
  no sound player, those parts quietly do nothing. Whether you are typing is known where Claude Code reports prompt-box
  edits (the terminal); elsewhere the queue still sends one prompt at a time, but it cannot see a half-typed draft.
- **Remote Control and mobile:** sounds play on the computer that runs Claude Code, and notifications use whatever channel
  that session has.
- **Other bands:** the queue and the card stack with the bands of your other plugins and share the prompt's height.
- **Permission prompts and questions** are never answered by this plugin.
- **Older Claude Code:** a part the running version cannot draw, play or detect is skipped without an error. Without the
  plugin's folder path (older versions) Windows and Linux stay silent and the notification still shows.
- **Time:** quiet hours and the card's times use this computer's local time.

## Privacy

The plugin makes no network requests, collects nothing and writes no file of its own. It reads the text of the prompt box
(to see whether you are typing, and to queue it when you press the button), what Claude Code reports about finished turns,
permission prompts and questions, and its `language` setting. A line of Claude's answer can appear in a system notification
and in the card (turn it off with `notifyDetails`); a notification goes through the channel Claude Code uses for the
session, which in the desktop app or with Remote Control may be that app's own, not just your terminal. The queue and the
card are held in the session's memory only. See [PRIVACY.md](PRIVACY.md).
