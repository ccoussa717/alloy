/**
 * Three-provider MVP surface: Anthropic, Codex/ChatGPT, xAI Grok.
 * /doctor and /providers — never print secrets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { diagnoseProviders, formatDoctorReport, MVP_PROVIDERS } = require(
  join(root, "lib", "providers.mjs"),
);

export function registerProviders(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description: "Diagnose Alloy providers, memory paths, and MCP config",
    handler: async (_args, ctx) => {
      const results = diagnoseProviders();
      const report = formatDoctorReport(results);

      // Append non-secret path checks
      const extra = [
        "",
        "Subscriptions (preferred for MVP):",
        "  Claude  →  /login  → Anthropic subscription",
        "  Codex   →  /login  → ChatGPT / Codex subscription",
        "  Grok    →  /login xai  → Use a subscription",
        "",
        "API keys still work as a fallback; /doctor will show env/api_key status.",
        `ALLOY_ROOT=${process.env.ALLOY_ROOT || "(unset)"}`,
        `ALLOY_VERSION=${process.env.ALLOY_VERSION || "0.1.0"}`,
      ].join("\n");

      const full = report + extra;

      if (ctx.hasUI) {
        // Show in a selectable list (scrollable) for long reports
        const lines = full.split("\n");
        await ctx.ui.select("Alloy /doctor", lines.length ? lines : [full]);
      } else {
        console.log(full);
      }

      const missing = results.filter((r: { ok: boolean }) => !r.ok);
      if (missing.length) {
        ctx.ui.notify(
          `${missing.length} provider(s) not configured. Use /login.`,
          "warning",
        );
      } else {
        ctx.ui.notify("All three MVP providers look configured.", "info");
      }
    },
  });

  pi.registerCommand("providers", {
    description: "Show MVP provider status (Anthropic, Codex, Grok)",
    handler: async (_args, ctx) => {
      const results = diagnoseProviders();
      const items = results.map(
        (r: { ok: boolean; label: string; status: string }) =>
          `${r.ok ? "✓" : "✗"} ${r.label} — ${r.status}`,
      );
      items.push("---");
      items.push("Run /login to connect a subscription");
      items.push("Run /doctor for full detail");
      await ctx.ui.select("Alloy providers", items);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      const results = diagnoseProviders();
      const ok = results.filter((r: { ok: boolean }) => r.ok).length;
      ctx.ui.setStatus("alloy-providers", `auth:${ok}/${MVP_PROVIDERS.length}`);
    } catch {
      // ignore
    }
  });
}
