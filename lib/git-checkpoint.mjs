/**
 * Recoverable git checkpoints (P0.4).
 *
 * Captures:
 *  - HEAD
 *  - tracked dirty state via `git stash create` (when non-empty)
 *  - untracked files by copying into the checkpoint store (stash create omits them)
 *  - porcelain status + manifest of paths
 *  - an immutable Git anchor commit authenticating metadata and stored payloads
 *
 * Restore never runs `git clean -fd` by default (would delete untracked work).
 * Untracked files are restored from the checkpoint file store.
 *
 * Destructive restore requires a quiescent workspace. These synchronous APIs
 * serialize cooperative calls within one Alloy process and revalidate state
 * immediately before mutation, but do not hold a global lock against an
 * external editor, Git process, or second Alloy process writing afterward.
 * Ordinary and malicious external writes in that final window are outside the
 * guarantee; descriptor-relative openat hardening is future work.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";
import {
  containedPath,
  copyEnumeratedPaths,
  createSafeParents,
  inspectDestination,
  inspectSource,
} from "./git-state-files.mjs";

const CHECKPOINT_FORMAT_VERSION = 2;
const ANCHOR_FORMAT_VERSION = 1;
const ANCHOR_MARKER = "alloy-checkpoint-anchor-v1";

function run(cmd, args, cwd, { trim = true, env, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    env,
    input,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: trim ? (r.stdout || "").trim() : r.stdout || "",
    stderr: (r.stderr || "").trim(),
  };
}

export function isGitRepo(cwd = process.cwd()) {
  const r = run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.stdout === "true";
}

function repositoryRoot(cwd = process.cwd()) {
  const root = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) throw new Error(root.stderr || "Not a git repository");
  return resolve(root.stdout);
}

function requireNonEmptyId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function checkpointRoot(cwd = process.cwd()) {
  const dir = join(getAlloyHome(), "checkpoints", projectIdFromCwd(cwd));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Parse porcelain status into tracked-dirty and untracked paths.
 * @returns {{ lines: string[], untracked: string[], trackedDirty: string[], intentToAdd: string[] }}
 */
export function parsePorcelain(porcelain) {
  const raw = String(porcelain || "");
  const nulDelimited = raw.includes("\0");
  const records = raw.split(nulDelimited ? "\0" : "\n").filter(Boolean);
  const lines = [];
  const untracked = [];
  const trackedDirty = [];
  const intentToAdd = [];
  for (let i = 0; i < records.length; i += 1) {
    const line = records[i];
    lines.push(line);
    if (line.startsWith("?? ")) {
      untracked.push(line.slice(3));
    } else if (line.length >= 3) {
      // XY PATH or XY ORIG -> PATH
      const rest = line.slice(3);
      const path =
        !nulDelimited && rest.includes(" -> ")
          ? rest.split(" -> ").pop()
          : rest;
      if (path) trackedDirty.push(path);
      if (line.startsWith(" A ") && path) intentToAdd.push(path);
      if (nulDelimited && /[RC]/.test(line.slice(0, 2))) i += 1;
    }
  }
  return { lines, untracked, trackedDirty, intentToAdd };
}

function copyUntrackedIntoStore(cwd, untracked, destDir) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  return copyEnumeratedPaths(cwd, destDir, untracked);
}

/**
 * Create a recoverable checkpoint.
 * @returns {object}
 */
export function createCheckpoint(label = "", cwd = process.cwd()) {
  if (!isGitRepo(cwd)) {
    throw new Error("Not a git repository");
  }
  const invocationCwd = resolve(cwd);
  cwd = repositoryRoot(cwd);

  const unmerged = run("git", ["ls-files", "-u", "-z"], cwd, {
    trim: false,
  });
  if (!unmerged.ok) {
    throw new Error(unmerged.stderr || "Cannot inspect index conflict stages");
  }
  if (unmerged.stdout) {
    throw new Error("Cannot create checkpoint with unmerged index entries");
  }

  const head = run("git", ["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  const status = run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    { trim: false },
  );
  if (!status.ok) throw new Error(status.stderr || "Cannot read status");
  const { lines, untracked, trackedDirty, intentToAdd } = parsePorcelain(
    status.stdout,
  );

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const durableRef = `refs/alloy/checkpoints/${id}`;
  const root = checkpointRoot(cwd);
  const base = join(root, id);
  const indexPath = join(root, `${id}.json`);
  let restoreObject = null;
  let ownedRefObject = null;
  let ownsBase = false;
  let ownsIndex = false;

  try {
    // Claim the filesystem ID before touching a ref with the same ID.
    mkdirSync(base, { mode: 0o700 });
    ownsBase = true;

    // Tracked changes object (excludes untracked — git limitation)
    const stash = run("git", ["stash", "create"], cwd);
    restoreObject = stash.ok && stash.stdout ? stash.stdout : null;
    if (restoreObject) {
      const zeroObject = "0".repeat(stash.stdout.length);
      const anchor = run(
        "git",
        ["update-ref", "--no-deref", durableRef, restoreObject, zeroObject],
        cwd,
      );
      if (!anchor.ok) throw new Error(anchor.stderr || "Cannot anchor Git stash");
      ownedRefObject = restoreObject;
    }

    // Diffs for verification / partial recovery
    const diff = run("git", ["diff", "--binary"], cwd, { trim: false });
    const diffCached = run("git", ["diff", "--cached", "--binary"], cwd, {
      trim: false,
    });
    if (!diff.ok) throw new Error(diff.stderr || "Cannot capture worktree diff");
    if (!diffCached.ok) {
      throw new Error(diffCached.stderr || "Cannot capture index diff");
    }

    let untrackedCopy = { copied: [], failed: [] };
    if (untracked.length) {
      untrackedCopy = copyUntrackedIntoStore(
        cwd,
        untracked,
        join(base, "untracked"),
      );
    }

    if (diff.stdout) {
      writeFileSync(join(base, "worktree.patch"), diff.stdout, {
        mode: 0o600,
      });
    }
    if (diffCached.stdout) {
      writeFileSync(join(base, "index.patch"), diffCached.stdout, {
        mode: 0o600,
      });
    }

    const complete =
      untrackedCopy.failed.length === 0 &&
      // if dirty tracked but stash empty and diffs empty — still "complete" clean-ish
      true;

    const meta = {
      formatVersion: CHECKPOINT_FORMAT_VERSION,
      id,
      label: label || `checkpoint ${new Date().toISOString()}`,
      created: new Date().toISOString(),
      head: head.stdout,
      ref: durableRef,
      refObject: null,
      restoreObject,
      dirty: lines.length > 0,
      includesUntracked: untrackedCopy.copied.length > 0,
      untracked: untrackedCopy.copied,
      untrackedFailed: untrackedCopy.failed,
      trackedDirty,
      intentToAdd,
      statusPorcelain: lines.slice(0, 500),
      complete,
      // NEVER implies restore will git clean
      restoreUsesClean: false,
      cwd: invocationCwd,
      repoRoot: cwd,
      storeDir: base,
      warning: complete
        ? null
        : "Checkpoint incomplete - some untracked paths failed to copy",
    };
    if (untracked.length && !restoreObject && trackedDirty.length === 0) {
      // only untracked — still recoverable via file store
      meta.recoverable = untrackedCopy.failed.length === 0;
    } else {
      meta.recoverable =
        Boolean(restoreObject) ||
        lines.length === 0 ||
        untrackedCopy.copied.length > 0 ||
        Boolean(diff.stdout) ||
        Boolean(diffCached.stdout) ||
        intentToAdd.length > 0;
    }

    const manifestDigest = computeCheckpointManifestDigest(meta, cwd);
    const anchorObject = createCheckpointAnchor(meta, manifestDigest, cwd);
    const zeroObject = "0".repeat(anchorObject.length);
    const anchored = run(
      "git",
      [
        "update-ref",
        "--no-deref",
        durableRef,
        anchorObject,
        ownedRefObject || zeroObject,
      ],
      cwd,
    );
    if (!anchored.ok) {
      throw new Error(anchored.stderr || "Cannot anchor checkpoint manifest");
    }
    ownedRefObject = anchorObject;
    meta.refObject = anchorObject;
    meta.manifestDigest = manifestDigest;

    const path = join(base, "meta.json");
    const serialized = JSON.stringify(meta, null, 2) + "\n";
    writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
    // Also index entry at root for listCheckpoints compatibility
    const indexFd = openSync(indexPath, "wx", 0o600);
    ownsIndex = true;
    try {
      writeFileSync(indexFd, serialized, { encoding: "utf8" });
    } finally {
      closeSync(indexFd);
    }

    return { ...meta, path };
  } catch (err) {
    const original = err instanceof Error ? err : new Error(String(err));
    const cleanupErrors = [];
    const artifacts = [
      ownsBase && { path: base, recursive: true },
      ownsIndex && { path: indexPath, recursive: false },
    ].filter(Boolean);
    for (const artifact of artifacts) {
      try {
        rmSync(artifact.path, {
          recursive: artifact.recursive,
          force: true,
        });
      } catch (cleanupError) {
        cleanupErrors.push(
          new Error(
            `Cannot remove partial checkpoint artifact ${artifact.path}`,
            { cause: cleanupError },
          ),
        );
      }
    }

    let retainedRef = null;
    if (ownedRefObject) {
      const cleanup = run(
        "git",
        ["update-ref", "--no-deref", "-d", durableRef, ownedRefObject],
        cwd,
      );
      if (!cleanup.ok) {
        retainedRef = durableRef;
        cleanupErrors.push(
          new Error(
            `Checkpoint ref may remain: ${durableRef}${cleanup.stderr ? `: ${cleanup.stderr}` : ""}`,
          ),
        );
      }
    }

    if (cleanupErrors.length) {
      throw new AggregateError(
        [original, ...cleanupErrors],
        `Checkpoint creation failed and cleanup was incomplete${retainedRef ? `; retained ref ${retainedRef}` : ""}`,
        { cause: original },
      );
    }
    throw original;
  }
}

export function listCheckpoints(cwd = process.cwd()) {
  cwd = repositoryRoot(cwd);
  const dir = checkpointRoot(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

function checkpointStore(match, cwd) {
  return containedPath(checkpointRoot(cwd), match.id).path;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authenticatedMetadata(metadata) {
  const {
    refObject: _refObject,
    manifestDigest: _manifestDigest,
    path: _path,
    ...authenticated
  } = metadata;
  return authenticated;
}

function checkpointPayloadRecord(base, rel) {
  const source = inspectSource(base, rel);
  if (source.stat.isSymbolicLink()) {
    return {
      path: rel,
      present: true,
      type: "symlink",
      mode: source.stat.mode & 0o7777,
      target: readlinkSync(source.path),
    };
  }
  return {
    path: rel,
    present: true,
    type: "file",
    mode: source.stat.mode & 0o7777,
    digest: sha256(readFileSync(source.path)),
  };
}

function listStoredPayloads(base, rel = "") {
  const paths = [];
  const directory = rel ? join(base, rel) : base;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (child === "meta.json") continue;
    if (entry.isDirectory()) {
      paths.push(...listStoredPayloads(base, child));
    } else {
      paths.push(child);
    }
  }
  return paths;
}

function checkpointManifest(metadata, cwd) {
  const base = checkpointStore(metadata, cwd);
  const untracked = metadata.untracked || [];
  if (
    !Array.isArray(untracked) ||
    untracked.some((rel) => typeof rel !== "string") ||
    new Set(untracked).size !== untracked.length
  ) {
    throw new Error(`Invalid checkpoint untracked manifest for ${metadata.id}`);
  }
  const stored = listStoredPayloads(base).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const expected = new Set(untracked.map((rel) => `untracked/${rel}`));
  for (const patch of ["worktree.patch", "index.patch"]) {
    if (existsSync(join(base, patch))) expected.add(patch);
  }
  if (
    stored.length !== expected.size ||
    stored.some((path) => !expected.has(path))
  ) {
    throw new Error(`Checkpoint stored payload set mismatch for ${metadata.id}`);
  }
  return {
    version: ANCHOR_FORMAT_VERSION,
    metadata: authenticatedMetadata(metadata),
    payloads: stored.map((rel) => checkpointPayloadRecord(base, rel)),
  };
}

function computeCheckpointManifestDigest(metadata, cwd) {
  return `sha256:${sha256(canonicalJson(checkpointManifest(metadata, cwd)))}`;
}

function createCheckpointAnchor(metadata, manifestDigest, cwd) {
  const tree = run("git", ["rev-parse", `${metadata.head}^{tree}`], cwd);
  if (!tree.ok) throw new Error(tree.stderr || "Cannot resolve checkpoint tree");
  const parent = metadata.restoreObject || metadata.head;
  const anchor = {
    version: ANCHOR_FORMAT_VERSION,
    id: metadata.id,
    ref: metadata.ref,
    head: metadata.head,
    restoreObject: metadata.restoreObject,
    manifestDigest,
  };
  const message = `${ANCHOR_MARKER}\n${canonicalJson(anchor)}\n`;
  const created = run(
    "git",
    ["commit-tree", tree.stdout, "-p", parent, "-F", "-"],
    cwd,
    {
      input: message,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Alloy Checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@alloy.invalid",
        GIT_COMMITTER_NAME: "Alloy Checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@alloy.invalid",
        GIT_AUTHOR_DATE: metadata.created,
        GIT_COMMITTER_DATE: metadata.created,
      },
    },
  );
  if (!created.ok) {
    throw new Error(created.stderr || "Cannot create checkpoint manifest anchor");
  }
  return created.stdout;
}

function readConsistentCheckpointMetadata(match, cwd) {
  const rootPath = join(checkpointRoot(cwd), `${match.id}.json`);
  const storePath = join(checkpointStore(match, cwd), "meta.json");
  let rootBytes;
  let storeBytes;
  try {
    rootBytes = readFileSync(rootPath);
    storeBytes = readFileSync(storePath);
  } catch (err) {
    throw new Error(`Checkpoint metadata is incomplete for ${match.id}`, {
      cause: err,
    });
  }
  if (!rootBytes.equals(storeBytes)) {
    throw new Error(`Checkpoint root/store metadata mismatch for ${match.id}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(rootBytes.toString("utf8"));
  } catch (err) {
    throw new Error(`Invalid checkpoint metadata for ${match.id}`, { cause: err });
  }
  if (metadata.id !== match.id) {
    throw new Error(`Checkpoint metadata identity mismatch for ${match.id}`);
  }
  return metadata;
}

function isFullObjectId(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function parseCheckpointAnchor(object, cwd) {
  const type = run("git", ["cat-file", "-t", object], cwd);
  if (!type.ok || type.stdout !== "commit") {
    throw new Error(`Invalid checkpoint anchor object ${object}`);
  }
  const content = run("git", ["cat-file", "commit", object], cwd, {
    trim: false,
  });
  if (!content.ok) throw new Error(content.stderr || "Cannot read checkpoint anchor");
  const separator = content.stdout.indexOf("\n\n");
  if (separator < 0) throw new Error(`Invalid checkpoint anchor content ${object}`);
  const headers = content.stdout.slice(0, separator).split("\n");
  const trees = headers
    .filter((line) => line.startsWith("tree "))
    .map((line) => line.slice("tree ".length));
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));
  const message = content.stdout.slice(separator + 2).trimEnd().split("\n");
  if (message[0] !== ANCHOR_MARKER || message.length !== 2) {
    throw new Error(`Invalid checkpoint anchor identity ${object}`);
  }
  let anchor;
  try {
    anchor = JSON.parse(message[1]);
  } catch (err) {
    throw new Error(`Invalid checkpoint anchor manifest ${object}`, { cause: err });
  }
  return { anchor, parents, trees };
}

function assertDirectRef(ref, cwd) {
  const symbolic = run("git", ["symbolic-ref", "-q", ref], cwd);
  if (symbolic.ok) {
    throw new Error(`Checkpoint canonical ref must be direct, not symbolic: ${ref}`);
  }
  if (symbolic.status !== 1) {
    throw new Error(symbolic.stderr || `Cannot inspect checkpoint ref ${ref}`);
  }
}

function validateAnchoredCheckpoint(metadata, cwd) {
  const expectedRef = `refs/alloy/checkpoints/${metadata.id}`;
  if (
    metadata.ref !== expectedRef ||
    !isFullObjectId(metadata.refObject) ||
    (metadata.restoreObject !== null &&
      !isFullObjectId(metadata.restoreObject)) ||
    typeof metadata.manifestDigest !== "string"
  ) {
    throw new Error(
      `Checkpoint reference metadata integrity mismatch for ${metadata.id}`,
    );
  }
  assertDirectRef(metadata.ref, cwd);
  const current = run("git", ["rev-parse", "--verify", metadata.ref], cwd);
  if (!current.ok || current.stdout !== metadata.refObject) {
    throw new Error(
      `Checkpoint reference object mismatch for ${metadata.id}; expected ${metadata.refObject}`,
    );
  }
  const { anchor, parents, trees } = parseCheckpointAnchor(metadata.refObject, cwd);
  const expectedParent = metadata.restoreObject || metadata.head;
  const expectedTree = run("git", ["rev-parse", `${metadata.head}^{tree}`], cwd);
  if (
    !expectedTree.ok ||
    trees.length !== 1 ||
    trees[0] !== expectedTree.stdout ||
    parents.length !== 1 ||
    parents[0] !== expectedParent ||
    anchor.version !== ANCHOR_FORMAT_VERSION ||
    anchor.id !== metadata.id ||
    anchor.ref !== expectedRef ||
    anchor.head !== metadata.head ||
    anchor.restoreObject !== metadata.restoreObject ||
    anchor.manifestDigest !== metadata.manifestDigest
  ) {
    throw new Error(`Checkpoint anchor integrity mismatch for ${metadata.id}`);
  }
  const head = run("git", ["cat-file", "-e", `${metadata.head}^{commit}`], cwd);
  if (!head.ok) throw new Error(head.stderr || "Invalid checkpoint HEAD");
  if (metadata.restoreObject) validateStashLikeAnchor(metadata, cwd);
  const digest = computeCheckpointManifestDigest(metadata, cwd);
  if (digest !== metadata.manifestDigest) {
    throw new Error(`Checkpoint payload digest mismatch for ${metadata.id}`);
  }
  return {
    kind: "anchored",
    object: metadata.refObject,
    restoreObject: metadata.restoreObject,
    metadata,
  };
}

function validateStashLikeAnchor(metadata, cwd) {
  for (const suffix of ["^{commit}", "^1^{commit}", "^2^{commit}"]) {
    const check = run(
      "git",
      ["cat-file", "-e", `${metadata.restoreObject}${suffix}`],
      cwd,
    );
    if (!check.ok) {
      throw new Error(
        `Invalid stash-like checkpoint object ${metadata.restoreObject}: ${check.stderr || "missing commit or parents"}`,
      );
    }
  }
  const base = run("git", ["rev-parse", `${metadata.restoreObject}^1`], cwd);
  if (!base.ok || base.stdout !== metadata.head) {
    throw new Error(
      `Checkpoint restore object ${metadata.restoreObject} does not belong to HEAD ${metadata.head}`,
    );
  }
}

function validateCheckpointReference(match, cwd, { forRestore = false } = {}) {
  const metadata = readConsistentCheckpointMetadata(match, cwd);
  if (metadata.formatVersion === CHECKPOINT_FORMAT_VERSION) {
    return validateAnchoredCheckpoint(metadata, cwd);
  }
  if (metadata.formatVersion !== undefined) {
    throw new Error(
      `Unsupported checkpoint format ${metadata.formatVersion}; export or migrate checkpoint ${metadata.id}`,
    );
  }
  if (forRestore) {
    throw new Error(
      `Checkpoint ${metadata.id} has unauthenticated legacy metadata; export or migrate it before restore`,
    );
  }
  return {
    kind: "unauthenticated",
    object: null,
    restoreObject: null,
    metadata,
  };
}

function captureUntrackedRestore(match, cwd) {
  const base = checkpointStore(match, cwd);
  const untrackedDir = join(base, "untracked");
  const payloads = [];
  for (const rel of match.untracked || []) {
    const source = inspectSource(untrackedDir, rel);
    inspectDestination(cwd, rel);
    payloads.push({
      rel,
      link: source.stat.isSymbolicLink() ? readlinkSync(source.path) : null,
      data: source.stat.isFile() ? readFileSync(source.path) : null,
      mode: source.stat.mode & 0o7777,
    });
  }
  return payloads;
}

function captureRestoreState(cwd) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const commands = {
    head: ["rev-parse", "HEAD"],
    status: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    tracked: ["ls-files", "-z"],
    index: ["ls-files", "--stage", "-z"],
    staged: ["diff", "--cached", "--binary"],
    unstaged: ["diff", "--binary"],
  };
  const state = {};
  for (const [name, args] of Object.entries(commands)) {
    const result = run("git", args, cwd, { trim: false, env });
    if (!result.ok) {
      throw new Error(result.stderr || `Cannot capture restore ${name} state`);
    }
    state[name] = result.stdout;
  }
  const symbolicHead = run("git", ["symbolic-ref", "-q", "HEAD"], cwd, {
    trim: false,
    env,
  });
  if (!symbolicHead.ok && symbolicHead.status !== 1) {
    throw new Error(symbolicHead.stderr || "Cannot capture symbolic HEAD state");
  }
  state.symbolicHead = symbolicHead.ok ? symbolicHead.stdout : "";
  return state;
}

function assertRestoreStateUnchanged(before, cwd) {
  const after = captureRestoreState(cwd);
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      throw new Error(
        `Repository ${key} state changed during restore preflight; restore aborted`,
      );
    }
  }
  return after;
}

function captureIgnoredPaths(cwd) {
  const ignored = run(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    cwd,
    {
      trim: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (!ignored.ok) {
    throw new Error(ignored.stderr || "Cannot preflight ignored paths");
  }
  return ignored.stdout.split("\0").filter(Boolean);
}

function restorePathsCollide(left, right) {
  left = left.replace(/\/+$/, "");
  right = right.replace(/\/+$/, "");
  return (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
}

function assertRestoreDestinationsAvailable(
  trackedRestorePaths,
  untrackedPayloads,
  currentState,
  cwd,
) {
  const currentUntracked = [
    ...new Set([
      ...parsePorcelain(currentState.status).untracked,
      ...captureIgnoredPaths(cwd),
    ]),
  ];
  for (const current of currentUntracked) {
    if (trackedRestorePaths.some((tracked) => restorePathsCollide(current, tracked))) {
      throw new Error(
        `Tracked restore collision appeared during preflight: ${current}`,
      );
    }
  }
  const currentTracked = currentState.tracked.split("\0").filter(Boolean);
  for (const tracked of trackedRestorePaths) {
    if (currentTracked.some((current) => restorePathsCollide(current, tracked))) {
      continue;
    }
    try {
      inspectDestination(cwd, tracked);
    } catch {
      throw new Error(
        `Tracked restore collision with current filesystem path: ${tracked}`,
      );
    }
  }
  for (const payload of untrackedPayloads) inspectDestination(cwd, payload.rel);
}

function probeUntrackedDestinations(payloads, cwd) {
  const root = resolve(cwd);
  for (const payload of payloads) {
    const destination = containedPath(root, payload.rel).path;
    let parent = dirname(destination);
    while (parent !== root) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Invalid destination ancestor: ${payload.rel}`);
        }
        break;
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
        parent = dirname(parent);
      }
    }

    let probeDir = null;
    let probeError = null;
    try {
      probeDir = mkdtempSync(join(parent, ".alloy-restore-probe-"));
      const probeFile = join(probeDir, "write-test");
      writeFileSync(probeFile, "probe", { flag: "wx", mode: 0o600 });
      unlinkSync(probeFile);
    } catch (err) {
      probeError = err;
    } finally {
      if (probeDir) {
        try {
          rmSync(probeDir, { recursive: true, force: true });
        } catch (err) {
          probeError ||= err;
        }
      }
    }
    if (probeError) {
      throw new Error(`Destination is not writable: ${payload.rel}`, {
        cause: probeError,
      });
    }
  }
}

function preflightTrackedRestore(
  match,
  cwd,
  checkpointUntrackedPaths,
  currentUntrackedPaths,
  restoreObject,
) {
  const head = run("git", ["cat-file", "-e", `${match.head}^{commit}`], cwd);
  if (!head.ok) throw new Error(head.stderr || "Invalid checkpoint HEAD");

  const temp = mkdtempSync(join(tmpdir(), "alloy-restore-"));
  const gitDir = join(temp, "git");
  const worktree = join(temp, "worktree");
  const index = join(temp, "index");
  mkdirSync(worktree, { mode: 0o700 });
  const objectDir = run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    cwd,
  );
  const objectFormat = run("git", ["rev-parse", "--show-object-format"], cwd);
  if (!objectDir.ok || !objectFormat.ok) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(
      objectDir.stderr || objectFormat.stderr || "Cannot locate Git object database",
    );
  }
  const initialized = run(
    "git",
    ["init", "--quiet", "--bare", `--object-format=${objectFormat.stdout}`, gitDir],
    cwd,
  );
  if (!initialized.ok) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(initialized.stderr || "Cannot initialize restore preflight repository");
  }
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: worktree,
    GIT_INDEX_FILE: index,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [
      objectDir.stdout,
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    ]
      .filter(Boolean)
      .join(delimiter),
    GIT_OPTIONAL_LOCKS: "0",
  };

  try {
    const detachedHead = run(
      "git",
      ["update-ref", "--no-deref", "HEAD", match.head],
      cwd,
      { env },
    );
    if (!detachedHead.ok) {
      throw new Error(detachedHead.stderr || "Cannot set restore preflight HEAD");
    }
    const readTree = run("git", ["read-tree", "--reset", "-u", match.head], cwd, {
      env,
    });
    if (!readTree.ok) throw new Error(readTree.stderr || "Cannot prepare restore preflight");

    if (restoreObject) {
      const object = run("git", ["cat-file", "-e", `${restoreObject}^{commit}`], cwd);
      if (!object.ok) throw new Error(object.stderr || "Invalid checkpoint reference");
      const apply = run("git", ["stash", "apply", "--index", restoreObject], cwd, {
        env,
      });
      if (!apply.ok) throw new Error(apply.stderr || "Checkpoint reference cannot be applied");
    } else if (match.dirty && (match.trackedDirty || []).length > 0) {
      const base = checkpointStore(match, cwd);
      const indexPatch = join(base, "index.patch");
      const worktreePatch = join(base, "worktree.patch");
      let hasPatch = false;
      if (existsSync(indexPatch)) {
        hasPatch = true;
        const apply = run("git", ["apply", "--index", indexPatch], cwd, { env });
        if (!apply.ok) throw new Error(apply.stderr || "Index patch cannot be applied");
      }
      if (existsSync(worktreePatch)) {
        hasPatch = true;
        const apply = run("git", ["apply", worktreePatch], worktree, { env });
        if (!apply.ok) throw new Error(apply.stderr || "Worktree patch cannot be applied");
      }
      if ((match.intentToAdd || []).length > 0) hasPatch = true;
      if (!hasPatch) throw new Error("Checkpoint has no recoverable tracked patch");
    }

    if ((match.intentToAdd || []).length > 0) {
      const intent = run(
        "git",
        ["add", "-N", "--", ...match.intentToAdd],
        worktree,
        { env },
      );
      if (!intent.ok) {
        throw new Error(intent.stderr || "Intent-to-add state cannot be applied");
      }
    }

    const tracked = run("git", ["ls-files", "-z"], worktree, {
      trim: false,
      env,
    });
    if (!tracked.ok) {
      throw new Error(tracked.stderr || "Cannot enumerate tracked restore paths");
    }
    const trackedRestorePaths = tracked.stdout.split("\0").filter(Boolean);
    for (const rel of currentUntrackedPaths) {
      try {
        inspectDestination(worktree, rel);
      } catch {
        throw new Error(`Tracked restore collision with current untracked path: ${rel}`);
      }
    }
    for (const rel of checkpointUntrackedPaths) inspectDestination(worktree, rel);
    return trackedRestorePaths;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function restoreUntrackedFiles(payloads, cwd) {
  const restored = [];
  for (const payload of payloads) {
    const destination = createSafeParents(cwd, payload.rel);
    if (payload.link !== null) {
      symlinkSync(payload.link, destination);
    } else {
      const fd = openSync(destination, "wx", payload.mode);
      try {
        writeFileSync(fd, payload.data);
        fchmodSync(fd, payload.mode);
      } finally {
        closeSync(fd);
      }
    }
    restored.push(payload.rel);
  }
  return restored;
}

/**
 * Restore a checkpoint.
 * @param {string} idOrPrefix
 * @param {string} [cwd]
 * @param {{ allowClean?: boolean }} [opts] - allowClean is always rejected
 */
export function restoreCheckpoint(idOrPrefix, cwd = process.cwd(), opts = {}) {
  requireNonEmptyId(idOrPrefix, "Checkpoint ID or prefix");
  if (opts.allowClean) {
    throw new Error(
      "git clean during restore is disabled (would delete untracked work). Restore untracked from checkpoint store instead.",
    );
  }
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");
  cwd = repositoryRoot(cwd);
  const all = listCheckpoints(cwd);
  const exact = all.find((checkpoint) => checkpoint.id === idOrPrefix);
  const prefixMatches = exact
    ? []
    : all.filter((checkpoint) => checkpoint.id.startsWith(idOrPrefix));
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous checkpoint prefix ${idOrPrefix}: ${prefixMatches.map((checkpoint) => checkpoint.id).join(", ")}`,
    );
  }
  const match = exact || prefixMatches[0];
  if (!match) throw new Error(`Checkpoint not found: ${idOrPrefix}`);
  let reference = validateCheckpointReference(match, cwd, { forRestore: true });
  const checkpoint = reference.metadata;

  const restoreState = captureRestoreState(cwd);
  const currentUntracked = [
    ...new Set([
      ...parsePorcelain(restoreState.status).untracked,
      ...captureIgnoredPaths(cwd),
    ]),
  ];
  const untrackedPayloads = captureUntrackedRestore(checkpoint, cwd);
  const trackedRestorePaths = preflightTrackedRestore(
    checkpoint,
    cwd,
    untrackedPayloads.map((payload) => payload.rel),
    currentUntracked,
    reference.restoreObject,
  );
  probeUntrackedDestinations(untrackedPayloads, cwd);
  const currentState = assertRestoreStateUnchanged(restoreState, cwd);
  assertRestoreDestinationsAvailable(
    trackedRestorePaths,
    untrackedPayloads,
    currentState,
    cwd,
  );
  if (reference.kind === "anchored") {
    const revalidated = validateCheckpointReference(checkpoint, cwd, {
      forRestore: true,
    });
    if (
      revalidated.kind !== reference.kind ||
      revalidated.object !== reference.object ||
      revalidated.restoreObject !== reference.restoreObject
    ) {
      throw new Error(
        `Checkpoint reference changed during restore preflight; restore aborted`,
      );
    }
    reference = revalidated;
  }

  // 1) Restore tracked state
  if (reference.restoreObject) {
    const reset = run("git", ["reset", "--hard", checkpoint.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    const show = run(
      "git",
      ["stash", "apply", "--index", reference.restoreObject],
      cwd,
    );
    if (!show.ok) throw new Error(show.stderr || "Restore failed");
  } else if (!checkpoint.dirty || (checkpoint.trackedDirty || []).length === 0) {
    // Clean tracked tree at checkpoint — reset tracked files only
    const reset = run("git", ["reset", "--hard", checkpoint.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    // Intentionally NO git clean -fd (P0.4)
  } else {
    // Dirty but no stash ref — try patches
    const base = checkpointStore(checkpoint, cwd);
    const idxPatch = join(base, "index.patch");
    const wtPatch = join(base, "worktree.patch");
    const reset = run("git", ["reset", "--hard", checkpoint.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    if (existsSync(idxPatch)) {
      const a = run("git", ["apply", "--index", idxPatch], cwd);
      if (!a.ok) throw new Error(a.stderr || "Index restore failed");
    }
    if (existsSync(wtPatch)) {
      const a = run("git", ["apply", wtPatch], cwd);
      if (!a.ok) throw new Error(a.stderr || "Worktree restore failed");
    }
  }

  if ((checkpoint.intentToAdd || []).length > 0) {
    const intent = run(
      "git",
      ["add", "-N", "--", ...checkpoint.intentToAdd],
      cwd,
    );
    if (!intent.ok) {
      throw new Error(intent.stderr || "Intent-to-add restore failed");
    }
  }

  // 2) Restore untracked from file store
  const restored = restoreUntrackedFiles(untrackedPayloads, cwd);

  return { ...checkpoint, untrackedRestored: restored, untrackedSkipped: [] };
}

/** Remove checkpoint store (optional cleanup helper) */
export function deleteCheckpoint(id, cwd = process.cwd()) {
  requireNonEmptyId(id, "Checkpoint ID");
  cwd = repositoryRoot(cwd);
  const all = listCheckpoints(cwd);
  const match = all.find((c) => c.id === id);
  if (!match) return false;

  const reference = validateCheckpointReference(match, cwd);
  const checkpoint = reference.metadata;
  if (reference.kind === "anchored") {
    const deleted = run(
      "git",
      ["update-ref", "--no-deref", "-d", checkpoint.ref, reference.object],
      cwd,
    );
    if (!deleted.ok) {
      throw new Error(
        `Cannot delete checkpoint ref ${checkpoint.ref}; checkpoint artifacts preserved${deleted.stderr ? `: ${deleted.stderr}` : ""}`,
      );
    }
  }

  const base = checkpointStore(checkpoint, cwd);
  const cleanupErrors = [];
  try {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  } catch (err) {
    cleanupErrors.push(err);
  }
  try {
    rmSync(join(checkpointRoot(cwd), `${id}.json`), { force: true });
  } catch (err) {
    cleanupErrors.push(err);
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      cleanupErrors,
      `Checkpoint ref deleted but one or more artifacts could not be removed for ${id}`,
    );
  }
  return true;
}
