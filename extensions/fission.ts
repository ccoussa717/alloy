import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  loadConfig,
  loadGlobalConfig,
  saveGlobalFissionConfig,
} = require(join(root, "lib", "config.mjs"));
const {
  parseFissionRequest,
  runFission,
  FISSION_EFFORT_LEVELS,
  FISSION_ROLES,
  formatFissionRoleLabel,
  fissionConfigHint,
} = require(join(root, "lib", "fission.mjs"));
const { groupFusionModelRoutes: groupModelRoutes } = require(
  join(root, "lib", "fusion.mjs"),
);
const { isTrustedSessionModelRoute } = require(
  join(root, "lib", "credential-broker.mjs"),
);
const { createPanelState, renderPanelLines, renderPanelThemed, upsertAgent } = require(
  join(root, "lib", "agent-panel.mjs"),
);
const { resolveParentChildSpawnOpts } = require(join(root, "lib", "parent-policy.mjs"));

type Dependencies = {
  loadConfig?: typeof loadConfig;
  loadGlobalConfig?: typeof loadGlobalConfig;
  saveGlobalFissionConfig?: typeof saveGlobalFissionConfig;
  isTrustedModelRoute?: typeof isTrustedSessionModelRoute;
  runFission?: typeof runFission;
  resolveParentChildSpawnOpts?: typeof resolveParentChildSpawnOpts;
};

const FISSION_ARGUMENTS = [
  { value: "setup", label: "setup", description: "Configure reviewers, judge, effort, severity" },
  { value: "status", label: "status", description: "Show effective Fission settings" },
  { value: "help", label: "help", description: "Show Fission usage" },
];

const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;

const FAMILY_BY_PROVIDER: Record<string, string> = {
  anthropic: "claude",
  openai: "gpt",
  "openai-codex": "gpt",
  xai: "grok",
  google: "gemini",
  gemini: "gemini",
};

function getFissionArgumentCompletions(prefix = "") {
  const raw = String(prefix).trimStart().toLowerCase();
  if (raw.includes(" ")) return null;
  const matches = FISSION_ARGUMENTS.filter((item) => item.value.startsWith(raw));
  return matches.length ? matches : null;
}

function formatAgentCount(reviewers: number) {
  return `${reviewers} ${reviewers === 1 ? "reviewer" : "reviewers"} + 1 judge = ${reviewers + 1} agents`;
}

function formatEffort(effort: string | null | undefined) {
  return effort ? effort : "model default";
}

function defaultFamilyForRoute(route: string): string {
  const provider = route.split("/", 1)[0] || "unknown";
  return FAMILY_BY_PROVIDER[provider] || provider;
}

function formatFissionHelp() {
  return [
    "/fission <request>              Run with the configured default reviewers",
    "/fission <reviewers> <request>  Override the reviewer count for one run (≤ max)",
    "/fission setup                  Configure models, counts, effort, severity",
    "/fission status                 Show effective models, specialties, limits",
    "/fission help                   Show this help",
    "",
    "Workflow: N specialist reviewers (parallel) → 1 independent judge.",
    "Specialties are fixed by N (correctness, security, architecture, tests, performance).",
    "Models must be distinct exact routes — no fallback. Run /fission setup first.",
    "Configured count means reviewers + 1 judge. Effort uses the same levels as /fusion.",
  ];
}

function formatFissionStatus(config: any) {
  const fission = config.fission || {};
  const reviewers = Number(fission.defaultReviewers) || 0;
  const maxReviewers = Number(fission.maxReviewers) || 0;
  const models = Array.isArray(fission.models)
    ? fission.models.slice(0, maxReviewers)
    : [];
  const efforts = Array.isArray(fission.reviewerEfforts) ? fission.reviewerEfforts : [];
  const defaultRoles = FISSION_ROLES[reviewers] || [];
  const maxRoles = FISSION_ROLES[maxReviewers] || [];
  const lines = [
    "Fission settings:",
    `Default run: ${formatAgentCount(reviewers)}`,
    `Maximum reviewers per run: ${maxReviewers}`,
    `Concurrency: ${Number(config.orchestration?.maxConcurrency) || 0}`,
    `Orchestration: ${config.orchestration?.enabled ? "enabled" : "disabled"}`,
    `Blocking severity: ${fission.blockingSeverity || "not configured"}`,
    `Judge effort: ${formatEffort(fission.judgeEffort)}`,
    "",
    "Reviewer models (slot → specialty at max N → route | effort):",
  ];
  if (!models.length) {
    lines.push("None configured — run /fission setup.");
  } else {
    for (let i = 0; i < models.length; i++) {
      const specialty =
        formatFissionRoleLabel(maxRoles[i] || defaultRoles[i] || "reviewer");
      lines.push(
        `  R${i + 1} [${specialty}]: ${models[i]} | effort ${formatEffort(efforts[i])}`,
      );
    }
  }
  lines.push(`Judge: ${fission.judgeModel || "not configured"}`);
  if (fission.modelFamilies && Object.keys(fission.modelFamilies).length) {
    lines.push(
      "",
      "Families:",
      ...Object.entries(fission.modelFamilies).map(
        ([route, label]) => `  ${route} → ${label}`,
      ),
    );
  }
  lines.push("", "Use /fission setup to change global defaults.");
  return lines;
}

async function showFissionLines(
  ctx: ExtensionContext,
  title: string,
  lines: string[],
) {
  if (ctx.hasUI) await ctx.ui.select(title, lines);
  else console.log(lines.join("\n"));
}

function cancelSetup(ctx: ExtensionContext) {
  ctx.ui.notify("Fission setup cancelled; no settings changed.", "info");
}

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
    ...(result.error ? [`Error: ${result.error}`] : []),
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

function parseCountLabel(label: string): number {
  return Number.parseInt(String(label), 10);
}

async function pickEffort(
  ctx: ExtensionContext,
  title: string,
  current: string | null | undefined,
): Promise<string | null | undefined> {
  const currentLabel = formatEffort(current);
  const choice = await ctx.ui.select(`${title} (current: ${currentLabel})`, [
    "default (model/provider default)",
    ...FISSION_EFFORT_LEVELS,
  ]);
  if (!choice) return undefined; // cancelled
  return choice.startsWith("default") ? null : choice;
}

export function registerFission(pi: ExtensionAPI, dependencies: Dependencies = {}) {
  const loadEffectiveConfig = dependencies.loadConfig || loadConfig;
  const loadOperatorConfig = dependencies.loadGlobalConfig || loadGlobalConfig;
  const saveFissionConfig =
    dependencies.saveGlobalFissionConfig || saveGlobalFissionConfig;
  const isTrustedModelRoute =
    dependencies.isTrustedModelRoute || isTrustedSessionModelRoute;
  const executeFission = dependencies.runFission || runFission;
  const resolveParentPolicy =
    dependencies.resolveParentChildSpawnOpts || resolveParentChildSpawnOpts;

  const invoke = async ({
    request,
    reviewers,
    ctx,
    signal,
  }: {
    request: string;
    reviewers?: number;
    ctx: ExtensionContext;
    signal?: AbortSignal;
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
      timeoutMs: 300_000,
      ...(signal ? { signal } : {}),
      ...parentPolicy,
    };
    const result = await executeFission(input);
    paintPanel(result, ctx);
    return result;
  };

  const setup = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      console.log("/fission setup requires the interactive TUI.");
      return;
    }
    const global = loadOperatorConfig();
    const allowed = (global.providers?.allow || []).filter(Boolean);
    const current = global.fission || {};
    const currentEfforts = Array.isArray(current.reviewerEfforts)
      ? current.reviewerEfforts
      : [];
    const routes = ctx.modelRegistry
      .getAll()
      .map((model: any) => `${model.provider}/${model.id}`)
      .filter((route: string) => isTrustedModelRoute(route, ctx.modelRegistry));
    const groups = groupModelRoutes(routes, allowed);
    const distinctRouteCount = new Set(
      groups.flatMap((group: any) =>
        group.models.map((model: string) => `${group.id}/${model}`),
      ),
    ).size;
    if (!groups.length || distinctRouteCount < 1) {
      ctx.ui.notify("No allowed Fission models are available.", "warning");
      return;
    }

    // 1) Default reviewer count
    const defaultCeiling = Math.min(5, distinctRouteCount);
    const defaultLabel = await ctx.ui.select(
      `Default reviewers for /fission <request> (current: ${current.defaultReviewers ?? "—"})`,
      Array.from({ length: defaultCeiling }, (_, index) => {
        const n = index + 1;
        return `Default ${n}: ${formatAgentCount(n)}`;
      }),
    );
    if (!defaultLabel) {
      cancelSetup(ctx);
      return;
    }
    const defaultReviewers = parseCountLabel(defaultLabel.replace(/^Default\s+/i, ""));
    if (!Number.isInteger(defaultReviewers) || defaultReviewers < 1) {
      cancelSetup(ctx);
      return;
    }

    // 2) Max reviewers (≥ default)
    const maxOptions = Array.from(
      { length: defaultCeiling - defaultReviewers + 1 },
      (_, index) => {
        const n = defaultReviewers + index;
        return `Max ${n}: allows /fission ${n} … (${formatAgentCount(n)})`;
      },
    );
    const maxLabel = await ctx.ui.select(
      `Maximum reviewers (current: ${current.maxReviewers ?? "—"})`,
      maxOptions,
    );
    if (!maxLabel) {
      cancelSetup(ctx);
      return;
    }
    const maxReviewers = parseCountLabel(maxLabel.replace(/^Max\s+/i, ""));
    if (
      !Number.isInteger(maxReviewers) ||
      maxReviewers < defaultReviewers ||
      maxReviewers > 5
    ) {
      cancelSetup(ctx);
      return;
    }
    if (maxReviewers > distinctRouteCount) {
      ctx.ui.notify(
        `Only ${distinctRouteCount} distinct allowed model routes are available; no settings changed.`,
        "warning",
      );
      return;
    }

    const maxRoles = FISSION_ROLES[maxReviewers] || [];
    const selectedModels: string[] = [];
    const reviewerEfforts: (string | null)[] = [];

    // 3) One distinct model (+ effort) per max reviewer slot
    for (let index = 0; index < maxReviewers; index += 1) {
      const specialty = formatFissionRoleLabel(maxRoles[index]);
      const availableGroups = groups
        .map((group: any) => ({
          ...group,
          models: group.models.filter(
            (model: string) => !selectedModels.includes(`${group.id}/${model}`),
          ),
        }))
        .filter((group: any) => group.models.length);
      if (!availableGroups.length) {
        ctx.ui.notify(
          "Not enough distinct model routes for the selected max reviewers.",
          "warning",
        );
        return;
      }
      const providerLabel = await ctx.ui.select(
        `Reviewer ${index + 1}/${maxReviewers} — ${specialty} — provider`,
        availableGroups.map((group: any) => group.label),
      );
      if (!providerLabel) {
        cancelSetup(ctx);
        return;
      }
      const provider = availableGroups.find(
        (group: any) => group.label === providerLabel,
      );
      if (!provider) {
        cancelSetup(ctx);
        return;
      }
      const model = await ctx.ui.select(
        `Reviewer ${index + 1}/${maxReviewers} — ${specialty} — ${provider.label} model`,
        provider.models,
      );
      if (!model) {
        cancelSetup(ctx);
        return;
      }
      selectedModels.push(`${provider.id}/${model}`);

      const effort = await pickEffort(
        ctx,
        `Reviewer ${index + 1} effort (${specialty})`,
        currentEfforts[index] ?? null,
      );
      if (effort === undefined) {
        cancelSetup(ctx);
        return;
      }
      reviewerEfforts.push(effort);
    }

    // 4) Judge
    const judgeProviderLabel = await ctx.ui.select(
      "Judge provider (independent adjudication)",
      groups.map((group: any) => group.label),
    );
    if (!judgeProviderLabel) {
      cancelSetup(ctx);
      return;
    }
    const judgeProvider = groups.find(
      (group: any) => group.label === judgeProviderLabel,
    );
    if (!judgeProvider) {
      cancelSetup(ctx);
      return;
    }
    const judgeModelId = await ctx.ui.select(
      `Judge ${judgeProvider.label} model`,
      judgeProvider.models,
    );
    if (!judgeModelId) {
      cancelSetup(ctx);
      return;
    }
    const judgeRoute = `${judgeProvider.id}/${judgeModelId}`;
    const judgeEffort = await pickEffort(
      ctx,
      "Judge effort",
      current.judgeEffort ?? null,
    );
    if (judgeEffort === undefined) {
      cancelSetup(ctx);
      return;
    }

    // 5) Blocking severity
    const severityChoice = await ctx.ui.select(
      `Blocking severity (current: ${current.blockingSeverity || "medium"})`,
      SEVERITY_LEVELS.map((level) => level),
    );
    if (!severityChoice) {
      cancelSetup(ctx);
      return;
    }

    const selectedRoutes = new Set([...selectedModels, judgeRoute]);
    const modelFamilies: Record<string, string> = {};
    for (const route of selectedRoutes) {
      const prior = current.modelFamilies?.[route];
      modelFamilies[route] =
        typeof prior === "string" && prior.trim()
          ? prior.trim()
          : defaultFamilyForRoute(route);
    }

    const saved = saveFissionConfig({
      models: selectedModels,
      judgeModel: judgeRoute,
      modelFamilies,
      defaultReviewers,
      maxReviewers,
      blockingSeverity: severityChoice,
      reviewerEfforts,
      judgeEffort,
    });
    const effective = loadEffectiveConfig(ctx.cwd);
    const restrictions = [];
    if (saved.orchestration?.enabled && !effective.orchestration?.enabled) {
      restrictions.push("Project policy disables orchestration for this repository.");
    }
    if (
      effective.fission?.defaultReviewers !== defaultReviewers ||
      effective.fission?.maxReviewers !== maxReviewers
    ) {
      restrictions.push(
        `Project policy lowers the effective reviewer limits to ${effective.fission?.defaultReviewers}/${effective.fission?.maxReviewers} default/maximum.`,
      );
    }
    await showFissionLines(ctx, "Fission setup saved", [
      "Global Fission setup saved.",
      "",
      ...formatFissionStatus(effective),
      ...restrictions,
    ]);
  };

  pi.registerCommand("fission", {
    description:
      "Adversarial review: /fission <request|setup|status|help>",
    getArgumentCompletions: getFissionArgumentCompletions,
    handler: async (args, ctx) => {
      const request = (args || "").trim();
      if (!request || request.toLowerCase() === "help") {
        await showFissionLines(ctx, "Fission help", formatFissionHelp());
        return;
      }
      if (request.toLowerCase() === "status") {
        try {
          await showFissionLines(
            ctx,
            "Fission status",
            formatFissionStatus(loadEffectiveConfig(ctx.cwd)),
          );
        } catch (error) {
          ctx.ui.notify(String((error as Error).message || error), "warning");
        }
        return;
      }
      if (request.toLowerCase() === "setup") {
        try {
          await setup(ctx);
        } catch (error) {
          ctx.ui.notify(String((error as Error).message || error), "warning");
        }
        return;
      }
      try {
        const result = await invoke({
          request,
          ctx,
        });
        const lines = formatFissionLines(result);
        const hint = result.error ? fissionConfigHint(result.error) : null;
        if (hint) lines.push("", hint);
        await ctx.ui.select(`Fission ${result.status}`, lines);
      } catch (error) {
        const message = String((error as Error).message || error);
        const hint = fissionConfigHint(message);
        ctx.ui.notify(hint ? `${message}. ${hint}` : message, "warning");
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
      });
      const lines = formatFissionLines(result);
      const hint = result.error ? fissionConfigHint(result.error) : null;
      if (hint) lines.push("", hint);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });
}
