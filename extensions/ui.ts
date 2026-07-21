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
        `Alloy v${process.env.ALLOY_VERSION || "0.1.0"}`,
        "Harness on Pi · MVP: 3 subs + memory + skills + MCP",
        "",
        "Auth:     /login   /providers   /doctor",
        "Memory:   /remember   /memory list|search|forget",
        "Skills:   /skill-capture   /skill-promote   /skill-drafts",
        "MCP:      /mcp list|status|reload|path",
        "Safety:   /permissions [readonly|safe|workspace]",
        "",
        "Subscriptions: Claude · Codex/ChatGPT · Grok",
        "Pi native: /model /resume /tree /compact /settings",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });
}
