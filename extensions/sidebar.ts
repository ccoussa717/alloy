import type { ExtensionAPI, SidebarExtensionState } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { bindSidebarPublisher, publishSidebarState, resetSidebarState } = require(
  join(root, "lib", "sidebar-state.mjs"),
);

export function registerSidebar(pi: ExtensionAPI) {
  let unbind = () => {};

  pi.on("session_start", (_event, ctx) => {
    unbind();
    resetSidebarState();
    if (!ctx.ui.setSidebarState) return;
    unbind = bindSidebarPublisher((state: SidebarExtensionState) => {
      ctx.ui.setSidebarState?.(state);
    });
  });

  pi.on("model_select", () => {
    publishSidebarState();
  });

  pi.on("session_shutdown", () => {
    unbind();
    unbind = () => {};
  });
}
