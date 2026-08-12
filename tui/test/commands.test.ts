import { describe, expect, it } from "bun:test";
import {
  commandCompletion,
  commandSuggestions,
  isExactCommandSuggestion,
  resolveSubmission,
  type CommandContext,
} from "../src/commands";

const context: CommandContext = {
  isStreaming: false,
  commands: [
    { name: "mode", source: "extension" },
    { name: "help", source: "extension" },
    { name: "review-prompt", source: "prompt" },
    { name: "skill:testing", source: "skill" },
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

  it("opens local evidence-backed selectors", () => {
    expect(resolveSubmission("/model", context)).toEqual({ kind: "dialog", dialog: "model-provider", clearInput: true });
    expect(resolveSubmission("/thinking", context)).toEqual({ kind: "dialog", dialog: "thinking", clearInput: true });
    expect(resolveSubmission("/quit", context)).toEqual({ kind: "exit", clearInput: true });
    expect(resolveSubmission("/sidebar", context)).toEqual({ kind: "toggle-sidebar", clearInput: true });
  });

  it("sends bare and topic help to the searchable backend command", () => {
    expect(resolveSubmission("/help", context)).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/help" },
      clearInput: true,
      refresh: true,
    });
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

  it("runs every backend slash command through prompt expansion while streaming", () => {
    expect(resolveSubmission("/help workflows", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/help workflows", streamingBehavior: "steer" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/mode build", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/mode build", streamingBehavior: "steer" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/review-prompt src", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/review-prompt src", streamingBehavior: "steer" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/skill:testing focused", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/skill:testing focused", streamingBehavior: "steer" },
      clearInput: true,
      refresh: true,
    });
  });

  it("canonicalizes command names and accepts every whitespace separator", () => {
    const commands = [...context.commands, { name: "fission", source: "extension" as const }];
    expect(resolveSubmission("/FISSION\tstatus", { ...context, commands })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/fission status" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/FISSION\nreview this", { ...context, commands, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/fission review this", streamingBehavior: "steer" },
      clearInput: true,
      refresh: true,
    });
    expect(resolveSubmission("/HELP\tworkflows", { ...context, isStreaming: true })).toEqual({
      kind: "request",
      request: { type: "prompt", message: "/help workflows", streamingBehavior: "steer" },
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

describe("commandSuggestions", () => {
  const commands = [
    { name: "plan", description: "Switch to Plan mode", source: "extension" as const },
    { name: "login-fixture", description: "Open authentication input", source: "extension" as const },
    { name: "help", description: "Backend help", source: "extension" as const },
  ];

  it("merges local and hydrated commands without duplicate names", () => {
    const suggestions = commandSuggestions("/", commands);
    expect(suggestions.filter((command) => command.name === "help")).toHaveLength(1);
    expect(suggestions.find((command) => command.name === "help")?.description).toBe("Browse and search Alloy help");
    expect(suggestions.some((command) => command.name === "plan")).toBe(true);
    expect(suggestions.filter((command) => command.name === "sidebar")).toHaveLength(1);
  });

  it("reserves local aliases from conflicting hydrated commands", () => {
    const conflicting = [
      ...commands,
      { name: "q", description: "Conflicting backend command", source: "extension" as const },
      { name: "exit", description: "Another conflict", source: "extension" as const },
    ];
    const suggestions = commandSuggestions("/", conflicting);
    expect(suggestions.some((command) => command.name === "q")).toBe(false);
    expect(suggestions.some((command) => command.name === "exit")).toBe(false);
    expect(commandSuggestions("/q", conflicting)[0]?.name).toBe("quit");
  });

  it("ranks names, aliases, descriptions, and fuzzy subsequences", () => {
    expect(commandSuggestions("/pl", commands)[0]?.name).toBe("plan");
    expect(commandSuggestions("/q", commands)[0]?.name).toBe("quit");
    expect(commandSuggestions("/auth", commands)[0]?.name).toBe("login-fixture");
    expect(commandSuggestions("/lgf", commands)[0]?.name).toBe("login-fixture");
  });

  it("does not suggest after arguments or for ordinary prompts", () => {
    expect(commandSuggestions("hello", commands)).toEqual([]);
    expect(commandSuggestions("/plan now", commands)).toEqual([]);
    expect(commandSuggestions("/plan\nnext", commands)).toEqual([]);
  });

  it("honors the visible suggestion limit", () => {
    expect(commandSuggestions("/", commands, 2)).toHaveLength(2);
    expect(commandSuggestions("/", commands, 0)).toEqual([]);
  });

  it("completes a selected command and closes the hint query", () => {
    expect(commandCompletion({ name: "plan" })).toBe("/plan ");
  });

  it("recognizes exact command names and local aliases", () => {
    expect(isExactCommandSuggestion("/plan", { name: "plan", aliases: [] })).toBe(true);
    expect(isExactCommandSuggestion("/q", { name: "quit", aliases: ["exit", "q"] })).toBe(true);
    expect(isExactCommandSuggestion("/pl", { name: "plan", aliases: [] })).toBe(false);
  });
});
