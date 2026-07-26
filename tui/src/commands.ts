import type { ModelInfo, SlashCommand } from "./session-store";
import type { RpcMessage } from "./rpc-client";

export interface CommandContext {
  isStreaming: boolean;
  commands: SlashCommand[];
  models: ModelInfo[];
}

export type LocalDialog = "help" | "model" | "thinking" | "session" | "export";

export type SubmissionResolution =
  | { kind: "none" }
  | { kind: "exit"; clearInput: true }
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
    if (!args) return { kind: "dialog", dialog: "model", clearInput: true };
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
