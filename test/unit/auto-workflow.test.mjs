import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-auto-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");
// Unit tests do not require Docker; production default remains sandbox.
process.env.ALLOY_IMPLEMENT_PROFILE = "ask-dangerous";

const auto = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "auto-workflow.mjs")).href
);
const agentRegistry = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "agent-registry.mjs")).href
);

test("createRunDir writes structure", () => {
  const dir = auto.createRunDir(tmp, "testrun1");
  assert.ok(existsSync(join(dir, "agents")));
  assert.ok(existsSync(join(dir, "checks")));
  assert.ok(existsSync(join(dir, "patches")));
});

test("runAutoWorkflow without auth still produces artifacts", async () => {
  // Children will fail auth; workflow should still write summary
  const summary = await auto.runAutoWorkflow({
    request: "noop diagnostic of empty folder",
    cwd: tmp,
    useWorktree: false,
    timeoutMs: 60_000,
  });
  assert.ok(summary.runId);
  assert.ok(summary.runDir);
  assert.ok(existsSync(join(summary.runDir, "summary.json")));
  assert.ok(existsSync(join(summary.runDir, "contract.json")));
  assert.ok(existsSync(join(summary.runDir, "request.md")));
  const body = readFileSync(join(summary.runDir, "summary.json"), "utf8");
  assert.match(body, /runId|status/);
  // Truthful statuses: COMPLETE only if pass; often AUTH_REQUIRED/PARTIAL/FAILED without models
  assert.ok(
    ["COMPLETE", "FAILED", "ABORTED", "PARTIAL", "AUTH_REQUIRED"].includes(
      summary.status,
    ),
    `unexpected status ${summary.status}`,
  );
  if (summary.status === "COMPLETE") assert.equal(summary.pass, true);
  if (summary.pass) assert.equal(summary.status, "COMPLETE");
});

function routedConfig(maxCostUsd = 2) {
  return {
    budgets: { maxCostUsd, maxFixRounds: 1 },
    auto: { useWorktree: false },
    orchestration: { enabled: true, maxConcurrency: 3 },
    roles: {},
  };
}

function workflowDeps(
  runDir,
  { costForRole = () => 0.1, initialSpent = 0, initialActive = 0 } = {},
) {
  const preparations = [];
  const launches = [];
  const reservations = [];
  const settlements = [];
  const activeReservations = new Map();
  let observed = initialSpent;
  const roleModels = {
    research: "xai/scout-routed",
    planning: "anthropic/planner-routed",
    implementation: "openai-codex/builder-routed",
    review: "anthropic/reviewer-routed",
  };
  let reviewCount = 0;
  return {
    preparations,
    launches,
    reservations,
    settlements,
    deps: {
      createRunDir: () => {
        for (const name of ["agents", "checks", "patches"]) {
          mkdirSync(join(runDir, name), { recursive: true });
        }
        return runDir;
      },
      loadConfig: () => routedConfig(),
      isGitRepo: () => false,
      runDiagnostics: () => ({ ok: true, skipped: false, summary: "checks pass" }),
      getRunningAgentCount: () => initialActive + activeReservations.size,
      getAgentSpentCost: () => {
        if (!Number.isFinite(observed)) return observed;
        return [...activeReservations.values()].reduce(
          (total, reservation) => total + reservation.budgetUsd,
          observed,
        );
      },
      reserveAgentLaunch: (input) => {
        const active = initialActive + activeReservations.size;
        if (active >= input.maxConcurrency) throw new Error("concurrency limit");
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
          id: `reservation-${reservations.length + 1}`,
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
        const model = roleModels[input.requestedRole];
        const provider = model.split("/", 1)[0];
        return {
          ok: true,
          spec: { profile: input.profile, model, tools: input.tools },
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
          maxConcurrency: 3,
          budgetUsd: 2 - input.spentCostUsd,
          budgetLimitUsd: 2,
        };
      },
      runChildAgent: async (options) => {
        launches.push(options);
        const cost = costForRole(options.role, launches.length);
        let text = `${options.role} complete`;
        if (options.role === "reviewer") {
          reviewCount++;
          text = reviewCount === 1 ? "VERDICT: FAIL" : "VERDICT: PASS";
        }
        return {
          ok: true,
          text,
          model: options.model,
          usage: { input: 1, output: 1, cost, turns: 1, costKnown: cost != null },
        };
      },
    },
  };
}

test("Auto fails before launching agents when sandboxed diagnostics are unavailable", async () => {
  const runDir = join(tmp, "sandbox-diagnostics");
  const harness = workflowDeps(runDir);
  let diagnosticCalls = 0;
  harness.deps.runDiagnostics = () => {
    diagnosticCalls += 1;
    return { ok: true, skipped: false, summary: "unexpected host diagnostics" };
  };

  const summary = await auto.runAutoWorkflowWithDependencies(
    {
      request: "sandboxed change",
      cwd: tmp,
      useWorktree: false,
      parentPermissionProfile: "ask-dangerous",
      parentSandbox: true,
    },
    harness.deps,
  );

  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "sandbox_diagnostics_unavailable");
  assert.equal(harness.launches.length, 0);
  assert.equal(diagnosticCalls, 0);
});

test("Auto routes every stage and fix re-review with matching leases and evidence", async () => {
  assert.equal(
    typeof auto.runAutoWorkflowWithDependencies,
    "function",
    "Auto dependency seam should exist",
  );
  const runDir = join(tmp, "deterministic-auto");
  const modelRegistry = { marker: "parent-session" };
  const { deps, preparations, launches, reservations, settlements } = workflowDeps(runDir);

  const summary = await auto.runAutoWorkflowWithDependencies(
    {
      request: "Implement the routed workflow",
      cwd: tmp,
      useWorktree: false,
      modelRegistry,
      maxFixRounds: 1,
    },
    deps,
  );

  assert.deepEqual(preparations.map((item) => item.requestedRole), [
    "research",
    "planning",
    "implementation",
    "review",
    "implementation",
    "review",
  ]);
  assert.ok(preparations.every((item) => item.partitionBudget === false));
  assert.ok(preparations.every((item) => item.modelRegistry === modelRegistry));
  assert.deepEqual(
    preparations.map((item) => Number(item.spentCostUsd.toFixed(1))),
    [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  );
  assert.deepEqual(launches.map((item) => item.role), [
    "scout",
    "planner",
    "builder",
    "reviewer",
    "fixer",
    "reviewer",
  ]);
  assert.ok(
    launches.every(
      (item) => item.brokerRuntimeCredential.provider === item.model.split("/", 1)[0],
    ),
  );
  assert.deepEqual(
    launches.map((item) => Number(item.maxCostUsd.toFixed(1))),
    [2, 1.9, 1.8, 1.7, 1.6, 1.5],
  );
  assert.ok(
    launches.every(
      (item) => item.credentialBroker !== "runtime-key" || item.readRoot === item.cwd,
    ),
  );
  assert.equal(reservations.length, 6);
  assert.equal(settlements.length, 6);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(summary.agents.planner.routing.reason, "fallback");
  assert.equal(summary.agents.planner.credentialMode, "runtime-key");
  assert.match(summary.panel.join("\n"), /fallback/);

  const artifacts = ["events.jsonl", "routing.json", "summary.json"]
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
  assert.match(artifacts, /"fallbackUsed": true/);
  assert.equal(artifacts.includes("secret-"), false);
});

for (const [label, observedCost, expectedError] of [
  ["exhausted", 2, "budget_exceeded"],
  ["unknown", null, "budget_usage_unavailable"],
]) {
  test(`Auto ${label} observed cost prevents the next launch`, async () => {
    const runDir = join(tmp, `budget-${label}`);
    const { deps, preparations, launches } = workflowDeps(runDir, {
      costForRole: () => observedCost,
    });

    const summary = await auto.runAutoWorkflowWithDependencies(
      {
        request: "Stop when cost cannot continue",
        cwd: tmp,
        useWorktree: false,
        modelRegistry: {},
      },
      deps,
    );

    assert.equal(preparations.length, label === "exhausted" ? 2 : 1);
    assert.equal(launches.length, 1);
    assert.equal(summary.status, "FAILED");
    assert.equal(summary.error, expectedError);
  });
}

test("Auto reads shared ledger state without double-counting local observed cost", async () => {
  const runDir = join(tmp, "shared-ledger-auto");
  const { deps, preparations, reservations } = workflowDeps(runDir, {
    initialSpent: 0.25,
    initialActive: 1,
  });

  const summary = await auto.runAutoWorkflowWithDependencies(
    {
      request: "Use the process ledger",
      cwd: tmp,
      useWorktree: false,
      modelRegistry: {},
      maxFixRounds: 1,
    },
    deps,
  );

  assert.equal(summary.status, "COMPLETE");
  assert.equal(preparations[0].activeChildren, 1);
  assert.deepEqual(
    preparations.map((item) => Number(item.spentCostUsd.toFixed(2))),
    [0.25, 0.35, 0.45, 0.55, 0.65, 0.75],
  );
  assert.equal(reservations.length, 6);
});

test("Auto cancellation wins over unknown usage and stops before the next phase", async () => {
  const runDir = join(tmp, "cancelled-auto");
  const controller = new AbortController();
  const workflow = workflowDeps(runDir);
  workflow.deps.runChildAgent = async (options) => {
    workflow.launches.push(options);
    controller.abort();
    return {
      ok: false,
      error: "aborted",
      text: "",
      model: options.model,
      usage: { input: 0, output: 0, cost: null, turns: 0, costKnown: false },
    };
  };

  const summary = await auto.runAutoWorkflowWithDependencies(
    {
      request: "Cancel immediately",
      cwd: tmp,
      useWorktree: false,
      modelRegistry: {},
      signal: controller.signal,
    },
    workflow.deps,
  );

  assert.equal(workflow.launches.length, 1);
  assert.equal(workflow.settlements.length, 1);
  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
});

test("Auto settles a reservation when a child throws", async () => {
  const runDir = join(tmp, "thrown-auto");
  const workflow = workflowDeps(runDir);
  workflow.deps.runChildAgent = async () => {
    throw new Error("child exploded");
  };

  await assert.rejects(
    auto.runAutoWorkflowWithDependencies(
      {
        request: "Settle on throw",
        cwd: tmp,
        useWorktree: false,
        modelRegistry: {},
      },
      workflow.deps,
    ),
    /child exploded/,
  );
  assert.equal(workflow.reservations.length, 1);
  assert.equal(workflow.settlements.length, 1);
  assert.equal(workflow.settlements[0].usage.costKnown, false);
});

for (const callback of ["onPanel", "onProgress"]) {
  test(`Auto releases its reservation when ${callback} throws before spawn`, async () => {
    agentRegistry.resetAgentLedgerForTests();
    const runDir = join(tmp, `throw-${callback}`);
    const workflow = workflowDeps(runDir);
    for (const name of [
      "getRunningAgentCount",
      "getAgentSpentCost",
      "reserveAgentLaunch",
      "settleAgentLaunch",
    ]) {
      delete workflow.deps[name];
    }
    let childCalls = 0;
    workflow.deps.runChildAgent = async () => {
      childCalls++;
      throw new Error("must not spawn");
    };
    const callbacks = callback === "onPanel"
      ? {
          onPanel(panel) {
            if (panel.agents.some((agent) => agent.status === "running")) {
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
      auto.runAutoWorkflowWithDependencies(
        {
          request: "Release callback reservation",
          cwd: tmp,
          useWorktree: false,
          modelRegistry: {},
          ...callbacks,
        },
        workflow.deps,
      ),
      new RegExp(`${callback === "onPanel" ? "panel" : "progress"} exploded`),
    );
    assert.equal(childCalls, 0);
    assert.equal(agentRegistry.getRunningAgentCount(tmp), 0);
    assert.equal(agentRegistry.getAgentSpentCost(tmp), 0);
    agentRegistry.resetAgentLedgerForTests();
  });
}

test("Auto abort during prepare prevents reservation and child launch", async () => {
  const runDir = join(tmp, "abort-during-prepare");
  const controller = new AbortController();
  const workflow = workflowDeps(runDir);
  const prepare = workflow.deps.prepareAgentLaunch;
  workflow.deps.prepareAgentLaunch = async (input) => {
    const launch = await prepare(input);
    controller.abort();
    return launch;
  };

  const summary = await auto.runAutoWorkflowWithDependencies(
    {
      request: "Abort during route preparation",
      cwd: tmp,
      useWorktree: false,
      modelRegistry: {},
      signal: controller.signal,
    },
    workflow.deps,
  );

  assert.equal(workflow.reservations.length, 0);
  assert.equal(workflow.launches.length, 0);
  assert.equal(summary.status, "ABORTED");
  assert.equal(summary.error, "aborted");
});

for (const [reason, rejectedReason, expectedError] of [
  ["orchestration concurrency limit reached", null, "concurrency_limit"],
  ["agent budget is exhausted", null, "budget_exceeded"],
  ["invalid orchestration policy", null, "invalid_orchestration_policy"],
  ["no eligible configured model for research", "custom transport is not eligible", "custom_transport_unavailable"],
  ["no eligible configured model for research", "provider is not authenticated", "provider_unavailable"],
]) {
  test(`Auto preserves actionable failure: ${expectedError}`, async () => {
    const runDir = join(tmp, `failure-${expectedError}`);
    const workflow = workflowDeps(runDir);
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

    const summary = await auto.runAutoWorkflowWithDependencies(
      {
        request: "Expose safe routing failure",
        cwd: tmp,
        useWorktree: false,
        modelRegistry: {},
      },
      workflow.deps,
    );

    assert.equal(summary.status, "FAILED");
    assert.equal(summary.error, expectedError);
    assert.equal(JSON.stringify(summary).includes("secret"), false);
  });
}

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
