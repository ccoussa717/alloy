import assert from "node:assert/strict";
import { test } from "node:test";

import { createAlloyTeamsHost } from "../../lib/teams-host.mjs";

const MODEL = "provider/research-model";
const RUN_ID = "00000000-0000-4000-8000-000000000011";
const context = {
  cwd: "/repo",
  projectId: "project",
  projectTrusted: true,
  source: "command",
  runtime: { modelRegistry: {} },
};

function member(overrides = {}) {
  return {
    id: "researcher",
    route: "research",
    capabilities: ["repo.read"],
    tools: ["read"],
    needs: [],
    instructions: "Inspect.",
    ...overrides,
  };
}

function launch(overrides = {}) {
  return {
    ok: true,
    spec: {
      model: MODEL,
      profile: "research",
      tools: ["read"],
      systemPrompt: "Read only.",
    },
    decision: { ok: true, role: "research", model: MODEL },
    credential: {
      mode: "runtime-key",
      runtimeCredential: { provider: "provider", apiKey: "synthetic" },
    },
    maxConcurrency: 3,
    budgetUsd: 1,
    budgetLimitUsd: 5,
    ...overrides,
  };
}

function validSpawnResult(overrides = {}) {
  const full = {
    ok: true,
    text: "evidence",
    model: MODEL,
    actualModel: MODEL,
    error: null,
    usage: { input: 2, output: 3, cost: 0.25, costKnown: true },
    ...overrides,
  };
  return {
    record: {
      ok: full.ok,
      model: full.model,
      actualModel: full.actualModel,
      error: full.error,
      usage: full.usage,
    },
    full,
    background: false,
  };
}

function dependencies({ prepared = launch(), spawnAgent = async () => validSpawnResult(), active = 1, maximum = 3 } = {}) {
  return {
    prepareAgentLaunch: async () => prepared,
    getRunningAgentCount: () => active,
    getAgentSpentCost: () => 0,
    loadConfig: () => ({ orchestration: { maxConcurrency: maximum } }),
    resolveParentChildSpawnOpts: () => ({
      permissionProfile: "ask-all",
      parentPermissionProfile: "ask-all",
      sandbox: false,
      parentSandbox: false,
      mode: "review",
    }),
    spawnAgent,
  };
}

async function admittedHost(options = {}) {
  const host = createAlloyTeamsHost(dependencies(options));
  const selectedMember = member();
  const admission = await host.preflightMember({
    member: selectedMember,
    maxCostUsd: 1,
    timeoutMs: 1000,
  }, context);
  assert.equal(admission.ok, true);
  return { host, admission, selectedMember };
}

function run(host, admission, selectedMember, signal = new AbortController().signal) {
  return host.runMember({
    runId: RUN_ID,
    objective: "Find evidence.",
    member: selectedMember,
    dependencies: [],
    admission,
    maxCostUsd: 1,
    timeoutMs: 1000,
  }, context, signal);
}

test("advertised concurrency uses current tightened Alloy capacity and fails closed when exhausted", async () => {
  const host = createAlloyTeamsHost(dependencies({ active: 2, maximum: 5 }));
  assert.equal((await host.capabilities(context)).maxConcurrency, 3);

  const exhausted = createAlloyTeamsHost(dependencies({ active: 3, maximum: 3 }));
  await assert.rejects(exhausted.capabilities(context), /concurrency/i);

  for (const maximum of [0, 1.5, Number.POSITIVE_INFINITY]) {
    const malformed = createAlloyTeamsHost(dependencies({ active: 0, maximum }));
    await assert.rejects(malformed.capabilities(context), /concurrency/i);
  }
});

test("preflight rejects contradictory semantic routing and missing or malformed credential evidence", async () => {
  const cases = [
    launch({ decision: { ok: true, role: "review", model: MODEL } }),
    launch({ credential: { mode: "none", runtimeCredential: null } }),
    launch({ credential: { mode: "runtime-key", runtimeCredential: null } }),
    launch({ credential: { mode: "runtime-key", runtimeCredential: { provider: "other", apiKey: "x" } } }),
    launch({ credential: { mode: "runtime-key", runtimeCredential: { provider: "provider", apiKey: "" } } }),
  ];
  for (const prepared of cases) {
    const host = createAlloyTeamsHost(dependencies({ prepared }));
    const result = await host.preflightMember({ member: member(), maxCostUsd: 1, timeoutMs: 1000 }, context);
    assert.equal(result.ok, false);
  }
});

test("preflight blocks proxy, accessor, and cyclic successful routing data without invoking traps", async () => {
  let proxyTrap = 0;
  let getterTrap = 0;
  const proxied = launch();
  proxied.spec = new Proxy({}, { get() { proxyTrap++; return "unsafe"; } });
  const accessor = launch();
  Object.defineProperty(accessor.decision, "role", {
    enumerable: true,
    get() { getterTrap++; return "research"; },
  });
  const cyclic = launch();
  cyclic.self = cyclic;
  for (const prepared of [proxied, accessor, cyclic]) {
    const host = createAlloyTeamsHost(dependencies({ prepared }));
    const result = await host.preflightMember({ member: member(), maxCostUsd: 1, timeoutMs: 1000 }, context);
    assert.equal(result.ok, false);
    assert.match(result.reason, /^alloy_routing:/);
  }
  assert.equal(proxyTrap, 0);
  assert.equal(getterTrap, 0);
});

test("spawn receives exact read subset, explicit repository confinement, and subset-preservation seam", async () => {
  let call;
  const state = await admittedHost({
    spawnAgent: async (input) => {
      call = input;
      return validSpawnResult();
    },
  });
  const execution = run(state.host, state.admission, state.selectedMember);
  assert.deepEqual(call.tools, ["read"]);
  assert.equal(call.readRoot, "/repo");
  assert.equal(call.preserveReadOnlyToolSubset, true);
  assert.equal(call.maxOutputBytes, 1_048_576);
  assert.equal(call.tools.includes("write"), false);
  assert.equal(call.tools.includes("bash"), false);
  assert.equal((await execution.result).ok, true);
});

test("spawn result normalization rejects hostile, cyclic, malformed, oversized, over-budget, and contradictory evidence", async () => {
  let proxyTrap = 0;
  let getterTrap = 0;
  const proxied = validSpawnResult();
  proxied.full = new Proxy({}, { get() { proxyTrap++; return "unsafe"; } });
  const accessor = validSpawnResult();
  Object.defineProperty(accessor.full, "text", {
    enumerable: true,
    get() { getterTrap++; return "unsafe"; },
  });
  const cyclic = validSpawnResult();
  cyclic.full.self = cyclic.full;

  const cases = [
    proxied,
    accessor,
    cyclic,
    validSpawnResult({ usage: { input: -1, output: 0, cost: 0, costKnown: true } }),
    validSpawnResult({ usage: { input: 1.5, output: 0, cost: 0, costKnown: true } }),
    validSpawnResult({ usage: { input: 0, output: 0, cost: Number.NaN, costKnown: true } }),
    validSpawnResult({ usage: { input: 0, output: 0, cost: 2, costKnown: true } }),
    validSpawnResult({ text: "x".repeat(1_048_577) }),
    validSpawnResult({ actualModel: "other/model" }),
    validSpawnResult({ actualModel: null }),
    validSpawnResult({ model: "other/model" }),
    validSpawnResult({ ok: "yes" }),
  ];

  for (const output of cases) {
    const state = await admittedHost({ spawnAgent: async () => output });
    const result = await run(state.host, state.admission, state.selectedMember).result;
    assert.equal(result.ok, false);
    assert.match(result.error, /^alloy_child:/);
    assert.equal(result.usage.costUsd, null);
  }
  assert.equal(proxyTrap, 0);
  assert.equal(getterTrap, 0);
});

test("sync spawn throws and async rejection settle as bounded failures without inspecting hostile errors", async () => {
  let getterTrap = 0;
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    get() { getterTrap++; throw new Error("trap"); },
  });
  for (const spawnAgent of [
    () => { throw hostile; },
    () => Promise.reject(hostile),
  ]) {
    const state = await admittedHost({ spawnAgent });
    const result = await run(state.host, state.admission, state.selectedMember).result;
    assert.equal(result.ok, false);
    assert.match(result.error, /^alloy_child:/);
  }
  assert.equal(getterTrap, 0);
});

test("containment is exact, concurrent and idempotent while live, and stale after settlement", async () => {
  let settle;
  let signal;
  const pending = new Promise((resolve) => { settle = resolve; });
  const state = await admittedHost({
    spawnAgent: (input) => {
      signal = input.signal;
      return pending;
    },
  });
  const controller = new AbortController();
  controller.abort("already stopped");
  const execution = run(state.host, state.admission, state.selectedMember, controller.signal);
  assert.equal(signal.aborted, true);

  const containment = {
    runId: execution.runId,
    memberId: execution.memberId,
    handle: execution.handle,
  };
  await Promise.all([
    state.host.containMember(containment, context, new AbortController().signal),
    state.host.containMember(containment, context, new AbortController().signal),
  ]);
  assert.equal(signal.aborted, true);
  await assert.rejects(
    state.host.containMember({ ...containment, memberId: "other" }, context, new AbortController().signal),
    /execution identity/,
  );

  settle(validSpawnResult({ ok: false, text: "", error: "aborted" }));
  await execution.result;
  await assert.rejects(
    state.host.containMember(containment, context, new AbortController().signal),
    /execution identity/,
  );
});
