/**
 * Alloy chrome — OpenCode empty-state splash + chat-box input.
 *
 * Empty session (matches reference splash):
 *   centered green/white "alloy" wordmark
 *   left-accent chat box with placeholder-style status row
 *   dim key hints under the box
 *
 * Active session:
 *   minimal top strip, same chat-box editor, key-hint footer
 *
 * Accent: Kylaira #1FE07A. Layout inspired by OpenCode, Alloy identity.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getState } = require(join(root, "lib", "state.mjs"));
const { permissionStatusText } = require(join(root, "lib", "permissions.mjs"));
const { getAgent, getAgentTranscript, listAgents } = require(
  join(root, "lib", "agent-registry.mjs"),
);

const VERSION = process.env.ALLOY_VERSION || "0.7.3";

type ThemeFg = { fg: (c: string, t: string) => string };

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function sessionHasUserMessages(ctx: ExtensionContext): boolean {
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message?.role === "user") return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function sessionTokenBits(ctx: ExtensionContext): {
  input: number;
  output: number;
  cost: number;
} {
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

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function shortModelLabel(ctx: ExtensionContext): string {
  if (!ctx.model) return "no model";
  const id = ctx.model.id || "model";
  const provider = ctx.model.provider || "";
  // OpenCode style: "Build · GPT-5.6 Sol OpenAI"
  return provider ? `${id} ${provider}` : id;
}

// ---------------------------------------------------------------------------
// Wordmark — gradient-ish "alloy" (green → white), OpenCode splash energy
// ---------------------------------------------------------------------------

/**
 * Large centered "alloy" wordmark.
 * Reference uses a heavy single-line logo; we use a compact block glyph
 * with Kylaira green (user: Alloy in green) and a bright white center beat.
 */
function buildWordmarkBlock(theme: ThemeFg, width: number): string[] {
  // 5-letter block rows (width ~29). Green fill, white highlight on the double-L stem.
  const G = (s: string) => theme.fg("accent", s);
  const W = (s: string) => theme.fg("text", s);
  const D = (s: string) => theme.fg("dim", s);

  // Row-based "alloy" — readable at a glance, centered like the reference
  const rows = [
    G("▄▀█") + " " + G("█") + D("░░") + " " + W("█") + D("░░") + " " + G("█▀█") + " " + G("█") + W("▄") + G("█"),
    G("█▀█") + " " + G("█") + D("▄▄") + " " + W("█") + D("▄▄") + " " + G("█▄█") + " " + D("░") + W("█") + D("░"),
  ];
  const plainWidths = [rows[0], rows[1]].map(
    (r) => r.replace(/\x1b\[[0-9;]*m/g, "").length,
  );
  return rows.map((row, i) => {
    const left = Math.max(0, Math.floor((width - plainWidths[i]) / 2));
    return " ".repeat(left) + row;
  });
}

// ---------------------------------------------------------------------------
// Chat-box width (centered, not full terminal — like the reference)
// ---------------------------------------------------------------------------

function chatBoxWidth(termWidth: number): number {
  // Reference box sits centered at ~half–two-thirds width
  const ideal = Math.floor(termWidth * 0.58);
  return Math.min(Math.max(ideal, 42), Math.min(72, termWidth));
}

function sidePad(termWidth: number, boxW: number): number {
  return Math.max(0, Math.floor((termWidth - boxW) / 2));
}

// ---------------------------------------------------------------------------
// Footer — reference: "tab agents  ctrl+p commands"
// ---------------------------------------------------------------------------

class KeyHintFooter implements Component {
  constructor(
    private theme: ThemeFg,
    private splash: () => boolean,
    private getRunning: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.theme;
    if (this.splash()) {
      // Match reference empty-state: few hints, left-aligned under the box zone
      const boxW = chatBoxWidth(width);
      const pad = sidePad(width, boxW);
      const hints =
        th.fg("dim", "tab") +
        th.fg("muted", " agents") +
        th.fg("dim", "  /agent") +
        th.fg("muted", " spawn") +
        th.fg("dim", "  Shift+Tab") +
        th.fg("muted", " ask") +
        th.fg("dim", "  /help");
      return [" ".repeat(pad) + truncateToWidth(hints, boxW)];
    }

    const running = this.getRunning();
    const left =
      th.fg("dim", "esc") +
      th.fg("muted", " interrupt") +
      th.fg("dim", "  /help") +
      th.fg("dim", "  Shift+Tab") +
      th.fg("muted", " ask") +
      th.fg("dim", "  /agent") +
      th.fg("dim", "  Ctrl+Shift+A");
    const right =
      running > 0
        ? th.fg("warning", `live agents:${running}`)
        : th.fg("dim", `/effort  v${VERSION}`);
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [truncateToWidth(left + " ".repeat(gap) + right, width)];
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
  let splashMode = true;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const installActiveHeader = (ctx: ExtensionContext) => {
    try {
      ctx.ui.setHeader((_tui, theme) => ({
        invalidate() {},
        render(width: number) {
          const brand = theme.fg("accent", "alloy");
          const perm = permissionStatusText(getState().permissionProfile);
          const { input, output, cost } = sessionTokenBits(ctx);
          const statsPlain = `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(2)}`;
          const leftPlain = `alloy  ${perm}`;
          const gap = Math.max(
            1,
            width - visibleWidth(leftPlain) - visibleWidth(statsPlain),
          );
          return [
            truncateToWidth(
              brand +
                theme.fg("dim", "  ") +
                theme.fg("muted", perm) +
                " ".repeat(gap) +
                theme.fg("dim", statsPlain),
              width,
            ),
            theme.fg("borderMuted", "─".repeat(Math.max(1, width))),
          ];
        },
      }));
    } catch {
      // ignore
    }
  };

  const leaveSplash = (ctx: ExtensionContext) => {
    if (!splashMode) return;
    splashMode = false;
    try {
      ctx.ui.setWidget("alloy-splash", undefined);
    } catch {
      // ignore
    }
    installActiveHeader(ctx);
    activeTui?.requestRender();
  };

  pi.on("agent_start", (_e, ctx) => {
    isWorking = true;
    leaveSplash(ctx);
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

  pi.on("message_start", (event, ctx) => {
    if ((event as { message?: { role?: string } })?.message?.role === "user") {
      leaveSplash(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    stopSpinner();
    activeTui = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    splashMode = !sessionHasUserMessages(ctx);

    try {
      ctx.ui.setTheme?.("alloy-dark");
    } catch {
      // theme may already be loaded via launcher --theme
    }

    ctx.ui.setStatus(
      "alloy",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "alloy") : "alloy",
    );

    // Splash: no top header chrome (clean black field like the reference)
    // Active: compact brand strip
    try {
      if (splashMode) {
        ctx.ui.setHeader(() => ({
          invalidate() {},
          render(): string[] {
            return [];
          },
        }));
      } else {
        installActiveHeader(ctx);
      }
    } catch {
      // ignore
    }

    // Key-hint footer
    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange?.(() => tui.requestRender());
        return {
          dispose: unsub || (() => {}),
          invalidate() {},
          render(width: number): string[] {
            const running = listAgents(process.cwd(), { limit: 20 }).filter(
              (a: { status: string }) => a.status === "running",
            ).length;
            return new KeyHintFooter(
              theme,
              () => splashMode,
              () => running,
            ).render(width);
          },
        };
      });
    } catch {
      // ignore
    }

    try {
      ctx.ui.setWorkingVisible?.(false);
    } catch {
      // ignore
    }

    // Wordmark splash above the chat box (vertically nudged toward center)
    try {
      if (splashMode) {
        ctx.ui.setWidget(
          "alloy-splash",
          (tui, theme) => ({
            invalidate() {},
            render(width: number) {
              if (!splashMode) return [];
              const rows = tui.terminal?.rows || 24;
              // Room for wordmark (2) + gap (1) + editor (~4) + footer (1) ≈ 8
              const reserved = 10;
              const pad = Math.max(2, Math.floor((rows - reserved) / 2));
              const blanks = Array.from({ length: pad }, () => "");
              const mark = buildWordmarkBlock(theme, width);
              return [...blanks, ...mark, ""];
            },
          }),
          { placement: "aboveEditor" },
        );
      }
    } catch {
      // ignore
    }

    // Chat box with left green accent (OpenCode input panel energy)
    try {
      class AlloyChatEditor extends CustomEditor {
        constructor(
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
        ) {
          super(tui, theme, keybindings, { paddingX: 0 });
          activeTui = tui;
          try {
            const th = ctx.ui.theme;
            if (th?.fg) {
              // Soft outer edges; accent lives on the left bar
              this.borderColor = (s: string) => th.fg("borderMuted", s);
            }
          } catch {
            // keep default
          }
        }

        render(width: number): string[] {
          const boxW = splashMode ? chatBoxWidth(width) : width;
          const padN = splashMode ? sidePad(width, boxW) : 0;
          const pad = " ".repeat(padN);

          const inner = super.render(boxW);
          if (inner.length < 2) {
            return inner.map((l) => pad + l);
          }

          const thm = ctx.ui.theme as ThemeFg;
          const accentBar = (s: string) => thm.fg("accent", s);
          const muted = (s: string) => thm.fg("borderMuted", s);
          const dim = (s: string) => thm.fg("dim", s);
          const text = (s: string) => thm.fg("text", s);

          // Top edge: quiet (no heavy green window frame)
          inner[0] = muted("─".repeat(boxW));

          // Content rows: left green accent bar (OpenCode blue bar → Kylaira green)
          // Preserve ANSI/cursor markers from super.render — only prefix the bar.
          for (let i = 1; i < inner.length - 1; i++) {
            const body = inner[i];
            let line = accentBar("│") + " " + body;
            const vw = visibleWidth(line);
            if (vw < boxW) line = line + " ".repeat(boxW - vw);
            else if (vw > boxW) line = truncateToWidth(line, boxW);
            inner[i] = line;
          }

          // Status row sits on the bottom border area (Build · model)
          let thinking = "off";
          try {
            thinking = pi.getThinkingLevel?.() || "off";
          } catch {
            // ignore
          }
          const perm = permissionStatusText(getState().permissionProfile);
          const model = shortModelLabel(ctx);
          const thinkBit = thinking !== "off" ? ` · ${thinking}` : "";
          const statusLeft = isWorking
            ? thm.fg("accent", `${spinnerFrames[spinnerIndex]} working`)
            : thm.fg("accent", `Build`) +
              dim(" · ") +
              text(model) +
              dim(thinkBit);

          // When not splash, append perm/cwd on the right
          let statusRight = "";
          if (!splashMode) {
            const cwd = formatCwd(ctx.cwd || process.cwd());
            statusRight = dim(` ${perm} · ${cwd} `);
          }

          // Bottom line: left accent continues + status
          const statusCore = statusLeft;
          const right = statusRight;
          const used =
            2 + visibleWidth(statusCore) + visibleWidth(right); // │ + space + …
          const gap = Math.max(1, boxW - used);
          inner[inner.length - 1] =
            accentBar("│") +
            " " +
            statusCore +
            " ".repeat(gap) +
            right;

          // Empty splash: keep super's cursor cell intact, paint dim placeholder after it.
          // Reference: Ask anything… "Fix broken tests"
          try {
            if (splashMode && !this.getText?.() && inner.length >= 3) {
              const ph = dim(' Ask anything…  "Fix broken tests"');
              // Content line already has accent bar + optional cursor reverse-video.
              // Append placeholder only if the line has room and little plain text.
              const raw = inner[1];
              const plain = raw.replace(/\x1b\[[0-9;]*m/g, "");
              if (plain.replace(/[│\s]/g, "").length <= 1) {
                const used = visibleWidth(raw);
                const room = Math.max(0, boxW - used);
                if (room > 8) {
                  inner[1] = raw + truncateToWidth(ph, room);
                }
              }
            }
          } catch {
            // ignore placeholder failures
          }

          return inner.map((l) => pad + l);
        }
      }

      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new AlloyChatEditor(tui, theme, keybindings),
      );
    } catch {
      // Custom editor optional if older Pi
    }
  });

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
        "UI:      OpenCode-style splash · green alloy · accent #1FE07A",
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
        ctx.ui.setWidget("alloy-splash", undefined);
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
  if (lines.length >= 100) {
    lines.push("… truncated — full file in ~/.pi/alloy/agents/");
  }
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
