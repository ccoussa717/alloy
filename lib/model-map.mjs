/**
 * One model map for Alloy children.
 *
 * Canonical store: config.profiles.<name>.model (tools/prompts live here too).
 * Auto shortcuts:  config.roles.<autoRole>.model (optional override).
 * Legacy:          config.orchestration.roles.<canonical>.primary
 *
 * Auto role → profile:
 *   scout → research, planner → plan, builder/fixer → code, reviewer → review
 */

export const AUTO_ROLE_TO_PROFILE = Object.freeze({
  scout: "research",
  planner: "plan",
  builder: "code",
  fixer: "code",
  reviewer: "review",
});

export const PROFILE_TO_ORCH_ROLE = Object.freeze({
  research: "research",
  plan: "planning",
  code: "implementation",
  review: "review",
  default: "general",
});

export const AUTO_ROLE_NAMES = Object.freeze([
  "scout",
  "planner",
  "builder",
  "fixer",
  "reviewer",
]);

/**
 * Resolve model for an auto pipeline role (scout/planner/…).
 * Priority: explicit roles.* → profiles[mapped] → orchestration.roles primary.
 * @param {object} cfg
 * @param {string} autoRole
 * @returns {string | null}
 */
export function resolveAutoRoleModel(cfg = {}, autoRole) {
  const role = String(autoRole || "").toLowerCase().trim();
  if (!role) return null;

  const fromRoles = cfg.roles?.[role]?.model;
  if (typeof fromRoles === "string" && fromRoles.trim()) {
    return fromRoles.trim();
  }

  const profileName = AUTO_ROLE_TO_PROFILE[role] || role;
  const fromProfile = cfg.profiles?.[profileName]?.model;
  if (typeof fromProfile === "string" && fromProfile.trim()) {
    return fromProfile.trim();
  }

  // fixer falls back to builder path (code profile already tried)
  if (role === "fixer") {
    const builderRole = cfg.roles?.builder?.model;
    if (typeof builderRole === "string" && builderRole.trim()) {
      return builderRole.trim();
    }
  }

  const orchKey = PROFILE_TO_ORCH_ROLE[profileName] || "general";
  const primary = cfg.orchestration?.roles?.[orchKey]?.primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }

  return null;
}

/**
 * All auto role models for a run.
 * @param {object} cfg
 * @param {object} [overrides] optional per-role model strings
 */
export function resolveAutoRoleModels(cfg = {}, overrides = {}) {
  const out = {};
  for (const role of AUTO_ROLE_NAMES) {
    const o = overrides?.[role];
    out[role] =
      typeof o === "string" && o.trim()
        ? o.trim()
        : resolveAutoRoleModel(cfg, role);
  }
  return out;
}

/**
 * When saving auto roles, also write models onto the canonical profiles map
 * so /profiles and /agent see the same routes.
 * @param {object} profiles existing profiles object
 * @param {Record<string, { model?: string|null }>} rolesPatch
 */
export function applyAutoRolesToProfiles(profiles = {}, rolesPatch = {}) {
  const next = { ...profiles };
  for (const [role, spec] of Object.entries(rolesPatch || {})) {
    const profileName = AUTO_ROLE_TO_PROFILE[role];
    if (!profileName) continue;
    const model = spec?.model;
    if (model == null || model === "") continue;
    next[profileName] = {
      ...(next[profileName] || {}),
      model,
    };
  }
  return next;
}

/**
 * Soft-migrate orchestration.roles primary → profiles when profile model empty.
 * Does not write disk; pure config transform for load-time view.
 * @param {object} cfg
 */
export function withUnifiedModelMap(cfg = {}) {
  const profiles = { ...(cfg.profiles || {}) };
  let changed = false;

  for (const [autoRole, profileName] of Object.entries(AUTO_ROLE_TO_PROFILE)) {
    const roleModel = cfg.roles?.[autoRole]?.model;
    if (typeof roleModel === "string" && roleModel.trim()) {
      if (!profiles[profileName]?.model) {
        profiles[profileName] = {
          ...(profiles[profileName] || {}),
          model: roleModel.trim(),
        };
        changed = true;
      }
    }
  }

  const orch = cfg.orchestration?.roles || {};
  for (const [profileName, orchKey] of Object.entries(PROFILE_TO_ORCH_ROLE)) {
    const primary = orch[orchKey]?.primary;
    if (typeof primary === "string" && primary.trim() && !profiles[profileName]?.model) {
      profiles[profileName] = {
        ...(profiles[profileName] || {}),
        model: primary.trim(),
      };
      changed = true;
    }
  }

  if (!changed) return cfg;
  return { ...cfg, profiles };
}
