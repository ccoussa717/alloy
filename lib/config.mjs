/**
 * Alloy config load/merge.
 * Global: ~/.pi/alloy/config.json
 * Project: .pi/alloy.json (may tighten policy, never weaken locked globals later)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getAlloyConfigPath,
  getProjectAlloyConfigPath,
} from "./paths.mjs";

export const DEFAULT_CONFIG = {
  version: 1,
  defaultMode: "build",
  permissionProfile: "safe",
  providers: {
    // MVP: only these three subscription providers
    allow: ["anthropic", "openai", "openai-codex", "xai"],
    favorites: [
      "anthropic/claude-sonnet-4-5",
      "openai-codex/gpt-5.1",
      "xai/grok-3",
    ],
  },
  memory: {
    enabled: true,
    maxInjectChars: 6000,
    autoLoad: true,
  },
  skills: {
    selfImprove: "approve", // propose → approve → save
    maxComposeDepth: 3,
  },
  mcp: {
    enabled: true,
    // Set true to auto-connect enabled servers on session start
    connectOnStart: false,
  },
  budgets: {
    maxCostUsd: 25,
    maxFixRounds: 2,
  },
  // Optional per-role models for /auto child agents (provider/model).
  // When unset, children inherit Pi's default/authenticated model.
  roles: {
    scout: { model: null },
    planner: { model: null },
    builder: { model: null },
    reviewer: { model: null },
  },
  auto: {
    useWorktree: true,
  },
};

export function loadJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function ensureDefaultConfig() {
  const path = getAlloyConfigPath();
  if (!existsSync(path)) {
    saveJson(path, DEFAULT_CONFIG);
  }
  return path;
}

export function loadConfig(cwd = process.cwd()) {
  ensureDefaultConfig();
  const global = loadJson(getAlloyConfigPath(), {}) || {};
  const project = loadJson(getProjectAlloyConfigPath(cwd), {}) || {};
  return deepMerge(deepMerge(DEFAULT_CONFIG, global), project);
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return b !== undefined ? b : a;
  if (typeof a !== "object" || a === null) return b !== undefined ? b : a;
  if (typeof b !== "object" || b === null) return b !== undefined ? b : a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = k in a ? deepMerge(a[k], v) : v;
  }
  return out;
}
