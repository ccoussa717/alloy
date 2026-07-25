/**
 * Track free-form Alloy agents (running + finished) and persist transcripts.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { getAlloyHome, projectIdFromCwd } from "./paths.mjs";
import { runChildAgent } from "./child-runner.mjs";
import {
  createPanelState,
  upsertAgent,
  setPhase,
  renderPanelLines,
  pushTickerEvent,
} from "./agent-panel.mjs";

/** @type {Map<string, any>} in-memory live agents for this process */
const live = new Map();
/** @type {Map<string, any>} active Auto/Fusion reservations for this process */
const workflowReservations = new Map();
/** @type {Map<string, any>} settled Auto/Fusion usage retained for this session */
const workflowObserved = new Map();
let reservationSequence = 0;

/** @type {((panel: any) => void) | null} */
let panelPainter = null;

/** @type {any} */
let sharedPanel = null;

function agentsRoot(cwd = process.cwd()) {
  const dir = join(getAlloyHome(), "agents", projectIdFromCwd(cwd));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getRunningAgentCount(cwd = process.cwd()) {
  const projectId = projectIdFromCwd(cwd);
  const freeAgents = [...live.values()].filter(
    (record) => record.status === "running" && record.projectId === projectId,
  ).length;
  const workflows = [...workflowReservations.values()].filter(
    (record) => record.projectId === projectId,
  ).length;
  return freeAgents + workflows;
}

export function getAgentSpentCost(cwd = process.cwd()) {
  const projectId = projectIdFromCwd(cwd);
  const freeAgentCost = [...live.values()].reduce((total, record) => {
    if (!Number.isFinite(total) || record.projectId !== projectId) return total;
    if (record.status === "running") {
      const reservation = record.budgetUsd;
      return typeof reservation === "number" &&
        Number.isFinite(reservation) &&
        reservation >= 0
        ? total + reservation
        : Number.NaN;
    }
    if (record.usage?.costKnown === false) return Number.NaN;
    const cost = record.usage?.cost;
    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? total + cost
      : Number.NaN;
  }, 0);
  return [
    ...workflowReservations.values(),
    ...workflowObserved.values(),
  ].reduce((total, record) => {
    if (!Number.isFinite(total) || record.projectId !== projectId) return total;
    if (record.kind === "reservation") return total + record.budgetUsd;
    if (record.costKnown === false) return Number.NaN;
    return typeof record.cost === "number" &&
      Number.isFinite(record.cost) &&
      record.cost >= 0
      ? total + record.cost
      : Number.NaN;
  }, freeAgentCost);
}

export function reserveAgentLaunch({
  cwd = process.cwd(),
  maxConcurrency,
  budgetUsd,
  budgetLimitUsd,
  owner = "workflow",
} = {}) {
  assertAgentConcurrency(getRunningAgentCount(cwd), maxConcurrency);
  if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error("Invalid agent budget reservation");
  }
  let reservedBudgetUsd = budgetUsd;
  if (budgetLimitUsd != null) {
    reservedBudgetUsd = Math.min(
      budgetUsd,
      remainingAgentBudget(getAgentSpentCost(cwd), budgetLimitUsd),
    );
  }
  const id = `workflow-${Date.now().toString(36)}-${++reservationSequence}`;
  workflowReservations.set(id, {
    id,
    kind: "reservation",
    projectId: projectIdFromCwd(cwd),
    owner: String(owner || "workflow").slice(0, 64),
    budgetUsd: reservedBudgetUsd,
  });
  return { id, budgetUsd: reservedBudgetUsd };
}

export function settleAgentLaunch(reservation, usage = {}) {
  const id = typeof reservation === "string" ? reservation : reservation?.id;
  const active = workflowReservations.get(id);
  if (!active) throw new Error("Unknown agent launch reservation");
  workflowReservations.delete(id);
  const cost = usage?.cost;
  const costKnown =
    usage?.costKnown !== false &&
    typeof cost === "number" &&
    Number.isFinite(cost) &&
    cost >= 0;
  workflowObserved.set(id, {
    id,
    kind: "observed",
    projectId: active.projectId,
    cost: costKnown ? cost : null,
    costKnown,
  });
  return { id, cost: costKnown ? cost : null, costKnown };
}

export function resetAgentLedgerForTests() {
  workflowReservations.clear();
  workflowObserved.clear();
  reservationSequence = 0;
}

export function remainingAgentBudget(committedCostUsd, maximumCostUsd) {
  if (
    typeof committedCostUsd !== "number" ||
    !Number.isFinite(committedCostUsd) ||
    committedCostUsd < 0 ||
    typeof maximumCostUsd !== "number" ||
    !Number.isFinite(maximumCostUsd) ||
    maximumCostUsd < 0
  ) {
    throw new Error("Invalid agent budget state");
  }
  const remaining = maximumCostUsd - committedCostUsd;
  if (remaining <= 0) throw new Error("Agent budget is exhausted");
  return remaining;
}

export function assertAgentConcurrency(activeChildren, maxConcurrency) {
  if (maxConcurrency == null) return;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("Invalid agent concurrency limit");
  }
  if (activeChildren >= maxConcurrency) {
    throw new Error(`Agent concurrency limit reached (${maxConcurrency})`);
  }
}

export function applyAgentBudget(record, budgetUsd) {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return record;
  const cost = record?.usage?.cost;
  record.budgetUsd = budgetUsd;
  if (
    record?.usage?.costKnown === false ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    record.ok = false;
    record.status = "fail";
    record.error ||= "budget_usage_unavailable";
    record.budgetUsageUnavailable = true;
    record.budgetExceeded = false;
    return record;
  }
  record.budgetExceeded = cost > budgetUsd;
  if (record.budgetExceeded) {
    record.ok = false;
    record.status = "fail";
    record.error ||= "budget_exceeded";
    record.budgetError = "budget_exceeded";
  }
  return record;
}

export function setAgentPanelPainter(fn) {
  panelPainter = fn;
}

function ensurePanel() {
  if (!sharedPanel) {
    sharedPanel = createPanelState({ title: "ALLOY AGENTS" });
  }
  return sharedPanel;
}

function paint() {
  if (!sharedPanel) return;
  setPhase(sharedPanel, "AGENTS");
  // rebuild panel from live + recent finished
  panelPainter?.(sharedPanel);
}

/**
 * List agents for project (live first, then disk).
 */
export function listAgents(cwd = process.cwd(), { limit = 40 } = {}) {
  const fromLive = [...live.values()].map(publicRecord);
  const dir = agentsRoot(cwd);
  const fromDisk = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort().reverse()) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (!fromLive.some((l) => l.id === rec.id)) {
          fromDisk.push(publicRecord(rec));
        }
      } catch {
        // skip
      }
    }
  }
  return [...fromLive, ...fromDisk].slice(0, limit);
}

function publicRecord(rec) {
  return {
    id: rec.id,
    name: rec.name,
    status: rec.status,
    model: rec.model,
    profile: rec.profile,
    task: rec.task,
    background: Boolean(rec.background),
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    error: rec.error,
    usage: rec.usage,
    lastTool: rec.lastTool,
    ok: rec.ok,
    routing: rec.routing || null,
    credentialBroker: rec.credentialBroker || "none",
    budgetUsd: rec.budgetUsd,
    budgetExceeded: Boolean(rec.budgetExceeded),
    budgetUsageUnavailable: Boolean(rec.budgetUsageUnavailable),
    budgetError: rec.budgetError || null,
  };
}

export function getAgent(idOrName, cwd = process.cwd()) {
  const q = String(idOrName || "").trim();
  if (!q) return null;
  for (const rec of live.values()) {
    if (rec.id === q || rec.name === q || rec.id.startsWith(q)) return rec;
  }
  const dir = agentsRoot(cwd);
  if (!existsSync(dir)) return null;
  // exact file
  const exact = join(dir, `${q}.json`);
  if (existsSync(exact)) {
    return JSON.parse(readFileSync(exact, "utf8"));
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (rec.id === q || rec.name === q || rec.id.startsWith(q) || f.startsWith(q)) {
        return rec;
      }
    } catch {
      // skip
    }
  }
  return null;
}

export function getAgentTranscript(idOrName, cwd = process.cwd()) {
  const rec = getAgent(idOrName, cwd);
  if (!rec) return null;
  const mdPath = join(agentsRoot(cwd), `${rec.id}.md`);
  let markdown = "";
  if (existsSync(mdPath)) markdown = readFileSync(mdPath, "utf8");
  else {
    markdown = formatTranscriptMd(rec);
  }
  return { record: publicRecord(rec), markdown, text: rec.text || "", events: rec.events || [] };
}

function formatTranscriptMd(rec) {
  const lines = [
    `# Agent ${rec.name} (${rec.id})`,
    "",
    `- status: ${rec.status}`,
    `- model: ${rec.model || "(default)"}`,
    `- profile: ${rec.profile || "default"}`,
    `- task: ${rec.task || ""}`,
    `- route: ${rec.routing?.reason || "legacy"}`,
    `- role: ${rec.routing?.role || rec.profile || "general"}`,
    `- fallback: ${rec.routing?.fallbackUsed ? "yes" : "no"}`,
    `- credential broker: ${rec.credentialBroker || "none"}`,
    "",
    "## Output",
    "",
    rec.text || rec.error || "(no output yet)",
    "",
  ];
  if (rec.lastTool) lines.push(`Last tool: ${rec.lastTool}`, "");
  return lines.join("\n");
}

function persist(rec, cwd) {
  const dir = agentsRoot(cwd);
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(join(dir, `${rec.id}.md`), formatTranscriptMd(rec), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Spawn a free-form agent.
 * @param {{
 *   name: string,
 *   task: string,
 *   model?: string|null,
 *   profile?: string,
 *   tools?: string[],
 *   systemPrompt?: string,
 *   cwd?: string,
 *   background?: boolean,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   onUpdate?: (rec: any) => void,
 *   routeDecision?: object,
 *   credentialBroker?: string,
 *   brokerRuntimeCredential?: object,
 *   maxConcurrency?: number|null,
 *   budgetUsd?: number,
 *   budgetLimitUsd?: number,
 * }} opts
 */
export async function spawnAgent(opts) {
  const cwd = opts.cwd || process.cwd();
  assertAgentConcurrency(getRunningAgentCount(cwd), opts.maxConcurrency);
  let budgetUsd = opts.budgetUsd;
  if (opts.budgetLimitUsd != null) {
    if (
      typeof budgetUsd !== "number" ||
      !Number.isFinite(budgetUsd) ||
      budgetUsd <= 0
    ) {
      throw new Error("Invalid agent budget reservation");
    }
    budgetUsd = Math.min(
      budgetUsd,
      remainingAgentBudget(getAgentSpentCost(cwd), opts.budgetLimitUsd),
    );
  }
  const id = newId();
  const name = String(opts.name || "agent").replace(/[^\w.-]+/g, "-").slice(0, 48) || "agent";

  /** @type {any} */
  const rec = {
    id,
    projectId: projectIdFromCwd(cwd),
    name,
    status: "running",
    model: opts.model || null,
    profile: opts.profile || "default",
    task: opts.task,
    tools: opts.tools || [],
    systemPrompt: opts.systemPrompt || "",
    background: Boolean(opts.background),
    startedAt: Date.now(),
    endedAt: null,
    ok: false,
    text: "",
    error: null,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    lastTool: "",
    messages: [],
    events: [],
    routing: opts.routeDecision || null,
    credentialBroker: opts.credentialBroker || "none",
    budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
    budgetExceeded: false,
  };

  live.set(id, rec);
  const panel = ensurePanel();
  upsertAgent(panel, {
    role: name,
    status: "running",
    model: rec.model || undefined,
    startedAt: rec.startedAt,
    detail: rec.task.slice(0, 40),
  });
  paint();
  persist(rec, cwd);
  opts.onUpdate?.(rec);

  const run = async () => {
    try {
      const parentProfile =
        opts.parentPermissionProfile || opts.permissionProfile || "ask-dangerous";
      const parentSbx =
        Boolean(opts.parentSandbox) ||
        parentProfile === "sandbox" ||
        Boolean(opts.sandbox);
      const result = await runChildAgent({
        prompt: opts.task,
        cwd,
        model: opts.model || undefined,
        tools: opts.tools,
        systemPrompt: opts.systemPrompt,
        timeoutMs: opts.timeoutMs || 300_000,
        signal: opts.signal,
        permissionProfile: opts.permissionProfile || parentProfile,
        mode: opts.mode || "build",
        sandbox: parentSbx,
        parentPermissionProfile: parentProfile,
        parentSandbox: parentSbx,
        role: opts.profile || name || "agent",
        readRoot:
          opts.credentialBroker && opts.credentialBroker !== "none"
            ? cwd
            : opts.readRoot || null,
        credentialBroker: opts.credentialBroker || "none",
        brokerRuntimeCredential: opts.brokerRuntimeCredential || null,
        maxCostUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
        onEvent: (ev) => {
          if (ev?.type === "tool_execution_start" && ev.toolName) {
            rec.lastTool = ev.toolName;
            const detail =
              typeof ev.args === "object" && ev.args
                ? String(
                    ev.args.command ||
                      ev.args.path ||
                      ev.args.file_path ||
                      ev.args.pattern ||
                      "",
                  ).slice(0, 48)
                : "";
            pushTickerEvent({
              agent: name,
              tool: ev.toolName,
              detail,
            });
            upsertAgent(panel, {
              role: name,
              status: "running",
              detail: detail ? `${ev.toolName} ${detail}` : ev.toolName,
              model: rec.model || undefined,
            });
            paint();
            opts.onUpdate?.(rec);
          }
        },
      });

      rec.ok = result.ok;
      rec.text = result.text;
      rec.error = result.error || null;
      rec.usage = result.usage;
      rec.messages = result.messages;
      rec.events = (result.events || []).slice(-200);
      rec.lastTool = result.lastTool || rec.lastTool;
      rec.model = result.model || rec.model;
      rec.status = result.ok ? "ok" : "fail";
      rec.endedAt = Date.now();
      applyAgentBudget(rec, budgetUsd);
    } catch (err) {
      rec.status = "fail";
      rec.error = String(err?.message || err);
      rec.endedAt = Date.now();
    }

    live.set(id, rec);
    upsertAgent(panel, {
      role: name,
      status: rec.status === "ok" ? "ok" : "fail",
      endedAt: rec.endedAt,
      usage: rec.usage,
      model: rec.model || undefined,
      detail: rec.error || (rec.text || "").slice(0, 40) || "done",
    });
    paint();
    persist(rec, cwd);
    opts.onUpdate?.(rec);
    // Keep finished in live map briefly for /agents; still on disk
    return rec;
  };

  if (opts.background) {
    // fire-and-forget
    run().catch(() => {});
    return { record: publicRecord(rec), promise: null, background: true };
  }

  const finished = await run();
  return { record: publicRecord(finished), full: finished, background: false };
}

export function getAgentsPanelLines() {
  const panel = ensurePanel();
  return renderPanelLines(panel);
}

export function clearAgentsPanel() {
  sharedPanel = createPanelState({ title: "ALLOY AGENTS" });
  paint();
}
