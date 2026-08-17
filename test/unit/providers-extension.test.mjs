import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

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

test("provider diagnostics drive Pi native OAuth refresh and persistence", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "alloy-pi-auth-"));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    anthropic: {
      type: "oauth",
      access: "expired-access-SECRET_MUST_NOT_APPEAR",
      refresh: "original-refresh-SECRET_MUST_NOT_APPEAR",
      expires: Date.now() - 60_000,
    },
  }));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    return new Response(JSON.stringify({
      access_token: "refreshed-access-SECRET_MUST_NOT_APPEAR",
      refresh_token: "rotated-refresh-SECRET_MUST_NOT_APPEAR",
      expires_in: 3_600,
    }), { status: 200 });
  });

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const [anthropic] = await diagnoseProvidersWithPiAuth(
    new ModelRegistry(runtime),
    [{
      id: "anthropic",
      label: "Anthropic (Claude)",
      status: "refreshable",
      detail: "stored OAuth",
      loginHint: "/login",
      ok: false,
    }],
  );

  const persisted = JSON.parse(readFileSync(authPath, "utf8")).anthropic;
  assert.equal(anthropic.status, "subscription");
  assert.equal(anthropic.ok, true);
  assert.equal(persisted.access, "refreshed-access-SECRET_MUST_NOT_APPEAR");
  assert.equal(persisted.refresh, "rotated-refresh-SECRET_MUST_NOT_APPEAR");
  assert.doesNotMatch(JSON.stringify(anthropic), /SECRET_MUST_NOT_APPEAR/);
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
      throw new Error("temporary provider outage SECRET_MUST_NOT_APPEAR");
    },
  };

  const [xai] = await diagnoseProvidersWithPiAuth(modelRegistry, raw);

  assert.equal(xai.ok, false);
  assert.equal(xai.status, "unavailable");
  assert.match(xai.detail, /retry.*doctor/i);
  assert.doesNotMatch(xai.detail, /login/i);
  assert.doesNotMatch(JSON.stringify(xai), /temporary provider outage|SECRET_MUST_NOT_APPEAR/);
});

test("provider diagnostics request re-login for a definitively rejected refresh token", async () => {
  const [xai] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    async getProviderAuth() {
      throw new Error("invalid_grant SECRET_MUST_NOT_APPEAR");
    },
  }, [{
    id: "xai",
    label: "xAI (Grok)",
    status: "refreshable",
    detail: "stored OAuth",
    loginHint: "/login xai",
    ok: false,
  }]);

  assert.equal(xai.ok, false);
  assert.equal(xai.status, "reauth_required");
  assert.match(xai.detail, /sign in again/i);
  assert.doesNotMatch(JSON.stringify(xai), /invalid_grant|SECRET_MUST_NOT_APPEAR/);
  assert.deepEqual(providerAuthGuidance([xai]).lines, [
    "Run /login xai to reconnect xAI (Grok); its stored authorization was rejected.",
  ]);
});

test("provider diagnostics classify quota failures without requesting login", async () => {
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    async getProviderAuth() {
      throw new Error("HTTP 403: extra usage quota exhausted");
    },
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "refreshable",
    detail: "stored OAuth",
    loginHint: "/login",
    ok: false,
  }]);

  assert.equal(anthropic.status, "quota_exhausted");
  assert.doesNotMatch(anthropic.detail, /login|sign in/i);
  assert.deepEqual(providerAuthGuidance([anthropic]).lines, [
    "Anthropic (Claude) is out of quota; wait for the usage window or change the provider plan.",
  ]);
});

test("provider diagnostics keep an unrelated 403 unavailable rather than requesting login", async () => {
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    async getProviderAuth() {
      throw new Error("HTTP 403 Forbidden");
    },
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "refreshable",
    detail: "stored OAuth",
    loginHint: "/login",
    ok: false,
  }]);

  assert.equal(anthropic.status, "unavailable");
  assert.doesNotMatch(anthropic.detail, /login|sign in/i);
});

test("provider diagnostics share an in-flight Pi auth refresh", async () => {
  let resolveAuth;
  let resolutionCalls = 0;
  const modelRegistry = {
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getProviderAuth() {
      resolutionCalls++;
      return new Promise((resolve) => {
        resolveAuth = resolve;
      });
    },
  };
  const raw = [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "refreshable",
    detail: "stored OAuth",
    loginHint: "/login",
    ok: false,
  }];

  const first = diagnoseProvidersWithPiAuth(modelRegistry, raw, 1_000);
  const second = diagnoseProvidersWithPiAuth(modelRegistry, raw, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolutionCalls, 1);
  resolveAuth({ auth: { apiKey: "synthetic" }, source: "OAuth" });
  const [[firstResult], [secondResult]] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
});

test("missing provider auth does not invoke Pi auth resolution", async () => {
  let resolutionCalls = 0;
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: false }),
    async getProviderAuth() {
      resolutionCalls++;
      return { auth: { apiKey: "synthetic" } };
    },
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "missing",
    detail: "not configured",
    loginHint: "/login",
    ok: false,
  }]);

  assert.equal(anthropic.status, "missing");
  assert.equal(resolutionCalls, 0);
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

test("Pi runtime auth source overrides stale raw OAuth metadata", async () => {
  const [xai] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
    getProviderAuth: async () => ({ auth: { apiKey: "synthetic" }, source: "runtime API key" }),
  }, [{
    id: "xai",
    label: "xAI (Grok)",
    status: "refreshable",
    detail: "stale stored OAuth",
    loginHint: "/login xai",
    ok: false,
  }]);

  assert.equal(xai.status, "api_key");
  assert.doesNotMatch(xai.detail, /OAuth|refreshes/i);
});

test("Pi stored API key type overrides stale raw environment metadata", async () => {
  const [anthropic] = await diagnoseProvidersWithPiAuth({
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getAll: () => [{ provider: "anthropic" }],
    isUsingOAuth: () => false,
    getProviderAuth: async () => ({ auth: { apiKey: "synthetic" }, source: "stored credential" }),
  }, [{
    id: "anthropic",
    label: "Anthropic (Claude)",
    status: "env",
    detail: "environment key",
    loginHint: "/login",
    ok: true,
  }]);

  assert.equal(anthropic.status, "api_key");
  assert.doesNotMatch(anthropic.detail, /OAuth|refreshes/i);
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
  assert.equal(xai.status, "timed_out");
  assert.deepEqual(providerAuthGuidance([xai]).lines, [
    "Pi auth timed out for xAI (Grok); wait for the check to finish or restart Alloy before retrying /doctor.",
  ]);
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
    needsReauth: 0,
    unavailable: 1,
    timedOut: 0,
    quotaExhausted: 0,
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

test("registered doctor view does not append unconditional provider login commands", async () => {
  const commands = new Map();
  registerProviders({
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerProvider() {},
    on() {},
  });
  const dialogs = [];
  const notifications = [];
  await commands.get("doctor").handler("", {
    hasUI: true,
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderAuth: async () => {
        throw new Error("temporary provider outage");
      },
    },
    ui: {
      async select(title, items) {
        dialogs.push({ title, items });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });

  const report = dialogs.flatMap(({ items }) => items).join("\n");
  assert.doesNotMatch(report, /Claude\s+→\s+\/login/);
  assert.doesNotMatch(report, /Grok\s+→\s+\/login xai/);
  assert.match(notifications.map(({ message }) => message).join("\n"), /Retry \/doctor/);
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
