/**
 * Free-form multi-agent commands:
 *   /agent <name> [profile=…] [model=…] [bg] <task>
 *   /agents [view <id>]
 *   /profiles
 *
 * Multi-model via profiles in ~/.pi/alloy/config.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  spawnAgent,
  listAgents,
  getAgent,
  getAgentTranscript,
  getAgentSpentCost,
  getRunningAgentCount,
  setAgentPanelPainter,
  getAgentsPanelLines,
  clearAgentsPanel,
} = require(join(root, "lib", "agent-registry.mjs"));
const {
  listProfiles,
  resolveProfile,
} = require(join(root, "lib", "agent-profiles.mjs"));
const { prepareAgentLaunch } = require(
  join(root, "lib", "agent-orchestration.mjs"),
);
const { resolveParentChildSpawnOpts } = require(
  join(root, "lib", "parent-policy.mjs"),
);
const { renderPanelThemed, renderPanelLines } = require(
  join(root, "lib", "agent-panel.mjs"),
);

let panelUi: ExtensionContext["ui"] | null = null;

export async function launchFreeAgent(
  params: {
    name: string;
    task: string;
    background?: boolean;
    profile?: string;
    model?: string;
    tools?: string[];
  },
  modelRegistry: unknown,
  signal?: AbortSignal,
  onPrepared?: (launch: any) => void,
  dependencies: {
    prepareAgentLaunch?: typeof prepareAgentLaunch;
    getRunningAgentCount?: typeof getRunningAgentCount;
    getAgentSpentCost?: typeof getAgentSpentCost;
    resolveParentChildSpawnOpts?: typeof resolveParentChildSpawnOpts;
    spawnAgent?: typeof spawnAgent;
  } = {},
) {
  const prepare = dependencies.prepareAgentLaunch || prepareAgentLaunch;
  const countRunning = dependencies.getRunningAgentCount || getRunningAgentCount;
  const spentCost = dependencies.getAgentSpentCost || getAgentSpentCost;
  const parentSpawnOpts =
    dependencies.resolveParentChildSpawnOpts || resolveParentChildSpawnOpts;
  const spawn = dependencies.spawnAgent || spawnAgent;
  const cwd = process.cwd();
  const launch = await prepare({
    task: params.task,
    profile: params.profile,
    model: params.model,
    tools: params.tools,
    cwd,
    modelRegistry,
    activeChildren: countRunning(cwd),
    spentCostUsd: spentCost(cwd),
  });
  if (!launch.ok) {
    throw new Error(`Agent routing failed: ${launch.decision.reason}`);
  }
  onPrepared?.(launch);
  const parentOpts = parentSpawnOpts();
  return spawn({
    name: params.name,
    task: params.task,
    model: launch.spec.model,
    profile: launch.spec.profile,
    tools: launch.spec.tools,
    systemPrompt: launch.spec.systemPrompt,
    cwd,
    background: Boolean(params.background),
    signal,
    routeDecision: launch.decision,
    credentialBroker: launch.credential.mode,
    brokerRuntimeCredential: launch.credential.runtimeCredential,
    maxConcurrency: launch.maxConcurrency,
    budgetUsd: launch.budgetUsd,
    budgetLimitUsd: launch.budgetLimitUsd,
    ...parentOpts,
  });
}

function paintPanel(panel: unknown) {
  const ui = panelUi;
  if (!ui?.setWidget) return;
  try {
    const theme = (ui as { theme?: unknown }).theme;
    const lines = theme
      ? renderPanelThemed(panel, theme)
      : renderPanelLines(panel);
    ui.setWidget("alloy-agents", lines, { placement: "belowEditor" });
    ui.setStatus?.(
      "alloy-agents",
      (ui as { theme?: { fg: (c: string, t: string) => string } }).theme?.fg
        ? (ui as { theme: { fg: (c: string, t: string) => string } }).theme.fg(
            "accent",
            "agents",
          )
        : "agents",
    );
  } catch {
    // ignore
  }
}

/**
 * Parse: /agent [bg] <name> [profile=x|model=y|tools=a,b]* <task...>
 */
export function parseAgentCommand(args: string) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  let background = false;
  if (tokens[0] === "bg" || tokens[0] === "background") {
    background = true;
    tokens.shift();
  }

  if (!tokens.length) return null;
  const name = tokens.shift()!;

  let profile: string | undefined;
  let model: string | undefined;
  const toolParts: string[] = [];

  while (tokens.length) {
    const t = tokens[0];
    if (t.startsWith("profile=") || t.startsWith("p=")) {
      profile = t.split("=").slice(1).join("=");
      tokens.shift();
      continue;
    }
    if (t.startsWith("model=") || t.startsWith("m=")) {
      model = t.split("=").slice(1).join("=");
      tokens.shift();
      continue;
    }
    if (t.startsWith("tools=") || t.startsWith("t=")) {
      toolParts.push(...t.split("=").slice(1).join("=").split(",").filter(Boolean));
      tokens.shift();
      continue;
    }
    // bare profile name if known
    if (!profile && !t.includes("=") && resolveProfile(t, process.cwd())) {
      // only consume if next tokens still leave a task — ambiguous; require profile=
      break;
    }
    break;
  }

  // Support: /agent name use model: task  OR  /agent name @profile task
  if (tokens[0] === "use" && tokens[1]) {
    tokens.shift();
    const m = tokens.shift()!;
    if (m.endsWith(":")) {
      model = m.slice(0, -1);
    } else if (tokens[0] === ":" || tokens[0]?.startsWith(":")) {
      model = m;
      if (tokens[0] === ":") tokens.shift();
      else tokens[0] = tokens[0].replace(/^:/, "");
    } else {
      model = m.replace(/:$/, "");
    }
  }
  if (tokens[0]?.startsWith("@")) {
    profile = tokens.shift()!.slice(1);
  }

  const task = tokens.join(" ").trim();
  if (!task) return { error: "missing task", name, background, profile, model };

  return {
    name,
    task,
    background,
    profile,
    model,
    tools: toolParts.length ? toolParts : undefined,
  };
}

export function registerAgents(pi: ExtensionAPI) {
  setAgentPanelPainter(paintPanel);

  pi.registerCommand("agent", {
    description:
      "Spawn agent: /agent [bg] <name> [profile=research|code|review] [model=provider/id] <task>",
    handler: async (args, ctx) => {
      panelUi = ctx.ui;
      const parsed = parseAgentCommand(args || "");
      if (!parsed || "error" in parsed && parsed.error === "missing task" && !parsed.task) {
        const profiles = listProfiles(process.cwd())
          .map(
            (p: { name: string; model: string; label: string }) =>
              `  ${p.name.padEnd(12)} ${String(p.model).padEnd(28)} ${p.label}`,
          )
          .join("\n");
        ctx.ui.notify(
          [
            "Usage:",
            "  /agent <name> <task>",
            "  /agent <name> profile=research <task>",
            "  /agent <name> model=xai/grok-3 <task>",
            "  /agent bg <name> profile=code <task>   # background",
            "  /agent <name> use xai/grok-3: <task>",
            "",
            "Profiles:",
            profiles,
            "",
            "List/view: /agents   /agents view <id|name>",
          ].join("\n"),
          "info",
        );
        return;
      }
      if ("error" in parsed && parsed.error) {
        ctx.ui.notify(`Usage error: ${parsed.error}. /agent for help.`, "warning");
        return;
      }

      const p = parsed as {
        name: string;
        task: string;
        background: boolean;
        profile?: string;
        model?: string;
        tools?: string[];
      };

      ctx.ui.setWorkingMessage?.(
        p.background ? undefined : `Agent ${p.name} running…`,
      );

      try {
        const result = await launchFreeAgent(
          p,
          ctx.modelRegistry,
          undefined,
          (launch) => {
            ctx.ui.notify(
              `Starting agent "${p.name}" (${launch.decision.role}) model=${launch.spec.model || "default"}${launch.decision.fallbackUsed ? " [fallback]" : ""}${p.background ? " [bg]" : ""}…`,
              "info",
            );
          },
        );

        if (p.background) {
          ctx.ui.notify(
            `Background agent started: ${result.record.id} (${result.record.name})\n/agents view ${result.record.id}`,
            "info",
          );
          return;
        }

        const rec = result.record;
        const lines = [
          `id: ${rec.id}`,
          `name: ${rec.name}`,
          `status: ${rec.status}`,
          `model: ${rec.model || "default"}`,
          `profile: ${rec.profile}`,
          `route: ${rec.routing?.reason || "legacy"}${rec.routing?.fallbackUsed ? " (fallback)" : ""}`,
          `usage: turns=${rec.usage?.turns || 0} cost=$${(rec.usage?.cost || 0).toFixed(4)}`,
          "",
          "--- output ---",
          ...String(result.full?.text || rec.error || "(empty)")
            .split("\n")
            .slice(0, 80),
          "",
          `Full: /agents view ${rec.id}`,
        ];
        if (ctx.hasUI) await ctx.ui.select(`Agent ${rec.name}`, lines);
        else console.log(lines.join("\n"));
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      } finally {
        ctx.ui.setWorkingMessage?.();
      }
    },
  });

  pi.registerCommand("agents", {
    description: "List agents or view one: /agents [view <id|name>] [panel]",
    handler: async (args, ctx) => {
      panelUi = ctx.ui;
      const raw = (args || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);

      if (parts[0] === "panel") {
        const lines = getAgentsPanelLines();
        if (ctx.hasUI) await ctx.ui.select("Agent panel", lines);
        else console.log(lines.join("\n"));
        return;
      }

      if (parts[0] === "clear") {
        clearAgentsPanel();
        ctx.ui.setWidget?.("alloy-agents", undefined);
        ctx.ui.notify("Agent panel cleared.", "info");
        return;
      }

      if (parts[0] === "view" || parts[0] === "show" || parts[0] === "open") {
        const id = parts.slice(1).join(" ").trim();
        if (!id) {
          ctx.ui.notify("Usage: /agents view <id|name>", "warning");
          return;
        }
        await showAgent(id, ctx);
        return;
      }

      // bare id if looks like one
      if (parts.length === 1 && parts[0].includes("-")) {
        const maybe = getAgent(parts[0], process.cwd());
        if (maybe) {
          await showAgent(parts[0], ctx);
          return;
        }
      }

      const list = listAgents(process.cwd(), { limit: 30 });
      if (!list.length) {
        ctx.ui.notify("No agents yet. Spawn with /agent <name> <task>", "info");
        return;
      }
      const items = list.map(
        (a: {
          id: string;
          name: string;
          status: string;
          model?: string;
          task?: string;
        }) => {
          const icon =
            a.status === "running" ? "◐" : a.status === "ok" ? "✓" : "✗";
          const task = (a.task || "").slice(0, 40);
          return `${icon} ${a.id}  ${a.name}  ${a.model || "default"}  ${task}`;
        },
      );
      items.push("---");
      items.push("Select a row to view, or: /agents view <id>");
      const picked = await ctx.ui.select(`Agents (${list.length})`, items);
      if (picked && !picked.startsWith("---") && !picked.startsWith("Select")) {
        const id = picked.replace(/^[◐✓✗]\s+/, "").split(/\s+/)[0];
        await showAgent(id, ctx);
      }
    },
  });

  pi.registerCommand("profiles", {
    description: "List multi-model agent profiles",
    handler: async (_args, ctx) => {
      const rows = listProfiles(process.cwd());
      const lines = [
        "Configure in ~/.pi/alloy/config.json under \"profiles\".",
        "",
        ...rows.map(
          (p: { name: string; model: string; label: string; tools: string }) =>
            `${p.name.padEnd(12)} ${String(p.model).padEnd(32)} ${p.label}`,
        ),
        "",
        "Use: /agent mybot profile=research Investigate auth",
        "     /agent mybot model=anthropic/claude-opus-4-6 Review PR logic",
      ];
      if (ctx.hasUI) await ctx.ui.select("Agent profiles", lines);
      else console.log(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "alloy_task",
    label: "Alloy Task (sub-agent)",
    description:
      "Spawn an isolated Alloy sub-agent. Alloy routes research, planning, implementation, review, and general tasks through configured eligible models.",
    promptSnippet: "Route and spawn an isolated sub-agent",
    promptGuidelines: [
      "Usually omit model/profile and let Alloy route from the task.",
      "A requested profile/model must be eligible in operator orchestration policy.",
      "After completion, summarize the sub-agent output for the user.",
      "For long work the user can /agents view <id>.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short agent name" }),
      task: Type.String({ description: "Task for the sub-agent" }),
      profile: Type.Optional(
        Type.String({
          description: "Profile: research | code | review | plan | default",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "provider/model override, e.g. xai/grok-3",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional tool allowlist",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({ description: "If true, return immediately" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      panelUi = panelUi; // may be null in tool-only path
      try {
        const result = await launchFreeAgent(
          params,
          ctx.modelRegistry,
          signal,
        );
        if (params.background) {
          return {
            content: [
              {
                type: "text",
                text: `Background agent ${result.record.id} (${result.record.name}) started. Model=${result.record.model || "default"}. View: /agents view ${result.record.id}`,
              },
            ],
            details: result.record,
          };
        }
        const rec = result.record;
        return {
          content: [
            {
              type: "text",
              text: [
                `Agent ${rec.name} [${rec.status}] id=${rec.id}`,
                `model=${rec.model || "default"} profile=${rec.profile}`,
                `route=${rec.routing?.reason || "legacy"}${rec.routing?.fallbackUsed ? " fallback=yes" : ""}`,
                "",
                result.full?.text || rec.error || "(empty)",
              ].join("\n"),
            },
          ],
          details: rec,
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `alloy_task failed: ${(err as Error).message || err}` },
          ],
          details: { error: true },
        };
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    panelUi = ctx.ui;
  });
}

async function showAgent(
  id: string,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      notify: (m: string, t?: string) => void;
    };
    hasUI?: boolean;
  },
) {
  const t = getAgentTranscript(id, process.cwd());
  if (!t) {
    ctx.ui.notify(`Agent not found: ${id}`, "warning");
    return;
  }
  const lines = t.markdown.split("\n");
  if (lines.length > 120) {
    lines.length = 120;
    lines.push("… (truncated — see ~/.pi/alloy/agents/ for full file)");
  }
  if (ctx.hasUI !== false) await ctx.ui.select(`Agent ${t.record.name}`, lines);
  else console.log(t.markdown);
}

// silence
void getAgentsPanelLines;
