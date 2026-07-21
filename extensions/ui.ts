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
        `Alloy v${process.env.ALLOY_VERSION || "0.7.0"}`,
        "Multi-model agents · Shift+Tab perms · /effort · sandbox",
        "",
        "Agents:   /agent <name> profile=research|code|review <task>",
        "          /agents          list / view transcripts",
        "          /profiles        multi-model profile map",
        "Auto:     /auto <req>   /fusion [plan|build] <req>",
        "Help:     /help   /effort   /permissions   Shift+Tab",
        "Auth:     /login   /login xai   /doctor",
        "Sandbox:  /sandbox   /permissions sandbox",
        "",
        "Subscriptions: Claude · Codex/ChatGPT · Grok (per-agent models)",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });
}
