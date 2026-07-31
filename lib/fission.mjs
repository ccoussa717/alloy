import { mkdirSync, writeFileSync } from "node:fs";
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
  captureFissionPacket,
  preflightFissionRepository,
  recaptureFissionSource,
  verifyFissionArtifacts,
} from "./fission-packet.mjs";
import {
  deriveFissionResult,
  findingId,
  validateJudgeOutput,
  validateReviewerOutput,
} from "./fission-schema.mjs";
import { parseStrictJsonObject } from "./strict-json.mjs";

const READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, cost: 0, turns: 0, costKnown: true });

export const FISSION_ROLES = Object.freeze({
  1: Object.freeze(["general_adversarial"]),
  2: Object.freeze(["correctness_regressions", "security_trust_boundaries"]),
  3: Object.freeze(["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling"]),
  4: Object.freeze(["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling", "test_quality_spec_coverage"]),
  5: Object.freeze(["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling", "test_quality_spec_coverage", "performance_concurrency_resources"]),
});

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
  const source = String(text ?? "").trim();
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
  return { reviewerModels: reviewerModels.slice(0, count), judgeModel };
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
  return result?.error || "child_failed";
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

function reviewerPrompt(request, role) {
  return [
    "You are a blind specialist reviewer. Inspect only the immutable packet in your current directory.",
    `Specialty: ${role}`,
    "Use read-only tools. Do not modify files, infer peer identities, or discuss model routing.",
    "Return exactly one strict JSON object matching the reviewer contract.",
    `Review request: ${request}`,
  ].join("\n\n");
}

function judgePrompt(request, findings) {
  return [
    "You are the independent Fission judge. Adjudicate every anonymized finding against the immutable packet.",
    "Return exactly one strict JSON object matching the judge contract. Do not use duplicate as a disposition.",
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
    recaptureFissionSource,
    verifyFissionArtifacts,
    getRunningAgentCount,
    getAgentSpentCost,
    reserveAgentLaunch,
    settleAgentLaunch,
    runChildAgent,
    ...dependencies,
  };
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request ?? "").trim();
  const defaultReviewers = opts.defaultReviewers ?? 3;
  const maxReviewers = opts.maxReviewers ?? 5;
  const selectedReviewers = opts.reviewers === undefined ? defaultReviewers : opts.reviewers;
  const base = {
    request,
    requestedReviewers: selectedReviewers,
    blockingSeverity: opts.blockingSeverity || "high",
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

  const preflight = deps.preflightFissionRepository(cwd);
  if (preflight.state === "REFUSED") {
    return createFissionResult({
      ...base,
      status: "REFUSED",
      verdict: null,
      message: "repository review was refused.",
      error: preflight.reason || "preflight_refused",
    });
  }
  if (preflight.state === "NO_CHANGES") {
    return createFissionResult({
      ...base,
      status: "NO_CHANGES",
      verdict: null,
      message: "no changes to review.",
      error: null,
    });
  }
  if (preflight.state !== "READY") {
    return createFissionResult({ ...base, status: "REFUSED", verdict: null, error: "preflight_refused" });
  }

  const runDir = deps.createRunDir(cwd);
  const runId = basename(runDir);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const runBase = { ...base, runDir, runId };
  let blockingSeverity = base.blockingSeverity;
  let capture = null;
  let cfg;
  let selected;
  const reviewers = [];
  let judge = null;
  const rawResults = [];
  const persist = (input) => {
    const result = createFissionResult({
      ...runBase,
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
    save(runDir, "result.json", result);
    save(runDir, "report.md", reportFor(result));
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
  save(runDir, "host-manifest.json", {
    version: 1,
    request,
    requestedReviewers: selectedReviewers,
    reviewerRoles: FISSION_ROLES[selectedReviewers],
    reviewerModels: selected.reviewerModels,
    judgeModel: selected.judgeModel,
  });
  try {
    capture = deps.captureFissionPacket({
      cwd,
      packetRoot: join(runDir, "packet"),
      request,
      preflight,
    });
  } catch (error) {
    return persist({ status: "INCOMPLETE", error: String(error?.message || error) });
  }
  if (capture.evidenceComplete !== true) {
    return persist({ status: "INCOMPLETE", error: capture.reason || "evidence_incomplete" });
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromCaller();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let terminalError = null;
  let terminalStatus = "INCOMPLETE";
  const active = new Set();
  let queueIndex = 0;
  const roles = FISSION_ROLES[selectedReviewers];

  const recordFailure = (error, status = "INCOMPLETE") => {
    if (!terminalError) {
      terminalError = error;
      terminalStatus = status;
      controller.abort(error);
    }
  };

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
      launch = await deps.prepareExactAgentLaunch({
        task: request,
        profile: "review",
        model: requestedModel,
        tools: READ_TOOLS,
        cwd,
        modelRegistry: opts.modelRegistry,
        activeChildren: deps.getRunningAgentCount(cwd),
        spentCostUsd: deps.getAgentSpentCost(cwd),
      });
    } catch {
      recordFailure("routing_failed");
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
          prompt: reviewerPrompt(request, role),
          cwd: capture.packetRoot,
          readRoot: capture.packetRoot,
          model: requestedModel,
          tools: READ_TOOLS,
          timeoutMs: opts.timeoutMs || 300_000,
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
        });
        rawResults.push(result);
        save(runDir, `${alias.toLowerCase()}.raw.txt`, result?.text || "");
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
        save(runDir, `${alias.toLowerCase()}.json`, record);
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
        save(runDir, `${alias.toLowerCase()}.json`, record);
        if (!result) save(runDir, `${alias.toLowerCase()}.raw.txt`, "");
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

  try {
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
  } finally {
    opts.signal?.removeEventListener?.("abort", abortFromCaller);
  }
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

  const sourceC = deps.recaptureFissionSource(capture);
  if (!sourceC.ok) return persist({ status: "INCOMPLETE", error: sourceC.reason || "source_drift" });
  if (!deps.verifyFissionArtifacts(capture).ok) {
    return persist({ status: "INCOMPLETE", error: "packet_drift" });
  }
  const submitted = reviewers.flatMap((reviewer) =>
    reviewer.output.findings.map((item, index) => ({
      id: findingId(reviewer.alias, index, item),
      finding: item,
    })));
  let judgeLaunch;
  try {
    judgeLaunch = await deps.prepareExactAgentLaunch({
      task: request,
      profile: "review",
      model: selected.judgeModel,
      tools: READ_TOOLS,
      cwd,
      modelRegistry: opts.modelRegistry,
      activeChildren: deps.getRunningAgentCount(cwd),
      spentCostUsd: deps.getAgentSpentCost(cwd),
    });
  } catch {
    return persist({ status: "INCOMPLETE", error: "routing_failed" });
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
      prompt: judgePrompt(request, submitted),
      cwd: capture.packetRoot,
      readRoot: capture.packetRoot,
      model: selected.judgeModel,
      tools: READ_TOOLS,
      timeoutMs: opts.timeoutMs || 300_000,
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
    });
    rawResults.push(judgeResult);
    save(runDir, "judge.raw.txt", judgeResult?.text || "");
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
    save(runDir, "judge.json", judge);
    if (!judgeResult) save(runDir, "judge.raw.txt", "");
  } catch (error) {
    const message = String(error?.message || error);
    judge = {
      requestedModel: selected.judgeModel,
      actualModel: judgeResult?.actualModel ?? null,
      status: "fail",
      valid: false,
      malformed: message === "judge_schema" || message.startsWith("strict_json"),
      output: null,
      error: message === "boom" ? "child_failed" : message,
      usage: judgeResult?.usage || { cost: null, costKnown: false },
    };
    save(runDir, "judge.json", judge);
  } finally {
    try {
      deps.settleAgentLaunch(
        judgeReservation,
        judgeResult?.usage || { cost: null, costKnown: false },
      );
    } catch {
      if (judge) judge.error ||= "settlement_failed";
    }
  }
  if (!judge.valid) return persist({ status: "INCOMPLETE", error: judge.error });

  const sourceD = deps.recaptureFissionSource(capture);
  if (!sourceD.ok) return persist({ status: "INCOMPLETE", error: sourceD.reason || "source_drift" });
  if (!deps.verifyFissionArtifacts(capture).ok) {
    return persist({ status: "INCOMPLETE", error: "packet_drift" });
  }
  const normalized = normalizeClusters(judge.output, submitted);
  const host = deriveFissionResult({
    preflight,
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
  save(runDir, "dispositions.json", normalized);
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
