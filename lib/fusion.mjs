/**
 * Multi-model fusion: independent workers + attributed merger.
 * Never shares a worktree between parallel writers.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunDir } from "./auto-workflow.mjs";
import { runChildAgent } from "./child-runner.mjs";
import { loadConfig } from "./config.mjs";
import { createWorktree, worktreeDiff, isGitRepo } from "./worktree.mjs";
import {
  createPanelState,
  upsertAgent,
  setPhase,
  renderPanelLines,
} from "./agent-panel.mjs";

const READ_TOOLS = ["read", "grep", "find", "ls"];
const BUILD_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

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
 * Resolve worker models for fusion.
 * Prefers config.fusion.models, then favorites, then null (default model) x N.
 */
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

/**
 * @param {{
 *   request: string,
 *   mode?: 'plan'|'build',
 *   cwd?: string,
 *   models?: (string|null)[],
 *   signal?: AbortSignal,
 *   onPanel?: (panel: any) => void,
 *   onProgress?: (msg: string) => void,
 *   timeoutMs?: number,
 * }} opts
 */
export async function runFusion(opts) {
  const cwd = opts.cwd || process.cwd();
  const request = String(opts.request || "").trim();
  if (!request) throw new Error("fusion: empty request");

  const mode = opts.mode === "build" ? "build" : "plan";
  const cfg = loadConfig(cwd);
  const models = opts.models?.length
    ? opts.models
    : resolveFusionModels(cfg, cfg.fusion?.workerCount || 2);

  const runDir = createRunDir(cwd);
  mkdirSync(join(runDir, "fusion"), { recursive: true });
  mkdirSync(join(runDir, "workers"), { recursive: true });

  const panel = createPanelState({
    title: "ALLOY FUSION",
    runId: runDir.split(/[/\\]/).pop(),
  });
  setPhase(panel, "FUSING");
  const emit = () => opts.onPanel?.(panel);
  const progress = (msg) => {
    appendEvent(runDir, { type: "progress", msg });
    opts.onProgress?.(msg);
  };

  save(runDir, "request.md", `# Fusion (${mode})\n\n${request}\n`);
  save(runDir, "fusion/models.json", { mode, models });
  appendEvent(runDir, { type: "fusion_start", mode, models });

  for (let i = 0; i < models.length; i++) {
    upsertAgent(panel, {
      role: "worker",
      index: i + 1,
      status: "pending",
      model: models[i] || undefined,
      detail: "queued",
    });
  }
  upsertAgent(panel, { role: "merger", status: "pending", detail: "waiting" });
  emit();

  const tools = mode === "build" ? BUILD_TOOLS : READ_TOOLS;
  const workerPrompt =
    mode === "build"
      ? `You are an independent implementation worker in a multi-model fusion run.
Implement the request in this worktree only. Do not assume other workers exist.
Summarize what you changed and how to verify.`
      : `You are an independent analyst in a multi-model fusion run.
Investigate the request. Propose a concrete plan or answer.
Do not modify files. Be specific about files and risks.`;

  /** @type {any[]} */
  const workers = [];

  // Sequential workers for build (each needs own worktree prep); parallel for plan
  const runOne = async (i) => {
    const model = models[i];
    upsertAgent(panel, {
      role: "worker",
      index: i + 1,
      status: "running",
      model: model || undefined,
      startedAt: Date.now(),
      detail: "working…",
    });
    emit();
    progress(`worker ${i + 1}/${models.length}…`);

    let workCwd = cwd;
    let worktree = null;
    if (mode === "build" && isGitRepo(cwd)) {
      try {
        worktree = createWorktree({
          taskId: `fusion-${panel.runId}-w${i + 1}`,
          role: `fusion${i + 1}`,
          cwd,
        });
        workCwd = worktree.path;
      } catch (err) {
        worktree = { error: String(err.message || err) };
      }
    }

    const result = await runChildAgent({
      prompt: `${workerPrompt}\n\n## Request\n${request}\n\nWorker index: ${i + 1} of ${models.length}`,
      cwd: workCwd,
      model: model || undefined,
      tools,
      systemPrompt: workerPrompt,
      timeoutMs: opts.timeoutMs || 300_000,
      signal: opts.signal,
    });

    let diffStat = "";
    if (worktree?.id && !worktree.error) {
      try {
        const d = worktreeDiff(worktree.id, cwd);
        save(runDir, `workers/w${i + 1}.diff`, d.diff || "");
        diffStat = d.stat || "";
      } catch {
        // ignore
      }
    }

    const record = {
      index: i + 1,
      model: model || result.model || null,
      ok: result.ok,
      error: result.error,
      text: result.text,
      usage: result.usage,
      worktree,
      diffStat,
    };
    workers.push(record);
    save(
      runDir,
      `workers/w${i + 1}.md`,
      `# Worker ${i + 1}\n\nmodel: ${record.model || "(default)"}\n\n${result.text || result.error || "(empty)"}\n`,
    );

    upsertAgent(panel, {
      role: "worker",
      index: i + 1,
      status: result.ok ? "ok" : "fail",
      model: record.model || undefined,
      endedAt: Date.now(),
      usage: result.usage,
      detail: result.error || (result.text || "").slice(0, 40) || "done",
    });
    emit();
    return record;
  };

  if (mode === "plan") {
    // Parallel independent attempts
    await Promise.all(models.map((_, i) => runOne(i)));
  } else {
    for (let i = 0; i < models.length; i++) {
      if (opts.signal?.aborted) break;
      await runOne(i);
    }
  }

  // Merger
  setPhase(panel, "MERGING");
  upsertAgent(panel, {
    role: "merger",
    status: "running",
    startedAt: Date.now(),
    detail: "synthesizing…",
    model: cfg.fusion?.mergerModel || cfg.roles?.reviewer?.model || undefined,
  });
  emit();
  progress("merger…");

  const sources = workers
    .map(
      (w, idx) =>
        `### Worker ${w.index} (model: ${w.model || "default"}, ok=${w.ok})\n${w.text || w.error || "(empty)"}\n${w.diffStat ? `diff stat:\n${w.diffStat}\n` : ""}`,
    )
    .join("\n");

  const mergerPrompt = `You are Alloy Fusion Merger. You receive independent worker outputs.
Produce an attributed merge with EXACTLY these sections:

## Consensus
## Unique findings (by worker)
## Conflicts
## Discarded claims
## Final decision

Rules:
- Preserve provenance (cite Worker N).
- Do not invent facts not present in workers.
- If workers disagree, explain and pick with rationale.
- ${mode === "build" ? "Recommend which worker worktree/approach to keep; do not claim you merged code automatically." : "Produce the best combined plan/answer."}
`;

  const mergeResult = await runChildAgent({
    prompt: `${mergerPrompt}\n\n## Request\n${request}\n\n## Worker outputs\n${sources}`,
    cwd,
    model: cfg.fusion?.mergerModel || cfg.roles?.reviewer?.model || undefined,
    tools: READ_TOOLS,
    systemPrompt: mergerPrompt,
    timeoutMs: opts.timeoutMs || 300_000,
    signal: opts.signal,
  });

  save(
    runDir,
    "fusion/merged.md",
    `# Fusion merge\n\n${mergeResult.text || mergeResult.error || "(empty)"}\n`,
  );
  save(runDir, "fusion/workers.json", workers);

  upsertAgent(panel, {
    role: "merger",
    status: mergeResult.ok ? "ok" : "fail",
    endedAt: Date.now(),
    usage: mergeResult.usage,
    model: mergeResult.model || cfg.fusion?.mergerModel || undefined,
    detail: mergeResult.error || "merged",
  });
  setPhase(panel, mergeResult.ok ? "COMPLETE" : "FAILED");
  emit();

  const summary = {
    kind: "fusion",
    mode,
    runId: panel.runId,
    runDir,
    models,
    workers: workers.map((w) => ({
      index: w.index,
      model: w.model,
      ok: w.ok,
      error: w.error,
      worktree: w.worktree,
    })),
    merger: {
      ok: mergeResult.ok,
      error: mergeResult.error,
      model: mergeResult.model,
    },
    panel: renderPanelLines(panel),
    status: mergeResult.ok ? "COMPLETE" : "FAILED",
  };
  save(runDir, "summary.json", summary);
  appendEvent(runDir, { type: "fusion_done", status: summary.status });
  return summary;
}
