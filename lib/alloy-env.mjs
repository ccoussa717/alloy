/**
 * Load ~/.pi/alloy/env into process.env (export KEY=value lines).
 * Used by the launcher and by extensions so MCP ${VAR} expansion works
 * even if the process was not started via bin/alloy.mjs.
 * Does not override variables already set in the environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let loaded = false;

export function getAlloyEnvPath() {
  return join(homedir(), ".pi", "alloy", "env");
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {{ path: string, loaded: boolean, keys: string[] }}
 */
export function loadAlloyEnvFile(opts = {}) {
  const path = getAlloyEnvPath();
  if (loaded && !opts.force) {
    return { path, loaded: true, keys: [] };
  }
  /** @type {string[]} */
  const keys = [];
  try {
    if (!existsSync(path)) {
      loaded = true;
      return { path, loaded: false, keys };
    }
    const text = readFileSync(path, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const cleaned = line.replace(/^export\s+/, "");
      const eq = cleaned.indexOf("=");
      if (eq <= 0) continue;
      const key = cleaned.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] != null && process.env[key] !== "") continue;
      let val = cleaned.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
      keys.push(key);
    }
    loaded = true;
    return { path, loaded: true, keys };
  } catch {
    return { path, loaded: false, keys };
  }
}
