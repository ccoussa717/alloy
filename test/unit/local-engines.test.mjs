// test/unit/local-engines.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mod = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "local-engines.mjs")).href
);

test("normalizeOllamaHostEnv accepts host, host:port, and full URL", () => {
  assert.equal(mod.normalizeOllamaHostEnv("192.168.1.5"), "http://192.168.1.5:11434");
  assert.equal(mod.normalizeOllamaHostEnv("192.168.1.5:11435"), "http://192.168.1.5:11435");
  assert.equal(mod.normalizeOllamaHostEnv("http://ollama.local:11434"), "http://ollama.local:11434");
  assert.equal(mod.normalizeOllamaHostEnv(":11434"), "http://127.0.0.1:11434");
  assert.equal(mod.normalizeOllamaHostEnv(""), undefined);
  assert.equal(mod.normalizeOllamaHostEnv(undefined), undefined);
});

test("getImplicitOllamaBaseUrl prefers OLLAMA_BASE_URL over OLLAMA_HOST", () => {
  assert.equal(
    mod.getImplicitOllamaBaseUrl({
      OLLAMA_BASE_URL: "http://custom:9999",
      OLLAMA_HOST: "ignored:1",
    }),
    "http://custom:9999",
  );
  assert.equal(
    mod.getImplicitOllamaBaseUrl({ OLLAMA_HOST: "10.0.0.2" }),
    "http://10.0.0.2:11434",
  );
  assert.equal(mod.getImplicitOllamaBaseUrl({}), mod.DEFAULT_OLLAMA_BASE_URL);
});

test("getImplicitLlamaCppBaseUrl prefers LLAMA_CPP_BASE_URL then LLAMA_BASE_URL", () => {
  assert.equal(
    mod.getImplicitLlamaCppBaseUrl({
      LLAMA_CPP_BASE_URL: "http://a:1",
      LLAMA_BASE_URL: "http://b:2",
    }),
    "http://a:1",
  );
  assert.equal(
    mod.getImplicitLlamaCppBaseUrl({ LLAMA_BASE_URL: "http://b:2/" }),
    "http://b:2",
  );
  assert.equal(mod.getImplicitLlamaCppBaseUrl({}), mod.DEFAULT_LLAMA_CPP_BASE_URL);
});

test("getImplicitLmStudioBaseUrl defaults and trims", () => {
  assert.equal(
    mod.getImplicitLmStudioBaseUrl({ LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1/" }),
    "http://127.0.0.1:1234/v1",
  );
  assert.equal(mod.getImplicitLmStudioBaseUrl({}), mod.DEFAULT_LM_STUDIO_BASE_URL);
});

test("discoveryProbeTimeoutMs is short for loopback and long for remote", () => {
  assert.equal(mod.discoveryProbeTimeoutMs("http://127.0.0.1:11434"), mod.LOOPBACK_PROBE_MS);
  assert.equal(mod.discoveryProbeTimeoutMs("http://localhost:8080"), mod.LOOPBACK_PROBE_MS);
  assert.ok(mod.discoveryProbeTimeoutMs("http://192.168.1.9:8080") >= 10_000);
});

test("ensureOpenAiV1BaseUrl appends /v1 once", () => {
  assert.equal(mod.ensureOpenAiV1BaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1");
  assert.equal(mod.ensureOpenAiV1BaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(mod.ensureOpenAiV1BaseUrl("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
});

function mockFetch(handler) {
  return async (url, init = {}) => handler(String(url), init);
}

test("discoverOllamaModels maps tags and show metadata", async () => {
  const fetchImpl = mockFetch(async (url, init) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b" }] }), {
        status: 200,
      });
    }
    if (url.endsWith("/api/show") && init.method === "POST") {
      return new Response(
        JSON.stringify({
          capabilities: ["completion", "thinking"],
          model_info: { "llama.context_length": 8192 },
          parameters: "num_ctx 4096\n",
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  });
  const result = await mod.discoverOllamaModels({
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 1);
  const m = result.models[0];
  assert.equal(m.id, "llama3.2:3b");
  assert.equal(m.provider, "ollama");
  assert.equal(m.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(m.api, "openai-completions");
  assert.equal(m.reasoning, true);
  assert.equal(m.contextWindow, 4096); // num_ctx wins over model_info
  assert.equal(m.cost.input, 0);
  assert.equal(m.compat.supportsDeveloperRole, false);
});

test("discoverOllamaModels returns ok:false when unreachable", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await mod.discoverOllamaModels({
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, []);
  assert.ok(result.error);
});

test("discoverOllamaModels empty tags yields ok with zero models", async () => {
  const fetchImpl = mockFetch(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
  const result = await mod.discoverOllamaModels({
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, 0);
});

test("discoverLlamaCppModels keeps only loaded models when status present", async () => {
  const fetchImpl = mockFetch(async (url) => {
    if (url.includes("/props")) {
      return new Response(
        JSON.stringify({
          default_generation_settings: { n_ctx: 8192 },
          modalities: { vision: false },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/models") || url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "loaded-a", status: { value: "loaded" }, meta: { n_ctx: 4096 } },
            { id: "idle-b", status: { value: "unloaded" } },
            { id: "no-status" },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("no", { status: 404 });
  });
  const result = await mod.discoverLlamaCppModels({
    baseUrl: "http://127.0.0.1:8080",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  const ids = result.models.map((m) => m.id).sort();
  // loaded + entries without status (assume available); exclude explicit unloaded
  assert.deepEqual(ids, ["loaded-a", "no-status"]);
  const loaded = result.models.find((m) => m.id === "loaded-a");
  assert.equal(loaded.provider, "llama.cpp");
  assert.equal(loaded.contextWindow, 4096);
  assert.ok(loaded.baseUrl.endsWith("/v1"));
});

test("discoverLmStudioModels maps OpenAI model list", async () => {
  const fetchImpl = mockFetch(async (url) => {
    assert.ok(url.includes("/models"));
    return new Response(
      JSON.stringify({ data: [{ id: "qwen2.5-coder-7b", owned_by: "local" }] }),
      { status: 200 },
    );
  });
  const result = await mod.discoverLmStudioModels({
    baseUrl: "http://127.0.0.1:1234/v1",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.models[0].id, "qwen2.5-coder-7b");
  assert.equal(result.models[0].provider, "lm-studio");
  assert.equal(result.models[0].cost.output, 0);
});
