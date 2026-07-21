/**
 * Alloy chrome — OpenCode-inspired chat-window layout, Alloy identity.
 *
 * Layout (top → bottom):
 *   green ALLOY wordmark + white status strip
 *   white transcript body (theme)
 *   bordered chat-box editor (model / tokens / cwd on borders)
 *   dim key-hint footer
 *
 * Accent: Kylaira #1FE07A. Not an OpenCode clone.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
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

const VERSION = process.env.ALLOY_VERSION || "0.7.2";

// ---------------------------------------------------------------------------
// Border helpers (from Pi border-status-editor pattern)
// ---------------------------------------------------------------------------

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");

  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
  );
  return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function formatContext(ctx: ExtensionContext): string {
  try {
    const usage = ctx.getContextUsage?.();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
    if (!contextWindow || !usage || usage.percent === null || usage.percent === undefined) {
      return "";
    }
    return `ctx ${Math.round(usage.percent)}%`;
  } catch {
    return "";
  }
}

function sessionTokenBits(ctx: ExtensionContext): { input: number; output: number; cost: number } {
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
  return { input, output, cost };
}

function fmtCount(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// Compact header — green ALLOY, white/muted chrome (no green window box)
// ---------------------------------------------------------------------------

function buildHeaderLines(
  theme: { fg: (c: string, t: string) => string },
  width: number,
  ctx: ExtensionContext,
): string[] {
  const w = Math.max(20, width);
  const brand = theme.fg("accent", "ALLOY");
  const tag = theme.fg("dim", " multi-model");
  const ver = theme.fg("dim", ` v${VERSION}`);

  const { input, output, cost } = sessionTokenBits(ctx);
  const statsPlain = `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(2)}`;
  const stats = theme.fg("muted", statsPlain);

  const leftPlain = `ALLOY multi-model v${VERSION}`;
  const pad = Math.max(1, w - visibleWidth(leftPlain) - visibleWidth(statsPlain));
  const topRow = brand + tag + ver + " ".repeat(pad) + stats;

  const cwd = basename(process.cwd());
  const perm = permissionStatusText(getState().permissionProfile);
  const agents = listAgents(process.cwd(), { limit: 20 });
  const running = agents.filter((a: { status: string }) => a.status === "running").length;
  const agentBit =
    running > 0
      ? theme.fg("warning", ` agents:${running}`)
      : agents.length
        ? theme.fg("dim", ` agents:${agents.length}`)
        : "";

  const subLeft =
    theme.fg("text", cwd) +
    theme.fg("dim", " · ") +
    theme.fg("muted", perm) +
    agentBit;
  const subPlain =
    `${cwd} · ${perm}` +
    (running > 0 ? ` agents:${running}` : agents.length ? ` agents:${agents.length}` : "");
  const rule = theme.fg("borderMuted", "─".repeat(w));

  return [
    "",
    truncateToWidth(topRow, w),
    truncateToWidth(subLeft + " ".repeat(Math.max(0, w - visibleWidth(subPlain))), w),
    rule,
  ];
}

// ---------------------------------------------------------------------------
// Empty footer component
// ---------------------------------------------------------------------------

class KeyHintFooter implements Component {
  constructor(
    private theme: { fg: (c: string, t: string) => string },
    private getRunning: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.theme;
    const running = this.getRunning();
    const left =
      th.fg("dim", " esc") +
      th.fg("muted", " interrupt") +
      th.fg("dim", "  /help") +
      th.fg("dim", "  Shift+Tab") +
      th.fg("muted", " ask") +
      th.fg("dim", "  /agent") +
      th.fg("dim", "  Ctrl+Shift+A");
    const right =
      running > 0
        ? th.fg("warning", `live agents:${running}`)
        : th.fg("dim", "/effort  /agents");
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [truncateToWidth(left + " ".repeat(pad) + right, width)];
  }
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerUi(pi: ExtensionAPI) {
  let isWorking = false;
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let activeTui: TUI | undefined;
  let branch: string | undefined;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  pi.on("agent_start", () => {
    isWorking = true;
    stopSpinner();
    spinnerTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      activeTui?.requestRender();
    }, 80);
    activeTui?.requestRender();
  });

  pi.on("agent_end", () => {
    isWorking = false;
    stopSpinner();
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", () => {
    stopSpinner();
    activeTui = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setTheme?.("alloy-dark");
    } catch {
      // theme may already be loaded via launcher --theme
    }

    // Green brand in status strip
    ctx.ui.setStatus(
      "alloy",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "ALLOY") : "ALLOY",
    );

    // Compact header: green ALLOY + white project strip
    try {
      ctx.ui.setHeader((_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          return buildHeaderLines(theme, width, ctx);
        },
      }));
    } catch {
      // ignore
    }

    // Key-hint footer (OpenCode-style bottom chrome) — not a heavy status bar
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange?.(() => {
          branch = footerData.getGitBranch?.() || branch;
          tui.requestRender();
        });
        // seed branch
        branch = footerData.getGitBranch?.() || branch;
        return {
          dispose: unsub || (() => {}),
          invalidate() {},
          render(width: number): string[] {
            const running = listAgents(process.cwd(), { limit: 20 }).filter(
              (a: { status: string }) => a.status === "running",
            ).length;
            return new KeyHintFooter(theme, () => running).render(width);
          },
        };
      });
    } catch {
      // ignore
    }

    // Hide built-in working row; spinner lives in chat-box top border
    try {
      ctx.ui.setWorkingVisible?.(false);
    } catch {
      // ignore
    }

    // Chat-box editor (OpenCode-style bordered input)
    try {
      const refreshBranch = async () => {
        try {
          const result = await pi.exec("git", ["branch", "--show-current"], {
            cwd: ctx.cwd,
          });
          const stdout = result?.stdout?.trim?.() || "";
          branch = stdout.length > 0 ? stdout : undefined;
          activeTui?.requestRender();
        } catch {
          // ignore
        }
      };
      void refreshBranch();

      class AlloyChatEditor extends CustomEditor {
        constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
          // paddingX 0 keeps the box tight like OpenCode's input pane
          super(tui, theme, keybindings, { paddingX: 0 });
          activeTui = tui;
          // Prefer green accent border for the chat box
          try {
            const th = ctx.ui.theme;
            if (th?.fg) {
              this.borderColor = (s: string) => th.fg("borderAccent", s);
            }
          } catch {
            // keep default
          }
        }

        render(width: number): string[] {
          const lines = super.render(width);
          if (lines.length < 2) return lines;

          const thm = ctx.ui.theme;
          const model = ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : "no model";
          let thinking = "off";
          try {
            thinking = pi.getThinkingLevel?.() || "off";
          } catch {
            // ignore
          }
          const thinkLabel = thinking === "off" ? "" : ` · ${thinking}`;
          const perm = permissionStatusText(getState().permissionProfile);
          const { input, output, cost } = sessionTokenBits(ctx);
          const ctxBit = formatContext(ctx);
          const cwdShort = formatCwd(ctx.cwd || process.cwd());
          const branchBit = branch ? ` (${branch})` : "";

          // Top border: working spinner (green) or quiet brand tick
          const topLeft = isWorking
            ? thm.fg("accent", ` ${spinnerFrames[spinnerIndex]} working `)
            : thm.fg("dim", " ");
          const topRight = thm.fg("dim", ` ${perm} `);

          // Bottom border: model · effort · tokens · path (white/muted)
          const bottomLeft = thm.fg(
            "text",
            ` ${model}${thinkLabel} `,
          );
          const tokenPart =
            input || output
              ? `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(2)}`
              : "";
          const bottomRightParts = [
            tokenPart,
            ctxBit,
            `${cwdShort}${branchBit}`,
          ].filter(Boolean);
          const bottomRight = thm.fg(
            "muted",
            ` ${bottomRightParts.join(" · ")} `,
          );

          const borderColor = (text: string) => this.borderColor(text);
          lines[0] = fitBorder(topLeft, topRight, width, borderColor);
          lines[lines.length - 1] = fitBorder(
            bottomLeft,
            bottomRight,
            width,
            borderColor,
          );
          return lines;
        }
      }

      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new AlloyChatEditor(tui, theme, keybindings),
      );
    } catch {
      // Custom editor optional if older Pi
    }

    // One-shot welcome under the chat box, then clear on first turn
    try {
      ctx.ui.setWidget(
        "alloy-welcome",
        (_tui, theme) => ({
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
        "UI:      chat-window chrome · green ALLOY · accent #1FE07A",
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
    description: "Reset Alloy header/footer/editor chrome",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      try {
        ctx.ui.setEditorComponent?.(undefined);
        ctx.ui.setWorkingVisible?.(true);
      } catch {
        // ignore
      }
      ctx.ui.notify(
        "Chrome cleared. /reload or restart to restore Alloy chrome.",
        "info",
      );
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
    await ctx.ui.select(
      `Last agent · ${last.name} · ${last.model || "default"}`,
      lines,
    );
  } else {
    console.log(t.markdown);
  }
}

void getAgent;
