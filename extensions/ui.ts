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
        `Alloy v${process.env.ALLOY_VERSION || "0.5.0"}`,
        "Harness on Pi · sandbox · help · auto · fusion · memory · MCP",
        "",
        "Help:     /help   /help <topic>   /help search <query>",
        "Auth:     /login   /providers   /doctor",
        "Modes:    /mode chat|plan|build|review",
        "Auto:     /auto <request>   /fusion [plan|build] <request>",
        "Safety:   /permissions readonly|safe|workspace|sandbox",
        "Sandbox:  /sandbox status|start|stop   (Docker, network none)",
        "Memory:   /remember   /memory   /mcp   /worktree   /diagnose",
        "Git:      /checkpoint   /undo",
        "",
        "Subscriptions: Claude · Codex/ChatGPT · Grok",
        "Pi native: /model /resume /tree /compact /settings",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });
}
