/**
 * Resolve and validate model ids against the pinned Pi provider catalogs.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "./pi-package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
          const ids = new Set();
          for (const m of text.matchAll(/id:\s*"([^"]+)"/g)) {
            ids.add(m[1]);
          }
          // also "id": "..."
          for (const m of text.matchAll(/"id"\s*:\s*"([^"]+)"/g)) {
            ids.add(m[1]);
          }
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
