import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as autoExtension from "../../extensions/auto.ts";

const { createFusionPresentationSummary, formatFusionContextLines, registerAuto } = autoExtension;

function registerFusionCommand(sentMessages = [], messageRenderers = new Map()) {
  const commands = new Map();
  registerAuto({
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
    registerMessageRenderer(type, renderer) {
      messageRenderers.set(type, renderer);
    },
    sendMessage(message) {
      sentMessages.push(message);
    },
  });
  return commands.get("fusion");
}

function registerFusionTool() {
  let fusionTool;
  registerAuto({
    on() {},
    registerCommand() {},
    registerTool(tool) {
      if (tool.name === "alloy_fusion") fusionTool = tool;
    },
  });
  return fusionTool;
}

test("Fusion operator output names routed provider failures", () => {
  assert.equal(typeof autoExtension.formatFusionLines, "function");
  const lines = autoExtension.formatFusionLines({
    status: "FAILED",
    runId: "run-1",
    runDir: "/tmp/run-1",
    models: {},
    usage: {},
    synthesis: "",
    error: "provider_unavailable",
    missingProviders: ["anthropic"],
    routing: {
      architect: {
        reason: "no eligible configured model for planning",
      },
    },
  });

  assert.match(lines.join("\n"), /anthropic/);
  assert.match(lines.join("\n"), /no eligible configured model for planning/);
});

test("Fusion transcript details are bounded while context contains metadata only", () => {
  const largeProposal = "architect result ".repeat(20_000);
  const largeSynthesis = "synthesis result ".repeat(20_000);
  const summary = {
    kind: "fusion",
    status: "COMPLETE",
    runId: "run-large",
    runDir: "/tmp/run-large",
    objective: `Compare the implementations ${"carefully ".repeat(1_000)}`,
    models: {
      architect: "anthropic/architect",
      builder: "openai-codex/builder",
      synthesizer: "anthropic/synthesizer",
    },
    proposals: [
      { role: "architect", text: largeProposal },
      { role: "builder", text: "builder result" },
    ],
    synthesis: largeSynthesis,
    usage: {},
    routing: {
      architect: { reason: "route ".repeat(20_000), candidates: ["candidate ".repeat(20_000)] },
    },
    panel: ["panel ".repeat(20_000)],
    hostileMetadata: "must be dropped ".repeat(20_000),
  };

  const presented = createFusionPresentationSummary(summary);
  const context = formatFusionContextLines(presented).join("\n");

  assert.ok(Buffer.byteLength(JSON.stringify(presented)) < 12_000);
  assert.equal("hostileMetadata" in presented, false);
  assert.equal("panel" in presented, false);
  assert.match(presented.proposals[0].text, /truncated.*artifact/);
  assert.match(presented.synthesis, /truncated.*artifact/);
  assert.equal(summary.proposals[0].text, largeProposal);
  assert.doesNotMatch(context, /architect result/);
  assert.doesNotMatch(context, /synthesis result/);
  assert.match(context, /Compare the implementations/);
  assert.ok(Buffer.byteLength(context) < 2_000);
  assert.match(context, /Bounded transcript previews; full outputs in run artifacts/);
  assert.match(context, /\/tmp\/run-large/);

  const saturated = createFusionPresentationSummary({
    ...summary,
    runId: "r".repeat(20_000),
    runDir: `/${"path/".repeat(20_000)}`,
    models: Object.fromEntries(["architect", "builder", "synthesizer"].map((role) => [role, "model".repeat(20_000)])),
    requestedEfforts: Object.fromEntries(["architect", "builder", "synthesizer"].map((role) => [role, "effort".repeat(20_000)])),
    proposals: ["architect", "builder"].map((role) => ({
      role,
      requestedModel: "requested".repeat(20_000),
      model: "model".repeat(20_000),
      ok: false,
      error: "error".repeat(20_000),
      text: `${role} `.repeat(20_000),
      usage: { input: 1, output: 2, cost: 3, turns: 4, costKnown: true },
    })),
    synthesis: "synthesis ".repeat(20_000),
    synthesizer: {
      model: "model".repeat(20_000),
      ok: false,
      error: "error".repeat(20_000),
      usage: { input: 1, output: 2, cost: 3, turns: 4, costKnown: true },
    },
    missingProviders: Array.from({ length: 100 }, () => "provider".repeat(20_000)),
    routing: Object.fromEntries(["architect", "builder", "synthesizer"].map((role) => [role, {
      model: "model".repeat(20_000),
      provider: "provider".repeat(20_000),
      reason: "reason".repeat(20_000),
    }])),
  });
  const saturatedContext = formatFusionContextLines(saturated).join("\n");
  assert.ok(Buffer.byteLength(JSON.stringify(saturated)) < 7_000);
  assert.ok(Buffer.byteLength(saturatedContext) < 2_500);

  const hydratedRecord = JSON.stringify({
    type: "response",
    command: "get_messages",
    success: true,
    data: {
      messages: Array.from({ length: 100 }, () => ({
        role: "custom",
        customType: "alloy-fusion",
        content: saturatedContext,
        details: saturated,
      })),
    },
  });
  assert.ok(Buffer.byteLength(hydratedRecord) < 1024 * 1024);
});

test("Fusion transcript truncation preserves valid UTF-8", () => {
  const presented = createFusionPresentationSummary({
    kind: "fusion",
    runDir: "/tmp/run-unicode",
    proposals: [{ role: "architect", text: "🧭".repeat(20_000) }],
    synthesis: "🧩".repeat(20_000),
  });

  assert.doesNotMatch(presented.proposals[0].text, /�/);
  assert.doesNotMatch(presented.synthesis, /�/);
  assert.ok(Buffer.byteLength(JSON.stringify(presented)) < 40_000);
});

test("Fusion context reports unknown aggregate cost", () => {
  const context = formatFusionContextLines({
    status: "BUDGET_EXCEEDED",
    runId: "run-unknown-cost",
    runDir: "/tmp/run-unknown-cost",
    usage: { input: 2, output: 3, turns: 2, cost: 0, costKnown: false },
  }).join("\n");

  assert.match(context, /cost unknown/);
  assert.doesNotMatch(context, /\$0\.0000/);
});

test("native Pi renderer keeps bounded Fusion results visible", () => {
  const renderers = new Map();
  registerFusionCommand([], renderers);
  const renderer = renderers.get("alloy-fusion");
  assert.equal(typeof renderer, "function");

  const component = renderer({
    content: "metadata only",
    details: {
      kind: "fusion",
      status: "COMPLETE",
      runId: "fusion-native",
      runDir: "/tmp/fusion-native",
      objective: "Compare implementations",
      proposals: [
        { role: "architect", model: "anthropic/a", ok: true, text: "Architect preview" },
        { role: "builder", model: "openai-codex/b", ok: false, error: "builder failed", text: "Builder preview" },
      ],
      synthesis: "Combined recommendation",
      synthesizer: { model: "anthropic/s", ok: true },
      usage: { input: 1, output: 2, turns: 3, cost: null, costKnown: false },
    },
  }, { expanded: false, outputPad: 0 }, {
    fg(_color, text) { return text; },
    bg(_color, text) { return text; },
  });
  const rendered = component.render(100).join("\n");

  assert.match(rendered, /Architect preview/);
  assert.match(rendered, /Builder preview/);
  assert.match(rendered, /builder failed/);
  assert.match(rendered, /Combined recommendation/);
  assert.match(rendered, /cost unknown/);
});

function writeConfig(home) {
  const config = {
    providers: {
      allow: ["anthropic", "openai-codex", "xai"],
      favorites: [],
    },
    fusion: {
      architectModel: "anthropic/claude-old",
      builderModel: "openai-codex/gpt-old",
      synthesizerModel: "xai/grok-old",
      architectEffort: null,
      builderEffort: null,
      synthesizerEffort: null,
    },
  };
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
  return config;
}

function setupContext(answers, calls, notifications) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    modelRegistry: {
      getAll: () => [
        { provider: "xai", id: "grok-new" },
        { provider: "openai-codex", id: "gpt-new" },
        { provider: "anthropic", id: "claude-new" },
      ],
    },
    ui: {
      async select(title, options) {
        calls.push({ title, options });
        if (title === "Fusion setup saved") return undefined;
        return answers.shift();
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

test("fusion setup selects a provider before each model", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-setup-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    writeConfig(home);
    const calls = [];
    const notifications = [];
    const command = registerFusionCommand();
    const ctx = setupContext(
      [
        "Anthropic",
        "claude-new",
        "high",
        "Codex",
        "gpt-new",
        "medium",
        "xAI",
        "grok-new",
        "default (model/provider default)",
      ],
      calls,
      notifications,
    );

    await command.handler("setup", ctx);

    assert.deepEqual(calls[0].options, ["Anthropic", "Codex", "xAI"]);
    assert.deepEqual(calls[1].options, ["claude-new", "claude-old"]);
    assert.deepEqual(calls[4].options, ["gpt-new", "gpt-old"]);
    assert.deepEqual(calls[7].options, ["grok-new", "grok-old"]);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.deepEqual(saved.fusion, {
      architectModel: "anthropic/claude-new",
      builderModel: "openai-codex/gpt-new",
      synthesizerModel: "xai/grok-new",
      architectEffort: "high",
      builderEffort: "medium",
      synthesizerEffort: null,
    });
    assert.deepEqual(notifications, []);
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("fusion setup cancellation leaves configuration unchanged", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-cancel-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    const original = writeConfig(home);
    const calls = [];
    const notifications = [];
    const command = registerFusionCommand();
    const ctx = setupContext(["Anthropic", undefined], calls, notifications);

    await command.handler("setup", ctx);

    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.deepEqual(saved, original);
    assert.deepEqual(notifications, [
      {
        message: "Fusion setup cancelled; no settings changed.",
        level: "info",
      },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("alloy_fusion tool paints panes through its execution context", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-tool-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    writeConfig(home);
    const widgets = [];
    const tool = registerFusionTool();
    const ctx = {
      modelRegistry: {
        find: (provider, id) => ({ provider, id }),
        getApiKeyAndHeaders: async () => ({
          ok: false,
          error: "provider unavailable",
        }),
      },
      ui: {
        setWidget(key, content, options) {
          widgets.push({ key, content, options });
        },
        setStatus() {},
      },
    };

    const result = await tool.execute(
      "tool-1",
      { request: "Design the feature" },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(widgets.length >= 1);
    assert.equal(widgets[0].options.placement, "aboveEditor");
    assert.equal(widgets.at(-1).content, undefined);
    assert.match(result.content[0].text, /Provider unavailable in this Alloy session/);
    assert.equal(result.details.error, "provider_unavailable");
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("fusion command leaves its result in transcript scrollback without a completion modal", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-command-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    writeConfig(home);
    const sentMessages = [];
    const widgets = [];
    const command = registerFusionCommand(sentMessages);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      modelRegistry: {
        find: (provider, id) => ({ provider, id }),
        getApiKeyAndHeaders: async () => ({ ok: false, error: "provider unavailable" }),
      },
      ui: {
        async confirm() {
          return true;
        },
        async select() {
          assert.fail("completed Fusion must not open a select modal");
        },
        notify() {},
        setWorkingMessage() {},
        setWidget(key, content, options) {
          widgets.push({ key, content, options });
        },
        setStatus() {},
      },
    };

    await command.handler(`Design the feature ${"deeply ".repeat(20_000)}`, ctx);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, "alloy-fusion");
    assert.equal(sentMessages[0].display, true);
    assert.equal(sentMessages[0].details.kind, "fusion");
    assert.ok(Buffer.byteLength(JSON.stringify(sentMessages[0])) < 40_000);
    assert.equal(widgets[0].options.placement, "aboveEditor");
    assert.equal(widgets.at(-1).content, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("fusion command persists an actionable transcript result when orchestration throws", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-throw-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    const config = writeConfig(home);
    config.fusion.architectEffort = "warp";
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const sentMessages = [];
    const command = registerFusionCommand(sentMessages);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      modelRegistry: { find() {}, getApiKeyAndHeaders() {} },
      ui: {
        async confirm() { return true; },
        notify() {},
        setWorkingMessage() {},
        setWidget() {},
        setStatus() {},
      },
    };

    await command.handler(`Design the feature ${"deeply ".repeat(20_000)}`, ctx);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, "alloy-fusion");
    assert.equal(sentMessages[0].details.status, "FAILED");
    assert.match(sentMessages[0].content, /invalid effort level/);
    assert.ok(Buffer.byteLength(JSON.stringify(sentMessages[0])) < 40_000);
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
