/**
 * Alloy help catalog — topics, commands, and search.
 */

/** @typedef {{ id: string, title: string, tags: string[], body: string }} HelpTopic */

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
- /auto multi-agent pipeline with fix loops
- /fusion read-only Architect-Builder synthesis
- Live agent panel during auto/fusion
- Docker sandbox permission profile

Launch: alloy
Core Pi features (sessions, /model, /tree, /compact) still work.`,
  },
  {
    id: "auth",
    title: "Authentication (Claude · Codex · Grok)",
    tags: ["login", "auth", "subscription", "claude", "codex", "grok", "provider"],
    body: `Preferred: subscriptions via Pi /login

  /login                 Claude Pro/Max and ChatGPT/Codex
  /login xai             Grok subscription
  /providers             Quick status
  /doctor                Versions, providers, catalog, economics (never secrets)
  alloy --version        Alloy + Pi + Node versions (CLI)

API keys work for their API provider routes:
  ANTHROPIC_API_KEY, OPENAI_API_KEY (openai/...), XAI_API_KEY
  openai-codex/... uses ChatGPT subscription auth from /login.

Switch models anytime: /model`,
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
  - alloy_auto, alloy_worktree, alloy_remember, alloy_diagnostics, alloy_fusion, alloy_task denied
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
and respect Alloy policy. Optional: "mcp.connectOnStart": true (global only).`,
  },
  {
    id: "modes",
    title: "Modes (Shift+Tab)",
    tags: ["mode", "plan", "build", "review", "chat", "shift+tab"],
    body: `Shift+Tab cycles Build → Plan → Build.

  /mode chat|plan|build|review
  /plan  /build  /review     Shortcuts

plan / review → hard read-only tool gating (no write/edit/bash).
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
Used automatically at the end of /auto rounds.`,
  },
  {
    id: "auto",
    title: "Auto pipeline & fix loops",
    tags: ["auto", "pipeline", "fix", "agents", "multi-agent"],
    body: `  /auto <request>

Flow:
  scout → plan → checkpoint → build (worktree)
       → diagnostics → review
       ↺ fixer (if VERDICT: FAIL or diag fail), up to maxFixRounds

  /runs                      Artifact root
  Live agent panel below the editor during the run
  /panel                     Clear panel

Artifacts: ~/.pi/alloy/runs/<project>/<runId>/
Config: budgets.maxFixRounds (default 2), roles.*.model`,
  },
  {
    id: "fusion",
    title: "Fusion (Architect + Builder)",
    tags: ["fusion", "multi-model", "architect", "builder", "synthesizer"],
    body: `  /fusion <objective>
  /fusion setup
  /fusion status
  /fusion help

The Architect and Builder inspect the repository independently with read-only
tools and distinct model routes. A fresh Synthesizer combines both proposals,
preserves attribution and disagreement, and returns one recommendation.

Configure ~/.pi/alloy/config.json:
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
Artifacts include role proposals, synthesis, usage, and status.`,
  },
  {
    id: "panel",
    title: "Agent panel",
    tags: ["panel", "tui", "widget", "status"],
    body: `During /auto and /fusion, Alloy paints a status widget below the editor:

  ✓ scout    model   8.2s
  ◐ builder  model   edit
  · reviewer         queued

  /panel                 Clear the widget
Footer also shows auto:PHASE fixN/M`,
  },
  {
    id: "config",
    title: "Configuration paths",
    tags: ["config", "paths", "files", "settings"],
    body: `Alloy home:  ~/.pi/alloy/
  config.json
  mcp.json
  memory/
  skills-drafts/
  runs/
  checkpoints/
  worktrees/

Pi home:     ~/.pi/agent/   (auth.json, sessions, skills)
Project:     .pi/alloy.json , .pi/alloy-mcp.json (trusted projects)

Env:
  ALLOY_HOME, ALLOY_PI_BIN, ALLOY_ROOT, PI_CODING_AGENT_DIR`,
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

Also: /auto pipeline, /fusion Architect-Builder synthesis.
Panel below editor shows live agent status.`,
  },
  {
    id: "commands",
    title: "All slash commands",
    tags: ["commands", "slash", "cheatsheet", "reference"],
    body: `Use /help commands to render the complete live command registry.

The list includes Pi-native commands plus every active extension, prompt, and
skill command in the current session. Descriptions are shown beside each name.`,
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

export function formatCommandCatalog(liveCommands = []) {
  const commands = [
    ...PI_NATIVE_COMMANDS.map((command) => ({ ...command, source: "builtin" })),
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
    ["builtin", "Pi native"],
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
