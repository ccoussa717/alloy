/**
 * Alloy /auto state machine:
 * CREATED → SCOUTING → PLANNING → CHECKPOINTING → BUILDING → CHECKING → REVIEWING
 *   ↺ FIXING (bounded) when review FAIL or diagnostics fail
 * → COMPLETE | FAILED | ABORTED
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { getRunsDir, projectIdFromCwd } from "./paths.mjs";
import { createCheckpoint } from "./git-checkpoint.mjs";
import { createWorktree, worktreeDiff, isGitRepo } from "./worktree.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { runChildAgent } from "./child-runner.mjs";
import { loadConfig } from "./config.mjs";
import { withHonesty } from "./honesty.mjs";
import { resolveAutoStatus } from "./auto-status.mjs";
import {
  createPanelState,
  upsertAgent,
  setPhase,
  renderPanelLines,
  pushTickerEvent,
} from "./agent-panel.mjs";

export const AUTO_STATES = [
  "CREATED",
  "SCOUTING",
  "PLANNING",
  "CHECKPOINTING",
  "BUILDING",
  "CHECKING",
  "REVIEWING",
  "FIXING",
  "COMPLETE",
  "PARTIAL",
  "AUTH_REQUIRED",
  "FAILED",
  "ABORTED",
];

const READ_TOOLS = ["read", "grep", "find", "ls"];
const BUILD_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

function rolePrompts() {
  return {
    scout: `You are Alloy Scout. Map the repository relevant to the task.
Return: key files, architecture notes, risks, and suggested approach.
Do not modify files.`,
    planner: `You are Alloy Planner. Produce an executable plan with numbered steps,
requirements (R1, R2, …) each needing evidence, and constraints.
Do not modify files.`,
    builder: `You are Alloy Builder. Implement the plan. Make focused changes.
Run quick checks if possible. Summarize files changed and how to verify.`,
    fixer: `You are Alloy Fixer (builder in a fix round). Address review FAIL findings and
diagnostic failures only. Prefer minimal diffs. Summarize what you fixed.`,
    reviewer: `You are Alloy Reviewer. Independent review of the work against the plan.
Findings first (severity-ordered). Do not implement fixes.
End with a single final line that is exactly: VERDICT: PASS  or  VERDICT: FAIL
(Use FAIL if diagnostics failed or requirements are unmet.)`,
  };
}

function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createRunDir(cwd = process.cwd(), runId = newRunId()) {
  const dir = join(getRunsDir(), projectIdFromCwd(cwd), runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "checks"), { recursive: true });
  mkdirSync(join(dir, "patches"), { recursive: true });
  return dir;
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

/** Parse reviewer verdict. Prefer VERDICT: PASS/FAIL; fallback to bare PASS/FAIL. */
export function parseReviewVerdict(text) {
  const t = String(text || "");
  const m = t.match(/VERDICT:\s*(PASS|FAIL)\b/i);
  if (m) return m[1].toUpperCase();
  const lines = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || "";
  if (/^PASS\b/i.test(last) && !/FAIL/i.test(last)) return "PASS";
  if (/^FAIL\b/i.test(last)) return "FAIL";
  if (/\bVERDICT:\s*PASS\b/i.test(t)) return "PASS";
  if (/\bFAIL\b/i.test(t) && !/\bPASS\b/i.test(t)) return "FAIL";
  if (/\bPASS\b/i.test(t) && !/\bFAIL\b/i.test(t)) return "PASS";
  return "UNKNOWN";
}

/**
 * @param {{
 *   request: string,
 *   cwd?: string,
 *   signal?: AbortSignal,
 *   onProgress?: (msg: string) => void,
 *   onPanel?: (panel: any) => void,
 *   useWorktree?: boolean,
 *   models?: Record<string,string>,
 *   maxFixRounds?: number,
 *   timeoutMs?: number,
 * }} opts
 */
export async function runAutoWorkflow(opts) {
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request || "").trim();
  if (!request) throw new Error("auto: empty request");

  const cfg = loadConfig(cwd);
  const models = {
    scout: opts.models?.scout || cfg.roles?.scout?.model || undefined,
    planner: opts.models?.planner || cfg.roles?.planner?.model || undefined,
    builder: opts.models?.builder || cfg.roles?.builder?.model || undefined,
    fixer: opts.models?.fixer || cfg.roles?.fixer?.model || cfg.roles?.builder?.model || undefined,
    reviewer: opts.models?.reviewer || cfg.roles?.reviewer?.model || undefined,
  };

  const maxFixRounds = opts.maxFixRounds ?? cfg.budgets?.maxFixRounds ?? 2;
  const runId = newRunId();
  const runDir = createRunDir(cwd, runId);
  const prompts = rolePrompts();
  const useWorktree =
    opts.useWorktree !== false &&
    (cfg.auto?.useWorktree !== false) &&
    isGitRepo(cwd);

  const panel = createPanelState({
    title: "ALLOY AUTO",
    runId,
    maxFixRounds,
  });
  for (const role of ["scout", "planner", "builder", "reviewer"]) {
    upsertAgent(panel, {
      role,
      status: "pending",
      model: models[role] || undefined,
      detail: "queued",
    });
  }
  const emitPanel = () => opts.onPanel?.(panel);

  /** @type {any} */
  const state = {
    runId,
    runDir,
    request,
    status: "CREATED",
    fixRound: 0,
    maxFixRounds,
    contract: {
      taskId: runId,
      requirements: [
        {
          id: "R1",
          text: request,
          evidence: ["builder summary", "diagnostics", "review"],
          status: "pending",
        },
      ],
      budgets: {
        maxCostUsd: cfg.budgets?.maxCostUsd ?? 25,
        maxFixRounds,
      },
    },
    agents: {},
    fixRounds: [],
    checkpoint: null,
    worktree: null,
    diagnostics: null,
    reviewVerdict: null,
    error: null,
  };

  save(runDir, "request.md", `# Auto request\n\n${request}\n`);
  save(runDir, "contract.json", state.contract);
  appendEvent(runDir, { type: "created", runId });
  setPhase(panel, "CREATED");
  emitPanel();

  const progress = (msg) => {
    appendEvent(runDir, { type: "progress", msg });
    opts.onProgress?.(msg);
  };

  const runRole = async (role, tools, extraUser, { round, fileSuffix } = {}) => {
    const phase =
      role === "scout"
        ? "SCOUTING"
        : role === "planner"
          ? "PLANNING"
          : role === "builder"
            ? "BUILDING"
            : role === "fixer"
              ? "FIXING"
              : role === "reviewer"
                ? "REVIEWING"
                : state.status;
    state.status = phase;
    setPhase(panel, phase);
    panel.fixRound = state.fixRound;

    const agentRole = role === "fixer" ? "fixer" : role;
    upsertAgent(panel, {
      role: agentRole,
      round: round != null ? round : undefined,
      status: "running",
      model: models[role] || models.builder || undefined,
      startedAt: Date.now(),
      detail: "working…",
    });
    emitPanel();
    progress(`${role}${round != null ? ` round ${round}` : ""}…`);

    // Writers + reviewer + diagnostics-facing review must see the builder tree
    const workCwd =
      (role === "builder" ||
        role === "fixer" ||
        role === "reviewer") &&
      state.worktree?.path &&
      !state.worktree?.error
        ? state.worktree.path
        : cwd;

    const childModel = models[role] || models.builder || null;
    let provider = null;
    let modelId = childModel;
    if (childModel && String(childModel).includes("/")) {
      const [p, ...rest] = String(childModel).split("/");
      provider = p;
      modelId = rest.join("/") || childModel;
    }
    const systemPrompt = withHonesty(prompts[role] || prompts.builder, {
      provider,
      modelId,
      role: agentRole,
    });
    const result = await runChildAgent({
      prompt: `${extraUser}\n\n## User request\n${request}`,
      cwd: workCwd,
      model: childModel,
      tools,
      systemPrompt,
      timeoutMs: opts.timeoutMs || 300_000,
      signal: opts.signal,
      permissionProfile: opts.permissionProfile || "ask-dangerous",
      mode: role === "scout" || role === "planner" || role === "reviewer" ? "plan" : "build",
      sandbox: Boolean(opts.sandbox),
      role: agentRole,
      onEvent: (ev) => {
        if (ev?.type === "tool_execution_start" && ev.toolName) {
          const detail =
            typeof ev.args === "object" && ev.args
              ? String(
                  ev.args.command ||
                    ev.args.path ||
                    ev.args.file_path ||
                    ev.args.pattern ||
                    "",
                ).slice(0, 40)
              : "";
          pushTickerEvent({
            agent: agentRole,
            tool: ev.toolName,
            detail,
          });
          upsertAgent(panel, {
            role: agentRole,
            round,
            status: "running",
            detail: detail ? `${ev.toolName} ${detail}` : `${ev.toolName}`,
          });
          emitPanel();
        }
      },
    });

    const key = fileSuffix || role;
    state.agents[key] = {
      ok: result.ok,
      text: result.text,
      error: result.error,
      usage: result.usage,
      model: result.model,
      exitCode: result.exitCode,
      stderr: (result.stderr || "").slice(0, 4000),
      role,
      round,
    };
    save(
      runDir,
      join("agents", `${key}.md`),
      `# ${key}\n\n${result.text || result.error || "(empty)"}\n`,
    );
    appendEvent(runDir, {
      type: "agent_done",
      role,
      key,
      ok: result.ok,
      error: result.error,
    });

    upsertAgent(panel, {
      role: agentRole,
      round,
      status: result.ok ? "ok" : "fail",
      endedAt: Date.now(),
      usage: result.usage,
      model: result.model || models[role] || undefined,
      detail: result.error || (result.text || "").slice(0, 40) || "done",
    });
    emitPanel();
    return result;
  };

  const captureWorktreeDiff = (label) => {
    if (state.worktree?.id && !state.worktree.error) {
      try {
        const d = worktreeDiff(state.worktree.id, cwd);
        const suffix = label ? `-${label}` : "";
        save(runDir, `patches/worktree${suffix}.diff`, d.diff || "(empty)");
        save(runDir, `patches/worktree${suffix}.stat.txt`, d.stat || "");
        return d;
      } catch {
        return null;
      }
    }
    return null;
  };

  const runCheck = (label) => {
    state.status = "CHECKING";
    setPhase(panel, "CHECKING");
    emitPanel();
    progress(`diagnostics${label ? ` ${label}` : ""}…`);
    const diagCwd = state.worktree?.path || cwd;
    const diagnostics = runDiagnostics(diagCwd, { includeTests: true });
    state.diagnostics = diagnostics;
    const file = label ? `diagnostics-${label}.json` : "diagnostics.json";
    save(runDir, join("checks", file), diagnostics);
    save(
      runDir,
      join("checks", label ? `summary-${label}.txt` : "summary.txt"),
      diagnostics.summary || "",
    );
    return diagnostics;
  };

  try {
    // SCOUT
    const scout = await runRole(
      "scout",
      READ_TOOLS,
      "Scout the repository for this task. Be concise but specific about files.",
    );
    if (opts.signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });

    // PLAN
    const plan = await runRole(
      "planner",
      READ_TOOLS,
      `Using this scout report, write the plan.\n\n## Scout report\n${scout.text || scout.error || "(none)"}`,
    );

    // CHECKPOINT
    state.status = "CHECKPOINTING";
    setPhase(panel, "CHECKPOINTING");
    emitPanel();
    progress("checkpoint…");
    if (isGitRepo(cwd)) {
      try {
        state.checkpoint = createCheckpoint(`auto:${runId}`, cwd);
        save(runDir, "checkpoint.json", state.checkpoint);
      } catch (err) {
        state.checkpoint = { error: String(err.message || err) };
      }
    }

    // WORKTREE — fail closed for writers (never fall back to main checkout)
    if (useWorktree) {
      try {
        state.worktree = createWorktree({ taskId: runId, role: "builder", cwd });
        save(runDir, "worktree.json", state.worktree);
        progress(`worktree ${state.worktree.id}`);
      } catch (err) {
        state.worktree = { error: String(err.message || err) };
        save(runDir, "worktree.json", state.worktree);
        progress(`worktree failed: ${state.worktree.error}`);
        state.status = "FAILED";
        state.error = "worktree_failed";
        setPhase(panel, "FAILED");
        emitPanel();
        const summary = {
          runId,
          status: "FAILED",
          pass: false,
          error: "worktree_failed",
          worktree: state.worktree,
          request,
          runDir,
          panel: renderPanelLines(panel),
        };
        save(runDir, "summary.json", summary);
        appendEvent(runDir, { type: "finished", status: "FAILED", error: "worktree_failed" });
        return summary;
      }
    }

    // BUILD
    let build = await runRole(
      "builder",
      BUILD_TOOLS,
      `Implement this plan. Stay focused.\n\n## Plan\n${plan.text || plan.error || "(none)"}\n\n## Scout\n${scout.text || ""}`,
    );
    captureWorktreeDiff("build");

    // CHECK + REVIEW + FIX LOOP
    let diagnostics = runCheck("r0");
    let review = await runRole(
      "reviewer",
      READ_TOOLS,
      `Review the implementation against the plan and diagnostics.\n\n## Plan\n${plan.text || ""}\n\n## Builder summary\n${build.text || build.error || ""}\n\n## Diagnostics\n${diagnostics.summary || ""}\n`,
      { fileSuffix: "reviewer-r0" },
    );
    let verdict = parseReviewVerdict(review.text);
    state.reviewVerdict = verdict;

    const needsFix = () => {
      if (opts.signal?.aborted) return false;
      if (build.error === "auth_required" || review.error === "auth_required") return false;
      if (!diagnostics.ok && !diagnostics.skipped) return true;
      if (verdict === "FAIL") return true;
      // UNKNOWN with failed build also fix
      if (verdict === "UNKNOWN" && !build.ok) return true;
      return false;
    };

    while (needsFix() && state.fixRound < maxFixRounds) {
      state.fixRound += 1;
      panel.fixRound = state.fixRound;
      setPhase(panel, "FIXING");
      // Ensure fixer row exists in panel
      upsertAgent(panel, {
        role: "fixer",
        round: state.fixRound,
        status: "pending",
        detail: "queued",
      });
      emitPanel();
      progress(`fix round ${state.fixRound}/${maxFixRounds}…`);

      const fix = await runRole(
        "fixer",
        BUILD_TOOLS,
        `Fix the failures below. Minimal changes only.

## Plan
${plan.text || ""}

## Previous builder summary
${build.text || build.error || ""}

## Diagnostics
${diagnostics.summary || ""}

## Review (verdict ${verdict})
${review.text || review.error || ""}
`,
        { round: state.fixRound, fileSuffix: `fixer-r${state.fixRound}` },
      );

      captureWorktreeDiff(`fix${state.fixRound}`);
      diagnostics = runCheck(`r${state.fixRound}`);
      review = await runRole(
        "reviewer",
        READ_TOOLS,
        `Re-review after fix round ${state.fixRound}.

## Plan
${plan.text || ""}

## Fixer summary
${fix.text || fix.error || ""}

## Diagnostics
${diagnostics.summary || ""}
`,
        { round: state.fixRound, fileSuffix: `reviewer-r${state.fixRound}` },
      );
      verdict = parseReviewVerdict(review.text);
      state.reviewVerdict = verdict;
      build = fix; // latest implementation agent
      state.fixRounds.push({
        round: state.fixRound,
        verdict,
        diagnosticsOk: diagnostics.ok,
        fixerOk: fix.ok,
      });
      save(runDir, "fix-rounds.json", state.fixRounds);
    }

    const pass =
      verdict === "PASS" &&
      (diagnostics.ok || diagnostics.skipped) &&
      (build.ok || Boolean(build.text));

    // Cost budget (recorded previously but not enforced)
    let totalCost = 0;
    for (const a of Object.values(state.agents)) {
      totalCost += Number(a?.usage?.cost) || 0;
    }
    const maxCost = Number(cfg.budgets?.maxCostUsd);
    const overBudget =
      Number.isFinite(maxCost) && maxCost > 0 && totalCost > maxCost;

    if (pass && !overBudget) {
      state.contract.requirements[0].status = "done";
    } else if (plan.text || build.text || review.text) {
      state.contract.requirements[0].status = "partial";
    }

    const authFail =
      ["scout", "planner", "builder", "reviewer"].some(
        (r) =>
          state.agents[r]?.error === "auth_required" ||
          state.agents[`${r}-r0`]?.error === "auth_required",
      ) ||
      build.error === "auth_required" ||
      scout.error === "auth_required";

    const resolved = resolveAutoStatus({
      aborted: Boolean(opts.signal?.aborted),
      authFail,
      overBudget,
      pass,
      hasPartialOutput: Boolean(plan.text || build.text || review.text),
      worktreeFailed: Boolean(state.worktree?.error),
    });
    state.status = resolved.status;
    if (resolved.error) state.error = resolved.error;

    setPhase(panel, state.status);
    emitPanel();

    const summary = {
      runId,
      status: state.status,
      request,
      runDir,
      checkpoint: state.checkpoint,
      worktree: state.worktree,
      diagnosticsOk: state.diagnostics?.ok,
      reviewVerdict: state.reviewVerdict,
      fixRound: state.fixRound,
      maxFixRounds,
      fixRounds: state.fixRounds,
      totalCost,
      maxCostUsd: Number.isFinite(maxCost) ? maxCost : null,
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([k, v]) => [
          k,
          { ok: v.ok, error: v.error, model: v.model, usage: v.usage, role: v.role, round: v.round },
        ]),
      ),
      contract: state.contract,
      // Truthful: COMPLETE implies pass
      pass: resolved.pass,
      panel: renderPanelLines(panel),
      error: state.error,
    };
    save(runDir, "summary.json", summary);
    save(
      runDir,
      "summary.md",
      [
        `# Auto run ${runId}`,
        "",
        `Status: **${state.status}**`,
        `Verdict: **${state.reviewVerdict || "n/a"}**`,
        `Fix rounds: ${state.fixRound}/${maxFixRounds}`,
        "",
        `Request: ${request}`,
        "",
        `## Panel`,
        "```",
        ...renderPanelLines(panel),
        "```",
        "",
        `## Agents`,
        ...Object.entries(state.agents).map(
          ([k, v]) => `- ${k}: ${v.ok ? "ok" : "fail"}${v.error ? ` (${v.error})` : ""}`,
        ),
        "",
        `## Diagnostics`,
        state.diagnostics?.summary || "(none)",
        "",
        `## Artifacts`,
        runDir,
        "",
      ].join("\n"),
    );
    appendEvent(runDir, { type: "finished", status: state.status, verdict: state.reviewVerdict });
    return summary;
  } catch (err) {
    if (err?.code === "ABORTED" || opts.signal?.aborted) {
      state.status = "ABORTED";
      state.error = "aborted";
    } else {
      state.status = "FAILED";
      state.error = String(err?.message || err);
    }
    setPhase(panel, state.status);
    emitPanel();
    save(runDir, "summary.json", {
      runId,
      status: state.status,
      error: state.error,
      runDir,
      panel: renderPanelLines(panel),
    });
    appendEvent(runDir, { type: "failed", error: state.error });
    throw err;
  }
}

export function loadRunSummary(runDir) {
  const p = join(runDir, "summary.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}
