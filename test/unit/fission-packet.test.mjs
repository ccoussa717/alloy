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
  FISSION_REQUEST_LIMIT,
  FISSION_STATUS_LIMIT,
  captureBoundedDirtyBaseline,
  captureFissionPacket,
  captureFissionSubjectPacket,
  FISSION_SUBJECT_PATH,
  preflightFissionRepository,
  readRegularFileNoFollow,
  recaptureFissionSource,
  verifyFissionArtifacts,
} from "../../lib/fission-packet.mjs";
import { captureDirtyBaseline } from "../../lib/worktree.mjs";

const root = mkdtempSync(join(tmpdir(), "alloy-fission-packet-"));
function makeTreeWritable(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
}
after(() => {
  makeTreeWritable(root);
  rmSync(root, { recursive: true, force: true });
});

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
  const initialBranch = git(repo, ["branch", "--show-current"]).stdout.trim();
  assert.ok(initialBranch);
  git(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "tracked.txt"), "side\n");
  git(repo, ["commit", "-am", "side"]);
  git(repo, ["checkout", initialBranch]);
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
    ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"],
    ["diff", "--binary", "--no-ext-diff", "--no-color"],
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

test("porcelain rename/copy records stay NUL-aligned and entry limits count logical entries", () => {
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

  const copied = captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: (_root, path) => ({
      bytes: Buffer.from(path), mode: 0o100644, size: path.length, executable: false,
    }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? Buffer.from("C  copy.txt\0source.txt\0")
          : Buffer.alloc(0),
    }),
  });
  assert.deepEqual(copied.entries, [{
    xy: "C ",
    path: "copy.txt",
    originalPath: "source.txt",
    untracked: false,
    deleted: false,
  }]);
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
  const fifo = join(repo, "pipe");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.throws(() => readRegularFileNoFollow(repo, "pipe", 10), /unsupported source type/i);
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

test("READY preflight from one repository cannot authorize another repository", () => {
  const repoA = initRepo("preflight-repo-a");
  const repoB = initRepo("preflight-repo-b");
  writeFileSync(join(repoA, "tracked.txt"), "dirty-a\n");
  writeFileSync(join(repoB, "tracked.txt"), "dirty-b\n");
  const preflight = preflightFissionRepository(repoA, trusted);
  const packetRoot = join(root, "cross-repo-packet");

  assert.throws(() => captureFissionPacket({
    cwd: repoB,
    packetRoot,
    request: "review",
    preflight,
    deps: trusted,
  }), /preflight_repository_mismatch/);
  assert.equal(existsSync(packetRoot), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith("cross-repo-packet.attempt-")), false);
});

test("replayed READY preflight cannot authorize changed HEAD or status", () => {
  const repo = initRepo("replayed-preflight");
  writeFileSync(join(repo, "tracked.txt"), "first dirty state\n");
  const statusPreflight = preflightFissionRepository(repo, trusted);
  writeFileSync(join(repo, "new-status-entry.txt"), "new entry\n");
  const statusPacket = join(root, "replayed-status-packet");
  assert.throws(() => captureFissionPacket({
    cwd: repo,
    packetRoot: statusPacket,
    request: "review",
    preflight: statusPreflight,
    deps: trusted,
  }), /preflight_drift/);
  assert.equal(existsSync(statusPacket), false);

  rmSync(join(repo, "new-status-entry.txt"));
  writeFileSync(join(repo, "tracked.txt"), "second dirty state\n");
  const headPreflight = preflightFissionRepository(repo, trusted);
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "advance head"]);
  writeFileSync(join(repo, "tracked.txt"), "dirty after new head\n");
  const headPacket = join(root, "replayed-head-packet");
  assert.throws(() => captureFissionPacket({
    cwd: repo,
    packetRoot: headPacket,
    request: "review",
    preflight: headPreflight,
    deps: trusted,
  }), /preflight_drift/);
  assert.equal(existsSync(headPacket), false);
});

test("preflight resolves repository root through a bounded Buffer Git operation", () => {
  const repo = resolve(join(root, "bounded-root"));
  const calls = [];
  const outputs = [
    Buffer.from(`${repo}\n`),
    Buffer.from("abc123\n"),
    Buffer.from(" M tracked.txt\0"),
    Buffer.from("refs/heads/main\n"),
  ];
  const result = preflightFissionRepository(join(repo, "sub"), {
    isProjectTrusted: () => true,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: outputs.shift(), stderr: Buffer.alloc(0) };
    },
  });

  assert.equal(result.state, "READY");
  assert.equal(result.repoRoot, repo);
  assert.deepEqual(calls[0].args, ["rev-parse", "--show-toplevel"]);
  assert.equal(calls[0].options.encoding, "buffer");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, "0");
  assert.ok(calls[0].options.maxBuffer <= FISSION_FILE_LIMIT + 1);
});

test("artifact verification enforces exact files, bytes, file modes, and directory modes", () => {
  const repo = initRepo("artifact-verification");
  writeFileSync(join(repo, "nested.txt"), "packet payload\n");
  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "artifact-verification-packet");
  const capture = captureFissionPacket({
    cwd: repo,
    packetRoot,
    request: "review",
    preflight,
    deps: trusted,
  });
  assert.equal(verifyFissionArtifacts(capture).ok, true);

  for (const child of Object.keys(capture.artifacts)) {
    const path = join(packetRoot, child);
    const accepted = readFileSync(path);
    chmodSync(path, 0o600);
    writeFileSync(path, Buffer.concat([accepted, Buffer.from("tamper")]));
    assert.equal(verifyFissionArtifacts(capture).mismatches.includes(`content:${child}`), true, child);
    writeFileSync(path, accepted);
    chmodSync(path, 0o400);
    assert.equal(verifyFissionArtifacts(capture).ok, true, `${child} restored`);
  }

  const requestPath = join(packetRoot, "request.txt");
  chmodSync(requestPath, 0o600);
  assert.deepEqual(verifyFissionArtifacts(capture), {
    ok: false,
    mismatches: ["mode:request.txt"],
  });
  chmodSync(requestPath, 0o400);

  chmodSync(join(packetRoot, "files"), 0o700);
  assert.equal(verifyFissionArtifacts(capture).mismatches.includes("directory_mode:files"), true);
  chmodSync(join(packetRoot, "files"), 0o500);

  chmodSync(packetRoot, 0o700);
  writeFileSync(join(packetRoot, "unexpected.txt"), "unexpected\n", { mode: 0o400 });
  chmodSync(packetRoot, 0o500);
  assert.equal(verifyFissionArtifacts(capture).mismatches.includes("unexpected:unexpected.txt"), true);
  chmodSync(packetRoot, 0o700);
  rmSync(join(packetRoot, "unexpected.txt"));
  chmodSync(packetRoot, 0o500);

  const stagedPath = join(packetRoot, "staged.diff");
  const stagedBytes = readFileSync(stagedPath);
  chmodSync(packetRoot, 0o700);
  rmSync(stagedPath);
  chmodSync(packetRoot, 0o500);
  assert.equal(verifyFissionArtifacts(capture).mismatches.includes("missing:staged.diff"), true);
  chmodSync(packetRoot, 0o700);
  writeFileSync(stagedPath, stagedBytes, { mode: 0o400 });
  chmodSync(packetRoot, 0o500);
  assert.equal(verifyFissionArtifacts(capture).ok, true);

  capture.artifacts["unstaged.diff"].sections.push({ affectedPath: "nested.txt", lineStart: 1, lineEnd: 1 });
  const sectionMismatch = verifyFissionArtifacts(capture).mismatches;
  assert.equal(sectionMismatch.includes("sections:unstaged.diff"), true);
  assert.equal(sectionMismatch.includes("inventory:unstaged.diff"), true);
  capture.artifacts["unstaged.diff"].sections.pop();
  assert.equal(verifyFissionArtifacts(capture).ok, true);
});

test("manifest preserves exact omission reason for every unsupported path", () => {
  const repo = initRepo("omission-reasons");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "deleted.txt"), "delete me\n");
  git(repo, ["add", "binary.bin", "deleted.txt"]);
  git(repo, ["commit", "-m", "add deletion fixtures"]);
  rmSync(join(repo, "binary.bin"));
  rmSync(join(repo, "deleted.txt"));
  symlinkSync("tracked.txt", join(repo, "link.txt"));
  writeFileSync(join(repo, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  writeFileSync(join(repo, "nul.txt"), Buffer.from("before\0after"));
  writeFileSync(join(repo, "too-large.txt"), Buffer.alloc(FISSION_FILE_LIMIT + 1, 0x61));
  const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${head},gitlink`]);

  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "omission-reasons-packet");
  const capture = captureFissionPacket({
    cwd: repo,
    packetRoot,
    request: "review",
    preflight,
    deps: trusted,
  });
  const reasons = Object.fromEntries(capture.manifest.entries.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons["binary.bin"], "binary");
  assert.equal(reasons["deleted.txt"], "deleted");
  assert.equal(reasons["link.txt"], "symlink");
  assert.equal(reasons["invalid.txt"], "invalid_utf8");
  assert.equal(reasons["nul.txt"], "nul_content");
  assert.equal(reasons["too-large.txt"], "file_limit");
  assert.equal(reasons.gitlink, "submodule");
});

test("bounded valid text deletion remains complete while manifest labels deletion", () => {
  const repo = initRepo("complete-text-deletion");
  writeFileSync(join(repo, "delete.txt"), "ordinary text\n");
  git(repo, ["add", "delete.txt"]);
  git(repo, ["commit", "-m", "add text fixture"]);
  rmSync(join(repo, "delete.txt"));
  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "complete-text-deletion-packet");
  const capture = captureFissionPacket({ cwd: repo, packetRoot, request: "review", preflight, deps: trusted });
  const entry = capture.manifest.entries.find((candidate) => candidate.path === "delete.txt");

  assert.equal(capture.evidenceComplete, true);
  assert.equal(capture.baseline.evidenceComplete, true);
  assert.equal(Object.hasOwn(capture.baseline.omissionReasons, "delete.txt"), false);
  assert.equal(entry.included, false);
  assert.equal(entry.reason, "deleted");
  assert.match(readFileSync(join(packetRoot, "unstaged.diff"), "utf8"), /ordinary text/);
});

test("unmatched unsafe markers in either patch buffer fail closed globally", () => {
  const markers = [
    ["GIT binary patch", "binary"],
    ["Binary files x and y differ", "binary"],
    ["new file mode 160000", "submodule"],
    ["Subproject commit deadbeef", "submodule"],
    ["new file mode 120000", "symlink"],
    ["deleted file mode 120000", "symlink"],
    ["old mode 120000", "symlink"],
    ["new mode 120000", "symlink"],
  ];
  for (const patchField of ["staged", "unstaged"]) {
    for (const [marker, reason] of markers) {
      const baseline = captureBoundedDirtyBaseline(root, undefined, {
        repositoryRoot: () => root,
        readRegularFileNoFollow: () => ({
          bytes: Buffer.from("safe text\n"), mode: 0o100644, size: 10, executable: false,
        }),
        spawnSync: (_command, args) => ({
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
            : args[0] === "status" ? Buffer.from(" M tracked.txt\0")
              : args.includes("--cached") === (patchField === "staged")
                ? Buffer.from(`${marker}\n`) : Buffer.alloc(0),
        }),
      });
      assert.equal(baseline.evidenceComplete, false, `${patchField}: ${marker}`);
      assert.equal(baseline.reason, reason, `${patchField}: ${marker}`);
      assert.equal(baseline.retainedFiles.length, 1, "safe current file remains available");
    }
  }
});

test("diff artifacts inventory exact sections for modifications, additions, deletions, renames, and quoted UTF-8 paths", () => {
  const repo = initRepo("diff-section-ownership");
  writeFileSync(join(repo, "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(repo, "space name.mjs"), "export const spaced = 1;\n");
  writeFileSync(join(repo, "delete.mjs"), "export const gone = true;\n");
  writeFileSync(join(repo, "rename-old.mjs"), "export const renamed = true;\n");
  git(repo, ["add", "a.mjs", "space name.mjs", "delete.mjs", "rename-old.mjs"]);
  git(repo, ["commit", "-m", "section base"]);
  writeFileSync(join(repo, "a.mjs"), "export const a = 2;\n");
  writeFileSync(join(repo, "space name.mjs"), "export const spaced = 2;\n");
  writeFileSync(join(repo, "é-add.mjs"), "export const added = true;\n");
  rmSync(join(repo, "delete.mjs"));
  git(repo, ["mv", "rename-old.mjs", "rename-new.mjs"]);
  git(repo, ["add", "--all"]);

  const packetRoot = join(root, "diff-section-ownership-packet");
  const capture = captureFissionPacket({
    cwd: repo,
    packetRoot,
    request: "review",
    preflight: preflightFissionRepository(repo, trusted),
    deps: trusted,
  });
  const staged = capture.artifacts["staged.diff"];
  assert.deepEqual(staged.sections.map(({ affectedPath }) => affectedPath).sort(), [
    "a.mjs", "delete.mjs", "rename-new.mjs", "space name.mjs", "é-add.mjs",
  ]);
  assert.deepEqual(capture.manifest.artifacts.find(({ path }) => path === "staged.diff").sections, staged.sections);
  for (const section of staged.sections) {
    assert.equal(Number.isInteger(section.lineStart) && section.lineStart > 0, true);
    assert.equal(section.lineEnd >= section.lineStart, true);
    assert.equal(section.lineEnd <= staged.lineCount, true);
  }
  assert.equal(new Set(staged.sections.map(({ affectedPath }) => affectedPath)).size, staged.sections.length);
  assert.match(readFileSync(join(packetRoot, "staged.diff"), "utf8"), /\\303\\251-add\.mjs|é-add\.mjs/);
  assert.equal(verifyFissionArtifacts(capture).ok, true);
});

test("malformed or ambiguous diff headers fail section ownership closed", () => {
  for (const patch of [
    'diff --git "a/\\303" "b/\\303"\n--- "a/\\303"\n+++ "b/\\303"\n',
    "diff --git a/a.mjs b/a.mjs\ndiff --git a/a.mjs b/a.mjs\n",
  ]) {
    const baseline = captureBoundedDirtyBaseline(root, undefined, {
      repositoryRoot: () => root,
      readRegularFileNoFollow: () => ({ bytes: Buffer.from("safe\n"), mode: 0o100644, size: 5, executable: false }),
      spawnSync: (_command, args) => ({
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
          : args[0] === "status" ? Buffer.from(" M a.mjs\0")
            : args.includes("--cached") ? Buffer.from(patch) : Buffer.alloc(0),
      }),
    });
    assert.equal(baseline.evidenceComplete, false);
    assert.equal(baseline.reason, "patch_sections");
  }
});

test("global symlink mode detection survives an unmatched quoted header", () => {
  const baseline = captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => ({ bytes: Buffer.from("safe\n"), mode: 0o100644, size: 5, executable: false }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? Buffer.from(" M a.mjs\0")
          : args.includes("--cached")
            ? Buffer.from('diff --git "a/unterminated b/a.mjs\nnew file mode 120000\n')
            : Buffer.alloc(0),
    }),
  });
  assert.equal(baseline.evidenceComplete, false);
  assert.equal(baseline.reason, "symlink");
});

test("deleting a quoted non-ASCII symlink is globally incomplete evidence", () => {
  const repo = initRepo("quoted-symlink-deletion");
  symlinkSync("tracked.txt", join(repo, "é-link"));
  git(repo, ["add", "é-link"]);
  git(repo, ["commit", "-m", "add quoted symlink"]);
  rmSync(join(repo, "é-link"));

  const baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  assert.match(baseline.unstagedPatch.toString("utf8"), /deleted file mode 120000/);
  assert.match(baseline.unstagedPatch.toString("utf8"), /\\303\\251-link|é-link/);
  assert.equal(baseline.evidenceComplete, false);
  assert.equal(baseline.reason, "symlink:é-link");
});

test("canonical patch capture ignores configured external diff and color while retaining unsafe markers", () => {
  const repo = initRepo("canonical-patch");
  const external = join(repo, "external-diff.sh");
  writeFileSync(external, "#!/bin/sh\nprintf 'EXTERNAL_DIFF_SECRET\\nGIT binary patch\\n'\n");
  chmodSync(external, 0o755);
  git(repo, ["config", "diff.external", external]);
  git(repo, ["config", "color.ui", "always"]);
  writeFileSync(join(repo, "tracked.txt"), "changed\n");

  const baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  const patch = baseline.unstagedPatch.toString("utf8");
  assert.match(patch, /^diff --git /m);
  assert.doesNotMatch(patch, /EXTERNAL_DIFF_SECRET|\u001b\[/);

  const synthetic = captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => ({ bytes: Buffer.from("safe\n"), mode: 0o100644, size: 5, executable: false }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? Buffer.from(" M tracked.txt\0")
          : args.includes("--cached") ? Buffer.from("GIT binary patch\n") : Buffer.alloc(0),
    }),
  });
  assert.equal(synthetic.evidenceComplete, false);
  assert.equal(synthetic.reason, "binary");
});

test("patch omission reasons match exact paths rather than path prefixes", () => {
  const repo = initRepo("omission-path-prefix");
  writeFileSync(join(repo, "foo"), "text file\n");
  writeFileSync(join(repo, "foobar"), Buffer.from([0, 1, 2]));
  git(repo, ["add", "foobar"]);
  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "omission-path-prefix-packet");
  const capture = captureFissionPacket({ cwd: repo, packetRoot, request: "review", preflight, deps: trusted });
  const entries = Object.fromEntries(capture.manifest.entries.map((entry) => [entry.path, entry]));
  assert.equal(entries.foo.included, true);
  assert.equal(entries.foo.reason, null);
  assert.equal(entries.foobar.included, false);
  assert.equal(entries.foobar.reason, "binary");
});

test("manifest records unsupported_type for a Git-enumerated FIFO", () => {
  const status = Buffer.from("?? pipe\0");
  const head = Buffer.from("abc123\n");
  const packetRoot = join(root, "fifo-reason-packet");
  const deps = {
    isProjectTrusted: () => true,
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => {
      throw new Error("Unsupported source type: pipe");
    },
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? head
        : args[0] === "status" ? status
          : args[0] === "symbolic-ref" ? Buffer.from("refs/heads/main\n")
            : Buffer.alloc(0),
    }),
  };
  const capture = captureFissionPacket({
    cwd: root,
    packetRoot,
    request: "review",
    preflight: { state: "READY", repoRoot: root, head, status, detached: false },
    deps,
  });
  assert.equal(capture.manifest.entries[0].path, "pipe");
  assert.equal(capture.manifest.entries[0].reason, "unsupported_type");
});

test("manifest records file-total omission and is the only readable identity-free manifest", () => {
  const repo = initRepo("file-total-reason");
  for (let index = 0; index < 9; index += 1) {
    writeFileSync(join(repo, `large-${index}.txt`), Buffer.alloc(FISSION_FILE_LIMIT, 0x61));
  }
  const preflight = preflightFissionRepository(repo, trusted);
  const packetRoot = join(root, "file-total-reason-packet");
  const capture = captureFissionPacket({
    cwd: repo,
    packetRoot,
    request: "review",
    preflight,
    deps: trusted,
  });
  const omitted = capture.manifest.entries.filter((entry) => !entry.included);
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].reason, "file_total_limit");

  const manifests = [];
  const scan = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) scan(join(directory, entry.name), child);
      else if (entry.name.endsWith(".json")) manifests.push(child);
    }
  };
  scan(packetRoot);
  assert.deepEqual(manifests, ["review-packet.json"]);
  assert.equal(statSync(join(packetRoot, "review-packet.json")).mode & 0o444, 0o400);
  const manifestText = readFileSync(join(packetRoot, "review-packet.json"), "utf8");
  assert.deepEqual(JSON.parse(manifestText), capture.manifest);
  assert.doesNotMatch(manifestText, /reviewer|judge|credential|identity|api[_-]?key/i);
});

test("file-total omissions do not consume capacity from later retained files", () => {
  const contents = {
    "a.txt": Buffer.from("aaaaaa"),
    "b.txt": Buffer.from("bbbbbb"),
    "c.txt": Buffer.from("cccc"),
  };
  const baseline = captureBoundedDirtyBaseline(root, { file: 10, fileTotal: 10 }, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: (_repo, path) => ({
      bytes: contents[path], mode: 0o100644, size: contents[path].length, executable: false,
    }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? Buffer.from("?? a.txt\0?? b.txt\0?? c.txt\0")
          : Buffer.alloc(0),
    }),
  });
  assert.deepEqual(baseline.retainedFiles.map((file) => file.path), ["a.txt", "c.txt"]);
  assert.equal(baseline.omissionReasons["b.txt"], "file_total_limit");
});

test("request limit accepts the exact boundary and rejects one byte over before writes", () => {
  const repo = initRepo("request-limit");
  writeFileSync(join(repo, "tracked.txt"), "dirty\n");
  const acceptedRoot = join(root, "request-limit-accepted");
  captureFissionPacket({
    cwd: repo,
    packetRoot: acceptedRoot,
    request: "x".repeat(FISSION_REQUEST_LIMIT),
    preflight: preflightFissionRepository(repo, trusted),
    deps: trusted,
  });
  assert.equal(readFileSync(join(acceptedRoot, "request.txt")).length, FISSION_REQUEST_LIMIT);

  const refusedRoot = join(root, "request-limit-refused");
  assert.throws(() => captureFissionPacket({
    cwd: repo,
    packetRoot: refusedRoot,
    request: "x".repeat(FISSION_REQUEST_LIMIT + 1),
    preflight: preflightFissionRepository(repo, trusted),
    deps: trusted,
  }), /request_limit/);
  assert.equal(existsSync(refusedRoot), false);
  assert.throws(() => captureFissionPacket({
    cwd: repo,
    packetRoot: join(root, "request-utf8-refused"),
    request: "review \ud800",
    preflight: preflightFissionRepository(repo, trusted),
    deps: trusted,
  }), /request_utf8/);
  assert.equal(existsSync(join(root, "request-utf8-refused")), false);
});

test("HEAD, status, patches, file, and retained-total exact limits are accepted", () => {
  const head = Buffer.alloc(FISSION_HEAD_LIMIT, 0x61);
  head[head.length - 1] = 0x0a;
  const emptyCapture = (status, stagedPatch, unstagedPatch) => captureBoundedDirtyBaseline(
    root,
    undefined,
    {
      repositoryRoot: () => root,
      spawnSync: (_command, args) => ({
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: args[0] === "rev-parse" ? head
          : args[0] === "status" ? status
            : args.includes("--cached") ? stagedPatch : unstagedPatch,
      }),
    },
  );
  const headBoundary = emptyCapture(Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  assert.equal(headBoundary.head.length, FISSION_HEAD_LIMIT);
  assert.equal(headBoundary.head.at(-1), 0x0a, "HEAD terminator is retained");

  const longDeletedPath = "a".repeat(FISSION_STATUS_LIMIT - 4);
  const status = Buffer.from(` D ${longDeletedPath}\0`);
  assert.equal(status.length, FISSION_STATUS_LIMIT);
  assert.equal(emptyCapture(status, Buffer.alloc(0), Buffer.alloc(0)).status.length, FISSION_STATUS_LIMIT);

  const stagedPatch = Buffer.alloc(FISSION_PATCH_LIMIT / 2, 0x78);
  const unstagedPatch = Buffer.alloc(FISSION_PATCH_LIMIT / 2, 0x79);
  const patchBoundary = emptyCapture(Buffer.alloc(0), stagedPatch, unstagedPatch);
  assert.equal(patchBoundary.stagedPatch.length + patchBoundary.unstagedPatch.length, FISSION_PATCH_LIMIT);

  const paths = Array.from({ length: 8 }, (_, index) => `file-${index}.txt`);
  const fileStatus = Buffer.from(`${paths.map((path) => `?? ${path}`).join("\0")}\0`);
  const fileBytes = Buffer.alloc(FISSION_FILE_LIMIT, 0x61);
  const fileBoundary = captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => ({
      bytes: fileBytes,
      mode: 0o100644,
      size: fileBytes.length,
      executable: false,
    }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? fileStatus : Buffer.alloc(0),
    }),
  });
  assert.equal(fileBoundary.retainedFiles[0].bytes.length, FISSION_FILE_LIMIT);
  assert.equal(
    fileBoundary.retainedFiles.reduce((total, file) => total + file.bytes.length, 0),
    FISSION_FILE_TOTAL_LIMIT,
  );
  assert.equal(fileBoundary.evidenceComplete, true);
});

test("exact +1 evidence limits reject or omit without retaining truncated bytes", () => {
  const globalCases = [
    ["head_limit", FISSION_HEAD_LIMIT + 1, 0, 0, 0],
    ["status_limit", 1, FISSION_STATUS_LIMIT + 1, 0, 0],
    ["patch_limit", 1, 0, FISSION_PATCH_LIMIT, 1],
  ];
  for (const [reason, headSize, statusSize, stagedSize, unstagedSize] of globalCases) {
    let call = 0;
    assert.throws(() => captureBoundedDirtyBaseline(root, undefined, {
      repositoryRoot: () => root,
      spawnSync: () => ({
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: [
          Buffer.alloc(headSize),
          Buffer.alloc(statusSize),
          Buffer.alloc(stagedSize),
          Buffer.alloc(unstagedSize),
        ][call++],
      }),
    }), new RegExp(reason));
  }

  const oversized = Buffer.alloc(FISSION_FILE_LIMIT + 1, 0x61);
  const baseline = captureBoundedDirtyBaseline(root, undefined, {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => {
      throw new Error("file_limit:oversized.txt");
    },
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? Buffer.from("head\n")
        : args[0] === "status" ? Buffer.from("?? oversized.txt\0") : Buffer.alloc(0),
    }),
  });
  assert.equal(oversized.length, FISSION_FILE_LIMIT + 1);
  assert.equal(baseline.retainedFiles.length, 0);
  assert.equal(baseline.omissionReasons["oversized.txt"], "file_limit");
});

test("special paths, deletion, mode change, and intent-to-add retain exact Git state", () => {
  const repo = initRepo("special-git-state");
  writeFileSync(join(repo, "delete.txt"), "delete\n");
  writeFileSync(join(repo, "mode.sh"), "#!/bin/sh\n");
  git(repo, ["add", "delete.txt", "mode.sh"]);
  git(repo, ["commit", "-m", "special base"]);
  rmSync(join(repo, "delete.txt"));
  chmodSync(join(repo, "mode.sh"), 0o755);
  for (const path of ["line\nbreak.txt", "tab\tpath.txt", "-leading.txt"]) {
    writeFileSync(join(repo, path), `${path}\n`);
  }
  writeFileSync(join(repo, "intent.txt"), "intent\n");
  git(repo, ["add", "-N", "--", "intent.txt"]);

  const baseline = captureBoundedDirtyBaseline(repo, undefined, trusted);
  for (const path of ["line\nbreak.txt", "tab\tpath.txt", "-leading.txt", "intent.txt", "mode.sh"]) {
    assert.equal(baseline.retainedFiles.some((file) => file.path === path), true, path);
  }
  assert.equal(baseline.entries.find((entry) => entry.path === "delete.txt").deleted, true);
  assert.equal(Object.hasOwn(baseline.omissionReasons, "delete.txt"), false);
  assert.equal(baseline.retainedFiles.find((file) => file.path === "mode.sh").executable, true);
  assert.equal(baseline.entries.find((entry) => entry.path === "intent.txt").xy, " A");
});

test("source recapture detects HEAD, status, each patch, and file bytes independently", () => {
  const state = {
    head: Buffer.from("head-a\n"),
    status: Buffer.from("?? file.txt\0"),
    staged: Buffer.from("staged-a\n"),
    unstaged: Buffer.from("unstaged-a\n"),
    file: Buffer.from("file-a\n"),
  };
  const deps = {
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => ({
      bytes: state.file,
      mode: 0o100644,
      size: state.file.length,
      executable: false,
    }),
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? state.head
        : args[0] === "status" ? state.status
          : args.includes("--cached") ? state.staged : state.unstaged,
    }),
  };
  const baseline = captureBoundedDirtyBaseline(root, undefined, deps);
  const capture = { repoRoot: root, sourceDigest: baseline.sourceDigest };
  for (const [field, changed] of [
    ["head", Buffer.from("head-b\n")],
    ["status", Buffer.from("?? gile.txt\0")],
    ["staged", Buffer.from("staged-b\n")],
    ["unstaged", Buffer.from("unstaged-b\n")],
    ["file", Buffer.from("file-b\n")],
  ]) {
    const original = state[field];
    state[field] = changed;
    assert.equal(recaptureFissionSource(capture, deps).ok, false, field);
    state[field] = original;
    assert.equal(recaptureFissionSource(capture, deps).ok, true, `${field} restored`);
  }
});

test("immediate source mismatch deletes the attempt and returns incomplete capture", () => {
  const status = Buffer.from("?? file.txt\0");
  const head = Buffer.from("head\n");
  let readCount = 0;
  const deps = {
    isProjectTrusted: () => true,
    repositoryRoot: () => root,
    readRegularFileNoFollow: () => {
      const bytes = Buffer.from(readCount++ === 0 ? "before\n" : "after\n");
      return { bytes, mode: 0o100644, size: bytes.length, executable: false };
    },
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? head
        : args[0] === "status" ? status
          : args[0] === "symbolic-ref" ? Buffer.from("refs/heads/main\n")
            : Buffer.alloc(0),
    }),
  };
  const packetRoot = join(root, "immediate-mismatch-packet");
  const capture = captureFissionPacket({
    cwd: root,
    packetRoot,
    request: "review",
    preflight: { state: "READY", repoRoot: root, head, status, detached: false },
    deps,
  });
  assert.equal(capture.evidenceComplete, false);
  assert.equal(capture.reason, "source_drift");
  assert.equal(existsSync(packetRoot), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith("immediate-mismatch-packet.attempt-")), false);
});

test("invalid UTF-8 patch evidence is refused before packet writes", () => {
  const status = Buffer.from(" D deleted.txt\0");
  const head = Buffer.from("head\n");
  const deps = {
    isProjectTrusted: () => true,
    repositoryRoot: () => root,
    spawnSync: (_command, args) => ({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: args[0] === "rev-parse" ? head
        : args[0] === "status" ? status
          : args[0] === "symbolic-ref" ? Buffer.from("refs/heads/main\n")
            : args.includes("--cached") ? Buffer.from([0xc3, 0x28])
              : Buffer.alloc(0),
    }),
  };
  const packetRoot = join(root, "invalid-patch-packet");
  assert.throws(() => captureFissionPacket({
    cwd: root,
    packetRoot,
    request: "review",
    preflight: { state: "READY", repoRoot: root, head, status, detached: false },
    deps,
  }), /invalid_utf8/);
  assert.equal(existsSync(packetRoot), false);
  assert.equal(readdirSync(root).some((name) => name.startsWith("invalid-patch-packet.attempt-")), false);
});

test("subject packet freezes freeform text without a git repository", () => {
  const packetRoot = join(root, "subject-packet");
  const request = "Critique this product idea:\n1. Ship free tier\n2. Skip auth\n";
  const capture = captureFissionSubjectPacket({ packetRoot, request });
  assert.equal(capture.kind, "subject");
  assert.equal(capture.evidenceComplete, true);
  assert.equal(capture.repoRoot, null);
  assert.ok(capture.packetDigest);
  assert.ok(capture.sourceDigest);
  assert.equal(capture.manifest.kind, "subject");
  assert.equal(capture.manifest.entries.length, 1);
  assert.equal(capture.manifest.entries[0].path, FISSION_SUBJECT_PATH);
  assert.equal(capture.manifest.entries[0].artifactPath, FISSION_SUBJECT_PATH);
  assert.equal(
    readFileSync(join(packetRoot, FISSION_SUBJECT_PATH), "utf8"),
    request,
  );
  assert.equal(readFileSync(join(packetRoot, "request.txt"), "utf8"), request);
  assert.deepEqual(recaptureFissionSource(capture), {
    ok: true,
    digest: capture.sourceDigest,
  });
  assert.equal(verifyFissionArtifacts(capture).ok, true);
});

test("subject packet recapture detects tampering", () => {
  const packetRoot = join(root, "subject-tamper");
  const capture = captureFissionSubjectPacket({
    packetRoot,
    request: "original subject body",
  });
  chmodSync(packetRoot, 0o700);
  const subjectPath = join(packetRoot, FISSION_SUBJECT_PATH);
  chmodSync(subjectPath, 0o600);
  writeFileSync(subjectPath, "tampered", { mode: 0o600 });
  chmodSync(subjectPath, 0o400);
  const recapture = recaptureFissionSource(capture);
  assert.equal(recapture.ok, false);
  assert.equal(recapture.reason, "source_drift");
});

test("subject packet rejects empty and oversize requests", () => {
  assert.throws(
    () => captureFissionSubjectPacket({ packetRoot: join(root, "empty"), request: "" }),
    /empty_request/,
  );
  assert.throws(
    () =>
      captureFissionSubjectPacket({
        packetRoot: join(root, "huge"),
        request: "x".repeat(FISSION_REQUEST_LIMIT + 1),
      }),
    /request_limit/,
  );
});
