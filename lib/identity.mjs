/**
 * Alloy-native agent identity (open-source harness; not tied to any fleet bus).
 *
 * Resolution: ALLOY_AGENT_ID env → config.identity.id → "default"
 */

import { hostname } from "node:os";
import { loadGlobalConfig } from "./config.mjs";

/**
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{ id: string, displayName: string | null, org: string | null, source: string }}
 */
export function resolveAgentIdentity(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.config || loadGlobalConfig();
  const fromEnv = typeof env.ALLOY_AGENT_ID === "string" ? env.ALLOY_AGENT_ID.trim() : "";
  if (fromEnv) {
    return {
      id: sanitizeAgentId(fromEnv),
      displayName: cfg.identity?.displayName || null,
      org: cfg.identity?.org || null,
      source: "env",
    };
  }
  const fromCfg =
    typeof cfg.identity?.id === "string" ? cfg.identity.id.trim() : "";
  if (fromCfg) {
    return {
      id: sanitizeAgentId(fromCfg),
      displayName: cfg.identity?.displayName || null,
      org: cfg.identity?.org || null,
      source: "config",
    };
  }
  return {
    id: "default",
    displayName: null,
    org: null,
    source: "default",
  };
}

export function sanitizeAgentId(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "default";
}

export function describeIdentity(identity = resolveAgentIdentity()) {
  const host = (() => {
    try {
      return hostname();
    } catch {
      return "unknown";
    }
  })();
  const name = identity.displayName ? ` (${identity.displayName})` : "";
  const org = identity.org ? ` org=${identity.org}` : "";
  return `agent=${identity.id}${name}${org} host=${host} source=${identity.source}`;
}
