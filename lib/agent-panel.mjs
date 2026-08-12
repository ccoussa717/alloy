/**
 * Agent panel + live tool ticker for Alloy TUI.
 * Status: pending | running | ok | fail | skip
 */

import {
  truncateToWidth,
  visibleWidth as terminalVisibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const ROLE_ORDER = [
  "scout",
  "planner",
  "architect",
  "builder",
  "synthesizer",
  "fixer",
  "reviewer",
  "judge",
  "worker",
  "merger",
];

const ROLE_LABELS = {
  architect: "Architect",
  builder: "Builder",
  synthesizer: "Synthesizer",
  reviewer: "Reviewer",
  judge: "Judge",
};

const FUSION_ROLES = ["architect", "builder", "synthesizer"];
const FUSION_LIVE_STATUSES = new Set(["pending", "running", "ok", "fail", "skip"]);
const FUSION_LIVE_MAX_BYTES = 20_000;

/** @type {Array<{ ts: number, agent: string, tool: string, detail: string }>} */
const globalTicker = [];
const TICKER_MAX = 12;

export function pushTickerEvent({ agent, tool, detail }) {
  globalTicker.unshift({
    ts: Date.now(),
    agent: String(agent || "agent").slice(0, 16),
    tool: String(tool || "").slice(0, 16),
    detail: String(detail || "").replace(/\s+/g, " ").slice(0, 48),
  });
  if (globalTicker.length > TICKER_MAX) globalTicker.length = TICKER_MAX;
}

export function getTickerEvents(limit = 8) {
  return globalTicker.slice(0, limit);
}

export function clearTicker() {
  globalTicker.length = 0;
}

export function createPanelState({ title = "ALLOY", runId, objective, maxFixRounds = 0 } = {}) {
  return {
    title,
    runId,
    ...(objective ? { objective } : {}),
    phase: "CREATED",
    fixRound: 0,
    maxFixRounds,
    agents: [],
    ticker: [],
  };
}

export function upsertAgent(panel, partial) {
  const key = agentKey(partial);
  let row = panel.agents.find((a) => agentKey(a) === key);
  if (!row) {
    row = {
      role: partial.role,
      status: "pending",
      round: partial.round,
      index: partial.index,
    };
    panel.agents.push(row);
  }
  Object.assign(row, partial);
  return row;
}

function agentKey(a) {
  const r = a.round != null ? `r${a.round}` : "";
  const i = a.index != null ? `#${a.index}` : "";
  return `${a.role}${r}${i}`;
}

export function setPhase(panel, phase) {
  panel.phase = phase;
}

function shortModel(m) {
  if (!m) return "";
  const s = String(m);
  if (s.includes("/")) return s.split("/").pop();
  return s.length > 16 ? s.slice(0, 14) + "…" : s;
}

function sanitizeFusionText(value) {
  return String(value || "")
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:sk-(?:proj-)?|xai-)[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, "[REDACTED]")
    .replace(/((?:proxy[-_ ]?)?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[-_ ]?key|access[-_ ]?key|secret[-_ ]?access[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|password|passwd|cookie|client[-_ ]?secret|private[-_ ]?key|secret|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function truncateUtf8(value, maxBytes, fromEnd = false) {
  const sanitized = sanitizeFusionText(value);
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  if (fromEnd) {
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/**
 * OpenCode-inspired panel: agent roster + live tool ticker.
 */
export function renderPanelLines(panel, { maxDetail = 40, tickerLimit = 6 } = {}) {
  const lines = [];
  const headBits = [
    panel.title || "ALLOY",
    panel.runId ? panel.runId : null,
    panel.phase && panel.phase !== "AGENTS" ? panel.phase : null,
    panel.maxFixRounds
      ? `fix ${panel.fixRound || 0}/${panel.maxFixRounds}`
      : null,
  ].filter(Boolean);
  const head = headBits.join(" · ");
  lines.push(head);
  lines.push("─".repeat(Math.min(58, Math.max(28, head.length + 4))));

  const sorted = [...(panel.agents || [])].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(String(a.role).replace(/\d+$/, ""));
    const ib = ROLE_ORDER.indexOf(String(b.role).replace(/\d+$/, ""));
    const sa = ia === -1 ? 50 : ia;
    const sb = ib === -1 ? 50 : ib;
    if (sa !== sb) return sa - sb;
    return (a.index || 0) - (b.index || 0);
  });

  if (!sorted.length) {
    lines.push("  (no agents — /agent <name> <task>)");
  } else {
    for (const a of sorted) {
      const icon =
        a.status === "running"
          ? "●"
          : a.status === "ok"
            ? "✓"
            : a.status === "fail"
              ? "✗"
              : a.status === "skip"
                ? "○"
                : "·";
      const elapsed =
        a.startedAt && a.status === "running"
          ? ` ${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`
          : a.startedAt && a.endedAt
            ? ` ${((a.endedAt - a.startedAt) / 1000).toFixed(1)}s`
            : "";
      const model = a.model ? ` ${shortModel(a.model)}` : "";
      const cost =
        a.usage?.cost != null && a.usage.cost > 0
          ? ` $${Number(a.usage.cost).toFixed(3)}`
          : "";
      const route = a.routing?.reason
        ? ` route:${a.routing.reason}${a.routing.fallbackUsed && a.routing.reason !== "fallback" ? "/fallback" : ""}`
        : "";
      const roleLabel = ROLE_LABELS[a.role] || a.role;
      const label = a.round != null ? `${roleLabel}[r${a.round}]` : roleLabel;
      const idx = a.index != null ? ` #${a.index}` : "";
      let detail = (a.detail || "").replace(/\s+/g, " ").trim();
      if (detail.length > maxDetail) detail = detail.slice(0, maxDetail - 1) + "…";
      lines.push(
        ` ${icon} ${label}${idx}${model}${elapsed}${cost}${route}${detail ? "  " + detail : ""}`,
      );
    }
  }

  // Live ticker (panel-local or global)
  const ticks = (panel.ticker && panel.ticker.length
    ? panel.ticker
    : getTickerEvents(tickerLimit)
  ).slice(0, tickerLimit);

  if (ticks.length) {
    lines.push("─ live ─");
    for (const t of ticks) {
      const time = t.ts ? fmtTime(t.ts) : "      ";
      const line = ` ${time}  ${t.agent}  ${t.tool}${t.detail ? "  " + t.detail : ""}`;
      lines.push(line.slice(0, 72));
    }
  }

  lines.push("─");
  lines.push(" Ctrl+Shift+A last agent · /agents · /agent");
  return lines;
}

export function renderPanelThemed(panel, theme) {
  const plain = renderPanelLines(panel);
  if (!theme?.fg) return plain;
  return plain.map((line, i) => {
    if (i === 0) return theme.fg("accent", line);
    if (line.startsWith("─")) return theme.fg("dim", line);
    if (line.includes("live")) return theme.fg("accent", line);
    if (line.trimStart().startsWith("✓") || line.includes(" ✓ "))
      return theme.fg("success", line);
    if (line.trimStart().startsWith("✗") || line.includes(" ✗ "))
      return theme.fg("error", line);
    if (line.trimStart().startsWith("●") || line.includes(" ● "))
      return theme.fg("warning", line);
    if (line.includes("Ctrl+Shift+A")) return theme.fg("dim", line);
    // ticker times
    if (/^\s+\d{2}:\d{2}:\d{2}/.test(line)) return theme.fg("muted", line);
    return line;
  });
}

export function visibleWidth(text) {
  return terminalVisibleWidth(String(text || ""));
}

function fit(text, width) {
  const value = String(text || "");
  const truncated = truncateToWidth(value, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function wrapPaneText(text, width) {
  const out = [];
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trimEnd();
    if (!line) {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(line, width));
  }
  return out;
}

function paneBody(agent, width, maxRows) {
  const status = agent?.status || "pending";
  const source = agent?.output || agent?.detail || (status === "pending" ? "Waiting..." : "Working...");
  const rows = wrapPaneText(source, width);
  return rows.slice(Math.max(0, rows.length - maxRows));
}

function paneTitle(agent, label) {
  const metadata = [
    label,
    agent?.model ? shortModel(agent.model) : null,
    agent?.effort || null,
  ].filter(Boolean).join(" · ");
  return `${metadata} [${agent?.status || "pending"}]`;
}

function renderSinglePane(agent, label, width, maxRows = 14) {
  const inner = Math.max(1, width - 2);
  const title = paneTitle(agent, label);
  const body = paneBody(agent, inner, maxRows);
  return [
    `┌${"─".repeat(inner)}┐`,
    `│${fit(title, inner)}│`,
    `├${"─".repeat(inner)}┤`,
    ...body.map((line) => `│${fit(line, inner)}│`),
    `└${"─".repeat(inner)}┘`,
  ];
}

function renderCompactFusionPanes(prefix, agents, width, maxRows) {
  const lines = [...prefix];
  const availableRows = Math.max(0, maxRows - prefix.length);
  const rowsPerAgent = Math.max(1, Math.floor(availableRows / Math.max(agents.length, 1)));
  for (const [label, agent] of agents) {
    lines.push(
      ...wrapPaneText(
        `${label} [${agent?.status || "pending"}]: ${agent?.output || agent?.detail || "Waiting..."}`,
        width,
      )
        .slice(-rowsPerAgent)
        .map((line) => fit(line, width)),
    );
  }
  return lines.slice(0, maxRows);
}

export function renderFusionPaneLines(panel, width, { maxRows = 14 } = {}) {
  const safeWidth = Math.max(1, Math.floor(width || 80));
  const totalRows = Math.max(1, Math.floor(maxRows));
  const header = fit(
    `${panel.title || "ALLOY FUSION"}${panel.runId ? ` · ${panel.runId}` : ""}${panel.phase ? ` · ${panel.phase}` : ""}`,
    safeWidth,
  );
  const objective = truncateToWidth(
    String(panel.objective || "").replace(/\s+/g, " ").trim(),
    safeWidth * 2,
  );
  const prefix = [
    header,
    ...(objective
      ? wrapPaneText(`Objective: ${objective}`, safeWidth)
          .slice(0, 2)
          .map((line) => fit(line, safeWidth))
      : []),
  ].slice(0, totalRows);
  const architect = panel.agents?.find((agent) => agent.role === "architect");
  const builder = panel.agents?.find((agent) => agent.role === "builder");
  const synthesizer = panel.agents?.find((agent) => agent.role === "synthesizer");
  const synthesisActive = synthesizer && synthesizer.status !== "pending";
  const activeAgents = [["Architect", architect], ["Builder", builder]];
  if (synthesisActive) activeAgents.push(["Synthesizer", synthesizer]);

  if (safeWidth < 20) {
    return renderCompactFusionPanes(prefix, activeAgents.map(([label, agent]) => [label[0], agent]), safeWidth, totalRows);
  }

  if (safeWidth < 72) {
    const chromeRows = prefix.length + activeAgents.length * 4;
    if (chromeRows + activeAgents.length > totalRows) {
      return renderCompactFusionPanes(prefix, activeAgents, safeWidth, totalRows);
    }
    let remainingBodyRows = totalRows - chromeRows;
    const lines = [...prefix];
    for (let index = 0; index < activeAgents.length; index++) {
      const panesLeft = activeAgents.length - index;
      const bodyRows = Math.max(1, Math.floor(remainingBodyRows / panesLeft));
      const [label, agent] = activeAgents[index];
      lines.push(...renderSinglePane(agent, label, safeWidth, bodyRows));
      remainingBodyRows -= bodyRows;
    }
    return lines;
  }

  const chromeRows = prefix.length + (synthesisActive ? 8 : 4);
  if (chromeRows + (synthesisActive ? 2 : 1) > totalRows) {
    return renderCompactFusionPanes(prefix, activeAgents, safeWidth, totalRows);
  }
  const bodyRows = totalRows - chromeRows;
  const proposalRows = synthesisActive ? Math.max(1, Math.floor(bodyRows / 2)) : bodyRows;
  const synthesisRows = synthesisActive ? Math.max(1, bodyRows - proposalRows) : 0;
  const leftWidth = Math.floor((safeWidth - 3) / 2);
  const rightWidth = safeWidth - 3 - leftWidth;
  const leftBody = paneBody(architect, leftWidth, proposalRows);
  const rightBody = paneBody(builder, rightWidth, proposalRows);
  const rows = Math.max(leftBody.length, rightBody.length, 1);
  const lines = [
    ...prefix,
    `┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`,
    `│${fit(paneTitle(architect, "Architect"), leftWidth)}│${fit(paneTitle(builder, "Builder"), rightWidth)}│`,
    `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`,
  ];
  for (let index = 0; index < rows; index++) {
    lines.push(
      `│${fit(leftBody[index], leftWidth)}│${fit(rightBody[index], rightWidth)}│`,
    );
  }
  lines.push(`└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`);
  if (synthesisActive) {
    lines.push(...renderSinglePane(synthesizer, "Synthesizer", safeWidth, synthesisRows));
  }
  return lines;
}

export function renderFusionWidgetLines(panel, width) {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : null;
  const renderLine = (line) => safeWidth ? truncateToWidth(line, safeWidth) : line;
  const agents = ["architect", "builder", "synthesizer"]
    .map((role) => panel.agents?.find((agent) => agent.role === role))
    .filter((agent) => agent && (agent.role !== "synthesizer" || agent.status !== "pending"));
  const glyphs = { architect: "◆", builder: "▲", synthesizer: "⧉" };
  const labels = { architect: "Architect", builder: "Builder", synthesizer: "Synthesizer" };
  const statuses = { pending: "·", running: "●", ok: "✓", fail: "×", skip: "○" };
  const lines = [renderLine(`ALLOY FUSION · ${panel.phase || "RUN"}`)];
  const objective = truncateToWidth(
    sanitizeFusionText(panel.objective).slice(0, 1024).replace(/\s+/g, " ").trim(),
    160,
  );
  if (objective) lines.push(renderLine(`Objective: ${objective}`));
  for (const agent of agents) {
    const activity = sanitizeFusionText(agent.output || agent.detail || (agent.status === "pending" ? "Waiting..." : "Working..."))
      .replace(/\s+/g, " ")
      .trim();
    const metadata = [agent.model ? shortModel(agent.model) : null, agent.effort || null]
      .filter(Boolean)
      .join(" · ");
    const status = `${glyphs[agent.role] || "◆"} ${labels[agent.role] || agent.role} ${statuses[agent.status] || "·"}`;
    lines.push(renderLine(`${status} ${activity}${metadata ? ` · ${metadata}` : ""}`));
  }
  return lines.slice(0, 6);
}

/**
 * Map a Pi child stream event into agent panel ticker + rolling output text.
 * Shared by fusion, fission, and other multi-agent workflows.
 */
export function applyWorkflowChildEvent(panel, agentRef, event, emit, emitUpdate) {
  if (!panel || !agentRef) return;
  const key = agentKey(agentRef);
  const detail = workflowChildEventDetail(event);
  if (detail) {
    panel.ticker = Array.isArray(panel.ticker) ? panel.ticker : [];
    panel.ticker.unshift({ ts: Date.now(), agent: key, ...detail });
    panel.ticker = panel.ticker.slice(0, 8);
    pushTickerEvent({
      agent: key,
      tool: detail.tool,
      detail: detail.detail,
    });
    upsertAgent(panel, {
      ...agentRef,
      detail: `${detail.tool} ${detail.detail}`.trim().slice(0, 80),
    });
  }
  const output = workflowChildEventOutput(event);
  if (output) {
    upsertAgent(panel, { ...agentRef, output });
  }
  if (detail) emit?.();
  else if (output) emitUpdate?.();
}

function workflowChildEventDetail(event) {
  if (event?.type === "tool_execution_start") {
    const args =
      event.args && typeof event.args === "object" && !Array.isArray(event.args)
        ? Object.entries(event.args)
            .filter(
              ([, value]) =>
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean",
            )
            .slice(0, 2)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(" ")
        : "";
    return {
      tool: event.toolName || "tool",
      detail: (args || "started").slice(0, 256),
      status: "running",
    };
  }
  if (event?.type === "tool_execution_end") {
    return {
      tool: event.toolName || "tool",
      detail: event.isError ? "failed" : "complete",
      status: event.isError ? "failed" : "complete",
    };
  }
  if (event?.type === "message_end") {
    return { tool: "message", detail: "complete", status: "complete" };
  }
  return null;
}

function workflowChildEventOutput(event) {
  if (typeof event?.outputText === "string" && event.outputText) {
    return event.outputText.slice(-12_000);
  }
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

/** Throttled panel publisher (fusion/fission share this). */
export function createPanelPublisher(onPanel, deps = {}) {
  const schedule = deps.schedulePanelUpdate || ((callback, delay) => setTimeout(callback, delay));
  const cancel = deps.cancelPanelUpdate || clearTimeout;
  const intervalMs = deps.panelUpdateIntervalMs || 100;
  let timer;
  let latestPanel;
  const publishNow = (panel) => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    latestPanel = undefined;
    onPanel?.(panel);
  };
  const publishUpdate = (panel) => {
    if (!onPanel) return;
    latestPanel = panel;
    if (timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      const current = latestPanel;
      latestPanel = undefined;
      if (current) onPanel(current);
    }, intervalMs);
  };
  const dispose = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    latestPanel = undefined;
  };
  return { publishNow, publishUpdate, dispose };
}

/**
 * Side-by-side (or stacked) streaming panes for fission reviewers.
 */
export function renderFissionPaneLines(panel, width = 80) {
  const safeWidth = Math.max(40, Math.floor(Number(width) || 80));
  const reviewers = [...(panel?.agents || [])]
    .filter((agent) => agent?.role === "reviewer" || agent?.role === "judge")
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "reviewer" ? -1 : 1;
      return (a.index || 0) - (b.index || 0);
    });
  const lines = [
    `ALLOY FISSION · ${panel?.phase || "RUN"}${panel?.runId ? ` · ${panel.runId}` : ""}`,
  ];
  if (!reviewers.length) {
    lines.push("  (waiting for reviewers…)");
    return lines;
  }
  // Two-column for 2 reviewers; stack otherwise
  const pair = reviewers.filter((a) => a.role === "reviewer");
  if (pair.length === 2 && safeWidth >= 60) {
    const leftWidth = Math.floor((safeWidth - 3) / 2);
    const rightWidth = safeWidth - 3 - leftWidth;
    const bodyRows = 8;
    const left = streamPaneBody(pair[0], leftWidth, bodyRows);
    const right = streamPaneBody(pair[1], rightWidth, bodyRows);
    lines.push(`┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`);
    lines.push(
      `│${fitPane(paneAgentTitle(pair[0], "R1"), leftWidth)}│${fitPane(paneAgentTitle(pair[1], "R2"), rightWidth)}│`,
    );
    lines.push(`├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`);
    for (let i = 0; i < bodyRows; i++) {
      lines.push(
        `│${fitPane(left[i], leftWidth)}│${fitPane(right[i], rightWidth)}│`,
      );
    }
    lines.push(`└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`);
  } else {
    for (const agent of pair) {
      const label =
        agent.role === "reviewer"
          ? `R${agent.index || "?"} ${shortModel(agent.model || agent.requestedModel)}`
          : "Judge";
      lines.push(...renderStreamSinglePane(agent, label, safeWidth, 6));
    }
  }
  const judge = reviewers.find((a) => a.role === "judge");
  if (judge) {
    lines.push(
      ...renderStreamSinglePane(
        judge,
        `Judge ${shortModel(judge.model || "")}`,
        safeWidth,
        5,
      ),
    );
  }
  return lines;
}

function paneAgentTitle(agent, fallback) {
  const status =
    agent.status === "running"
      ? "●"
      : agent.status === "ok"
        ? "✓"
        : agent.status === "fail"
          ? "×"
          : "·";
  return `${status} ${fallback} ${shortModel(agent.model || agent.requestedModel || "")}`;
}

function fitPane(text, width) {
  return truncateToWidth(String(text || ""), width).padEnd(width, " ").slice(0, width);
}

function streamPaneBody(agent, width, rows) {
  const text = sanitizeFusionText(agent?.output || agent?.detail || "…");
  const wrapped = wrapTextWithAnsi(text, width);
  const body = wrapped.slice(-rows);
  while (body.length < rows) body.unshift("");
  return body;
}

function renderStreamSinglePane(agent, label, width, rows) {
  const inner = Math.max(10, width - 2);
  const body = streamPaneBody(agent, inner, rows);
  return [
    `┌${"─".repeat(inner)}┐`,
    `│${fitPane(paneAgentTitle(agent, label), inner)}│`,
    `├${"─".repeat(inner)}┤`,
    ...body.map((line) => `│${fitPane(line, inner)}│`),
    `└${"─".repeat(inner)}┘`,
  ];
}

export function createFissionLivePanel(panel) {
  const ticker = Array.isArray(panel?.ticker) ? panel.ticker : [];
  const agents = [...(panel?.agents || [])].filter(Boolean);
  const snapshot = {
    kind: "alloy.fission.live",
    version: 1,
    runId: truncateUtf8(panel?.runId, 128),
    phase: truncateUtf8(panel?.phase || "CREATED", 64),
    mode: truncateUtf8(panel?.mode, 32),
    agents: agents.map((agent) => {
      const status = FUSION_LIVE_STATUSES.has(agent.status) ? agent.status : "pending";
      const key = agentKey(agent);
      return {
        role: truncateUtf8(agent.role, 32),
        index: agent.index ?? null,
        status,
        model: truncateUtf8(agent.model || agent.requestedModel, 256),
        activity: truncateUtf8(
          agent.detail || (status === "pending" ? "Waiting" : "Working"),
          512,
        ),
        output: truncateUtf8(agent.output, 4_096, true),
        events: ticker
          .filter((event) => event?.agent === key)
          .slice(0, 3)
          .map((event) => {
            const status =
              event?.status === "complete" || event?.status === "failed"
                ? event.status
                : "running";
            return {
              tool: truncateUtf8(event.tool, 64),
              detail: truncateUtf8(event.detail, 256),
              status,
            };
          }),
      };
    }),
  };
  // reuse size cap logic below with agents list
  let serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  while (serializedBytes >= FUSION_LIVE_MAX_BYTES) {
    const agentsWithOutput = snapshot.agents.filter((agent) => agent.output);
    if (!agentsWithOutput.length) break;
    const reduction = Math.max(
      1,
      Math.ceil((serializedBytes - FUSION_LIVE_MAX_BYTES + 1) / agentsWithOutput.length),
    );
    for (const agent of agentsWithOutput) {
      const outputBytes = Buffer.byteLength(agent.output, "utf8");
      agent.output = truncateUtf8(agent.output, Math.max(0, outputBytes - reduction), true);
    }
    serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  }
  return snapshot;
}

export function createFusionLivePanel(panel) {
  const ticker = Array.isArray(panel?.ticker) ? panel.ticker : [];
  const snapshot = {
    kind: "alloy.fusion.live",
    version: 1,
    runId: truncateUtf8(panel?.runId, 128),
    phase: truncateUtf8(panel?.phase || "CREATED", 64),
    objective: truncateUtf8(panel?.objective, 1_024),
    agents: FUSION_ROLES.map((role) => {
      const agent = panel?.agents?.find((candidate) => candidate?.role === role) || {};
      const status = FUSION_LIVE_STATUSES.has(agent.status) ? agent.status : "pending";
      return {
        role,
        status,
        model: truncateUtf8(agent.model, 256),
        effort: truncateUtf8(agent.effort, 32),
        activity: truncateUtf8(
          agent.detail || (status === "pending" ? "Waiting" : "Working"),
          512,
        ),
        output: truncateUtf8(agent.output, 4_096, true),
        events: ticker
          .filter((event) => event?.agent === role)
          .slice(0, 3)
          .map((event) => ({
            tool: truncateUtf8(event.tool, 64),
            detail: truncateUtf8(event.detail, 256),
            status: truncateUtf8(event.status || "running", 16),
          })),
      };
    }),
  };
  let serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  while (serializedBytes >= FUSION_LIVE_MAX_BYTES) {
    const agentsWithOutput = snapshot.agents.filter((agent) => agent.output);
    if (!agentsWithOutput.length) break;
    const reduction = Math.max(
      1,
      Math.ceil((serializedBytes - FUSION_LIVE_MAX_BYTES + 1) / agentsWithOutput.length),
    );
    for (const agent of agentsWithOutput) {
      const outputBytes = Buffer.byteLength(agent.output, "utf8");
      agent.output = truncateUtf8(agent.output, Math.max(0, outputBytes - reduction), true);
    }
    serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  }
  return snapshot;
}
