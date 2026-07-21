/**
 * /auto orchestration with live agent panel + fix loops.
 * /fusion multi-model merge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { runAutoWorkflow } = require(join(root, "lib", "auto-workflow.mjs"));
const { runFusion } = require(join(root, "lib", "fusion.mjs"));
const { getRunsDir } = require(join(root, "lib", "paths.mjs"));
const { renderPanelThemed, renderPanelLines } = require(
  join(root, "lib", "agent-panel.mjs"),
);

/** Keep last UI ctx for panel refresh during long runs */
let panelUi: ExtensionContext["ui"] | null = null;

function paintPanel(panel: unknown, ctx?: { ui?: ExtensionContext["ui"] }) {
  const ui = ctx?.ui || panelUi;
  if (!ui?.setWidget) return;
  try {
    const theme = (ui as { theme?: unknown }).theme;
    const lines = theme
      ? renderPanelThemed(panel, theme)
      : renderPanelLines(panel);
    ui.setWidget("alloy-agents", lines, { placement: "belowEditor" });
    const phase = (panel as { phase?: string })?.phase || "run";
    const fix = (panel as { fixRound?: number; maxFixRounds?: number })?.maxFixRounds
      ? ` fix${(panel as { fixRound?: number }).fixRound || 0}/${(panel as { maxFixRounds?: number }).maxFixRounds}`
      : "";
    ui.setStatus?.(
      "alloy-auto",
      (ui as { theme?: { fg: (c: string, t: string) => string } }).theme?.fg
        ? (ui as { theme: { fg: (c: string, t: string) => string } }).theme.fg(
            "accent",
            `auto:${phase}${fix}`,
          )
        : `auto:${phase}${fix}`,
    );
  } catch {
    // ignore UI paint errors
  }
}

function clearPanel(ctx?: { ui?: ExtensionContext["ui"] }) {
  const ui = ctx?.ui || panelUi;
  try {
    ui?.setWidget?.("alloy-agents", undefined);
  } catch {
    // ignore
  }
}

export function registerAuto(pi: ExtensionAPI) {
  pi.registerCommand("auto", {
    description:
      "Auto pipeline with fix loops: scout → plan → build → check → review ↺ fix. /auto <request>",
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
          `Spawns child Pi agents (needs /login). May use a worktree and fix rounds on FAIL.\n\n${request.slice(0, 300)}`,
        );
        if (!ok) {
          ctx.ui.notify("Auto cancelled.", "info");
          return;
        }
      }

      panelUi = ctx.ui;
      ctx.ui.notify("Auto starting… watch the agent panel below the editor.", "info");
      ctx.ui.setWorkingMessage?.("Alloy auto running…");

      try {
        const summary = await runAutoWorkflow({
          request,
          cwd: process.cwd(),
          onProgress: (msg: string) => {
            try {
              ctx.ui.notify(msg, "info");
            } catch {
              // ignore
            }
          },
          onPanel: (panel: unknown) => paintPanel(panel, ctx),
        });

        paintPanel(
          {
            title: "ALLOY AUTO",
            runId: summary.runId,
            phase: summary.status,
            fixRound: summary.fixRound,
            maxFixRounds: summary.maxFixRounds,
            agents: Object.entries(summary.agents || {}).map(([k, v]: [string, any]) => ({
              role: k,
              status: v.ok ? "ok" : "fail",
              model: v.model,
              detail: v.error || summary.reviewVerdict || "",
              usage: v.usage,
            })),
          },
          ctx,
        );

        const lines = [
          `status: ${summary.status}`,
          `verdict: ${summary.reviewVerdict || "n/a"}`,
          `fix rounds: ${summary.fixRound || 0}/${summary.maxFixRounds || 0}`,
          `run: ${summary.runId}`,
          `dir: ${summary.runDir}`,
          `diagnostics: ${summary.diagnosticsOk ? "ok" : "fail/skip"}`,
          `pass: ${summary.pass}`,
          "",
          ...(summary.panel || []),
        ];
        if (summary.error === "auth_required") {
          lines.push("", "Auth required: /login for Claude, Codex, and/or Grok.");
        }
        await ctx.ui.select("Auto complete", lines);
      } catch (err) {
        ctx.ui.setStatus("alloy-auto", "auto:fail");
        ctx.ui.notify(String((err as Error).message || err), "error");
      } finally {
        ctx.ui.setWorkingMessage?.();
        // Keep panel visible so user can read final state; clear on next session_start
      }
    },
  });

  pi.registerCommand("fusion", {
    description:
      "Multi-model fusion: /fusion [plan|build] <request> — independent workers + merger",
    handler: async (args, ctx) => {
      let raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify(
          "Usage: /fusion [plan|build] <request>\nDefault mode: plan (read-only workers).",
          "warning",
        );
        return;
      }
      let mode: "plan" | "build" = "plan";
      if (/^build\b/i.test(raw)) {
        mode = "build";
        raw = raw.replace(/^build\s+/i, "");
      } else if (/^plan\b/i.test(raw)) {
        mode = "plan";
        raw = raw.replace(/^plan\s+/i, "");
      }
      if (!raw.trim()) {
        ctx.ui.notify("Provide a request after /fusion [plan|build]", "warning");
        return;
      }

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Start fusion?",
          `Mode: ${mode}\nIndependent workers + attributed merge.\n\n${raw.slice(0, 280)}`,
        );
        if (!ok) return;
      }

      panelUi = ctx.ui;
      ctx.ui.setWorkingMessage?.("Alloy fusion running…");
      try {
        const summary = await runFusion({
          request: raw,
          mode,
          cwd: process.cwd(),
          onPanel: (panel: unknown) => paintPanel(panel, ctx),
          onProgress: (msg: string) => {
            try {
              ctx.ui.notify(msg, "info");
            } catch {
              // ignore
            }
          },
        });
        const lines = [
          `status: ${summary.status}`,
          `mode: ${summary.mode}`,
          `run: ${summary.runId}`,
          `dir: ${summary.runDir}`,
          "",
          ...(summary.panel || []),
          "",
          "Merged write-up: fusion/merged.md in the run dir",
        ];
        await ctx.ui.select("Fusion complete", lines);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      } finally {
        ctx.ui.setWorkingMessage?.();
      }
    },
  });

  pi.registerCommand("panel", {
    description: "Clear the Alloy agent panel widget",
    handler: async (_args, ctx) => {
      clearPanel(ctx);
      ctx.ui.setStatus("alloy-auto", undefined);
      ctx.ui.notify("Agent panel cleared.", "info");
    },
  });

  pi.registerCommand("runs", {
    description: "Show Alloy runs directory path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Runs: ${getRunsDir()}`, "info");
    },
  });

  pi.on("session_start", () => {
    // fresh session — clear stale panel
    clearPanel();
    panelUi = null;
  });

  pi.registerTool({
    name: "alloy_auto",
    label: "Alloy Auto",
    description:
      "Run Alloy multi-step pipeline with fix loops (scout, plan, build, diagnostics, review, fix).",
    promptSnippet: "Run multi-step auto implementation pipeline",
    parameters: Type.Object({
      request: Type.String({ description: "What to implement or investigate" }),
      useWorktree: Type.Optional(Type.Boolean()),
      maxFixRounds: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      try {
        const summary = await runAutoWorkflow({
          request: params.request,
          cwd: process.cwd(),
          useWorktree: params.useWorktree !== false,
          maxFixRounds: params.maxFixRounds,
          signal,
          onPanel: (panel: unknown) => paintPanel(panel),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Auto ${summary.status} (${summary.runId})`,
                `verdict: ${summary.reviewVerdict}`,
                `fix rounds: ${summary.fixRound}/${summary.maxFixRounds}`,
                `artifacts: ${summary.runDir}`,
                ...(summary.panel || []),
              ].join("\n"),
            },
          ],
          details: summary,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Auto failed: ${(err as Error).message || err}` }],
          details: { error: true },
        };
      }
    },
  });

  pi.registerTool({
    name: "alloy_fusion",
    label: "Alloy Fusion",
    description:
      "Run multi-model fusion: independent workers then an attributed merger. mode=plan (default) or build.",
    promptSnippet: "Multi-model fusion with provenance",
    parameters: Type.Object({
      request: Type.String(),
      mode: Type.Optional(
        Type.Union([Type.Literal("plan"), Type.Literal("build")]),
      ),
    }),
    async execute(_id, params, signal) {
      try {
        const summary = await runFusion({
          request: params.request,
          mode: params.mode === "build" ? "build" : "plan",
          cwd: process.cwd(),
          signal,
          onPanel: (panel: unknown) => paintPanel(panel),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Fusion ${summary.status} (${summary.runId})`,
                `mode: ${summary.mode}`,
                `artifacts: ${summary.runDir}`,
                ...(summary.panel || []),
              ].join("\n"),
            },
          ],
          details: summary,
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Fusion failed: ${(err as Error).message || err}` },
          ],
          details: { error: true },
        };
      }
    },
  });
}
