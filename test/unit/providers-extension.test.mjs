import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

import {
  registerProviders,
  withClaudeOpus5,
} from "../../extensions/providers.ts";

test("session startup registers Claude Opus 5 on the live Anthropic provider", () => {
  const registrations = [];
  const handlers = new Map();
  const anthropic = anthropicProvider();
  const pi = {
    registerProvider: (...args) => registrations.push(args),
    registerCommand() {},
    on: (event, handler) => handlers.set(event, handler),
  };

  registerProviders(pi);
  handlers.get("session_start")({}, {
    modelRegistry: { getProvider: () => anthropic },
    ui: { setStatus() {} },
  });

  assert.equal(registrations.length, 1);
  const [provider] = registrations[0];
  assert.equal(provider.id, "anthropic");
  assert.equal(provider.auth, anthropic.auth);
  assert.equal(provider.stream, anthropic.stream);

  const models = provider.getModels();
  for (const builtin of anthropic.getModels()) {
    assert.ok(
      models.some((model) => model.id === builtin.id),
      `missing built-in Anthropic model ${builtin.id}`,
    );
  }
  assert.equal(
    models.filter((model) => model.id === "claude-opus-5").length,
    1,
  );
  const opus5 = models.find((model) => model.id === "claude-opus-5");
  assert.ok(opus5);
  assert.deepEqual(
    {
      id: opus5.id,
      name: opus5.name,
      api: opus5.api,
      provider: opus5.provider,
      baseUrl: opus5.baseUrl,
      reasoning: opus5.reasoning,
      input: opus5.input,
      cost: opus5.cost,
      contextWindow: opus5.contextWindow,
      maxTokens: opus5.maxTokens,
      thinkingLevelMap: opus5.thinkingLevelMap,
      compat: opus5.compat,
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        xhigh: "xhigh",
        max: "max",
      },
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      },
    },
  );
});

test("Claude Opus 5 preserves custom models but keeps its canonical transport", () => {
  const anthropic = anthropicProvider();
  const custom = {
    ...anthropic.getModels()[0],
    id: "claude-custom-test",
    name: "Claude Custom Test",
    baseUrl: "https://proxy.example.test/v1",
  };
  let liveModels = [...anthropic.getModels(), custom];
  const proxied = {
    ...anthropic,
    baseUrl: "https://proxy.example.test/v1",
    getModels: () => liveModels,
  };

  const extended = withClaudeOpus5(proxied);
  const models = extended.getModels();

  assert.equal(extended.baseUrl, proxied.baseUrl);
  assert.equal(extended.auth, proxied.auth);
  assert.equal(extended.stream, proxied.stream);
  assert.ok(models.some((model) => model.id === custom.id));
  assert.equal(
    models.find((model) => model.id === "claude-opus-5").baseUrl,
    "https://api.anthropic.com",
  );

  liveModels = anthropic.getModels();
  assert.ok(
    !extended.getModels().some((model) => model.id === "claude-custom-test"),
  );
});
