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

const tmp = mkdtempSync(join(tmpdir(), "alloy-git-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const git = await import(
  pathToFileURL(
    join(new URL("../..", import.meta.url).pathname, "lib", "git-checkpoint.mjs"),
  ).href
);

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(name) {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  run(repo, ["init"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  run(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.txt"), "v1\n");
  run(repo, ["add", "a.txt"]);
  run(repo, ["commit", "-m", "init"]);
  return repo;
}

describe("P0.4 safe checkpoints", () => {
  test("checkpoint and restore dirty tracked tree", () => {
    const repo = initRepo("tracked");
    writeFileSync(join(repo, "a.txt"), "v2-dirty\n");
    const cp = git.createCheckpoint("before-mess", repo);
    assert.ok(cp.id);
    assert.ok(cp.ref || cp.dirty);

    writeFileSync(join(repo, "a.txt"), "v3-worse\n");
    git.restoreCheckpoint(cp.id, repo);
    const body = readFileSync(join(repo, "a.txt"), "utf8");
    assert.match(body, /v2-dirty/);
  });

  test("untracked files survive checkpoint round-trip (byte-for-byte)", () => {
    const repo = initRepo("untracked");
    writeFileSync(join(repo, "untracked.txt"), "secret-untracked-bytes\n");
    const cp = git.createCheckpoint("with-untracked", repo);
    assert.equal(cp.includesUntracked, true);
    assert.ok(cp.untracked.includes("untracked.txt"));
    assert.equal(cp.restoreUsesClean, false);

    // Destroy untracked and dirty the tree
    rmSync(join(repo, "untracked.txt"));
    writeFileSync(join(repo, "a.txt"), "changed\n");
    assert.equal(existsSync(join(repo, "untracked.txt")), false);

    git.restoreCheckpoint(cp.id, repo);
    assert.ok(existsSync(join(repo, "untracked.txt")));
    assert.equal(
      readFileSync(join(repo, "untracked.txt"), "utf8"),
      "secret-untracked-bytes\n",
    );
  });

  test("restore never git cleans new untracked files", () => {
    const repo = initRepo("no-clean");
    const cp = git.createCheckpoint("clean-base", repo);
    // After checkpoint, create new untracked work
    writeFileSync(join(repo, "precious.txt"), "do-not-delete\n");
    git.restoreCheckpoint(cp.id, repo);
    // precious must still exist — old code ran git clean -fd and would remove it
    assert.ok(existsSync(join(repo, "precious.txt")));
    assert.equal(readFileSync(join(repo, "precious.txt"), "utf8"), "do-not-delete\n");
  });

  test("allowClean is rejected", () => {
    const repo = initRepo("allow-clean");
    const cp = git.createCheckpoint("x", repo);
    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo, { allowClean: true }),
      /disabled|clean/i,
    );
  });

  test("parsePorcelain classifies untracked", () => {
    const p = git.parsePorcelain(" M a.txt\n?? untracked.txt\n");
    assert.deepEqual(p.untracked, ["untracked.txt"]);
    assert.ok(p.trackedDirty.includes("a.txt"));
  });

  test("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
