/**
 * Resolve and validate model ids against the pinned Pi provider catalogs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "./pi-package.mjs";
import { getAlloyTrustedModel } from "./alloy-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Hosted providers whose full Pi builtin catalog Alloy guarantees in-session. */
export const MVP_CATALOG_PROVIDERS = Object.freeze([
  "anthropic",
  "openai-codex",
  "xai",
]);

/** Defaults known to exist in the Pi version pinned by package.json. */
export const CATALOG_DEFAULTS = {
  favorites: [
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.4",
    "xai/grok-4.5",
  ],
  profiles: {
    research: "xai/grok-4.5",
    code: "openai-codex/gpt-5.4",
    review: "anthropic/claude-opus-4-6",
    plan: "anthropic/claude-sonnet-4-6",
  },
};

function collectIdsFromCatalogText(text) {
  const ids = new Set();
  for (const m of text.matchAll(/id:\s*"([^"]+)"/g)) ids.add(m[1]);
  for (const m of text.matchAll(/"id"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
  // Nested API maps: { "openai-codex-responses": { "gpt-5.6-luna": {…} } }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const key of Object.keys(value)) {
            if (key && !key.includes("/") && key !== "default") ids.add(key);
          }
        }
      }
    }
  } catch {
    // non-JSON provider modules fall back to regex hits only
  }
  return ids;
}

/**
 * Load model id lists from pi-ai provider modules when available.
 * @returns {Record<string, string[]>}
 */
export function loadProviderCatalogIds() {
  /** @type {Record<string, string[]>} */
  const out = {
    anthropic: [],
    "openai-codex": [],
    xai: [],
  };

  const piRoot = findPackageRoot("@earendil-works/pi-coding-agent", [root]);
  const piAiRoot = findPackageRoot("@earendil-works/pi-ai", [
    root,
    piRoot,
  ]);
  const bases = piAiRoot ? [join(piAiRoot, "dist", "providers")] : [];

  const files = {
    anthropic: ["data/anthropic.json", "anthropic.models.js", "anthropic.js"],
    "openai-codex": [
      "data/openai-codex.json",
      "openai-codex.models.js",
      "openai-codex.js",
    ],
    xai: ["data/xai.json", "xai.models.js", "xai.js"],
  };

  for (const [provider, names] of Object.entries(files)) {
    for (const base of bases) {
      for (const name of names) {
        const p = join(base, name);
        if (!existsSync(p)) continue;
        try {
          const text = readFileSync(p, "utf8");
          const ids = collectIdsFromCatalogText(text);
          if (ids.size) {
            out[provider] = [...ids].sort();
            break;
          }
        } catch {
          // continue
        }
      }
      if (out[provider].length) break;
    }
  }

  return out;
}

/**
 * Full Alloy-trusted Model objects for a hosted provider (from pinned Pi data).
 * @param {string} provider
 * @returns {object[]}
 */
export function listAlloyBuiltinModels(provider) {
  const catalog = loadProviderCatalogIds();
  const ids = catalog[provider] || [];
  const models = [];
  for (const id of ids) {
    const model = getAlloyTrustedModel(provider, id);
    if (model) models.push(model);
  }
  return models;
}

/**
 * Wrap a Pi Provider so getModels() always includes the full Alloy builtin catalog
 * for that provider (e.g. openai-codex gpt-5.6-luna/sol/terra, not just a partial
 * session subset).
 *
 * @param {object} provider
 * @param {string} providerId
 */
export function withFullBuiltinModelCatalog(provider, providerId) {
  if (!provider || typeof provider.getModels !== "function") return provider;
  const extras = listAlloyBuiltinModels(providerId);
  if (!extras.length) return provider;
  return {
    ...provider,
    getModels: () => {
      const current = provider.getModels() || [];
      const byId = new Map();
      for (const model of current) {
        if (model?.id) byId.set(model.id, model);
      }
      for (const model of extras) {
        if (model?.id && !byId.has(model.id)) byId.set(model.id, model);
      }
      return [...byId.values()];
    },
  };
}

/**
 * Re-register MVP providers so session modelRegistry exposes the full catalog.
 * Safe to call from session_start and again from /fission setup.
 *
 * @param {{ registerProvider?: Function }} pi
 * @param {{ getProvider?: Function }} [modelRegistry]
 * @returns {{ provider: string, before: number, after: number }[]}
 */
/**
 * Build selectable provider/model routes for setup wizards.
 * Unions session registry models with the full Alloy builtin catalog for MVP
 * providers present in the session (so Codex always lists 5.6-luna/sol/terra).
 *
 * @param {{ getAll?: Function, find?: Function, getProvider?: Function }} modelRegistry
 * @param {string[]} allowedProviders
 * @param {(route: string, registry: unknown) => boolean} isTrustedRoute
 * @returns {string[]}
 */
export function collectSetupModelRoutes(
  modelRegistry,
  allowedProviders = [],
  isTrustedRoute = () => false,
) {
  const allowed = new Set((allowedProviders || []).filter(Boolean));
  const routes = new Set();

  // Session registry first (keep whatever Pi already exposed, including non-catalog ids).
  for (const model of modelRegistry?.getAll?.() || []) {
    if (!model?.provider || !model?.id) continue;
    if (allowed.size && !allowed.has(model.provider)) continue;
    routes.add(`${model.provider}/${model.id}`);
  }

  // Expand MVP hosted catalogs so partial session subsets (e.g. Codex without 5.6-*)
  // still list the full pinned builtin set.
  for (const provider of MVP_CATALOG_PROVIDERS) {
    if (allowed.size && !allowed.has(provider)) continue;
    const present =
      Boolean(modelRegistry?.getProvider?.(provider)) ||
      (modelRegistry?.getAll?.() || []).some((m) => m?.provider === provider);
    if (!present) continue;
    for (const builtin of listAlloyBuiltinModels(provider)) {
      const route = `${provider}/${builtin.id}`;
      const syntheticRegistry = {
        find: (p, id) => {
          if (p === provider && id === builtin.id) return builtin;
          return modelRegistry?.find?.(p, id) ?? null;
        },
      };
      // Prefer trust gate when provided; if no gate, include all builtins.
      if (
        typeof isTrustedRoute !== "function" ||
        isTrustedRoute(route, syntheticRegistry)
      ) {
        routes.add(route);
      }
    }
  }

  return [...routes].sort();
}

export function ensureMvpBuiltinCatalogs(pi, modelRegistry) {
  const report = [];
  if (!pi?.registerProvider || !modelRegistry?.getProvider) return report;
  for (const providerId of MVP_CATALOG_PROVIDERS) {
    const current = modelRegistry.getProvider(providerId);
    if (!current) continue;
    // Defensive: ignore stub registries that return the wrong provider object.
    if (current.id && current.id !== providerId) continue;
    const before =
      typeof current.getModels === "function" ? current.getModels().length : 0;
    const extras = listAlloyBuiltinModels(providerId);
    const missing = extras.filter(
      (model) =>
        !current.getModels?.().some((existing) => existing?.id === model.id),
    );
    if (!missing.length) {
      report.push({ provider: providerId, before, after: before, added: 0 });
      continue;
    }
    // Prefer native Provider object registration (same pattern as Claude Opus 5).
    const patched = withFullBuiltinModelCatalog(current, providerId);
    try {
      if (patched?.id || patched?.name) {
        pi.registerProvider(patched);
      } else {
        pi.registerProvider(providerId, patched);
      }
    } catch {
      // One provider must not block the others.
      report.push({
        provider: providerId,
        before,
        after: before,
        added: 0,
      });
      continue;
    }
    const afterProvider = modelRegistry.getProvider(providerId);
    const after =
      typeof afterProvider?.getModels === "function"
        ? afterProvider.getModels().length
        : before;
    report.push({
      provider: providerId,
      before,
      after,
      added: Math.max(0, after - before),
    });
  }
  return report;
}

/**
 * @param {string} modelRef  provider/id or bare id
 * @param {Record<string, string[]>} [catalog]
 */
export function resolveModelInCatalog(modelRef, catalog = loadProviderCatalogIds()) {
  if (!modelRef) return { ok: false, reason: "empty" };
  const s = String(modelRef);
  let provider = null;
  let id = s;
  if (s.includes("/")) {
    const i = s.indexOf("/");
    provider = s.slice(0, i);
    id = s.slice(i + 1);
  }

  if (provider && catalog[provider]) {
    const hit = catalog[provider].includes(id);
    return {
      ok: hit,
      provider,
      id,
      reason: hit ? "found" : `id not in ${provider} catalog`,
      catalogSize: catalog[provider].length,
    };
  }

  // search all
  for (const [p, ids] of Object.entries(catalog)) {
    if (ids.includes(id)) {
      return { ok: true, provider: p, id, reason: "found", catalogSize: ids.length };
    }
  }
  return {
    ok: false,
    provider,
    id,
    reason: catalog[provider || ""]?.length
      ? "not found"
      : "catalog unavailable",
  };
}

/**
 * Validate Alloy default model refs against catalogs.
 */
export function validateDefaultModels(defaults = CATALOG_DEFAULTS) {
  const catalog = loadProviderCatalogIds();
  const refs = [
    ...defaults.favorites,
    ...Object.values(defaults.profiles),
  ];
  const unique = [...new Set(refs)];
  return unique.map((ref) => ({
    ref,
    ...resolveModelInCatalog(ref, catalog),
  }));
}
