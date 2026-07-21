/**
 * Fail-closed policy for MVP.
 * Profiles: readonly | safe (default) | workspace
 * Modes plan/review also block mutations (including MCP tools).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadConfig } = require(join(root, "lib", "config.mjs"));
const {
  getState,
  setPermissionProfile,
  isReadOnlyMode,
} = require(join(root, "lib", "state.mjs"));
const { isMcpToolName } = require(join(root, "lib", "mcp-client.mjs"));

const DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r| --recursive| --force)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(chmod|chown)\b.*\s777\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bwget\b.*\|\s*(ba)?sh\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
];

const MUTATING_NATIVE = new Set(["write", "edit", "bash"]);

/** MCP tools that look read-only by name (heuristic). */
function mcpLooksReadOnly(toolName: string): boolean {
  return /_(get|list|read|search|find|query|fetch|describe|show|status)/i.test(
    toolName,
  );
}

export function registerPolicy(pi: ExtensionAPI) {
  try {
    const profile = loadConfig().permissionProfile || "safe";
    setPermissionProfile(profile);
  } catch {
    setPermissionProfile("safe");
  }

  pi.registerCommand("permissions", {
    description: "Show or set permission profile: /permissions [readonly|safe|workspace]",
    handler: async (args, ctx) => {
      const next = (args || "").trim().toLowerCase();
      const cur = getState().permissionProfile;
      if (!next) {
        ctx.ui.notify(
          `Permission profile: ${cur}\nMode: ${getState().mode}\nRead-only effective: ${isReadOnlyMode()}`,
          "info",
        );
        return;
      }
      try {
        setPermissionProfile(next);
        ctx.ui.setStatus("alloy-policy", `perm:${next}`);
        ctx.ui.notify(`Permission profile → ${next}`, "info");
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const { permissionProfile: profile, mode } = getState();
    const name = event.toolName;

    // --- Read-only effective (plan / review / readonly profile) ---
    if (isReadOnlyMode()) {
      if (MUTATING_NATIVE.has(name)) {
        if (name === "bash") {
          const command = String(
            (event.input as { command?: string }).command || "",
          );
          const inspection =
            /^(ls|pwd|cat|head|tail|rg|grep|find|git\s+(status|diff|log|show|branch|rev-parse)|sed\s+-n|wc|file|which|node\s+-e|node\s+--version|node\s+-v|npm\s+(test|run|ls|view)|python\s+--version|echo)\b/i.test(
              command.trim(),
            );
          if (inspection) return undefined;
        }
        return {
          block: true,
          reason: `Alloy ${mode}/${profile}: mutating tool "${name}" blocked`,
        };
      }
      if (isMcpToolName(name) && !mcpLooksReadOnly(name)) {
        return {
          block: true,
          reason: `Alloy ${mode}: MCP tool "${name}" blocked (read-only mode). Switch /mode build to allow.`,
        };
      }
      return undefined;
    }

    if (profile === "workspace") return undefined;

    // --- safe profile ---
    if (name === "bash") {
      const command = String(
        (event.input as { command?: string }).command || "",
      );
      const dangerous = DANGEROUS.some((re) => re.test(command));
      if (!dangerous) return undefined;

      if (!ctx.hasUI) {
        return {
          block: true,
          reason:
            "Dangerous command blocked (no UI for approval; headless fail-closed)",
        };
      }

      const choice = await ctx.ui.select(
        `Alloy safe mode — approve command?\n\n  ${command}`,
        ["Allow once", "Deny"],
      );
      if (choice !== "Allow once") {
        return { block: true, reason: "Blocked by Alloy policy" };
      }
    }

    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    const { permissionProfile } = getState();
    ctx.ui.setStatus("alloy-policy", `perm:${permissionProfile}`);
  });
}
