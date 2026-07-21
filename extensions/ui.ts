/**
 * Alloy chrome — OpenCode empty-state layout.
 *
 * On start:
 *   terminal cleared
 *   big bold "alloy" wordmark dead-center
 *   solid chat panel directly underneath (green left bar)
 *   dim key hints under the panel
 *
 * Only brand differences from OpenCode: green + "alloy".
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
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

const VERSION = process.env.ALLOY_VERSION || "0.7.6";

type ThemeLike = {
  fg: (c: string, t: string) => string;
  bg?: (c: string, t: string) => string;
  bold?: (t: string) => string;
};

// ---------------------------------------------------------------------------
// Helpers
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

function shortModel(ctx: ExtensionContext): string {
  if (!ctx.model) return "no model";
  const id = ctx.model.id || "model";
  const provider = ctx.model.provider || "";
  return provider ? `${id} ${provider}` : id;
}

function panelWidth(termW: number, splash: boolean): number {
  if (!splash) return Math.max(20, termW);
  // OpenCode empty-state box: ~half width, centered
  return Math.min(64, Math.max(46, Math.floor(termW * 0.5)));
}

function centerPad(termW: number, boxW: number): number {
  return Math.max(0, Math.floor((termW - boxW) / 2));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function isVisuallyBlank(line: string): boolean {
  return stripAnsi(line).replace(/\s/g, "").length === 0;
}

function padVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - w);
}

/** OpenCode panel row: green left bar + solid gray body. */
function panelRow(theme: ThemeLike, body: string, boxW: number): string {
  const innerW = Math.max(1, boxW - 1);
  const filled = padVisible(" " + body, innerW);
  const bar = theme.fg("accent", "▌");
  if (theme.bg) return bar + theme.bg("userMessageBg", filled);
  return bar + filled;
}

// ---------------------------------------------------------------------------
// Big bold "alloy" wordmark — 5-row solid block font (OpenCode mass)
// Gradient left→right: dim green → Kylaira → white (like opencode gray→white)
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  a: [
    " ███ ",
    "█   █",
    "█████",
    "█   █",
    "█   █",
  ],
  l: [
    "█    ",
    "█    ",
    "█    ",
    "█    ",
    "█████",
  ],
  o: [
    " ███ ",
    "█   █",
    "█   █",
    "█   █",
    " ███ ",
  ],
  y: [
    "█   █",
    "█   █",
    " █ █ ",
    "  █  ",
    "  █  ",
  ],
};

/** Color ramp per letter index for "alloy" (5 letters). */
function letterColor(
  theme: ThemeLike,
  index: number,
): (s: string) => string {
  // OpenCode: dark → light across the word. Ours: green brand with bright end.
  const ramp = ["dim", "muted", "accent", "accent", "text"] as const;
  const key = ramp[Math.min(index, ramp.length - 1)]!;
  return (s: string) => theme.fg(key, s);
}

function buildWordmark(theme: ThemeLike, width: number): string[] {
  const word = "alloy";
  const gap = "  ";
  const rows = 5;
  const lines: string[] = [];

  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let i = 0; i < word.length; i++) {
      const ch = word[i]!;
      const glyph = GLYPHS[ch];
      if (!glyph) continue;
      const paint = letterColor(theme, i);
      // Paint each non-space cell; keep spaces uncolored for clean gaps
      const row = glyph[r]!;
      let painted = "";
      for (const cell of row) {
        painted += cell === " " ? " " : paint(cell);
      }
      if (i > 0) line += gap;
      line += painted;
    }
    const plain = stripAnsi(line);
    const left = Math.max(0, Math.floor((width - plain.length) / 2));
    lines.push(" ".repeat(left) + line);
  }
  return lines;
}

/** Rows consumed by splash unit (logo + gap + panel + hints). */
const SPLASH_LOGO_ROWS = 5;
const SPLASH_GAP = 2;
const SPLASH_PANEL_ROWS = 2; // input + status
const SPLASH_HINT_ROWS = 1;
const SPLASH_UNIT =
  SPLASH_LOGO_ROWS + SPLASH_GAP + SPLASH_PANEL_ROWS + SPLASH_HINT_ROWS;

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function registerUi(pi: ExtensionAPI) {
  let isWorking = false;
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let activeTui: TUI | undefined;
  let splashMode = true;
  let didClear = false;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const clearTerminal = (tui?: TUI) => {
    if (didClear) return;
    didClear = true;
    try {
      tui?.terminal?.clearScreen?.();
    } catch {
      // ignore
    }
    // Hard clear (screen + home + scrollback) — OpenCode-clean field
    try {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
      }
    } catch {
      // ignore
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
          const stats = `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(2)}`;
          const left = `alloy  ${perm}`;
          const gap = Math.max(
            1,
            width - visibleWidth(left) - visibleWidth(stats),
          );
          return [
            truncateToWidth(
              brand +
                theme.fg("dim", "  ") +
                theme.fg("muted", perm) +
                " ".repeat(gap) +
                theme.fg("dim", stats),
              width,
            ),
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
    didClear = false;

    try {
      ctx.ui.setTheme?.("alloy-dark");
    } catch {
      // already via launcher
    }

    ctx.ui.setStatus(
      "alloy",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "alloy") : "alloy",
    );

    // Splash header = vertical top-pad + big bold alloy wordmark (centered unit)
    // Active header = compact brand strip
    try {
      if (splashMode) {
        ctx.ui.setHeader((tui, theme) => {
          activeTui = tui;
          clearTerminal(tui);
          return {
            invalidate() {},
            render(width: number) {
              if (!splashMode) return [];
              const rows = tui.terminal?.rows || 24;
              // Top pad so logo+panel+hints sit in the vertical middle
              const pad = Math.max(0, Math.floor((rows - SPLASH_UNIT) / 2));
              const blanks = Array.from({ length: pad }, () => "");
              const mark = buildWordmark(theme, width);
              // Gap under logo before the chat panel (editor is next)
              const gap = Array.from({ length: SPLASH_GAP }, () => "");
              return [...blanks, ...mark, ...gap];
            },
          };
        });
      } else {
        installActiveHeader(ctx);
      }
    } catch {
      // ignore
    }

    // Footer: OpenCode key hints, indented under the centered panel
    try {
      ctx.ui.setFooter((tui, theme) => {
        activeTui = tui;
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (splashMode) {
              const boxW = panelWidth(width, true);
              const pad = centerPad(width, boxW);
              const hints =
                theme.fg("dim", "tab") +
                theme.fg("muted", " agents") +
                theme.fg("dim", "  ctrl+p") +
                theme.fg("muted", " commands");
              return [" ".repeat(pad) + truncateToWidth(hints, boxW)];
            }
            const running = listAgents(process.cwd(), { limit: 20 }).filter(
              (a: { status: string }) => a.status === "running",
            ).length;
            const left =
              theme.fg("dim", "esc") +
              theme.fg("muted", " interrupt") +
              theme.fg("dim", "  tab") +
              theme.fg("muted", " agents") +
              theme.fg("dim", "  /agent") +
              theme.fg("dim", "  Shift+Tab") +
              theme.fg("muted", " ask") +
              theme.fg("dim", "  Ctrl+Shift+A");
            const right =
              running > 0
                ? theme.fg("warning", `agents:${running}`)
                : "";
            const gap = Math.max(
              1,
              width - visibleWidth(left) - visibleWidth(right),
            );
            return [truncateToWidth(left + " ".repeat(gap) + right, width)];
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

    // No above-editor splash widget — wordmark lives in header so it sits
    // directly above the chat panel with true vertical centering.
    try {
      ctx.ui.setWidget("alloy-splash", undefined);
    } catch {
      // ignore
    }

    // Solid OpenCode-style chat panel under the wordmark
    try {
      class AlloyChatEditor extends CustomEditor {
        constructor(
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
        ) {
          super(tui, theme, keybindings, { paddingX: 0 });
          activeTui = tui;
          this.borderColor = (s: string) => s;
        }

        render(width: number): string[] {
          const thm = ctx.ui.theme as ThemeLike;
          const splash = splashMode;
          const boxW = panelWidth(width, splash);
          const padN = splash ? centerPad(width, boxW) : 0;
          const pad = " ".repeat(padN);

          const raw = super.render(boxW);
          if (raw.length < 2) return raw.map((l) => pad + l);

          // Drop Pi top/bottom ─ borders
          let body = raw.slice(1, -1);
          const typed = (this.getText?.() || "").length > 0;

          // Empty splash: one input row only (OpenCode is 2 rows total with status)
          if (splash && !typed) {
            const cursorLine =
              body.find((l) => l.includes("\x1b[7m")) || body[0] || "";
            body = [cursorLine];
          } else {
            while (body.length > 1 && isVisuallyBlank(body[body.length - 1]!)) {
              body.pop();
            }
            if (body.length === 0) body = [""];
          }

          // Placeholder (OpenCode: Ask anything…)
          if (splash && !typed && body[0] !== undefined) {
            const line = body[0];
            const ph = thm.fg("dim", 'Ask anything…  "Fix broken tests"');
            if (isVisuallyBlank(line)) {
              body[0] = ph;
            } else if (stripAnsi(line).replace(/\s/g, "").length <= 1) {
              body[0] = line + thm.fg("dim", ' Ask anything…  "Fix broken tests"');
            }
          }

          const out: string[] = [];
          for (const line of body) {
            out.push(panelRow(thm, line, boxW));
          }

          // Status row inside panel
          let thinking = "off";
          try {
            thinking = pi.getThinkingLevel?.() || "off";
          } catch {
            // ignore
          }
          const model = shortModel(ctx);
          const thinkBit = thinking !== "off" ? ` · ${thinking}` : "";
          const statusInner = isWorking
            ? thm.fg("accent", `${spinnerFrames[spinnerIndex]} working`)
            : thm.fg("accent", "Build") +
              thm.fg("dim", " · ") +
              thm.fg("text", model) +
              thm.fg("dim", thinkBit);
          out.push(panelRow(thm, statusInner, boxW));

          return out.map((l) => pad + l);
        }
      }

      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new AlloyChatEditor(tui, theme, keybindings),
      );
    } catch {
      // older Pi
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
      await ctx.ui.select("Alloy", [
        `Alloy v${VERSION}`,
        "OpenCode layout · green alloy wordmark · accent #1FE07A",
        "",
        "/agent  /agents  Ctrl+Shift+A  Shift+Tab  /effort  /help",
      ]);
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
      ctx.ui.notify("Chrome cleared. Restart alloy to restore.", "info");
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
