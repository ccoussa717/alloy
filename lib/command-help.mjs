/**
 * Shared helpers for slash-command help/status panels and subcommand menus.
 *
 * Empty `/fission` (etc.) must show an *action* menu that runs setup/status/help —
 * not a fake list of command strings that dismisses on Enter.
 *
 * Help content uses ui.select as a scrollable reader with a clear Done row.
 */

/**
 * @param {string[]} lines
 * @param {{ doneLabel?: string }} [opts]
 * @returns {string[]}
 */
export function helpMenuLines(lines = [], opts = {}) {
  const done =
    opts.doneLabel ||
    "✓  Done — press Enter or Esc to close";
  const body = [];
  for (const raw of lines) {
    if (raw == null) continue;
    const line = String(raw);
    // Preserve visual spacing without zero-height empty options
    body.push(line.length === 0 ? " " : line);
  }
  // Drop trailing blank-only rows
  while (body.length && body[body.length - 1] === " ") body.pop();
  return [done, "─".repeat(Math.min(48, 48)), " ", ...body];
}

/**
 * @typedef {{ id: string, label: string, description?: string }} SubcommandAction
 */

/**
 * Format an actionable subcommand menu for ui.select.
 * @param {SubcommandAction[]} actions
 * @returns {string[]}
 */
export function subcommandMenuOptions(actions = []) {
  return actions.map((action) => {
    const label = String(action.label || action.id || "").trim();
    const desc = String(action.description || "").trim();
    return desc ? `${label}  —  ${desc}` : label;
  });
}

/**
 * Resolve the chosen row back to an action id.
 * @param {string | undefined | null} picked
 * @param {SubcommandAction[]} actions
 * @returns {string | null}
 */
export function resolveSubcommandChoice(picked, actions = []) {
  if (picked == null || picked === "") return null;
  const raw = String(picked).trim();
  const label = raw.split(/\s+—\s+/)[0].trim();
  const byId = actions.find((a) => a.id === raw || a.id === label);
  if (byId) return byId.id;
  const byLabel = actions.find((a) => a.label === label || a.label === raw);
  return byLabel?.id || null;
}

/** Standard workflow subcommands (order shown in empty-command menus). */
export const FISSION_SUBCOMMANDS = Object.freeze([
  { id: "help", label: "help", description: "How to use fission" },
  { id: "status", label: "status", description: "Show routes, roles, limits" },
  { id: "setup", label: "setup", description: "Configure models, roles, judge" },
]);

export const FUSION_SUBCOMMANDS = Object.freeze([
  { id: "help", label: "help", description: "How to use fusion" },
  { id: "status", label: "status", description: "Show role models and effort" },
  { id: "setup", label: "setup", description: "Configure architect / builder / synthesizer" },
]);

export const AUTO_SUBCOMMANDS = Object.freeze([
  { id: "help", label: "help", description: "How to use auto" },
  { id: "status", label: "status", description: "Show models and implement posture" },
  { id: "setup", label: "setup", description: "Configure roles + forceSandbox" },
]);

export const FORGE_SUBCOMMANDS = Object.freeze([
  { id: "help", label: "help", description: "How to use forge" },
]);

export const PACK_SUBCOMMANDS = Object.freeze([
  { id: "list", label: "list", description: "Show available packs" },
  { id: "help", label: "help", description: "How packs work" },
  { id: "apply ship", label: "apply ship", description: "Ship posture preset" },
  { id: "apply incident", label: "apply incident", description: "Incident posture preset" },
  { id: "apply economy", label: "apply economy", description: "Economy posture preset" },
]);

export function formatFissionCommandHelp() {
  return helpMenuLines([
    "Fission — adversarial multi-model review (plans, docs, ideas, or dirty tree)",
    " ",
    "Commands",
    "  /fission <request>             Run with default reviewer count",
    "  /fission <N> <request>         Override reviewer count for one run (1–max)",
    "  /fission setup                 Roles, models, judge, effort, severity (TUI)",
    "  /fission status                Show effective routes and limits",
    "  /fission help                  This screen",
    " ",
    "What it reviews (auto)",
    "  Freeform text always works — plans, ideas, documents, contracts",
    "  In a trusted dirty git repo, auto freezes the dirty tree as evidence",
    "  CI force-repo: alloy fission --repo --json \"…\"",
    " ",
    "Before you run",
    "  1. /login for every reviewer/judge provider",
    "  2. /fission setup  (or /setup) — enables orchestration + models",
    "  3. For dirty-tree code review only: /trust + uncommitted changes",
    " ",
    "How it works",
    "  N specialist reviewers in parallel → 1 independent judge",
    "  Reviewers are read-only on a frozen evidence packet",
    "  Exact model routes only — no fallback",
    "  Configured default N means N reviewers + 1 judge",
    " ",
    "Verdicts",
    "  PASS   no blocking finding at configured severity",
    "  FAIL   judge validated a blocking finding",
    "  NO_CHANGES (repo mode only) / INCOMPLETE / ABORTED / REFUSED",
    " ",
    "PASS is not “safe to merge” — it only means no validated blocking finding.",
    " ",
    "Also: /help fission · alloy fission --json \"…\" (CI, exit 0/1/2)",
  ]);
}

export function formatFusionCommandHelp() {
  return helpMenuLines([
    "Fusion — plan-only multi-model debate (does not write project code)",
    " ",
    "Commands",
    "  /fusion <objective>     Architect + Builder → Synthesizer",
    "  /fusion setup           Pick models + effort per role",
    "  /fusion status          Show effective settings",
    "  /fusion help            This screen",
    " ",
    "Before you run",
    "  /login for each provider · /fusion setup once",
    "  Architect and Builder must be distinct models",
    " ",
    "Flow",
    "  Architect  ─┐",
    "  Builder    ─┴→ Synthesizer → one attributed plan",
    " ",
    "Eligible success = exactly three model roles. Failures stop early.",
    "Artifacts under ~/.pi/alloy/runs/ (or under a /forge run id).",
    " ",
    "Also: /help fusion · phase 1 of /forge",
  ]);
}

export function formatAutoCommandHelp() {
  return helpMenuLines([
    "Auto — implement with scout → plan → build → review ↺ fix",
    " ",
    "Commands",
    "  /auto <request>     Run the implement pipeline",
    "  /auto setup         Role models + forceSandbox toggle",
    "  /auto status        Effective models + implement posture",
    "  /auto help          This screen",
    "  /setup              Full path: fusion → fission → auto",
    " ",
    "Models (not main /model)",
    "  profiles.*  canonical map (research / plan / code / review)",
    "  roles.*     optional auto overrides (synced by /auto setup)",
    " ",
    "Implement permissions",
    "  Default: inherit session /permissions",
    "  forceSandbox: always Docker for implement (fail closed if no Docker)",
    " ",
    "Flow",
    "  scout → plan → checkpoint → build (worktree)",
    "       → diagnostics → review ↺ fixer (maxFixRounds)",
    " ",
    "Also: /pack apply ship|incident|economy · /runs · /help auto",
  ]);
}

export function formatForgeCommandHelp() {
  return helpMenuLines([
    "Forge — full multi-model spine under one run id",
    " ",
    "Commands",
    "  /forge <request>     fusion → fission-plan → auto → fission-diff",
    "  /forge help          This screen",
    " ",
    "Before you run",
    "  /setup   (or /fusion setup · /fission setup · /auto setup)",
    "  /login for every provider · /trust for fission",
    " ",
    "Spine",
    "  fusion          plan debate + synthesis",
    "  fission-plan    pre-build review (NO_CHANGES OK if no code yet)",
    "  auto            implement in worktree (seeded with context)",
    "  fission-diff    post-build review of worktree/cwd diff",
    " ",
    "Pre-build fission FAIL blocks implement.",
    "Post-build fission FAIL fails the forge run even if auto passed.",
    " ",
    "Artifacts: ~/.pi/alloy/runs/<project>/<runId>/",
    "Standalone still available: /fusion · /fission · /auto",
    " ",
    "Also: /help forge · /help workflows",
  ]);
}

export function formatPackCommandHelp() {
  return helpMenuLines([
    "Policy packs — local posture presets (no remote control plane)",
    " ",
    "  /pack list",
    "  /pack apply ship | incident | economy",
    " ",
    "  ship       Worktrees on; implement inherits session; high fission severity",
    "  incident   forceSandbox + ask-all session; careful review posture",
    "  economy    Lower cost/concurrency; fewer reviewers; forceSandbox",
    " ",
    "Packs never set model routes — run /setup (or per-workflow setup) for models.",
  ]);
}

export function formatSetupCommandHelp() {
  return helpMenuLines([
    "Setup — one path for multi-model configuration",
    " ",
    "  /setup",
    "    1) /fusion setup   architect · builder · synthesizer",
    "    2) /fission setup  (run when prompted)",
    "    3) /auto setup     roles + forceSandbox",
    " ",
    "Or run each setup alone. Then:",
    "  /fusion status · /fission status · /auto status",
    "  /trust  before fission on this repo",
    " ",
    "Mental model: Chat · Workflows · Policy — see /help start",
  ]);
}
