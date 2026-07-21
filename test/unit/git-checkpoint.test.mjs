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

const tmp = mkdtempSync(join(tmpdir(), "alloy-git-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const git = await import(
  pathToFileURL(
    join(new URL("../..", import.meta.url).pathname, "lib", "git-checkpoint.mjs"),
  ).href
);
const { projectIdFromCwd } = await import(
  pathToFileURL(
    join(new URL("../..", import.meta.url).pathname, "lib", "paths.mjs"),
  ).href
);

function run(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function raw(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).stdout;
}

function snapshot(repo, paths = []) {
  const indexPath = run(repo, ["rev-parse", "--git-path", "index"]).stdout.trim();
  return {
    status: raw(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    index: readFileSync(resolve(repo, indexPath)),
    files: paths.map((path) => readFileSync(join(repo, path))),
  };
}

function observableGitState(repo) {
  return {
    status: raw(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    index: raw(repo, ["ls-files", "--stage", "-z"]),
    staged: raw(repo, ["diff", "--cached", "--binary"]),
    unstaged: raw(repo, ["diff", "--binary"]),
  };
}

function overwriteMetadata(cp, update) {
  const metadata = update(JSON.parse(readFileSync(cp.path, "utf8")));
  const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);
  for (const path of [cp.path, rootPath]) {
    writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

function checkpointArtifactPaths(repo, id) {
  const root = checkpointRootPath(repo);
  return [join(root, id), join(root, `${id}.json`)];
}

function checkpointRootPath(repo) {
  return join(
    process.env.ALLOY_HOME,
    "checkpoints",
    projectIdFromCwd(repo),
  );
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

  test("copies only Git-enumerated files from an untracked directory", () => {
    const repo = initRepo("untracked-enumerated");
    writeFileSync(join(repo, ".gitignore"), "scratch/ignored.key\n");
    run(repo, ["add", ".gitignore"]);
    run(repo, ["commit", "-m", "ignore nested secret"]);
    mkdirSync(join(repo, "scratch"));
    writeFileSync(join(repo, "scratch", "visible.txt"), "visible\n");
    writeFileSync(join(repo, "scratch", "ignored.key"), "credential\n");

    const cp = git.createCheckpoint("enumerated-only", repo);

    assert.deepEqual(cp.untracked, ["scratch/visible.txt"]);
    assert.equal(
      existsSync(join(cp.storeDir, "untracked", "scratch", "ignored.key")),
      false,
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

  test("dangling untracked symlinks restore byte-exact targets", () => {
    const repo = initRepo("dangling-untracked-symlink");
    symlinkSync("missing target with spaces", join(repo, "dangling-link"));
    const cp = git.createCheckpoint("dangling-symlink", repo);

    assert.equal(cp.complete, true);
    rmSync(join(repo, "dangling-link"));
    git.restoreCheckpoint(cp.id, repo);

    assert.equal(lstatSync(join(repo, "dangling-link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(repo, "dangling-link")), "missing target with spaces");
  });

  test("refuses an existing untracked destination without mutating current state", () => {
    const repo = initRepo("restore-collision");
    writeFileSync(join(repo, "collision.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("collision", repo);
    rmSync(join(repo, "collision.txt"));
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    writeFileSync(join(repo, "collision.txt"), "newer bytes\n");
    const before = snapshot(repo, ["a.txt", "collision.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /collision|exists/i);
    assert.deepEqual(snapshot(repo, ["a.txt", "collision.txt"]), before);
  });

  test("refuses tracked restore paths that would overwrite current untracked data", () => {
    const repo = initRepo("tracked-untracked-collision");
    writeFileSync(join(repo, "owned-at-checkpoint.txt"), "tracked checkpoint bytes\n");
    run(repo, ["add", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "track collision path"]);
    const cp = git.createCheckpoint("tracked-collision", repo);
    run(repo, ["rm", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "remove collision path"]);
    writeFileSync(join(repo, "owned-at-checkpoint.txt"), "new untracked bytes\n");
    const before = snapshot(repo, ["owned-at-checkpoint.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /collision|untracked/i);
    assert.deepEqual(snapshot(repo, ["owned-at-checkpoint.txt"]), before);
  });

  test("refuses tracked restore paths that would overwrite current ignored data", () => {
    const repo = initRepo("tracked-ignored-collision");
    writeFileSync(join(repo, ".gitignore"), "owned-at-checkpoint.txt\n");
    writeFileSync(join(repo, "owned-at-checkpoint.txt"), "tracked checkpoint bytes\n");
    run(repo, ["add", ".gitignore"]);
    run(repo, ["add", "-f", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "track ignored collision path"]);
    const cp = git.createCheckpoint("ignored-collision", repo);
    run(repo, ["rm", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "remove ignored collision path"]);
    writeFileSync(join(repo, "owned-at-checkpoint.txt"), "new ignored bytes\n");
    const before = snapshot(repo, ["owned-at-checkpoint.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /collision|ignored/i);
    assert.deepEqual(snapshot(repo, ["owned-at-checkpoint.txt"]), before);
  });

  test("refuses a symlink destination ancestor without writing outside the repo", () => {
    const repo = initRepo("restore-ancestor-symlink");
    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, "nested", "value.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("ancestor-symlink", repo);
    rmSync(join(repo, "nested"), { recursive: true });
    const outside = join(tmp, "outside-restore");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, "nested"));
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /symlink|ancestor/i);
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(existsSync(join(outside, "value.txt")), false);
  });

  test("anchored tracked state survives reflog expiry and prune", () => {
    const repo = initRepo("durable-stash");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("durable", repo);
    run(repo, ["reflog", "expire", "--expire=now", "--all"]);
    run(repo, ["gc", "--prune=now"]);
    run(repo, ["reset", "--hard", "HEAD"]);

    git.restoreCheckpoint(cp.id, repo);

    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "checkpoint dirty bytes\n");
  });

  test("invalid checkpoint refs fail before mutating current state", () => {
    const repo = initRepo("invalid-ref-atomic");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("invalid-ref", repo);
    overwriteMetadata(cp, (metadata) => ({
      ...metadata,
      ref: "refs/alloy/checkpoints/does-not-exist",
    }));
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    writeFileSync(join(repo, "current.txt"), "current untracked bytes\n");
    const before = snapshot(repo, ["a.txt", "current.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /invalid|reference|object/i);
    assert.deepEqual(snapshot(repo, ["a.txt", "current.txt"]), before);
  });

  test("invalid fallback patches fail before mutating current state", () => {
    const repo = initRepo("invalid-patch-atomic");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("invalid-patch", repo);
    overwriteMetadata(cp, (metadata) => ({ ...metadata, ref: null }));
    writeFileSync(join(cp.storeDir, "worktree.patch"), "not a patch\n");
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(() => git.restoreCheckpoint(cp.id, repo), /patch|apply/i);
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects tracked and index changes made during preflight", () => {
    const repo = initRepo("restore-concurrent-change");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("concurrent-change", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    const bin = join(tmp, "fake-concurrent-restore-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "stash" ] && [ "$2" = "apply" ] && [ -n "$GIT_INDEX_FILE" ]; then\n  printf \'concurrent bytes\\n\' > "$TEST_REPO/a.txt"\n  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE "$REAL_GIT" -C "$TEST_REPO" add a.txt\nfi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();

    process.env.REAL_GIT = realGit;
    process.env.TEST_REPO = repo;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      assert.throws(
        () => git.restoreCheckpoint(cp.id, repo),
        /changed|concurrent|preflight/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
      delete process.env.TEST_REPO;
    }

    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "concurrent bytes\n");
    assert.equal(run(repo, ["show", ":a.txt"]).stdout, "concurrent bytes\n");
    assert.equal(run(repo, ["status", "--porcelain"]).stdout.trim(), "M  a.txt");
  });

  test("restore preflights destination writability before tracked mutation", () => {
    const repo = initRepo("restore-unwritable-parent");
    mkdirSync(join(repo, "locked"));
    writeFileSync(join(repo, "locked", "value.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("unwritable-parent", repo);
    rmSync(join(repo, "locked", "value.txt"));
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    chmodSync(join(repo, "locked"), 0o500);

    try {
      assert.throws(
        () => git.restoreCheckpoint(cp.id, repo),
        /writ|EACCES|permission/i,
      );
      assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    } finally {
      chmodSync(join(repo, "locked"), 0o700);
    }
  });

  test("checkpoint round-trips intent-to-add state exactly", () => {
    const repo = initRepo("checkpoint-intent-to-add");
    writeFileSync(join(repo, "intent.txt"), "intent bytes\n");
    run(repo, ["add", "-N", "--", "intent.txt"]);
    const expected = observableGitState(repo);

    const cp = git.createCheckpoint("intent-to-add", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    rmSync(join(repo, "intent.txt"), { force: true });
    git.restoreCheckpoint(cp.id, repo);

    assert.deepEqual(observableGitState(repo), expected);
  });

  test("root index collision preserves pre-existing bytes and cleans owned state", () => {
    const repo = initRepo("root-index-collision");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const fixedNow = 1_700_000_000_000;
    const fixedRandom = 0.123456789;
    const id = `${fixedNow.toString(36)}-${fixedRandom.toString(36).slice(2, 7)}`;
    const root = checkpointRootPath(repo);
    const indexPath = join(root, `${id}.json`);
    mkdirSync(root, { recursive: true });
    writeFileSync(indexPath, "pre-existing index bytes\n");
    const oldNow = Date.now;
    const oldRandom = Math.random;
    let error = null;

    Date.now = () => fixedNow;
    Math.random = () => fixedRandom;
    try {
      git.createCheckpoint("index-collision", repo);
    } catch (err) {
      error = err;
    } finally {
      Date.now = oldNow;
      Math.random = oldRandom;
    }

    assert.ok(error);
    assert.equal(readFileSync(indexPath, "utf8"), "pre-existing index bytes\n");
    assert.equal(existsSync(join(root, id)), false);
    assert.equal(
      run(repo, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/alloy/checkpoints/${id}`,
      ]).stdout.trim(),
      "",
    );
  });

  test("regular untracked modes restore independently of process umask", () => {
    const repo = initRepo("restore-untracked-mode");
    writeFileSync(join(repo, "executable.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, "executable.sh"), 0o777);
    const cp = git.createCheckpoint("untracked-mode", repo);
    rmSync(join(repo, "executable.sh"));
    const oldUmask = process.umask(0o077);

    try {
      git.restoreCheckpoint(cp.id, repo);
    } finally {
      process.umask(oldUmask);
    }

    assert.equal(lstatSync(join(repo, "executable.sh")).mode & 0o777, 0o777);
  });

  test("exact checkpoint ID wins and ambiguous prefixes fail without mutation", () => {
    const repo = initRepo("ambiguous-prefix");
    const cp = git.createCheckpoint("prefix-base", repo);
    const metadata = JSON.parse(readFileSync(cp.path, "utf8"));
    const otherId = `${cp.id}-other`;
    writeFileSync(
      join(checkpointRootPath(repo), `${otherId}.json`),
      `${JSON.stringify({ ...metadata, id: otherId }, null, 2)}\n`,
    );

    writeFileSync(join(repo, "a.txt"), "exact lookup mutation\n");
    git.restoreCheckpoint(cp.id, repo);
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v1\n");

    writeFileSync(join(repo, "a.txt"), "ambiguous prefix survivor\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    const prefix = cp.id.slice(0, -1);

    assert.throws(() => git.restoreCheckpoint(prefix, repo), /ambiguous|multiple/i);
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("persists final recovery metadata in both metadata files", () => {
    const repo = initRepo("persisted-recovery");
    writeFileSync(join(repo, "untracked.txt"), "recoverable\n");
    const cp = git.createCheckpoint("metadata", repo);
    const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);

    for (const path of [cp.path, rootPath]) {
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(persisted.recoverable, cp.recoverable);
      assert.equal(persisted.warning, cp.warning);
    }
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

  test("post-anchor diff failure removes the exact durable ref and checkpoint artifacts", () => {
    const repo = initRepo("post-anchor-diff-failure");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const bin = join(tmp, "fake-post-anchor-git-bin");
    const log = join(tmp, "post-anchor-git.log");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\nif [ "$1" = "diff" ]; then exit 71; fi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();

    process.env.GIT_LOG = log;
    process.env.REAL_GIT = realGit;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      assert.throws(
        () => git.createCheckpoint("post-anchor-failure", repo),
        /worktree diff|capture/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
      delete process.env.GIT_LOG;
    }

    const commands = readFileSync(log, "utf8").trim().split("\n");
    const anchor = commands.find((line) =>
      /^update-ref refs\/alloy\/checkpoints\/\S+ [0-9a-f]+$/.test(line),
    );
    assert.ok(anchor, "expected durable ref creation");
    const [, ref, object] = anchor.split(" ");
    const id = ref.split("/").pop();
    assert.equal(
      run(repo, ["for-each-ref", "--format=%(refname)", ref]).stdout.trim(),
      "",
    );
    assert.ok(
      commands.includes(`update-ref -d ${ref} ${object}`),
      "expected compare-and-swap ref deletion",
    );
    for (const path of checkpointArtifactPaths(repo, id)) {
      assert.equal(existsSync(path), false, `unexpected checkpoint artifact: ${path}`);
    }
  });

  test("ref cleanup failure reports the original failure and exact retained ref", () => {
    const repo = initRepo("ref-cleanup-failure");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const bin = join(tmp, "fake-ref-cleanup-git-bin");
    const log = join(tmp, "ref-cleanup-git.log");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\nif [ "$1" = "update-ref" ] && [ "$2" = "-d" ]; then exit 72; fi\nif [ "$1" = "diff" ]; then exit 71; fi\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();

    let error = null;
    process.env.GIT_LOG = log;
    process.env.REAL_GIT = realGit;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      git.createCheckpoint("cleanup-failure", repo);
    } catch (err) {
      error = err;
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
      delete process.env.GIT_LOG;
    }

    const commands = readFileSync(log, "utf8").trim().split("\n");
    const anchor = commands.find((line) =>
      /^update-ref refs\/alloy\/checkpoints\/\S+ [0-9a-f]+$/.test(line),
    );
    assert.ok(anchor, "expected durable ref creation");
    const [, ref, object] = anchor.split(" ");
    const id = ref.split("/").pop();
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, new RegExp(ref.replaceAll("/", "\\/")));
    assert.match(error.errors.map((item) => item.message).join("\n"), /worktree diff/i);
    assert.match(error.errors.map((item) => item.message).join("\n"), /ref.*remain/i);
    assert.ok(commands.includes(`update-ref -d ${ref} ${object}`));
    assert.equal(
      run(repo, ["for-each-ref", "--format=%(refname)", ref]).stdout.trim(),
      ref,
    );
    for (const path of checkpointArtifactPaths(repo, id)) {
      assert.equal(existsSync(path), false, `unexpected checkpoint artifact: ${path}`);
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
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    const before = snapshot(repo, ["a.txt"]);
    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo, { allowClean: true }),
      /disabled|clean/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
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
