/**
 * Alloy — root extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerHonesty } from "./honesty.ts";
import { registerMemory } from "./memory.ts";
import { registerProviders } from "./providers.ts";
import { registerSkillsImprove } from "./skills-improve.ts";
import { registerMcp } from "./mcp.ts";
import { registerPolicy } from "./policy.ts";
import { registerUi } from "./ui.ts";
import { registerModes } from "./modes.ts";
import { registerGit } from "./git.ts";
import { registerWorktree } from "./worktree.ts";
import { registerDiagnostics } from "./diagnostics.ts";
import { registerAuto } from "./auto.ts";
import { registerSandbox } from "./sandbox.ts";
import { registerHelp } from "./help.ts";
import { registerEffort } from "./effort.ts";
import { registerAgents } from "./agents.ts";
import { registerToolDisplay } from "./tool-display.ts";
import { registerNativeCommands } from "./native-commands.ts";
import { registerAuthCommands } from "./auth-commands.ts";
import { registerSidebar } from "./sidebar.ts";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ensureDefaultConfig } = require(join(root, "lib", "config.mjs"));
const { ensureMcpConfig } = require(join(root, "lib", "mcp-config.mjs"));
const { getAlloyHome } = require(join(root, "lib", "paths.mjs"));

export default function alloyExtension(pi: ExtensionAPI) {
  try {
    getAlloyHome();
    ensureDefaultConfig();
    ensureMcpConfig();
  } catch (err) {
    console.error("Alloy: failed to init home:", err);
  }

  registerUi(pi);
  registerHonesty(pi); // anti-hallucination + factual /whoami — before other prompt injectors
  registerHelp(pi);
  registerNativeCommands(pi);
  registerAuthCommands(pi);
  registerProviders(pi);
  registerModes(pi); // Shift+Tab = Build/Plan
  registerPolicy(pi); // approval profiles remain an independent axis
  registerEffort(pi); // /effort = thinking
  registerSandbox(pi); // Docker routing for bash (display override follows)
  registerToolDisplay(pi); // compact one-line tool UI (includes sandbox-aware bash)
  registerMemory(pi);
  registerSkillsImprove(pi);
  registerSidebar(pi);
  registerMcp(pi);
  registerGit(pi);
  registerWorktree(pi);
  registerDiagnostics(pi);
  registerAuto(pi);
  registerAgents(pi); // /agent /agents /profiles · multi-model sub-agents
}
