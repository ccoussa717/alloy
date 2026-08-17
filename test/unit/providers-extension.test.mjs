import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

import {
  diagnoseProvidersWithPiAuth,
  providerAuthGuidance,
  registerProviders,
  withClaudeOpus5,
} from "../../extensions/providers.ts";

test("provider diagnostics use Pi native auth resolution for refreshable OAuth", async () => {
  const calls = [];
  const raw = [
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      status: "expired",
      detail: "raw timestamp says expired",
      loginHint: "/login",
      ok: false,
    },
  ];
  const modelRegistry = {
    getProviderAuthStatus(providerId) {
      calls.push(["status", providerId]);
      return { configured: true, source: "stored" };
    },
    async getProviderAuth(providerId) {
      calls.push(["auth", providerId]);
      return { auth: { apiKey: "SECRET_MUST_NOT_APPEAR" }, source: "OAuth" };
    },
  };

  const [anthropic] = await diagnoseProvidersWithPiAuth(modelRegistry, raw);

  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.status, "subscription");
  assert.match(anthropic.detail, /Pi.*OAuth/i);
  assert.doesNotMatch(JSON.stringify(anthropic), /SECRET_MUST_NOT_APPEAR/);
  assert.deepEqual(calls, [["status", "anthropic"], ["auth", "anthropic"]]);
});

test("provider diagnostics fail closed and redact Pi refresh errors", async () => {
  const raw = [
    {
      id: "xai",
      label: "xAI (Grok)",
      status: "subscription",
      detail: "stored OAuth",
      loginHint: "/login xai",
      ok: true,
    },
  ];
  const modelRegistry = {
    getProviderAuthStatus() {
      return { configured: true, source: "stored" };
    },
    async getProviderAuth() {
      throw new Error("invalid_grant SECRET_MUST_NOT_APPEAR");
    },
  };

  const [xai] = await diagnoseProvidersWithPiAuth(modelRegistry, raw);

  assert.equal(xai.ok, false);
  assert.equal(xai.status, "unavailable");
  assert.match(xai.detail, /retry.*doctor/i);
  assert.doesNotMatch(xai.detail, /login/i);
  assert.doesNotMatch(JSON.stringify(xai), /invalid_grant|SECRET_MUST_NOT_APPEAR/);
});

test("provider diagnostics accept Pi auth results without an optional source label", async () => {
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getProviderAuth: async () => ({ auth: { apiKey: "synthetic" } }),
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "subscription",
    detail: "stored OAuth",
    loginHint: "/login",
    ok: true,
  }]);

  assert.equal(anthropic.ok, true);
  assert.equal(anthropic.status, "subscription");
});

test("provider diagnostics classify Pi runtime keys as API keys", async () => {
  const [xai] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
    getProviderAuth: async () => ({ auth: { apiKey: "synthetic" }, source: "API key" }),
  }, [{
    id: "xai",
    label: "xAI (Grok)",
    status: "missing",
    detail: "not configured",
    loginHint: "/login xai",
    ok: false,
  }]);

  assert.equal(xai.ok, true);
  assert.equal(xai.status, "api_key");
});

test("provider diagnostics bound stalled Pi auth resolution", async () => {
  const started = Date.now();
  const [xai] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getProviderAuth: async () => new Promise(() => {}),
  }, [{
    id: "xai",
    label: "xAI (Grok)",
    status: "refreshable",
    detail: "pending",
    loginHint: "/login xai",
    ok: false,
  }], 10);

  assert.equal(xai.ok, false);
  assert.equal(xai.status, "unavailable");
  assert.ok(Date.now() - started < 1_000);
});

test("provider diagnostics contain synchronous Pi status failures", async () => {
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus() {
      throw new Error("status SECRET_MUST_NOT_APPEAR");
    },
    async getProviderAuth() {
      assert.fail("auth resolution must not run after status failure");
    },
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "subscription",
    detail: "stored OAuth",
    loginHint: "/login",
    ok: true,
  }]);

  assert.equal(anthropic.ok, false);
  assert.equal(anthropic.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(anthropic), /SECRET_MUST_NOT_APPEAR/);
});

test("provider diagnostics treat unresolved configured auth as unavailable", async () => {
  const [xai] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "models_json_command" }),
    getProviderAuth: async () => undefined,
  }, [{
    id: "xai",
    label: "xAI (Grok)",
    status: "missing",
    detail: "not configured",
    loginHint: "/login xai",
    ok: false,
  }]);

  assert.equal(xai.ok, false);
  assert.equal(xai.status, "unavailable");
  assert.doesNotMatch(xai.detail, /login/i);
});

test("provider diagnostics classify every configured Pi auth source", async () => {
  const cases = [
    { source: "runtime", rawStatus: "missing", expected: "api_key" },
    { source: "fallback", rawStatus: "missing", expected: "api_key" },
    { source: "models_json_key", rawStatus: "missing", expected: "api_key" },
    { source: "models_json_command", rawStatus: "missing", expected: "api_key" },
    { source: "stored", rawStatus: "api_key", expected: "api_key" },
    { source: "environment", rawStatus: "missing", expected: "env" },
  ];
  for (const { source, rawStatus, expected } of cases) {
    const [result] = await diagnoseProvidersWithPiAuth({
      getProviderAuthStatus: () => ({ configured: true, source }),
      getProviderAuth: async () => ({ auth: { apiKey: "synthetic" } }),
    }, [{
      id: "xai",
      label: "xAI (Grok)",
      status: rawStatus,
      detail: "not configured",
      loginHint: "/login xai",
      ok: false,
    }]);
    assert.equal(result.status, expected, source);
  }
});

test("provider guidance preserves both login and retry actions for mixed failures", () => {
  assert.deepEqual(providerAuthGuidance([
    { status: "missing" },
    { status: "unavailable" },
    { status: "subscription" },
  ]), {
    needsLogin: 1,
    unavailable: 1,
    lines: [
      "Run /login to connect 1 missing provider.",
      "Retry /doctor for 1 unavailable provider auth check.",
    ],
  });
});

test("registered providers view shows retry guidance without unconditional login advice", async () => {
  const commands = new Map();
  const pi = {
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerProvider() {},
    on() {},
  };
  registerProviders(pi);
  const dialogs = [];
  const providers = {
    anthropic: { configured: true, auth: undefined },
    "openai-codex": { configured: true, auth: { auth: { apiKey: "synthetic" }, source: "OAuth" } },
    xai: { configured: true, auth: { auth: { apiKey: "synthetic" }, source: "OAuth" } },
  };
  await commands.get("providers").handler("", {
    modelRegistry: {
      getProviderAuthStatus: (providerId) => ({ configured: providers[providerId].configured, source: "stored" }),
      getProviderAuth: async (providerId) => providers[providerId].auth,
    },
    ui: {
      async select(title, items) {
        dialogs.push({ title, items });
      },
    },
  });

  const output = dialogs.flatMap(({ items }) => items).join("\n");
  assert.match(output, /Retry \/doctor for 1 unavailable provider auth check/);
  assert.doesNotMatch(output, /Run \/login to connect a subscription/);
});

test("session startup stays network-free and keeps Pi's built-in Claude Opus 5", async () => {
  const registrations = [];
  const handlers = new Map();
  const statuses = [];
  let authResolutionCalls = 0;
  const anthropic = anthropicProvider();
  const pi = {
    registerProvider: (...args) => registrations.push(args),
    registerCommand() {},
    on: (event, handler) => handlers.set(event, handler),
  };

  registerProviders(pi);
  await handlers.get("session_start")({}, {
    modelRegistry: {
      getProvider: () => anthropic,
      getProviderAuthStatus: (providerId) => ({ configured: providerId === "anthropic" }),
      async getProviderAuth() {
        authResolutionCalls++;
        throw new Error("startup must not resolve auth");
      },
    },
    ui: { setStatus: (...args) => statuses.push(args) },
  });

  assert.equal(registrations.length, 0);
  assert.equal(authResolutionCalls, 0);
  assert.deepEqual(statuses, [["alloy-providers", "auth:1/3"]]);
  const provider = anthropic;
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
