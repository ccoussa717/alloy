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

  test("seeds a staged-only baseline into both index and worktree", () => {
    const repo = initRepo("staged-only");
    writeFileSync(join(repo, "f.txt"), "staged\n");
    git(repo, ["add", "f.txt"]);

    const created = wt.createWorktree({
      taskId: "staged1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.equal(created.seed.applied, true);
    assert.deepEqual(created.seed.errors, []);
    assert.equal(readFileSync(join(created.path, "f.txt"), "utf8"), "staged\n");
    assert.equal(git(created.path, ["show", ":f.txt"]).stdout, "staged\n");
    assert.equal(
      git(created.path, ["status", "--porcelain"]).stdout.trim(),
      "M  f.txt",
    );

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("seeds a combined staged and unstaged baseline exactly", () => {
    const repo = initRepo("combined");
    writeFileSync(join(repo, "f.txt"), "staged\n");
    git(repo, ["add", "f.txt"]);
    writeFileSync(join(repo, "f.txt"), "unstaged\n");

    const created = wt.createWorktree({
      taskId: "combined1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.equal(created.seed.applied, true);
    assert.deepEqual(created.seed.errors, []);
    assert.equal(readFileSync(join(created.path, "f.txt"), "utf8"), "unstaged\n");
    assert.equal(git(created.path, ["show", ":f.txt"]).stdout, "staged\n");
    assert.equal(
      git(created.path, ["status", "--porcelain"]).stdout.trim(),
      "MM f.txt",
    );

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("seeds staged binary content exactly", () => {
    const repo = initRepo("binary");
    const binary = Buffer.from([0, 1, 2, 3, 255]);
    writeFileSync(join(repo, "f.txt"), binary);
    git(repo, ["add", "f.txt"]);

    const created = wt.createWorktree({
      taskId: "binary1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.deepEqual(readFileSync(join(created.path, "f.txt")), binary);
    assert.equal(
      git(created.path, ["status", "--porcelain"]).stdout.trim(),
      "M  f.txt",
    );

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("seeds spaced untracked paths and preserves relative symlinks", () => {
    const repo = initRepo("untracked-special");
    writeFileSync(join(repo, "space file.txt"), "spaced\n");
    symlinkSync("f.txt", join(repo, "relative-link"));

    const created = wt.createWorktree({
      taskId: "special1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.equal(
      readFileSync(join(created.path, "space file.txt"), "utf8"),
      "spaced\n",
    );
    assert.equal(readlinkSync(join(created.path, "relative-link")), "f.txt");

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("does not overwrite a tracked patch-name collision while seeding", () => {
    const repo = initRepo("patch-collision");
    writeFileSync(join(repo, ".alloy-staged.patch"), "tracked-content\n");
    git(repo, ["add", ".alloy-staged.patch"]);
    git(repo, ["commit", "-m", "track patch name"]);
    writeFileSync(join(repo, "f.txt"), "staged\n");
    git(repo, ["add", "f.txt"]);

    const created = wt.createWorktree({
      taskId: "collision1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.equal(
      readFileSync(join(created.path, ".alloy-staged.patch"), "utf8"),
      "tracked-content\n",
    );
    assert.equal(
      git(created.path, ["status", "--porcelain"]).stdout.trim(),
      "M  f.txt",
    );

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("capture fails closed when git cannot produce a dirty diff", () => {
    const repo = initRepo("diff-failure");
    writeFileSync(join(repo, "f.txt"), "dirty\n");
    const bin = join(tmp, "fake-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "diff" ]; then exit 71; fi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();

    process.env.REAL_GIT = realGit;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      assert.throws(() => wt.captureDirtyBaseline(repo), /diff/i);
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
    }
  });

  test("does not three-way an unstaged patch into the target index", () => {
    const repo = initRepo("unstaged-divergence");
    writeFileSync(join(repo, "f.txt"), "line-one\nline-two\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-m", "multiline base"]);
    writeFileSync(join(repo, "f.txt"), "dirty-one\nline-two\n");
    const baseline = wt.captureDirtyBaseline(repo);

    const created = wt.createWorktree({
      taskId: "diverged1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    writeFileSync(join(created.path, "f.txt"), "line-one\ndiverged-two\n");
    git(created.path, ["add", "f.txt"]);
    git(created.path, ["commit", "-m", "diverge target"]);

    try {
      const result = wt.seedWorktreeFromBaseline(baseline, created.path);
      assert.equal(result.applied, false);
      assert.match(result.errors.join("\n"), /unstaged patch/i);
      assert.equal(git(created.path, ["diff", "--cached"]).stdout, "");
    } finally {
      git(created.path, ["reset", "--hard", "HEAD"]);
      wt.removeWorktree(created.id, { cwd: repo });
    }
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

  test("fails closed and removes the worktree when dirty seeding fails", () => {
    const repo = initRepo("failed-seed");
    symlinkSync("missing-target", join(repo, "dangling-link"));

    let created = null;
    let error = null;
    try {
      created = wt.createWorktree({
        taskId: "failed1",
        role: "builder",
        cwd: repo,
        seedDirty: true,
      });
    } catch (err) {
      error = err;
    } finally {
      if (created) wt.removeWorktree(created.id, { cwd: repo });
    }

    assert.match(String(error?.message || ""), /failed to seed dirty baseline/i);
    assert.equal(
      git(repo, ["branch", "--list", "alloy/builder-failed1"]).stdout.trim(),
      "",
    );
  });

  test("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
