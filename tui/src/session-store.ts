import { redactDisplayText, transcriptToolStates, type TranscriptToolStatus } from "./content";

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

export interface SidebarSnapshot {
  sessionId: string;
  context: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    cost: number;
  };
  mcp: Array<{
    name: string;
    status: "connected" | "connecting" | "disconnected" | "disabled" | "failed";
    error?: string;
    toolCount?: number;
    transport?: "stdio" | "http" | "sse";
  }>;
  lsp: {
    supported: boolean;
    enabled: boolean;
    items: Array<{
      id: string;
      root: string;
      status: "connected" | "error" | "unavailable";
      error?: string;
    }>;
  };
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
    priority: "high" | "medium" | "low";
  }>;
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
  data?: FusionLivePanelState;
}

export interface FusionLiveEventState {
  tool: string;
  detail: string;
  status: "running" | "complete" | "failed";
}

export interface FusionLiveAgentState {
  role: "architect" | "builder" | "synthesizer";
  status: "pending" | "running" | "ok" | "fail" | "skip";
  model: string;
  effort: string;
  activity: string;
  output: string;
  events: FusionLiveEventState[];
}

export interface FusionLivePanelState {
  kind: "alloy.fusion.live";
  version: 1;
  runId: string;
  phase: string;
  objective: string;
  agents: FusionLiveAgentState[];
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
  transcriptTools: Record<string, TranscriptToolStatus>;
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
  sidebarSnapshot: SidebarSnapshot | null;
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

export function isStreamingTranscriptMessage(state: SessionState, index: number): boolean {
  return state.isStreaming &&
    state.currentAssistantMessageId !== null &&
    findCurrentAssistant(state.messages, state.currentAssistantMessageId) === index;
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
    transcriptTools: mergeTranscriptTools(state.transcriptTools, [nextMessage]),
    currentAssistantMessageId: phase === "end" && message.role === "assistant" ? null : currentAssistantMessageId,
  };
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function mergeTranscriptTools(
  current: Record<string, TranscriptToolStatus>,
  messages: SessionMessage[],
): Record<string, TranscriptToolStatus> {
  const next = { ...current };
  for (const [id, status] of Object.entries(transcriptToolStates(messages))) {
    if (status === "pending" && (next[id] === "completed" || next[id] === "error")) continue;
    next[id] = status;
  }
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

function sidebarRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sidebarNumber(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sidebarText(value: string, limit: number): string {
  return redactDisplayText(value)
    .replace(/((?:token|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .slice(0, limit);
}

function widgetText(value: unknown, limit: number, fromEnd = false): string {
  const sanitized = redactDisplayText(asString(value))
    .replace(/((?:token|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return fromEnd ? sanitized.slice(-limit) : sanitized.slice(0, limit);
}

export function parseFusionLivePanel(value: unknown): FusionLivePanelState | undefined {
  const panel = sidebarRecord(value);
  if (panel?.kind !== "alloy.fusion.live" || panel.version !== 1 || !Array.isArray(panel.agents)) {
    return undefined;
  }
  const roles = ["architect", "builder", "synthesizer"] as const;
  const statuses = new Set(["pending", "running", "ok", "fail", "skip"]);
  const eventStatuses = new Set(["running", "complete", "failed"]);
  if (typeof panel.runId !== "string" || typeof panel.phase !== "string" || typeof panel.objective !== "string") {
    return undefined;
  }
  if (panel.agents.length !== roles.length) return undefined;
  const agents: FusionLiveAgentState[] = [];
  const seen = new Set<string>();
  for (const value of panel.agents) {
    const agent = sidebarRecord(value);
    if (!agent) return undefined;
    const role = agent.role;
    const status = agent.status;
    if (!roles.includes(role as typeof roles[number]) || typeof status !== "string" || !statuses.has(status) || seen.has(role as string)) {
      return undefined;
    }
    if (typeof agent.model !== "string" || typeof agent.effort !== "string" || typeof agent.activity !== "string" || typeof agent.output !== "string") {
      return undefined;
    }
    const eventsValue = agent.events;
    if (eventsValue !== undefined && !Array.isArray(eventsValue)) return undefined;
    const events: FusionLiveEventState[] = [];
    for (const item of (eventsValue || []).slice(0, 3)) {
      const event = sidebarRecord(item);
      if (!event || typeof event.tool !== "string" || typeof event.detail !== "string" || typeof event.status !== "string" || !eventStatuses.has(event.status)) return undefined;
      events.push({
        tool: widgetText(event.tool, 64),
        detail: widgetText(event.detail, 256),
        status: event.status as FusionLiveEventState["status"],
      });
    }
    seen.add(role as string);
    agents.push({
      role: role as FusionLiveAgentState["role"],
      status: status as FusionLiveAgentState["status"],
      model: widgetText(agent.model, 256),
      effort: widgetText(agent.effort, 32),
      activity: widgetText(agent.activity, 512),
      output: widgetText(agent.output, 4_096, true),
      events,
    });
  }
  agents.sort((left, right) => roles.indexOf(left.role) - roles.indexOf(right.role));
  const parsed: FusionLivePanelState = {
    kind: "alloy.fusion.live",
    version: 1,
    runId: widgetText(panel.runId, 128),
    phase: widgetText(panel.phase, 64),
    objective: widgetText(panel.objective, 1_024),
    agents,
  };
  return new TextEncoder().encode(JSON.stringify(parsed)).length < 20_000 ? parsed : undefined;
}

function parseSidebarSnapshot(value: unknown): SidebarSnapshot | null {
  const data = sidebarRecord(value);
  const context = sidebarRecord(data?.context);
  const lsp = sidebarRecord(data?.lsp);
  if (!data || typeof data.sessionId !== "string" || data.sessionId.length > 500 || !context || !lsp) return null;
  if (!Array.isArray(data.mcp) || data.mcp.length > 100 || !Array.isArray(lsp.items) || lsp.items.length > 100) {
    return null;
  }
  if (!Array.isArray(data.todos) || data.todos.length > 100) return null;
  const tokens = sidebarNumber(context.tokens, true);
  const contextWindow = sidebarNumber(context.contextWindow, true);
  const percent = sidebarNumber(context.percent, true);
  const cost = sidebarNumber(context.cost);
  if (cost === null || (context.tokens !== null && tokens === null) || (context.contextWindow !== null && contextWindow === null) || (context.percent !== null && percent === null)) {
    return null;
  }

  const mcp: SidebarSnapshot["mcp"] = [];
  for (const value of data.mcp) {
    const item = sidebarRecord(value);
    if (!item || typeof item.name !== "string" || !["connected", "connecting", "disconnected", "disabled", "failed"].includes(String(item.status))) return null;
    if (item.toolCount !== undefined && (typeof item.toolCount !== "number" || !Number.isSafeInteger(item.toolCount) || item.toolCount < 0)) return null;
    if (item.transport !== undefined && !["stdio", "http", "sse"].includes(String(item.transport))) return null;
    mcp.push({
      name: sidebarText(item.name, 200),
      status: item.status as SidebarSnapshot["mcp"][number]["status"],
      ...(typeof item.error === "string" ? { error: sidebarText(item.error, 500) } : {}),
      ...(typeof item.toolCount === "number" ? { toolCount: item.toolCount } : {}),
      ...(typeof item.transport === "string" ? { transport: item.transport as "stdio" | "http" | "sse" } : {}),
    });
  }

  const lspItems: SidebarSnapshot["lsp"]["items"] = [];
  for (const value of lsp.items) {
    const item = sidebarRecord(value);
    if (!item || typeof item.id !== "string" || typeof item.root !== "string" || !["connected", "error", "unavailable"].includes(String(item.status))) return null;
    lspItems.push({
      id: sidebarText(item.id, 200),
      root: sidebarText(item.root, 200),
      status: item.status as SidebarSnapshot["lsp"]["items"][number]["status"],
      ...(typeof item.error === "string" ? { error: sidebarText(item.error, 500) } : {}),
    });
  }

  const todos: SidebarSnapshot["todos"] = [];
  for (const value of data.todos) {
    const item = sidebarRecord(value);
    if (!item || typeof item.content !== "string" || !["pending", "in_progress", "completed", "cancelled"].includes(String(item.status)) || !["high", "medium", "low"].includes(String(item.priority))) return null;
    todos.push({
      content: sidebarText(item.content, 500),
      status: item.status as SidebarSnapshot["todos"][number]["status"],
      priority: item.priority as SidebarSnapshot["todos"][number]["priority"],
    });
  }

  if (typeof lsp.supported !== "boolean" || typeof lsp.enabled !== "boolean") return null;
  return {
    sessionId: data.sessionId,
    context: { tokens, contextWindow, percent, cost },
    mcp,
    lsp: { supported: lsp.supported, enabled: lsp.enabled, items: lspItems },
    todos,
  };
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
    transcriptTools: {},
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
    sidebarSnapshot: null,
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
              transcriptTools: {},
              widgets: {},
              statuses: {},
              notifications: [],
              toasts: [],
              editorText: "",
              title: "",
              extensionDialogs: emptyExtensionDialogs(),
              sidebarSnapshot: null,
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
          transcriptTools: transcriptToolStates(messages),
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
      case "get_sidebar_state": {
        const snapshot = parseSidebarSnapshot(message.data);
        return snapshot?.sessionId === state.sessionId
          ? { ...state, sidebarSnapshot: snapshot, backendError: null }
          : state;
      }
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
    case "sidebar_state_updated": {
      const snapshot = parseSidebarSnapshot(message.data);
      return snapshot?.sessionId === state.sessionId ? { ...state, sidebarSnapshot: snapshot } : state;
    }
    case "agent_start":
      return { ...state, isStreaming: true, toolExecutions: {}, backendError: null };
    case "agent_end":
    case "agent_settled":
      return { ...state, isStreaming: false, currentAssistantMessageId: null };
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
        const previous = state.toolExecutions[toolCallId];
        const execution: ToolExecution = {
          ...(previous ?? {
            toolCallId,
            toolName: asString(message.toolName),
          }),
          toolCallId,
          toolName: asString(message.toolName, previous?.toolName),
          result: message.result,
          isError: message.isError === true,
          status: message.isError === true ? "error" : "completed",
        };
        return {
          ...state,
          toolExecutions: { ...state.toolExecutions, [toolCallId]: execution },
        };
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
        case "close":
          return id
            ? { ...state, extensionDialogs: removeExtensionDialog(state.extensionDialogs, id) }
            : state;
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
          const data = parseFusionLivePanel(message.widgetData);
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
                ...(data ? { data } : {}),
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
