# kit-graphite

A graphite theme for the Claude desktop and mobile apps.

- **Colors:** neutral charcoal grays in both modes, with a black accent in light mode and an ivory one in dark mode. Red, green and amber keep their meaning, toned down to fit.
- **Backdrop:** a field of dots behind the conversation, frozen mid-wave (crests are big bright dots, troughs tiny dim ones), with small bright motes drifting up through it on a slow sway. Only small things move, so it stays smooth at the display's own rate without slowing the app.
- **Character:** a small clay-colored pixel comet with blinking eyes rises from the bottom of the middle column, shrinking into the distance, then circles the middle of the screen, its pixel tail always streaming back along the flight. It is an original drawing, not Anthropic's logo or mascot.

With the system's reduce-motion setting on, the dots and the character stand still. The terminal and editors draw no theme.

Dots are drawn only in the middle, between the app's sidebars, which cover the sides. A frosted pane with crisp edges sits behind the message column so text reads easily; it is placed for the usual layout and can sit a little off if the window is resized.

## Install

Needs Claude Code 2.1.326 or later (2.1.323 for the theme alone); on an earlier version the app simply keeps its own look, with no error.

At the prompt of a terminal session:

```
/plugin install kit-graphite --marketplace KitTran1307/kit-claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `KitTran1307/kit-claude-mods`, then Add plugin.

The theme applies when a session starts. To go back to the app's own look, disable or uninstall the plugin, or use `/graphite off` (below).

## Commands

| Command | What it does |
| --- | --- |
| `/graphite off` | Turns the look off and remembers it for later sessions. The plugin then draws nothing and sets no theme, so Claude's default look shows. Where the running session can put the default look back, it does so at once; otherwise the reply says it takes effect from the next session. |
| `/graphite on` | Turns the look on again (the default) and remembers it. |
| `/graphite status` | Says whether Graphite is on or off. |
| `/graphite doctor` | Checks the setup and prints one line per check, then a summary. It only reads and changes nothing. It never runs the Python script; for the version check it may run `claude --version`, which only prints a version. |

If the remembered choice cannot be read or saved, Graphite stays on and carries on quietly; the reply says when a choice could not be saved.

### `/graphite doctor`

Each line is `PASS <name> - <detail>`, `WARN <name> - <detail> Fix: <hint>` or `FAIL <name> - <detail> Fix: <hint>`. It checks:

- `claude-code`: your Claude Code version against 2.1.323, the first that accepts a theme. If the version cannot be read, it says so (a WARN, never an error).
- `setting`: whether the remembered on/off choice can be read.
- `theme`: what this session found out when it set the theme: drawn by an app, waiting for the desktop or mobile app, nothing here to draw it (a terminal-only session), or refused by an older Claude Code.
- `terminal-image` and `terminal-script`: whether `terminal/terminal-backdrop.png` and `terminal/add-to-windows-terminal.py` are in the plugin. They are optional extras for Windows Terminal, so a missing one is a WARN, and the script is only looked for, never run.

## In the terminal (Windows Terminal)

The terminal draws no theme, so `terminal/` holds a matching look for Windows Terminal: the "Kit Graphite" color scheme and a still backdrop of the dot field with the comet. `python terminal/add-to-windows-terminal.py` backs up Windows Terminal's settings, then adds the scheme and a "Claude Kit" profile (PowerShell 7 when installed, else Windows PowerShell; opens in your home folder; backdrop at 35%); existing profiles and the default stay as they are. It finds the settings of the Store, Preview, Canary and unpackaged installs by itself.
