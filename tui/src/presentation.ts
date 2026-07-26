import type { RetryState, ToolExecution } from "./session-store";
import { redactDisplayText, toolSummary } from "./content";

export interface ActivityState {
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  retry: RetryState | null;
}

export function activityAnimationInterval(
  environment: Record<string, string | undefined> = process.env,
): number | null {
  const preference = environment.ALLOY_ACTIVITY_ANIMATION?.trim().toLowerCase() ?? "auto";
  if (preference === "on") return 80;
  if (preference === "off") return null;
  return environment.SSH_CONNECTION || environment.SSH_TTY ? null : 80;
}

export function activityFrame(frame: number, width = 8): string {
  const size = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (size === 0) return "";
  if (size === 1) return "■";
  const cycleLength = (size - 1) * 2;
  const cycle = ((Math.floor(frame) % cycleLength) + cycleLength) % cycleLength;
  const position = cycle < size ? cycle : cycleLength - cycle;
  return Array.from({ length: size }, (_, index) => index === position ? "■" : "⬝").join("");
}

export function activityLabel(state: ActivityState, tools: ToolExecution[]): string {
  if (state.isCompacting) return "Compacting context";
  if (state.isRetrying && state.retry) {
    const attempt = `${state.retry.attempt}/${state.retry.maxAttempts}`;
    const error = redactDisplayText(state.retry.errorMessage).replace(/\s+/g, " ").trim();
    return `Retrying ${attempt}${error ? ` · ${error}` : ""}`;
  }
  const running = tools.find((tool) => tool.status === "running");
  if (running) return `Working · ${toolSummary(running.toolName, running.args)}`;
  if (state.isStreaming) return "Working";
  return "Ready";
}

export function splashDivider(width: number): string {
  const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return "─".repeat(Math.min("MULTI-MODEL CODING HARNESS".length, available));
}
