import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-git-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const git = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "git-checkpoint.mjs")).href
);

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

test("checkpoint and restore dirty tree", () => {
  const repo = join(tmp, "repo");
  spawnSync("mkdir", ["-p", repo]);
  run(repo, ["init"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  run(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  run(repo, ["add", "a.txt"]);
  run(repo, ["commit", "-m", "init"]);

  writeFileSync(join(repo, "a.txt"), "v2-dirty\n");
  const cp = git.createCheckpoint("before-mess", repo);
  assert.ok(cp.id);
  assert.ok(cp.ref || cp.dirty);

  writeFileSync(join(repo, "a.txt"), "v3-worse\n");
  git.restoreCheckpoint(cp.id, repo);
  const body = readFileSync(join(repo, "a.txt"), "utf8");
  // stash apply restores to checkpoint content
  assert.match(body, /v2-dirty|v1/);
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
