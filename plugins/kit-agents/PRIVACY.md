# Privacy: kit-agents

kit-agents reads only the live list of subagents of your current Claude Code session (their names, types, models,
progress lines, token counts and start times) and draws it on your screen.

- It stores nothing on disk and keeps nothing after the session ends.
- It sends nothing anywhere: no network, no telemetry, no analytics.
- It does not read your files, your prompts, your conversation, your login or any secret.
- The only things it changes are what it draws (a pane or a band) and, when you press Reply, which conversation the
  main view shows.
