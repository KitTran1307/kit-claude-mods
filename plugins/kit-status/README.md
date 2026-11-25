# Status Dot (kit-status)

See at a glance which sessions need you. Status Dot puts a colored dot at the start of each session's name in the
Claude desktop app's sidebar and moves it as the session works.

| Dot | When |
| --- | --- |
| 🔵 | Claude is working on a turn. |
| ⏳ | Claude stopped, but a background command (`run_in_background`) or a background agent is still running and will wake it. |
| 🟠 | Claude is waiting for you: it asked a question, or its last reply ends on one. |
| ✅ | Claude finished and nothing is waiting. |

## Install

```
/plugin install kit-status --marketplace KitTran1307/kit-claude-mods
```

That is all: sessions you start or resume afterwards get the dot, with nothing to set up. In the desktop app: click +
next to the prompt box, then Plugins, Add marketplace with `KitTran1307/kit-claude-mods`, then Add plugin.

## Good to know

- Only the desktop app has a sidebar. In the terminal, an editor or a cloud session the plugin does nothing.
- It renames the session itself, through the app's own session tools, so the dot also shows in the session list on the
  phone. Remove the dot by hand at any time; it comes back at the next turn.
- If the app would ask you to approve a rename (a title you typed yourself, outside bypass mode), the plugin stops
  renaming that session instead of asking every turn.
- "Waiting for you" is read from the last reply: one that ends on a question counts, so a rhetorical question at the
  end shows 🟠 too.
- A background command that never reports back stops counting after two hours.
- No network, no model calls, nothing stored.
