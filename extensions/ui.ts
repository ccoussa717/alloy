/**
 * Alloy chrome — OpenCode layout, Alloy identity.
 *
 * Empty state (OpenCode splash, 1:1 structure):
 *   clean black field (quietStartup — no Skills dump)
 *   centered "alloy" wordmark (green brand beat)
 *   solid gray chat panel + green left bar
 *   Build · model on panel bottom row
 *   dim key hints under the panel
 *
 * Active: same panel style, compact brand strip.
 * Only differences from OpenCode: green accent + "alloy" name.
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

const VERSION = process.env.ALLOY_VERSION || "0.7.4";

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

/** OpenCode-width centered panel on empty; near-full when chatting. */
function panelWidth(termW: number, splash: boolean): number {
  if (!splash) return Math.max(20, termW);
  // ~ half screen like the reference, min 48 max 68
  return Math.min(68, Math.max(48, Math.floor(termW * 0.52)));
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

/** Pad plain or ANSI text to exact visible width with spaces (inside bg). */
function padVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - w);
}

/**
 * OpenCode panel row: green left bar + solid gray body.
 * Bar is outside the bg so it reads as a pure accent strip.
 */
function panelRow(
  theme: ThemeLike,
  body: string,
  boxW: number,
): string {
  const innerW = Math.max(1, boxW - 1);
  const filled = padVisible(" " + body, innerW);
  const bar = theme.fg("accent", "▌");
  if (theme.bg) {
    return bar + theme.bg("userMessageBg", filled);
  }
  return bar + filled;
}

// ---------------------------------------------------------------------------
// Wordmark — OpenCode single-line mass, green brand (not blue)
// ---------------------------------------------------------------------------

/**
 * Heavy lowercase "alloy" like OpenCode's "opencode":
 * left dim → green beat → bright white right.
 */
function buildWordmark(theme: ThemeLike, width: number): string[] {
  // Two-row slab letters (same visual weight as OpenCode logo)
  const d = (s: string) => theme.fg("dim", s);
  const m = (s: string) => theme.fg("muted", s);
  const g = (s: string) => theme.fg("accent", s);
  const w = (s: string) => theme.fg("text", s);

  // a l l o y  — gradient through the word
  const row1 =
    d("▄▀█") +
    " " +
    m("█") +
    d("  ") +
    " " +
    g("█") +
    d("  ") +
    " " +
    w("▄▀█") +
    " " +
    w("█") +
    g("▄") +
    w("█");
  const row2 =
    d("█▀█") +
    " " +
    m("█") +
    d("▄▄") +
    " " +
    g("█") +
    d("▄▄") +
    " " +
    w("█▀█") +
    " " +
    d(" ") +
    w("█") +
    d(" ");

  const center = (line: string) => {
    const plain = stripAnsi(line);
    const left = Math.max(0, Math.floor((width - plain.length) / 2));
    return " ".repeat(left) + line;
  };

  return ["", center(row1), center(row2), ""];
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
          const stats = `↑${fmtCount(input)} ↓${fmtCount(output)} $${cost.toFixed(2)}`;
          const left = `alloy  ${perm}`;
          const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(stats));
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

    try {
      ctx.ui.setTheme?.("alloy-dark");
    } catch {
      // already via launcher
    }

    ctx.ui.setStatus(
      "alloy",
      ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "alloy") : "alloy",
    );

    // Empty header on splash (clean black); compact strip when active
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

    // Footer: OpenCode-style key hints under the panel
    try {
      ctx.ui.setFooter((tui, theme) => ({
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          const boxW = panelWidth(width, splashMode);
          const pad = splashMode ? centerPad(width, boxW) : 0;
          if (splashMode) {
            // Reference: "tab agents  ctrl+p commands"
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
              : theme.fg("dim", "");
          const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
          return [truncateToWidth(left + " ".repeat(gap) + right, width)];
        },
      }));
    } catch {
      // ignore
    }

    try {
      ctx.ui.setWorkingVisible?.(false);
    } catch {
      // ignore
    }

    // Centered wordmark above the chat panel (splash only)
    try {
      if (splashMode) {
        ctx.ui.setWidget(
          "alloy-splash",
          (tui, theme) => ({
            invalidate() {},
            render(width: number) {
              if (!splashMode) return [];
              const rows = tui.terminal?.rows || 24;
              // logo(~4) + panel(~3) + hints(1) ≈ 8; push unit toward vertical center
              const reserved = 9;
              const pad = Math.max(1, Math.floor((rows - reserved) / 2) - 1);
              const blanks = Array.from({ length: pad }, () => "");
              return [...blanks, ...buildWordmark(theme, width)];
            },
          }),
          { placement: "aboveEditor" },
        );
      }
    } catch {
      // ignore
    }

    // Solid OpenCode-style chat panel
    try {
      class AlloyChatEditor extends CustomEditor {
        constructor(
          tui: TUI,
          theme: EditorTheme,
          keybindings: KeybindingsManager,
        ) {
          super(tui, theme, keybindings, { paddingX: 0 });
          activeTui = tui;
          // Hide default border color — we paint the panel ourselves
          this.borderColor = (s: string) => s;
        }

        render(width: number): string[] {
          const thm = ctx.ui.theme as ThemeLike;
          const splash = splashMode;
          const boxW = panelWidth(width, splash);
          const padN = splash ? centerPad(width, boxW) : 0;
          const pad = " ".repeat(padN);

          // Use super for text layout + cursor markers, then restyle into a panel
          const raw = super.render(boxW);
          if (raw.length < 2) return raw.map((l) => pad + l);

          // Drop Pi's top/bottom ─ borders
          let body = raw.slice(1, -1);

          const typed = (this.getText?.() || "").length > 0;

          // Empty splash: single input row (OpenCode is 2 rows: input + status)
          if (splash && !typed) {
            // Prefer the line that has the cursor
            const cursorLine =
              body.find((l) => l.includes("\x1b[7m") || l.includes("\u200b")) ||
              body[0] ||
              "";
            body = [cursorLine];
          } else {
            // Collapse trailing blank padding lines Pi reserves (min 5)
            while (body.length > 1 && isVisuallyBlank(body[body.length - 1]!)) {
              body.pop();
            }
            // Keep at least one input row
            if (body.length === 0) body = [""];
          }

          // Placeholder on empty splash (OpenCode: Ask anything… "Fix broken tests")
          if (splash && !typed && body[0] !== undefined) {
            const line = body[0];
            if (isVisuallyBlank(line) || stripAnsi(line).replace(/\s/g, "").length <= 1) {
              // Keep cursor cell from super if present; append dim placeholder after
              const ph = thm.fg("dim", 'Ask anything…  "Fix broken tests"');
              if (isVisuallyBlank(line)) {
                body[0] = ph;
              } else {
                // cursor at start — show placeholder after reverse-video cell
                body[0] = line + thm.fg("dim", ' Ask anything…  "Fix broken tests"');
              }
            }
          }

          // Paint input rows as solid panel
          const out: string[] = [];
          for (const line of body) {
            out.push(panelRow(thm, line, boxW));
          }

          // Status row inside the panel (OpenCode: Build · model)
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
      // older Pi without setEditorComponent
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
        "OpenCode layout · green accent #1FE07A · alloy wordmark",
        "",
        "/agent  /agents  /profiles  Ctrl+Shift+A",
        "Shift+Tab ask-levels  /effort  /help",
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
