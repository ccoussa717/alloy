export type EscapeAction = "dialog" | "autocomplete" | "abort" | "notification" | "none";

/** What Escape should do, most specific overlay first. */
export function resolveEscapeAction(input: {
  hasDialog: boolean;
  autocompleteOpen: boolean;
  modelBusy: boolean;
  hasNotifications: boolean;
}): EscapeAction {
  if (input.hasDialog) return "dialog";
  if (input.autocompleteOpen) return "autocomplete";
  if (input.modelBusy) return "abort";
  if (input.hasNotifications) return "notification";
  return "none";
}

/**
 * Ordinary chat while the main model is thinking should stop that turn
 * and send the new instruction now — not sit in the follow-up queue.
 * Slash commands keep their own streaming behavior.
 */
export function shouldInterruptThenPrompt(input: {
  text: string;
  isStreaming: boolean;
  toolsRunning: boolean;
}): boolean {
  const value = input.text.trim();
  if (!value || value.startsWith("/")) return false;
  return input.isStreaming || input.toolsRunning;
}
