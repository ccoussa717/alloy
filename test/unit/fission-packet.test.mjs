import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  FISSION_ENTRY_LIMIT,
  FISSION_FILE_LIMIT,
  FISSION_FILE_TOTAL_LIMIT,
  FISSION_HEAD_LIMIT,
  FISSION_PATCH_LIMIT,
  FISSION_STATUS_LIMIT,
  captureBoundedDirtyBaseline,
  captureFissionPacket,
  preflightFissionRepository,
  readRegularFileNoFollow,
  recaptureFissionSource,
  verifyFissionArtifacts,
} from "../../lib/fission-packet.mjs";
import { captureDirtyBaseline } from "../../lib/worktree.mjs";

const root = mkdtempSync(join(tmpdir(), "alloy-fission-packet-"));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd, args, options = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", ...options });
}

function initRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

const trusted = { isProjectTrusted: () => true };

test("preflight refuses untrusted projects without invoking Git or writing artifacts", () => {
  let calls = 0;
  const packetRoot = join(root, "must-not-exist");
  const result = preflightFissionRepository(root, {
    isProjectTrusted: () => false,
    spawnSync: () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, { state: "REFUSED", reason: "untrusted_project" });
  assert.equal(calls, 0);
  assert.equal(existsSync(packetRoot), false);
});

test("preflight distinguishes non-repositories, unborn HEAD, clean, dirty, and detached state", () => {
  assert.deepEqual(preflightFissionRepository(root, trusted), {
    state: "REFUSED",
    reason: "not_repository",
  });

  const unborn = join(root, "unborn");
  mkdirSync(unborn);
  git(unborn, ["init"]);
  assert.equal(preflightFissionRepository(unborn, trusted).reason, "unborn_head");

  const repo = initRepo("preflight");
  assert.equal(preflightFissionRepository(repo, trusted).state, "NO_CHANGES");
  writeFileSync(join(repo, "tracked.txt"), "dirty\n");
  const dirty = preflightFissionRepository(repo, trusted);
  assert.equal(dirty.state, "READY");
  assert.ok(Buffer.isBuffer(dirty.head));
  assert.ok(Buffer.isBuffer(dirty.status));
  git(repo, ["checkout", "--detach"]);
  const detached = preflightFissionRepository(repo, trusted);
  assert.equal(detached.state, "READY");
  assert.equal(detached.detached, true);
});

test("preflight rejects an unmerged index", () => {
  const repo = initRepo("conflict");
  git(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "tracked.txt"), "side\n");
  git(repo, ["commit", "-am", "side"]);
  git(repo, ["checkout", "master"]);
  writeFileSync(join(repo, "tracked.txt"), "main\n");
  git(repo, ["commit", "-am", "main"]);
  git(repo, ["merge", "side"]);
  assert.equal(preflightFissionRepository(repo, trusted).reason, "unmerged_index");
});

test("bounded capture preserves existing baseline behavior and normalizes subdirectories", () => {
  const repo = initRepo("baseline");
  const sub = join(repo, "sub");
  mkdirSync(sub);
  writeFileSync(join(repo, "tracked.txt"), "staged-value\n");
  git(repo, ["add", "tracked.txt"]);
  writeFileSync(join(repo, "tracked.txt"), "worktree-value\n");
  writeFileSync(join(repo, "untracked.txt"), "new\n");

  const legacy = captureDirtyBaseline(sub);
  const bounded = captureBoundedDirtyBaseline(sub, undefined, trusted);
  assert.equal(typeof legacy.head, "string");
  assert.equal(typeof legacy.stagedPatch, "string");
  assert.equal(bounded.repoRoot, resolve(repo));
  assert.ok(Buffer.isBuffer(bounded.head));
  assert.match(bounded.stagedPatch.toString(), /staged-value/);
  assert.match(bounded.unstagedPatch.toString(), /worktree-value/);
  assert.ok(bounded.entries.some((entry) => entry.untracked));
  assert.ok(bounded.retainedFiles.some((file) => file.path === "untracked.txt"));
});

test("capture invokes bounded Git reads with lock suppression and no shell", () => {
  const calls = [];
  const outputs = [
    Buffer.from("abc\n"),
    Buffer.from(" M tracked.txt\0"),
    Buffer.from("diff --git a/tracked.txt b/tracked.txt\n"),
    Buffer.alloc(0),
  ];
  captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => ({
      bytes: Buffer.from("text\n"),
      mode: 0o100644,
      size: 5,
      executable: false,
    }),
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: outputs.shift(), stderr: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["diff", "--cached", "--binary"],
    ["diff", "--binary"],
  ]);
  for (const call of calls) {
    assert.equal(call.command, "git");
    assert.equal(call.options.encoding, "buffer");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, "0");
  }
  assert.equal(calls[0].options.maxBuffer, FISSION_HEAD_LIMIT + 1);
  assert.equal(calls[1].options.maxBuffer, FISSION_STATUS_LIMIT + 1);
  assert.equal(calls[2].options.maxBuffer, FISSION_PATCH_LIMIT + 1);
  assert.equal(calls[3].options.maxBuffer, FISSION_PATCH_LIMIT + 1);
});

test("porcelain rename records stay NUL-aligned and entry limits count logical entries", () => {
  const make = (count) => {
    const records = [];
    for (let i = 0; i < count; i += 1) records.push(`?? f${i}.txt`);
    records.push("R  renamed.txt", "old.txt");
    return Buffer.from(`${records.join("\0")}\0`);
  };
  const capture = (count) => captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: (_root, path) => ({
      bytes: Buffer.from(path), mode: 0o100644, size: path.length, executable: false,
    }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? make(count)
          : Buffer.alloc(0),
    }),
  });
  const accepted = capture(FISSION_ENTRY_LIMIT - 1);
  assert.equal(accepted.entries.length, FISSION_ENTRY_LIMIT);
  assert.equal(accepted.entries.at(-1).originalPath, "old.txt");
  assert.throws(() => capture(FISSION_ENTRY_LIMIT), /entry_limit/);
});

test("bounded evidence rejects exact overages without retaining truncation", () => {
  const cases = [
    ["head_limit", [FISSION_HEAD_LIMIT + 1, 1, 0, 0]],
    ["status_limit", [1, FISSION_STATUS_LIMIT + 1, 0, 0]],
    ["patch_limit", [1, 1, FISSION_PATCH_LIMIT + 1, 0]],
    ["patch_limit", [1, 1, FISSION_PATCH_LIMIT, 1]],
  ];
  for (const [reason, sizes] of cases) {
    let index = 0;
    assert.throws(
      () => captureBoundedDirtyBaseline(root, undefined, {
        repositoryRoot: () => root,
        spawnSync: () => ({
          status: 0,
          stdout: Buffer.alloc(sizes[index++]),
          stderr: Buffer.alloc(0),
        }),
      }),
      new RegExp(reason),
    );
  }
});

test("spawn buffer overflow preserves the exact evidence limit reason", () => {
  let call = 0;
  assert.throws(() => captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    spawnSync: () => {
      call += 1;
      if (call === 3) return {
        status: null,
        stdout: Buffer.alloc(FISSION_PATCH_LIMIT + 1),
        stderr: Buffer.alloc(0),
        error: Object.assign(new Error("overflow"), { code: "ENOBUFS" }),
      };
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  }), /patch_limit/);
});

test("readRegularFileNoFollow accepts bounded regular files and rejects links and overages", () => {
  const repo = initRepo("safe-files");
  writeFileSync(join(repo, "safe.txt"), "hello\n");
  chmodSync(join(repo, "safe.txt"), 0o755);
  const safe = readRegularFileNoFollow(repo, "safe.txt", 6);
  assert.deepEqual(safe.bytes, Buffer.from("hello\n"));
  assert.equal(safe.executable, true);
  assert.throws(() => readRegularFileNoFollow(repo, "safe.txt", 5), /file_limit/);
  symlinkSync("safe.txt", join(repo, "link.txt"));
  assert.throws(() => readRegularFileNoFollow(repo, "link.txt", 10), /symlink|unsupported/i);
  assert.throws(() => readRegularFileNoFollow(repo, "../escape.txt", 10), /escape/i);
});

test("trusted capture freezes status, patches, current files, and packet artifacts", () => {
  const repo = initRepo("packet");
  writeFileSync(join(repo, "tracked.txt"), "staged-value\n");
  git(repo, ["add", "tracked.txt"]);
  writeFileSync(join(repo, "tracked.txt"), "worktree-value\n");
  writeFileSync(join(repo, "untracked.txt"), "new-value\n");
  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "packet-output");
  const capture = captureFissionPacket({
    cwd: repo,
    packetRoot,
    request: "Review this change",
    preflight,
    deps: trusted,
  });
  assert.match(readFileSync(join(packetRoot, "staged.diff"), "utf8"), /staged-value/);
  assert.match(readFileSync(join(packetRoot, "unstaged.diff"), "utf8"), /worktree-value/);
  assert.ok(capture.manifest.entries.some((entry) => entry.untracked));
  assert.equal(capture.evidenceComplete, true);
  assert.ok(capture.artifacts["review-packet.json"]);
  assert.equal(statSync(join(packetRoot, "files")).mode & 0o777, 0o500);
  assert.equal(verifyFissionArtifacts(capture).ok, true);
  assert.equal(recaptureFissionSource(capture, trusted).ok, true);

  writeFileSync(join(repo, "untracked.txt"), "changed\n");
  assert.equal(recaptureFissionSource(capture, trusted).ok, false);
  writeFileSync(join(repo, "untracked.txt"), "new-value\n");
  assert.equal(recaptureFissionSource(capture, trusted).ok, true, "byte-identical ABA is not detectable");

  chmodSync(packetRoot, 0o700);
  chmodSync(join(packetRoot, "files"), 0o700);
  chmodSync(join(packetRoot, "staged.diff"), 0o600);
  writeFileSync(join(packetRoot, "staged.diff"), "tampered\n");
  assert.equal(verifyFissionArtifacts(capture).ok, false);
});

test("unsupported, binary, and excessive file evidence fails closed with exact reason", () => {
  const repo = initRepo("unsupported");
  symlinkSync("tracked.txt", join(repo, "link.txt"));
  let baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  assert.equal(baseline.evidenceComplete, false);
  assert.equal(baseline.retainedFiles.some((file) => file.path === "link.txt"), false);

  rmSync(join(repo, "link.txt"));
  writeFileSync(join(repo, "binary.txt"), Buffer.from([0, 1, 2]));
  baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  assert.equal(baseline.evidenceComplete, false);
  assert.match(baseline.reason, /binary/);

  writeFileSync(join(repo, "binary.txt"), Buffer.alloc(FISSION_FILE_LIMIT + 1, 0x61));
  baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  assert.equal(baseline.reason, "file_limit:binary.txt");

  rmSync(join(repo, "binary.txt"));
  for (let i = 0; i < FISSION_FILE_TOTAL_LIMIT / FISSION_FILE_LIMIT + 1; i += 1) {
    writeFileSync(join(repo, `large-${i}.txt`), Buffer.alloc(FISSION_FILE_LIMIT, 0x61));
  }
  baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  assert.match(baseline.reason, /file_total_limit/);
});

test("capture requires READY preflight and request bounds before creating directories", () => {
  const target = join(root, "refused-packet");
  assert.throws(() => captureFissionPacket({
    cwd: root,
    packetRoot: target,
    request: "review",
    preflight: { state: "REFUSED" },
  }), /READY/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(root).includes("refused-packet"), false);
});
