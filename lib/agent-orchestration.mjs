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

function exactFailure(spec, model, reason, rejected = []) {
  const provider = typeof model === "string" && model.includes("/")
    ? model.split("/", 1)[0]
    : null;
  return {
    ok: false,
    spec,
    decision: {
      ok: false,
      role: "review",
      model: null,
      provider: null,
      reason,
      fallbackUsed: false,
      candidates: model ? [model] : [],
      rejected: rejected.length ? rejected : (model ? [{ model, reason }] : []),
      credentialBoundary: "none",
      requestedProvider: provider,
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
  // Always inspect an explicit requested model (e.g. /fusion setup), even when
  // it is not on the role primary/fallback list.
  const inspectList = [
    ...new Set(
      [
        typeof requestedModel === "string" ? requestedModel.trim() : "",
        ...routes,
      ].filter(Boolean),
    ),
  ];
  const inspections = await Promise.all(
    inspectList.map(async (model) => {
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

export async function prepareExactAgentLaunch(input = {}, dependencies = {}) {
  const cwd = input.cwd || process.cwd();
  const deps = {
    loadConfig,
    resolveAgentSpec,
    inspectCandidate: inspectSessionModelCandidate,
    ...dependencies,
  };
  const rawModel = typeof input.model === "string" ? input.model.trim() : "";
  const slash = rawModel.indexOf("/");
  const validRoute =
    slash > 0 &&
    slash < rawModel.length - 1 &&
    !/\s/.test(rawModel.slice(0, slash)) &&
    !/\s/.test(rawModel.slice(slash + 1));
  const requestedSpec = narrowedSpec(deps.resolveAgentSpec, {
    profile: input.profile || "review",
    model: rawModel || null,
    tools: input.tools,
    cwd,
  });
  if (!validRoute) {
    return exactFailure(requestedSpec, rawModel || null, "exact route must be an explicit provider/model");
  }
  const requestedTools = Array.isArray(input.tools)
    ? [...new Set(input.tools.filter((tool) => typeof tool === "string" && tool))]
    : [];
  const admittedTools = Array.isArray(requestedSpec.tools)
    ? [...new Set(requestedSpec.tools)]
    : [];
  if (
    requestedTools.length === 0 ||
    requestedTools.length !== admittedTools.length ||
    requestedTools.some((tool) => !admittedTools.includes(tool))
  ) {
    return exactFailure(
      requestedSpec,
      rawModel,
      "exact launch requires an exact nonempty requested tool set",
    );
  }

  const cfg = deps.loadConfig(cwd);
  if (cfg.orchestration?.enabled !== true) {
    return exactFailure(requestedSpec, rawModel, "exact route requires orchestration to be enabled");
  }
  const maxConcurrency = cfg.orchestration?.maxConcurrency;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    return exactFailure(requestedSpec, rawModel, "invalid orchestration policy");
  }
  const provider = rawModel.slice(0, slash);
  const allowed = Array.isArray(cfg.providers?.allow) ? cfg.providers.allow : [];
  if (!allowed.includes(provider)) {
    return exactFailure(requestedSpec, rawModel, `provider ${provider} is not allowed`);
  }
  const activeChildren = input.activeChildren ?? 0;
  if (!Number.isInteger(activeChildren) || activeChildren < 0) {
    return exactFailure(requestedSpec, rawModel, "invalid orchestration concurrency state");
  }
  if (activeChildren >= maxConcurrency) {
    return exactFailure(requestedSpec, rawModel, `agent concurrency limit reached (${maxConcurrency})`);
  }
  const budget = budgetState(cfg, input.spentCostUsd);
  if (!budget.ok) return exactFailure(requestedSpec, rawModel, "invalid agent budget state");
  if (budget.remaining <= 0) {
    return exactFailure(requestedSpec, rawModel, "agent budget is exhausted");
  }
  const availableSlots = maxConcurrency - activeChildren;
  const budgetUsd = input.partitionBudget === false
    ? budget.remaining
    : budget.remaining / availableSlots;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return exactFailure(requestedSpec, rawModel, "agent budget partition is exhausted");
  }

  let inspected;
  try {
    inspected = await deps.inspectCandidate(rawModel, input.modelRegistry);
  } catch {
    return exactFailure(requestedSpec, rawModel, "model is not available");
  }
  const candidate = inspected?.candidate || {};
  let reason = null;
  if (candidate.model !== rawModel) reason = "inspected candidate does not match exact route";
  else if (candidate.transport !== "builtin" && candidate.transport !== "local") {
    reason = "custom transport is unavailable";
  }
  else if (candidate.available !== true) reason = "model is not available";
  else if (candidate.authenticated !== true) reason = "provider is not authenticated";
  else if (candidate.supportsTools !== true) {
    reason = "model does not support required tools";
  }
  if (reason) return exactFailure(requestedSpec, rawModel, reason);

  const lease = inspected?.lease;
  const credentialProvider = lease?.runtimeCredential?.provider;
  if (lease?.mode !== "runtime-key" || !lease.runtimeCredential) {
    return exactFailure(requestedSpec, rawModel, "runtime credential is unavailable");
  }
  if (credentialProvider !== provider) {
    return exactFailure(requestedSpec, rawModel, "runtime credential provider does not match exact route");
  }
  return {
    ok: true,
    spec: requestedSpec,
    decision: {
      ok: true,
      role: input.requestedRole || "review",
      model: rawModel,
      provider,
      reason: "exact-route",
      fallbackUsed: false,
      candidates: [rawModel],
      rejected: [],
      credentialBoundary: lease.mode,
    },
    credential: publicCredential(lease),
    maxConcurrency,
    budgetUsd,
    budgetLimitUsd: budget.maximum,
  };
}
