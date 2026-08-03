/**
 * Alloy config load/merge with a project trust boundary.
 *
 * Global: ~/.pi/alloy/config.json  (operator-trusted)
 * Project: .pi/alloy.json          (only if project trusted; tighten-only)
 *
 * Sandbox image/network/allowEnv/autoPull/mounts are GLOBAL-ONLY.
 * Project may not set mcp.connectOnStart true.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  getAlloyConfigPath,
  getProjectAlloyConfigPath,
} from "./paths.mjs";
import {
  isProjectTrusted,
  isWeakerPermission,
  stricterPermission,
  projectMayReplacePermission,
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
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.4",
      "xai/grok-4.5",
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
  orchestration: {
    enabled: false,
    mainModel: null,
    maxConcurrency: 3,
    roles: {
      research: { primary: "xai/grok-4.5", fallbacks: [] },
      planning: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
      implementation: { primary: "openai-codex/gpt-5.4", fallbacks: [] },
      review: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
      general: { primary: null, fallbacks: [] },
    },
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
      model: "xai/grok-4.5",
      tools: ["read", "grep", "find", "ls"],
    },
    code: {
      label: "Implement / code",
      model: "openai-codex/gpt-5.4",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    },
    review: {
      label: "Review",
      model: "anthropic/claude-opus-4-6",
      tools: ["read", "grep", "find", "ls"],
    },
    plan: {
      label: "Plan",
      model: "anthropic/claude-sonnet-4-6",
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
    architectModel: null,
    builderModel: null,
    synthesizerModel: null,
    architectEffort: null,
    builderEffort: null,
    synthesizerEffort: null,
  },
  fission: {
    models: [],
    judgeModel: null,
    modelFamilies: {},
    defaultReviewers: 3,
    maxReviewers: 5,
    blockingSeverity: "medium",
    minProviderCount: null,
    minFamilyCount: null,
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
  const config = deepMerge(DEFAULT_CONFIG, global);
  config.fission = validateGlobalFissionConfig(config.fission);
  return config;
}

function validateGlobalFissionConfig(fission) {
  if (!fission || typeof fission !== "object" || Array.isArray(fission)) {
    throw new Error("Invalid global fission config");
  }
  const { defaultReviewers, maxReviewers } = fission;
  if (
    !Number.isInteger(defaultReviewers) ||
    !Number.isInteger(maxReviewers) ||
    defaultReviewers < 1 ||
    defaultReviewers > maxReviewers ||
    maxReviewers > 5
  ) {
    throw new Error("Invalid global fission reviewer settings");
  }
  if (!Array.isArray(fission.models)) {
    throw new Error("Invalid global fission models");
  }
  const selectedRoutes = new Set(fission.models);
  if (typeof fission.judgeModel === "string") selectedRoutes.add(fission.judgeModel);
  if (
    Array.isArray(fission.models) &&
    typeof fission.judgeModel === "string" &&
    fission.models.includes(fission.judgeModel)
  ) {
    throw new Error("Invalid global fission judgeModel (must differ from reviewer models)");
  }
  const families = fission.modelFamilies;
  if (!families || typeof families !== "object" || Array.isArray(families)) {
    throw new Error("Invalid global fission modelFamilies");
  }
  const modelFamilies = {};
  for (const [route, label] of Object.entries(families)) {
    if (!selectedRoutes.has(route) || typeof label !== "string") {
      throw new Error("Invalid global fission modelFamilies");
    }
    const trimmed = label.trim();
    if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 64) {
      throw new Error("Invalid global fission modelFamilies");
    }
    modelFamilies[route] = trimmed;
  }
  const severity = fission.blockingSeverity;
  if (!Object.hasOwn({ critical: 1, high: 1, medium: 1, low: 1 }, severity)) {
    throw new Error("Invalid global fission blockingSeverity");
  }
  for (const key of ["minProviderCount", "minFamilyCount"]) {
    const value = fission[key];
    if (value != null && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`Invalid global fission ${key}`);
    }
  }
  return { ...fission, modelFamilies };
}

export function saveGlobalFusionConfig(fusion) {
  const path = ensureDefaultConfig();
  const invalid = Symbol("invalid-config");
  const current = loadJson(path, invalid);
  if (
    current === invalid ||
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    (current.fusion != null &&
      (typeof current.fusion !== "object" || Array.isArray(current.fusion)))
  ) {
    throw new Error(
      `Cannot save Fusion settings: invalid global config at ${path}`,
    );
  }
  const updated = {
    ...current,
    fusion: {
      ...(current.fusion && typeof current.fusion === "object"
        ? current.fusion
        : {}),
      ...fusion,
    },
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return loadGlobalConfig();
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
  out.orchestration = deepMerge(base.orchestration || {}, {});
  out.fission = deepMerge(base.fission || {}, {});

  // permissionProfile — only tighten; never demote global sandbox → non-sandbox
  if (project.permissionProfile != null) {
    const proj = normalizePermissionId(project.permissionProfile) || project.permissionProfile;
    const glob = normalizePermissionId(base.permissionProfile) || base.permissionProfile;
    if (!projectMayReplacePermission(proj, glob) || isWeakerPermission(proj, glob)) {
      rejected.push(
        glob === "sandbox" && proj !== "sandbox"
          ? `permissionProfile:${proj} (cannot replace global sandbox with non-sandbox; ignored)`
          : `permissionProfile:${proj} (weaker than global ${glob}; ignored)`,
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

  // Fission routes are operator-owned. Projects may only tighten reviewer
  // counts and the blocking threshold.
  if (project.fission && typeof project.fission === "object") {
    const proposed = project.fission;
    for (const key of ["models", "judgeModel", "modelFamilies"]) {
      if (Object.hasOwn(proposed, key)) {
        rejected.push(`fission.${key} (global-only; project override ignored)`);
      }
    }

    const hasDefault = Object.hasOwn(proposed, "defaultReviewers");
    const hasMax = Object.hasOwn(proposed, "maxReviewers");
    if (hasDefault || hasMax) {
      const globalDefault = base.fission?.defaultReviewers;
      const globalMax = base.fission?.maxReviewers;
      const projectDefault = proposed.defaultReviewers;
      const projectMax = proposed.maxReviewers;
      const effectiveMax = hasMax ? projectMax : globalMax;
      const effectiveDefault = hasDefault
        ? projectDefault
        : Math.min(globalDefault, effectiveMax);
      const valid =
        Number.isInteger(globalDefault) &&
        Number.isInteger(globalMax) &&
        Number.isInteger(effectiveDefault) &&
        Number.isInteger(effectiveMax) &&
        effectiveDefault >= 1 &&
        effectiveDefault <= effectiveMax &&
        effectiveMax <= globalMax &&
        (!hasDefault || effectiveDefault <= globalDefault);
      if (!valid) {
        rejected.push("fission.defaultReviewers/maxReviewers (must be integer tightenings with 1 <= defaultReviewers <= maxReviewers <= global max)");
      } else {
        out.fission.defaultReviewers = effectiveDefault;
        out.fission.maxReviewers = effectiveMax;
      }
    }

    if (Object.hasOwn(proposed, "blockingSeverity")) {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      const globalRank = rank[base.fission?.blockingSeverity];
      const projectRank = rank[proposed.blockingSeverity];
      if (projectRank === undefined || globalRank === undefined || projectRank < globalRank) {
        rejected.push("fission.blockingSeverity (must tighten the global threshold)");
      } else {
        out.fission.blockingSeverity = proposed.blockingSeverity;
      }
    }
  }
  if (project.budgets) {
    // project may only lower budgets (tighten)
    const b = { ...base.budgets };
    if (project.budgets.maxCostUsd != null) {
      const g = Number(base.budgets?.maxCostUsd);
      const p = Number(project.budgets.maxCostUsd);
      if (Number.isFinite(p) && p < 0) {
        rejected.push("budgets.maxCostUsd (must be non-negative)");
      } else if (Number.isFinite(p) && Number.isFinite(g) && p > g) {
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

  // orchestration policy is operator-owned; projects may only disable it or
  // lower concurrency. Model routes and the preferred main model stay global.
  if (project.orchestration && typeof project.orchestration === "object") {
    const proposed = project.orchestration;
    if (Object.hasOwn(proposed, "mainModel")) {
      rejected.push("orchestration.mainModel (global-only; project override ignored)");
    }
    if (Object.hasOwn(proposed, "roles")) {
      rejected.push("orchestration.roles (global-only; project override ignored)");
    }
    if (Object.hasOwn(proposed, "enabled") && typeof proposed.enabled !== "boolean") {
      rejected.push("orchestration.enabled (must be boolean)");
    } else if (proposed.enabled === false) {
      out.orchestration.enabled = false;
    } else if (proposed.enabled === true && base.orchestration?.enabled !== true) {
      rejected.push("orchestration.enabled (project cannot enable orchestration)");
    }
    if (proposed.maxConcurrency != null) {
      const globalMax = base.orchestration?.maxConcurrency;
      const projectMax = proposed.maxConcurrency;
      if (!Number.isInteger(projectMax) || projectMax < 1) {
        rejected.push("orchestration.maxConcurrency (must be a positive integer)");
      } else if (!Number.isInteger(globalMax) || globalMax < 1) {
        rejected.push("orchestration.maxConcurrency (invalid global limit; project override ignored)");
      } else if (projectMax > globalMax) {
        rejected.push("orchestration.maxConcurrency (cannot raise above global)");
      } else {
        out.orchestration.maxConcurrency = projectMax;
      }
    }
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
