/**
 * Named multi-model agent profiles.
 * Resolve profile name → { model, tools, systemPrompt, thinking }.
 */

import { loadConfig } from "./config.mjs";
import { withHonesty } from "./honesty.mjs";

export const DEFAULT_PROFILES = {
  research: {
    label: "Research / explore",
    model: "xai/grok-4.5",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are a research agent. Explore the codebase thoroughly. Do not modify files. Cite paths and conclusions clearly.",
  },
  code: {
    label: "Implement / code",
    model: "openai-codex/gpt-5.4",
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    systemPrompt:
      "You are an implementation agent. Make focused code changes. Run checks when useful. Summarize what changed.",
  },
  review: {
    label: "Review",
    model: "anthropic/claude-opus-4-6",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are an independent reviewer. Findings first, severity-ordered. Do not implement. End with VERDICT: PASS or VERDICT: FAIL.",
  },
  plan: {
    label: "Plan",
    model: "anthropic/claude-sonnet-4-6",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are a planning agent. Produce a concrete numbered plan with requirements. Do not modify files.",
  },
  default: {
    label: "General",
    model: null,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    systemPrompt: "You are a helpful coding agent. Be precise and complete the task.",
  },
};

/**
 * Merge config.profiles over defaults.
 */
export function getProfiles(cwd = process.cwd()) {
  const cfg = loadConfig(cwd);
  const fromCfg = cfg.profiles || {};
  const out = { ...DEFAULT_PROFILES };
  for (const [name, spec] of Object.entries(fromCfg)) {
    out[name] = {
      ...(DEFAULT_PROFILES[name] || DEFAULT_PROFILES.default),
      ...spec,
      // deep-ish tools replace
      tools: spec.tools || (DEFAULT_PROFILES[name] || DEFAULT_PROFILES.default).tools,
    };
  }
  // Also map /auto roles into profiles if not overridden
  if (cfg.roles) {
    for (const [role, spec] of Object.entries(cfg.roles)) {
      if (!out[role] && spec?.model) {
        out[role] = {
          label: `Auto role: ${role}`,
          model: spec.model,
          tools: role === "builder" || role === "fixer"
            ? DEFAULT_PROFILES.code.tools
            : DEFAULT_PROFILES.research.tools,
          systemPrompt: DEFAULT_PROFILES[role]?.systemPrompt || DEFAULT_PROFILES.default.systemPrompt,
        };
      } else if (out[role] && spec?.model) {
        out[role] = { ...out[role], model: spec.model };
      }
    }
  }
  return out;
}

export function resolveProfile(name, cwd = process.cwd()) {
  const profiles = getProfiles(cwd);
  if (!name) return { ...profiles.default, name: "default" };
  const key = String(name).toLowerCase().trim();
  const p = profiles[key];
  if (!p) return null;
  return { ...p, name: key };
}

export function listProfiles(cwd = process.cwd()) {
  const profiles = getProfiles(cwd);
  return Object.entries(profiles).map(([name, p]) => ({
    name,
    label: p.label || name,
    model: p.model || "(default)",
    tools: (p.tools || []).join(","),
  }));
}

/**
 * Resolve model string: explicit > profile > null (inherit).
 */
export function resolveAgentSpec({
  profile,
  model,
  tools,
  systemPrompt,
  cwd = process.cwd(),
} = {}) {
  const base = resolveProfile(profile || "default", cwd) || {
    ...DEFAULT_PROFILES.default,
    name: "default",
  };
  const resolvedModel = model || base.model || null;
  const basePrompt =
    systemPrompt || base.systemPrompt || DEFAULT_PROFILES.default.systemPrompt;
  // Parse provider/id when profile model is "provider/id"
  let provider = null;
  let modelId = resolvedModel;
  if (resolvedModel && String(resolvedModel).includes("/")) {
    const [p, ...rest] = String(resolvedModel).split("/");
    provider = p;
    modelId = rest.join("/") || resolvedModel;
  }
  const honestPrompt = withHonesty(basePrompt, {
    provider,
    modelId,
    role: base.name || profile || "agent",
  });
  return {
    profile: base.name || profile || "default",
    model: resolvedModel,
    tools: tools && tools.length ? tools : base.tools || DEFAULT_PROFILES.default.tools,
    systemPrompt: honestPrompt,
    label: base.label || base.name,
  };
}
