/**
 * Central capability policy.
 *
 * Every tool has an explicit capability set. One gate decides
 * allow / deny / need-approval for plan|review modes and permission profiles.
 *
 * MCP tools are NOT classified by name heuristics — default is external_side_effect.
 */

/** @typedef {'read'|'workspace_write'|'process'|'network'|'persistent_state'|'child_agent'|'git_destructive'|'external_side_effect'} Capability */

/** @type {Record<string, Capability[]>} */
export const NATIVE_TOOL_CAPS = {
  read: ["read"],
  grep: ["read"],
  find: ["read"],
  ls: ["read"],
  write: ["workspace_write"],
  edit: ["workspace_write"],
  bash: ["process"],
};

/** @type {Record<string, Capability[]>} */
export const ALLOY_TOOL_CAPS = {
  alloy_help: ["read"],
  alloy_memory_search: ["read"],
  alloy_mcp_list: ["read"],
  alloy_remember: ["persistent_state"],
  alloy_diagnostics: ["process", "read", "external_side_effect"], // runs repository-defined host commands
  alloy_worktree: ["workspace_write", "git_destructive", "child_agent"],
  alloy_auto: ["child_agent", "workspace_write", "process", "git_destructive"],
  alloy_fusion: ["child_agent", "workspace_write", "process"],
  alloy_task: ["child_agent", "workspace_write", "process"],
};

/** Caps allowed in plan/review (strict read-only). */
export const READ_ONLY_CAPS = new Set(["read"]);

/**
 * Resolve capabilities for a tool name.
 * Unknown tools → external_side_effect (deny-by-default in constrained modes).
 * @param {string} toolName
 * @returns {Capability[]}
 */
export function capabilitiesForTool(toolName) {
  const name = String(toolName || "");
  if (NATIVE_TOOL_CAPS[name]) return [...NATIVE_TOOL_CAPS[name]];
  if (ALLOY_TOOL_CAPS[name]) return [...ALLOY_TOOL_CAPS[name]];
  if (name.startsWith("mcp_")) {
    // No name-based inference — MCP is an external side effect unless later allowlisted
    return ["external_side_effect"];
  }
  // Unknown alloy_* or third-party
  if (name.startsWith("alloy_")) return ["external_side_effect"];
  return ["external_side_effect"];
}

/**
 * True if every cap is allowed in the given set.
 * @param {Capability[]} caps
 * @param {Set<string>} allowed
 */
export function capsSubsetOf(caps, allowed) {
  return caps.every((c) => allowed.has(c));
}

/**
 * True if any cap is in the set.
 * @param {Capability[]} caps
 * @param {Iterable<string>} set
 */
export function capsIntersect(caps, set) {
  const s = set instanceof Set ? set : new Set(set);
  return caps.some((c) => s.has(c));
}

/**
 * Dangerous bash patterns (host process risk).
 * Used only for ask-dangerous approval prompts — not for plan/review (bash denied entirely).
 */
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
  /\bgit\s+clean\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
];

export function isDangerousBash(command) {
  return DANGEROUS_BASH.some((re) => re.test(String(command || "")));
}

/**
 * Evaluate a tool call against mode + permission profile.
 *
 * @param {{
 *   toolName: string,
 *   input?: any,
 *   mode?: string,
 *   readOnlyMode?: boolean,
 *   permissionProfile?: string,
 * }} opts
 * @returns {{
 *   decision: 'allow'|'deny'|'approve',
 *   reason?: string,
 *   caps: Capability[],
 * }}
 */
export function evaluateToolPolicy(opts) {
  const toolName = String(opts.toolName || "");
  const caps = capabilitiesForTool(toolName);
  const readOnly = Boolean(
    opts.readOnlyMode ||
      opts.mode === "plan" ||
      opts.mode === "review",
  );
  const profile = opts.permissionProfile || "ask-dangerous";
  const input = opts.input || {};

  // --- Plan / review: strict read-only, no bash, no MCP by default ---
  if (readOnly) {
    if (toolName === "bash") {
      return {
        decision: "deny",
        reason: `Alloy ${opts.mode || "plan/review"} mode denies bash entirely (shell is not read-only). /mode build to run commands.`,
        caps,
      };
    }
    if (!capsSubsetOf(caps, READ_ONLY_CAPS)) {
      return {
        decision: "deny",
        reason: `Alloy ${opts.mode || "plan/review"} mode is read-only. Blocked ${toolName} [${caps.join(", ")}]. /mode build to mutate.`,
        caps,
      };
    }
    return { decision: "allow", caps };
  }

  // --- Legacy profile id "sandbox": isolation is orthogonal. Approval defaults
  // to ask-dangerous (NOT allow-all). Parent ask-all/ask-some must be passed as
  // those ids with sandbox handled by the docker bash path / child enforcer.
  if (profile === "sandbox") {
    // Fall through as ask-dangerous for approval decisions.
    return evaluateToolPolicy({
      ...opts,
      permissionProfile: "ask-dangerous",
    });
  }

  // --- ask-none: no prompts ---
  if (profile === "ask-none") {
    return { decision: "allow", caps };
  }

  // Pure read tools never need approval
  if (capsSubsetOf(caps, READ_ONLY_CAPS) && caps.length > 0) {
    return { decision: "allow", caps };
  }

  // --- ask-all: approve anything with non-read caps ---
  if (profile === "ask-all") {
    if (!capsSubsetOf(caps, READ_ONLY_CAPS)) {
      return {
        decision: "approve",
        reason: `ask-all: approve ${toolName} [${caps.join(", ")}]`,
        caps,
      };
    }
    return { decision: "allow", caps };
  }

  // --- ask-some: approve writes, process, child agents, memory writes, MCP ---
  if (profile === "ask-some") {
    const needs = [
      "workspace_write",
      "process",
      "child_agent",
      "persistent_state",
      "external_side_effect",
      "git_destructive",
      "network",
    ];
    if (capsIntersect(caps, needs)) {
      return {
        decision: "approve",
        reason: `ask-some: approve ${toolName} [${caps.join(", ")}]`,
        caps,
      };
    }
    return { decision: "allow", caps };
  }

  // --- ask-dangerous (default): approve dangerous bash + destructive/external actions ---
  if (profile === "ask-dangerous") {
    if (toolName === "bash") {
      const command = String(input.command || "");
      if (isDangerousBash(command)) {
        return {
          decision: "approve",
          reason: `ask-dangerous: dangerous bash`,
          caps,
        };
      }
      return { decision: "allow", caps };
    }
    if (capsIntersect(caps, ["git_destructive"])) {
      return {
        decision: "approve",
        reason: `ask-dangerous: git_destructive ${toolName}`,
        caps,
      };
    }
    if (capsIntersect(caps, ["network", "external_side_effect"])) {
      return {
        decision: "approve",
        reason: `ask-dangerous: approve external action ${toolName}`,
        caps,
      };
    }
    return { decision: "allow", caps };
  }

  // Unknown profile → fail closed for non-read
  if (!capsSubsetOf(caps, READ_ONLY_CAPS)) {
    return {
      decision: "deny",
      reason: `Unknown permission profile ${profile}; denying ${toolName}`,
      caps,
    };
  }
  return { decision: "allow", caps };
}

/**
 * Format a short approval prompt body.
 */
export function formatApprovalDetail(toolName, input) {
  if (toolName === "bash") {
    return String(input?.command || "").slice(0, 300);
  }
  if (toolName === "write" || toolName === "edit") {
    return String(input?.path || input?.file_path || "").slice(0, 200);
  }
  try {
    return JSON.stringify(input ?? {}).slice(0, 200);
  } catch {
    return "";
  }
}
