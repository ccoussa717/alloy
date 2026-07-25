/**
 * Ensure Shift+Tab is free for Alloy Build/Plan mode cycling
 * (unbind Pi's default app.thinking.cycle).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const MARKER = "_alloyNote";

export function getKeybindingsPath() {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "keybindings.json");
}

/**
 * Merge Alloy keybinding preferences without wiping user customizations.
 * Sets app.thinking.cycle to [] so Shift+Tab is available for operating modes.
 * Thinking is controlled via /effort instead.
 */
export function ensureAlloyKeybindings() {
  const path = getKeybindingsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8")) || {};
    } catch {
      data = {};
    }
  }

  // Empty array = unbound in Pi keybinding system (when supported);
  // also set undefined-friendly empty list.
  const cycle = data["app.thinking.cycle"];
  const already =
    Array.isArray(cycle) && cycle.length === 0 && data[MARKER] === "shift-tab-modes";

  if (already) return { path, changed: false };

  data["app.thinking.cycle"] = [];
  data[MARKER] = "shift-tab-modes";
  // Optional: document companion — users can rebind thinking cycle elsewhere
  if (!data["app.thinking.cycleAlt"]) {
    // leave unset; /effort is the primary UX
  }

  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return { path, changed: true };
}
