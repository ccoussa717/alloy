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
const {
  diagnoseProviders,
  formatFullDoctorReport,
  MVP_PROVIDERS,
} = require(join(root, "lib", "providers.mjs"));
const { diagnoseDocker, formatDockerDoctor } = require(
  join(root, "lib", "docker-sandbox.mjs"),
);
const { getAlloyVersion } = require(join(root, "lib", "version.mjs"));

export function registerProviders(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description:
      "Diagnose Alloy versions, providers, model defaults, Docker (never prints secrets)",
    handler: async (_args, ctx) => {
      const results = diagnoseProviders();
      const docker = diagnoseDocker(process.cwd());
      const full = formatFullDoctorReport({
        results,
        dockerText: formatDockerDoctor(docker),
        includeEconomics: true,
        includeModels: true,
      });

      const footer = [
        "",
        "Commands:",
        "  Claude  →  /login  → Anthropic subscription",
        "  Codex   →  /login  → ChatGPT / Codex subscription",
        "  Grok    →  /login xai  → Use a subscription",
        "  Sandbox →  /permissions sandbox",
        "  Help    →  /help",
        `ALLOY_ROOT=${process.env.ALLOY_ROOT || "(unset)"}`,
        `ALLOY_VERSION=${process.env.ALLOY_VERSION || getAlloyVersion()}`,
      ].join("\n");

      const report = full + footer;

      if (ctx.hasUI) {
        await ctx.ui.select("Alloy /doctor", report.split("\n"));
      } else {
        console.log(report);
      }

      const missing = results.filter((r: { ok: boolean }) => !r.ok);
      if (missing.length) {
        ctx.ui.notify(
          `${missing.length} provider(s) not configured or expired. Use /login.`,
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
      items.push("Run /doctor for full detail (economics + catalog)");
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
