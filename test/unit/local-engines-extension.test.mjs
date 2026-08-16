// test/unit/local-engines-extension.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerLocalEngines } from "../../extensions/local-engines.ts";

function fakePi(registrations, unregistrations = [], handlers = new Map()) {
  return {
    registerProvider(id, config) { registrations.push({ id, config }); },
    unregisterProvider(id) { unregistrations.push(id); },
    on(event, handler) { handlers.set(event, handler); },
  };
}

function discoveredModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 8192,
    compat: { supportsDeveloperRole: false },
    ...overrides,
  };
}

function discoveryBundle(ollamaModels, ollama = undefined) {
  return {
    ollama: ollama ?? {
      ok: true,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: ollamaModels,
    },
    llamaCpp: {
      ok: false,
      provider: "llama.cpp-local",
      baseUrl: "http://127.0.0.1:8080",
      models: [],
    },
    lmStudio: {
      ok: false,
      provider: "lm-studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: [],
    },
  };
}

test("extension load registers catalogs before session_start", async () => {
  const registrations = [];
  const unregistrations = [];
  const handlers = new Map();
  const pi = {
    registerProvider: (id, cfg) => registrations.push({ id, cfg }),
    unregisterProvider: (id) => unregistrations.push(id),
    registerCommand() {},
    on: (event, handler) => handlers.set(event, handler),
  };
  const result = await registerLocalEngines(pi, {
    discover: async () => ({
      ollama: {
        ok: true,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: [
          {
            id: "m1",
            name: "m1",
            api: "openai-completions",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            reasoning: true,
            thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" },
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192,
            compat: { supportsDeveloperRole: false },
          },
        ],
      },
      llamaCpp: { ok: false, provider: "llama.cpp-local", baseUrl: "http://127.0.0.1:8080", models: [] },
      lmStudio: { ok: true, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
    }),
    loadConfig: () => ({ providers: { local: { enabled: true } } }),
    env: {
      OLLAMA_API_KEY: "real-ollama-key",
      LLAMA_CPP_API_KEY: "real-llama-key",
      LM_STUDIO_API_KEY: "real-lm-key",
    },
  });
  assert.equal(result.ollama.ok, true);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "ollama");
  assert.equal(registrations[0].cfg.apiKey, "$OLLAMA_API_KEY");
  assert.equal(registrations[0].cfg.models[0].id, "m1");
  assert.equal(registrations[0].cfg.models[0].contextWindow, 8192);
  assert.deepEqual(registrations[0].cfg.models[0].thinkingLevelMap, {
    off: "none",
    low: "low",
    medium: "medium",
    high: "high",
  });
  // Nested provider models must not carry provider/api/baseUrl fields
  assert.equal(registrations[0].cfg.models[0].provider, undefined);
  assert.equal(registrations[0].cfg.models[0].api, undefined);
  assert.equal(registrations[0].cfg.models[0].baseUrl, undefined);
  assert.equal(typeof handlers.get("session_start"), "function");
  let status;
  await handlers.get("session_start")({}, {
    ui: { setStatus(_key, value) { status = value; } },
  });
  assert.equal(status, "local:1");
  assert.deepEqual(unregistrations, ["llama.cpp-local", "lm-studio"]);
});

test("registration failures are isolated per provider", async () => {
  const attempted = [];
  const pi = {
    registerProvider(id, config) {
      attempted.push({ id, config });
      if (id === "ollama") throw new Error("conflict");
    },
    unregisterProvider() {},
    on() {},
  };
  await registerLocalEngines(pi, {
    discover: async () => ({
      ollama: { ok: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [{ id: "a" }] },
      llamaCpp: { ok: true, provider: "llama.cpp-local", baseUrl: "http://127.0.0.1:8080", models: [{ id: "b" }] },
      lmStudio: { ok: true, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "c" }] },
    }),
    loadConfig: () => ({}),
    env: {
      LLAMA_CPP_API_KEY: " ",
      LLAMA_API_KEY: "legacy",
      LM_STUDIO_API_KEY: "studio",
    },
  });
  assert.deepEqual(attempted.map(({ id }) => id), ["ollama", "llama.cpp-local", "lm-studio"]);
  assert.equal(attempted[1].config.apiKey, "$LLAMA_API_KEY");
  assert.equal(attempted[2].config.apiKey, "$LM_STUDIO_API_KEY");
});

test("malformed discovered models do not suppress later local providers", async () => {
  const registrations = [];
  const handlers = new Map();
  await registerLocalEngines(fakePi(registrations, [], handlers), {
    discover: async () => ({
      ollama: {
        ok: true,
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: [null],
      },
      llamaCpp: {
        ok: true,
        provider: "llama.cpp-local",
        baseUrl: "http://127.0.0.1:8080",
        models: [discoveredModel("llama", {
          provider: "llama.cpp-local",
          baseUrl: "http://127.0.0.1:8080/v1",
        })],
      },
      lmStudio: {
        ok: true,
        provider: "lm-studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [discoveredModel("studio", {
          provider: "lm-studio",
          baseUrl: "http://127.0.0.1:1234/v1",
        })],
      },
    }),
    loadConfig: () => ({}),
    manualProviders: () => new Map(),
    env: {},
  });

  assert.deepEqual(registrations.map(({ id }) => id), ["llama.cpp-local", "lm-studio"]);
  assert.equal(typeof handlers.get("session_start"), "function");
});

test("discovery failure leaves hosted extension startup intact", async () => {
  const registrations = [];
  const unregistrations = [];
  let sessionStart;
  await registerLocalEngines(
    {
      registerProvider(id, config) { registrations.push({ id, config }); },
      unregisterProvider(id) { unregistrations.push(id); },
      on(event, handler) { if (event === "session_start") sessionStart = handler; },
    },
    {
      discover: async () => { throw new Error("unexpected failure"); },
      loadConfig: () => ({}),
      env: {},
    },
  );
  assert.deepEqual(registrations, []);
  await sessionStart({}, { ui: { setStatus() {} } });
  assert.deepEqual(unregistrations, ["ollama", "llama.cpp-local", "lm-studio"]);
});

test("manual Ollama metadata overrides live discovery without hiding new models", async () => {
  const registrations = [];
  const manualProviders = new Map([["ollama", {
    name: "Private Ollama",
    baseUrl: "http://manual.invalid/v1",
    api: "openai-responses",
    apiKey: "$MANUAL_OLLAMA_KEY",
    headers: { "X-Manual": "yes" },
    authHeader: true,
    compat: { supportsDeveloperRole: false },
    models: [
      { id: "existing", name: "Manual Existing", contextWindow: 65536 },
      { id: "manual-only", name: "Manual Alias", maxTokens: 2048 },
    ],
  }]]);

  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([
      discoveredModel("existing", { contextWindow: 8192 }),
      discoveredModel("new-live"),
    ]),
    loadConfig: () => ({}),
    manualProviders: () => manualProviders,
    env: {},
  });

  const ollama = registrations.find(({ id }) => id === "ollama");
  assert.deepEqual(ollama.config.models.map(({ id }) => id), [
    "existing", "new-live", "manual-only",
  ]);
  assert.equal(ollama.config.models[0].name, "Manual Existing");
  assert.equal(ollama.config.models[0].contextWindow, 65536);
  assert.equal(ollama.config.name, "Private Ollama");
  assert.equal(ollama.config.baseUrl, "http://manual.invalid/v1");
  assert.equal(ollama.config.apiKey, "$MANUAL_OLLAMA_KEY");
  assert.equal(ollama.config.api, "openai-responses");
  assert.deepEqual(ollama.config.headers, { "X-Manual": "yes" });
  assert.equal(ollama.config.authHeader, true);
});

test("canonical manual config loading accepts commented models.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "alloy-model-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  await writeFile(path, `{
    // Pi accepts comments in models.json.
    "providers": {
      "ollama": {
        "name": "Commented Ollama",
        "baseUrl": "http://manual.invalid/v1",
        "api": "openai-completions",
        "models": [{ "id": "manual" }]
      }
    }
  }`);

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const registrations = [];
  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([discoveredModel("live")]),
    loadConfig: () => ({}),
    env: {},
  });

  const ollama = registrations.find(({ id }) => id === "ollama");
  assert.equal(ollama.config.name, "Commented Ollama");
  assert.deepEqual(ollama.config.models.map(({ id }) => id), ["live", "manual"]);
});

test("invalid canonical manual config fails local registration closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "alloy-invalid-model-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify({
    providers: {
      ollama: {
        baseUrl: 42,
        apiKey: "must-not-activate",
        models: [{ id: "manual" }],
      },
    },
  }));
  const registrations = [];
  const unregistrations = [];
  const handlers = new Map();

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await registerLocalEngines(fakePi(registrations, unregistrations, handlers), {
      discover: async () => discoveryBundle([discoveredModel("live")]),
      loadConfig: () => ({}),
      env: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  await handlers.get("session_start")({}, { ui: { setStatus() {} } });

  assert.deepEqual(registrations, []);
  assert.deepEqual(unregistrations, []);
});

test("manual provider compat applies when its model list is omitted", async () => {
  const registrations = [];
  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([discoveredModel("live-only")]),
    loadConfig: () => ({}),
    manualProviders: () => new Map([["ollama", {
      compat: { maxTokensField: "max_tokens" },
    }]]),
    env: {},
  });

  const ollama = registrations.find(({ id }) => id === "ollama");
  assert.equal(ollama.config.models[0].compat.maxTokensField, "max_tokens");
});

test("failed or empty discovery leaves a manual provider registered by Pi", async () => {
  for (const ollama of [
    { ok: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [], error: "offline" },
    { ok: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] },
  ]) {
    const registrations = [];
    const unregistrations = [];
    const handlers = new Map();
    await registerLocalEngines(fakePi(registrations, unregistrations, handlers), {
      discover: async () => discoveryBundle([], ollama),
      loadConfig: () => ({}),
      manualProviders: () => new Map([["ollama", { models: [{ id: "manual" }] }]]),
      env: {},
    });
    await handlers.get("session_start")({}, { ui: { setStatus() {} } });
    assert.equal(registrations.some(({ id }) => id === "ollama"), false);
    assert.equal(unregistrations.includes("ollama"), false);
  }
});

test("discovered order is stable and the last duplicate manual model wins", async () => {
  const registrations = [];
  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([
      discoveredModel("first"),
      discoveredModel("duplicate"),
      discoveredModel("last"),
    ]),
    loadConfig: () => ({}),
    manualProviders: () => new Map([["ollama", {
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      models: [
        { id: "manual-first", name: "Manual First" },
        { id: "duplicate", name: "Older Duplicate", compat: { supportsDeveloperRole: true } },
        { id: "manual-last", name: "Manual Last" },
        { id: "duplicate", name: "Newest Duplicate", maxTokens: 4096 },
      ],
    }]]),
    env: {},
  });

  const models = registrations.find(({ id }) => id === "ollama").config.models;
  assert.deepEqual(models.map(({ id }) => id), [
    "first", "duplicate", "last", "manual-first", "manual-last",
  ]);
  const duplicate = models.find(({ id }) => id === "duplicate");
  assert.equal(models[0].compat.maxTokensField, "max_tokens");
  assert.equal(duplicate.name, "Newest Duplicate");
  assert.equal(duplicate.maxTokens, 4096);
  assert.deepEqual(duplicate.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  });
});

test("compat preserves Pi nested keys across discovery, provider, and model layers", async () => {
  const registrations = [];
  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([discoveredModel("layered", {
      compat: {
        supportsDeveloperRole: false,
        chatTemplateKwargs: { discovered: true },
        openRouterRouting: { allow_fallbacks: true, order: ["discovered"] },
        vercelGatewayRouting: { only: ["discovered"] },
      },
    })]),
    loadConfig: () => ({}),
    manualProviders: () => new Map([["ollama", {
      compat: {
        chatTemplateKwargs: { provider: "kept" },
        openRouterRouting: { require_parameters: true },
        vercelGatewayRouting: { order: ["provider"] },
      },
      models: [{
        id: "layered",
        compat: {
          chatTemplateKwargs: { model: 1 },
          openRouterRouting: { zdr: true },
          vercelGatewayRouting: { only: ["model"] },
        },
      }],
    }]]),
    env: {},
  });

  const compat = registrations.find(({ id }) => id === "ollama").config.models[0].compat;
  assert.deepEqual(compat.chatTemplateKwargs, {
    discovered: true,
    provider: "kept",
    model: 1,
  });
  assert.deepEqual(compat.openRouterRouting, {
    allow_fallbacks: true,
    order: ["discovered"],
    require_parameters: true,
    zdr: true,
  });
  assert.deepEqual(compat.vercelGatewayRouting, {
    only: ["model"],
    order: ["provider"],
  });
});

test("session start moves off a removed local model when a fallback is available", async () => {
  let sessionStart;
  let selected;
  await registerLocalEngines(
    {
      registerProvider() {},
      unregisterProvider() {},
      setModel(model) { selected = model; return Promise.resolve(true); },
      on(event, handler) { if (event === "session_start") sessionStart = handler; },
    },
    {
      discover: async () => ({
        ollama: { ok: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] },
        llamaCpp: { ok: false, provider: "llama.cpp-local", baseUrl: "http://127.0.0.1:8080", models: [] },
        lmStudio: { ok: false, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
      }),
      loadConfig: () => ({}),
      env: {},
    },
  );
  const fallback = { provider: "anthropic", id: "fallback" };
  await sessionStart({}, {
    model: { provider: "ollama", id: "removed" },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [fallback],
    },
    ui: { setStatus() {}, notify() {} },
  });
  assert.equal(selected, fallback);
});
