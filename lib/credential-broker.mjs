/**
 * Build provider-scoped, in-memory credential leases for isolated Pi children.
 * Lease payloads are written only to the child's ephemeral 0600 auth.json.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
