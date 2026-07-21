/**
 * Git worktree helpers for Alloy parallel/isolated writers.
 * Worktrees live under ~/.pi/alloy/worktrees/<project-id>/
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
import { join } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";

function run(args, cwd) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
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
 * Create an isolated worktree + branch for a task/role.
 * @returns {{ id: string, path: string, branch: string }}
 */
export function createWorktree({ taskId, role = "builder", cwd = process.cwd() } = {}) {
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");

  const id = `${role}-${(taskId || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
  const branch = `alloy/${id}`;
  const path = join(worktreeRoot(cwd), id);

  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path}`);
  }

  // Branch from current HEAD
  const head = run(["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  // Prefer worktree add -b; if branch exists, fail clearly
  const add = run(["worktree", "add", "-b", branch, path, "HEAD"], cwd);
  if (!add.ok) {
    throw new Error(add.stderr || add.stdout || "git worktree add failed");
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
  };
  meta.worktrees = [...(meta.worktrees || []).filter((w) => w.id !== id), entry];
  saveMeta(meta, cwd);
  return entry;
}

export function listWorktrees(cwd = process.cwd()) {
  const meta = loadMeta(cwd);
  // Reconcile with git worktree list
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
    // Fallback: force remove directory + prune
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
  return {
    id: entry.id,
    path: entry.path,
    branch: entry.branch,
    stat: stat.stdout,
    diff: diff.stdout,
  };
}
