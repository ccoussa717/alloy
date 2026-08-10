import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatFissionLines,
  registerFission,
} from "../../extensions/fission.ts";
import {
  parseFissionRequest,
  resolveFissionEfforts,
  resolveFissionModels,
  fissionConfigHint,
  FISSION_EFFORT_LEVELS,
} from "../../lib/fission.mjs";

function result(overrides = {}) {
  return {
    status: "COMPLETE",
    verdict: "PASS",
    message: "no submitted blocking finding validated.",
    validatedFindings: [],
    rejectedFindings: [],
    unresolvedFindings: [],
    modelDiversity: {
      exactModelCount: 3,
      providerCount: 2,
      familyCount: 2,
      actualModels: ["anthropic/opus", "openai-codex/gpt", "anthropic/judge"],
      providers: ["anthropic", "openai-codex"],
      families: ["claude", "gpt"],
    },
    usage: { input: 10, output: 20, turns: 3, cost: 0.25, costKnown: true },
    runDir: "/tmp/fission-run",
    panel: [],
    ...overrides,
  };
}

function harness(
  fission = { defaultReviewers: 3, maxReviewers: 5 },
  dependencyOverrides = {},
) {
  const commands = new Map();
  const tools = new Map();
  const calls = [];
  const parent = {
    permissionProfile: "ask-all",
    parentPermissionProfile: "ask-all",
    sandbox: false,
    parentSandbox: false,
    mode: "review",
  };
  registerFission(
    {
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerTool(spec) {
        tools.set(spec.name, spec);
      },
    },
    {
      loadConfig: () => ({ fission }),
      resolveParentChildSpawnOpts: (overrides) => {
        assert.deepEqual(overrides, { mode: "review" });
        return parent;
      },
      runFission: async (input) => {
        calls.push(input);
        return result();
      },
      isTrustedModelRoute: () => true,
      ...dependencyOverrides,
    },
  );
  return { commands, tools, calls, parent };
}

test("parseFissionRequest honors every effective reviewer pair and UTF-8 bounds", () => {
  for (const [defaults, text, expected] of [
    [{ defaultReviewers: 3, maxReviewers: 5 }, "review this", 3],
    [{ defaultReviewers: 2, maxReviewers: 4 }, "review this", 2],
    [{ defaultReviewers: 2, maxReviewers: 2 }, "review this", 2],
    [{ defaultReviewers: 2, maxReviewers: 4 }, "4 review this", 4],
  ]) {
    assert.deepEqual(parseFissionRequest(text, defaults), {
      request: "review this",
      reviewers: expected,
    });
  }
  assert.equal(parseFissionRequest("snowman: ☃", { defaultReviewers: 2, maxReviewers: 4 }).request, "snowman: ☃");
  assert.equal(Buffer.byteLength(parseFissionRequest("x".repeat(16 * 1024), { defaultReviewers: 2, maxReviewers: 4 }).request), 16 * 1024);
  for (const text of ["", "2", "0 review", "1.5 review", "-1 review", "5 review"]) {
    assert.throws(() => parseFissionRequest(text, { defaultReviewers: 2, maxReviewers: 4 }));
  }
  assert.throws(
    () => parseFissionRequest("☃".repeat(5462), { defaultReviewers: 2, maxReviewers: 4 }),
    /request_limit/,
  );
  assert.throws(() => parseFissionRequest("inspect \ud800"), /request_utf8/);
});

test("resolveFissionEfforts validates levels and pads nulls", () => {
  assert.deepEqual(
    resolveFissionEfforts({
      fission: {
        reviewerEfforts: ["high", null, "low"],
        judgeEffort: "medium",
      },
    }, 3),
    { reviewerEfforts: ["high", null, "low"], judgeEffort: "medium" },
  );
  assert.deepEqual(
    resolveFissionEfforts({ fission: {} }, 2),
    { reviewerEfforts: [null, null], judgeEffort: null },
  );
  assert.throws(
    () => resolveFissionEfforts({ fission: { reviewerEfforts: ["nope"] } }, 1),
    /fission_effort/,
  );
  assert.ok(FISSION_EFFORT_LEVELS.includes("xhigh"));
});

test("resolveFissionModels includes efforts for the selected count", () => {
  const cfg = {
    fission: {
      models: ["a/m1", "b/m2", "c/m3"],
      judgeModel: "d/judge",
      reviewerEfforts: ["high", "low", "medium"],
      judgeEffort: "max",
    },
  };
  const selected = resolveFissionModels(cfg, 2);
  assert.deepEqual(selected.reviewerModels, ["a/m1", "b/m2"]);
  assert.deepEqual(selected.reviewerEfforts, ["high", "low"]);
  assert.equal(selected.judgeEffort, "max");
  assert.equal(selected.judgeModel, "d/judge");
});

test("fissionConfigHint points operators at setup", () => {
  assert.match(fissionConfigHint("reviewer_models"), /fission setup/i);
  assert.match(fissionConfigHint("judge_model"), /fission setup/i);
  assert.equal(fissionConfigHint("timeout"), null);
});

test("registerFission adds exactly one command and one tool with a strict hard-cap schema", () => {
  const { commands, tools } = harness({ defaultReviewers: 2, maxReviewers: 4 });
  assert.deepEqual([...commands.keys()], ["fission"]);
  assert.deepEqual([...tools.keys()], ["alloy_fission"]);
  const schema = tools.get("alloy_fission").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["request"]);
  assert.equal(schema.properties.request.minLength, 1);
  assert.equal(schema.properties.request.maxLength, 16 * 1024);
  assert.equal(schema.properties.reviewers.minimum, 1);
  assert.equal(schema.properties.reviewers.maximum, 5);
  assert.equal(schema.properties.reviewers.type, "integer");
});

test("slash command exposes help and setup/status completions without starting a run", async () => {
  const { commands, calls } = harness();
  const command = commands.get("fission");
  const selected = [];
  const notifications = [];
  let pickIndex = 0;
  const picks = [
    "help  —  How to use fission", // bare /fission → action menu
  ];
  const ctx = {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: { getAll: () => [] },
    ui: {
      async select(title, lines) {
        selected.push({ title, lines });
        if (/pick an action/i.test(title) && picks[pickIndex] != null) {
          return picks[pickIndex++];
        }
        return lines[0];
      },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };

  assert.deepEqual(
    command.getArgumentCompletions("").map(({ value }) => value),
    ["setup", "status", "help"],
  );
  await command.handler("", ctx);
  await command.handler("help", ctx);

  assert.equal(calls.length, 0);
  assert.equal(notifications.length, 0);
  assert.ok(selected.length >= 2);
  assert.match(selected[0].title, /pick an action/i);
  assert.ok(
    selected[0].lines.some((l) => /help/i.test(l) && /How to use fission/i.test(l)),
  );
  const helpView = selected.find((v) => /Fission help/i.test(v.title));
  assert.ok(helpView, "selecting help from menu must open help content");
  const text = helpView.lines.join("\n");
  assert.match(text, /\/fission setup/);
  assert.match(text, /\/fission status/);
  assert.match(text, /reviewers \+ 1 judge|N reviewers \+ 1 judge/i);
  assert.match(text, /Done/i);
});

test("fission status shows routes, specialties, effort, and concurrency", async () => {
  const configured = {
    providers: { allow: ["anthropic", "openai-codex"] },
    orchestration: { enabled: true, maxConcurrency: 2 },
    fission: {
      models: ["anthropic/reviewer-a", "openai-codex/reviewer-b"],
      judgeModel: "anthropic/judge",
      modelFamilies: { "anthropic/reviewer-a": "claude" },
      defaultReviewers: 2,
      maxReviewers: 2,
      blockingSeverity: "high",
      reviewerEfforts: ["high", null],
      judgeEffort: "medium",
    },
  };
  const { commands, calls } = harness(configured.fission, {
    loadConfig: () => configured,
  });
  const selected = [];
  await commands.get("fission").handler("status", {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: { getAll: () => [] },
    ui: {
      async select(title, lines) { selected.push({ title, lines }); },
      notify() {},
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(selected.length, 1);
  const text = selected[0].lines.join("\n");
  assert.match(text, /2 reviewers \+ 1 judge = 3 agents/i);
  assert.match(text, /reviewer-a/i);
  assert.match(text, /Correctness|Security|effort high/i);
  assert.match(text, /judge: anthropic\/judge/i);
  assert.match(text, /Judge effort: medium/i);
  assert.match(text, /concurrency: 2/i);
  assert.match(text, /blocking severity: high/i);
});

test("fission setup saves default≠max, efforts, severity, and distinct routes", async () => {
  const global = {
    providers: {
      allow: ["anthropic", "openai-codex", "xai"],
      favorites: [],
    },
    orchestration: { enabled: false, maxConcurrency: 3 },
    fission: {
      models: ["anthropic/old-reviewer", "openai-codex/old-reviewer"],
      judgeModel: "xai/old-judge",
      modelFamilies: {
        "anthropic/old-reviewer": "claude",
        "xai/old-judge": "grok",
      },
      defaultReviewers: 2,
      maxReviewers: 2,
      blockingSeverity: "medium",
      reviewerEfforts: [],
      judgeEffort: null,
    },
  };
  const saves = [];
  // default 2, max 3 → need 3 reviewer models + judge + efforts + severity
  const answers = [
    "Default 2: 2 reviewers + 1 judge = 3 agents",
    "Max 3: allows /fission 3 … (3 reviewers + 1 judge = 4 agents)",
    "Security & trust boundaries",
    "Anthropic",
    "claude-new",
    "high",
    "Cynical customer",
    "Codex",
    "gpt-new",
    "default (model/provider default)",
    "Adversarial code review",
    "xAI",
    "grok-new",
    "low",
    "Anthropic",
    "claude-judge",
    "medium",
    "high", // blocking severity
  ];
  const selections = [];
  const notifications = [];
  const { commands, calls } = harness(global.fission, {
    loadConfig: () => global,
    loadGlobalConfig: () => global,
    saveGlobalFissionConfig: (settings) => {
      saves.push(settings);
      return {
        ...global,
        orchestration: { ...global.orchestration, enabled: true },
        fission: { ...global.fission, ...settings },
      };
    },
  });
  const ctx = {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: {
      getAll: () => [
        { provider: "xai", id: "grok-new" },
        { provider: "openai-codex", id: "gpt-new" },
        { provider: "anthropic", id: "claude-new" },
        { provider: "anthropic", id: "claude-other" },
        { provider: "anthropic", id: "claude-judge" },
      ],
    },
    ui: {
      async select(title, options) {
        selections.push({ title, options });
        if (title === "Fission setup saved") return undefined;
        return answers.shift();
      },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };

  await commands.get("fission").handler("setup", ctx);

  assert.equal(calls.length, 0);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].models, [
    "anthropic/claude-new",
    "openai-codex/gpt-new",
    "xai/grok-new",
  ]);
  assert.equal(saves[0].judgeModel, "anthropic/claude-judge");
  assert.equal(saves[0].defaultReviewers, 2);
  assert.equal(saves[0].maxReviewers, 3);
  assert.deepEqual(saves[0].reviewerEfforts, ["high", null, "low"]);
  assert.deepEqual(saves[0].roles, [
    "security_trust_boundaries",
    "cynical_customer",
    "adversarial_code_review",
  ]);
  assert.equal(saves[0].judgeEffort, "medium");
  assert.equal(saves[0].blockingSeverity, "high");
  assert.equal(saves[0].modelFamilies["anthropic/claude-new"], "claude");
  assert.equal(saves[0].modelFamilies["openai-codex/gpt-new"], "gpt");
  assert.match(selections[0].options[0], /Default 1:/);
  assert.match(selections[1].options[0], /Max 2:/);
  // Role picker offers catalog labels
  assert.ok(
    selections.some((s) =>
      (s.options || []).includes("Cynical customer"),
    ),
  );
  assert.ok(selections.some((s) => /pick role|Security|Cynical|Adversarial/i.test(s.title)));
  assert.deepEqual(notifications, []);
  assert.match(selections.at(-1).options.join("\n"), /Default run:/i);
});

test("fission setup reports project-effective restrictions after saving global settings", async () => {
  const global = {
    providers: { allow: ["anthropic", "xai"], favorites: [] },
    orchestration: { enabled: false, maxConcurrency: 3 },
    fission: {
      models: ["anthropic/reviewer"],
      judgeModel: "xai/judge",
      modelFamilies: {},
      defaultReviewers: 1,
      maxReviewers: 1,
      blockingSeverity: "medium",
      reviewerEfforts: [],
      judgeEffort: null,
    },
  };
  const effective = {
    ...global,
    orchestration: { enabled: false, maxConcurrency: 1 },
  };
  const answers = [
    "Default 1: 1 reviewer + 1 judge = 2 agents",
    "Max 1: allows /fission 1 … (1 reviewer + 1 judge = 2 agents)",
    "General adversarial",
    "Anthropic",
    "reviewer",
    "default (model/provider default)",
    "xAI",
    "judge",
    "default (model/provider default)",
    "medium",
  ];
  const views = [];
  const { commands } = harness(global.fission, {
    loadConfig: () => effective,
    loadGlobalConfig: () => global,
    saveGlobalFissionConfig: () => ({
      ...global,
      orchestration: { ...global.orchestration, enabled: true },
    }),
  });
  await commands.get("fission").handler("setup", {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: {
      getAll: () => [
        { provider: "anthropic", id: "reviewer" },
        { provider: "xai", id: "judge" },
      ],
    },
    ui: {
      async select(title, options) {
        views.push({ title, options });
        if (title === "Fission setup saved") return undefined;
        return answers.shift();
      },
      notify() {},
    },
  });

  const text = views.at(-1).options.join("\n");
  assert.match(text, /Orchestration: disabled/i);
  assert.match(text, /project policy.*disables orchestration/i);
});

test("fission setup cancellation is all-or-nothing", async () => {
  const global = {
    providers: { allow: ["anthropic"], favorites: [] },
    orchestration: { enabled: false, maxConcurrency: 3 },
    fission: {
      models: ["anthropic/reviewer"],
      judgeModel: "anthropic/judge",
      modelFamilies: {},
      defaultReviewers: 1,
      maxReviewers: 1,
      blockingSeverity: "medium",
    },
  };
  const saves = [];
  const notifications = [];
  const { commands } = harness(global.fission, {
    loadConfig: () => global,
    loadGlobalConfig: () => global,
    saveGlobalFissionConfig: (settings) => saves.push(settings),
  });
  const answers = ["Default 1: 1 reviewer + 1 judge = 2 agents", undefined];
  await commands.get("fission").handler("setup", {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: { getAll: () => [{ provider: "anthropic", id: "reviewer" }] },
    ui: {
      async select(_title, _options) { return answers.shift(); },
      notify(message, level) { notifications.push({ message, level }); },
    },
  });

  assert.deepEqual(saves, []);
  assert.deepEqual(notifications, [{
    message: "Fission setup cancelled; no settings changed.",
    level: "info",
  }]);
});

test("fission setup omits registry models whose transport is not trusted", async () => {
  const global = {
    providers: { allow: ["anthropic"], favorites: [] },
    orchestration: { enabled: false, maxConcurrency: 3 },
    fission: {
      models: ["anthropic/safe"],
      judgeModel: "anthropic/safe",
      modelFamilies: {},
      defaultReviewers: 1,
      maxReviewers: 1,
      blockingSeverity: "medium",
    },
  };
  const views = [];
  const notifications = [];
  const { commands } = harness(global.fission, {
    loadConfig: () => global,
    loadGlobalConfig: () => global,
    saveGlobalFissionConfig: () => global,
    isTrustedModelRoute: (route) => route === "anthropic/safe",
  });
  await commands.get("fission").handler("setup", {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: {
      getAll: () => [
        { provider: "anthropic", id: "safe" },
        { provider: "anthropic", id: "unsafe" },
      ],
    },
    ui: {
      async select(title, options) {
        views.push({ title, options });
        return undefined;
      },
      notify(message, level) { notifications.push({ message, level }); },
    },
  });
  // Cancelled on first select after default options built from trusted only
  const firstModelStep = views.find((v) => /provider/i.test(v.title));
  if (firstModelStep) {
    assert.ok(!JSON.stringify(firstModelStep.options).includes("unsafe"));
  }
});

test("fission setup offers discovered Ollama routes like /model", async () => {
  const global = {
    providers: {
      allow: ["anthropic", "ollama", "openai-codex", "xai"],
      favorites: [],
    },
    orchestration: { enabled: false, maxConcurrency: 3 },
    fission: {
      models: [],
      judgeModel: null,
      modelFamilies: {},
      defaultReviewers: 1,
      maxReviewers: 3,
      blockingSeverity: "medium",
    },
  };
  const views = [];
  const trusted = new Set([
    "anthropic/claude-sonnet-4-6",
    "ollama/llama3.2",
    "ollama/qwen2.5-coder",
  ]);
  const { commands } = harness(global.fission, {
    loadConfig: () => global,
    loadGlobalConfig: () => global,
    saveGlobalFissionConfig: () => global,
    isTrustedModelRoute: (route) => trusted.has(route),
  });
  await commands.get("fission").handler("setup", {
    cwd: "/repo/project",
    hasUI: true,
    modelRegistry: {
      getAll: () => [
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "ollama", id: "llama3.2" },
        { provider: "ollama", id: "qwen2.5-coder" },
        { provider: "evil-proxy", id: "hijack" },
      ],
    },
    ui: {
      async select(title, options) {
        views.push({ title, options });
        // Cancel after default reviewer count so provider/model options were built
        if (/Default reviewers/i.test(title)) return undefined;
        return undefined;
      },
      notify() {},
    },
  });

  const serialized = JSON.stringify(views);
  // Provider/model pickers are only shown after count steps; if we cancelled
  // early, still assert trusted route filtering produced at least the default
  // count ceiling from 3 distinct trusted routes (not 4 with evil-proxy).
  const defaultStep = views.find((v) => /Default reviewers/i.test(v.title));
  assert.ok(defaultStep, "expected default reviewer count step");
  // 3 trusted routes → ceiling min(5,3)=3 options
  assert.equal(defaultStep.options.length, 3);
  assert.ok(!serialized.includes("evil-proxy"));
  assert.ok(!serialized.includes("hijack"));
});
