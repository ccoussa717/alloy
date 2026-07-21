/**
 * Project trust gate for Alloy.
 *
 * Project-local Alloy config (`.pi/alloy.json`) and MCP (`.pi/alloy-mcp.json`)
 * are ignored until the project is trusted.
 *
 * Trust sources (first match wins for "yes"):
 * 1. Explicit runtime override set by the extension (Pi session: ctx.isProjectTrusted)
 * 2. Pi trust store ~/.pi/agent/trust.json (path → true|false)
 * 3. Default: untrusted (fail closed)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

/** @type {Map<string, boolean>} */
const runtimeTrust = new Map();

function normalizeCwd(cwd) {
  try {
    return resolve(cwd || process.cwd());
  } catch {
    return String(cwd || process.cwd());
  }
}

function getTrustStorePath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "trust.json");
}

/**
 * Read Pi trust.json decision for cwd or an ancestor.
 * @returns {boolean | null} true/false if known, null if no entry
 */
export function readPiTrustDecision(cwd = process.cwd()) {
  const path = getTrustStorePath();
  if (!existsSync(path)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  let current = normalizeCwd(cwd);
  while (true) {
    if (Object.prototype.hasOwnProperty.call(data, current)) {
      const v = data[current];
      if (v === true) return true;
      if (v === false) return false;
      // null = cleared entry; keep walking
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Set/clear session trust for a cwd (from Pi project_trust / isProjectTrusted).
 */
export function setRuntimeProjectTrust(cwd, trusted) {
  const key = normalizeCwd(cwd);
  if (trusted === null || trusted === undefined) {
    runtimeTrust.delete(key);
    return;
  }
  runtimeTrust.set(key, Boolean(trusted));
}

export function clearRuntimeProjectTrust() {
  runtimeTrust.clear();
}

/**
 * @param {string} [cwd]
 * @param {{ forceTrusted?: boolean, forceUntrusted?: boolean }} [opts]
 * @returns {boolean}
 */
export function isProjectTrusted(cwd = process.cwd(), opts = {}) {
  if (opts.forceUntrusted) return false;
  if (opts.forceTrusted) return true;

  const key = normalizeCwd(cwd);
  if (runtimeTrust.has(key)) return runtimeTrust.get(key);

  // Also check exact runtime map by walking ancestors
  let current = key;
  while (true) {
    if (runtimeTrust.has(current)) return runtimeTrust.get(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const decision = readPiTrustDecision(cwd);
  if (decision === true) return true;
  if (decision === false) return false;

  // Fail closed: untrusted until proven otherwise
  return false;
}

/**
 * Permission restrictiveness rank — higher = more autonomous / weaker safety.
 * Project config may only decrease this number relative to global, never increase.
 */
export const PERMISSION_AUTONOMY_RANK = {
  "ask-all": 0,
  "ask-some": 1,
  "ask-dangerous": 2,
  sandbox: 2, // constrained execution; treat as not weaker than ask-dangerous
  "ask-none": 3,
};

/**
 * Pick the stricter (lower autonomy) of two permission profiles.
 */
export function stricterPermission(a, b) {
  const ra = PERMISSION_AUTONOMY_RANK[a] ?? 2;
  const rb = PERMISSION_AUTONOMY_RANK[b] ?? 2;
  return ra <= rb ? a : b;
}

/**
 * Whether project wants a weaker (more autonomous) profile than global.
 */
export function isWeakerPermission(projectProfile, globalProfile) {
  const rp = PERMISSION_AUTONOMY_RANK[projectProfile];
  const rg = PERMISSION_AUTONOMY_RANK[globalProfile];
  if (rp == null || rg == null) return true; // unknown → treat as weaken attempt
  return rp > rg;
}
