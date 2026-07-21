/**
 * /help — searchable feature documentation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  HELP_TOPICS,
  listTopics,
  getTopic,
  searchHelp,
  formatTopic,
} = require(join(root, "lib", "help-catalog.mjs"));

export function registerHelp(pi: ExtensionAPI) {
  pi.registerCommand("help", {
    description: "Alloy help: /help [topic|search <query>]",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();

      // No args → topic picker
      if (!raw) {
        const items = [
          "search <query>  — search all help",
          "commands        — slash cheatsheet",
          ...listTopics().map(
            (t: { id: string; title: string }) => `${t.id.padEnd(14)} ${t.title}`,
          ),
        ];
        const picked = await ctx.ui.select("Alloy help — pick a topic", items);
        if (!picked) return;
        if (picked.startsWith("search")) {
          const q = await ctx.ui.input("Search help", "e.g. sandbox, memory, fusion");
          if (!q) return;
          await showSearch(q, ctx);
          return;
        }
        const id = picked.split(/\s+/)[0];
        await showTopic(id, ctx);
        return;
      }

      if (/^search\b/i.test(raw)) {
        const q = raw.replace(/^search\s+/i, "").trim();
        if (!q) {
          ctx.ui.notify("Usage: /help search <query>", "warning");
          return;
        }
        await showSearch(q, ctx);
        return;
      }

      // Direct topic or free-text search
      const topic = getTopic(raw);
      if (topic) {
        await showTopic(topic.id, ctx);
        return;
      }

      const hits = searchHelp(raw, { limit: 8 });
      if (!hits.length) {
        ctx.ui.notify(
          `No help matches for "${raw}". Try /help or /help commands`,
          "warning",
        );
        return;
      }
      if (hits.length === 1 && hits[0].score >= 20) {
        await showTopic(hits[0].id, ctx);
        return;
      }
      const items = hits.map(
        (h: { id: string; title: string; score: number }) =>
          `${h.id.padEnd(14)} ${h.title}  (${h.score})`,
      );
      const picked = await ctx.ui.select(`Help search: ${raw}`, items);
      if (!picked) return;
      await showTopic(picked.split(/\s+/)[0], ctx);
    },
  });

  pi.registerTool({
    name: "alloy_help",
    label: "Alloy Help",
    description:
      "Search Alloy documentation (commands, sandbox, auto, fusion, memory, MCP, etc.).",
    promptSnippet: "Search Alloy help docs",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query or topic id" })),
      topic: Type.Optional(Type.String({ description: "Exact topic id" })),
    }),
    async execute(_id, params) {
      if (params.topic) {
        const t = getTopic(params.topic);
        return {
          content: [{ type: "text", text: formatTopic(t) }],
          details: { topic: params.topic },
        };
      }
      const q = params.query || "";
      if (!q) {
        const index = listTopics()
          .map((t: { id: string; title: string }) => `- ${t.id}: ${t.title}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `Alloy help topics:\n${index}` }],
          details: { topics: listTopics() },
        };
      }
      const direct = getTopic(q);
      if (direct) {
        return {
          content: [{ type: "text", text: formatTopic(direct) }],
          details: { topic: direct.id },
        };
      }
      const hits = searchHelp(q, { limit: 5 });
      if (!hits.length) {
        return {
          content: [{ type: "text", text: `No help matches for: ${q}` }],
          details: { hits: [] },
        };
      }
      const text = hits
        .map(
          (h: { id: string; title: string; body: string; score: number }) =>
            `## ${h.title} (${h.id}, score ${h.score})\n${h.body.slice(0, 800)}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { hits } };
    },
  });
}

async function showTopic(
  id: string,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      notify: (m: string, l?: string) => void;
    };
    hasUI?: boolean;
  },
) {
  const topic = getTopic(id);
  if (!topic) {
    ctx.ui.notify(`Unknown topic: ${id}`, "warning");
    return;
  }
  const lines = formatTopic(topic).split("\n");
  if (ctx.hasUI !== false) {
    await ctx.ui.select(`Help: ${topic.title}`, lines);
  } else {
    console.log(formatTopic(topic));
  }
}

async function showSearch(
  q: string,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      notify: (m: string, l?: string) => void;
    };
  },
) {
  const hits = searchHelp(q, { limit: 10 });
  if (!hits.length) {
    ctx.ui.notify(`No matches for "${q}"`, "warning");
    return;
  }
  const items = hits.map(
    (h: { id: string; title: string; score: number }) =>
      `${h.id.padEnd(14)} ${h.title}`,
  );
  const picked = await ctx.ui.select(`Search: ${q}`, items);
  if (!picked) return;
  await showTopic(picked.split(/\s+/)[0], ctx);
}

// silence unused if tree-shaken
void HELP_TOPICS;
