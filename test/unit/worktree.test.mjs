import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-wt-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const wt = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "worktree.mjs")).href
);

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

test("create list diff remove worktree", () => {
  const repo = join(tmp, "repo");
  spawnSync("mkdir", ["-p", repo]);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-m", "init"]);

  const created = wt.createWorktree({ taskId: "t1", role: "builder", cwd: repo });
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

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
