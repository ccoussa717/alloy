/**
 * Architect-builder fusion: two independent read-only proposals followed by
 * one attributed synthesis.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunDir } from "./auto-workflow.mjs";
import { runChildAgent } from "./child-runner.mjs";
import { loadConfig } from "./config.mjs";
import { loadCredentialLeaseForModels } from "./credential-broker.mjs";
import { withHonesty } from "./honesty.mjs";
import {
  createPanelState,
  upsertAgent,
  setPhase,
  renderPanelLines,
} from "./agent-panel.mjs";

function honestyFactsForModel(model, role) {
  let provider = null;
  let modelId = model || null;
  if (model && String(model).includes("/")) {
    const [p, ...rest] = String(model).split("/");
    provider = p;
    modelId = rest.join("/") || model;
  }
  return { provider, modelId, role };
}

const READ_TOOLS = ["read", "grep", "find", "ls"];
export const FUSION_EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const FUSION_ARGUMENTS = [
  {
    value: "setup",
    label: "setup",
    description: "Configure role models and effort",
  },
  {
    value: "status",
    label: "status",
    description: "Show effective Fusion settings",
  },
  { value: "help", label: "help", description: "Show Fusion usage" },
];

const FUSION_PROVIDER_LABELS = new Map([
  ["anthropic", "Anthropic"],
  ["openai-codex", "Codex"],
  ["openai", "OpenAI"],
  ["xai", "xAI"],
]);

function formatProviderLabel(provider) {
  const known = FUSION_PROVIDER_LABELS.get(provider);
  if (known) return known;
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "ai"
        ? "AI"
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

export function groupFusionModelRoutes(routes = [], allowedProviders = []) {
  const allowed = new Set(allowedProviders.filter(Boolean));
  const grouped = new Map();

  for (const rawRoute of routes) {
    const route = typeof rawRoute === "string" ? rawRoute.trim() : "";
    const separator = route.indexOf("/");
    if (separator <= 0 || separator === route.length - 1) continue;
    const provider = route.slice(0, separator);
    const model = route.slice(separator + 1);
    if (allowed.size && !allowed.has(provider)) continue;
    if (!grouped.has(provider)) grouped.set(provider, new Set());
    grouped.get(provider).add(model);
  }

  const providerOrder = [...FUSION_PROVIDER_LABELS.keys()];
  const groups = [...grouped.entries()]
    .map(([id, models]) => ({
      id,
      label: formatProviderLabel(id),
      models: [...models].sort(),
    }))
    .sort((left, right) => {
      const leftRank = providerOrder.indexOf(left.id);
      const rightRank = providerOrder.indexOf(right.id);
      if (leftRank !== -1 || rightRank !== -1) {
        if (leftRank === -1) return 1;
        if (rightRank === -1) return -1;
        return leftRank - rightRank;
      }
      return left.label.localeCompare(right.label);
    });

  const labelCounts = new Map();
  for (const group of groups) {
    labelCounts.set(group.label, (labelCounts.get(group.label) || 0) + 1);
  }
  return groups.map((group) => ({
    ...group,
    label:
      labelCounts.get(group.label) === 1
        ? group.label
        : `${group.label} (${group.id})`,
  }));
}

export function getFusionArgumentCompletions(prefix = "") {
  const raw = String(prefix).trimStart().toLowerCase();
  if (raw.includes(" ")) return null;
  const matches = FUSION_ARGUMENTS.filter((item) => item.value.startsWith(raw));
  return matches.length ? matches : null;
}

export function resolveFusionRoleEfforts(cfg) {
  const fusion = cfg.fusion || {};
  const resolved = {};
  for (const role of ["architect", "builder", "synthesizer"]) {
    const value = fusion[`${role}Effort`];
    if (value == null || value === "") {
      resolved[role] = null;
      continue;
    }
    const normalized = String(value).toLowerCase();
    if (!FUSION_EFFORT_LEVELS.includes(normalized)) {
      throw new Error(`fusion ${role} has invalid effort level: ${value}`);
    }
    resolved[role] = normalized;
  }
  return resolved;
}

function save(runDir, name, data) {
  const path = join(runDir, name);
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return path;
}

function appendEvent(runDir, event) {
  const path = join(runDir, "events.jsonl");
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, prev + line, "utf8");
}

/** Resolve legacy fusion worker lists for persisted pre-architect configurations. */
export function resolveFusionModels(cfg, count = 2) {
  const fromCfg = (cfg.fusion?.models || []).filter(Boolean);
  if (fromCfg.length >= 2) return fromCfg.slice(0, Math.max(count, fromCfg.length));
  const fav = (cfg.providers?.favorites || []).filter(Boolean);
  const models = [...fromCfg, ...fav].filter(Boolean);
  // unique preserve order
  const uniq = [];
  for (const m of models) {
    if (!uniq.includes(m)) uniq.push(m);
  }
  while (uniq.length < count) uniq.push(null);
  return uniq.slice(0, Math.max(2, count));
}

function assertAllowedModel(model, allowed, role) {
  if (!model || !String(model).includes("/")) {
    throw new Error(`fusion ${role} model must be an explicit provider/model route`);
  }
  const provider = String(model).split("/", 1)[0];
  if (allowed.length && !allowed.includes(provider)) {
    throw new Error(`fusion ${role} provider ${provider} is not allowed`);
  }
  return String(model);
}

/** Resolve configured routes and fallbacks without enforcing validity. */
export function getFusionRoleModelDefaults(cfg) {
  const fusion = cfg.fusion || {};
  const legacy = (fusion.models || []).filter(Boolean);
  const favorites = (cfg.providers?.favorites || []).filter(Boolean);
  const architect =
    fusion.architectModel || legacy[0] || cfg.roles?.planner?.model || favorites[0];
  const builder =
    fusion.builderModel ||
    legacy[1] ||
    cfg.roles?.builder?.model ||
    favorites.find((model) => model !== architect);
  const synthesizer =
    fusion.synthesizerModel ||
    fusion.mergerModel ||
    cfg.roles?.reviewer?.model ||
    architect;
  return { architect, builder, synthesizer };
}

/** Resolve the three explicit model routes used by architect-builder fusion. */
export function resolveFusionRoleModels(cfg) {
  const defaults = getFusionRoleModelDefaults(cfg);
  const allowed = (cfg.providers?.allow || []).filter(Boolean);
  const resolved = {
    architect: assertAllowedModel(defaults.architect, allowed, "architect"),
    builder: assertAllowedModel(defaults.builder, allowed, "builder"),
    synthesizer: assertAllowedModel(
      defaults.synthesizer,
      allowed,
      "synthesizer",
    ),
  };
  if (resolved.architect === resolved.builder) {
    throw new Error("fusion architect and builder must use distinct models");
  }
  return resolved;
}

const PROPOSAL_SECTIONS = [
  "Perspective",
  "Proposed approach",
  "Evidence",
  "Risks",
  "Verification",
];
const SYNTHESIS_SECTIONS = [
  "Consensus",
  "Architect contributions",
  "Builder contributions",
  "Conflicts and resolution",
  "Rejected claims",
  "Final recommendation",
];

function validateSections(text, required) {
  const body = String(text || "");
  const lines = body.split(/\r?\n/);
  const matches = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = lines[index].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence || marker;
      continue;
    }
    if (fence) continue;
    const heading = lines[index].match(/^##[ \t]+(.+?)[ \t]*$/);
    if (heading) matches.push({ index, heading: heading[1].trim() });
  }
  const headings = matches.map((match) => match.heading);
  const missing = required.filter((section) => !headings.includes(section));
  const exactOrder =
    headings.length === required.length &&
    headings.every((heading, index) => heading === required[index]);
  const nonEmpty =
    exactOrder &&
    matches.every((match, index) => {
      const end = matches[index + 1]?.index ?? lines.length;
      return lines.slice(match.index + 1, end).join("\n").trim().length > 0;
    });
  const noPreamble = matches.length > 0 && lines.slice(0, matches[0].index).join("\n").trim() === "";
  return {
    ok: body.trim().length > 0 && noPreamble && fence === null && exactOrder && nonEmpty,
    missing,
  };
}

export function validateFusionProposal(text) {
  return validateSections(text, PROPOSAL_SECTIONS);
}

export function validateFusionSynthesis(text) {
  return validateSections(text, SYNTHESIS_SECTIONS);
}

export function deriveFusionStatus({
  proposals = [],
  synthesis = null,
  aborted = false,
  budgetExceeded = false,
} = {}) {
  if (aborted) return "ABORTED";
  if (budgetExceeded) return "BUDGET_EXCEEDED";
  const proposalsOk =
    proposals.length === 2 &&
    proposals.every((proposal) => proposal?.ok && proposal?.contractOk);
  if (!proposalsOk) return "FAILED";
  if (!synthesis?.ok || !synthesis?.contractOk) return "FAILED";
  return "COMPLETE";
}

function normalizeFusionError(error) {
  return error === "auth_required" ? "provider_unavailable" : error;
}

function childEventOutput(event) {
  if (
    !event ||
    (event.type !== "message_update" && event.type !== "message_end") ||
    event.message?.role !== "assistant" ||
    !Array.isArray(event.message.content)
  ) {
    return null;
  }
  const text = event.message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text ? text.slice(-12_000) : null;
}

function fusionFailureDetail(error) {
  const details = {
    provider_unavailable: "selected provider unavailable in this Alloy session",
    timeout: "child timed out",
    spawn_failed: "could not start child runtime",
    child_setup_failed: "child runtime setup failed",
    sandbox_unavailable: "required sandbox unavailable",
    invalid_proposal: "proposal did not match the Fusion contract",
    invalid_synthesis: "synthesis did not match the Fusion contract",
  };
  return details[error] || error || "child failed";
}

const ROLE_PROMPTS = {
  architect: `You are the Architect in an Alloy fusion run.
Analyze system boundaries, architecture, constraints, tradeoffs, failure modes, and sequencing.
Inspect the repository but do not modify files. Work independently from the Builder.`,
  builder: `You are the Builder in an Alloy fusion run.
Analyze concrete implementation, affected files, tests, developer experience, and operational risks.
Inspect the repository but do not modify files. Work independently from the Architect.`,
};

const PROPOSAL_CONTRACT = `Return Markdown with EXACTLY these top-level sections:
## Perspective
## Proposed approach
## Evidence
## Risks
## Verification

Use concrete repository evidence. Do not claim actions you did not observe.`;

const SYNTHESIZER_PROMPT = `You are the Synthesizer in an Alloy fusion run.
Combine two independent proposals without erasing disagreement or provenance.
Do not modify files. Do not invent evidence not present in the proposals.

Return Markdown with EXACTLY these top-level sections:
## Consensus
## Architect contributions
## Builder contributions
## Conflicts and resolution
## Rejected claims
## Final recommendation`;

function totalUsage(results) {
  const total = (results || []).reduce(
    (total, result) => {
      const usage = result?.usage || {};
      total.input += Number(usage.input) || 0;
      total.output += Number(usage.output) || 0;
      total.cost += Number(usage.cost) || 0;
      total.turns += Number(usage.turns) || 0;
      return total;
    },
    { input: 0, output: 0, cost: 0, turns: 0 },
  );
  total.cost = Number(total.cost.toFixed(12));
  return total;
}

function childEventDetail(event) {
  if (event?.type === "tool_execution_start") {
    return { tool: event.toolName || "tool", detail: "started" };
  }
  if (event?.type === "message_end") return { tool: "message", detail: "complete" };
  return null;
}

function makeSummary({
  panel,
  runDir,
  models,
  requestedEfforts,
  proposals = [],
  synthesisResult = null,
  status,
  missingProviders = [],
  error = null,
}) {
  const usage = totalUsage([...proposals, synthesisResult].filter(Boolean));
  return {
    kind: "fusion",
    mode: "plan",
    runId: panel.runId,
    runDir,
    models,
    requestedEfforts,
    proposals,
    synthesis: synthesisResult?.text || "",
    synthesizer: synthesisResult
      ? {
          ok: synthesisResult.ok,
          contractOk: synthesisResult.contractOk,
          error: synthesisResult.error,
          model: synthesisResult.model,
          usage: synthesisResult.usage,
        }
      : null,
    usage,
    missingProviders,
    error,
    panel: renderPanelLines(panel),
    status,
  };
}

function persistSummary(runDir, summary) {
  save(runDir, "summary.json", summary);
  appendEvent(runDir, { type: "fusion_done", status: summary.status });
  return summary;
}

/** Testable coordinator seam. Production callers should use runFusion(). */
export async function runFusionWithDependencies(opts, deps) {
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request || "").trim();
  if (!request) throw new Error("fusion: empty request");
  if (opts.mode === "build") {
    throw new Error("fusion build is not available; use /fusion <objective> for planning");
  }

  const cfg = deps.loadConfig(cwd);
  const models = resolveFusionRoleModels(cfg);
  const requestedEfforts = resolveFusionRoleEfforts(cfg);
  const runDir = deps.createRunDir(cwd);
  mkdirSync(join(runDir, "fusion"), { recursive: true, mode: 0o700 });
  const panel = createPanelState({
    title: "ALLOY FUSION",
    runId: runDir.split(/[/\\]/).pop(),
  });
  const emit = () => opts.onPanel?.(panel);
  const progress = (msg) => {
    appendEvent(runDir, { type: "progress", msg });
    opts.onProgress?.(msg);
  };

  save(runDir, "request.md", `# Fusion objective\n\n${request}\n`);
  const leases = {
    architect: await deps.loadCredentialLease([models.architect]),
    builder: await deps.loadCredentialLease([models.builder]),
    synthesizer: await deps.loadCredentialLease([models.synthesizer]),
  };
  const missingProviders = [
    ...new Set(Object.values(leases).flatMap((lease) => lease.missing || [])),
  ];
  save(runDir, "fusion/models.json", {
    mode: "plan",
    models,
    requestedEfforts,
    credentialProviders: Object.fromEntries(
      Object.entries(leases).map(([role, lease]) => [role, lease.providers || []]),
    ),
  });
  appendEvent(runDir, {
    type: "fusion_start",
    mode: "plan",
    models,
    requestedEfforts,
  });

  for (const role of ["architect", "builder"]) {
    upsertAgent(panel, {
      role,
      status: "pending",
      model: models[role],
      detail: "queued",
    });
  }
  upsertAgent(panel, {
    role: "synthesizer",
    status: "pending",
    model: models.synthesizer,
    detail: "waiting",
  });
  emit();

  if (missingProviders.length) {
    setPhase(panel, "PROVIDER UNAVAILABLE");
    emit();
    const summary = makeSummary({
      panel,
      runDir,
      models,
      requestedEfforts,
      status: "FAILED",
      missingProviders,
      error: "provider_unavailable",
    });
    return persistSummary(runDir, summary);
  }

  if (opts.parentSandbox || opts.sandbox) {
    setPhase(panel, "FAILED");
    emit();
    const summary = makeSummary({
      panel,
      runDir,
      models,
      requestedEfforts,
      status: "FAILED",
      error: "sandbox_model_egress_unavailable",
    });
    return persistSummary(runDir, summary);
  }

  setPhase(panel, "PROPOSING");
  const parentProfile =
    opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous";

  const runChild = async (options) => {
    try {
      return await deps.runChildAgent(options);
    } catch {
      return {
        ok: false,
        text: "",
        error: "child_failed",
        model: options.model,
        usage: { input: 0, output: 0, cost: 0, turns: 0 },
        events: [],
      };
    }
  };

  const runProposal = async (role) => {
    const model = models[role];
    const startedAt = Date.now();
    upsertAgent(panel, {
      role,
      status: "running",
      model,
      startedAt,
      detail: "analyzing…",
    });
    emit();
    progress(`${role}…`);
    const rolePrompt = ROLE_PROMPTS[role];
    const result = await runChild({
      prompt: `${rolePrompt}\n\n${PROPOSAL_CONTRACT}\n\n## Objective\n${request}`,
      cwd,
      model,
      thinkingLevel: requestedEfforts[role],
      tools: READ_TOOLS,
      systemPrompt: withHonesty(
        `${rolePrompt}\n\n${PROPOSAL_CONTRACT}`,
        honestyFactsForModel(model, `fusion-${role}`),
      ),
      timeoutMs: opts.timeoutMs || 300_000,
      signal: opts.signal,
      permissionProfile: parentProfile,
      mode: "plan",
      sandbox: false,
      parentPermissionProfile: parentProfile,
      parentSandbox: false,
      readRoot: cwd,
      credentialBroker: leases[role].mode,
      brokerAuthJson: leases[role].authJson,
      brokerRuntimeCredential: leases[role].runtimeCredential,
      role: `fusion-${role}`,
      onEvent: (event) => {
        const detail = childEventDetail(event);
        if (detail) {
          panel.ticker.unshift({ ts: Date.now(), agent: role, ...detail });
          panel.ticker = panel.ticker.slice(0, 8);
        }
        const output = childEventOutput(event);
        if (output) upsertAgent(panel, { role, output });
        emit();
      },
    });
    const contract = result.ok
      ? validateFusionProposal(result.text)
      : { ok: false, missing: [] };
    const record = {
      role,
      requestedModel: model,
      model: result.model || model,
      ok: Boolean(result.ok && contract.ok),
      contractOk: contract.ok,
      error: normalizeFusionError(
        result.ok && !contract.ok ? "invalid_proposal" : result.error,
      ),
      missingSections: contract.missing,
      text: result.text || "",
      usage: result.usage || { input: 0, output: 0, cost: 0, turns: 0 },
    };
    save(
      runDir,
      `fusion/${role}.md`,
      `# ${role[0].toUpperCase()}${role.slice(1)} proposal\n\nmodel: ${record.model}\n\n${record.text || record.error || "(empty)"}\n`,
    );
    upsertAgent(panel, {
      role,
      status: record.ok ? "ok" : "fail",
      model: record.model,
      startedAt,
      endedAt: Date.now(),
      usage: record.usage,
      output: record.text.slice(-12_000),
      detail: record.error
        ? fusionFailureDetail(record.error)
        : "proposal ready",
    });
    emit();
    return record;
  };

  const proposals = await Promise.all([
    runProposal("architect"),
    runProposal("builder"),
  ]);
  const proposalUsage = totalUsage(proposals);
  const maxCostUsd = Number(cfg.budgets?.maxCostUsd);
  const budgetExceeded =
    Number.isFinite(maxCostUsd) && proposalUsage.cost >= maxCostUsd;
  const proposalsOk = proposals.every((proposal) => proposal.ok && proposal.contractOk);
  if (opts.signal?.aborted || budgetExceeded || !proposalsOk) {
    const status = deriveFusionStatus({
      proposals,
      synthesis: null,
      aborted: Boolean(opts.signal?.aborted),
      budgetExceeded,
    });
    const unavailableProviders = proposals
      .filter((proposal) => proposal.error === "provider_unavailable")
      .map((proposal) => proposal.requestedModel.split("/", 1)[0]);
    setPhase(
      panel,
      unavailableProviders.length
        ? "PROVIDER UNAVAILABLE"
        : status.replaceAll("_", " "),
    );
    const summary = makeSummary({
      panel,
      runDir,
      models,
      requestedEfforts,
      proposals,
      status,
      missingProviders: [...new Set(unavailableProviders)],
      error: unavailableProviders.length ? "provider_unavailable" : null,
    });
    return persistSummary(runDir, summary);
  }

  setPhase(panel, "SYNTHESIZING");
  upsertAgent(panel, {
    role: "synthesizer",
    status: "running",
    model: models.synthesizer,
    startedAt: Date.now(),
    detail: "combining…",
  });
  emit();
  progress("synthesizer…");
  const sourceText = proposals
    .map(
      (proposal) =>
        `# ${proposal.role.toUpperCase()} PROPOSAL\nmodel: ${proposal.model}\n\n${proposal.text.slice(0, 60_000)}`,
    )
    .join("\n\n");
  const synthStartedAt = Date.now();
  const rawSynthesis = await runChild({
    prompt: `${SYNTHESIZER_PROMPT}\n\n## Objective\n${request}\n\n${sourceText}`,
    cwd,
    model: models.synthesizer,
    thinkingLevel: requestedEfforts.synthesizer,
    tools: READ_TOOLS,
    systemPrompt: withHonesty(
      SYNTHESIZER_PROMPT,
      honestyFactsForModel(models.synthesizer, "fusion-synthesizer"),
    ),
    timeoutMs: opts.timeoutMs || 300_000,
    signal: opts.signal,
    permissionProfile: parentProfile,
    mode: "plan",
    sandbox: false,
    parentPermissionProfile: parentProfile,
    parentSandbox: false,
    readRoot: cwd,
    credentialBroker: leases.synthesizer.mode,
    brokerAuthJson: leases.synthesizer.authJson,
    brokerRuntimeCredential: leases.synthesizer.runtimeCredential,
    role: "fusion-synthesizer",
    onEvent: (event) => {
      const detail = childEventDetail(event);
      if (detail) {
        panel.ticker.unshift({ ts: Date.now(), agent: "synthesizer", ...detail });
        panel.ticker = panel.ticker.slice(0, 8);
      }
      const output = childEventOutput(event);
      if (output) upsertAgent(panel, { role: "synthesizer", output });
      emit();
    },
  });
  const synthContract = rawSynthesis.ok
    ? validateFusionSynthesis(rawSynthesis.text)
    : { ok: false, missing: [] };
  const synthesisResult = {
    ...rawSynthesis,
    ok: Boolean(rawSynthesis.ok && synthContract.ok),
    contractOk: synthContract.ok,
    error:
      rawSynthesis.ok && !synthContract.ok
        ? "invalid_synthesis"
        : normalizeFusionError(rawSynthesis.error),
    missingSections: synthContract.missing,
    model: rawSynthesis.model || models.synthesizer,
  };
  save(
    runDir,
    "fusion/synthesis.md",
    `# Fusion synthesis\n\nmodel: ${synthesisResult.model}\n\n${synthesisResult.text || synthesisResult.error || "(empty)"}\n`,
  );
  const total = totalUsage([...proposals, synthesisResult]);
  const finalBudgetExceeded =
    Number.isFinite(maxCostUsd) && total.cost >= maxCostUsd;
  const status = deriveFusionStatus({
    proposals,
    synthesis: synthesisResult,
    aborted: Boolean(opts.signal?.aborted),
    budgetExceeded: finalBudgetExceeded,
  });
  const unavailableProviders =
    synthesisResult.error === "provider_unavailable"
      ? [models.synthesizer.split("/", 1)[0]]
      : [];
  upsertAgent(panel, {
    role: "synthesizer",
    status: synthesisResult.ok ? "ok" : "fail",
    model: synthesisResult.model,
    startedAt: synthStartedAt,
    endedAt: Date.now(),
    usage: synthesisResult.usage,
    output: String(synthesisResult.text || "").slice(-12_000),
    detail: synthesisResult.error
      ? fusionFailureDetail(synthesisResult.error)
      : "synthesis ready",
  });
  setPhase(
    panel,
    unavailableProviders.length ? "PROVIDER UNAVAILABLE" : status,
  );
  emit();
  const summary = makeSummary({
    panel,
    runDir,
    models,
    requestedEfforts,
    proposals,
    synthesisResult,
    status,
    missingProviders: unavailableProviders,
    error: unavailableProviders.length ? "provider_unavailable" : null,
  });
  return persistSummary(runDir, summary);
}

export function runFusion(opts) {
  return runFusionWithDependencies(opts, {
    createRunDir,
    loadConfig,
    loadCredentialLease:
      opts.loadCredentialLease || loadCredentialLeaseForModels,
    runChildAgent,
  });
}
