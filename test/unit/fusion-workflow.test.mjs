import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import * as fusion from "../../lib/fusion.mjs";
import * as agentRegistry from "../../lib/agent-registry.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRunDir() {
  const root = mkdtempSync(join(tmpdir(), "alloy-fusion-test-"));
  const runDir = join(root, "run-1");
  mkdirSync(runDir, { recursive: true });
  roots.push(root);
  return runDir;
}

const config = {
  providers: {
    allow: ["anthropic", "openai-codex"],
    favorites: ["anthropic/architect", "openai-codex/builder"],
  },
  roles: { reviewer: { model: "anthropic/synthesizer" } },
  fusion: {
    architectEffort: "high",
    builderEffort: "medium",
    synthesizerEffort: "low",
  },
  budgets: { maxCostUsd: 10 },
};

const proposals = {
  "fusion-architect": `## Perspective
Architecture view.
## Proposed approach
Boundaries first.
## Evidence
Observed files.
## Risks
Trust boundaries.
## Verification
Run tests.`,
  "fusion-builder": `## Perspective
Builder view.
## Proposed approach
Small implementation.
## Evidence
Observed callers.
## Risks
Regression risk.
## Verification
Run tests.`,
};

const synthesis = `## Agreements
Both models support a bounded workflow.
## Disagreements
- Architect: Prioritize explicit boundaries.
- Builder: Prioritize implementation size.
- Status: resolved — use the smallest implementation that preserves the boundary.
## Consensus
- Decision: Build the smallest workflow that preserves the explicit boundary.
- Caveats: Verify the boundary before release.`;

function deps(runDir, runChildAgent, lease = null) {
  return {
    createRunDir: () => runDir,
    loadConfig: () => config,
    loadCredentialLease: (models) => {
      if (lease) return lease;
      const provider = models[0].split("/", 1)[0];
      const secret = provider === "anthropic" ? "secret-a" : "secret-b";
      return {
        mode: "runtime-key",
        runtimeCredential: { provider, apiKey: secret },
        providers: [provider],
        missing: [],
      };
    },
    runChildAgent,
  };
}

test("architect and builder run in parallel before attributed synthesis", async () => {
  assert.equal(
    typeof fusion.runFusionWithDependencies,
    "function",
    "fusion dependency seam should exist",
  );
  const runDir = makeRunDir();
  const calls = [];
  const leaseRequests = [];
  let active = 0;
  let maxActive = 0;
  const architectTail = `ARCHITECT TAIL ${"x".repeat(60_100)}`;
  const panels = [];
  const runChildAgent = async (options) => {
    calls.push(options);
    active++;
    maxActive = Math.max(maxActive, active);
    options.onEvent?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "live" },
      outputText: `live ${options.role}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    const text = options.role === "fusion-architect"
      ? `${proposals[options.role]}\n${architectTail}`
      : proposals[options.role] || synthesis;
    return {
      ok: true,
      text,
      model: options.model,
      usage: { input: 10, output: 5, cost: 0.1, turns: 1 },
      stdoutBytes: 123,
      eventCount: 4,
      events: [],
    };
  };

  const workflowDeps = deps(runDir, runChildAgent);
  const loadCredentialLease = workflowDeps.loadCredentialLease;
  workflowDeps.loadCredentialLease = (models) => {
    leaseRequests.push(models);
    return loadCredentialLease(models);
  };
  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Design the feature",
      cwd: process.cwd(),
      mode: "plan",
      parentPermissionProfile: "ask-all",
      onPanel: (panel) => panels.push(structuredClone(panel)),
    },
    workflowDeps,
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(calls.map((call) => call.role), [
    "fusion-architect",
    "fusion-builder",
    "fusion-synthesizer",
  ]);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.model), [
    "anthropic/architect",
    "openai-codex/builder",
  ]);
  assert.deepEqual(calls.map((call) => call.thinkingLevel), [
    "high",
    "medium",
    "low",
  ]);
  assert.ok(calls.every((call) => call.mode === "plan"));
  assert.ok(calls.every((call) => call.tools.every((tool) => tool !== "bash")));
  assert.ok(calls.every((call) => call.credentialBroker === "runtime-key"));
  assert.ok(calls.every((call) => call.permissionProfile === "ask-all"));
  assert.ok(calls.every((call) => call.parentPermissionProfile === "ask-all"));
  assert.ok(calls.every((call) => call.readRoot === process.cwd()));
  assert.deepEqual(calls.map((call) => call.brokerRuntimeCredential.provider), [
    "anthropic",
    "openai-codex",
    "anthropic",
  ]);
  assert.ok(
    panels.some((panel) => {
      const architect = panel.agents.find((agent) => agent.role === "architect");
      const builder = panel.agents.find((agent) => agent.role === "builder");
      return panel.objective === "Design the feature" && architect?.output?.includes("live fusion-architect") && builder?.output?.includes("live fusion-builder");
    }),
  );
  const synthesisPrompt = calls[2].prompt;
  assert.ok(synthesisPrompt.indexOf("## Agreements") < synthesisPrompt.indexOf("## Disagreements"));
  assert.ok(synthesisPrompt.indexOf("## Disagreements") < synthesisPrompt.indexOf("## Consensus"));
  assert.match(synthesisPrompt, /attribute each model's position/i);
  assert.match(synthesisPrompt, /do not invent agreement/i);
  assert.match(synthesisPrompt, /- Status: resolved\|open\|none/);
  assert.match(synthesisPrompt, /ARCHITECT TAIL/);
  assert.deepEqual(leaseRequests, [
    ["anthropic/architect"],
    ["openai-codex/builder"],
    ["anthropic/synthesizer"],
  ]);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(summary.objective, "Design the feature");
  assert.equal(summary.synthesis, synthesis);
  assert.equal(summary.proposals.length, 2);
  assert.ok(summary.proposals.every((proposal) => Number.isFinite(proposal.durationMs)));
  assert.deepEqual(summary.proposals.map((proposal) => proposal.stdoutBytes), [123, 123]);
  assert.deepEqual(summary.proposals.map((proposal) => proposal.eventCount), [4, 4]);
  assert.equal(summary.synthesizer.stdoutBytes, 123);
  assert.equal(summary.synthesizer.eventCount, 4);
  assert.ok(Number.isFinite(summary.synthesizer.durationMs));
  assert.equal(summary.usage.cost, 0.3);
  assert.deepEqual(summary.requestedEfforts, {
    architect: "high",
    builder: "medium",
    synthesizer: "low",
  });

  const artifactText = [
    "request.md",
    "fusion/models.json",
    "fusion/architect.md",
    "fusion/builder.md",
    "fusion/synthesis.md",
    "summary.json",
  ]
    .map((path) => readFileSync(join(runDir, path), "utf8"))
    .join("\n");
  assert.equal(artifactText.includes("secret-a"), false);
  assert.equal(artifactText.includes("secret-b"), false);
  assert.match(artifactText, /"requestedEfforts"/);
  assert.match(artifactText, /"architect": "high"/);
});

test("invalid proposal skips synthesis and cannot complete", async () => {
  assert.equal(typeof fusion.runFusionWithDependencies, "function");
  const runDir = makeRunDir();
  const calls = [];
  const runChildAgent = async (options) => {
    calls.push(options);
    return {
      ok: true,
      text:
        options.role === "fusion-builder"
          ? "unstructured answer"
          : proposals[options.role],
      model: options.model,
      usage: { input: 1, output: 1, cost: 0, turns: 1 },
      events: [],
    };
  };

  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    deps(runDir, runChildAgent),
  );

  assert.equal(calls.length, 2);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.proposals[1].error, "invalid_proposal");
  assert.equal(summary.synthesis, "");
});

test("parent-inaccessible providers fail before spawning children", async () => {
  assert.equal(typeof fusion.runFusionWithDependencies, "function");
  const runDir = makeRunDir();
  let calls = 0;
  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    deps(
      runDir,
      async () => {
        calls++;
        throw new Error("must not spawn");
      },
      {
        mode: "none",
        authJson: null,
        providers: ["anthropic", "openai-codex"],
        missing: ["openai-codex"],
      },
    ),
  );

  assert.equal(calls, 0);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "provider_unavailable");
  assert.deepEqual(summary.missingProviders, ["openai-codex"]);
});

test("worker cost can stop the workflow before synthesis", async () => {
  assert.equal(typeof fusion.runFusionWithDependencies, "function");
  const runDir = makeRunDir();
  let calls = 0;
  const expensiveConfig = structuredClone(config);
  expensiveConfig.budgets.maxCostUsd = 1;
  const baseDeps = deps(runDir, async (options) => {
    calls++;
    return {
      ok: true,
      text: proposals[options.role],
      model: options.model,
      usage: { input: 1, output: 1, cost: 0.75, turns: 1 },
      events: [],
    };
  });
  baseDeps.loadConfig = () => expensiveConfig;

  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    baseDeps,
  );

  assert.equal(calls, 2);
  assert.equal(summary.status, "BUDGET_EXCEEDED");
  assert.equal(summary.usage.cost, 1.5);
});

test("synthesis credential failure is reported as provider unavailable", async () => {
  const runDir = makeRunDir();
  let calls = 0;
  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    deps(runDir, async (options) => {
      calls++;
      if (options.role === "fusion-synthesizer") {
        return {
          ok: false,
          error: "auth_required",
          text: "",
          model: options.model,
          usage: { input: 0, output: 0, cost: 0, turns: 0 },
        };
      }
      return {
        ok: true,
        text: proposals[options.role],
        model: options.model,
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
      };
    }),
  );

  assert.equal(calls, 3);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.synthesizer.error, "provider_unavailable");
  assert.equal(summary.error, "provider_unavailable");
  assert.deepEqual(summary.missingProviders, ["anthropic"]);
});

test("synthesis cost can exceed the total workflow budget", async () => {
  const runDir = makeRunDir();
  const budgetConfig = structuredClone(config);
  budgetConfig.budgets.maxCostUsd = 1;
  const workflowDeps = deps(runDir, async (options) => ({
    ok: true,
    text: proposals[options.role] || synthesis,
    model: options.model,
    usage: {
      input: 1,
      output: 1,
      cost: options.role === "fusion-synthesizer" ? 0.6 : 0.25,
      turns: 1,
    },
  }));
  workflowDeps.loadConfig = () => budgetConfig;

  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    workflowDeps,
  );

  assert.equal(summary.status, "BUDGET_EXCEEDED");
  assert.equal(summary.usage.cost, 1.1);
});

test("negative budgets fail closed before synthesis", async () => {
  const runDir = makeRunDir();
  const budgetConfig = structuredClone(config);
  budgetConfig.budgets.maxCostUsd = -1;
  let calls = 0;
  const workflowDeps = deps(runDir, async (options) => {
    calls++;
    return {
      ok: true,
      text: proposals[options.role],
      model: options.model,
      usage: { input: 1, output: 1, cost: 100, turns: 1 },
    };
  });
  workflowDeps.loadConfig = () => budgetConfig;

  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    workflowDeps,
  );

  assert.equal(calls, 2);
  assert.equal(summary.status, "BUDGET_EXCEEDED");
});

test("thrown proposal failure persists FAILED status and skips synthesis", async () => {
  const runDir = makeRunDir();
  let calls = 0;
  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    deps(runDir, async (options) => {
      calls++;
      if (options.role === "fusion-builder") throw new Error("setup exploded");
      return {
        ok: true,
        text: proposals[options.role],
        model: options.model,
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
      };
    }),
  );

  assert.equal(calls, 2);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.proposals[1].error, "child_failed");
  assert.deepEqual(summary.proposals[1].usage, { input: 0, output: 0, cost: null, turns: 0, costKnown: false });
  assert.equal(summary.usage.costKnown, false);
  assert.equal(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")).status, "FAILED");
});

test("thrown synthesis failure persists FAILED status", async () => {
  const runDir = makeRunDir();
  const summary = await fusion.runFusionWithDependencies(
    { request: "Design the feature", cwd: process.cwd() },
    deps(runDir, async (options) => {
      if (options.role === "fusion-synthesizer") throw new Error("setup exploded");
      return {
        ok: true,
        text: proposals[options.role],
        model: options.model,
        usage: { input: 1, output: 1, cost: 0, turns: 1 },
      };
    }),
  );

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.synthesizer.error, "child_failed");
  assert.equal(summary.usage.costKnown, false);
  assert.equal(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")).status, "FAILED");
});

function routedFusionConfig({ maxConcurrency = 1, maxCostUsd = 2 } = {}) {
  return {
    ...structuredClone(config),
    budgets: { maxCostUsd },
    orchestration: { enabled: true, maxConcurrency },
  };
}

function routedFusionDeps(runDir, runChildAgent, cfg = routedFusionConfig()) {
  const preparations = [];
  const reservations = [];
  const settlements = [];
  const activeReservations = new Map();
  let observed = 0;
  const routes = {
    planning: "anthropic/architect-fallback",
    implementation: "openai-codex/builder-primary",
    review: "anthropic/reviewer-primary",
  };
  return {
    preparations,
    reservations,
    settlements,
    deps: {
      createRunDir: () => runDir,
      loadConfig: () => cfg,
      getRunningAgentCount: () => activeReservations.size,
      getAgentSpentCost: () => {
        if (!Number.isFinite(observed)) return observed;
        return [...activeReservations.values()].reduce(
          (total, reservation) => total + reservation.budgetUsd,
          observed,
        );
      },
      reserveAgentLaunch: (input) => {
        if (activeReservations.size >= input.maxConcurrency) {
          throw new Error("concurrency limit");
        }
        const spent = Number.isFinite(observed)
          ? [...activeReservations.values()].reduce(
              (total, reservation) => total + reservation.budgetUsd,
              observed,
            )
          : observed;
        if (!Number.isFinite(spent)) throw new Error("invalid budget state");
        const budgetUsd = Math.min(input.budgetUsd, input.budgetLimitUsd - spent);
        if (!(budgetUsd > 0)) throw new Error("budget exhausted");
        const reservation = {
          id: `fusion-reservation-${reservations.length + 1}`,
          budgetUsd,
        };
        reservations.push({ ...input, ...reservation });
        activeReservations.set(reservation.id, reservation);
        return reservation;
      },
      settleAgentLaunch: (reservation, usage) => {
        activeReservations.delete(reservation.id);
        settlements.push({ reservation, usage });
        if (
          usage?.costKnown === false ||
          typeof usage?.cost !== "number" ||
          !Number.isFinite(usage.cost)
        ) {
          observed = Number.NaN;
        } else if (Number.isFinite(observed)) {
          observed += usage.cost;
        }
      },
      prepareAgentLaunch: async (input) => {
        preparations.push(input);
        const model = routes[input.requestedRole];
        const provider = model.split("/", 1)[0];
        return {
          ok: true,
          spec: { model, tools: input.tools, profile: input.profile },
          decision: {
            ok: true,
            role: input.requestedRole,
            model,
            provider,
            reason: input.requestedRole === "planning" ? "fallback" : "primary",
            fallbackUsed: input.requestedRole === "planning",
            rejected: [],
            credentialBoundary: "runtime-key",
          },
          credential: {
            mode: "runtime-key",
            runtimeCredential: { provider, apiKey: `secret-${provider}` },
          },
          maxConcurrency: cfg.orchestration.maxConcurrency,
          budgetUsd:
            (cfg.budgets.maxCostUsd - input.spentCostUsd) /
            (input.partitionBudget === false
              ? 1
              : cfg.orchestration.maxConcurrency - input.activeChildren),
          budgetLimitUsd: cfg.budgets.maxCostUsd,
        };
      },
      loadCredentialLease: () => assert.fail("routed Fusion must use shared launch preparation"),
      runChildAgent,
    },
  };
}

test("routed Fusion uses fallback evidence, matching leases, and serial proposals at concurrency one", async () => {
  const runDir = makeRunDir();
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const {
    deps: workflowDeps,
    preparations,
    reservations,
    settlements,
  } = routedFusionDeps(
    runDir,
    async (options) => {
      calls.push(options);
      assert.equal(typeof options.onEvent, "function");
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        ok: true,
        text: proposals[options.role] || synthesis,
        model: options.model,
        usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
        stdoutBytes: 123,
        eventCount: 4,
      };
    },
  );
  const modelRegistry = { marker: "session" };

  const summary = await fusion.runFusionWithDependencies(
    { request: "Route this plan", cwd: process.cwd(), modelRegistry },
    workflowDeps,
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(preparations.map((item) => item.requestedRole), [
    "planning",
    "implementation",
    "review",
  ]);
  assert.ok(preparations.every((item) => item.partitionBudget !== false));
  assert.ok(preparations.every((item) => item.modelRegistry === modelRegistry));
  assert.deepEqual(
    preparations.map((item) => Number(item.spentCostUsd.toFixed(1))),
    [0, 0.1, 0.2],
  );
  assert.deepEqual(calls.map((item) => item.model), [
    "anthropic/architect-fallback",
    "openai-codex/builder-primary",
    "anthropic/reviewer-primary",
  ]);
  assert.ok(
    calls.every(
      (item) => item.brokerRuntimeCredential.provider === item.model.split("/", 1)[0],
    ),
  );
  assert.deepEqual(calls.map((item) => Number(item.maxCostUsd.toFixed(1))), [2, 1.9, 1.8]);
  assert.equal(reservations.length, 3);
  assert.equal(settlements.length, 3);
  assert.equal(summary.status, "COMPLETE");
  assert.deepEqual(summary.proposals.map((proposal) => proposal.stdoutBytes), [123, 123]);
  assert.deepEqual(summary.proposals.map((proposal) => proposal.eventCount), [4, 4]);
  assert.equal(summary.synthesizer.stdoutBytes, 123);
  assert.equal(summary.synthesizer.eventCount, 4);
  assert.equal(summary.routing.architect.reason, "fallback");
  assert.match(summary.panel.join("\n"), /fallback/);

  const artifacts = ["fusion/models.json", "summary.json"]
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  assert.match(artifacts, /"fallbackUsed": true/);
  assert.equal(artifacts.includes("secret-"), false);
});

test("routed Fusion rejects identical proposal models before spawning", async () => {
  const runDir = makeRunDir();
  let childCalls = 0;
  const cfg = routedFusionConfig({ maxConcurrency: 2 });
  const { deps: workflowDeps } = routedFusionDeps(
    runDir,
    async () => {
      childCalls++;
      throw new Error("must not spawn");
    },
    cfg,
  );
  workflowDeps.prepareAgentLaunch = async (input) => ({
    ok: true,
    spec: { model: "anthropic/shared", tools: input.tools, profile: input.profile },
    decision: {
      ok: true,
      role: input.requestedRole,
      model: "anthropic/shared",
      provider: "anthropic",
      reason: "primary",
      fallbackUsed: false,
      rejected: [],
      credentialBoundary: "runtime-key",
    },
    credential: {
      mode: "runtime-key",
      runtimeCredential: { provider: "anthropic", apiKey: "secret" },
    },
    maxConcurrency: 2,
    budgetUsd: 1,
    budgetLimitUsd: 2,
  });

  const summary = await fusion.runFusionWithDependencies(
    { request: "Keep independent perspectives", cwd: process.cwd(), modelRegistry: {} },
    workflowDeps,
  );

  assert.equal(childCalls, 0);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "fusion_models_not_distinct");
});

test("routed Fusion runs proposals in parallel when concurrency permits", async () => {
  const runDir = makeRunDir();
  let active = 0;
  let maxActive = 0;
  let synthesisPrompt = "";
  const architectTail = `ROUTED ARCHITECT TAIL ${"x".repeat(60_100)}`;
  const cfg = routedFusionConfig({ maxConcurrency: 2 });
  const { deps: workflowDeps, preparations, reservations } = routedFusionDeps(
    runDir,
    async (options) => {
      if (options.role === "fusion-synthesizer") synthesisPrompt = options.prompt;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        ok: true,
        text: options.role === "fusion-architect"
          ? `${proposals[options.role]}\n${architectTail}`
          : proposals[options.role] || synthesis,
        model: options.model,
        usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
      };
    },
    cfg,
  );

  const summary = await fusion.runFusionWithDependencies(
    { request: "Parallel routed proposals", cwd: process.cwd(), modelRegistry: {} },
    workflowDeps,
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(preparations.slice(0, 2).map((item) => item.activeChildren), [0, 1]);
  assert.deepEqual(preparations.slice(0, 2).map((item) => item.spentCostUsd), [0, 1]);
  assert.equal(reservations.slice(0, 2).reduce((sum, item) => sum + item.budgetUsd, 0), 2);
  assert.deepEqual(reservations.slice(0, 2).map((item) => item.budgetUsd), [1, 1]);
  assert.equal(summary.status, "COMPLETE");
  assert.match(synthesisPrompt, /ROUTED ARCHITECT TAIL/);
});

test("routed Fusion abort stops the serial workflow before the next launch", async () => {
  const runDir = makeRunDir();
  const controller = new AbortController();
  let calls = 0;
  const { deps: workflowDeps } = routedFusionDeps(
    runDir,
    async (options) => {
      calls++;
      controller.abort();
      return {
        ok: false,
        error: "aborted",
        text: "",
        model: options.model,
        usage: { input: 0, output: 0, cost: null, turns: 0, costKnown: false },
      };
    },
  );

  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Abort safely",
      cwd: process.cwd(),
      modelRegistry: {},
      signal: controller.signal,
    },
    workflowDeps,
  );

  assert.equal(calls, 1);
  assert.equal(summary.status, "ABORTED");
});

test("routed Fusion synthesis cancellation wins over unknown usage", async () => {
  const runDir = makeRunDir();
  const controller = new AbortController();
  let calls = 0;
  const workflow = routedFusionDeps(runDir, async (options) => {
    calls++;
    if (options.role === "fusion-synthesizer") {
      controller.abort();
      return {
        ok: false,
        error: "aborted",
        text: "",
        model: options.model,
        usage: { input: 0, output: 0, cost: null, turns: 0, costKnown: false },
      };
    }
    return {
      ok: true,
      text: proposals[options.role],
      model: options.model,
      usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
    };
  });

  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Cancel synthesis safely",
      cwd: process.cwd(),
      modelRegistry: {},
      signal: controller.signal,
    },
    workflow.deps,
  );

  assert.equal(calls, 3);
  assert.equal(workflow.settlements.length, 3);
  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
});

test("routed Fusion accounts for observed synthesis cost before final status", async () => {
  const runDir = makeRunDir();
  const workflow = routedFusionDeps(runDir, async (options) => ({
    ok: true,
    text: proposals[options.role] || synthesis,
    model: options.model,
    usage: {
      input: 1,
      output: 1,
      cost: options.role === "fusion-synthesizer" ? 3 : 0.1,
      turns: 1,
      costKnown: true,
    },
  }));

  const summary = await fusion.runFusionWithDependencies(
    { request: "Account for synthesis overrun", cwd: process.cwd(), modelRegistry: {} },
    workflow.deps,
  );

  assert.equal(workflow.settlements.length, 3);
  assert.equal(summary.status, "BUDGET_EXCEEDED");
  assert.equal(summary.error, "budget_exceeded");
});

test("routed Fusion settles reservations on thrown child errors", async () => {
  const runDir = makeRunDir();
  const workflow = routedFusionDeps(runDir, async () => {
    throw new Error("child exploded");
  });

  const summary = await fusion.runFusionWithDependencies(
    { request: "Settle thrown work", cwd: process.cwd(), modelRegistry: {} },
    workflow.deps,
  );

  assert.equal(workflow.settlements.length, 1);
  assert.equal(workflow.settlements[0].usage.costKnown, false);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "child_failed");
  assert.equal(summary.usage.costKnown, false);
});

test("routed Fusion preserves thrown synthesis failure over unknown usage", async () => {
  const runDir = makeRunDir();
  const workflow = routedFusionDeps(runDir, async (options) => {
    if (options.role === "fusion-synthesizer") throw new Error("synthesis exploded");
    return {
      ok: true,
      text: proposals[options.role],
      model: options.model,
      usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
    };
  });

  const summary = await fusion.runFusionWithDependencies(
    { request: "Preserve synthesis failure", cwd: process.cwd(), modelRegistry: {} },
    workflow.deps,
  );

  assert.equal(workflow.settlements.length, 3);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "child_failed");
  assert.equal(summary.usage.costKnown, false);
});

for (const callback of ["onPanel", "onProgress"]) {
  test(`routed Fusion releases its reservation when ${callback} throws before spawn`, async () => {
    agentRegistry.resetAgentLedgerForTests();
    const runDir = makeRunDir();
    const workflow = routedFusionDeps(runDir, async () => assert.fail("must not spawn"));
    for (const name of [
      "getRunningAgentCount",
      "getAgentSpentCost",
      "reserveAgentLaunch",
      "settleAgentLaunch",
    ]) {
      delete workflow.deps[name];
    }
    const callbacks = callback === "onPanel"
      ? {
          onPanel(panel) {
            if (panel.agents.some((agent) => agent.model)) {
              throw new Error("panel exploded");
            }
          },
        }
      : {
          onProgress() {
            throw new Error("progress exploded");
          },
        };

    await assert.rejects(
      fusion.runFusionWithDependencies(
        {
          request: "Release Fusion callback reservation",
          cwd: process.cwd(),
          modelRegistry: {},
          ...callbacks,
        },
        workflow.deps,
      ),
      new RegExp(`${callback === "onPanel" ? "panel" : "progress"} exploded`),
    );
    assert.equal(agentRegistry.getRunningAgentCount(process.cwd()), 0);
    assert.equal(agentRegistry.getAgentSpentCost(process.cwd()), 0);
    agentRegistry.resetAgentLedgerForTests();
  });
}

test("routed Fusion abort during prepare prevents reservation and child launch", async () => {
  const runDir = makeRunDir();
  const controller = new AbortController();
  let childCalls = 0;
  const workflow = routedFusionDeps(runDir, async () => {
    childCalls++;
  });
  const prepare = workflow.deps.prepareAgentLaunch;
  workflow.deps.prepareAgentLaunch = async (input) => {
    const launch = await prepare(input);
    controller.abort();
    return launch;
  };

  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Abort during Fusion preparation",
      cwd: process.cwd(),
      modelRegistry: {},
      signal: controller.signal,
    },
    workflow.deps,
  );

  assert.equal(workflow.reservations.length, 0);
  assert.equal(childCalls, 0);
  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
});

for (const [reason, rejectedReason, expectedError] of [
  ["orchestration concurrency limit reached", null, "concurrency_limit"],
  ["orchestration budget is exhausted", null, "budget_exceeded"],
  ["invalid orchestration policy: enabled must be boolean", null, "invalid_orchestration_policy"],
  ["no eligible configured model for planning", "custom transport is not eligible", "custom_transport_unavailable"],
  ["no eligible configured model for planning", "provider is not authenticated", "provider_unavailable"],
]) {
  test(`routed Fusion preserves actionable failure: ${expectedError}`, async () => {
    const runDir = makeRunDir();
    const cfg = routedFusionConfig({ maxConcurrency: 2 });
    const workflow = routedFusionDeps(runDir, async () => assert.fail("must not spawn"), cfg);
    workflow.deps.prepareAgentLaunch = async () => ({
      ok: false,
      spec: { model: null },
      decision: {
        ok: false,
        reason,
        fallbackUsed: false,
        rejected: rejectedReason
          ? [{ model: "anthropic/candidate", reason: rejectedReason }]
          : [],
      },
      credential: null,
    });

    const summary = await fusion.runFusionWithDependencies(
      { request: "Expose the safe failure", cwd: process.cwd(), modelRegistry: {} },
      workflow.deps,
    );

    assert.equal(summary.status, "FAILED");
    assert.equal(summary.error, expectedError);
    if (expectedError === "provider_unavailable") {
      assert.deepEqual(summary.missingProviders, ["anthropic"]);
    }
    assert.equal(JSON.stringify(summary).includes("secret"), false);
  });
}

test("Fusion fails closed on malformed orchestration enablement", async () => {
  const runDir = makeRunDir();
  const cfg = routedFusionConfig({ maxConcurrency: 2 });
  cfg.orchestration.enabled = "true";
  let preparations = 0;
  let childCalls = 0;

  const summary = await fusion.runFusionWithDependencies(
    { request: "Do not bypass malformed policy", cwd: process.cwd(), modelRegistry: {} },
    {
      createRunDir: () => runDir,
      loadConfig: () => cfg,
      prepareAgentLaunch: async () => {
        preparations++;
        return {
          ok: false,
          spec: { model: null },
          decision: {
            ok: false,
            reason: "invalid orchestration policy",
            fallbackUsed: false,
            rejected: [],
          },
          credential: null,
        };
      },
      loadCredentialLease: () => assert.fail("must not use legacy credential path"),
      runChildAgent: async () => {
        childCalls++;
      },
    },
  );

  assert.ok(preparations >= 1);
  assert.equal(childCalls, 0);
  assert.equal(summary.status, "FAILED");
});

test("legacy Fusion unknown proposal cost fails closed before synthesis", async () => {
  const runDir = makeRunDir();
  let calls = 0;
  const summary = await fusion.runFusionWithDependencies(
    { request: "Preserve legacy routing safely", cwd: process.cwd() },
    deps(runDir, async (options) => {
      calls++;
      return {
        ok: true,
        text: proposals[options.role] || synthesis,
        model: options.model,
        usage: { input: 1, output: 1, cost: null, turns: 1, costKnown: false },
      };
    }),
  );

  assert.equal(calls, 2);
  assert.equal(summary.status, "BUDGET_EXCEEDED");
  assert.equal(summary.error, "budget_usage_unavailable");
  assert.equal(summary.synthesis, "");
  assert.equal(summary.usage.costKnown, false);
});

test("legacy Fusion unknown synthesis cost fails closed", async () => {
  const runDir = makeRunDir();
  const summary = await fusion.runFusionWithDependencies(
    { request: "Account for synthesis cost", cwd: process.cwd() },
    deps(runDir, async (options) => ({
      ok: true,
      text: proposals[options.role] || synthesis,
      model: options.model,
      usage: {
        input: 1,
        output: 1,
        cost: options.role === "fusion-synthesizer" ? null : 0.1,
        turns: 1,
        costKnown: options.role !== "fusion-synthesizer",
      },
    })),
  );

  assert.equal(summary.status, "BUDGET_EXCEEDED");
  assert.equal(summary.error, "budget_usage_unavailable");
  assert.equal(summary.usage.costKnown, false);
});

for (const malformedCost of [null, "0.25", -1]) {
  test(`legacy Fusion rejects malformed cost ${String(malformedCost)}`, async () => {
    const runDir = makeRunDir();
    const summary = await fusion.runFusionWithDependencies(
      { request: "Reject malformed usage", cwd: process.cwd() },
      deps(runDir, async (options) => ({
        ok: true,
        text: proposals[options.role] || synthesis,
        model: options.model,
        usage: { input: 1, output: 1, cost: malformedCost, turns: 1 },
      })),
    );

    assert.equal(summary.status, "BUDGET_EXCEEDED");
    assert.equal(summary.error, "budget_usage_unavailable");
    assert.equal(summary.usage.costKnown, false);
  });
}

test("legacy Fusion proposal cancellation wins over unknown usage", async () => {
  const runDir = makeRunDir();
  const controller = new AbortController();
  let calls = 0;
  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Cancel legacy proposals",
      cwd: process.cwd(),
      signal: controller.signal,
    },
    deps(runDir, async (options) => {
      calls++;
      controller.abort();
      return {
        ok: false,
        error: "aborted",
        text: "",
        model: options.model,
        usage: { input: 0, output: 0, cost: null, turns: 0, costKnown: false },
      };
    }),
  );

  assert.equal(calls, 2);
  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
  assert.equal(summary.synthesis, "");
});

test("legacy Fusion synthesis cancellation wins over unknown usage", async () => {
  const runDir = makeRunDir();
  const controller = new AbortController();
  const summary = await fusion.runFusionWithDependencies(
    {
      request: "Cancel legacy synthesis",
      cwd: process.cwd(),
      signal: controller.signal,
    },
    deps(runDir, async (options) => {
      if (options.role === "fusion-synthesizer") {
        controller.abort();
        return {
          ok: false,
          error: "aborted",
          text: "",
          model: options.model,
          usage: { input: 0, output: 0, cost: null, turns: 0, costKnown: false },
        };
      }
      return {
        ok: true,
        text: proposals[options.role],
        model: options.model,
        usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
      };
    }),
  );

  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
});

for (const [label, proposalCost, expectedError] of [
  ["exhausted", 1, "budget_exceeded"],
  ["unknown", null, "budget_usage_unavailable"],
]) {
  test(`routed Fusion ${label} proposal cost blocks later launches and synthesis`, async () => {
    const runDir = makeRunDir();
    const calls = [];
    const cfg = routedFusionConfig({ maxConcurrency: 1, maxCostUsd: 1 });
    const { deps: workflowDeps, preparations } = routedFusionDeps(
      runDir,
      async (options) => {
        calls.push(options);
        return {
          ok: true,
          text: proposals[options.role] || synthesis,
          model: options.model,
          usage: {
            input: 1,
            output: 1,
            cost: proposalCost,
            turns: 1,
            costKnown: proposalCost != null,
          },
        };
      },
      cfg,
    );

    const summary = await fusion.runFusionWithDependencies(
      { request: "Stop before unsafe spend", cwd: process.cwd(), modelRegistry: {} },
      workflowDeps,
    );

    assert.deepEqual(preparations.map((item) => item.requestedRole), ["planning"]);
    assert.equal(calls.length, 1);
    assert.equal(summary.status, "BUDGET_EXCEEDED");
    assert.equal(summary.error, expectedError);
    assert.equal(summary.synthesis, "");
  });
}
