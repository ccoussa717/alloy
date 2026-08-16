import assert from "node:assert/strict";
import { test } from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

let broker = null;
try {
  broker = await import("../../lib/credential-broker.mjs");
} catch {
  // RED: the implementation module does not exist yet.
}

test("credential broker selects only credentials required by role models", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: [
      "anthropic/claude",
      "openai-codex/gpt",
      "anthropic/claude-synth",
    ],
    auth: {
      anthropic: { type: "oauth", access: "anthropic-token" },
      "openai-codex": { type: "oauth", access: "openai-token" },
      xai: { type: "api_key", key: "xai-secret" },
    },
    env: {},
  });

  assert.equal(lease.mode, "ephemeral-json");
  assert.deepEqual(Object.keys(lease.authJson).sort(), [
    "anthropic",
    "openai-codex",
  ]);
  assert.deepEqual(lease.providers, ["anthropic", "openai-codex"]);
  assert.deepEqual(lease.missing, []);
  assert.equal(JSON.stringify(lease.authJson).includes("xai-secret"), false);
});

test("credential broker materializes selected API-key environment variables", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: ["openai/gpt"],
    auth: {},
    env: { OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret" },
  });

  assert.deepEqual(lease.authJson, {
    openai: { type: "api_key", key: "openai-secret" },
  });
  assert.deepEqual(lease.missing, []);
});

test("credential broker reports selected providers without credentials", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: ["anthropic/claude", "xai/grok"],
    auth: {},
    env: {},
  });

  assert.equal(lease.mode, "none");
  assert.equal(lease.authJson, null);
  assert.deepEqual(lease.missing, ["anthropic", "xai"]);
});

test("credential broker rejects unresolved API-key environment references", () => {
  const lease = broker.selectCredentialLease({
    models: ["openai/gpt"],
    auth: { openai: { type: "api_key", key: "$OPENAI_API_KEY" } },
    env: {},
  });

  assert.equal(lease.mode, "none");
  assert.equal(lease.authJson, null);
  assert.deepEqual(lease.missing, ["openai"]);
});

test("session credential broker reproduces active built-in provider access", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai-codex/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "synthetic-session-token",
        headers: { "x-test-account": "synthetic-account" },
      }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: "synthetic-session-token",
          headers: { "x-test-account": "synthetic-account" },
        },
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "runtime-key",
    runtimeCredential: {
      provider: "openai-codex",
      apiKey: "synthetic-session-token",
      headers: { "x-test-account": "synthetic-account" },
    },
    providers: ["openai-codex"],
    missing: [],
  });
});

test("session credential broker rejects custom model transports before auth", async () => {
  const model = {
    ...getBuiltinModel("openai", "gpt-5.4"),
    baseUrl: "https://proxy.invalid/v1",
  };
  let authCalls = 0;
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: true, apiKey: "must-not-be-leased" };
      },
    },
  );

  assert.equal(authCalls, 0);
  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["openai"],
    missing: ["openai"],
  });
});

test("session credential broker rejects auth-level base URL overrides", async () => {
  const model = getBuiltinModel("openai", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "must-not-be-leased",
      }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: "must-not-be-leased",
          baseUrl: "https://attacker.example/v1",
        },
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["openai"],
    missing: ["openai"],
  });
});

test("session credential broker rejects model-level header overrides before auth", async () => {
  const model = {
    ...getBuiltinModel("openai", "gpt-5.4"),
    headers: { "x-forward-token": "attacker" },
  };
  let authCalls = 0;
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return { ok: true, apiKey: "must-not-be-leased" };
      },
    },
  );

  assert.equal(authCalls, 0);
  assert.deepEqual(lease.missing, ["openai"]);
});

test("session credential broker rejects resolved environment propagation", async () => {
  const model = getBuiltinModel("openai", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "must-not-be-leased",
        env: { AZURE_OPENAI_BASE_URL: "https://attacker.example" },
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "must-not-be-leased" },
        env: { AZURE_OPENAI_BASE_URL: "https://attacker.example" },
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["openai"],
    missing: ["openai"],
  });
});

test("session credential broker rejects provider-auth environment overrides", async () => {
  const model = getBuiltinModel("openai", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "must-not-be-leased",
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "must-not-be-leased" },
        env: { OPENAI_BASE_URL: "https://proxy.invalid/v1" },
      }),
    },
  );

  assert.equal(lease.mode, "none");
  assert.equal(lease.runtimeCredential, null);
});

test("session credential broker rejects model-specific resolved headers", async () => {
  const model = getBuiltinModel("openai", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "must-not-be-leased",
        headers: { "x-model-override": "custom" },
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "must-not-be-leased" },
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["openai"],
    missing: ["openai"],
  });
});

test("session credential broker rejects access it cannot reproduce", async () => {
  const model = getBuiltinModel("anthropic", "claude-opus-4-6");
  for (const resolved of [
    { ok: true },
    { ok: true, headers: { Authorization: "synthetic-header-only" } },
  ]) {
    const lease = await broker.resolveSessionCredentialLease(
      ["anthropic/claude-opus-4-6"],
      {
        find: () => model,
        getApiKeyAndHeaders: async () => resolved,
      },
    );
    assert.deepEqual(lease, {
      mode: "none",
      runtimeCredential: null,
      providers: ["anthropic"],
      missing: ["anthropic"],
    });
  }
});

test("session credential broker requires the full active provider auth", async () => {
  const model = getBuiltinModel("openai", "gpt-5.4");
  const lease = await broker.resolveSessionCredentialLease(
    ["openai/gpt-5.4"],
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "resolved-token",
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "different-token" },
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["openai"],
    missing: ["openai"],
  });
});

test("session credential broker reports parent-inaccessible providers", async () => {
  const lease = await broker.resolveSessionCredentialLease(
    ["anthropic/claude-opus-4-6"],
    {
      find: () => getBuiltinModel("anthropic", "claude-opus-4-6"),
      getApiKeyAndHeaders: async () => ({
        ok: false,
        error: "No API key found for anthropic",
      }),
    },
  );

  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["anthropic"],
    missing: ["anthropic"],
  });
});

test("session credential broker rejects multi-provider leases before auth", async () => {
  let authCalls = 0;
  const lease = await broker.resolveSessionCredentialLease(
    ["anthropic/claude-opus-4-6", "openai-codex/gpt-5.4"],
    {
      find: () => {
        authCalls++;
        return null;
      },
    },
  );

  assert.equal(authCalls, 0);
  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["anthropic", "openai-codex"],
    missing: ["anthropic", "openai-codex"],
  });
});

test("session credential broker rejects multiple same-provider models before auth", async () => {
  let authCalls = 0;
  const lease = await broker.resolveSessionCredentialLease(
    ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    {
      find: () => {
        authCalls++;
        return null;
      },
    },
  );

  assert.equal(authCalls, 0);
  assert.deepEqual(lease, {
    mode: "none",
    runtimeCredential: null,
    providers: ["anthropic"],
    missing: ["anthropic"],
  });
});

test("session credential broker rejects malformed routes before auth", async () => {
  for (const models of [[], [null], ["missing-model/"], ["/missing-provider"]]) {
    let authCalls = 0;
    const lease = await broker.resolveSessionCredentialLease(models, {
      find: () => {
        authCalls++;
        return null;
      },
    });
    assert.equal(lease.mode, "none");
    assert.ok(lease.missing.length > 0);
    assert.equal(authCalls, 0);
  }
});

test("candidate inspection separates non-secret facts from the runtime lease", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-5.4");
  const inspected = await broker.inspectSessionModelCandidate(
    "openai-codex/gpt-5.4",
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "synthetic-session-token",
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "synthetic-session-token" },
      }),
    },
  );

  assert.deepEqual(inspected.candidate, {
    model: "openai-codex/gpt-5.4",
    available: true,
    authenticated: true,
    transport: "builtin",
    supportsTools: true,
  });
  assert.equal(JSON.stringify(inspected.candidate).includes("synthetic-session-token"), false);
  assert.equal(inspected.lease.runtimeCredential.apiKey, "synthetic-session-token");
});

test("canonical Alloy Claude Opus 5 receives a session-scoped lease", async () => {
  const model = {
    ...getBuiltinModel("anthropic", "claude-opus-4-8"),
    id: "claude-opus-5",
    name: "Claude Opus 5",
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
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
    },
  };
  const registry = {
    find: () => model,
    getApiKeyAndHeaders: async () => ({
      ok: true,
      apiKey: "synthetic-opus-token",
    }),
    getProviderAuth: async () => ({
      auth: { apiKey: "synthetic-opus-token" },
    }),
  };

  const inspected = await broker.inspectSessionModelCandidate(
    "anthropic/claude-opus-5",
    registry,
  );

  assert.equal(inspected.candidate.authenticated, true);
  assert.equal(inspected.candidate.transport, "builtin");
  assert.equal(inspected.lease.mode, "runtime-key");
  assert.equal(inspected.lease.runtimeCredential.apiKey, "synthetic-opus-token");
  assert.equal(JSON.stringify(inspected.candidate).includes("synthetic-opus-token"), false);
});

test("canonical Opus 5 rejects unsafe model and auth transports before credential access", async () => {
  const canonical = {
    ...getBuiltinModel("anthropic", "claude-opus-4-8"),
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
    },
  };

  for (const model of [
    { ...canonical, baseUrl: "https://proxy.invalid/v1" },
    { ...canonical, headers: { "x-forward-secret": "unsafe" } },
  ]) {
    let authCalls = 0;
    const inspected = await broker.inspectSessionModelCandidate(
      "anthropic/claude-opus-5",
      {
        find: () => model,
        getApiKeyAndHeaders: async () => {
          authCalls++;
          return { ok: true, apiKey: "must-not-be-read" };
        },
      },
    );
    assert.equal(authCalls, 0);
    assert.equal(inspected.candidate.transport, "custom");
    assert.equal(JSON.stringify(inspected.candidate).includes("unsafe"), false);
  }

  for (const auth of [
    { apiKey: "must-not-be-leased", baseUrl: "https://proxy.invalid/v1" },
    { apiKey: "must-not-be-leased", headers: { "x-auth-override": "unsafe" } },
  ]) {
    const lease = await broker.resolveSessionCredentialLease(
      ["anthropic/claude-opus-5"],
      {
        find: () => canonical,
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "must-not-be-leased",
        }),
        getProviderAuth: async () => ({ auth }),
      },
    );
    assert.equal(lease.mode, "none");
  }
});


test("isTrustedSessionModelRoute accepts registry routes with builtin transport", () => {
  assert.equal(typeof broker.isTrustedSessionModelRoute, "function");
  const model = getBuiltinModel("openai-codex", "gpt-5.4");
  assert.ok(model, "builtin openai-codex/gpt-5.4 should exist");
  assert.equal(
    broker.isTrustedSessionModelRoute("openai-codex/gpt-5.4", {
      find: (provider, id) =>
        provider === "openai-codex" && id === "gpt-5.4" ? model : null,
    }),
    true,
  );
  assert.equal(
    broker.isTrustedSessionModelRoute("openai-codex/gpt-5.4", {
      find: () => ({
        ...model,
        baseUrl: "https://proxy.invalid/v1",
      }),
    }),
    false,
  );
  assert.equal(
    broker.isTrustedSessionModelRoute("openai-codex/missing", {
      find: () => null,
    }),
    false,
  );
  assert.equal(broker.isTrustedSessionModelRoute("not-a-route", { find: () => null }), false);
});

test("isTrustedSessionModelRoute accepts catalog models when only metadata drifts", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-5.6-luna");
  assert.ok(model, "builtin openai-codex/gpt-5.6-luna should exist");
  const drifted = {
    ...model,
    cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { low: "low" },
    compat: { ...(model.compat || {}), extraFlag: true },
    contextWindow: (model.contextWindow || 1000) + 1,
  };
  const registry = {
    find: (provider, id) =>
      provider === "openai-codex" && id === "gpt-5.6-luna" ? drifted : null,
    getApiKeyAndHeaders: async () => ({
      ok: true,
      apiKey: "codex-token",
      headers: {},
    }),
    getProviderAuth: async () => ({
      auth: { apiKey: "codex-token", headers: {} },
    }),
  };
  assert.equal(
    broker.isTrustedSessionModelRoute("openai-codex/gpt-5.6-luna", registry),
    true,
  );
  const inspected = await broker.inspectSessionModelCandidate(
    "openai-codex/gpt-5.6-luna",
    registry,
  );
  assert.equal(inspected.candidate.transport, "builtin");
  assert.equal(inspected.candidate.authenticated, true);
  assert.equal(inspected.lease.mode, "runtime-key");
});

function localOllamaModel(overrides = {}) {
  return {
    provider: "ollama",
    id: "llama3.2",
    name: "llama3.2",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    ...overrides,
  };
}

test("isTrustedSessionModelRoute accepts discovered local engines", () => {
  const model = localOllamaModel();
  assert.equal(
    broker.isTrustedSessionModelRoute("ollama/llama3.2", {
      find: (provider, id) =>
        provider === "ollama" && id === "llama3.2" ? model : null,
    }),
    true,
  );
  assert.equal(
    broker.isTrustedSessionModelRoute("ollama/llama3.2", {
      find: () => localOllamaModel({ api: "anthropic-messages" }),
    }),
    false,
  );
  assert.equal(
    broker.isTrustedSessionModelRoute("ollama/llama3.2", {
      find: () => localOllamaModel({ baseUrl: "not-a-url" }),
    }),
    false,
  );
  assert.equal(
    broker.isTrustedSessionModelRoute("ollama/missing", { find: () => null }),
    false,
  );
  // Non-local custom providers remain untrusted even with openai-completions shape.
  assert.equal(
    broker.isTrustedSessionModelRoute("evil-proxy/gpt", {
      find: () => ({
        provider: "evil-proxy",
        id: "gpt",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9/v1",
      }),
    }),
    false,
  );
});

test("session credential broker leases local engine access like /model", async () => {
  const model = localOllamaModel({
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
    },
    compat: { supportsReasoningEffort: true },
  });
  const lease = await broker.resolveSessionCredentialLease(["ollama/llama3.2"], {
    find: () => model,
    getApiKeyAndHeaders: async () => ({
      ok: true,
      apiKey: "ollama",
      headers: {},
    }),
    getProviderAuth: async () => ({
      auth: { apiKey: "ollama", headers: {} },
    }),
  });

  assert.equal(lease.mode, "runtime-key");
  assert.equal(lease.runtimeCredential.provider, "ollama");
  assert.equal(lease.runtimeCredential.apiKey, "ollama");
  assert.deepEqual(lease.runtimeCredential.headers, {});
  // Children need baseUrl + model snapshot — parent discovery is not loaded there.
  assert.deepEqual(lease.runtimeCredential.transport, {
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    model: {
      id: "llama3.2",
      name: "llama3.2",
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        low: "low",
        medium: "medium",
        high: "high",
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_768,
      compat: { supportsReasoningEffort: true },
    },
  });
  assert.deepEqual(lease.providers, ["ollama"]);
  assert.deepEqual(lease.missing, []);
});

test("inspectSessionModelCandidate marks local engines as local transport", async () => {
  const model = localOllamaModel();
  const inspected = await broker.inspectSessionModelCandidate(
    "ollama/llama3.2",
    {
      find: () => model,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "ollama",
        headers: {},
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "ollama", headers: {} },
      }),
    },
  );

  assert.equal(inspected.candidate.available, true);
  assert.equal(inspected.candidate.authenticated, true);
  assert.equal(inspected.candidate.transport, "local");
  assert.equal(inspected.candidate.supportsTools, true);
  assert.equal(inspected.lease.mode, "runtime-key");
  assert.equal(JSON.stringify(inspected.candidate).includes("ollama"), true);
  assert.equal(
    JSON.stringify(inspected.candidate).includes("apiKey"),
    false,
  );
});

test("isTrustedSessionTransport accepts builtin and local only", () => {
  assert.equal(broker.isTrustedSessionTransport("builtin"), true);
  assert.equal(broker.isTrustedSessionTransport("local"), true);
  assert.equal(broker.isTrustedSessionTransport("custom"), false);
  assert.equal(broker.isTrustedSessionTransport("invalid"), false);
});
