/**
 * Permission levels (Grok Build style) + Shift+Tab cycle.
 * /effort handles thinking; Shift+Tab is permissions only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
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
  isSandboxProfile,
} = require(join(root, "lib", "state.mjs"));
const { isMcpToolName } = require(join(root, "lib", "mcp-client.mjs"));
const { diagnoseDocker } = require(join(root, "lib", "docker-sandbox.mjs"));
const {
  normalizePermissionId,
  getPermissionLevel,
  nextPermissionLevel,
  permissionStatusText,
  formatPermissionMenu,
  isInspectionBash,
  isDangerousBash,
  listCycleLevels,
} = require(join(root, "lib", "permissions.mjs"));
const { ensureAlloyKeybindings } = require(
  join(root, "lib", "keybindings-patch.mjs"),
);

const MUTATING_NATIVE = new Set(["write", "edit", "bash"]);

function mcpLooksReadOnly(toolName: string): boolean {
  return /_(get|list|read|search|find|query|fetch|describe|show|status)/i.test(
    toolName,
  );
}

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
      `Unknown level: ${raw}\nUse: ask-all | ask-some | ask-dangerous | ask-none | sandbox\nOr Shift+Tab to cycle.`,
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
  // Free Shift+Tab from thinking cycle (thinking → /effort)
  try {
    ensureAlloyKeybindings();
  } catch {
    // ignore
  }

  try {
    const cfg = loadConfig();
    const raw = cfg.permissionProfile || "ask-dangerous";
    const id = normalizePermissionId(raw) || "ask-dangerous";
    setPermissionProfile(id);
  } catch {
    setPermissionProfile("ask-dangerous");
  }

  // Shift+Tab → cycle permission levels
  pi.registerShortcut(Key.shift("tab"), {
    description: "Cycle Alloy permission level (ask everything → … → ask nothing)",
    handler: async (ctx) => {
      // Skip if in plan/review — those force read-only; still allow cycle for when user switches mode
      const cur = getState().permissionProfile;
      // If currently sandbox, jump into the ask cycle at dangerous
      const from =
        cur === "sandbox" ? "ask-dangerous" : cur;
      const next = nextPermissionLevel(from);
      try {
        applyProfile(next.id, ctx);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  pi.registerCommand("permissions", {
    description:
      "Permission level: /permissions [ask-all|ask-some|ask-dangerous|ask-none|sandbox]  (Shift+Tab cycles)",
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
          "Shift+Tab cycles the four ask levels.",
          "Thinking/effort: /effort [off|minimal|low|medium|high|xhigh|max]",
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

  // Friendly aliases
  for (const alias of ["ask", "permission"] as const) {
    pi.registerCommand(alias, {
      description: `Alias for /permissions (Shift+Tab cycles)`,
      handler: async (args, ctx) => {
        // re-enter via same logic
        const next = (args || "").trim().toLowerCase();
        if (!next) {
          const cur = getState().permissionProfile;
          ctx.ui.notify(formatPermissionMenu(cur), "info");
          return;
        }
        try {
          applyProfile(next === "cycle" ? nextPermissionLevel(getState().permissionProfile).id : next, ctx);
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "warning");
        }
      },
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    const profile = getState().permissionProfile;
    const name = event.toolName;

    // Plan/review modes: hard read-only
    if (isReadOnlyMode()) {
      if (MUTATING_NATIVE.has(name)) {
        if (name === "bash" && isInspectionBash((event.input as { command?: string }).command)) {
          return undefined;
        }
        return {
          block: true,
          reason: `Alloy ${getState().mode} mode is read-only. /mode build to mutate.`,
        };
      }
      if (isMcpToolName(name) && !mcpLooksReadOnly(name)) {
        return {
          block: true,
          reason: `Alloy ${getState().mode}: mutating MCP blocked.`,
        };
      }
      return undefined;
    }

    // Sandbox: docker boundary; no host prompts
    if (profile === "sandbox") {
      if (name === "bash") {
        const d = diagnoseDocker(process.cwd());
        if (!d.daemon) {
          return {
            block: true,
            reason: `Sandbox profile but Docker unavailable: ${d.detail}`,
          };
        }
      }
      return undefined;
    }

    // ask-none: never prompt
    if (profile === "ask-none") return undefined;

    // ask-all: approve every mutation
    if (profile === "ask-all") {
      if (MUTATING_NATIVE.has(name) || (isMcpToolName(name) && !mcpLooksReadOnly(name))) {
        const detail =
          name === "bash"
            ? String((event.input as { command?: string }).command || "")
            : JSON.stringify(event.input ?? {}).slice(0, 200);
        const ok = await approve(
          ctx,
          `Ask everything — allow ${name}?\n\n  ${detail}`,
        );
        if (!ok) {
          return {
            block: true,
            reason: ctx.hasUI
              ? "Denied by user (ask-all)"
              : "ask-all blocked in headless (fail-closed)",
          };
        }
      }
      return undefined;
    }

    // ask-some: approve writes/edits + non-inspection bash + mutating MCP
    if (profile === "ask-some") {
      if (name === "write" || name === "edit") {
        const path =
          (event.input as { path?: string; file_path?: string }).path ||
          (event.input as { file_path?: string }).file_path ||
          "";
        const ok = await approve(ctx, `Ask some — allow ${name}?\n\n  ${path}`);
        if (!ok) {
          return {
            block: true,
            reason: ctx.hasUI
              ? "Denied by user (ask-some)"
              : "ask-some blocked in headless",
          };
        }
        return undefined;
      }
      if (name === "bash") {
        const command = String(
          (event.input as { command?: string }).command || "",
        );
        if (isInspectionBash(command)) return undefined;
        const ok = await approve(
          ctx,
          `Ask some — allow bash?\n\n  ${command}`,
        );
        if (!ok) {
          return {
            block: true,
            reason: ctx.hasUI
              ? "Denied by user (ask-some)"
              : "ask-some blocked in headless",
          };
        }
        return undefined;
      }
      if (isMcpToolName(name) && !mcpLooksReadOnly(name)) {
        const ok = await approve(ctx, `Ask some — allow MCP ${name}?`);
        if (!ok) {
          return { block: true, reason: "Denied by user (ask-some)" };
        }
      }
      return undefined;
    }

    // ask-dangerous (default): only dangerous bash
    if (profile === "ask-dangerous" && name === "bash") {
      const command = String(
        (event.input as { command?: string }).command || "",
      );
      if (!isDangerousBash(command)) return undefined;
      const ok = await approve(
        ctx,
        `Dangerous command — allow?\n\n  ${command}`,
      );
      if (!ok) {
        return {
          block: true,
          reason: ctx.hasUI
            ? "Denied by user (ask-dangerous)"
            : "Dangerous command blocked headless (fail-closed)",
        };
      }
    }

    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      const kb = ensureAlloyKeybindings();
      if (kb.changed) {
        ctx.ui.notify(
          "Alloy: Shift+Tab cycles permissions. Thinking is /effort. Restart or /reload if Shift+Tab still changes thinking.",
          "info",
        );
      }
    } catch {
      // ignore
    }
    updateStatus(ctx);
  });
}

// silence unused
void listCycleLevels;
void isSandboxProfile;
