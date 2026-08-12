/**
 * /forge pipeline spine:
 *   fusion (multi-model plan) → fission (adversarial review) → auto (implement)
 *   → fission (post-build review when a diff exists)
 *
 * Shared artifacts under one run root:
 *   runs/<project>/<forgeRunId>/
 *     forge.json, request.md, events.jsonl, summary.json
 *     fusion/ | fission-plan/ | auto/ | fission-diff/
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunDir as defaultCreateRunDir } from "./auto-workflow.mjs";
import { runAutoWorkflowWithDependencies } from "./auto-workflow.mjs";
import { runFusionWithDependencies } from "./fusion.mjs";
import { runFissionWithDependencies } from "./fission.mjs";
import {
  createPanelState,
  upsertAgent,
  setPhase,
  renderPanelLines,
} from "./agent-panel.mjs";
import {
  prepareAgentLaunch,
  prepareExactAgentLaunch,
} from "./agent-orchestration.mjs";
import {
  getAgentSpentCost,
  getRunningAgentCount,
  reserveAgentLaunch,
  settleAgentLaunch,
} from "./agent-registry.mjs";
import { runChildAgent } from "./child-runner.mjs";
import {
  DEFAULT_FISSION_WORKFLOW_TIMEOUT_MS,
  loadConfig,
} from "./config.mjs";
import { loadCredentialLeaseForModels } from "./credential-broker.mjs";
import { recordRun } from "./run-index.mjs";
import {
  resolveImplementPermissionProfile,
  assertImplementProfileReady,
} from "./implement-policy.mjs";

function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function save(runDir, name, data) {
  const path = join(runDir, name);
  const body = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return path;
}

function appendEvent(runDir, event) {
  const path = join(runDir, "events.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, prev + line, "utf8");
}

function ensurePhaseDir(forgeRunDir, phase) {
  const dir = join(forgeRunDir, phase);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "agents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "checks"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "patches"), { recursive: true, mode: 0o700 });
  return dir;
}

function phaseCreateRunDir(forgeRunDir, phase) {
  return function createRunDir(_cwd, _runId) {
    return ensurePhaseDir(forgeRunDir, phase);
  };
}

function truncate(text, max = 12_000) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `…${s.slice(-max)}`;
}

function formatFissionFindings(result) {
  if (!result) return "(no fission result)";
  const lines = [
    `status: ${result.status}`,
    `verdict: ${result.verdict || "n/a"}`,
    `message: ${result.message || ""}`,
  ];
  if (result.error) lines.push(`error: ${result.error}`);
  const validated = result.validatedFindings || [];
  if (validated.length) {
    lines.push("", "Validated findings:");
    for (const finding of validated.slice(0, 20)) {
      lines.push(
        `- [${finding.adjudicatedSeverity || "?"}] ${finding.claim || JSON.stringify(finding)}`,
      );
    }
  } else {
    lines.push("", "Validated findings: none");
  }
  const unresolved = result.unresolvedFindings || [];
  if (unresolved.length) {
    lines.push("", "Unresolved:");
    for (const finding of unresolved.slice(0, 10)) {
      lines.push(`- ${finding.claim || JSON.stringify(finding)}`);
    }
  }
  return lines.join("\n");
}

function fissionBlocks(result) {
  if (!result) return false;
  if (result.status === "REFUSED") return true;
  if (result.status === "ABORTED") return true;
  if (result.status === "INCOMPLETE" && result.error && result.error !== "workflow_timeout") {
    // Soft skips: NO_CHANGES handled separately
    if (result.error === "reviewer_models" || result.error === "judge_model") return true;
    if (result.error === "orchestration_disabled") return true;
  }
  if (result.status === "COMPLETE" && result.verdict === "FAIL") return true;
  return false;
}

/**
 * @param {object} opts
 * @param {object} [dependencies]
 */
export async function runForgeWithDependencies(opts = {}, dependencies = {}) {
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request || "").trim();
  if (!request) throw new Error("forge: empty request");

  const createRunDir = dependencies.createRunDir || defaultCreateRunDir;
  const runFusion = dependencies.runFusionWithDependencies || runFusionWithDependencies;
  const runFission = dependencies.runFissionWithDependencies || runFissionWithDependencies;
  const runAuto = dependencies.runAutoWorkflowWithDependencies || runAutoWorkflowWithDependencies;

  const forgeRunId = opts.runId || newRunId();
  const forgeRunDir = createRunDir(cwd, forgeRunId);

  const panel = createPanelState({
    title: "ALLOY FORGE",
    runId: forgeRunId,
  });
  const emit = () => opts.onPanel?.(panel);
  const progress = (msg) => {
    appendEvent(forgeRunDir, { type: "progress", msg });
    opts.onProgress?.(msg);
  };

  const phases = {
    fusion: null,
    fissionPlan: null,
    auto: null,
    fissionDiff: null,
  };

  const mark = (role, status, detail = "") => {
    upsertAgent(panel, { role, status, detail });
    emit();
  };

  mkdirSync(join(forgeRunDir, "phases"), { recursive: true, mode: 0o700 });
  save(forgeRunDir, "request.md", `# Forge objective\n\n${request}\n`);
  save(forgeRunDir, "forge.json", {
    version: 1,
    kind: "forge",
    runId: forgeRunId,
    request,
    phases: ["fusion", "fission-plan", "auto", "fission-diff"],
    startedAt: new Date().toISOString(),
  });
  appendEvent(forgeRunDir, { type: "forge_start", runId: forgeRunId });

  for (const role of ["fusion", "fission-plan", "auto", "fission-diff"]) {
    mark(role, "pending", "queued");
  }
  setPhase(panel, "FUSION");
  emit();

  const parentPolicy = {
    permissionProfile: opts.parentPermissionProfile || opts.permissionProfile,
    parentPermissionProfile: opts.parentPermissionProfile || opts.permissionProfile,
    sandbox: opts.parentSandbox ?? opts.sandbox,
    parentSandbox: opts.parentSandbox ?? opts.sandbox,
  };

  // ─── 1. FUSION ─────────────────────────────────────────────
  mark("fusion", "running", "planning…");
  progress("forge: fusion…");
  let fusionSummary;
  try {
    fusionSummary = await runFusion(
      {
        request,
        cwd,
        signal: opts.signal,
        modelRegistry: opts.modelRegistry,
        timeoutMs: opts.fusionTimeoutMs || opts.timeoutMs || 300_000,
        onProgress: (msg) => progress(`fusion: ${msg}`),
        onPanel: (p) => {
          // keep forge panel primary; still forward detail
          mark("fusion", "running", p?.phase || "running");
        },
        ...parentPolicy,
        mode: "plan",
      },
      {
        createRunDir: phaseCreateRunDir(forgeRunDir, "fusion"),
        loadConfig: dependencies.loadConfig || loadConfig,
        prepareAgentLaunch: dependencies.prepareAgentLaunch || prepareAgentLaunch,
        loadCredentialLease:
          dependencies.loadCredentialLease || loadCredentialLeaseForModels,
        runChildAgent: dependencies.runChildAgent || runChildAgent,
        getAgentSpentCost: dependencies.getAgentSpentCost || getAgentSpentCost,
        getRunningAgentCount: dependencies.getRunningAgentCount || getRunningAgentCount,
        reserveAgentLaunch: dependencies.reserveAgentLaunch || reserveAgentLaunch,
        settleAgentLaunch: dependencies.settleAgentLaunch || settleAgentLaunch,
      },
    );
  } catch (error) {
    mark("fusion", "fail", String(error?.message || error));
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "FAILED",
      error: String(error?.message || error),
      pass: false,
    });
  }
  phases.fusion = {
    status: fusionSummary?.status,
    runDir: fusionSummary?.runDir,
    error: fusionSummary?.error || null,
    synthesisOk: Boolean(fusionSummary?.synthesizer?.ok),
  };
  save(forgeRunDir, "phases/fusion.json", phases.fusion);

  if (fusionSummary?.status !== "COMPLETE") {
    mark("fusion", "fail", fusionSummary?.error || fusionSummary?.status || "failed");
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "FAILED",
      error: fusionSummary?.error || `fusion_${String(fusionSummary?.status || "failed").toLowerCase()}`,
      pass: false,
      fusion: fusionSummary,
    });
  }
  mark("fusion", "ok", "synthesis ready");
  const synthesis = truncate(fusionSummary.synthesis || "", 16_000);

  if (opts.signal?.aborted) {
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "ABORTED",
      error: "aborted",
      pass: false,
      fusion: fusionSummary,
    });
  }

  // ─── 2. FISSION (plan / pre-build) ─────────────────────────
  setPhase(panel, "FISSION_PLAN");
  mark("fission-plan", "running", "reviewing plan…");
  progress("forge: fission (plan)…");

  const fissionPlanRequest = [
    "Pre-implementation adversarial review for a Forge run.",
    "Review the plan/synthesis below as freeform subject matter (not a git diff).",
    "Focus on plan risk: security, correctness, operability, and missing requirements.",
    "",
    "## Objective",
    request,
    "",
    "## Fusion synthesis",
    synthesis || "(empty synthesis)",
  ].join("\n");

  const cfgEarly = (dependencies.loadConfig || loadConfig)(cwd);
  const fissionTimeoutMs =
    opts.fissionTimeoutMs ||
    opts.timeoutMs ||
    cfgEarly.fission?.workflowTimeoutMs ||
    DEFAULT_FISSION_WORKFLOW_TIMEOUT_MS;

  const fissionPlan = await runFission(
    {
      request: fissionPlanRequest,
      cwd,
      signal: opts.signal,
      modelRegistry: opts.modelRegistry,
      timeoutMs: fissionTimeoutMs,
      defaultReviewers: opts.defaultReviewers,
      maxReviewers: opts.maxReviewers,
      reviewers: opts.reviewers,
      ...parentPolicy,
      // Force subject mode: plan review must not depend on a dirty tree.
      fissionMode: "subject",
    },
    {
      createRunDir: phaseCreateRunDir(forgeRunDir, "fission-plan"),
      loadConfig: dependencies.loadConfig || loadConfig,
      prepareExactAgentLaunch:
        dependencies.prepareExactAgentLaunch || prepareExactAgentLaunch,
      runChildAgent: dependencies.runChildAgent || runChildAgent,
      getAgentSpentCost: dependencies.getAgentSpentCost || getAgentSpentCost,
      getRunningAgentCount: dependencies.getRunningAgentCount || getRunningAgentCount,
      reserveAgentLaunch: dependencies.reserveAgentLaunch || reserveAgentLaunch,
      settleAgentLaunch: dependencies.settleAgentLaunch || settleAgentLaunch,
    },
  );
  phases.fissionPlan = {
    status: fissionPlan.status,
    verdict: fissionPlan.verdict,
    error: fissionPlan.error,
    runDir: fissionPlan.runDir,
    runId: fissionPlan.runId,
  };
  save(forgeRunDir, "phases/fission-plan.json", {
    ...phases.fissionPlan,
    validatedFindings: fissionPlan.validatedFindings || [],
  });

  if (fissionPlan.status === "NO_CHANGES") {
    mark("fission-plan", "ok", "no diff yet — skipped evidence review");
  } else if (fissionBlocks(fissionPlan)) {
    mark(
      "fission-plan",
      "fail",
      fissionPlan.verdict || fissionPlan.error || fissionPlan.status,
    );
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "FAILED",
      error:
        fissionPlan.verdict === "FAIL"
          ? "fission_plan_fail"
          : fissionPlan.error || "fission_plan_blocked",
      pass: false,
      fusion: fusionSummary,
      fissionPlan,
    });
  } else {
    mark("fission-plan", "ok", fissionPlan.verdict || fissionPlan.status);
  }

  if (opts.signal?.aborted) {
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "ABORTED",
      error: "aborted",
      pass: false,
      fusion: fusionSummary,
      fissionPlan,
    });
  }

  // ─── 3. AUTO (implement) ───────────────────────────────────
  setPhase(panel, "AUTO");
  mark("auto", "running", "implementing…");
  progress("forge: auto…");

  const cfg = (dependencies.loadConfig || loadConfig)(cwd);
  const implementResolved = resolveImplementPermissionProfile(cfg, {
    implementPermissionProfile: opts.implementPermissionProfile,
    forceSandbox: opts.forceSandbox,
    permissionProfile:
      opts.permissionProfile || opts.parentPermissionProfile || cfg.permissionProfile,
    parentPermissionProfile:
      opts.parentPermissionProfile || opts.permissionProfile || cfg.permissionProfile,
  });
  if (implementResolved.sandbox) {
    const ready = assertImplementProfileReady(implementResolved);
    if (!ready.ok) {
      mark("auto", "fail", "sandbox unavailable");
      return finishForge({
        forgeRunDir,
        forgeRunId,
        request,
        panel,
        phases,
        status: "FAILED",
        error: ready.error,
        pass: false,
        fusion: fusionSummary,
        fissionPlan,
      });
    }
  }

  const forgeContext = [
    "## Fusion synthesis",
    synthesis || "(empty)",
    "",
    "## Pre-build fission",
    formatFissionFindings(fissionPlan),
  ].join("\n");

  let autoSummary;
  try {
    autoSummary = await runAuto(
      {
        request: `Forge implementation for:\n${request}`,
        forgeContext,
        cwd,
        signal: opts.signal,
        modelRegistry: opts.modelRegistry,
        timeoutMs: opts.autoTimeoutMs || opts.timeoutMs,
        onProgress: (msg) => progress(`auto: ${msg}`),
        onPanel: () => mark("auto", "running", "pipeline…"),
        implementPermissionProfile: implementResolved.profile,
        permissionProfile: implementResolved.profile,
        parentPermissionProfile: implementResolved.profile,
        sandbox: implementResolved.sandbox,
        parentSandbox: implementResolved.sandbox,
        mode: "build",
      },
      {
        createRunDir: phaseCreateRunDir(forgeRunDir, "auto"),
        loadConfig: dependencies.loadConfig || loadConfig,
        prepareAgentLaunch: dependencies.prepareAgentLaunch || prepareAgentLaunch,
        runChildAgent: dependencies.runChildAgent || runChildAgent,
        getAgentSpentCost: dependencies.getAgentSpentCost || getAgentSpentCost,
        getRunningAgentCount: dependencies.getRunningAgentCount || getRunningAgentCount,
        reserveAgentLaunch: dependencies.reserveAgentLaunch || reserveAgentLaunch,
        settleAgentLaunch: dependencies.settleAgentLaunch || settleAgentLaunch,
      },
    );
  } catch (error) {
    mark("auto", "fail", String(error?.message || error));
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "FAILED",
      error: String(error?.message || error),
      pass: false,
      fusion: fusionSummary,
      fissionPlan,
    });
  }

  phases.auto = {
    status: autoSummary?.status,
    pass: autoSummary?.pass,
    reviewVerdict: autoSummary?.reviewVerdict,
    runDir: autoSummary?.runDir,
    worktree: autoSummary?.worktree || null,
    error: autoSummary?.error || null,
  };
  save(forgeRunDir, "phases/auto.json", phases.auto);

  if (!autoSummary?.pass) {
    mark("auto", "fail", autoSummary?.error || autoSummary?.status || "failed");
    // Still attempt post-diff fission if worktree/diff may exist
  } else {
    mark("auto", "ok", autoSummary.reviewVerdict || "COMPLETE");
  }

  if (opts.signal?.aborted) {
    return finishForge({
      forgeRunDir,
      forgeRunId,
      request,
      panel,
      phases,
      status: "ABORTED",
      error: "aborted",
      pass: false,
      fusion: fusionSummary,
      fissionPlan,
      auto: autoSummary,
    });
  }

  // ─── 4. FISSION (post-build diff) ──────────────────────────
  setPhase(panel, "FISSION_DIFF");
  mark("fission-diff", "running", "reviewing implementation…");
  progress("forge: fission (diff)…");

  const fissionCwd =
    autoSummary?.worktree?.path && existsSync(autoSummary.worktree.path)
      ? autoSummary.worktree.path
      : cwd;

  const fissionDiffRequest = [
    "Post-implementation adversarial review for a Forge run.",
    "Review the actual code changes against the objective and fusion plan.",
    "",
    "## Objective",
    request,
    "",
    "## Fusion synthesis (plan)",
    synthesis || "(empty)",
    "",
    "## Auto summary",
    `status: ${autoSummary?.status}`,
    `verdict: ${autoSummary?.reviewVerdict}`,
    `pass: ${autoSummary?.pass}`,
  ].join("\n");

  const fissionDiff = await runFission(
    {
      request: fissionDiffRequest,
      cwd: fissionCwd,
      signal: opts.signal,
      modelRegistry: opts.modelRegistry,
      timeoutMs: fissionTimeoutMs,
      defaultReviewers: opts.defaultReviewers,
      maxReviewers: opts.maxReviewers,
      reviewers: opts.reviewers,
      ...parentPolicy,
      mode: "review",
    },
    {
      createRunDir: phaseCreateRunDir(forgeRunDir, "fission-diff"),
      loadConfig: dependencies.loadConfig || loadConfig,
      prepareExactAgentLaunch:
        dependencies.prepareExactAgentLaunch || prepareExactAgentLaunch,
      runChildAgent: dependencies.runChildAgent || runChildAgent,
      getAgentSpentCost: dependencies.getAgentSpentCost || getAgentSpentCost,
      getRunningAgentCount: dependencies.getRunningAgentCount || getRunningAgentCount,
      reserveAgentLaunch: dependencies.reserveAgentLaunch || reserveAgentLaunch,
      settleAgentLaunch: dependencies.settleAgentLaunch || settleAgentLaunch,
    },
  );
  phases.fissionDiff = {
    status: fissionDiff.status,
    verdict: fissionDiff.verdict,
    error: fissionDiff.error,
    runDir: fissionDiff.runDir,
    cwd: fissionCwd,
  };
  save(forgeRunDir, "phases/fission-diff.json", {
    ...phases.fissionDiff,
    validatedFindings: fissionDiff.validatedFindings || [],
  });

  if (fissionDiff.status === "NO_CHANGES") {
    mark("fission-diff", "ok", "no reviewable diff");
  } else if (fissionBlocks(fissionDiff)) {
    mark(
      "fission-diff",
      "fail",
      fissionDiff.verdict || fissionDiff.error || fissionDiff.status,
    );
  } else {
    mark("fission-diff", "ok", fissionDiff.verdict || fissionDiff.status);
  }

  const autoPass = Boolean(autoSummary?.pass);
  const diffFail =
    fissionDiff.status === "COMPLETE" && fissionDiff.verdict === "FAIL";
  const pass = autoPass && !diffFail;
  let status = "COMPLETE";
  let error = null;
  if (!autoPass && diffFail) {
    status = "FAILED";
    error = "auto_and_fission_diff_fail";
  } else if (!autoPass) {
    status = "FAILED";
    error = autoSummary?.error || "auto_failed";
  } else if (diffFail) {
    status = "FAILED";
    error = "fission_diff_fail";
  }

  return finishForge({
    forgeRunDir,
    forgeRunId,
    request,
    panel,
    phases,
    status,
    error,
    pass,
    fusion: fusionSummary,
    fissionPlan,
    auto: autoSummary,
    fissionDiff,
  });
}

function finishForge(input) {
  const {
    forgeRunDir,
    forgeRunId,
    request,
    panel,
    phases,
    status,
    error = null,
    pass = false,
    fusion = null,
    fissionPlan = null,
    auto = null,
    fissionDiff = null,
  } = input;

  setPhase(panel, status);
  const summary = {
    kind: "forge",
    runId: forgeRunId,
    runDir: forgeRunDir,
    request,
    status,
    pass,
    error,
    phases,
    fusion: fusion
      ? {
          status: fusion.status,
          runDir: fusion.runDir,
          error: fusion.error || null,
          synthesis: truncate(fusion.synthesis || "", 4000),
        }
      : null,
    fissionPlan: fissionPlan
      ? {
          status: fissionPlan.status,
          verdict: fissionPlan.verdict,
          error: fissionPlan.error,
          runDir: fissionPlan.runDir,
        }
      : null,
    auto: auto
      ? {
          status: auto.status,
          pass: auto.pass,
          reviewVerdict: auto.reviewVerdict,
          runDir: auto.runDir,
          worktree: auto.worktree || null,
          error: auto.error || null,
        }
      : null,
    fissionDiff: fissionDiff
      ? {
          status: fissionDiff.status,
          verdict: fissionDiff.verdict,
          error: fissionDiff.error,
          runDir: fissionDiff.runDir,
        }
      : null,
    panel: renderPanelLines(panel),
    finishedAt: new Date().toISOString(),
  };

  save(forgeRunDir, "summary.json", summary);
  save(forgeRunDir, "forge.json", {
    version: 1,
    kind: "forge",
    runId: forgeRunId,
    request,
    status,
    pass,
    error,
    phases: summary.phases,
    finishedAt: summary.finishedAt,
  });
  appendEvent(forgeRunDir, { type: "forge_done", status, pass, error });
  try {
    recordRun({
      kind: "forge",
      cwd: opts.cwd || process.cwd(),
      runId: forgeRunId,
      runDir: forgeRunDir,
      status,
      pass,
      error,
      meta: {
        fusion: summary.fusion?.status,
        fissionPlan: summary.fissionPlan?.status,
        auto: summary.auto?.status,
        fissionDiff: summary.fissionDiff?.status,
      },
    });
  } catch {
    // best-effort
  }
  return summary;
}

export function runForge(opts) {
  return runForgeWithDependencies(opts, {});
}
