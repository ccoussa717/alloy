import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-wt-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const wt = await import(
  pathToFileURL(
    join(new URL("../..", import.meta.url).pathname, "lib", "worktree.mjs"),
  ).href
);

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(name) {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

describe("worktrees", () => {
  test("create list diff remove worktree", () => {
    const repo = initRepo("basic");
    const created = wt.createWorktree({
      taskId: "t1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    assert.ok(created.path);
    assert.ok(existsSync(created.path));
    assert.ok(created.branch.startsWith("alloy/"));

    const list = wt.listWorktrees(repo);
    assert.ok(list.some((w) => w.id === created.id));

    writeFileSync(join(created.path, "f.txt"), "two\n");
    const diff = wt.worktreeDiff(created.id, repo);
    assert.match(diff.diff || diff.stat || "", /two|f\.txt|1 file|changed/i);

    const removed = wt.removeWorktree(created.id, { cwd: repo });
    assert.equal(removed.id, created.id);
    assert.equal(wt.listWorktrees(repo).length, 0);
  });

  test("seeds dirty tracked + untracked baseline into worktree", () => {
    const repo = initRepo("dirty");
    // Dirty tracked
    writeFileSync(join(repo, "f.txt"), "dirty-main\n");
    // Untracked
    writeFileSync(join(repo, "scratch.txt"), "untracked-bytes\n");

    const baseline = wt.captureDirtyBaseline(repo);
    assert.equal(baseline.dirty, true);
    assert.ok(baseline.untracked.includes("scratch.txt"));
    assert.ok(baseline.unstagedPatch.includes("dirty-main") || baseline.unstagedPatch.length > 0);

    const created = wt.createWorktree({
      taskId: "seed1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });
    assert.equal(created.seededDirty, true);
    // Worktree should see the same dirty content
    assert.equal(
      readFileSync(join(created.path, "f.txt"), "utf8"),
      "dirty-main\n",
    );
    assert.ok(existsSync(join(created.path, "scratch.txt")));
    assert.equal(
      readFileSync(join(created.path, "scratch.txt"), "utf8"),
      "untracked-bytes\n",
    );

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("seedDirty false stays at clean HEAD", () => {
    const repo = initRepo("clean-seed");
    writeFileSync(join(repo, "f.txt"), "dirty\n");
    writeFileSync(join(repo, "u.txt"), "u\n");
    const created = wt.createWorktree({
      taskId: "n1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    assert.equal(readFileSync(join(created.path, "f.txt"), "utf8"), "one\n");
    assert.equal(existsSync(join(created.path, "u.txt")), false);
    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
