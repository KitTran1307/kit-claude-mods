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
  root = mkdtempSync(join(tmpdir(), "kit-statusbar-"));
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
