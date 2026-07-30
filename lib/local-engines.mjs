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
