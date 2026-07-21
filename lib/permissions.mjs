/**
 * Permission levels (Grok Build / Claude Code style).
 * Shift+Tab cycles these. Sandbox is separate (/sandbox).
 */

/** @typedef {'ask-all'|'ask-some'|'ask-dangerous'|'ask-none'|'sandbox'} PermissionId */

/**
 * @type {Array<{
 *   id: PermissionId,
 *   label: string,
 *   short: string,
 *   description: string,
 *   cycle: boolean,
 * }>}
 */
export const PERMISSION_LEVELS = [
  {
    id: "ask-all",
    label: "Ask me for everything",
    short: "ask:all",
    description: "Approve every write, edit, bash, and mutating MCP tool call.",
    cycle: true,
  },
  {
    id: "ask-some",
    label: "Ask me for some things",
    short: "ask:some",
    description:
      "Approve file edits and shell commands. Inspection-only bash (ls, git status, …) is free.",
    cycle: true,
  },
  {
    id: "ask-dangerous",
    label: "Ask me for dangerous things",
    short: "ask:danger",
    description:
      "Default. Only high-risk bash needs approval (rm -rf, sudo, force-push, …).",
    cycle: true,
  },
  {
    id: "ask-none",
    label: "Don't ask me for anything",
    short: "ask:none",
    description: "Full autonomy in the project. No approval prompts.",
    cycle: true,
  },
  {
    id: "sandbox",
    label: "Sandbox (Docker)",
    short: "sandbox",
    description:
      "Bash runs in Docker (node:22-bookworm, network none). Not in Shift+Tab cycle — use /sandbox.",
    cycle: false,
  },
];

const CYCLE = PERMISSION_LEVELS.filter((l) => l.cycle);

/** Legacy / alias → canonical id */
const ALIASES = {
  // New short names
  all: "ask-all",
  everything: "ask-all",
  "ask-everything": "ask-all",
  "ask-me-for-everything": "ask-all",
  some: "ask-some",
  "ask-edits": "ask-some",
  "ask-me-for-some-things": "ask-some",
  "ask-me-for-some": "ask-some",
  dangerous: "ask-dangerous",
  danger: "ask-dangerous",
  "ask-me-for-dangerous-things": "ask-dangerous",
  "ask-me-for-dangerous": "ask-dangerous",
  safe: "ask-dangerous", // old Alloy name
  none: "ask-none",
  "dont-ask": "ask-none",
  "don't-ask": "ask-none",
  "dont-ask-me-for-anything": "ask-none",
  "don't-ask-me-for-anything": "ask-none",
  "do-not-ask": "ask-none",
  full: "ask-none",
  workspace: "ask-none", // old Alloy name
  bypass: "ask-none",
  // exact ids
  "ask-all": "ask-all",
  "ask-some": "ask-some",
  "ask-dangerous": "ask-dangerous",
  "ask-none": "ask-none",
  sandbox: "sandbox",
  // old readonly → ask-all for approvals (plan mode still hard-blocks)
  readonly: "ask-all",
};

export function normalizePermissionId(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase().replace(/\s+/g, "-");
  return ALIASES[key] || null;
}

export function getPermissionLevel(id) {
  const canon = normalizePermissionId(id) || id;
  return PERMISSION_LEVELS.find((l) => l.id === canon) || null;
}

export function listCycleLevels() {
  return [...CYCLE];
}

/**
 * @param {string} currentId
 * @returns {{ id: string, label: string, short: string, description: string }}
 */
export function nextPermissionLevel(currentId) {
  const canon = normalizePermissionId(currentId) || "ask-dangerous";
  let idx = CYCLE.findIndex((l) => l.id === canon);
  if (idx < 0) idx = CYCLE.findIndex((l) => l.id === "ask-dangerous");
  if (idx < 0) idx = 0;
  return CYCLE[(idx + 1) % CYCLE.length];
}

export function permissionStatusText(id) {
  const level = getPermissionLevel(id);
  return level ? level.short : String(id || "ask:danger");
}

export function formatPermissionMenu(currentId) {
  const cur = normalizePermissionId(currentId) || currentId;
  const lines = ["Permission levels (Shift+Tab to cycle):", ""];
  for (const l of CYCLE) {
    const mark = l.id === cur ? "→" : " ";
    lines.push(`${mark} ${l.short.padEnd(12)} ${l.label}`);
    lines.push(`    ${l.description}`);
  }
  lines.push("");
  lines.push("Sandbox (Docker) is separate: /sandbox or /permissions sandbox");
  return lines.join("\n");
}

/** Bash that is allowed without prompt in ask-some */
export function isInspectionBash(command) {
  const c = String(command || "").trim();
  return /^(ls|pwd|cat|head|tail|rg|grep|find|git\s+(status|diff|log|show|branch|rev-parse)|sed\s+-n|wc|file|which|node\s+-e|node\s+--version|node\s+-v|npm\s+(test|run|ls|view|outdated)|python\s+--version|echo|true|false|date|whoami|uname)\b/i.test(
    c,
  );
}

export const DANGEROUS_BASH = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r| --recursive| --force)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(chmod|chown)\b.*\s777\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
];

export function isDangerousBash(command) {
  return DANGEROUS_BASH.some((re) => re.test(String(command || "")));
}
