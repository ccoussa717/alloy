/**
 * Shared helpers for slash-command help/status panels.
 *
 * Help is shown via ui.select (list of lines). Empty lines become blank options;
 * normalize them and always lead with a clear close action.
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

export function formatFissionCommandHelp() {
  return helpMenuLines([
    "Fission — adversarial multi-model review of the current dirty tree",
    " ",
    "Commands",
    "  /fission <contract>            Run with default reviewer count",
    "  /fission <N> <contract>        Override reviewer count for one run (1–max)",
    "  /fission setup                 Roles, models, judge, effort, severity (TUI)",
    "  /fission status                Show effective routes and limits",
    "  /fission help                  This screen",
    " ",
    "Before you run",
    "  1. /login for every reviewer/judge provider",
    "  2. /fission setup  (or /setup)",
    "  3. /trust this repository (trusted repos only)",
    "  4. Have a dirty/staged diff (clean tree → NO_CHANGES)",
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
    "  NO_CHANGES / INCOMPLETE / ABORTED / REFUSED",
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
