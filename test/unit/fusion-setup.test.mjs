import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as autoExtension from "../../extensions/auto.ts";

const { registerAuto } = autoExtension;

function registerFusionCommand() {
  const commands = new Map();
  registerAuto({
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
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
    assert.equal(typeof widgets.at(-1).content, "function");
    assert.match(result.content[0].text, /Provider unavailable in this Alloy session/);
    assert.equal(result.details.error, "provider_unavailable");
  } finally {
    if (previousHome === undefined) delete process.env.ALLOY_HOME;
    else process.env.ALLOY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
