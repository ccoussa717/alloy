/**
 * Alloy help catalog — topics, commands, and search.
 *
 * Design goals:
 * - First-time path is obvious (start → auth → workflows)
 * - Every topic has a one-line summary for the picker
 * - Groups keep the menu scannable
 * - Bodies stay accurate for operators but use plain language first
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   summary: string,
 *   group: string,
 *   tags: string[],
 *   body: string,
 *   related?: string[],
 * }} HelpTopic
 */

import { OPENTUI_COMMANDS } from "./opentui-commands.mjs";

// Pi does not include built-ins in ExtensionAPI.getCommands(). Keep this list
// pinned to the bundled Pi runtime; the unit test catches drift on upgrades.
export const PI_NATIVE_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  {
    name: "model",
    description: "Select model (opens selector UI)",
    argumentHint: "<provider/model>",
  },
  {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling",
  },
  {
    name: "export",
    description: "Export session (HTML default, or specify path: .html/.jsonl)",
  },
  {
    name: "import",
    description: "Import and resume a session from a JSONL file",
  },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  {
    name: "fork",
    description: "Create a new fork from a previous user message",
  },
  {
    name: "clone",
    description: "Duplicate the current session at the current position",
  },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  {
    name: "trust",
    description: "Save project trust decision for future sessions",
  },
  {
    name: "login",
    description: "Configure provider authentication",
    argumentHint: "<provider>",
  },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  {
    name: "reload",
    description:
      "Reload keybindings, extensions, skills, prompts, themes, and context files",
  },
  { name: "quit", description: "Quit pi" },
];

/** Menu section order (picker + topic index). */
export const HELP_GROUPS = [
  { id: "start", label: "Start here" },
  { id: "workflows", label: "Multi-model workflows" },
  { id: "session", label: "Session controls" },
  { id: "tools", label: "Daily tools" },
  { id: "reference", label: "Reference" },
];

/** Common aliases → topic id (also used by free-text /help <word>). */
export const HELP_ALIASES = Object.freeze({
  "getting-started": "start",
  quickstart: "start",
  intro: "start",
  begin: "start",
  about: "overview",
  what: "overview",
  login: "auth",
  providers: "auth",
  oauth: "auth",
  subscription: "auth",
  docker: "sandbox",
  isolation: "sandbox",
  container: "sandbox",
  approval: "permissions",
  approvals: "permissions",
  policy: "permissions-policy",
  capability: "permissions-policy",
  thinking: "effort",
  reasoning: "effort",
  checkpoint: "git",
  worktree: "git",
  undo: "git",
  diagnose: "diagnostics",
  tests: "diagnostics",
  lint: "diagnostics",
  subagent: "agents",
  agent: "agents",
  profiles: "agents",
  pack: "packs",
  packs: "packs",
  ship: "packs",
  incident: "packs",
  economy: "packs",
  identity: "cli",
  runs: "cli",
  ci: "cli",
  fission: "fission",
  fusion: "fusion",
  forge: "forge",
  auto: "auto",
  pipeline: "workflows",
  multi: "workflows",
  "multi-model": "workflows",
  slash: "commands",
  cheatsheet: "commands",
  paths: "config",
  settings: "config",
  env: "config",
});

/**
 * @type {HelpTopic[]}
 */
export const HELP_TOPICS = [
  // ── Start here ──────────────────────────────────────────────────────────
  {
    id: "start",
    title: "Start here (first 5 minutes)",
    summary: "Install → login → model → first useful commands",
    group: "start",
    tags: [
      "start",
      "quickstart",
      "getting-started",
      "intro",
      "begin",
      "first",
      "onboarding",
    ],
    related: ["auth", "workflows", "permissions", "commands"],
    body: `Welcome. Alloy is a multi-model coding harness (on Pi) in one terminal.

## 1. Launch in your project

  cd /path/to/your-repo
  alloy

## 2. Connect a model provider

  /login                 # pick Claude, Codex/ChatGPT, or another OAuth provider
  /login xai             # Grok subscription
  /model                 # choose the active chat model
  /doctor                # if something looks wrong (never prints secrets)

Repeat /login for each provider you want multi-model workflows to use.

## 3. Try the three levels of power

  Just chat              Ask anything in the project (uses /model)
  /fusion <goal>         Two plans → one synthesis (read-only)
  /auto <task>           Implement with scout → build → review → fix
  /forge <task>          Full spine: plan → review → implement → re-review

## 4. Safety knobs you should know

  Shift+Tab              Toggle Build ↔ Plan (Plan is hard read-only)
  /permissions           Approval prompts (ask-all … ask-none)
  /permissions sandbox   Bash in Docker when available

## How to use this help

  /help                  Topic picker (grouped menu)
  /help start            This page
  /help workflows        Which multi-model path to pick
  /help search docker    Free-text search
  /help commands         Every slash command in this session

Tip: most workflow commands also have their own help:
  /fusion help · /fission help · /auto help · /forge help`,
  },
  {
    id: "overview",
    title: "What is Alloy?",
    summary: "Product map — what Alloy adds on top of Pi",
    group: "start",
    tags: ["intro", "overview", "start", "about", "pi", "harness"],
    related: ["start", "workflows", "auth"],
    body: `Alloy is a coding harness on top of Pi (pi.dev).

One terminal. Your best models, working as a system — not a different chat app
per vendor.

## What Alloy adds

- Subscriptions for Claude, Codex/ChatGPT, and Grok (plus API-key routes)
- Durable memory across sessions
- Skills (create, compose, promote with approval)
- Live MCP tool bridge
- Modes: chat / plan / build / review (Shift+Tab = Build ↔ Plan)
- Approval profiles + optional Docker sandbox
- Git checkpoints & worktrees
- Diagnostics (typecheck / lint / test when the repo defines them)
- Multi-model workflows (see /help workflows):
    /fusion   plan debate → one synthesis
    /fission  multi-role adversarial review + judge
    /auto     implement with scout / plan / build / review / fix
    /forge    full spine: fusion → fission → auto → fission
- Live agent panel during multi-agent runs
- Local policy packs, run index, and CI CLI (Alloy 1.0+)

## Mental model

  Main chat /model     = only the interactive session
  Workflow setups      = child agents use their own model routes
  Permissions          = what needs your approval
  Modes (Plan/Build)   = hard tool gates (Plan never writes)

Launch: alloy
First-time path: /help start
Core Pi features (sessions, /model, /tree, /compact) still work.`,
  },
  {
    id: "auth",
    title: "Login & providers",
    summary: "Connect Claude, Codex, Grok — then verify with /doctor",
    group: "start",
    tags: [
      "login",
      "auth",
      "subscription",
      "claude",
      "codex",
      "grok",
      "provider",
      "oauth",
      "api-key",
    ],
    related: ["start", "workflows", "config"],
    body: `You need at least one authenticated provider before useful work.

## Preferred: OAuth / subscriptions

  /login                 Choose one available OAuth provider
  /login xai             Grok subscription (common second login)
  /providers             Quick status of known routes
  /doctor                Versions, providers, catalog (never secrets)
  alloy --version        Alloy + Pi + Node (from a shell)

The provider picker labels routes as configured or not. Green "configured"
means local credential evidence exists — send a real prompt to confirm e2e.

## API keys (optional)

  ANTHROPIC_API_KEY      anthropic/... routes
  OPENAI_API_KEY         openai/... routes (not the same as Codex OAuth)
  XAI_API_KEY            xai/... API routes

openai-codex/... uses ChatGPT subscription auth from /login.

## Local engines

Ollama, llama.cpp, and LM Studio are auto-detected when already running.
Restart Alloy after starting an engine. See /doctor.

## Switch models anytime

  /model

OpenTUI login is OAuth-only (RPC input is not masked). Put API keys in the
environment or ~/.pi/agent/models.json — never paste them into chat.`,
  },
  {
    id: "workflows",
    title: "Workflows: which path?",
    summary: "Fusion · fission · auto · forge — when to use each",
    group: "start",
    tags: [
      "workflows",
      "forge",
      "fusion",
      "fission",
      "auto",
      "setup",
      "combinations",
      "multi-model",
      "pipeline",
      "choose",
      "which",
    ],
    related: ["fusion", "fission", "auto", "forge", "packs", "cli"],
    body: `Pick a path by goal. Deep dives: /help fusion | fission | auto | forge

## Comparison

| Command  | Purpose                              | Writes code? | Setup              |
|----------|--------------------------------------|--------------|--------------------|
| /fusion  | Two plans + synthesizer → one plan   | No           | /fusion setup      |
| /fission | N role reviewers + judge on evidence | No           | /fission setup     |
| /auto    | Scout→plan→build→check→review↺fix  | Yes (worktree)| /auto setup       |
| /forge   | fusion → fission → auto → fission    | Yes          | all three setups   |

Important: main chat /model is ONLY the interactive session.
Child workflows use their own routes from setup/config.

## Setup checklist (before /forge)

1. /login  (and /login xai, etc.) for every provider you will use
2. /fusion setup   — architect, builder, synthesizer (+ effort)
3. /fission setup  — reviewers, role catalog, models, judge, severity
4. /auto setup     — role models + forceSandbox toggle
   (implement inherits session /permissions unless forceSandbox)
5. Or one path: /setup  (fusion → fission reminder → auto)
6. Optional: /pack apply ship|incident|economy  (posture only; no models)
7. /fusion status · /fission status · /auto status
8. /trust the project if you will run fission

Models: profiles.* (canonical). roles.* optional auto overrides.
orchestration.roles is legacy fallback. See /help agents.

## What to type

| Goal                              | Command                          |
|-----------------------------------|----------------------------------|
| Fast single-model work            | just chat (after /model)         |
| Multi-model plan only             | /fusion <objective>              |
| Review current dirty tree         | /fission <contract>              |
| Implement with fix loops          | /auto <request>                  |
| Full quality path                 | /forge <request>                 |
| Plan then implement yourself      | /fusion … then /auto …           |
| Apply a local preset              | /pack apply ship|incident|economy|
| List recent multi-agent runs      | /runs  or  alloy runs            |
| Free-form extra agent             | /agent name model=… <task>       |
| CI fission (non-interactive)      | alloy fission --json "…"         |

## Forge spine (shared artifacts)

  fusion/
    → fission-plan/   (NO_CHANGES OK if no code yet; FAIL blocks implement)
    → auto/           (seeded with fusion synthesis + fission findings)
    → fission-diff/   (reviews worktree if present)

Run root: ~/.pi/alloy/runs/<project>/<runId>/

## Rules of thumb

- Fusion  = productive disagreement → one plan
- Fission = many hostile reviews → adjudicated findings (not one blended essay)
- Auto    = execution engine under policy
- Forge   = all of the above, one run id

More: /help fusion · /help fission · /help auto · /help forge · /help config`,
  },

  // ── Multi-model workflows ───────────────────────────────────────────────
  {
    id: "fusion",
    title: "Fusion — plan debate",
    summary: "Architect + Builder → synthesizer (read-only, no code writes)",
    group: "workflows",
    tags: [
      "fusion",
      "multi-model",
      "architect",
      "builder",
      "synthesizer",
      "setup",
      "plan",
    ],
    related: ["workflows", "forge", "fission", "panel"],
    body: `Plan-only multi-model debate. Does not write project code.

  /fusion <objective>
  /fusion setup
  /fusion status
  /fusion help
  Tool: alloy_fusion

## Flow

  Architect  ─┐
  Builder    ─┴→ Synthesizer → one attributed recommendation

Run /fusion setup first (TUI): provider/model + effort per role.
Architect and Builder must be distinct models.

## Config (~/.pi/alloy/config.json)

  "fusion": {
    "architectModel": "anthropic/...",
    "builderModel": "openai-codex/...",
    "synthesizerModel": "anthropic/...",
    "architectEffort": "high",
    "builderEffort": "medium",
    "synthesizerEffort": "low"
  }

## Notes

- At most three model calls per run (exactly three when eligible and successful)
- Auth, proposal, abort, or budget failures stop earlier
- Effort is a request; Pi clamps unsupported values to the model
- Artifacts: role proposals, synthesis, usage, status under ~/.pi/alloy/runs/

Also phase 1 of /forge. See /help workflows · /help forge.`,
  },
  {
    id: "fission",
    title: "Fission — adversarial review",
    summary: "N specialist reviewers + independent judge on the dirty tree",
    group: "workflows",
    tags: [
      "fission",
      "review",
      "adversarial",
      "judge",
      "trusted",
      "setup",
      "contract",
    ],
    related: ["workflows", "forge", "cli", "start"],
    body: `Adversarial multi-role review of the current change against a contract.

  /fission <request>              Default reviewer count
  /fission <reviewers> <request>  Override count for one run (≤ max)
  /fission setup                  Roles, models, N, effort, severity
  /fission status
  /fission help
  Tool: alloy_fission

  CI:  alloy fission --json "Review PR changes"   (exit 0 / 1 / 2)

## Before first use

1. /fission setup  (interactive TUI — saves global defaults)
2. /trust the project (trusted repositories only)
3. Have a dirty tree or staged/unstaged diff (clean tree → NO_CHANGES)

## How it works

N specialist reviewers in parallel → 1 independent judge.

Predefined roles (pick in setup), for example:
  Security, Adversarial code review, Cynical customer, Correctness,
  Architecture, Tests, Performance, Privacy, Ops, General.

Default packs still apply if fission.roles is unset.
Configured default N means N reviewers + 1 judge (e.g. 3 → 4 agents).
maxReviewers default/cap is 5. You must configure that many distinct routes.
Judge is separate. Exact routes only — no fallback.

## Trust boundary

Fission supports trusted repositories only. Normal Git config and attributes
may execute helpers while evidence is captured; hostile repositories are
unsupported. Reviewers and the judge receive read-only tools only.

## Verdicts

  COMPLETE / INCOMPLETE / ABORTED / REFUSED / NO_CHANGES
  PASS  = no submitted blocking finding validated
  FAIL  = Judge validated a finding at blocking severity

PASS is not a broad quality guarantee. Fission does not run tests, make fixes,
merge, or deploy.

## Config keys

  fission.models, fission.roles, fission.judgeModel, fission.modelFamilies
  fission.defaultReviewers (default 3), fission.maxReviewers (default/cap 5)
  fission.blockingSeverity (default medium)
  fission.reviewerEfforts, fission.judgeEffort

Trusted project config may lower defaultReviewers/maxReviewers but never raise
global values. Project model/judge routes are ignored.

Also used twice inside /forge (plan + post-diff). See /help workflows · /help forge.`,
  },
  {
    id: "auto",
    title: "Auto — implement with fix loops",
    summary: "Scout → plan → build → diagnose → review ↺ fix (writes code)",
    group: "workflows",
    tags: [
      "auto",
      "pipeline",
      "fix",
      "agents",
      "multi-agent",
      "setup",
      "implement",
      "build",
    ],
    related: ["workflows", "forge", "sandbox", "packs", "permissions"],
    body: `Implement-only multi-agent pipeline. Prefers a Git worktree.

  /auto <request>
  /auto setup
  /auto status
  /auto help
  Tool: alloy_auto

## Flow

  scout → plan → checkpoint → build (worktree)
       → diagnostics → review
       ↺ fixer (if VERDICT: FAIL or diag fail), up to maxFixRounds

## Setup

  /auto setup     Role models + forceSandbox (TUI)
  /auto status    What will actually run
  /setup          Full path: fusion → fission → auto

Models are NOT the main chat /model.

## Implement permissions (simple)

Default: inherit session /permissions.
Optional: auto.forceSandbox = true → always Docker sandbox for implement
(fail closed if Docker is missing).

Overrides still work: ALLOY_IMPLEMENT_PROFILE, auto.implementPermissionProfile

## Config (~/.pi/alloy/config.json)

  "profiles": { "research"|"plan"|"code"|"review": { "model": "provider/model" } }
  "roles": { "scout"|"planner"|"builder"|"fixer"|"reviewer": { "model": "…" } }
  "auto": { "useWorktree": true, "forceSandbox": false }
  "budgets": { "maxFixRounds": 2 }

roles.* override profiles.* for auto. See /help agents.

## Related commands

  /pack list · /pack apply ship|incident|economy
  /runs      Recent run index + artifacts under ~/.pi/alloy/runs/
  /panel     Clear live agent widget

Also the implement phase inside /forge.
Compare: /help workflows · /help forge · /help fusion · /help fission`,
  },
  {
    id: "forge",
    title: "Forge — full quality spine",
    summary: "fusion → fission → auto → fission under one run id",
    group: "workflows",
    tags: [
      "forge",
      "pipeline",
      "spine",
      "fusion",
      "fission",
      "auto",
      "multi-model",
      "setup",
    ],
    related: ["workflows", "fusion", "fission", "auto", "packs"],
    body: `End-to-end multi-model path with shared run artifacts.

  /forge <request>
  /forge help
  Tool: alloy_forge

  CLI:  alloy forge --json "<request>"

## Spine

  fusion (plan debate + synthesis)
    → fission (pre-build review; NO_CHANGES OK if no diff yet)
    → auto (implement in worktree; seeded with fusion + fission context)
    → fission (post-build review on worktree/cwd diff)

Standalone tools remain available:
  /fusion   plan only
  /fission  adversarial review only
  /auto     implement-only pipeline

## Setup before first /forge

  1. /login for every provider you will use
  2. /fusion setup   (architect / builder / synthesizer)
  3. /fission setup  (roles, models, judge, severity)
  4. /auto setup     (roles + forceSandbox)  or  /setup
  5. Optional: /pack apply ship|incident|economy
  6. /fusion status · /fission status · /auto status
  7. /trust the project (fission requires trust)

## Artifacts

  ~/.pi/alloy/runs/<project>/<runId>/
    forge.json · summary.json · events.jsonl · request.md
    fusion/ · fission-plan/ · auto/ · fission-diff/ · phases/

Pre-build fission FAIL (blocking findings) stops before auto.
Post-build fission FAIL fails the forge run even if auto passed.

See /help workflows for the comparison table and combinations.`,
  },
  {
    id: "agents",
    title: "Free-form sub-agents",
    summary: "/agent and profiles when you need one extra model on a task",
    group: "workflows",
    tags: [
      "agent",
      "agents",
      "subagent",
      "multi-model",
      "profiles",
      "task",
      "bg",
    ],
    related: ["workflows", "panel", "permissions"],
    body: `Spawn a separate Pi child for a one-off task (optional model override).

  /agent <name> <task>
  /agent <name> profile=research <task>
  /agent <name> model=xai/grok-4.5 <task>
  /agent <name> use anthropic/claude-opus-4-6: Review this
  /agent bg <name> profile=code <task>

  /agents                 List agents (select to view)
  /agents view <id|name>  Full transcript
  /profiles               Model profile map

Tool (main agent can call): alloy_task

## Default profiles (~/.pi/alloy/config.json)

  research → Grok
  code     → Codex / GPT
  review   → Claude Opus
  plan     → Claude Sonnet

Login each provider once (/login, /login xai), then any agent can use any
logged-in model.

For structured pipelines prefer /auto or /forge over free-form agents.
Panel below the editor shows live status — /help panel.`,
  },
  {
    id: "packs",
    title: "Policy packs",
    summary: "Local presets: ship · incident · economy (/pack apply)",
    group: "workflows",
    tags: [
      "pack",
      "packs",
      "ship",
      "incident",
      "economy",
      "preset",
      "policy",
    ],
    related: ["auto", "workflows", "config", "permissions"],
    body: `Local, open-source presets. No remote control plane.

  /pack list
  /pack apply ship|incident|economy

## Packs

  ship       Worktrees on; implement inherits session; fission severity high
  incident   forceSandbox implement; ask-all session; high severity
  economy    Lower cost/concurrency; fewer reviewers; forceSandbox

## Guarantees

- Packs merge posture only (budgets, forceSandbox, counts) — not model routes
- Fission models still come from /fission setup
- Re-run any /… setup afterward if needed

Suggested: /setup (or /fusion + /fission + /auto setup), then optional /pack apply.`,
  },
  {
    id: "panel",
    title: "Live agent panel",
    summary: "Status widget under the editor during multi-agent runs",
    group: "workflows",
    tags: ["panel", "tui", "widget", "status", "live"],
    related: ["auto", "fusion", "fission", "forge"],
    body: `During /auto, /fusion, /fission, and /forge, Alloy paints a status widget
below the editor:

  ✓ scout    model   8.2s
  ◐ builder  model   edit
  · reviewer         queued

  /panel                 Clear the widget

Footer also shows phase hints such as auto:BUILDING fix1/2.

If the widget is stale after an abort, /panel clears it.`,
  },

  // ── Session controls ────────────────────────────────────────────────────
  {
    id: "modes",
    title: "Modes (Shift+Tab)",
    summary: "Build ↔ Plan — Plan is hard read-only",
    group: "session",
    tags: ["mode", "plan", "build", "review", "chat", "shift+tab", "readonly"],
    related: ["permissions", "effort", "start"],
    body: `Operating mode is separate from approval profiles.

  Shift+Tab              Cycles Build → Plan → Build
  /mode chat|plan|build|review
  /plan  /build  /review Shortcuts

## What each mode does

  plan / review   Hard read-only: no write/edit/bash/MCP
                  Multi-agent tools (auto/fusion/fission/forge/task) denied
  build / chat    Use the active permission profile for approvals

Shift+Tab does NOT change permissions or effort.
  Permissions → /permissions cycle
  Thinking    → /effort`,
  },
  {
    id: "permissions",
    title: "Approval profiles",
    summary: "ask-all · ask-some · ask-dangerous · ask-none (+ sandbox)",
    group: "session",
    tags: [
      "permissions",
      "ask",
      "ask-all",
      "ask-some",
      "ask-dangerous",
      "ask-none",
      "sandbox",
      "security",
      "approval",
    ],
    related: ["modes", "sandbox", "auto", "permissions-policy"],
    body: `Approval profiles control when the main agent asks before acting.
They are separate from Build/Plan operating modes.

## Profiles

  ask-all        Ask me for everything
  ask-some       Ask me for some things (edits + shell; inspection bash free)
  ask-dangerous  Ask me for dangerous things only (default)
  ask-none       Don't ask me for anything

  /permissions              Show menu
  /permissions ask-some     Set directly
  /permissions cycle        Walk the four ask-* profiles

## Sandbox (Docker) is separate

  /permissions sandbox
  /sandbox status|start|stop

Sandbox is not part of /permissions cycle. Details: /help sandbox

## Implement children (/auto, /forge)

By default implement inherits this session profile.
auto.forceSandbox = true forces Docker sandbox for implement only.

Build ↔ Plan modes: Shift+Tab or /mode (see /help modes).
Thinking level: /effort (not approval profiles).`,
  },
  {
    id: "permissions-policy",
    title: "Capability policy (deep)",
    summary: "How tools are gated — plan mode, unknown tools, trust the gate",
    group: "session",
    tags: [
      "permissions",
      "policy",
      "plan",
      "review",
      "ask",
      "sandbox",
      "readonly",
      "capability",
    ],
    related: ["permissions", "modes", "sandbox"],
    body: `Approval profiles (set with /permissions or /permissions cycle):
  ask-all | ask-some | ask-dangerous | ask-none | sandbox

## Plan / review modes are hard read-only

  - bash is always denied (no prefix allowlist)
  - write/edit denied
  - alloy_auto, alloy_worktree, alloy_remember, alloy_diagnostics,
    alloy_fusion, alloy_fission, alloy_forge, alloy_task denied
  - MCP tools denied by default (no name heuristics)

## Capability gate

Every tool has explicit capabilities. Unknown tools = external_side_effect.
Trust this gate over model claims about what it can do.

Day-to-day usage: /help permissions · /help modes · /help sandbox`,
  },
  {
    id: "sandbox",
    title: "Docker sandbox",
    summary: "Bash in a container — network none, project mounted",
    group: "session",
    tags: [
      "sandbox",
      "docker",
      "container",
      "isolation",
      "network",
      "security",
    ],
    related: ["permissions", "auto", "diagnostics"],
    body: `When the session profile is sandbox, bash (and !shell via user_bash)
runs inside a Docker container for that session.

## Defaults

  image:   node:22-bookworm
  network: none
  mount:   project dir → /workspace
  limits:  2g RAM, 2 CPUs
  flags:   --cap-drop ALL, no-new-privileges

  /sandbox                   Status
  /sandbox start|stop        Manual lifecycle
  /permissions sandbox       Enable for the session

## Config (~/.pi/alloy/config.json)

  "sandbox": {
    "image": "node:22-bookworm",
    "network": "none",
    "memory": "2g",
    "cpus": "2",
    "autoPull": true
  }

Requires Docker CLI + a running daemon. Fail-closed if Docker is missing.

## /auto and /forge implement children

Implement inherits session approvals unless auto.forceSandbox is true.
When sandbox is required and Docker is missing, implement fails closed.
See /help auto.

Diagnostics (/diagnose) are host commands, not Docker bash — see /help diagnostics.`,
  },
  {
    id: "effort",
    title: "Effort / thinking",
    summary: "Reasoning level for the active model (/effort, not Shift+Tab)",
    group: "session",
    tags: ["effort", "thinking", "reasoning", "levels"],
    related: ["modes", "permissions"],
    body: `Thinking / reasoning effort for the active model:

  /effort                 Show current + list
  /effort high            Set level
  /effort cycle
  /thinking high          Alias

Levels: off | minimal | low | medium | high | xhigh | max

CLI:
  alloy --thinking high
  alloy --model xai/your-model:high

Shift+Tab = Build/Plan modes, not effort.`,
  },

  // ── Daily tools ─────────────────────────────────────────────────────────
  {
    id: "memory",
    title: "Durable memory",
    summary: "Facts that survive /new — /remember and /memory",
    group: "tools",
    tags: ["memory", "remember", "persist", "facts"],
    related: ["start", "honesty"],
    body: `Session history is Pi's JSONL tree. Alloy adds durable facts that survive /new.

  /remember <fact>           Project memory
  /remember user: <fact>     User-global memory
  /memory list
  /memory search <query>
  /memory forget <id>

Tools: alloy_remember, alloy_memory_search
Stored under ~/.pi/alloy/memory/

Never store secrets in memory.`,
  },
  {
    id: "skills",
    title: "Skills",
    summary: "On-demand playbooks — capture, promote, never silent mutation",
    group: "tools",
    tags: ["skills", "skill-capture", "promote", "self-improve"],
    related: ["start", "commands"],
    body: `Skills are on-demand capability packs (Agent Skills standard).

  /skill:name                Invoke a skill
  /skill-capture <name>      Draft a skill
  /skill-promote <name>      Approve + install (required for self-improve)
  /skill-drafts              List drafts

Rule: propose → approve → promote. No silent skill mutation.
Skills may compose other skills (max depth 3).
Starter pack: testing, git-hygiene, skill-capture.`,
  },
  {
    id: "mcp",
    title: "MCP servers",
    summary: "Connect stdio / HTTP / SSE tools into the same policy gate",
    group: "tools",
    tags: ["mcp", "tools", "servers", "connect", "http", "sse"],
    related: ["permissions", "config"],
    body: `Pi has no built-in MCP. Alloy bridges external servers:

  stdio            local command servers
  http             Streamable HTTP (remote MCP services)
  sse              legacy Server-Sent Events HTTP

Config: ~/.pi/alloy/mcp.json  (or project .pi/alloy-mcp.json)

  /mcp list|status           Servers + tool counts (no tool names)
  /mcp tools                 Full tool name list (when you need it)
  /mcp connect               Start enabled servers, register tools
  /mcp disconnect
  /mcp path

HTTP example (secrets via env expansion — do not commit tokens):
  {
    "transport": "http",
    "url": "https://host.example/mcp",
    "headers": { "Authorization": "Bearer \${MCP_TOKEN}" },
    "enabled": true
  }

url-only entries default to http. Tools appear as mcp_<server>_<tool>
and respect Alloy policy. Global mcp.enabled must be true for any connection.
Optional: "mcp.connectOnStart": true connects enabled global servers only;
project servers always require /mcp connect.`,
  },
  {
    id: "git",
    title: "Checkpoints & worktrees",
    summary: "Snapshots you can undo; isolated builder trees",
    group: "tools",
    tags: ["git", "checkpoint", "undo", "worktree", "branch"],
    related: ["auto", "start"],
    body: `## Checkpoints (recoverable snapshots)

  /checkpoint [label]
  /checkpoints
  /undo [id]                 Confirms; headless denied

## Worktrees (isolated builders)

  /worktree create [role] [taskId]
  /worktree list|remove|diff

/auto prefers worktrees when the project is a Git repo.
Stored under ~/.pi/alloy/checkpoints and ~/.pi/alloy/worktrees/`,
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    summary: "Repo typecheck / lint / test — used by /auto rounds",
    group: "tools",
    tags: ["diagnose", "test", "lint", "typecheck", "diagnostics"],
    related: ["auto", "sandbox"],
    body: `  /diagnose [--no-test]
  Tool: alloy_diagnostics

Detects Node/TS/Python/Rust/Go and runs typecheck/lint/test when available.
Used automatically at the end of /auto rounds.

Diagnostics are repository-defined host commands, not Docker-sandboxed Bash.
Their environment is allowlisted to exclude provider keys and arbitrary host
environment variables, but commands retain same-user filesystem and network
access. The model-callable tool requires approval under the default permission
profile. /auto fails closed instead of running diagnostics when sandbox
isolation is required.`,
  },
  {
    id: "honesty",
    title: "Honesty policy",
    summary: "No invented facts — /whoami is authoritative for model identity",
    group: "tools",
    tags: ["honesty", "hallucination", "facts", "whoami", "truth"],
    related: ["memory", "start"],
    body: `Alloy honesty policy (on by default).

Rules:
  - Never invent facts, files, APIs, command output, or model names
  - Never confidently guess — say "I don't know" and look it up
  - Model identity only from the harness (see /whoami)
  - Prefer tools over memory for codebase claims

Commands:
  /whoami     Authoritative model + Alloy version
  /honesty    Show full policy

Config: honesty.enabled (default true) in ~/.pi/alloy/config.json`,
  },

  // ── Reference ───────────────────────────────────────────────────────────
  {
    id: "cli",
    title: "CLI, runs & identity",
    summary: "alloy fission|forge|runs — CI exit codes and agent id",
    group: "reference",
    tags: [
      "cli",
      "ci",
      "runs",
      "identity",
      "agent-id",
      "exit",
      "json",
      "gha",
      "github",
    ],
    related: ["fission", "forge", "config", "workflows"],
    body: `Non-interactive commands (no TUI):

  alloy fission [--json] [--reviewers N] <request>
  alloy forge   [--json] <request>
  alloy runs    [--limit N]
  alloy --version | --help

## Exit codes (fission / forge)

  0   PASS or NO_CHANGES
  1   FAIL (blocking findings / failed spine)
  2   INCOMPLETE / config / runtime error

## Run index

Multi-agent runs append to:
  ~/.pi/alloy/runs/index.jsonl

List them:
  /runs
  alloy runs --limit 20

Artifacts still live under ~/.pi/alloy/runs/<project>/<runId>/

## Agent identity

  export ALLOY_AGENT_ID=my-agent

Env only — attributes rows in the run index.

## CI template

  docs/ci/github-actions-fission.yml

Installer channel:
  ALLOY_CHANNEL=stable   # default — latest GitHub release
  ALLOY_CHANNEL=main     # tip of main
  ALLOY_REF=v1.0.0       # pin tag or SHA`,
  },
  {
    id: "config",
    title: "Config paths & env",
    summary: "Where settings live — ~/.pi/alloy and project overrides",
    group: "reference",
    tags: [
      "config",
      "paths",
      "files",
      "settings",
      "env",
      "ALLOY_HOME",
      "identity",
    ],
    related: ["cli", "packs", "workflows", "auth"],
    body: `## Directories

Alloy home:  ~/.pi/alloy/
  config.json          global operator config
  mcp.json
  memory/
  skills-drafts/
  runs/                workflow artifacts + index.jsonl
  checkpoints/
  worktrees/

Pi home:     ~/.pi/agent/   (auth.json, sessions, skills)
Project:     .pi/alloy.json , .pi/alloy-mcp.json (trusted projects)

## Key blocks in config.json

  profiles.*          canonical models/tools (one map)
  roles.*             optional auto-role overrides (synced on /auto setup)
  fusion.* / fission.* from their setups
  auto.useWorktree
  auto.forceSandbox   implement always sandboxed when true
  orchestration.*     concurrency + legacy primaries
  budgets.*           maxCostUsd, maxFixRounds

Prefer: /setup  or  /fusion setup · /fission setup · /auto setup

## Environment

  ALLOY_HOME, ALLOY_PI_BIN, ALLOY_ROOT, PI_CODING_AGENT_DIR
  ALLOY_AGENT_ID               run-index attribution (env only)
  ALLOY_IMPLEMENT_PROFILE      optional implement override
  ALLOY_CHANNEL                installer: stable (default) or main

CLI: alloy fission|forge|runs · Workflow map: /help workflows`,
  },
  {
    id: "commands",
    title: "All slash commands",
    summary: "Live registry for this session (built-ins + extensions + skills)",
    group: "reference",
    tags: ["commands", "slash", "cheatsheet", "reference", "list"],
    related: ["start", "workflows"],
    body: `Use /help commands to render the complete active command registry.

OpenTUI combines its shared local controls with every active extension, prompt,
and skill command in the current session. Descriptions are shown beside each
name. The legacy renderer shows its complete Pi-native command set instead.

## Everyday cheatsheet

  /help · /help start · /help workflows · /help search <q>
  /login · /model · /doctor · /providers
  /permissions · /permissions cycle · /sandbox
  /mode · Shift+Tab (Build/Plan) · /effort
  /fusion · /fission · /auto · /forge · /pack · /runs · /panel
  /agent · /agents · /profiles
  /remember · /memory · /mcp · /checkpoint · /worktree · /diagnose
  /whoami · /honesty · /quit

Workflow-specific help:
  /fusion help · /fission help · /auto help · /forge help`,
  },
];

/**
 * Topics in menu order (group order, then catalog order within group).
 * @returns {HelpTopic[]}
 */
export function orderedTopics() {
  const groupRank = new Map(HELP_GROUPS.map((g, i) => [g.id, i]));
  return [...HELP_TOPICS].sort((a, b) => {
    const ga = groupRank.get(a.group) ?? 99;
    const gb = groupRank.get(b.group) ?? 99;
    if (ga !== gb) return ga - gb;
    return HELP_TOPICS.indexOf(a) - HELP_TOPICS.indexOf(b);
  });
}

/**
 * @returns {Array<{ id: string, title: string, summary: string, group: string, tags: string[] }>}
 */
export function listTopics() {
  return orderedTopics().map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary || "",
    group: t.group || "reference",
    tags: t.tags,
  }));
}

/**
 * Picker lines for the interactive /help menu (grouped, with summaries).
 * @returns {string[]}
 */
const PICKER_ID_WIDTH = 20;

export function formatTopicPickerLines() {
  const lines = [
    `${"search".padEnd(PICKER_ID_WIDTH)} Search all help by keyword`,
    `${"commands".padEnd(PICKER_ID_WIDTH)} Full slash-command list for this session`,
    "",
  ];
  let lastGroup = null;
  const groupLabel = new Map(HELP_GROUPS.map((g) => [g.id, g.label]));
  for (const t of orderedTopics()) {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      const label = groupLabel.get(t.group) || t.group;
      lines.push(`── ${label} ──`);
    }
    const summary = t.summary || t.title;
    lines.push(`${t.id.padEnd(PICKER_ID_WIDTH)} ${summary}`);
  }
  lines.push("");
  lines.push("Tip: /help start · /help workflows · /help search docker");
  return lines;
}

/**
 * Resolve a topic by id, title, or alias.
 * @param {string} idOrTitle
 * @returns {HelpTopic | null}
 */
export function getTopic(idOrTitle) {
  const q = String(idOrTitle || "").toLowerCase().trim();
  if (!q) return null;
  const aliased = HELP_ALIASES[q] || q;
  return (
    HELP_TOPICS.find((t) => t.id === aliased) ||
    HELP_TOPICS.find((t) => t.id === q) ||
    HELP_TOPICS.find((t) => t.title.toLowerCase() === q) ||
    HELP_TOPICS.find((t) => t.title.toLowerCase().startsWith(q) && q.length >= 4) ||
    null
  );
}

/**
 * Ranked search across id, title, summary, tags, body.
 * @returns {Array<HelpTopic & { score: number }>}
 */
export function searchHelp(query, { limit = 10 } = {}) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) {
    return orderedTopics()
      .slice(0, limit)
      .map((t) => ({ ...t, score: 0 }));
  }
  const terms = raw.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const t of HELP_TOPICS) {
    const summary = t.summary || "";
    const hay =
      `${t.id} ${t.title} ${summary} ${t.tags.join(" ")} ${t.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (t.id === term) score += 50;
      if (HELP_ALIASES[term] === t.id) score += 45;
      if (t.title.toLowerCase().includes(term)) score += 20;
      if (summary.toLowerCase().includes(term)) score += 18;
      if (t.tags.some((tag) => tag.includes(term))) score += 15;
      if (hay.includes(term)) score += 5;
      if (t.tags.some((tag) => tag.startsWith(term))) score += 8;
      if (t.id.startsWith(term)) score += 12;
    }
    if (score > 0) scored.push({ ...t, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/**
 * User-facing topic page (no raw tag dump at the top).
 * @param {HelpTopic | null} topic
 */
export function formatTopic(topic) {
  if (!topic) {
    return [
      "Topic not found.",
      "",
      "Try:",
      "  /help                 open the topic picker",
      "  /help start           first 5 minutes",
      "  /help workflows       multi-model map",
      "  /help search <query>  keyword search",
      "  /help commands        active command registry",
    ].join("\n");
  }

  const lines = [`# ${topic.title}`, ""];
  if (topic.summary) {
    lines.push(topic.summary, "");
  }
  lines.push(topic.body);

  const related = (topic.related || [])
    .map((id) => getTopic(id))
    .filter(Boolean);
  if (related.length) {
    lines.push("", "── Related ──");
    for (const r of related) {
      lines.push(`  /help ${r.id.padEnd(16)} ${r.summary || r.title}`);
    }
  }

  lines.push(
    "",
    "── Navigate ──",
    "  /help                 topic picker",
    "  /help search <query>  search",
    "  /help commands        active command registry",
  );
  return lines.join("\n");
}

/**
 * Compact multi-line index for tools / headless.
 */
export function formatTopicIndex() {
  const groupLabel = new Map(HELP_GROUPS.map((g) => [g.id, g.label]));
  const lines = ["Alloy help topics", ""];
  let lastGroup = null;
  for (const t of orderedTopics()) {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      lines.push(`${groupLabel.get(t.group) || t.group}:`);
    }
    lines.push(`  ${t.id.padEnd(PICKER_ID_WIDTH)} ${t.summary || t.title}`);
  }
  lines.push("", "Open: /help <id> · Search: /help search <query>");
  return lines.join("\n");
}

export function getHelpArgumentCompletions(prefix = "") {
  const raw = String(prefix).trimStart().toLowerCase();
  if (raw.trimStart().startsWith("search ")) return null;
  const candidates = [
    {
      value: "search ",
      label: "search <query>",
      description: "Search all help",
    },
    {
      value: "commands",
      label: "commands",
      description: "Full slash-command list for this session",
    },
    ...listTopics().map((topic) => ({
      value: topic.id,
      label: topic.id,
      description: topic.summary || topic.title,
    })),
  ];
  const filtered = candidates.filter((item) => item.value.startsWith(raw));
  return filtered.length ? filtered : null;
}

export function formatCommandCatalog(liveCommands = [], options = {}) {
  const frontend = options.frontend ?? process.env.ALLOY_FRONTEND;
  const nativeCommands =
    frontend === "opentui" ? OPENTUI_COMMANDS : PI_NATIVE_COMMANDS;
  const commands = [
    ...nativeCommands.map((command) => ({ ...command, source: "builtin" })),
    ...liveCommands,
  ];
  const unique = [];
  const seen = new Set();
  for (const command of commands) {
    if (!command?.name || seen.has(command.name)) continue;
    seen.add(command.name);
    unique.push(command);
  }

  const groups = [
    ["builtin", frontend === "opentui" ? "OpenTUI built-ins" : "Pi native"],
    ["extension", "Extensions"],
    ["prompt", "Prompts"],
    ["skill", "Skills"],
  ];
  const lines = [
    "Active command registry for this session.",
    "Also: /help start · /help workflows · /help search <query>",
    "",
  ];
  for (const [source, label] of groups) {
    const group = unique
      .filter((command) => command.source === source)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!group.length) continue;
    if (lines.length > 3) lines.push("");
    lines.push(`--- ${label} ---`);
    lines.push(
      ...group.map((command) => {
        const invocation = `/${command.name}${
          command.argumentHint ? ` ${command.argumentHint}` : ""
        }`;
        return command.description
          ? `${invocation} - ${command.description}`
          : invocation;
      }),
    );
  }
  return lines.join("\n");
}
