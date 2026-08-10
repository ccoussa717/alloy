/**
 * Implement-phase permission for /auto and /forge builder+fixer children.
 *
 * Occam rule (1.0.1+):
 *   implement uses the *session* approval profile by default
 *   optional auto.forceSandbox → always sandbox (fail closed if Docker missing)
 *
 * Legacy still honored:
 *   opts.implementPermissionProfile
 *   ALLOY_IMPLEMENT_PROFILE
 *   auto.implementPermissionProfile
 */

import { diagnoseDocker } from "./docker-sandbox.mjs";
import { normalizePermissionId } from "./permissions.mjs";

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
 * @returns {{ profile: string, sandbox: boolean, source: string, forceSandbox: boolean }}
 */
export function resolveImplementPermissionProfile(cfg = {}, opts = {}) {
  const env = opts.env || process.env;

  const fromOpts =
    typeof opts.implementPermissionProfile === "string"
      ? opts.implementPermissionProfile.trim()
      : "";
  const fromEnv =
    typeof env.ALLOY_IMPLEMENT_PROFILE === "string"
      ? env.ALLOY_IMPLEMENT_PROFILE.trim()
      : "";
  const fromLegacyCfg =
    typeof cfg.auto?.implementPermissionProfile === "string"
      ? cfg.auto.implementPermissionProfile.trim()
      : "";

  const forceSandbox =
    opts.forceSandbox === true ||
    cfg.auto?.forceSandbox === true ||
    fromOpts === "sandbox" ||
    fromEnv === "sandbox" ||
    fromLegacyCfg === "sandbox";

  if (forceSandbox && !fromOpts && !fromEnv && !fromLegacyCfg) {
    return {
      profile: "sandbox",
      sandbox: true,
      source: opts.forceSandbox === true ? "opts.forceSandbox" : "config.forceSandbox",
      forceSandbox: true,
    };
  }

  // Explicit override (opts > env > legacy config field)
  let profile = fromOpts || fromEnv || fromLegacyCfg || "";
  let source = fromOpts
    ? "opts"
    : fromEnv
      ? "env"
      : fromLegacyCfg
        ? "config.legacy"
        : "";

  if (!profile) {
    // Inherit session permission profile
    const session =
      opts.permissionProfile ||
      opts.parentPermissionProfile ||
      cfg.permissionProfile ||
      "ask-dangerous";
    const normalized = normalizePermissionId(session) || String(session).trim();
    profile = IMPLEMENT_PROFILES.has(normalized) ? normalized : "ask-dangerous";
    source = "session";
  }

  if (!IMPLEMENT_PROFILES.has(profile)) {
    throw new Error(
      `Invalid implement permission profile "${profile}". Use: ${[...IMPLEMENT_PROFILES].join(", ")}`,
    );
  }

  if (forceSandbox && profile !== "sandbox" && !fromOpts && !fromEnv) {
    // forceSandbox wins over inherited session unless explicit override
    return {
      profile: "sandbox",
      sandbox: true,
      source: "forceSandbox",
      forceSandbox: true,
    };
  }

  return {
    profile,
    sandbox: profile === "sandbox",
    source: source || "session",
    forceSandbox: profile === "sandbox" && (forceSandbox || source === "session"),
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
        "Implement needs Docker sandbox but Docker is unavailable. " +
        "Start Docker, or turn off auto.forceSandbox / ALLOY_IMPLEMENT_PROFILE=sandbox " +
        "so implement inherits your session approvals (no silent host downgrade from sandbox).",
    };
  }
  return { ok: true };
}
