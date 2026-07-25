/**
 * Operating modes: chat | plan | build | review
 * plan/review are read-leaning; build/chat use active permission profile.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getState, nextPrimaryMode, setMode } = require(
  join(root, "lib", "state.mjs"),
);
const { loadConfig } = require(join(root, "lib", "config.mjs"));
const { ensureAlloyKeybindings } = require(
  join(root, "lib", "keybindings-patch.mjs"),
);

const MODE_HELP: Record<string, string> = {
  chat: "General conversation and light coding with current permissions.",
  plan: "Read-only investigation. Writes a plan; no file mutations.",
  build: "Implement with tools under the active permission profile.",
  review: "Independent review posture. Prefer read tools; no mutations.",
};

function applyMode(
  raw: string,
  ctx: {
    ui: {
      notify: (message: string, type?: string) => void;
      setStatus: (key: string, value: string | undefined) => void;
    };
  },
) {
  setMode(raw);
  const mode = getState().mode;
  const label = mode[0]!.toUpperCase() + mode.slice(1);
  ctx.ui.setStatus("alloy-mode", `mode:${mode}`);
  ctx.ui.notify(`Mode → ${label}. ${MODE_HELP[mode] || ""}`, "info");
  if (mode === "plan") {
    ctx.ui.notify(
      "Plan mode: mutating tools blocked. Shift+Tab to return to Build.",
      "info",
    );
  }
  return mode;
}

export function registerModes(pi: ExtensionAPI) {
  try {
    ensureAlloyKeybindings();
  } catch {
    // The runtime shortcut still works when the persisted Pi override cannot be updated.
  }

  try {
    const cfg = loadConfig();
    if (cfg.defaultMode) setMode(cfg.defaultMode);
  } catch {
    // keep default
  }

  pi.registerShortcut(Key.shift("tab"), {
    description: "Cycle primary mode (Build ↔ Plan)",
    handler: async (ctx) => {
      try {
        applyMode(nextPrimaryMode(getState().mode), ctx);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  pi.registerCommand("mode", {
    description:
      "Set operating mode: /mode [chat|plan|build|review] (Shift+Tab cycles Build/Plan)",
    handler: async (args, ctx) => {
      const next = (args || "").trim().toLowerCase();
      if (!next) {
        const s = getState();
        const lines = Object.entries(MODE_HELP).map(
          ([k, v]) => `${k === s.mode ? "→" : " "} ${k}  — ${v}`,
        );
        lines.unshift(`Current mode: ${s.mode}`);
        await ctx.ui.select("Alloy modes", lines);
        return;
      }
      try {
        applyMode(next, ctx);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  // Convenience aliases
  for (const m of ["plan", "build", "review"] as const) {
    pi.registerCommand(m, {
      description: `Switch to ${m} mode (alias for /mode ${m})`,
      handler: async (_args, ctx) => {
        applyMode(m, ctx);
      },
    });
  }

  pi.on("before_agent_start", async (event) => {
    const { mode } = getState();
    const extras: string[] = [
      "",
      `# Alloy mode: ${mode}`,
      MODE_HELP[mode] || "",
    ];
    if (mode === "plan") {
      extras.push(
        "You are in PLAN mode. Do not edit files or run mutating commands.",
        "Investigate with read/grep/find/ls and produce a concrete plan.",
        "End with requirements checklist and open questions.",
      );
    } else if (mode === "review") {
      extras.push(
        "You are in REVIEW mode. Treat this as an independent code review.",
        "Do not implement fixes unless asked. Findings first, severity-ordered.",
      );
    } else if (mode === "build") {
      extras.push(
        "You are in BUILD mode. Implement carefully, run checks when possible.",
      );
    }
    return {
      systemPrompt: `${event.systemPrompt}\n${extras.join("\n")}`,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    const { mode } = getState();
    ctx.ui.setStatus("alloy-mode", `mode:${mode}`);
  });
}
