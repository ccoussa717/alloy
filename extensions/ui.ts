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
        `Alloy v${process.env.ALLOY_VERSION || "0.6.0"}`,
        "Harness on Pi · Shift+Tab permissions · /effort thinking",
        "",
        "Help:     /help   /help <topic>   /help search <query>",
        "Auth:     /login   /providers   /doctor",
        "Effort:   /effort [off|low|medium|high|xhigh|max]",
        "Perms:    Shift+Tab cycle  ·  /permissions ask-all|ask-some|ask-dangerous|ask-none",
        "Sandbox:  /sandbox  or  /permissions sandbox  (Docker)",
        "Modes:    /mode chat|plan|build|review",
        "Auto:     /auto <request>   /fusion [plan|build] <request>",
        "Memory:   /remember   /memory   /mcp   /worktree   /diagnose",
        "",
        "Subscriptions: Claude · Codex/ChatGPT · Grok",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });
}
