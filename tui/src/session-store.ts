import { redactDisplayText } from "./content";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type QueueMode = "all" | "one-at-a-time";

export interface SessionMessage {
  id?: string;
  role?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name?: string;
  [key: string]: unknown;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source?: "extension" | "prompt" | "skill";
  [key: string]: unknown;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  [key: string]: unknown;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  status: "running" | "completed" | "error";
}

export interface WidgetState {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface NotificationState {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface ExtensionDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

export interface ExtensionDialogQueue {
  order: string[];
  byId: Record<string, ExtensionDialog>;
}

export interface SessionState {
  messages: SessionMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  retry: RetryState | null;
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  pendingSteering: string[];
  pendingFollowUp: string[];
  toolExecutions: Record<string, ToolExecution>;
  statuses: Record<string, string>;
  widgets: Record<string, WidgetState>;
  notifications: NotificationState[];
  toasts: NotificationState[];
  editorText: string;
  title: string;
  extensionDialogs: ExtensionDialogQueue;
  commands: SlashCommand[];
  availableModels: ModelInfo[];
  sessionStats: SessionStats | null;
  backendError: string | null;
  fatalError: string | null;
  currentAssistantMessageId: string | null;
}

export interface RpcMessage {
  type: string;
  [key: string]: unknown;
}

interface RpcSessionSnapshot {
  model?: ModelInfo;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

const CURRENT_ASSISTANT_FALLBACK = "assistant:current";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function messageKey(message: SessionMessage): string | null {
  if (typeof message.id === "string") return `id:${message.id}`;
  if (typeof message.toolCallId === "string") return `tool:${message.toolCallId}`;
  if (typeof message.role === "string" && typeof message.timestamp === "number") {
    return `${message.role}:${message.timestamp}`;
  }
  return null;
}

function findCurrentAssistant(messages: SessionMessage[], currentId: string | null): number {
  if (currentId && currentId !== CURRENT_ASSISTANT_FALLBACK) {
    const explicitIndex = messages.findIndex((candidate) => candidate.id === currentId);
    if (explicitIndex >= 0) return explicitIndex;
  }
  return messages.findLastIndex((candidate) => candidate.role === "assistant");
}

function upsertMessage(
  state: SessionState,
  message: SessionMessage,
  phase: "start" | "update" | "end",
): SessionState {
  const nextMessage = { ...message };
  const explicitId = typeof message.id === "string" ? message.id : null;
  let index = -1;
  let currentAssistantMessageId = state.currentAssistantMessageId;

  if (message.role === "assistant") {
    if (currentAssistantMessageId === null) {
      const key = messageKey(message);
      index = explicitId
        ? state.messages.findIndex((candidate) => candidate.id === explicitId)
        : phase === "end" && key
          ? state.messages.findIndex((candidate) => messageKey(candidate) === key)
          : -1;
    } else {
      index = explicitId
        ? state.messages.findIndex((candidate) => candidate.id === explicitId)
        : findCurrentAssistant(state.messages, currentAssistantMessageId);
      if (index < 0 && explicitId && currentAssistantMessageId !== null) {
        index = findCurrentAssistant(state.messages, currentAssistantMessageId);
      }
    }
    currentAssistantMessageId = explicitId ?? currentAssistantMessageId ?? CURRENT_ASSISTANT_FALLBACK;
  } else {
    const key = messageKey(message);
    if (key) index = state.messages.findIndex((candidate) => messageKey(candidate) === key);
  }

  const messages = [...state.messages];
  if (index >= 0) messages[index] = nextMessage;
  else messages.push(nextMessage);

  return {
    ...state,
    messages,
    messageCount: messages.length,
    currentAssistantMessageId: phase === "end" && message.role === "assistant" ? null : currentAssistantMessageId,
  };
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function emptyExtensionDialogs(): ExtensionDialogQueue {
  return { order: [], byId: {} };
}

function hasOwn<T>(record: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function queueExtensionDialog(queue: ExtensionDialogQueue, dialog: ExtensionDialog): ExtensionDialogQueue {
  return {
    order: hasOwn(queue.byId, dialog.id) ? queue.order : [...queue.order, dialog.id],
    byId: { ...queue.byId, [dialog.id]: dialog },
  };
}

function removeExtensionDialog(queue: ExtensionDialogQueue, id: string): ExtensionDialogQueue {
  if (!hasOwn(queue.byId, id)) return queue;
  return {
    order: queue.order.filter((dialogId) => dialogId !== id),
    byId: omitKey(queue.byId, id),
  };
}

export function activeExtensionDialog(state: SessionState): ExtensionDialog | null {
  const id = state.extensionDialogs.order[0];
  return id ? state.extensionDialogs.byId[id] ?? null : null;
}

function errorText(value: unknown, fallback: string): string {
  if (typeof value === "string") return redactDisplayText(value);
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return redactDisplayText(value.message);
  }
  return fallback;
}

export function createInitialState(): SessionState {
  const notifications: NotificationState[] = [];
  return {
    messages: [],
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    retry: null,
    model: null,
    thinkingLevel: "off",
    sessionId: null,
    sessionFile: null,
    sessionName: null,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: false,
    messageCount: 0,
    pendingMessageCount: 0,
    pendingSteering: [],
    pendingFollowUp: [],
    toolExecutions: {},
    statuses: {},
    widgets: {},
    notifications,
    toasts: notifications,
    editorText: "",
    title: "",
    extensionDialogs: emptyExtensionDialogs(),
    commands: [],
    availableModels: [],
    sessionStats: null,
    backendError: null,
    fatalError: null,
    currentAssistantMessageId: null,
  };
}

export function reduceRpcMessage(state: SessionState, message: RpcMessage): SessionState {
  if (message.type === "response") {
    if (message.success === false) {
      return { ...state, backendError: errorText(message.error, "Backend command failed") };
    }
    if (message.success !== true) return state;

    switch (message.command) {
      case "get_state": {
        const data = message.data as RpcSessionSnapshot;
        const sessionChanged = state.sessionId !== data.sessionId;
        const current = sessionChanged
          ? {
              ...state,
              messages: [],
              toolExecutions: {},
              widgets: {},
              statuses: {},
              notifications: [],
              toasts: [],
              editorText: "",
              title: "",
              extensionDialogs: emptyExtensionDialogs(),
              currentAssistantMessageId: null,
            }
          : state;
        return {
          ...current,
          model: data.model ?? null,
          thinkingLevel: data.thinkingLevel,
          isStreaming: data.isStreaming,
          isCompacting: data.isCompacting,
          steeringMode: data.steeringMode,
          followUpMode: data.followUpMode,
          sessionFile: data.sessionFile ?? null,
          sessionId: data.sessionId,
          sessionName: data.sessionName ?? null,
          autoCompactionEnabled: data.autoCompactionEnabled,
          messageCount: data.messageCount,
          pendingMessageCount: data.pendingMessageCount,
          backendError: null,
        };
      }
      case "get_messages": {
        const data = message.data as { messages?: SessionMessage[] };
        const messages = Array.isArray(data.messages) ? data.messages.map((item) => ({ ...item })) : [];
        return {
          ...state,
          messages,
          messageCount: messages.length,
          toolExecutions: {},
          currentAssistantMessageId: null,
          backendError: null,
        };
      }
      case "get_commands": {
        const data = message.data as { commands?: SlashCommand[] };
        return {
          ...state,
          commands: Array.isArray(data.commands) ? data.commands.map((item) => ({ ...item })) : [],
          backendError: null,
        };
      }
      case "get_available_models": {
        const data = message.data as { models?: ModelInfo[] };
        return {
          ...state,
          availableModels: Array.isArray(data.models) ? data.models.map((item) => ({ ...item })) : [],
          backendError: null,
        };
      }
      case "get_session_stats":
        return { ...state, sessionStats: message.data as SessionStats, backendError: null };
      case "set_model":
        return { ...state, model: message.data as ModelInfo, backendError: null };
      case "cycle_model": {
        const data = message.data as { model?: ModelInfo; thinkingLevel?: ThinkingLevel } | null;
        return data
          ? {
              ...state,
              model: data.model ?? state.model,
              thinkingLevel: data.thinkingLevel ?? state.thinkingLevel,
              backendError: null,
            }
          : state;
      }
      case "cycle_thinking_level": {
        const data = message.data as { level?: ThinkingLevel } | null;
        return data?.level ? { ...state, thinkingLevel: data.level, backendError: null } : state;
      }
      default:
        return state;
    }
  }

  switch (message.type) {
    case "agent_start":
      return { ...state, isStreaming: true, backendError: null };
    case "agent_end":
    case "agent_settled":
      return { ...state, isStreaming: false, toolExecutions: {}, currentAssistantMessageId: null };
    case "message_start":
    case "message_update":
    case "message_end":
      return message.message && typeof message.message === "object"
        ? upsertMessage(state, message.message as SessionMessage, message.type.slice(8) as "start" | "update" | "end")
        : state;
    case "queue_update": {
      const pendingSteering = Array.isArray(message.steering)
        ? message.steering.filter((item): item is string => typeof item === "string")
        : [];
      const pendingFollowUp = Array.isArray(message.followUp)
        ? message.followUp.filter((item): item is string => typeof item === "string")
        : [];
      return {
        ...state,
        pendingSteering,
        pendingFollowUp,
        pendingMessageCount: pendingSteering.length + pendingFollowUp.length,
      };
    }
    case "compaction_start":
      return { ...state, isCompacting: true };
    case "compaction_end":
      return {
        ...state,
        isCompacting: false,
        backendError: message.errorMessage
          ? errorText(message.errorMessage, "Compaction failed")
          : state.backendError,
      };
    case "auto_retry_start":
      return {
        ...state,
        isRetrying: true,
        retry: {
          attempt: typeof message.attempt === "number" ? message.attempt : 0,
          maxAttempts: typeof message.maxAttempts === "number" ? message.maxAttempts : 0,
          delayMs: typeof message.delayMs === "number" ? message.delayMs : 0,
          errorMessage: asString(message.errorMessage),
        },
      };
    case "auto_retry_end":
      return {
        ...state,
        isRetrying: false,
        retry: null,
        backendError: message.success === false && message.finalError
          ? errorText(message.finalError, "Retry failed")
          : state.backendError,
      };
    case "thinking_level_changed":
      return typeof message.level === "string"
        ? { ...state, thinkingLevel: message.level as ThinkingLevel }
        : state;
    case "session_info_changed":
      return { ...state, sessionName: typeof message.name === "string" ? message.name : null };
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const toolCallId = asString(message.toolCallId);
      if (!toolCallId) return state;
      if (message.type === "tool_execution_end") {
        return { ...state, toolExecutions: omitKey(state.toolExecutions, toolCallId) };
      }
      const previous = state.toolExecutions[toolCallId];
      const execution: ToolExecution = {
        ...(previous ?? {
          toolCallId,
          toolName: asString(message.toolName),
          status: "running",
        }),
        toolCallId,
        toolName: asString(message.toolName, previous?.toolName),
        status: "running",
      };
      if ("args" in message) execution.args = message.args;
      if ("partialResult" in message) execution.partialResult = message.partialResult;
      if ("result" in message) execution.result = message.result;
      if ("isError" in message) execution.isError = message.isError === true;
      return {
        ...state,
        toolExecutions: { ...state.toolExecutions, [toolCallId]: execution },
      };
    }
    case "extension_ui_response":
      return typeof message.id === "string"
        ? { ...state, extensionDialogs: removeExtensionDialog(state.extensionDialogs, message.id) }
        : state;
    case "extension_ui_request": {
      const id = asString(message.id);
      switch (message.method) {
        case "select":
          return {
            ...state,
            extensionDialogs: queueExtensionDialog(state.extensionDialogs, {
              id,
              method: "select",
              title: asString(message.title),
              options: Array.isArray(message.options)
                ? message.options.filter((item): item is string => typeof item === "string")
                : [],
              timeout: typeof message.timeout === "number" ? message.timeout : undefined,
            }),
          };
        case "confirm":
          return {
            ...state,
            extensionDialogs: queueExtensionDialog(state.extensionDialogs, {
              id,
              method: "confirm",
              title: asString(message.title),
              message: asString(message.message),
              timeout: typeof message.timeout === "number" ? message.timeout : undefined,
            }),
          };
        case "input":
          return {
            ...state,
            extensionDialogs: queueExtensionDialog(state.extensionDialogs, {
              id,
              method: "input",
              title: asString(message.title),
              placeholder: typeof message.placeholder === "string" ? message.placeholder : undefined,
              timeout: typeof message.timeout === "number" ? message.timeout : undefined,
            }),
          };
        case "editor":
          return {
            ...state,
            extensionDialogs: queueExtensionDialog(state.extensionDialogs, {
              id,
              method: "editor",
              title: asString(message.title),
              prefill: typeof message.prefill === "string" ? message.prefill : undefined,
              timeout: typeof message.timeout === "number" ? message.timeout : undefined,
            }),
          };
        case "notify": {
          const notification: NotificationState = {
            id,
            message: redactDisplayText(asString(message.message)),
            type: message.notifyType === "warning" || message.notifyType === "error" ? message.notifyType : "info",
          };
          const notifications = [...state.notifications, notification];
          return { ...state, notifications, toasts: notifications };
        }
        case "setStatus": {
          const key = asString(message.statusKey);
          if (!key) return state;
          return {
            ...state,
            statuses: message.statusText === undefined
              ? omitKey(state.statuses, key)
              : { ...state.statuses, [key]: asString(message.statusText) },
          };
        }
        case "setWidget": {
          const key = asString(message.widgetKey);
          if (!key) return state;
          if (message.widgetLines === undefined) {
            return { ...state, widgets: omitKey(state.widgets, key) };
          }
          if (!Array.isArray(message.widgetLines)) return state;
          const previous = state.widgets[key];
          const placement = message.widgetPlacement === "belowEditor" || message.widgetPlacement === "aboveEditor"
            ? message.widgetPlacement
            : previous?.placement ?? "aboveEditor";
          return {
            ...state,
            widgets: {
              ...state.widgets,
              [key]: {
                lines: message.widgetLines.filter((item): item is string => typeof item === "string"),
                placement,
              },
            },
          };
        }
        case "setTitle":
          return { ...state, title: asString(message.title) };
        case "set_editor_text":
          return { ...state, editorText: asString(message.text) };
        default:
          return state;
      }
    }
    case "extension_error": {
      const path = asString(message.extensionPath, "Extension");
      const event = typeof message.event === "string" ? ` (${message.event})` : "";
      return {
        ...state,
        backendError: `${path}${event}: ${errorText(message.error, "Extension failed")}`,
      };
    }
    case "backend_error":
      return { ...state, backendError: errorText(message.error, "Backend error") };
    case "fatal_error":
      return { ...state, fatalError: errorText(message.error, "Fatal backend error") };
    default:
      return state;
  }
}
