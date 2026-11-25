#!/usr/bin/env node
// Optional helper of the kit-safety plugin: the file work a snapshot needs and the plugin's own module cannot do (binary-safe
// copy, hashing, restore, delete, size scan). Plain Node >= 18, no dependencies; Windows, macOS and Linux. No network, no
// environment variables, never prints file contents.
//
// Protocol: `node safety-fs.mjs` reads ONE JSON request from stdin and writes ONE JSON line to stdout. It exits 0 whenever it
// handled the request, also for {"ok":false,"error":"..."}; the error is a short fixed message, never file contents.
//
//   {"cmd":"hello"}                                            -> {ok:true, v:1, node}
//   {"cmd":"scan",    root, targets:[rel], maxBytes, maxFiles} -> {ok, files, dirs, bytes, tooBig, tooBigBy?, isTruncated, skipped, skippedCount, missing, missingCount}
//   {"cmd":"copy",    root, destDir, targets, maxBytes, maxFiles, manifest}
//                                                              -> {ok, tooBig, tooBigBy?, files, bytes, dirs, skippedCount, missing, missingCount}
//       A SUMMARY only: the manifest is written to <destDir>/manifest.json (the caller reads it from there; an answer with the
//       whole file list would pass the engine's 4 MiB limit on stdout for a big tree). When `tooBig` nothing is left on disk.
//       `tooBigBy` is 'bytes' or 'files': which limit was passed (bytes wins when both were).
//   {"cmd":"restore", root, snapDir, only?:[rel]}              -> {ok, restored, dirs, bytes, failed:[{rel,reason}], failedCount, keptNewer}
//   {"cmd":"remove",  snapshotsRoot, projectKey, id}           -> {ok, removed}
//
// No answer can outgrow the engine's limit on a command's output: every list in one is cut (500 entries, 300 characters each) and
// has its full count beside it (`skippedCount`, `missingCount`, `failedCount`). The manifest never travels in an answer, and it
// holds no command text. File modes are kept as permission bits only (`& 0o777`): a setuid, setgid or sticky bit is never
// recorded and never restored, whatever an old manifest says.
//
// Layout (same as hooks/snapshot.ts): <snapshotsRoot>/<projectKey>/<id>/manifest.json and .../files/<rel>.
// Safety rules: every `rel` (in a request and in a manifest) must be a safe relative path (no `..`, no drive, no backslash, no NUL);
// symbolic links are never followed (a link is skipped when saving, a link in the way is refused when restoring); every folder above
// a file is checked one by one with lstat and again with realpath, so nothing lands outside the project root (or outside the
// snapshot folder); when restoring, the folder that holds a file is confirmed once more (same folder, still inside the root) after
// the temp file exists and right before the rename, so a folder swapped for a link in between is refused; a destination folder of
// `copy` must not exist yet; a manifest that fails validation is refused entirely.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_LISTED = 500; // entries of `skipped` / `failed` / `missing` an answer lists (the count is always complete)
const MAX_LISTED_REL = 300; // characters of a listed path (display only, never joined to a path)
const MAX_DEPTH = 256;
const MAX_ENTRIES = 200_000;
const CHUNK = 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW || 0;
const WINDOWS = process.platform === "win32";

const ID_RE = /^\d{8}T\d{6}Z(?:-[1-9]\d{0,5})?$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,23}-[0-9a-f]{14}$/;
const SHA_RE = /^[0-9a-f]{64}$/i;
const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;
// `private` (a .env-like file) is only produced by the plugin's text-only backend; this helper keeps the mode and makes every folder
// 0700, so it copies such a file like any other. It is listed so that a manifest of the other backend still validates.
const SKIP_REASONS = ["symlink", "binary", "too-large", "unreadable", "outside", "special", "limit", "private"];

// A request that cannot be served: answered as {ok:false, error}.
class Fail extends Error {}
// One file or folder that cannot be handled (the rest goes on): carries the reason that is reported.
export class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
// A limit was passed.
class TooBig extends Error {}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (message) => {
  throw new Fail(message);
};

// ---- paths ----

// Same rules as isSafeRelative() in hooks/paths.ts (plus: no ":" in a segment on Windows, where it names a data stream).
function safeRel(rel) {
  if (typeof rel !== "string" || rel === "" || rel.length > 4096) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\") || rel.includes("\0")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !(WINDOWS && seg.includes(":")));
}

function relList(value, what) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) fail(`${what} must be a list`);
  const out = [];
  const seen = new Set();
  for (const rel of value) {
    if (!safeRel(rel)) fail(`unsafe path in ${what}`);
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

function absPath(value, what) {
  if (typeof value !== "string" || value === "" || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) fail(`${what} must be an absolute path`);
  return value;
}

// The real path of a folder that must exist; a filesystem root is never accepted.
function realFolder(value, what) {
  const abs = absPath(value, what);
  let real;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isDirectory()) fail(`${what} is not a folder`);
  } catch (e) {
    if (e instanceof Fail) throw e;
    fail(`${what} not found`);
  }
  if (parse(real).root === real) fail(`${what} is a filesystem root`);
  return real;
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

// `p` is `base` or below it (path.relative is case-insensitive on Windows).
function withinOrEqual(base, p) {
  const r = relative(base, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function pointsInside(base, p) {
  try {
    return withinOrEqual(base, realpathSync(p));
  } catch {
    return false;
  }
}

/**
 * Walks the folders above `rel` below `base` (a real folder), one lstat each. A missing folder is created when `create` (and
 * counts as ours), else the answer is null. A link in the way is a Refusal ('symlink' when it stays inside `base`, else
 * 'outside'), a file in the way is a Refusal 'blocked'. Each folder is also confirmed with realpath. Returns the absolute path of
 * the last segment of `rel`. When `seen` is an object, the identity of the folder that holds the last segment (`dev`, `ino`) is
 * written to it, for confirmParent to compare once a file has been made there.
 */
export function walkParents(base, rel, create, verified, seen) {
  const segs = rel.split("/");
  let cur = base;
  for (let i = 0; i < segs.length - 1; i += 1) {
    cur = join(cur, segs[i]);
    let st = lstatOrNull(cur);
    if (!st) {
      if (!create) return null;
      try {
        mkdirSync(cur);
      } catch (e) {
        if (!e || e.code !== "EEXIST") throw e;
      }
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink()) throw new Refusal(pointsInside(base, cur) ? "symlink" : "outside");
    if (!st.isDirectory()) throw new Refusal("blocked");
  }
  if (seen) {
    // Taken before the realpath check: a folder swapped for a link after this is caught by confirmParent, one swapped before it is a link here.
    const parent = lstatSync(cur);
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Refusal("outside");
    seen.dev = parent.dev;
    seen.ino = parent.ino;
  }
  if (!verified.has(cur)) {
    if (!withinOrEqual(base, realpathSync(cur))) throw new Refusal("outside");
    verified.add(cur);
  }
  const abs = join(cur, segs[segs.length - 1]);
  if (!withinOrEqual(base, abs)) throw new Refusal("outside");
  return abs;
}

const errText = (e) => (e && typeof e.code === "string" ? `${e.code} (${typeof e.syscall === "string" ? e.syscall : "fs"})` : "internal error");

// ---- limits ----

function readLimits(req) {
  const { maxBytes, maxFiles } = req;
  if (typeof maxBytes !== "number" || !(maxBytes >= 0)) fail("maxBytes must be a number");
  if (typeof maxFiles !== "number" || !(maxFiles >= 0)) fail("maxFiles must be a number");
  return { maxBytes, maxFiles };
}

// ---- walking the project (read only, lstat everywhere, never follows a link) ----

function skip(ctx, rel, reason) {
  ctx.skippedCount += 1;
  if (ctx.skipped.length < MAX_LISTED) ctx.skipped.push({ rel: rel.slice(0, MAX_LISTED_REL), reason });
}

// The first MAX_LISTED missing targets, cut: what an answer lists (the count is `missingCount`).
const listedMissing = (ctx) => ctx.missing.slice(0, MAX_LISTED).map((rel) => rel.slice(0, MAX_LISTED_REL));

// Which limit a TooBig stopped at: the size when it was passed (also when both were), else the number of files.
const tooBigBy = (ctx) => (ctx.bytes > ctx.limits.maxBytes ? "bytes" : "files");

function addFile(ctx, rel, abs, st) {
  if (ctx.seen.has(rel)) return;
  ctx.seen.add(rel);
  ctx.fileCount += 1;
  ctx.bytes += st.size;
  if (ctx.fileCount > ctx.limits.maxFiles || ctx.bytes > ctx.limits.maxBytes) throw new TooBig();
  // Only the permission bits: a setuid, setgid or sticky bit is never recorded (and so never restored).
  ctx.files.push({ rel, abs, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o777, st });
}

// True when something below `abs` was stored; a folder that stored nothing is recorded as an empty folder.
function walkDir(ctx, abs, rel, depth) {
  if (ctx.seen.has(`${rel}/`)) return true; // reached already through another target
  ctx.seen.add(`${rel}/`);
  ctx.dirCount += 1;
  if (ctx.dirCount > ctx.limits.maxFiles) throw new TooBig();
  let names;
  try {
    names = readdirSync(abs);
  } catch {
    skip(ctx, rel, "unreadable");
    return false;
  }
  names.sort();
  let stored = false;
  for (const name of names) {
    const childRel = `${rel}/${name}`;
    const childAbs = join(abs, name);
    if (!safeRel(childRel)) {
      skip(ctx, childRel, "special");
      continue;
    }
    let st;
    try {
      st = lstatSync(childAbs);
    } catch {
      skip(ctx, childRel, "unreadable");
      continue;
    }
    if (st.isSymbolicLink()) skip(ctx, childRel, "symlink");
    else if (st.isDirectory()) {
      if (depth >= MAX_DEPTH) skip(ctx, childRel, "limit");
      else if (walkDir(ctx, childAbs, childRel, depth + 1)) stored = true;
    } else if (st.isFile()) {
      addFile(ctx, childRel, childAbs, st);
      stored = true;
    } else skip(ctx, childRel, "special");
  }
  // A folder that stored nothing (empty, or holding only links and odd files) is kept as an empty folder; that counts as stored.
  if (!stored) ctx.dirs.push(rel);
  return true;
}

// Lists what the targets hold: files (with their lstat), empty folders, what was skipped or is missing; stops at a limit.
function collect(root, targets, limits) {
  const ctx = { limits, files: [], dirs: [], skipped: [], skippedCount: 0, missing: [], bytes: 0, fileCount: 0, dirCount: 0, tooBig: false, seen: new Set() };
  const verified = new Set();
  // Files are remembered as `rel`, folders as `rel/`: a target inside an earlier target's folder is not counted twice.
  const covered = (rel) => {
    const segs = rel.split("/");
    for (let i = 1; i <= segs.length; i += 1) if (ctx.seen.has(`${segs.slice(0, i).join("/")}/`)) return true;
    return false;
  };
  try {
    for (const rel of targets) {
      if (ctx.seen.has(rel) || covered(rel)) continue;
      try {
        const abs = walkParents(root, rel, false, verified);
        if (abs === null) {
          ctx.missing.push(rel);
          continue;
        }
        const st = lstatOrNull(abs);
        if (!st) ctx.missing.push(rel);
        else if (st.isSymbolicLink()) skip(ctx, rel, "symlink");
        else if (st.isFile()) addFile(ctx, rel, abs, st);
        else if (st.isDirectory()) walkDir(ctx, abs, rel, 1);
        else skip(ctx, rel, "special");
      } catch (e) {
        if (e instanceof TooBig) throw e;
        skip(ctx, rel, e instanceof Refusal && SKIP_REASONS.includes(e.reason) ? e.reason : "unreadable");
      }
    }
  } catch (e) {
    if (!(e instanceof TooBig)) throw e;
    ctx.tooBig = true;
  }
  return ctx;
}

function cmdScan(req) {
  const root = realFolder(req.root, "root");
  const targets = relList(req.targets, "targets");
  const ctx = collect(root, targets, readLimits(req));
  return {
    ok: true,
    files: ctx.fileCount,
    dirs: ctx.dirCount,
    bytes: ctx.bytes,
    tooBig: ctx.tooBig,
    ...(ctx.tooBig ? { tooBigBy: tooBigBy(ctx) } : {}),
    isTruncated: ctx.tooBig,
    skipped: ctx.skipped,
    skippedCount: ctx.skippedCount,
    missing: listedMissing(ctx),
    missingCount: ctx.missing.length,
  };
}

// ---- manifest ----

function text(value, max) {
  return String(value)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "")
    .replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, " ")
    .trim()
    .slice(0, max);
}

function num(v, min, max) {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function gitName(v) {
  if (typeof v !== "string" || !GIT_NAME_RE.test(v)) return null;
  return v.startsWith("-") || v.startsWith("/") || v.endsWith("/") || v.endsWith(".") || v.includes("..") || v.includes("//") ? null : v;
}

// Same rule as looseRefName() in hooks/snapshot.ts: a name git accepts as one argument, with nothing hidden in it (letters of any
// script are fine; only the strict names above are ever printed in a command).
const REF_BAD = /[\u0000-\u0020\u007F-\u009F~^:?*[\\\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
function looseRef(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 200 || REF_BAD.test(v)) return false;
  if (v.includes("..") || v.includes("@{") || v.includes("//")) return false;
  return !(v.startsWith("-") || v.startsWith("/") || v.endsWith("/") || v.endsWith(".") || v.endsWith(".lock"));
}

function cleanGit(v) {
  if (!isObj(v)) return undefined;
  const git = { head: gitName(v.head), branch: gitName(v.branch) };
  const ref = gitName(v.ref);
  if (ref) git.ref = ref;
  if (typeof v.stashSha === "string" && GIT_SHA_RE.test(v.stashSha)) git.stashSha = v.stashSha.toLowerCase();
  if (v.isPartial === true) git.isPartial = true;
  if (Array.isArray(v.branches)) {
    const branches = [];
    for (const b of v.branches.slice(0, 100)) {
      if (!isObj(b) || !looseRef(b.name) || typeof b.sha !== "string" || !GIT_SHA_RE.test(b.sha)) continue;
      branches.push(b.remote === true ? { name: b.name, sha: b.sha.toLowerCase(), remote: true } : { name: b.name, sha: b.sha.toLowerCase() });
    }
    if (branches.length > 0) git.branches = branches;
  }
  return git;
}

function cleanRisks(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const item of v.slice(0, 20)) {
    if (!isObj(item) || typeof item.kind !== "string" || typeof item.label !== "string") continue;
    const kind = text(item.kind, 40);
    const label = text(item.label, 120);
    if (!kind || !label) continue;
    const risk = { kind, label };
    const name = typeof item.name === "string" ? text(item.name, 200) : "";
    if (name) risk.name = name;
    out.push(risk);
  }
  return out;
}

/**
 * Validates a manifest and returns a clean copy in canonical key order. Strict where the manifest drives file writes: a
 * wrong version, id or backend, or any file, folder or target that is not a safe relative path, refuses the whole manifest.
 */
function validateManifest(raw) {
  if (!isObj(raw) || raw.v !== 1) fail("invalid manifest");
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) fail("invalid manifest");
  const n = num(raw.n, 0, 1_000_000_000);
  const createdAt = num(raw.createdAt, 0, 8.64e15);
  if (n === null || createdAt === null) fail("invalid manifest");
  if (typeof raw.root !== "string" || raw.root.length > 4096 || raw.root.includes("\0")) fail("invalid manifest");
  if (raw.kind !== "before-command" && raw.kind !== "before-restore") fail("invalid manifest");
  if (typeof raw.tool !== "string") fail("invalid manifest");
  if (raw.backend !== "node" && raw.backend !== "fs") fail("invalid manifest");
  if (!Array.isArray(raw.files) || !Array.isArray(raw.dirs) || !Array.isArray(raw.targets)) fail("invalid manifest");
  if (raw.files.length > MAX_ENTRIES || raw.dirs.length > MAX_ENTRIES) fail("invalid manifest");
  const files = [];
  const seen = new Set();
  for (const f of raw.files) {
    if (!isObj(f) || !safeRel(f.rel) || seen.has(f.rel)) fail("invalid manifest");
    const size = num(f.size, 0, 2 ** 50);
    const mtimeMs = num(f.mtimeMs, 0, 8.64e15);
    if (size === null || mtimeMs === null) fail("invalid manifest");
    if (f.sha256 !== undefined && (typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256))) fail("invalid manifest");
    if (f.mode !== undefined && !(Number.isInteger(f.mode) && f.mode >= 0 && f.mode <= 0o7777)) fail("invalid manifest");
    seen.add(f.rel);
    const file = { rel: f.rel, size: Math.floor(size), mtimeMs };
    if (f.mode !== undefined) file.mode = f.mode;
    if (f.sha256 !== undefined) file.sha256 = f.sha256.toLowerCase();
    files.push(file);
  }
  const dirs = relList(raw.dirs, "manifest dirs");
  const targets = relList(raw.targets, "manifest targets");
  const skipped = [];
  if (Array.isArray(raw.skipped)) {
    for (const s of raw.skipped.slice(0, MAX_ENTRIES)) {
      if (isObj(s) && typeof s.rel === "string" && SKIP_REASONS.includes(s.reason) && text(s.rel, 300)) skipped.push({ rel: text(s.rel, 300), reason: s.reason });
    }
  }
  const manifest = { v: 1, id: raw.id, n: Math.floor(n), createdAt, root: raw.root, kind: raw.kind, tool: text(raw.tool, 100) };
  // No `command` here: the command text is never stored (an old manifest's field is dropped).
  if (raw.quiet === true) manifest.quiet = true;
  manifest.risks = cleanRisks(raw.risks);
  manifest.targets = targets;
  manifest.backend = raw.backend;
  manifest.files = files;
  manifest.dirs = dirs;
  manifest.skipped = skipped;
  manifest.totalBytes = Math.floor(num(raw.totalBytes, 0, 2 ** 53 - 1) ?? files.reduce((t, f) => t + f.size, 0));
  const git = cleanGit(raw.git);
  if (git) manifest.git = git;
  if (typeof raw.restoredFrom === "string" && ID_RE.test(raw.restoredFrom)) manifest.restoredFrom = raw.restoredFrom;
  return manifest;
}

function writeAtomic(file, content) {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw e;
  }
}

// ---- copy ----

/**
 * Streams `src` into the new file `dst` (created exclusively), hashing the bytes on the way. Returns {size, sha256}. The source
 * is opened without following a link and must still be a regular file once open. `budget.bytes` grows with what is read; a
 * file that grew past the limit while being copied raises TooBig.
 */
function copyHashed(src, dst, before, budget) {
  let rfd = -1;
  let wfd = -1;
  try {
    rfd = openSync(src, constants.O_RDONLY | O_NOFOLLOW);
    const st = fstatSync(rfd);
    if (!st.isFile()) throw new Refusal("special");
    if (before && before.ino && st.ino && before.ino !== st.ino) throw new Refusal("unreadable");
    wfd = openSync(dst, "wx", 0o600);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const n = readSync(rfd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      budget.bytes += n;
      if (budget.bytes > budget.maxBytes) throw new TooBig();
      hash.update(buf.subarray(0, n));
      let done = 0;
      while (done < n) done += writeSync(wfd, buf, done, n - done);
      size += n;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    if (rfd >= 0) closeSync(rfd);
    if (wfd >= 0) closeSync(wfd);
  }
}

function setTimes(file, mtimeMs) {
  const seconds = mtimeMs / 1000;
  utimesSync(file, seconds, seconds);
}

function removeQuietly(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // best effort
  }
}

function checkManifestHeader(manifest, destDir, root) {
  if (!isObj(manifest)) fail("manifest is missing");
  const draft = {
    ...manifest,
    root,
    backend: "node",
    files: [],
    dirs: [],
    skipped: [],
    totalBytes: 0,
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
  };
  const clean = validateManifest(draft);
  if (clean.id !== basename(destDir)) fail("manifest id does not match destDir");
  return clean;
}

function cmdCopy(req) {
  const root = realFolder(req.root, "root");
  const destDir = absPath(req.destDir, "destDir");
  const targets = relList(req.targets, "targets");
  const limits = readLimits(req);
  const header = checkManifestHeader(req.manifest, destDir, absPath(req.root, "root"));
  const base = { ...header, targets };
  if (!ID_RE.test(basename(destDir)) || !KEY_RE.test(basename(dirname(destDir)))) fail("destDir is not <projectKey>/<id>");
  if (lstatOrNull(destDir)) fail("destination already exists");
  const parent = dirname(destDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realDest = join(realpathSync(parent), basename(destDir));
  for (const rel of targets) {
    if (withinOrEqual(join(root, ...rel.split("/")), realDest)) fail("destination is inside a target");
  }
  const ctx = collect(root, targets, limits);
  const summary = (extra) => ({
    ok: true,
    files: ctx.fileCount,
    bytes: ctx.bytes,
    dirs: ctx.dirCount,
    skippedCount: ctx.skippedCount,
    missing: listedMissing(ctx),
    missingCount: ctx.missing.length,
    ...extra,
  });
  const tooBig = (by) => summary({ tooBig: true, tooBigBy: by });
  if (ctx.tooBig) return tooBig(tooBigBy(ctx));

  try {
    mkdirSync(destDir, { mode: 0o700 });
  } catch (e) {
    if (e && e.code === "EEXIST") fail("destination already exists");
    throw e;
  }
  try {
    mkdirSync(join(destDir, "files"), { mode: 0o700 });
    const budget = { bytes: 0, maxBytes: limits.maxBytes };
    const made = new Set();
    const files = [];
    for (const f of ctx.files) {
      const dst = join(destDir, "files", ...f.rel.split("/"));
      const dir = dirname(dst);
      if (!made.has(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        made.add(dir);
      }
      try {
        const { size, sha256 } = copyHashed(f.abs, dst, f.st, budget);
        chmodSync(dst, (f.mode | 0o600) & 0o777);
        setTimes(dst, f.mtimeMs);
        files.push({ rel: f.rel, size, mtimeMs: f.mtimeMs, mode: f.mode, sha256 });
      } catch (e) {
        if (e instanceof TooBig) throw e;
        removeQuietly(dst);
        skip(ctx, f.rel, e instanceof Refusal && SKIP_REASONS.includes(e.reason) ? e.reason : "unreadable");
      }
    }
    for (const rel of ctx.dirs) mkdirSync(join(destDir, "files", ...rel.split("/")), { recursive: true, mode: 0o700 });
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const manifest = validateManifest({
      ...base,
      files,
      dirs: [...ctx.dirs].sort(),
      skipped: ctx.skipped,
      totalBytes: files.reduce((t, f) => t + f.size, 0),
    });
    writeAtomic(join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return summary({ tooBig: false, files: files.length, bytes: manifest.totalBytes });
  } catch (e) {
    removeQuietly(destDir);
    if (e instanceof TooBig) return tooBig("bytes");
    throw e;
  }
}

// ---- restore ----

const inSelection = (only, rel) => only === null || only.some((o) => rel === o || rel.startsWith(`${o}/`));

// Opens a stored copy: it must be a regular file, never a link (checked with lstat, and again with O_NOFOLLOW where it exists).
function openStored(abs) {
  const before = lstatOrNull(abs);
  if (!before) throw new Refusal("missing");
  if (!before.isFile()) throw new Refusal("corrupt");
  let fd;
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    throw new Refusal(e && e.code === "ENOENT" ? "missing" : "corrupt");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (before.ino && st.ino && before.ino !== st.ino)) throw new Refusal("corrupt");
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/**
 * After the walk and before the rename: the folder that holds the temp file must still be the folder walkParents checked (same
 * `dev` and `ino` as `guard.parent`, not a link now) and its real path must still lie inside `guard.root` (the real project root).
 * A folder swapped for a link between the walk and now would otherwise take the rename outside the project. Refusal 'outside'.
 * (The check cannot be atomic with the rename: a swap in the last instant is not caught, only every earlier one.)
 */
export function confirmParent(parentAbs, guard) {
  let st;
  let real;
  try {
    st = lstatSync(parentAbs);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Refusal("outside");
    const seen = guard.parent;
    if (seen && seen.ino && st.ino && (st.ino !== seen.ino || st.dev !== seen.dev)) throw new Refusal("outside");
    real = realpathSync(parentAbs);
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal("outside");
  }
  if (!withinOrEqual(guard.root, real)) throw new Refusal("outside");
}

// Copies the stored file into a temp file next to its destination, checks the sha256 of the bytes written, then renames it over.
// `guard` = { root: the real project root, parent: { dev, ino } of the destination folder as walkParents saw it }. The folder is
// confirmed again right after the temp file exists and right before the rename (a swap for a link in between is refused 'outside',
// and the temp file is cleaned up). `guard.afterCreate` / `guard.beforeRename` are called at those two points and exist only so that a
// unit test can swap the folder there; cmdRestore never sets them.
export function restoreFile(storedAbs, destAbs, file, guard) {
  const folder = dirname(destAbs);
  const tmp = join(folder, `.kit-safety-${randomBytes(6).toString("hex")}.tmp`);
  let rfd = -1;
  let wfd = -1;
  let renamed = false;
  try {
    rfd = openStored(storedAbs);
    const stored = fstatSync(rfd);
    wfd = openSync(tmp, "wx", 0o600);
    if (guard.afterCreate) guard.afterCreate();
    confirmParent(folder, guard);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const n = readSync(rfd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      let done = 0;
      while (done < n) done += writeSync(wfd, buf, done, n - done);
      size += n;
    }
    closeSync(wfd);
    wfd = -1;
    if (file.sha256 && hash.digest("hex") !== file.sha256) throw new Refusal("corrupt");
    // Permission bits only: a manifest that says 04755 (or a copied setuid file) never comes back setuid, setgid or sticky.
    if (guard.beforeRename) guard.beforeRename();
    confirmParent(folder, guard);
    chmodSync(tmp, (file.mode !== undefined ? file.mode : stored.mode) & 0o777);
    setTimes(tmp, file.mtimeMs);
    try {
      renameSync(tmp, destAbs);
    } catch (e) {
      // Windows: a read-only file cannot be replaced; make it writable once and try again.
      if (!e || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      chmodSync(destAbs, 0o666);
      renameSync(tmp, destAbs);
    }
    renamed = true;
    return size;
  } finally {
    if (rfd >= 0) closeSync(rfd);
    if (wfd >= 0) closeSync(wfd);
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // not created or already gone
      }
    }
  }
}

// Counts what is under `abs` now that the manifest does not hold (the person's newer work, left alone).
function countExtra(abs, rel, known, skippedRels, counter, depth) {
  if (depth > MAX_DEPTH || counter.visited > 500_000) return;
  let names;
  try {
    names = readdirSync(abs);
  } catch {
    return;
  }
  for (const name of names) {
    counter.visited += 1;
    const childRel = `${rel}/${name}`;
    if (name.startsWith(".kit-safety-") && name.endsWith(".tmp")) continue;
    let st;
    try {
      st = lstatSync(join(abs, name));
    } catch {
      continue;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) countExtra(join(abs, name), childRel, known, skippedRels, counter, depth + 1);
    else if (!known.has(childRel) && !skippedRels.some((s) => childRel === s || childRel.startsWith(`${s}/`))) counter.n += 1;
  }
}

function cmdRestore(req) {
  const root = realFolder(req.root, "root");
  const snapDir = absPath(req.snapDir, "snapDir");
  const only = req.only === undefined || req.only === null ? null : relList(req.only, "only");
  const snap = lstatOrNull(snapDir);
  if (!snap || snap.isSymbolicLink() || !snap.isDirectory()) fail("snapshot not found");
  const realSnap = realpathSync(snapDir);
  const mfile = join(realSnap, "manifest.json");
  const mst = lstatOrNull(mfile);
  if (!mst || !mst.isFile() || mst.size > MAX_MANIFEST_BYTES) fail("snapshot has no manifest");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(mfile, "utf8"));
  } catch {
    fail("invalid manifest");
  }
  const manifest = validateManifest(parsed);
  if (manifest.id !== basename(realSnap)) fail("manifest does not match its folder");

  const filesRoot = join(realSnap, "files");
  const fst = lstatOrNull(filesRoot);
  const hasFiles = Boolean(fst && fst.isDirectory() && !fst.isSymbolicLink());
  const failed = [];
  let failedCount = 0;
  const reportFail = (rel, reason) => {
    failedCount += 1;
    if (failed.length < MAX_LISTED) failed.push({ rel: rel.slice(0, MAX_LISTED_REL), reason });
  };
  const verifiedStored = new Set();
  const verifiedDest = new Set();
  let restored = 0;
  let dirsMade = 0;
  let bytes = 0;

  for (const file of manifest.files) {
    if (!inSelection(only, file.rel)) continue;
    let storedAbs;
    try {
      storedAbs = hasFiles ? walkParents(filesRoot, file.rel, false, verifiedStored) : null;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      reportFail(file.rel, "corrupt");
      continue;
    }
    if (storedAbs === null) {
      reportFail(file.rel, "missing");
      continue;
    }
    try {
      const parent = {};
      const destAbs = walkParents(root, file.rel, true, verifiedDest, parent);
      const existing = lstatOrNull(destAbs);
      if (existing && existing.isDirectory() && !existing.isSymbolicLink()) throw new Refusal("blocked");
      bytes += restoreFile(storedAbs, destAbs, file, { root, parent });
      restored += 1;
    } catch (e) {
      reportFail(file.rel, e instanceof Refusal ? e.reason : e && e.code === "ENOENT" ? "missing" : "write-failed");
    }
  }

  for (const rel of manifest.dirs) {
    if (!inSelection(only, rel)) continue;
    try {
      const abs = walkParents(root, rel, true, verifiedDest);
      const st = lstatOrNull(abs);
      if (!st) {
        mkdirSync(abs);
        dirsMade += 1;
      } else if (st.isSymbolicLink()) throw new Refusal(pointsInside(root, abs) ? "symlink" : "outside");
      else if (!st.isDirectory()) throw new Refusal("blocked");
    } catch (e) {
      reportFail(rel, e instanceof Refusal ? e.reason : "write-failed");
    }
  }

  // What is under the restored folders now but not in the manifest stays where it is; it is only counted.
  const known = new Set(manifest.files.map((f) => f.rel));
  const skippedRels = manifest.skipped.map((s) => s.rel);
  const folderTargets = manifest.targets.filter((t) => manifest.dirs.includes(t) || manifest.files.some((f) => f.rel.startsWith(`${t}/`)) || manifest.dirs.some((d) => d.startsWith(`${t}/`)));
  const scopes = new Set();
  for (const t of folderTargets) {
    if (only === null) scopes.add(t);
    else for (const o of only) scopes.add(o.startsWith(`${t}/`) || o === t ? o : t.startsWith(`${o}/`) ? t : "");
  }
  scopes.delete("");
  const counter = { n: 0, visited: 0 };
  for (const rel of scopes) {
    try {
      const abs = walkParents(root, rel, false, new Set());
      const st = abs === null ? null : lstatOrNull(abs);
      if (st && st.isDirectory() && !st.isSymbolicLink()) countExtra(abs, rel, known, skippedRels, counter, 1);
    } catch {
      // a link in the way: nothing to count there
    }
  }
  return { ok: true, restored, dirs: dirsMade, bytes, failed, failedCount, keptNewer: counter.n };
}

// ---- remove ----

function cmdRemove(req) {
  const snapshotsRoot = absPath(req.snapshotsRoot, "snapshotsRoot");
  if (typeof req.projectKey !== "string" || !KEY_RE.test(req.projectKey)) fail("bad projectKey");
  if (typeof req.id !== "string" || !ID_RE.test(req.id)) fail("bad id");
  let realRoot;
  try {
    realRoot = realpathSync(snapshotsRoot);
  } catch {
    return { ok: true, removed: false };
  }
  const parent = join(snapshotsRoot, req.projectKey);
  const target = join(parent, req.id);
  const pst = lstatOrNull(parent);
  if (!pst) return { ok: true, removed: false };
  if (pst.isSymbolicLink() || !pst.isDirectory()) fail("not a snapshot folder");
  if (relative(join(realRoot, req.projectKey), realpathSync(parent)) !== "") fail("not a snapshot folder");
  const tst = lstatOrNull(target);
  if (!tst) return { ok: true, removed: false };
  if (tst.isSymbolicLink() || !tst.isDirectory()) fail("not a snapshot folder");
  rmSync(target, { recursive: true, force: true, maxRetries: 2 });
  return { ok: true, removed: true };
}

// ---- main ----

function handle(req) {
  if (!isObj(req)) fail("bad request");
  switch (req.cmd) {
    case "hello":
      return { ok: true, v: 1, node: process.versions.node };
    case "scan":
      return cmdScan(req);
    case "copy":
      return cmdCopy(req);
    case "restore":
      return cmdRestore(req);
    case "remove":
      return cmdRemove(req);
    default:
      return fail("unknown command");
  }
}

function answer(result) {
  process.stdout.on("error", () => {}); // a reader that closed the pipe early is not our failure
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN) fail("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let result;
  try {
    const input = await readStdin();
    if (input.trim() === "") fail("empty request");
    let req;
    try {
      req = JSON.parse(input);
    } catch {
      fail("bad JSON");
    }
    result = handle(req);
  } catch (e) {
    result = { ok: false, error: e instanceof Fail ? e.message : errText(e) };
  }
  answer(result);
}

// Runs when node was started on this file, not when a test imports it. Any doubt (no entry path, a path that cannot be resolved) means
// "run": a helper that stayed silent would make the plugin fall back to its text-only backend for good. Both paths go through realpath
// (node resolves a symlinked entry for import.meta.url but not for argv[1]).
function isMainScript() {
  try {
    const entry = process.argv[1];
    if (typeof entry !== "string" || entry === "") return true;
    const a = realpathSync.native(entry);
    const b = realpathSync.native(fileURLToPath(import.meta.url));
    return WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return true;
  }
}

if (isMainScript()) main();
