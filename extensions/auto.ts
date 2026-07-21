/**
 * /auto orchestration — scout → plan → checkpoint → build (worktree) → check → review
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { runAutoWorkflow } = require(join(root, "lib", "auto-workflow.mjs"));
const { getRunsDir } = require(join(root, "lib", "paths.mjs"));

export function registerAuto(pi: ExtensionAPI) {
  pi.registerCommand("auto", {
    description:
      "Run Alloy auto pipeline: scout → plan → build → diagnostics → review. /auto <request>",
    handler: async (args, ctx) => {
      const request = (args || "").trim();
      if (!request) {
        ctx.ui.notify(
          "Usage: /auto <request>\nExample: /auto add a --version flag to the CLI",
          "warning",
        );
        return;
      }

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Start /auto?",
          `This spawns child Pi agents (needs provider auth) and may edit a worktree.\n\n${request.slice(0, 300)}`,
        );
        if (!ok) {
          ctx.ui.notify("Auto cancelled.", "info");
          return;
        }
      }

      ctx.ui.notify("Auto starting… (scout → plan → build → check → review)", "info");
      ctx.ui.setStatus("alloy-auto", "auto:run");

      try {
        const summary = await runAutoWorkflow({
          request,
          cwd: process.cwd(),
          onProgress: (msg: string) => {
            try {
              ctx.ui.setStatus("alloy-auto", `auto:${msg.slice(0, 24)}`);
              ctx.ui.notify(msg, "info");
            } catch {
              // ignore UI failures mid-run
            }
          },
        });

        ctx.ui.setStatus("alloy-auto", `auto:${summary.status}`);
        const lines = [
          `status: ${summary.status}`,
          `run: ${summary.runId}`,
          `dir: ${summary.runDir}`,
          `diagnostics: ${summary.diagnosticsOk ? "ok" : "fail/skip"}`,
          "",
          "agents:",
          ...Object.entries(summary.agents || {}).map(
            ([k, v]: [string, any]) =>
              `  ${k}: ${v.ok ? "ok" : "fail"}${v.error ? ` (${v.error})` : ""}`,
          ),
        ];
        if (summary.error === "auth_required") {
          lines.push("", "Auth required: run /login for Claude, Codex, and/or Grok.");
        }
        await ctx.ui.select("Auto complete", lines);
      } catch (err) {
        ctx.ui.setStatus("alloy-auto", "auto:fail");
        ctx.ui.notify(String((err as Error).message || err), "error");
      }
    },
  });

  pi.registerCommand("runs", {
    description: "Show Alloy runs directory path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Runs: ${getRunsDir()}`, "info");
    },
  });

  pi.registerTool({
    name: "alloy_auto",
    label: "Alloy Auto",
    description:
      "Run the Alloy multi-step pipeline (scout, plan, build, diagnostics, review) for a request. Prefer when the user wants an automated end-to-end implementation pass.",
    promptSnippet: "Run multi-step auto implementation pipeline",
    parameters: Type.Object({
      request: Type.String({ description: "What to implement or investigate" }),
      useWorktree: Type.Optional(
        Type.Boolean({ description: "Isolate builder in a git worktree (default true)" }),
      ),
    }),
    async execute(_id, params, signal) {
      try {
        const summary = await runAutoWorkflow({
          request: params.request,
          cwd: process.cwd(),
          useWorktree: params.useWorktree !== false,
          signal,
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Auto ${summary.status} (${summary.runId})`,
                `artifacts: ${summary.runDir}`,
                `diagnostics: ${summary.diagnosticsOk}`,
                JSON.stringify(summary.agents, null, 2),
              ].join("\n"),
            },
          ],
          details: summary,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Auto failed: ${(err as Error).message || err}`,
            },
          ],
          details: { error: true },
        };
      }
    },
  });
}
