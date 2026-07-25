/**
 * Build provider-scoped, in-memory credential leases for isolated Pi children.
 * Lease payloads are written only to the child's ephemeral 0600 auth.json.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getPiAgentDir } from "./paths.mjs";

const PROVIDER_ENV_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
};

export function providerFromModel(model) {
  const ref = String(model || "");
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : null;
}

function cloneCredential(value) {
  return JSON.parse(JSON.stringify(value));
}

function materializeEnvReference(credential, env) {
  const copy = cloneCredential(credential);
  if (copy?.type !== "api_key" || typeof copy.key !== "string") return copy;
  const match = copy.key.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  const key = match?.[1] || match?.[2];
  if (key && !env[key]) return null;
  if (key) copy.key = String(env[key]);
  return copy;
}

/**
 * @param {{ models: string[], auth?: object, env?: object }} input
 */
export function selectCredentialLease({ models, auth = {}, env = {} }) {
  const providers = [];
  for (const model of models || []) {
    const provider = providerFromModel(model);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }

  const authJson = {};
  const missing = [];
  for (const provider of providers) {
    if (auth?.[provider] && typeof auth[provider] === "object") {
      const credential = materializeEnvReference(auth[provider], env);
      if (credential) {
        authJson[provider] = credential;
        continue;
      }
    }
    const envKey = PROVIDER_ENV_KEYS[provider];
    if (envKey && env[envKey]) {
      authJson[provider] = { type: "api_key", key: String(env[envKey]) };
      continue;
    }
    missing.push(provider);
  }

  return {
    mode: Object.keys(authJson).length ? "ephemeral-json" : "none",
    authJson: Object.keys(authJson).length ? authJson : null,
    providers,
    missing,
  };
}

function inspectAuthFile(path) {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { ok: false, reason: "auth file must not be a symlink" };
  if (!stat.isFile()) return { ok: false, reason: "auth path is not a regular file" };
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return { ok: false, reason: "auth file is not owned by this user" };
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return { ok: false, reason: "auth file permissions must be 0600" };
  }
  return { ok: true };
}

/**
 * Load only enough parent credential state to construct a provider-scoped lease.
 * Secret values are returned in memory and must never be logged or persisted.
 */
export function loadCredentialLeaseForModels(
  models,
  { authPath = join(getPiAgentDir(), "auth.json"), env = process.env } = {},
) {
  let auth = {};
  let authReason = null;
  try {
    const inspection = inspectAuthFile(authPath);
    if (inspection.ok) auth = JSON.parse(readFileSync(authPath, "utf8"));
    else authReason = inspection.reason;
  } catch (error) {
    authReason = error instanceof Error ? error.message : "auth file unreadable";
  }
  return {
    ...selectCredentialLease({ models, auth, env }),
    authPath,
    authReason,
  };
}

function sameModelTransport(model, builtinModel) {
  const requestShape = (candidate) => ({
    provider: candidate.provider,
    id: candidate.id,
    api: candidate.api,
    baseUrl: candidate.baseUrl,
    headers: candidate.headers,
    compat: candidate.compat,
    input: candidate.input,
    reasoning: candidate.reasoning,
    contextWindow: candidate.contextWindow,
    maxTokens: candidate.maxTokens,
    thinkingLevelMap: candidate.thinkingLevelMap,
    cost: candidate.cost,
  });
  return isDeepStrictEqual(requestShape(model), requestShape(builtinModel));
}

function unavailableSessionLease(providers, missing = providers) {
  return {
    mode: "none",
    runtimeCredential: null,
    providers,
    missing,
  };
}

/**
 * Reproduce active parent-session access as a one-provider in-memory lease.
 * Runtime model overrides and partial auth are rejected before child launch.
 */
export async function resolveSessionCredentialLease(models, modelRegistry) {
  if (!Array.isArray(models) || !models.length) {
    return unavailableSessionLease([], ["invalid-model-route"]);
  }

  const routes = [];
  const providers = [];
  for (const model of models) {
    const route = typeof model === "string" ? model.trim() : "";
    const separator = route.indexOf("/");
    if (separator <= 0 || separator === route.length - 1) {
      return unavailableSessionLease(providers, ["invalid-model-route"]);
    }
    const provider = route.slice(0, separator);
    if (!providers.includes(provider)) providers.push(provider);
    routes.push({ provider, modelId: route.slice(separator + 1) });
  }

  if (providers.length !== 1 || routes.length !== 1) {
    return unavailableSessionLease(providers);
  }

  let runtimeCredential = null;
  for (const { provider, modelId } of routes) {
    const model = modelRegistry?.find?.(provider, modelId);
    const builtinModel = getBuiltinModel(provider, modelId);
    if (!model || !builtinModel || !sameModelTransport(model, builtinModel)) {
      return unavailableSessionLease(providers);
    }

    let resolved;
    try {
      resolved = await modelRegistry.getApiKeyAndHeaders(model);
    } catch {
      return unavailableSessionLease(providers);
    }
    if (!resolved?.ok || !resolved.apiKey) {
      return unavailableSessionLease(providers);
    }

    let providerAuth;
    try {
      providerAuth = await modelRegistry.getProviderAuth?.(provider);
    } catch {
      return unavailableSessionLease(providers);
    }
    if (!providerAuth?.auth || providerAuth.auth.apiKey !== resolved.apiKey) {
      return unavailableSessionLease(providers);
    }
    if (
      providerAuth.auth.baseUrl &&
      providerAuth.auth.baseUrl !== builtinModel.baseUrl
    ) {
      return unavailableSessionLease(providers);
    }
    if (resolved.env && Object.keys(resolved.env).length) {
      return unavailableSessionLease(providers);
    }
    if (
      !isDeepStrictEqual(
        resolved.headers || {},
        providerAuth.auth.headers || {},
      )
    ) {
      return unavailableSessionLease(providers);
    }

    runtimeCredential = {
      provider,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
    };
  }

  return {
    mode: "runtime-key",
    runtimeCredential,
    providers,
    missing: [],
  };
}

export async function inspectSessionModelCandidate(route, modelRegistry) {
  const ref = typeof route === "string" ? route.trim() : "";
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    return {
      candidate: {
        model: ref,
        available: false,
        authenticated: false,
        transport: "invalid",
        supportsTools: false,
      },
      lease: unavailableSessionLease([], ["invalid-model-route"]),
    };
  }

  const provider = ref.slice(0, separator);
  const modelId = ref.slice(separator + 1);
  const model = modelRegistry?.find?.(provider, modelId);
  const builtinModel = getBuiltinModel(provider, modelId);
  const builtin = Boolean(
    model && builtinModel && sameModelTransport(model, builtinModel),
  );
  if (!model || !builtinModel || !builtin) {
    return {
      candidate: {
        model: ref,
        available: Boolean(model),
        authenticated: false,
        transport: model ? "custom" : "builtin",
        supportsTools: Boolean(model),
      },
      lease: unavailableSessionLease([provider]),
    };
  }

  const lease = await resolveSessionCredentialLease([ref], modelRegistry);
  return {
    candidate: {
      model: ref,
      available: true,
      authenticated: lease.mode === "runtime-key" && !lease.missing.length,
      transport: "builtin",
      supportsTools: true,
    },
    lease,
  };
}
