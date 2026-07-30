/**
 * Three-provider MVP surface: Anthropic, Codex/ChatGPT, xAI Grok.
 * /doctor and /providers — never print secrets.
 * Local engines are surfaced in doctor/providers via discovery (see local-engines).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
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
const {
  discoverLocalEngines,
  formatLocalEnginesDoctorSection,
  localEngineDoctorRows,
} = require(join(root, "lib", "local-engines.mjs"));
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));
const { getAlloyVersion } = require(join(root, "lib", "version.mjs"));
const { ALLOY_CLAUDE_OPUS_5_MODEL } = require(
  join(root, "lib", "alloy-models.mjs"),
);

export function withClaudeOpus5(anthropic: Provider): Provider {
  const fallback = ALLOY_CLAUDE_OPUS_5_MODEL;
  return {
    ...anthropic,
    getModels: () => {
      const current = anthropic.getModels();
      return current.some((model) => model.id === fallback.id)
        ? current
        : [...current, fallback];
    },
  };
}

export function registerProviders(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description:
      "Diagnose Alloy versions, providers, model defaults, Docker (never prints secrets)",
    handler: async (_args, ctx) => {
      const results = diagnoseProviders();
      const docker = diagnoseDocker(process.cwd());
      let localEnginesText: string | null = null;
      try {
        const localBundle = await discoverLocalEngines({
          config: loadGlobalConfig(),
        });
        localEnginesText = formatLocalEnginesDoctorSection(localBundle);
      } catch {
        // discovery failures must not break hosted /doctor
        localEnginesText =
          "Local engines\n-------------\nDiscovery failed (non-fatal; hosted doctor continues).";
      }
      const full = formatFullDoctorReport({
        results,
        dockerText: formatDockerDoctor(docker),
        localEnginesText,
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
          `${missing.length} hosted provider(s) not configured or expired. Use /login.`,
          "warning",
        );
      } else {
        ctx.ui.notify("Hosted MVP providers look configured.", "info");
      }
    },
  });

  pi.registerCommand("providers", {
    description:
      "Show hosted MVP + local engine status (Anthropic, Codex, Grok, Ollama, …)",
    handler: async (_args, ctx) => {
      const results = diagnoseProviders();
      const items = results.map(
        (r: { ok: boolean; label: string; status: string }) =>
          `${r.ok ? "✓" : "✗"} ${r.label} — ${r.status}`,
      );
      try {
        const localBundle = await discoverLocalEngines({
          config: loadGlobalConfig(),
        });
        const localRows = localEngineDoctorRows(localBundle);
        if (localRows.length) {
          items.push("---");
          items.push("Local engines");
          for (const row of localRows) {
            items.push(
              `${row.ok ? "✓" : "✗"} ${row.label} — ${row.detail}`,
            );
          }
        }
      } catch {
        // discovery failures must not break /providers
      }
      items.push("---");
      items.push("Run /login to connect a subscription");
      items.push("Run /doctor for full detail (economics + catalog + local)");
      await ctx.ui.select("Alloy providers", items);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const anthropic = ctx.modelRegistry.getProvider("anthropic");
    if (
      anthropic &&
      !anthropic.getModels().some((model) => model.id === "claude-opus-5")
    ) {
      pi.registerProvider(withClaudeOpus5(anthropic));
    }

    try {
      const results = diagnoseProviders();
      const ok = results.filter((r: { ok: boolean }) => r.ok).length;
      ctx.ui.setStatus("alloy-providers", `auth:${ok}/${MVP_PROVIDERS.length}`);
    } catch {
      // ignore
    }
  });
}
