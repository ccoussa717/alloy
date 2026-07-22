import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
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

function overwriteRootMetadata(cp, update) {
  const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);
  const metadata = update(JSON.parse(readFileSync(rootPath, "utf8")));
  writeFileSync(rootPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function convertToPriorModernMetadata(cp, repo) {
  const restoreObject = cp.restoreObject || cp.refObject;
  run(repo, ["update-ref", cp.ref, restoreObject, cp.refObject]);
  overwriteMetadata(cp, (metadata) => {
    const {
      formatVersion: _formatVersion,
      restoreObject: _restoreObject,
      ...prior
    } = metadata;
    return { ...prior, refObject: restoreObject };
  });
  return restoreObject;
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

function assertNoCheckpointArtifacts(repo) {
  const root = checkpointRootPath(repo);
  if (existsSync(root)) assert.deepEqual(readdirSync(root), []);
  assert.equal(
    run(repo, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/alloy/checkpoints/",
    ]).stdout.trim(),
    "",
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

  test("staged deletion restores after live HEAD advances with the same deletion", () => {
    const repo = initRepo("staged-delete-advanced-head");
    writeFileSync(join(repo, "delete-me.txt"), "tracked bytes\n");
    run(repo, ["add", "delete-me.txt"]);
    run(repo, ["commit", "-m", "track deletion target"]);
    run(repo, ["rm", "delete-me.txt"]);
    const expected = observableGitState(repo);
    const cp = git.createCheckpoint("staged-delete", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    run(repo, ["rm", "delete-me.txt"]);
    run(repo, ["commit", "-m", "advance with same deletion"]);

    git.restoreCheckpoint(cp.id, repo);

    assert.deepEqual(observableGitState(repo), expected);
    assert.equal(existsSync(join(repo, "delete-me.txt")), false);
    assert.equal(run(repo, ["rev-parse", "HEAD"]).stdout.trim(), cp.head);
  });

  test("checkpoint creation rejects a UU conflict without artifacts or mutation", () => {
    const repo = initRepo("unmerged-uu");
    const baseBranch = run(repo, ["branch", "--show-current"]).stdout.trim();
    run(repo, ["switch", "-c", "conflict-side"]);
    writeFileSync(join(repo, "a.txt"), "side bytes\n");
    run(repo, ["add", "a.txt"]);
    run(repo, ["commit", "-m", "side update"]);
    run(repo, ["switch", baseBranch]);
    writeFileSync(join(repo, "a.txt"), "main bytes\n");
    run(repo, ["add", "a.txt"]);
    run(repo, ["commit", "-m", "main update"]);
    assert.notEqual(run(repo, ["merge", "conflict-side"]).status, 0);
    const before = snapshot(repo, ["a.txt"]);
    const unmerged = raw(repo, ["ls-files", "-u", "-z"]);
    assert.ok(unmerged.length > 0);

    assert.throws(
      () => git.createCheckpoint("reject-uu", repo),
      /unmerged|conflict|index/i,
    );

    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.deepEqual(raw(repo, ["ls-files", "-u", "-z"]), unmerged);
    assertNoCheckpointArtifacts(repo);
  });

  test("checkpoint creation rejects an AA conflict without artifacts or mutation", () => {
    const repo = initRepo("unmerged-aa");
    const baseBranch = run(repo, ["branch", "--show-current"]).stdout.trim();
    run(repo, ["switch", "-c", "conflict-side"]);
    writeFileSync(join(repo, "added.txt"), "side bytes\n");
    run(repo, ["add", "added.txt"]);
    run(repo, ["commit", "-m", "side add"]);
    run(repo, ["switch", baseBranch]);
    writeFileSync(join(repo, "added.txt"), "main bytes\n");
    run(repo, ["add", "added.txt"]);
    run(repo, ["commit", "-m", "main add"]);
    assert.notEqual(run(repo, ["merge", "conflict-side"]).status, 0);
    const before = snapshot(repo, ["added.txt"]);
    const unmerged = raw(repo, ["ls-files", "-u", "-z"]);
    assert.ok(unmerged.length > 0);

    assert.throws(
      () => git.createCheckpoint("reject-aa", repo),
      /unmerged|conflict|index/i,
    );

    assert.deepEqual(snapshot(repo, ["added.txt"]), before);
    assert.deepEqual(raw(repo, ["ls-files", "-u", "-z"]), unmerged);
    assertNoCheckpointArtifacts(repo);
  });

  test("checkpoint operations from a repository subdirectory use the repository root", () => {
    const repo = initRepo("subdirectory-invocation");
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "tracked.txt"), "tracked base\n");
    run(repo, ["add", "sub/tracked.txt"]);
    run(repo, ["commit", "-m", "add subdirectory"]);
    writeFileSync(join(repo, "root-untracked.txt"), "root payload\n");
    writeFileSync(join(sub, "nested-untracked.txt"), "nested payload\n");

    const cp = git.createCheckpoint("from-subdirectory", sub);

    assert.deepEqual([...cp.untracked].sort(), [
      "root-untracked.txt",
      "sub/nested-untracked.txt",
    ]);
    assert.equal(cp.cwd, resolve(sub));
    assert.equal(cp.repoRoot, resolve(repo));
    assert.equal(
      git.listCheckpoints(repo).some((item) => item.id === cp.id),
      true,
    );
    assert.equal(
      git.listCheckpoints(sub).some((item) => item.id === cp.id),
      true,
    );

    for (const path of ["root-untracked.txt", "sub/nested-untracked.txt"]) {
      rmSync(join(repo, path));
    }
    git.restoreCheckpoint(cp.id, repo);
    assert.equal(readFileSync(join(repo, "root-untracked.txt"), "utf8"), "root payload\n");
    assert.equal(
      readFileSync(join(sub, "nested-untracked.txt"), "utf8"),
      "nested payload\n",
    );

    for (const path of ["root-untracked.txt", "sub/nested-untracked.txt"]) {
      rmSync(join(repo, path));
    }
    git.restoreCheckpoint(cp.id, sub);
    assert.equal(readFileSync(join(repo, "root-untracked.txt"), "utf8"), "root payload\n");
    assert.equal(
      readFileSync(join(sub, "nested-untracked.txt"), "utf8"),
      "nested payload\n",
    );

    assert.equal(git.deleteCheckpoint(cp.id, sub), true);
    assert.equal(
      git.listCheckpoints(repo).some((item) => item.id === cp.id),
      false,
    );
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

  test("refuses a current ignored empty directory at a tracked file destination", () => {
    const repo = initRepo("tracked-ignored-empty-directory");
    writeFileSync(join(repo, ".gitignore"), "owned-at-checkpoint/\n");
    writeFileSync(join(repo, "owned-at-checkpoint"), "checkpoint tracked bytes\n");
    run(repo, ["add", ".gitignore", "owned-at-checkpoint"]);
    run(repo, ["commit", "-m", "track file destination"]);
    const cp = git.createCheckpoint("ignored-empty-directory", repo);
    run(repo, ["rm", "owned-at-checkpoint"]);
    run(repo, ["commit", "-m", "remove tracked file destination"]);
    mkdirSync(join(repo, "owned-at-checkpoint"));
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.equal(
      run(repo, ["check-ignore", "owned-at-checkpoint/"]).status,
      0,
    );
    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /collision|ignored|directory|preflight/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(lstatSync(join(repo, "owned-at-checkpoint")).isDirectory(), true);
    assert.deepEqual(readdirSync(join(repo, "owned-at-checkpoint")), []);
  });

  test("refuses a current ignored file where checkpoint tracked paths need a directory", () => {
    const repo = initRepo("tracked-directory-ignored-file");
    writeFileSync(join(repo, ".gitignore"), "shape\n");
    mkdirSync(join(repo, "shape"));
    writeFileSync(join(repo, "shape", "value.txt"), "checkpoint tracked bytes\n");
    run(repo, ["add", ".gitignore"]);
    run(repo, ["add", "-f", "shape/value.txt"]);
    run(repo, ["commit", "-m", "track directory shape"]);
    const cp = git.createCheckpoint("tracked-directory-shape", repo);
    run(repo, ["rm", "shape/value.txt"]);
    run(repo, ["commit", "-m", "remove tracked directory shape"]);
    writeFileSync(join(repo, "shape"), "current ignored file\n");
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt", "shape"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /collision|ignored|directory|preflight/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt", "shape"]), before);
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

  test("new checkpoints use an immutable manifest anchor that owns the restore object", () => {
    const repo = initRepo("manifest-anchor");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");

    const cp = git.createCheckpoint("manifest-anchor", repo);

    assert.equal(cp.formatVersion, 2);
    assert.match(cp.refObject, /^[0-9a-f]{40,64}$/);
    assert.match(cp.restoreObject, /^[0-9a-f]{40,64}$/);
    assert.equal(run(repo, ["rev-parse", cp.ref]).stdout.trim(), cp.refObject);
    assert.equal(run(repo, ["cat-file", "-t", cp.refObject]).stdout.trim(), "commit");
    assert.equal(run(repo, ["rev-parse", `${cp.refObject}^1`]).stdout.trim(), cp.restoreObject);
    assert.match(
      run(repo, ["show", "-s", "--format=%B", cp.refObject]).stdout,
      /alloy-checkpoint-anchor-v1|manifestDigest|sha256/i,
    );
  });

  test("restore rejects authenticated head substitution even when metadata copies agree", () => {
    const repo = initRepo("tampered-authenticated-head");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("authenticated-head", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    run(repo, ["commit", "--allow-empty", "-m", "same-tree alternate head"]);
    const substitutedHead = run(repo, ["rev-parse", "HEAD"]).stdout.trim();
    overwriteMetadata(cp, (metadata) => ({
      ...metadata,
      head: substitutedHead,
    }));
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|authenticated/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects root and store metadata disagreement before mutation", () => {
    const repo = initRepo("mismatched-authenticated-metadata");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("metadata-mismatch", repo);
    overwriteRootMetadata(cp, (metadata) => ({
      ...metadata,
      label: "tampered root label",
    }));
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /metadata|mismatch|integrity/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects authenticated patch tampering before mutation", () => {
    const repo = initRepo("tampered-authenticated-patch");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("authenticated-patch", repo);
    writeFileSync(join(cp.storeDir, "worktree.patch"), "tampered patch bytes\n");
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects authenticated index patch tampering before mutation", () => {
    const repo = initRepo("tampered-authenticated-index-patch");
    writeFileSync(join(repo, "a.txt"), "checkpoint staged bytes\n");
    run(repo, ["add", "a.txt"]);
    const cp = git.createCheckpoint("authenticated-index-patch", repo);
    writeFileSync(join(cp.storeDir, "index.patch"), "tampered index patch bytes\n");
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects authenticated untracked payload tampering before mutation", () => {
    const repo = initRepo("tampered-authenticated-untracked");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");
    const cp = git.createCheckpoint("authenticated-untracked", repo);
    writeFileSync(
      join(cp.storeDir, "untracked", "untracked.txt"),
      "tampered untracked bytes\n",
    );
    rmSync(join(repo, "untracked.txt"));
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(existsSync(join(repo, "untracked.txt")), false);
  });

  test("restore rejects authenticated untracked symlink target tampering", () => {
    const repo = initRepo("tampered-authenticated-symlink");
    symlinkSync("a.txt", join(repo, "untracked-link"));
    const cp = git.createCheckpoint("authenticated-symlink", repo);
    const storedLink = join(cp.storeDir, "untracked", "untracked-link");
    rmSync(storedLink);
    symlinkSync("different-target", storedLink);
    rmSync(join(repo, "untracked-link"));
    const before = snapshot(repo);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.deepEqual(snapshot(repo), before);
    assert.equal(existsSync(join(repo, "untracked-link")), false);
  });

  test("restore rejects authenticated untracked mode tampering", (t) => {
    const repo = initRepo("tampered-authenticated-mode");
    writeFileSync(join(repo, "setuid.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, "setuid.sh"), 0o4755);
    if ((lstatSync(join(repo, "setuid.sh")).mode & 0o7777) !== 0o4755) {
      t.skip("filesystem strips setuid mode");
      return;
    }
    const cp = git.createCheckpoint("authenticated-mode", repo);
    const stored = join(cp.storeDir, "untracked", "setuid.sh");
    if ((lstatSync(stored).mode & 0o7777) !== 0o4755) {
      t.skip("checkpoint filesystem strips setuid mode");
      return;
    }
    chmodSync(stored, 0o755);
    rmSync(join(repo, "setuid.sh"));
    const before = snapshot(repo);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.deepEqual(snapshot(repo), before);
    assert.equal(existsSync(join(repo, "setuid.sh")), false);
  });

  test("prior unanchored modern metadata with external payloads fails with migration guidance", () => {
    const repo = initRepo("prior-modern-external-payload");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");
    const cp = git.createCheckpoint("prior-modern", repo);
    convertToPriorModernMetadata(cp, repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    rmSync(join(repo, "untracked.txt"));
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /migration|export|unauthenticated|legacy/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("prior unanchored modern tracked-only metadata fails closed", () => {
    const repo = initRepo("prior-modern-tracked-only");
    writeFileSync(join(repo, "a.txt"), "prior checkpoint bytes\n");
    const cp = git.createCheckpoint("prior-modern-tracked", repo);
    convertToPriorModernMetadata(cp, repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /export|migrate|unauthenticated|legacy/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("prior unanchored modern deletion is artifact-only and leaves named refs", () => {
    const repo = initRepo("prior-modern-delete");
    writeFileSync(join(repo, "a.txt"), "prior checkpoint bytes\n");
    writeFileSync(join(repo, "legacy-untracked.txt"), "legacy payload\n");
    const prior = git.createCheckpoint("prior-modern-delete", repo);
    const priorObject = convertToPriorModernMetadata(prior, repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    rmSync(join(repo, "legacy-untracked.txt"));
    writeFileSync(join(repo, "a.txt"), "unrelated checkpoint bytes\n");
    const unrelated = git.createCheckpoint("unrelated", repo);

    assert.equal(git.deleteCheckpoint(prior.id, repo), true);
    assert.equal(
      run(repo, ["rev-parse", "--verify", prior.ref]).stdout.trim(),
      priorObject,
    );
    assert.equal(existsSync(prior.storeDir), false);
    assert.equal(run(repo, ["rev-parse", unrelated.ref]).stdout.trim(), unrelated.refObject);
    assert.equal(existsSync(unrelated.storeDir), true);
  });

  test("delete rejects authenticated payload tampering and preserves artifacts", () => {
    const repo = initRepo("tampered-authenticated-delete");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");
    const cp = git.createCheckpoint("authenticated-delete", repo);
    const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);
    writeFileSync(
      join(cp.storeDir, "untracked", "untracked.txt"),
      "tampered untracked bytes\n",
    );

    assert.throws(
      () => git.deleteCheckpoint(cp.id, repo),
      /anchor|digest|integrity|payload/i,
    );
    assert.equal(run(repo, ["rev-parse", cp.ref]).stdout.trim(), cp.refObject);
    assert.equal(existsSync(cp.storeDir), true);
    assert.equal(existsSync(rootPath), true);
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

  test("restore rejects modern metadata that points at another checkpoint ref", () => {
    const repo = initRepo("tampered-modern-restore");
    writeFileSync(join(repo, "a.txt"), "checkpoint A bytes\n");
    const checkpointA = git.createCheckpoint("checkpoint-a", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "checkpoint B bytes\n");
    const checkpointB = git.createCheckpoint("checkpoint-b", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    overwriteMetadata(checkpointA, (metadata) => ({
      ...metadata,
      ref: checkpointB.ref,
      refObject: checkpointB.refObject,
    }));
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(checkpointA.id, repo),
      /integrity|metadata|mismatch|reference/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(
      run(repo, ["rev-parse", checkpointB.ref]).stdout.trim(),
      checkpointB.refObject,
    );
  });

  test("delete rejects modern metadata that points at another checkpoint ref", () => {
    const repo = initRepo("tampered-modern-delete");
    writeFileSync(join(repo, "a.txt"), "checkpoint A bytes\n");
    const checkpointA = git.createCheckpoint("checkpoint-a", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "checkpoint B bytes\n");
    const checkpointB = git.createCheckpoint("checkpoint-b", repo);
    const rootA = join(dirname(dirname(checkpointA.path)), `${checkpointA.id}.json`);
    const rootB = join(dirname(dirname(checkpointB.path)), `${checkpointB.id}.json`);
    overwriteMetadata(checkpointA, (metadata) => ({
      ...metadata,
      ref: checkpointB.ref,
      refObject: checkpointB.refObject,
    }));
    const before = {
      aRoot: readFileSync(rootA),
      aMeta: readFileSync(checkpointA.path),
      bRoot: readFileSync(rootB),
      bMeta: readFileSync(checkpointB.path),
      bRef: run(repo, ["rev-parse", checkpointB.ref]).stdout.trim(),
    };

    assert.throws(
      () => git.deleteCheckpoint(checkpointA.id, repo),
      /integrity|metadata|mismatch|reference/i,
    );
    assert.deepEqual(readFileSync(rootA), before.aRoot);
    assert.deepEqual(readFileSync(checkpointA.path), before.aMeta);
    assert.deepEqual(readFileSync(rootB), before.bRoot);
    assert.deepEqual(readFileSync(checkpointB.path), before.bMeta);
    assert.equal(run(repo, ["rev-parse", checkpointB.ref]).stdout.trim(), before.bRef);
    assert.ok(
      git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === checkpointA.id),
    );
    assert.ok(
      git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === checkpointB.id),
    );
  });

  test("restore rejects a modern ref moved away from its recorded object", () => {
    const repo = initRepo("moved-modern-ref");
    writeFileSync(join(repo, "a.txt"), "checkpoint A bytes\n");
    const checkpointA = git.createCheckpoint("checkpoint-a", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "checkpoint B bytes\n");
    const checkpointB = git.createCheckpoint("checkpoint-b", repo);
    run(repo, [
      "update-ref",
      checkpointA.ref,
      checkpointB.refObject,
      checkpointA.refObject,
    ]);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(checkpointA.id, repo),
      /object|integrity|mismatch/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(
      run(repo, ["rev-parse", checkpointB.ref]).stdout.trim(),
      checkpointB.refObject,
    );
  });

  test("restore rejects a symbolic canonical ref without touching its victim", () => {
    const repo = initRepo("symbolic-checkpoint-restore");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("symbolic-restore", repo);
    const victim = "refs/heads/checkpoint-victim";
    run(repo, ["update-ref", victim, cp.refObject]);
    run(repo, ["update-ref", "-d", cp.ref, cp.refObject]);
    run(repo, ["symbolic-ref", cp.ref, victim]);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /symbolic|direct|reference|integrity/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(run(repo, ["rev-parse", victim]).stdout.trim(), cp.refObject);
    assert.equal(run(repo, ["symbolic-ref", "-q", cp.ref]).stdout.trim(), victim);
    assert.equal(existsSync(cp.storeDir), true);
    assert.equal(existsSync(rootPath), true);
  });

  test("delete rejects a symbolic canonical ref without deleting victim or artifacts", () => {
    const repo = initRepo("symbolic-checkpoint-delete");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("symbolic-delete", repo);
    const victim = "refs/heads/checkpoint-victim";
    run(repo, ["update-ref", victim, cp.refObject]);
    run(repo, ["update-ref", "-d", cp.ref, cp.refObject]);
    run(repo, ["symbolic-ref", cp.ref, victim]);
    const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);

    assert.throws(
      () => git.deleteCheckpoint(cp.id, repo),
      /symbolic|direct|reference|integrity/i,
    );
    assert.equal(run(repo, ["rev-parse", victim]).stdout.trim(), cp.refObject);
    assert.equal(run(repo, ["symbolic-ref", "-q", cp.ref]).stdout.trim(), victim);
    assert.equal(existsSync(cp.storeDir), true);
    assert.equal(existsSync(rootPath), true);
  });

  test("checkpoint creation never follows a colliding symref into its target", () => {
    const repo = initRepo("symbolic-checkpoint-create");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const fixedNow = 1_700_000_200_000;
    const fixedRandom = 0.345678912;
    const id = `${fixedNow.toString(36)}-${fixedRandom.toString(36).slice(2, 7)}`;
    const ref = `refs/alloy/checkpoints/${id}`;
    const victim = "refs/heads/unborn-checkpoint-victim";
    run(repo, ["symbolic-ref", ref, victim]);
    const bin = join(tmp, "fake-symbolic-create-git-bin");
    const log = join(tmp, "symbolic-create-git.log");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\nexec "$REAL_GIT" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    const oldNow = Date.now;
    const oldRandom = Math.random;
    const oldPath = process.env.PATH;
    const oldGitLog = process.env.GIT_LOG;
    const oldRealGit = process.env.REAL_GIT;
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).stdout.trim();
    let created = null;
    let error = null;

    process.env.GIT_LOG = log;
    process.env.REAL_GIT = realGit;
    process.env.PATH = `${bin}:${oldPath}`;
    Date.now = () => fixedNow;
    Math.random = () => fixedRandom;

    try {
      created = git.createCheckpoint("symbolic-create", repo);
    } catch (err) {
      error = err;
    } finally {
      Date.now = oldNow;
      Math.random = oldRandom;
      process.env.PATH = oldPath;
      if (oldRealGit === undefined) delete process.env.REAL_GIT;
      else process.env.REAL_GIT = oldRealGit;
      if (oldGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = oldGitLog;
    }

    let commands;
    try {
      commands = readFileSync(log, "utf8").trim().split("\n");
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(log, { force: true });
    }
    const refUpdates = commands.filter(
      (line) => line.startsWith("update-ref ") && line.split(" ").includes(ref),
    );
    assert.ok(refUpdates.length > 0, "expected at least one checkpoint ref update");
    for (const update of refUpdates) {
      assert.match(update, /^update-ref --no-deref /);
    }
    assert.ok(
      refUpdates.some((line) =>
        new RegExp(`^update-ref --no-deref ${ref} [0-9a-f]+ 0+$`).test(line),
      ),
      "expected a no-deref compare-and-swap ref claim",
    );
    assert.equal(run(repo, ["show-ref", "--verify", "--quiet", victim]).status, 1);
    if (error) {
      assert.match(error.message, /anchor|collision|reference|ref/i);
      assert.equal(run(repo, ["symbolic-ref", "-q", ref]).stdout.trim(), victim);
      for (const path of checkpointArtifactPaths(repo, id)) {
        assert.equal(existsSync(path), false);
      }
    } else {
      assert.equal(created.id, id);
      assert.equal(run(repo, ["symbolic-ref", "-q", ref]).status, 1);
      assert.equal(run(repo, ["rev-parse", "--verify", ref]).stdout.trim(), created.refObject);
      for (const path of checkpointArtifactPaths(repo, id)) {
        assert.equal(existsSync(path), true);
      }
    }
  });

  test("legacy raw-object metadata restore fails closed with migration guidance", () => {
    const repo = initRepo("legacy-raw-restore");
    writeFileSync(join(repo, "a.txt"), "legacy checkpoint bytes\n");
    const legacy = git.createCheckpoint("legacy", repo);
    const legacyObject = legacy.restoreObject;
    run(repo, ["update-ref", "-d", legacy.ref, legacy.refObject]);
    overwriteMetadata(legacy, (metadata) => {
      const {
        formatVersion: _formatVersion,
        refObject: _refObject,
        restoreObject: _restoreObject,
        manifestDigest: _manifestDigest,
        ...rest
      } = metadata;
      return { ...rest, ref: legacyObject };
    });
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "unrelated checkpoint bytes\n");
    const unrelated = git.createCheckpoint("unrelated", repo);
    const unrelatedObject = unrelated.refObject;
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(legacy.id, repo),
      /export|migrate|unauthenticated|legacy/i,
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(
      run(repo, ["rev-parse", unrelated.ref]).stdout.trim(),
      unrelatedObject,
    );
  });

  test("legacy deletion removes only legacy artifacts and no unrelated ref", () => {
    const repo = initRepo("legacy-raw-delete");
    writeFileSync(join(repo, "a.txt"), "legacy checkpoint bytes\n");
    const legacy = git.createCheckpoint("legacy", repo);
    const legacyObject = legacy.restoreObject;
    const legacyRoot = join(dirname(dirname(legacy.path)), `${legacy.id}.json`);
    run(repo, ["update-ref", "-d", legacy.ref, legacy.refObject]);
    overwriteMetadata(legacy, (metadata) => {
      const {
        formatVersion: _formatVersion,
        refObject: _refObject,
        restoreObject: _restoreObject,
        manifestDigest: _manifestDigest,
        ...rest
      } = metadata;
      return { ...rest, ref: legacyObject };
    });
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "unrelated checkpoint bytes\n");
    const unrelated = git.createCheckpoint("unrelated", repo);
    const unrelatedRoot = join(
      dirname(dirname(unrelated.path)),
      `${unrelated.id}.json`,
    );
    const unrelatedObject = unrelated.refObject;

    assert.equal(git.deleteCheckpoint(legacy.id, repo), true);
    assert.equal(existsSync(legacy.storeDir), false);
    assert.equal(existsSync(legacyRoot), false);
    assert.equal(existsSync(unrelated.storeDir), true);
    assert.equal(existsSync(unrelatedRoot), true);
    assert.equal(
      run(repo, ["rev-parse", unrelated.ref]).stdout.trim(),
      unrelatedObject,
    );
    assert.equal(
      git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === legacy.id),
      false,
    );
    assert.ok(
      git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === unrelated.id),
    );
  });

  test("unauthenticated fallback patches fail closed before mutating current state", () => {
    const repo = initRepo("invalid-patch-atomic");
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("invalid-patch", repo);
    overwriteMetadata(cp, (metadata) => {
      const {
        formatVersion: _formatVersion,
        refObject: _refObject,
        restoreObject: _restoreObject,
        manifestDigest: _manifestDigest,
        ...rest
      } = metadata;
      return { ...rest, ref: null };
    });
    writeFileSync(join(cp.storeDir, "worktree.patch"), "not a patch\n");
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    const before = snapshot(repo, ["a.txt"]);

    assert.throws(
      () => git.restoreCheckpoint(cp.id, repo),
      /migration|export|unauthenticated/i,
    );
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

  test("restore rejects a symbolic HEAD switch at the same object during preflight", () => {
    const repo = initRepo("restore-concurrent-head-switch");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("concurrent-head-switch", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    const originalHead = run(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const bin = join(tmp, "fake-concurrent-head-switch-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "stash" ] && [ "$2" = "apply" ] && [ -n "$GIT_INDEX_FILE" ]; then\n  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE "$REAL_GIT" -C "$TEST_REPO" switch -c concurrent-branch >/dev/null 2>&1\nfi\nexec "$REAL_GIT" "$@"\n',
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
        /HEAD|branch|changed|preflight/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
      delete process.env.TEST_REPO;
    }

    assert.equal(run(repo, ["rev-parse", "HEAD"]).stdout.trim(), originalHead);
    assert.equal(
      run(repo, ["symbolic-ref", "--short", "HEAD"]).stdout.trim(),
      "concurrent-branch",
    );
    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
  });

  test("restore rejects an ignored tracked-destination collision created during preflight", () => {
    const repo = initRepo("restore-concurrent-ignored-collision");
    writeFileSync(join(repo, ".gitignore"), "owned-at-checkpoint.txt\n");
    writeFileSync(join(repo, "owned-at-checkpoint.txt"), "checkpoint tracked bytes\n");
    run(repo, ["add", ".gitignore"]);
    run(repo, ["add", "-f", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "track ignored destination"]);
    writeFileSync(join(repo, "a.txt"), "checkpoint dirty bytes\n");
    const cp = git.createCheckpoint("late-ignored-collision", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    run(repo, ["rm", "owned-at-checkpoint.txt"]);
    run(repo, ["commit", "-m", "remove ignored destination"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    const bin = join(tmp, "fake-concurrent-ignored-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "stash" ] && [ "$2" = "apply" ] && [ -n "$GIT_INDEX_FILE" ]; then\n  printf \'late ignored bytes\\n\' > "$TEST_REPO/owned-at-checkpoint.txt"\nfi\nexec "$REAL_GIT" "$@"\n',
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
        /collision|ignored|changed|preflight/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
      delete process.env.TEST_REPO;
    }

    assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    assert.equal(
      readFileSync(join(repo, "owned-at-checkpoint.txt"), "utf8"),
      "late ignored bytes\n",
    );
  });

  test("restore preflights destination writability before tracked mutation", (t) => {
    const repo = initRepo("restore-unwritable-parent");
    const locked = join(repo, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "value.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("unwritable-parent", repo);
    rmSync(join(locked, "value.txt"));
    writeFileSync(join(repo, "a.txt"), "current tracked bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);
    chmodSync(locked, 0o500);

    try {
      const probe = join(locked, ".alloy-permission-probe");
      let modeBitsBypassed = false;
      try {
        writeFileSync(probe, "probe", { flag: "wx" });
        modeBitsBypassed = true;
      } catch (err) {
        assert.ok(
          err?.code === "EACCES" || err?.code === "EPERM",
          `expected mode-bit permission denial, received ${err?.code || err}`,
        );
      } finally {
        rmSync(probe, { force: true });
      }
      if (modeBitsBypassed) {
        t.skip("effective process can write into a mode 0500 directory");
        return;
      }

      assert.throws(
        () => git.restoreCheckpoint(cp.id, repo),
        /writ|EACCES|permission/i,
      );
      assert.deepEqual(snapshot(repo, ["a.txt"]), before);
    } finally {
      chmodSync(locked, 0o700);
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

  test("duplicate checkpoint ID preserves the first checkpoint and restore capability", () => {
    const repo = initRepo("duplicate-checkpoint-id");
    const fixedNow = 1_700_000_100_000;
    const fixedRandom = 0.234567891;
    const oldNow = Date.now;
    const oldRandom = Math.random;
    Date.now = () => fixedNow;
    Math.random = () => fixedRandom;
    let first = null;
    let secondError = null;

    try {
      writeFileSync(join(repo, "a.txt"), "first checkpoint tracked bytes\n");
      writeFileSync(join(repo, "first-untracked.txt"), "first untracked bytes\n");
      first = git.createCheckpoint("first", repo);
      const rootIndex = join(dirname(dirname(first.path)), `${first.id}.json`);
      const before = {
        ref: run(repo, ["rev-parse", first.ref]).stdout.trim(),
        rootIndex: readFileSync(rootIndex),
        metadata: readFileSync(first.path),
        patch: readFileSync(join(first.storeDir, "worktree.patch")),
        untracked: readFileSync(
          join(first.storeDir, "untracked", "first-untracked.txt"),
        ),
      };

      writeFileSync(join(repo, "a.txt"), "second checkpoint tracked bytes\n");
      try {
        git.createCheckpoint("second", repo);
      } catch (err) {
        secondError = err;
      }

      assert.ok(secondError);
      assert.equal(run(repo, ["rev-parse", first.ref]).stdout.trim(), before.ref);
      assert.deepEqual(readFileSync(rootIndex), before.rootIndex);
      assert.deepEqual(readFileSync(first.path), before.metadata);
      assert.deepEqual(
        readFileSync(join(first.storeDir, "worktree.patch")),
        before.patch,
      );
      assert.deepEqual(
        readFileSync(join(first.storeDir, "untracked", "first-untracked.txt")),
        before.untracked,
      );

      rmSync(join(repo, "first-untracked.txt"));
      run(repo, ["reset", "--hard", "HEAD"]);
      git.restoreCheckpoint(first.id, repo);
      assert.equal(
        readFileSync(join(repo, "a.txt"), "utf8"),
        "first checkpoint tracked bytes\n",
      );
      assert.equal(
        readFileSync(join(repo, "first-untracked.txt"), "utf8"),
        "first untracked bytes\n",
      );
    } finally {
      Date.now = oldNow;
      Math.random = oldRandom;
    }
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

  test("special untracked modes restore independently of process umask", (t) => {
    const repo = initRepo("restore-untracked-special-modes");
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
    const cp = git.createCheckpoint("untracked-special-modes", repo);
    for (const name of expected.keys()) rmSync(join(repo, name));
    const oldUmask = process.umask(0o077);

    try {
      git.restoreCheckpoint(cp.id, repo);
    } finally {
      process.umask(oldUmask);
    }

    for (const [name, mode] of expected) {
      assert.equal(lstatSync(join(repo, name)).mode & 0o7777, mode);
    }
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

  test("empty checkpoint IDs and prefixes cannot restore a single record", () => {
    const repo = initRepo("empty-restore-id");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("nonempty", repo);
    run(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "current survivor bytes\n");
    run(repo, ["add", "a.txt"]);
    const before = snapshot(repo, ["a.txt"]);

    for (const id of ["", "   "]) {
      assert.throws(() => git.restoreCheckpoint(id, repo), /non-empty/i);
      assert.deepEqual(snapshot(repo, ["a.txt"]), before);
      assert.equal(run(repo, ["rev-parse", cp.ref]).stdout.trim(), cp.refObject);
      assert.equal(existsSync(cp.storeDir), true);
    }
  });

  test("empty checkpoint IDs cannot delete a single record", () => {
    const repo = initRepo("empty-delete-id");
    writeFileSync(join(repo, "a.txt"), "checkpoint bytes\n");
    const cp = git.createCheckpoint("nonempty", repo);
    const rootPath = join(dirname(dirname(cp.path)), `${cp.id}.json`);

    for (const id of ["", "   "]) {
      assert.throws(() => git.deleteCheckpoint(id, repo), /non-empty/i);
      assert.equal(run(repo, ["rev-parse", cp.ref]).stdout.trim(), cp.refObject);
      assert.equal(existsSync(cp.storeDir), true);
      assert.equal(existsSync(rootPath), true);
    }
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
      /^update-ref --no-deref refs\/alloy\/checkpoints\/\S+ [0-9a-f]+ 0+$/.test(line),
    );
    assert.ok(anchor, "expected durable ref creation");
    const [, , ref, object] = anchor.split(" ");
    const id = ref.split("/").pop();
    assert.equal(
      run(repo, ["for-each-ref", "--format=%(refname)", ref]).stdout.trim(),
      "",
    );
    assert.ok(
      commands.includes(`update-ref --no-deref -d ${ref} ${object}`),
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
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GIT_LOG"\nif [ "$1" = "update-ref" ] && [ "$2" = "--no-deref" ] && [ "$3" = "-d" ]; then exit 72; fi\nif [ "$1" = "diff" ]; then exit 71; fi\nexec "$REAL_GIT" "$@"\n',
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
      /^update-ref --no-deref refs\/alloy\/checkpoints\/\S+ [0-9a-f]+ 0+$/.test(line),
    );
    assert.ok(anchor, "expected durable ref creation");
    const [, , ref, object] = anchor.split(" ");
    const id = ref.split("/").pop();
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, new RegExp(ref.replaceAll("/", "\\/")));
    assert.match(error.errors.map((item) => item.message).join("\n"), /worktree diff/i);
    assert.match(error.errors.map((item) => item.message).join("\n"), /ref.*remain/i);
    assert.ok(commands.includes(`update-ref --no-deref -d ${ref} ${object}`));
    assert.equal(
      run(repo, ["for-each-ref", "--format=%(refname)", ref]).stdout.trim(),
      ref,
    );
    for (const path of checkpointArtifactPaths(repo, id)) {
      assert.equal(existsSync(path), false, `unexpected checkpoint artifact: ${path}`);
    }
  });

  test("delete ref failure preserves discoverable checkpoint artifacts", () => {
    const repo = initRepo("delete-ref-failure");
    writeFileSync(join(repo, "a.txt"), "checkpoint tracked bytes\n");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");
    const cp = git.createCheckpoint("delete-failure", repo);
    const rootIndex = join(dirname(dirname(cp.path)), `${cp.id}.json`);
    const before = {
      ref: run(repo, ["rev-parse", cp.ref]).stdout.trim(),
      rootIndex: readFileSync(rootIndex),
      metadata: readFileSync(cp.path),
      untracked: readFileSync(
        join(cp.storeDir, "untracked", "untracked.txt"),
      ),
    };
    const bin = join(tmp, "fake-delete-ref-git-bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = "update-ref" ] && [ "$2" = "--no-deref" ] && [ "$3" = "-d" ]; then exit 73; fi\nexec "$REAL_GIT" "$@"\n',
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
        () => git.deleteCheckpoint(cp.id, repo),
        /ref|delete|preserv/i,
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.REAL_GIT;
    }

    assert.equal(run(repo, ["rev-parse", cp.ref]).stdout.trim(), before.ref);
    assert.deepEqual(readFileSync(rootIndex), before.rootIndex);
    assert.deepEqual(readFileSync(cp.path), before.metadata);
    assert.deepEqual(
      readFileSync(join(cp.storeDir, "untracked", "untracked.txt")),
      before.untracked,
    );
    assert.ok(git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === cp.id));
  });

  test("delete removes the durable ref and all checkpoint artifacts", () => {
    const repo = initRepo("delete-success");
    writeFileSync(join(repo, "a.txt"), "checkpoint tracked bytes\n");
    writeFileSync(join(repo, "untracked.txt"), "checkpoint untracked bytes\n");
    const cp = git.createCheckpoint("delete-success", repo);
    const rootIndex = join(dirname(dirname(cp.path)), `${cp.id}.json`);

    assert.equal(git.deleteCheckpoint(cp.id, repo), true);
    assert.equal(
      run(repo, ["for-each-ref", "--format=%(refname)", cp.ref]).stdout.trim(),
      "",
    );
    assert.equal(existsSync(cp.storeDir), false);
    assert.equal(existsSync(rootIndex), false);
    assert.equal(git.listCheckpoints(repo).some((checkpoint) => checkpoint.id === cp.id), false);
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

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
});
