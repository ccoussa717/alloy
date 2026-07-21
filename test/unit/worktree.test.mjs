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
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function rawGit(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).stdout;
}

function observableState(cwd) {
  return {
    status: rawGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    index: rawGit(cwd, ["ls-files", "--stage", "-z"]),
    staged: rawGit(cwd, ["diff", "--cached", "--binary"]),
    unstaged: rawGit(cwd, ["diff", "--binary"]),
  };
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

function rewriteWorktreeMeta(created, update) {
  const path = join(dirname(created.path), "index.json");
  const original = readFileSync(path, "utf8");
  const metadata = JSON.parse(original);
  metadata.worktrees = metadata.worktrees.map((entry) =>
    entry.id === created.id ? update(entry) : entry,
  );
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  return { path, original };
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
    assert.notEqual(git(repo, ["show-ref", "--verify", `refs/heads/${created.branch}`]).status, 0);
  });

  test("subdirectory create list diff and remove share repository-root authority", () => {
    const repo = initRepo("subdirectory-authority");
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "tracked.txt"), "tracked base\n");
    git(repo, ["add", "sub/tracked.txt"]);
    git(repo, ["commit", "-m", "add subdirectory"]);
    writeFileSync(join(repo, "f.txt"), "dirty root tracked\n");
    writeFileSync(join(repo, "root-untracked.txt"), "root payload\n");
    writeFileSync(join(sub, "nested-untracked.txt"), "nested payload\n");

    const baseline = wt.captureDirtyBaseline(sub);
    assert.equal(baseline.cwd, resolve(sub));
    assert.equal(baseline.repoRoot, resolve(repo));
    assert.equal(baseline.sourceCwd, resolve(repo));

    const created = wt.createWorktree({
      taskId: "subdir1",
      role: "builder",
      cwd: sub,
      seedDirty: true,
    });

    try {
      assert.equal(created.seed.applied, true);
      assert.equal(created.cwd, resolve(sub));
      assert.equal(created.repoRoot, resolve(repo));
      assert.equal(readFileSync(join(created.path, "f.txt"), "utf8"), "dirty root tracked\n");
      assert.equal(
        readFileSync(join(created.path, "root-untracked.txt"), "utf8"),
        "root payload\n",
      );
      assert.equal(
        readFileSync(join(created.path, "sub", "nested-untracked.txt"), "utf8"),
        "nested payload\n",
      );
      assert.ok(wt.listWorktrees(repo).some((entry) => entry.id === created.id));
      assert.ok(wt.listWorktrees(sub).some((entry) => entry.id === created.id));
      const diff = wt.worktreeDiff(created.id, sub);
      assert.match(diff.diff || diff.stat, /f\.txt|dirty root tracked/i);
    } finally {
      wt.removeWorktree(created.id, { cwd: sub });
    }

    assert.equal(wt.listWorktrees(repo).length, 0);
  });

  test("create rejects a role-derived path outside the managed worktree root", () => {
    const repo = initRepo("create-path-escape");

    assert.throws(
      () =>
        wt.createWorktree({
          taskId: "escape1",
          role: "../victim",
          cwd: repo,
          seedDirty: false,
        }),
      /invalid worktree role or path/i,
    );
  });

  test("remove rejects an external metadata path and preserves the victim", () => {
    const repo = initRepo("remove-external-victim");
    const created = wt.createWorktree({
      taskId: "external1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    const victim = join(tmp, "external-worktree-victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "sentinel.txt"), "preserve me\n");
    const metadata = rewriteWorktreeMeta(created, (entry) => ({
      ...entry,
      path: victim,
    }));

    try {
      assert.throws(
        () => wt.removeWorktree(created.id, { cwd: repo }),
        /contain|outside|metadata|registered|path/i,
      );
      assert.equal(readFileSync(join(victim, "sentinel.txt"), "utf8"), "preserve me\n");
      assert.equal(existsSync(created.path), true);
    } finally {
      writeFileSync(metadata.path, metadata.original);
      if (existsSync(created.path)) wt.removeWorktree(created.id, { cwd: repo });
      rmSync(victim, { recursive: true, force: true });
    }
  });

  test("remove rejects an inside-root unregistered path and preserves it", () => {
    const repo = initRepo("remove-unregistered-victim");
    const created = wt.createWorktree({
      taskId: "unregistered1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    assert.equal(git(repo, ["worktree", "remove", "--force", created.path]).status, 0);
    mkdirSync(created.path);
    writeFileSync(join(created.path, "sentinel.txt"), "preserve me\n");

    try {
      assert.throws(
        () => wt.removeWorktree(created.id, { cwd: repo }),
        /metadata|registered|worktree|path/i,
      );
      assert.equal(readFileSync(join(created.path, "sentinel.txt"), "utf8"), "preserve me\n");
      assert.equal(git(repo, ["show-ref", "--verify", `refs/heads/${created.branch}`]).status, 0);
    } finally {
      rmSync(created.path, { recursive: true, force: true });
      git(repo, ["branch", "-D", created.branch]);
    }
  });

  test("remove forgets an already absent and pruned worktree without deleting its branch", () => {
    const repo = initRepo("remove-already-absent");
    const created = wt.createWorktree({
      taskId: "absent1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    assert.equal(git(repo, ["worktree", "remove", "--force", created.path]).status, 0);

    const removed = wt.removeWorktree(created.id, { cwd: repo });

    assert.equal(removed.id, created.id);
    assert.equal(wt.listWorktrees(repo).some((entry) => entry.id === created.id), false);
    assert.equal(git(repo, ["show-ref", "--verify", `refs/heads/${created.branch}`]).status, 0);
    git(repo, ["branch", "-D", created.branch]);
  });

  test("remove rejects a branch mismatch without deleting worktree or branches", () => {
    const repo = initRepo("remove-branch-mismatch");
    const created = wt.createWorktree({
      taskId: "branch-mismatch1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    git(repo, ["branch", "metadata-victim", "HEAD"]);
    const metadata = rewriteWorktreeMeta(created, (entry) => ({
      ...entry,
      branch: "metadata-victim",
    }));

    try {
      assert.throws(
        () => wt.removeWorktree(created.id, { cwd: repo }),
        /branch|metadata|registered|mismatch/i,
      );
      assert.equal(existsSync(created.path), true);
      assert.equal(git(repo, ["show-ref", "--verify", "refs/heads/metadata-victim"]).status, 0);
      assert.equal(git(repo, ["show-ref", "--verify", `refs/heads/${created.branch}`]).status, 0);
    } finally {
      if (existsSync(created.path)) {
        writeFileSync(metadata.path, metadata.original);
        wt.removeWorktree(created.id, { cwd: repo });
      } else {
        git(repo, ["branch", "-D", created.branch]);
      }
      git(repo, ["branch", "-D", "metadata-victim"]);
    }
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

  test("seeds special untracked modes independently of process umask", (t) => {
    const repo = initRepo("untracked-special-modes");
    const expected = new Map([
      ["setuid.sh", 0o4755],
      ["setgid-sticky.sh", 0o3755],
    ]);
    for (const [name, mode] of expected) {
      writeFileSync(join(repo, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(repo, name), mode);
      if ((lstatSync(join(repo, name)).mode & 0o7777) !== mode) {
        t.skip(`filesystem strips mode ${mode.toString(8)}`);
        return;
      }
    }
    const oldUmask = process.umask(0o077);
    let created;

    try {
      created = wt.createWorktree({
        taskId: "special-modes1",
        role: "builder",
        cwd: repo,
        seedDirty: true,
      });
    } finally {
      process.umask(oldUmask);
    }

    try {
      assert.equal(created.seed.applied, true);
      for (const [name, mode] of expected) {
        assert.equal(lstatSync(join(created.path, name)).mode & 0o7777, mode);
      }
    } finally {
      wt.removeWorktree(created.id, { cwd: repo });
    }
  });

  test("copies only Git-enumerated files from an untracked directory", () => {
    const repo = initRepo("untracked-enumerated");
    writeFileSync(join(repo, ".gitignore"), "scratch/ignored.key\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-m", "ignore nested secret"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "visible.txt"), "visible\n");
    writeFileSync(join(repo, "scratch", "ignored.key"), "credential\n");

    const baseline = wt.captureDirtyBaseline(repo);
    const created = wt.createWorktree({
      taskId: "enumerated1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.deepEqual(baseline.untracked, ["scratch/visible.txt"]);
    assert.equal(readFileSync(join(created.path, "scratch", "visible.txt"), "utf8"), "visible\n");
    assert.equal(existsSync(join(created.path, "scratch", "ignored.key")), false);

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("reproduces intent-to-add and exact NUL-delimited Git state", () => {
    const repo = initRepo("intent-to-add");
    writeFileSync(join(repo, "intent.txt"), "intent bytes\n");
    git(repo, ["add", "-N", "--", "intent.txt"]);
    writeFileSync(join(repo, "scratch.txt"), "untracked bytes\n");
    const expected = observableState(repo);

    const created = wt.createWorktree({
      taskId: "intent1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });

    assert.equal(created.seed.applied, true);
    assert.deepEqual(observableState(created.path), expected);

    wt.removeWorktree(created.id, { cwd: repo });
  });

  test("fails seeding when enumerated untracked bytes changed after capture", () => {
    const repo = initRepo("untracked-race");
    writeFileSync(join(repo, "scratch.txt"), "captured bytes\n");
    const baseline = wt.captureDirtyBaseline(repo);
    baseline.sourceCwd = repo;
    const created = wt.createWorktree({
      taskId: "race1",
      role: "builder",
      cwd: repo,
      seedDirty: false,
    });
    writeFileSync(join(repo, "scratch.txt"), "changed bytes\n");

    try {
      const result = wt.seedWorktreeFromBaseline(baseline, created.path);
      assert.equal(result.applied, false);
      assert.match(result.errors.join("\n"), /untracked.*mismatch/i);
    } finally {
      wt.removeWorktree(created.id, { cwd: repo });
    }
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

  test("seeds dangling untracked symlinks with byte-exact targets", () => {
    const repo = initRepo("dangling-symlink");
    symlinkSync("missing-target", join(repo, "dangling-link"));

    const created = wt.createWorktree({
      taskId: "dangling1",
      role: "builder",
      cwd: repo,
      seedDirty: true,
    });
    try {
      assert.equal(created.seed.applied, true);
      assert.equal(lstatSync(join(created.path, "dangling-link")).isSymbolicLink(), true);
      assert.equal(readlinkSync(join(created.path, "dangling-link")), "missing-target");
    } finally {
      wt.removeWorktree(created.id, { cwd: repo });
    }
  });

  test("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
