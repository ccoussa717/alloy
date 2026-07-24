import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import * as fusion from "../../lib/fusion.mjs";

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

const synthesis = `## Consensus
Shared answer.
## Architect contributions
System boundaries.
## Builder contributions
Implementation details.
## Conflicts and resolution
Selected the safer path.
## Rejected claims
Unsupported assumptions.
## Final recommendation
Build the bounded workflow.`;

function deps(runDir, runChildAgent, lease = null) {
  return {
    createRunDir: () => runDir,
    loadConfig: () => config,
    loadCredentialLease: (models) => {
      if (lease) return lease;
      const provider = models[0].split("/", 1)[0];
      const secret = provider === "anthropic" ? "secret-a" : "secret-b";
      return {
        mode: "ephemeral-json",
        authJson: { [provider]: { type: "oauth", access: secret } },
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
  const runChildAgent = async (options) => {
    calls.push(options);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    const text = proposals[options.role] || synthesis;
    return {
      ok: true,
      text,
      model: options.model,
      usage: { input: 10, output: 5, cost: 0.1, turns: 1 },
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
  assert.ok(calls.every((call) => call.credentialBroker === "ephemeral-json"));
  assert.ok(calls.every((call) => call.permissionProfile === "ask-all"));
  assert.ok(calls.every((call) => call.parentPermissionProfile === "ask-all"));
  assert.ok(calls.every((call) => call.readRoot === process.cwd()));
  assert.deepEqual(calls.map((call) => Object.keys(call.brokerAuthJson)), [
    ["anthropic"],
    ["openai-codex"],
    ["anthropic"],
  ]);
  assert.deepEqual(leaseRequests, [
    ["anthropic/architect"],
    ["openai-codex/builder"],
    ["anthropic/synthesizer"],
  ]);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(summary.synthesis, synthesis);
  assert.equal(summary.proposals.length, 2);
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

test("missing selected credentials fails before spawning children", async () => {
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
  assert.equal(summary.status, "AUTH_REQUIRED");
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

test("synthesis auth failure is reported as auth required", async () => {
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
  assert.equal(summary.status, "AUTH_REQUIRED");
  assert.equal(summary.synthesizer.error, "auth_required");
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
  assert.equal(JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")).status, "FAILED");
});
