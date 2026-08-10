/**
 * Alloy help catalog — topics, commands, and search.
 */

/** @typedef {{ id: string, title: string, tags: string[], body: string }} HelpTopic */

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

/** @type {HelpTopic[]} */
export const HELP_TOPICS = [
  {
    id: "overview",
    title: "What is Alloy?",
    tags: ["intro", "overview", "start", "about"],
    body: `Alloy is a coding harness on top of Pi (pi.dev).

It adds:
- Subscriptions for Claude, Codex/ChatGPT, and Grok
- Durable memory across sessions
- Skills (create, compose, self-improve with approval)
- Live MCP tool bridge
- Modes (chat/plan/build/review)
- Git checkpoints & worktrees
- Diagnostics
- Multi-model workflows (see /help workflows):
    /fusion  plan debate → one synthesis
    /fission multi-role adversarial review + judge
    /auto    implement with scout/plan/build/review/fix
    /forge   full spine: fusion → fission → auto → fission
- Live agent panel during multi-agent runs
- Docker sandbox permission profile

Launch: alloy
First-time multi-model setup: /help workflows
Core Pi features (sessions, /model, /tree, /compact) still work.`,
  },
  {
    id: "workflows",
    title: "Workflows: fusion · fission · auto · forge",
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
    ],
    body: `Choose the right multi-model path. Details: /help fusion | fission | auto | forge

## Comparison

| Command | Purpose | Writes code? | Model setup |
|---------|---------|--------------|-------------|
| /fusion | Two plans + synthesizer → one plan | No | /fusion setup |
| /fission | N role reviewers + judge on evidence | No | /fission setup |
| /auto | Scout→plan→build→check→review↺fix | Yes (worktree) | /auto setup or roles.*.model |
| /forge | fusion → fission → auto → fission | Yes | fusion + fission + auto setups |

Main chat /model is ONLY the interactive session. Child workflows use their own routes.

## Setup checklist (recommended before /forge)

1. /login  (and /login xai, etc.) for every provider you will use
2. /fusion setup   — architect, builder, synthesizer (+ effort)
3. /fission setup  — default/max reviewers, role catalog, models, judge, severity
4. /auto setup     — scout/planner/builder/fixer/reviewer models + implement profile
   (default implement profile: sandbox — needs Docker; override with ask-dangerous)
5. Optional: /pack apply ship|incident|economy  (local presets; does not wipe fission models)
6. /fusion status · /fission status · /auto status  to verify
7. Trust the project if you will run fission (/trust)

If roles.*.model is null, auto routes via profiles / orchestration.roles
(research → plan → code → review). See /help agents and /profiles.

## Combinations (what to type)

| Goal | Command |
|------|---------|
| Fast single-model work | just chat (after /model) |
| Multi-model plan only | /fusion <objective> |
| Review current dirty tree | /fission <contract>  or  /fission 5 <contract> |
| Implement with fix loops | /auto <request> |
| Full quality path | /forge <request> |
| Plan then implement yourself | /fusion … then /auto … |
| Plan then adversarial review only | /fusion … then /fission … (needs a diff or use forge) |
| Review after you edited | /fission … |
| Apply a local preset pack | /pack apply ship\|incident\|economy |
| List recent multi-agent runs | /runs  or  alloy runs |
| Free-form extra agent | /agent name model=… <task> |
| CI fission (non-interactive) | alloy fission --json "…" |

## Forge spine (shared artifacts)

  fusion/
    → fission-plan/   (NO_CHANGES OK if no code yet; FAIL blocks implement)
    → auto/           (seeded with fusion synthesis + fission findings)
    → fission-diff/   (reviews worktree if present)

Run root: ~/.pi/alloy/runs/<project>/<runId>/
  forge.json · summary.json · events.jsonl · phases/

## Rules of thumb

- Fusion = productive disagreement → one plan
- Fission = many hostile reviews → adjudicated findings (not one blended essay)
- Auto = execution engine under policy
- Forge = all of the above, one run id

More detail: /help fusion · /help fission · /help auto · /help forge · /help config`,
  },
  {
    id: "auth",
    title: "Authentication (Claude · Codex · Grok)",
    tags: ["login", "auth", "subscription", "claude", "codex", "grok", "provider"],
    body: `Preferred: subscriptions via Pi /login. Run it once per provider.

  /login                 Choose one available OAuth provider
  /login xai             Grok subscription
  /providers             Quick status
  /doctor                Versions, providers, catalog, economics (never secrets)
  alloy --version        Alloy + Pi + Node versions (CLI)

API keys work for their API provider routes:
  ANTHROPIC_API_KEY, OPENAI_API_KEY (openai/...), XAI_API_KEY
  openai-codex/... uses ChatGPT subscription auth from /login.

The provider picker labels locally configured routes. Send a prompt to verify
end-to-end authentication. Switch models anytime: /model`,
  },
  {
    id: "permissions-policy",
    title: "Permissions & capability policy",
    tags: ["permissions", "policy", "plan", "review", "ask", "sandbox", "readonly"],
    body: `Approval profiles (set directly or use /permissions cycle):
  ask-all | ask-some | ask-dangerous | ask-none | sandbox

Plan/review modes are hard read-only:
  - bash is always denied (no prefix allowlist)
  - write/edit denied
  - alloy_auto, alloy_worktree, alloy_remember, alloy_diagnostics, alloy_fusion, alloy_fission, alloy_forge, alloy_task denied
  - MCP tools denied by default (no name heuristics)

Every tool has explicit capabilities. Unknown tools = external_side_effect.
Trust this gate over model claims about what it can do.`,
  },
  {
    id: "honesty",
    title: "Honesty / no hallucinations",
    tags: ["honesty", "hallucination", "facts", "whoami", "truth"],
    body: `Alloy honesty policy (always on by default)

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
  {
    id: "memory",
    title: "Durable memory",
    tags: ["memory", "remember", "persist", "facts"],
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
    title: "Skills & self-improve",
    tags: ["skills", "skill-capture", "promote", "self-improve"],
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
    tags: ["mcp", "tools", "servers", "connect"],
    body: `Pi has no built-in MCP. Alloy bridges:

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
    id: "modes",
    title: "Modes (Shift+Tab)",
    tags: ["mode", "plan", "build", "review", "chat", "shift+tab"],
    body: `Shift+Tab cycles Build → Plan → Build.

  /mode chat|plan|build|review
  /plan  /build  /review     Shortcuts

plan / review → hard read-only tool gating (no write/edit/bash/MCP).
build / chat  → use active permission profile.`,
  },
  {
    id: "permissions",
    title: "Approval profiles",
    tags: [
      "permissions",
      "ask",
      "ask-all",
      "ask-some",
      "ask-dangerous",
      "ask-none",
      "sandbox",
      "security",
    ],
    body: `Approval profiles are separate from Build/Plan mode:

  ask-all        Ask me for everything
  ask-some       Ask me for some things (edits + shell)
  ask-dangerous  Ask me for dangerous things (default)
  ask-none       Don't ask me for anything

  /permissions              Show menu
  /permissions ask-some     Set directly
  /permissions cycle

Sandbox is separate:
  /permissions sandbox
  /sandbox status|start|stop

Shift+Tab cycles Build and Plan. Thinking/effort uses /effort.`,
  },
  {
    id: "effort",
    title: "Effort / thinking levels",
    tags: ["effort", "thinking", "reasoning"],
    body: `Thinking level (reasoning effort):

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
  {
    id: "sandbox",
    title: "Docker sandbox profile",
    tags: ["sandbox", "docker", "container", "isolation", "network"],
    body: `When /permissions sandbox is active, bash (and !shell via user_bash)
runs inside a session Docker container.

Defaults:
  image:   node:22-bookworm
  network: none
  mount:   project dir → /workspace
  limits:  2g RAM, 2 CPUs
  flags:   --cap-drop ALL, no-new-privileges

  /sandbox                   Status
  /sandbox start|stop        Manual lifecycle
  /permissions sandbox       Enable

Config (~/.pi/alloy/config.json):
  "sandbox": {
    "image": "node:22-bookworm",
    "network": "none",
    "memory": "2g",
    "cpus": "2",
    "autoPull": true
  }

Requires Docker CLI + running daemon.
Fail-closed if Docker is missing.
/auto does not force sandbox; set the profile first (safest).`,
  },
  {
    id: "git",
    title: "Checkpoints & worktrees",
    tags: ["git", "checkpoint", "undo", "worktree", "branch"],
    body: `Checkpoints (recoverable snapshots):
  /checkpoint [label]
  /checkpoints
  /undo [id]                 Confirms; headless denied

Worktrees (isolated builders):
  /worktree create [role] [taskId]
  /worktree list|remove|diff

Stored under ~/.pi/alloy/checkpoints and ~/.pi/alloy/worktrees/`,
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    tags: ["diagnose", "test", "lint", "typecheck"],
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
    id: "auto",
    title: "Auto pipeline & fix loops",
    tags: ["auto", "pipeline", "fix", "agents", "multi-agent", "setup", "implement"],
    body: `  /auto <request>
  /auto setup
  /auto status
  /auto help
  Tool: alloy_auto

Implement-only multi-agent pipeline (writes code; prefers a Git worktree):

  scout → plan → checkpoint → build (worktree)
       → diagnostics → review
       ↺ fixer (if VERDICT: FAIL or diag fail), up to maxFixRounds

Run /auto setup (TUI) for role models and implement permission profile.
Models are NOT the main chat /model.

Default implement profile: sandbox (Docker required; no silent downgrade).
Override: /auto setup, auto.implementPermissionProfile, or ALLOY_IMPLEMENT_PROFILE
(ask-all | ask-some | ask-dangerous | ask-none | sandbox).

Config (~/.pi/alloy/config.json):
  "roles": {
    "scout":    { "model": "provider/model" },
    "planner":  { "model": "provider/model" },
    "builder":  { "model": "provider/model" },
    "fixer":    { "model": "provider/model" },
    "reviewer": { "model": "provider/model" }
  }
  "budgets": { "maxFixRounds": 2 }
  "auto": {
    "useWorktree": true,
    "implementPermissionProfile": "sandbox"
  }

If roles.*.model is null, children route via profiles / orchestration.roles
(scout→research, planner→plan, builder/fixer→code, reviewer→review).
See /help agents and /profiles. Log in each provider with /login.

Local packs: /pack list · /pack apply ship|incident|economy
  /runs     Recent run index + artifacts under ~/.pi/alloy/runs/
  /panel    Clear live agent widget

Also the implement phase inside /forge (fusion + fission context injected).
Compare: /help workflows · /help forge · /help fusion · /help fission`,
  },
  {
    id: "fusion",
    title: "Fusion (Architect + Builder)",
    tags: ["fusion", "multi-model", "architect", "builder", "synthesizer", "setup", "plan"],
    body: `  /fusion <objective>
  /fusion setup
  /fusion status
  /fusion help
  Tool: alloy_fusion

Plan-only multi-model debate. Does not write project code.

  Architect  ─┐
  Builder    ─┴→ Synthesizer → one attributed recommendation

Run /fusion setup first (TUI): provider/model + effort per role.
Architect and Builder must be distinct models.

Configure ~/.pi/alloy/config.json (or use setup):
  "fusion": {
    "architectModel": "anthropic/...",
    "builderModel": "openai-codex/...",
    "synthesizerModel": "anthropic/...",
    "architectEffort": "high",
    "builderEffort": "medium",
    "synthesizerEffort": "low"
  }

Fusion is plan-only and makes at most three model calls. An eligible successful
run makes exactly three; auth, proposal, abort, or budget failures stop earlier.
Effort values are requested levels; Pi clamps unsupported values to the
selected model's capabilities.
Artifacts include role proposals, synthesis, usage, and status.

Also phase 1 of /forge. See /help workflows · /help forge.`,
  },
  {
    id: "panel",
    title: "Agent panel",
    tags: ["panel", "tui", "widget", "status"],
    body: `During /auto, /fusion, /fission, and /forge, Alloy paints a status widget below the editor:

  ✓ scout    model   8.2s
  ◐ builder  model   edit
  · reviewer         queued

  /panel                 Clear the widget
Footer also shows auto:PHASE fixN/M`,
  },
  {
    id: "forge",
    title: "Forge pipeline spine",
    tags: ["forge", "pipeline", "spine", "fusion", "fission", "auto", "multi-model", "setup"],
    body: `  /forge <request>
  Tool: alloy_forge

Full multi-model quality path with shared run artifacts:

  fusion (plan debate + synthesis)
    → fission (pre-build review; NO_CHANGES is OK if no diff yet)
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
  4. /auto setup     (implement roles + sandbox/ask profile)
  5. Optional: /pack apply ship|incident|economy
  6. /fusion status · /fission status · /auto status

See /help workflows for the full comparison table and combinations.

One run root: ~/.pi/alloy/runs/<project>/<runId>/
  forge.json · summary.json · events.jsonl
  fusion/ · fission-plan/ · auto/ · fission-diff/ · phases/

Pre-build fission FAIL (blocking findings) stops before auto.
Post-build fission FAIL fails the forge run even if auto passed.`,
  },
  {
    id: "fission",
    title: "Fission adversarial review",
    tags: ["fission", "review", "adversarial", "judge", "trusted", "setup"],
    body: `  /fission <request>              Run with the configured default reviewers
  /fission <reviewers> <request>  Override the reviewer count for one run (≤ max)
  /fission setup                  Roles, models, default/max N, effort, severity
  /fission status                 Routes, roles, effort, limits
  /fission help                   Show command help
  Tool: alloy_fission

Run /fission setup before the first review. Setup is interactive (TUI) and
saves global defaults atomically (also enables orchestration).

Workflow: N specialist reviewers in parallel → 1 independent judge.
Each reviewer slot picks a predefined role (not freeform prose), for example:
  Security & trust boundaries, Adversarial code review, Cynical customer,
  Correctness & regressions, Architecture, Tests, Performance, Privacy, Ops.
Default packs still exist when roles are unset; setup stores fission.roles[].

Configured default means reviewers + 1 judge (e.g. default 3 → 4 agents).
maxReviewers (default/cap 5) is the ceiling for /fission N <request>. You must
configure that many distinct reviewer model routes. Judge is separate.

Effort uses the same levels as /fusion (off…max or model default) via
thinkingLevel on each child. Requested levels are clamped by the model.

Fission supports trusted repositories only. Normal Git config and attributes
may execute helpers while repository evidence is captured; hostile repositories
are unsupported. Reviewers and the independent judge receive read-only tools.

Global config (~/.pi/alloy/config.json):
  fission.models, fission.roles, fission.judgeModel, fission.modelFamilies
  fission.defaultReviewers (default 3), fission.maxReviewers (default/cap 5)
  fission.blockingSeverity (default medium)
  fission.reviewerEfforts (parallel to models), fission.judgeEffort

Trusted project config may lower defaultReviewers and maxReviewers but never
raise global values. A max-only override also lowers the effective default when
needed. Project model routes, judge routes, and family labels are ignored.

Statuses: COMPLETE, INCOMPLETE, ABORTED, REFUSED, NO_CHANGES.
PASS means only that no submitted blocking finding validated. It is not a broad
quality guarantee. Exact configured routes are required. No fallback is
permitted for models or routing, and incomplete evidence fails closed.

Fission does not run tests, make fixes, merge, or deploy. It only captures evidence,
runs bounded reviews and adjudication, and writes review artifacts.

Also used twice inside /forge (plan + post-diff). See /help workflows · /help forge.`,
  },
  {
    id: "config",
    title: "Configuration paths",
    tags: ["config", "paths", "files", "settings"],
    body: `Alloy home:  ~/.pi/alloy/
  config.json          global operator config (fusion, fission, roles, budgets…)
  mcp.json
  memory/
  skills-drafts/
  runs/                /auto /fusion /fission /forge artifacts
  checkpoints/
  worktrees/

Pi home:     ~/.pi/agent/   (auth.json, sessions, skills)
Project:     .pi/alloy.json , .pi/alloy-mcp.json (trusted projects)

Key config blocks in config.json:
  fusion.*                         from /fusion setup
  fission.*                        from /fission setup
  roles.*.model                    from /auto setup (or edit)
  auto.useWorktree
  auto.implementPermissionProfile  default sandbox
  identity.id / displayName / org  ALLOY_AGENT_ID override
  profiles.*                       defaults for agent routing
  orchestration.*                  multi-agent routing policy
  budgets.*                        maxCostUsd, maxFixRounds

Run index: ~/.pi/alloy/runs/index.jsonl  (see /runs or alloy runs)

Env:
  ALLOY_HOME, ALLOY_PI_BIN, ALLOY_ROOT, PI_CODING_AGENT_DIR
  ALLOY_AGENT_ID               multi-agent run attribution
  ALLOY_IMPLEMENT_PROFILE      override implement sandbox/ask profile
  ALLOY_CHANNEL                installer: stable (default) or main

Non-interactive CLI:
  alloy fission [--json] [--reviewers N] <request>   exit 0/1/2
  alloy forge [--json] <request>
  alloy runs [--limit N]
  CI template: docs/ci/github-actions-fission.yml

Workflow map: /help workflows`,
  },
  {
    id: "agents",
    title: "Multi-model sub-agents",
    tags: ["agent", "agents", "subagent", "multi-model", "profiles", "task"],
    body: `Free-form sub-agents (separate Pi processes, optional model per agent):

  /agent <name> <task>
  /agent <name> profile=research <task>
  /agent <name> model=xai/grok-3 <task>
  /agent <name> use anthropic/claude-opus-4-6: Review this
  /agent bg <name> profile=code <task>

  /agents                 List agents (select to view)
  /agents view <id|name>  Full transcript
  /profiles               Model profile map

Tool (main agent can call): alloy_task

Profiles (edit ~/.pi/alloy/config.json):
  research → Grok
  code     → Codex / GPT
  review   → Claude Opus
  plan     → Claude Sonnet

Login each provider once: /login and /login xai
Then any agent can use any logged-in model.

Also: /auto, /fusion, /fission, /forge — see /help workflows.
Panel below editor shows live agent status.`,
  },
  {
    id: "commands",
    title: "All slash commands",
    tags: ["commands", "slash", "cheatsheet", "reference"],
    body: `Use /help commands to render the complete active command registry.

OpenTUI combines its shared local controls with every active extension, prompt,
and skill command in the current session. Descriptions are shown beside each
name. The legacy renderer shows its complete Pi-native command set instead.`,
  },
];

export function listTopics() {
  return HELP_TOPICS.map((t) => ({ id: t.id, title: t.title, tags: t.tags }));
}

export function getTopic(idOrTitle) {
  const q = String(idOrTitle || "").toLowerCase().trim();
  return (
    HELP_TOPICS.find((t) => t.id === q) ||
    HELP_TOPICS.find((t) => t.title.toLowerCase() === q) ||
    null
  );
}

/**
 * Ranked search across id, title, tags, body.
 * @returns {Array<HelpTopic & { score: number }>}
 */
export function searchHelp(query, { limit = 10 } = {}) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) {
    return HELP_TOPICS.slice(0, limit).map((t) => ({ ...t, score: 0 }));
  }
  const terms = raw.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const t of HELP_TOPICS) {
    const hay = `${t.id} ${t.title} ${t.tags.join(" ")} ${t.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (t.id === term) score += 50;
      if (t.title.toLowerCase().includes(term)) score += 20;
      if (t.tags.some((tag) => tag.includes(term))) score += 15;
      if (hay.includes(term)) score += 5;
      // startswith bonus on words
      if (t.tags.some((tag) => tag.startsWith(term))) score += 8;
    }
    if (score > 0) scored.push({ ...t, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

export function formatTopic(topic) {
  if (!topic) return "Topic not found. Try /help or /help search <query>";
  return [`# ${topic.title}`, `id: ${topic.id}`, `tags: ${topic.tags.join(", ")}`, "", topic.body].join(
    "\n",
  );
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
    ...listTopics().map((topic) => ({
      value: topic.id,
      label: topic.id,
      description: topic.title,
    })),
  ];
  const filtered = candidates.filter((item) => item.value.startsWith(raw));
  return filtered.length ? filtered : null;
}

export function formatCommandCatalog(liveCommands = [], options = {}) {
  const frontend = options.frontend ?? process.env.ALLOY_FRONTEND;
  const nativeCommands = frontend === "opentui" ? OPENTUI_COMMANDS : PI_NATIVE_COMMANDS;
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
  const lines = [];
  for (const [source, label] of groups) {
    const group = unique
      .filter((command) => command.source === source)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!group.length) continue;
    if (lines.length) lines.push("");
    lines.push(`--- ${label} ---`);
    lines.push(
      ...group.map((command) => {
        const invocation = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
        return command.description
          ? `${invocation} - ${command.description}`
          : invocation;
      }),
    );
  }
  return lines.join("\n");
}
