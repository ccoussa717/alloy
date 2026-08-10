/**
 * Local policy packs — model-agnostic presets (no remote control plane).
 * Packs set posture (sandbox force, budgets, fission counts), not model routes.
 */

export const POLICY_PACKS = Object.freeze({
  ship: {
    id: "ship",
    label: "Ship",
    description:
      "Ship posture: worktrees on, implement inherits session approvals (not forced sandbox), fission severity high.",
    apply: {
      auto: {
        useWorktree: true,
        forceSandbox: false,
      },
      fission: {
        blockingSeverity: "high",
        defaultReviewers: 3,
        maxReviewers: 5,
      },
    },
  },
  incident: {
    id: "incident",
    label: "Incident",
    description:
      "Review-first: force sandbox implement, ask-all session, high fission severity.",
    apply: {
      auto: {
        useWorktree: true,
        forceSandbox: true,
      },
      fission: {
        blockingSeverity: "high",
        defaultReviewers: 3,
        maxReviewers: 5,
      },
      defaultMode: "review",
      permissionProfile: "ask-all",
    },
  },
  economy: {
    id: "economy",
    label: "Economy",
    description:
      "Lower cost ceilings, fewer reviewers, sandbox implement forced.",
    apply: {
      budgets: {
        maxCostUsd: 10,
        maxFixRounds: 1,
      },
      orchestration: {
        maxConcurrency: 2,
      },
      auto: {
        useWorktree: true,
        forceSandbox: true,
      },
      fission: {
        defaultReviewers: 2,
        maxReviewers: 3,
        blockingSeverity: "high",
      },
    },
  },
});

export function listPolicyPacks() {
  return Object.values(POLICY_PACKS).map((pack) => ({
    id: pack.id,
    label: pack.label,
    description: pack.description,
  }));
}

export function getPolicyPack(id) {
  const key = String(id || "").toLowerCase().trim();
  return POLICY_PACKS[key] || null;
}

/**
 * Deep-merge pack.apply onto a config-shaped object (does not set models).
 */
export function mergePackOntoConfig(config, pack) {
  if (!pack?.apply) return config;
  const out = structuredClone
    ? structuredClone(config)
    : JSON.parse(JSON.stringify(config));
  const apply = pack.apply;
  if (apply.defaultMode) out.defaultMode = apply.defaultMode;
  if (apply.permissionProfile) out.permissionProfile = apply.permissionProfile;
  if (apply.auto) out.auto = { ...(out.auto || {}), ...apply.auto };
  if (apply.budgets) out.budgets = { ...(out.budgets || {}), ...apply.budgets };
  if (apply.orchestration) {
    out.orchestration = {
      ...(out.orchestration || {}),
      ...apply.orchestration,
      roles: {
        ...(out.orchestration?.roles || {}),
        ...(apply.orchestration.roles || {}),
      },
    };
  }
  // Intentionally ignore apply.roles — packs are model-agnostic
  if (apply.fission) {
    const { models, judgeModel, modelFamilies, roles, ...rest } = apply.fission;
    out.fission = { ...(out.fission || {}), ...rest };
    void models;
    void judgeModel;
    void modelFamilies;
    void roles;
  }
  return out;
}
