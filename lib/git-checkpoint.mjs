/**
 * Git checkpoint helpers for Alloy.
 * Uses git stash create (object in repo, no stack push) so we do not disturb the stash list.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { getAlloyHome } from "./paths.mjs";
import { projectIdFromCwd } from "./paths.mjs";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
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
  const r = run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return r.ok && r.stdout === "true";
}

function checkpointDir(cwd = process.cwd()) {
  const dir = join(getAlloyHome(), "checkpoints", projectIdFromCwd(cwd));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Create a recoverable checkpoint.
 * @returns {{ id: string, ref: string|null, head: string, label: string, path: string }}
 */
export function createCheckpoint(label = "", cwd = process.cwd()) {
  if (!isGitRepo(cwd)) {
    throw new Error("Not a git repository");
  }

  const head = run("git", ["rev-parse", "HEAD"], cwd);
  if (!head.ok) throw new Error(head.stderr || "Cannot read HEAD");

  const status = run("git", ["status", "--porcelain"], cwd);
  const stash = run("git", ["stash", "create"], cwd);
  // stash create returns empty if working tree clean
  const ref = stash.ok && stash.stdout ? stash.stdout : null;

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const meta = {
    id,
    label: label || `checkpoint ${new Date().toISOString()}`,
    created: new Date().toISOString(),
    head: head.stdout,
    ref,
    dirty: Boolean(status.stdout),
    statusPorcelain: status.stdout.split("\n").filter(Boolean).slice(0, 200),
    cwd,
  };

  const path = join(checkpointDir(cwd), `${id}.json`);
  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return { ...meta, path };
}

export function listCheckpoints(cwd = process.cwd()) {
  const dir = checkpointDir(cwd);
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

/**
 * Restore a checkpoint. Prefers stash ref when present; otherwise resets to HEAD snapshot only.
 * Destructive to working tree — caller must confirm.
 */
export function restoreCheckpoint(idOrPrefix, cwd = process.cwd()) {
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");
  const all = listCheckpoints(cwd);
  const match =
    all.find((c) => c.id === idOrPrefix) ||
    all.find((c) => c.id.startsWith(idOrPrefix));
  if (!match) throw new Error(`Checkpoint not found: ${idOrPrefix}`);

  if (match.ref) {
    // Apply the tree from the stash commit without using stash stack
    const show = run("git", ["stash", "apply", match.ref], cwd);
    if (!show.ok) {
      // Fallback: checkout files from the stash commit
      const co = run("git", ["checkout", match.ref, "--", "."], cwd);
      if (!co.ok) throw new Error(show.stderr || co.stderr || "Restore failed");
    }
  } else {
    // Clean tree checkpoint — restore tracked files to recorded HEAD
    const reset = run("git", ["reset", "--hard", match.head], cwd);
    if (!reset.ok) throw new Error(reset.stderr || "reset --hard failed");
    const clean = run("git", ["clean", "-fd"], cwd);
    if (!clean.ok) throw new Error(clean.stderr || "clean failed");
  }

  return match;
}
