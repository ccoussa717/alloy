/**
 * /effort — thinking / reasoning level (was Shift+Tab in stock Pi).
 * Levels: off | minimal | low | medium | high | xhigh | max
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type Level = (typeof LEVELS)[number];

function normalize(raw: string): Level | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // friendly aliases
  const map: Record<string, Level> = {
    off: "off",
    none: "off",
    "0": "off",
    minimal: "minimal",
    min: "minimal",
    low: "low",
    "1": "low",
    medium: "medium",
    med: "medium",
    mid: "medium",
    "2": "medium",
    high: "high",
    "3": "high",
    xhigh: "xhigh",
    "extra-high": "xhigh",
    "extra": "xhigh",
    "4": "xhigh",
    max: "max",
    maximum: "max",
    "5": "max",
  };
  return map[s] || (LEVELS.includes(s as Level) ? (s as Level) : null);
}

export function registerEffort(pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description:
      "Thinking/effort level: /effort [off|minimal|low|medium|high|xhigh|max]  (replaces Shift+Tab for thinking)",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      const current = (() => {
        try {
          return pi.getThinkingLevel?.() ?? "(unknown)";
        } catch {
          return "(unknown)";
        }
      })();

      if (!raw || raw === "status" || raw === "show") {
        const lines = [
          `Current effort/thinking: ${current}`,
          "",
          "Levels:",
          ...LEVELS.map((l) => `  ${l === current ? "→" : " "} ${l}`),
          "",
          "Usage: /effort high",
          "Note: Shift+Tab cycles permissions (ask levels), not effort.",
        ];
        if (ctx.hasUI) await ctx.ui.select("Effort / thinking", lines);
        else console.log(lines.join("\n"));
        return;
      }

      if (raw === "cycle" || raw === "next") {
        try {
          const cur = String(pi.getThinkingLevel?.() || "off");
          const idx = LEVELS.indexOf(cur as Level);
          const next = LEVELS[(idx < 0 ? 0 : idx + 1) % LEVELS.length];
          pi.setThinkingLevel?.(next);
          ctx.ui.notify(`Effort → ${next}`, "info");
          ctx.ui.setStatus?.(
            "alloy-effort",
            ctx.ui.theme?.fg
              ? ctx.ui.theme.fg("accent", `effort:${next}`)
              : `effort:${next}`,
          );
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "warning");
        }
        return;
      }

      const level = normalize(raw);
      if (!level) {
        ctx.ui.notify(
          `Unknown effort: ${raw}\nUse: ${LEVELS.join(" | ")}`,
          "warning",
        );
        return;
      }

      try {
        pi.setThinkingLevel?.(level);
        ctx.ui.notify(`Effort → ${level}`, "info");
        ctx.ui.setStatus?.(
          "alloy-effort",
          ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("accent", `effort:${level}`)
            : `effort:${level}`,
        );
      } catch (err) {
        ctx.ui.notify(
          `Could not set effort: ${(err as Error).message || err}\nModel may not support thinking levels.`,
          "warning",
        );
      }
    },
  });

  // Alias
  pi.registerCommand("thinking", {
    description: "Alias for /effort",
    handler: async (args, ctx) => {
      // Delegate by re-invoking is awkward; duplicate thin call
      const raw = (args || "").trim();
      if (!raw) {
        try {
          ctx.ui.notify(`Thinking: ${pi.getThinkingLevel?.()}`, "info");
        } catch {
          ctx.ui.notify("Use /effort", "info");
        }
        return;
      }
      const level = normalize(raw);
      if (!level) {
        ctx.ui.notify(`Unknown: ${raw}. /effort [level]`, "warning");
        return;
      }
      try {
        pi.setThinkingLevel?.(level);
        ctx.ui.notify(`Effort → ${level}`, "info");
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      const level = pi.getThinkingLevel?.();
      if (level) {
        ctx.ui.setStatus(
          "alloy-effort",
          ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("dim", `effort:${level}`)
            : `effort:${level}`,
        );
      }
    } catch {
      // ignore
    }
  });

  pi.on("thinking_level_select", (event, ctx) => {
    try {
      const level = (event as { level?: string }).level || pi.getThinkingLevel?.();
      if (level) {
        ctx.ui.setStatus(
          "alloy-effort",
          ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("dim", `effort:${level}`)
            : `effort:${level}`,
        );
      }
    } catch {
      // ignore
    }
  });
}
