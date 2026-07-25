import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareAgentLaunch } from "../../lib/agent-orchestration.mjs";
import {
  applyAgentBudget,
  assertAgentConcurrency,
  remainingAgentBudget,
} from "../../lib/agent-registry.mjs";
import {
  accumulateAssistantUsage,
  emptyUsage,
} from "../../lib/child-runner.mjs";

const { launchFreeAgent } = await import("../../extensions/agents.ts");

const config = {
  providers: { allow: ["xai", "anthropic", "openai-codex"] },
  budgets: { maxCostUsd: 5 },
  orchestration: {
    enabled: true,
    mainModel: "anthropic/claude-sonnet-4-6",
    maxConcurrency: 2,
    roles: {
      research: {
        primary: "xai/grok-4.5",
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
      planning: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: [],
      },
      implementation: {
        primary: "openai-codex/gpt-5.4",
        fallbacks: [],
      },
      review: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [],
      },
      general: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: [],
      },
    },
  },
};

function specFor({ profile, model, tools }) {
  const profileModels = {
    research: "xai/grok-4.5",
    code: "openai-codex/gpt-5.4",
    review: "anthropic/claude-opus-4-6",
    plan: "anthropic/claude-sonnet-4-6",
  };
  const profileTools = {
    research: ["read", "grep", "find", "ls"],
    code: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    review: ["read", "grep", "find", "ls"],
    plan: ["read", "grep", "find", "ls"],
    default: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  };
  return {
    profile: profile || "default",
    model: model || profileModels[profile] || null,
    tools: tools || profileTools[profile || "default"],
    systemPrompt: `prompt:${profile || "default"}`,
    label: profile || "default",
  };
}

function inspected(model, authenticated = true) {
  return {
    candidate: {
      model,
      available: true,
      authenticated,
      transport: "builtin",
      supportsTools: true,
    },
    lease: authenticated
      ? {
          mode: "runtime-key",
          runtimeCredential: { provider: model.split("/")[0], apiKey: "secret" },
          providers: [model.split("/")[0]],
          missing: [],
        }
      : {
          mode: "none",
          runtimeCredential: null,
          providers: [model.split("/")[0]],
          missing: [model.split("/")[0]],
        },
  };
}

function deps(inspectCandidate) {
  return {
    loadConfig: () => config,
    resolveAgentSpec: specFor,
    inspectCandidate,
  };
}

describe("free-agent orchestration", () => {
  it("classifies the task and selects an authenticated configured fallback", async () => {
    const result = await prepareAgentLaunch(
      {
        task: "Research the authentication flow",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
      },
      deps(async (model) => inspected(model, model.startsWith("anthropic/"))),
    );

    assert.equal(result.ok, true);
    assert.equal(result.spec.profile, "research");
    assert.equal(result.spec.model, "anthropic/claude-sonnet-4-6");
    assert.equal(result.decision.role, "research");
    assert.equal(result.decision.reason, "fallback");
    assert.deepEqual(result.credential, {
      mode: "runtime-key",
      runtimeCredential: {
        provider: "anthropic",
        apiKey: "secret",
      },
    });
    assert.equal(JSON.stringify(result.decision).includes("secret"), false);
    assert.equal(result.budgetUsd, 2.5);
  });

  it("partitions remaining budget across available concurrency slots", async () => {
    const first = await prepareAgentLaunch(
      {
        task: "Research the authentication flow",
        cwd: "/project",
        activeChildren: 0,
        spentCostUsd: 0,
      },
      deps(async (model) => inspected(model)),
    );
    const second = await prepareAgentLaunch(
      {
        task: "Review the change",
        cwd: "/project",
        activeChildren: 1,
        spentCostUsd: first.budgetUsd,
      },
      deps(async (model) => inspected(model)),
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.budgetUsd, 2.5);
    assert.equal(second.budgetUsd, 2.5);
  });

  it("treats a profile model as an explicit configured request", async () => {
    const result = await prepareAgentLaunch(
      {
        task: "Implement the approved change",
        profile: "code",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
      },
      deps(async (model) => inspected(model)),
    );

    assert.equal(result.ok, true);
    assert.equal(result.spec.profile, "code");
    assert.equal(result.spec.model, "openai-codex/gpt-5.4");
    assert.equal(result.decision.reason, "requested-model");
    assert.equal(result.spec.tools.includes("bash"), true);
  });

  it("allows requested tools to narrow but never expand the routed role", async () => {
    const result = await prepareAgentLaunch(
      {
        task: "Review the approved change",
        profile: "review",
        tools: ["read", "write", "bash"],
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
      },
      deps(async (model) => inspected(model)),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.spec.tools, ["read"]);

    const none = await prepareAgentLaunch(
      {
        task: "Review without tools",
        profile: "review",
        tools: [],
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
      },
      deps(async (model) => inspected(model)),
    );
    assert.equal(none.ok, true);
    assert.deepEqual(none.spec.tools, []);
  });

  it("returns the router failure without a credential when gates close", async () => {
    const result = await prepareAgentLaunch(
      {
        task: "Review the change",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 2,
      },
      deps(async (model) => inspected(model)),
    );

    assert.equal(result.ok, false);
    assert.match(result.decision.reason, /concurrency/);
    assert.equal(result.credential, null);
  });

  it("rejects malformed policy and budget before inspecting credentials", async () => {
    let inspections = 0;
    for (const broken of [
      {
        ...config,
        orchestration: { ...config.orchestration, maxConcurrency: "2" },
      },
      {
        ...config,
        budgets: { maxCostUsd: "5" },
      },
    ]) {
      const result = await prepareAgentLaunch(
        {
          task: "Research the authentication flow",
          cwd: "/project",
          modelRegistry: {},
          activeChildren: 0,
        },
        {
          loadConfig: () => broken,
          resolveAgentSpec: specFor,
          inspectCandidate: async (model) => {
            inspections++;
            return inspected(model);
          },
        },
      );
      assert.equal(result.ok, false);
      assert.match(result.decision.reason, /invalid/);
    }
    assert.equal(inspections, 0);
  });

  it("preserves explicit legacy routing when orchestration is disabled", async () => {
    const disabled = {
      ...config,
      orchestration: { ...config.orchestration, enabled: false },
    };
    const result = await prepareAgentLaunch(
      {
        task: "Review the change",
        profile: "review",
        model: "anthropic/claude-opus-4-6",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
      },
      {
        loadConfig: () => disabled,
        resolveAgentSpec: specFor,
        inspectCandidate: async (model) => inspected(model),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.spec.model, "anthropic/claude-opus-4-6");
    assert.equal(result.decision.reason, "explicit-legacy-route");
    assert.equal(result.credential.mode, "runtime-key");
  });

  it("fails closed on malformed orchestration enablement", async () => {
    const result = await prepareAgentLaunch(
      {
        task: "Review the change",
        cwd: "/project",
        activeChildren: 0,
        spentCostUsd: 0,
      },
      {
        loadConfig: () => ({
          ...config,
          orchestration: { ...config.orchestration, enabled: "true" },
        }),
        resolveAgentSpec: specFor,
        inspectCandidate: async () => assert.fail("must fail before auth"),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.decision.reason, /invalid orchestration policy/);
  });

  it("applies zero and previously spent budget before legacy or routed auth", async () => {
    let inspections = 0;
    const inspectCandidate = async (model) => {
      inspections++;
      return inspected(model);
    };
    const zeroBudget = {
      ...config,
      orchestration: { ...config.orchestration, enabled: false },
      budgets: { maxCostUsd: 0 },
    };
    const legacy = await prepareAgentLaunch(
      {
        task: "Review the change",
        profile: "review",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
        spentCostUsd: 0,
      },
      {
        loadConfig: () => zeroBudget,
        resolveAgentSpec: specFor,
        inspectCandidate,
      },
    );
    assert.equal(legacy.ok, false);
    assert.match(legacy.decision.reason, /budget/);

    const routed = await prepareAgentLaunch(
      {
        task: "Research the change",
        cwd: "/project",
        modelRegistry: {},
        activeChildren: 0,
        spentCostUsd: 5,
      },
      deps(inspectCandidate),
    );
    assert.equal(routed.ok, false);
    assert.match(routed.decision.reason, /budget/);
    assert.equal(inspections, 0);
  });

  it("enforces concurrency atomically and reports observed budget overruns", () => {
    assert.doesNotThrow(() => assertAgentConcurrency(1, 2));
    assert.throws(() => assertAgentConcurrency(2, 2), /concurrency limit/);

    const record = {
      ok: true,
      status: "ok",
      error: null,
      usage: { cost: 5.01 },
    };
    applyAgentBudget(record, 5);
    assert.equal(record.ok, false);
    assert.equal(record.status, "fail");
    assert.equal(record.error, "budget_exceeded");
    assert.equal(record.budgetExceeded, true);
    assert.equal(record.budgetError, "budget_exceeded");

    const timedOutOverBudget = {
      ok: false,
      status: "fail",
      error: "timeout",
      usage: { cost: 5.01, costKnown: true },
    };
    applyAgentBudget(timedOutOverBudget, 5);
    assert.equal(timedOutOverBudget.error, "timeout");
    assert.equal(timedOutOverBudget.budgetError, "budget_exceeded");

    const unknown = {
      ok: true,
      status: "ok",
      error: null,
      usage: { cost: null },
    };
    applyAgentBudget(unknown, 5);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, "budget_usage_unavailable");
    assert.equal(unknown.budgetUsageUnavailable, true);

    const failed = {
      ok: false,
      status: "fail",
      error: "timeout",
      usage: { cost: null, costKnown: false },
    };
    applyAgentBudget(failed, 5);
    assert.equal(failed.error, "timeout");
    assert.equal(failed.budgetUsageUnavailable, true);

    const parsed = { input: 0, output: 0, cost: 0, turns: 0, costKnown: true };
    accumulateAssistantUsage(parsed, {
      role: "assistant",
      usage: { input: 10, output: 3 },
    });
    assert.equal(parsed.costKnown, false);
    assert.equal(emptyUsage(false).costKnown, false);
    assert.equal(emptyUsage(true).costKnown, true);

    assert.equal(remainingAgentBudget(1.25, 5), 3.75);
    assert.throws(() => remainingAgentBudget(5, 5), /budget.*exhausted/i);
    assert.throws(() => remainingAgentBudget(Number.NaN, 5), /invalid.*budget/i);
  });

  it("passes the same routed credential and parent boundary to the shared spawner", async () => {
    let captured = null;
    const result = await launchFreeAgent(
      { name: "reviewer", task: "Review the change" },
      { registry: true },
      undefined,
      undefined,
      {
        getRunningAgentCount: () => 1,
        getAgentSpentCost: () => 1.25,
        prepareAgentLaunch: async (input) => {
          assert.equal(input.activeChildren, 1);
          assert.equal(input.spentCostUsd, 1.25);
          return {
            ok: true,
            spec: {
              model: "anthropic/claude-opus-4-6",
              profile: "review",
              tools: ["read"],
              systemPrompt: "review safely",
            },
            decision: {
              role: "review",
              reason: "primary",
              fallbackUsed: false,
              credentialBoundary: "runtime-key",
            },
            credential: {
              mode: "runtime-key",
              runtimeCredential: {
                provider: "anthropic",
                apiKey: "synthetic-secret",
              },
            },
            maxConcurrency: 2,
            budgetUsd: 3.75,
            budgetLimitUsd: 5,
          };
        },
        resolveParentChildSpawnOpts: () => ({
          parentPermissionProfile: "ask-all",
          parentSandbox: true,
        }),
        spawnAgent: async (options) => {
          captured = options;
          return { record: { id: "agent-1" } };
        },
      },
    );

    assert.equal(result.record.id, "agent-1");
    assert.equal(captured.credentialBroker, "runtime-key");
    assert.equal(captured.brokerRuntimeCredential.apiKey, "synthetic-secret");
    assert.equal(captured.parentPermissionProfile, "ask-all");
    assert.equal(captured.parentSandbox, true);
    assert.equal(captured.maxConcurrency, 2);
    assert.equal(captured.budgetUsd, 3.75);
    assert.equal(captured.budgetLimitUsd, 5);
    assert.equal(JSON.stringify(captured.routeDecision).includes("synthetic-secret"), false);
  });
});
