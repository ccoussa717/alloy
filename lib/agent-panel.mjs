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
  "worker",
  "merger",
];

const ROLE_LABELS = {
  architect: "Architect",
  builder: "Builder",
  synthesizer: "Synthesizer",
};

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

export function createPanelState({ title = "ALLOY", runId, maxFixRounds = 0 } = {}) {
  return {
    title,
    runId,
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

function renderSinglePane(agent, label, width, maxRows = 14) {
  const inner = Math.max(1, width - 2);
  const title = `${label} [${agent?.status || "pending"}]`;
  const body = paneBody(agent, inner, maxRows);
  return [
    `┌${"─".repeat(inner)}┐`,
    `│${fit(title, inner)}│`,
    `├${"─".repeat(inner)}┤`,
    ...body.map((line) => `│${fit(line, inner)}│`),
    `└${"─".repeat(inner)}┘`,
  ];
}

export function renderFusionPaneLines(panel, width, { maxRows = 14 } = {}) {
  const safeWidth = Math.max(1, Math.floor(width || 80));
  const header = fit(
    `${panel.title || "ALLOY FUSION"}${panel.runId ? ` · ${panel.runId}` : ""}${panel.phase ? ` · ${panel.phase}` : ""}`,
    safeWidth,
  );
  const architect = panel.agents?.find((agent) => agent.role === "architect");
  const builder = panel.agents?.find((agent) => agent.role === "builder");
  const synthesizer = panel.agents?.find((agent) => agent.role === "synthesizer");
  const synthesisActive = synthesizer && synthesizer.status !== "pending";

  if (safeWidth < 20) {
    const agents = synthesisActive
      ? [["S", synthesizer]]
      : [["A", architect], ["B", builder]];
    return [
      header,
      ...agents.flatMap(([label, agent]) =>
        wrapPaneText(
          `${label} [${agent?.status || "pending"}]: ${agent?.output || agent?.detail || "Waiting..."}`,
          safeWidth,
        )
          .slice(-Math.max(1, Math.ceil(maxRows / agents.length)))
          .map((line) => fit(line, safeWidth)),
      ),
    ];
  }

  if (synthesisActive) {
    return [header, ...renderSinglePane(synthesizer, "Synthesizer", safeWidth, maxRows)];
  }
  if (safeWidth < 72) {
    return [
      header,
      ...renderSinglePane(architect, "Architect", safeWidth, Math.ceil(maxRows / 2)),
      ...renderSinglePane(builder, "Builder", safeWidth, Math.ceil(maxRows / 2)),
    ];
  }

  const leftWidth = Math.floor((safeWidth - 3) / 2);
  const rightWidth = safeWidth - 3 - leftWidth;
  const leftBody = paneBody(architect, leftWidth, maxRows);
  const rightBody = paneBody(builder, rightWidth, maxRows);
  const rows = Math.max(leftBody.length, rightBody.length, 1);
  const lines = [
    header,
    `┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`,
    `│${fit(`Architect [${architect?.status || "pending"}]`, leftWidth)}│${fit(`Builder [${builder?.status || "pending"}]`, rightWidth)}│`,
    `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`,
  ];
  for (let index = 0; index < rows; index++) {
    lines.push(
      `│${fit(leftBody[index], leftWidth)}│${fit(rightBody[index], rightWidth)}│`,
    );
  }
  lines.push(`└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`);
  return lines;
}
