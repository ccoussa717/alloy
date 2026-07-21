/**
 * Minimal fail-closed policy for MVP.
 * Profiles: readonly | safe (default) | workspace
 * Blocks obvious destructive bash in safe mode without approval.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadConfig } = require(join(root, "lib", "config.mjs"));

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

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

export function registerPolicy(pi: ExtensionAPI) {
  let profile = "safe";
  try {
    profile = loadConfig().permissionProfile || "safe";
  } catch {
    profile = "safe";
  }

  pi.registerCommand("permissions", {
    description: "Show or set permission profile: /permissions [readonly|safe|workspace]",
    handler: async (args, ctx) => {
      const next = (args || "").trim().toLowerCase();
      if (!next) {
        ctx.ui.notify(`Permission profile: ${profile}`, "info");
        return;
      }
      if (!["readonly", "safe", "workspace"].includes(next)) {
        ctx.ui.notify("Use: readonly | safe | workspace", "warning");
        return;
      }
      profile = next;
      ctx.ui.setStatus("alloy-policy", `perm:${profile}`);
      ctx.ui.notify(`Permission profile → ${profile}`, "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (profile === "workspace") return undefined;

    if (profile === "readonly") {
      if (WRITE_TOOLS.has(event.toolName)) {
        // Allow bash only if it looks like a pure inspection command (heuristic)
        if (event.toolName === "bash") {
          const command = String((event.input as { command?: string }).command || "");
          const inspection =
            /^(ls|pwd|cat|head|tail|rg|grep|find|git\s+(status|diff|log|show|branch)|sed\s+-n|wc|file|which|node\s+-v|npm\s+(test|run|ls)|python\s+--version)\b/i.test(
              command.trim(),
            );
          if (inspection) return undefined;
        }
        return {
          block: true,
          reason: "Alloy readonly profile blocks mutating tools",
        };
      }
      return undefined;
    }

    // safe profile
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command || "");
      const dangerous = DANGEROUS.some((re) => re.test(command));
      if (!dangerous) return undefined;

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: "Dangerous command blocked (no UI for approval; headless fail-closed)",
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
    ctx.ui.setStatus("alloy-policy", `perm:${profile}`);
  });
}
