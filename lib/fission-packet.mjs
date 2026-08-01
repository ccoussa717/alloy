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

export function assertExactUtf8String(value) {
  const text = String(value ?? "");
  if (Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("request_utf8");
  return text;
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

function decodeGitQuotedPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) throw new Error("patch_sections");
  const bytes = [];
  const escapes = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      const codePoint = value.codePointAt(index);
      const decodedChar = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(decodedChar, "utf8"));
      index += decodedChar.length - 1;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined || index >= value.length - 1) throw new Error("patch_sections");
    if (escaped === "\\" || escaped === '"') bytes.push(escaped.charCodeAt(0));
    else if (Object.hasOwn(escapes, escaped)) bytes.push(escapes[escaped]);
    else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] || "")) octal += value[++index];
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) throw new Error("patch_sections");
      bytes.push(byte);
    } else throw new Error("patch_sections");
  }
  const decoded = validUtf8(Buffer.from(bytes));
  if (decoded === null || decoded.includes("\0")) throw new Error("patch_sections");
  return decoded;
}

function decodeGitPath(value) {
  const decoded = value.startsWith('"') ? decodeGitQuotedPath(value) : value;
  if (!decoded || decoded.includes("\0")) throw new Error("patch_sections");
  return decoded;
}

function parseHeaderTokens(line, entries) {
  const source = line.slice("diff --git ".length);
  if (!source.startsWith('"')) {
    const matches = (entries || []).filter((entry) => {
      const original = entry.originalPath || entry.path;
      return source === `a/${original} b/${entry.path}`;
    });
    if (matches.length !== 1) throw new Error("patch_sections");
    return [`a/${matches[0].originalPath || matches[0].path}`, `b/${matches[0].path}`];
  }
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    while (source[index] === " ") index += 1;
    if (index >= source.length) break;
    const start = index;
    if (source[index] === '"') {
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const char = source[index++];
        if (!escaped && char === '"') break;
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      if (source[index - 1] !== '"') throw new Error("patch_sections");
    } else {
      while (index < source.length && source[index] !== " ") index += 1;
    }
    tokens.push(source.slice(start, index));
  }
  if (tokens.length !== 2) throw new Error("patch_sections");
  return tokens.map(decodeGitPath);
}

function repositoryPath(value, prefix, allowNull = false) {
  if (allowNull && value === "/dev/null") return null;
  if (!value.startsWith(prefix)) throw new Error("patch_sections");
  const path = value.slice(prefix.length);
  if (
    !path || path.includes("\\") || path.startsWith("/") ||
    posix.normalize(path) !== path || path === "." || path.startsWith("../")
  ) throw new Error("patch_sections");
  return path;
}

function markerPath(line, marker, prefix) {
  if (!line.startsWith(marker)) throw new Error("patch_sections");
  let value = line.slice(marker.length);
  if (!value.startsWith('"') && value.endsWith("\t")) value = value.slice(0, -1);
  return repositoryPath(decodeGitPath(value), prefix, true);
}

export function deriveDiffSections(patch, entries) {
  const text = Buffer.isBuffer(patch) ? validUtf8(patch) : String(patch ?? "");
  if (text === null) throw new Error("patch_sections");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return [];
  const starts = [];
  for (const [index, line] of lines.entries()) if (line.startsWith("diff --git ")) starts.push(index);
  if (starts.length === 0 || starts[0] !== 0) throw new Error("patch_sections");
  const sections = [];
  const owned = new Set();
  for (const [ordinal, start] of starts.entries()) {
    const end = (starts[ordinal + 1] ?? lines.length) - 1;
    const sectionLines = lines.slice(start, end + 1);
    const [rawSource, rawDestination] = parseHeaderTokens(sectionLines[0], entries);
    const source = repositoryPath(rawSource, "a/");
    const destination = repositoryPath(rawDestination, "b/");
    const oldMarkers = sectionLines.filter((line) => line.startsWith("--- "));
    const newMarkers = sectionLines.filter((line) => line.startsWith("+++ "));
    if (oldMarkers.length !== newMarkers.length || oldMarkers.length > 1) throw new Error("patch_sections");
    if (oldMarkers.length === 1) {
      const oldPath = markerPath(oldMarkers[0], "--- ", "a/");
      const newPath = markerPath(newMarkers[0], "+++ ", "b/");
      if ((oldPath !== null && oldPath !== source) || (newPath !== null && newPath !== destination)) {
        throw new Error("patch_sections");
      }
    }
    const candidates = (entries || []).filter((entry) =>
      entry.path === destination &&
      (entry.originalPath ? entry.originalPath === source : source === destination));
    if (candidates.length !== 1 || owned.has(candidates[0].path)) throw new Error("patch_sections");
    owned.add(candidates[0].path);
    sections.push({ affectedPath: candidates[0].path, lineStart: start + 1, lineEnd: end + 1 });
  }
  return sections;
}

function patchOmissionReasons(stagedPatch, unstagedPatch, entries, patchSections) {
  const reasons = new Map();
  const decoded = [validUtf8(stagedPatch), validUtf8(unstagedPatch)];
  if (decoded.some((text) => text === null)) {
    for (const entry of entries) reasons.set(entry.path, "invalid_utf8");
    return reasons;
  }
  for (const [patchIndex, sections] of patchSections.entries()) {
    const lines = decoded[patchIndex].split("\n");
    for (const section of sections) {
      const text = lines.slice(section.lineStart - 1, section.lineEnd).join("\n");
      if (/GIT binary patch|Binary files .* differ/.test(text)) {
        reasons.set(section.affectedPath, "binary");
      } else if (
        /^(?:old mode |new mode |new file mode |deleted file mode )160000|^index [0-9a-f.]+ 160000|Subproject commit/m.test(text)
      ) {
        reasons.set(section.affectedPath, "submodule");
      } else if (/^(?:old mode |new mode |new file mode |deleted file mode )120000/m.test(text)) {
        reasons.set(section.affectedPath, "symlink");
      }
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
  if (/^(?:new file mode|deleted file mode|old mode|new mode) 120000$/m.test(text)) return "symlink";
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
    repoRoot,
    ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"],
    limits.patch,
    deps,
    "patch_limit",
  );
  const unstagedPatch = gitBuffer(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", "--no-color"],
    limits.patch,
    deps,
    "patch_limit",
  );
  if (stagedPatch.length + unstagedPatch.length > limits.patch) throw new Error("patch_limit");
  const entries = parseStatus(status, limits.entries);
  if (conflict(entries)) throw new Error("unmerged_index");

  const unsafePatchReason = globalPatchReason(stagedPatch, unstagedPatch);
  const patchesUtf8 = validUtf8(stagedPatch) !== null && validUtf8(unstagedPatch) !== null;
  let patchSections = [[], []];
  let patchSectionsValid = patchesUtf8;
  if (patchSectionsValid) {
    try {
      patchSections = [deriveDiffSections(stagedPatch, entries), deriveDiffSections(unstagedPatch, entries)];
    } catch {
      patchSectionsValid = false;
    }
  }
  const omissionReasons = patchSectionsValid
    ? patchOmissionReasons(stagedPatch, unstagedPatch, entries, patchSections)
    : new Map();
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
  const symlinkEntry = entries.find((entry) => omissionReasons.get(entry.path) === "symlink");
  const reason = unsafePatchReason === "symlink"
    ? symlinkEntry ? `symlink:${symlinkEntry.path}` : "symlink"
    : firstOmission
      ? `${omissionReasons.get(firstOmission.path)}:${firstOmission.path}`
      : unsafePatchReason || (!patchSectionsValid ? "patch_sections" : undefined);
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
    patchSections: { staged: patchSections[0], unstaged: patchSections[1] },
    patchSectionsValid,
  };
  baseline.sourceDigest = sourceDigestOf(baseline);
  Object.assign(baseline, {
    evidenceComplete: omissionReasons.size === 0 && unsafePatchReason === null && patchSectionsValid,
    reason,
  });
  return baseline;
}

function artifact(type, path, bytes, sections) {
  return {
    type,
    path,
    digest: framedDigest([["artifact", type, path, bytes]]),
    size: bytes.length,
    lineCount: countLines(bytes),
    mode: 0o400,
    ...(sections ? { sections } : {}),
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
  const requestBytes = Buffer.from(assertExactUtf8String(request));
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
      const sections = type === "staged_diff"
        ? baseline.patchSections.staged
        : type === "unstaged_diff" ? baseline.patchSections.unstaged : undefined;
      artifacts[child] = artifact(type, child, bytes, sections);
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
      artifacts: Object.values(artifacts).map((item) => structuredClone(item)),
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
      if (expected.type === "staged_diff" || expected.type === "unstaged_diff") {
        const sections = deriveDiffSections(bytes, capture.manifest.entries);
        if (JSON.stringify(sections) !== JSON.stringify(expected.sections)) {
          mismatches.push(`sections:${child}`);
        }
      }
      if (child !== "review-packet.json") {
        const inventory = capture.manifest.artifacts.find((item) => item.path === child);
        if (!inventory || JSON.stringify(inventory) !== JSON.stringify(expected)) {
          mismatches.push(`inventory:${child}`);
        }
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
