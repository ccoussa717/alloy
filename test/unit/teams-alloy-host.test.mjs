import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function member(overrides = {}) {
  return {
    id: "researcher",
    route: "research",
    capabilities: ["repo.read"],
    tools: ["read", "grep", "find", "ls"],
    needs: [],
    instructions: "Inspect the repository and report evidence.",
    ...overrides,
  };
}

function successfulLaunch(overrides = {}) {
  return {
    ok: true,
    spec: {
      model: "provider/research-model",
      profile: "research",
      tools: ["read", "grep", "find", "ls"],
      systemPrompt: "Read-only research.",
    },
    decision: { ok: true, role: "research", model: "provider/research-model" },
    credential: {
      mode: "runtime-key",
      runtimeCredential: { provider: "provider", apiKey: "opaque" },
    },
    maxConcurrency: 3,
    budgetUsd: 2,
    budgetLimitUsd: 5,
    ...overrides,
  };
}

function harness(launch = successfulLaunch()) {
  const prepareCalls = [];
  const runningCalls = [];
  const spentCalls = [];
  const parentCalls = [];
  const spawnCalls = [];
  const pending = deferred();
  const dependencies = {
    prepareAgentLaunch: async (input) => {
      prepareCalls.push(input);
      return launch;
    },
    getRunningAgentCount: (cwd) => {
      runningCalls.push(cwd);
      return 1;
    },
    getAgentSpentCost: (cwd) => {
      spentCalls.push(cwd);
      return 0.5;
    },
    loadConfig: () => ({ orchestration: { maxConcurrency: 3 } }),
    resolveParentChildSpawnOpts: (input) => {
      parentCalls.push(input);
      return {
        permissionProfile: "ask-all",
        parentPermissionProfile: "ask-all",
        sandbox: true,
        parentSandbox: true,
        mode: "review",
      };
    },
    spawnAgent: (input) => {
      spawnCalls.push(input);
      return pending.promise;
    },
  };
  return {
    dependencies,
    pending,
    parentCalls,
    prepareCalls,
    runningCalls,
    spentCalls,
    spawnCalls,
  };
}

const context = {
  cwd: "/repo",
  projectId: "project",
  projectTrusted: true,
  source: "command",
  runtime: { modelRegistry: { id: "registry" } },
};

test("Alloy host routes semantic read-only members through existing admission primitives", async () => {
  const { createAlloyTeamsHost } = await import("../../lib/teams-host.mjs");
  const state = harness();
  const host = createAlloyTeamsHost(state.dependencies);

  assert.equal(host.id, "alloy");
  assert.deepEqual(await host.capabilities(context), {
    capabilities: ["repo.read"],
    tools: ["read", "grep", "find", "ls"],
    maxConcurrency: 2,
    supportsCancellation: true,
  });

  const admission = await host.preflightMember({
    member: member(),
    maxCostUsd: 2 / 3,
    timeoutMs: 120_000,
  }, context);

  assert.equal(admission.ok, true);
  assert.equal(state.prepareCalls[0].requestedRole, "research");
  assert.deepEqual(state.prepareCalls[0].tools, ["read", "grep", "find", "ls"]);
  assert.equal(state.prepareCalls[0].activeChildren, 1);
  assert.equal(state.prepareCalls[0].spentCostUsd, 0.5);
  assert.equal(state.prepareCalls[0].modelRegistry, context.runtime.modelRegistry);
  assert.deepEqual(state.runningCalls, ["/repo", "/repo"]);
  assert.deepEqual(state.spentCalls, ["/repo"]);
  assert.equal(admission.timeoutMs, 120_000);
  assert.equal(Number.isInteger(admission.timeoutMs), true);
  assert.equal(admission.maxCostUsd, 2 / 3);
  assert.equal(Object.isFrozen(admission.token), true);
});

test("Alloy host blocks failed routing, authority widening, and timeout widening", async () => {
  const { createAlloyTeamsHost } = await import("../../lib/teams-host.mjs");

  const failed = createAlloyTeamsHost(harness({
    ok: false,
    decision: { reason: "no eligible configured model" },
  }).dependencies);
  const failedAdmission = await failed.preflightMember({
    member: member({ tools: ["read"] }),
    maxCostUsd: 1,
    timeoutMs: 1000,
  }, context);
  assert.equal(failedAdmission.ok, false);
  assert.match(failedAdmission.reason, /^alloy_routing:/);

  const widenedTools = successfulLaunch({
    spec: {
      ...successfulLaunch().spec,
      tools: ["read", "write"],
    },
  });
  const toolAdmission = await createAlloyTeamsHost(harness(widenedTools).dependencies)
    .preflightMember({ member: member({ tools: ["read"] }), maxCostUsd: 1, timeoutMs: 1000 }, context);
  assert.equal(toolAdmission.ok, false);
  assert.match(toolAdmission.reason, /^alloy_tool:/);

  const timeoutAdmission = await createAlloyTeamsHost(harness(successfulLaunch({
    timeoutMs: 1001,
  })).dependencies).preflightMember({
    member: member(),
    maxCostUsd: 1,
    timeoutMs: 1000,
  }, context);
  assert.equal(timeoutAdmission.ok, false);
  assert.match(timeoutAdmission.reason, /^alloy_timeout:/);

  const host = createAlloyTeamsHost(harness().dependencies);
  for (const invalid of [
    member({ capabilities: ["repo.read", "repo.write"] }),
    member({ tools: ["read", "bash"] }),
  ]) {
    const result = await host.preflightMember({
      member: invalid,
      maxCostUsd: 1,
      timeoutMs: 1000,
    }, context);
    assert.equal(result.ok, false);
  }
});

test("Alloy run returns synchronously, reuses spawn policy, maps evidence, and contains only its handle", async () => {
  const { createAlloyTeamsHost } = await import("../../lib/teams-host.mjs");
  const first = harness();
  const second = harness();
  const host = createAlloyTeamsHost(first.dependencies);
  const otherHost = createAlloyTeamsHost(second.dependencies);
  const selectedMember = member();
  const admission = await host.preflightMember({
    member: selectedMember,
    maxCostUsd: 2 / 3,
    timeoutMs: 120_000,
  }, context);
  const otherAdmission = await otherHost.preflightMember({
    member: selectedMember,
    maxCostUsd: 2 / 3,
    timeoutMs: 120_000,
  }, context);
  assert.equal(admission.ok, true);
  assert.equal(otherAdmission.ok, true);

  const parentSignal = new AbortController();
  const execution = host.runMember({
    runId: "00000000-0000-4000-8000-000000000001",
    objective: "Find the cause.",
    member: selectedMember,
    dependencies: [],
    admission,
    maxCostUsd: admission.maxCostUsd,
    timeoutMs: admission.timeoutMs,
  }, context, parentSignal.signal);
  const otherExecution = otherHost.runMember({
    runId: "00000000-0000-4000-8000-000000000002",
    objective: "Find another cause.",
    member: selectedMember,
    dependencies: [],
    admission: otherAdmission,
    maxCostUsd: otherAdmission.maxCostUsd,
    timeoutMs: otherAdmission.timeoutMs,
  }, context, new AbortController().signal);

  assert.equal(execution.runId, "00000000-0000-4000-8000-000000000001");
  assert.equal(execution.memberId, "researcher");
  assert.equal(typeof execution.handle, "object");
  assert.equal(first.spawnCalls.length, 1);
  assert.deepEqual(first.parentCalls, [{ mode: "review" }]);
  assert.equal(first.spawnCalls[0].model, "provider/research-model");
  assert.equal(first.spawnCalls[0].profile, "research");
  assert.deepEqual(first.spawnCalls[0].tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(first.spawnCalls[0].routeDecision, successfulLaunch().decision);
  assert.equal(first.spawnCalls[0].mode, "review");
  assert.equal(first.spawnCalls[0].background, false);
  assert.equal(first.spawnCalls[0].permissionProfile, "ask-all");
  assert.equal(first.spawnCalls[0].parentPermissionProfile, "ask-all");
  assert.equal(first.spawnCalls[0].timeoutMs, admission.timeoutMs);
  assert.equal(first.spawnCalls[0].budgetUsd, 2 / 3);
  assert.equal(first.spawnCalls[0].budgetLimitUsd, 5);
  assert.equal(first.spawnCalls[0].credentialBroker, "runtime-key");
  assert.deepEqual(first.spawnCalls[0].brokerRuntimeCredential, {
    provider: "provider",
    apiKey: "opaque",
  });
  assert.equal(first.spawnCalls[0].signal.aborted, false);
  assert.equal(second.spawnCalls[0].signal.aborted, false);

  await host.containMember({
    runId: execution.runId,
    memberId: execution.memberId,
    handle: execution.handle,
  }, context, new AbortController().signal);
  assert.equal(first.spawnCalls[0].signal.aborted, true);
  assert.equal(second.spawnCalls[0].signal.aborted, false);

  await assert.rejects(
    otherHost.containMember({
      runId: execution.runId,
      memberId: execution.memberId,
      handle: execution.handle,
    }, context, new AbortController().signal),
    /execution identity/,
  );

  const firstFull = {
    ok: true,
    text: "Evidence",
    model: "provider/research-model",
    actualModel: "provider/research-model",
    error: null,
    usage: { input: 11, output: 7, cost: 0.25, costKnown: true },
  };
  first.pending.resolve({
    record: {
      ok: firstFull.ok,
      model: firstFull.model,
      actualModel: firstFull.actualModel,
      error: firstFull.error,
      usage: firstFull.usage,
    },
    full: firstFull,
    background: false,
  });
  const secondFull = {
    ok: false,
    text: "",
    model: "provider/research-model",
    error: "aborted",
    actualModel: "provider/research-model",
    usage: { input: 0, output: 0, cost: 0, costKnown: true },
  };
  second.pending.resolve({
    record: {
      ok: secondFull.ok,
      model: secondFull.model,
      actualModel: secondFull.actualModel,
      error: secondFull.error,
      usage: secondFull.usage,
    },
    full: secondFull,
    background: false,
  });
  assert.deepEqual(await execution.result, {
    ok: true,
    text: "Evidence",
    model: "provider/research-model",
    usage: { input: 11, output: 7, costUsd: 0.25 },
  });
  await otherExecution.result;
});

test("Alloy adapter does not import a second workflow, router, worktree, or diagnostics stack", () => {
  const source = readFileSync(new URL("../../lib/teams-host.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    "auto-workflow",
    "fusion",
    "fission",
    "forge",
    "worktree",
    "diagnostics",
  ]) {
    assert.doesNotMatch(source, new RegExp(`(?:import|require)[^\\n]*${forbidden}`, "i"));
  }
});
