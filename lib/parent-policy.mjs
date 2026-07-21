/**
 * Resolve parent session policy for child spawns (commands + model-callable tools).
 */

import { getState } from "./state.mjs";
import { parentPolicyAxes } from "./project-trust.mjs";

/**
 * Snapshot parent approval + sandbox for alloy_task / alloy_auto / alloy_fusion.
 * Always read live session state — never default open.
 */
export function resolveParentChildSpawnOpts(overrides = {}) {
  const state = getState();
  const axes = parentPolicyAxes(
    overrides.permissionProfile ?? state.permissionProfile,
    overrides.sandbox ??
      (state.permissionProfile === "sandbox" || Boolean(state.sandboxActive)),
  );
  return {
    permissionProfile: axes.approvalProfile,
    parentPermissionProfile: axes.approvalProfile,
    sandbox: axes.sandbox,
    parentSandbox: axes.sandbox,
    mode:
      overrides.mode ??
      (state.mode === "plan" || state.mode === "review" ? state.mode : "build"),
  };
}
