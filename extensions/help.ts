/**
 * /help — searchable, grouped feature documentation.
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
  formatTopicIndex,
  formatTopicPickerLines,
  formatCommandCatalog,
  getHelpArgumentCompletions,
} = require(join(root, "lib", "help-catalog.mjs"));

const PICKER_ACTIONS = new Set(["search", "commands"]);

export function registerHelp(pi: ExtensionAPI) {
  pi.registerCommand("help", {
    description: "Alloy help: /help [topic|search <query>|commands]",
    getArgumentCompletions: getHelpArgumentCompletions,
    handler: async (args, ctx) => {
      const raw = (args || "").trim();

      // No args → grouped topic picker
      if (!raw) {
        await browseHelp(pi, ctx);
        return;
      }

      if (/^search\b/i.test(raw)) {
        const q = raw.replace(/^search\s+/i, "").trim();
        if (!q) {
          const typed = await promptSearch(ctx);
          if (!typed) return;
          await showSearch(typed, pi, ctx);
          return;
        }
        await showSearch(q, pi, ctx);
        return;
      }

      if (raw.toLowerCase() === "commands") {
        await showCommands(pi.getCommands(), ctx);
        await maybeContinue(pi, ctx);
        return;
      }

      // Direct topic or free-text search
      const topic = getTopic(raw);
      if (topic) {
        await showTopic(topic.id, ctx);
        await maybeContinue(pi, ctx);
        return;
      }

      const hits = searchHelp(raw, { limit: 8 });
      if (!hits.length) {
        ctx.ui.notify(
          `No help matches for "${raw}". Try /help start or /help search <query>`,
          "warning",
        );
        return;
      }
      if (hits.length === 1 && hits[0].score >= 20) {
        await showTopic(hits[0].id, ctx);
        await maybeContinue(pi, ctx);
        return;
      }
      const items = hits.map(
        (h: { id: string; title: string; summary?: string }) =>
          `${h.id.padEnd(20)} ${h.summary || h.title}`,
      );
      const picked = await ctx.ui.select(`Help matches for “${raw}”`, items);
      if (!picked || isSectionHeader(picked)) return;
      const id = firstToken(picked);
      await showTopic(id, ctx);
      await maybeContinue(pi, ctx);
    },
  });

  pi.registerTool({
    name: "alloy_help",
    label: "Alloy Help",
    description:
      "Search Alloy documentation (start, workflows, sandbox, auto, fusion, memory, MCP, CLI, etc.).",
    promptSnippet: "Search Alloy help docs",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query or topic id" })),
      topic: Type.Optional(Type.String({ description: "Exact topic id" })),
    }),
    async execute(_id, params) {
      if (params.topic) {
        if (params.topic.toLowerCase() === "commands") {
          const commands = pi.getCommands();
          return {
            content: [{ type: "text", text: formatCommandCatalog(commands) }],
            details: { topic: "commands", commands },
          };
        }
        const t = getTopic(params.topic);
        return {
          content: [{ type: "text", text: formatTopic(t) }],
          details: { topic: params.topic },
        };
      }
      const q = params.query || "";
      if (!q) {
        return {
          content: [{ type: "text", text: formatTopicIndex() }],
          details: { topics: listTopics() },
        };
      }
      const direct = getTopic(q);
      if (direct) {
        if (direct.id === "commands") {
          const commands = pi.getCommands();
          return {
            content: [{ type: "text", text: formatCommandCatalog(commands) }],
            details: { topic: "commands", commands },
          };
        }
        return {
          content: [{ type: "text", text: formatTopic(direct) }],
          details: { topic: direct.id },
        };
      }
      const hits = searchHelp(q, { limit: 5 });
      if (!hits.length) {
        return {
          content: [
            {
              type: "text",
              text: `No help matches for: ${q}\n\nTry topic ids: start, workflows, auth, fusion, fission, auto, forge`,
            },
          ],
          details: { hits: [] },
        };
      }
      const text = hits
        .map(
          (h: {
            id: string;
            title: string;
            summary?: string;
            body: string;
            score: number;
          }) =>
            `## ${h.title} (${h.id})\n${h.summary || ""}\n\n${h.body.slice(0, 900)}`,
        )
        .join("\n\n");
      return { content: [{ type: "text", text }], details: { hits } };
    },
  });
}

function firstToken(line: string) {
  return String(line || "").trim().split(/\s+/)[0] || "";
}

function isSectionHeader(line: string) {
  const t = String(line || "").trim();
  return t.startsWith("──") || t.startsWith("Tip:") || t === "";
}

async function browseHelp(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      input: (t: string, p?: string) => Promise<string | undefined>;
      notify: (m: string, l?: string) => void;
    };
    hasUI?: boolean;
  },
) {
  const items = formatTopicPickerLines();
  const picked = await ctx.ui.select(
    "Alloy help — pick a topic (or search)",
    items,
  );
  if (!picked || isSectionHeader(picked)) return;

  const id = firstToken(picked);
  if (id === "search") {
    const q = await promptSearch(ctx);
    if (!q) return;
    await showSearch(q, pi, ctx);
    return;
  }
  if (id === "commands") {
    await showCommands(pi.getCommands(), ctx);
    await maybeContinue(pi, ctx);
    return;
  }
  if (PICKER_ACTIONS.has(id)) return;

  const topic = getTopic(id);
  if (!topic) {
    // User may have selected a tip line or malformed row
    ctx.ui.notify("Pick a topic id from the list, or choose “search”.", "info");
    return;
  }
  await showTopic(topic.id, ctx);
  await maybeContinue(pi, ctx);
}

async function promptSearch(ctx: {
  ui: { input: (t: string, p?: string) => Promise<string | undefined> };
}) {
  return ctx.ui.input(
    "Search help",
    "e.g. sandbox, fission, memory, docker, pack",
  );
}

async function maybeContinue(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      input: (t: string, p?: string) => Promise<string | undefined>;
      notify: (m: string, l?: string) => void;
    };
    hasUI?: boolean;
  },
) {
  if (ctx.hasUI === false) return;
  const next = await ctx.ui.select("Help", [
    "Browse all topics",
    "Search…",
    "Done",
  ]);
  if (!next || next === "Done") return;
  if (next.startsWith("Search")) {
    const q = await promptSearch(ctx);
    if (!q) return;
    await showSearch(q, pi, ctx);
    return;
  }
  await browseHelp(pi, ctx);
}

async function showCommands(
  commands: Array<{ name: string; description?: string; source: string }>,
  ctx: {
    ui: { select: (t: string, o: string[]) => Promise<string | undefined> };
    hasUI?: boolean;
  },
) {
  const text = formatCommandCatalog(commands);
  if (ctx.hasUI !== false) {
    await ctx.ui.select("All slash commands", text.split("\n"));
  } else {
    console.log(text);
  }
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
  pi: ExtensionAPI,
  ctx: {
    ui: {
      select: (t: string, o: string[]) => Promise<string | undefined>;
      input: (t: string, p?: string) => Promise<string | undefined>;
      notify: (m: string, l?: string) => void;
    };
    hasUI?: boolean;
  },
) {
  const hits = searchHelp(q, { limit: 10 });
  if (!hits.length) {
    ctx.ui.notify(
      `No matches for “${q}”. Try /help start or broader words.`,
      "warning",
    );
    return;
  }
  const items = hits.map(
    (h: { id: string; title: string; summary?: string }) =>
      `${h.id.padEnd(20)} ${h.summary || h.title}`,
  );
  const picked = await ctx.ui.select(`Search: ${q}`, items);
  if (!picked || isSectionHeader(picked)) return;
  await showTopic(firstToken(picked), ctx);
  await maybeContinue(pi, ctx);
}

// silence unused if tree-shaken
void HELP_TOPICS;
