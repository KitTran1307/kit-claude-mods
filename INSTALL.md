# Installing kit-claude-mods (instructions for Claude)

These steps are written for Claude Code to follow when a person asks it to install one or more of these plugins.
A person can follow them too. Install only the plugins the person asked for; if they said "all", that is
`kit-cloud`, `kit-statusbar` and `kit-todos`.

## 1. Check the machine

Run these and note the results (Windows: Git Bash or PowerShell both work):

```
claude --version
node --version     # only kit-cloud needs Node (18 or newer)
gh --version       # only kit-cloud needs the GitHub CLI
gh auth status     # kit-cloud: must show a signed-in account
```

- Claude Code missing or very old: tell the person to update Claude Code first (`claude update`), then stop.
- kit-cloud asked for but Node < 18 or missing, or `gh` missing or signed out: install the other plugins, then tell
  the person exactly what kit-cloud still needs (https://nodejs.org, https://cli.github.com, `gh auth login`).
  Do not install Node or gh, and never run `gh auth login` for them: signing in is theirs to do.

## 2. Install

From a shell (works the same on every OS):

```
claude plugin install <plugin> --marketplace KitTran1307/kit-claude-mods
```

once per plugin. The first one adds the marketplace. If the command asks a question it cannot answer
non-interactively, give the person the in-session line instead and let them run it:
`/plugin install <plugin> --marketplace KitTran1307/kit-claude-mods`.

Already installed? `claude plugin update <plugin>` brings it to the newest version.

## 3. Verify

Run these yourself (shell commands), and report what they printed:

- `claude plugin list` shows each installed plugin as enabled; note the folder it lists for kit-cloud.
- kit-cloud: it installs kit-cloud-pilot with it; `node "<kit-cloud-pilot folder>/bin/cloud-pilot.mjs" doctor` prints
  one JSON line: `"ok": true`, or `problems` that say what is missing.
- kit-todos and kit-cloud: `claude -p "/todo"` and `claude -p "/cloud"` print the plugin's answer (in Git Bash on
  Windows, put `MSYS_NO_PATHCONV=1 ` before the command so `/todo` is not turned into a path).

Slash commands typed in a session are the person's to run, not yours: do not claim you ran them. Tell the person to
start a new session (or type `/reload-plugins`) and try `/todo` and `/cloud` there.

- kit-statusbar: it appears above the prompt in the person's next session, in the desktop app always and in the
  terminal unless they already have a status line set up there (its `surfaces` option changes that).

## 4. Tell the person

One short message: what was installed, what each one shows and where, the one command to try for each (`/todo`,
`/cloud`), anything still missing (for kit-cloud), and that options live in `/config`.

## Notes

- Options are per plugin; see each plugin's README for the list and the `pluginConfigs` form for settings.json.
- Nothing in these plugins sends data anywhere; see SECURITY.md.
- To remove one: `/plugin uninstall <plugin>` (kit-cloud-pilot: also `cloud-pilot stop` and delete
  `~/.claude/cloud-pilot`).
