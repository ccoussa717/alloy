import type { ModelInfo, SlashCommand } from "./session-store";
import type { RpcMessage } from "./rpc-client";

export interface CommandContext {
  isStreaming: boolean;
  commands: SlashCommand[];
  models: ModelInfo[];
}

export interface CommandSuggestion {
  name: string;
  description: string;
  aliases: string[];
  source: "local" | NonNullable<SlashCommand["source"]>;
}

export type LocalDialog = "help" | "model-provider" | "model" | "thinking" | "session" | "export";

export type SubmissionResolution =
  | { kind: "none" }
  | { kind: "exit"; clearInput: true }
  | { kind: "toggle-sidebar"; clearInput: true }
  | { kind: "dialog"; dialog: LocalDialog; clearInput: true }
  | { kind: "error"; message: string }
  | {
      kind: "request";
      request: RpcMessage;
      clearInput: true;
      refresh?: boolean;
      resultDialog?: "session" | "export";
    };

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const LOCAL_COMMANDS: CommandSuggestion[] = [
  { name: "help", description: "Show Alloy help", aliases: [], source: "local" },
  { name: "new", description: "Start a new session", aliases: [], source: "local" },
  { name: "clone", description: "Clone the current session", aliases: [], source: "local" },
  { name: "compact", description: "Compact session context", aliases: [], source: "local" },
  { name: "session", description: "Show session statistics", aliases: [], source: "local" },
  { name: "export", description: "Export the session to HTML", aliases: [], source: "local" },
  { name: "model", description: "Select the active model", aliases: [], source: "local" },
  { name: "thinking", description: "Select the thinking level", aliases: [], source: "local" },
  { name: "sidebar", description: "Toggle workspace sidebar", aliases: [], source: "local" },
  { name: "quit", description: "Exit Alloy", aliases: ["exit", "q"], source: "local" },
];

function fuzzySubsequence(query: string, value: string): boolean {
  let index = 0;
  for (const character of value) {
    if (character === query[index]) index++;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

function suggestionScore(query: string, suggestion: CommandSuggestion): number | null {
  if (!query) return 0;
  const names = [suggestion.name, ...suggestion.aliases].map((value) => value.toLowerCase());
  if (names.some((value) => value === query)) return 0;
  if (names.some((value) => value.startsWith(query))) return 1;
  if (names.some((value) => value.includes(query))) return 2;
  if (names.some((value) => fuzzySubsequence(query, value))) return 3;
  if (suggestion.description.toLowerCase().includes(query)) return 4;
  return null;
}

export function commandSuggestions(input: string, commands: SlashCommand[], limit = 50): CommandSuggestion[] {
  const match = input.match(/^\/([^\s/]*)$/);
  if (!match) return [];
  const query = (match[1] ?? "").toLowerCase();
  const merged = new Map<string, CommandSuggestion>();
  const reservedLocalNames = new Set(LOCAL_COMMANDS.flatMap((command) => [command.name, ...command.aliases]));
  for (const command of LOCAL_COMMANDS) merged.set(command.name, command);
  for (const command of commands) {
    const name = command.name.replace(/^\//, "").toLowerCase();
    if (!name || reservedLocalNames.has(name) || merged.has(name)) continue;
    merged.set(name, {
      name,
      description: command.description?.trim() || `${command.source ?? "registered"} command`,
      aliases: [],
      source: command.source ?? "extension",
    });
  }
  return [...merged.values()]
    .map((suggestion) => ({ suggestion, score: suggestionScore(query, suggestion) }))
    .filter((entry): entry is { suggestion: CommandSuggestion; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.suggestion.name.localeCompare(b.suggestion.name))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.suggestion);
}

export function commandCompletion(suggestion: Pick<CommandSuggestion, "name">): string {
  return `/${suggestion.name} `;
}

export function isExactCommandSuggestion(input: string, suggestion: Pick<CommandSuggestion, "name" | "aliases">): boolean {
  const value = input.match(/^\/([^\s/]*)$/)?.[1]?.toLowerCase();
  return value === suggestion.name || suggestion.aliases.includes(value ?? "");
}

function request(request: RpcMessage, options: Partial<Extract<SubmissionResolution, { kind: "request" }>> = {}) {
  return { kind: "request", request, clearInput: true, ...options } as const;
}

export function resolveSubmission(input: string, context: CommandContext): SubmissionResolution {
  const value = input.trim();
  if (!value) return { kind: "none" };

  const firstSpace = value.indexOf(" ");
  const name = (firstSpace === -1 ? value : value.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? "" : value.slice(firstSpace + 1).trim();

  if (name === "/quit" || name === "/exit" || name === "/q") return { kind: "exit", clearInput: true };
  if (name === "/help" && !args) return { kind: "dialog", dialog: "help", clearInput: true };
  if (name === "/new") return request({ type: "new_session" }, { refresh: true });
  if (name === "/clone") return request({ type: "clone" }, { refresh: true });
  if (name === "/compact") {
    return request({ type: "compact", ...(args ? { customInstructions: args } : {}) });
  }
  if (name === "/session") {
    return request({ type: "get_session_stats" }, { resultDialog: "session" });
  }
  if (name === "/export") {
    if (args) return { kind: "error", message: "OpenTUI /export does not accept a path; use --legacy-pi-ui for path or JSONL export." };
    return request({ type: "export_html" }, { resultDialog: "export" });
  }
  if (name === "/model") {
    if (!args) return { kind: "dialog", dialog: "model-provider", clearInput: true };
    const exact = context.models.find((model) => `${model.provider}/${model.id}` === args || model.id === args);
    const slash = args.indexOf("/");
    const provider = exact?.provider ?? (slash > 0 ? args.slice(0, slash) : undefined);
    const modelId = exact?.id ?? (slash > 0 ? args.slice(slash + 1) : undefined);
    if (!provider || !modelId) return { kind: "error", message: `Unknown model: ${args}` };
    return request({ type: "set_model", provider, modelId });
  }
  if (name === "/thinking") {
    if (!args) return { kind: "dialog", dialog: "thinking", clearInput: true };
    if (!THINKING_LEVELS.includes(args as (typeof THINKING_LEVELS)[number])) {
      return { kind: "error", message: `Unknown thinking level: ${args}` };
    }
    return request({ type: "set_thinking_level", level: args });
  }
  if (name === "/sidebar" && !args) return { kind: "toggle-sidebar", clearInput: true };

  if (name.startsWith("/")) {
    const commandName = name.slice(1);
    const registered = context.commands.find((command) => command.name.replace(/^\//, "").toLowerCase() === commandName);
    if (!registered) return { kind: "error", message: `Unknown command: ${name}` };
    if (registered.source === "extension") {
      return request({ type: "prompt", message: value }, { refresh: true });
    }
  }

  return request({ type: context.isStreaming ? "steer" : "prompt", message: value });
}
