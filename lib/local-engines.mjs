/**
 * Local engine discovery (Ollama, llama.cpp, LM Studio).
 * Never log secrets. Probes are read-only.
 */

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const LLAMA_CPP_LOCAL_PROVIDER_ID = "llama.cpp-local";
export const DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
export const LOOPBACK_PROBE_MS = 400;
export const REMOTE_PROBE_MS = 10_000;
export const MAX_DISCOVERY_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_DISCOVERED_MODELS = 512;
const OLLAMA_HOST_DEFAULT_PORT = "11434";

export function trimTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeHttpBaseUrl(value, { defaultHttpPort, stripV1 = false } = {}) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.port && parsed.protocol === "http:" && defaultHttpPort) {
      parsed.port = defaultHttpPort;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    if (stripV1) parsed.pathname = parsed.pathname.replace(/\/v1$/u, "") || "/";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

export function redactLocalEngineUrl(value) {
  return normalizeHttpBaseUrl(value) || "invalid URL";
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
    return normalizeHttpBaseUrl(parsed.toString(), {
      defaultHttpPort: OLLAMA_HOST_DEFAULT_PORT,
      stripV1: true,
    });
  } catch {
    return undefined;
  }
}

export function getImplicitOllamaBaseUrl(env = process.env) {
  const base = env.OLLAMA_BASE_URL?.trim();
  if (base) {
    return normalizeHttpBaseUrl(base, { stripV1: true }) || DEFAULT_OLLAMA_BASE_URL;
  }
  return normalizeOllamaHostEnv(env.OLLAMA_HOST) || DEFAULT_OLLAMA_BASE_URL;
}

export function getImplicitLlamaCppBaseUrl(env = process.env) {
  const a = env.LLAMA_CPP_BASE_URL?.trim();
  if (a) return normalizeHttpBaseUrl(a, { stripV1: true }) || DEFAULT_LLAMA_CPP_BASE_URL;
  const b = env.LLAMA_BASE_URL?.trim();
  if (b) return normalizeHttpBaseUrl(b, { stripV1: true }) || DEFAULT_LLAMA_CPP_BASE_URL;
  return DEFAULT_LLAMA_CPP_BASE_URL;
}

export function getImplicitLmStudioBaseUrl(env = process.env) {
  const v = env.LM_STUDIO_BASE_URL?.trim();
  if (v) return ensureOpenAiV1BaseUrl(v);
  return DEFAULT_LM_STUDIO_BASE_URL;
}

export function ensureOpenAiV1BaseUrl(url) {
  const base = normalizeHttpBaseUrl(url);
  if (!base) return "";
  const parsed = new URL(base);
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return parsed.toString().replace(/\/$/u, "");
}

export const LOCAL_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
});

export function toPositiveNumberOrUndefined(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

async function readJsonWithinLimit(response, maxBytes = MAX_DISCOVERY_BODY_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("response too large");
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response too large");
    return JSON.parse(text);
  }
  return response.json();
}

export async function fetchJsonWithTimeout(
  url,
  options = {},
  timeoutMs = LOOPBACK_PROBE_MS,
  fetchImpl = fetch,
) {
  const controller = new AbortController();
  const userSignal = options.signal;
  const abortFromUser = () => controller.abort(userSignal?.reason);
  if (userSignal?.aborted) abortFromUser();
  else userSignal?.addEventListener("abort", abortFromUser, { once: true });

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  const request = (async () => {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    return { response, payload: await readJsonWithinLimit(response) };
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", abortFromUser);
  }
}

function remainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function safeProbeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:HTTP \d{3}|invalid model catalog|request failed|response too large)$/i.test(message)) {
    return message;
  }
  if (error instanceof Error && /timed out|abort/i.test(`${error.name} ${message}`)) {
    return "request timed out";
  }
  return "request failed";
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
  const requestedMax = toPositiveNumberOrUndefined(maxTokens);
  const cap = Math.min(requestedMax ?? DISCOVERY_DEFAULT_MAX_TOKENS, ctx, DISCOVERY_DEFAULT_MAX_TOKENS);
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
  const resolved = getImplicitOllamaBaseUrl({
    ...env,
    ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}),
  });
  const timeoutMs = discoveryProbeTimeoutMs(resolved);
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  const headers = {
    ...authHeaders(env.OLLAMA_API_KEY),
    "Content-Type": "application/json",
  };
  try {
    const tagsUrl = `${resolved}/api/tags`;
    const { response: tagsRes, payload } = await fetchJsonWithTimeout(
      tagsUrl,
      { headers },
      remainingMs(deadline),
      fetchImpl,
    );
    if (!tagsRes.ok) {
      return {
        ok: false,
        provider: "ollama",
        baseUrl: resolved,
        models: [],
        error: `HTTP ${tagsRes.status}`,
        latencyMs: Date.now() - started,
      };
    }
    if (!payload || !Array.isArray(payload.models)) {
      return {
        ok: false,
        provider: "ollama",
        baseUrl: resolved,
        models: [],
        error: "invalid model catalog",
        latencyMs: Date.now() - started,
      };
    }
    const seen = new Set();
    const entries = payload.models.slice(0, MAX_DISCOVERED_MODELS).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = item.model || item.name;
      if (typeof id !== "string" || !id || seen.has(id)) return [];
      seen.add(id);
      return [{ id, name: typeof item.name === "string" && item.name ? item.name : id }];
    });
    const models = await mapWithConcurrency(entries, 8, async (entry) => {
      let contextWindow = DISCOVERY_DEFAULT_CONTEXT_WINDOW;
      let reasoning = false;
      let input = ["text"];
      if (Date.now() < deadline) {
        try {
          const { response: showRes, payload: show } = await fetchJsonWithTimeout(
            `${resolved}/api/show`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ model: entry.id }),
            },
            remainingMs(deadline),
            fetchImpl,
          );
          if (showRes.ok) {
            contextWindow = extractOllamaContextWindow(show) ?? contextWindow;
            const caps = ollamaCapabilities(show);
            reasoning = caps.reasoning;
            input = caps.input;
          }
        } catch {
          // keep defaults for this model
        }
      }
      const override = toPositiveNumberOrUndefined(env.OLLAMA_CONTEXT_LENGTH);
      if (override && contextWindow === DISCOVERY_DEFAULT_CONTEXT_WINDOW) {
        contextWindow = override;
      }
      return buildLocalModelSpec({
        id: entry.id,
        name: entry.name,
        provider: "ollama",
        baseUrl: resolved,
        contextWindow,
        reasoning,
        input,
      });
    });
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
      error: safeProbeError(err),
      latencyMs: Date.now() - started,
    };
  }
}

function authHeaders(apiKey) {
  if (!apiKey || !String(apiKey).trim()) return {};
  return { Authorization: `Bearer ${String(apiKey).trim()}` };
}

function llamaStatusIsExcluded(item) {
  const status = item?.status;
  if (!status) return false;
  const value = String(
    typeof status === "string" ? status : status.value || status.state || "",
  ).toLowerCase();
  if (!value) return false;
  return value !== "loaded" && value !== "ready" && value !== "running";
}

export async function discoverLlamaCppModels({
  baseUrl,
  fetchImpl = fetch,
  env = process.env,
  apiKey,
} = {}) {
  const resolved = getImplicitLlamaCppBaseUrl({
    ...env,
    ...(baseUrl ? { LLAMA_CPP_BASE_URL: baseUrl } : {}),
  });
  const key = apiKey ?? env.LLAMA_CPP_API_KEY ?? env.LLAMA_API_KEY;
  const timeoutMs = discoveryProbeTimeoutMs(resolved);
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  const headers = authHeaders(key);
  const modelsUrls = [`${ensureOpenAiV1BaseUrl(resolved)}/models`, `${resolved}/models`];
  try {
    let payload = null;
    let lastErr = null;
    for (const modelsUrl of modelsUrls) {
      try {
        const { response: res, payload: parsed } = await fetchJsonWithTimeout(
          modelsUrl,
          { headers },
          remainingMs(deadline),
          fetchImpl,
        );
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        if (parsed && Array.isArray(parsed.data)) {
          payload = parsed;
          break;
        }
        lastErr = "invalid model catalog";
      } catch (e) {
        lastErr = safeProbeError(e);
      }
    }
    if (!payload || !Array.isArray(payload.data)) {
      return {
        ok: false,
        provider: LLAMA_CPP_LOCAL_PROVIDER_ID,
        baseUrl: resolved,
        models: [],
        error: lastErr || "invalid model catalog",
        latencyMs: Date.now() - started,
      };
    }

    let serverCtx = undefined;
    let serverInput = ["text"];
    try {
      const { response: propsRes, payload: props } = await fetchJsonWithTimeout(
        `${resolved}/props`,
        { headers },
        remainingMs(deadline),
        fetchImpl,
      );
      if (propsRes.ok) {
        const n = props?.default_generation_settings?.n_ctx;
        serverCtx = toPositiveNumberOrUndefined(n);
        if (props?.modalities?.vision === true) serverInput = ["text", "image"];
      }
    } catch {
      // optional
    }

    const models = [];
    const seen = new Set();
    for (const item of payload.data.slice(0, MAX_DISCOVERED_MODELS)) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
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
          provider: LLAMA_CPP_LOCAL_PROVIDER_ID,
          baseUrl: resolved,
          contextWindow: metaCtx ?? serverCtx ?? DISCOVERY_DEFAULT_CONTEXT_WINDOW,
          input,
        }),
      );
    }
    return {
      ok: true,
      provider: LLAMA_CPP_LOCAL_PROVIDER_ID,
      baseUrl: resolved,
      models,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      provider: LLAMA_CPP_LOCAL_PROVIDER_ID,
      baseUrl: resolved,
      models: [],
      error: safeProbeError(err),
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
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  try {
    const modelsUrl = `${resolved}/models`;
    const { response: res, payload } = await fetchJsonWithTimeout(
      modelsUrl,
      { headers: authHeaders(key) },
      remainingMs(deadline),
      fetchImpl,
    );
    if (!res.ok) {
      return {
        ok: false,
        provider: "lm-studio",
        baseUrl: resolved,
        models: [],
        error: `HTTP ${res.status}`,
        latencyMs: Date.now() - started,
      };
    }
    if (!payload || !Array.isArray(payload.data)) {
      return {
        ok: false,
        provider: "lm-studio",
        baseUrl: resolved,
        models: [],
        error: "invalid model catalog",
        latencyMs: Date.now() - started,
      };
    }
    const seen = new Set();
    const data = payload.data.slice(0, MAX_DISCOVERED_MODELS);
    const models = data
      .filter((item) => {
        if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
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
      error: safeProbeError(err),
      latencyMs: Date.now() - started,
    };
  }
}

export function resolveLocalEngineFlags(config = {}) {
  const local = config.providers?.local || {};
  const enabled = local.enabled !== false;
  const allow = Array.isArray(config.providers?.allow)
    ? new Set(config.providers.allow)
    : null;
  const allowed = (provider) => !allow || allow.has(provider);
  return {
    enabled,
    ollama: enabled && local.ollama !== false && allowed("ollama"),
    llamaCpp:
      enabled && local.llamaCpp !== false && allowed(LLAMA_CPP_LOCAL_PROVIDER_ID),
    lmStudio: enabled && local.lmStudio !== false && allowed("lm-studio"),
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
      : Promise.resolve(skippedResult(LLAMA_CPP_LOCAL_PROVIDER_ID, getImplicitLlamaCppBaseUrl(env))),
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
  const label = {
    ollama: "Ollama",
    [LLAMA_CPP_LOCAL_PROVIDER_ID]: "llama.cpp",
    "lm-studio": "LM Studio",
  };
  return [bundle.ollama, bundle.llamaCpp, bundle.lmStudio].map((r) => {
    const id = r.provider;
    if (r.skipped) {
      return {
        id,
        label: label[id] || id,
        ok: false,
        status: "disabled",
        detail: `disabled in config · ${redactLocalEngineUrl(r.baseUrl)}`,
      };
    }
    if (r.ok && r.models.length > 0) {
      return {
        id,
        label: label[id] || id,
        ok: true,
        status: "reachable",
        detail: `reachable (${r.models.length} model${r.models.length === 1 ? "" : "s"}) @ ${redactLocalEngineUrl(r.baseUrl)}${
          r.latencyMs != null ? ` · ${r.latencyMs}ms` : ""
        }`,
      };
    }
    if (r.ok) {
      return {
        id,
        label: label[id] || id,
        ok: false,
        status: "empty",
        detail: `reachable (no models) @ ${redactLocalEngineUrl(r.baseUrl)}`,
      };
    }
    return {
      id,
      label: label[id] || id,
      ok: false,
      status: "unreachable",
      detail: `unreachable @ ${redactLocalEngineUrl(r.baseUrl)}${r.error ? ` · ${safeProbeError(new Error(r.error))}` : ""}`,
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
      } else if (row.id === LLAMA_CPP_LOCAL_PROVIDER_ID) {
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
