/**
 * Predefined Fission reviewer roles (viewpoints).
 * Operators pick these in /fission setup; each slot pairs a role with a model.
 */

/**
 * @typedef {{ id: string, label: string, brief: string }} FissionRoleDef
 */

/** @type {readonly FissionRoleDef[]} */
export const FISSION_ROLE_CATALOG = Object.freeze([
  {
    id: "security_trust_boundaries",
    label: "Security & trust boundaries",
    brief:
      "Authn/authz, secrets, injection, SSRF, path traversal, trust-boundary violations, data exposure.",
  },
  {
    id: "adversarial_code_review",
    label: "Adversarial code review",
    brief:
      "Assume the author is wrong. Hunt edge cases, races, silent failures, API misuse, and incomplete error handling.",
  },
  {
    id: "cynical_customer",
    label: "Cynical customer",
    brief:
      "Review as a skeptical buyer/operator. Broken promises, confusing UX, footguns, missing recovery paths, production pain.",
  },
  {
    id: "correctness_regressions",
    label: "Correctness & regressions",
    brief:
      "Behavioral correctness vs intent, off-by-one, state machine bugs, and regressions against prior behavior.",
  },
  {
    id: "architecture_failure_handling",
    label: "Architecture & failure handling",
    brief:
      "Layering, coupling, failure modes, retries, timeouts, idempotency, and blast radius of the change.",
  },
  {
    id: "test_quality_spec_coverage",
    label: "Test quality & spec coverage",
    brief:
      "Missing tests for the change, weak assertions, flaky patterns, and gaps between claimed behavior and coverage.",
  },
  {
    id: "performance_concurrency_resources",
    label: "Performance & concurrency",
    brief:
      "Hot paths, N+1, unbounded work, lock contention, memory growth, and resource leaks.",
  },
  {
    id: "privacy_data_handling",
    label: "Privacy & data handling",
    brief:
      "PII logging, retention, over-collection, cross-tenant leakage, and unsafe analytics or telemetry.",
  },
  {
    id: "ops_reliability",
    label: "Ops & reliability",
    brief:
      "Deploy risk, observability, rollback, config flags, migration safety, and runbook gaps.",
  },
  {
    id: "general_adversarial",
    label: "General adversarial",
    brief:
      "Broad hostile review: anything that can break, confuse, or be abused in production.",
  },
]);

export const FISSION_ROLE_IDS = Object.freeze(
  FISSION_ROLE_CATALOG.map((role) => role.id),
);

const BY_ID = new Map(FISSION_ROLE_CATALOG.map((role) => [role.id, role]));

/** Default packs when setup has not chosen roles (legacy index-aligned specialties). */
export const FISSION_DEFAULT_ROLE_PACKS = Object.freeze({
  1: Object.freeze(["general_adversarial"]),
  2: Object.freeze(["correctness_regressions", "security_trust_boundaries"]),
  3: Object.freeze([
    "correctness_regressions",
    "security_trust_boundaries",
    "architecture_failure_handling",
  ]),
  4: Object.freeze([
    "correctness_regressions",
    "security_trust_boundaries",
    "architecture_failure_handling",
    "test_quality_spec_coverage",
  ]),
  5: Object.freeze([
    "correctness_regressions",
    "security_trust_boundaries",
    "architecture_failure_handling",
    "test_quality_spec_coverage",
    "performance_concurrency_resources",
  ]),
});

/** @deprecated Prefer FISSION_DEFAULT_ROLE_PACKS; kept for existing imports. */
export const FISSION_ROLES = FISSION_DEFAULT_ROLE_PACKS;

export function isFissionRoleId(id) {
  return typeof id === "string" && BY_ID.has(id);
}

export function getFissionRole(id) {
  return BY_ID.get(id) || null;
}

export function formatFissionRoleLabel(roleId) {
  if (typeof roleId !== "string" || !roleId) return "Reviewer";
  return BY_ID.get(roleId)?.label || roleId.replace(/_/g, " ");
}

export function fissionRoleBrief(roleId) {
  return BY_ID.get(roleId)?.brief || "";
}

/**
 * Roles for a run of `count` reviewers: configured slots if present, else defaults.
 * @param {object} cfg
 * @param {number} count
 * @returns {string[]}
 */
export function resolveFissionRoles(cfg, count) {
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error("reviewer_limit");
  }
  const configured = Array.isArray(cfg?.fission?.roles) ? cfg.fission.roles : [];
  if (configured.length >= count) {
    const roles = [];
    for (let i = 0; i < count; i++) {
      const id = configured[i];
      if (!isFissionRoleId(id)) throw new Error("reviewer_roles");
      if (roles.includes(id)) throw new Error("reviewer_roles");
      roles.push(id);
    }
    return roles;
  }
  const pack = FISSION_DEFAULT_ROLE_PACKS[count];
  if (!pack) throw new Error("reviewer_limit");
  return [...pack];
}

/** Labels for setup UI select (stable order = catalog order). */
export function fissionRoleSelectOptions() {
  return FISSION_ROLE_CATALOG.map((role) => role.label);
}

export function fissionRoleIdFromLabel(label) {
  const hit = FISSION_ROLE_CATALOG.find((role) => role.label === label);
  return hit?.id || null;
}
