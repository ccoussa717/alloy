import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { createRunDir } from "./auto-workflow.mjs";
import { prepareExactAgentLaunch, routingFailureCode } from "./agent-orchestration.mjs";
import {
  getAgentSpentCost,
  getRunningAgentCount,
  reserveAgentLaunch,
  settleAgentLaunch,
} from "./agent-registry.mjs";
import { runChildAgent } from "./child-runner.mjs";
import { loadConfig } from "./config.mjs";
import {
  FISSION_OUTPUT_LIMIT,
  FISSION_REQUEST_LIMIT,
  FISSION_SUBJECT_PATH,
  assertExactUtf8String,
  captureFissionPacket,
  captureFissionSubjectPacket,
  preflightFissionRepository,
  recaptureFissionSource,
  verifyFissionArtifacts,
} from "./fission-packet.mjs";
import {
  deriveFissionResult,
  findingId,
  JudgeOutputSchema,
  ReviewerOutputSchema,
  validateJudgeOutput,
  validateReviewerOutput,
} from "./fission-schema.mjs";
import { parseStrictJsonObject } from "./strict-json.mjs";
import {
  formatFissionRoleLabel,
  fissionRoleBrief,
  resolveFissionRoles,
} from "./fission-roles.mjs";
import { recordRun } from "./run-index.mjs";

export {
  FISSION_DEFAULT_ROLE_PACKS,
  FISSION_ROLE_CATALOG,
  FISSION_ROLE_IDS,
  FISSION_ROLES,
  formatFissionRoleLabel,
  fissionRoleBrief,
  fissionRoleSelectOptions,
  fissionRoleIdFromLabel,
  getFissionRole,
  isFissionRoleId,
  resolveFissionRoles,
} from "./fission-roles.mjs";

const READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, cost: 0, turns: 0, costKnown: true });

function waitWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Same vocabulary as fusion / child-runner thinking levels. */
export const FISSION_EFFORT_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Specialties assigned when a run uses `count` reviewers (index-aligned with models).
 * Prefer resolveFissionRoles(cfg, count) when config may include operator-chosen roles.
 */
export function fissionRolesForCount(count) {
  return resolveFissionRoles({}, count);
}

/**
 * Resolve per-reviewer + judge thinking levels from global fission config.
 * Missing / empty → null (model/provider default).
 */
export function resolveFissionEfforts(cfg, reviewerCount) {
  const fission = cfg?.fission || {};
  const raw = Array.isArray(fission.reviewerEfforts) ? fission.reviewerEfforts : [];
  const count = Number.isInteger(reviewerCount) ? reviewerCount : 0;
  const reviewerEfforts = [];
  for (let i = 0; i < count; i++) {
    const value = raw[i];
    if (value == null || value === "") {
      reviewerEfforts.push(null);
      continue;
    }
    const normalized = String(value).toLowerCase();
    if (!FISSION_EFFORT_LEVELS.includes(normalized)) {
      throw new Error("fission_effort");
    }
    reviewerEfforts.push(normalized);
  }
  let judgeEffort = null;
  if (fission.judgeEffort != null && fission.judgeEffort !== "") {
    const normalized = String(fission.judgeEffort).toLowerCase();
    if (!FISSION_EFFORT_LEVELS.includes(normalized)) {
      throw new Error("fission_effort");
    }
    judgeEffort = normalized;
  }
  return { reviewerEfforts, judgeEffort };
}

/** Operator-facing hint when config blocks a run. */
export function fissionConfigHint(errorCode) {
  const code = String(errorCode || "");
  if (code === "reviewer_models" || code.startsWith("reviewer_models")) {
    return "Configure reviewer models with /fission setup (need one distinct route per max reviewer).";
  }
  if (code === "judge_model") {
    return "Configure a judge model with /fission setup.";
  }
  if (code === "orchestration_disabled") {
    return "Fission requires orchestration.enabled. Re-run /fission setup (it turns this on), or set orchestration.enabled=true in ~/.pi/alloy/config.json. Check /fission status for “Orchestration: enabled”.";
  }
  if (code === "fission_effort") {
    return "Invalid fission effort in config — re-run /fission setup.";
  }
  if (code === "reviewer_roles") {
    return "Configure reviewer roles with /fission setup (pick a predefined role per slot).";
  }
  if (code === "provider_unavailable" || code.startsWith("provider_unavailable")) {
    return "A reviewer/judge model is not available or not authenticated in this session. /login for cloud providers, or start Ollama/llama.cpp/LM Studio and restart Alloy so local models are discovered.";
  }
  if (code === "routing_failed" || code.startsWith("routing_failed")) {
    return "Could not launch a reviewer with the configured exact model route. Check /fission status models and /doctor.";
  }
  if (code === "custom_transport_unavailable") {
    return "Configured model uses an untrusted custom transport. Prefer /model-discovered routes or re-run /fission setup.";
  }
  if (code.startsWith("child_failed")) {
    return "A reviewer child process failed. Upgrade to Alloy ≥1.1.1 for local-engine children. Ensure Ollama is running and the model name matches /model.";
  }
  if (code === "packet_drift" || code === "source_drift") {
    return "The review packet changed during the run (or failed to freeze). Retry; if it persists, report with /fission status and the Artifacts path.";
  }
  return null;
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value))].sort();
}

export function buildModelDiversity({
  requestedModels = [],
  actualModels = [],
  modelFamilies = {},
} = {}) {
  const requested = uniqueSorted(requestedModels);
  const actual = uniqueSorted(actualModels);
  const providers = uniqueSorted(actual.map((model) => model.split("/", 1)[0]));
  const families = uniqueSorted(actual.map((model) => {
    const label = modelFamilies?.[model];
    return typeof label === "string" && label.trim() ? label.trim() : "unknown";
  }));
  return {
    requestedModels: requested,
    actualModels: actual,
    providers,
    families,
    exactModelCount: actual.length,
    providerCount: providers.length,
    familyCount: families.length,
  };
}

/** auto = dirty trusted repo when available, otherwise freeform subject. */
export const FISSION_MODES = Object.freeze(["auto", "subject", "repo"]);
/** Session/child modes that must not be confused with packet fissionMode. */
const SESSION_MODES = new Set(["review", "build", "plan", "chat"]);

/**
 * Resolve packet mode from opts.fissionMode (preferred) or opts.mode.
 * Session modes (review/build/plan/chat) are ignored → auto, so parentPolicy
 * spreads remain safe.
 */
export function normalizeFissionMode(value) {
  if (value == null || value === "") return "auto";
  const mode = String(value).trim().toLowerCase();
  if (SESSION_MODES.has(mode)) return "auto";
  if (!FISSION_MODES.includes(mode)) throw new Error("fission_mode");
  return mode;
}

export function resolveRequestedFissionMode(opts = {}) {
  if (opts.fissionMode != null && opts.fissionMode !== "") {
    return normalizeFissionMode(opts.fissionMode);
  }
  return normalizeFissionMode(opts.mode);
}

export function createFissionResult(input = {}) {
  return {
    kind: "fission",
    runId: input.runId ?? (input.runDir ? basename(input.runDir) : null),
    runDir: input.runDir ?? null,
    status: input.status || "INCOMPLETE",
    verdict: input.verdict ?? (input.status === "INCOMPLETE" ? "INCOMPLETE" : null),
    message: input.message || "review evidence is incomplete.",
    request: input.request || "",
    requestedReviewers: input.requestedReviewers ?? null,
    blockingSeverity: input.blockingSeverity || "high",
    mode: input.mode ?? null,
    packetDigest: input.packetDigest ?? null,
    sourceDigest: input.sourceDigest ?? null,
    evidenceComplete: input.evidenceComplete === true,
    reviewers: input.reviewers || [],
    judge: input.judge || null,
    clusters: input.clusters || [],
    validatedFindings: input.validatedFindings || [],
    rejectedFindings: input.rejectedFindings || [],
    unresolvedFindings: input.unresolvedFindings || [],
    modelDiversity: input.modelDiversity || buildModelDiversity(),
    usage: input.usage || { ...EMPTY_USAGE },
    error: input.error ?? null,
    panel: input.panel || [],
  };
}

function validateReviewerLimits(defaultReviewers, maxReviewers) {
  if (
    !Number.isInteger(defaultReviewers) ||
    !Number.isInteger(maxReviewers) ||
    defaultReviewers < 1 ||
    maxReviewers > 5 ||
    defaultReviewers > maxReviewers
  ) throw new Error("reviewer_limit");
}

export function parseFissionRequest(text, {
  defaultReviewers = 3,
  maxReviewers = 5,
} = {}) {
  validateReviewerLimits(defaultReviewers, maxReviewers);
  const source = assertExactUtf8String(text).trim();
  if (!source) throw new Error("empty_request");
  const firstSpace = source.search(/\s/);
  const token = firstSpace === -1 ? source : source.slice(0, firstSpace);
  const numericToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token);
  let reviewers = defaultReviewers;
  let request = source;
  if (numericToken) {
    if (!/^\d+$/.test(token)) throw new Error("reviewer_limit");
    reviewers = Number(token);
    request = firstSpace === -1 ? "" : source.slice(firstSpace).trim();
    if (!Number.isInteger(reviewers) || reviewers < 1 || reviewers > maxReviewers) {
      throw new Error("reviewer_limit");
    }
  }
  if (!request) throw new Error("empty_request");
  if (Buffer.byteLength(request, "utf8") > FISSION_REQUEST_LIMIT) {
    throw new Error("request_limit");
  }
  return { request, reviewers };
}

function validRoute(route) {
  if (typeof route !== "string" || route !== route.trim()) return false;
  const slash = route.indexOf("/");
  return slash > 0 && slash < route.length - 1 && !/\s/.test(route);
}

export function resolveFissionModels(cfg, count, overrides = {}) {
  if (
    overrides &&
    Object.keys(overrides).some((key) => ["model", "models", "reviewerModels", "judgeModel"].includes(key))
  ) throw new Error("fission_model_override");
  const configured = Array.isArray(cfg?.fission?.models) ? cfg.fission.models : [];
  const reviewerModels = [];
  for (const route of configured) {
    if (!validRoute(route)) throw new Error("reviewer_models");
    if (!reviewerModels.includes(route)) reviewerModels.push(route);
  }
  if (reviewerModels.length < count) throw new Error("reviewer_models");
  const judgeModel = cfg?.fission?.judgeModel;
  if (!validRoute(judgeModel)) throw new Error("judge_model");
  const efforts = resolveFissionEfforts(cfg, count);
  return {
    reviewerModels: reviewerModels.slice(0, count),
    judgeModel,
    reviewerEfforts: efforts.reviewerEfforts,
    judgeEffort: efforts.judgeEffort,
  };
}

function save(runDir, name, value) {
  const path = join(runDir, name);
  const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return path;
}

function totalUsage(results) {
  const usage = { input: 0, output: 0, cost: 0, turns: 0, costKnown: true };
  for (const result of results.filter(Boolean)) {
    const observed = result.usage || {};
    usage.input += Number(observed.input) || 0;
    usage.output += Number(observed.output) || 0;
    usage.turns += Number(observed.turns) || 0;
    if (
      observed.costKnown === false ||
      typeof observed.cost !== "number" ||
      !Number.isFinite(observed.cost) ||
      observed.cost < 0
    ) {
      usage.costKnown = false;
    } else {
      usage.cost += observed.cost;
    }
  }
  usage.cost = usage.costKnown ? Number(usage.cost.toFixed(12)) : null;
  return usage;
}

function observedUsageError(result, reservedBudget) {
  const cost = result?.usage?.cost;
  if (
    result?.usage?.costKnown === false ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  ) return "budget_usage_unavailable";
  if (Number.isFinite(reservedBudget) && cost > reservedBudget) return "budget_exceeded";
  return null;
}

function childFailure(result) {
  if (result?.ok) return null;
  if (result?.error === "auth_required") return "provider_unavailable";
  const code = result?.error || "child_failed";
  // Attach a short stderr hint so operators see why local children died
  // (unknown model, connection refused, etc.) without dumping full logs.
  if (code === "child_failed" || code === "spawn_failed") {
    const stderr = String(result?.stderr || "").trim().replace(/\s+/g, " ");
    if (stderr) {
      const hint = stderr.length > 160 ? `${stderr.slice(0, 157)}...` : stderr;
      return `${code}: ${hint}`;
    }
  }
  return code;
}

function panelLines(reviewers, judge, status) {
  return [
    `ALLOY FISSION ${status}`,
    ...reviewers.map((item) => `${item.alias} ${item.role}: ${item.status}`),
    ...(judge ? [`JUDGE: ${judge.status}`] : []),
  ];
}

function reportFor(result) {
  const lines = [
    "# Fission Report",
    "",
    "## Result",
    `${result.status}${result.verdict ? ` / ${result.verdict}` : ""}: ${result.message}`,
    "",
    "## Validated Findings",
    result.validatedFindings.length ? JSON.stringify(result.validatedFindings, null, 2) : "None.",
    "",
    "## Rejected and Duplicate Claims",
    result.rejectedFindings.length ? JSON.stringify(result.rejectedFindings, null, 2) : "None.",
    "",
    "## Unresolved Evidence Requests",
    result.unresolvedFindings.length ? JSON.stringify(result.unresolvedFindings, null, 2) : "None.",
    "",
    "## Disagreements",
    result.judge?.output?.judgeConcern ? JSON.stringify(result.judge.output.judgeConcern, null, 2) : "None.",
    "",
    "## Coverage and Model Diversity",
    JSON.stringify(result.modelDiversity, null, 2),
    "",
    "## Run Evidence",
    `Packet digest: ${result.packetDigest || "unavailable"}`,
    `Source digest: ${result.sourceDigest || "unavailable"}`,
    "",
  ];
  return lines.join("\n");
}

function normalizeClusters(judgeOutput, submitted) {
  const byId = new Map(submitted.map((item) => [item.id, item.finding]));
  const clusters = [];
  const validatedFindings = [];
  const rejectedFindings = [];
  const unresolvedFindings = [];
  for (const [index, cluster] of judgeOutput.clusters.entries()) {
    const clusterId = `C${String(index + 1).padStart(4, "0")}`;
    const members = [
      cluster.canonicalFindingId,
      ...cluster.findingIds
        .filter((id) => id !== cluster.canonicalFindingId)
        .sort(),
    ];
    clusters.push({ clusterId, ...cluster, findingIds: members });
    const canonical = byId.get(cluster.canonicalFindingId);
    const common = {
      clusterId,
      canonicalFindingId: cluster.canonicalFindingId,
      memberFindingIds: members,
      affectedPath: canonical.affectedPath,
      location: canonical.location,
      claim: canonical.claim,
      adjudicatedSeverity: cluster.adjudicatedSeverity,
      rationale: cluster.rationale,
      evidenceRefs: cluster.evidenceRefs,
    };
    if (cluster.disposition === "validated") validatedFindings.push(common);
    else if (cluster.disposition === "rejected") {
      rejectedFindings.push({ ...common, adjudicatedSeverity: null, disposition: "rejected" });
    } else {
      unresolvedFindings.push({
        ...common,
        adjudicatedSeverity: null,
        disposition: cluster.disposition,
      });
    }
    for (const id of members.slice(1)) {
      const member = byId.get(id);
      rejectedFindings.push({
        clusterId,
        canonicalFindingId: cluster.canonicalFindingId,
        memberFindingIds: members,
        affectedPath: member.affectedPath,
        location: member.location,
        claim: member.claim,
        adjudicatedSeverity: null,
        rationale: `Duplicate of ${cluster.canonicalFindingId}: ${cluster.rationale}`,
        evidenceRefs: cluster.evidenceRefs,
        disposition: "duplicate",
      });
    }
  }
  return { clusters, validatedFindings, rejectedFindings, unresolvedFindings };
}

function blockingFinding(validatedFindings, threshold) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const limit = rank[threshold];
  return validatedFindings.some((item) => rank[item.adjudicatedSeverity] <= limit);
}

const REVIEWER_EXAMPLE = {
  reviewerRole: "correctness_regressions",
  coverage: ["changed behavior and regression risk"],
  findings: [{
    severity: "high",
    claim: "The changed branch can lose an acknowledged write.",
    affectedPath: "lib/example.mjs",
    location: {
      artifact: "unstaged_diff",
      artifactPath: "unstaged.diff",
      lineStart: 12,
      lineEnd: 14,
      artifactDigest: "a".repeat(64),
    },
    evidence: "The accepted diff returns before the durable write.",
    reproduction: "Interrupt immediately after the acknowledgement.",
    suggestedFix: "Complete the durable write before acknowledging.",
    confidence: 0.95,
  }],
  errors: [],
};

const JUDGE_EXAMPLE = {
  clusters: [{
    canonicalFindingId: `F${"a".repeat(24)}`,
    findingIds: [`F${"a".repeat(24)}`],
    disposition: "validated",
    adjudicatedSeverity: "high",
    rationale: "The accepted diff directly supports the claim.",
    evidenceRefs: [{
      artifactPath: "unstaged.diff",
      artifactDigest: "a".repeat(64),
      lineStart: 12,
      lineEnd: 14,
    }],
  }],
  judgeConcern: null,
};

const SUBJECT_REVIEWER_EXAMPLE = {
  reviewerRole: "general_adversarial",
  coverage: ["subject-risks"],
  findings: [{
    severity: "high",
    claim: "The plan omits authentication failure handling.",
    affectedPath: FISSION_SUBJECT_PATH,
    location: {
      artifact: "file",
      artifactPath: FISSION_SUBJECT_PATH,
      lineStart: 1,
      lineEnd: 3,
      artifactDigest: "a".repeat(64),
    },
    evidence: "The subject text describes the happy path only.",
    reproduction: "Read the subject section on auth.",
    suggestedFix: "Specify failure modes and recovery.",
    confidence: 0.9,
  }],
  errors: [],
};

const SUBJECT_JUDGE_EXAMPLE = {
  clusters: [{
    canonicalFindingId: "F" + "a".repeat(24),
    findingIds: ["F" + "a".repeat(24)],
    disposition: "validated",
    adjudicatedSeverity: "high",
    rationale: "The subject text supports the claim.",
    evidenceRefs: [{
      artifactPath: FISSION_SUBJECT_PATH,
      artifactDigest: "a".repeat(64),
      lineStart: 1,
      lineEnd: 3,
    }],
  }],
  judgeConcern: null,
};

function reviewerPrompt(request, role, packetKind = "repo") {
  const label = formatFissionRoleLabel(role);
  const brief = fissionRoleBrief(role);
  if (packetKind === "subject") {
    const example = { ...SUBJECT_REVIEWER_EXAMPLE, reviewerRole: role };
    return [
      "You are a blind specialist reviewer. Inspect only the immutable packet in your current directory.",
      `Role id: ${role}`,
      `Role: ${label}`,
      brief ? `Focus: ${brief}` : "",
      "This is a freeform subject review (plan, idea, document, or contract) — not a git diff.",
      `Read ${FISSION_SUBJECT_PATH}. Stay in character for this role. Prefer findings that match your focus.`,
      "Use read-only tools. Do not modify files or read outside the packet root.",
      "Return exactly one strict JSON object. The complete exact JSON Schema contract follows:",
      JSON.stringify(ReviewerOutputSchema),
      `Semantic rules: reviewerRole must equal the role id above. affectedPath must be exactly "${FISSION_SUBJECT_PATH}". location.artifact must be "file" and location.artifactPath must be "${FISSION_SUBJECT_PATH}". Digests and inclusive line ranges must match the packet. coverage values must be unique. All strings are exact UTF-8 and also obey these byte limits: coverage 512, narratives 8192, paths 4096, errors 2048. No properties beyond the schema are allowed.`,
      "Concrete valid JSON example:",
      JSON.stringify(example),
      `Review request: ${request}`,
    ].filter(Boolean).join("\n\n");
  }
  const example = { ...REVIEWER_EXAMPLE, reviewerRole: role };
  return [
    "You are a blind specialist reviewer. Inspect only the immutable packet in your current directory.",
    `Role id: ${role}`,
    `Role: ${label}`,
    brief ? `Focus: ${brief}` : "",
    "Stay in character for this role. Prefer findings that match your focus; do not dilute into a generic review.",
    "Use read-only tools. Do not modify files or read outside the packet root.",
    "Return exactly one strict JSON object. The complete exact JSON Schema contract follows:",
    JSON.stringify(ReviewerOutputSchema),
    "Semantic rules: reviewerRole must equal the role id above. affectedPath must exactly equal a path in review-packet.json entries. location may reference only staged.diff, unstaged.diff, or the accepted files/<affectedPath> artifact. Diff evidence must lie entirely within one diff section owned by affectedPath. File evidence must correspond to affectedPath. Digests and inclusive line ranges must match the packet. coverage values must be unique. All strings are exact UTF-8 and also obey these byte limits: coverage 512, narratives 8192, paths 4096, errors 2048. No properties beyond the schema are allowed.",
    "Concrete valid JSON example:",
    JSON.stringify(example),
    `Review request: ${request}`,
  ].filter(Boolean).join("\n\n");
}

function judgePrompt(request, findings, packetKind = "repo") {
  if (packetKind === "subject") {
    return [
      "You are the independent Fission judge. Adjudicate every anonymized finding against the immutable packet.",
      "This is a freeform subject review. Inspect only the packet root (especially subject.md).",
      "Return exactly one strict JSON object. The complete exact JSON Schema contract follows:",
      JSON.stringify(JudgeOutputSchema),
      `Semantic rules: cover every submitted finding exactly once; canonicalFindingId must be a member. Allowed dispositions are exactly validated, rejected, needs_probe, and human_decision; duplicate is not a disposition. adjudicatedSeverity is required and non-null only for validated, and must be null otherwise. Validated clusters require evidenceRefs. judgeConcern is either null or the exact concern object. Evidence may reference only ${FISSION_SUBJECT_PATH} with exact packet digest and inclusive line range. All strings are exact UTF-8 and also obey these byte limits: narratives 8192 and paths 4096. No properties beyond the schema are allowed.`,
      "Concrete valid JSON example:",
      JSON.stringify(SUBJECT_JUDGE_EXAMPLE),
      `Review request: ${request}`,
      JSON.stringify({ findings }),
    ].join("\n\n");
  }
  return [
    "You are the independent Fission judge. Adjudicate every anonymized finding against the immutable packet.",
    "Inspect only the packet root. Return exactly one strict JSON object. The complete exact JSON Schema contract follows:",
    JSON.stringify(JudgeOutputSchema),
    "Semantic rules: cover every submitted finding exactly once; canonicalFindingId must be a member. Allowed dispositions are exactly validated, rejected, needs_probe, and human_decision; duplicate is not a disposition. adjudicatedSeverity is required and non-null only for validated, and must be null otherwise. Validated clusters require evidenceRefs. judgeConcern is either null or the exact concern object. Cluster diff evidence must lie entirely within one section owned by at least one member finding affectedPath. Evidence may reference only staged.diff, unstaged.diff, or accepted changed file artifacts, with exact packet digest and inclusive line range. All strings are exact UTF-8 and also obey these byte limits: narratives 8192 and paths 4096. No properties beyond the schema are allowed.",
    "Concrete valid JSON example:",
    JSON.stringify(JUDGE_EXAMPLE),
    `Review request: ${request}`,
    JSON.stringify({ findings }),
  ].join("\n\n");
}

export async function runFissionWithDependencies(opts = {}, dependencies = {}) {
  const deps = {
    createRunDir,
    loadConfig,
    prepareExactAgentLaunch,
    preflightFissionRepository,
    captureFissionPacket,
    captureFissionSubjectPacket,
    recaptureFissionSource,
    verifyFissionArtifacts,
    getRunningAgentCount,
    getAgentSpentCost,
    reserveAgentLaunch,
    settleAgentLaunch,
    runChildAgent,
    saveArtifact: save,
    commitTerminalArtifacts: renameSync,
    ...dependencies,
  };
  const cwd = opts.cwd || process.cwd();
  const workflowTimeoutMs = opts.timeoutMs ?? 300_000;
  if (!Number.isFinite(workflowTimeoutMs) || workflowTimeoutMs <= 0) {
    return createFissionResult({
      request: "",
      requestedReviewers: opts.reviewers ?? opts.defaultReviewers ?? 3,
      blockingSeverity: opts.blockingSeverity || "high",
      status: "INCOMPLETE",
      error: "workflow_timeout_invalid",
    });
  }
  const deadlineAt = Date.now() + workflowTimeoutMs;
  let request;
  try {
    request = assertExactUtf8String(opts.request).trim();
  } catch {
    return createFissionResult({
      request: "",
      requestedReviewers: opts.reviewers ?? opts.defaultReviewers ?? 3,
      blockingSeverity: opts.blockingSeverity || "high",
      status: "INCOMPLETE",
      error: "request_utf8",
    });
  }
  const defaultReviewers = opts.defaultReviewers ?? 3;
  const maxReviewers = opts.maxReviewers ?? 5;
  const selectedReviewers = opts.reviewers === undefined ? defaultReviewers : opts.reviewers;
  let requestedMode;
  try {
    requestedMode = resolveRequestedFissionMode(opts);
  } catch {
    return createFissionResult({
      request,
      requestedReviewers: selectedReviewers,
      blockingSeverity: opts.blockingSeverity || "high",
      status: "INCOMPLETE",
      error: "fission_mode",
    });
  }
  const base = {
    request,
    requestedReviewers: selectedReviewers,
    blockingSeverity: opts.blockingSeverity || "high",
    mode: null,
  };
  try {
    validateReviewerLimits(defaultReviewers, maxReviewers);
    if (
      !Number.isInteger(selectedReviewers) ||
      selectedReviewers < 1 ||
      selectedReviewers > maxReviewers
    ) throw new Error("reviewer_limit");
  } catch {
    return createFissionResult({ ...base, status: "INCOMPLETE", error: "reviewer_limit" });
  }
  if (!request) return createFissionResult({ ...base, status: "INCOMPLETE", error: "empty_request" });
  if (Buffer.byteLength(request, "utf8") > FISSION_REQUEST_LIMIT) {
    return createFissionResult({ ...base, status: "INCOMPLETE", error: "request_limit" });
  }
  if (opts.signal?.aborted) {
    return createFissionResult({ ...base, status: "ABORTED", verdict: null, error: "aborted" });
  }

  const gitDeps = () => ({ deadlineAt });
  let preflight = null;
  let packetMode = null; // "repo" | "subject" once chosen

  if (requestedMode === "repo" || requestedMode === "auto") {
    preflight = deps.preflightFissionRepository(cwd, gitDeps());
    if (preflight.reason === "workflow_timeout") {
      return createFissionResult({ ...base, status: "INCOMPLETE", error: "workflow_timeout" });
    }
    if (Date.now() >= deadlineAt) {
      return createFissionResult({ ...base, status: "INCOMPLETE", error: "workflow_timeout" });
    }
    if (preflight.state === "READY") {
      packetMode = "repo";
    } else if (requestedMode === "repo") {
      if (preflight.state === "REFUSED") {
        return createFissionResult({
          ...base,
          mode: "repo",
          status: "REFUSED",
          verdict: null,
          message: "repository review was refused.",
          error: preflight.reason || "preflight_refused",
        });
      }
      if (preflight.state === "NO_CHANGES") {
        return createFissionResult({
          ...base,
          mode: "repo",
          status: "NO_CHANGES",
          verdict: null,
          message: "no changes to review.",
          error: null,
        });
      }
      return createFissionResult({
        ...base,
        mode: "repo",
        status: "REFUSED",
        verdict: null,
        error: "preflight_refused",
      });
    }
    // auto + not READY → subject mode below
  }

  if (!packetMode) packetMode = "subject";
  base.mode = packetMode;

  let runDir;
  try {
    runDir = deps.createRunDir(cwd);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
  } catch {
    return createFissionResult({ ...base, status: "INCOMPLETE", error: "artifact_write_failed" });
  }
  const runId = basename(runDir);
  const runBase = { ...base, runDir, runId };
  let blockingSeverity = base.blockingSeverity;
  let capture = null;
  let cfg;
  let selected;
  let hostManifest = null;
  let detachCallerAbort = () => {};
  let deadlineTimer = null;
  let artifactWriteFailed = false;
  let onArtifactFailure = () => {};
  const reviewers = [];
  let judge = null;
  const rawResults = [];
  const writeArtifact = (name, value) => {
    if (artifactWriteFailed) return false;
    try {
      deps.saveArtifact(runDir, name, value);
      return true;
    } catch {
      artifactWriteFailed = true;
      onArtifactFailure();
      return false;
    }
  };
  const persist = (input) => {
    detachCallerAbort();
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    let result = createFissionResult({
      ...runBase,
      mode: packetMode,
      blockingSeverity,
      packetDigest: capture?.packetDigest ?? null,
      sourceDigest: capture?.sourceDigest ?? null,
      evidenceComplete: capture?.evidenceComplete === true,
      reviewers,
      judge,
      usage: totalUsage(rawResults),
      panel: panelLines(reviewers, judge, input.status || "INCOMPLETE"),
      ...input,
    });
    if (artifactWriteFailed && result.error !== "artifact_write_failed") {
      result = createFissionResult({
        ...result,
        status: "INCOMPLETE",
        verdict: null,
        message: "review evidence is incomplete.",
        error: "artifact_write_failed",
      });
    }
    if (!artifactWriteFailed) {
      const attemptDir = join(runDir, `.terminal-attempt-${process.pid}-${Date.now()}`);
      const terminalDir = join(runDir, "terminal");
      try {
        mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
        deps.saveArtifact(attemptDir, "host-manifest.json", {
          ...hostManifest,
          status: result.status,
          error: result.error,
        });
        deps.saveArtifact(attemptDir, "report.md", reportFor(result));
        deps.saveArtifact(attemptDir, "result.json", result);
        deps.commitTerminalArtifacts(attemptDir, terminalDir);
      } catch {
        rmSync(attemptDir, { recursive: true, force: true });
        artifactWriteFailed = true;
        result = createFissionResult({
          ...result,
          status: "INCOMPLETE",
          verdict: null,
          message: "review evidence is incomplete.",
          error: "artifact_write_failed",
        });
      }
    }
    try {
      recordRun({
        kind: "fission",
        cwd,
        runId: result.runId,
        runDir: result.runDir,
        status: result.status,
        pass: result.status === "COMPLETE" && result.verdict === "PASS",
        error: result.error || null,
        cost: result.usage?.cost ?? null,
        meta: {
          verdict: result.verdict,
          requestedReviewers: result.requestedReviewers,
          mode: result.mode,
        },
      });
    } catch {
      // best-effort
    }
    return result;
  };

  if (opts.parentSandbox || opts.sandbox) {
    return persist({ status: "INCOMPLETE", error: "sandbox_model_egress_unavailable" });
  }
  try {
    cfg = deps.loadConfig(cwd);
    if (cfg.orchestration?.enabled !== true) throw new Error("orchestration_disabled");
    blockingSeverity = opts.blockingSeverity || cfg.fission?.blockingSeverity || "high";
    if (!Object.hasOwn({ critical: 1, high: 1, medium: 1, low: 1 }, blockingSeverity)) {
      throw new Error("blocking_severity");
    }
    selected = resolveFissionModels(cfg, selectedReviewers, opts.modelOverrides);
  } catch (error) {
    return persist({ status: "INCOMPLETE", error: String(error?.message || error) });
  }
  hostManifest = {
    version: 1,
    mode: packetMode,
    request,
    requestedReviewers: selectedReviewers,
    reviewerRoles: resolveFissionRoles(cfg, selectedReviewers),
    reviewerModels: selected.reviewerModels,
    judgeModel: selected.judgeModel,
    reviewerEfforts: selected.reviewerEfforts,
    judgeEffort: selected.judgeEffort,
  };
  if (!writeArtifact("launch-manifest.json", hostManifest)) {
    return persist({ status: "INCOMPLETE", error: "artifact_write_failed" });
  }
  const packetRoot = join(runDir, "packet");
  try {
    if (packetMode === "repo") {
      capture = deps.captureFissionPacket({
        cwd,
        packetRoot,
        request,
        preflight,
        deps: gitDeps(),
      });
    } else {
      const captureSubject =
        deps.captureFissionSubjectPacket || captureFissionSubjectPacket;
      capture = captureSubject({ packetRoot, request });
    }
  } catch (error) {
    return persist({ status: "INCOMPLETE", error: String(error?.message || error) });
  }
  if (Date.now() >= deadlineAt) {
    return persist({ status: "INCOMPLETE", error: "workflow_timeout" });
  }
  if (capture.evidenceComplete !== true) {
    return persist({ status: "INCOMPLETE", error: capture.reason || "evidence_incomplete" });
  }

  const controller = new AbortController();
  let terminalError = null;
  let terminalStatus = "INCOMPLETE";
  const active = new Set();
  let queueIndex = 0;
  const roles = resolveFissionRoles(cfg, selectedReviewers);

  const recordFailure = (error, status = "INCOMPLETE") => {
    if (!terminalError) {
      terminalError = error;
      terminalStatus = status;
      controller.abort(error);
    }
  };
  const abortFromCaller = () => recordFailure("aborted", "ABORTED");
  if (opts.signal?.aborted) abortFromCaller();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  detachCallerAbort = () => {
    opts.signal?.removeEventListener?.("abort", abortFromCaller);
    detachCallerAbort = () => {};
  };
  onArtifactFailure = () => recordFailure("artifact_write_failed");
  const remainingTime = () => Math.max(1, deadlineAt - Date.now());
  const checkDeadline = () => {
    if (!terminalError && Date.now() >= deadlineAt) recordFailure("workflow_timeout");
    return terminalError;
  };
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) recordFailure("workflow_timeout");
  else deadlineTimer = setTimeout(() => recordFailure("workflow_timeout"), remaining);

  const beginReviewer = async (index) => {
    if (controller.signal.aborted) {
      recordFailure("aborted", "ABORTED");
      return null;
    }
    const role = roles[index];
    const alias = `R${String(index + 1).padStart(2, "0")}`;
    const requestedModel = selected.reviewerModels[index];
    const verified = deps.verifyFissionArtifacts(capture);
    if (!verified.ok) {
      recordFailure("packet_drift");
      return null;
    }
    let launch;
    try {
      launch = await waitWithSignal(deps.prepareExactAgentLaunch({
        task: request,
        profile: "review",
        model: requestedModel,
        tools: READ_TOOLS,
        cwd,
        modelRegistry: opts.modelRegistry,
        activeChildren: deps.getRunningAgentCount(cwd),
        spentCostUsd: deps.getAgentSpentCost(cwd),
      }), controller.signal);
    } catch {
      if (!terminalError) recordFailure(opts.signal?.aborted ? "aborted" : "routing_failed", opts.signal?.aborted ? "ABORTED" : "INCOMPLETE");
      return null;
    }
    if (controller.signal.aborted) {
      recordFailure("aborted", "ABORTED");
      return null;
    }
    if (!launch.ok) {
      recordFailure(routingFailureCode(launch.decision));
      return null;
    }
    let reservation;
    try {
      reservation = deps.reserveAgentLaunch({
        cwd,
        maxConcurrency: launch.maxConcurrency,
        budgetUsd: launch.budgetUsd,
        budgetLimitUsd: launch.budgetLimitUsd,
        owner: `fission:${alias}`,
      });
    } catch (error) {
      const message = String(error?.message || error);
      recordFailure(/budget/i.test(message) ? "budget_exceeded" : "concurrency_limit");
      return null;
    }
    const promise = (async () => {
      let result = null;
      let childStarted = false;
      let record;
      try {
        childStarted = true;
        result = await deps.runChildAgent({
          prompt: reviewerPrompt(request, role, packetMode),
          cwd: capture.packetRoot,
          readRoot: capture.packetRoot,
          model: requestedModel,
          thinkingLevel: selected.reviewerEfforts[index] ?? null,
          tools: READ_TOOLS,
          timeoutMs: remainingTime(),
          signal: controller.signal,
          permissionProfile: opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous",
          parentPermissionProfile: opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous",
          parentSandbox: false,
          sandbox: false,
          mode: "review",
          role: `fission-reviewer-${role}`,
          credentialBroker: launch.credential.mode,
          brokerRuntimeCredential: launch.credential.runtimeCredential,
          maxCostUsd: reservation.budgetUsd,
          maxOutputBytes: FISSION_OUTPUT_LIMIT,
          requireExactModelAttestation: true,
        });
        rawResults.push(result);
        writeArtifact(`${alias.toLowerCase()}.raw.txt`, result?.text || "");
        const failure = childFailure(result);
        if (failure) throw new Error(failure);
        const usageError = observedUsageError(result, reservation.budgetUsd);
        if (usageError) throw new Error(usageError);
        if (!result.actualModel) throw new Error("actual_model_missing");
        if (result.actualModel !== requestedModel) throw new Error("actual_model_mismatch");
        const output = parseStrictJsonObject(result.text);
        validateReviewerOutput({ output, reviewerRole: role, packet: capture });
        if (output.errors.length) throw new Error("reviewer_errors");
        record = {
          alias,
          role,
          requestedModel,
          actualModel: result.actualModel,
          status: "ok",
          valid: true,
          malformed: false,
          output,
          error: null,
          usage: result.usage,
        };
        writeArtifact(`${alias.toLowerCase()}.json`, record);
      } catch (error) {
        const message = String(error?.message || error);
        const normalized = message === "reviewer_schema" || message.startsWith("strict_json")
          ? "reviewer_schema"
          : message;
        record = {
          alias,
          role,
          requestedModel,
          actualModel: result?.actualModel ?? null,
          status: "fail",
          valid: false,
          malformed: normalized === "reviewer_schema",
          output: null,
          error: normalized === "boom" ? "child_failed" : normalized,
          usage: result?.usage || { ...EMPTY_USAGE, cost: childStarted ? null : 0, costKnown: !childStarted },
        };
        writeArtifact(`${alias.toLowerCase()}.json`, record);
        if (!result) writeArtifact(`${alias.toLowerCase()}.raw.txt`, "");
        recordFailure(record.error, record.error === "aborted" ? "ABORTED" : "INCOMPLETE");
      } finally {
        try {
          deps.settleAgentLaunch(
            reservation,
            result?.usage || { cost: childStarted ? null : 0, costKnown: !childStarted },
          );
        } catch {
          recordFailure("settlement_failed");
        }
        reviewers[index] = record;
      }
    })();
    return { promise };
  };

  while ((queueIndex < selectedReviewers && !terminalError) || active.size) {
    while (queueIndex < selectedReviewers && !terminalError) {
      const maxConcurrency = cfg.orchestration.maxConcurrency;
      if (deps.getRunningAgentCount(cwd) >= maxConcurrency) break;
      const started = await beginReviewer(queueIndex++);
      if (!started) break;
      const { promise } = started;
      active.add(promise);
      promise.finally(() => active.delete(promise));
    }
    if (!active.size) {
      if (queueIndex < selectedReviewers && !terminalError) recordFailure("concurrency_limit");
      break;
    }
    await Promise.race(active);
  }
  while (active.size) await Promise.race(active);
  reviewers.splice(selectedReviewers);
  if (terminalError) {
    return persist({ status: terminalStatus, error: terminalError });
  }
  if (reviewers.length !== selectedReviewers || reviewers.some((item) => !item?.valid)) {
    return persist({ status: "INCOMPLETE", error: "reviewer_quorum" });
  }
  if (new Set(reviewers.map((item) => item.actualModel)).size !== selectedReviewers) {
    return persist({ status: "INCOMPLETE", error: "reviewer_models_not_distinct" });
  }
  if (controller.signal.aborted) {
    return persist({ status: "ABORTED", error: "aborted" });
  }

  const sourceC = deps.recaptureFissionSource(capture, gitDeps());
  if (checkDeadline()) return persist({ status: terminalStatus, error: terminalError });
  if (!sourceC.ok) return persist({ status: "INCOMPLETE", error: sourceC.reason || "source_drift" });
  if (!deps.verifyFissionArtifacts(capture).ok) {
    return persist({ status: "INCOMPLETE", error: "packet_drift" });
  }
  if (checkDeadline()) return persist({ status: terminalStatus, error: terminalError });
  const submitted = reviewers.flatMap((reviewer) =>
    reviewer.output.findings.map((item, index) => ({
      id: findingId(reviewer.alias, index, item),
      finding: item,
    })));
  let judgeLaunch;
  try {
    judgeLaunch = await waitWithSignal(deps.prepareExactAgentLaunch({
      task: request,
      profile: "review",
      model: selected.judgeModel,
      tools: READ_TOOLS,
      cwd,
      modelRegistry: opts.modelRegistry,
      activeChildren: deps.getRunningAgentCount(cwd),
      spentCostUsd: deps.getAgentSpentCost(cwd),
    }), controller.signal);
  } catch {
    if (terminalError) return persist({ status: terminalStatus, error: terminalError });
    return persist({ status: opts.signal?.aborted ? "ABORTED" : "INCOMPLETE", error: opts.signal?.aborted ? "aborted" : "routing_failed" });
  }
  if (controller.signal.aborted) {
    return persist({ status: "ABORTED", error: "aborted" });
  }
  if (!judgeLaunch.ok) {
    return persist({ status: "INCOMPLETE", error: routingFailureCode(judgeLaunch.decision) });
  }
  let judgeReservation;
  try {
    judgeReservation = deps.reserveAgentLaunch({
      cwd,
      maxConcurrency: judgeLaunch.maxConcurrency,
      budgetUsd: judgeLaunch.budgetUsd,
      budgetLimitUsd: judgeLaunch.budgetLimitUsd,
      owner: "fission:judge",
    });
  } catch (error) {
    return persist({
      status: "INCOMPLETE",
      error: /budget/i.test(String(error?.message || error)) ? "budget_exceeded" : "concurrency_limit",
    });
  }
  let judgeResult = null;
  try {
    judgeResult = await deps.runChildAgent({
      prompt: judgePrompt(request, submitted, packetMode),
      cwd: capture.packetRoot,
      readRoot: capture.packetRoot,
      model: selected.judgeModel,
      thinkingLevel: selected.judgeEffort ?? null,
      tools: READ_TOOLS,
      timeoutMs: remainingTime(),
      signal: controller.signal,
      permissionProfile: opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous",
      parentPermissionProfile: opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous",
      parentSandbox: false,
      sandbox: false,
      mode: "review",
      role: "fission-judge",
      credentialBroker: judgeLaunch.credential.mode,
      brokerRuntimeCredential: judgeLaunch.credential.runtimeCredential,
      maxCostUsd: judgeReservation.budgetUsd,
      maxOutputBytes: FISSION_OUTPUT_LIMIT,
      requireExactModelAttestation: true,
    });
    rawResults.push(judgeResult);
    writeArtifact("judge.raw.txt", judgeResult?.text || "");
    const failure = childFailure(judgeResult);
    if (failure) throw new Error(failure);
    const usageError = observedUsageError(judgeResult, judgeReservation.budgetUsd);
    if (usageError) throw new Error(usageError);
    if (!judgeResult.actualModel) throw new Error("actual_model_missing");
    if (judgeResult.actualModel !== selected.judgeModel) throw new Error("actual_model_mismatch");
    const output = parseStrictJsonObject(judgeResult.text);
    validateJudgeOutput({ output, findings: submitted, packet: capture });
    judge = {
      requestedModel: selected.judgeModel,
      actualModel: judgeResult.actualModel,
      status: "ok",
      valid: true,
      malformed: false,
      output,
      error: null,
      usage: judgeResult.usage,
    };
    writeArtifact("judge.json", judge);
    if (!judgeResult) writeArtifact("judge.raw.txt", "");
  } catch (error) {
    const message = String(error?.message || error);
    const cancelled = opts.signal?.aborted || message === "aborted";
    const judgeError = cancelled
      ? "aborted"
      : message === "boom" ? "child_failed" : message;
    judge = {
      requestedModel: selected.judgeModel,
      actualModel: judgeResult?.actualModel ?? null,
      status: "fail",
      valid: false,
      malformed: message === "judge_schema" || message.startsWith("strict_json"),
      output: null,
      error: judgeError,
      usage: judgeResult?.usage || { cost: null, costKnown: false },
    };
    writeArtifact("judge.json", judge);
    recordFailure(judgeError, cancelled ? "ABORTED" : "INCOMPLETE");
  } finally {
    try {
      deps.settleAgentLaunch(
        judgeReservation,
        judgeResult?.usage || { cost: null, costKnown: false },
      );
    } catch {
      judge = {
        ...(judge || {
          requestedModel: selected.judgeModel,
          actualModel: judgeResult?.actualModel ?? null,
          malformed: false,
          output: null,
          usage: judgeResult?.usage || { cost: null, costKnown: false },
        }),
        status: "fail",
        valid: false,
        error: "settlement_failed",
      };
      terminalError = "settlement_failed";
      terminalStatus = "INCOMPLETE";
      controller.abort("settlement_failed");
      writeArtifact("judge.json", judge);
    }
  }
  if (terminalError) {
    return persist({ status: terminalStatus, error: terminalError });
  }
  if (!judge.valid) return persist({ status: "INCOMPLETE", error: judge.error });

  const sourceD = deps.recaptureFissionSource(capture, gitDeps());
  if (checkDeadline()) return persist({ status: terminalStatus, error: terminalError });
  if (!sourceD.ok) return persist({ status: "INCOMPLETE", error: sourceD.reason || "source_drift" });
  if (!deps.verifyFissionArtifacts(capture).ok) {
    return persist({ status: "INCOMPLETE", error: "packet_drift" });
  }
  if (checkDeadline()) return persist({ status: terminalStatus, error: terminalError });
  const normalized = normalizeClusters(judge.output, submitted);
  const host = deriveFissionResult({
    // Subject mode has no repo preflight; synthesize READY for host checks.
    preflight: packetMode === "subject"
      ? { state: "READY" }
      : preflight,
    packet: capture,
    sourceVerified: true,
    artifactsVerified: true,
    requestedReviewers: selectedReviewers,
    reviewers,
    judge,
  });
  let error = null;
  if (judge.output.judgeConcern) error = "judge_concern";
  else if (normalized.unresolvedFindings.length) error = "unresolved_findings";
  if (error) controller.abort(error);
  if (host.verdict === "PASS" || host.verdict === "FAIL") {
    const failed = blockingFinding(normalized.validatedFindings, blockingSeverity);
    host.verdict = failed ? "FAIL" : "PASS";
    host.message = failed
      ? "a submitted blocking finding was validated."
      : "no submitted blocking finding validated.";
  }
  const status = host.verdict === "PASS" || host.verdict === "FAIL" ? "COMPLETE" : "INCOMPLETE";
  const modelDiversity = buildModelDiversity({
    requestedModels: [...selected.reviewerModels, selected.judgeModel],
    actualModels: [...reviewers.map((item) => item.actualModel), judge.actualModel],
    modelFamilies: cfg.fission?.modelFamilies,
  });
  writeArtifact("dispositions.json", normalized);
  return persist({
    status,
    verdict: host.verdict,
    message: host.message,
    error,
    modelDiversity,
    ...normalized,
  });
}

export function runFission(opts, dependencies = {}) {
  return runFissionWithDependencies(opts, dependencies);
}
