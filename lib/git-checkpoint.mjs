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
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";

function run(cmd, args, cwd, { trim = true } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
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
  const copied = [];
  const failed = [];
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const rel of untracked) {
    const src = resolve(cwd, rel);
    // refuse path escape
    if (!src.startsWith(resolve(cwd))) {
      failed.push({ path: rel, error: "path_escape" });
      continue;
    }
    if (!existsSync(src)) {
      failed.push({ path: rel, error: "missing" });
      continue;
    }
    const dest = join(destDir, rel);
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
      copied.push(rel);
    } catch (err) {
      failed.push({ path: rel, error: String(err?.message || err) });
    }
  }
  return { copied, failed };
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

  const status = run("git", ["status", "--porcelain=v1", "-z"], cwd, {
    trim: false,
  });
  if (!status.ok) throw new Error(status.stderr || "Cannot read status");
  const { lines, untracked, trackedDirty } = parsePorcelain(status.stdout);

  // Tracked changes object (excludes untracked — git limitation)
  const stash = run("git", ["stash", "create"], cwd);
  if (!stash.ok) throw new Error(stash.stderr || "Cannot capture Git stash");
  const ref = stash.ok && stash.stdout ? stash.stdout : null;

  // Diffs for verification / partial recovery
  const diff = run("git", ["diff", "--binary"], cwd, { trim: false });
  const diffCached = run("git", ["diff", "--cached", "--binary"], cwd, {
    trim: false,
  });
  if (!diff.ok) throw new Error(diff.stderr || "Cannot capture worktree diff");
  if (!diffCached.ok) {
    throw new Error(diffCached.stderr || "Cannot capture index diff");
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
  };

  const path = join(base, "meta.json");
  writeFileSync(path, JSON.stringify(meta, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // Also index entry at root for listCheckpoints compatibility
  writeFileSync(join(checkpointRoot(cwd), `${id}.json`), JSON.stringify(meta, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  if (!complete) {
    meta.warning = "Checkpoint incomplete — some untracked paths failed to copy";
  }
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

function restoreUntrackedFiles(match, cwd) {
  const base = match.storeDir || join(checkpointRoot(cwd), match.id);
  const untrackedDir = join(base, "untracked");
  if (!existsSync(untrackedDir)) return { restored: [], skipped: [] };
  const restored = [];
  const skipped = [];
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? join(prefix, name) : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, rel);
      else {
        const dest = resolve(cwd, rel);
        if (!dest.startsWith(resolve(cwd))) {
          skipped.push(rel);
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        if (st.isSymbolicLink()) {
          rmSync(dest, { recursive: true, force: true });
          symlinkSync(readlinkSync(full), dest);
        } else {
          cpSync(full, dest, { verbatimSymlinks: true });
        }
        restored.push(rel);
      }
    }
  };
  walk(untrackedDir);
  return { restored, skipped };
}

/**
 * Restore a checkpoint.
 * @param {string} idOrPrefix
 * @param {string} [cwd]
 * @param {{ allowClean?: boolean }} [opts] — allowClean is rejected unless explicitly true AND complete untracked manifest; still defaults false
 */
export function restoreCheckpoint(idOrPrefix, cwd = process.cwd(), opts = {}) {
  if (!isGitRepo(cwd)) throw new Error("Not a git repository");
  const all = listCheckpoints(cwd);
  const match =
    all.find((c) => c.id === idOrPrefix) ||
    all.find((c) => c.id.startsWith(idOrPrefix));
  if (!match) throw new Error(`Checkpoint not found: ${idOrPrefix}`);

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
    const base = match.storeDir || join(checkpointRoot(cwd), match.id);
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
  const u = restoreUntrackedFiles(match, cwd);

  // 3) Optional clean — only if explicitly requested AND we refuse by default
  if (opts.allowClean) {
    throw new Error(
      "git clean during restore is disabled in Alloy P0.4 (would delete untracked work). Restore untracked from checkpoint store instead.",
    );
  }

  return { ...match, untrackedRestored: u.restored, untrackedSkipped: u.skipped };
}

/** Remove checkpoint store (optional cleanup helper) */
export function deleteCheckpoint(id, cwd = process.cwd()) {
  const all = listCheckpoints(cwd);
  const match = all.find((c) => c.id === id);
  if (!match) return false;
  const base = match.storeDir || join(checkpointRoot(cwd), match.id);
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
  return true;
}
