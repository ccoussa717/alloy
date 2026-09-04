import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerTeams as registerPortableTeams } from "../packages/pi-teams/src/extension/index.ts";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createAlloyTeamsHost } = require(join(root, "lib", "teams-host.mjs"));
const { getAlloyHome } = require(join(root, "lib", "paths.mjs"));

export function registerTeams(pi: ExtensionAPI) {
  return registerPortableTeams(pi, {
    host: createAlloyTeamsHost(),
    teamsRoot: join(getAlloyHome(), "team-runs"),
  });
}
