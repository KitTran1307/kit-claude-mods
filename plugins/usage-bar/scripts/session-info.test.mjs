// Run with: node --test scripts/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session-info.mjs");
const ID = "0f9e8d7c-1111-4222-8333-444455556666";
const CWD = "/work/my project";
const SLUG = "-work-my-project";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "usage-bar-"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const line = (obj) => `${JSON.stringify(obj)}\n`;
const userLine = (text) => line({ type: "user", message: { role: "user", content: text } });

// A config directory with one transcript; returns the folder and the transcript's path.
function makeConfig(name, transcript, { slug = SLUG, login } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, "projects", slug), { recursive: true });
  const file = join(dir, "projects", slug, `${ID}.jsonl`);
  writeFileSync(file, transcript);
  if (login !== undefined) writeFileSync(join(dir, ".claude.json"), login);
  return { dir, file };
}

function run(args, env = {}) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: "", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("a /rename beats the automatic title; the latest of each wins", () => {
  const { file } = makeConfig(
    "titles",
    userLine("hello") +
      line({ type: "ai-title", aiTitle: "Old auto" }) +
      line({ type: "custom-title", customTitle: "First rename" }) +
      line({ type: "ai-title", aiTitle: "New auto" }) +
      line({ type: "custom-title", customTitle: "Second rename" }),
  );
  assert.equal(run(["--transcript", file]).title, "Second rename");
});

test("without a rename the latest automatic title shows", () => {
  const { file } = makeConfig("auto", line({ type: "ai-title", aiTitle: "Old" }) + userLine("x") + line({ type: "ai-title", aiTitle: "Newest" }));
  assert.equal(run(["--transcript", file]).title, "Newest");
});

test("no title entries: an empty title", () => {
  const { file } = makeConfig("none", userLine("just talking"));
  assert.equal(run(["--transcript", file]).title, "");
});

test("a title quoted inside a message (escaped) never counts as an entry", () => {
  const quoted = userLine('please parse {"type":"ai-title","aiTitle":"Quoted"} and {"type":"custom-title","customTitle":"Fake"}');
  assert.ok(quoted.includes('\\"type\\":\\"ai-title\\"'));
  const real = line({ type: "ai-title", aiTitle: "Real" });
  assert.equal(run(["--transcript", makeConfig("quoted-after", real + quoted).file]).title, "Real");
  assert.equal(run(["--transcript", makeConfig("quoted-only", quoted).file]).title, "");
});

test("an entry cut short is skipped for the one before it", () => {
  const { file } = makeConfig("cut", line({ type: "ai-title", aiTitle: "Whole" }) + '{"type":"ai-title","aiTitle":"Cu');
  assert.equal(run(["--transcript", file]).title, "Whole");
});

test("only the last --tail-mb MB are read: a title further back is not found", () => {
  const filler = userLine("x".repeat(1000)).repeat(1500); // about 1.5 MB
  const early = line({ type: "ai-title", aiTitle: "Early" });
  const late = line({ type: "ai-title", aiTitle: "Late" });
  const earlyOnly = makeConfig("tail-early", early + filler).file;
  assert.equal(run(["--transcript", earlyOnly, "--tail-mb", "1"]).title, "");
  assert.equal(run(["--transcript", earlyOnly, "--tail-mb", "4"]).title, "Early");
  const lateOne = makeConfig("tail-late", early + filler + late).file;
  assert.equal(run(["--transcript", lateOne, "--tail-mb", "1"]).title, "Late");
});

test("the session's own email comes from its context; a quoted one does not count", () => {
  const context = line({ type: "attachment", userContext: { userEmail: "The user's email address is ann@example.com. Use it." } });
  const { file } = makeConfig("ctx-email", context);
  assert.equal(run(["--transcript", file]).transcriptEmail, "ann@example.com");
  assert.equal(run(["--transcript", file]).email, "ann@example.com");
  const quoted = userLine('"userEmail":"The user\'s email address is fake@example.com."');
  assert.equal(run(["--transcript", makeConfig("ctx-quoted", quoted).file]).transcriptEmail, "");
});

test("--session finds the transcript in the project's own folder", () => {
  const { dir } = makeConfig("by-slug", line({ type: "ai-title", aiTitle: "By slug" }));
  const out = run(["--session", ID, "--cwd", CWD, "--config-dir", dir]);
  assert.equal(out.title, "By slug");
  assert.ok(out.transcript.endsWith(`${ID}.jsonl`));
});

test("--session scans every project folder when the folder is not the cwd's", () => {
  const { dir } = makeConfig("by-scan", line({ type: "ai-title", aiTitle: "By scan" }), { slug: "-somewhere-else" });
  assert.equal(run(["--session", ID, "--cwd", CWD, "--config-dir", dir]).title, "By scan");
  assert.equal(run(["--session", ID, "--config-dir", dir]).title, "By scan");
});

test("CLAUDE_CONFIG_DIR is the config directory and its .claude.json the login record", () => {
  const { dir } = makeConfig("env-dir", line({ type: "ai-title", aiTitle: "From env" }), {
    login: JSON.stringify({ oauthAccount: { emailAddress: "login@example.com" } }),
  });
  const out = run(["--session", ID, "--cwd", CWD], { CLAUDE_CONFIG_DIR: dir });
  assert.equal(out.title, "From env");
  assert.equal(out.loginEmail, "login@example.com");
  assert.equal(out.email, "login@example.com");
});

test("the transcript's email wins over the login record", () => {
  const context = line({ userContext: { userEmail: "The user's email address is session@example.com." } });
  const { dir } = makeConfig("both-emails", context, { login: JSON.stringify({ oauthAccount: { emailAddress: "login@example.com" } }) });
  const out = run(["--session", ID, "--cwd", CWD, "--config-dir", dir]);
  assert.equal(out.email, "session@example.com");
  assert.equal(out.loginEmail, "login@example.com");
});

test("--login-file alone reads the login record; a missing or invalid one is an empty email", () => {
  const good = join(root, "login-good.json");
  writeFileSync(good, JSON.stringify({ oauthAccount: { emailAddress: "big@example.com" } }));
  assert.equal(run(["--login-file", good]).loginEmail, "big@example.com");
  const bad = join(root, "login-bad.json");
  writeFileSync(bad, "{ not json");
  assert.equal(run(["--login-file", bad]).loginEmail, "");
  assert.equal(run(["--login-file", join(root, "nope.json")]).loginEmail, "");
});

test("a missing transcript, a bad session id or an unknown folder is an empty answer, not a failure", () => {
  assert.deepEqual(run(["--transcript", join(root, "missing.jsonl")]).title, "");
  const { dir } = makeConfig("bad-id", line({ type: "ai-title", aiTitle: "X" }));
  assert.equal(run(["--session", "../../etc/passwd", "--config-dir", dir]).transcript, "");
  assert.equal(run(["--session", ID, "--config-dir", join(root, "no-such-dir")]).transcript, "");
});

test("no arguments is a usage error", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});

const hookLine = (extra = {}, type = "hook_non_blocking_error") =>
  line({ type: "attachment", attachment: { type, hookName: "Stop", command: "bash scripts/x.sh", stderr: "Failed with non-blocking status code: bash: scripts/x.sh: No such file or directory", ...extra } });

test("hookErrors: none in a transcript without failures", () => {
  const { file } = makeConfig("hooks-none", userLine("hello") + line({ type: "attachment", attachment: { type: "hook_success" } }));
  assert.deepEqual(run(["--transcript", file]).hookErrors, { count: 0, last: null });
});

test("hookErrors: counts both kinds and reports the latest, with a short command and the first line of the reason", () => {
  const { file } = makeConfig(
    "hooks-many",
    hookLine() + userLine("x") + hookLine({ hookName: "PreToolUse" }) + hookLine({ hookName: undefined, hookEvent: "SessionStart", command: "node gone.js", stderr: undefined, content: "Cannot find module\nat line 2" }, "hook_blocking_error"),
  );
  assert.deepEqual(run(["--transcript", file]).hookErrors, {
    count: 3,
    last: { hook: "SessionStart", command: "node gone.js", reason: "Cannot find module" },
  });
  const one = makeConfig("hooks-one", hookLine({ command: `node ${"x".repeat(200)}` })).file;
  const last = run(["--transcript", one]).hookErrors.last;
  assert.equal(last.command.length, 60);
  assert.equal(last.reason, "bash: scripts/x.sh: No such file or directory");
});

test("hookErrors: quoted text and a line cut short never count", () => {
  const quoted = userLine('see {"type":"hook_non_blocking_error","hookName":"Fake"} and {"type":"hook_blocking_error"}');
  assert.ok(quoted.includes('\\"type\\":\\"hook_non_blocking_error\\"'));
  const cut = '{"type":"attachment","attachment":{"type":"hook_non_blocking_error","hookName":"Cu';
  assert.equal(run(["--transcript", makeConfig("hooks-quoted", quoted).file]).hookErrors.count, 0);
  const out = run(["--transcript", makeConfig("hooks-cut", hookLine() + quoted + cut).file]).hookErrors;
  assert.equal(out.count, 1);
  assert.equal(out.last.hook, "Stop");
});

test("hookErrors: only the --tail-mb window is counted; the other fields are unchanged", () => {
  const filler = userLine("x".repeat(1000)).repeat(1500); // about 1.5 MB
  const { file } = makeConfig("hooks-tail", hookLine() + filler + hookLine({ hookName: "Late" }) + line({ type: "ai-title", aiTitle: "T" }));
  const out = run(["--transcript", file, "--tail-mb", "1"]);
  assert.equal(out.hookErrors.count, 1);
  assert.equal(out.hookErrors.last.hook, "Late");
  assert.equal(out.title, "T");
  assert.equal(run(["--transcript", file, "--tail-mb", "4"]).hookErrors.count, 2);
  for (const key of ["title", "transcriptEmail", "loginEmail", "email", "transcript"]) assert.ok(key in out, key);
});

// ---- prompt-cache stamp ----
const reply = (extra = {}, usage = { cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 } }) =>
  line({ type: "assistant", timestamp: "2026-11-12T08:00:00.000Z", isSidechain: false, message: { role: "assistant", usage }, ...extra });
const T0 = Date.parse("2026-11-12T08:00:00.000Z");

test("cacheStamp: the last main-thread reply, 5 minutes by default", () => {
  const { file } = makeConfig("cache-5m", reply() + reply({ timestamp: "2026-11-12T09:00:00.000Z" }));
  assert.deepEqual(run(["--transcript", file]).cacheStamp, { at: Date.parse("2026-11-12T09:00:00.000Z"), ttlMs: 300_000 });
});

test("cacheStamp: 1-hour cache tokens mean a 1 hour life", () => {
  const { file } = makeConfig("cache-1h", reply({}, { cache_creation: { ephemeral_1h_input_tokens: 9 } }));
  assert.deepEqual(run(["--transcript", file]).cacheStamp, { at: T0, ttlMs: 3_600_000 });
});

const W1H = { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9 }, cache_read_input_tokens: 0 };
const W5M = { cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0 };
const READ = { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 500 };
const T1 = "2026-11-12T09:00:00.000Z";

test("cacheStamp: a 1 h write then a read-only reply keeps the 1 hour life", () => {
  const { file } = makeConfig("cache-1h-read", reply({}, W1H) + reply({ timestamp: T1 }, READ));
  assert.deepEqual(run(["--transcript", file]).cacheStamp, { at: Date.parse(T1), ttlMs: 3_600_000 });
});

test("cacheStamp: a 5 minute write then a read-only reply keeps 5 minutes; a later 1 h write wins", () => {
  const a = makeConfig("cache-5m-read", reply({}, W5M) + reply({ timestamp: T1 }, READ));
  assert.deepEqual(run(["--transcript", a.file]).cacheStamp, { at: Date.parse(T1), ttlMs: 300_000 });
  const b = makeConfig("cache-mixed", reply({}, W5M) + reply({ timestamp: T1 }, W1H) + reply({ timestamp: "2026-11-12T10:00:00.000Z" }, READ));
  assert.deepEqual(run(["--transcript", b.file]).cacheStamp, { at: Date.parse("2026-11-12T10:00:00.000Z"), ttlMs: 3_600_000 });
});

test("cacheStamp: a read-only reply with no earlier writer is 5 minutes", () => {
  const { file } = makeConfig("cache-read-only", reply({}, READ));
  assert.deepEqual(run(["--transcript", file]).cacheStamp, { at: T0, ttlMs: 300_000 });
});

test("cacheStamp: subagent replies, other entries and error stand-ins are skipped", () => {
  const { file } = makeConfig(
    "cache-skip",
    reply() +
      reply({ isSidechain: true, timestamp: "2026-11-12T10:00:00.000Z" }) +
      userLine("hi") +
      reply({ timestamp: "2026-11-12T12:00:00.000Z", message: { model: "<synthetic>", usage: {} } }),
  );
  assert.equal(run(["--transcript", file]).cacheStamp.at, T0);
});

test("cacheStamp: a missing field in the last reply is null, never an earlier reply", () => {
  assert.equal(run(["--transcript", makeConfig("cache-no-usage", reply() + reply({}, null)).file]).cacheStamp, null);
  assert.equal(run(["--transcript", makeConfig("cache-no-time", reply() + reply({ timestamp: undefined })).file]).cacheStamp, null);
  assert.equal(run(["--transcript", makeConfig("cache-bad-time", reply() + reply({ timestamp: "later" })).file]).cacheStamp, null);
  assert.equal(run(["--transcript", makeConfig("cache-no-1h", reply({}, { cache_creation: {} })).file]).cacheStamp, null);
});

test("cacheStamp: none without a reply; a cut line and quoted text are skipped", () => {
  assert.equal(run(["--transcript", makeConfig("cache-none", userLine("hello")).file]).cacheStamp, null);
  const quoted = userLine('look: {"type":"assistant","timestamp":"2030-01-01T00:00:00Z"}');
  assert.equal(run(["--transcript", makeConfig("cache-quoted", quoted).file]).cacheStamp, null);
  const cut = reply() + '{"type":"assistant","timestamp":"2026-11-12T';
  assert.equal(run(["--transcript", makeConfig("cache-cut", cut).file]).cacheStamp.at, T0);
});

test("cacheStamp: only the tail window is read", () => {
  const filler = userLine("x".repeat(1000)).repeat(1500);
  const { file } = makeConfig("cache-tail", reply() + filler);
  assert.equal(run(["--transcript", file, "--tail-mb", "1"]).cacheStamp, null);
  assert.equal(run(["--transcript", file, "--tail-mb", "4"]).cacheStamp.at, T0);
});

test("hookErrors: control characters are stripped from the hook, command and reason", () => {
  const { file } = makeConfig(
    "hooks-ctl",
    hookLine({
      hookName: "St\u001b]0;x\u0007op\u009b",
      command: "bash \u001b]0;x\u0007 run.sh\u0000",
      stderr: "Failed with non-blocking status code: \u001b[31mbash: gone: No such file\u001b[0m\u0007",
    }),
  );
  const last = run(["--transcript", file]).hookErrors.last;
  for (const v of [last.hook, last.command, last.reason]) assert.doesNotMatch(v, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(last.hook, "St]0;xop");
  assert.equal(last.command, "bash ]0;x run.sh");
  assert.equal(last.reason, "[31mbash: gone: No such file[0m");
});

test("hookErrors: a long hook name is cut like the command", () => {
  const { file } = makeConfig("hooks-longname", hookLine({ hookName: "H".repeat(200) }));
  assert.equal(run(["--transcript", file]).hookErrors.last.hook.length, 40);
});
