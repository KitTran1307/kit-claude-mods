#!/usr/bin/env node
// Optional helper of the kit-statusbar plugin, for what the plugin cannot read by itself: a session transcript or a
// login record over 4 MB. Plain Node, no dependencies; Windows, macOS and Linux. Prints one JSON object:
//   {"title","transcriptEmail","loginEmail","email","transcript","hookErrors"}   (a missing value is "")
//
//   node session-info.mjs --transcript FILE [--tail-mb N] [--login-file FILE]
//   node session-info.mjs --session ID [--cwd DIR] [--config-dir DIR] [--tail-mb N] [--login-file FILE]
//
// title: the latest /rename (custom-title), else the latest automatic title (ai-title), looked for in the last
//   --tail-mb MB of the transcript only (default 4), so a very long session stays cheap.
// transcriptEmail: the account the session itself runs as (its context's userEmail), same window.
// loginEmail: oauthAccount.emailAddress of the login record: --login-file, or with --session the config
//   directory's own: <CLAUDE_CONFIG_DIR>/.claude.json when that is set, else <home>/.claude.json.
// email: transcriptEmail, else loginEmail.
// hookErrors: {"count","last"}, the hook failures (hook_non_blocking_error / hook_blocking_error entries) in the same
//   window; last is null or {"hook","command","reason"}. Same rules as hookErrors() in hooks/transcript.ts.
// --session finds the transcript at <config dir>/projects/<project>/<ID>.jsonl; the config dir is --config-dir,
//   else CLAUDE_CONFIG_DIR, else <home>/.claude. With --cwd the project folder is tried first, then every folder.
// The title and email rules are the same as hooks/transcript.ts.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The last `tailBytes` of a file as text, from the first whole line in it (a line cut by the window is dropped).
function readTail(file, tailBytes) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, start + done);
      if (n <= 0) break;
      done += n;
    }
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      from = nl < 0 ? done : nl + 1;
    }
    return buf.toString("utf8", from, done);
  } finally {
    closeSync(fd);
  }
}

function parseObject(line) {
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// The text of `field` in the last entry of `type`. Matching the unescaped `"type":"..."` key means text quoted
// inside a message (escaped `\"type\":\"...\"`) never counts as an entry. An entry that does not parse is skipped.
function lastEntryField(text, type, field) {
  const key = `"type":"${type}"`;
  let at = text.lastIndexOf(key);
  for (let tries = 0; at >= 0 && tries < 50; tries += 1) {
    const start = text.lastIndexOf("\n", at) + 1;
    const end = text.indexOf("\n", at);
    const value = parseObject(text.slice(start, end < 0 ? undefined : end))?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (start === 0) break;
    at = text.lastIndexOf(key, start - 1);
  }
  return "";
}

const lastTitle = (text) => lastEntryField(text, "custom-title", "customTitle") || lastEntryField(text, "ai-title", "aiTitle");

// "userEmail":"The user's email address is <email>. ..." (unescaped key, so a real entry, not quoted text)
const EMAIL_KEY = `"userEmail":"The user's email address is `;
function transcriptEmail(text) {
  const at = text.lastIndexOf(EMAIL_KEY);
  if (at < 0) return "";
  const from = at + EMAIL_KEY.length;
  return /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text.slice(from, from + 320))?.[0] ?? "";
}

// ---- hook failures (same rules as hooks/transcript.ts) ----
const HOOK_ERROR_TYPES = ["hook_non_blocking_error", "hook_blocking_error"];
const str = (v) => (typeof v === "string" ? v.trim() : "");
const record = (v) => (v !== null && typeof v === "object" ? v : null);

// One line of at most `room` characters, cut with an ellipsis.
function fitText(value, room) {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  if (room < 4) return "";
  return chars.length <= room ? chars.join("") : `${chars.slice(0, room - 1).join("")}…`;
}

// A stack trace starts with where it was thrown; the line naming the error is the one worth showing.
const CAUSE = /\b(?:\w*Error|error|No such file|not found|Cannot|ENOENT|EACCES|denied|does not exist)\b/i;

function hookFailure(att) {
  const nested = record(att.blockingError);
  const raw = str(att.stderr) || str(att.content) || str(nested?.blockingError) || str(att.blockingError) || str(att.output) || str(att.message);
  const lines = raw.replace(/^Failed with non-blocking status code:\s*/i, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const firstLine = lines.find((l) => CAUSE.test(l)) ?? lines[0] ?? "";
  return {
    hook: str(att.hookName) || str(att.hookEvent) || str(att.hook_event_name),
    command: fitText(str(att.command) || str(nested?.command), 60),
    reason: fitText(firstLine.replace(/^Failed with non-blocking status code:\s*/i, ""), 80),
  };
}

function hookErrors(text) {
  const seen = new Set();
  let count = 0;
  let lastAt = -1;
  let last = null;
  for (const type of HOOK_ERROR_TYPES) {
    const key = `"type":"${type}"`;
    for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
      const start = text.lastIndexOf("\n", at) + 1;
      if (seen.has(start)) continue;
      seen.add(start);
      const end = text.indexOf("\n", at);
      const entry = parseObject(text.slice(start, end < 0 ? undefined : end));
      const att = record(entry?.attachment) ?? entry;
      if (!att || !HOOK_ERROR_TYPES.includes(att.type)) continue;
      count += 1;
      if (start > lastAt) {
        lastAt = start;
        last = hookFailure(att);
      }
    }
  }
  return { count, last };
}

function loginEmail(file) {
  try {
    const email = JSON.parse(readFileSync(file, "utf8"))?.oauthAccount?.emailAddress;
    return typeof email === "string" && /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(email) ? email : "";
  } catch {
    return "";
  }
}

function findTranscript(configDir, id, cwd) {
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return "";
  const projects = join(configDir, "projects");
  if (cwd) {
    const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
    if (isFile(direct)) return direct;
  }
  try {
    for (const name of readdirSync(projects)) {
      const file = join(projects, name, `${id}.jsonl`);
      if (isFile(file)) return file;
    }
  } catch {
    // no projects folder: no transcript
  }
  return "";
}

const args = parseArgs(process.argv.slice(2));
if (!args.transcript && !args.session && !args["login-file"]) {
  process.stderr.write("usage: session-info.mjs --transcript FILE | --session ID [--cwd DIR] [--config-dir DIR] [--tail-mb N] [--login-file FILE]\n");
  process.exit(2);
}

const custom = (args["config-dir"] || process.env.CLAUDE_CONFIG_DIR || "").trim();
const configDir = custom || join(homedir(), ".claude");
const transcript = args.transcript || (args.session ? findTranscript(configDir, args.session, args.cwd || "") : "");
const tailBytes = Math.max(1, Number(args["tail-mb"]) || 4) * MIB;

let text = "";
if (transcript) {
  try {
    text = readTail(transcript, tailBytes);
  } catch {
    text = "";
  }
}
const loginFile = args["login-file"] || (args.session ? join(custom || homedir(), ".claude.json") : "");
const fromTranscript = transcriptEmail(text);
const fromLogin = loginFile ? loginEmail(loginFile) : "";
process.stdout.write(
  JSON.stringify({
    title: lastTitle(text),
    transcriptEmail: fromTranscript,
    loginEmail: fromLogin,
    email: fromTranscript || fromLogin,
    transcript,
    hookErrors: hookErrors(text),
  }),
);
