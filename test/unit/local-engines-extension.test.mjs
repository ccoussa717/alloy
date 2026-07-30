// test/unit/local-engines-extension.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLocalEngines } from "../../extensions/local-engines.ts";

test("session_start registers only engines with models", async () => {
  const registrations = [];
  const handlers = new Map();
  const pi = {
    registerProvider: (id, cfg) => registrations.push({ id, cfg }),
    registerCommand() {},
    on: (event, handler) => handlers.set(event, handler),
  };
  registerLocalEngines(pi, {
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
      llamaCpp: { ok: false, provider: "llama.cpp", baseUrl: "http://127.0.0.1:8080", models: [] },
      lmStudio: { ok: true, provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] },
    }),
    loadConfig: () => ({ providers: { local: { enabled: true } } }),
  });
  await handlers.get("session_start")({}, { ui: { setStatus() {}, notify() {} } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "ollama");
  assert.equal(registrations[0].cfg.apiKey, "ollama");
  assert.equal(registrations[0].cfg.models[0].id, "m1");
  // Nested provider models must not carry provider/api/baseUrl fields
  assert.equal(registrations[0].cfg.models[0].provider, undefined);
  assert.equal(registrations[0].cfg.models[0].api, undefined);
  assert.equal(registrations[0].cfg.models[0].baseUrl, undefined);
});
