/**
 * Git worktree helpers for Alloy parallel/isolated writers.
 * Worktrees live under ~/.pi/alloy/worktrees/<project-id>/
 *
 * By default, new worktrees are seeded with the source checkout's dirty
 * baseline (staged + unstaged + untracked) so scout/planner state matches
 * what the builder sees.
 *
 * Path checks fail closed for state changes they detect and pre-existing
 * symlink/collision paths, but are not an OS security boundary against a
 * malicious same-UID process racing ancestor replacement between validation
 * and use. Descriptor-relative openat hardening is future work.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectIdFromCwd } from "./paths.mjs";
import {
  copyEnumeratedPaths,
  fingerprintEnumeratedPaths,
} from "./git-state-files.mjs";

function run(args, cwd, { trim = true, input } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
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
  const r = run(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.stdout === "true";
}

export function repositoryRoot(cwd = process.cwd()) {
  const root = run(["rev-parse", "--show-toplevel"], cwd);
  if (!root.ok) throw new Error(root.stderr || "Not a git repository");
  return resolve(root.stdout);
}

function requireNonEmptyId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertSafeDirectoryChain(target, { mustExist = false, label = "path" } = {}) {
  target = resolve(target);
  const chain = [];
  for (let current = target; ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }

  let finalExists = false;
  for (const current of chain.reverse()) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsafe ${label}: symlink path component ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Unsafe ${label}: non-directory path component ${current}`);
    }
    if (current === target) finalExists = true;
  }
  if (mustExist && !finalExists) {
    throw new Error(`Unsafe ${label}: directory does not exist: ${target}`);
  }
  return finalExists;
}

function worktreeRoot(cwd = process.cwd()) {
  cwd = repositoryRoot(cwd);
  const home = resolve(
    process.env.ALLOY_HOME || join(homedir(), ".pi", "alloy"),
  );
  const dir = join(home, "worktrees", projectIdFromCwd(cwd));
  assertSafeDirectoryChain(dir, { label: "managed worktree root" });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafeDirectoryChain(dir, {
    mustExist: true,
    label: "managed worktree root",
  });
  return dir;
}

function removeManagedWorktreeWithGit(path, cwd) {
  assertSafeDirectoryChain(path, {
    mustExist: true,
    label: "managed worktree path",
  });
  return run(["worktree", "remove", "--force", path], cwd);
}

function metaPath(cwd = process.cwd()) {
  return join(worktreeRoot(cwd), "index.json");
}

function loadMeta(cwd = process.cwd()) {
  const p = metaPath(cwd);
  if (!existsSync(p)) return { worktrees: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { worktrees: [] };
  }
}

function saveMeta(meta, cwd = process.cwd()) {
  writeFileSync(metaPath(cwd), JSON.stringify(meta, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Snapshot dirty state of a working tree (does not mutate).
 * @returns {{
 *   head: string,
 *   porcelain: string[],
 *   unstagedPatch: string,
 *   stagedPatch: string,
 *   untracked: string[],
 *   dirty: boolean,
 * }}
 */
export function captureDirtyBaseline(cwd = process.cwd()) {
  const invocationCwd = resolve(cwd);
  cwd = repositoryRoot(cwd);
  const head = run(["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  const porcelain = run(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    { trim: false },
  );
  if (!porcelain.ok) throw new Error(porcelain.stderr || "Cannot read status");
  const records = (porcelain.stdout || "").split("\0").filter(Boolean);
  const lines = [];

  const untracked = [];
  const intentToAdd = [];
  for (let i = 0; i < records.length; i += 1) {
    const line = records[i];
    lines.push(line);
    if (line.startsWith("?? ")) untracked.push(line.slice(3));
    if (line.startsWith(" A ")) intentToAdd.push(line.slice(3));
    if (/[RC]/.test(line.slice(0, 2))) i += 1;
  }

  const unstaged = run(["diff", "--binary"], cwd, { trim: false });
  const staged = run(["diff", "--cached", "--binary"], cwd, {
    trim: false,
  });
  if (!unstaged.ok) {
    throw new Error(unstaged.stderr || "Cannot capture unstaged diff");
  }
  if (!staged.ok) {
    throw new Error(staged.stderr || "Cannot capture staged diff");
  }
  const indexState = run(["ls-files", "--stage", "-z"], cwd, {
    trim: false,
  });
  if (!indexState.ok) {
    throw new Error(indexState.stderr || "Cannot capture index state");
  }

  return {
    head: head.stdout,
    porcelain: lines,
    porcelainRaw: porcelain.stdout || "",
    indexState: indexState.stdout || "",
    unstagedPatch: unstaged.stdout || "",
    stagedPatch: staged.stdout || "",
    untracked,
    untrackedState: fingerprintEnumeratedPaths(cwd, untracked),
    intentToAdd,
    dirty: lines.length > 0,
    sourceCwd: cwd,
    cwd: invocationCwd,
    repoRoot: cwd,
  };
}

function copyUntracked(sourceCwd, destCwd, paths) {
  return copyEnumeratedPaths(sourceCwd, destCwd, paths);
}

/**
 * Apply a captured dirty baseline into a clean worktree path.
 * @returns {{ applied: boolean, untrackedCopied: string[], errors: string[] }}
 */
export function seedWorktreeFromBaseline(baseline, worktreePath) {
  const errors = [];
  if (!baseline || !existsSync(worktreePath)) {
    return { applied: false, untrackedCopied: [], errors: ["missing baseline or path"] };
  }

  // Staged first, then unstaged (matches index → worktree order)
  if (baseline.stagedPatch) {
    try {
      const a = run(["apply", "--index", "-"], worktreePath, {
        input: baseline.stagedPatch,
      });
      if (!a.ok) errors.push(`staged patch: ${a.stderr || "apply failed"}`);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  if (baseline.unstagedPatch) {
    try {
      const a = run(["apply", "-"], worktreePath, {
        input: baseline.unstagedPatch,
      });
      if (!a.ok) errors.push(`unstaged patch: ${a.stderr || "apply failed"}`);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  if (baseline.intentToAdd?.length && errors.length === 0) {
    const intent = run(["add", "-N", "--", ...baseline.intentToAdd], worktreePath);
    if (!intent.ok) errors.push(`intent-to-add: ${intent.stderr || "add failed"}`);
  }

  let untrackedCopied = [];
  if (baseline.untracked?.length) {
    // source cwd is not in baseline — caller must pass source via baseline.sourceCwd
    const sourceCwd = baseline.sourceCwd;
    if (sourceCwd) {
      const r = copyUntracked(sourceCwd, worktreePath, baseline.untracked);
      untrackedCopied = r.copied;
      for (const f of r.failed) errors.push(`untracked ${f.path}: ${f.error}`);
    } else {
      errors.push("untracked present but sourceCwd missing on baseline");
    }
  }

  if (errors.length === 0) {
    try {
      const actual = captureDirtyBaseline(worktreePath);
      const comparisons = [
        ["porcelain", actual.porcelainRaw, baseline.porcelainRaw],
        ["index", actual.indexState, baseline.indexState],
        ["staged patch", actual.stagedPatch, baseline.stagedPatch],
        ["unstaged patch", actual.unstagedPatch, baseline.unstagedPatch],
        [
          "untracked",
          JSON.stringify(actual.untrackedState),
          JSON.stringify(baseline.untrackedState),
        ],
      ];
      for (const [name, observed, expected] of comparisons) {
        if (observed !== expected) errors.push(`${name} state mismatch`);
      }
    } catch (err) {
      errors.push(`state verification: ${String(err?.message || err)}`);
    }
  }

  return {
    applied: errors.length === 0,
    untrackedCopied,
    errors,
    seeded: Boolean(
      baseline.stagedPatch ||
        baseline.unstagedPatch ||
        (baseline.untracked && baseline.untracked.length) ||
        (baseline.intentToAdd && baseline.intentToAdd.length),
    ),
  };
}

/**
 * Create an isolated worktree + branch for a task/role.
 * @param {{ taskId?: string, role?: string, cwd?: string, seedDirty?: boolean }} opts
 * @returns {{ id: string, path: string, branch: string, seeded?: object }}
 */
export function createWorktree({
  taskId,
  role = "builder",
  cwd = process.cwd(),
  seedDirty = true,
} = {}) {
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");
  const invocationCwd = resolve(cwd);
  cwd = repositoryRoot(cwd);

  const id = `${role}-${(taskId || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
  const branch = `alloy/${id}`;
  const path = join(worktreeRoot(cwd), id);

  if (!safePersistedPath({ id, path }, cwd)) {
    throw new Error(`Invalid worktree role or path: ${role}`);
  }
  assertSafeDirectoryChain(path, { label: "managed worktree path" });

  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path}`);
  }

  // Capture dirty baseline BEFORE worktree add (source tree state scout saw)
  let baseline = null;
  if (seedDirty) {
    baseline = captureDirtyBaseline(invocationCwd);
  }
  const head = baseline?.head
    ? { ok: true, stdout: baseline.head, stderr: "" }
    : run(["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  const add = run(
    ["worktree", "add", "-b", branch, path, head.stdout],
    cwd,
  );
  if (!add.ok) {
    throw new Error(add.stderr || add.stdout || "git worktree add failed");
  }

  let seedResult = null;
  if (baseline?.dirty) {
    seedResult = seedWorktreeFromBaseline(baseline, path);
    if (!seedResult.applied) {
      let removed;
      try {
        removed = removeManagedWorktreeWithGit(path, cwd);
      } catch (err) {
        removed = { ok: false, stderr: String(err?.message || err) };
      }
      const deleted = run(["branch", "-D", branch], cwd);
      const cleanup = [
        !removed.ok && `worktree cleanup: ${removed.stderr || "failed"}`,
        !deleted.ok && `branch cleanup: ${deleted.stderr || "failed"}`,
      ].filter(Boolean);
      throw new Error(
        `Failed to seed dirty baseline: ${[
          ...seedResult.errors,
          ...cleanup,
        ].join("; ")}`,
      );
    }
  }

  const meta = loadMeta(cwd);
  const entry = {
    id,
    path,
    branch,
    role,
    taskId: taskId || null,
    created: new Date().toISOString(),
    head: head.stdout,
    seededDirty: Boolean(seedResult?.seeded),
    seedErrors: seedResult?.errors || [],
    cwd: invocationCwd,
    repoRoot: cwd,
  };
  meta.worktrees = [...(meta.worktrees || []).filter((w) => w.id !== id), entry];
  saveMeta(meta, cwd);
  return { ...entry, seed: seedResult };
}

export function listWorktrees(cwd = process.cwd()) {
  cwd = repositoryRoot(cwd);
  const meta = loadMeta(cwd);
  const registered = registeredWorktrees(cwd);
  return (meta.worktrees || []).map((w) => {
    const persisted = safePersistedPath(w, cwd);
    return {
      ...w,
      exists: persisted ? existsSync(persisted.path) : false,
      knownToGit: persisted
        ? registered.some(
            (item) =>
              item.path === persisted.path &&
              item.branch === `refs/heads/${w.branch}`,
          )
        : false,
    };
  });
}

function registeredWorktrees(cwd) {
  const listed = run(["worktree", "list", "--porcelain"], cwd);
  if (!listed.ok) {
    throw new Error(listed.stderr || "Cannot list registered Git worktrees");
  }
  return listed.stdout
    .split(/\n\n+/)
    .map((record) => {
      const lines = record.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "));
      const branch = lines.find((line) => line.startsWith("branch "));
      return path
        ? {
            path: resolve(path.slice("worktree ".length)),
            branch: branch ? branch.slice("branch ".length) : null,
          }
        : null;
    })
    .filter(Boolean);
}

function safePersistedPath(entry, cwd) {
  if (!entry || typeof entry.id !== "string" || typeof entry.path !== "string") {
    return null;
  }
  const root = worktreeRoot(cwd);
  const path = resolve(entry.path);
  const fromRoot = relative(root, path);
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    path !== join(root, entry.id)
  ) {
    return null;
  }
  return { root, path };
}

function findWorktreeEntry(meta, id) {
  requireNonEmptyId(id, "Worktree ID or prefix");
  const entries = meta.worktrees || [];
  const exact = entries.find((entry) => entry.id === id);
  if (exact) return exact;
  const matches = entries.filter((entry) => entry.id.startsWith(id));
  if (matches.length > 1) throw new Error(`Ambiguous worktree prefix: ${id}`);
  return matches[0] || null;
}

function validateRegisteredEntry(entry, cwd) {
  const persisted = safePersistedPath(entry, cwd);
  if (!persisted) {
    throw new Error(`Invalid worktree metadata path for ${entry?.id || "unknown"}`);
  }
  if (entry.branch !== `alloy/${entry.id}`) {
    throw new Error(`Worktree metadata branch mismatch for ${entry.id}`);
  }
  const registered = registeredWorktrees(cwd);
  const live = registered.find((item) => item.path === persisted.path);
  if (!live || live.branch !== `refs/heads/${entry.branch}`) {
    return { ...persisted, live: null };
  }
  return { ...persisted, live };
}

/**
 * Remove worktree and optionally delete branch.
 */
export function removeWorktree(id, { deleteBranch = true, cwd = process.cwd() } = {}) {
  requireNonEmptyId(id, "Worktree ID or prefix");
  cwd = repositoryRoot(cwd);
  const meta = loadMeta(cwd);
  const entry = findWorktreeEntry(meta, id);
  if (!entry) throw new Error(`Worktree not found: ${id}`);
  const validated = validateRegisteredEntry(entry, cwd);
  const pathExists = assertSafeDirectoryChain(validated.path, {
    label: "managed worktree path",
  });

  if (!validated.live) {
    if (pathExists) {
      throw new Error(`Worktree path is not registered with Git: ${validated.path}`);
    }
    if (deleteBranch && entry.branch) {
      const deleted = run(["branch", "-D", entry.branch], cwd);
      if (!deleted.ok) {
        throw new Error(
          `Git could not delete worktree branch ${entry.branch}; metadata retained for retry: ${deleted.stderr || "delete failed"}`,
        );
      }
    }
    meta.worktrees = (meta.worktrees || []).filter((w) => w.id !== entry.id);
    saveMeta(meta, cwd);
    return entry;
  }

  if (!pathExists) {
    throw new Error(`Managed worktree path is missing: ${validated.path}`);
  }

  const removed = removeManagedWorktreeWithGit(validated.path, cwd);
  if (!removed.ok) {
    throw new Error(
      `Git could not remove worktree ${entry.id}: ${removed.stderr || "remove failed"}`,
    );
  }
  const stillRegistered = registeredWorktrees(cwd).some(
    (item) => item.path === validated.path,
  );
  if (existsSync(validated.path) || stillRegistered) {
    throw new Error(`Worktree removal could not be verified for ${entry.id}`);
  }

  if (deleteBranch && entry.branch) {
    const deleted = run(["branch", "-D", entry.branch], cwd);
    if (!deleted.ok) {
      throw new Error(
        `Git could not delete worktree branch ${entry.branch}; metadata retained for retry: ${deleted.stderr || "delete failed"}`,
      );
    }
  }

  meta.worktrees = (meta.worktrees || []).filter((w) => w.id !== entry.id);
  saveMeta(meta, cwd);
  return entry;
}

/**
 * Export a patch from a worktree vs its base HEAD (or main repo HEAD).
 */
export function worktreeDiff(id, cwd = process.cwd()) {
  requireNonEmptyId(id, "Worktree ID or prefix");
  cwd = repositoryRoot(cwd);
  const meta = loadMeta(cwd);
  const entry = findWorktreeEntry(meta, id);
  if (!entry) throw new Error(`Worktree not found: ${id}`);
  const validated = validateRegisteredEntry(entry, cwd);
  if (!validated.live) throw new Error(`Worktree is not registered with Git: ${entry.id}`);
  if (!existsSync(validated.path)) {
    throw new Error(`Worktree path missing: ${validated.path}`);
  }

  const base = entry.head || "HEAD";
  const diff = run(["diff", base], validated.path);
  const stat = run(["diff", "--stat", base], validated.path);
  const porcelain = run(["status", "--porcelain"], validated.path);
  const untracked = (porcelain.stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
  return {
    id: entry.id,
    path: validated.path,
    branch: entry.branch,
    stat: stat.stdout,
    diff: diff.stdout,
    untracked,
    porcelain: porcelain.stdout,
  };
}
