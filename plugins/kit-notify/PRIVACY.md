# Notify privacy policy

Last updated: 2026-11-25.

Notify (kit-notify) is a Claude Code plugin that plays a sound and shows a notification when Claude finishes or needs
you, keeps a queue of prompts, and shows a welcome-back card. It runs entirely on your own computer, inside Claude Code.

## What it reads

- Events Claude Code reports to it: a turn finished (its length and the first line of its answer), a permission prompt or
  question is waiting (its text), a tool ran, you typed or sent something (the time, never the keys).
- The text of the prompt box: to see whether you are in the middle of typing before it sends a queued prompt, and to put
  it in the queue when you press "Queue what I typed".
- Claude Code's own `language` setting, once at session start, only to choose English or Vietnamese.
- The name of the current project folder and the plugin's own options.
- On an older Claude Code that cannot say which system this is, the `OS` environment variable and the output of `uname -sr`, and the plugin folder's location, to find its own sound file.

It does not read your files, your conversation history, your login or any token.

## What it stores

Nothing of its own on disk (Claude Code may create the plugin's data folder when it asks for the plugin's location). The queue and the welcome-back card are held in the session's memory and are gone when the session
ends. A line of Claude's answer is shown in the system notification and in the card only if you leave `notifyDetails` on;
the notification system of your computer may keep it in its history, and in the desktop app or with Remote Control the
notification goes through that app's own channel (the plugin does not choose it).

## What it runs

To play its own sound file on Windows or Linux it starts the system's own player (`powershell`, `paplay`, `aplay` or
`canberra-gtk-play`) on a file inside the plugin (and `uname` once, on an older Claude Code, to learn the system). Nothing else.

## Network and sharing

None. It makes no network requests and sends no data to anyone, including its authors.

## Contact

Open a private security advisory at https://github.com/KitTran1307/kit-claude-mods/security/advisories/new.
