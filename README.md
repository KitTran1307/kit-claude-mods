# kit-claude-mods

[![CI](https://github.com/KitTran1307/kit-claude-mods/actions/workflows/ci.yml/badge.svg)](https://github.com/KitTran1307/kit-claude-mods/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Windows · macOS · Linux](https://img.shields.io/badge/os-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555.svg)](#)

Three small mods for [Claude Code](https://claude.com/claude-code) that add what the interface leaves out. They work
in the CLI and in the Claude desktop app, on Windows, macOS and Linux.

| Plugin | What you get | Needs |
| --- | --- | --- |
| [**kit-cloud**](plugins/kit-cloud) | A band above the prompt with your **cloud sessions**: working, asking you something, PR open, CI failed, silent, each with its link. `/cloud` for the table. | Node 18+, GitHub CLI `gh` signed in |
| [**kit-statusbar**](plugins/kit-statusbar) | A **status bar** for the desktop app (which has none) and the CLI: repo, model, effort, context use, account, session title, 5-hour and weekly limits with reset countdowns. | nothing |
| [**kit-todos**](plugins/kit-todos) | Your project's **open to-dos** above the prompt, most urgent first, with *Do it now* and *Draft* buttons, plus the project's newest memories. `/todo` to add and finish tasks. | nothing |

All three together in the Claude Code CLI (real screenshot, demo data):

![kit-cloud, kit-statusbar and kit-todos above the prompt in the Claude Code CLI](docs/images/terminal-bands.png)

Each one is independent: install only what you want. When several are installed their bands stack above the prompt
and share its height.

## Install

### Let Claude do it

Paste this into a Claude Code session:

> Install the kit-cloud, kit-statusbar and kit-todos plugins from the KitTran1307/kit-claude-mods marketplace,
> following https://github.com/KitTran1307/kit-claude-mods/blob/main/INSTALL.md

Claude follows [INSTALL.md](INSTALL.md): it checks what your machine has, installs, and verifies each plugin.

### By hand

In a Claude Code **terminal** session (answer `y` to add the marketplace, then pick the scope, user is the usual one):

```
/plugin install kit-cloud --marketplace KitTran1307/kit-claude-mods
/plugin install kit-statusbar --marketplace KitTran1307/kit-claude-mods
/plugin install kit-todos --marketplace KitTran1307/kit-claude-mods
```

From a shell instead:

```
claude plugin install kit-todos --marketplace KitTran1307/kit-claude-mods
```

In the **desktop app**, where `/plugin` is not available: click **+** next to the prompt box → **Plugins** →
**Add marketplace** → `KitTran1307/kit-claude-mods` → **Add plugin**, and pick the ones you want. A plugin installed
from a terminal at the user scope also loads in the desktop app's local sessions.

New sessions pick the plugins up; in the session where you installed them they are active right away.

### Update and remove

```
claude plugin update kit-todos            # then /reload-plugins in an open session
/plugin uninstall kit-todos
```

## Options

Every plugin has options (which surfaces to draw on, where the to-do file lives, ...). Change them in `/config`, or in
`~/.claude/settings.json`; each plugin's README lists them.

## Privacy

Nothing here sends data anywhere. kit-statusbar and kit-todos read local files only (this session's transcript, your
login record for the email, your to-do file and memory folders). kit-cloud-pilot (which kit-cloud draws) talks to GitHub through your own `gh`
login and nothing else. See [SECURITY.md](SECURITY.md).

## Development

Each plugin is a Claude Code hooks module (`hooks/register.tsx`) with its tests beside it.

```
claude --plugin-dir plugins/kit-todos         # run a plugin from this folder in one session
claude plugin validate plugins/kit-todos      # what the engine sees and would refuse
claude plugin test plugins/kit-todos          # the plugin's tests against the engine
```

Claude Code writes the engine's type definitions into `plugins/<name>/.claude-plugin/types/` the first time it loads a
plugin from a folder (gitignored); after that `npx -p typescript tsc -p plugins/<name>` type-checks it.

## License

[MIT](LICENSE)
