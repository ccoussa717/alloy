import { describe, expect, it } from "bun:test";
import {
  ACTIVITY_ANIMATION_MS,
  ACTIVITY_TRACK_WIDTH,
  activityAnimationInterval,
  activityFrame,
  activityLabel,
  splashDivider,
} from "../src/presentation";

describe("OpenCode-style activity presentation", () => {
  it("uses a six-cell track (25% smaller than the old eight-cell bar)", () => {
    expect(ACTIVITY_TRACK_WIDTH).toBe(6);
    expect(activityFrame(0)).toBe("■·····");
    expect(activityFrame(5)).toBe("·····■");
    expect(activityFrame(6)).toBe("····■·");
    // Full bounce returns to the start: path length = (6-1)*2 = 10
    expect(activityFrame(10)).toBe(activityFrame(0));
  });

  it("animates by default, including over SSH; off/custom ms still work", () => {
    expect(activityAnimationInterval({})).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ SSH_CONNECTION: "client server" })).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ SSH_TTY: "/dev/pts/1" })).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "on" })).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "off" })).toBeNull();
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "auto" })).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "invalid" })).toBe(ACTIVITY_ANIMATION_MS);
    expect(activityAnimationInterval({ ALLOY_ACTIVITY_ANIMATION: "150" })).toBe(150);
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
