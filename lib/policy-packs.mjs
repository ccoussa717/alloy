/**
 * Local policy packs (open-source presets — no remote/org control plane).
 */

export const POLICY_PACKS = Object.freeze({
  ship: {
    id: "ship",
    label: "Ship",
    description:
      "Trusted monorepo defaults: multi-model fission severity high, implement with ask-dangerous, recommended auto models.",
    apply: {
      auto: {
        useWorktree: true,
        implementPermissionProfile: "ask-dangerous",
      },
      fission: {
        blockingSeverity: "high",
        defaultReviewers: 3,
        maxReviewers: 5,
      },
      roles: {
        scout: { model: "xai/grok-4.5" },
        planner: { model: "anthropic/claude-sonnet-4-6" },
        builder: { model: "openai-codex/gpt-5.4" },
        fixer: { model: "openai-codex/gpt-5.4" },
        reviewer: { model: "anthropic/claude-opus-4-6" },
      },
    },
  },
  incident: {
    id: "incident",
    label: "Incident",
    description:
      "Review-first: high fission severity, sandbox implement, prefer careful models.",
    apply: {
      auto: {
        useWorktree: true,
        implementPermissionProfile: "sandbox",
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
      "Lower concurrency and cost ceilings; prefer fewer fission reviewers.",
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
        implementPermissionProfile: "sandbox",
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
 * Deep-merge pack.apply onto a config-shaped object (does not validate fission models).
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
  if (apply.roles) {
    out.roles = { ...(out.roles || {}) };
    for (const [name, spec] of Object.entries(apply.roles)) {
      out.roles[name] = { ...(out.roles[name] || {}), ...spec };
    }
  }
  if (apply.fission) {
    // Only merge non-route fields by default so packs don't wipe operator models
    const { models, judgeModel, modelFamilies, roles, ...rest } = apply.fission;
    out.fission = { ...(out.fission || {}), ...rest };
    void models;
    void judgeModel;
    void modelFamilies;
    void roles;
  }
  return out;
}
