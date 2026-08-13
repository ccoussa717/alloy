import { describe, expect, it } from "bun:test";
import { resolveEscapeAction, shouldInterruptThenPrompt } from "../src/interrupt";

describe("resolveEscapeAction", () => {
  it("dismisses overlays before aborting the model", () => {
    expect(resolveEscapeAction({
      hasDialog: true,
      autocompleteOpen: true,
      modelBusy: true,
      hasNotifications: true,
    })).toBe("dialog");
    expect(resolveEscapeAction({
      hasDialog: false,
      autocompleteOpen: true,
      modelBusy: true,
      hasNotifications: true,
    })).toBe("autocomplete");
  });

  it("aborts a thinking model when no overlay is open", () => {
    expect(resolveEscapeAction({
      hasDialog: false,
      autocompleteOpen: false,
      modelBusy: true,
      hasNotifications: true,
    })).toBe("abort");
  });

  it("dismisses notifications only when the model is idle", () => {
    expect(resolveEscapeAction({
      hasDialog: false,
      autocompleteOpen: false,
      modelBusy: false,
      hasNotifications: true,
    })).toBe("notification");
    expect(resolveEscapeAction({
      hasDialog: false,
      autocompleteOpen: false,
      modelBusy: false,
      hasNotifications: false,
    })).toBe("none");
  });
});

describe("shouldInterruptThenPrompt", () => {
  it("interrupts ordinary chat while the model is thinking or using tools", () => {
    expect(shouldInterruptThenPrompt({
      text: "do this instead",
      isStreaming: true,
      toolsRunning: false,
    })).toBe(true);
    expect(shouldInterruptThenPrompt({
      text: "stop that file",
      isStreaming: false,
      toolsRunning: true,
    })).toBe(true);
  });

  it("does not interrupt idle chat or slash commands", () => {
    expect(shouldInterruptThenPrompt({
      text: "hello",
      isStreaming: false,
      toolsRunning: false,
    })).toBe(false);
    expect(shouldInterruptThenPrompt({
      text: "/fission review this",
      isStreaming: true,
      toolsRunning: false,
    })).toBe(false);
    expect(shouldInterruptThenPrompt({
      text: "   ",
      isStreaming: true,
      toolsRunning: false,
    })).toBe(false);
  });
});
