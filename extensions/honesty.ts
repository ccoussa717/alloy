/**
 * Alloy honesty — anti-hallucination policy + factual model identity.
 *
 * Injected every turn via before_agent_start.
 * /whoami answers from harness facts only (never model self-report).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildHonestyBlock,
  withHonesty,
  factsFromContext,
} = require(join(root, "lib", "honesty.mjs"));
const { loadConfig } = require(join(root, "lib", "config.mjs"));

function honestyEnabled(): boolean {
  try {
    const cfg = loadConfig();
    return cfg.honesty?.enabled !== false;
  } catch {
    return true;
  }
}

export function registerHonesty(pi: ExtensionAPI) {
  // Inject first-class honesty + real model id every agent turn
  pi.on("before_agent_start", async (event, ctx) => {
    if (!honestyEnabled()) return;
    const facts = factsFromContext(ctx, { role: "main" });
    return {
      systemPrompt: withHonesty(event.systemPrompt, facts),
    };
  });

  pi.registerCommand("whoami", {
    description: "Show harness facts: Alloy version + active model (not a guess)",
    handler: async (_args, ctx) => {
      const facts = factsFromContext(ctx, { role: "main" });
      const provider = facts.provider || "(unknown)";
      const modelId = facts.modelId || "(unknown)";
      const ver = facts.alloyVersion || process.env.ALLOY_VERSION || "unknown";
      const lines = [
        "Alloy harness facts (authoritative)",
        "",
        `Alloy version:  ${ver}`,
        `Runtime:        Pi coding agent (not Cursor, not Composer)`,
        `Provider:       ${provider}`,
        `Model id:       ${modelId}`,
        "",
        "If a chat reply claims a different model, the model hallucinated.",
        "Trust this /whoami output and the Build · status line, not self-description.",
      ];
      if (ctx.hasUI !== false) {
        await ctx.ui.select("Alloy /whoami", lines);
      } else {
        console.log(lines.join("\n"));
      }
    },
  });

  pi.registerCommand("honesty", {
    description: "Show Alloy honesty / anti-hallucination policy",
    handler: async (_args, ctx) => {
      const facts = factsFromContext(ctx, { role: "main" });
      const block = buildHonestyBlock(facts);
      const lines = block.split("\n").slice(0, 80);
      if (ctx.hasUI !== false) {
        await ctx.ui.select("Alloy honesty policy", lines);
      } else {
        console.log(block);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!honestyEnabled()) return;
    try {
      const id = ctx.model?.id;
      if (id) {
        ctx.ui.setStatus(
          "alloy-model",
          ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("dim", String(id).slice(0, 24))
            : String(id).slice(0, 24),
        );
      }
    } catch {
      // ignore
    }
  });
}
