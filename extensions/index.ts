/**
 * Alloy — root extension.
 * Wires MVP modules: providers, memory, skills-improve, mcp, policy, ui.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerMemory } from "./memory.ts";
import { registerProviders } from "./providers.ts";
import { registerSkillsImprove } from "./skills-improve.ts";
import { registerMcp } from "./mcp.ts";
import { registerPolicy } from "./policy.ts";
import { registerUi } from "./ui.ts";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ensureDefaultConfig } = require(join(root, "lib", "config.mjs"));
const { ensureMcpConfig } = require(join(root, "lib", "mcp-config.mjs"));
const { getAlloyHome } = require(join(root, "lib", "paths.mjs"));

export default function alloyExtension(pi: ExtensionAPI) {
  // Ensure on-disk layout exists before any command runs
  try {
    getAlloyHome();
    ensureDefaultConfig();
    ensureMcpConfig();
  } catch (err) {
    console.error("Alloy: failed to init home:", err);
  }

  registerUi(pi);
  registerProviders(pi);
  registerMemory(pi);
  registerSkillsImprove(pi);
  registerMcp(pi);
  registerPolicy(pi);
}
