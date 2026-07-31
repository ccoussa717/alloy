import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { isProjectTrusted } from "./project-trust.mjs";
import {
  createSafeParents,
  readRegularFileNoFollow as readRegularFileNoFollowImpl,
} from "./git-state-files.mjs";

export const FISSION_REQUEST_LIMIT = 16 * 1024;
export const FISSION_HEAD_LIMIT = 1024;
export const FISSION_STATUS_LIMIT = 1 * 1024 * 1024;
export const FISSION_PATCH_LIMIT = 2 * 1024 * 1024;
export const FISSION_FILE_LIMIT = 256 * 1024;
export const FISSION_FILE_TOTAL_LIMIT = 2 * 1024 * 1024;
export const FISSION_ENTRY_LIMIT = 10_000;
export const FISSION_OUTPUT_LIMIT = 256 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const FISSION_REPOSITORY_ROOT_LIMIT = 4 * 1024;
const defaultLimits = Object.freeze({
  head: FISSION_HEAD_LIMIT,
  status: FISSION_STATUS_LIMIT,
  patch: FISSION_PATCH_LIMIT,
  file: FISSION_FILE_LIMIT,
  fileTotal: FISSION_FILE_TOTAL_LIMIT,
  entries: FISSION_ENTRY_LIMIT,
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function framedDigest(records) {
  const hash = createHash("sha256");
  for (const record of records) {
    for (const field of record) hash.update(frame(field));
  }
  return hash.digest("hex");
}

function validUtf8(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function countLines(bytes) {
  if (bytes.length === 0) return 0;
  let lines = 1;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.at(-1) === 0x0a ? lines - 1 : lines;
}

function gitBuffer(cwd, args, maxBytes, deps = {}, limitReason = "output_limit") {
  const run = deps.spawnSync || spawnSync;
  const result = run("git", args, {
    cwd,
    encoding: "buffer",
    shell: false,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: maxBytes + 1,
  });
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout || "");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : String(result.stderr || "");
  if (result.error?.code === "ENOBUFS") throw new Error(limitReason);
  if (result.status !== 0) {
    const error = new Error(stderr.trim() || `Git command failed: ${args.join(" ")}`);
    error.status = result.status;
    throw error;
  }
  return stdout;
}

function resolveRoot(cwd, deps) {
  if (deps.repositoryRoot) return resolve(deps.repositoryRoot(cwd));
  const raw = gitBuffer(
    resolve(cwd),
    ["rev-parse", "--show-toplevel"],
    FISSION_REPOSITORY_ROOT_LIMIT,
    deps,
    "repository_root_limit",
  );
  const decoded = validUtf8(raw);
  if (decoded === null || decoded.includes("\0")) throw new Error("invalid_repository_root");
  const root = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
  if (!root || root.includes("\n")) throw new Error("invalid_repository_root");
  return resolve(root);
}

function parseStatus(status, entryLimit) {
  const decoded = validUtf8(status);
  if (decoded === null) throw new Error("invalid_status");
  const records = decoded.split("\0");
  if (records.at(-1) === "") records.pop();
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) throw new Error("invalid_status");
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = /[RC]/.test(xy);
    const originalPath = renamed ? records[++index] : null;
    if (renamed && originalPath === undefined) throw new Error("invalid_status");
    entries.push({
      xy,
      path,
      originalPath,
      untracked: xy === "??",
      deleted: xy.includes("D"),
    });
    if (entries.length > entryLimit) throw new Error("entry_limit");
  }
  return entries;
}

function conflict(entries) {
  return entries.some(({ xy }) =>
    xy.includes("U") || ["AA", "DD", "AU", "UA", "DU", "UD"].includes(xy));
}

function assertBufferLimit(bytes, limit, reason) {
  if (bytes.length > limit) throw new Error(reason);
}

function patchOmissionReasons(stagedPatch, unstagedPatch, entries) {
  const reasons = new Map();
  const decoded = [validUtf8(stagedPatch), validUtf8(unstagedPatch)];
  if (decoded.some((text) => text === null)) {
    for (const entry of entries) reasons.set(entry.path, "invalid_utf8");
    return reasons;
  }
  const sections = decoded.flatMap((text) => text.split(/(?=^diff --git )/m).filter(Boolean));
  for (const entry of entries) {
    const names = [entry.path, entry.originalPath].filter(Boolean);
    const section = sections.find((candidate) => {
      const lines = candidate.split("\n");
      if (names.some((name) => lines.some((line) =>
        line === `--- a/${name}` ||
        line === `+++ b/${name}` ||
        line === `--- ${JSON.stringify(`a/${name}`)}` ||
        line === `+++ ${JSON.stringify(`b/${name}`)}`))) return true;
      const sources = entry.originalPath ? [entry.originalPath] : [entry.path];
      return sources.some((source) => names.some((destination) => {
        const raw = `diff --git a/${source} b/${destination}`;
        const quoted = `diff --git ${JSON.stringify(`a/${source}`)} ${JSON.stringify(`b/${destination}`)}`;
        return lines[0] === raw || lines[0] === quoted;
      }));
    });
    if (!section) continue;
    if (/GIT binary patch|Binary files .* differ/.test(section)) {
      reasons.set(entry.path, "binary");
    } else if (
      /^(?:old mode |new mode |new file mode |deleted file mode )160000|^index [0-9a-f.]+ 160000|Subproject commit/m.test(section)
    ) {
      reasons.set(entry.path, "submodule");
    } else if (/^(?:old mode |new mode |new file mode |deleted file mode )120000/m.test(section)) {
      reasons.set(entry.path, "symlink");
    }
  }
  return reasons;
}

function globalPatchReason(stagedPatch, unstagedPatch) {
  const text = `${validUtf8(stagedPatch) ?? ""}\n${validUtf8(unstagedPatch) ?? ""}`;
  if (/GIT binary patch|Binary files .* differ/.test(text)) return "binary";
  if (
    /^(?:old mode |new mode |new file mode |deleted file mode )160000|^index [0-9a-f.]+ 160000|Subproject commit/m.test(text)
  ) return "submodule";
  return null;
}

function sourceDigestOf(baseline) {
  const records = [
    ["head", baseline.head],
    ["status", baseline.status],
    ["staged_patch", baseline.stagedPatch],
    ["unstaged_patch", baseline.unstagedPatch],
  ];
  for (const file of baseline.retainedFiles) {
    records.push(["file", file.path, file.mode.toString(8).padStart(6, "0"), file.bytes]);
  }
  return framedDigest(records);
}

export function readRegularFileNoFollow(root, rel, maxBytes) {
  return readRegularFileNoFollowImpl(root, rel, maxBytes);
}

export function preflightFissionRepository(cwd = process.cwd(), deps = {}) {
  if (!(deps.isProjectTrusted || isProjectTrusted)(cwd)) {
    return { state: "REFUSED", reason: "untrusted_project" };
  }
  let repoRoot;
  try {
    repoRoot = resolveRoot(cwd, deps);
  } catch {
    return { state: "REFUSED", reason: "not_repository" };
  }
  let head;
  try {
    head = gitBuffer(repoRoot, ["rev-parse", "HEAD"], FISSION_HEAD_LIMIT, deps, "head_limit");
  } catch (error) {
    return { state: "REFUSED", reason: error.message === "head_limit" ? "head_limit" : "unborn_head" };
  }
  if (head.length > FISSION_HEAD_LIMIT) return { state: "REFUSED", reason: "head_limit" };
  let status;
  try {
    status = gitBuffer(
      repoRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      FISSION_STATUS_LIMIT,
      deps,
      "status_limit",
    );
  } catch (error) {
    return { state: "REFUSED", reason: error.message === "status_limit" ? "status_limit" : "status_failed" };
  }
  if (status.length > FISSION_STATUS_LIMIT) return { state: "REFUSED", reason: "status_limit" };
  let entries;
  try {
    entries = parseStatus(status, FISSION_ENTRY_LIMIT);
  } catch (error) {
    return { state: "REFUSED", reason: error.message };
  }
  if (conflict(entries)) return { state: "REFUSED", reason: "unmerged_index" };
  if (status.length === 0) return { state: "NO_CHANGES", repoRoot, head, status, detached: false };
  let detached = false;
  try {
    gitBuffer(repoRoot, ["symbolic-ref", "-q", "HEAD"], FISSION_HEAD_LIMIT, deps);
  } catch {
    detached = true;
  }
  return { state: "READY", repoRoot, head, status, detached };
}

export function captureBoundedDirtyBaseline(cwd, limits = defaultLimits, deps = {}) {
  limits = { ...defaultLimits, ...(limits || {}) };
  const repoRoot = resolveRoot(cwd, deps);
  const head = gitBuffer(repoRoot, ["rev-parse", "HEAD"], limits.head, deps, "head_limit");
  assertBufferLimit(head, limits.head, "head_limit");
  const status = gitBuffer(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    limits.status,
    deps,
    "status_limit",
  );
  assertBufferLimit(status, limits.status, "status_limit");
  const stagedPatch = gitBuffer(
    repoRoot, ["diff", "--cached", "--binary"], limits.patch, deps, "patch_limit",
  );
  const unstagedPatch = gitBuffer(
    repoRoot, ["diff", "--binary"], limits.patch, deps, "patch_limit",
  );
  if (stagedPatch.length + unstagedPatch.length > limits.patch) throw new Error("patch_limit");
  const entries = parseStatus(status, limits.entries);
  if (conflict(entries)) throw new Error("unmerged_index");

  const omissionReasons = patchOmissionReasons(stagedPatch, unstagedPatch, entries);
  const unsafePatchReason = globalPatchReason(stagedPatch, unstagedPatch);
  const patchesUtf8 = validUtf8(stagedPatch) !== null && validUtf8(unstagedPatch) !== null;
  const retainedFiles = [];
  let total = 0;
  const readFile = deps.readRegularFileNoFollow || readRegularFileNoFollow;
  for (const entry of entries) {
    if (entry.deleted) {
      continue;
    }
    if (omissionReasons.has(entry.path)) continue;
    let observed;
    try {
      observed = readFile(repoRoot, entry.path, limits.file);
    } catch (error) {
      const message = String(error?.message || error);
      const reason = message.startsWith("file_limit")
        ? "file_limit"
        : message.startsWith("symlink")
          ? "symlink"
          : "unsupported_type";
      omissionReasons.set(entry.path, reason);
      continue;
    }
    if (observed.bytes.length > limits.file) {
      omissionReasons.set(entry.path, "file_limit");
      continue;
    }
    const text = validUtf8(observed.bytes);
    if (text === null) {
      omissionReasons.set(entry.path, "invalid_utf8");
      continue;
    }
    if (observed.bytes.includes(0)) {
      omissionReasons.set(entry.path, "nul_content");
      continue;
    }
    if (total + observed.bytes.length > limits.fileTotal) {
      omissionReasons.set(entry.path, "file_total_limit");
      continue;
    }
    total += observed.bytes.length;
    retainedFiles.push({
      path: entry.path,
      bytes: observed.bytes,
      mode: observed.mode & 0o177777,
      size: observed.size,
      executable: observed.executable,
      lineCount: countLines(observed.bytes),
      digest: digest(observed.bytes),
    });
  }
  retainedFiles.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const firstOmission = entries.find((entry) => omissionReasons.has(entry.path));
  const reason = firstOmission
    ? `${omissionReasons.get(firstOmission.path)}:${firstOmission.path}`
    : unsafePatchReason || undefined;
  const baseline = {
    repoRoot,
    head,
    status,
    stagedPatch,
    unstagedPatch,
    entries,
    retainedFiles,
    sourceDigest: "",
    omissionReasons: Object.fromEntries(omissionReasons),
    patchesUtf8,
  };
  baseline.sourceDigest = sourceDigestOf(baseline);
  Object.assign(baseline, {
    evidenceComplete: omissionReasons.size === 0 && unsafePatchReason === null,
    reason,
  });
  return baseline;
}

function artifact(type, path, bytes) {
  return {
    type,
    path,
    digest: framedDigest([["artifact", type, path, bytes]]),
    size: bytes.length,
    lineCount: countLines(bytes),
    mode: 0o400,
  };
}

function safePacketPath(root, child) {
  const absolute = resolve(root, child.split("/").join(sep));
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("packet_path_escape");
  return absolute;
}

function writeArtifact(root, child, bytes) {
  const path = safePacketPath(root, child);
  createSafeParents(root, child);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o400);
}

function freezeDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) freezeDirectories(join(root, entry.name));
  }
  chmodSync(root, 0o500);
}

function manifestEntry(entry, file, artifactInfo, omissionReason) {
  return {
    ...entry,
    included: Boolean(file),
    reason: file ? null : omissionReason || (entry.deleted ? "deleted" : undefined),
    artifactPath: artifactInfo?.path || null,
    artifactDigest: artifactInfo?.digest || null,
    mode: file?.mode || null,
    size: file?.size ?? null,
    lineCount: file?.lineCount ?? null,
  };
}

export function captureFissionPacket({ cwd, packetRoot, request, preflight, deps = {} }) {
  if (preflight?.state !== "READY") throw new Error("READY preflight required");
  const requestBytes = Buffer.from(String(request ?? ""));
  if (requestBytes.length > FISSION_REQUEST_LIMIT) throw new Error("request_limit");
  const fresh = preflightFissionRepository(cwd, deps);
  if (fresh.repoRoot && resolve(fresh.repoRoot) !== resolve(preflight.repoRoot)) {
    throw new Error("preflight_repository_mismatch");
  }
  if (
    fresh.state !== "READY" ||
    !Buffer.isBuffer(preflight.head) ||
    !Buffer.isBuffer(preflight.status) ||
    !fresh.head.equals(preflight.head) ||
    !fresh.status.equals(preflight.status)
  ) throw new Error("preflight_drift");
  const baseline = captureBoundedDirtyBaseline(cwd, undefined, deps);
  if (
    baseline.repoRoot !== fresh.repoRoot ||
    !baseline.head.equals(fresh.head) ||
    !baseline.status.equals(fresh.status)
  ) throw new Error("preflight_drift");
  if (!baseline.patchesUtf8) throw new Error("invalid_utf8_patch");
  const finalRoot = resolve(packetRoot);
  const attemptRoot = `${finalRoot}.attempt-${process.pid}-${Date.now()}`;
  const artifacts = {};
  try {
    mkdirSync(attemptRoot, { recursive: false, mode: 0o700 });
    const fixed = [
      ["request", "request.txt", requestBytes],
      ["head", "head.txt", baseline.head],
      ["status", "status.bin", baseline.status],
      ["staged_diff", "staged.diff", baseline.stagedPatch],
      ["unstaged_diff", "unstaged.diff", baseline.unstagedPatch],
    ];
    for (const [type, child, bytes] of fixed) {
      writeArtifact(attemptRoot, child, bytes);
      artifacts[child] = artifact(type, child, bytes);
    }
    for (const file of baseline.retainedFiles) {
      const child = posix.join("files", file.path.split(sep).join("/"));
      writeArtifact(attemptRoot, child, file.bytes);
      artifacts[child] = artifact("file", child, file.bytes);
    }
    const entries = baseline.entries.map((entry) => {
      const file = baseline.retainedFiles.find((candidate) => candidate.path === entry.path);
      const info = file ? artifacts[posix.join("files", file.path.split(sep).join("/"))] : null;
      return manifestEntry(entry, file, info, baseline.omissionReasons[entry.path]);
    });
    const manifest = {
      version: 1,
      sourceDigest: baseline.sourceDigest,
      evidenceComplete: baseline.evidenceComplete,
      reason: baseline.reason || null,
      entries,
      artifacts: Object.values(artifacts),
    };
    const reviewPacket = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeArtifact(attemptRoot, "review-packet.json", reviewPacket);
    artifacts["review-packet.json"] = artifact("manifest", "review-packet.json", reviewPacket);
    const packetDigest = framedDigest(
      Object.values(artifacts)
        .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
        .map((item) => ["artifact", item.type, item.path, readFileSync(join(attemptRoot, item.path))]),
    );
    const capture = {
      repoRoot: baseline.repoRoot,
      head: baseline.head,
      sourceDigest: baseline.sourceDigest,
      packetDigest,
      evidenceComplete: baseline.evidenceComplete,
      reason: baseline.reason || null,
      manifest,
      artifacts,
      packetRoot: finalRoot,
      baseline,
    };
    const immediate = recaptureFissionSource(capture, deps);
    if (!immediate.ok) {
      rmSync(attemptRoot, { recursive: true, force: true });
      return { ...capture, evidenceComplete: false, reason: immediate.reason };
    }
    freezeDirectories(attemptRoot);
    renameSync(attemptRoot, finalRoot);
    return capture;
  } catch (error) {
    rmSync(attemptRoot, { recursive: true, force: true });
    throw error;
  }
}

export function recaptureFissionSource(capture, deps = {}) {
  try {
    const observed = captureBoundedDirtyBaseline(capture.repoRoot, undefined, deps);
    return observed.sourceDigest === capture.sourceDigest
      ? { ok: true, digest: observed.sourceDigest }
      : { ok: false, digest: observed.sourceDigest, reason: "source_drift" };
  } catch (error) {
    return { ok: false, digest: null, reason: error.message || "source_recapture_failed" };
  }
}

export function verifyFissionArtifacts(capture) {
  const mismatches = [];
  const expectedFiles = new Set(Object.keys(capture.artifacts));
  const expectedDirectories = new Set(["."]);
  for (const child of expectedFiles) {
    let parent = posix.dirname(child);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const actualFiles = new Map();
  const actualDirectories = new Map();
  const walk = (absolute, relativePath) => {
    const stat = lstatSync(absolute);
    if (!stat.isDirectory()) throw new Error("packet_root_not_directory");
    actualDirectories.set(relativePath, stat);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relativePath === "." ? entry.name : posix.join(relativePath, entry.name);
      const childAbsolute = join(absolute, entry.name);
      const childStat = lstatSync(childAbsolute);
      if (childStat.isDirectory()) walk(childAbsolute, child);
      else actualFiles.set(child, childStat);
    }
  };
  try {
    walk(capture.packetRoot, ".");
  } catch {
    return { ok: false, mismatches: ["packet_root"] };
  }
  for (const directory of [...expectedDirectories].sort()) {
    const observed = actualDirectories.get(directory);
    if (!observed) mismatches.push(`missing_directory:${directory}`);
    else if ((observed.mode & 0o7777) !== 0o500) mismatches.push(`directory_mode:${directory}`);
  }
  for (const directory of [...actualDirectories.keys()].sort()) {
    if (!expectedDirectories.has(directory)) mismatches.push(`unexpected_directory:${directory}`);
  }
  for (const child of [...expectedFiles].sort()) {
    const expected = capture.artifacts[child];
    const observedStat = actualFiles.get(child);
    if (!observedStat) {
      mismatches.push(`missing:${child}`);
      continue;
    }
    if (!observedStat.isFile()) {
      mismatches.push(`type:${child}`);
      continue;
    }
    if ((observedStat.mode & 0o7777) !== expected.mode) mismatches.push(`mode:${child}`);
    try {
      const bytes = readFileSync(safePacketPath(capture.packetRoot, child));
      const observed = artifact(expected.type, expected.path, bytes);
      if (bytes.length !== expected.size || observed.digest !== expected.digest) {
        mismatches.push(`content:${child}`);
      }
    } catch {
      mismatches.push(`content:${child}`);
    }
  }
  for (const child of [...actualFiles.keys()].sort()) {
    if (!expectedFiles.has(child)) mismatches.push(`unexpected:${child}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}
