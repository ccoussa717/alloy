/**
 * Process-local Alloy session state shared across extension modules.
 * Modes and permission profile must stay in sync for tool gating.
 */

const state = {
  mode: "build", // chat | plan | build | review
  permissionProfile: "safe", // readonly | safe | workspace
  mcpConnected: false,
  mcpToolCount: 0,
};

export function getState() {
  return { ...state };
}

export function setMode(mode) {
  const allowed = ["chat", "plan", "build", "review"];
  if (!allowed.includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Use: ${allowed.join(", ")}`);
  }
  state.mode = mode;
  // Plan and review force readonly-leaning policy for mutation tools
  if (mode === "plan" || mode === "review") {
    // Soft-force: if user is on workspace, keep it but policy still blocks writes in plan/review
  }
  return getState();
}

export function setPermissionProfile(profile) {
  const allowed = ["readonly", "safe", "workspace"];
  if (!allowed.includes(profile)) {
    throw new Error(`Invalid profile: ${profile}`);
  }
  state.permissionProfile = profile;
  return getState();
}

export function setMcpStats({ connected, toolCount }) {
  state.mcpConnected = Boolean(connected);
  state.mcpToolCount = toolCount || 0;
  return getState();
}

export function isReadOnlyMode() {
  return (
    state.mode === "plan" ||
    state.mode === "review" ||
    state.permissionProfile === "readonly"
  );
}
