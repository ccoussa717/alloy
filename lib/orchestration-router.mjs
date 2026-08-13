const ROLE_ALIASES = Object.freeze({
  research: "research",
  scout: "research",
  planning: "planning",
  plan: "planning",
  planner: "planning",
  implementation: "implementation",
  implement: "implementation",
  code: "implementation",
  builder: "implementation",
  fixer: "implementation",
  review: "review",
  reviewer: "review",
  general: "general",
  default: "general",
});

const ROLE_PATTERNS = [
  ["review", /\b(review|audit|critique|regression|security check)\b/i],
  ["research", /\b(research|investigate|explore|compare|find out|look up)\b/i],
  ["planning", /\b(plan|planning|architecture|design|spec|proposal|roadmap)\b/i],
  ["implementation", /\b(implement|build|fix|edit|change|code|add|create|refactor)\b/i],
];

const MODEL_ROUTE_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;

function normalizeRole(role) {
  if (role == null) return null;
  return ROLE_ALIASES[String(role).trim().toLowerCase()] || null;
}

export function classifyTaskRole(task, requestedRole = null) {
  if (requestedRole != null) {
    return normalizeRole(requestedRole) || "general";
  }

  const text = typeof task === "string" ? task : "";
  let selected = null;
  let selectedIndex = Infinity;
  for (const [role, pattern] of ROLE_PATTERNS) {
    const index = text.search(pattern);
    if (index >= 0 && index < selectedIndex) {
      selected = role;
      selectedIndex = index;
    }
  }
  return selected || "general";
}

function failure(role, reason, candidates = [], rejected = []) {
  return {
    ok: false,
    role,
    model: null,
    provider: null,
    reason,
    fallbackUsed: false,
    candidates,
    rejected,
  };
}

function orderedRoutes(rolePolicy) {
  const routes = [rolePolicy?.primary, ...(rolePolicy?.fallbacks || [])]
    .filter((model) => typeof model === "string" && model.trim())
    .map((model) => model.trim());
  return [...new Set(routes)];
}

function providerFor(model) {
  if (
    typeof model !== "string" ||
    model.length > 256 ||
    !MODEL_ROUTE_PATTERN.test(model)
  ) {
    return null;
  }
  const separator = model.indexOf("/");
  return model.slice(0, separator);
}

export function validateOrchestrationPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, errors: ["policy must be an object"] };
  }
  if (policy.enabled !== true) {
    errors.push("enabled must be true for routing");
  }
  if (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency < 1) {
    errors.push("maxConcurrency must be a positive integer");
  }
  if (!policy.roles || typeof policy.roles !== "object" || Array.isArray(policy.roles)) {
    errors.push("roles must be an object");
  } else {
    for (const [role, spec] of Object.entries(policy.roles)) {
      if (!normalizeRole(role) || normalizeRole(role) !== role) {
        errors.push(`roles.${role} is not a canonical role`);
        continue;
      }
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        errors.push(`roles.${role} must be an object`);
        continue;
      }
      if (
        spec.primary != null &&
        (typeof spec.primary !== "string" || !providerFor(spec.primary))
      ) {
        errors.push(`roles.${role}.primary must be a provider/model string`);
      }
      if (!Array.isArray(spec.fallbacks)) {
        errors.push(`roles.${role}.fallbacks must be an array`);
      } else if (
        spec.fallbacks.some(
          (model) => typeof model !== "string" || !providerFor(model),
        )
      ) {
        errors.push(`roles.${role}.fallbacks must contain provider/model strings`);
      }
    }
  }
  if (
    policy.mainModel != null &&
    (typeof policy.mainModel !== "string" || !providerFor(policy.mainModel))
  ) {
    errors.push("mainModel must be a provider/model string");
  }
  return { ok: errors.length === 0, errors };
}

function rejectionReason({
  model,
  candidate,
  providerAllow,
  requiresTools,
  remainingBudgetUsd,
}) {
  const provider = providerFor(model);
  if (!provider) return "model route must use provider/model format";
  if (!providerAllow.has(provider)) return "provider is not allowed";
  if (!candidate || candidate.available !== true) return "model is not available";
  if (candidate.transport !== "builtin" && candidate.transport !== "local") {
    return "custom transport is not eligible";
  }
  if (candidate.authenticated !== true) return "provider is not authenticated";
  if (requiresTools && candidate.supportsTools !== true) {
    return "model does not support required tools";
  }
  if (candidate.estimatedCostUsd != null) {
    const estimate = candidate.estimatedCostUsd;
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0) {
      return "estimated cost is invalid";
    }
    if (Number.isFinite(remainingBudgetUsd) && estimate > remainingBudgetUsd) {
      return "estimated cost exceeds remaining budget";
    }
  }
  return null;
}

export function routeAgentTask(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("general", "invalid routing request");
  }
  const {
    task,
    requestedRole = null,
    requestedModel = null,
    policy = {},
    providerAllow = [],
    candidates = [],
    requiresTools = false,
    activeChildren = 0,
    remainingBudgetUsd,
  } = input;
  const role = classifyTaskRole(task, requestedRole);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return failure(role, "invalid orchestration policy: policy must be an object");
  }
  if (policy.enabled === false || policy.enabled == null) {
    return failure(role, "orchestration is disabled");
  }
  if (policy.enabled !== true) {
    return failure(role, "invalid orchestration policy: enabled must be boolean");
  }
  if (requestedRole != null && !normalizeRole(requestedRole)) {
    return failure(role, "unknown orchestration role");
  }
  if (requestedModel != null && typeof requestedModel !== "string") {
    return failure(role, "invalid requested model");
  }
  if (!Array.isArray(providerAllow)) {
    return failure(role, "invalid provider allowlist");
  }
  if (!Array.isArray(candidates)) {
    return failure(role, "invalid model candidates");
  }
  if (!Number.isInteger(activeChildren) || activeChildren < 0) {
    return failure(role, "invalid active child count");
  }
  if (
    typeof remainingBudgetUsd !== "number" ||
    !Number.isFinite(remainingBudgetUsd) ||
    remainingBudgetUsd < 0
  ) {
    return failure(role, "invalid remaining budget");
  }
  const validation = validateOrchestrationPolicy(policy);
  if (!validation.ok) {
    return failure(
      role,
      `invalid orchestration policy: ${validation.errors.join("; ")}`,
    );
  }

  const maxConcurrency = policy.maxConcurrency;
  if (activeChildren >= maxConcurrency) {
    return failure(role, "orchestration concurrency limit reached");
  }
  if (remainingBudgetUsd <= 0) {
    return failure(role, "orchestration budget is exhausted");
  }

  const routes = orderedRoutes(policy.roles?.[role]);
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  // Explicit requested routes (e.g. /fusion setup models) may sit outside the
  // role primary/fallback list; still require eligibility checks below.
  if (!routes.length && !requested) {
    return failure(role, `no models are configured for ${role}`);
  }
  if (requested && !providerFor(requested)) {
    return failure(role, "invalid requested model", routes);
  }

  const selectionOrder = requested
    ? [requested, ...routes.filter((model) => model !== requested)]
    : routes;
  const available = new Map(candidates.map((entry) => [entry?.model, entry]));
  const allowed = new Set(providerAllow);
  const rejected = [];

  for (const model of selectionOrder) {
    const candidate = available.get(model);
    const reason = rejectionReason({
      model,
      candidate,
      providerAllow: allowed,
      requiresTools,
      remainingBudgetUsd,
    });
    if (reason) {
      rejected.push({ model, reason });
      continue;
    }

    const configuredIndex = routes.indexOf(model);
    return {
      ok: true,
      role,
      model,
      provider: providerFor(model),
      reason: requested && model === requested
        ? "requested-model"
        : configuredIndex === 0
          ? "primary"
          : "fallback",
      fallbackUsed: configuredIndex > 0,
      candidates: routes,
      rejected,
    };
  }

  return failure(
    role,
    `no eligible configured model for ${role}`,
    routes,
    rejected,
  );
}
