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
  cpSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";

function run(args, cwd) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
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

  const porcelain = run(["status", "--porcelain"], cwd);
  const lines = (porcelain.stdout || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  const untracked = [];
  for (const line of lines) {
    if (line.startsWith("?? ")) untracked.push(line.slice(3));
  }

  const unstaged = run(["diff"], cwd);
  const staged = run(["diff", "--cached"], cwd);

  return {
    head: head.stdout,
    porcelain: lines,
    unstagedPatch: unstaged.stdout || "",
    stagedPatch: staged.stdout || "",
    untracked,
    dirty: lines.length > 0,
  };
}

function copyUntracked(sourceCwd, destCwd, paths) {
  const copied = [];
  const failed = [];
  const srcRoot = resolve(sourceCwd);
  const destRoot = resolve(destCwd);
  for (const rel of paths) {
    const src = resolve(sourceCwd, rel);
    if (!src.startsWith(srcRoot)) {
      failed.push({ path: rel, error: "path_escape" });
      continue;
    }
    if (!existsSync(src)) {
      failed.push({ path: rel, error: "missing" });
      continue;
    }
    const dest = resolve(destCwd, rel);
    if (!dest.startsWith(destRoot)) {
      failed.push({ path: rel, error: "dest_escape" });
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      copied.push(rel);
    } catch (err) {
      failed.push({ path: rel, error: String(err?.message || err) });
    }
  }
  return { copied, failed };
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
    const tmp = join(worktreePath, ".alloy-staged.patch");
    try {
      writeFileSync(tmp, baseline.stagedPatch + "\n");
      const a = run(["apply", "--cached", tmp], worktreePath);
      if (!a.ok) {
        // try without --cached into worktree
        const b = run(["apply", tmp], worktreePath);
        if (!b.ok) errors.push(`staged patch: ${a.stderr || b.stderr || "apply failed"}`);
      }
    } catch (err) {
      errors.push(String(err?.message || err));
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
    }
  }

  if (baseline.unstagedPatch) {
    const tmp = join(worktreePath, ".alloy-unstaged.patch");
    try {
      writeFileSync(tmp, baseline.unstagedPatch + "\n");
      const a = run(["apply", tmp], worktreePath);
      if (!a.ok) {
        // 3-way fallback
        const b = run(["apply", "--3way", tmp], worktreePath);
        if (!b.ok) errors.push(`unstaged patch: ${a.stderr || b.stderr || "apply failed"}`);
      }
    } catch (err) {
      errors.push(String(err?.message || err));
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
    }
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

  return {
    applied: errors.length === 0,
    untrackedCopied,
    errors,
    seeded: Boolean(
      baseline.stagedPatch ||
        baseline.unstagedPatch ||
        (baseline.untracked && baseline.untracked.length),
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

  const head = run(["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  // Capture dirty baseline BEFORE worktree add (source tree state scout saw)
  let baseline = null;
  if (seedDirty) {
    baseline = captureDirtyBaseline(cwd);
    baseline.sourceCwd = resolve(cwd);
  }

  const add = run(["worktree", "add", "-b", branch, path, "HEAD"], cwd);
  if (!add.ok) {
    throw new Error(add.stderr || add.stdout || "git worktree add failed");
  }

  let seedResult = null;
  if (baseline?.dirty) {
    seedResult = seedWorktreeFromBaseline(baseline, path);
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
