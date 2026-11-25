# Themes (kit-themes)

Three original themes for the Claude desktop and mobile apps, chosen by one command. Install it and you already have
one: by default it follows the app's light or dark mode.

| Theme | Look | Contrast (main text on the page) |
| --- | --- | --- |
| **Paper** | Warm cream paper with dark brown text and a rust accent. Easy on the eyes by day, bright in a dark room. | 14.3 : 1 |
| **High Contrast** | Pure black with white text and a yellow accent. Text and status colors reach WCAG AAA (7 : 1 or better) as the app paints them; the lowest is 10.3 : 1. It looks stark, with fewer shades. | 21.0 : 1 |
| **Night** | Dark warm browns with cream text and an amber accent, low in blue light, for evenings. | 13.9 : 1 |

Screenshot description: the desktop app with the sidebar, a short chat, a code block and the message box, shown in each
theme. Paper is cream with brown ink, High Contrast is black with white and yellow, Night is dark brown with amber.
Real screenshots come with the first release.

The numbers are checked by the repository's CI (`scripts/contrast.mjs`): main text must reach 7 : 1 and secondary text
4.5 : 1 in every theme, and High Contrast must reach 7 : 1 on every pair. The full table is in `docs/contrast.md`.

## Install

```
/plugin install kit-themes --marketplace KitTran1307/kit-claude-mods
```

That is all: the theme applies when a session starts. It needs Claude Code 2.1.323 or later; on an older version the app
simply keeps its own look, with no error. In the desktop app: click + next to the prompt box, then Plugins, Add
marketplace with `KitTran1307/kit-claude-mods`, then Add plugin.

## Choose a theme

| Command | What it does |
| --- | --- |
| `/themes auto` | The default. Paper when the app is in light mode, Night when it is in dark mode. |
| `/themes paper` | Always Paper (light), whatever the app's mode. |
| `/themes contrast` | Always High Contrast. |
| `/themes night` | Always Night (dark). |
| `/themes off` | No theme: Claude's own look. Clears the theme this plugin set. |
| `/themes` | Says which theme is in use. |

Your choice is remembered for later sessions. A few other words work too, such as `high-contrast`, `dark`, `light`
and the Vietnamese names (`giấy`, `đêm`, `tương phản cao`, `tự động`, `tắt`).

## Options

Set in `/config` or the plugin's settings. Every option has a working default.

| Option | Default | What it does |
| --- | --- | --- |
| `theme` | `auto` | The theme to start with (`auto`, `paper`, `contrast`, `night`, `off`). A choice made with `/themes` is remembered and wins over this. |
| `language` | `auto` | Language of `/themes`: `auto` follows Claude Code's own language setting (Vietnamese or else English), `en` or `vi` forces one. |

## Good to know

- **Motion and sound:** nothing moves and nothing plays, so the system's reduce-motion setting changes nothing here.
- **Terminal:** a terminal draws no themes. `/themes` there says so plainly; your choice still shows in the desktop and mobile apps.
- **Other themes:** a session has one theme at a time. If you also use another theme plugin (for example kit-graphite), the one set last wins; `/themes off` clears the session's theme only when this plugin set one earlier.
- **Permission prompts** always keep the app's own look.
- Sidebars, code blocks and borders follow the app's own shades of the palette, so they can differ a little from the preview; the app builds code colors from the status colors, and High Contrast borders are the app's own.

## Privacy

Nothing is sent anywhere and nothing is collected. The plugin reads Claude Code's own `language` setting (to pick
English or Vietnamese) and its own saved choice, and writes that one choice when you use `/themes`. See [PRIVACY.md](PRIVACY.md).
