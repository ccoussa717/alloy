/**
 * Alloy agent id for run-index attribution (open-source harness).
 *
 * Occam: env only — ALLOY_AGENT_ID. No config.identity block required.
 * Resolution: ALLOY_AGENT_ID → "default"
 */

import { hostname } from "node:os";

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.config] ignored (legacy callers)
 * @returns {{ id: string, displayName: string | null, org: string | null, source: string }}
 */
export function resolveAgentIdentity(opts = {}) {
  const env = opts.env || process.env;
  const fromEnv = typeof env.ALLOY_AGENT_ID === "string" ? env.ALLOY_AGENT_ID.trim() : "";
  if (fromEnv) {
    return {
      id: sanitizeAgentId(fromEnv),
      displayName: null,
      org: null,
      source: "env",
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
  return `agent=${identity.id} host=${host} source=${identity.source}`;
}
