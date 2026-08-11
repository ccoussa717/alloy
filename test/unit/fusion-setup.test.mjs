import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as autoExtension from "../../extensions/auto.ts";

const {
  createFusionPresentationSummary,
  createFusionTransportSummary,
  formatFusionContextLines,
  hydrateFusionPresentationSummary,
  registerAuto,
} = autoExtension;

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
    synthesis: "DO NOT ENTER MODEL CONTEXT",
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
  assert.doesNotMatch(lines.join("\n"), /DO NOT ENTER MODEL CONTEXT/);
});

test("Fusion transcript keeps complete output while context contains metadata only", () => {
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

  assert.equal("hostileMetadata" in presented, false);
  assert.equal("panel" in presented, false);
  assert.equal(presented.objective, summary.objective);
  assert.equal(presented.proposals[0].text, largeProposal);
  assert.equal(presented.synthesis, largeSynthesis);
  assert.doesNotMatch(JSON.stringify(presented), /truncated for transcript/);
  assert.equal(summary.proposals[0].text, largeProposal);
  assert.doesNotMatch(context, /architect result/);
  assert.doesNotMatch(context, /synthesis result/);
  assert.match(context, /Compare the implementations/);
  assert.ok(Buffer.byteLength(context) < 2_000);
  assert.match(context, /Full outputs are shown in the terminal/);
  assert.match(context, /model context remains metadata-only/);
  assert.match(context, /\/tmp\/run-large/);
});

test("Fusion transcript preserves complete UTF-8 output", () => {
  const proposal = "🧭".repeat(20_000);
  const synthesis = "🧩".repeat(20_000);
  const presented = createFusionPresentationSummary({
    kind: "fusion",
    runDir: "/tmp/run-unicode",
    proposals: [{ role: "architect", text: proposal }],
    synthesis,
  });

  assert.equal(presented.proposals[0].text, proposal);
  assert.equal(presented.synthesis, synthesis);
});

test("Fusion transport stays below the RPC record limit and hydrates complete output from artifacts", () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fusion-transport-"));
  const previousHome = process.env.ALLOY_HOME;
  process.env.ALLOY_HOME = home;
  try {
    const runDir = join(home, "runs", "fusion-transport");
    mkdirSync(runDir, { recursive: true });
    const architect = `ARCH START\n${"architecture ".repeat(100_000)}\nARCH END`;
    const builder = `BUILD START\n${"implementation ".repeat(100_000)}\nBUILD END`;
    const synthesis = `## Agreements\nShared.\n\n## Disagreements\n- Architect: A\n- Builder: B\n- Status: open\n\n## Consensus\n- Decision: Proceed carefully.\n- Caveats: Open issue.\n${"consensus ".repeat(100_000)}\nSYNTH END`;
    const summary = {
      kind: "fusion",
      status: "COMPLETE",
      runId: "fusion-transport",
      runDir,
      objective: `Compare everything ${"carefully ".repeat(100_000)}`,
      proposals: [
        { role: "architect", model: "anthropic/a", ok: true, text: architect },
        { role: "builder", model: "openai-codex/b", ok: true, text: builder },
      ],
      synthesis,
      synthesizer: { model: "anthropic/s", ok: true },
      usage: {},
    };
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary));

    const transported = createFusionTransportSummary(summary);
    assert.ok(Buffer.byteLength(JSON.stringify(transported)) < 20_000);
    const context = formatFusionContextLines(createFusionPresentationSummary(summary)).join("\n");
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "message_end", message: { customType: "alloy-fusion", content: context, details: transported } })) < 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({
      type: "response",
      command: "get_messages",
      success: true,
      data: {
        messages: Array.from({ length: 100 }, () => ({
          role: "custom",
          customType: "alloy-fusion",
          content: context,
          details: transported,
        })),
      },
    })) < 1024 * 1024);
    assert.equal(transported.bodyStorage, "artifact");
    assert.equal("proposals" in transported, false);
    assert.equal("synthesis" in transported, false);
    assert.equal(transported.summarySha256, createHash("sha256").update(readFileSync(join(runDir, "summary.json"))).digest("hex"));

    const hydrated = hydrateFusionPresentationSummary(transported);
    assert.equal(hydrated.objective, summary.objective);
    assert.equal(hydrated.proposals[0].text, architect);
    assert.equal(hydrated.proposals[1].text, builder);
    assert.equal(hydrated.synthesis, synthesis);

    writeFileSync(join(runDir, "summary.json"), JSON.stringify({ ...summary, synthesis: "tampered" }));
    const tampered = hydrateFusionPresentationSummary(transported);
    assert.match(tampered.error, /artifact could not be read safely/);
    assert.notEqual(tampered.synthesis, "tampered");
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Fusion transport reports a missing completed-run artifact", () => {
  const transported = createFusionTransportSummary({
    kind: "fusion",
    status: "COMPLETE",
    runId: "missing-run",
    runDir: "/tmp/alloy-missing-fusion-run",
    objective: "Show complete output",
    proposals: [],
    synthesis: "",
  });

  assert.equal(transported.bodyStorage, "inline");
  assert.match(transported.error, /artifact could not be read safely/);
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

test("native Pi renderer keeps complete Fusion results visible", () => {
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
    // Session models remain; full pinned catalogs are merged in (Codex 5.6-*, etc.).
    assert.ok(calls[1].options.includes("claude-new"));
    assert.ok(calls[1].options.includes("claude-old"));
    assert.ok(calls[4].options.includes("gpt-new"));
    assert.ok(calls[4].options.includes("gpt-old"));
    assert.ok(
      calls[4].options.includes("gpt-5.6-luna") ||
        calls[4].options.includes("gpt-5.4"),
      `codex list incomplete: ${calls[4].options.join(",")}`,
    );
    assert.ok(calls[7].options.includes("grok-new"));
    assert.ok(calls[7].options.includes("grok-old"));
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
      mode: "rpc",
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
    assert.equal(widgets[0].options.data.kind, "alloy.fusion.live");
    assert.equal(widgets[0].options.data.version, 1);
    assert.deepEqual(widgets[0].options.data.agents.map((agent) => agent.role), [
      "architect",
      "builder",
      "synthesizer",
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(widgets[0].options.data)) < 20_000);
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
      mode: "rpc",
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

    const objective = `Design the feature ${"deeply ".repeat(20_000)}`;
    await command.handler(objective, ctx);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, "alloy-fusion");
    assert.equal(sentMessages[0].display, true);
    assert.equal(sentMessages[0].details.kind, "fusion");
    assert.ok(Buffer.byteLength(JSON.stringify(sentMessages[0])) < 20_000);
    assert.equal(
      hydrateFusionPresentationSummary(sentMessages[0].details).objective,
      objective.trim(),
    );
    assert.ok(Buffer.byteLength(sentMessages[0].content) < 2_000);
    assert.equal(widgets[0].options.placement, "aboveEditor");
    assert.equal(widgets[0].options.data.kind, "alloy.fusion.live");
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

    const objective = `Design the feature ${"deeply ".repeat(20_000)}`;
    await command.handler(objective, ctx);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].customType, "alloy-fusion");
    assert.equal(sentMessages[0].details.status, "FAILED");
    assert.equal(sentMessages[0].details.bodyStorage, "inline");
    assert.match(objective, new RegExp(`^${sentMessages[0].details.objective}`));
    assert.ok(Buffer.byteLength(JSON.stringify(sentMessages[0])) < 20_000);
    assert.match(sentMessages[0].content, /invalid effort level/);
    assert.ok(Buffer.byteLength(sentMessages[0].content) < 2_000);
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
