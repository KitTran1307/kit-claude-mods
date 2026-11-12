# kit-todos

A to-do band for Claude Code. When you open a session it shows the open tasks of the project you are in, most
urgent first, in a band above the prompt. One press hands a task to Claude ("Do it now"), drafts it into the prompt
("Draft"), hides the band for the day ("Hide today") or opens a full list ("Open list"). The tasks live in one plain
JSON file you control, shared by every project and every Claude Code surface on your machine. The same plugin adds
a `/todo` command, a pane with the whole list, a task count in the status line, and the project's latest memory.
Claude can also suggest follow-up tasks for you to add or dismiss, and the whole interface can be in Vietnamese.

![The kit-todos band above the prompt in the Claude Code CLI](https://raw.githubusercontent.com/KitTran1307/kit-claude-mods/main/docs/images/terminal-bands.png)

`/todo` (or **Open list**) opens the whole list beside the conversation:

![The to-do pane: every open task with Do it now, Draft and Done](https://raw.githubusercontent.com/KitTran1307/kit-claude-mods/main/docs/images/todo-pane.png)

*Real screenshots of Claude Code on demo data.*

```
╭───────────────────────────────────────────────────────────────╮
│ ✻ Tasks for my-app                         2 tasks, 1 overdue │
│ ╭────────────────────────────╮ ╭────────────────────────────╮ │
│ │ ● Overdue                  │ │ ● Due soon                 │ │
│ │ Fix the login redirect     │ │ Write the release notes    │ │
│ │ overdue 2 days (Sat Nov 7) │ │ tomorrow, Tue Nov 10       │ │
│ │ [ Do it now ] [ Draft ]    │ │ [ Do it now ] [ Draft ]    │ │
│ ╰────────────────────────────╯ ╰────────────────────────────╯ │
│ ● Overdue  ● Due soon  ● Scheduled  ● No date  ● Done         │
│ Latest memory: Release checklist, 4 saved                     │
│ [ Open list ] [ Hide today ]                                  │
╰───────────────────────────────────────────────────────────────╯
```

The band sizes itself to the room it is given: cards when there is space, one row per task in a short terminal,
and a single line when there is almost no room. It never scrolls.

## Requirements

- A recent Claude Code with plugin hooks modules. The one-line installs below need 2.1.275 or later in a session
  (`/plugin install … --marketplace`) and 2.1.292 or later from a shell (`claude plugin install … --marketplace`).
- The Claude Code CLI or the Claude desktop app, on Windows, macOS or Linux.
- Nothing else: no Node, no Python, no account. The plugin only reads and writes your todos file and reads the
  project's memory index; it uses no network.

## Install

- In a terminal session:

  ```
  /plugin install kit-todos --marketplace KitTran1307/kit-claude-mods
  ```

  Answer `y` to add the marketplace, pick a scope, and set the options on the screen that follows (or accept the defaults).

- From a shell (Claude Code 2.1.292 or later):

  ```
  claude plugin install kit-todos --marketplace KitTran1307/kit-claude-mods
  ```

- In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with
  `KitTran1307/kit-claude-mods`, then **Add plugin** and pick `kit-todos`.

- Let Claude do it: tell Claude "Install the kit-todos plugin from the KitTran1307/kit-claude-mods marketplace".
  The repository has an `INSTALL.md` that Claude follows.

The plugin is active in the session you installed it from, and in every session you start afterwards.

## Options

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `todosFile` | string | `~/.claude/kit-todos/todos.json` | The JSON file that holds your tasks. `~` and `~/` mean your home folder, a relative path is taken from your home folder, and both `/` and `\` work. A missing file is an empty list; the first `/todo add` creates it. |
| `soonDays` | number | `2` | A task due within this many days is "Due soon". Whole number from 0 to 30; anything else becomes 2. |
| `showBand` | boolean | `true` | `false` never draws the band. The `/todo` command, the pane and the count in the status line keep working. |
| `showMemories` | boolean | `true` | Show the project's newest memory in the band and the latest ones in the pane. |
| `memoriesAllProfiles` | boolean | `false` | Read memories from every account profile (`~/.claude` and each `~/.claude-*`), not just the current one. Off by default so one account's memories never show in another's session. |
| `allowSuggestions` | boolean | `true` | `true` gives Claude a tool to propose follow-up tasks, which wait for your approval (see [Tasks Claude suggests](#tasks-claude-suggests)). `false` gives Claude no such tool, and `/todo` stops mentioning suggestions. |
| `language` | string | `auto` | `auto`, `en` or `vi`. `auto` uses Vietnamese when Claude Code's own `language` setting is Vietnamese (for example `Vietnamese`, `vi` or `Tiếng Việt`), looked up once when the session starts, and English otherwise or when it cannot be read. `en` and `vi` fix the language. See [Language](#language). |

Set them in any of these ways:

- At install time, on the screen the terminal shows.
- Later, in the `/config` menu: each option is a row. A change reloads the plugin at once.
- Or in `~/.claude/settings.json` (this works everywhere, including the desktop app). Options are stored under
  `pluginConfigs`, keyed by the plugin's id, which is its name and its marketplace, `kit-todos@kit-claude-mods`:

  ```json
  {
    "pluginConfigs": {
      "kit-todos@kit-claude-mods": {
        "options": {
          "todosFile": "~/Documents/todos.json",
          "soonDays": 3,
          "showBand": true,
          "showMemories": false,
          "allowSuggestions": true,
          "language": "auto"
        }
      }
    }
  }
  ```

  Only the options you list change. `claude plugin configure kit-todos` shows the options and which are unset.

## Commands

| Command | What it does |
| --- | --- |
| `/todo` | Opens the pane and lists this project's open tasks, numbered, with the path of the todos file. Also shows the band again if you hid it. |
| `/todo add <task>` | Adds a task for the current project to the file. The first one creates the file. |
| `/todo done <number>` | Marks a task done, using its number in the last `/todo` list of this session. It stays visible in the pane for 24 hours. |
| `/todo claim` | Links the open tasks for this folder name to this repository. Use it for tasks created before version 1.3 (other folders with the same name stop showing them) and for tasks hidden after you moved this repository or changed its remote. `/todo` tells you when this is needed. |
| `/todo suggestions` | Lists the tasks Claude has suggested and you have not yet added or dismissed, numbered. |
| `/todo accept <number>` / `/todo accept all` | Adds that suggestion (or all of those listed) to the todos file, with its date and note. |
| `/todo reject <number>` / `/todo reject all` | Dismisses that suggestion (or all of those listed). Nothing is written. |

Without a task or a number, `/todo add` and `/todo done` print their usage and change nothing. The number in
`/todo done` always refers to the last `/todo` list in this session, even if another session has changed the list
since. In a new session, run `/todo` first. If that task is no longer in the file, nothing is changed and the reply
says so.

`/todo accept` and `/todo reject` use the numbers of the last `/todo suggestions` list of this session, like `/todo done`
does for `/todo`: run `/todo suggestions` first. `all` means the suggestions that list showed, so one that arrived
after it is never added unseen. With `allowSuggestions` off, these three commands are not available.

Buttons: **Do it now** sends the task to Claude as a prompt (and hides the band for the day), **Draft** only puts it
in the prompt box so you can edit it first, **Done** (in the pane) marks it done, **Open list** opens the pane,
**Hide today** hides the band until tomorrow. The pane draws 50 open tasks at first; **Show more** draws 50 more.

**Do it now** sends at once only when the card shows everything the prompt carries. When the task has a `note`, text
longer than the card shows, wider than a one-line list row shows (a short terminal), or on several lines, an `id` outside letters, digits, `.`, `_` and `-` (64 at most), or invisible characters
(control, zero-width or bidi marks), it drafts the whole prompt into the prompt box instead, so you read it before you
send it. This keeps a todos file edited by someone else, or imported, from slipping instructions you never saw to Claude.

The prompt Claude receives names your todos file and asks it to set `"done": true` and `"doneAt"` (the current UTC
time) on that task once it is finished and verified, and to ask you before it decides anything on your behalf.

## Tasks Claude suggests

Claude often ends a session with follow-up work it found but did not do: something out of scope, too large, or
needing your decision. With `allowSuggestions` on (the default), Claude gets a tool, `propose_todo`, to hand such a
task to you instead of leaving it in the chat. The tool description tells Claude to use it only for work it is **not**
doing now, once per task, and never for work it is about to do.

- **Nothing is saved until you approve.** The tool does not touch your todos file. It only puts the task on a card
  above the prompt: `Claude suggests: <task>` with **Add** and **Dismiss**. The pane shows the same cards.
- **Add** saves the task like `/todo add` does (same file, same lock, same format) and keeps its date and note. You get
  a notification, and the card goes. **Dismiss** removes the card and writes nothing. `/todo suggestions`,
  `/todo accept <number|all>` and `/todo reject <number|all>` do the same from the keyboard. A toast tells you each
  time Claude makes a suggestion, so you notice one even when the band is hidden.
- **You see what you save.** A suggestion is one line of at most 200 characters, with an optional date (`YYYY-MM-DD`,
  a real day) and note (300 characters at most). Invisible characters (control, zero-width and bidi marks) are removed
  and white space is tidied before the card is drawn, so the card shows exactly the text that **Add** saves. The band
  draws a card only when the whole of it fits, so **Add** is never next to text you could not read; in a very short
  terminal it shows one line, "N tasks suggested by Claude", and **Review** opens the pane with the full cards.
  A task with a note still makes **Do it now** draft the prompt for you to read first, as any task with a note does.
- **Privacy.** Suggestions live only in the session, in memory, until you add or dismiss them. They are not written
  anywhere and are gone when the session ends. At most 10 wait at once (Claude is told to put the rest in its message);
  a suggestion with the same text as one already waiting (ignoring case) is not added twice.
- **Hide today** hides the task list but not suggestions, because they wait for a decision. They also stay out of the
  way while Claude is working or a question dialog is open, like the rest of the band.

## Language

The band, the pane, the status line, the buttons, dates, notifications and every reply of `/todo` can be in English or
Vietnamese (`language` option). Vietnamese uses short wording for non-technical users, dates as `T2 9/11` ("hôm nay,
T2 9/11", "quá hạn 2 ngày (T7 7/11)") and the count as "4 việc, 1 quá hạn". Command words stay as they are
(`/todo add`, `done`, `claim`, `suggestions`, `accept`, `reject`). Two things stay in English on purpose because Claude,
not you, reads them: the prompt that **Do it now** and **Draft** send, and what the `propose_todo` tool says to Claude.
Your own task texts are shown as you wrote them.

## The todos file

A JSON array of tasks. Edit it by hand, let Claude edit it, or use `/todo add`.

```json
[
  { "id": "t1", "text": "Fix the login redirect", "project": "my-app", "due": "2026-11-07", "done": false },
  { "id": "t2", "text": "Write the release notes", "note": "Use CHANGELOG.md as the source.", "project": "my-app", "due": "2026-11-10", "done": false },
  { "id": "t3", "text": "Renew the domain", "done": false },
  { "id": "t4", "text": "Deploy the preview", "project": "my-app", "done": true, "doneAt": "2026-11-08T20:00:00.000Z" }
]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A non-empty string; keep it to letters, digits, `.`, `_` and `-` (64 at most), or **Do it now** drafts instead of sending. Claude is told this id when you hand it a task. Make them unique; repeats still work (see below). |
| `text` | yes | The task. Long text is shortened on screen, but Claude gets all of it. |
| `note` | no | Extra detail sent to Claude with the task. |
| `project` | no | The folder name of the project's git repository (or of the working folder when it is not a repository), compared ignoring case. Used to find the task only when it has no `repo`. A task with neither `project` nor `repo` shows in every project. |
| `repo` | no | The repository the task belongs to; `/todo add` and `/todo claim` set it. It is `git:<host>/<owner>/<name>` from the `origin` remote, so the task stays with the repository when you rename or re-clone the folder. Without a remote it is `path:<folder>`. When set, the task shows only in that repository. |
| `due` | no | A day, `YYYY-MM-DD`. Anything else (`2026-11-9`, `2026-02-30`, `tomorrow`) counts as no date. |
| `done` | no | `true` when finished. Anything but `true` means open. |
| `doneAt` | no | When it was marked done, an ISO 8601 UTC time. Done tasks show in the pane for 24 hours after this. |

Status labels: **Overdue** (due before today), **Due soon** (due within `soonDays`), **Scheduled** (due later),
**No date**, **Done**. Tasks are ordered most urgent first, then by due date, then in file order. Dates are read in
your machine's local time, and written in English or Vietnamese by the `language` option ("today, Mon Nov 9",
"tomorrow, Tue Nov 10", "overdue 2 days (Sat Nov 7)", "Fri Nov 13").

## Data safety

- A todos file that cannot be parsed (broken JSON, or JSON that is not a list) is never overwritten. A notification
  says why, `/todo` and the pane show a warning, and nothing is written until you fix the file.
- Entries the plugin cannot show (no `id`, no `text`, not an object) are left exactly as they are when it writes.
  It only adds entries (`/todo add`, or **Add** / `/todo accept` on a suggestion you approved), sets `done` and
  `doneAt` (`/todo done`, **Done**) or sets `repo` (`/todo claim`). It never deletes or reorders entries.
- Several sessions can save the list at the same time. They take turns using a small lock file next to it
  (`todos.json.lock`, safe to delete when no session is saving). After saving, a session checks that its change is in
  the file. If someone else (an editor, or Claude finishing a task) saved over it at that moment, the change is
  applied again. If the lock stays busy for a few seconds, nothing is saved and you are told.
- "Done" marks the entry you picked, even when several share an id. If the file changed since the list was shown
  and the plugin cannot tell which entry you meant, it writes nothing and says so.
- When the plugin writes, it saves the file as JSON indented by two spaces, so the formatting of a hand-edited file
  may change; the content and the extra fields of every entry are kept.
- A missing file is an empty list, not an error. A file with a byte order mark (some Windows editors add one) is read.
- Claude never writes the todos file through `propose_todo`: it can only queue a card that you approve.
- The plugin never stops a session from starting: if the file system or environment fails, it simply shows less.

## Troubleshooting

The band is not showing:

1. `showBand` is `false` (check `/config`).
2. There are no open tasks for this project. A task with `repo` shows only in that repository; a task with only
   `project` shows only in folders with that name. Run `/todo` to see what the plugin found and which file it reads
   (`List file:`). If you renamed the folder of a task created before version 1.3, change its `project` to the new
   name, then run `/todo claim`.
3. You pressed **Hide today** or **Do it now**. The band returns tomorrow, or run `/todo` to bring it back.
4. A question dialog (survey) is open, or Claude is working. The band comes back when it is idle.
5. The todos file cannot be read: `/todo` prints a `Warning:` with the reason. Check the path in `todosFile`.
6. The plugin is not enabled: check `/plugin`.

Claude's suggestions are not showing: `allowSuggestions` is `false`, or Claude has not proposed anything (it is told to
do so only for follow-up work it is not doing now). Run `/todo suggestions` to see what is waiting. The band hides them
while Claude is working or a question dialog is open, and when `showBand` is `false` (the toast, the pane and
`/todo suggestions` still work).

The latest memory is missing: `showMemories` is `false`, or Claude Code has no memory index yet for this project.
Memories are read from `<config folder>/projects/<project>/memory/MEMORY.md` of the current profile only
(`$CLAUDE_CONFIG_DIR`, else `~/.claude`). With `memoriesAllProfiles` on, `~/.claude` and every `~/.claude-*` folder
are read too and the newest one wins (another account's memories can then show in this session).

Still stuck: start Claude Code with `claude --debug` and look for lines that begin with `kit-todos:`. They say when
a hook was skipped and why.

## Uninstall

- Terminal session: `/plugin`, pick `kit-todos`, uninstall. Or from a shell: `claude plugin uninstall kit-todos`.
- Desktop app: open the same Plugins menu and remove it.

Your todos file is not touched. To drop the marketplace too: `claude plugin marketplace remove kit-claude-mods`.
