/**
 * /forge — multi-model pipeline spine:
 * fusion → fission → auto → fission (diff), shared run artifacts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { runForge } = require(join(root, "lib", "forge-workflow.mjs"));
const {
  createPanelState,
  renderPanelLines,
  renderPanelThemed,
  upsertAgent,
  setPhase,
} = require(join(root, "lib", "agent-panel.mjs"));
const { resolveParentChildSpawnOpts } = require(join(root, "lib", "parent-policy.mjs"));

const FORGE_ARGUMENTS = [
  { value: "help", label: "help", description: "Show Forge usage" },
];

function getForgeArgumentCompletions(prefix = "") {
  const raw = String(prefix).trimStart().toLowerCase();
  if (raw.includes(" ")) return null;
  const matches = FORGE_ARGUMENTS.filter((item) => item.value.startsWith(raw));
  return matches.length ? matches : null;
}

function formatForgeHelp() {
  return [
    "/forge <request>     Full multi-model spine: fusion → fission → auto → fission",
    "/forge help          Show this help",
    "",
    "Standalone tools (still available):",
    "  /fusion   multi-model plan only",
    "  /fission  multi-model adversarial review only",
    "  /auto     implement with scout/plan/build/review/fix only",
    "",
    "Forge shares one run directory under ~/.pi/alloy/runs/ with phase subfolders:",
    "  fusion/  fission-plan/  auto/  fission-diff/",
    "",
    "Pre-build fission FAIL (blocking findings) stops before implementation.",
    "Post-build fission reviews the worktree (or cwd) diff when present.",
  ];
}

function formatForgeSummary(summary: any) {
  return [
    `status: ${summary.status}`,
    `pass: ${summary.pass}`,
    ...(summary.error ? [`error: ${summary.error}`] : []),
    `run: ${summary.runId}`,
    `dir: ${summary.runDir}`,
    "",
    "Phases:",
    `  fusion:       ${summary.fusion?.status || "—"}`,
    `  fission-plan: ${summary.fissionPlan?.status || "—"} ${summary.fissionPlan?.verdict || ""}`.trimEnd(),
    `  auto:         ${summary.auto?.status || "—"} pass=${summary.auto?.pass ?? "—"}`,
    `  fission-diff: ${summary.fissionDiff?.status || "—"} ${summary.fissionDiff?.verdict || ""}`.trimEnd(),
    "",
    ...(summary.panel || []),
  ];
}

function paintForgePanel(summary: any, ctx: ExtensionContext) {
  if (!ctx.ui?.setWidget) return;
  const panel = createPanelState({
    title: "ALLOY FORGE",
    runId: summary.runId,
  });
  setPhase(panel, summary.status || "COMPLETE");
  const phaseMap: Record<string, { status?: string; detail?: string }> = {
    fusion: {
      status: summary.fusion?.status === "COMPLETE" ? "ok" : summary.fusion ? "fail" : "pending",
      detail: summary.fusion?.error || summary.fusion?.status || "",
    },
    "fission-plan": {
      status:
        summary.fissionPlan?.status === "NO_CHANGES" ||
        summary.fissionPlan?.verdict === "PASS" ||
        summary.fissionPlan?.status === "COMPLETE"
          ? summary.fissionPlan?.verdict === "FAIL"
            ? "fail"
            : "ok"
          : summary.fissionPlan
            ? "fail"
            : "pending",
      detail: summary.fissionPlan?.verdict || summary.fissionPlan?.error || "",
    },
    auto: {
      status: summary.auto?.pass ? "ok" : summary.auto ? "fail" : "pending",
      detail: summary.auto?.reviewVerdict || summary.auto?.error || "",
    },
    "fission-diff": {
      status:
        !summary.fissionDiff
          ? "pending"
          : summary.fissionDiff.verdict === "FAIL"
            ? "fail"
            : "ok",
      detail: summary.fissionDiff?.verdict || summary.fissionDiff?.error || "",
    },
  };
  for (const [role, info] of Object.entries(phaseMap)) {
    upsertAgent(panel, {
      role,
      status: info.status || "pending",
      detail: info.detail || "",
    });
  }
  const theme = (ctx.ui as any).theme;
  const lines = theme ? renderPanelThemed(panel, theme) : renderPanelLines(panel);
  ctx.ui.setWidget("alloy-agents", lines, { placement: "belowEditor" });
  ctx.ui.setStatus?.("alloy-forge", `forge:${summary.status}`);
}

export function registerForge(pi: ExtensionAPI) {
  pi.registerCommand("forge", {
    description:
      "Full spine: fusion → fission → auto → fission. /forge <request>",
    getArgumentCompletions: getForgeArgumentCompletions,
    handler: async (args, ctx) => {
      const request = (args || "").trim();
      if (!request || request.toLowerCase() === "help") {
        if (ctx.hasUI) await ctx.ui.select("Forge help", formatForgeHelp());
        else console.log(formatForgeHelp().join("\n"));
        return;
      }

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Start /forge?",
          [
            "Runs multi-model fusion, then fission, then auto implement, then post-diff fission.",
            "Needs configured fusion + fission models (/fusion setup, /fission setup).",
            "May use a worktree and multiple model calls — slower/costlier than /auto alone.",
            "",
            request.slice(0, 400),
          ].join("\n"),
        );
        if (!ok) {
          ctx.ui.notify("Forge cancelled.", "info");
          return;
        }
      }

      ctx.ui.notify("Forge starting… watch the agent panel.", "info");
      ctx.ui.setWorkingMessage?.("Alloy forge running…");

      try {
        // Build mode for auto phase; fusion/fission enforce their own read-only child modes.
        const parentOpts = resolveParentChildSpawnOpts({ mode: "build" });
        const summary = await runForge({
          request,
          cwd: process.cwd(),
          modelRegistry: ctx.modelRegistry,
          ...parentOpts,
          onProgress: (msg: string) => {
            try {
              ctx.ui.notify(msg, "info");
            } catch {
              // ignore
            }
          },
          onPanel: (panel: unknown) => {
            const theme = (ctx.ui as any).theme;
            const {
              renderPanelThemed: themed,
              renderPanelLines: plain,
            } = require(join(root, "lib", "agent-panel.mjs"));
            const lines = theme
              ? themed(panel, theme)
              : plain(panel);
            ctx.ui.setWidget?.("alloy-agents", lines, { placement: "belowEditor" });
            ctx.ui.setStatus?.(
              "alloy-forge",
              `forge:${(panel as { phase?: string })?.phase || "run"}`,
            );
          },
        });

        paintForgePanel(summary, ctx);
        const lines = formatForgeSummary(summary);
        if (summary.error === "auth_required" || /auth|provider_unavailable/i.test(String(summary.error || ""))) {
          lines.push("", "Auth: /login for required providers; configure /fusion setup and /fission setup.");
        }
        await ctx.ui.select(`Forge ${summary.status}`, lines);
      } catch (err) {
        ctx.ui.setStatus?.("alloy-forge", "forge:fail");
        ctx.ui.notify(String((err as Error).message || err), "error");
      } finally {
        ctx.ui.setWorkingMessage?.();
      }
    },
  });

  pi.registerTool({
    name: "alloy_forge",
    label: "Alloy Forge",
    description:
      "Run the full multi-model spine: fusion plan → fission review → auto implement → post-diff fission.",
    promptSnippet: "Full fusion→fission→auto→fission pipeline",
    parameters: Type.Object(
      {
        request: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const parentOpts = resolveParentChildSpawnOpts({ mode: "build" });
      const summary = await runForge({
        request: params.request,
        cwd: ctx.cwd || process.cwd(),
        modelRegistry: ctx.modelRegistry,
        signal,
        ...parentOpts,
      });
      return {
        content: [{ type: "text", text: formatForgeSummary(summary).join("\n") }],
        details: summary,
      };
    },
  });
}
