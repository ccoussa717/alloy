import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareExactAgentLaunch } from "../../lib/agent-orchestration.mjs";

const route = "anthropic/claude-opus-4-6";
const baseConfig = {
  providers: { allow: ["anthropic", "openai-codex"] },
  budgets: { maxCostUsd: 6 },
  orchestration: { enabled: true, maxConcurrency: 3 },
};

function specFor({ profile, model, tools }) {
  return {
    profile: profile || "review",
    model: model || null,
    tools: tools ?? ["read", "grep", "find", "ls"],
    systemPrompt: "review",
    label: "review",
  };
}

function inspection(overrides = {}) {
  return {
    candidate: {
      model: route,
      available: true,
      authenticated: true,
      transport: "builtin",
      supportsTools: true,
      ...overrides.candidate,
    },
    lease: overrides.lease === undefined
      ? {
          mode: "runtime-key",
          runtimeCredential: { provider: "anthropic", apiKey: "synthetic-secret" },
        }
      : overrides.lease,
  };
}

function dependencies({ config = baseConfig, inspect = inspection() } = {}) {
  const inspected = [];
  return {
    inspected,
    deps: {
      loadConfig: () => config,
      resolveAgentSpec: specFor,
      inspectCandidate: async (model) => {
        inspected.push(model);
        return typeof inspect === "function" ? inspect(model) : inspect;
      },
    },
  };
}

describe("exact agent launch admission", () => {
  it("admits one exact built-in route without fallback or credential disclosure", async () => {
    const { deps, inspected } = dependencies();
    const result = await prepareExactAgentLaunch({
      cwd: "/project",
      model: route,
      profile: "review",
      tools: ["read", "grep", "find", "ls"],
      activeChildren: 1,
      spentCostUsd: 2,
    }, deps);

    assert.equal(result.ok, true);
    assert.deepEqual(inspected, [route]);
    assert.equal(result.spec.model, route);
    assert.equal(result.decision.model, route);
    assert.equal(result.decision.provider, "anthropic");
    assert.equal(result.decision.fallbackUsed, false);
    assert.deepEqual(result.decision.candidates, [route]);
    assert.equal(JSON.stringify(result.decision).includes("synthetic-secret"), false);
    assert.equal(result.credential.mode, "runtime-key");
    assert.equal(result.maxConcurrency, 3);
    assert.equal(result.budgetUsd, 2);
    assert.equal(result.budgetLimitUsd, 6);
  });

  it("rejects malformed routes, disabled orchestration, provider denial, capacity, and budget before inspection", async () => {
    const cases = [
      [{ model: "anthropic", activeChildren: 0, spentCostUsd: 0 }, baseConfig, /provider\/model/],
      [{ model: "/opus", activeChildren: 0, spentCostUsd: 0 }, baseConfig, /provider\/model/],
      [{ model: route, activeChildren: 0, spentCostUsd: 0 }, { ...baseConfig, orchestration: { ...baseConfig.orchestration, enabled: false } }, /enabled/],
      [{ model: "xai/grok", activeChildren: 0, spentCostUsd: 0 }, baseConfig, /not allowed/],
      [{ model: route, activeChildren: 3, spentCostUsd: 0 }, baseConfig, /concurrency/],
      [{ model: route, activeChildren: 0, spentCostUsd: 6 }, baseConfig, /budget/],
    ];
    for (const [input, config, reason] of cases) {
      const { deps, inspected } = dependencies({ config });
      const result = await prepareExactAgentLaunch({ cwd: "/project", profile: "review", tools: ["read"], ...input }, deps);
      assert.equal(result.ok, false);
      assert.match(result.decision.reason, reason);
      assert.deepEqual(inspected, []);
      assert.equal(result.credential, null);
      assert.equal(JSON.stringify(result.decision).includes("synthetic-secret"), false);
    }
  });

  it("inspects only the requested route and fails closed for every candidate or lease defect", async () => {
    const defects = [
      [inspection({ candidate: { available: false } }), /not available/],
      [inspection({ candidate: { transport: "custom" } }), /custom transport/],
      [inspection({ candidate: { authenticated: false } }), /not authenticated/],
      [inspection({ candidate: { supportsTools: false } }), /tools/],
      [inspection({ lease: null }), /credential/],
      [inspection({ lease: { mode: "runtime-key", runtimeCredential: { provider: "openai-codex", apiKey: "wrong" } } }), /credential provider/],
    ];
    for (const [inspect, reason] of defects) {
      const { deps, inspected } = dependencies({ inspect });
      const result = await prepareExactAgentLaunch({
        cwd: "/project",
        model: route,
        profile: "review",
        tools: ["read"],
        activeChildren: 0,
        spentCostUsd: 0,
      }, deps);
      assert.equal(result.ok, false);
      assert.match(result.decision.reason, reason);
      assert.deepEqual(inspected, [route]);
      assert.equal(result.credential, null);
      assert.equal(JSON.stringify(result.decision).includes("wrong"), false);
    }
  });
});
