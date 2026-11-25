// Run with: node --test plugins/kit-safety/scripts/
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { confirmParent, Refusal, restoreFile, walkParents } from "./safety-fs.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "safety-fs.mjs");
const KEY = "acme-shop-a1b2c3d4e5f607";
const ID = "20261124T093015Z";
const ID2 = "20261124T093016Z";
const WIN = process.platform === "win32";
const MB = 1024 * 1024;
const LIMITS = { maxBytes: 100 * MB, maxFiles: 50_000 };

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "kit-safety-fs-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---- helpers ----

let counter = 0;
/** A fresh world: project/ (the root), outside/ (with a canary that must never change), snaps/ (the snapshots root). */
function sandbox() {
  counter += 1;
  const dir = join(tmp, `sb${counter}`);
  const sb = { dir, project: join(dir, "project"), outside: join(dir, "outside"), snaps: join(dir, "snaps") };
  mkdirSync(sb.project, { recursive: true });
  mkdirSync(sb.outside, { recursive: true });
  mkdirSync(sb.snaps, { recursive: true });
  writeFileSync(join(sb.outside, "canary.txt"), "canary");
  return sb;
}
const dest = (sb, id = ID) => join(sb.snaps, KEY, id);
const put = (sb, rel, content = "x") => {
  const file = join(sb.project, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};
const read = (sb, rel) => readFileSync(join(sb.project, ...rel.split("/")));
const exists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const canaryIntact = (sb) => assert.equal(readFileSync(join(sb.outside, "canary.txt"), "utf8"), "canary");

function call(req) {
  const res = spawnSync(process.execPath, [SCRIPT], { input: typeof req === "string" ? req : JSON.stringify(req), encoding: "utf8", maxBuffer: 64 * MB });
  assert.equal(res.status, 0, `exit status (stderr: ${res.stderr})`);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /^[^\n]*\n$/, "exactly one line on stdout");
  return JSON.parse(res.stdout);
}

const manifestIn = (id = ID, extra = {}) => ({
  v: 1,
  id,
  n: 7,
  createdAt: 1_800_000_000_000,
  kind: "before-command",
  tool: "Bash",
  command: "rm -rf build",
  risks: [{ kind: "delete", label: "rm -rf" }],
  ...extra,
});

function copyReq(sb, targets, extra = {}) {
  const id = extra.id ?? ID;
  return { cmd: "copy", root: sb.project, destDir: dest(sb, id), targets, ...LIMITS, manifest: manifestIn(id, extra.manifest), ...(extra.req ?? {}) };
}
/** The manifest the helper wrote into a snapshot folder (the copy answer is only a summary: it does not carry the manifest). */
const manifestOnDisk = (sb, id = ID) => JSON.parse(readFileSync(join(dest(sb, id), "manifest.json"), "utf8"));

function copyOk(sb, targets, extra = {}) {
  const res = call(copyReq(sb, targets, extra));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.tooBig, false);
  assert.equal(res.manifest, undefined, "the answer is a summary: no manifest in it");
  const manifest = manifestOnDisk(sb, extra.id ?? ID);
  assert.equal(res.files, manifest.files.length);
  assert.equal(res.bytes, manifest.totalBytes);
  return manifest;
}
const restoreReq = (sb, extra = {}) => ({ cmd: "restore", root: sb.project, snapDir: dest(sb), ...extra });

/** Makes a symlink or reports that this machine cannot (Windows without the privilege). */
function link(t, target, at) {
  try {
    symlinkSync(target, at);
    return true;
  } catch (e) {
    if (WIN || e.code === "EPERM") {
      t.skip("symbolic links are not available here");
      return false;
    }
    throw e;
  }
}

function tree(sb) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        out.push(`${r}/`);
        walk(abs, r);
      } else out.push(r);
    }
  };
  walk(sb.project, "");
  return out;
}

// ---- protocol ----

test("hello answers with the protocol version and the node version", () => {
  assert.deepEqual(call({ cmd: "hello" }), { ok: true, v: 1, node: process.versions.node });
});

test("bad JSON, empty input, non-objects and an unknown command are answered as errors, with exit 0", () => {
  assert.deepEqual(call("{ not json"), { ok: false, error: "bad JSON" });
  assert.deepEqual(call(""), { ok: false, error: "empty request" });
  assert.deepEqual(call("   \n"), { ok: false, error: "empty request" });
  for (const bad of ["[]", "null", '"scan"', "42", "true"]) assert.deepEqual(call(bad), { ok: false, error: "bad request" }, bad);
  assert.deepEqual(call({ cmd: "format-disk" }), { ok: false, error: "unknown command" });
  assert.deepEqual(call({}), { ok: false, error: "unknown command" });
  assert.deepEqual(call({ cmd: 5 }), { ok: false, error: "unknown command" });
});

test("missing or wrongly typed fields are errors, never exceptions", () => {
  const sb = sandbox();
  const bad = [
    { cmd: "scan" },
    { cmd: "scan", root: sb.project },
    { cmd: "scan", root: sb.project, targets: "build", ...LIMITS },
    { cmd: "scan", root: sb.project, targets: [], maxBytes: "big", maxFiles: 5 },
    { cmd: "scan", root: sb.project, targets: [], maxBytes: 5 },
    { cmd: "scan", root: sb.project, targets: [], maxBytes: null, maxFiles: 5 },
    { cmd: "scan", root: 12, targets: [], ...LIMITS },
    { cmd: "scan", root: "relative/dir", targets: [], ...LIMITS },
    { cmd: "scan", root: join(sb.dir, "no-such-folder"), targets: [], ...LIMITS },
    { cmd: "scan", root: join(sb.outside, "canary.txt"), targets: [], ...LIMITS },
    { cmd: "copy" },
    { cmd: "copy", root: sb.project, destDir: dest(sb), targets: [], ...LIMITS },
    { cmd: "copy", root: sb.project, destDir: dest(sb), targets: [], ...LIMITS, manifest: "no" },
    { cmd: "restore" },
    { cmd: "restore", root: sb.project },
    { cmd: "remove" },
    { cmd: "remove", snapshotsRoot: sb.snaps },
  ];
  for (const req of bad) {
    const res = call(req);
    assert.equal(res.ok, false, JSON.stringify(req));
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0 && res.error.length < 80, res.error);
  }
});

test("a filesystem root is never accepted as the project root", () => {
  const root = process.platform === "win32" ? "C:\\" : "/";
  assert.equal(call({ cmd: "scan", root, targets: [], ...LIMITS }).ok, false);
  assert.equal(call({ cmd: "restore", root, snapDir: join(tmp, "x") }).ok, false);
});

// ---- scan ----

test("scan counts files, bytes and folders under the targets; a missing target is listed, not an error", () => {
  const sb = sandbox();
  put(sb, "build/a.txt", "12345");
  put(sb, "build/sub/b.txt", "1234567890");
  put(sb, "build/sub/deeper/c.txt", "");
  put(sb, "other.txt", "abc");
  mkdirSync(join(sb.project, "build", "empty"));
  const res = call({ cmd: "scan", root: sb.project, targets: ["build", "other.txt", "ghost"], ...LIMITS });
  assert.equal(res.ok, true);
  assert.equal(res.files, 4);
  assert.equal(res.bytes, 18);
  assert.equal(res.dirs, 4); // build, sub, deeper, empty
  assert.equal(res.tooBig, false);
  assert.equal(res.isTruncated, false);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.missing, ["ghost"]);
});

test("scan counts overlapping targets once", () => {
  const sb = sandbox();
  put(sb, "build/a.txt", "1234");
  const res = call({ cmd: "scan", root: sb.project, targets: ["build/a.txt", "build", "build", "build/a.txt"], ...LIMITS });
  assert.equal(res.files, 1);
  assert.equal(res.bytes, 4);
});

test("scan stops early at a limit and says so", () => {
  const sb = sandbox();
  for (let i = 0; i < 30; i += 1) put(sb, `many/f${String(i).padStart(2, "0")}.txt`, "1234567890");
  const byFiles = call({ cmd: "scan", root: sb.project, targets: ["many"], maxBytes: MB, maxFiles: 10 });
  assert.equal(byFiles.tooBig, true);
  assert.equal(byFiles.isTruncated, true);
  assert.ok(byFiles.files <= 11);
  const byBytes = call({ cmd: "scan", root: sb.project, targets: ["many"], maxBytes: 95, maxFiles: 1000 });
  assert.equal(byBytes.tooBig, true);
  assert.ok(byBytes.bytes <= 100);
  const exact = call({ cmd: "scan", root: sb.project, targets: ["many"], maxBytes: 300, maxFiles: 30 });
  assert.equal(exact.tooBig, false, "exactly at the limit is allowed");
  assert.equal(exact.files, 30);
});

test("scan limits also bound the number of folders", () => {
  const sb = sandbox();
  for (let i = 0; i < 20; i += 1) mkdirSync(join(sb.project, "d", `e${i}`), { recursive: true });
  assert.equal(call({ cmd: "scan", root: sb.project, targets: ["d"], maxBytes: MB, maxFiles: 5 }).tooBig, true);
});

test("scan skips symbolic links and never follows them", (t) => {
  const sb = sandbox();
  put(sb, "build/a.txt", "1234");
  if (!link(t, sb.outside, join(sb.project, "build", "to-outside"))) return;
  link(t, join(sb.project, "build", "a.txt"), join(sb.project, "build", "to-file"));
  link(t, sb.outside, join(sb.project, "top-link"));
  const res = call({ cmd: "scan", root: sb.project, targets: ["build", "top-link"], ...LIMITS });
  assert.equal(res.files, 1);
  assert.equal(res.skippedCount, 3);
  assert.deepEqual(
    res.skipped.map((s) => `${s.rel}:${s.reason}`).sort(),
    ["build/to-file:symlink", "build/to-outside:symlink", "top-link:symlink"],
  );
});

test("scan refuses a target below a symlinked folder: it is skipped as outside, nothing is read", (t) => {
  const sb = sandbox();
  if (!link(t, sb.outside, join(sb.project, "escape"))) return;
  const res = call({ cmd: "scan", root: sb.project, targets: ["escape/canary.txt"], ...LIMITS });
  assert.equal(res.ok, true);
  assert.equal(res.files, 0);
  assert.deepEqual(res.skipped, [{ rel: "escape/canary.txt", reason: "outside" }]);
});

test("scan answers for a symlink that stays inside the project with reason symlink", (t) => {
  const sb = sandbox();
  put(sb, "real/a.txt", "1");
  if (!link(t, join(sb.project, "real"), join(sb.project, "alias"))) return;
  const res = call({ cmd: "scan", root: sb.project, targets: ["alias/a.txt"], ...LIMITS });
  assert.deepEqual(res.skipped, [{ rel: "alias/a.txt", reason: "symlink" }]);
});

test("scan: the project folder itself may be reached through a symlink", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "123");
  const alias = join(sb.dir, "alias-root");
  if (!link(t, sb.project, alias)) return;
  const res = call({ cmd: "scan", root: alias, targets: ["a.txt"], ...LIMITS });
  assert.equal(res.files, 1);
});

test("every unsafe rel in a request refuses the whole request", () => {
  const sb = sandbox();
  put(sb, "ok.txt", "1");
  const unsafe = ["../x", "a/../../x", "/etc/passwd", "C:\\x", "C:x", "a\\b", "a//b", "a/./b", "./a", "a/", "", ".", "..", "a\0b", "x".repeat(5000)];
  for (const rel of unsafe) {
    for (const cmd of ["scan", "copy"]) {
      const req = cmd === "scan" ? { cmd, root: sb.project, targets: ["ok.txt", rel], ...LIMITS } : copyReq(sb, ["ok.txt", rel]);
      const res = call(req);
      assert.equal(res.ok, false, `${cmd} ${JSON.stringify(rel)}`);
      assert.match(res.error, /unsafe path/);
    }
  }
  assert.equal(exists(dest(sb)), false);
  assert.equal(call({ cmd: "scan", root: sb.project, targets: [5], ...LIMITS }).ok, false);
  assert.equal(call({ cmd: "scan", root: sb.project, targets: [null], ...LIMITS }).ok, false);
});

// ---- copy ----

test("copy saves a tree with nested, empty, unicode and spaced names and writes the manifest", () => {
  const sb = sandbox();
  put(sb, "build/a.txt", "hello");
  put(sb, "build/sub dir/Tệp tin 日本語.txt", "unicode");
  put(sb, "build/sub dir/deep/er/c.bin", "c");
  put(sb, "build/.hidden", "dot");
  mkdirSync(join(sb.project, "build", "empty folder"));
  mkdirSync(join(sb.project, "build", "empty-parent", "empty-child"), { recursive: true });
  put(sb, "notes.md", "# notes");
  const manifest = copyOk(sb, ["build", "notes.md"]);

  assert.equal(manifest.v, 1);
  assert.equal(manifest.id, ID);
  assert.equal(manifest.n, 7);
  assert.equal(manifest.kind, "before-command");
  assert.equal(manifest.tool, "Bash");
  // The caller passed a `command` (an old caller does): it is dropped, the command text is never stored.
  assert.equal("command" in manifest, false);
  assert.equal(manifest.backend, "node");
  assert.equal(manifest.root, sb.project);
  assert.deepEqual(manifest.targets, ["build", "notes.md"]);
  assert.deepEqual(manifest.files.map((f) => f.rel), [
    "build/.hidden",
    "build/a.txt",
    "build/sub dir/Tệp tin 日本語.txt",
    "build/sub dir/deep/er/c.bin",
    "notes.md",
  ]);
  assert.deepEqual(manifest.dirs, ["build/empty folder", "build/empty-parent/empty-child"]);
  assert.deepEqual(manifest.skipped, []);
  assert.equal(manifest.totalBytes, "hello".length + "unicode".length + 1 + "dot".length + "# notes".length);
  for (const f of manifest.files) {
    assert.equal(readFileSync(join(dest(sb), "files", ...f.rel.split("/")), "utf8"), readFileSync(join(sb.project, ...f.rel.split("/")), "utf8"));
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(statSync(join(dest(sb), "files", "build", "empty folder")).isDirectory());
  assert.ok(statSync(join(dest(sb), "files", "build", "empty-parent", "empty-child")).isDirectory());

  // The manifest is written to disk (that is where the caller reads it), with a fixed key order and no leftovers.
  const onDisk = readFileSync(join(dest(sb), "manifest.json"), "utf8");
  assert.deepEqual(JSON.parse(onDisk), manifest);
  assert.ok(onDisk.endsWith("}\n"));
  assert.deepEqual(Object.keys(manifest), ["v", "id", "n", "createdAt", "root", "kind", "tool", "risks", "targets", "backend", "files", "dirs", "skipped", "totalBytes"]);
  assert.deepEqual(Object.keys(manifest.files[0]), ["rel", "size", "mtimeMs", "mode", "sha256"]);
  assert.deepEqual(readdirSync(dest(sb)).sort(), ["files", "manifest.json"]);
  // The project itself is untouched.
  assert.equal(read(sb, "build/a.txt").toString(), "hello");
});

test("copy is binary safe: random bytes and a 5 MB file come back identical, with the right hash", () => {
  const sb = sandbox();
  const small = randomBytes(4096);
  const big = randomBytes(5 * MB + 123);
  put(sb, "data/small.bin", small);
  put(sb, "data/big.bin", big);
  put(sb, "data/zero.bin", Buffer.alloc(0));
  put(sb, "data/bytes.bin", Buffer.from([0, 255, 0, 10, 13, 10, 254]));
  const manifest = copyOk(sb, ["data"]);
  const byRel = Object.fromEntries(manifest.files.map((f) => [f.rel, f]));
  assert.equal(byRel["data/small.bin"].sha256, sha(small));
  assert.equal(byRel["data/big.bin"].sha256, sha(big));
  assert.equal(byRel["data/big.bin"].size, big.length);
  assert.equal(byRel["data/zero.bin"].size, 0);
  assert.equal(byRel["data/zero.bin"].sha256, sha(Buffer.alloc(0)));
  assert.ok(readFileSync(join(dest(sb), "files", "data", "big.bin")).equals(big));
  assert.ok(readFileSync(join(dest(sb), "files", "data", "small.bin")).equals(small));
  assert.ok(readFileSync(join(dest(sb), "files", "data", "zero.bin")).equals(Buffer.alloc(0)));
  assert.equal(manifest.totalBytes, small.length + big.length + 7);
});

test("copy keeps the modification time and the permissions", () => {
  const sb = sandbox();
  const file = put(sb, "bin/run.sh", "#!/bin/sh\n");
  const private_ = put(sb, "bin/secret.key", "k");
  const old = new Date("2020-01-02T03:04:05.000Z");
  utimesSync(file, old, old);
  utimesSync(private_, old, old);
  if (!WIN) {
    chmodSync(file, 0o755);
    chmodSync(private_, 0o600);
  }
  const manifest = copyOk(sb, ["bin"]);
  const run = manifest.files.find((f) => f.rel === "bin/run.sh");
  assert.equal(run.mtimeMs, old.getTime());
  const stored = statSync(join(dest(sb), "files", "bin", "run.sh"));
  assert.equal(Math.floor(stored.mtimeMs), old.getTime());
  if (!WIN) {
    assert.equal(run.mode, 0o755);
    assert.equal(stored.mode & 0o777, 0o755);
    assert.equal(manifest.files.find((f) => f.rel === "bin/secret.key").mode, 0o600);
  }
});

test("copy of a read-only file records its mode and keeps the stored copy usable", () => {
  if (WIN) return;
  const sb = sandbox();
  chmodSync(put(sb, "ro/lock.txt", "locked"), 0o444);
  const manifest = copyOk(sb, ["ro"]);
  assert.equal(manifest.files[0].mode, 0o444);
  assert.equal(statSync(join(dest(sb), "files", "ro", "lock.txt")).mode & 0o200, 0o200, "the stored copy stays writable so it can be removed");
});

test("copy of a single file target, overlapping targets and a missing target", () => {
  const sb = sandbox();
  put(sb, "docs/readme.md", "r");
  put(sb, "docs/guide.md", "g");
  const manifest = copyOk(sb, ["docs/readme.md", "docs", "ghost.txt", "docs/guide.md"]);
  assert.deepEqual(manifest.files.map((f) => f.rel), ["docs/guide.md", "docs/readme.md"]);
  assert.deepEqual(manifest.targets, ["docs/readme.md", "docs", "ghost.txt", "docs/guide.md"]);
  const res = call(copyReq(sb, ["only-missing.txt"], { id: ID2 }));
  assert.equal(res.ok, true);
  assert.deepEqual(manifestOnDisk(sb, ID2).files, []);
  assert.deepEqual(res.missing, ["only-missing.txt"]);
  assert.equal(res.missingCount, 1);
});

test("copy with no targets still writes a manifest (a snapshot that holds only git facts)", () => {
  const sb = sandbox();
  const res = call(copyReq(sb, [], { manifest: { git: { head: "main", branch: "main", stashSha: "a".repeat(40) } } }));
  assert.equal(res.ok, true);
  assert.deepEqual(manifestOnDisk(sb).files, []);
  assert.equal(manifestOnDisk(sb).git.stashSha, "a".repeat(40));
  assert.ok(existsSync(join(dest(sb), "manifest.json")));
});

test("copy of an empty folder target records it as an empty folder", () => {
  const sb = sandbox();
  mkdirSync(join(sb.project, "just-empty"));
  const manifest = copyOk(sb, ["just-empty"]);
  assert.deepEqual(manifest.files, []);
  assert.deepEqual(manifest.dirs, ["just-empty"]);
  assert.ok(statSync(join(dest(sb), "files", "just-empty")).isDirectory());
});

test("copy that passes a limit stops, deletes the partial folder and says tooBig", () => {
  const sb = sandbox();
  for (let i = 0; i < 12; i += 1) put(sb, `big/f${i}.txt`, "x".repeat(100));
  const bytes = call({ ...copyReq(sb, ["big"]), maxBytes: 500 });
  assert.equal(bytes.ok, true);
  assert.equal(bytes.tooBig, true);
  assert.equal(bytes.tooBigBy, "bytes");
  assert.equal(bytes.manifest, undefined);
  assert.equal(exists(dest(sb)), false, "no partial snapshot is left");
  const files = call({ ...copyReq(sb, ["big"]), maxFiles: 5 });
  assert.equal(files.tooBig, true);
  assert.equal(files.tooBigBy, "files");
  assert.equal(exists(dest(sb)), false);
  assert.deepEqual(readdirSync(join(sb.snaps, KEY)), []);
  // The same request without a limit problem succeeds afterwards (the id was not used up).
  assert.equal(call(copyReq(sb, ["big"])).tooBig, false);
});

test("copy cleans up when a file grows past the limit while it is being copied", (t) => {
  if (process.platform !== "linux" || !existsSync("/proc/self/status")) return t.skip("needs /proc");
  // /proc files report a size of 0 and then deliver text: the limit is only noticed while reading.
  const id = ID;
  const destDir = join(tmp, `proc-snaps-${counter}`, KEY, id);
  const res = call({
    cmd: "copy",
    root: "/proc/self",
    destDir,
    targets: ["status"],
    maxBytes: 100,
    maxFiles: 10,
    manifest: manifestIn(id),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.tooBig, true);
  assert.equal(res.tooBigBy, "bytes");
  assert.equal(exists(destDir), false);
});

test("copy skips symbolic links and records them", (t) => {
  const sb = sandbox();
  put(sb, "app/main.js", "m");
  if (!link(t, sb.outside, join(sb.project, "app", "outlink"))) return;
  link(t, join(sb.project, "app", "main.js"), join(sb.project, "app", "filelink"));
  mkdirSync(join(sb.project, "app", "onlylinks"));
  link(t, sb.outside, join(sb.project, "app", "onlylinks", "l"));
  link(t, join(sb.project, "app"), join(sb.project, "top"));
  const manifest = copyOk(sb, ["app", "top"]);
  assert.deepEqual(manifest.files.map((f) => f.rel), ["app/main.js"]);
  assert.deepEqual(
    manifest.skipped.map((s) => `${s.rel}:${s.reason}`).sort(),
    ["app/filelink:symlink", "app/onlylinks/l:symlink", "app/outlink:symlink", "top:symlink"],
  );
  assert.deepEqual(manifest.dirs, ["app/onlylinks"], "a folder that holds only links is kept as an empty folder");
  assert.equal(exists(join(dest(sb), "files", "app", "outlink")), false);
  assert.equal(exists(join(dest(sb), "files", "top")), false);
  assert.deepEqual(readdirSync(join(dest(sb), "files", "app")).sort(), ["main.js", "onlylinks"]);
});

test("copy skips special files such as a named pipe", (t) => {
  if (WIN) return t.skip("no named pipes here");
  const sb = sandbox();
  put(sb, "run/data.txt", "d");
  const made = spawnSync("mkfifo", [join(sb.project, "run", "pipe")]);
  if (made.status !== 0) return t.skip("mkfifo is not available");
  const manifest = copyOk(sb, ["run"]);
  assert.deepEqual(manifest.files.map((f) => f.rel), ["run/data.txt"]);
  assert.deepEqual(manifest.skipped, [{ rel: "run/pipe", reason: "special" }]);
});

test("copy refuses a target below a symlinked folder that leads outside the project", (t) => {
  const sb = sandbox();
  put(sb, "keep.txt", "k");
  if (!link(t, sb.outside, join(sb.project, "escape"))) return;
  const manifest = copyOk(sb, ["escape/canary.txt", "escape", "keep.txt"]);
  assert.deepEqual(manifest.files.map((f) => f.rel), ["keep.txt"]);
  assert.deepEqual(
    manifest.skipped.map((s) => `${s.rel}:${s.reason}`).sort(),
    ["escape/canary.txt:outside", "escape:symlink"],
  );
  assert.equal(exists(join(dest(sb), "files", "escape")), false);
  canaryIntact(sb);
});

test("copy refuses to merge into an existing destination", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  const before = readFileSync(join(dest(sb), "manifest.json"), "utf8");
  put(sb, "a.txt", "changed");
  const res = call(copyReq(sb, ["a.txt"]));
  assert.deepEqual(res, { ok: false, error: "destination already exists" });
  assert.equal(readFileSync(join(dest(sb), "manifest.json"), "utf8"), before);
  assert.equal(readFileSync(join(dest(sb), "files", "a.txt"), "utf8"), "a");
  // Also a plain file or a symlink at that path.
  writeFileSync(dest(sb, ID2), "in the way");
  assert.equal(call(copyReq(sb, ["a.txt"], { id: ID2 })).ok, false);
});

test("copy refuses a destination that is a symlink, and never writes through it", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  mkdirSync(join(sb.snaps, KEY), { recursive: true });
  if (!link(t, sb.outside, dest(sb))) return;
  assert.equal(call(copyReq(sb, ["a.txt"])).ok, false);
  assert.deepEqual(readdirSync(sb.outside), ["canary.txt"]);
});

test("copy only writes <projectKey>/<id>: other destination shapes are refused", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const shapes = [
    join(sb.snaps, "plain-name", ID),
    join(sb.snaps, KEY, "not-an-id"),
    join(sb.snaps, ID),
    join(sb.snaps, KEY, "..", ID),
  ];
  for (const destDir of shapes) {
    const res = call({ ...copyReq(sb, ["a.txt"]), destDir });
    assert.equal(res.ok, false, destDir);
  }
  assert.equal(call({ ...copyReq(sb, ["a.txt"]), destDir: "relative/path" }).ok, false);
  assert.equal(call({ ...copyReq(sb, ["a.txt"]), destDir: undefined }).ok, false);
});

test("copy refuses a manifest whose id is not the destination's, or that is invalid", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const badManifests = [
    { id: ID2 },
    { id: "../../x" },
    { v: 2 },
    { kind: "after-command" },
    { createdAt: "yesterday" },
    { n: "seven" },
    { tool: 5 },
  ];
  for (const bad of badManifests) {
    const res = call({ ...copyReq(sb, ["a.txt"]), manifest: { ...manifestIn(), ...bad } });
    assert.equal(res.ok, false, JSON.stringify(bad));
  }
  assert.equal(exists(dest(sb)), false);
});

test("copy refuses a destination inside a target", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const inside = join(sb.project, "box", KEY, ID);
  const res = call({ ...copyReq(sb, ["box"]), destDir: inside });
  assert.deepEqual(res, { ok: false, error: "destination is inside a target" });
  // Next to the project's files is fine (a project folder that holds the snapshots folder).
  const sb2 = sandbox();
  put(sb2, "a.txt", "a");
  const ok = call({ ...copyReq(sb2, ["a.txt"]), destDir: join(sb2.project, ".snaps", KEY, ID) });
  assert.equal(ok.ok, true);
});

test("copy only keeps whitelisted manifest fields and cleans git facts", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const hostile = {
    evil: "x",
    __proto__: { polluted: true },
    root: "/somewhere/else",
    backend: "fs",
    files: [{ rel: "../../etc/passwd", size: 1, mtimeMs: 1 }],
    command: "echo   hi\u0007\n there",
    risks: [{ kind: "delete", label: "rm -rf", name: "build", extra: 1 }, "junk", { kind: 5 }],
    git: { head: "-f", branch: "main", ref: "refs/kit-safety/x", stashSha: "z".repeat(40), branches: [{ name: "ok", sha: "b".repeat(40) }, { name: "bad name", sha: "b".repeat(40) }] },
    restoredFrom: "nope",
  };
  const res = call(copyReq(sb, ["a.txt"], { manifest: JSON.parse(JSON.stringify(hostile).replace('"evil"', '"__proto__x"')) }));
  assert.equal(res.ok, true, JSON.stringify(res));
  const m = manifestOnDisk(sb);
  assert.equal(m.evil, undefined);
  assert.equal(m.root, sb.project);
  assert.equal(m.backend, "node");
  assert.deepEqual(m.files.map((f) => f.rel), ["a.txt"]);
  assert.equal("command" in m, false, "the command text is never stored");
  assert.deepEqual(m.risks, [{ kind: "delete", label: "rm -rf", name: "build" }]);
  assert.deepEqual(m.git, { head: null, branch: "main", ref: "refs/kit-safety/x", branches: [{ name: "ok", sha: "b".repeat(40) }] });
  assert.equal(m.restoredFrom, undefined);
  assert.equal(({}).polluted, undefined);
});

// ---- restore ----

test("restore brings back deleted and modified files, keeps newer files, and keeps times and modes", () => {
  const sb = sandbox();
  const keep = put(sb, "build/a.txt", "original a");
  put(sb, "build/sub/b.txt", "original b");
  put(sb, "build/sub/c.txt", "original c");
  put(sb, "loose.txt", "loose original");
  const old = new Date("2021-05-06T07:08:09.000Z");
  utimesSync(keep, old, old);
  if (!WIN) chmodSync(keep, 0o750);
  const manifest = copyOk(sb, ["build", "loose.txt"]);
  assert.equal(manifest.files.length, 4);

  // The aftermath: one file deleted, one changed, a whole sub folder gone, new work added.
  rmSync(join(sb.project, "build", "a.txt"));
  put(sb, "build/sub/b.txt", "changed afterwards");
  rmSync(join(sb.project, "build", "sub", "c.txt"));
  put(sb, "build/new.txt", "newer work");
  put(sb, "build/sub/newer.txt", "newer work too");
  rmSync(join(sb.project, "loose.txt"));

  const res = call(restoreReq(sb));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.restored, 4);
  assert.deepEqual(res.failed, []);
  assert.equal(res.failedCount, 0);
  assert.equal(res.keptNewer, 2);
  assert.equal(res.bytes, "original a".length + "original b".length + "original c".length + "loose original".length);
  assert.equal(read(sb, "build/a.txt").toString(), "original a");
  assert.equal(read(sb, "build/sub/b.txt").toString(), "original b");
  assert.equal(read(sb, "build/sub/c.txt").toString(), "original c");
  assert.equal(read(sb, "loose.txt").toString(), "loose original");
  assert.equal(read(sb, "build/new.txt").toString(), "newer work");
  assert.equal(read(sb, "build/sub/newer.txt").toString(), "newer work too");
  const back = statSync(join(sb.project, "build", "a.txt"));
  assert.equal(Math.floor(back.mtimeMs), old.getTime());
  if (!WIN) assert.equal(back.mode & 0o777, 0o750);
  assert.deepEqual(tree(sb).filter((p) => p.includes(".kit-safety")), [], "no temp files are left");
});

test("restore recreates a deleted folder tree, binary files and empty folders", () => {
  const sb = sandbox();
  const big = randomBytes(2 * MB + 7);
  put(sb, "site/img/logo.png", big);
  put(sb, "site/index.html", "<html>");
  mkdirSync(join(sb.project, "site", "cache", "empty"), { recursive: true });
  copyOk(sb, ["site"]);
  rmSync(join(sb.project, "site"), { recursive: true });
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true);
  assert.equal(res.restored, 2);
  assert.equal(res.dirs, 1);
  assert.ok(read(sb, "site/img/logo.png").equals(big));
  assert.ok(statSync(join(sb.project, "site", "cache", "empty")).isDirectory());
  assert.equal(res.keptNewer, 0);
});

test("restore of unicode and spaced names, into a root that is itself spaced", () => {
  const sb = sandbox();
  const spaced = join(sb.dir, "my project (v2) Đà Nẵng");
  mkdirSync(spaced, { recursive: true });
  mkdirSync(join(spaced, "Thư mục"), { recursive: true });
  writeFileSync(join(spaced, "Thư mục", "bảng tính 1.txt"), "xin chào");
  const id = ID;
  const destDir = join(sb.snaps, KEY, id);
  const copied = call({ cmd: "copy", root: spaced, destDir, targets: ["Thư mục"], ...LIMITS, manifest: manifestIn(id) });
  assert.equal(copied.ok, true, JSON.stringify(copied));
  rmSync(join(spaced, "Thư mục"), { recursive: true });
  const res = call({ cmd: "restore", root: spaced, snapDir: destDir });
  assert.equal(res.restored, 1);
  assert.equal(readFileSync(join(spaced, "Thư mục", "bảng tính 1.txt"), "utf8"), "xin chào");
});

test("restore with `only` brings back just those files (and everything under a folder)", () => {
  const sb = sandbox();
  put(sb, "p/a.txt", "a");
  put(sb, "p/q/b.txt", "b");
  put(sb, "p/q/c.txt", "c");
  put(sb, "r.txt", "r");
  mkdirSync(join(sb.project, "p", "q", "empty"));
  copyOk(sb, ["p", "r.txt"]);
  rmSync(join(sb.project, "p"), { recursive: true });
  rmSync(join(sb.project, "r.txt"));
  const one = call(restoreReq(sb, { only: ["p/a.txt"] }));
  assert.equal(one.restored, 1);
  assert.deepEqual(tree(sb), ["p/", "p/a.txt"]);
  const folder = call(restoreReq(sb, { only: ["p/q"] }));
  assert.equal(folder.restored, 2);
  assert.equal(folder.dirs, 1);
  assert.deepEqual(tree(sb), ["p/", "p/a.txt", "p/q/", "p/q/b.txt", "p/q/c.txt", "p/q/empty/"]);
  const none = call(restoreReq(sb, { only: ["p/qq"] }));
  assert.equal(none.restored, 0, "p/qq is not under p/q");
  assert.equal(call(restoreReq(sb, { only: [] })).restored, 0);
  assert.equal(exists(join(sb.project, "r.txt")), false);
});

test("restore counts newer files only inside the scope that was asked for", () => {
  const sb = sandbox();
  put(sb, "p/a.txt", "a");
  put(sb, "p/q/b.txt", "b");
  copyOk(sb, ["p"]);
  put(sb, "p/mine.txt", "mine");
  put(sb, "p/q/mine2.txt", "mine2");
  assert.equal(call(restoreReq(sb)).keptNewer, 2);
  assert.equal(call(restoreReq(sb, { only: ["p/q"] })).keptNewer, 1);
  assert.equal(call(restoreReq(sb, { only: ["p/a.txt"] })).keptNewer, 0);
});

test("restore reports a file whose stored copy was changed as corrupt and leaves the project file alone", () => {
  const sb = sandbox();
  put(sb, "d/good.txt", "good");
  put(sb, "d/bad.txt", "bad");
  put(sb, "d/gone.txt", "gone");
  copyOk(sb, ["d"]);
  writeFileSync(join(dest(sb), "files", "d", "bad.txt"), "tampered!");
  rmSync(join(dest(sb), "files", "d", "gone.txt"));
  put(sb, "d/bad.txt", "the person's current text");
  rmSync(join(sb.project, "d", "good.txt"));
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true);
  assert.equal(res.restored, 1);
  assert.deepEqual(res.failed.sort((a, b) => (a.rel < b.rel ? -1 : 1)), [
    { rel: "d/bad.txt", reason: "corrupt" },
    { rel: "d/gone.txt", reason: "missing" },
  ]);
  assert.equal(read(sb, "d/bad.txt").toString(), "the person's current text");
  assert.equal(read(sb, "d/good.txt").toString(), "good");
  assert.deepEqual(tree(sb).filter((p) => p.includes(".kit-safety") || p.endsWith(".tmp")), []);
});

test("restore refuses a wrong sha256 in the manifest and writes nothing for that file", () => {
  const sb = sandbox();
  put(sb, "a.txt", "alpha");
  copyOk(sb, ["a.txt"]);
  const file = join(dest(sb), "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  m.files[0].sha256 = sha("something else");
  writeFileSync(file, JSON.stringify(m));
  put(sb, "a.txt", "current");
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 0);
  assert.deepEqual(res.failed, [{ rel: "a.txt", reason: "corrupt" }]);
  assert.equal(read(sb, "a.txt").toString(), "current");
});

test("restore without sha256 in the manifest (a snapshot made without Node) restores what is stored", () => {
  const sb = sandbox();
  const snap = dest(sb);
  mkdirSync(join(snap, "files", "t"), { recursive: true });
  writeFileSync(join(snap, "files", "t", "note.txt"), "from the fs backend");
  const manifest = { ...manifestIn(), root: sb.project, backend: "fs", targets: ["t"], files: [{ rel: "t/note.txt", size: 3, mtimeMs: 1_600_000_000_000 }], dirs: ["t/empty"], skipped: [], totalBytes: 3 };
  writeFileSync(join(snap, "manifest.json"), JSON.stringify(manifest));
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.restored, 1);
  assert.equal(read(sb, "t/note.txt").toString(), "from the fs backend");
  assert.equal(Math.floor(statSync(join(sb.project, "t", "note.txt")).mtimeMs), 1_600_000_000_000);
  assert.ok(statSync(join(sb.project, "t", "empty")).isDirectory());
});

test("restore refuses a tampered manifest entirely, writing nothing", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  put(sb, "b.txt", "b");
  copyOk(sb, ["a.txt", "b.txt"]);
  const file = join(dest(sb), "manifest.json");
  const good = JSON.parse(readFileSync(file, "utf8"));
  rmSync(join(sb.project, "a.txt"));
  rmSync(join(sb.project, "b.txt"));
  const evil = ["../escape.txt", "a/../../escape.txt", "/tmp/escape.txt", "C:\\escape.txt", "C:/escape.txt", "sub\\..\\..\\escape.txt", "a//b", "./a.txt", "a.txt/", "", "x\0y"];
  for (const rel of evil) {
    for (const where of ["files", "dirs", "targets"]) {
      const m = JSON.parse(JSON.stringify(good));
      if (where === "files") m.files.push({ rel, size: 1, mtimeMs: 1 });
      else m[where].push(rel);
      writeFileSync(file, JSON.stringify(m));
      const res = call(restoreReq(sb));
      assert.equal(res.ok, false, `${where} ${JSON.stringify(rel)}`);
    }
  }
  assert.deepEqual(tree(sb), [], "not even the good entries were restored");
  assert.equal(exists(join(sb.dir, "escape.txt")), false);
  assert.equal(exists(join(tmp, "escape.txt")), false);
});

test("restore refuses invalid manifests of other kinds", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  const file = join(dest(sb), "manifest.json");
  const good = JSON.parse(readFileSync(file, "utf8"));
  rmSync(join(sb.project, "a.txt"));
  const variants = [
    (m) => ({ ...m, v: 2 }),
    (m) => ({ ...m, v: undefined }),
    (m) => ({ ...m, id: ID2 }), // not the folder's id
    (m) => ({ ...m, id: "../x" }),
    (m) => ({ ...m, kind: "other" }),
    (m) => ({ ...m, backend: "cloud" }),
    (m) => ({ ...m, files: "all" }),
    (m) => ({ ...m, files: [{ rel: "a.txt", size: "big", mtimeMs: 1 }] }),
    (m) => ({ ...m, files: [{ rel: "a.txt", size: 1, mtimeMs: 1, sha256: "xyz" }] }),
    (m) => ({ ...m, files: [{ rel: "a.txt", size: 1, mtimeMs: 1, mode: 0o17777 }] }),
    (m) => ({ ...m, files: [m.files[0], m.files[0]] }),
    (m) => ({ ...m, files: [null] }),
    (m) => ({ ...m, dirs: 5 }),
    (m) => [m],
    () => "text",
    () => null,
  ];
  for (const make of variants) {
    writeFileSync(file, JSON.stringify(make(good)));
    assert.equal(call(restoreReq(sb)).ok, false, JSON.stringify(make(good)).slice(0, 80));
  }
  for (const raw of ["", "{", "not json at all", "\u0000\u0000"]) {
    writeFileSync(file, raw);
    assert.equal(call(restoreReq(sb)).ok, false, raw);
  }
  assert.deepEqual(tree(sb), []);
});

test("restore refuses an `only` entry that is unsafe", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  for (const only of [["../a.txt"], ["/a.txt"], ["a.txt", ".."], "a.txt", [3]]) {
    assert.equal(call(restoreReq(sb, { only })).ok, false, JSON.stringify(only));
  }
});

test("restore refuses a missing, symlinked or manifest-less snapshot folder", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  assert.equal(call(restoreReq(sb)).ok, false);
  copyOk(sb, ["a.txt"]);
  rmSync(join(sb.project, "a.txt"));
  const empty = join(sb.snaps, KEY, ID2);
  mkdirSync(empty, { recursive: true });
  assert.equal(call(restoreReq(sb, { snapDir: empty })).ok, false);
  if (!link(t, dest(sb), join(sb.snaps, KEY, "20261124T093017Z"))) return;
  assert.equal(call(restoreReq(sb, { snapDir: join(sb.snaps, KEY, "20261124T093017Z") })).ok, false);
  assert.equal(exists(join(sb.project, "a.txt")), false);
});

test("restore never writes through a symlinked folder in the project, even one that leads outside", (t) => {
  const sb = sandbox();
  put(sb, "build/a.txt", "a");
  put(sb, "build/deep/b.txt", "b");
  copyOk(sb, ["build"]);
  rmSync(join(sb.project, "build"), { recursive: true });
  if (!link(t, sb.outside, join(sb.project, "build"))) return;
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true);
  assert.equal(res.restored, 0);
  assert.deepEqual(res.failed.map((f) => f.reason), ["outside", "outside"]);
  assert.deepEqual(readdirSync(sb.outside), ["canary.txt"]);
  canaryIntact(sb);
});

test("restore does not follow a link into a folder inside the project either", (t) => {
  const sb = sandbox();
  put(sb, "build/a.txt", "a");
  copyOk(sb, ["build"]);
  rmSync(join(sb.project, "build"), { recursive: true });
  mkdirSync(join(sb.project, "real"));
  if (!link(t, join(sb.project, "real"), join(sb.project, "build"))) return;
  const res = call(restoreReq(sb));
  assert.deepEqual(res.failed, [{ rel: "build/a.txt", reason: "symlink" }]);
  assert.deepEqual(readdirSync(join(sb.project, "real")), []);
});

test("restore replaces a symlink standing where a file was, without touching what it pointed to", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "stored text");
  copyOk(sb, ["a.txt"]);
  rmSync(join(sb.project, "a.txt"));
  if (!link(t, join(sb.outside, "canary.txt"), join(sb.project, "a.txt"))) return;
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 1);
  assert.equal(lstatSync(join(sb.project, "a.txt")).isSymbolicLink(), false);
  assert.equal(read(sb, "a.txt").toString(), "stored text");
  canaryIntact(sb);
});

test("restore refuses to turn a folder into a file, and a file into a folder", () => {
  const sb = sandbox();
  put(sb, "x/file.txt", "f");
  put(sb, "plain.txt", "p");
  copyOk(sb, ["x", "plain.txt"]);
  rmSync(join(sb.project, "x"), { recursive: true });
  rmSync(join(sb.project, "plain.txt"));
  put(sb, "x", "a file where the folder was");
  mkdirSync(join(sb.project, "plain.txt", "inside"), { recursive: true });
  put(sb, "plain.txt/inside/keep.txt", "keep me");
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 0);
  assert.deepEqual(res.failed.map((f) => `${f.rel}:${f.reason}`).sort(), ["plain.txt:blocked", "x/file.txt:blocked"]);
  assert.equal(read(sb, "x").toString(), "a file where the folder was");
  assert.equal(read(sb, "plain.txt/inside/keep.txt").toString(), "keep me");
});

test("restore does not follow a symlink inside the snapshot's own files folder", (t) => {
  const sb = sandbox();
  put(sb, "d/a.txt", "a");
  put(sb, "d/b.txt", "b");
  copyOk(sb, ["d"]);
  rmSync(join(sb.project, "d"), { recursive: true });
  rmSync(join(dest(sb), "files", "d", "a.txt"));
  if (!link(t, join(sb.outside, "canary.txt"), join(dest(sb), "files", "d", "a.txt"))) return;
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 1);
  assert.deepEqual(res.failed, [{ rel: "d/a.txt", reason: "corrupt" }]);
  assert.equal(exists(join(sb.project, "d", "a.txt")), false);
  // And a whole stored folder replaced by a link.
  rmSync(join(dest(sb), "files", "d"), { recursive: true });
  if (!link(t, sb.outside, join(dest(sb), "files", "d"))) return;
  const res2 = call(restoreReq(sb));
  assert.equal(res2.restored, 0);
  assert.ok(res2.failed.length >= 1);
  assert.equal(exists(join(sb.project, "d", "canary.txt")), false);
  canaryIntact(sb);
});

test("restore twice is the same as once", () => {
  const sb = sandbox();
  put(sb, "a/one.txt", "1");
  copyOk(sb, ["a"]);
  call(restoreReq(sb));
  const again = call(restoreReq(sb));
  assert.equal(again.ok, true);
  assert.equal(again.restored, 1);
  assert.equal(again.keptNewer, 0);
  assert.equal(read(sb, "a/one.txt").toString(), "1");
});

// ---- fix pass: summary answers, which limit tripped, setuid, whitelist ----

test("scan says which limit tripped: files, bytes, or (when both) bytes", () => {
  const sb = sandbox();
  for (let i = 0; i < 30; i += 1) put(sb, `empties/e${String(i).padStart(2, "0")}`, "");
  const byFiles = call({ cmd: "scan", root: sb.project, targets: ["empties"], maxBytes: MB, maxFiles: 10 });
  assert.equal(byFiles.tooBig, true);
  assert.equal(byFiles.tooBigBy, "files");
  assert.equal(byFiles.bytes, 0, "no bytes at all: a file count is not a size");
  for (let i = 0; i < 5; i += 1) put(sb, `sized/f${i}`, "x".repeat(100));
  const byBytes = call({ cmd: "scan", root: sb.project, targets: ["sized"], maxBytes: 250, maxFiles: 1000 });
  assert.equal(byBytes.tooBigBy, "bytes");
  // Only the file limit: the 4th file is over 3 files but not over the size.
  const onlyFiles = call({ cmd: "scan", root: sb.project, targets: ["sized"], maxBytes: 1000, maxFiles: 3 });
  assert.equal(onlyFiles.tooBigBy, "files");
  // Both at once (the 4th file passes the file limit and the size limit together): the size is the reason.
  const both = call({ cmd: "scan", root: sb.project, targets: ["sized"], maxBytes: 350, maxFiles: 3 });
  assert.equal(both.tooBig, true);
  assert.equal(both.tooBigBy, "bytes");
  // Not too big: no `tooBigBy` at all.
  const fine = call({ cmd: "scan", root: sb.project, targets: ["sized"], ...LIMITS });
  assert.equal(fine.tooBig, false);
  assert.equal("tooBigBy" in fine, false);
});

test("scan: more than the limit of EMPTY files is a file-count problem with 0 bytes (51 000 empty files in the real world)", () => {
  const sb = sandbox();
  for (let i = 0; i < 60; i += 1) put(sb, `empty/f${i}`, "");
  const res = call({ cmd: "scan", root: sb.project, targets: ["empty"], maxBytes: 200 * MB, maxFiles: 50 });
  assert.equal(res.tooBig, true);
  assert.equal(res.tooBigBy, "files");
  assert.equal(res.bytes, 0);
});

test("copy answers with a summary only: no manifest, no file list, and the answer stays small however big the tree is", () => {
  const sb = sandbox();
  for (let i = 0; i < 3000; i += 1) put(sb, `tree/d${i % 50}/module-with-a-rather-long-file-name-${i}.js`, "x");
  const res = call(copyReq(sb, ["tree"]));
  assert.equal(res.ok, true);
  assert.equal(res.tooBig, false);
  assert.deepEqual(Object.keys(res).sort(), ["bytes", "dirs", "files", "missing", "missingCount", "ok", "skippedCount", "tooBig"]);
  assert.equal(res.files, 3000);
  assert.equal(res.bytes, 3000);
  assert.ok(JSON.stringify(res).length < 400, "a few hundred bytes, not megabytes");
  const manifest = manifestOnDisk(sb);
  assert.equal(manifest.files.length, 3000);
  assert.ok(JSON.stringify(manifest).length > 200_000, "the manifest itself is on disk, far bigger than the answer");
});

test("copy that is too big says which limit, writes no folder, and lists nothing big", () => {
  const sb = sandbox();
  for (let i = 0; i < 12; i += 1) put(sb, `big/f${i}.txt`, "x".repeat(100));
  const bytes = call({ ...copyReq(sb, ["big"]), maxBytes: 500 });
  assert.deepEqual([bytes.ok, bytes.tooBig, bytes.tooBigBy], [true, true, "bytes"]);
  assert.equal("skipped" in bytes, false);
  assert.equal("manifest" in bytes, false);
  const files = call({ ...copyReq(sb, ["big"]), maxFiles: 5 });
  assert.deepEqual([files.tooBig, files.tooBigBy], [true, "files"]);
  assert.equal(exists(dest(sb)), false);
});

test("a long list of missing targets and of skipped entries is cut to 500 (the count stays complete), each path to 300 characters", () => {
  const sb = sandbox();
  put(sb, "real.txt", "r");
  // Each name is under the file system's limit; the whole path is not (a missing folder, so the target is "missing").
  const ghosts = Array.from({ length: 700 }, (_, i) => `ghost-${i}/${"d".repeat(100)}/${"e".repeat(100)}/${"f".repeat(100)}`);
  const scan = call({ cmd: "scan", root: sb.project, targets: ["real.txt", ...ghosts], ...LIMITS });
  assert.equal(scan.missing.length, 500);
  assert.equal(scan.missingCount, 700);
  assert.ok(scan.missing.every((m) => m.length <= 300));
  const copy = call(copyReq(sb, ["real.txt", ...ghosts]));
  assert.equal(copy.missing.length, 500);
  assert.equal(copy.missingCount, 700);
  assert.ok(JSON.stringify(copy).length < 200_000);
  // Skipped entries (links) with long names.
  const sb2 = sandbox();
  put(sb2, "d/real.txt", "r");
  let made = 0;
  for (let i = 0; i < 520; i += 1) {
    try {
      symlinkSync(sb2.outside, join(sb2.project, "d", `${"L".repeat(120)}-${i}`));
      made += 1;
    } catch {
      break;
    }
  }
  if (made > 0) {
    const res = call({ cmd: "scan", root: sb2.project, targets: ["d"], ...LIMITS });
    assert.equal(res.skippedCount, made);
    assert.ok(res.skipped.length <= 500);
    assert.ok(res.skipped.every((x) => x.rel.length <= 300));
  }
});

test("the manifest keeps no command: an old caller that sends one gets none on disk", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const manifest = copyOk(sb, ["a.txt"], { manifest: { command: "PGPASSWORD=hunter2 psql -h db" } });
  assert.equal("command" in manifest, false);
  assert.equal(readFileSync(join(dest(sb), "manifest.json"), "utf8").includes("hunter2"), false);
  // An old manifest on disk that still has a command: restore reads it fine.
  const file = join(dest(sb), "manifest.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), command: "mysql -ps3cret" }));
  put(sb, "a.txt", "changed");
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(read(sb, "a.txt").toString(), "a");
});

test("quiet is kept only when it is true", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  assert.equal(copyOk(sb, ["a.txt"], { manifest: { quiet: true } }).quiet, true);
  let n = 0;
  for (const quiet of [false, "yes", 1, null, {}]) {
    n += 1;
    const id = `20261124T1000${10 + n}Z`;
    assert.equal("quiet" in copyOk(sb, ["a.txt"], { id, manifest: { quiet } }), false, JSON.stringify(quiet));
  }
});

test("git facts: isPartial and the remote flag are kept; branch names git accepts are kept, the rest dropped", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  const A = "a".repeat(40);
  const manifest = copyOk(sb, ["a.txt"], {
    manifest: {
      git: {
        head: A,
        branch: "main",
        isPartial: true,
        branches: [
          { name: "plain", sha: A },
          { name: "feat+x", sha: A },
          { name: "fix/lỗi-đăng-nhập", sha: A },
          { name: "origin/main", sha: A, remote: true },
          { name: "o/x", sha: A, remote: "yes" },
          { name: "bad name", sha: A },
          { name: "-D", sha: A },
          { name: "a..b", sha: A },
          { name: "a@{1}", sha: A },
          { name: "x.lock", sha: A },
          { name: "tab\there", sha: A },
          { name: "ok", sha: "short" },
        ],
      },
    },
  });
  assert.equal(manifest.git.isPartial, true);
  assert.deepEqual(manifest.git.branches, [
    { name: "plain", sha: A },
    { name: "feat+x", sha: A },
    { name: "fix/lỗi-đăng-nhập", sha: A },
    { name: "origin/main", sha: A, remote: true },
    { name: "o/x", sha: A },
  ]);
  const sb2 = sandbox();
  put(sb2, "a.txt", "a");
  assert.equal("isPartial" in copyOk(sb2, ["a.txt"], { manifest: { git: { head: A, branch: "main", isPartial: "yes" } } }).git, false);
});

test("copy never records or stores a setuid, setgid or sticky bit", (t) => {
  if (WIN) return t.skip("no permission bits on Windows");
  const sb = sandbox();
  const file = put(sb, "bin/tool", "#!/bin/sh\n");
  chmodSync(file, 0o4755);
  if ((statSync(file).mode & 0o7000) === 0) return t.skip("this filesystem does not keep setuid bits");
  const manifest = copyOk(sb, ["bin"]);
  assert.equal(manifest.files[0].mode, 0o755);
  assert.equal(statSync(join(dest(sb), "files", "bin", "tool")).mode & 0o7000, 0);
});

test("restore writes permission bits only: a manifest that says 04755, 02755 or 01777 never brings back setuid, setgid or sticky", (t) => {
  if (WIN) return t.skip("no permission bits on Windows");
  const sb = sandbox();
  for (const [rel, mode] of [["bin/suid", 0o4755], ["bin/sgid", 0o2755], ["bin/sticky", 0o1777], ["bin/all", 0o7777], ["bin/plain", 0o640]]) put(sb, rel, rel);
  copyOk(sb, ["bin"]);
  const file = join(dest(sb), "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  const wanted = { "bin/suid": 0o4755, "bin/sgid": 0o2755, "bin/sticky": 0o1777, "bin/all": 0o7777, "bin/plain": 0o640 };
  for (const f of m.files) f.mode = wanted[f.rel];
  writeFileSync(file, JSON.stringify(m));
  rmSync(join(sb.project, "bin"), { recursive: true });
  const res = call(restoreReq(sb));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.restored, 5);
  for (const rel of Object.keys(wanted)) {
    const mode = statSync(join(sb.project, ...rel.split("/"))).mode;
    assert.equal(mode & 0o7000, 0, `${rel} came back with special bits: ${(mode & 0o7777).toString(8)}`);
  }
  assert.equal(statSync(join(sb.project, "bin", "suid")).mode & 0o777, 0o755);
  assert.equal(statSync(join(sb.project, "bin", "plain")).mode & 0o777, 0o640);
});

test("restore of a copied setuid file (made by an older helper that recorded the bit) never sets it", (t) => {
  if (WIN) return t.skip("no permission bits on Windows");
  const sb = sandbox();
  put(sb, "x/tool", "t");
  copyOk(sb, ["x"]);
  // An older snapshot: the stored copy itself carries the bit, and so does the manifest.
  const stored = join(dest(sb), "files", "x", "tool");
  chmodSync(stored, 0o4755);
  const file = join(dest(sb), "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  delete m.files[0].mode;
  writeFileSync(file, JSON.stringify(m));
  rmSync(join(sb.project, "x"), { recursive: true });
  assert.equal(call(restoreReq(sb)).ok, true);
  assert.equal(statSync(join(sb.project, "x", "tool")).mode & 0o7000, 0);
});

// ---- remove ----

test("remove deletes one snapshot folder recursively and leaves its neighbours", () => {
  const sb = sandbox();
  put(sb, "a/x.txt", "x");
  copyOk(sb, ["a"]);
  copyOk(sb, ["a"], { id: ID2 });
  const res = call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID });
  assert.deepEqual(res, { ok: true, removed: true });
  assert.equal(exists(dest(sb)), false);
  assert.equal(exists(dest(sb, ID2)), true);
  assert.equal(exists(join(sb.snaps, KEY)), true);
  assert.deepEqual(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }), { ok: true, removed: false });
  assert.deepEqual(call({ cmd: "remove", snapshotsRoot: join(sb.dir, "none"), projectKey: KEY, id: ID }), { ok: true, removed: false });
  assert.deepEqual(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: "other-aaaaaaaaaaaaaa", id: ID }), { ok: true, removed: false });
  // The project's files were never involved.
  assert.equal(read(sb, "a/x.txt").toString(), "x");
});

test("remove deletes a read-only stored file and a half-made snapshot without a manifest", () => {
  if (WIN) return;
  const sb = sandbox();
  chmodSync(put(sb, "ro/f.txt", "x"), 0o444);
  copyOk(sb, ["ro"]);
  mkdirSync(join(dest(sb, ID2), "files", "z"), { recursive: true });
  writeFileSync(join(dest(sb, ID2), "files", "z", "partial"), "p");
  assert.equal(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }).removed, true);
  assert.equal(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID2 }).removed, true);
  assert.deepEqual(readdirSync(join(sb.snaps, KEY)), []);
});

test("remove refuses ids and project keys that could climb out or name something else", () => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  const ids = ["..", ".", "", "../x", `../${ID}`, `${ID}/..`, `${ID}/`, "/etc", "20261124", "latest", `${ID}\0`, `${ID}-0`, `${ID}-`, `${ID} `, " " + ID, ID.toLowerCase(), 5, null, undefined, [ID]];
  for (const id of ids) {
    const res = call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id });
    assert.equal(res.ok, false, JSON.stringify(id));
  }
  const keys = ["..", ".", "", "../snaps", `${KEY}/..`, "acme", "ACME-SHOP-A1B2C3D4E5F607", "acme-shop-a1b2c3d4e5f60", "acme shop-a1b2c3d4e5f607", 5, null];
  for (const projectKey of keys) {
    const res = call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey, id: ID });
    assert.equal(res.ok, false, JSON.stringify(projectKey));
  }
  assert.equal(call({ cmd: "remove", snapshotsRoot: "relative", projectKey: KEY, id: ID }).ok, false);
  assert.equal(exists(dest(sb)), true, "the snapshot is still there");
  assert.equal(read(sb, "a.txt").toString(), "a");
});

test("remove refuses a project folder or a snapshot folder that is a symlink, and deletes nothing outside", (t) => {
  const sb = sandbox();
  // snaps/<KEY> is a link to a folder that holds a folder named like a snapshot id.
  mkdirSync(join(sb.outside, ID));
  writeFileSync(join(sb.outside, ID, "precious.txt"), "precious");
  if (!link(t, sb.outside, join(sb.snaps, KEY))) return;
  assert.equal(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }).ok, false);
  assert.equal(readFileSync(join(sb.outside, ID, "precious.txt"), "utf8"), "precious");
  rmSync(join(sb.snaps, KEY));
  // snaps/<KEY>/<ID> is itself a link.
  mkdirSync(join(sb.snaps, KEY));
  if (!link(t, join(sb.outside, ID), join(sb.snaps, KEY, ID))) return;
  assert.equal(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }).ok, false);
  assert.equal(readFileSync(join(sb.outside, ID, "precious.txt"), "utf8"), "precious");
  canaryIntact(sb);
});

test("remove does not follow symlinks inside the snapshot", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  if (!link(t, sb.outside, join(dest(sb), "files", "trap"))) return;
  assert.deepEqual(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }), { ok: true, removed: true });
  assert.equal(exists(dest(sb)), false);
  canaryIntact(sb);
});

test("remove works when the snapshots folder itself is reached through a symlink", (t) => {
  const sb = sandbox();
  put(sb, "a.txt", "a");
  copyOk(sb, ["a.txt"]);
  const alias = join(sb.dir, "snaps-alias");
  if (!link(t, sb.snaps, alias)) return;
  assert.deepEqual(call({ cmd: "remove", snapshotsRoot: alias, projectKey: KEY, id: ID }), { ok: true, removed: true });
});

test("a full cycle: copy, damage, restore, remove", () => {
  const sb = sandbox();
  put(sb, "src/app.ts", "export const a = 1\n");
  put(sb, "src/lib/util.ts", "export const b = 2\n");
  const scan = call({ cmd: "scan", root: sb.project, targets: ["src"], ...LIMITS });
  assert.equal(scan.tooBig, false);
  copyOk(sb, ["src"]);
  rmSync(join(sb.project, "src"), { recursive: true });
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 2);
  assert.equal(read(sb, "src/lib/util.ts").toString(), "export const b = 2\n");
  assert.equal(call({ cmd: "remove", snapshotsRoot: sb.snaps, projectKey: KEY, id: ID }).removed, true);
  assert.deepEqual(tree(sb), ["src/", "src/app.ts", "src/lib/", "src/lib/util.ts"]);
});

// ---- importing the module, and a restore that races with a swapped folder ----

test("importing the module does not run the helper (no read of stdin, no answer, no exit)", () => {
  assert.equal(typeof restoreFile, "function");
  assert.equal(typeof confirmParent, "function");
  assert.equal(typeof walkParents, "function");
  assert.equal(new Refusal("outside").reason, "outside");
});

test("started on a path that goes through a symlink, or a relative path, the helper still answers", (t) => {
  const alias = join(tmp, `alias-${randomBytes(4).toString("hex")}.mjs`);
  if (link(t, SCRIPT, alias)) {
    const res = spawnSync(process.execPath, [alias], { input: JSON.stringify({ cmd: "hello" }), encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).ok, true);
  }
  const rel = spawnSync(process.execPath, ["safety-fs.mjs"], { cwd: dirname(SCRIPT), input: JSON.stringify({ cmd: "hello" }), encoding: "utf8" });
  assert.equal(rel.status, 0);
  assert.equal(JSON.parse(rel.stdout).ok, true);
});

test("a manifest with the skip reason private validates: the .env it names is not counted as newer work, a made-up reason is not known", () => {
  const sb = sandbox();
  put(sb, "cfg/a.txt", "a");
  copyOk(sb, ["cfg"]);
  const file = join(dest(sb), "manifest.json");
  const base = JSON.parse(readFileSync(file, "utf8"));
  const keptFor = (reason) => {
    writeFileSync(file, JSON.stringify({ ...base, skipped: [{ rel: "cfg/.env", reason }] }));
    rmSync(join(sb.project, "cfg"), { recursive: true, force: true });
    put(sb, "cfg/.env", "SECRET=1");
    const res = call(restoreReq(sb));
    assert.equal(res.ok, true);
    assert.deepEqual(res.failed, []);
    assert.equal(res.restored, 1);
    assert.equal(read(sb, "cfg/.env").toString(), "SECRET=1", "the .env is never touched");
    return res.keptNewer;
  };
  assert.equal(keptFor("private"), 0);
  assert.equal(keptFor("bogus"), 1);
});

/** A project with a folder tree whose file was deleted, and the snapshot that brings it back. */
function raceWorld(rel = "a/b/f.txt") {
  const sb = sandbox();
  put(sb, rel, "old content");
  copyOk(sb, [rel.split("/")[0]]);
  rmSync(join(sb.project, ...rel.split("/")));
  const root = realpathSync(sb.project);
  const buf = Buffer.from("old content");
  const file = { rel, size: buf.length, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: sha(buf) };
  const stored = join(dest(sb), "files", ...rel.split("/"));
  const parent = {};
  const abs = walkParents(root, rel, true, new Set(), parent);
  const folder = dirname(abs);
  return { sb, root, file, stored, parent, abs, folder, guard: { root, parent } };
}
/** Replaces `folder` by a link to `target`, as an attacker with write access to the project could between two steps. */
function swapForLink(t, folder, target) {
  try {
    renameSync(folder, `${folder}-moved`);
  } catch (e) {
    // Windows refuses to rename a folder while a handle is open inside it (the temp file being written): the swap cannot happen there
    if (WIN && (e.code === "EPERM" || e.code === "EBUSY")) return false;
    throw e;
  }
  return link(t, target, folder);
}
const noTemps = (dir) => readdirSync(dir).filter((n) => n.startsWith(".kit-safety-"));

test("walkParents tells the identity of the folder it checked", () => {
  const w = raceWorld();
  const st = lstatSync(w.folder);
  assert.equal(w.parent.ino, st.ino);
  assert.equal(w.parent.dev, st.dev);
  const top = {};
  walkParents(w.root, "top.txt", true, new Set(), top);
  assert.equal(top.ino, lstatSync(w.root).ino);
  assert.equal(walkParents(w.root, "a/b/f.txt", true, new Set()), w.abs, "without the extra argument it answers as before");
});

test("restoreFile without a swap restores the file and leaves no temp file", () => {
  const w = raceWorld();
  assert.equal(restoreFile(w.stored, w.abs, w.file, w.guard), 11);
  assert.equal(readFileSync(w.abs, "utf8"), "old content");
  assert.deepEqual(noTemps(w.folder), []);
});

test("a folder swapped for a link to the outside between the walk and the restore: refused as outside, nothing lands outside, no temp file is left", (t) => {
  const w = raceWorld();
  if (!swapForLink(t, w.folder, w.sb.outside)) return;
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, w.guard), (e) => e instanceof Refusal && e.reason === "outside");
  assert.deepEqual(readdirSync(w.sb.outside), ["canary.txt"]);
  canaryIntact(w.sb);
});

test("a folder swapped for a link after the temp file was made (the temp file is in the moved folder): refused as outside, nothing lands outside", (t) => {
  const w = raceWorld();
  let swapped = false;
  const guard = { ...w.guard, afterCreate: () => (swapped = swapForLink(t, w.folder, w.sb.outside)) };
  if (WIN) {
    // Windows refuses the swap while the temp file is open, so there is no attack: the restore must then simply succeed in the project
    let done = null;
    try {
      done = restoreFile(w.stored, w.abs, w.file, guard);
    } catch (e) {
      if (!(e instanceof Refusal && e.reason === "outside" && swapped)) throw e;
    }
    if (!swapped) {
      assert.equal(done, 11);
      assert.equal(readFileSync(w.abs, "utf8"), "old content");
      assert.deepEqual(noTemps(w.folder), []);
    }
  } else {
    assert.throws(() => restoreFile(w.stored, w.abs, w.file, guard), (e) => e instanceof Refusal && e.reason === "outside");
  }
  if (!swapped) {
    assert.deepEqual(readdirSync(w.sb.outside), ["canary.txt"]);
    return;
  }
  assert.deepEqual(readdirSync(w.sb.outside), ["canary.txt"]);
  assert.equal(exists(join(w.sb.outside, "f.txt")), false);
  canaryIntact(w.sb);
});

test("a folder swapped for a link just before the rename: refused as outside, the file is not renamed outside", (t) => {
  const w = raceWorld();
  let swapped = false;
  const guard = { ...w.guard, beforeRename: () => (swapped = swapForLink(t, w.folder, w.sb.outside)) };
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, guard), (e) => e instanceof Refusal && e.reason === "outside");
  if (!swapped) return;
  assert.deepEqual(readdirSync(w.sb.outside), ["canary.txt"]);
  canaryIntact(w.sb);
});

test("a folder swapped for another real folder inside the project (not the one that was checked): refused, no file is made there, no temp file is left", () => {
  const w = raceWorld();
  renameSync(w.folder, `${w.folder}-old`);
  mkdirSync(w.folder);
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, w.guard), (e) => e instanceof Refusal && e.reason === "outside");
  assert.deepEqual(readdirSync(w.folder), []);
  assert.equal(exists(w.abs), false);
});

test("the same swap between the temp file and the rename: the new folder is refused too (the temp file went with the old one)", () => {
  const w = raceWorld();
  const guard = {
    ...w.guard,
    beforeRename: () => {
      renameSync(w.folder, `${w.folder}-old`);
      mkdirSync(w.folder);
    },
  };
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, guard), (e) => e instanceof Refusal && e.reason === "outside");
  assert.deepEqual(readdirSync(w.folder), []);
});

test("a folder swapped for a link to another folder inside the project is refused as well", (t) => {
  const w = raceWorld();
  mkdirSync(join(w.sb.project, "elsewhere"));
  if (!swapForLink(t, w.folder, join(w.sb.project, "elsewhere"))) return;
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, w.guard), (e) => e instanceof Refusal && e.reason === "outside");
  assert.deepEqual(readdirSync(join(w.sb.project, "elsewhere")), []);
});

test("an ancestor swapped for a link is caught by the real path check even without an identity to compare", (t) => {
  const w = raceWorld("a/b/c/f.txt");
  mkdirSync(join(w.sb.outside, "b", "c"), { recursive: true });
  const top = join(w.sb.project, "a");
  renameSync(top, `${top}-moved`);
  if (!link(t, w.sb.outside, top)) return;
  // `a` now leads to outside/, whose b/c is a real folder: lstat of the folder says "a folder", only realpath tells where it is.
  assert.throws(() => restoreFile(w.stored, w.abs, w.file, { root: w.root }), (e) => e instanceof Refusal && e.reason === "outside");
  assert.deepEqual(readdirSync(join(w.sb.outside, "b", "c")), []);
  canaryIntact(w.sb);
});

test("confirmParent: the same folder passes; a missing folder, a file, or a folder outside the root is refused as outside", () => {
  const w = raceWorld();
  assert.doesNotThrow(() => confirmParent(w.folder, w.guard));
  assert.doesNotThrow(() => confirmParent(w.folder, { root: w.root }));
  assert.doesNotThrow(() => confirmParent(w.folder, { root: w.root, parent: { dev: 0, ino: 0 } }), "an identity the file system does not give is not compared");
  const refused = (folder, guard) => assert.throws(() => confirmParent(folder, guard), (e) => e instanceof Refusal && e.reason === "outside");
  refused(join(w.root, "nope"), w.guard);
  refused(w.abs.replace("f.txt", "g.txt"), w.guard);
  writeFileSync(w.abs, "x");
  refused(w.abs, w.guard);
  refused(w.sb.outside, { root: w.root });
  refused(dirname(w.root), { root: w.root });
});

test("restore as a whole still refuses a project folder that is a link (the walk, as before) and restores nested files in order", (t) => {
  const sb = sandbox();
  put(sb, "x/y/one.txt", "1");
  put(sb, "x/two.txt", "2");
  put(sb, "three.txt", "3");
  copyOk(sb, ["x", "three.txt"]);
  rmSync(join(sb.project, "x"), { recursive: true });
  rmSync(join(sb.project, "three.txt"));
  const res = call(restoreReq(sb));
  assert.equal(res.restored, 3);
  assert.deepEqual(res.failed, []);
  assert.equal(read(sb, "x/y/one.txt").toString(), "1");
  assert.deepEqual(tree(sb).filter((p) => p.includes(".kit-safety-")), []);
  rmSync(join(sb.project, "x"), { recursive: true });
  if (!link(t, sb.outside, join(sb.project, "x"))) return;
  const res2 = call(restoreReq(sb));
  assert.equal(res2.restored, 1); // three.txt is there already (restored again); x/* is refused
  assert.deepEqual(res2.failed.map((f) => f.reason), ["outside", "outside"]);
  canaryIntact(sb);
});
