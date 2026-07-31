import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { repositoryRoot } from "./worktree.mjs";
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
  return resolve((deps.repositoryRoot || repositoryRoot)(cwd));
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

function inspectPatchEvidence(stagedPatch, unstagedPatch) {
  const text = `${validUtf8(stagedPatch) ?? "\0"}${validUtf8(unstagedPatch) ?? "\0"}`;
  if (text.includes("\0") || /GIT binary patch|Binary files .* differ/.test(text)) return "binary";
  if (
    /^(?:old mode |new mode |new file mode |deleted file mode )160000|^index [0-9a-f.]+ 160000|Subproject commit/m.test(text)
  ) return "submodule";
  if (/^(?:old mode |new mode |new file mode |deleted file mode )120000/m.test(text)) return "unsupported";
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

  let evidenceComplete = true;
  let reason = inspectPatchEvidence(stagedPatch, unstagedPatch);
  if (reason) evidenceComplete = false;
  const retainedFiles = [];
  let total = 0;
  const readFile = deps.readRegularFileNoFollow || readRegularFileNoFollow;
  for (const entry of entries) {
    if (entry.deleted) continue;
    let observed;
    try {
      observed = readFile(repoRoot, entry.path, limits.file);
    } catch (error) {
      evidenceComplete = false;
      if (!reason) {
        reason = error.message.startsWith("file_limit")
          ? error.message
          : `unsupported:${entry.path}`;
      }
      continue;
    }
    if (observed.bytes.length > limits.file) {
      evidenceComplete = false;
      reason ||= `file_limit:${entry.path}`;
      continue;
    }
    const text = validUtf8(observed.bytes);
    if (text === null || observed.bytes.includes(0)) {
      evidenceComplete = false;
      reason ||= `binary:${entry.path}`;
      continue;
    }
    total += observed.bytes.length;
    if (total > limits.fileTotal) {
      evidenceComplete = false;
      reason ||= `file_total_limit:${entry.path}`;
      continue;
    }
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
  const baseline = {
    repoRoot,
    head,
    status,
    stagedPatch,
    unstagedPatch,
    entries,
    retainedFiles,
    sourceDigest: "",
  };
  baseline.sourceDigest = sourceDigestOf(baseline);
  Object.assign(baseline, { evidenceComplete, reason });
  return baseline;
}

function artifact(type, path, bytes, mode = 0o400) {
  return {
    type,
    path,
    digest: framedDigest([["artifact", type, path, bytes]]),
    size: bytes.length,
    lineCount: countLines(bytes),
    mode,
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

function manifestEntry(entry, file, artifactInfo) {
  return {
    ...entry,
    included: Boolean(file),
    reason: file ? null : entry.deleted ? "deleted" : "unsupported",
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
  const baseline = captureBoundedDirtyBaseline(cwd, undefined, deps);
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
      artifacts[child] = artifact("file", child, file.bytes, file.mode);
    }
    const entries = baseline.entries.map((entry) => {
      const file = baseline.retainedFiles.find((candidate) => candidate.path === entry.path);
      const info = file ? artifacts[posix.join("files", file.path.split(sep).join("/"))] : null;
      return manifestEntry(entry, file, info);
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
  for (const [child, expected] of Object.entries(capture.artifacts)) {
    try {
      const bytes = readFileSync(safePacketPath(capture.packetRoot, child));
      const observed = artifact(expected.type, expected.path, bytes, expected.mode);
      if (bytes.length !== expected.size || observed.digest !== expected.digest) mismatches.push(child);
    } catch {
      mismatches.push(child);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
