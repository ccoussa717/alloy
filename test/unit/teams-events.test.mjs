import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  hashEvent,
  TEAM_EVENT_TYPES,
  validateEventHistory,
} from "../../packages/pi-teams/src/core/events.ts";
import { TEAM_LIMITS, ZERO_HASH } from "../../packages/pi-teams/src/core/limits.ts";
import { canonicalJson } from "../../packages/pi-teams/src/core/compiler.ts";
import { createFileEventStore } from "../../packages/pi-teams/src/storage/file-event-store.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_RUN_ID = "123e4567-e89b-42d3-a456-426614174001";
const OCCURRED_AT = "2026-09-04T12:00:00.000Z";

function withoutHash(event) {
  const { hash: _hash, ...rest } = event;
  return rest;
}

function chainedEvent(previous, overrides = {}) {
  const eventWithoutHash = {
    v: 1,
    runId: RUN_ID,
    seq: previous === undefined ? 1 : previous.seq + 1,
    type: "run.requested",
    actor: { kind: "system", id: "tester" },
    occurredAt: OCCURRED_AT,
    payload: {},
    prevHash: previous === undefined ? ZERO_HASH : previous.hash,
    ...overrides,
  };
  return { ...eventWithoutHash, hash: hashEvent(eventWithoutHash) };
}

function validHistory() {
  const requested = chainedEvent(undefined, {
    payload: { objective: "Map auth" },
  });
  const snapshotted = chainedEvent(requested, {
    type: "manifest.snapshotted",
    occurredAt: "2026-09-04T12:00:01Z",
    payload: { manifestDigest: "a".repeat(64) },
  });
  const completed = chainedEvent(snapshotted, {
    type: "run.completed",
    occurredAt: "2026-09-04T12:00:02.25Z",
  });
  return [requested, snapshotted, completed];
}

function rehash(event) {
  return { ...event, hash: hashEvent(withoutHash(event)) };
}

// Break caught: hashing omits the required newline or depends on insertion order.
test("event hashes canonical JSON plus one newline deterministically", () => {
  const first = chainedEvent(undefined, { payload: { objective: "Map auth" } });
  const reordered = {
    payload: { objective: "Map auth" },
    type: "run.requested",
    v: 1,
    actor: { id: "tester", kind: "system" },
    seq: 1,
    runId: RUN_ID,
    occurredAt: OCCURRED_AT,
    prevHash: ZERO_HASH,
  };

  assert.equal(
    first.hash,
    "8399dc4a67bc7100a3728adad232c46c7d22be8e44afb26e3844b1a133dacb2f",
  );
  assert.equal(hashEvent(reordered), first.hash);
  assert.notEqual(
    first.hash,
    createHash("sha256")
      .update(JSON.stringify(withoutHash(first)), "utf8")
      .digest("hex"),
  );
});

// Break caught: chain validation stops checking the first anchor, links, or recomputed hashes.
test("validates a deterministic contiguous hash chain", () => {
  const history = validHistory();
  const validated = validateEventHistory(history, RUN_ID);

  assert.equal(validated.length, 3);
  assert.equal(validated[0].seq, 1);
  assert.equal(validated[0].prevHash, ZERO_HASH);
  for (let index = 0; index < validated.length; index += 1) {
    assert.equal(hashEvent(withoutHash(validated[index])), validated[index].hash);
    if (index > 0) assert.equal(validated[index].prevHash, validated[index - 1].hash);
  }
});

// Break caught: malformed top-level records or unknown event types enter authority.
test("rejects non-exact event records and unknown types", () => {
  const first = validHistory()[0];
  const cases = [
    null,
    [],
    { ...first, extra: true },
    Object.assign(Object.create({ inherited: true }), first),
    { ...first, type: "run.unknown" },
    { ...first, v: 2 },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => validateEventHistory([candidate], RUN_ID),
      /event_(shape|type|version):/,
    );
  }
  assert.ok(Object.isFrozen(TEAM_EVENT_TYPES));
  assert.deepEqual(TEAM_EVENT_TYPES, [
    "run.requested", "manifest.snapshotted", "policy.admitted", "policy.blocked",
    "run.awaiting_approval", "approval.granted", "run.started", "member.ready",
    "member.started", "member.artifact_recorded", "member.succeeded",
    "member.failed", "budget.observed", "cancel.requested", "member.cancelled",
    "run.completed", "run.failed", "run.blocked", "run.cancelled",
  ]);
});

// Break caught: records from another or malformed run are accepted into this run's authority.
test("requires lowercase UUID run IDs matching the requested history", () => {
  const first = validHistory()[0];
  const malformed = [
    "123E4567-E89B-42D3-A456-426614174000",
    "not-a-uuid",
    "../../escape",
    "123e4567-e89b-42d3-c456-426614174000",
  ];

  for (const runId of malformed) {
    const candidate = rehash({ ...first, runId });
    assert.throws(() => validateEventHistory([candidate], runId), /event_run_id:/);
  }
  assert.throws(
    () => validateEventHistory([first], OTHER_RUN_ID),
    /event_run_id:/,
  );
});

// Break caught: duplicate, skipped, fractional, or reordered sequence numbers are accepted.
test("requires positive contiguous integer sequences", () => {
  const history = validHistory();
  for (const seq of [0, -1, 1.5, 2, Number.MAX_SAFE_INTEGER + 1]) {
    const candidate = rehash({ ...history[0], seq });
    assert.throws(() => validateEventHistory([candidate], RUN_ID), /event_sequence:/);
  }

  for (const seq of [1, 3]) {
    const second = rehash({ ...history[1], seq });
    assert.throws(
      () => validateEventHistory([history[0], second], RUN_ID),
      /event_sequence:/,
    );
  }
});

// Break caught: the zero anchor, previous link, stored hash, or payload integrity is not enforced.
test("rejects broken anchors, links, hashes, and changed payloads", () => {
  const history = validHistory();
  const wrongAnchor = rehash({ ...history[0], prevHash: "1".repeat(64) });
  const wrongLink = rehash({ ...history[1], prevHash: "2".repeat(64) });
  const badStoredHash = { ...history[1], hash: "f".repeat(64) };
  const changedPayload = { ...history[1], payload: { changed: true } };

  assert.throws(() => validateEventHistory([wrongAnchor], RUN_ID), /event_prev_hash:/);
  assert.throws(
    () => validateEventHistory([history[0], wrongLink], RUN_ID),
    /event_prev_hash:/,
  );
  for (const candidate of [badStoredHash, changedPayload]) {
    assert.throws(
      () => validateEventHistory([history[0], candidate], RUN_ID),
      /event_hash:/,
    );
  }
});

// Break caught: malformed actors, timestamps, payloads, or digests are treated as authority.
test("requires exact known actors, RFC 3339 UTC timestamps, plain payloads, and hashes", () => {
  const first = validHistory()[0];
  const invalidActors = [
    null,
    { kind: "operator", id: "tester" },
    { kind: "human", id: "" },
    { kind: "human", id: "tester", extra: true },
    Object.assign(Object.create(null), { kind: "human", id: "tester" }),
  ];
  for (const actor of invalidActors) {
    const candidate = rehash({ ...first, actor });
    assert.throws(() => validateEventHistory([candidate], RUN_ID), /event_actor:/);
  }

  for (const occurredAt of [
    "2026-09-04T12:00:00+00:00",
    "2026-09-04 12:00:00Z",
    "2026-09-04T12:00:00z",
    "2026-02-30T12:00:00Z",
    "not-a-time",
  ]) {
    const candidate = rehash({ ...first, occurredAt });
    assert.throws(() => validateEventHistory([candidate], RUN_ID), /event_timestamp:/);
  }

  for (const payload of [null, [], new Date()]) {
    const candidate = { ...first, payload, hash: "0".repeat(64) };
    assert.throws(() => validateEventHistory([candidate], RUN_ID), /event_payload:/);
  }
  const nullPrototypePayload = Object.assign(Object.create(null), { safe: true });
  assert.doesNotThrow(() => validateEventHistory([
    rehash({ ...first, payload: nullPrototypePayload }),
  ], RUN_ID));

  for (const hash of ["A".repeat(64), "0".repeat(63), "g".repeat(64)]) {
    assert.throws(
      () => validateEventHistory([{ ...first, hash }], RUN_ID),
      /event_hash:/,
    );
  }
});

// Break caught: a terminal event is followed by more authority or a second terminal.
test("allows at most one terminal event and only at the end", () => {
  const history = validHistory();
  assert.equal(validateEventHistory(history.slice(0, 2), RUN_ID).length, 2);
  assert.equal(validateEventHistory(history, RUN_ID).length, 3);

  const afterTerminal = chainedEvent(history[2], { type: "budget.observed" });
  const secondTerminal = chainedEvent(history[2], { type: "run.failed" });
  assert.throws(
    () => validateEventHistory([...history, afterTerminal], RUN_ID),
    /event_terminal:/,
  );
  assert.throws(
    () => validateEventHistory([...history, secondTerminal], RUN_ID),
    /event_terminal:/,
  );
});

// Break caught: empty or resource-unbounded in-memory histories are validated.
test("rejects empty, oversized-event, and over-count histories", () => {
  assert.throws(() => validateEventHistory([], RUN_ID), /event_history:/);

  const oversized = {
    ...validHistory()[0],
    payload: { text: "x".repeat(65_536) },
    hash: "0".repeat(64),
  };
  assert.throws(() => validateEventHistory([oversized], RUN_ID), /event_line_bytes:/);

  const repeated = Array.from({ length: 4_097 }, (_, index) => ({
    ...validHistory()[0],
    seq: index + 1,
  }));
  assert.throws(() => validateEventHistory(repeated, RUN_ID), /event_history_events:/);
});

const PROJECT_ID = "a".repeat(64);

function manifestSnapshot() {
  return {
    apiVersion: "pi.dev/teams/v1alpha1",
    kind: "Team",
    metadata: { name: "solo", description: "Read evidence." },
    spec: {
      limits: {
        maxConcurrency: 1,
        maxCostUsd: 1,
        timeoutMs: 1_000,
        maxMembers: 1,
      },
      members: [{
        id: "reader",
        route: "research",
        capabilities: ["repo.read"],
        tools: ["read"],
        needs: [],
        instructions: "Read evidence.",
      }],
    },
  };
}

function runSnapshotInput(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    manifest: manifestSnapshot(),
    request: {
      teamRef: "builtin/solo",
      objective: "Read the repository.",
      actor: { kind: "human", id: "operator" },
      requestedAt: OCCURRED_AT,
    },
    ...overrides,
  };
}

function draft(type, overrides = {}) {
  return {
    type,
    actor: { kind: "system", id: "teams" },
    occurredAt: OCCURRED_AT,
    payload: {},
    ...overrides,
  };
}

async function withStoreFixture(run, options = {}) {
  const parent = await realFs.mkdtemp(join(tmpdir(), "teams-events-"));
  const root = join(parent, "store");
  try {
    return await run({
      parent,
      root,
      store: createFileEventStore({
        root,
        now: () => OCCURRED_AT,
        randomUUID: () => OTHER_RUN_ID,
        ...options,
      }),
    });
  } finally {
    await realFs.rm(parent, { recursive: true, force: true });
  }
}

function trackingFs(syncPaths, opened) {
  return {
    ...realFs,
    async open(path, flags, mode) {
      opened.push({ path: String(path), flags, mode });
      const handle = await realFs.open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              syncPaths.push(String(path));
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

// Break caught: creation omits secure modes, exclusive claim, snapshots, or durable fsyncs.
test("file event store creates secure durable run authority and exclusively claims its ID", async () => {
  const syncPaths = [];
  const opened = [];
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const projectDir = join(root, PROJECT_ID);
    const runDir = join(projectDir, RUN_ID);

    for (const directory of [root, projectDir, runDir, join(runDir, "artifacts")]) {
      assert.equal((await realFs.stat(directory)).mode & 0o777, 0o700, directory);
    }
    for (const name of [
      "manifest.snapshot.json", "request.json", "events.jsonl", "writer.lock",
    ]) {
      assert.equal((await realFs.stat(join(runDir, name))).mode & 0o777, 0o600, name);
    }
    assert.deepEqual(
      JSON.parse(await realFs.readFile(join(runDir, "manifest.snapshot.json"), "utf8")),
      manifestSnapshot(),
    );
    assert.deepEqual(
      JSON.parse(await realFs.readFile(join(runDir, "request.json"), "utf8")),
      runSnapshotInput().request,
    );

    await assert.rejects(() => store.createRun(runSnapshotInput()), /event_writer_claimed:/);
    assert.ok(syncPaths.some((path) => path.endsWith("manifest.snapshot.json")));
    assert.ok(syncPaths.some((path) => path.endsWith("request.json")));
    assert.ok(syncPaths.some((path) => path.endsWith("writer.lock")));
    assert.ok(syncPaths.some((path) => path.endsWith(PROJECT_ID)));
    assert.ok(syncPaths.some((path) => path.endsWith(RUN_ID)));
    assert.ok(syncPaths.some((path) => path === root));

    const writableFiles = opened.filter(({ path }) =>
      /(?:events\.jsonl|writer\.lock|snapshot\.json|request\.json)$/.test(path)
    );
    assert.ok(writableFiles.length >= 4);
    for (const { flags } of writableFiles) {
      assert.equal(typeof flags, "number");
      assert.notEqual(flags & (constants.O_NOFOLLOW ?? 0), 0);
    }
    const eventOpen = writableFiles.find(({ path }) => path.endsWith("events.jsonl"));
    assert.notEqual(eventOpen.flags & constants.O_APPEND, 0);

    await writer.close();
  }, { fs: trackingFs(syncPaths, opened) });
});

// Break caught: caller mutation during creation changes immutable request/manifest snapshots.
test("createRun snapshots input at the call boundary", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const input = runSnapshotInput();
    const pending = store.createRun(input);
    input.manifest.metadata.description = "mutated";
    input.request.objective = "mutated";
    const writer = await pending;
    const runDir = join(root, PROJECT_ID, RUN_ID);

    assert.equal(
      JSON.parse(await realFs.readFile(join(runDir, "manifest.snapshot.json"), "utf8"))
        .metadata.description,
      "Read evidence.",
    );
    assert.equal(
      JSON.parse(await realFs.readFile(join(runDir, "request.json"), "utf8")).objective,
      "Read the repository.",
    );
    await writer.close();
  });
});

// Break caught: accessors or repeated reads substitute path identifiers after validation.
test("createRun captures exact snapshot data properties once before path use", async () => {
  await withStoreFixture(async ({ root, store }) => {
    let getterCalls = 0;
    const accessorSnapshot = runSnapshotInput();
    Object.defineProperty(accessorSnapshot, "projectId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("project getter invoked");
      },
    });
    await assert.rejects(
      () => store.createRun(accessorSnapshot),
      /event_run_snapshot:/,
    );
    assert.equal(getterCalls, 0);
    await assert.rejects(() => realFs.stat(root), { code: "ENOENT" });

    const target = runSnapshotInput();
    let propertyReads = 0;
    let ownKeyReads = 0;
    let descriptorReads = 0;
    const proxySnapshot = new Proxy(target, {
      ownKeys(object) {
        ownKeyReads += 1;
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
      get(object, property, receiver) {
        propertyReads += 1;
        if (property === "projectId") return "b".repeat(64);
        if (property === "runId") return OTHER_RUN_ID;
        return Reflect.get(object, property, receiver);
      },
    });
    await assert.rejects(
      () => store.createRun(proxySnapshot),
      /event_run_snapshot:/,
    );
    assert.equal(propertyReads, 0);
    assert.equal(ownKeyReads, 0);
    assert.equal(descriptorReads, 0);
    await assert.rejects(() => realFs.stat(root), { code: "ENOENT" });
  });
});

// Break caught: pre-existing store directories retain group/world permissions.
test("file event store tightens existing authority directories to mode 0700", async () => {
  await withStoreFixture(async ({ root, store }) => {
    await realFs.mkdir(join(root, PROJECT_ID), { recursive: true, mode: 0o755 });
    await realFs.chmod(root, 0o755);
    await realFs.chmod(join(root, PROJECT_ID), 0o755);

    const writer = await store.createRun(runSnapshotInput());
    assert.equal((await realFs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await realFs.stat(join(root, PROJECT_ID))).mode & 0o777, 0o700);
    await writer.close();
  });
});

// Break caught: restrictive umask leaves created files/directories less permissive than exact modes.
test("creation fchmods every file and descriptor-verifies/chmods every authority directory", async () => {
  const chmods = [];
  const observedFs = {
    ...realFs,
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod") {
            return async (requestedMode) => {
              chmods.push({ path: String(path), mode: requestedMode });
              return target.chmod(requestedMode);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };

  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const requiredDirectories = ["store", PROJECT_ID, RUN_ID, "artifacts"];
    const requiredFiles = [
      "writer.lock", "manifest.snapshot.json", "request.json", "events.jsonl",
    ];
    for (const suffix of requiredDirectories) {
      assert.ok(chmods.some(({ path, mode }) => path.endsWith(suffix) && mode === 0o700), suffix);
    }
    for (const suffix of requiredFiles) {
      assert.ok(chmods.some(({ path, mode }) => path.endsWith(suffix) && mode === 0o600), suffix);
    }
    await writer.close();
  }, { fs: observedFs });
});

// Break caught: newly created nested root entries are not synced through each parent in order.
test("creation fsyncs each new directory before its parent entry boundary", async () => {
  const operations = [];
  const observedFs = {
    ...realFs,
    async mkdir(path, options) {
      operations.push(`mkdir:${String(path)}`);
      return realFs.mkdir(path, options);
    },
    async open(path, flags, mode) {
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

  const parent = await realFs.mkdtemp(join(tmpdir(), "teams-events-sync-"));
  const root = join(parent, "level-one", "level-two", "store");
  try {
    const store = createFileEventStore({
      root,
      now: () => OCCURRED_AT,
      randomUUID: () => OTHER_RUN_ID,
      fs: observedFs,
    });
    const writer = await store.createRun(runSnapshotInput());

    for (const child of ["level-one", "level-two", "store", PROJECT_ID, RUN_ID, "artifacts"]) {
      const mkdirIndex = operations.findIndex((entry) =>
        entry.startsWith("mkdir:") && entry.endsWith(child)
      );
      const chmodIndex = operations.findIndex((entry) =>
        entry.startsWith("chmod:") && entry.includes(child) && entry.endsWith(":700")
      );
      const childSyncIndex = operations.findIndex((entry) =>
        entry.startsWith("sync:") && entry.endsWith(child)
      );
      assert.ok(mkdirIndex >= 0, `mkdir ${child}`);
      assert.ok(chmodIndex > mkdirIndex, `chmod after mkdir ${child}`);
      assert.ok(childSyncIndex > chmodIndex, `child fsync after chmod ${child}`);
    }

    const levelOneMkdir = operations.findIndex((entry) => entry.startsWith("mkdir:") && entry.endsWith("level-one"));
    const parentSync = operations.findIndex((entry) => entry === `sync:${parent}`);
    assert.ok(parentSync > levelOneMkdir, "new root entry is synced through its pre-existing parent");
    await writer.close();
  } finally {
    await realFs.rm(parent, { recursive: true, force: true });
  }
});

// Break caught: concurrent first users race on root mkdir and leak raw EEXIST.
test("concurrent fresh-root creation adopts the verified winner and preserves run claims", async () => {
  const parent = await realFs.mkdtemp(join(tmpdir(), "teams-events-race-"));
  try {
    const root = join(parent, "fresh-root");
    let rootLstats = 0;
    let release;
    const bothAtRoot = new Promise((resolve) => { release = resolve; });
    const racingFs = {
      ...realFs,
      async lstat(path, options) {
        if (String(path) === root && rootLstats < 2) {
          rootLstats += 1;
          if (rootLstats === 2) release();
          await bothAtRoot;
          const error = new Error("injected concurrent absence");
          error.code = "ENOENT";
          throw error;
        }
        return realFs.lstat(path, options);
      },
    };
    const firstStore = createFileEventStore({
      root,
      now: () => OCCURRED_AT,
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174010",
      fs: racingFs,
    });
    const secondStore = createFileEventStore({
      root,
      now: () => OCCURRED_AT,
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174011",
      fs: racingFs,
    });
    const differentRuns = await Promise.allSettled([
      firstStore.createRun(runSnapshotInput()),
      secondStore.createRun(runSnapshotInput({ runId: OTHER_RUN_ID })),
    ]);
    try {
      assert.deepEqual(differentRuns.map(({ status }) => status), ["fulfilled", "fulfilled"]);
    } finally {
      await Promise.all(differentRuns.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.close()] : []
      ));
    }

    const collisionRoot = join(parent, "collision-root");
    const collisionStoreA = createFileEventStore({
      root: collisionRoot,
      now: () => OCCURRED_AT,
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174012",
    });
    const collisionStoreB = createFileEventStore({
      root: collisionRoot,
      now: () => OCCURRED_AT,
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174013",
    });
    const sameRun = await Promise.allSettled([
      collisionStoreA.createRun(runSnapshotInput()),
      collisionStoreB.createRun(runSnapshotInput()),
    ]);
    try {
      assert.equal(sameRun.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = sameRun.find(({ status }) => status === "rejected");
      assert.match(String(rejected.reason), /event_writer_claimed:/);
    } finally {
      await Promise.all(sameRun.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.close()] : []
      ));
    }
  } finally {
    await realFs.rm(parent, { recursive: true, force: true });
  }
});

// Break caught: append rewrites a prefix, omits newline/fsync, or races sequence assignment.
test("writer serializes concurrent canonical appends without changing existing prefixes", async () => {
  const syncPaths = [];
  const opened = [];
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const eventPath = join(root, PROJECT_ID, RUN_ID, "events.jsonl");
    const first = await writer.append(draft("run.requested", { payload: { n: 1 } }));
    const prefix = await realFs.readFile(eventPath);
    const [second, third] = await Promise.all([
      writer.append(draft("manifest.snapshotted", { payload: { n: 2 } })),
      writer.append(draft("policy.admitted", { payload: { n: 3 } })),
    ]);
    const bytes = await realFs.readFile(eventPath);
    const text = bytes.toString("utf8");

    assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
    assert.deepEqual([first.prevHash, second.prevHash, third.prevHash], [
      ZERO_HASH, first.hash, second.hash,
    ]);
    assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
    assert.ok(text.endsWith("\n"));
    assert.equal(text.split("\n").length - 1, 3);
    assert.deepEqual(await store.read(PROJECT_ID, RUN_ID), [first, second, third]);
    assert.ok(syncPaths.filter((path) => path.endsWith("events.jsonl")).length >= 3);

    await writer.close();
  }, { fs: trackingFs(syncPaths, opened) });
});

// Break caught: validation and canonical capture observe different proxy descriptor values.
test("writer rejects proxy drafts and payloads before invoking their traps", async () => {
  await withStoreFixture(async ({ store }) => {
    let rootTraps = 0;
    const proxyDraft = new Proxy(draft("run.requested"), {
      ownKeys(object) {
        rootTraps += 1;
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, property) {
        rootTraps += 1;
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
      get(object, property, receiver) {
        rootTraps += 1;
        return Reflect.get(object, property, receiver);
      },
    });
    let nestedTraps = 0;
    const proxyPayload = new Proxy({ value: "original" }, {
      ownKeys(object) {
        nestedTraps += 1;
        return Reflect.ownKeys(object);
      },
      getOwnPropertyDescriptor(object, property) {
        nestedTraps += 1;
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
    });

    const writer = await store.createRun(runSnapshotInput());
    await assert.rejects(() => writer.append(proxyDraft), /event_draft:/);
    await assert.rejects(
      () => writer.append(draft("run.requested", { payload: proxyPayload })),
      /event_payload:/,
    );
    assert.equal(rootTraps, 0);
    assert.equal(nestedTraps, 0);

    const event = await writer.append(draft("run.requested", {
      payload: { value: "original" },
    }));
    assert.deepEqual(event.payload, { value: "original" });
    assert.ok(Object.isFrozen(event.payload));
    assert.ok(Object.isFrozen(event.actor));
    await writer.close();
  });
});

// Break caught: caller mutation after append changes the queued authority record.
test("writer snapshots a draft at the append call boundary", async () => {
  await withStoreFixture(async ({ store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const input = draft("run.requested", { payload: { value: "original" } });
    const pending = writer.append(input);
    input.payload.value = "mutated";
    input.actor.id = "mutated";

    const event = await pending;
    assert.deepEqual(event.payload, { value: "original" });
    assert.deepEqual(event.actor, { kind: "system", id: "teams" });
    assert.deepEqual(await store.read(PROJECT_ID, RUN_ID), [event]);
    await writer.close();
  });
});

// Break caught: oversized/deep payloads are fully serialized or traversed past the byte budget.
test("writer rejects huge and deeply nested events during bounded canonical traversal", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const eventPath = join(root, PROJECT_ID, RUN_ID, "events.jsonl");
    let lateTraversal = 0;
    const lateValue = new Proxy({ value: true }, {
      ownKeys(target) {
        lateTraversal += 1;
        return Reflect.ownKeys(target);
      },
    });
    await assert.rejects(
      () => writer.append(draft("run.requested", {
        payload: {
          a: "x".repeat(TEAM_LIMITS.eventLineBytes * 64),
          z: lateValue,
        },
      })),
      /event_line_bytes:/,
    );
    assert.equal(lateTraversal, 0);

    let nested = { value: true };
    for (let depth = 0; depth < 20_000; depth += 1) nested = { child: nested };
    await assert.rejects(
      () => writer.append(draft("run.requested", { payload: nested })),
      /event_line_bytes:/,
    );
    assert.equal((await realFs.stat(eventPath)).size, 0);
    await writer.close();
  });
});

// Break caught: structural work grows with very wide containers before the byte limit is known.
test("bounded canonicalization rejects very wide arrays and objects before descriptor work", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const eventPath = join(root, PROJECT_ID, RUN_ID, "events.jsonl");

    const wideArray = new Array(40_000).fill(0);
    Object.defineProperty(wideArray, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("wide array descriptor reached");
      },
    });
    await assert.rejects(
      () => writer.append(draft("run.requested", { payload: { wideArray } })),
      /event_line_bytes:/,
    );

    const wideObject = {};
    for (let index = 0; index < 14_000; index += 1) {
      wideObject[`k${String(index).padStart(5, "0")}`] = 0;
    }
    Object.defineProperty(wideObject, "zzzz", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("wide object descriptor reached");
      },
    });
    await assert.rejects(
      () => writer.append(draft("run.requested", { payload: { wideObject } })),
      /event_line_bytes:/,
    );

    assert.equal((await realFs.stat(eventPath)).size, 0);
    await writer.close();
  });
});

// Break caught: invalid drafts or oversized events are partially appended.
test("writer rejects non-exact drafts and oversized lines before writing", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    const eventPath = join(root, PROJECT_ID, RUN_ID, "events.jsonl");
    const invalid = [
      { ...draft("run.requested"), extra: true },
      draft("unknown.event"),
      draft("run.requested", { occurredAt: "tomorrow" }),
      draft("run.requested", { actor: { kind: "root", id: "operator" } }),
      draft("run.requested", { payload: [] }),
    ];
    for (const candidate of invalid) {
      await assert.rejects(() => writer.append(candidate), /event_/);
    }
    await assert.rejects(
      () => writer.append(draft("run.requested", {
        payload: { text: "x".repeat(TEAM_LIMITS.eventLineBytes) },
      })),
      /event_line_bytes:/,
    );
    assert.equal((await realFs.stat(eventPath)).size, 0);
    await writer.close();
  });
});

// Break caught: the writer creates a history that its bounded reader must reject.
test("writer refuses event-count and aggregate-byte history overflow before append", async () => {
  const fastFs = {
    ...realFs,
    async open(path, flags, mode) {
      const handle = await realFs.open(path, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };

  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    for (let index = 0; index < TEAM_LIMITS.eventHistoryEvents; index += 1) {
      await writer.append(draft("budget.observed", { payload: { index } }));
    }
    const countPath = join(root, PROJECT_ID, RUN_ID, "events.jsonl");
    const countBytes = (await realFs.stat(countPath)).size;
    await assert.rejects(
      () => writer.append(draft("budget.observed")),
      /event_history_events:/,
    );
    assert.equal((await realFs.stat(countPath)).size, countBytes);
    await writer.close();

    const largeWriter = await store.createRun(runSnapshotInput({ runId: OTHER_RUN_ID }));
    const largePath = join(root, PROJECT_ID, OTHER_RUN_ID, "events.jsonl");
    let accepted = 0;
    while (accepted < 300) {
      try {
        await largeWriter.append(draft("budget.observed", {
          payload: { index: accepted, text: "x".repeat(64_900) },
        }));
        accepted += 1;
      } catch (error) {
        assert.match(String(error), /event_history_bytes:/);
        break;
      }
    }
    assert.ok(accepted > 0 && accepted < 300);
    const largeBytes = (await realFs.stat(largePath)).size;
    await assert.rejects(
      () => largeWriter.append(draft("budget.observed", {
        payload: { text: "x".repeat(64_900) },
      })),
      /event_history_bytes:/,
    );
    assert.equal((await realFs.stat(largePath)).size, largeBytes);
    await largeWriter.close();
  }, { fs: fastFs });
});

// Break caught: a terminal writer remains live or a consumed run ID can be reclaimed.
test("terminal append durably closes the writer and permanently consumes the run ID", async () => {
  const syncPaths = [];
  const opened = [];
  await withStoreFixture(async ({ root, store }) => {
    const writer = await store.createRun(runSnapshotInput());
    await writer.append(draft("run.requested"));
    await writer.append(draft("run.completed"));
    await assert.rejects(() => writer.append(draft("budget.observed")), /event_writer_closed:/);
    await writer.close();

    assert.ok(syncPaths.filter((path) => path.endsWith(RUN_ID)).length >= 2);
    assert.equal((await realFs.stat(join(root, PROJECT_ID, RUN_ID, "writer.lock"))).mode & 0o777, 0o600);
    const laterStore = createFileEventStore({ root });
    await assert.rejects(
      () => laterStore.createRun(runSnapshotInput()),
      /event_writer_claimed:/,
    );
  }, { fs: trackingFs(syncPaths, opened) });
});

// Break caught: a failed partial creation is cleaned up and its abandoned ID becomes reusable.
test("a failed run creation permanently consumes the abandoned run ID", async () => {
  let failSnapshot = true;
  const failingFs = {
    ...realFs,
    async open(path, flags, mode) {
      if (failSnapshot && String(path).endsWith("manifest.snapshot.json")) {
        failSnapshot = false;
        throw new Error("injected snapshot failure");
      }
      return realFs.open(path, flags, mode);
    },
  };

  await withStoreFixture(async ({ store }) => {
    await assert.rejects(() => store.createRun(runSnapshotInput()), /injected snapshot failure/);
    await assert.rejects(() => store.createRun(runSnapshotInput()), /event_writer_claimed:/);
  }, { fs: failingFs });
});

async function completedLog(root, store) {
  const writer = await store.createRun(runSnapshotInput());
  await writer.append(draft("run.requested"));
  await writer.append(draft("run.completed"));
  const path = join(root, PROJECT_ID, RUN_ID, "events.jsonl");
  return { path, original: await realFs.readFile(path) };
}

// Break caught: line parsing ignores blank, torn, malformed, noncanonical, or invalid UTF-8 tails.
test("reader rejects corrupt physical event lines without repairing tails", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const { path, original } = await completedLog(root, store);
    const mutations = [
      { bytes: Buffer.concat([original, Buffer.from("\n")]), error: /event_blank_line:/ },
      { bytes: Buffer.concat([original, Buffer.from("{\"v\":1")]), error: /event_truncated:/ },
      { bytes: Buffer.concat([original, Buffer.from("{no}\n")]), error: /event_parse:/ },
      { bytes: original.subarray(0, original.length - 1), error: /event_truncated:/ },
      { bytes: Buffer.concat([original, Buffer.from([0xff, 0x0a])]), error: /event_utf8:/ },
      {
        bytes: Buffer.concat([Buffer.from(" ".repeat(TEAM_LIMITS.eventLineBytes)), Buffer.from("\n")]),
        error: /event_line_bytes:/,
      },
    ];

    for (const mutation of mutations) {
      await realFs.writeFile(path, mutation.bytes);
      await assert.rejects(() => store.read(PROJECT_ID, RUN_ID), mutation.error);
    }

    const [firstLine] = original.toString("utf8").trimEnd().split("\n");
    await realFs.writeFile(path, ` ${firstLine}\n`);
    await assert.rejects(() => store.read(PROJECT_ID, RUN_ID), /event_canonical:/);
  });
});

// Break caught: validation and streaming reads accumulate more bytes than the history ceiling.
test("history validation and reader enforce the aggregate byte ceiling", async () => {
  const events = [];
  let previous;
  for (let index = 0; index < 258; index += 1) {
    previous = chainedEvent(previous, {
      seq: index + 1,
      type: "budget.observed",
      payload: { text: "x".repeat(64_900) },
    });
    events.push(previous);
  }
  assert.ok(events.every((event) =>
    Buffer.byteLength(`${canonicalJson(event)}\n`) <= TEAM_LIMITS.eventLineBytes
  ));
  assert.ok(
    events.reduce((bytes, event) => bytes + Buffer.byteLength(`${canonicalJson(event)}\n`), 0) >
      TEAM_LIMITS.eventHistoryBytes,
  );
  assert.throws(() => validateEventHistory(events, RUN_ID), /event_history_bytes:/);

  await withStoreFixture(async ({ root, store }) => {
    const { path } = await completedLog(root, store);
    await realFs.writeFile(path, events.map((event) => `${canonicalJson(event)}\n`).join(""));
    await assert.rejects(() => store.read(PROJECT_ID, RUN_ID), /event_history_bytes:/);
  });
});

// Break caught: parsing accumulates more event records than the immutable history ceiling.
test("reader enforces the history event ceiling while streaming", async () => {
  await withStoreFixture(async ({ root, store }) => {
    const { path } = await completedLog(root, store);
    const events = [];
    let previous;
    for (let index = 0; index <= TEAM_LIMITS.eventHistoryEvents; index += 1) {
      previous = chainedEvent(previous, {
        seq: index + 1,
        type: "budget.observed",
        payload: { index },
      });
      events.push(`${canonicalJson(previous)}\n`);
    }
    await realFs.writeFile(path, events.join(""));
    await assert.rejects(() => store.read(PROJECT_ID, RUN_ID), /event_history_events:/);
  });
});

// Break caught: listing guesses runs from mutable state or omits durable run directories.
test("store lists only durable UUID run directories in lexical order", async () => {
  await withStoreFixture(async ({ root, store }) => {
    assert.deepEqual(await store.list(PROJECT_ID), []);
    const writer = await store.createRun(runSnapshotInput());
    assert.deepEqual(await store.list(PROJECT_ID), [RUN_ID]);

    const projectDir = join(root, PROJECT_ID);
    await realFs.mkdir(join(projectDir, "not-a-run"));
    await realFs.symlink(join(projectDir, RUN_ID), join(projectDir, OTHER_RUN_ID));
    assert.deepEqual(await store.list(PROJECT_ID), [RUN_ID]);
    await writer.close();
  });
});

// Break caught: invalid path identifiers or symlinked authority directories escape the store root.
test("store validates path identifiers and refuses symlink traversal", async () => {
  await withStoreFixture(async ({ parent, root, store }) => {
    for (const projectId of ["../escape", "A".repeat(64), "a".repeat(63)]) {
      await assert.rejects(
        () => store.createRun(runSnapshotInput({ projectId })),
        /event_project_id:/,
      );
      await assert.rejects(() => store.list(projectId), /event_project_id:/);
    }
    await assert.rejects(
      () => store.createRun(runSnapshotInput({ runId: "../escape" })),
      /event_run_id:/,
    );

    await realFs.mkdir(root, { recursive: true, mode: 0o700 });
    const outside = join(parent, "outside");
    await realFs.mkdir(outside);
    await realFs.symlink(outside, join(root, PROJECT_ID));
    await assert.rejects(() => store.createRun(runSnapshotInput()), /event_directory_/);
    assert.deepEqual(await realFs.readdir(outside), []);
  });
});
