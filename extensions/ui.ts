/**
 * Alloy chrome — OpenCode empty-state layout (faithful).
 *
 * On start (matches OpenCode splash proportions):
 *   terminal cleared · pure black field
 *   compact ALLOY brand lockup, centered
 *   compact chat panel under it (~half width, centered)
 *   thin green left accent bar (OpenCode uses blue; we brand green)
 *   dim key hints flush under the panel's left edge
 *
 * Brand: "ALLOY", accent #1FE07A.
 * Lockup uses portable terminal glyphs with width and height fallbacks.
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

const VERSION = process.env.ALLOY_VERSION || "1.1.25";

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

export function panelWidth(termW: number, splash: boolean): number {
  const width = Math.max(1, Math.floor(termW));
  if (!splash) return width;
  // OpenCode empty-state: compact centered box (~half width, not full-bleed)
  return Math.min(width, 62, Math.max(48, Math.floor(width * 0.48)));
}

function centerPad(termW: number, boxW: number): number {
  return Math.max(0, Math.floor((termW - boxW) / 2));
}

export function splashHorizontalLayout(
  renderWidth: number,
): { width: number; boxWidth: number; left: number } {
  const width = Math.max(1, Math.floor(renderWidth));
  const boxWidth = panelWidth(width, true);
  return { width, boxWidth, left: centerPad(width, boxWidth) };
}

export function buildSplashHintLine(theme: ThemeLike, width: number): string {
  const layout = splashHorizontalLayout(width);
  const hints =
    theme.fg("dim", "tab") +
    theme.fg("muted", " agents") +
    theme.fg("dim", "  ctrl+p") +
    theme.fg("muted", " commands");
  return (
    " ".repeat(layout.left) +
    truncateToWidth(hints, layout.boxWidth, "")
  );
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

function centerVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  const left = Math.max(0, Math.floor((width - w) / 2));
  return padVisible(" ".repeat(left) + text, width);
}

const EDITOR_INPUT_ROWS = 3;
const BOTTOM_PADDING_ROWS = 1;
const COMPACT_TERMINAL_ROWS = 9;

export function inputRowsForTerminal(rows: number): number {
  return Number.isFinite(rows) && rows < COMPACT_TERMINAL_ROWS
    ? 1
    : EDITOR_INPUT_ROWS;
}

export function showEditorStatus(rows: number): boolean {
  return inputRowsForTerminal(rows) > 1;
}

export function ensureMinimumInputRows(
  lines: string[],
  minimumRows = EDITOR_INPUT_ROWS,
): string[] {
  const padded = [...lines];
  while (padded.length < minimumRows) padded.push("");
  return padded;
}

export function withBottomPadding(
  lines: string[],
  terminalRows = 24,
): string[] {
  const paddingRows = inputRowsForTerminal(terminalRows) === 1
    ? 0
    : BOTTOM_PADDING_ROWS;
  return [
    ...lines,
    ...Array.from({ length: paddingRows }, () => ""),
  ];
}

function isEditorBorder(line: string): boolean {
  const plain = stripAnsi(line);
  return (
    /^─+$/.test(plain) ||
    /^─{1,3} [↑↓] \d+(?: more )?(?:─*|\.\.\.)$/.test(plain)
  );
}

export function splitEditorRender(raw: string[]): {
  body: string[];
  autocomplete: string[];
} {
  const bottomBorder = raw.findIndex(
    (line, index) => index > 0 && isEditorBorder(line),
  );
  if (bottomBorder < 0) {
    return {
      body: raw.length > 2 ? raw.slice(1, -1) : [...raw],
      autocomplete: [],
    };
  }
  return {
    body: raw.slice(1, bottomBorder),
    autocomplete: raw.slice(bottomBorder + 1),
  };
}

export function fitCompactAutocomplete(
  lines: string[],
  terminalRows: number,
  splash: boolean,
): string[] {
  const outsideEditorRows = 1 + (splash ? 0 : 1); // footer + active header
  const availableRows = Math.max(0, terminalRows - outsideEditorRows - 1);
  if (availableRows === 0 || lines.length <= availableRows) {
    return lines.slice(0, availableRows);
  }
  const selected = lines.findIndex((line) =>
    stripAnsi(line).trimStart().startsWith("→ "),
  );
  if (selected < 0) return lines.slice(0, availableRows);
  const maxStart = lines.length - availableRows;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor((availableRows - 1) / 2), maxStart),
  );
  return lines.slice(start, start + availableRows);
}

/**
 * OpenCode panel row: thin accent bar + solid gray body.
 * Left bar is 1 cell; body is filled to boxW.
 */
export function panelRow(
  theme: ThemeLike,
  body: string,
  boxW: number,
): string {
  if (boxW <= 1) return theme.fg("accent", "▌");
  const innerW = Math.max(1, boxW - 1);
  const filled = padVisible(" " + body, innerW);
  // Thin bar (OpenCode uses a 1px accent; ▌ reads as a solid strip in terminals)
  const bar = theme.fg("accent", "▌");
  if (theme.bg) return bar + theme.bg("userMessageBg", filled);
  return bar + filled;
}

// ---------------------------------------------------------------------------
// Terminal-native brand lockup. The terminal owns the typeface; Alloy supplies
// portable spacing, weight, and color that survive SSH and tmux.
// ---------------------------------------------------------------------------

const SPLASH_WORDMARK = "A L L O Y";
const COMPACT_SPLASH_WORDMARK = "ALLOY";
const SPLASH_SUBTITLE = "MULTI-MODEL CODING HARNESS";
const FULL_SPLASH_MIN_ROWS = 11;

/** Center the compact brand lockup, with a single-line constrained fallback. */
export function buildWordmark(
  theme: ThemeLike,
  width: number,
  terminalRows = 24,
): string[] {
  const layoutWidth = splashHorizontalLayout(width).width;
  const contentWidth = visibleWidth(SPLASH_SUBTITLE);

  if (terminalRows >= FULL_SPLASH_MIN_ROWS && contentWidth <= layoutWidth) {
    const left = Math.max(0, Math.floor((layoutWidth - contentWidth) / 2));
    let title = centerVisible(SPLASH_WORDMARK, contentWidth);
    title = theme.bold ? theme.bold(title) : title;
    title = theme.fg("userMessageText", title);
    const divider = theme.fg("accent", "─".repeat(contentWidth));
    const subtitle = theme.fg("muted", SPLASH_SUBTITLE);
    return [title, divider, subtitle].map((line) => " ".repeat(left) + line);
  }

  const plain =
    visibleWidth(SPLASH_WORDMARK) <= layoutWidth
      ? SPLASH_WORDMARK
      : truncateToWidth(COMPACT_SPLASH_WORDMARK, layoutWidth, "");
  let word = plain;
  if (theme.bold) word = theme.bold(word);
  word = theme.fg("userMessageText", word);
  const left = Math.max(
    0,
    Math.floor((layoutWidth - visibleWidth(plain)) / 2),
  );
  return [" ".repeat(left) + word];
}

/**
 * Splash unit height for vertical centering (OpenCode: lockup + gap + 4-row
 * panel + hints — compact, lots of black field around it).
 */
const SPLASH_GAP = 1;
/** OpenCode-style panel is 3 input rows + 1 status row. */
const SPLASH_INPUT_ROWS = EDITOR_INPUT_ROWS;
const SPLASH_PANEL_ROWS = SPLASH_INPUT_ROWS + 1;
const SPLASH_HINT_ROWS = 1 + BOTTOM_PADDING_ROWS;
// Alloy enables Pi quiet startup, leaving one above-editor widget spacer.
const SPLASH_CHROME_ROWS = 1;

export function splashTopPadding(rows: number, logoRows: number): number {
  const splashUnit =
    logoRows +
    SPLASH_GAP +
    SPLASH_PANEL_ROWS +
    SPLASH_HINT_ROWS +
    SPLASH_CHROME_ROWS;
  return Math.max(0, Math.floor((rows - splashUnit) / 2));
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
    // Drop any leftover splash footer/hints chrome
    try {
      ctx.ui.setFooter((tui, theme) => {
        activeTui = tui;
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            // Active session: compact key hints only (no splash padding)
            const running = listAgents(process.cwd(), { limit: 20 }).filter(
              (a: { status: string }) => a.status === "running",
            ).length;
            const left =
              theme.fg("dim", "esc") +
              theme.fg("muted", " interrupt") +
              theme.fg("dim", "  tab") +
              theme.fg("muted", " agents") +
              theme.fg("dim", "  /mcp") +
              theme.fg("dim", "  Shift+Tab") +
              theme.fg("muted", " mode");
            const right =
              running > 0 ? theme.fg("warning", `agents:${running}`) : "";
            const gap = Math.max(
              1,
              width - visibleWidth(left) - visibleWidth(right),
            );
            return withBottomPadding(
              [truncateToWidth(left + " ".repeat(gap) + right, width)],
              tui.terminal?.rows || 24,
            );
          },
        };
      });
    } catch {
      // ignore
    }
    installActiveHeader(ctx);
    activeTui?.requestRender(true);
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

  // As soon as the operator starts typing, drop splash chrome (don't wait for send)
  pi.on("input", (_event, ctx) => {
    try {
      leaveSplash(ctx);
    } catch {
      // ignore
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

    // Splash header = vertical top-pad + responsive Alloy lockup (centered unit)
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
              if (inputRowsForTerminal(rows) === 1) return [];
              const mark = buildWordmark(theme, width, rows);
              // Top pad so logo+panel+hints sit in the vertical middle
              const pad = splashTopPadding(rows, mark.length);
              const blanks = Array.from({ length: pad }, () => "");
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
              // OpenCode: hints sit flush under the panel's left edge
              return withBottomPadding(
                [buildSplashHintLine(theme, width)],
                tui.terminal?.rows || 24,
              );
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
              theme.fg("muted", " mode") +
              theme.fg("dim", "  Ctrl+Shift+A");
            const right =
              running > 0
                ? theme.fg("warning", `agents:${running}`)
                : "";
            const gap = Math.max(
              1,
              width - visibleWidth(left) - visibleWidth(right),
            );
            return withBottomPadding(
              [truncateToWidth(left + " ".repeat(gap) + right, width)],
              tui.terminal?.rows || 24,
            );
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
          const layout = splash
            ? splashHorizontalLayout(width)
            : null;
          const boxW = layout?.boxWidth || panelWidth(width, false);
          const padN = layout?.left || 0;
          const pad = " ".repeat(padN);

          const raw = super.render(boxW);
          const editorRender = splitEditorRender(raw);
          let body = editorRender.body;
          const typed = (this.getText?.() || "").length > 0;
          const terminalRows = this.tui.terminal?.rows || 24;

          // Keep the cursor at the top of the empty splash input area.
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

          // Placeholder — OpenCode copy style (ASCII "...")
          if (splash && !typed && body[0] !== undefined) {
            const line = body[0];
            const phText = 'Ask anything...  "Fix broken tests"';
            const ph = thm.fg("dim", phText);
            if (isVisuallyBlank(line)) {
              body[0] = ph;
            } else if (stripAnsi(line).replace(/\s/g, "").length <= 1) {
              // keep cursor cell, then dim placeholder
              body[0] = line + thm.fg("dim", " " + phText);
            }
          }

          body = ensureMinimumInputRows(
            body,
            inputRowsForTerminal(terminalRows),
          );

          const out: string[] = [];
          for (const line of body) {
            out.push(panelRow(thm, line, boxW));
          }

          // Status row inside panel (OpenCode: "Build · model …")
          let thinking = "off";
          try {
            thinking = pi.getThinkingLevel?.() || "off";
          } catch {
            // ignore
          }
          const model = shortModel(ctx);
          const thinkBit = thinking !== "off" ? ` · ${thinking}` : "";
          const modeRaw = getState().mode || "build";
          const modeLabel =
            modeRaw === "plan"
              ? "Plan"
              : modeRaw === "review"
                ? "Review"
                : "Build";
          const statusInner = isWorking
            ? thm.fg("accent", `${spinnerFrames[spinnerIndex]} working`)
            : thm.fg("accent", modeLabel) +
              thm.fg("dim", " · ") +
              thm.fg("muted", model) +
              thm.fg("dim", thinkBit);
          if (showEditorStatus(terminalRows)) {
            out.push(panelRow(thm, statusInner, boxW));
          }

          const autocomplete = showEditorStatus(terminalRows)
            ? editorRender.autocomplete
            : fitCompactAutocomplete(
                editorRender.autocomplete,
                terminalRows,
                splash,
              );

          return [
            ...out.map((l) => pad + l),
            ...autocomplete.map((l) => pad + l),
          ];
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
    description: "Show Alloy version and runtime",
    handler: async (_args, ctx) => {
      await ctx.ui.select("Alloy", [
        `Alloy v${VERSION}`,
        "Pi runtime with the Solid/OpenTUI shell",
        "",
        "Use /help for guides or /help commands for the active command list",
      ]);
    },
  });

  pi.registerCommand("chrome", {
    description: process.env.ALLOY_FRONTEND === "opentui"
      ? "Available only with the legacy Pi renderer"
      : "Reset Alloy header/footer/editor chrome",
    handler: async (_args, ctx) => {
      if (ctx.mode === "rpc") {
        ctx.ui.notify("/chrome is only available with --legacy-pi-ui.", "warning");
        return;
      }
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
