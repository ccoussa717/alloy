/**
 * Alloy config load/merge with trust boundary (P0.1).
 *
 * Global: ~/.pi/alloy/config.json  (operator-trusted)
 * Project: .pi/alloy.json          (only if project trusted; tighten-only)
 *
 * Sandbox image/network/allowEnv/autoPull/mounts are GLOBAL-ONLY.
 * Project may not set mcp.connectOnStart true.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getAlloyConfigPath,
  getProjectAlloyConfigPath,
} from "./paths.mjs";
import {
  isProjectTrusted,
  isWeakerPermission,
  stricterPermission,
} from "./project-trust.mjs";
import { normalizePermissionId } from "./permissions.mjs";

export const DEFAULT_CONFIG = {
  version: 1,
  defaultMode: "build",
  // ask-all | ask-some | ask-dangerous | ask-none | sandbox
  permissionProfile: "ask-dangerous",
  providers: {
    allow: ["anthropic", "openai", "openai-codex", "xai"],
    favorites: [
      "anthropic/claude-sonnet-4-5",
      "openai-codex/gpt-5.3",
      "xai/grok-4",
    ],
  },
  memory: {
    enabled: true,
    maxInjectChars: 6000,
    autoLoad: true,
  },
  honesty: {
    enabled: true,
  },
  skills: {
    selfImprove: "approve",
    maxComposeDepth: 3,
  },
  mcp: {
    enabled: true,
    // Global operator opt-in only. Project cannot enable this.
    connectOnStart: false,
  },
  budgets: {
    maxCostUsd: 25,
    maxFixRounds: 2,
  },
  roles: {
    scout: { model: null },
    planner: { model: null },
    builder: { model: null },
    fixer: { model: null },
    reviewer: { model: null },
  },
  profiles: {
    research: {
      label: "Research / explore",
      model: "xai/grok-4",
      tools: ["read", "grep", "find", "ls"],
    },
    code: {
      label: "Implement / code",
      model: "openai-codex/gpt-5.3",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    },
    review: {
      label: "Review",
      model: "anthropic/claude-opus-4-6",
      tools: ["read", "grep", "find", "ls"],
    },
    plan: {
      label: "Plan",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["read", "grep", "find", "ls"],
    },
    default: {
      label: "General",
      model: null,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    },
  },
  auto: {
    useWorktree: true,
  },
  fusion: {
    models: [],
    workerCount: 2,
    mergerModel: null,
  },
  sandbox: {
    engine: "docker",
    image: "node:22-bookworm",
    network: "none",
    memory: "2g",
    cpus: "2",
    workdir: "/workspace",
    autoPull: true,
    allowEnv: ["PATH", "HOME", "NODE_ENV", "TERM", "LANG", "npm_config_cache"],
  },
};

/** Keys a trusted project may never override (operator / global only). */
export const GLOBAL_ONLY_SANDBOX_KEYS = [
  "image",
  "network",
  "allowEnv",
  "autoPull",
  "mounts",
  "engine",
  "pull",
];

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

/**
 * Operator base: defaults ⊕ global config (never project).
 */
export function loadGlobalConfig() {
  ensureDefaultConfig();
  const global = loadJson(getAlloyConfigPath(), {}) || {};
  return deepMerge(DEFAULT_CONFIG, global);
}

/**
 * Merge project config onto operator base with tighten-only rules.
 * @param {object} base - global+defaults
 * @param {object} project - raw project JSON
 * @returns {{ config: object, rejected: string[] }}
 */
export function mergeProjectConfigTightenOnly(base, project) {
  const rejected = [];
  if (!project || typeof project !== "object") {
    return { config: base, rejected };
  }

  const out = deepMerge(base, {});
  // Shallow-clone nested objects we may mutate
  out.mcp = { ...(base.mcp || {}) };
  out.sandbox = { ...(base.sandbox || {}) };
  out.memory = { ...(base.memory || {}) };
  out.honesty = { ...(base.honesty || {}) };
  out.auto = { ...(base.auto || {}) };
  out.budgets = { ...(base.budgets || {}) };

  // permissionProfile — only tighten
  if (project.permissionProfile != null) {
    const proj = normalizePermissionId(project.permissionProfile) || project.permissionProfile;
    const glob = normalizePermissionId(base.permissionProfile) || base.permissionProfile;
    if (isWeakerPermission(proj, glob)) {
      rejected.push(
        `permissionProfile:${proj} (weaker than global ${glob}; ignored)`,
      );
    } else {
      out.permissionProfile = stricterPermission(proj, glob);
    }
  }

  // defaultMode — allow project preference (non-security)
  if (project.defaultMode != null) {
    out.defaultMode = project.defaultMode;
  }

  // mcp — project cannot enable connectOnStart; cannot force enabled if global off
  if (project.mcp && typeof project.mcp === "object") {
    if (project.mcp.connectOnStart === true) {
      rejected.push("mcp.connectOnStart (project cannot enable auto-connect)");
    }
    if (project.mcp.enabled === false) {
      out.mcp.enabled = false; // tighten OK
    } else if (project.mcp.enabled === true && base.mcp?.enabled === false) {
      rejected.push("mcp.enabled (cannot enable if global disabled)");
    }
  }

  // sandbox — only non-global-only keys may come from project (e.g. memory/cpus/workdir limits can tighten later)
  if (project.sandbox && typeof project.sandbox === "object") {
    for (const [k, v] of Object.entries(project.sandbox)) {
      if (GLOBAL_ONLY_SANDBOX_KEYS.includes(k)) {
        rejected.push(`sandbox.${k} (global-only; project override ignored)`);
        continue;
      }
      // allow memory/cpus/workdir as tighten-ish project prefs for now
      out.sandbox[k] = v;
    }
  }

  // roles / profiles / fusion / auto — allowed for trusted projects (model selection)
  if (project.roles) out.roles = deepMerge(base.roles || {}, project.roles);
  if (project.profiles) out.profiles = deepMerge(base.profiles || {}, project.profiles);
  if (project.fusion) out.fusion = deepMerge(base.fusion || {}, project.fusion);
  if (project.auto) out.auto = deepMerge(base.auto || {}, project.auto);
  if (project.budgets) {
    // project may only lower budgets (tighten)
    const b = { ...base.budgets };
    if (project.budgets.maxCostUsd != null) {
      const g = Number(base.budgets?.maxCostUsd);
      const p = Number(project.budgets.maxCostUsd);
      if (Number.isFinite(p) && Number.isFinite(g) && p > g) {
        rejected.push("budgets.maxCostUsd (cannot raise above global)");
      } else if (Number.isFinite(p)) {
        b.maxCostUsd = p;
      }
    }
    if (project.budgets.maxFixRounds != null) {
      const g = Number(base.budgets?.maxFixRounds);
      const p = Number(project.budgets.maxFixRounds);
      if (Number.isFinite(p) && Number.isFinite(g) && p > g) {
        rejected.push("budgets.maxFixRounds (cannot raise above global)");
      } else if (Number.isFinite(p)) {
        b.maxFixRounds = p;
      }
    }
    out.budgets = b;
  }

  // honesty — project may not disable
  if (project.honesty?.enabled === false) {
    rejected.push("honesty.enabled=false (cannot disable honesty from project)");
  }

  // memory — project may disable autoLoad / lower maxInjectChars only
  if (project.memory && typeof project.memory === "object") {
    if (project.memory.enabled === false) out.memory.enabled = false;
    if (project.memory.autoLoad === false) out.memory.autoLoad = false;
    if (project.memory.maxInjectChars != null) {
      const g = Number(base.memory?.maxInjectChars) || 6000;
      const p = Number(project.memory.maxInjectChars);
      if (Number.isFinite(p) && p <= g) out.memory.maxInjectChars = p;
      else if (Number.isFinite(p) && p > g) {
        rejected.push("memory.maxInjectChars (cannot raise above global)");
      }
    }
  }

  return { config: out, rejected };
}

/**
 * Load effective Alloy config for cwd.
 * @param {string} [cwd]
 * @param {{ trusted?: boolean }} [opts] — force trust decision for tests
 */
export function loadConfig(cwd = process.cwd(), opts = {}) {
  const base = loadGlobalConfig();
  const trusted =
    opts.trusted !== undefined
      ? Boolean(opts.trusted)
      : isProjectTrusted(cwd);

  if (!trusted) {
    return base;
  }

  const projectPath = getProjectAlloyConfigPath(cwd);
  const project = loadJson(projectPath, null);
  if (!project) return base;

  const { config } = mergeProjectConfigTightenOnly(base, project);
  return config;
}

/**
 * Like loadConfig but also returns trust + rejection diagnostics.
 */
export function loadConfigDetailed(cwd = process.cwd(), opts = {}) {
  const base = loadGlobalConfig();
  const trusted =
    opts.trusted !== undefined
      ? Boolean(opts.trusted)
      : isProjectTrusted(cwd);
  const projectPath = getProjectAlloyConfigPath(cwd);
  const projectExists = existsSync(projectPath);
  const project = projectExists ? loadJson(projectPath, null) : null;

  if (!trusted) {
    return {
      config: base,
      trusted: false,
      projectApplied: false,
      projectExists,
      rejected: projectExists
        ? ["project config ignored (project not trusted)"]
        : [],
    };
  }

  if (!project) {
    return {
      config: base,
      trusted: true,
      projectApplied: false,
      projectExists,
      rejected: [],
    };
  }

  const { config, rejected } = mergeProjectConfigTightenOnly(base, project);
  return {
    config,
    trusted: true,
    projectApplied: true,
    projectExists,
    rejected,
  };
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
