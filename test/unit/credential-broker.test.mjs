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
