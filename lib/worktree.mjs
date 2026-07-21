/**
 * Git worktree helpers for Alloy parallel/isolated writers.
 * Worktrees live under ~/.pi/alloy/worktrees/<project-id>/
 *
 * By default, new worktrees are seeded with the source checkout's dirty
 * baseline (staged + unstaged + untracked) so scout/planner state matches
 * what the builder sees (Ava P0.5 / P1 verification).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";
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

function worktreeRoot(cwd = process.cwd()) {
  const dir = join(getAlloyHome(), "worktrees", projectIdFromCwd(cwd));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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

  const id = `${role}-${(taskId || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
  const branch = `alloy/${id}`;
  const path = join(worktreeRoot(cwd), id);

  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path}`);
  }

  // Capture dirty baseline BEFORE worktree add (source tree state scout saw)
  let baseline = null;
  if (seedDirty) {
    baseline = captureDirtyBaseline(cwd);
    baseline.sourceCwd = resolve(cwd);
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
      const removed = run(["worktree", "remove", "--force", path], cwd);
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
  };
  meta.worktrees = [...(meta.worktrees || []).filter((w) => w.id !== id), entry];
  saveMeta(meta, cwd);
  return { ...entry, seed: seedResult };
}

export function listWorktrees(cwd = process.cwd()) {
  const meta = loadMeta(cwd);
  const listed = run(["worktree", "list", "--porcelain"], cwd);
  const paths = new Set();
  if (listed.ok) {
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length));
    }
  }
  return (meta.worktrees || []).map((w) => ({
    ...w,
    exists: existsSync(w.path),
    knownToGit: paths.has(w.path),
  }));
}

/**
 * Remove worktree and optionally delete branch.
 */
export function removeWorktree(id, { deleteBranch = true, cwd = process.cwd() } = {}) {
  const meta = loadMeta(cwd);
  const entry = (meta.worktrees || []).find((w) => w.id === id || w.id.startsWith(id));
  if (!entry) throw new Error(`Worktree not found: ${id}`);

  const rm = run(["worktree", "remove", "--force", entry.path], cwd);
  if (!rm.ok && existsSync(entry.path)) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
    } catch {
      // ignore
    }
    run(["worktree", "prune"], cwd);
  } else if (!rm.ok) {
    run(["worktree", "prune"], cwd);
  }

  if (deleteBranch && entry.branch) {
    run(["branch", "-D", entry.branch], cwd);
  }

  meta.worktrees = (meta.worktrees || []).filter((w) => w.id !== entry.id);
  saveMeta(meta, cwd);
  return entry;
}

/**
 * Export a patch from a worktree vs its base HEAD (or main repo HEAD).
 */
export function worktreeDiff(id, cwd = process.cwd()) {
  const list = listWorktrees(cwd);
  const entry = list.find((w) => w.id === id || w.id.startsWith(id));
  if (!entry) throw new Error(`Worktree not found: ${id}`);
  if (!existsSync(entry.path)) throw new Error(`Worktree path missing: ${entry.path}`);

  const base = entry.head || "HEAD";
  const diff = run(["diff", base], entry.path);
  const stat = run(["diff", "--stat", base], entry.path);
  const porcelain = run(["status", "--porcelain"], entry.path);
  const untracked = (porcelain.stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
  return {
    id: entry.id,
    path: entry.path,
    branch: entry.branch,
    stat: stat.stdout,
    diff: diff.stdout,
    untracked,
    porcelain: porcelain.stdout,
  };
}
