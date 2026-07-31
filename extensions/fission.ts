import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadConfig } = require(join(root, "lib", "config.mjs"));
const { parseFissionRequest, runFission } = require(join(root, "lib", "fission.mjs"));
const { createPanelState, renderPanelLines, renderPanelThemed, upsertAgent } = require(
  join(root, "lib", "agent-panel.mjs"),
);
const { resolveParentChildSpawnOpts } = require(join(root, "lib", "parent-policy.mjs"));

type Dependencies = {
  loadConfig?: typeof loadConfig;
  runFission?: typeof runFission;
  resolveParentChildSpawnOpts?: typeof resolveParentChildSpawnOpts;
};

function findingLine(finding: any) {
  const severity = finding?.adjudicatedSeverity ? `[${finding.adjudicatedSeverity}] ` : "";
  return `${severity}${finding?.claim || JSON.stringify(finding)}`;
}

export function formatFissionLines(result: any) {
  const diversity = result.modelDiversity || {};
  const usage = result.usage || {};
  const lines = [
    `Fission ${result.verdict || "NO VERDICT"} / ${result.status}`,
    result.message || "review evidence is incomplete.",
    "",
    "Validated findings:",
    ...(result.validatedFindings?.length
      ? result.validatedFindings.map(findingLine)
      : ["None."]),
    "",
    "Rejected findings:",
    ...(result.rejectedFindings?.length
      ? result.rejectedFindings.map(findingLine)
      : ["None."]),
    "",
    "Unresolved findings:",
    ...(result.unresolvedFindings?.length
      ? result.unresolvedFindings.map(findingLine)
      : ["None."]),
    "",
    `Models: ${Number(diversity.exactModelCount) || 0} exact, ${Number(diversity.providerCount) || 0} providers, ${Number(diversity.familyCount) || 0} families`,
    `Usage: ${Number(usage.input) || 0} input, ${Number(usage.output) || 0} output, ${Number(usage.turns) || 0} turns, ${usage.costKnown === false ? "unknown cost" : `$${(Number(usage.cost) || 0).toFixed(4)}`}`,
  ];
  if (result.runDir != null) lines.push(`Artifacts: ${result.runDir}`);
  return lines;
}

function paintPanel(result: any, ctx: { ui?: ExtensionContext["ui"] }) {
  const ui = ctx?.ui;
  if (!ui?.setWidget) return;
  const panel = createPanelState({ title: "ALLOY FISSION", runId: result.runId });
  panel.phase = result.status;
  for (const [index, reviewer] of (result.reviewers || []).entries()) {
    upsertAgent(panel, {
      role: "reviewer",
      index: index + 1,
      status: reviewer.status === "ok" ? "ok" : "fail",
      model: reviewer.actualModel || reviewer.requestedModel,
      usage: reviewer.usage,
      detail: reviewer.error || reviewer.role || "",
    });
  }
  if (result.judge) {
    upsertAgent(panel, {
      role: "judge",
      status: result.judge.status === "ok" ? "ok" : "fail",
      model: result.judge.actualModel || result.judge.requestedModel,
      usage: result.judge.usage,
      detail: result.judge.error || "",
    });
  }
  const theme = (ui as any).theme;
  const lines = theme ? renderPanelThemed(panel, theme) : renderPanelLines(panel);
  ui.setWidget("alloy-agents", lines, { placement: "belowEditor" });
  ui.setStatus?.("alloy-fission", `fission:${result.status}`);
}

export function registerFission(pi: ExtensionAPI, dependencies: Dependencies = {}) {
  const loadEffectiveConfig = dependencies.loadConfig || loadConfig;
  const executeFission = dependencies.runFission || runFission;
  const resolveParentPolicy =
    dependencies.resolveParentChildSpawnOpts || resolveParentChildSpawnOpts;

  const invoke = async ({
    request,
    reviewers,
    ctx,
    signal,
    includeSignal,
  }: {
    request: string;
    reviewers?: number;
    ctx: ExtensionContext;
    signal?: AbortSignal;
    includeSignal: boolean;
  }) => {
    const effectiveConfig = loadEffectiveConfig(ctx.cwd);
    const { defaultReviewers, maxReviewers } = effectiveConfig.fission;
    const parsed = parseFissionRequest(
      reviewers === undefined ? request : `${reviewers} ${request}`,
      { defaultReviewers, maxReviewers },
    );
    const parentPolicy = resolveParentPolicy({ mode: "review" });
    const input = {
      request: parsed.request,
      reviewers: parsed.reviewers,
      defaultReviewers,
      maxReviewers,
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      ...(includeSignal ? { signal } : {}),
      timeoutMs: 300_000,
      ...parentPolicy,
    };
    const result = await executeFission(input);
    paintPanel(result, ctx);
    return result;
  };

  pi.registerCommand("fission", {
    description: "Run bounded adversarial review in a trusted repository",
    handler: async (args, ctx) => {
      try {
        const result = await invoke({
          request: args || "",
          ctx,
          includeSignal: false,
        });
        await ctx.ui.select(`Fission ${result.status}`, formatFissionLines(result));
      } catch (error) {
        ctx.ui.notify(String((error as Error).message || error), "warning");
      }
    },
  });

  pi.registerTool({
    name: "alloy_fission",
    label: "Alloy Fission",
    description: "Run bounded multi-model adversarial review with independent adjudication.",
    promptSnippet: "Adversarial review with independent judge",
    parameters: Type.Object({
      request: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
      reviewers: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await invoke({
        request: params.request,
        reviewers: params.reviewers,
        ctx,
        signal,
        includeSignal: true,
      });
      return {
        content: [{ type: "text", text: formatFissionLines(result).join("\n") }],
        details: result,
      };
    },
  });
}
