/**
 * Safe git checkpoints (P0.4).
 *
 * Captures:
 *  - HEAD
 *  - tracked dirty state via `git stash create` (when non-empty)
 *  - untracked files by copying into the checkpoint store (stash create omits them)
 *  - porcelain status + manifest of paths
 *
 * Restore never runs `git clean -fd` by default (would delete untracked work).
 * Untracked files are restored from the checkpoint file store.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * @returns {{ lines: string[], untracked: string[], trackedDirty: string[] }}
 */
export function parsePorcelain(porcelain) {
  const raw = String(porcelain || "");
  const nulDelimited = raw.includes("\0");
  const records = raw.split(nulDelimited ? "\0" : "\n").filter(Boolean);
  const lines = [];
  const untracked = [];
  const trackedDirty = [];
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
      if (nulDelimited && /[RC]/.test(line.slice(0, 2))) i += 1;
    }
  }
  return { lines, untracked, trackedDirty };
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
  const { lines, untracked, trackedDirty } = parsePorcelain(status.stdout);

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const durableRef = `refs/alloy/checkpoints/${id}`;

  // Tracked changes object (excludes untracked — git limitation)
  const stash = run("git", ["stash", "create"], cwd);
  if (!stash.ok) throw new Error(stash.stderr || "Cannot capture Git stash");
  const ref = stash.stdout ? durableRef : null;
  if (ref) {
    const anchor = run("git", ["update-ref", ref, stash.stdout], cwd);
    if (!anchor.ok) throw new Error(anchor.stderr || "Cannot anchor Git stash");
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

  const base = join(checkpointRoot(cwd), id);
  mkdirSync(base, { recursive: true, mode: 0o700 });

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
      Boolean(diffCached.stdout);
  }

  const path = join(base, "meta.json");
  const serialized = JSON.stringify(meta, null, 2) + "\n";
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
  // Also index entry at root for listCheckpoints compatibility
  writeFileSync(join(checkpointRoot(cwd), `${id}.json`), serialized, {
    encoding: "utf8",
    mode: 0o600,
  });

  return { ...meta, path };
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
        const check = run("git", ["apply", "--check", worktreePatch], cwd, { env });
        if (!check.ok) throw new Error(check.stderr || "Worktree patch cannot be applied");
      }
      if (!hasPatch) throw new Error("Checkpoint has no recoverable tracked patch");
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
      writeFileSync(destination, payload.data, {
        flag: "wx",
        mode: payload.mode,
      });
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
  const match =
    all.find((c) => c.id === idOrPrefix) ||
    all.find((c) => c.id.startsWith(idOrPrefix));
  if (!match) throw new Error(`Checkpoint not found: ${idOrPrefix}`);

  const currentStatus = run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    {
      trim: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (!currentStatus.ok) {
    throw new Error(currentStatus.stderr || "Cannot preflight current status");
  }
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
      ...parsePorcelain(currentStatus.stdout).untracked,
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
