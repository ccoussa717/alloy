/**
 * Launch preview: what Fusion / Fission / Auto will actually start.
 * Distinguishes setup-pinned routes from factory defaults.
 */
import { DEFAULT_CONFIG, loadConfig, loadConfigDetailed } from "./config.mjs";
import { getFusionRoleModelDefaults } from "./fusion.mjs";
import { AUTO_ROLE_NAMES, resolveAutoRoleModels } from "./model-map.mjs";

const FACTORY_FUSION = DEFAULT_CONFIG.fusion || {};
const FACTORY_ORCH = DEFAULT_CONFIG.orchestration?.roles || {};
const FACTORY_PROFILES = DEFAULT_CONFIG.profiles || {};
const FACTORY_FAVORITES = DEFAULT_CONFIG.providers?.favorites || [];

function setupPinned(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function factoryLabel(route, factoryRoute) {
  if (!route) return "unset";
  if (factoryRoute && route === factoryRoute) return `${route}  [factory default]`;
  return route;
}

export function formatLaunchPreview(cwd = process.cwd()) {
  const detailed = loadConfigDetailed(cwd);
  const cfg = detailed.config || loadConfig(cwd);
  const fusionCfg = cfg.fusion || {};
  const fission = cfg.fission || {};
  const orch = cfg.orchestration || {};
  const fusionDefaults = getFusionRoleModelDefaults(cfg);
  const autoModels = resolveAutoRoleModels(cfg);

  const fusionSetupComplete = Boolean(
    setupPinned(fusionCfg.architectModel) &&
      setupPinned(fusionCfg.builderModel) &&
      setupPinned(fusionCfg.synthesizerModel || fusionCfg.mergerModel),
  );

  const lines = [
    "Launch preview (what the next run will start)",
    "",
    `Orchestration: ${orch.enabled === true ? "enabled" : "off"}`,
    `Project config: ${
      detailed.projectApplied
        ? "trusted + applied"
        : detailed.projectExists
          ? detailed.trusted
            ? "trusted but not applied"
            : "present, not trusted (ignored)"
          : "none"
    }`,
    ...(Array.isArray(detailed.rejected) && detailed.rejected.length
      ? detailed.rejected.map((item) => `  rejected: ${item}`)
      : []),
    "",
    "Fusion",
    fusionSetupComplete
      ? "  setup: complete (exact routes)"
      : "  setup: incomplete — generic orchestration / factory fallbacks",
    `  architect: ${factoryLabel(
      fusionDefaults.architect,
      FACTORY_ORCH.planning?.primary || FACTORY_PROFILES.plan?.model || FACTORY_FAVORITES[0],
    )}${setupPinned(fusionCfg.architectModel) ? "  [setup]" : ""}`,
    `  builder: ${factoryLabel(
      fusionDefaults.builder,
      FACTORY_ORCH.implementation?.primary || FACTORY_PROFILES.code?.model,
    )}${setupPinned(fusionCfg.builderModel) ? "  [setup]" : ""}`,
    `  synthesizer: ${factoryLabel(
      fusionDefaults.synthesizer,
      FACTORY_ORCH.review?.primary || FACTORY_PROFILES.review?.model,
    )}${setupPinned(fusionCfg.synthesizerModel || fusionCfg.mergerModel) ? "  [setup]" : ""}`,
    "",
    "Fission",
    `  mode: repo = dirty tree vs HEAD (not whole-repo); subject = request text`,
    `  orchestration: ${orch.enabled === true ? "enabled" : "DISABLED — run fails before children"}`,
    ...(Array.isArray(fission.models) && fission.models.length
      ? fission.models.map((model, index) => {
          const role = Array.isArray(fission.roles) ? fission.roles[index] : "";
          return `  R${index + 1}${role ? ` [${role}]` : ""}: ${model}  [setup]`;
        })
      : ["  reviewers: none — run /fission setup"]),
    `  judge: ${fission.judgeModel || "not configured"}`,
    "",
    "Auto / Forge implement",
    ...AUTO_ROLE_NAMES.map((role) => {
      const configured = setupPinned(cfg.roles?.[role]?.model);
      const route = autoModels[role];
      return `  ${role}: ${route || "(unset)"}${configured ? "  [setup]" : "  [resolved]"}`;
    }),
    `  forceSandbox: ${cfg.auto?.forceSandbox === true}`,
    `  useWorktree: ${cfg.auto?.useWorktree !== false}`,
    "",
    "Chat /agent uses the requested model only — no silent factory replace.",
    "Use /fusion setup, /fission setup, /auto setup to pin routes.",
  ];
  return lines;
}
