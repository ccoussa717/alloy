import { describe, expect, it } from "bun:test";
import { createInitialState, isStreamingTranscriptMessage, reduceRpcMessage, type SessionState } from "../src/session-store";

describe("session store snapshots", () => {
  it("hydrates and fully replaces the active session sidebar snapshot", () => {
    let state = reduceRpcMessage(createInitialState(), {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionId: "session-1",
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_sidebar_state",
      success: true,
      data: {
        sessionId: "session-1",
        context: { tokens: 1200, contextWindow: 200000, percent: 0.6, cost: 0.01 },
        mcp: [
          { name: "open-brain", status: "connected", toolCount: 3, transport: "http" },
          { name: "broken", status: "failed", error: "Authorization: Bearer secret-value" },
        ],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      },
    });

    expect(state.sidebarSnapshot?.mcp.map((item) => item.name)).toEqual(["open-brain", "broken"]);
    expect(state.sidebarSnapshot?.mcp[1]?.error).toContain("[REDACTED]");
    expect(state.sidebarSnapshot?.mcp[1]?.error).not.toContain("secret-value");

    state = reduceRpcMessage(state, {
      type: "sidebar_state_updated",
      data: {
        sessionId: "session-1",
        context: { tokens: 1500, contextWindow: 200000, percent: 0.75, cost: 0.02 },
        mcp: [{ name: "open-brain", status: "disconnected", transport: "http" }],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      },
    });
    expect(state.sidebarSnapshot?.mcp).toEqual([
      { name: "open-brain", status: "disconnected", transport: "http" },
    ]);
  });

  it("rejects stale sidebar updates and clears the snapshot on session replacement", () => {
    let state: SessionState = { ...createInitialState(), sessionId: "session-1" };
    state = reduceRpcMessage(state, {
      type: "sidebar_state_updated",
      data: {
        sessionId: "stale-session",
        context: { tokens: null, contextWindow: null, percent: null, cost: 0 },
        mcp: [],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      },
    });
    expect(state.sidebarSnapshot).toBeNull();

    state = {
      ...state,
      sidebarSnapshot: {
        sessionId: "session-1",
        context: { tokens: 1, contextWindow: 10, percent: 10, cost: 0 },
        mcp: [],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      },
    };
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionId: "session-2",
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    expect(state.sidebarSnapshot).toBeNull();
  });

  it("bounds and redacts every sidebar string that can reach the display", () => {
    const sessionId = "s".repeat(501);
    let state: SessionState = { ...createInitialState(), sessionId };
    state = reduceRpcMessage(state, {
      type: "sidebar_state_updated",
      data: {
        sessionId,
        context: { tokens: 1, contextWindow: 10, percent: 10, cost: 0 },
        mcp: [],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      },
    });
    expect(state.sidebarSnapshot).toBeNull();

    state = { ...state, sessionId: "session-1" };
    state = reduceRpcMessage(state, {
      type: "sidebar_state_updated",
      data: {
        sessionId: "session-1",
        context: { tokens: 1, contextWindow: 10, percent: 10, cost: 0 },
        mcp: [{ name: "api_key = server-secret", status: "failed", error: "credential: error-secret" }],
        lsp: {
          supported: true,
          enabled: true,
          items: [{ id: "password=id-secret", root: "token = root-secret", status: "error", error: "token = lsp-error-secret" }],
        },
        todos: [{ content: "credential = todo-secret", status: "pending", priority: "high" }],
      },
    });
    const visible = JSON.stringify(state.sidebarSnapshot);
    expect(visible).toContain("[REDACTED]");
    for (const secret of ["server-secret", "error-secret", "id-secret", "root-secret", "lsp-error-secret", "todo-secret"]) {
      expect(visible).not.toContain(secret);
    }
  });

  it("hydrates session metadata from get_state without mutating prior state", () => {
    const initial = createInitialState();
    const model = { id: "claude-sonnet", provider: "anthropic", name: "Sonnet" };

    const next = reduceRpcMessage(initial, {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model,
        thinkingLevel: "high",
        isStreaming: true,
        isCompacting: true,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        sessionName: "Migration",
        autoCompactionEnabled: true,
        messageCount: 7,
        pendingMessageCount: 2,
      },
    });

    expect(next).not.toBe(initial);
    expect(next).toMatchObject({
      model,
      thinkingLevel: "high",
      isStreaming: true,
      isCompacting: true,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionName: "Migration",
      autoCompactionEnabled: true,
      messageCount: 7,
      pendingMessageCount: 2,
    });
    expect(initial).toEqual(createInitialState());
  });

  it("atomically clears session-bound state when get_state reports a new session", () => {
    let state = createInitialState();
    state = { ...state, sessionId: "session-old" };
    state = reduceRpcMessage(state, {
      type: "message_end",
      message: { id: "old-message", role: "assistant", content: "stale" },
    });
    state = reduceRpcMessage(state, {
      type: "tool_execution_start",
      toolCallId: "old-tool",
      toolName: "read",
    });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "old-dialog",
      method: "confirm",
      title: "Stale dialog",
    });
    state = {
      ...state,
      widgets: { old: { lines: ["stale"], placement: "aboveEditor" } },
    };

    const next = reduceRpcMessage(state, {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionId: "session-new",
        autoCompactionEnabled: false,
        messageCount: 4,
        pendingMessageCount: 0,
      },
    });

    expect(next.sessionId).toBe("session-new");
    expect(next.messages).toEqual([]);
    expect(next.toolExecutions).toEqual({});
    expect(next.widgets).toEqual({});
    expect(next.extensionDialogs).toEqual({ order: [], byId: {} });
    expect(next.currentAssistantMessageId).toBeNull();
  });

  it("hydrates messages, commands, models, and session stats", () => {
    const messages = [
      { id: "user-1", role: "user", content: "hello", timestamp: 1 },
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "failed-1", name: "bash" }] },
      { id: "result-1", role: "toolResult", toolCallId: "failed-1", isError: true, content: [{ type: "text", text: "failed" }] },
    ];
    const commands = [{ name: "review", description: "Review changes", source: "extension" as const }];
    const models = [{ id: "gpt-5", provider: "openai" }];
    const stats = {
      sessionId: "session-1",
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 1,
      tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: 0.01,
    };

    let state = createInitialState();
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages },
    });
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands },
    });
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models },
    });
    state = reduceRpcMessage(state, {
      type: "response",
      command: "get_session_stats",
      success: true,
      data: stats,
    });

    expect(state.messages).toEqual(messages);
    expect(state.messages).not.toBe(messages);
    expect(state.messageCount).toBe(3);
    expect(state.transcriptTools).toEqual({ "failed-1": "error" });
    expect(state.commands).toEqual(commands);
    expect(state.availableModels).toEqual(models);
    expect(state.sessionStats).toEqual(stats);
  });
});

describe("session store events", () => {
  it("upserts streaming messages by id and by the current-assistant fallback", () => {
    let state = reduceRpcMessage(createInitialState(), { type: "agent_start" });

    state = reduceRpcMessage(state, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 10 },
    });
    state = reduceRpcMessage(state, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 11 },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    state = reduceRpcMessage(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 12 },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(state.currentAssistantMessageId).toBeNull();

    state = reduceRpcMessage(state, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 20 },
    });
    expect(state.messages).toHaveLength(2);

    state = reduceRpcMessage(state, {
      type: "message_update",
      message: { id: "server-id", role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 20 },
    });
    state = reduceRpcMessage(state, {
      type: "message_end",
      message: { id: "server-id", role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 21 },
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.content).toEqual([{ type: "text", text: "b" }]);

    state = reduceRpcMessage(state, {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "new stream" }], timestamp: 30 },
    });
    expect(state.messages).toHaveLength(3);
    expect(state.messages[2]?.content).toEqual([{ type: "text", text: "new stream" }]);
  });

  it("tracks agent, queue, compaction, retry, and session metadata events", () => {
    let state = reduceRpcMessage(createInitialState(), { type: "agent_start" });
    expect(state.isStreaming).toBe(true);

    state = reduceRpcMessage(state, {
      type: "queue_update",
      steering: ["change direction"],
      followUp: ["then summarize"],
    });
    expect(state.pendingSteering).toEqual(["change direction"]);
    expect(state.pendingFollowUp).toEqual(["then summarize"]);
    expect(state.pendingMessageCount).toBe(2);

    state = reduceRpcMessage(state, { type: "compaction_start", reason: "threshold" });
    expect(state.isCompacting).toBe(true);
    state = reduceRpcMessage(state, {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
    expect(state.isCompacting).toBe(false);

    state = reduceRpcMessage(state, {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "rate limited",
    });
    expect(state.isRetrying).toBe(true);
    expect(state.retry).toEqual({
      attempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "rate limited",
    });
    state = reduceRpcMessage(state, { type: "auto_retry_end", success: true, attempt: 2 });
    expect(state.isRetrying).toBe(false);
    expect(state.retry).toBeNull();

    state = reduceRpcMessage(state, { type: "thinking_level_changed", level: "medium" });
    state = reduceRpcMessage(state, { type: "session_info_changed", name: "Renamed" });
    state = reduceRpcMessage(state, { type: "agent_end", messages: [], willRetry: false });
    expect(state.thinkingLevel).toBe("medium");
    expect(state.sessionName).toBe("Renamed");
    expect(state.isStreaming).toBe(false);
  });

  it("keeps completed tool executions visible through agent settlement and clears them during hydration", () => {
    let state = reduceRpcMessage(createInitialState(), {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/a" },
    });
    const afterStart = state;
    state = reduceRpcMessage(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/a" },
      partialResult: "partial",
    });
    state = reduceRpcMessage(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "complete",
      isError: false,
    });

    expect(state.toolExecutions["tool-1"]).toEqual({
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/a" },
      partialResult: "partial",
      result: "complete",
      isError: false,
      status: "completed",
    });
    expect(afterStart.toolExecutions["tool-1"]?.status).toBe("running");

    state = reduceRpcMessage(state, { type: "agent_end", messages: [], willRetry: false });
    expect(state.toolExecutions["tool-1"]?.status).toBe("completed");

    state = reduceRpcMessage(afterStart, {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [] },
    });
    expect(state.toolExecutions).toEqual({});
  });

  it("finalizes Markdown streams and never downgrades terminal transcript tool state", () => {
    let state = reduceRpcMessage(createInitialState(), { type: "agent_start" });
    state = reduceRpcMessage(state, {
      type: "message_start",
      message: { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read" }] },
    });
    expect(isStreamingTranscriptMessage(state, 0)).toBe(true);
    state = reduceRpcMessage(state, {
      type: "message_end",
      message: { id: "result-1", role: "toolResult", toolCallId: "tool-1", content: "complete" },
    });
    expect(state.transcriptTools["tool-1"]).toBe("completed");
    state = reduceRpcMessage(state, {
      type: "message_update",
      message: { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read" }] },
    });
    expect(state.transcriptTools["tool-1"]).toBe("completed");
    state = reduceRpcMessage(state, {
      type: "message_end",
      message: { id: "assistant-1", role: "assistant", content: "done" },
    });
    expect(isStreamingTranscriptMessage(state, 0)).toBe(false);
  });
});

describe("extension UI events", () => {
  it("queues interactive requests by id and removes only the matching response", () => {
    const requests = [
      { method: "select", title: "Choose", options: ["a", "b"], timeout: 100 },
      { method: "confirm", title: "Proceed", message: "Really?", timeout: 200 },
      { method: "input", title: "Name", placeholder: "value", timeout: 300 },
      { method: "editor", title: "Edit", prefill: "draft" },
    ] as const;
    let state = createInitialState();

    for (const [index, request] of requests.entries()) {
      state = reduceRpcMessage(state, {
        type: "extension_ui_request",
        id: `dialog-${index}`,
        ...request,
      });
    }

    expect(state.extensionDialogs.order).toEqual(["dialog-0", "dialog-1", "dialog-2", "dialog-3"]);
    expect(state.extensionDialogs.byId["dialog-0"]).toMatchObject({ id: "dialog-0", ...requests[0] });
    state = reduceRpcMessage(state, { type: "extension_ui_response", id: "other", cancelled: true });
    expect(state.extensionDialogs.order).toEqual(["dialog-0", "dialog-1", "dialog-2", "dialog-3"]);
    state = reduceRpcMessage(state, { type: "extension_ui_response", id: "dialog-1", confirmed: false });
    expect(state.extensionDialogs.order).toEqual(["dialog-0", "dialog-2", "dialog-3"]);
    expect(state.extensionDialogs.byId["dialog-1"]).toBeUndefined();
    expect(state.extensionDialogs.byId["dialog-0"]?.id).toBe("dialog-0");
  });

  it("updates a repeated dialog id without moving it behind later requests", () => {
    let state = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "dialog-1",
      method: "input",
      title: "First",
    });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "dialog-2",
      method: "input",
      title: "Second",
    });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "dialog-1",
      method: "input",
      title: "Updated",
    });

    expect(state.extensionDialogs.order).toEqual(["dialog-1", "dialog-2"]);
    expect(state.extensionDialogs.byId["dialog-1"]?.title).toBe("Updated");
  });

  it("applies notify, status, widget, title, and editor requests with clear semantics", () => {
    let state = createInitialState();
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "Saved",
    });
    expect(state.notifications).toEqual([{ id: "notice-1", message: "Saved", type: "info" }]);
    expect(state.toasts).toBe(state.notifications);

    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "branch",
      statusText: "main",
    });
    expect(state.statuses).toEqual({ branch: "main" });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "status-2",
      method: "setStatus",
      statusKey: "branch",
      statusText: undefined,
    });
    expect(state.statuses).toEqual({});

    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "agents",
      widgetLines: ["one"],
      widgetPlacement: "belowEditor",
    });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "widget-2",
      method: "setWidget",
      widgetKey: "agents",
      widgetLines: ["two"],
    });
    expect(state.widgets.agents).toEqual({ lines: ["two"], placement: "belowEditor" });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "widget-3",
      method: "setWidget",
      widgetKey: "agents",
      widgetLines: undefined,
      widgetPlacement: "aboveEditor",
    });
    expect(state.widgets).toEqual({});

    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "Alloy session",
    });
    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "editor-1",
      method: "set_editor_text",
      text: "queued prompt",
    });
    expect(state.title).toBe("Alloy session");
    expect(state.editorText).toBe("queued prompt");
  });

  it("stores validated Fusion live widget data and keeps generic fallback lines", () => {
    const secret = [
      "credential=live-panel-secret",
      "AWS_SECRET_ACCESS_KEY=aws-live-secret",
      "https://user:url-password@example.test/repo.git",
      `gh${"p_"}abcdefghijklmnopqrstuvwxyz123456`,
      `-----BEGIN ${"PRIVATE"} KEY-----\nprivate-key-material\n-----END ${"PRIVATE"} KEY-----`,
      `-----BEGIN ${"PRIVATE"} KEY-----\npartial-key-material`,
    ].join("\n");
    let state = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "fusion-widget-1",
      method: "setWidget",
      widgetKey: "alloy-agents",
      widgetLines: ["Fusion fallback"],
      widgetPlacement: "aboveEditor",
      widgetData: {
        kind: "alloy.fusion.live",
        version: 1,
        runId: "fusion-live",
        phase: "PROPOSING",
        objective: "Compare both approaches",
        agents: [
          {
            role: "architect",
            status: "running",
            model: "anthropic/claude-fable-5",
            effort: "high",
            activity: "Analyzing boundaries",
            output: secret,
            events: [{ tool: "read", detail: "src/auth.ts", status: "running" }],
          },
          {
            role: "builder",
            status: "pending",
            model: "",
            effort: "",
            activity: "Waiting",
            output: "",
            events: [],
          },
          {
            role: "synthesizer",
            status: "pending",
            model: "",
            effort: "",
            activity: "Waiting",
            output: "",
            events: [],
          },
        ],
      },
    });

    expect(state.widgets["alloy-agents"]?.lines).toEqual(["Fusion fallback"]);
    expect(state.widgets["alloy-agents"]?.data).toMatchObject({
      kind: "alloy.fusion.live",
      version: 1,
      objective: "Compare both approaches",
    });
    const visible = JSON.stringify(state.widgets["alloy-agents"]?.data);
    expect(visible).toContain("[REDACTED]");
    expect(visible).not.toMatch(/live-panel-secret|aws-live-secret|url-password|ghp_|private-key-material|partial-key-material/);

    state = reduceRpcMessage(state, {
      type: "extension_ui_request",
      id: "fusion-widget-2",
      method: "setWidget",
      widgetKey: "alloy-agents",
      widgetLines: ["Still usable"],
      widgetData: {
        kind: "alloy.fusion.live",
        version: 1,
        agents: [{ role: "architect", status: "running" }],
      },
    });
    expect(state.widgets["alloy-agents"]).toEqual({
      lines: ["Still usable"],
      placement: "aboveEditor",
    });
  });

  it("stores validated Fission live widget data with reviewer panes", () => {
    const state = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "fission-widget-1",
      method: "setWidget",
      widgetKey: "alloy-agents",
      widgetLines: ["Fission fallback"],
      widgetPlacement: "aboveEditor",
      widgetData: {
        kind: "alloy.fission.live",
        version: 1,
        runId: "fission-live",
        phase: "REVIEW",
        mode: "repo",
        agents: [
          {
            role: "reviewer",
            index: 1,
            status: "running",
            model: "openai-codex/gpt-5.6-sol",
            activity: "reading packet",
            output: "Reviewing docs/alloy-ai-meetup.html…",
            events: [{ tool: "read", detail: "review-packet.json", status: "running" }],
          },
          {
            role: "reviewer",
            index: 2,
            status: "running",
            model: "xai/grok-4.5",
            activity: "starting…",
            output: "",
            events: [],
          },
          {
            role: "judge",
            index: null,
            status: "pending",
            model: "openai-codex/gpt-5.6-sol",
            activity: "Waiting",
            output: "",
            events: [],
          },
        ],
      },
    });

    expect(state.widgets["alloy-agents"]?.lines).toEqual(["Fission fallback"]);
    expect(state.widgets["alloy-agents"]?.data).toMatchObject({
      kind: "alloy.fission.live",
      version: 1,
      phase: "REVIEW",
      mode: "repo",
    });
    expect(state.widgets["alloy-agents"]?.data?.agents?.map((agent: any) => agent.role)).toEqual([
      "reviewer",
      "reviewer",
      "judge",
    ]);
    expect(state.widgets["alloy-agents"]?.data?.agents?.[0]).toMatchObject({
      index: 1,
      model: "openai-codex/gpt-5.6-sol",
      status: "running",
    });
  });

  it("rejects structured Fusion panels above the transport byte limit", () => {
    const oversizedOutput = "💡".repeat(4_096);
    const state = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "fusion-widget-large",
      method: "setWidget",
      widgetKey: "alloy-agents",
      widgetLines: ["Bounded fallback"],
      widgetData: {
        kind: "alloy.fusion.live",
        version: 1,
        runId: "fusion-large",
        phase: "PROPOSING",
        objective: "Compare both approaches",
        agents: ["architect", "builder", "synthesizer"].map((role) => ({
          role,
          status: "running",
          model: "provider/model",
          effort: "medium",
          activity: "Working",
          output: oversizedOutput,
          events: [],
        })),
      },
    });

    expect(state.widgets["alloy-agents"]).toEqual({
      lines: ["Bounded fallback"],
      placement: "aboveEditor",
    });
  });

  it("rejects Fusion panels with malformed required text fields", () => {
    const state = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "fusion-widget-malformed",
      method: "setWidget",
      widgetKey: "alloy-agents",
      widgetLines: ["Malformed fallback"],
      widgetData: {
        kind: "alloy.fusion.live",
        version: 1,
        runId: "fusion-malformed",
        phase: "PROPOSING",
        objective: 42,
        agents: ["architect", "builder", "synthesizer"].map((role) => ({
          role,
          status: "running",
          model: "provider/model",
          effort: "medium",
          activity: "Working",
          output: "Visible",
          events: [],
        })),
      },
    });

    expect(state.widgets["alloy-agents"]).toEqual({
      lines: ["Malformed fallback"],
      placement: "aboveEditor",
    });
  });

  it("surfaces command, extension, backend, and fatal errors", () => {
    let state = reduceRpcMessage(createInitialState(), {
      type: "response",
      command: "get_state",
      success: false,
      error: "backend unavailable",
    });
    expect(state.backendError).toBe("backend unavailable");

    state = reduceRpcMessage(state, {
      type: "extension_error",
      extensionPath: "/extensions/git.ts",
      event: "tool_call",
      error: "extension failed",
    });
    expect(state.backendError).toContain("extension failed");

    state = reduceRpcMessage(state, { type: "backend_error", error: "pipe closed" });
    expect(state.backendError).toBe("pipe closed");
    state = reduceRpcMessage(state, { type: "fatal_error", error: "process exited" });
    expect(state.fatalError).toBe("process exited");
  });

  it("redacts credentials from errors and error notifications", () => {
    const secret = "Authorization: Bearer backend-secret-token";
    const messages = [
      { type: "response", command: "prompt", success: false, error: secret },
      { type: "backend_error", error: secret },
      { type: "fatal_error", error: secret },
    ];

    for (const message of messages) {
      const state = reduceRpcMessage(createInitialState(), message);
      const visible = state.backendError ?? state.fatalError ?? "";
      expect(visible).toContain("[REDACTED]");
      expect(visible).not.toContain("backend-secret-token");
    }

    const notification = reduceRpcMessage(createInitialState(), {
      type: "extension_ui_request",
      id: "secret-error",
      method: "notify",
      notifyType: "error",
      message: secret,
    }).notifications[0]?.message ?? "";
    expect(notification).toContain("[REDACTED]");
    expect(notification).not.toContain("backend-secret-token");
  });
});
