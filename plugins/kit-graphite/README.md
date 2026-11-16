# kit-graphite

A graphite theme for the Claude desktop and mobile apps.

- **Colors:** neutral charcoal grays in both modes, with a black accent in light mode and an ivory one in dark mode. Red, green and amber keep their meaning, toned down to fit.
- **Backdrop:** a field of dots behind the conversation, frozen mid-wave (crests are big bright dots, troughs tiny dim ones), with small bright motes drifting up through it on a slow sway. Only small things move, so it stays smooth at the display's own rate without slowing the app.
- **Character:** a small clay-colored pixel comet with blinking eyes rises from the bottom of the middle column, shrinking into the distance, then circles the middle of the screen, its pixel tail always streaming back along the flight. It is an original drawing, not Anthropic's logo or mascot.

With the system's reduce-motion setting on, the dots and the character stand still. The terminal and editors draw no theme.

Dots are drawn only in the middle, between the app's sidebars, which cover the sides. A frosted pane with crisp edges sits behind the message column so text reads easily; it is placed for the usual layout and can sit a little off if the window is resized.

## Install

Needs Claude Code 2.1.323 or later for the theme; on an earlier version the app simply keeps its own look, with no error.

At the prompt of a terminal session:

```
/plugin install kit-graphite --marketplace KitTran1307/kit-claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `KitTran1307/kit-claude-mods`, then Add plugin.

The theme applies when a session starts. To go back to the app's own look, disable or uninstall the plugin.

## In the terminal (Windows Terminal)

The terminal draws no theme, so `terminal/` holds a matching look for Windows Terminal: the "Kit Graphite" color scheme and a still backdrop of the dot field with the comet. `python terminal/add-to-windows-terminal.py` backs up Windows Terminal's settings, then adds the scheme and a "Claude Kit" profile (PowerShell 7 when installed, else Windows PowerShell; opens in your home folder; backdrop at 35%); existing profiles and the default stay as they are. It finds the settings of the Store, Preview, Canary and unpackaged installs by itself.
