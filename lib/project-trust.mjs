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
 *
 * Permission model (child-policy follow-up):
 * - Approval axis: ask-all | ask-some | ask-dangerous | ask-none
 * - Isolation axis: sandbox flag (orthogonal). Profile id "sandbox" means
 *   isolation on + default approval ask-dangerous, not "allow all tools".
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

  return false;
}

/**
 * Approval-axis autonomy rank — higher = more autonomous / weaker safety.
 * Sandbox is NOT on this axis.
 */
export const APPROVAL_AUTONOMY_RANK = {
  "ask-all": 0,
  "ask-some": 1,
  "ask-dangerous": 2,
  "ask-none": 3,
};

/** @deprecated use APPROVAL_AUTONOMY_RANK; kept for older imports */
export const PERMISSION_AUTONOMY_RANK = {
  ...APPROVAL_AUTONOMY_RANK,
  // legacy: sandbox was mis-ranked on the approval axis
  sandbox: 1.5,
};

/**
 * Map any profile id to an approval profile (never returns "sandbox").
 * Profile "sandbox" → isolation flag elsewhere; approval defaults to ask-dangerous.
 */
export function toApprovalProfile(profile) {
  if (!profile) return "ask-dangerous";
  const p = String(profile).trim().toLowerCase();
  if (p === "sandbox") return "ask-dangerous";
  if (p === "readonly" || p === "safe") return "ask-dangerous";
  if (p === "workspace") return "ask-none";
  if (Object.prototype.hasOwnProperty.call(APPROVAL_AUTONOMY_RANK, p)) return p;
  return "ask-dangerous";
}

export function isSandboxProfileId(profile) {
  return String(profile || "").trim().toLowerCase() === "sandbox";
}

/**
 * Stricter of two approval profiles (ask-* only).
 */
export function stricterApproval(a, b) {
  const aa = toApprovalProfile(a);
  const bb = toApprovalProfile(b);
  const ra = APPROVAL_AUTONOMY_RANK[aa] ?? 2;
  const rb = APPROVAL_AUTONOMY_RANK[bb] ?? 2;
  return ra <= rb ? aa : bb;
}

/**
 * Config-merge helper: preserve sandbox profile id when either side is sandbox
 * (isolation ceiling). Otherwise compare approval ranks.
 */
export function stricterPermission(a, b) {
  if (isSandboxProfileId(a) && isSandboxProfileId(b)) return "sandbox";
  if (isSandboxProfileId(a) || isSandboxProfileId(b)) return "sandbox";
  return stricterApproval(a, b);
}

/**
 * Whether project wants a weaker profile than global.
 * Demoting sandbox → any non-sandbox is always weaker.
 */
export function isWeakerPermission(projectProfile, globalProfile) {
  if (isSandboxProfileId(globalProfile) && !isSandboxProfileId(projectProfile)) {
    return true;
  }
  if (isSandboxProfileId(projectProfile)) {
    // Project enabling sandbox tightens isolation — not weaker.
    return false;
  }
  const rp = APPROVAL_AUTONOMY_RANK[toApprovalProfile(projectProfile)];
  const rg = APPROVAL_AUTONOMY_RANK[toApprovalProfile(globalProfile)];
  if (rp == null || rg == null) return true;
  return rp > rg;
}

/**
 * Whether a project-proposed profile is allowed to replace the operator global profile.
 */
export function projectMayReplacePermission(projectProfile, globalProfile) {
  if (!projectProfile || !globalProfile) return false;
  if (isSandboxProfileId(globalProfile) && !isSandboxProfileId(projectProfile)) {
    return false;
  }
  if (isWeakerPermission(projectProfile, globalProfile)) return false;
  return true;
}

/**
 * Parent session → child inheritance axes (approval + sandbox flag).
 */
export function parentPolicyAxes(permissionProfile, sandboxFlag = false) {
  const raw = permissionProfile || "ask-dangerous";
  return {
    approvalProfile: toApprovalProfile(raw),
    sandbox: Boolean(sandboxFlag) || isSandboxProfileId(raw),
    rawProfile: raw,
  };
}
