import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let input = "";
let sequence = 0;
let held = false;
let decorated = false;
let modelRequestCount = 0;
let stateResponseCount = 0;
const logPath = process.env.ALLOY_FAKE_LOG;
const pidPath = process.env.ALLOY_FAKE_PID_FILE;
const startupDelayMs = Number(process.env.ALLOY_FAKE_STARTUP_DELAY_MS || 0);
const emptyHistory = process.env.ALLOY_FAKE_EMPTY === "1";
const fusionHistory = process.env.ALLOY_FAKE_FUSION_HISTORY === "1";
const fusionWidget = process.env.ALLOY_FAKE_FUSION_WIDGET === "1";

if (pidPath) writeFileSync(pidPath, `${process.pid}\n`);

function log(message: Record<string, unknown>): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(request: Record<string, unknown>, data?: unknown, success = true): void {
  send({
    type: "response",
    id: request.id,
    command: request.type,
    success,
    ...(data === undefined ? {} : { data }),
  });
}

function message(role: "user" | "assistant", content: string, id?: string) {
  return { id: id ?? `${role}-${++sequence}`, role, content, timestamp: Date.now() + sequence };
}

function fusionResult() {
  const runDir = join(process.env.ALLOY_HOME || "/tmp", "runs", "fusion-pty");
  const summary = {
    kind: "fusion",
    status: "COMPLETE",
    runId: "fusion-pty",
    runDir,
    objective: "Compare both approaches",
    requestedEfforts: { architect: "high", builder: "medium", synthesizer: "low" },
    proposals: [
      {
        role: "architect",
        model: "anthropic/claude-fable-5",
        ok: true,
        durationMs: 1_250,
        text: "## Architecture\n\nKeep boundaries explicit.\n\n- Preserve artifacts",
        usage: { input: 1_200, output: 340, cost: 0.0123, turns: 2 },
      },
      {
        role: "builder",
        model: "openai-codex/gpt-5.6-sol",
        ok: true,
        durationMs: 980,
        text: "## Build\n\nShip the smallest complete slice.\n\n- Verify behavior",
        usage: { input: 900, output: 280, cost: 0.0098, turns: 1 },
      },
    ],
    synthesis: "## Agreements\n\nBoth models support explicit verification.\n\n## Disagreements\n\n- Architect: Prefer stronger boundaries.\n- Builder: Prefer a smaller slice.\n- Status: resolved — preserve the stronger boundary.\n\n## Consensus\n\n- Decision: Ship the smallest slice that preserves the stronger boundary.\n- Caveats: Verify the boundary before release.",
    synthesizer: {
      ok: true,
      model: "anthropic/claude-fable-5",
      durationMs: 640,
      usage: { input: 2_500, output: 410, cost: 0.015, turns: 1 },
    },
  };
  mkdirSync(runDir, { recursive: true });
  const summaryBytes = Buffer.from(JSON.stringify(summary));
  writeFileSync(join(runDir, "summary.json"), summaryBytes);
  return {
    id: `fusion-${++sequence}`,
    role: "custom",
    customType: "alloy-fusion",
    content: "Fusion COMPLETE",
    timestamp: Date.now() + sequence,
    details: {
      kind: "fusion",
      mode: "plan",
      status: summary.status,
      runId: summary.runId,
      runDir: summary.runDir,
      objective: summary.objective,
      bodyStorage: "artifact",
      summaryPath: join(runDir, "summary.json"),
      summarySha256: createHash("sha256").update(summaryBytes).digest("hex"),
    },
  };
}

function stream(text: string, followProbe = false): void {
  const id = `assistant-${++sequence}`;
  const toolCallId = `tool-${sequence}`;
  const commandCallId = `command-${sequence}`;
  const toolCalls = [
    { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/tmp/example.ts" } },
    { type: "toolCall", id: commandCallId, name: "bash", arguments: { command: "printf 'fixture command'" } },
  ];
  const textContent = { type: "text", text: `${text}\n\n\`\`\`typescript\nconst status: string = "visible"\n\`\`\`` };
  const content = followProbe ? [textContent, ...toolCalls] : [...toolCalls, textContent];
  send({ type: "agent_start" });
  send({ type: "message_start", message: { id, role: "assistant", content: [{ type: "reasoning", text: "Checking the request" }], timestamp: Date.now() } });
  setTimeout(() => {
    send({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "/tmp/example.ts" } });
    send({ type: "tool_execution_end", toolCallId, toolName: "read", result: "fixture tool result", isError: false });
    send({ type: "tool_execution_start", toolCallId: commandCallId, toolName: "bash", args: { command: "printf 'fixture command'" } });
    send({ type: "tool_execution_end", toolCallId: commandCallId, toolName: "bash", result: "fixture command", isError: false });
    send({ type: "message_update", message: { id, role: "assistant", content, timestamp: Date.now() } });
    send({
      type: "message_end",
      message: {
        id: `result-${sequence}`,
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "fixture tool result" }],
        timestamp: Date.now(),
      },
    });
    send({
      type: "message_end",
      message: {
        id: `command-result-${sequence}`,
        role: "toolResult",
        toolCallId: commandCallId,
        toolName: "bash",
        content: [{ type: "text", text: "fixture command" }],
        timestamp: Date.now(),
      },
    });
  }, 500);
  setTimeout(() => {
    send({ type: "message_end", message: { id, role: "assistant", content, timestamp: Date.now() } });
    send({ type: "agent_end" });
  }, 650);
  if (followProbe) {
    setTimeout(() => send({ type: "message_end", message: message("assistant", "wheel pause sentinel") }), 750);
    setTimeout(() => send({ type: "message_end", message: message("assistant", "wheel follow resumed sentinel") }), 1_500);
    setTimeout(() => send({ type: "message_end", message: message("assistant", "keyboard pause sentinel") }), 2_200);
    setTimeout(() => send({ type: "message_end", message: message("assistant", "keyboard follow resumed sentinel") }), 2_900);
  }
}

function streamFlickerFixture(): void {
  const id = `assistant-${++sequence}`;
  const lines: string[] = [];
  let emitted = 0;
  let latestMessage: Record<string, unknown> | undefined;
  send({ type: "agent_start" });
  send({
    type: "message_start",
    message: { id, role: "assistant", content: [{ type: "text", text: "```typescript\n" }], timestamp: Date.now() },
  });

  const timer = setInterval(() => {
    for (let burst = 0; burst < 2 && emitted < 120; burst++) {
      emitted++;
      lines.push(`const value${emitted} = ${emitted};`);
      const text = `\`\`\`typescript\n${lines.join("\n")}${emitted === 120 ? "\n```" : ""}`;
      latestMessage = { id, role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
      send({ type: "message_update", message: latestMessage, assistantMessageEvent: { type: "text_delta", delta: lines.at(-1) } });
    }
    if (emitted < 120) return;
    clearInterval(timer);
    send({ type: "message_end", message: latestMessage! });
    send({ type: "agent_end" });
  }, 35);
}

function handle(request: Record<string, unknown>): void {
  log(request);
  switch (request.type) {
    case "get_state":
      setTimeout(() => {
        stateResponseCount++;
        respond(request, {
          model: { id: "fixture-model", provider: "fake", name: "Fixture" },
          thinkingLevel: "medium",
          isStreaming: held,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionId: "pty-session",
          sessionName: "PTY verification",
          autoCompactionEnabled: true,
          messageCount: fusionHistory ? 2 : emptyHistory ? 0 : 50,
          pendingMessageCount: 0,
        });
        send({ type: "extension_ui_request", id: `heartbeat-${stateResponseCount}`, method: "setStatus", statusKey: "fixture-heartbeat", statusText: `heartbeat:${stateResponseCount}` });
        if (!decorated) {
          decorated = true;
          send({ type: "extension_ui_request", id: "title-1", method: "setTitle", title: "Fixture title" });
          send({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "alloy-mode", statusText: "mode:plan" });
          send({
            type: "extension_ui_request",
            id: "widget-1",
            method: "setWidget",
            widgetKey: fusionWidget ? "alloy-agents" : "fixture",
            widgetLines: fusionWidget
              ? [
                  "ALLOY FUSION · SYNTHESIZING",
                  "Objective: Compare both approaches",
                  "◆ Architect ✓ Boundaries identified · claude-fable-5",
                  "▲ Builder ✓ Implementation traced · gpt-5.6-sol",
                  "⧉ Synthesizer ● Comparing conclusions · fable-5",
                ]
              : ["fixture widget"],
            widgetPlacement: "aboveEditor",
            ...(fusionWidget
              ? {
                  widgetData: {
                    kind: "alloy.fusion.live",
                    version: 1,
                    runId: "fusion-live",
                    phase: "SYNTHESIZING",
                    objective: "Compare both approaches",
                    agents: [
                      {
                        role: "architect",
                        status: "running",
                        model: "anthropic/claude-fable-5",
                        effort: "high",
                        activity: "Analyzing boundaries",
                        output: `${"Historical architecture detail ".repeat(100)}CURRENT ARCHITECTURE`,
                        events: [{ tool: "read", detail: "path=src/auth.ts", status: "running" }],
                      },
                      {
                        role: "builder",
                        status: "running",
                        model: "openai-codex/gpt-5.6-sol",
                        effort: "medium",
                        activity: "Tracing implementation",
                        output: `${"Historical implementation detail ".repeat(100)}CURRENT IMPLEMENTATION`,
                        events: [{ tool: "grep", detail: "pattern=session", status: "running" }],
                      },
                      {
                        role: "synthesizer",
                        status: "running",
                        model: "anthropic/claude-fable-5",
                        effort: "low",
                        activity: "Comparing conclusions",
                        output: `${"Historical synthesis detail ".repeat(100)}CURRENT SYNTHESIS`,
                        events: [],
                      },
                    ],
                  },
                }
              : {}),
          });
        }
      }, Number.isFinite(startupDelayMs) && startupDelayMs > 0 ? startupDelayMs : 0);
      return;
    case "get_messages":
      respond(request, {
        messages: fusionHistory
          ? [message("user", "/fusion Compare both approaches"), fusionResult()]
          : emptyHistory
            ? []
            : Array.from({ length: 50 }, (_, index) =>
                message(index % 2 === 0 ? "user" : "assistant", `hydrated history item ${String(index + 1).padStart(2, "0")}`),
              ),
      });
      return;
    case "get_commands":
      respond(request, {
        commands: [
          { name: "mode", description: "Select Alloy mode", source: "extension" },
          { name: "help", description: "Browse and search Alloy help", source: "extension" },
          { name: "skill:testing", description: "Run the testing skill", source: "skill" },
          { name: "plan", description: "Switch to Plan mode", source: "extension" },
          { name: "build", description: "Switch to Build mode", source: "extension" },
          { name: "approval", description: "Open approval", source: "extension" },
          { name: "cancel", description: "Open cancellable input", source: "extension" },
          { name: "login-fixture", description: "Open authentication input", source: "extension" },
          { name: "login-status-fixture", description: "Show provider login status", source: "extension" },
          { name: "login-complete-fixture", description: "Complete authentication externally", source: "extension" },
          { name: "panel-fixture", description: "Keep a panel below the editor", source: "extension" },
          { name: "panel-clear-fixture", description: "Clear the retained panel", source: "extension" },
          { name: "editor-fixture", description: "Populate the composer", source: "extension" },
          { name: "backend-loss", description: "Terminate the fixture backend", source: "extension" },
        ],
      });
      return;
    case "get_available_models":
      modelRequestCount++;
      respond(request, {
        models: modelRequestCount === 1
          ? [{ id: "stale-model", provider: "fake", name: "Stale" }]
          : modelRequestCount === 2
            ? [{ id: "fresh-model", provider: "fake", name: "Fresh" }]
            : [
              { id: "fresh-model", provider: "fake", name: "Fresh" },
              { id: "grok-model", provider: "xai", name: "Grok" },
            ],
      });
      return;
    case "get_session_stats":
      respond(request, {
        sessionId: "pty-session",
        userMessages: 25,
        assistantMessages: 25,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 50,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        cost: 0,
      });
      return;
    case "get_sidebar_state":
      respond(request, {
        sessionId: "pty-session",
        context: { tokens: 150, contextWindow: 200000, percent: 0.075, cost: 0.01 },
        mcp: [
          { name: "fixture-mcp", status: "connected", toolCount: 3, transport: "stdio" },
          { name: "offline-mcp", status: "failed", error: "fixture connection refused", transport: "http" },
        ],
        lsp: { supported: false, enabled: false, items: [] },
        todos: [],
      });
      return;
    case "prompt":
    case "steer": {
      const text = typeof request.message === "string" ? request.message : "";
      respond(request);
      send({ type: "message_end", message: message("user", text) });
      if (text === "/approval") {
        send({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "Allow fixture tool?", message: "Approve the PTY fixture." });
      } else if (text === "/help") {
        send({
          type: "extension_ui_request",
          id: "help-1",
          method: "select",
          title: "Alloy help - pick a topic",
          options: ["search <query>  - search all help", "overview       What is Alloy?", "commands       All slash commands"],
        });
      } else if (text === "/cancel") {
        send({ type: "extension_ui_request", id: "cancel-1", method: "input", title: "Cancel this request", placeholder: "Escape must cancel" });
      } else if (text === "/login-fixture") {
        send({
          type: "extension_ui_request",
          id: "login-1",
          method: "input",
          title: [
            "https://auth.example.test/authorize?client=fixture&scope=account%20models%20sessions&state=0123456789abcdef",
            "Keep this URL visible while authenticating.",
            "The provider may take several seconds to respond.",
            "Do not close the terminal while sign-in is pending.",
            "Return here after approving access in the browser.",
            "Device code: ABCD-EFGH",
            "",
            "Paste the authorization response below",
          ].join("\n"),
          placeholder: "authorization code",
        });
      } else if (text === "/login-status-fixture") {
        send({
          type: "extension_ui_request",
          id: "login-status-1",
          method: "select",
          title: "Login with OAuth",
          options: [
            "Anthropic (anthropic)\tconfigured",
            "OpenAI Codex (openai-codex)\tnot configured",
          ],
        });
      } else if (text === "/login-complete-fixture") {
        send({
          type: "extension_ui_request",
          id: "login-complete-1",
          method: "input",
          title: "Complete login in your browser",
          placeholder: "redirect URL",
        });
        setTimeout(() => {
          send({ type: "extension_ui_request", id: "login-complete-1", method: "close" });
          send({
            type: "extension_ui_request",
            id: "login-complete-notice",
            method: "notify",
            notifyType: "info",
            message: "OAuth login completed externally.",
          });
        }, 500);
      } else if (text === "/panel-fixture") {
        send({
          type: "extension_ui_request",
          id: "panel-fixture",
          method: "setWidget",
          widgetKey: "panel-fixture",
          widgetLines: ["PANEL", "retained result", "use /panel to clear"],
          widgetPlacement: "belowEditor",
        });
      } else if (text === "/panel-clear-fixture") {
        send({
          type: "extension_ui_request",
          id: "panel-clear-fixture",
          method: "setWidget",
          widgetKey: "panel-fixture",
        });
      } else if (text === "/editor-fixture") {
        send({ type: "extension_ui_request", id: "editor-1", method: "set_editor_text", text: "seed" });
      } else if (text === "hold") {
        held = true;
        send({ type: "agent_start" });
      } else if (text === "flicker stream") {
        streamFlickerFixture();
      } else if (text === "/backend-loss") {
        setTimeout(() => process.exit(37), 50);
      } else if (text === "/mode" || text === "/plan" || text === "/build") {
        send({ type: "extension_ui_request", id: "mode-notice", method: "notify", notifyType: "info", message: "Mode command received" });
      } else {
        const streamedText = text === "PTY prompt"
          ? [
              "streamed assistant text",
              ...Array.from({ length: 20 }, (_, index) => `streamed filler line ${index + 1}`),
              "streamed tail sentinel",
            ].join("\n")
          : text === "paused append"
            ? "sticky append stayed at the tail"
            : "streamed assistant text";
        stream(streamedText, text === "PTY prompt");
      }
      return;
    }
    case "abort":
      respond(request);
      held = false;
      send({ type: "agent_end" });
      return;
    case "extension_ui_response":
      send({ type: "extension_ui_response", id: request.id });
      if (request.id === "help-1") return;
      send({
        type: "extension_ui_request",
        id: `notice-${request.id}`,
        method: "notify",
        notifyType: "info",
        message: request.cancelled === true ? "Cancellation received" : request.confirmed === true ? "Approval received: allow" : "Response received",
      });
      return;
    case "new_session":
      respond(request, { sessionId: "new-pty-session" });
      return;
    case "compact":
      respond(request, { compacted: true });
      return;
    case "set_model":
      respond(request, { id: request.modelId, provider: request.provider });
      return;
    case "set_thinking_level":
      respond(request, { level: request.level });
      send({ type: "thinking_level_changed", level: request.level });
      return;
    case "export_html":
      respond(request, { path: "/tmp/alloy-pty-export.html" });
      return;
    default:
      respond(request);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
  }
});
