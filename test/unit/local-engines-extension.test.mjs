// test/unit/local-engines-extension.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLocalEngines } from "../../extensions/local-engines.ts";

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
            reasoning: false,
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

test("manual models.json providers take precedence over successful discovery", async () => {
  const registrations = [];
  await registerLocalEngines(
    {
      registerProvider(id) { registrations.push(id); },
      unregisterProvider() {},
      on() {},
    },
    {
      discover: async () => ({
        ollama: { ok: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [{ id: "auto" }] },
        llamaCpp: { ok: false, provider: "llama.cpp-local", baseUrl: "http://127.0.0.1:8080", models: [] },
        lmStudio: { ok: false, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
      }),
      loadConfig: () => ({}),
      manualProviderIds: () => new Set(["ollama"]),
      env: {},
    },
  );
  assert.deepEqual(registrations, []);
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
