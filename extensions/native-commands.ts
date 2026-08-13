/**
 * RPC-compatible replacements for commands implemented by Pi's interactive TUI.
 */

import {
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
  type SessionInfo,
  type SessionMessageEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

export interface FlatSessionTreeEntry {
  entry: SessionEntry;
  depth: number;
}

type SessionLister = {
  list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
  listAll(sessionDir?: string): Promise<SessionInfo[]>;
};

const SHOW_ALL_SESSIONS = "Show all sessions";

export const OPEN_TUI_HOTKEYS = [
  "Enter        Send a prompt, or interrupt and update a thinking model",
  "Shift+Enter  Insert a newline",
  "Shift+Tab    Toggle Build / Plan mode",
  "PageUp/Down  Scroll the transcript one page",
  "Ctrl+U/D     Scroll the transcript half a page",
  "Ctrl+C       Cancel a dialog, abort an active run, or exit when idle",
  "Ctrl+Shift+A Open the most recent sub-agent transcript",
  "Up/Down      Move through extension command choices",
  "Y/N          Confirm or deny a confirmation dialog",
  "Esc          Abort the thinking model, cancel a dialog, or dismiss a notice",
];

export function flattenSessionTree(tree: SessionTreeNode[]): FlatSessionTreeEntry[] {
  const flat: FlatSessionTreeEntry[] = [];
  const stack = [...tree]
    .reverse()
    .map((node) => ({ node, depth: 0 }));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    flat.push({ entry: current.node.entry, depth: current.depth });
    for (let index = current.node.children.length - 1; index >= 0; index--) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }

  return flat;
}

export function formatSessionOption(session: SessionInfo): string {
  const title = singleLine(session.name || session.firstMessage || "(empty session)");
  const project = session.cwd || "(unknown project)";
  const count = `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`;
  return `${title} | ${count} | ${project} | ${session.id}`;
}

export function formatTreeOption(
  item: FlatSessionTreeEntry,
  currentLeafId?: string | null,
): string {
  const current = item.entry.id === currentLeafId ? "current " : "";
  const indent = "  ".repeat(item.depth);
  return `${indent}${current}${describeEntry(item.entry)} | ${item.entry.id}`;
}

export function getUserMessageEntries(entries: SessionEntry[]): SessionMessageEntry[] {
  return entries.filter(
    (entry): entry is SessionMessageEntry =>
      entry.type === "message" && entry.message.role === "user",
  );
}

export function formatUserMessageOption(
  entry: SessionMessageEntry,
  index: number,
  total: number,
): string {
  return `${index + 1}/${total} ${messageText(entry)} | ${entry.id}`;
}

export function registerNativeCommands(
  pi: ExtensionAPI,
  sessions: SessionLister = SessionManager,
) {
  pi.registerCommand("resume", {
    description: "Resume a session from this project or all projects",
    handler: async (_args, ctx) => {
      try {
        const current = await sessions.list(
          ctx.sessionManager.getCwd(),
          ctx.sessionManager.getSessionDir(),
        );
        const currentOptions = current.map(formatSessionOption);
        const choice = await ctx.ui.select("Resume session", [
          ...currentOptions,
          SHOW_ALL_SESSIONS,
        ]);
        if (!choice) return;

        if (choice !== SHOW_ALL_SESSIONS) {
          const selected = current[currentOptions.indexOf(choice)];
          if (selected) await ctx.switchSession(selected.path);
          return;
        }

        const manager = ctx.sessionManager as typeof ctx.sessionManager & {
          usesDefaultSessionDir?: () => boolean;
        };
        const all = manager.usesDefaultSessionDir?.() === false
          ? await sessions.listAll(ctx.sessionManager.getSessionDir())
          : await sessions.listAll();
        if (all.length === 0) {
          ctx.ui.notify("No sessions found.", "info");
          return;
        }

        const allOptions = all.map(formatSessionOption);
        const allChoice = await ctx.ui.select("Resume session from all projects", allOptions);
        if (!allChoice) return;
        const selected = all[allOptions.indexOf(allChoice)];
        if (selected) await ctx.switchSession(selected.path);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("tree", {
    description: "Navigate to an entry in the current session tree",
    handler: async (_args, ctx) => {
      try {
        const flat = flattenSessionTree(ctx.sessionManager.getTree());
        if (flat.length === 0) {
          ctx.ui.notify("No entries in the current session.", "info");
          return;
        }

        const options = flat.map((item) =>
          formatTreeOption(item, ctx.sessionManager.getLeafId()),
        );
        const choice = await ctx.ui.select("Session tree", options);
        if (!choice) return;
        const selected = flat[options.indexOf(choice)];
        if (selected) await ctx.navigateTree(selected.entry.id);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("fork", {
    description: "Fork the current session from a user message",
    handler: async (_args, ctx) => {
      try {
        const messages = getUserMessageEntries(ctx.sessionManager.getBranch());
        if (messages.length === 0) {
          ctx.ui.notify("No user messages to fork from.", "info");
          return;
        }

        const options = messages.map((entry, index) =>
          formatUserMessageOption(entry, index, messages.length),
        );
        const choice = await ctx.ui.select("Fork from user message", options);
        if (!choice) return;
        const selected = messages[options.indexOf(choice)];
        if (selected) await ctx.fork(selected.id);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("name", {
    description: "Set the current session name: /name [name]",
    handler: async (args, ctx) => {
      try {
        const argument = (args || "").trim();
        const input = argument || await ctx.ui.input("Session name", "Enter a session name");
        const name = input?.trim();
        if (!name) return;
        await pi.setSessionName(name);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerCommand("hotkeys", {
    description: "Show OpenTUI keyboard shortcuts",
    handler: async (_args, ctx) => {
      try {
        await ctx.ui.select("OpenTUI hotkeys", OPEN_TUI_HOTKEYS);
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function messageText(entry: SessionMessageEntry): string {
  const message = entry.message;
  if (!("content" in message)) {
    if ("command" in message) return `!${message.command}`;
    if ("summary" in message) return singleLine(message.summary);
    return "(message)";
  }

  const content = message.content;
  if (typeof content === "string") return singleLine(content) || "(empty message)";
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  return singleLine(text) || "(attachment)";
}

function describeEntry(entry: SessionEntry): string {
  if (entry.type === "message") {
    const role = entry.message.role;
    return `${role}: ${messageText(entry)}`;
  }
  if (entry.type === "model_change") return `model: ${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return `thinking: ${entry.thinkingLevel}`;
  if (entry.type === "compaction") return `compaction: ${singleLine(entry.summary)}`;
  if (entry.type === "branch_summary") return `branch summary: ${singleLine(entry.summary)}`;
  if (entry.type === "session_info") return `session name: ${entry.name || "(cleared)"}`;
  if (entry.type === "custom_message") return `custom message: ${contentText(entry.content)}`;
  if (entry.type === "custom") return `custom: ${entry.customType}`;
  if (entry.type === "label") return `label: ${entry.label || "(cleared)"}`;
  return "entry";
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return singleLine(content) || "(empty message)";
  const text = content.map((part) => part.text || "").join(" ");
  return singleLine(text) || "(attachment)";
}

function notifyError(ctx: { ui: { notify(message: string, type: "error"): void } }, error: unknown) {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}
