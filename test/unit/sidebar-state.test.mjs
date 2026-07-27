import assert from "node:assert/strict";
import test from "node:test";

import { bindSidebarPublisher, resetSidebarState, setSidebarMcp } from "../../lib/sidebar-state.mjs";

test("sidebar MCP publication normalizes names and strips unsupported transports", () => {
  const snapshots = [];
  const unbind = bindSidebarPublisher((snapshot) => snapshots.push(snapshot));
  try {
    setSidebarMcp([
      { name: "   ", status: "disconnected", transport: "bogus" },
      { name: " live ", status: "connected", toolCount: 2, transport: "http" },
    ]);
    assert.deepEqual(snapshots.at(-1).mcp, [
      { name: "(unnamed)", status: "failed", error: "server name is empty" },
      { name: "live", status: "connected", toolCount: 2, transport: "http" },
    ]);
  } finally {
    unbind();
    resetSidebarState();
  }
});
