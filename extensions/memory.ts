/**
 * Durable memory across sessions.
 * Commands: /remember, /memory
 * Tools: alloy_remember, alloy_memory_search
 * Injects project+user memory into the system prompt each turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadLib(name: string) {
  // Prefer package lib/ (plain .mjs — no TS compile step)
  return require(join(root, "lib", name));
}

const {
  listMemory,
  remember,
  forget,
  searchMemory,
  formatMemoryForPrompt,
} = loadLib("memory-store.mjs");
const { loadConfig } = loadLib("config.mjs");

export function registerMemory(pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerCommand("remember", {
    description: "Save a durable fact: /remember [user:] <text>",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /remember <fact>   or   /remember user: <fact>", "warning");
        return;
      }
      let scope: "project" | "user" = "project";
      let text = raw;
      if (/^user:\s*/i.test(raw)) {
        scope = "user";
        text = raw.replace(/^user:\s*/i, "");
      }
      const entry = remember(text, { scope, cwd: process.cwd() });
      ctx.ui.notify(`Remembered (${entry.scope}): ${entry.id}`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "List/search/forget durable memory: /memory [search <q>|forget <id>|list]",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw || raw === "list") {
        const entries = listMemory(process.cwd());
        if (!entries.length) {
          ctx.ui.notify("No durable memory yet. Use /remember <fact>.", "info");
          return;
        }
        const lines = entries.map(
          (e: { scope: string; id: string; text: string }) =>
            `[${e.scope}/${e.id}] ${e.text.slice(0, 120)}`,
        );
        await ctx.ui.select(`Durable memory (${entries.length})`, lines);
        return;
      }
      if (raw.startsWith("search ")) {
        const q = raw.slice("search ".length).trim();
        const hits = searchMemory(q, process.cwd());
        if (!hits.length) {
          ctx.ui.notify(`No matches for "${q}"`, "info");
          return;
        }
        await ctx.ui.select(
          `Memory search: ${q}`,
          hits.map(
            (e: { scope: string; id: string; text: string }) =>
              `[${e.scope}/${e.id}] ${e.text.slice(0, 120)}`,
          ),
        );
        return;
      }
      if (raw.startsWith("forget ")) {
        const id = raw.slice("forget ".length).trim();
        const result = forget(id, process.cwd());
        if (result.ambiguous) {
          ctx.ui.notify(
            `Ambiguous id. Matches: ${result.matches.map((m: { id: string }) => m.id).join(", ")}`,
            "warning",
          );
          return;
        }
        if (!result.removed) {
          ctx.ui.notify(`Nothing to forget for "${id}"`, "warning");
          return;
        }
        ctx.ui.notify(`Forgot ${result.matches[0].id}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /memory list | /memory search <q> | /memory forget <id>", "warning");
    },
  });

  pi.registerTool({
    name: "alloy_remember",
    label: "Alloy Remember",
    description:
      "Save a durable fact to Alloy memory that persists across sessions. Use for stable project facts, preferences, and decisions.",
    promptSnippet: "Save durable cross-session memory",
    promptGuidelines: [
      "Use alloy_remember for facts that should survive /new and new days.",
      "Do not store secrets, API keys, or credentials in memory.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Fact to remember" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("user")], {
          description: "project (default) or user-global",
        }),
      ),
    }),
    async execute(_id, params) {
      const entry = remember(params.text, {
        scope: params.scope === "user" ? "user" : "project",
        cwd: process.cwd(),
      });
      return {
        content: [
          {
            type: "text",
            text: `Saved memory ${entry.scope}/${entry.id}`,
          },
        ],
        details: entry,
      };
    },
  });

  pi.registerTool({
    name: "alloy_memory_search",
    label: "Alloy Memory Search",
    description: "Search durable Alloy memory for facts from prior sessions.",
    promptSnippet: "Search durable cross-session memory",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, params) {
      const hits = searchMemory(params.query, process.cwd());
      const text =
        hits.length === 0
          ? "No matches."
          : hits
              .map(
                (e: { scope: string; id: string; text: string }) =>
                  `[${e.scope}/${e.id}] ${e.text}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { count: hits.length },
      };
    },
  });

  if (config.memory?.enabled !== false && config.memory?.autoLoad !== false) {
    pi.on("before_agent_start", async (event) => {
      const entries = listMemory(process.cwd());
      if (!entries.length) return;
      const block = formatMemoryForPrompt(
        entries,
        config.memory?.maxInjectChars ?? 6000,
      );
      if (!block) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${block}`,
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      const n = listMemory(process.cwd()).length;
      if (n > 0) {
        ctx.ui.setStatus("alloy-memory", `memory:${n}`);
      }
    } catch {
      // ignore
    }
  });
}
