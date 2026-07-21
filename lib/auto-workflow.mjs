/**
 * Alloy /auto state machine (v1):
 * CREATED → SCOUTING → PLANNING → CHECKPOINTING → BUILDING → CHECKING → REVIEWING → COMPLETE
 * Failures → FAILED; abort → ABORTED
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

export const AUTO_STATES = [
  "CREATED",
  "SCOUTING",
  "PLANNING",
  "CHECKPOINTING",
  "BUILDING",
  "CHECKING",
  "REVIEWING",
  "COMPLETE",
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
    reviewer: `You are Alloy Reviewer. Independent review of the work against the plan.
Findings first (severity-ordered). Do not implement fixes unless critical correctness is broken.
State PASS or FAIL at the end.`,
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

/**
 * @param {{ request: string, cwd?: string, signal?: AbortSignal, onProgress?: (msg: string) => void, useWorktree?: boolean, models?: Record<string,string> }} opts
 */
export async function runAutoWorkflow(opts) {
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request || "").trim();
  if (!request) throw new Error("auto: empty request");

  const cfg = loadConfig(cwd);
  const models = {
    scout: opts.models?.scout || cfg.roles?.scout?.model,
    planner: opts.models?.planner || cfg.roles?.planner?.model,
    builder: opts.models?.builder || cfg.roles?.builder?.model,
    reviewer: opts.models?.reviewer || cfg.roles?.reviewer?.model,
  };

  const runId = newRunId();
  const runDir = createRunDir(cwd, runId);
  const prompts = rolePrompts();
  const useWorktree = opts.useWorktree !== false && isGitRepo(cwd);

  /** @type {any} */
  const state = {
    runId,
    runDir,
    request,
    status: "CREATED",
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
        maxFixRounds: cfg.budgets?.maxFixRounds ?? 2,
      },
    },
    agents: {},
    checkpoint: null,
    worktree: null,
    diagnostics: null,
    error: null,
  };

  save(runDir, "request.md", `# Auto request\n\n${request}\n`);
  save(runDir, "contract.json", state.contract);
  appendEvent(runDir, { type: "created", runId });

  const progress = (msg) => {
    appendEvent(runDir, { type: "progress", msg });
    opts.onProgress?.(msg);
  };

  const runRole = async (role, tools, extraUser) => {
    progress(`${role}…`);
    state.status = role === "scout" ? "SCOUTING"
      : role === "planner" ? "PLANNING"
      : role === "builder" ? "BUILDING"
      : role === "reviewer" ? "REVIEWING"
      : state.status;

    const workCwd = role === "builder" && state.worktree?.path
      ? state.worktree.path
      : cwd;

    const result = await runChildAgent({
      prompt: `${extraUser}\n\n## User request\n${request}`,
      cwd: workCwd,
      model: models[role],
      tools,
      systemPrompt: prompts[role],
      timeoutMs: opts.timeoutMs || 300_000,
      signal: opts.signal,
    });

    state.agents[role] = {
      ok: result.ok,
      text: result.text,
      error: result.error,
      usage: result.usage,
      model: result.model,
      exitCode: result.exitCode,
      stderr: (result.stderr || "").slice(0, 4000),
    };
    save(runDir, join("agents", `${role}.md`), `# ${role}\n\n${result.text || result.error || "(empty)"}\n`);
    appendEvent(runDir, { type: "agent_done", role, ok: result.ok, error: result.error });
    return result;
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
    progress("checkpoint…");
    if (isGitRepo(cwd)) {
      try {
        state.checkpoint = createCheckpoint(`auto:${runId}`, cwd);
        save(runDir, "checkpoint.json", state.checkpoint);
      } catch (err) {
        state.checkpoint = { error: String(err.message || err) };
      }
    }

    // WORKTREE for builder
    if (useWorktree) {
      try {
        state.worktree = createWorktree({ taskId: runId, role: "builder", cwd });
        save(runDir, "worktree.json", state.worktree);
        progress(`worktree ${state.worktree.id}`);
      } catch (err) {
        state.worktree = { error: String(err.message || err) };
        progress(`worktree skipped: ${state.worktree.error}`);
      }
    }

    // BUILD
    const build = await runRole(
      "builder",
      BUILD_TOOLS,
      `Implement this plan. Stay focused.\n\n## Plan\n${plan.text || plan.error || "(none)"}\n\n## Scout\n${scout.text || ""}`,
    );

    // Capture worktree diff
    if (state.worktree?.id && !state.worktree.error) {
      try {
        const d = worktreeDiff(state.worktree.id, cwd);
        save(runDir, "patches/worktree.diff", d.diff || "(empty)");
        save(runDir, "patches/worktree.stat.txt", d.stat || "");
      } catch {
        // ignore
      }
    }

    // CHECK
    state.status = "CHECKING";
    progress("diagnostics…");
    const diagCwd = state.worktree?.path || cwd;
    state.diagnostics = runDiagnostics(diagCwd, { includeTests: true });
    save(runDir, "checks/diagnostics.json", state.diagnostics);
    save(runDir, "checks/summary.txt", state.diagnostics.summary || "");

    // REVIEW
    const review = await runRole(
      "reviewer",
      READ_TOOLS,
      `Review the implementation against the plan and diagnostics.\n\n## Plan\n${plan.text || ""}\n\n## Builder summary\n${build.text || build.error || ""}\n\n## Diagnostics\n${state.diagnostics.summary || ""}\n`,
    );

    // Contract evidence
    const reviewPass = /\bPASS\b/i.test(review.text || "") && !/\bFAIL\b/i.test(review.text || "");
    const pass = Boolean(review.ok && state.diagnostics.ok && build.ok && (reviewPass || review.ok));

    if (pass) {
      state.contract.requirements[0].status = "done";
    } else if (plan.text || build.text || review.text) {
      state.contract.requirements[0].status = "partial";
    }

    state.status =
      opts.signal?.aborted ? "ABORTED"
        : build.error === "auth_required" || scout.error === "auth_required"
          ? "FAILED"
          : "COMPLETE";

    if (state.status === "FAILED" && (build.error === "auth_required" || scout.error === "auth_required")) {
      state.error = "auth_required";
    }

    const summary = {
      runId,
      status: state.status,
      request,
      runDir,
      checkpoint: state.checkpoint,
      worktree: state.worktree,
      diagnosticsOk: state.diagnostics?.ok,
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([k, v]) => [
          k,
          { ok: v.ok, error: v.error, model: v.model, usage: v.usage },
        ]),
      ),
      contract: state.contract,
      pass: Boolean(pass),
    };
    save(runDir, "summary.json", summary);
    save(
      runDir,
      "summary.md",
      [
        `# Auto run ${runId}`,
        "",
        `Status: **${state.status}**`,
        "",
        `Request: ${request}`,
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
    appendEvent(runDir, { type: "finished", status: state.status });

    return summary;
  } catch (err) {
    if (err?.code === "ABORTED" || opts.signal?.aborted) {
      state.status = "ABORTED";
      state.error = "aborted";
    } else {
      state.status = "FAILED";
      state.error = String(err?.message || err);
    }
    save(runDir, "summary.json", { runId, status: state.status, error: state.error, runDir });
    appendEvent(runDir, { type: "failed", error: state.error });
    throw err;
  }
}

export function loadRunSummary(runDir) {
  const p = join(runDir, "summary.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}
