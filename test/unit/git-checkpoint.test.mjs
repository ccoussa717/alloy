import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readlinkSync,
  symlinkSync,
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

  test("staged-only checkpoint restores the index without leaking store files", () => {
    const repo = initRepo("staged");
    writeFileSync(join(repo, "a.txt"), "v2-staged\n");
    run(repo, ["add", "a.txt"]);
    const cp = git.createCheckpoint("staged-only", repo);

    run(repo, ["reset", "--hard", "HEAD"]);
    git.restoreCheckpoint(cp.id, repo);

    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v2-staged\n");
    assert.equal(run(repo, ["show", ":a.txt"]).stdout, "v2-staged\n");
    assert.equal(run(repo, ["diff"]).stdout, "");
    assert.equal(run(repo, ["status", "--porcelain"]).stdout.trim(), "M  a.txt");
    assert.equal(existsSync(join(repo, "index.patch")), false);
    assert.equal(existsSync(join(repo, "worktree.patch")), false);
    assert.equal(existsSync(join(repo, "meta.json")), false);
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

  test("untracked paths with spaces restore exactly", () => {
    const repo = initRepo("untracked-space");
    writeFileSync(join(repo, "space file.bin"), "spaced-bytes\n");
    const cp = git.createCheckpoint("space-path", repo);

    assert.equal(cp.complete, true);
    assert.deepEqual(cp.untracked, ["space file.bin"]);
    rmSync(join(repo, "space file.bin"));
    git.restoreCheckpoint(cp.id, repo);
    assert.equal(
      readFileSync(join(repo, "space file.bin"), "utf8"),
      "spaced-bytes\n",
    );
  });

  test("untracked symlinks preserve their relative target", () => {
    const repo = initRepo("untracked-symlink");
    symlinkSync("a.txt", join(repo, "relative-link"));
    const cp = git.createCheckpoint("symlink", repo);

    rmSync(join(repo, "relative-link"));
    git.restoreCheckpoint(cp.id, repo);
    assert.equal(readlinkSync(join(repo, "relative-link")), "a.txt");
  });

  test("checkpoint creation fails closed when Git cannot capture tracked state", () => {
    const repo = initRepo("capture-failure");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const bin = join(tmp, "fake-checkpoint-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "stash" ] || [ "$1" = "diff" ]; then exit 71; fi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();

    process.env.REAL_GIT = realGit;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      assert.throws(
        () => git.createCheckpoint("capture-failure", repo),
        /capture|diff|stash/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
    }
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
