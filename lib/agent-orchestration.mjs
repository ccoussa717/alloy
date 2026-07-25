import { resolveAgentSpec } from "./agent-profiles.mjs";
import { loadConfig } from "./config.mjs";
import { inspectSessionModelCandidate } from "./credential-broker.mjs";
import { classifyTaskRole, routeAgentTask } from "./orchestration-router.mjs";

const PROFILE_ROLES = Object.freeze({
  research: "research",
  scout: "research",
  plan: "planning",
  planner: "planning",
  code: "implementation",
  builder: "implementation",
  fixer: "implementation",
  review: "review",
  reviewer: "review",
  default: "general",
});

const ROLE_PROFILES = Object.freeze({
  research: "research",
  planning: "plan",
  implementation: "code",
  review: "review",
  general: "default",
});

export function routingFailureCode(decision) {
  const reason = String(decision?.reason || "").toLowerCase();
  const rejected = (decision?.rejected || [])
    .map((item) => String(item?.reason || "").toLowerCase())
    .join(" ");
  if (reason.includes("concurrency")) return "concurrency_limit";
  if (reason.includes("invalid agent budget state")) {
    return "budget_usage_unavailable";
  }
  if (reason.includes("budget")) return "budget_exceeded";
  if (reason.includes("invalid orchestration") || reason.includes("invalid policy")) {
    return "invalid_orchestration_policy";
  }
  if (rejected.includes("custom transport")) return "custom_transport_unavailable";
  if (
    (reason.includes("provider") && reason.includes("unavailable")) ||
    reason.includes("no eligible configured model") ||
    rejected.includes("provider is not authenticated") ||
    rejected.includes("model is not available")
  ) {
    return "provider_unavailable";
  }
  return "routing_failed";
}

function configuredRoutes(policy, role) {
  const spec = policy?.roles?.[role];
  return [...new Set([spec?.primary, ...(spec?.fallbacks || [])].filter(Boolean))];
}

function publicCredential(lease) {
  return {
    mode: lease?.mode || "none",
    runtimeCredential: lease?.runtimeCredential || null,
  };
}

function narrowedSpec(resolveSpec, input) {
  const base = resolveSpec({ ...input, tools: undefined });
  if (!Array.isArray(input.tools)) return base;
  const allowed = new Set(base.tools || []);
  return {
    ...base,
    tools: [...new Set(input.tools.filter((tool) => allowed.has(tool)))],
  };
}

function budgetState(cfg, spentCostUsd) {
  const maximum = cfg.budgets?.maxCostUsd;
  const spent = spentCostUsd ?? 0;
  if (
    typeof maximum !== "number" ||
    !Number.isFinite(maximum) ||
    maximum < 0 ||
    typeof spent !== "number" ||
    !Number.isFinite(spent) ||
    spent < 0
  ) {
    return { ok: false, remaining: null };
  }
  return {
    ok: true,
    maximum,
    remaining: Math.max(0, maximum - spent),
  };
}

function budgetFailure(spec, reason) {
  return {
    ok: false,
    spec,
    decision: {
      ok: false,
      role: PROFILE_ROLES[spec.profile] || "general",
      model: null,
      provider: null,
      reason,
      fallbackUsed: false,
      candidates: [],
      rejected: [],
      credentialBoundary: "none",
    },
    credential: null,
  };
}

function legacyDecision(model, profile, credentialBoundary = "none") {
  const provider = typeof model === "string" ? model.split("/", 1)[0] : null;
  return {
    ok: true,
    role: PROFILE_ROLES[profile] || "general",
    model: model || null,
    provider,
    reason: "explicit-legacy-route",
    fallbackUsed: false,
    candidates: model ? [model] : [],
    rejected: [],
    credentialBoundary,
  };
}

export async function prepareAgentLaunch(input = {}, dependencies = {}) {
  const cwd = input.cwd || process.cwd();
  const deps = {
    loadConfig,
    resolveAgentSpec,
    inspectCandidate: inspectSessionModelCandidate,
    ...dependencies,
  };
  const cfg = deps.loadConfig(cwd);
  const requestedSpec = narrowedSpec(deps.resolveAgentSpec, {
    profile: input.profile,
    model: input.model,
    tools: input.tools,
    cwd,
  });
  const budget = budgetState(cfg, input.spentCostUsd);
  if (!budget.ok) return budgetFailure(requestedSpec, "invalid agent budget state");
  if (budget.remaining <= 0) {
    return budgetFailure(requestedSpec, "agent budget is exhausted");
  }

  if (cfg.orchestration?.enabled !== true && cfg.orchestration?.enabled !== false) {
    return budgetFailure(requestedSpec, "invalid orchestration policy");
  }

  if (cfg.orchestration.enabled === false) {
    if (!requestedSpec.model) {
      return {
        ok: true,
        spec: requestedSpec,
        decision: legacyDecision(null, requestedSpec.profile),
        credential: { mode: "none", runtimeCredential: null },
        maxConcurrency: null,
        budgetUsd: budget.remaining,
        budgetLimitUsd: budget.maximum,
      };
    }
    const inspected = await deps.inspectCandidate(
      requestedSpec.model,
      input.modelRegistry,
    );
    if (inspected.lease?.mode !== "runtime-key") {
      return {
        ok: false,
        spec: requestedSpec,
        decision: {
          ...legacyDecision(requestedSpec.model, requestedSpec.profile),
          ok: false,
          reason: "provider unavailable for explicit legacy route",
        },
        credential: null,
      };
    }
    return {
      ok: true,
      spec: requestedSpec,
        decision: legacyDecision(
          requestedSpec.model,
          requestedSpec.profile,
          inspected.lease.mode,
        ),
      credential: publicCredential(inspected.lease),
      maxConcurrency: null,
      budgetUsd: budget.remaining,
      budgetLimitUsd: budget.maximum,
    };
  }

  const requestedRole = input.requestedRole ?? (input.profile
    ? PROFILE_ROLES[String(input.profile).toLowerCase()]
    : null);
  const role = classifyTaskRole(input.task, requestedRole);
  const requestedModel = input.model || (
    input.requestedRole == null && input.profile ? requestedSpec.model : null
  );
  const routeInput = {
    task: input.task,
    requestedRole,
    requestedModel,
    policy: cfg.orchestration,
    providerAllow: cfg.providers?.allow || [],
    requiresTools: Boolean(requestedSpec.tools?.length),
    activeChildren: input.activeChildren,
    remainingBudgetUsd: budget.remaining,
  };
  const preflight = routeAgentTask({ ...routeInput, candidates: [] });
  const onlyNeedsCandidateInspection =
    !preflight.ok &&
    preflight.rejected.length > 0 &&
    preflight.rejected.every((item) => item.reason === "model is not available");
  if (!onlyNeedsCandidateInspection) {
    return {
      ok: false,
      spec: requestedSpec,
      decision: preflight,
      credential: null,
    };
  }

  const routes = configuredRoutes(cfg.orchestration, role);
  const inspections = await Promise.all(
    routes.map(async (model) => {
      try {
        return await deps.inspectCandidate(model, input.modelRegistry);
      } catch {
        return {
          candidate: {
            model,
            available: false,
            authenticated: false,
            transport: "builtin",
            supportsTools: false,
          },
          lease: null,
        };
      }
    }),
  );
  const decision = routeAgentTask({
    ...routeInput,
    candidates: inspections.map((item) => item.candidate),
  });
  if (!decision.ok) {
    return { ok: false, spec: requestedSpec, decision, credential: null };
  }

  const selected = inspections.find(
    (item) => item.candidate.model === decision.model,
  );
  if (selected?.lease?.mode !== "runtime-key") {
    return {
      ok: false,
      spec: requestedSpec,
      decision: {
        ...decision,
        ok: false,
        model: null,
        provider: null,
        reason: "selected provider credential is unavailable",
      },
      credential: null,
    };
  }

  const profile = input.profile || ROLE_PROFILES[decision.role] || "default";
  const spec = narrowedSpec(deps.resolveAgentSpec, {
    profile,
    model: decision.model,
    tools: input.tools,
    cwd,
  });
  return {
    ok: true,
    spec,
    decision: {
      ...decision,
      credentialBoundary: selected.lease.mode,
    },
    credential: publicCredential(selected.lease),
    maxConcurrency: cfg.orchestration.maxConcurrency,
    budgetUsd: input.partitionBudget === false
      ? budget.remaining
      : budget.remaining /
        (cfg.orchestration.maxConcurrency - (input.activeChildren || 0)),
    budgetLimitUsd: budget.maximum,
  };
}
