import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { canonicalJson } from "../../packages/pi-teams/src/core/compiler.ts";
import { TEAM_LIMITS } from "../../packages/pi-teams/src/core/limits.ts";
import { createFileArtifactStore } from "../../packages/pi-teams/src/storage/file-artifact-store.ts";

const PROJECT_ID = "a".repeat(64);
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_RUN_ID = "123e4567-e89b-42d3-a456-426614174001";
const MEMBER_ID = "architecture";

function memberResult(overrides = {}) {
  return {
    ok: true,
    text: "evidence\n",
    model: "provider/model",
    usage: { input: 11, output: 7, costUsd: 0.25 },
    ...overrides,
  };
}

async function makeAuthority(root) {
  const project = join(root, PROJECT_ID);
  const run = join(project, RUN_ID);
  const artifacts = join(run, "artifacts");
  await realFs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  for (const path of [root, project, run, artifacts]) await realFs.chmod(path, 0o700);
  return { project, run, artifacts };
}

async function withFixture(run, options = {}) {
  const parent = await realFs.mkdtemp(join(tmpdir(), "teams-artifacts-"));
  const root = join(parent, "store");
  try {
    const paths = await makeAuthority(root);
    return await run({
      parent,
      root,
      ...paths,
      store: createFileArtifactStore({ root, ...options }),
    });
  } finally {
    await realFs.rm(parent, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function trackingFs(operations, opened) {
  return {
    ...realFs,
    async mkdir(path, options) {
      operations.push(`mkdir:${String(path)}`);
      return realFs.mkdir(path, options);
    },
    async open(path, flags, mode) {
      opened.push({ path: String(path), flags, mode });
      const handle = await realFs.open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod") {
            return async (requestedMode) => {
              operations.push(`chmod:${String(path)}:${requestedMode.toString(8)}`);
              return target.chmod(requestedMode);
            };
          }
          if (property === "sync") {
            return async () => {
              operations.push(`sync:${String(path)}`);
              return target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

// Break caught: artifacts are not exact, deterministic, private, durable, or verified on return.
test("writes and re-verifies deterministic durable member artifacts", async () => {
  const operations = [];
  const opened = [];
  await withFixture(async ({ artifacts, store }) => {
    const result = memberResult();
    const ref = await store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, result);
    const memberDirectory = join(artifacts, MEMBER_ID);
    const outputPath = join(memberDirectory, "output.md");
    const resultPath = join(memberDirectory, "result.json");
    const outputBytes = await realFs.readFile(outputPath);
    const persistedResult = await realFs.readFile(resultPath);
    const expectedEnvelope = {
      runId: RUN_ID,
      memberId: MEMBER_ID,
      ok: result.ok,
      model: result.model,
      usage: result.usage,
    };

    assert.deepEqual(ref, {
      memberId: MEMBER_ID,
      outputPath: "artifacts/architecture/output.md",
      resultPath: "artifacts/architecture/result.json",
      outputBytes: outputBytes.byteLength,
      outputSha256: sha256(outputBytes),
      resultBytes: persistedResult.byteLength,
      resultSha256: sha256(persistedResult),
    });
    assert.equal(outputBytes.toString("utf8"), "evidence\n");
    assert.equal(persistedResult.toString("utf8"), canonicalJson(expectedEnvelope));
    assert.ok(!persistedResult.toString("utf8").includes("evidence"));
    assert.equal((await realFs.stat(memberDirectory)).mode & 0o777, 0o700);
    assert.equal((await realFs.stat(outputPath)).mode & 0o777, 0o600);
    assert.equal((await realFs.stat(resultPath)).mode & 0o777, 0o600);
    assert.deepEqual(await store.readVerified(PROJECT_ID, RUN_ID, ref), {
      text: result.text,
      result,
    });

    const writes = opened.filter(({ path }) => /(?:output\.md|result\.json)$/.test(path));
    assert.equal(writes.length >= 4, true);
    for (const { flags } of writes.slice(0, 2)) {
      assert.notEqual(flags & constants.O_EXCL, 0);
      assert.notEqual(flags & constants.O_NOFOLLOW, 0);
    }
    assert.ok(operations.some((entry) => entry.endsWith("architecture:700")));
    assert.ok(operations.some((entry) => entry.endsWith("output.md:600")));
    assert.ok(operations.some((entry) => entry.endsWith("result.json:600")));
    const outputSync = operations.findIndex((entry) => entry.endsWith("output.md"));
    const resultSync = operations.findIndex((entry) => entry.endsWith("result.json"));
    const directorySync = operations.findLastIndex((entry) => entry.endsWith("architecture"));
    assert.ok(outputSync >= 0 && resultSync > outputSync && directorySync > resultSync);

    await assert.rejects(
      () => store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, result),
      /artifact_exists:/,
    );
  }, { fs: trackingFs(operations, opened) });
});

// Break caught: failed results omit their stable error or persist a second copy of text.
test("round-trips the optional failure error in canonical result JSON", async () => {
  await withFixture(async ({ artifacts, store }) => {
    const result = memberResult({ ok: false, text: "partial", model: null, error: "timed out" });
    const ref = await store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, result);
    const encoded = await realFs.readFile(join(artifacts, MEMBER_ID, "result.json"), "utf8");
    assert.equal(encoded, canonicalJson({
      runId: RUN_ID,
      memberId: MEMBER_ID,
      ok: false,
      model: null,
      usage: result.usage,
      error: "timed out",
    }));
    assert.deepEqual(await store.readVerified(PROJECT_ID, RUN_ID, ref), {
      text: "partial",
      result,
    });
  });
});

// Break caught: path components are joined before exact project/run/member validation.
test("rejects invalid identifiers before any filesystem access", async () => {
  let calls = 0;
  const untouchedFs = new Proxy(realFs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args) => {
        calls += 1;
        return value(...args);
      };
    },
  });
  const store = createFileArtifactStore({ root: "/never-used", fs: untouchedFs });
  const invalidProjects = ["", "A".repeat(64), "../" + "a".repeat(64), "/tmp"];
  const invalidRuns = ["", "../run", RUN_ID.toUpperCase(), "/tmp/run"];
  const invalidMembers = ["", "Architecture", ".", "..", "a/b", "a\\b", "/tmp"];

  for (const projectId of invalidProjects) {
    await assert.rejects(() => store.writeMember(projectId, RUN_ID, MEMBER_ID, memberResult()), /artifact_project_id:/);
  }
  for (const runId of invalidRuns) {
    await assert.rejects(() => store.writeMember(PROJECT_ID, runId, MEMBER_ID, memberResult()), /artifact_run_id:/);
  }
  for (const memberId of invalidMembers) {
    await assert.rejects(() => store.writeMember(PROJECT_ID, RUN_ID, memberId, memberResult()), /artifact_member_id:/);
  }
  assert.equal(calls, 0);
});

// Break caught: malformed result shapes, invalid UTF-16, or non-finite usage become durable authority.
test("validates the exact member result before creating its directory", async () => {
  const cases = [
    [null, /artifact_result:/],
    [{ ...memberResult(), extra: true }, /artifact_result:/],
    [{ ...memberResult(), usage: { input: 1, output: 2, costUsd: null, extra: 1 } }, /artifact_usage:/],
    [{ ...memberResult(), usage: { input: -1, output: 2, costUsd: null } }, /artifact_usage:/],
    [{ ...memberResult(), usage: { input: 1.5, output: 2, costUsd: null } }, /artifact_usage:/],
    [{ ...memberResult(), usage: { input: 1, output: 2, costUsd: Number.NaN } }, /artifact_usage:/],
    [{ ...memberResult(), model: 3 }, /artifact_model:/],
    [{ ...memberResult(), ok: "yes" }, /artifact_ok:/],
    [{ ...memberResult(), text: "bad\ud800" }, /artifact_utf8:/],
    [{ ...memberResult(), error: "bad\ud800" }, /artifact_utf8:/],
  ];
  for (const [candidate, expected] of cases) {
    await withFixture(async ({ artifacts, store }) => {
      await assert.rejects(
        () => store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, candidate),
        expected,
      );
      await assert.rejects(() => realFs.lstat(join(artifacts, MEMBER_ID)), { code: "ENOENT" });
    });
  }
});

// Break caught: output/result ceilings are exclusive or checked only after an unbounded Buffer allocation.
test("enforces inclusive output and result byte ceilings before durable writes", async () => {
  await withFixture(async ({ store }) => {
    const exact = "x".repeat(TEAM_LIMITS.outputBytes);
    const ref = await store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, memberResult({ text: exact }));
    assert.equal(ref.outputBytes, TEAM_LIMITS.outputBytes);
    assert.equal((await store.readVerified(PROJECT_ID, RUN_ID, ref)).text.length, TEAM_LIMITS.outputBytes);
  });

  await withFixture(async ({ store }) => {
    const base = canonicalJson({
      runId: RUN_ID,
      memberId: MEMBER_ID,
      ok: false,
      model: null,
      usage: { input: 11, output: 7, costUsd: 0.25 },
      error: "",
    });
    const error = "x".repeat(TEAM_LIMITS.resultBytes - Buffer.byteLength(base, "utf8"));
    const ref = await store.writeMember(
      PROJECT_ID,
      RUN_ID,
      MEMBER_ID,
      memberResult({ ok: false, model: null, error }),
    );
    assert.equal(ref.resultBytes, TEAM_LIMITS.resultBytes);
    assert.equal((await store.readVerified(PROJECT_ID, RUN_ID, ref)).result.error, error);
  });

  await withFixture(async ({ artifacts, store }) => {
    await assert.rejects(
      () => store.writeMember(
        PROJECT_ID,
        RUN_ID,
        MEMBER_ID,
        memberResult({ text: "x".repeat(TEAM_LIMITS.outputBytes + 1) }),
      ),
      /artifact_output_bytes:/,
    );
    await assert.rejects(() => realFs.lstat(join(artifacts, MEMBER_ID)), { code: "ENOENT" });
  });

  await withFixture(async ({ artifacts, store }) => {
    await assert.rejects(
      () => store.writeMember(
        PROJECT_ID,
        RUN_ID,
        MEMBER_ID,
        memberResult({ ok: false, error: "x".repeat(TEAM_LIMITS.resultBytes) }),
      ),
      /artifact_result_bytes:/,
    );
    await assert.rejects(() => realFs.lstat(join(artifacts, MEMBER_ID)), { code: "ENOENT" });
  });
});

async function writtenFixture(run, options = {}) {
  return withFixture(async (fixture) => {
    const ref = await fixture.store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, memberResult());
    return run({ ...fixture, ref, memberDirectory: join(fixture.artifacts, MEMBER_ID) });
  }, options);
}

// Break caught: event-provided paths, identities, byte counts, or digest strings influence file selection.
test("requires an exact trusted artifact reference before opening paths", async () => {
  await writtenFixture(async ({ store, ref }) => {
    const cases = [
      [{ ...ref, memberId: "risks" }, /artifact_path:/],
      [{ ...ref, memberId: "../architecture" }, /artifact_member_id:/],
      [{ ...ref, outputPath: "/tmp/output.md" }, /artifact_path:/],
      [{ ...ref, outputPath: "artifacts\\architecture\\output.md" }, /artifact_path:/],
      [{ ...ref, outputPath: "artifacts/./architecture/output.md" }, /artifact_path:/],
      [{ ...ref, outputPath: "artifacts/risks/../architecture/output.md" }, /artifact_path:/],
      [{ ...ref, resultPath: "artifacts/architecture/../architecture/result.json" }, /artifact_path:/],
      [{ ...ref, outputBytes: ref.outputBytes + 1 }, /artifact_size:/],
      [{ ...ref, resultBytes: ref.resultBytes + 1 }, /artifact_size:/],
      [{ ...ref, outputSha256: "A".repeat(64) }, /artifact_digest:/],
      [{ ...ref, resultSha256: "0" }, /artifact_digest:/],
      [{ ...ref, extra: true }, /artifact_ref:/],
    ];
    for (const [candidate, expected] of cases) {
      await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, candidate), expected);
    }
    await assert.rejects(() => store.readVerified(PROJECT_ID, OTHER_RUN_ID, ref), /artifact_directory_run:/);
  });
});

// Break caught: changed bytes, same-length changes, or malformed/canonicalized JSON are returned.
test("rejects output and result corruption before returning text", async () => {
  await writtenFixture(async ({ store, ref, memberDirectory }) => {
    await realFs.writeFile(join(memberDirectory, "output.md"), "changed!\n");
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_digest:/);
  });

  await writtenFixture(async ({ store, ref, memberDirectory }) => {
    const resultPath = join(memberDirectory, "result.json");
    const parsed = JSON.parse(await realFs.readFile(resultPath, "utf8"));
    await realFs.writeFile(resultPath, JSON.stringify(parsed, null, 2));
    const bytes = await realFs.readFile(resultPath);
    const changedRef = { ...ref, resultBytes: bytes.byteLength, resultSha256: sha256(bytes) };
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, changedRef), /artifact_canonical:/);
  });

  await writtenFixture(async ({ store, ref, memberDirectory }) => {
    const resultPath = join(memberDirectory, "result.json");
    await realFs.writeFile(resultPath, Buffer.from([0xff]));
    const bytes = await realFs.readFile(resultPath);
    const changedRef = { ...ref, resultBytes: bytes.byteLength, resultSha256: sha256(bytes) };
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, changedRef), /artifact_utf8:/);
  });

  await writtenFixture(async ({ store, ref, memberDirectory }) => {
    const outputPath = join(memberDirectory, "output.md");
    const bytes = Buffer.from([0xff]);
    await realFs.writeFile(outputPath, bytes);
    const changedRef = { ...ref, outputBytes: bytes.byteLength, outputSha256: sha256(bytes) };
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, changedRef), /artifact_utf8:/);
  });
});

// Break caught: result envelope identity or exact shape is not revalidated after digest verification.
test("rejects digest-consistent result identity, shape, and value tampering", async () => {
  const mutations = [
    (value) => ({ ...value, runId: OTHER_RUN_ID }),
    (value) => ({ ...value, memberId: "risks" }),
    (value) => ({ ...value, extra: true }),
    (value) => ({ ...value, usage: { ...value.usage, input: -1 } }),
    (value) => ({ ...value, ok: "yes" }),
  ];
  for (const mutate of mutations) {
    await writtenFixture(async ({ store, ref, memberDirectory }) => {
      const path = join(memberDirectory, "result.json");
      const value = mutate(JSON.parse(await realFs.readFile(path, "utf8")));
      const bytes = Buffer.from(canonicalJson(value), "utf8");
      await realFs.writeFile(path, bytes);
      const changedRef = { ...ref, resultBytes: bytes.byteLength, resultSha256: sha256(bytes) };
      await assert.rejects(
        () => store.readVerified(PROJECT_ID, RUN_ID, changedRef),
        /artifact_(identity|result|usage|ok):/,
      );
    });
  }
});

// Break caught: final files or authority directories can be replaced with symlinks and followed.
test("rejects symlinked artifact files and directories", async () => {
  await writtenFixture(async ({ parent, store, ref, memberDirectory }) => {
    const outside = join(parent, "outside-output");
    await realFs.writeFile(outside, "evidence\n", { mode: 0o600 });
    await realFs.unlink(join(memberDirectory, "output.md"));
    await realFs.symlink(outside, join(memberDirectory, "output.md"));
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_file_output:/);
  });

  await writtenFixture(async ({ parent, store, ref, memberDirectory }) => {
    const outside = join(parent, "outside-result");
    await realFs.writeFile(outside, await realFs.readFile(join(memberDirectory, "result.json")), { mode: 0o600 });
    await realFs.unlink(join(memberDirectory, "result.json"));
    await realFs.symlink(outside, join(memberDirectory, "result.json"));
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_file_result:/);
  });

  await writtenFixture(async ({ parent, artifacts, store, ref, memberDirectory }) => {
    const outside = join(parent, "outside-member");
    await realFs.rename(memberDirectory, outside);
    await realFs.symlink(outside, join(artifacts, MEMBER_ID));
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_directory_member:/);
  });

  await writtenFixture(async ({ parent, run, artifacts, store, ref }) => {
    const outside = join(parent, "outside-artifacts");
    await realFs.rename(artifacts, outside);
    await realFs.symlink(outside, join(run, "artifacts"));
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_directory_artifacts:/);
  });

  await withFixture(async ({ parent, artifacts, store }) => {
    const outside = join(parent, "outside-new-member");
    await realFs.mkdir(outside, { mode: 0o700 });
    await realFs.symlink(outside, join(artifacts, MEMBER_ID));
    await assert.rejects(
      () => store.writeMember(PROJECT_ID, RUN_ID, MEMBER_ID, memberResult()),
      /artifact_exists:/,
    );
    await assert.rejects(() => realFs.lstat(join(outside, "output.md")), { code: "ENOENT" });
  });
});

// Break caught: a lstat/open swap changes which inode is verified and read.
test("fails closed when a file is replaced between lstat and open", async () => {
  let armed = false;
  let swapped = false;
  let memberDirectory;
  const racingFs = {
    ...realFs,
    async lstat(path, options) {
      const stat = await realFs.lstat(path, options);
      if (armed && String(path).endsWith("output.md")) swapped = true;
      return stat;
    },
    async open(path, flags, mode) {
      if (armed && swapped && String(path).endsWith("output.md")) {
        swapped = false;
        await realFs.rename(join(memberDirectory, "output.md"), join(memberDirectory, "old-output.md"));
        await realFs.writeFile(join(memberDirectory, "output.md"), "evidence\n", { mode: 0o600 });
      }
      return realFs.open(path, flags, mode);
    },
  };
  await writtenFixture(async ({ store, ref, memberDirectory: directory }) => {
    memberDirectory = directory;
    armed = true;
    await assert.rejects(() => store.readVerified(PROJECT_ID, RUN_ID, ref), /artifact_file_output:/);
  }, { fs: racingFs });
});

// Break caught: oversized files are read/allocated before the descriptor size guard.
test("rejects oversized output and result descriptors before calling read", async () => {
  for (const [name, limit] of [["output.md", TEAM_LIMITS.outputBytes], ["result.json", TEAM_LIMITS.resultBytes]]) {
    let reads = 0;
    const observedFs = {
      ...realFs,
      async open(path, flags, mode) {
        const handle = await realFs.open(path, flags, mode);
        if (!String(path).endsWith(name)) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "read") {
              return async (...args) => {
                reads += 1;
                return target.read(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    await writtenFixture(async ({ store, ref, memberDirectory }) => {
      await realFs.truncate(join(memberDirectory, name), limit + 1);
      reads = 0;
      await assert.rejects(
        () => store.readVerified(PROJECT_ID, RUN_ID, ref),
        new RegExp(name === "output.md" ? "artifact_output_bytes:" : "artifact_result_bytes:"),
      );
      assert.equal(reads, 0, `${name} was read before its size ceiling was enforced`);
    }, { fs: observedFs });
  }
});
