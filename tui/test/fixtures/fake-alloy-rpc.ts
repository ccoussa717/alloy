import { appendFileSync, writeFileSync } from "node:fs";

let input = "";
let sequence = 0;
let held = false;
let decorated = false;
const logPath = process.env.ALLOY_FAKE_LOG;
const pidPath = process.env.ALLOY_FAKE_PID_FILE;
const startupDelayMs = Number(process.env.ALLOY_FAKE_STARTUP_DELAY_MS || 0);

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

function stream(text: string): void {
  const id = `assistant-${++sequence}`;
  const toolCallId = `tool-${sequence}`;
  const content = [
    { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "/tmp/example.ts" } },
    { type: "text", text },
  ];
  send({ type: "agent_start" });
  send({ type: "message_start", message: { id, role: "assistant", content: [{ type: "reasoning", text: "Checking the request" }], timestamp: Date.now() } });
  setTimeout(() => {
    send({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "/tmp/example.ts" } });
    send({ type: "tool_execution_end", toolCallId, toolName: "read", result: "fixture tool result", isError: false });
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
  }, 500);
  setTimeout(() => {
    send({ type: "message_end", message: { id, role: "assistant", content, timestamp: Date.now() } });
    send({ type: "agent_end" });
  }, 650);
}

function handle(request: Record<string, unknown>): void {
  log(request);
  switch (request.type) {
    case "get_state":
      setTimeout(() => {
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
          messageCount: 50,
          pendingMessageCount: 0,
        });
        if (!decorated) {
          decorated = true;
          send({ type: "extension_ui_request", id: "title-1", method: "setTitle", title: "Fixture title" });
          send({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "alloy-mode", statusText: "mode:plan" });
          send({ type: "extension_ui_request", id: "widget-1", method: "setWidget", widgetKey: "fixture", widgetLines: ["fixture widget"], widgetPlacement: "aboveEditor" });
        }
      }, Number.isFinite(startupDelayMs) && startupDelayMs > 0 ? startupDelayMs : 0);
      return;
    case "get_messages":
      respond(request, {
        messages: Array.from({ length: 50 }, (_, index) =>
          message(index % 2 === 0 ? "user" : "assistant", `hydrated history item ${String(index + 1).padStart(2, "0")}`),
        ),
      });
      return;
    case "get_commands":
      respond(request, {
        commands: [
          { name: "mode", description: "Select Alloy mode", source: "extension" },
          { name: "plan", description: "Switch to Plan mode", source: "extension" },
          { name: "build", description: "Switch to Build mode", source: "extension" },
          { name: "approval", description: "Open approval", source: "extension" },
          { name: "cancel", description: "Open cancellable input", source: "extension" },
          { name: "backend-loss", description: "Terminate the fixture backend", source: "extension" },
        ],
      });
      return;
    case "get_available_models":
      respond(request, { models: [{ id: "fixture-model", provider: "fake", name: "Fixture" }] });
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
    case "prompt":
    case "steer": {
      const text = typeof request.message === "string" ? request.message : "";
      respond(request);
      send({ type: "message_end", message: message("user", text) });
      if (text === "/approval") {
        send({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "Allow fixture tool?", message: "Approve the PTY fixture." });
      } else if (text === "/cancel") {
        send({ type: "extension_ui_request", id: "cancel-1", method: "input", title: "Cancel this request", placeholder: "Escape must cancel" });
      } else if (text === "hold") {
        held = true;
        send({ type: "agent_start" });
      } else if (text === "/backend-loss") {
        setTimeout(() => process.exit(37), 50);
      } else if (text === "/mode" || text === "/plan" || text === "/build") {
        send({ type: "extension_ui_request", id: "mode-notice", method: "notify", notifyType: "info", message: "Mode command received" });
      } else {
        stream(text === "paused append" ? "sticky append stayed at the tail" : "streamed assistant text");
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
