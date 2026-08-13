import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTaskRole,
  routeAgentTask,
} from "../../lib/orchestration-router.mjs";

const policy = {
  enabled: true,
  maxConcurrency: 2,
  roles: {
    research: {
      primary: "xai/grok-4.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    },
    implementation: {
      primary: "openai-codex/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    },
    review: {
      primary: "anthropic/claude-opus-5",
      fallbacks: ["anthropic/claude-opus-4-6"],
    },
    general: {
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: [],
    },
  },
};

function candidate(model, overrides = {}) {
  return {
    model,
    available: true,
    authenticated: true,
    transport: "builtin",
    supportsTools: true,
    ...overrides,
  };
}

describe("orchestration role classification", () => {
  it("honors a valid explicit role or alias", () => {
    assert.equal(classifyTaskRole("ignore the task", "review"), "review");
    assert.equal(classifyTaskRole("ignore the task", "builder"), "implementation");
  });

  it("classifies unambiguous task language deterministically", () => {
    assert.equal(classifyTaskRole("Research current OAuth options"), "research");
    assert.equal(classifyTaskRole("Write an architecture plan"), "planning");
    assert.equal(classifyTaskRole("Implement the approved API change"), "implementation");
    assert.equal(classifyTaskRole("Review this diff for regressions"), "review");
  });

  it("uses the first actionable intent for mixed task language", () => {
    assert.equal(classifyTaskRole("Fix the security regression"), "implementation");
    assert.equal(classifyTaskRole("Implement the architecture plan"), "implementation");
    assert.equal(classifyTaskRole("Build a research dashboard"), "implementation");
    assert.equal(classifyTaskRole("Review the implementation plan"), "review");
  });

  it("uses general for unknown or invalid input", () => {
    assert.equal(classifyTaskRole("Help me with this"), "general");
    assert.equal(classifyTaskRole(null), "general");
    assert.equal(classifyTaskRole("Help me", "untrusted-role"), "general");
  });
});

describe("orchestration route selection", () => {
  it("selects the configured primary and records a non-secret decision", () => {
    const decision = routeAgentTask({
      task: "Research the provider API",
      policy,
      providerAllow: ["xai", "anthropic"],
      candidates: [
        candidate("xai/grok-4.5"),
        candidate("anthropic/claude-sonnet-4-6"),
      ],
      requiresTools: true,
      activeChildren: 0,
      remainingBudgetUsd: 5,
    });

    assert.deepEqual(decision, {
      ok: true,
      role: "research",
      model: "xai/grok-4.5",
      provider: "xai",
      reason: "primary",
      fallbackUsed: false,
      candidates: ["xai/grok-4.5", "anthropic/claude-sonnet-4-6"],
      rejected: [],
    });
    assert.equal(JSON.stringify(decision).includes("apiKey"), false);
  });

  it("uses only a configured fallback when the primary is ineligible", () => {
    const decision = routeAgentTask({
      task: "Research the provider API",
      policy,
      providerAllow: ["xai", "anthropic"],
      candidates: [
        candidate("xai/grok-4.5", { authenticated: false }),
        candidate("anthropic/claude-sonnet-4-6"),
      ],
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.model, "anthropic/claude-sonnet-4-6");
    assert.equal(decision.reason, "fallback");
    assert.equal(decision.fallbackUsed, true);
    assert.deepEqual(decision.rejected, [
      { model: "xai/grok-4.5", reason: "provider is not authenticated" },
    ]);
  });

  it("honors an eligible configured model requested by the orchestrator", () => {
    const decision = routeAgentTask({
      task: "Research the provider API",
      requestedModel: "anthropic/claude-sonnet-4-6",
      policy,
      providerAllow: ["xai", "anthropic"],
      candidates: [
        candidate("xai/grok-4.5"),
        candidate("anthropic/claude-sonnet-4-6"),
      ],
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.model, "anthropic/claude-sonnet-4-6");
    assert.equal(decision.reason, "requested-model");
    assert.equal(decision.fallbackUsed, true);
  });

  it("honors an eligible requested model outside the role primary/fallback list", () => {
    // /fusion setup (and similar) may pin exact routes that are not the role primary.
    const decision = routeAgentTask({
      task: "Research the provider API",
      requestedModel: "openai/gpt-unconfigured",
      policy,
      providerAllow: ["xai", "anthropic", "openai"],
      candidates: [candidate("openai/gpt-unconfigured")],
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.model, "openai/gpt-unconfigured");
    assert.equal(decision.reason, "requested-model");
    assert.equal(decision.fallbackUsed, false);
  });

  it("still rejects an ineligible requested model outside the role list", () => {
    const decision = routeAgentTask({
      task: "Research the provider API",
      requestedModel: "openai/gpt-unconfigured",
      policy,
      providerAllow: ["xai", "anthropic", "openai"],
      candidates: [candidate("openai/gpt-unconfigured", { authenticated: false })],
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, false);
    assert.ok(decision.rejected.some((item) => item.model === "openai/gpt-unconfigured"));
  });

  it("fails closed on an unknown explicitly requested role", () => {
    const decision = routeAgentTask({
      task: "Help me with this",
      requestedRole: "administrator",
      policy,
      providerAllow: ["anthropic"],
      candidates: [candidate("anthropic/claude-sonnet-4-6")],
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "unknown orchestration role");
  });

  it("filters provider, transport, auth, tool, and budget failures", () => {
    const constrainedPolicy = {
      ...policy,
      roles: {
        ...policy.roles,
        implementation: {
          primary: "blocked/primary",
          fallbacks: [
            "custom/transport",
            "missing/auth",
            "text/no-tools",
            "price/expensive",
            "openai-codex/gpt-5.4",
          ],
        },
      },
    };
    const decision = routeAgentTask({
      task: "Implement the API change",
      policy: constrainedPolicy,
      providerAllow: ["custom", "missing", "text", "price", "openai-codex"],
      candidates: [
        candidate("blocked/primary"),
        candidate("custom/transport", { transport: "custom" }),
        candidate("missing/auth", { authenticated: false }),
        candidate("text/no-tools", { supportsTools: false }),
        candidate("price/expensive", { estimatedCostUsd: 3 }),
        candidate("openai-codex/gpt-5.4"),
      ],
      requiresTools: true,
      remainingBudgetUsd: 2,
    });

    assert.equal(decision.model, "openai-codex/gpt-5.4");
    assert.deepEqual(decision.rejected, [
      { model: "blocked/primary", reason: "provider is not allowed" },
      { model: "custom/transport", reason: "custom transport is not eligible" },
      { model: "missing/auth", reason: "provider is not authenticated" },
      { model: "text/no-tools", reason: "model does not support required tools" },
      { model: "price/expensive", reason: "estimated cost exceeds remaining budget" },
    ]);
  });

  it("accepts Alloy local-engine transports as eligible", () => {
    const decision = routeAgentTask({
      task: "Review this change",
      requestedRole: "review",
      policy: {
        enabled: true,
        maxConcurrency: 2,
        roles: {
          review: {
            primary: "ollama/llama3.2",
            fallbacks: [],
          },
        },
      },
      providerAllow: ["ollama"],
      candidates: [candidate("ollama/llama3.2", { transport: "local" })],
      requiresTools: true,
      remainingBudgetUsd: 5,
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.model, "ollama/llama3.2");
    assert.equal(decision.provider, "ollama");
  });

  it("fails before selection when orchestration, concurrency, or budget gates close", () => {
    const base = {
      task: "Research the provider API",
      policy,
      providerAllow: ["xai"],
      candidates: [candidate("xai/grok-4.5")],
      remainingBudgetUsd: 5,
    };

    assert.match(
      routeAgentTask({ ...base, policy: { ...policy, enabled: false } }).reason,
      /disabled/,
    );
    assert.match(routeAgentTask({ ...base, activeChildren: 2 }).reason, /concurrency/);
    assert.match(routeAgentTask({ ...base, remainingBudgetUsd: 0 }).reason, /budget/);
  });

  it("fails closed on malformed safety policy", () => {
    const base = {
      task: "Research the provider API",
      providerAllow: ["xai"],
      candidates: [candidate("xai/grok-4.5")],
      remainingBudgetUsd: 5,
    };

    assert.match(
      routeAgentTask({
        ...base,
        policy: { ...policy, maxConcurrency: "unlimited" },
      }).reason,
      /invalid orchestration policy.*maxConcurrency/,
    );
    assert.match(
      routeAgentTask({
        ...base,
        policy: {
          ...policy,
          roles: {
            ...policy.roles,
            research: {
              primary: "xai/grok-4.5",
              fallbacks: "anthropic/claude-sonnet-4-6",
            },
          },
        },
        remainingBudgetUsd: 5,
      }).reason,
      /invalid orchestration policy.*fallbacks/,
    );
  });

  it("fails closed on malformed top-level routing inputs", () => {
    const base = {
      task: "Research the provider API",
      policy,
      providerAllow: ["xai"],
      candidates: [candidate("xai/grok-4.5")],
      remainingBudgetUsd: 5,
    };

    for (const input of [
      { ...base, policy: null },
      { ...base, candidates: null },
      { ...base, providerAllow: null },
      { ...base, requestedModel: 42 },
      { ...base, activeChildren: "none" },
      { ...base, activeChildren: -1 },
      { ...base, remainingBudgetUsd: "unknown" },
      { ...base, remainingBudgetUsd: -1 },
    ]) {
      const decision = routeAgentTask(input);
      assert.equal(decision.ok, false, JSON.stringify(input));
      assert.match(decision.reason, /invalid|disabled/);
    }
  });

  it("rejects invalid cost estimates without bypassing configured fallbacks", () => {
    const decision = routeAgentTask({
      task: "Research the provider API",
      policy,
      providerAllow: ["xai", "anthropic"],
      candidates: [
        candidate("xai/grok-4.5", { estimatedCostUsd: "unknown" }),
        candidate("anthropic/claude-sonnet-4-6"),
      ],
      remainingBudgetUsd: 2,
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.model, "anthropic/claude-sonnet-4-6");
    assert.deepEqual(decision.rejected, [
      { model: "xai/grok-4.5", reason: "estimated cost is invalid" },
    ]);
  });

  it("requires a finite observed remaining budget", () => {
    const base = {
      task: "Research the provider API",
      policy,
      providerAllow: ["xai"],
      candidates: [candidate("xai/grok-4.5", { estimatedCostUsd: 1 })],
    };

    assert.match(routeAgentTask(base).reason, /invalid remaining budget/);
    assert.match(
      routeAgentTask({ ...base, remainingBudgetUsd: Infinity }).reason,
      /invalid remaining budget/,
    );
  });

  it("returns structured failures for malformed root requests and model route types", () => {
    const malformedRoot = routeAgentTask(null);
    assert.equal(malformedRoot.ok, false);
    assert.equal(malformedRoot.reason, "invalid routing request");

    const malformedPolicy = {
      ...policy,
      roles: {
        ...policy.roles,
        research: {
          primary: ["xai/grok-4.5"],
          fallbacks: [["anthropic/claude-sonnet-4-6"]],
        },
      },
    };
    const decision = routeAgentTask({
      task: "Research the provider API",
      policy: malformedPolicy,
      providerAllow: ["xai", "anthropic"],
      candidates: [candidate("xai/grok-4.5")],
      remainingBudgetUsd: 5,
    });
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /primary.*string|fallbacks.*string/);
  });
});
