import { describe, expect, it } from "bun:test";
import { activityAnimationInterval, activityFrame, activityLabel, splashDivider } from "../src/presentation";

describe("OpenCode-style activity presentation", () => {
  it("moves one bright block back and forth across an eight-cell track", () => {
    expect(activityFrame(0)).toBe("■⬝⬝⬝⬝⬝⬝⬝");
    expect(activityFrame(7)).toBe("⬝⬝⬝⬝⬝⬝⬝■");
    expect(activityFrame(8)).toBe("⬝⬝⬝⬝⬝⬝■⬝");
    expect(activityFrame(14)).toBe(activityFrame(0));
  });

  it("avoids continuous redraws over SSH unless animation is explicitly enabled", () => {
    expect(activityAnimationInterval({})).toBe(80);
    expect(activityAnimationInterval({ SSH_CONNECTION: "client server" })).toBeNull();
    expect(activityAnimationInterval({ SSH_TTY: "/dev/pts/1" })).toBeNull();
    expect(activityAnimationInterval({ SSH_CONNECTION: "client server", ALLOY_ACTIVITY_ANIMATION: "on" })).toBe(80);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "off" })).toBeNull();
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "auto" })).toBe(80);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "invalid" })).toBe(80);
  });

  it("reports the current tool, retries, compaction, and idle state", () => {
    const base = { isStreaming: true, isCompacting: false, isRetrying: false, retry: null };
    expect(activityLabel(base, [{ toolCallId: "1", toolName: "bash", args: { command: "bun test" }, status: "running" }])).toBe(
      "Working · $ bun test",
    );
    expect(activityLabel({ ...base, isRetrying: true, retry: { attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: "rate limited" } }, [])).toBe(
      "Retrying 2/3 · rate limited",
    );
    expect(activityLabel({ ...base, isCompacting: true }, [])).toBe("Compacting context");
    expect(activityLabel({ ...base, isStreaming: false }, [])).toBe("Ready");
  });

  it("restores the green splash divider without overflowing narrow terminals", () => {
    expect(splashDivider(80)).toBe("─".repeat("MULTI-MODEL CODING HARNESS".length));
    expect(splashDivider(12)).toBe("─".repeat(12));
    expect(splashDivider(0)).toBe("");
  });
});
