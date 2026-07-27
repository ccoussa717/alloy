/**
 * /auto orchestration with live agent panel + fix loops.
 * /fusion read-only Architect-Builder synthesis.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { runAutoWorkflow } = require(join(root, "lib", "auto-workflow.mjs"));
const {
  FUSION_EFFORT_LEVELS,
  getFusionRoleModelDefaults,
  getFusionArgumentCompletions,
  groupFusionModelRoutes,
  resolveFusionRoleEfforts,
  resolveFusionRoleModels,
  runFusion,
} = require(join(root, "lib", "fusion.mjs"));
const { resolveSessionCredentialLease } = require(
  join(root, "lib", "credential-broker.mjs"),
);
const {
  loadConfig,
  loadGlobalConfig,
  saveGlobalFusionConfig,
} = require(join(root, "lib", "config.mjs"));
const { getRunsDir } = require(join(root, "lib", "paths.mjs"));
const { renderFusionPaneLines, renderFusionWidgetLines, renderPanelThemed, renderPanelLines } = require(
  join(root, "lib", "agent-panel.mjs"),
);
const { resolveParentChildSpawnOpts } = require(
  join(root, "lib", "parent-policy.mjs"),
);

/** Keep last UI ctx for panel refresh during long runs */
let panelUi: ExtensionContext["ui"] | null = null;

function paintPanel(panel: unknown, ctx?: Pick<ExtensionContext, "ui" | "mode">) {
  const ui = ctx?.ui || panelUi;
  if (!ui?.setWidget) return;
  try {
    const theme = (ui as { theme?: unknown }).theme;
    const phase = (panel as { phase?: string })?.phase || "run";
    const isFusion = (panel as { title?: string })?.title === "ALLOY FUSION";
    if (isFusion) {
      if (ctx?.mode === "rpc") {
        ui.setWidget("alloy-agents", renderFusionWidgetLines(panel), {
          placement: "aboveEditor",
        });
      } else {
        ui.setWidget(
          "alloy-agents",
          (_tui: unknown, widgetTheme: any) => ({
            render(width: number) {
              const lines = renderFusionPaneLines(panel, width);
              if (!widgetTheme?.fg) return lines;
              return lines.map((line: string, index: number) =>
                index === 0
                  ? widgetTheme.fg("accent", line)
                  : /^[┌├└].*[┐┤┘]$/.test(line)
                    ? widgetTheme.fg("dim", line)
                    : line,
              );
            },
            invalidate() {},
          }),
          { placement: "aboveEditor" },
        );
      }
    } else {
      const lines = theme
        ? renderPanelThemed(panel, theme)
        : renderPanelLines(panel);
      ui.setWidget("alloy-agents", lines, { placement: "belowEditor" });
    }
    const statusKey = isFusion ? "alloy-fusion" : "alloy-auto";
    const statusPrefix = isFusion ? "fusion" : "auto";
    const fix = (panel as { fixRound?: number; maxFixRounds?: number })?.maxFixRounds
      ? ` fix${(panel as { fixRound?: number }).fixRound || 0}/${(panel as { maxFixRounds?: number }).maxFixRounds}`
      : "";
    ui.setStatus?.(
      statusKey,
      (ui as { theme?: { fg: (c: string, t: string) => string } }).theme?.fg
        ? (ui as { theme: { fg: (c: string, t: string) => string } }).theme.fg(
            "accent",
            `${statusPrefix}:${phase}${fix}`,
          )
        : `${statusPrefix}:${phase}${fix}`,
    );
  } catch {
    // ignore UI paint errors
  }
}

export function formatFusionLines(summary: any) {
  return formatFusionContextLines(summary);
}

const FUSION_CONTEXT_OBJECTIVE_BYTES = 128;
const FUSION_METADATA_BYTES = 128;
const FUSION_PATH_BYTES = 512;

function truncateUtf8(value: unknown, maxBytes: number) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  if (bytes.length <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function presentationUsage(value: any) {
  const cost = finiteNonNegative(value?.cost);
  return {
    input: finiteNonNegative(value?.input) || 0,
    output: finiteNonNegative(value?.output) || 0,
    cost,
    costKnown: value?.costKnown !== false && cost !== null,
    turns: finiteNonNegative(value?.turns) || 0,
  };
}

function presentationModels(value: any) {
  return Object.fromEntries(
    FUSION_ROLES.map((role) => [role, truncateUtf8(value?.[role], FUSION_METADATA_BYTES)]),
  );
}

function presentationRouting(value: any) {
  return Object.fromEntries(
    FUSION_ROLES.map((role) => {
      const route = value?.[role];
      return [role, route && typeof route === "object" ? {
        reason: truncateUtf8(route.reason, FUSION_METADATA_BYTES),
        fallbackUsed: Boolean(route.fallbackUsed),
      } : null];
    }),
  );
}

function selectFusionProposals(value: unknown) {
  const proposals = Array.isArray(value) ? value : [];
  const invalidRoles = proposals.filter(
    (proposal: any) => proposal?.role !== "architect" && proposal?.role !== "builder",
  );
  const duplicateRoles = ["architect", "builder"].filter(
    (role) => proposals.filter((proposal: any) => proposal?.role === role).length > 1,
  );
  const selected = ["architect", "builder"]
    .map((role) => {
      const matches = proposals.filter((proposal: any) => proposal?.role === role);
      return matches.length === 1 ? matches[0] : null;
    })
    .filter(Boolean);
  const errors = [
    invalidRoles.length ? "unknown proposal role" : "",
    ...duplicateRoles.map((role) => `duplicate ${role} role`),
  ].filter(Boolean);
  return { proposals: selected, errors };
}

export function createFusionPresentationSummary(summary: any) {
  const runDir = String(summary?.runDir || "");
  const selection = selectFusionProposals(summary?.proposals);
  const errors = [
    String(summary?.error || ""),
    selection.errors.length ? `Malformed Fusion provenance: ${selection.errors.join(", ")}` : "",
  ].filter(Boolean);
  return {
    kind: "fusion",
    mode: "plan",
    status: truncateUtf8(summary?.status, FUSION_METADATA_BYTES) || "UNKNOWN",
    runId: truncateUtf8(summary?.runId, FUSION_METADATA_BYTES),
    runDir,
    objective: String(summary?.objective || ""),
    error: errors.join("; ") || null,
    models: presentationModels(summary?.models),
    requestedEfforts: presentationModels(summary?.requestedEfforts),
    proposals: selection.proposals.map((proposal: any) => {
      const role = truncateUtf8(proposal?.role, FUSION_METADATA_BYTES);
      return {
        role,
        model: truncateUtf8(proposal?.model, FUSION_METADATA_BYTES),
        ok: proposal?.ok === true,
        contractOk: proposal?.contractOk === true,
        error: String(proposal?.error || "") || null,
        text: String(proposal?.text || ""),
        usage: presentationUsage(proposal?.usage),
        durationMs: finiteNonNegative(proposal?.durationMs),
      };
    }),
    synthesis: String(summary?.synthesis || ""),
    synthesizer: summary?.synthesizer
      ? {
          model: truncateUtf8(summary.synthesizer.model, FUSION_METADATA_BYTES),
          ok: summary.synthesizer.ok === true,
          contractOk: summary.synthesizer.contractOk === true,
          error: String(summary.synthesizer.error || "") || null,
          usage: presentationUsage(summary.synthesizer.usage),
          durationMs: finiteNonNegative(summary.synthesizer.durationMs),
        }
      : null,
    usage: presentationUsage(summary?.usage),
    missingProviders: Array.isArray(summary?.missingProviders)
      ? summary.missingProviders.slice(0, 3).map((provider: unknown) => truncateUtf8(provider, 64))
      : [],
    routing: presentationRouting(summary?.routing),
  };
}

export function createFusionTransportSummary(summary: any) {
  const presented = createFusionPresentationSummary(summary);
  const summaryPath = presented.runDir ? join(presented.runDir, "summary.json") : "";
  let summarySha256 = "";
  try {
    summarySha256 = createHash("sha256").update(readFileSync(summaryPath)).digest("hex");
  } catch {
    // Pre-run failures do not have a durable summary artifact.
  }
  const artifactBacked = Boolean(summarySha256);
  const transportError = presented.runDir && !artifactBacked
    ? "Full Fusion output unavailable: the run artifact could not be read safely."
    : "";
  return {
    kind: "fusion",
    mode: "plan",
    status: presented.status,
    runId: presented.runId,
    runDir: presented.runDir,
    bodyStorage: artifactBacked ? "artifact" : "inline",
    summaryPath: artifactBacked ? summaryPath : "",
    summarySha256,
    objective: truncateUtf8(presented.objective, FUSION_CONTEXT_OBJECTIVE_BYTES),
    error: truncateUtf8(
      [presented.error, transportError].filter(Boolean).join("; "),
      FUSION_METADATA_BYTES,
    ) || null,
  };
}

function artifactUnavailable(summary: any) {
  const message = "Full Fusion output unavailable: the run artifact could not be read safely.";
  return {
    ...summary,
    error: [summary?.error, message].filter(Boolean).join("; "),
  };
}

export function hydrateFusionPresentationSummary(summary: any) {
  if (summary?.bodyStorage !== "artifact") return createFusionPresentationSummary(summary);
  try {
    const runsRoot = realpathSync(getRunsDir());
    const runDir = realpathSync(String(summary.runDir || ""));
    const summaryPath = realpathSync(String(summary.summaryPath || ""));
    if (
      !runDir.startsWith(`${runsRoot}${sep}`) ||
      summaryPath !== join(runDir, "summary.json")
    ) {
      return artifactUnavailable(summary);
    }
    const storedBytes = readFileSync(summaryPath);
    const digest = createHash("sha256").update(storedBytes).digest("hex");
    if (digest !== String(summary.summarySha256 || "")) {
      return artifactUnavailable(summary);
    }
    const stored = JSON.parse(storedBytes.toString("utf8"));
    if (
      stored?.kind !== "fusion" ||
      String(stored.runId || "") !== String(summary.runId || "") ||
      realpathSync(String(stored.runDir || "")) !== runDir
    ) {
      return artifactUnavailable(summary);
    }
    return createFusionPresentationSummary(stored);
  } catch {
    return artifactUnavailable(summary);
  }
}

function formatFusionCost(usage: any) {
  const cost = finiteNonNegative(usage?.cost);
  return usage?.costKnown === false || cost === null
    ? "cost unknown"
    : `$${cost.toFixed(4)}`;
}

export function formatFusionContextLines(summary: any) {
  const models = summary?.models || {};
  const usage = summary?.usage || {};
  const lines = [
    `Fusion ${truncateUtf8(summary?.status, FUSION_METADATA_BYTES) || "UNKNOWN"} (${truncateUtf8(summary?.runId, FUSION_METADATA_BYTES) || "unknown run"})`,
    `Objective: ${truncateUtf8(summary?.objective, FUSION_CONTEXT_OBJECTIVE_BYTES) || "not recorded"}`,
    `Architect: ${truncateUtf8(models.architect, FUSION_METADATA_BYTES) || "n/a"}`,
    `Builder: ${truncateUtf8(models.builder, FUSION_METADATA_BYTES) || "n/a"}`,
    `Synthesizer: ${truncateUtf8(models.synthesizer, FUSION_METADATA_BYTES) || "n/a"}`,
    `Usage: ${finiteNonNegative(usage.input) || 0} input, ${finiteNonNegative(usage.output) || 0} output, ${finiteNonNegative(usage.turns) || 0} turns, ${formatFusionCost(usage)}`,
    `Artifacts: ${truncateUtf8(summary?.runDir, FUSION_PATH_BYTES) || "n/a"}`,
    "Full outputs are shown in the terminal and saved to artifacts; model context remains metadata-only.",
  ];
  if (summary?.error) lines.push(`Error: ${truncateUtf8(summary.error, FUSION_METADATA_BYTES)}`);
  if (summary?.error === "provider_unavailable") {
    if (summary.missingProviders?.length) {
      lines.push(`Provider unavailable in this Alloy session: ${summary.missingProviders.slice(0, 3).map((provider: unknown) => truncateUtf8(provider, 64)).join(", ")}`);
    }
    for (const route of Object.values(summary.routing || {}) as any[]) {
      if (route?.reason) lines.push(`Route reason: ${truncateUtf8(route.reason, FUSION_METADATA_BYTES)}`);
    }
  }
  return lines;
}

export function formatFusionPresentationLines(summary: any) {
  const lines = [
    `FUSION // ${summary?.status || "UNKNOWN"}`,
    summary?.runId ? `run: ${summary.runId}` : "",
    summary?.objective ? `prompt: ${summary.objective}` : "",
  ].filter(Boolean);
  if (summary?.error) lines.push(`× ${summary.error}`);
  const proposals = Array.isArray(summary?.proposals) ? summary.proposals : [];
  for (const role of ["architect", "builder"]) {
    const matches = proposals.filter((proposal: any) => proposal?.role === role);
    if (matches.length !== 1) continue;
    const proposal = matches[0];
    lines.push("", `${role.toUpperCase()} // ${proposal?.model || "unknown model"}`);
    lines.push(proposal?.ok === true ? "✓ done" : "× failed");
    if (proposal?.error) lines.push(`× ${proposal.error}`);
    lines.push(proposal?.text || "(no output)");
  }
  if (summary?.synthesizer || summary?.synthesis) {
    lines.push(
      "",
      `SYNTHESIZER // ${summary?.synthesizer?.model || summary?.models?.synthesizer || "unknown model"}`,
      summary?.synthesizer?.ok === true ? "✓ done" : "× failed",
      ...(summary?.synthesizer?.error ? [`× ${summary.synthesizer.error}`] : []),
      summary?.synthesis || "(no output)",
    );
  }
  lines.push("", `usage: ${finiteNonNegative(summary?.usage?.input) || 0} input · ${finiteNonNegative(summary?.usage?.output) || 0} output · ${finiteNonNegative(summary?.usage?.turns) || 0} turns · ${formatFusionCost(summary?.usage)}`);
  if (summary?.runDir) lines.push("", `artifacts: ${summary.runDir}`);
  return lines;
}

function clearPanel(ctx?: { ui?: ExtensionContext["ui"] }) {
  const ui = ctx?.ui || panelUi;
  try {
    ui?.setWidget?.("alloy-agents", undefined);
  } catch {
    // ignore
  }
}

function clearFusionPanel(ctx?: { ui?: ExtensionContext["ui"] }) {
  const ui = ctx?.ui || panelUi;
  clearPanel(ctx);
  try {
    ui?.setStatus?.("alloy-fusion", undefined);
  } catch {
    // ignore
  }
}

const FUSION_ROLES = ["architect", "builder", "synthesizer"] as const;

function formatFusionStatus(cwd: string) {
  const global = loadGlobalConfig();
  const effective = loadConfig(cwd);
  const globalModels = getFusionRoleModelDefaults(global);
  const models = resolveFusionRoleModels(effective);
  const efforts = resolveFusionRoleEfforts(effective);
  return [
    "Fusion role settings:",
    ...FUSION_ROLES.map((role) => {
      const configured = globalModels[role] || "not configured";
      const effort = efforts[role] || "model default";
      return `${role}: ${models[role]} | requested effort ${effort} | global/default ${configured}`;
    }),
    "",
    "Use /fusion setup to change global defaults.",
  ];
}

async function showFusionLines(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
) {
  if (ctx.hasUI) await ctx.ui.select(title, lines);
  else console.log(lines.join("\n"));
}

async function setupFusion(ctx: ExtensionContext) {
  if (!ctx.hasUI) {
    console.log("/fusion setup requires the interactive TUI.");
    return;
  }
  const global = loadGlobalConfig();
  const allowed = (global.providers?.allow || []).filter(Boolean);
  const defaults = getFusionRoleModelDefaults(global);
  const favorites = (global.providers?.favorites || []).filter(Boolean);
  const current: Record<string, string> = {
    architect: defaults.architect || "not configured",
    builder: defaults.builder || "not configured",
    synthesizer: defaults.synthesizer || "not configured",
  };
  const routes = ctx.modelRegistry
    .getAll()
    .map((model) => `${model.provider}/${model.id}`);
  const configuredRoutes = [
    ...Object.values(current),
    ...favorites,
    ...Object.values(global.roles || {}).map((role: any) => role?.model),
  ].filter(
    (route): route is string =>
      typeof route === "string" &&
      route.includes("/"),
  );
  const providerGroups = groupFusionModelRoutes(
    [...configuredRoutes, ...routes],
    allowed,
  );
  if (!providerGroups.length) {
    ctx.ui.notify("No allowed Fusion models are available.", "warning");
    return;
  }
  const models: Record<string, string> = {};
  const efforts: Record<string, string | null> = {};

  for (const role of FUSION_ROLES) {
    const providerLabel = await ctx.ui.select(
      `Fusion ${role} provider (current: ${current[role]})`,
      providerGroups.map((provider) => provider.label),
    );
    if (!providerLabel) {
      ctx.ui.notify("Fusion setup cancelled; no settings changed.", "info");
      return;
    }
    const provider = providerGroups.find(
      (candidate) => candidate.label === providerLabel,
    );
    if (!provider) {
      ctx.ui.notify("Fusion setup cancelled; no settings changed.", "info");
      return;
    }
    const model = await ctx.ui.select(
      `Fusion ${role} ${provider.label} model (current: ${current[role]})`,
      provider.models,
    );
    if (!model) {
      ctx.ui.notify("Fusion setup cancelled; no settings changed.", "info");
      return;
    }
    models[role] = `${provider.id}/${model}`;

    const effort = await ctx.ui.select(`Fusion ${role} effort`, [
      "default (model/provider default)",
      ...FUSION_EFFORT_LEVELS,
    ]);
    if (!effort) {
      ctx.ui.notify("Fusion setup cancelled; no settings changed.", "info");
      return;
    }
    efforts[role] = effort.startsWith("default") ? null : effort;
  }

  if (models.architect === models.builder) {
    ctx.ui.notify(
      "Architect and Builder must use distinct models; no settings changed.",
      "warning",
    );
    return;
  }

  const saved = saveGlobalFusionConfig({
    architectModel: models.architect,
    builderModel: models.builder,
    synthesizerModel: models.synthesizer,
    architectEffort: efforts.architect,
    builderEffort: efforts.builder,
    synthesizerEffort: efforts.synthesizer,
  });
  const savedModels = resolveFusionRoleModels(saved);
  const savedEfforts = resolveFusionRoleEfforts(saved);
  await showFusionLines(ctx, "Fusion setup saved", [
    "Global Fusion setup saved:",
    ...FUSION_ROLES.map(
      (role) =>
        `${role}: ${savedModels[role]} | requested effort ${savedEfforts[role] || "model default"}`,
    ),
    "",
    "Use /fusion status to inspect project overrides.",
  ]);
}

export function registerAuto(pi: ExtensionAPI) {
  pi.registerMessageRenderer?.("alloy-fusion", (message, { outputPad }, theme) => {
    const details = message.details as any;
    const lines = details?.kind === "fusion"
      ? formatFusionPresentationLines(hydrateFusionPresentationSummary(details))
      : [String(message.content || "")];
    const text = lines
      .map((line) =>
        /^(FUSION|ARCHITECT|BUILDER|SYNTHESIZER) \/\//.test(line)
          ? theme.fg("accent", line)
          : line.startsWith("× ")
            ? theme.fg("error", line)
            : line,
      )
      .join("\n");
    return new Text(text, outputPad, 1, (value) => theme.bg("customMessageBg", value));
  });

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
        const parentOpts = resolveParentChildSpawnOpts();
        const summary = await runAutoWorkflow({
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
      "Plan-only fusion: /fusion <objective|setup|status|help>",
    getArgumentCompletions: getFusionArgumentCompletions,
    handler: async (args, ctx) => {
      const request = (args || "").trim();
      if (!request) {
        ctx.ui.notify(
          "Usage: /fusion <objective|setup|status|help>",
          "warning",
        );
        return;
      }

      if (request.toLowerCase() === "help") {
        await showFusionLines(ctx, "Fusion help", [
          "/fusion <objective>  Run read-only Architect + Builder + Synthesizer",
          "/fusion setup        Select persistent role models and effort",
          "/fusion status       Show effective role settings",
        ]);
        return;
      }
      if (request.toLowerCase() === "status") {
        try {
          await showFusionLines(
            ctx,
            "Fusion status",
            formatFusionStatus(ctx.cwd),
          );
        } catch (err) {
          const message = String((err as Error).message || err);
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
          else console.error(message);
        }
        return;
      }
      if (request.toLowerCase() === "setup") {
        try {
          await setupFusion(ctx);
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "warning");
        }
        return;
      }

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Start fusion?",
          `Read-only Architect + Builder proposals, then attributed synthesis.\n\n${request.slice(0, 280)}`,
        );
        if (!ok) return;
      }

      panelUi = ctx.ui;
      ctx.ui.setWorkingMessage?.("Alloy fusion running…");
      try {
        const parentOpts = resolveParentChildSpawnOpts({ mode: "plan" });
        const summary = await runFusion({
          request,
          cwd: process.cwd(),
          modelRegistry: ctx.modelRegistry,
          ...parentOpts,
          loadCredentialLease: (models: string[]) =>
            resolveSessionCredentialLease(models, ctx.modelRegistry),
          onPanel: (panel: unknown) => paintPanel(panel, ctx),
          onProgress: (msg: string) => {
            try {
              ctx.ui.notify(msg, "info");
            } catch {
              // ignore
            }
          },
        });
        const context = createFusionPresentationSummary(summary);
        const presented = createFusionTransportSummary(summary);
        const lines = formatFusionContextLines(context);
        pi.sendMessage({
          customType: "alloy-fusion",
          content: lines.join("\n"),
          display: true,
          details: presented,
        });
      } catch (err) {
        const message = String((err as Error).message || err);
        ctx.ui.notify(message, "error");
        try {
          const presented = createFusionTransportSummary({
            kind: "fusion",
            status: "FAILED",
            objective: request,
            runId: "",
            runDir: "",
            proposals: [],
            synthesis: "",
            synthesizer: null,
            error: message,
          });
          pi.sendMessage({
            customType: "alloy-fusion",
            content: `Fusion failed: ${truncateUtf8(message, FUSION_METADATA_BYTES)}`,
            display: true,
            details: presented,
          });
        } catch {
          // The notification above is the last available reporting path.
        }
      } finally {
        ctx.ui.setWorkingMessage?.();
        clearFusionPanel(ctx);
      }
    },
  });

  pi.registerCommand("panel", {
    description: "Clear the Alloy agent panel widget",
    handler: async (_args, ctx) => {
      clearPanel(ctx);
      ctx.ui.setStatus("alloy-auto", undefined);
      ctx.ui.setStatus("alloy-fusion", undefined);
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const parentOpts = resolveParentChildSpawnOpts();
        const summary = await runAutoWorkflow({
          request: params.request,
          cwd: process.cwd(),
          useWorktree: params.useWorktree !== false,
          maxFixRounds: params.maxFixRounds,
          signal,
          modelRegistry: ctx.modelRegistry,
          ...parentOpts,
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
      "Run plan-only multi-model fusion: read-only Architect and Builder proposals followed by attributed synthesis.",
    promptSnippet: "Architect-Builder synthesis with provenance",
    parameters: Type.Object({
      request: Type.String(),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const parentOpts = resolveParentChildSpawnOpts({ mode: "plan" });
        const summary = await runFusion({
          request: params.request,
          cwd: process.cwd(),
          signal,
          modelRegistry: ctx.modelRegistry,
          ...parentOpts,
          loadCredentialLease: (models: string[]) =>
            resolveSessionCredentialLease(models, ctx.modelRegistry),
          onPanel: (panel: unknown) => paintPanel(panel, ctx),
        });
        const context = createFusionPresentationSummary(summary);
        const presented = createFusionTransportSummary(summary);
        return {
          content: [
            {
              type: "text",
              text: formatFusionLines(context).join("\n"),
            },
          ],
          details: presented,
        };
      } catch (err) {
        const message = truncateUtf8((err as Error).message || String(err), FUSION_METADATA_BYTES);
        return {
          content: [
            { type: "text", text: `Fusion failed: ${message}` },
          ],
          details: { error: true, message },
        };
      } finally {
        clearFusionPanel(ctx);
      }
    },
  });
}
