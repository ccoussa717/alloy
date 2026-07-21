/**
 * Alloy chrome — OpenCode-inspired window feel, Kylaira green (#1FE07A).
 * Custom header "window", status footer, welcome strip.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getState } = require(join(root, "lib", "state.mjs"));
const { permissionStatusText } = require(join(root, "lib", "permissions.mjs"));
const { getAgent, getAgentTranscript, listAgents } = require(
  join(root, "lib", "agent-registry.mjs"),
);

const VERSION = process.env.ALLOY_VERSION || "0.7.1";

function boxLine(theme: { fg: (c: string, t: string) => string }, width: number, content: string) {
  const inner = Math.max(10, width - 2);
  const body = truncateToWidth(content, inner);
  const pad = " ".repeat(Math.max(0, inner - visibleWidth(body)));
  return (
    theme.fg("borderAccent", "│") +
    body +
    pad +
    theme.fg("borderAccent", "│")
  );
}

function buildHeaderLines(theme: { fg: (c: string, t: string) => string }, width: number): string[] {
  const w = Math.max(40, Math.min(width, 88));
  const inner = w - 2;
  const top =
    theme.fg("borderAccent", "╭") +
    theme.fg("borderAccent", "─".repeat(inner)) +
    theme.fg("borderAccent", "╮");
  const bot =
    theme.fg("borderAccent", "╰") +
    theme.fg("borderAccent", "─".repeat(inner)) +
    theme.fg("borderAccent", "╯");

  const brand = theme.fg("accent", " ALLOY");
  const tag = theme.fg("dim", "  multi-model coding harness");
  const ver = theme.fg("dim", `v${VERSION}`);
  const titleCore = ` ALLOY` + `  multi-model coding harness`;
  // build colored title row
  const titlePlain = ` ALLOY  multi-model coding harness`;
  const right = `v${VERSION} `;
  const midPad = Math.max(1, inner - visibleWidth(titlePlain) - visibleWidth(right));
  const titleRow =
    theme.fg("borderAccent", "│") +
    theme.fg("accent", " ALLOY") +
    theme.fg("dim", "  multi-model coding harness") +
    " ".repeat(midPad) +
    theme.fg("dim", right) +
    theme.fg("borderAccent", "│");

  const cwd = basename(process.cwd());
  const perm = permissionStatusText(getState().permissionProfile);
  const hints = theme.fg(
    "muted",
    ` /help  /agent  /agents  Shift+Tab ${perm}  /effort  Ctrl+Shift+A`,
  );
  const proj = theme.fg("dim", ` project `) + theme.fg("text", cwd);
  const emptyHintPad = Math.max(0, inner - visibleWidth(` /help  /agent  /agents  Shift+Tab ${perm}  /effort  Ctrl+Shift+A`));
  const hintRow =
    theme.fg("borderAccent", "│") +
    theme.fg("muted", ` /help  /agent  /agents  Shift+Tab ${perm}  /effort  Ctrl+Shift+A`) +
    " ".repeat(emptyHintPad) +
    theme.fg("borderAccent", "│");

  const projPad = Math.max(0, inner - visibleWidth(` project ${cwd}`));
  const projRow =
    theme.fg("borderAccent", "│") +
    theme.fg("dim", " project ") +
    theme.fg("text", cwd) +
    " ".repeat(projPad) +
    theme.fg("borderAccent", "│");

  return ["", top, titleRow, hintRow, projRow, bot, ""];
}

export function registerUi(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" && ctx.mode !== "interactive") {
      // still set statuses in non-tui when possible
    }

    try {
      ctx.ui.setTheme?.("alloy-dark");
    } catch {
      // theme may already be loaded via launcher --theme
    }

    ctx.ui.setStatus(
      "alloy",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "ALLOY") : "ALLOY",
    );

    // Window-style header (OpenCode-inspired chrome, Kylaira green)
    try {
      ctx.ui.setHeader((_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          return buildHeaderLines(theme, width);
        },
      }));
    } catch {
      // ignore
    }

    // Status footer: tokens · model · perm · branch
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange?.(() => tui.requestRender());
        return {
          dispose: unsub || (() => {}),
          invalidate() {},
          render(width: number): string[] {
            let input = 0;
            let output = 0;
            let cost = 0;
            try {
              for (const e of ctx.sessionManager.getBranch()) {
                if (e.type === "message" && e.message?.role === "assistant") {
                  const m = e.message as AssistantMessage;
                  input += m.usage?.input || 0;
                  output += m.usage?.output || 0;
                  cost += m.usage?.cost?.total || 0;
                }
              }
            } catch {
              // ignore
            }
            const fmt = (n: number) =>
              n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
            const branch = footerData.getGitBranch?.() || "";
            const model = ctx.model?.id || "no-model";
            const perm = permissionStatusText(getState().permissionProfile);
            const agents = listAgents(process.cwd(), { limit: 20 });
            const running = agents.filter((a: { status: string }) => a.status === "running").length;

            const left = theme.fg(
              "dim",
              `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`,
            );
            const mid = theme.fg("accent", ` ${perm} `);
            const agentBit =
              running > 0
                ? theme.fg("warning", ` agents:${running}`)
                : theme.fg("dim", agents.length ? ` agents:${agents.length}` : "");
            const right = theme.fg(
              "dim",
              `${model}${branch ? " · " + branch : ""}`,
            );

            const rule = theme.fg("borderMuted", "─".repeat(Math.max(10, width)));
            const row = left + mid + agentBit;
            const pad = " ".repeat(
              Math.max(1, width - visibleWidth(row) - visibleWidth(right)),
            );
            return [
              rule,
              truncateToWidth(row + pad + right, width),
            ];
          },
        };
      });
    } catch {
      // ignore footer failures
    }

    // Subtle welcome strip once
    try {
      ctx.ui.setWidget(
        "alloy-welcome",
        (tui, theme) => ({
          invalidate() {},
          render(width: number) {
            const line = theme.fg(
              "dim",
              " ready · multi-model agents · Ctrl+Shift+A last agent · /help",
            );
            return [truncateToWidth(line, width)];
          },
        }),
        { placement: "belowEditor" },
      );
      // Clear welcome on first agent turn so the strip does not stick
      let cleared = false;
      pi.on("agent_start", () => {
        if (cleared) return;
        cleared = true;
        try {
          ctx.ui.setWidget("alloy-welcome", undefined);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  });

  // Open last agent transcript
  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Open last Alloy sub-agent transcript",
    handler: async (ctx) => {
      await openLastAgent(ctx);
    },
  });

  pi.registerCommand("last-agent", {
    description: "Open the most recent sub-agent transcript (also Ctrl+Shift+A)",
    handler: async (_args, ctx) => {
      await openLastAgent(ctx);
    },
  });

  pi.registerCommand("alloy", {
    description: "Alloy help and version",
    handler: async (_args, ctx) => {
      const lines = [
        `Alloy v${VERSION}`,
        "Kylaira multi-model coding harness",
        "",
        "UI:      OpenCode-inspired chrome · accent #1FE07A",
        "Agents:  /agent  /agents  /profiles  Ctrl+Shift+A",
        "Auto:    /auto  /fusion",
        "Perms:   Shift+Tab ask-levels",
        "Effort:  /effort high",
        "Auth:    /login  /login xai",
        "Help:    /help",
      ];
      await ctx.ui.select("Alloy", lines);
    },
  });

  pi.registerCommand("chrome", {
    description: "Reset Alloy header/footer chrome",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Chrome cleared. /reload or restart to restore Alloy chrome.", "info");
    },
  });
}

async function openLastAgent(ctx: {
  ui: {
    select: (t: string, o: string[]) => Promise<string | undefined>;
    notify: (m: string, t?: string) => void;
  };
  hasUI?: boolean;
}) {
  const list = listAgents(process.cwd(), { limit: 20 });
  if (!list.length) {
    ctx.ui.notify("No agents yet. Spawn with /agent <name> <task>", "info");
    return;
  }
  // Prefer most recently ended, else most recently started
  const sorted = [...list].sort((a: any, b: any) => {
    const ta = a.endedAt || a.startedAt || 0;
    const tb = b.endedAt || b.startedAt || 0;
    return tb - ta;
  });
  const last = sorted[0];
  const t = getAgentTranscript(last.id, process.cwd());
  if (!t) {
    ctx.ui.notify(`Could not load agent ${last.id}`, "warning");
    return;
  }
  const lines = String(t.markdown || "")
    .split("\n")
    .slice(0, 100);
  if (lines.length >= 100) lines.push("… truncated — full file in ~/.pi/alloy/agents/");
  if (ctx.hasUI !== false) {
    await ctx.ui.select(`Last agent · ${last.name} · ${last.model || "default"}`, lines);
  } else {
    console.log(t.markdown);
  }
}

// silence unused helpers if tree-shaken
void boxLine;
void getAgent;
