import { describe, expect, it } from "bun:test";
import { resolveSubmission, type CommandContext } from "../src/commands";

const context: CommandContext = {
  isStreaming: false,
  commands: [
    { name: "mode", source: "extension" },
    { name: "help", source: "extension" },
  ],
  models: [
    { id: "claude-sonnet", provider: "anthropic", name: "Sonnet" },
    { id: "gpt-5", provider: "openai", name: "GPT-5" },
  ],
};

describe("resolveSubmission", () => {
  it("submits prompts and extension commands through the backend", () => {
    expect(resolveSubmission("hello", context)).toEqual({
      kind: "request",
      request: { type: "prompt", message: "hello" },
      clearInput: true,
    });
    expect(resolveSubmission("/mode plan", context)).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/mode plan" },
      clearInput: true,
      refresh: true,
    });
  });

  it("steers by default while streaming", () => {
    expect(resolveSubmission("change course", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "steer", message: "change course" },
      clearInput: true,
    });
  });

  it("maps local session commands to RPC without claiming completion", () => {
    expect(resolveSubmission("/new", context)).toEqual({
      kind: "request",
      request: { type: "new_session" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/clone", context)).toEqual({
      kind: "request",
      request: { type: "clone" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/compact focus on decisions", context)).toEqual({
      kind: "request",
      request: { type: "compact", customInstructions: "focus on decisions" },
      clearInput: true,
    });
    expect(resolveSubmission("/export", context)).toEqual({
      kind: "request",
      request: { type: "export_html" },
      clearInput: true,
      resultDialog: "export",
    });
    expect(resolveSubmission("/export session.jsonl", context)).toEqual({
      kind: "error",
      message: "OpenTUI /export does not accept a path; use --legacy-pi-ui for path or JSONL export.",
    });
    expect(resolveSubmission("/session", context)).toEqual({
      kind: "request",
      request: { type: "get_session_stats" },
      clearInput: true,
      resultDialog: "session",
    });
  });

  it("opens local evidence-backed selectors and help", () => {
    expect(resolveSubmission("/model", context)).toEqual({ kind: "dialog", dialog: "model-provider", clearInput: true });
    expect(resolveSubmission("/thinking", context)).toEqual({ kind: "dialog", dialog: "thinking", clearInput: true });
    expect(resolveSubmission("/help", context)).toEqual({ kind: "dialog", dialog: "help", clearInput: true });
    expect(resolveSubmission("/quit", context)).toEqual({ kind: "exit", clearInput: true });
  });

  it("keeps bare help local but sends help arguments to the registered backend command", () => {
    expect(resolveSubmission("/help", context)).toEqual({ kind: "dialog", dialog: "help", clearInput: true });
    expect(resolveSubmission("/help auth", context)).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/help auth" },
      clearInput: true,
      refresh: true,
    });
  });

  it("rejects unregistered slash commands instead of sending them to the model", () => {
    expect(resolveSubmission("/missing argument", context)).toEqual({
      kind: "error",
      message: "Unknown command: /missing",
    });
  });

  it("runs registered extension commands as prompts even while streaming", () => {
    expect(resolveSubmission("/mode build", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/mode build" },
      clearInput: true,
      refresh: true,
    });
  });

  it("sets explicit model and thinking choices with validated RPC fields", () => {
    expect(resolveSubmission("/model openai/gpt-5", context)).toEqual({
      kind: "request",
      request: { type: "set_model", provider: "openai", modelId: "gpt-5" },
      clearInput: true,
    });
    expect(resolveSubmission("/thinking high", context)).toEqual({
      kind: "request",
      request: { type: "set_thinking_level", level: "high" },
      clearInput: true,
    });
    expect(resolveSubmission("/thinking impossible", context)).toEqual({
      kind: "error",
      message: "Unknown thinking level: impossible",
    });
  });

  it("does not submit empty input", () => {
    expect(resolveSubmission("   ", context)).toEqual({ kind: "none" });
  });
});
