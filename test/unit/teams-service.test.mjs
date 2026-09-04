import assert from "node:assert/strict";
import { hashEvent } from "../../packages/pi-teams/src/core/events.ts";
import { ZERO_HASH, TEAM_LIMITS } from "../../packages/pi-teams/src/core/limits.ts";
import { createTeamCatalog } from "../../packages/pi-teams/src/core/catalog.ts";
import { createTeamService } from "../../packages/pi-teams/src/core/service.ts";
import { test } from "node:test";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_ID = "a".repeat(64);
const NOW = "2026-09-04T12:00:00.000Z";
const MODEL_ACTOR = { kind: "model", id: "requester" };
const HUMAN_ACTOR = { kind: "human", id: "operator" };
const RUNTIME = Object.freeze({ session: "one" });

function definition() {
  return {
    apiVersion: "pi.dev/teams/v1alpha1",
    kind: "Team",
    metadata: { name: "investigate", description: "Investigate repository evidence." },
    spec: {
      limits: {
        maxConcurrency: 2,
        maxCostUsd: 2,
        timeoutMs: 300_000,
        maxMembers: 3,
      },
      members: [
        {
          id: "architecture",
          route: "research",
          capabilities: ["repo.read"],
          tools: ["read", "grep"],
          needs: [],
          instructions: "Map the architecture.",
        },
        {
          id: "risks",
          route: "review",
          capabilities: ["repo.read"],
          tools: ["grep", "find"],
          needs: [],
          instructions: "Review the risks.",
        },
        {
          id: "lead",
          route: "planning",
          capabilities: ["repo.read"],
          tools: ["read", "ls"],
          needs: ["architecture", "risks"],
          instructions: "Synthesize the evidence.",
        },
      ],
    },
  };
}

function entry(overrides = {}) {
  return {
    ref: "builtin/investigate",
    source: "builtin",
    origin: "builtin/investigate.yaml",
    definition: definition(),
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    cwd: "/repo",
    projectId: PROJECT_ID,
    projectTrusted: true,
    source: "tool",
    runtime: RUNTIME,
    ...overrides,
  };
}

function eventStoreFake(options = {}) {
  const runs = new Map();
  const createCalls = [];
  return {
    runs,
    createCalls,
    async createRun(snapshot) {
      createCalls.push(structuredClone(snapshot));
      if (runs.has(snapshot.runId)) throw new Error("event_writer_claimed:duplicate");
      const record = {
        snapshot: structuredClone(snapshot),
        events: [],
        closed: false,
        appendCalls: [],
        closeCalls: 0,
      };
      runs.set(snapshot.runId, record);
      return {
        async append(draft) {
          if (record.closed) throw new Error("event_writer_closed:closed");
          record.appendCalls.push(draft.type);
          await options.beforeAppend?.(draft, record);
          const previous = record.events.at(-1);
          const withoutHash = {
            v: 1,
            runId: snapshot.runId,
            seq: record.events.length + 1,
            type: draft.type,
            actor: structuredClone(draft.actor),
            occurredAt: draft.occurredAt,
            payload: structuredClone(draft.payload),
            prevHash: previous?.hash ?? ZERO_HASH,
          };
          const event = { ...withoutHash, hash: hashEvent(withoutHash) };
          record.events.push(event);
          if (["run.completed", "run.failed", "run.blocked", "run.cancelled"].includes(event.type)) {
            record.closed = true;
          }
          return options.returnEvent?.(event, draft, record) ?? event;
        },
        async close() {
          record.closeCalls += 1;
          record.closed = true;
        },
      };
    },
    async read(projectId, runId) {
      const record = runs.get(runId);
      if (record === undefined || record.snapshot.projectId !== projectId) {
        throw new Error("event_history:not found");
      }
      return structuredClone(record.events);
    },
    async list(projectId) {
      return [...runs.entries()]
        .filter(([, record]) => record.snapshot.projectId === projectId)
        .map(([runId]) => runId);
    },
  };
}

function admitted(input, timeoutMs) {
  return {
    ok: true,
    memberId: input.member.id,
    effectiveRoute: input.member.route,
    effectiveModel: `provider/${input.member.id}`,
    effectiveCapabilities: [...input.member.capabilities],
    effectiveTools: [...input.member.tools],
    maxCostUsd: input.maxCostUsd,
    timeoutMs,
    token: { secret: input.member.id },
  };
}

function fixture(options = {}) {
  const eventStore = options.eventStore ?? eventStoreFake();
  const preflightCalls = [];
  let providerCalls = 0;
  let capabilitiesCalls = 0;
  let catalogCalls = 0;
  let resolveCalls = 0;
  const baseCatalog = options.catalog ?? createTeamCatalog([options.entry ?? entry()]);
  const catalog = {
    list: () => baseCatalog.list(),
    resolve(ref) {
      resolveCalls += 1;
      return baseCatalog.resolve(ref);
    },
  };
  const timeouts = options.timeouts ?? [250_000, 120_000, 60_000];
  const host = {
    id: "stock-pi",
    async capabilities(receivedContext) {
      capabilitiesCalls += 1;
      options.onCapabilities?.(receivedContext);
      return {
        capabilities: ["repo.read"],
        tools: ["read", "grep", "find", "ls"],
        maxConcurrency: options.hostConcurrency ?? 1,
        supportsCancellation: true,
      };
    },
    async preflightMember(input, receivedContext) {
      const index = preflightCalls.length;
      preflightCalls.push({ input, context: receivedContext });
      if (options.preflight !== undefined) {
        return options.preflight(input, receivedContext, index);
      }
      return admitted(input, timeouts[index]);
    },
    runMember() {
      providerCalls += 1;
      throw new Error("runMember must not be called by request or approve");
    },
    async containMember() {},
  };
  const service = createTeamService({
    async catalogFor(receivedContext) {
      catalogCalls += 1;
      options.onCatalog?.(receivedContext);
      return catalog;
    },
    eventStore,
    artifactStore: {
      async writeMember() { throw new Error("artifact writes are not used in Task 9"); },
      async readVerified() { throw new Error("artifact reads are not used in Task 9"); },
    },
    host,
    now: options.now ?? (() => NOW),
    randomUUID: options.randomUUID ?? (() => RUN_ID),
  });
  return {
    service,
    eventStore,
    preflightCalls,
    get providerCalls() { return providerCalls; },
    get capabilitiesCalls() { return capabilitiesCalls; },
    get catalogCalls() { return catalogCalls; },
    get resolveCalls() { return resolveCalls; },
  };
}

async function request(run, overrides = {}) {
  return run.service.request({
    teamRef: "builtin/investigate",
    objective: "Map auth",
    actor: MODEL_ACTOR,
    context: context(),
    ...overrides,
  });
}

// Break caught: request creates durable authority before validating caller-controlled claims.
test("request validates and captures objective and context before effects", async () => {
  for (const objective of ["", "   ", "x".repeat(TEAM_LIMITS.objectiveBytes + 1), "\ud800"]) {
    const run = fixture();
    await assert.rejects(() => request(run, { objective }), /objective/);
    assert.equal(run.catalogCalls, 0);
    assert.equal(run.eventStore.createCalls.length, 0);
    assert.equal(run.capabilitiesCalls, 0);
  }

  for (const invalidContext of [
    context({ cwd: "" }),
    context({ projectId: "A".repeat(64) }),
    context({ projectTrusted: "yes" }),
    context({ source: "unknown" }),
  ]) {
    const run = fixture();
    await assert.rejects(() => request(run, { context: invalidContext }), /context/);
    assert.equal(run.catalogCalls, 0);
    assert.equal(run.eventStore.createCalls.length, 0);
  }

  const mutable = context();
  const run = fixture({
    onCatalog(received) {
      assert.notEqual(received, mutable);
      assert.equal(received.cwd, "/repo");
      mutable.cwd = "/changed";
      mutable.projectTrusted = false;
    },
  });
  await request(run, { context: mutable });
  assert.equal(run.preflightCalls[0].context.cwd, "/repo");
  assert.equal(run.preflightCalls[0].context.projectTrusted, true);
});

// Break caught: catalog provenance contradicts project trust after a writer has been claimed.
test("request rejects mismatched project trust and catalog identity before writer creation", async () => {
  const projectRun = fixture({ entry: entry({
    ref: "project/investigate",
    source: "project",
    origin: "/repo/.pi/teams/investigate.yaml",
  }) });
  await assert.rejects(
    () => request(projectRun, {
      teamRef: "project/investigate",
      context: context({ projectTrusted: false }),
    }),
    /catalog_trust/,
  );
  assert.equal(projectRun.eventStore.createCalls.length, 0);
  assert.equal(projectRun.capabilitiesCalls, 0);

  const mismatched = fixture({ entry: entry({ source: "user" }) });
  await assert.rejects(() => request(mismatched), /catalog_identity/);
  assert.equal(mismatched.eventStore.createCalls.length, 0);
});

// Break caught: a catalog resolver substitutes a different valid team for the requested reference.
test("request binds qualified and short catalog resolution to the exact requested identity", async () => {
  const other = entry({
    ref: "builtin/other",
    definition: {
      ...definition(),
      metadata: { ...definition().metadata, name: "other" },
    },
  });
  for (const [teamRef, substituted] of [
    ["builtin/investigate", other],
    ["investigate", other],
    ["investigate", entry({ ref: "user/investigate", source: "builtin" })],
  ]) {
    const maliciousCatalog = {
      list: () => [substituted],
      resolve: () => substituted,
    };
    const run = fixture({ catalog: maliciousCatalog });
    await assert.rejects(() => request(run, { teamRef }), /catalog_identity/);
    assert.equal(run.eventStore.createCalls.length, 0);
    assert.equal(run.capabilitiesCalls, 0);
  }

  const shortRun = fixture();
  const view = await request(shortRun, { teamRef: "investigate" });
  assert.equal(view.teamRef, "builtin/investigate");
});

// Break caught: request compiles/preflights repeatedly, widens limits, leaks tokens, or starts providers.
test("request compiles once, preflights every member, and awaits human approval", async () => {
  const run = fixture({ hostConcurrency: 1 });
  const view = await request(run);

  assert.equal(run.catalogCalls, 1);
  assert.equal(run.resolveCalls, 1);
  assert.equal(run.capabilitiesCalls, 1);
  assert.deepEqual(run.preflightCalls.map(({ input }) => input.member.id), [
    "architecture", "risks", "lead",
  ]);
  assert.deepEqual(run.preflightCalls.map(({ input }) => input.maxCostUsd), [
    2 / 3, 2 / 3, 2 / 3,
  ]);
  assert.deepEqual(run.preflightCalls.map(({ input }) => input.timeoutMs), [
    300_000, 300_000, 300_000,
  ]);
  assert.equal(run.providerCalls, 0);
  assert.equal(view.status, "awaiting_approval");
  assert.deepEqual(view.limits, {
    maxConcurrency: 1,
    maxCostUsd: 2,
    timeoutMs: 300_000,
    maxMembers: 3,
  });
  assert.deepEqual(view.admissions.map(({ timeoutMs }) => timeoutMs), [
    250_000, 120_000, 60_000,
  ]);
  assert.ok(view.admissions.every((admission) => !("token" in admission)));
  assert.equal(view.approvalBinding.policyDigest, view.policyDigest);

  const record = run.eventStore.runs.get(RUN_ID);
  assert.deepEqual(record.events.map(({ type }) => type), [
    "run.requested",
    "manifest.snapshotted",
    "policy.admitted",
    "run.awaiting_approval",
  ]);
  assert.deepEqual(record.events[0].payload, {
    projectId: PROJECT_ID,
    teamRef: "builtin/investigate",
    objective: "Map auth",
  });
  assert.deepEqual(record.events[1].payload, {
    teamRef: "builtin/investigate",
    manifestDigest: view.manifestDigest,
    planDigest: view.planDigest,
    limits: view.limits,
    members: [
      { id: "architecture", needs: [] },
      { id: "risks", needs: [] },
      { id: "lead", needs: ["architecture", "risks"] },
    ],
  });
  assert.deepEqual(record.events[2].payload, {
    policyDigest: view.policyDigest,
    admissions: view.admissions,
  });
  assert.deepEqual(record.events[3].payload, { binding: view.approvalBinding });
  assert.deepEqual(run.eventStore.createCalls[0].request, {
    teamRef: "builtin/investigate",
    objective: "Map auth",
    actor: MODEL_ACTOR,
    requestedAt: NOW,
  });
});

// Break caught: Promise.all early rejection skips later preflights or loses complete block reasons.
test("preflight settles all members and durably blocks every denied position", async () => {
  for (const blockedIndex of [0, 1, 2]) {
    let settled = 0;
    const run = fixture({
      async preflight(input, _context, index) {
        await Promise.resolve();
        settled += 1;
        if (index === blockedIndex) {
          return {
            ok: false,
            memberId: input.member.id,
            effectiveRoute: null,
            effectiveModel: null,
            effectiveCapabilities: [],
            effectiveTools: [],
            maxCostUsd: input.maxCostUsd,
            reason: `denied-${input.member.id}`,
          };
        }
        return admitted(input, 120_000);
      },
    });
    const view = await request(run);
    assert.equal(settled, 3);
    assert.equal(run.preflightCalls.length, 3);
    assert.equal(view.status, "blocked");
    assert.equal(run.providerCalls, 0);
    const events = run.eventStore.runs.get(RUN_ID).events;
    assert.deepEqual(events.map(({ type }) => type), [
      "run.requested", "manifest.snapshotted", "policy.blocked", "run.blocked",
    ]);
    assert.deepEqual(events[2].payload, {
      reasons: [`denied-${definition().spec.members[blockedIndex].id}`],
    });
    assert.deepEqual(events[3].payload, {
      reason: `denied-${definition().spec.members[blockedIndex].id}`,
    });
  }
});

// Break caught: a synchronous throw or rejected host preflight creates an unhandled/partial admission.
test("preflight converts every host failure into a complete terminal block after settlement", async () => {
  const run = fixture({
    preflight(input, _context, index) {
      if (index === 0) throw new Error("sync denial");
      if (index === 1) return Promise.reject(new Error("async denial"));
      return admitted(input, 120_000);
    },
  });
  const view = await request(run);
  assert.equal(run.preflightCalls.length, 3);
  assert.equal(view.status, "blocked");
  const reasons = run.eventStore.runs.get(RUN_ID).events[2].payload.reasons;
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /sync denial/);
  assert.match(reasons[1], /async denial/);
});

// Break caught: hostile Error.message values coerce or invoke accessors before durable blocking.
test("preflight safely falls back for hostile error messages without coercion or traps", async () => {
  const cases = [
    {
      name: "number message",
      create() {
        const error = new Error("ignored");
        error.message = 42;
        return { rejection: error, traps: () => 0 };
      },
    },
    {
      name: "symbol message",
      create() {
        const error = new Error("ignored");
        error.message = Symbol("secret");
        return { rejection: error, traps: () => 0 };
      },
    },
    {
      name: "accessor message",
      create() {
        let traps = 0;
        const error = new Error("ignored");
        Object.defineProperty(error, "message", {
          configurable: true,
          get() {
            traps += 1;
            throw new Error("message getter invoked");
          },
        });
        return { rejection: error, traps: () => traps };
      },
    },
    {
      name: "hostile object message",
      create() {
        let traps = 0;
        const message = {
          get [Symbol.toPrimitive]() {
            traps += 1;
            throw new Error("message coercion invoked");
          },
          toString() {
            traps += 1;
            throw new Error("message toString invoked");
          },
        };
        const error = new Error("ignored");
        error.message = message;
        return { rejection: error, traps: () => traps };
      },
    },
    {
      name: "proxy message",
      create() {
        let traps = 0;
        const message = new Proxy({}, {
          get() { traps += 1; throw new Error("proxy message get invoked"); },
          getPrototypeOf() { traps += 1; throw new Error("proxy message prototype invoked"); },
        });
        const error = new Error("ignored");
        error.message = message;
        return { rejection: error, traps: () => traps };
      },
    },
    {
      name: "proxy error",
      create() {
        let traps = 0;
        const error = new Proxy(new Error("secret"), {
          get() { traps += 1; throw new Error("proxy error get invoked"); },
          getPrototypeOf() { traps += 1; throw new Error("proxy error prototype invoked"); },
        });
        return { rejection: error, traps: () => traps };
      },
    },
  ];

  for (const { name, create } of cases) {
    const hostile = create();
    const run = fixture({
      preflight(input, _context, index) {
        return index === 0
          ? Promise.reject(hostile.rejection)
          : admitted(input, 120_000);
      },
    });
    const view = await request(run);
    assert.equal(view.status, "blocked", name);
    const events = run.eventStore.runs.get(RUN_ID).events;
    assert.deepEqual(events.map(({ type }) => type), [
      "run.requested", "manifest.snapshotted", "policy.blocked", "run.blocked",
    ], name);
    assert.equal(
      events[2].payload.reasons[0],
      "preflight_architecture:host preflight failed",
      name,
    );
    assert.equal(events[3].payload.reason, events[2].payload.reasons[0], name);
    assert.equal(hostile.traps(), 0, name);
  }
});

// Break caught: UTF-16 truncation splits a supplementary character and prevents durable blocking.
test("preflight bounds supplementary-character errors by code point and UTF-8 bytes", async () => {
  const run = fixture({
    preflight(input, _context, index) {
      if (index === 0) throw new Error(`aa${"💥".repeat(1_000)}`);
      return admitted(input, 120_000);
    },
  });
  const view = await request(run);
  assert.equal(view.status, "blocked");
  const events = run.eventStore.runs.get(RUN_ID).events;
  assert.deepEqual(events.map(({ type }) => type), [
    "run.requested", "manifest.snapshotted", "policy.blocked", "run.blocked",
  ]);
  const reason = events[2].payload.reasons[0];
  assert.ok(Buffer.byteLength(reason, "utf8") <= TEAM_LIMITS.descriptionBytes);
  assert.equal(Buffer.from(reason, "utf8").toString("utf8"), reason);
  assert.match(reason, /^preflight_architecture:aa💥+$/u);
  assert.equal(events[3].payload.reason, reason);
});

// Break caught: a failed durable claim is retried in-process as though the ID were unused.
test("request permanently abandons a run ID after writer creation fails", async () => {
  const store = eventStoreFake();
  let createAttempts = 0;
  const failingStore = {
    ...store,
    async createRun(snapshot) {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("injected create failure");
      return store.createRun(snapshot);
    },
  };
  const run = fixture({ eventStore: failingStore });
  await assert.rejects(() => request(run), /injected create failure/);
  await assert.rejects(() => request(run), /claimed or abandoned/);
  assert.equal(createAttempts, 1);
  assert.equal(run.preflightCalls.length, 0);
  assert.equal(run.providerCalls, 0);
});

// Break caught: hostile clock or UUID providers create a writer from invalid authority identifiers.
test("request rejects hostile time and UUID outputs before writer creation", async () => {
  for (const options of [
    { now: () => "tomorrow" },
    { now: () => { throw new Error("clock failed"); } },
    { randomUUID: () => "../escape" },
    { randomUUID: () => { throw new Error("uuid failed"); } },
  ]) {
    const run = fixture(options);
    await assert.rejects(() => request(run), /(service_time|service_run_id|clock failed|uuid failed)/);
    assert.equal(run.eventStore.createCalls.length, 0);
    assert.equal(run.preflightCalls.length, 0);
    assert.equal(run.providerCalls, 0);
  }
});

// Break caught: invalid or widening admission timeouts survive service preflight.
test("preflight durably blocks invalid effective timeouts without skipping members", async () => {
  for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 300_001]) {
    const run = fixture({
      preflight(input, _context, index) {
        return admitted(input, index === 1 ? timeoutMs : 120_000);
      },
    });
    const view = await request(run);
    assert.equal(run.preflightCalls.length, 3);
    assert.equal(view.status, "blocked");
    assert.equal(run.providerCalls, 0);
    assert.match(run.eventStore.runs.get(RUN_ID).events[2].payload.reasons[0], /policy_timeout/);
  }
});

// Break caught: approval accepts model authority, stale digests, or emits before exact verification.
test("approve requires an exact human binding and is idempotent", async () => {
  const run = fixture();
  const awaiting = await request(run);
  const record = run.eventStore.runs.get(RUN_ID);
  const eventCount = record.events.length;

  await assert.rejects(
    () => run.service.approve({
      runId: RUN_ID,
      actor: MODEL_ACTOR,
      binding: awaiting.approvalBinding,
      context: context(),
    }),
    /approval_actor/,
  );
  assert.equal(record.events.length, eventCount);

  for (const [field, value] of Object.entries({
    runId: "123e4567-e89b-42d3-a456-426614174001",
    manifestDigest: "1".repeat(64),
    planDigest: "2".repeat(64),
    policyDigest: "3".repeat(64),
    requestedAction: "inspect",
  })) {
    await assert.rejects(
      () => run.service.approve({
        runId: RUN_ID,
        actor: HUMAN_ACTOR,
        binding: { ...awaiting.approvalBinding, [field]: value },
        context: context(),
      }),
      /approval_binding/,
    );
    assert.equal(record.events.length, eventCount);
  }

  const approved = await run.service.approve({
    runId: RUN_ID,
    actor: HUMAN_ACTOR,
    binding: awaiting.approvalBinding,
    context: context({ source: "command" }),
  });
  assert.equal(approved.lastEvent.type, "approval.granted");
  assert.deepEqual(approved.lastEvent.actor, HUMAN_ACTOR);
  assert.equal(record.events.length, eventCount + 1);
  assert.equal(run.providerCalls, 0);

  const duplicate = await run.service.approve({
    runId: RUN_ID,
    actor: HUMAN_ACTOR,
    binding: awaiting.approvalBinding,
    context: context({ source: "command" }),
  });
  assert.equal(duplicate.lastEvent.type, "approval.granted");
  assert.equal(record.events.length, eventCount + 1);
  assert.equal(run.providerCalls, 0);
});

// Break caught: approval binding validation invokes proxy reflection before rejection.
test("approve rejects binding proxies without invoking any reflective trap", async () => {
  const run = fixture();
  const awaiting = await request(run);
  let traps = 0;
  const binding = new Proxy(awaiting.approvalBinding, {
    getPrototypeOf(target) {
      traps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      traps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      traps += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    get(target, property, receiver) {
      traps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(
    () => run.service.approve({
      runId: RUN_ID,
      actor: HUMAN_ACTOR,
      binding,
      context: context({ source: "command" }),
    }),
    /approval_binding/,
  );
  assert.equal(traps, 0);
  assert.equal(run.eventStore.runs.get(RUN_ID).events.length, 4);
});

// Break caught: concurrent approval races append twice rather than sharing one operation.
test("concurrent approvals share exactly one append", async () => {
  let releaseApproval;
  const approvalGate = new Promise((resolve) => { releaseApproval = resolve; });
  let approvalAppends = 0;
  const store = eventStoreFake({
    async beforeAppend(draft) {
      if (draft.type !== "approval.granted") return;
      approvalAppends += 1;
      await approvalGate;
    },
  });
  const run = fixture({ eventStore: store });
  const awaiting = await request(run);
  const input = {
    runId: RUN_ID,
    actor: HUMAN_ACTOR,
    binding: awaiting.approvalBinding,
    context: context({ source: "command" }),
  };
  const first = run.service.approve(input);
  const second = run.service.approve(input);
  await Promise.resolve();
  assert.equal(approvalAppends, 1);
  releaseApproval();
  const [firstView, secondView] = await Promise.all([first, second]);
  assert.equal(firstView.lastEvent.type, "approval.granted");
  assert.equal(secondView.lastEvent.type, "approval.granted");
  assert.equal(approvalAppends, 1);
});

// Break caught: failed approval retains writer authority, live tokens, or a replayable rejected promise.
test("approval append failure closes and evicts the live run fail closed", async () => {
  let approvalAppends = 0;
  const store = eventStoreFake({
    beforeAppend(draft) {
      if (draft.type === "approval.granted") {
        approvalAppends += 1;
        throw new Error("injected approval append failure");
      }
    },
  });
  const run = fixture({ eventStore: store });
  const awaiting = await request(run);
  const input = {
    runId: RUN_ID,
    actor: HUMAN_ACTOR,
    binding: awaiting.approvalBinding,
    context: context({ source: "command" }),
  };
  const first = run.service.approve(input);
  const second = run.service.approve(input);
  await assert.rejects(() => first, /injected approval append failure/);
  await assert.rejects(() => second, /injected approval append failure/);
  const record = store.runs.get(RUN_ID);
  assert.equal(approvalAppends, 1);
  assert.equal(record.closeCalls, 1);
  assert.equal(record.closed, true);
  await assert.rejects(() => run.service.approve(input), /approval_run/);
  assert.equal(approvalAppends, 1);
});

// Break caught: projection failure after durable approval leaves a live admitted run and open writer.
test("approval projection failure closes and evicts the live run", async () => {
  let approvalAppends = 0;
  const store = eventStoreFake({
    returnEvent(event, draft) {
      if (draft.type !== "approval.granted") return event;
      approvalAppends += 1;
      return { ...event, payload: { invalid: true } };
    },
  });
  const run = fixture({ eventStore: store });
  const awaiting = await request(run);
  const input = {
    runId: RUN_ID,
    actor: HUMAN_ACTOR,
    binding: awaiting.approvalBinding,
    context: context({ source: "command" }),
  };
  await assert.rejects(() => run.service.approve(input), /event_payload/);
  const record = store.runs.get(RUN_ID);
  assert.equal(approvalAppends, 1);
  assert.equal(record.closeCalls, 1);
  assert.equal(record.closed, true);
  await assert.rejects(() => run.service.approve(input), /approval_run/);
  assert.equal(approvalAppends, 1);
});

// Break caught: blocked, abandoned, or context-rebound runs gain approval authority.
test("approve fails closed for blocked, abandoned, and runtime-mismatched runs", async () => {
  const blocked = fixture({
    preflight(input) {
      return {
        ok: false,
        memberId: input.member.id,
        effectiveRoute: null,
        effectiveModel: null,
        effectiveCapabilities: [],
        effectiveTools: [],
        maxCostUsd: input.maxCostUsd,
        reason: "denied",
      };
    },
  });
  const blockedView = await request(blocked);
  await assert.rejects(
    () => blocked.service.approve({
      runId: RUN_ID,
      actor: HUMAN_ACTOR,
      binding: {
        runId: RUN_ID,
        manifestDigest: blockedView.manifestDigest,
        planDigest: blockedView.planDigest,
        policyDigest: "a".repeat(64),
        requestedAction: "execute",
      },
      context: context(),
    }),
    /approval_run/,
  );

  const live = fixture();
  const awaiting = await request(live);
  const restarted = fixture({ eventStore: live.eventStore });
  await assert.rejects(
    () => restarted.service.approve({
      runId: RUN_ID,
      actor: HUMAN_ACTOR,
      binding: awaiting.approvalBinding,
      context: context(),
    }),
    /approval_run/,
  );

  for (const changedContext of [
    context({ cwd: "/other" }),
    context({ projectId: "b".repeat(64) }),
    context({ projectTrusted: false }),
    context({ runtime: Object.freeze({ session: "other" }) }),
  ]) {
    await assert.rejects(
      () => live.service.approve({
        runId: RUN_ID,
        actor: HUMAN_ACTOR,
        binding: awaiting.approvalBinding,
        context: changedContext,
      }),
      /context_binding/,
    );
  }
  assert.equal(live.eventStore.runs.get(RUN_ID).events.length, 4);
});
