/**
 * Light Alloy chrome: header status + welcome on session start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerUi(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("alloy", "ALLOY");
    // One-time soft nudge; do not spam
    try {
      ctx.ui.notify(
        "Alloy ready · /doctor · /remember · /memory · /mcp · /skill-capture · /login",
        "info",
      );
    } catch {
      // ignore
    }
  });

  pi.registerCommand("alloy", {
    description: "Alloy help and version",
    handler: async (_args, ctx) => {
      const lines = [
        `Alloy v${process.env.ALLOY_VERSION || "0.4.0"}`,
        "Harness on Pi · auto fix-loops · fusion · live agent panel",
        "",
        "Auth:     /login   /providers   /doctor",
        "Modes:    /mode chat|plan|build|review",
        "Auto:     /auto <request>   (fix loops on FAIL)",
        "Fusion:   /fusion [plan|build] <request>",
        "Panel:    live below editor during auto/fusion · /panel clears",
        "Memory:   /remember   /memory   /mcp   /worktree   /diagnose",
        "Git:      /checkpoint   /undo",
        "Safety:   /permissions [readonly|safe|workspace]",
        "",
        "Subscriptions: Claude · Codex/ChatGPT · Grok",
        "Pi native: /model /resume /tree /compact /settings",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });
}
