/**
 * Load ~/.pi/alloy/env into process.env (export KEY=value lines).
 * Used by the launcher and by extensions so MCP ${VAR} expansion works
 * even if the process was not started via bin/alloy.mjs.
 * Does not override variables already set in the environment.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let loaded = false;

export function getAlloyEnvPath() {
  return join(homedir(), ".pi", "alloy", "env");
}

export function inspectAlloyEnvFile(path = getAlloyEnvPath()) {
  try {
    if (!existsSync(path)) return { ok: false, reason: "missing" };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: "secrets file must not be a symlink" };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: "secrets path is not a regular file" };
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return { ok: false, reason: "secrets file is not owned by this user" };
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return {
        ok: false,
        reason: "secrets file permissions must be 0600",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "secrets file unreadable",
    };
  }
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {{ path: string, loaded: boolean, keys: string[], reason?: string }}
 */
export function loadAlloyEnvFile(opts = {}) {
  const path = getAlloyEnvPath();
  if (loaded && !opts.force) {
    return { path, loaded: true, keys: [] };
  }
  /** @type {string[]} */
  const keys = [];
  try {
    const inspection = inspectAlloyEnvFile(path);
    if (!inspection.ok) {
      if (inspection.reason === "missing") loaded = true;
      return {
        path,
        loaded: false,
        keys,
        reason: inspection.reason,
      };
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
  } catch (error) {
    return {
      path,
      loaded: false,
      keys,
      reason: error instanceof Error ? error.message : "secrets file unreadable",
    };
  }
}
