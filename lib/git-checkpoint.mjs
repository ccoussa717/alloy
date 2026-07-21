/**
 * Recoverable git checkpoints (P0.4).
 *
 * Captures:
 *  - HEAD
 *  - tracked dirty state via `git stash create` (when non-empty)
 *  - untracked files by copying into the checkpoint store (stash create omits them)
 *  - porcelain status + manifest of paths
 *
 * Restore never runs `git clean -fd` by default (would delete untracked work).
 * Untracked files are restored from the checkpoint file store.
 *
 * Filesystem validation fails closed for state changes it detects and for
 * pre-existing symlink/collision paths. It is not an OS security boundary
 * against a malicious same-UID process racing ancestor replacement between
 * validation and use; descriptor-relative openat hardening is future work.
 */

import { spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";
import {
  containedPath,
  copyEnumeratedPaths,
  createSafeParents,
  inspectDestination,
  inspectSource,
} from "./git-state-files.mjs";

function run(cmd, args, cwd, { trim = true, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    env,
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
  let anchoredObject = null;
  let ownsBase = false;
  let ownsIndex = false;

  try {
    // Tracked changes object (excludes untracked — git limitation)
    const stash = run("git", ["stash", "create"], cwd);
    const ref = stash.ok && stash.stdout ? durableRef : null;
    if (ref) {
      const anchor = run("git", ["update-ref", ref, stash.stdout], cwd);
      if (!anchor.ok) throw new Error(anchor.stderr || "Cannot anchor Git stash");
      anchoredObject = stash.stdout;
    }

    // Create the owned store before capture so every later failure has one
    // compensation path for the ref, store, and root index entry.
    mkdirSync(base, { mode: 0o700 });
    ownsBase = true;

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
      id,
      label: label || `checkpoint ${new Date().toISOString()}`,
      created: new Date().toISOString(),
      head: head.stdout,
      ref,
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
      cwd,
      storeDir: base,
      warning: complete
        ? null
        : "Checkpoint incomplete - some untracked paths failed to copy",
    };
    if (untracked.length && !ref && trackedDirty.length === 0) {
      // only untracked — still recoverable via file store
      meta.recoverable = untrackedCopy.failed.length === 0;
    } else {
      meta.recoverable =
        Boolean(ref) ||
        lines.length === 0 ||
        untrackedCopy.copied.length > 0 ||
        Boolean(diff.stdout) ||
        Boolean(diffCached.stdout) ||
        intentToAdd.length > 0;
    }

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
    if (anchoredObject) {
      const cleanup = run(
        "git",
        ["update-ref", "-d", durableRef, anchoredObject],
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
      mode: source.stat.mode & 0o777,
    });
  }
  return payloads;
}

function captureRestoreState(cwd) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const commands = {
    head: ["rev-parse", "HEAD"],
    status: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
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
) {
  const head = run("git", ["cat-file", "-e", `${match.head}^{commit}`], cwd);
  if (!head.ok) throw new Error(head.stderr || "Invalid checkpoint HEAD");

  const temp = mkdtempSync(join(tmpdir(), "alloy-restore-"));
  const worktree = join(temp, "worktree");
  const index = join(temp, "index");
  mkdirSync(worktree, { mode: 0o700 });
  const gitDir = run("git", ["rev-parse", "--absolute-git-dir"], cwd);
  if (!gitDir.ok) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(gitDir.stderr || "Cannot locate Git directory");
  }
  const env = {
    ...process.env,
    GIT_DIR: gitDir.stdout,
    GIT_WORK_TREE: worktree,
    GIT_INDEX_FILE: index,
    GIT_OPTIONAL_LOCKS: "0",
  };

  try {
    const readTree = run("git", ["read-tree", "--reset", "-u", match.head], cwd, {
      env,
    });
    if (!readTree.ok) throw new Error(readTree.stderr || "Cannot prepare restore preflight");

    if (match.ref) {
      const object = run("git", ["cat-file", "-e", `${match.ref}^{commit}`], cwd);
      if (!object.ok) throw new Error(object.stderr || "Invalid checkpoint reference");
      const apply = run("git", ["stash", "apply", "--index", match.ref], cwd, {
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

    for (const rel of currentUntrackedPaths) {
      try {
        inspectDestination(worktree, rel);
      } catch {
        throw new Error(`Tracked restore collision with current untracked path: ${rel}`);
      }
    }
    for (const rel of checkpointUntrackedPaths) inspectDestination(worktree, rel);
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
  if (opts.allowClean) {
    throw new Error(
      "git clean during restore is disabled (would delete untracked work). Restore untracked from checkpoint store instead.",
    );
  }
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");
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

  const restoreState = captureRestoreState(cwd);
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
  const currentUntracked = [
    ...new Set([
      ...parsePorcelain(restoreState.status).untracked,
      ...ignored.stdout.split("\0").filter(Boolean),
    ]),
  ];
  const untrackedPayloads = captureUntrackedRestore(match, cwd);
  preflightTrackedRestore(
    match,
    cwd,
    untrackedPayloads.map((payload) => payload.rel),
    currentUntracked,
  );
  probeUntrackedDestinations(untrackedPayloads, cwd);
  assertRestoreStateUnchanged(restoreState, cwd);

  // 1) Restore tracked state
  if (match.ref) {
    const reset = run("git", ["reset", "--hard", match.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    const show = run("git", ["stash", "apply", "--index", match.ref], cwd);
    if (!show.ok) throw new Error(show.stderr || "Restore failed");
  } else if (!match.dirty || (match.trackedDirty || []).length === 0) {
    // Clean tracked tree at checkpoint — reset tracked files only
    const reset = run("git", ["reset", "--hard", match.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    // Intentionally NO git clean -fd (P0.4)
  } else {
    // Dirty but no stash ref — try patches
    const base = checkpointStore(match, cwd);
    const idxPatch = join(base, "index.patch");
    const wtPatch = join(base, "worktree.patch");
    const reset = run("git", ["reset", "--hard", match.head], cwd);
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

  if ((match.intentToAdd || []).length > 0) {
    const intent = run(
      "git",
      ["add", "-N", "--", ...match.intentToAdd],
      cwd,
    );
    if (!intent.ok) {
      throw new Error(intent.stderr || "Intent-to-add restore failed");
    }
  }

  // 2) Restore untracked from file store
  const restored = restoreUntrackedFiles(untrackedPayloads, cwd);

  return { ...match, untrackedRestored: restored, untrackedSkipped: [] };
}

/** Remove checkpoint store (optional cleanup helper) */
export function deleteCheckpoint(id, cwd = process.cwd()) {
  const all = listCheckpoints(cwd);
  const match = all.find((c) => c.id === id);
  if (!match) return false;
  const base = checkpointStore(match, cwd);
  try {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    rmSync(join(checkpointRoot(cwd), `${id}.json`), { force: true });
  } catch {
    // ignore
  }
  if (match.ref?.startsWith("refs/alloy/checkpoints/")) {
    run("git", ["update-ref", "-d", match.ref], cwd);
  }
  return true;
}
