/**
 * Resolve implement-phase permission profile for /auto and /forge auto phase.
 * Default: sandbox (B). No silent downgrade if Docker is unavailable.
 */

import { diagnoseDocker } from "./docker-sandbox.mjs";

const IMPLEMENT_PROFILES = new Set([
  "ask-all",
  "ask-some",
  "ask-dangerous",
  "ask-none",
  "sandbox",
]);

/**
 * @param {object} cfg
 * @param {object} [opts]
 * @returns {{ profile: string, sandbox: boolean, source: string }}
 */
export function resolveImplementPermissionProfile(cfg = {}, opts = {}) {
  const env = opts.env || process.env;
  const fromEnv =
    typeof env.ALLOY_IMPLEMENT_PROFILE === "string"
      ? env.ALLOY_IMPLEMENT_PROFILE.trim()
      : "";
  const fromOpts =
    typeof opts.implementPermissionProfile === "string"
      ? opts.implementPermissionProfile.trim()
      : "";
  const fromCfg =
    typeof cfg.auto?.implementPermissionProfile === "string"
      ? cfg.auto.implementPermissionProfile.trim()
      : "";

  let profile = fromOpts || fromEnv || fromCfg || "sandbox";
  if (!IMPLEMENT_PROFILES.has(profile)) {
    throw new Error(
      `Invalid implement permission profile "${profile}". Use: ${[...IMPLEMENT_PROFILES].join(", ")}`,
    );
  }

  const source = fromOpts
    ? "opts"
    : fromEnv
      ? "env"
      : fromCfg
        ? "config"
        : "default";

  return {
    profile,
    sandbox: profile === "sandbox",
    source,
  };
}

/**
 * @param {object} resolved from resolveImplementPermissionProfile
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function assertImplementProfileReady(resolved) {
  if (!resolved?.sandbox) return { ok: true };
  const status = diagnoseDocker();
  if (!status?.docker || !status?.daemon) {
    return {
      ok: false,
      error:
        "Implement profile is sandbox but Docker is unavailable. " +
        "Start Docker, or set auto.implementPermissionProfile / ALLOY_IMPLEMENT_PROFILE " +
        "to ask-dangerous or ask-all (no silent downgrade).",
    };
  }
  return { ok: true };
}
