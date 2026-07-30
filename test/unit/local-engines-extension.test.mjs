// test/unit/local-engines-extension.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLocalEngines } from "../../extensions/local-engines.ts";

test("extension load registers catalogs before session_start", async () => {
  const registrations = [];
  const handlers = new Map();
  const pi = {
    registerProvider: (id, cfg) => registrations.push({ id, cfg }),
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
  assert.equal(registrations.length, 3);
  assert.equal(registrations[0].id, "ollama");
  assert.equal(registrations[0].cfg.apiKey, "$OLLAMA_API_KEY");
  assert.equal(registrations[0].cfg.models[0].id, "m1");
  // Nested provider models must not carry provider/api/baseUrl fields
  assert.equal(registrations[0].cfg.models[0].provider, undefined);
  assert.equal(registrations[0].cfg.models[0].api, undefined);
  assert.equal(registrations[0].cfg.models[0].baseUrl, undefined);
  assert.equal(registrations[1].id, "llama.cpp-local");
  assert.equal(registrations[1].cfg.apiKey, "$LLAMA_CPP_API_KEY");
  assert.deepEqual(registrations[1].cfg.models, []);
  assert.equal(registrations[2].id, "lm-studio");
  assert.equal(registrations[2].cfg.apiKey, "$LM_STUDIO_API_KEY");
  assert.deepEqual(registrations[2].cfg.models, []);

  assert.equal(typeof handlers.get("session_start"), "function");
  let status;
  await handlers.get("session_start")({}, {
    ui: { setStatus(_key, value) { status = value; } },
  });
  assert.equal(status, "local:1");
});

test("registration failures are isolated per provider", async () => {
  const attempted = [];
  const pi = {
    registerProvider(id) {
      attempted.push(id);
      if (id === "ollama") throw new Error("conflict");
    },
    on() {},
  };
  await registerLocalEngines(pi, {
    discover: async () => ({
      ollama: { ok: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [{ id: "a" }] },
      llamaCpp: { ok: true, provider: "llama.cpp-local", baseUrl: "http://127.0.0.1:8080", models: [{ id: "b" }] },
      lmStudio: { ok: true, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "c" }] },
    }),
    loadConfig: () => ({}),
    env: {},
  });
  assert.deepEqual(attempted, ["ollama", "llama.cpp-local", "lm-studio"]);
});

test("discovery failure leaves hosted extension startup intact", async () => {
  const registrations = [];
  await registerLocalEngines(
    {
      registerProvider(id, config) { registrations.push({ id, config }); },
      on() {},
    },
    {
      discover: async () => { throw new Error("unexpected failure"); },
      loadConfig: () => ({}),
      env: {},
    },
  );
  assert.deepEqual(
    registrations.map(({ id }) => id),
    ["ollama", "llama.cpp-local", "lm-studio"],
  );
  assert.ok(registrations.every(({ config }) => config.models.length === 0));
});
