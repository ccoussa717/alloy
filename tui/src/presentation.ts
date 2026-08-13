import type { RetryState, ToolExecution } from "./session-store";
import { redactDisplayText, toolSummary } from "./content";

export interface ActivityState {
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  retry: RetryState | null;
  workflowLabel?: string;
}

/** Default footer track width (was 8; 25% smaller → 6). */
export const ACTIVITY_TRACK_WIDTH = 6;

/**
 * Frame delay for the Working indicator bounce.
 * ~120ms reads smoother than 80ms; still responsive enough to feel alive.
 * Override with ALLOY_ACTIVITY_ANIMATION=off|on|auto|N (ms).
 */
export const ACTIVITY_ANIMATION_MS = 120;

export function activityAnimationInterval(
  environment: Record<string, string | undefined> = process.env,
): number | null {
  const preference = environment.ALLOY_ACTIVITY_ANIMATION?.trim().toLowerCase() ?? "auto";
  if (preference === "off" || preference === "0" || preference === "false") return null;
  if (preference === "on" || preference === "true" || preference === "auto" || preference === "") {
    return ACTIVITY_ANIMATION_MS;
  }
  const ms = Number(preference);
  if (Number.isFinite(ms) && ms >= 30 && ms <= 2000) return Math.floor(ms);
  // Unknown values: keep animation on (including over SSH — users expect the bar to move).
  return ACTIVITY_ANIMATION_MS;
}

/**
 * One bright cell bouncing left↔right on a dim track.
 * Uses full-cycle endpoints so the turnaround holds a beat (smoother than
 * reversing mid-frame).
 */
export function activityFrame(frame: number, width = ACTIVITY_TRACK_WIDTH): string {
  const size = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (size === 0) return "";
  if (size === 1) return "■";
  // Path: 0..size-1 then size-2..1 (endpoint dwell once per turn).
  const pathLength = (size - 1) * 2;
  const cycle = ((Math.floor(frame) % pathLength) + pathLength) % pathLength;
  const position = cycle <= size - 1 ? cycle : pathLength - cycle;
  return Array.from({ length: size }, (_, index) => (index === position ? "■" : "·")).join("");
}

export function activityLabel(state: ActivityState, tools: ToolExecution[]): string {
  if (state.isCompacting) return "Compacting context";
  if (state.isRetrying && state.retry) {
    const attempt = `${state.retry.attempt}/${state.retry.maxAttempts}`;
    const error = redactDisplayText(state.retry.errorMessage).replace(/\s+/g, " ").trim();
    return `Retrying ${attempt}${error ? ` · ${error}` : ""}`;
  }
  const workflow = String(state.workflowLabel || "").trim();
  if (workflow) return workflow;
  const running = tools.find((tool) => tool.status === "running");
  if (running) return `Working · ${toolSummary(running.toolName, running.args)}`;
  if (state.isStreaming) return "Working";
  return "Ready";
}

export function splashDivider(width: number): string {
  const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return "─".repeat(Math.min("MULTI-MODEL CODING HARNESS".length, available));
}
