/**
 * Approval profiles. Operating-mode cycling lives in extensions/modes.ts.
 * All tool_call decisions go through lib/capabilities.mjs.
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
const { diagnoseDocker } = require(join(root, "lib", "docker-sandbox.mjs"));
const {
  normalizePermissionId,
  getPermissionLevel,
  nextPermissionLevel,
  permissionStatusText,
  formatPermissionMenu,
} = require(join(root, "lib", "permissions.mjs"));
const {
  evaluateToolPolicy,
  formatApprovalDetail,
  capabilitiesForTool,
} = require(join(root, "lib", "capabilities.mjs"));

function applyProfile(
  raw: string,
  ctx: {
    ui: {
      notify: (m: string, t?: string) => void;
      setStatus: (k: string, v: string | undefined) => void;
      theme?: { fg: (c: string, t: string) => string };
    };
  },
) {
  const id = normalizePermissionId(raw);
  if (!id) {
    throw new Error(
      `Unknown level: ${raw}\nUse: ask-all | ask-some | ask-dangerous | ask-none | sandbox\nUse /permissions cycle to cycle approval profiles.`,
    );
  }

  if (id === "sandbox") {
    const d = diagnoseDocker(process.cwd());
    if (!d.daemon) {
      throw new Error(
        `Cannot enable sandbox: ${d.detail}\nInstall/start Docker, or pick another level.`,
      );
    }
  }

  setPermissionProfile(id);
  const level = getPermissionLevel(id)!;
  const short = permissionStatusText(id);
  ctx.ui.setStatus(
    "alloy-policy",
    ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", short) : short,
  );

  if (id === "sandbox") {
    ctx.ui.setStatus(
      "alloy-sandbox",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "🔒 sandbox") : "🔒 sandbox",
    );
  } else {
    ctx.ui.setStatus("alloy-sandbox", undefined);
  }

  ctx.ui.notify(`${level.label}\n${level.description}`, "info");
  return level;
}

function updateStatus(ctx: {
  ui: {
    setStatus: (k: string, v: string | undefined) => void;
    theme?: { fg: (c: string, t: string) => string };
  };
}) {
  const id = getState().permissionProfile;
  const short = permissionStatusText(id);
  ctx.ui.setStatus(
    "alloy-policy",
    ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", short) : short,
  );
}

async function approve(
  ctx: {
    hasUI: boolean;
    ui: { select: (t: string, o: string[]) => Promise<string | undefined> };
  },
  title: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const choice = await ctx.ui.select(title, ["Allow once", "Deny"]);
  return choice === "Allow once";
}

export function registerPolicy(pi: ExtensionAPI) {
  try {
    const cfg = loadConfig();
    const raw = cfg.permissionProfile || "ask-dangerous";
    const id = normalizePermissionId(raw) || "ask-dangerous";
    setPermissionProfile(id);
  } catch {
    setPermissionProfile("ask-dangerous");
  }

  pi.registerCommand("permissions", {
    description:
      "Approval profile: /permissions [ask-all|ask-some|ask-dangerous|ask-none|sandbox|cycle]",
    handler: async (args, ctx) => {
      const next = (args || "").trim().toLowerCase();
      if (!next) {
        const cur = getState().permissionProfile;
        const level = getPermissionLevel(cur);
        const lines = [
          `Current: ${level?.label || cur} (${permissionStatusText(cur)})`,
          `Mode: ${getState().mode}`,
          `Read-only (plan/review): ${isReadOnlyMode()}`,
          "",
          formatPermissionMenu(cur),
          "",
          "Cycle approval profiles with /permissions cycle.",
          "Shift+Tab cycles Build and Plan modes.",
          "Thinking/effort: /effort [off|minimal|low|medium|high|xhigh|max]",
          "Policy: central capability gate; plan/review deny bash + non-read tools.",
        ];
        if (ctx.hasUI) await ctx.ui.select("Permissions", lines);
        else console.log(lines.join("\n"));
        return;
      }
      if (next === "cycle" || next === "next") {
        const n = nextPermissionLevel(getState().permissionProfile);
        try {
          applyProfile(n.id, ctx);
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "warning");
        }
        return;
      }
      try {
        applyProfile(next, ctx);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  for (const alias of ["ask", "permission"] as const) {
    pi.registerCommand(alias, {
      description: `Alias for /permissions`,
      handler: async (args, ctx) => {
        const next = (args || "").trim().toLowerCase();
        if (!next) {
          const cur = getState().permissionProfile;
          ctx.ui.notify(formatPermissionMenu(cur), "info");
          return;
        }
        try {
          applyProfile(
            next === "cycle"
              ? nextPermissionLevel(getState().permissionProfile).id
              : next,
            ctx,
          );
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "warning");
        }
      },
    });
  }

  // Single gate for native, alloy_*, and MCP tools
  pi.on("tool_call", async (event, ctx) => {
    const state = getState();
    const profile = state.permissionProfile;
    const name = event.toolName;
    const input = event.input || {};

    // Sandbox: docker must be available for bash — fail closed, never host bash
    if (profile === "sandbox" && name === "bash") {
      const d = diagnoseDocker(process.cwd());
      if (!d.daemon) {
        return {
          block: true,
          reason: `Sandbox profile but Docker unavailable: ${d.detail}. Host bash is blocked.`,
        };
      }
    }

    const result = evaluateToolPolicy({
      toolName: name,
      input,
      mode: state.mode,
      readOnlyMode: isReadOnlyMode(),
      permissionProfile: profile,
    });

    if (result.decision === "allow") {
      return undefined;
    }

    if (result.decision === "deny") {
      return {
        block: true,
        reason: result.reason || `Blocked ${name}`,
      };
    }

    // approve
    const detail = formatApprovalDetail(name, input);
    const caps = (result.caps || capabilitiesForTool(name)).join(", ");
    const ok = await approve(
      ctx,
      `${result.reason || "Approve tool?"}\n\n  tool: ${name}\n  caps: ${caps}\n  ${detail}`,
    );
    if (!ok) {
      return {
        block: true,
        reason: ctx.hasUI
          ? `Denied by user (${profile})`
          : `${profile} blocked in headless (fail-closed)`,
      };
    }
    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    updateStatus(ctx);
  });
}
