/**
 * Process-local Alloy session state shared across extension modules.
 */

const state = {
  mode: "build", // chat | plan | build | review
  // ask-all | ask-some | ask-dangerous | ask-none | sandbox
  permissionProfile: "ask-dangerous",
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
  // Normalization lives in permissions.mjs; state stores canonical ids only.
  const allowed = [
    "ask-all",
    "ask-some",
    "ask-dangerous",
    "ask-none",
    "sandbox",
    // legacy (still accepted if something sets them raw)
    "readonly",
    "safe",
    "workspace",
  ];
  if (!allowed.includes(profile)) {
    throw new Error(`Invalid permission profile: ${profile}`);
  }
  // Map legacy on write
  const map = {
    readonly: "ask-all",
    safe: "ask-dangerous",
    workspace: "ask-none",
  };
  state.permissionProfile = map[profile] || profile;
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

/** Plan/review modes force read-only tool gating. */
export function isReadOnlyMode() {
  return state.mode === "plan" || state.mode === "review";
}

export function isSandboxProfile() {
  return state.permissionProfile === "sandbox";
}
