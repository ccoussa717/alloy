# Alloy Local Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover Ollama, llama.cpp, and LM Studio models and surface them in Alloy `/model`, `/providers`, and `/doctor` without OAuth or hand-written `models.json`.

**Architecture:** A pure `lib/local-engines.mjs` module resolves base URLs, probes engines with short timeouts (mocked in tests), and maps HTTP payloads to Pi model specs. An `extensions/local-engines.ts` extension registers those providers via `pi.registerProvider` on `session_start` (and re-probes for doctor). MVP cloud providers stay unchanged; local engines are keyless with placeholder API keys so Pi treats them as configured.

**Tech Stack:** Node 22+, Alloy ESM (`*.mjs` + extension `*.ts`), `node:test` / `node:assert/strict`, Pi `@earendil-works/pi-coding-agent` ExtensionAPI `registerProvider`, undici/global `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-30-alloy-local-engines-design.md`

## Global Constraints

- No Oh My Pi package dependency; no Pi fork/bump required for v1.
- Never print API keys, placeholders, or auth tokens in doctor/providers output.
- Loopback probe timeout 250–500 ms; non-loopback 10_000 ms; use `Promise.allSettled`.
- Provider ids exactly: `ollama`, `llama.cpp`, `lm-studio`.
- Default fusion/orchestration role models stay cloud (do not switch primaries to local).
- Placeholder keys only: `"ollama"`, `"local"` (never log them).
- Existing Anthropic / openai-codex / xAI doctor and login behavior must not regress.
- TDD: failing tests before implementation for each library unit.
- Frequent commits after each green task.

## File structure

| File | Responsibility |
|------|----------------|
| `lib/local-engines.mjs` | URL normalize, timeouts, probes, model mapping, doctor row data |
| `test/unit/local-engines.test.mjs` | Unit tests with injected `fetch` |
| `extensions/local-engines.ts` | Register providers + session hooks |
| `extensions/index.ts` | Wire `registerLocalEngines` |
| `lib/providers.mjs` | Format local engine section in full doctor report |
| `lib/config.mjs` | Default `providers.allow` + `providers.local` flags |
| `config/alloy.example.json` | Example config |
| `extensions/providers.ts` | `/providers` and `/doctor` include local rows |
| `docs/REFERENCE.md`, `README.md`, `CHANGELOG.md` | Docs |

---

### Task 1: URL helpers and probe timeout pure functions

**Files:**
- Create: `lib/local-engines.mjs`
- Create: `test/unit/local-engines.test.mjs`

**Interfaces:**
- Produces:
  - `isLoopbackHostname(hostname: string): boolean`
  - `discoveryProbeTimeoutMs(baseUrl: string, loopbackMs?: number, remoteMs?: number): number`
  - `normalizeOllamaHostEnv(value: string | undefined): string | undefined`
  - `getImplicitOllamaBaseUrl(env?: NodeJS.ProcessEnv): string`
  - `getImplicitLlamaCppBaseUrl(env?: NodeJS.ProcessEnv): string`
  - `getImplicitLmStudioBaseUrl(env?: NodeJS.ProcessEnv): string`
  - `trimTrailingSlash(url: string): string`
  - `ensureOpenAiV1BaseUrl(url: string): string`
  - Constants: `DEFAULT_OLLAMA_BASE_URL`, `DEFAULT_LLAMA_CPP_BASE_URL`, `DEFAULT_LM_STUDIO_BASE_URL`, `DISCOVERY_DEFAULT_CONTEXT_WINDOW` (128000), `DISCOVERY_DEFAULT_MAX_TOKENS` (32768), `LOOPBACK_PROBE_MS` (400), `REMOTE_PROBE_MS` (10000)

- [ ] **Step 1: Write the failing test file**

```js
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
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

```bash
cd /path/to/alloy && node --test test/unit/local-engines.test.mjs
```

Expected: ERR_MODULE_NOT_FOUND for `lib/local-engines.mjs`

- [ ] **Step 3: Implement URL helpers in `lib/local-engines.mjs`**

```js
/**
 * Local engine discovery (Ollama, llama.cpp, LM Studio).
 * Never log secrets. Probes are read-only.
 */

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
export const LOOPBACK_PROBE_MS = 400;
export const REMOTE_PROBE_MS = 10_000;
const OLLAMA_HOST_DEFAULT_PORT = "11434";

export function trimTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function isLoopbackHostname(hostname) {
  const h = String(hostname || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "127.0.0.1" ||
    /^127\./.test(h)
  );
}

export function discoveryProbeTimeoutMs(
  baseUrl,
  loopbackMs = LOOPBACK_PROBE_MS,
  remoteMs = REMOTE_PROBE_MS,
) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return isLoopbackHostname(hostname) ? loopbackMs : remoteMs;
  } catch {
    return loopbackMs;
  }
}

export function normalizeOllamaHostEnv(value) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const candidate = trimmed.includes("://")
    ? trimmed
    : trimmed.startsWith("//")
      ? `http:${trimmed}`
      : trimmed.startsWith(":")
        ? `http://127.0.0.1${trimmed}`
        : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return undefined;
    }
    if (!parsed.port && parsed.protocol === "http:") {
      parsed.port = OLLAMA_HOST_DEFAULT_PORT;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

export function getImplicitOllamaBaseUrl(env = process.env) {
  const base = env.OLLAMA_BASE_URL?.trim();
  if (base) return trimTrailingSlash(base);
  return normalizeOllamaHostEnv(env.OLLAMA_HOST) || DEFAULT_OLLAMA_BASE_URL;
}

export function getImplicitLlamaCppBaseUrl(env = process.env) {
  const a = env.LLAMA_CPP_BASE_URL?.trim();
  if (a) return trimTrailingSlash(a);
  const b = env.LLAMA_BASE_URL?.trim();
  if (b) return trimTrailingSlash(b);
  return DEFAULT_LLAMA_CPP_BASE_URL;
}

export function getImplicitLmStudioBaseUrl(env = process.env) {
  const v = env.LM_STUDIO_BASE_URL?.trim();
  if (v) return trimTrailingSlash(v);
  return DEFAULT_LM_STUDIO_BASE_URL;
}

export function ensureOpenAiV1BaseUrl(url) {
  const base = trimTrailingSlash(url);
  if (base.endsWith("/v1")) return base;
  return `${base}/v1`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test test/unit/local-engines.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/local-engines.mjs test/unit/local-engines.test.mjs
git commit -m "feat(local-engines): URL helpers and probe timeout policy"
```

---

### Task 2: fetch-with-timeout and Ollama discovery

**Files:**
- Modify: `lib/local-engines.mjs`
- Modify: `test/unit/local-engines.test.mjs`

**Interfaces:**
- Consumes: URL helpers from Task 1
- Produces:
  - `fetchWithTimeout(url, options, timeoutMs, fetchImpl): Promise<Response>`
  - `LOCAL_COMPAT` frozen compat object for local OpenAI-compat servers
  - `buildLocalModelSpec({ id, name, provider, baseUrl, contextWindow, maxTokens, reasoning, input }): object`
  - `discoverOllamaModels({ baseUrl, fetchImpl, env }): Promise<{ ok, models, error?, latencyMs, baseUrl }>`
  - `toPositiveNumberOrUndefined(value): number | undefined`

- [ ] **Step 1: Append failing tests**

```js
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
```

- [ ] **Step 2: Run tests — expect FAIL** (functions missing)

```bash
node --test test/unit/local-engines.test.mjs
```

- [ ] **Step 3: Implement Ollama discovery**

Add to `lib/local-engines.mjs`:

```js
export const LOCAL_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
});

export function toPositiveNumberOrUndefined(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = LOOPBACK_PROBE_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    timeoutMs,
  );
  try {
    const userSignal = options.signal;
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else {
        userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), { once: true });
      }
    }
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function buildLocalModelSpec({
  id,
  name,
  provider,
  baseUrl,
  contextWindow = DISCOVERY_DEFAULT_CONTEXT_WINDOW,
  maxTokens,
  reasoning = false,
  input = ["text"],
}) {
  const ctx = contextWindow > 0 ? contextWindow : DISCOVERY_DEFAULT_CONTEXT_WINDOW;
  const cap = maxTokens ?? Math.min(ctx, DISCOVERY_DEFAULT_MAX_TOKENS);
  return {
    id,
    name: name || id,
    api: "openai-completions",
    provider,
    baseUrl: ensureOpenAiV1BaseUrl(baseUrl),
    reasoning: Boolean(reasoning),
    input: Array.isArray(input) ? input : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctx,
    maxTokens: cap,
    compat: { ...LOCAL_COMPAT },
  };
}

function extractOllamaRuntimeContextWindow(payload) {
  const parameters = payload?.parameters;
  if (typeof parameters !== "string") return undefined;
  const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
  return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractOllamaContextWindow(payload) {
  const runtime = extractOllamaRuntimeContextWindow(payload);
  if (runtime !== undefined) return runtime;
  const modelInfo = payload?.model_info;
  if (modelInfo && typeof modelInfo === "object") {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key === "context_length" || key.endsWith(".context_length") || key.endsWith(".context_window")) {
        const n = toPositiveNumberOrUndefined(value);
        if (n !== undefined) return n;
      }
    }
  }
  return undefined;
}

function ollamaCapabilities(payload) {
  const capabilities = payload?.capabilities;
  let reasoning = false;
  let input = ["text"];
  if (Array.isArray(capabilities)) {
    const set = new Set(capabilities.map((c) => String(c).toLowerCase()));
    reasoning = set.has("thinking");
    if (set.has("vision") || set.has("image")) input = ["text", "image"];
  } else if (capabilities && typeof capabilities === "object") {
    reasoning = capabilities.thinking === true;
    if (capabilities.vision === true || capabilities.image === true) input = ["text", "image"];
  }
  return { reasoning, input };
}

export async function discoverOllamaModels({ baseUrl, fetchImpl = fetch, env = process.env } = {}) {
  const resolved = trimTrailingSlash(baseUrl || getImplicitOllamaBaseUrl(env));
  const timeoutMs = discoveryProbeTimeoutMs(resolved);
  const started = Date.now();
  try {
    const tagsUrl = `${resolved}/api/tags`;
    const tagsRes = await fetchWithTimeout(tagsUrl, {}, timeoutMs, fetchImpl);
    if (!tagsRes.ok) {
      return {
        ok: false,
        provider: "ollama",
        baseUrl: resolved,
        models: [],
        error: `HTTP ${tagsRes.status} from ${tagsUrl}`,
        latencyMs: Date.now() - started,
      };
    }
    const payload = await tagsRes.json();
    const entries = (payload.models || []).flatMap((item) => {
      const id = item.model || item.name;
      return id ? [{ id, name: item.name || id }] : [];
    });
    const models = [];
    for (const entry of entries) {
      let contextWindow = DISCOVERY_DEFAULT_CONTEXT_WINDOW;
      let reasoning = false;
      let input = ["text"];
      try {
        const showRes = await fetchWithTimeout(
          `${resolved}/api/show`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: entry.id }),
          },
          timeoutMs,
          fetchImpl,
        );
        if (showRes.ok) {
          const show = await showRes.json();
          contextWindow = extractOllamaContextWindow(show) ?? contextWindow;
          const caps = ollamaCapabilities(show);
          reasoning = caps.reasoning;
          input = caps.input;
        }
      } catch {
        // keep defaults for this model
      }
      const override = toPositiveNumberOrUndefined(env.OLLAMA_CONTEXT_LENGTH);
      if (override) contextWindow = override;
      models.push(
        buildLocalModelSpec({
          id: entry.id,
          name: entry.name,
          provider: "ollama",
          baseUrl: resolved,
          contextWindow,
          reasoning,
          input,
        }),
      );
    }
    return {
      ok: true,
      provider: "ollama",
      baseUrl: resolved,
      models,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "ollama",
      baseUrl: resolved,
      models: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
node --test test/unit/local-engines.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/local-engines.mjs test/unit/local-engines.test.mjs
git commit -m "feat(local-engines): discover Ollama models via /api/tags and /api/show"
```

---

### Task 3: llama.cpp and LM Studio discovery

**Files:**
- Modify: `lib/local-engines.mjs`
- Modify: `test/unit/local-engines.test.mjs`

**Interfaces:**
- Produces:
  - `discoverLlamaCppModels({ baseUrl, fetchImpl, env, apiKey? }): Promise<DiscoveryResult>`
  - `discoverLmStudioModels({ baseUrl, fetchImpl, env, apiKey? }): Promise<DiscoveryResult>`
  - DiscoveryResult shape: `{ ok, provider, baseUrl, models, error?, latencyMs }`

- [ ] **Step 1: Append failing tests**

```js
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
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```js
function authHeaders(apiKey) {
  if (!apiKey || !String(apiKey).trim()) return {};
  return { Authorization: `Bearer ${String(apiKey).trim()}` };
}

function llamaStatusIsExcluded(item) {
  const status = item?.status;
  if (!status || typeof status !== "object") return false;
  const value = String(status.value || status.state || "").toLowerCase();
  if (!value) return false;
  return value !== "loaded" && value !== "ready" && value !== "running";
}

export async function discoverLlamaCppModels({
  baseUrl,
  fetchImpl = fetch,
  env = process.env,
  apiKey,
} = {}) {
  const resolved = trimTrailingSlash(baseUrl || getImplicitLlamaCppBaseUrl(env));
  const key = apiKey ?? env.LLAMA_API_KEY ?? env.LLAMA_CPP_API_KEY;
  const timeoutMs = discoveryProbeTimeoutMs(resolved);
  const started = Date.now();
  const headers = authHeaders(key);
  const modelsUrls = [`${ensureOpenAiV1BaseUrl(resolved)}/models`, `${resolved}/models`];
  try {
    let payload = null;
    let lastErr = null;
    for (const modelsUrl of modelsUrls) {
      try {
        const res = await fetchWithTimeout(modelsUrl, { headers }, timeoutMs, fetchImpl);
        if (!res.ok) {
          lastErr = `HTTP ${res.status} from ${modelsUrl}`;
          continue;
        }
        payload = await res.json();
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (!payload || !Array.isArray(payload.data)) {
      return {
        ok: false,
        provider: "llama.cpp",
        baseUrl: resolved,
        models: [],
        error: lastErr || "invalid model catalog",
        latencyMs: Date.now() - started,
      };
    }

    let serverCtx = undefined;
    let serverInput = ["text"];
    try {
      const propsRes = await fetchWithTimeout(`${resolved}/props`, { headers }, timeoutMs, fetchImpl);
      if (propsRes.ok) {
        const props = await propsRes.json();
        const n = props?.default_generation_settings?.n_ctx;
        serverCtx = toPositiveNumberOrUndefined(n);
        if (props?.modalities?.vision === true) serverInput = ["text", "image"];
      }
    } catch {
      // optional
    }

    const models = [];
    for (const item of payload.data) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      if (llamaStatusIsExcluded(item)) continue;
      const metaCtx =
        toPositiveNumberOrUndefined(item.meta?.n_ctx) ??
        toPositiveNumberOrUndefined(item.meta?.n_ctx_train);
      let input = serverInput;
      const modalities = item.architecture?.input_modalities;
      if (Array.isArray(modalities)) {
        input = modalities.map((m) => String(m).toLowerCase()).includes("image")
          ? ["text", "image"]
          : ["text"];
      }
      models.push(
        buildLocalModelSpec({
          id: item.id,
          name: item.id,
          provider: "llama.cpp",
          baseUrl: resolved,
          contextWindow: metaCtx ?? serverCtx ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW,
          input,
        }),
      );
    }
    return {
      ok: true,
      provider: "llama.cpp",
      baseUrl: resolved,
      models,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "llama.cpp",
      baseUrl: resolved,
      models: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

export async function discoverLmStudioModels({
  baseUrl,
  fetchImpl = fetch,
  env = process.env,
  apiKey,
} = {}) {
  const resolved = ensureOpenAiV1BaseUrl(baseUrl || getImplicitLmStudioBaseUrl(env));
  const key = apiKey ?? env.LM_STUDIO_API_KEY;
  const timeoutMs = discoveryProbeTimeoutMs(resolved);
  const started = Date.now();
  try {
    const modelsUrl = `${resolved}/models`;
    const res = await fetchWithTimeout(
      modelsUrl,
      { headers: authHeaders(key) },
      timeoutMs,
      fetchImpl,
    );
    if (!res.ok) {
      return {
        ok: false,
        provider: "lm-studio",
        baseUrl: resolved,
        models: [],
        error: `HTTP ${res.status} from ${modelsUrl}`,
        latencyMs: Date.now() - started,
      };
    }
    const payload = await res.json();
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models = data
      .filter((item) => item && typeof item.id === "string" && item.id)
      .map((item) =>
        buildLocalModelSpec({
          id: item.id,
          name: item.id,
          provider: "lm-studio",
          baseUrl: resolved,
          contextWindow:
            toPositiveNumberOrUndefined(item.context_window) ??
            toPositiveNumberOrUndefined(item.context_length) ??
            DISCOVERY_DEFAULT_CONTEXT_WINDOW,
          maxTokens: toPositiveNumberOrUndefined(item.max_tokens),
        }),
      );
    return {
      ok: true,
      provider: "lm-studio",
      baseUrl: resolved,
      models,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "lm-studio",
      baseUrl: resolved,
      models: [],
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
node --test test/unit/local-engines.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add lib/local-engines.mjs test/unit/local-engines.test.mjs
git commit -m "feat(local-engines): discover llama.cpp and LM Studio models"
```

---

### Task 4: Parallel discoverAll + doctor rows (no secrets)

**Files:**
- Modify: `lib/local-engines.mjs`
- Modify: `test/unit/local-engines.test.mjs`

**Interfaces:**
- Produces:
  - `resolveLocalEngineFlags(config): { enabled, ollama, llamaCpp, lmStudio }`
  - `discoverLocalEngines({ config, env, fetchImpl }): Promise<{ ollama, llamaCpp, lmStudio }>`
  - `formatLocalEnginesDoctorSection(results): string`
  - `localEngineDoctorRows(results): Array<{ id, label, ok, status, detail }>`

- [ ] **Step 1: Failing tests**

```js
test("discoverLocalEngines respects local.enabled false", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("should not run");
  };
  const out = await mod.discoverLocalEngines({
    config: { providers: { local: { enabled: false } } },
    fetchImpl,
  });
  assert.equal(calls, 0);
  assert.equal(out.ollama.ok, false);
  assert.equal(out.ollama.skipped, true);
});

test("discoverLocalEngines runs probes in parallel when enabled", async () => {
  const fetchImpl = mockFetch(async (url) => {
    if (url.includes("11434") && url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "a", model: "a" }] }), { status: 200 });
    }
    if (url.includes("8080") && url.includes("models")) {
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }
    if (url.includes("1234") && url.includes("models")) {
      return new Response(JSON.stringify({ data: [{ id: "lm1" }] }), { status: 200 });
    }
    if (url.endsWith("/api/show")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.endsWith("/props")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  const out = await mod.discoverLocalEngines({ fetchImpl, config: {} });
  assert.equal(out.ollama.ok, true);
  assert.equal(out.llamaCpp.ok, true);
  assert.equal(out.lmStudio.ok, true);
});

test("formatLocalEnginesDoctorSection never embeds secret-like keys", () => {
  const secret = "Bearer-SECRET_MUST_NOT_APPEAR_zzz";
  const text = mod.formatLocalEnginesDoctorSection({
    ollama: {
      ok: true,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [{ id: "x" }],
      latencyMs: 12,
    },
    llamaCpp: {
      ok: false,
      provider: "llama.cpp",
      baseUrl: "http://127.0.0.1:8080",
      models: [],
      error: "ECONNREFUSED",
      latencyMs: 3,
    },
    lmStudio: {
      ok: false,
      provider: "lm-studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: [],
      skipped: true,
    },
  });
  assert.ok(text.includes("Local engines"));
  assert.ok(text.includes("Ollama"));
  assert.ok(text.includes("reachable") || text.includes("OK"));
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("apiKey"));
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```js
export function resolveLocalEngineFlags(config = {}) {
  const local = config.providers?.local || {};
  const enabled = local.enabled !== false;
  return {
    enabled,
    ollama: enabled && local.ollama !== false,
    llamaCpp: enabled && local.llamaCpp !== false,
    lmStudio: enabled && local.lmStudio !== false,
  };
}

function skippedResult(provider, baseUrl) {
  return {
    ok: false,
    provider,
    baseUrl,
    models: [],
    skipped: true,
    error: "disabled by config",
    latencyMs: 0,
  };
}

export async function discoverLocalEngines({
  config = {},
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const flags = resolveLocalEngineFlags(config);
  const tasks = {
    ollama: flags.ollama
      ? discoverOllamaModels({ env, fetchImpl })
      : Promise.resolve(skippedResult("ollama", getImplicitOllamaBaseUrl(env))),
    llamaCpp: flags.llamaCpp
      ? discoverLlamaCppModels({ env, fetchImpl })
      : Promise.resolve(skippedResult("llama.cpp", getImplicitLlamaCppBaseUrl(env))),
    lmStudio: flags.lmStudio
      ? discoverLmStudioModels({ env, fetchImpl })
      : Promise.resolve(skippedResult("lm-studio", getImplicitLmStudioBaseUrl(env))),
  };
  const [ollama, llamaCpp, lmStudio] = await Promise.all([
    tasks.ollama,
    tasks.llamaCpp,
    tasks.lmStudio,
  ]);
  return { ollama, llamaCpp, lmStudio };
}

export function localEngineDoctorRows(bundle) {
  const label = { ollama: "Ollama", "llama.cpp": "llama.cpp", "lm-studio": "LM Studio" };
  return [bundle.ollama, bundle.llamaCpp, bundle.lmStudio].map((r) => {
    const id = r.provider;
    if (r.skipped) {
      return {
        id,
        label: label[id] || id,
        ok: false,
        status: "disabled",
        detail: `disabled in config · ${r.baseUrl}`,
      };
    }
    if (r.ok) {
      return {
        id,
        label: label[id] || id,
        ok: true,
        status: "reachable",
        detail: `reachable (${r.models.length} model${r.models.length === 1 ? "" : "s"}) @ ${r.baseUrl}${
          r.latencyMs != null ? ` · ${r.latencyMs}ms` : ""
        }`,
      };
    }
    return {
      id,
      label: label[id] || id,
      ok: false,
      status: "unreachable",
      detail: `unreachable @ ${r.baseUrl}${r.error ? ` · ${r.error}` : ""}`,
    };
  });
}

export function formatLocalEnginesDoctorSection(bundle) {
  const lines = [
    "Local engines",
    "-------------",
    "Auto-discovery: Ollama, llama.cpp, LM Studio (no OAuth required).",
    "",
  ];
  for (const row of localEngineDoctorRows(bundle)) {
    const mark = row.ok ? "OK " : "NO ";
    lines.push(`[${mark}] ${row.label}`);
    lines.push(`       status: ${row.status}`);
    lines.push(`       ${row.detail}`);
    if (!row.ok && row.status === "unreachable") {
      if (row.id === "ollama") {
        lines.push("       hint: start `ollama serve` or set OLLAMA_BASE_URL / OLLAMA_HOST");
      } else if (row.id === "llama.cpp") {
        lines.push(
          "       hint: start llama-server router, set LLAMA_BASE_URL, or /login llama.cpp · manage with /llama",
        );
      } else if (row.id === "lm-studio") {
        lines.push("       hint: enable LM Studio local server or set LM_STUDIO_BASE_URL");
      }
    }
    lines.push("");
  }
  lines.push("Secrets are never printed. Placeholder local keys are not real credentials.");
  return lines.join("\n");
}
```

- [ ] **Step 4: PASS + commit**

```bash
node --test test/unit/local-engines.test.mjs
git add lib/local-engines.mjs test/unit/local-engines.test.mjs
git commit -m "feat(local-engines): parallel discoverAll and doctor section formatter"
```

---

### Task 5: Config defaults

**Files:**
- Modify: `lib/config.mjs` (`DEFAULT_CONFIG.providers`)
- Modify: `config/alloy.example.json`
- Modify: `test/unit/trust-boundary.test.mjs` only if defaults assertions break; add small assertion in new or existing config test

**Interfaces:**
- Produces: `DEFAULT_CONFIG.providers.allow` includes three local ids; `DEFAULT_CONFIG.providers.local = { enabled: true, ollama: true, llamaCpp: true, lmStudio: true }`

- [ ] **Step 1: Write/adjust test**

In `test/unit/local-engines.test.mjs` or a config test:

```js
import { DEFAULT_CONFIG } from "../../lib/config.mjs"; // or dynamic import like other tests

test("default config allowlists local engines and enables discovery", async () => {
  const { DEFAULT_CONFIG } = await import(
    pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "config.mjs")).href
  );
  for (const id of ["ollama", "llama.cpp", "lm-studio"]) {
    assert.ok(DEFAULT_CONFIG.providers.allow.includes(id), id);
  }
  assert.equal(DEFAULT_CONFIG.providers.local.enabled, true);
  assert.equal(DEFAULT_CONFIG.providers.local.ollama, true);
  assert.equal(DEFAULT_CONFIG.providers.local.llamaCpp, true);
  assert.equal(DEFAULT_CONFIG.providers.local.lmStudio, true);
});
```

- [ ] **Step 2: FAIL then update `DEFAULT_CONFIG` and example json**

```js
// lib/config.mjs — providers block
providers: {
  allow: [
    "anthropic",
    "openai",
    "openai-codex",
    "xai",
    "ollama",
    "llama.cpp",
    "lm-studio",
  ],
  favorites: [
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.4",
    "xai/grok-4.5",
  ],
  local: {
    enabled: true,
    ollama: true,
    llamaCpp: true,
    lmStudio: true,
  },
},
```

Mirror the same `allow` + `local` in `config/alloy.example.json`.

**Note for CHANGELOG (Task 7):** Existing `~/.pi/alloy/config.json` files that already set `providers.allow` to the old four-id list will **not** auto-gain local ids (array merge replaces). Users must add the three ids (or delete allow to re-default). Discovery still registers models for `/model`; allow mainly gates orchestration routing.

- [ ] **Step 3: PASS + commit**

```bash
node --test test/unit/local-engines.test.mjs
git add lib/config.mjs config/alloy.example.json test/unit/local-engines.test.mjs
git commit -m "feat(config): allowlist local engines and discovery flags"
```

---

### Task 6: Extension registration + doctor/providers wiring

**Files:**
- Create: `extensions/local-engines.ts`
- Modify: `extensions/index.ts`
- Modify: `lib/providers.mjs` (`formatFullDoctorReport`)
- Modify: `extensions/providers.ts`
- Create: `test/unit/local-engines-extension.test.mjs`

**Interfaces:**
- Produces: `registerLocalEngines(pi: ExtensionAPI): void`
- Consumes: `discoverLocalEngines`, `buildLocalModelSpec` results, `loadGlobalConfig` or `loadConfig`
- Registration form (legacy config that Pi accepts):

```ts
pi.registerProvider("ollama", {
  name: "Ollama",
  baseUrl: ".../v1",
  apiKey: "ollama", // placeholder; never print
  api: "openai-completions",
  models: [ /* model specs without provider field if required by Pi */ ],
});
```

Strip `provider` from model objects if Pi expects model entries without it when nested under provider config — match Pi docs:

```json
{ "id": "llama3.1:8b", "name": "...", "reasoning": false, "input": ["text"], "cost": {...}, "contextWindow": N, "maxTokens": N, "compat": {...} }
```

- [ ] **Step 1: Extension unit test (mock pi)**

```js
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
});
```

- [ ] **Step 2: Implement `extensions/local-engines.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEngines = require(join(root, "lib", "local-engines.mjs"));
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));

type DiscoverFn = typeof localEngines.discoverLocalEngines;

export type LocalEnginesDependencies = {
  discover?: DiscoverFn;
  loadConfig?: () => unknown;
};

function toRegisterModels(models: Array<Record<string, unknown>>) {
  return models.map((m) => {
    const { provider: _p, api: _a, baseUrl: _b, ...rest } = m;
    return {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ["text"],
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: m.compat,
    };
  });
}

const PLACEHOLDER: Record<string, string> = {
  ollama: "ollama",
  "llama.cpp": "local",
  "lm-studio": "local",
};

const DISPLAY: Record<string, string> = {
  ollama: "Ollama",
  "llama.cpp": "llama.cpp",
  "lm-studio": "LM Studio",
};

export function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;

  const runRegister = async (ctx?: { ui?: { setStatus?: Function } }) => {
    const config = loadConfig();
    const bundle = await discover({ config });
    const entries: Array<{ key: "ollama" | "llamaCpp" | "lmStudio"; id: string }> = [
      { key: "ollama", id: "ollama" },
      { key: "llamaCpp", id: "llama.cpp" },
      { key: "lmStudio", id: "lm-studio" },
    ];
    let registered = 0;
    for (const { key, id } of entries) {
      const result = bundle[key];
      if (!result?.ok || !result.models?.length) continue;
      pi.registerProvider(id, {
        name: DISPLAY[id] || id,
        baseUrl: result.models[0].baseUrl || localEngines.ensureOpenAiV1BaseUrl(result.baseUrl),
        apiKey: PLACEHOLDER[id] || "local",
        api: "openai-completions",
        models: toRegisterModels(result.models),
      });
      registered += 1;
    }
    try {
      ctx?.ui?.setStatus?.(
        "alloy-local",
        `local:${registered}`,
      );
    } catch {
      // ignore
    }
    return bundle;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await runRegister(ctx);
    } catch {
      // never break session startup
    }
  });
}
```

Wire in `extensions/index.ts`:

```ts
import { registerLocalEngines } from "./local-engines.ts";
// after registerProviders(pi):
registerLocalEngines(pi);
```

- [ ] **Step 3: Wire doctor**

In `lib/providers.mjs` `formatFullDoctorReport`, accept optional `localEnginesText` or call discovery:

Prefer inject for testability:

```js
export function formatFullDoctorReport({
  results = diagnoseProviders(),
  dockerText = null,
  localEnginesText = null,
  includeEconomics = true,
  includeModels = true,
} = {}) {
  // ... after formatDoctorReport(results) ...
  if (localEnginesText) {
    lines.push(localEnginesText);
    lines.push("");
  }
  // ...
}
```

In `extensions/providers.ts` doctor handler:

```ts
const { discoverLocalEngines, formatLocalEnginesDoctorSection, localEngineDoctorRows } = require(
  join(root, "lib", "local-engines.mjs"),
);
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));
// inside doctor handler:
const localBundle = await discoverLocalEngines({ config: loadGlobalConfig() });
const localEnginesText = formatLocalEnginesDoctorSection(localBundle);
const full = formatFullDoctorReport({
  results,
  dockerText: formatDockerDoctor(docker),
  localEnginesText,
  includeEconomics: true,
  includeModels: true,
});
```

Update `/providers` command to append local rows from `localEngineDoctorRows(localBundle)`.

Update MVP-only copy: e.g. “All three MVP providers” → “Hosted MVP providers” where appropriate so local does not confuse the message.

- [ ] **Step 4: Run unit tests**

```bash
node --test test/unit/local-engines.test.mjs test/unit/local-engines-extension.test.mjs test/unit/providers.test.mjs test/unit/providers-extension.test.mjs
```

Expected: PASS (fix providers-extension if status string assertions are brittle).

- [ ] **Step 5: Commit**

```bash
git add extensions/local-engines.ts extensions/index.ts extensions/providers.ts lib/providers.mjs test/unit/local-engines-extension.test.mjs
git commit -m "feat(local-engines): register discovered local providers and surface in doctor"
```

---

### Task 7: Docs + CHANGELOG + full verify

**Files:**
- Modify: `docs/REFERENCE.md` (Authentication and providers section)
- Modify: `README.md` (short mention after `/login`)
- Modify: `CHANGELOG.md`
- Optionally: `docs/MVP.md` if it claims only three providers without local

- [ ] **Step 1: REFERENCE.md — add table after API key table**

```markdown
### Local engines (auto-discovery)

Alloy probes these engines at session start when `providers.local.enabled` is true (default):

| Provider | Default URL | Env |
|---|---|---|
| `ollama` | `http://127.0.0.1:11434` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST`; optional `OLLAMA_API_KEY`, `OLLAMA_CONTEXT_LENGTH` |
| `llama.cpp` | `http://127.0.0.1:8080` | `LLAMA_CPP_BASE_URL`, then `LLAMA_BASE_URL`; optional `LLAMA_API_KEY` / `LLAMA_CPP_API_KEY` |
| `lm-studio` | `http://127.0.0.1:1234/v1` | `LM_STUDIO_BASE_URL`; optional `LM_STUDIO_API_KEY` |

No OAuth. Models appear under `/model` when the engine is reachable and has usable models (llama.cpp: loaded models when status is advertised). Pi’s `/llama` still manages llama.cpp load/unload/download. `/doctor` reports reachability and model counts without secrets.

Disable all probes with `"providers": { "local": { "enabled": false } }`. Existing configs that pin `providers.allow` to the old four hosted ids should add `ollama`, `llama.cpp`, and `lm-studio` for orchestration routing; `/model` discovery still registers when probes succeed.
```

- [ ] **Step 2: README — one sentence under first-run auth**

```markdown
Local engines (Ollama, llama.cpp, LM Studio) are auto-detected when running on their default ports; use `/model` after they start. See the reference for env overrides.
```

- [ ] **Step 3: CHANGELOG under Unreleased / next version**

```markdown
### Added
- Auto-discovery for local engines: Ollama, llama.cpp, and LM Studio (zero-config `/model` when servers are up).
- `/doctor` and `/providers` report local engine reachability and model counts (never secrets).
- Config: `providers.local.{enabled,ollama,llamaCpp,lmStudio}` and default allowlist entries for the three providers.
```

- [ ] **Step 4: Full unit suite**

```bash
npm test
```

Expected: all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/REFERENCE.md README.md CHANGELOG.md docs/MVP.md
git commit -m "docs: document local engine auto-discovery"
```

---

### Task 8: Manual smoke (when engines available)

**Files:** none required

- [ ] **Step 1: With Ollama running (optional)**

```bash
curl -s http://127.0.0.1:11434/api/tags | head
# from alloy checkout with deps:
node -e "
import { discoverLocalEngines, formatLocalEnginesDoctorSection } from './lib/local-engines.mjs';
const b = await discoverLocalEngines();
console.log(formatLocalEnginesDoctorSection(b));
console.log('ollama models', b.ollama.models.map(m => m.id));
"
```

Expected: reachable + model ids if Ollama up; unreachable otherwise without throw.

- [ ] **Step 2: Interactive (operator)**

```bash
alloy
# /doctor  → Local engines section
# /providers → local rows
# /model → ollama/... if up
```

- [ ] **Step 3: Final commit only if smoke-driven fixes** — otherwise done.

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Ollama tags + show | Task 2 |
| llama.cpp models + props, loaded-only | Task 3 |
| LM Studio /v1/models | Task 3 |
| Env URL precedence | Task 1 |
| Timeouts loopback/remote | Task 1–2 |
| Parallel allSettled-style | Task 4 (`Promise.all` of independent discover that each catch) |
| Placeholder auth, no secrets in doctor | Task 4, 6 |
| registerProvider on session_start | Task 6 |
| Config flags + allowlist | Task 5 |
| Doctor/providers UX | Task 6 |
| Docs + CHANGELOG | Task 7 |
| Keep fusion cloud defaults | Task 5 (no fusion changes) |
| Coexist with Pi `/llama` | Task 6–7 docs |
| Unit tests mocked fetch | Tasks 1–6 |
| No Oh My Pi dep | all |

## Placeholder scan

Plan avoids TBD/TODO; each step has concrete code or commands.

## Type/name consistency

- Functions: `discoverOllamaModels`, `discoverLlamaCppModels`, `discoverLmStudioModels`, `discoverLocalEngines`, `formatLocalEnginesDoctorSection`, `localEngineDoctorRows`, `resolveLocalEngineFlags`, `registerLocalEngines`
- Config keys: `providers.local.enabled|ollama|llamaCpp|lmStudio`
- Provider ids: `ollama`, `llama.cpp`, `lm-studio`
