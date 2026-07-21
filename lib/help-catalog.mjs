/**
 * Alloy help catalog — topics, commands, and search.
 */

/** @typedef {{ id: string, title: string, tags: string[], body: string }} HelpTopic */

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
- /fusion multi-model merge
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
  /doctor                Full diagnostics (never prints secrets)

API keys still work as fallback:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY

Switch models anytime: /model`,
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
    body: `Pi has no built-in MCP. Alloy bridges stdio servers.

Config: ~/.pi/alloy/mcp.json  (or project .pi/alloy-mcp.json)

  /mcp list|status
  /mcp connect               Start enabled servers, register tools
  /mcp disconnect
  /mcp path

Tools appear as mcp_<server>_<tool> and respect Alloy policy.
Optional: "mcp.connectOnStart": true in config.`,
  },
  {
    id: "modes",
    title: "Modes",
    tags: ["mode", "plan", "build", "review", "chat"],
    body: `  /mode chat|plan|build|review
  /plan  /build  /review     Shortcuts

plan / review → read-only tool gating (no write/edit; limited bash).
build / chat  → use active permission profile.`,
  },
  {
    id: "permissions",
    title: "Permission levels (Shift+Tab)",
    tags: [
      "permissions",
      "shift+tab",
      "ask",
      "ask-all",
      "ask-some",
      "ask-dangerous",
      "ask-none",
      "sandbox",
      "security",
    ],
    body: `Shift+Tab cycles permission levels (Claude Code / Grok Build style):

  ask-all        Ask me for everything
  ask-some       Ask me for some things (edits + shell)
  ask-dangerous  Ask me for dangerous things (default)
  ask-none       Don't ask me for anything

  /permissions              Show menu
  /permissions ask-some     Set directly
  /permissions cycle

Sandbox is separate (not in Shift+Tab):
  /permissions sandbox
  /sandbox status|start|stop

Thinking/effort is /effort — not Shift+Tab.`,
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

Shift+Tab = permissions, not effort.`,
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
    title: "Fusion (multi-model)",
    tags: ["fusion", "multi-model", "merge", "workers"],
    body: `  /fusion [plan|build] <request>

plan  — parallel read-only workers + merger
build — each worker gets its own worktree; merger attributes, does not auto-merge code

Configure ~/.pi/alloy/config.json:
  "fusion": {
    "models": ["anthropic/…", "openai-codex/…", "xai/…"],
    "mergerModel": "anthropic/…"
  }

Merger sections: Consensus · Unique · Conflicts · Discarded · Final decision`,
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
    id: "commands",
    title: "Command cheatsheet",
    tags: ["commands", "slash", "cheatsheet", "reference"],
    body: `Auth       /login /logout /providers /doctor
Modes      /mode /plan /build /review
Memory     /remember /memory
Skills     /skill-capture /skill-promote /skill-drafts
MCP        /mcp
Git        /checkpoint /checkpoints /undo /worktree
Diag       /diagnose
Auto       /auto /fusion /runs /panel
Safety     /permissions /sandbox
Help       /help /help <query>
Meta       /alloy

Pi native  /model /settings /resume /new /tree /fork /compact /export /reload /quit`,
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
