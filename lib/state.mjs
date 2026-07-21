/**
 * Process-local Alloy session state shared across extension modules.
 */

const state = {
  mode: "build", // chat | plan | build | review
  permissionProfile: "safe", // readonly | safe | workspace | sandbox
  mcpConnected: false,
  mcpToolCount: 0,
  sandboxActive: false,
  sandboxContainer: null,
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
  return getState();
}

export function setPermissionProfile(profile) {
  const allowed = ["readonly", "safe", "workspace", "sandbox"];
  if (!allowed.includes(profile)) {
    throw new Error(
      `Invalid profile: ${profile}. Use: readonly | safe | workspace | sandbox`,
    );
  }
  state.permissionProfile = profile;
  return getState();
}

export function setMcpStats({ connected, toolCount }) {
  state.mcpConnected = Boolean(connected);
  state.mcpToolCount = toolCount || 0;
  return getState();
}

export function setSandboxActive(active, containerName = null) {
  state.sandboxActive = Boolean(active);
  state.sandboxContainer = containerName;
  return getState();
}

export function isReadOnlyMode() {
  return (
    state.mode === "plan" ||
    state.mode === "review" ||
    state.permissionProfile === "readonly"
  );
}

export function isSandboxProfile() {
  return state.permissionProfile === "sandbox";
}
