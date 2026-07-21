/**
 * Agent panel model + pure render helpers for Alloy TUI widgets.
 * Status: pending | running | ok | fail | skip
 */

const ROLE_ORDER = ["scout", "planner", "builder", "fixer", "reviewer", "worker", "merger"];

/**
 * @typedef {{
 *   role: string,
 *   status: 'pending'|'running'|'ok'|'fail'|'skip',
 *   model?: string,
 *   detail?: string,
 *   startedAt?: number,
 *   endedAt?: number,
 *   usage?: { turns?: number, cost?: number, input?: number, output?: number },
 *   round?: number,
 * }} AgentRow
 */

/**
 * @typedef {{
 *   title: string,
 *   runId?: string,
 *   phase?: string,
 *   fixRound?: number,
 *   maxFixRounds?: number,
 *   agents: AgentRow[],
 * }} PanelState
 */

export function createPanelState({ title = "ALLOY", runId, maxFixRounds = 0 } = {}) {
  /** @type {PanelState} */
  return {
    title,
    runId,
    phase: "CREATED",
    fixRound: 0,
    maxFixRounds,
    agents: [],
  };
}

/**
 * Ensure a row exists for role (optionally keyed by role+round+index).
 */
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

/**
 * Render plain string lines (for tests / headless).
 */
export function renderPanelLines(panel, { maxDetail = 48 } = {}) {
  const lines = [];
  const head = [
    panel.title || "ALLOY",
    panel.runId ? `run ${panel.runId}` : null,
    panel.phase ? `phase ${panel.phase}` : null,
    panel.maxFixRounds
      ? `fix ${panel.fixRound || 0}/${panel.maxFixRounds}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(head);
  lines.push("─".repeat(Math.min(56, Math.max(24, head.length))));

  const sorted = [...panel.agents].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(String(a.role).replace(/\d+$/, ""));
    const ib = ROLE_ORDER.indexOf(String(b.role).replace(/\d+$/, ""));
    const sa = ia === -1 ? 99 : ia;
    const sb = ib === -1 ? 99 : ib;
    if (sa !== sb) return sa - sb;
    return (a.index || 0) - (b.index || 0);
  });

  if (!sorted.length) {
    lines.push("(no agents yet)");
    return lines;
  }

  for (const a of sorted) {
    const icon =
      a.status === "running"
        ? "◐"
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
    const label = a.round != null ? `${a.role}[fix${a.round}]` : a.role;
    const idx = a.index != null ? ` #${a.index}` : "";
    let detail = (a.detail || "").replace(/\s+/g, " ").trim();
    if (detail.length > maxDetail) detail = detail.slice(0, maxDetail - 1) + "…";
    const right = detail ? `  ${detail}` : "";
    lines.push(`${icon} ${label}${idx}${model}${elapsed}${cost}${right}`);
  }
  return lines;
}

function shortModel(m) {
  const s = String(m);
  if (s.includes("/")) return s.split("/").pop();
  return s.length > 18 ? s.slice(0, 16) + "…" : s;
}

/**
 * Colorize lines when Pi theme is available.
 * @param {*} theme - ctx.ui.theme
 */
export function renderPanelThemed(panel, theme) {
  const plain = renderPanelLines(panel);
  if (!theme?.fg) return plain;
  return plain.map((line, i) => {
    if (i === 0) return theme.fg("accent", line);
    if (i === 1) return theme.fg("dim", line);
    if (line.startsWith("✓")) return theme.fg("success", line);
    if (line.startsWith("✗")) return theme.fg("error", line);
    if (line.startsWith("◐")) return theme.fg("warning", line);
    if (line.startsWith("·") || line.startsWith("○")) return theme.fg("muted", line);
    return line;
  });
}
