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
