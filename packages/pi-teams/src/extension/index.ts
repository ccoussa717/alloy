import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStockPiHost } from "../adapters/stock-pi.ts";
import { createTeamService } from "../core/service.ts";
import type {
  ArtifactStore,
  EventStore,
  TeamHost,
  TeamRunContext,
  TeamService,
  TeamServiceDependencies,
} from "../core/types.ts";
import { loadTeamCatalog } from "../storage/catalog-loader.ts";
import { createFileArtifactStore } from "../storage/file-artifact-store.ts";
import { createFileEventStore } from "../storage/file-event-store.ts";
import {
  registerTeamCommand,
  type CommandContext,
} from "./commands.ts";
import {
  createTeamRegistration,
  type TeamRegistrationAPI,
} from "./registration.ts";
import { registerTeamTool } from "./tool.ts";

export interface ExtensionAPI extends TeamRegistrationAPI {}

export interface RegisterTeamsOptions {
  host?: TeamHost;
  eventStore?: EventStore;
  artifactStore?: ArtifactStore;
  catalogFor?: TeamServiceDependencies["catalogFor"];
  agentDir?: string;
  teamsRoot?: string;
}

const builtinsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../builtins");
const registerOnce = createTeamRegistration({
  createService: createTeamService,
  registerCommand: registerTeamCommand,
  registerTool: registerTeamTool,
});

function projectId(cwd: string): string {
  return createHash("sha256").update(cwd, "utf8").digest("hex");
}

function createContext(
  ctx: CommandContext,
  source: "command" | "tool",
): TeamRunContext {
  const cwd = realpathSync.native(resolve(ctx.cwd));
  return Object.freeze({
    cwd,
    projectId: projectId(cwd),
    projectTrusted: ctx.isProjectTrusted(),
    source,
    signal: ctx.signal,
    runtime: ctx,
  });
}

export function registerTeams(
  pi: ExtensionAPI,
  options: RegisterTeamsOptions = {},
): TeamService {
  const contextFactory = (ctx: CommandContext, source: "command" | "tool") =>
    createContext(ctx, source);

  return registerOnce(pi, () => {
    const agentDir = resolve(
      options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    );
    const teamsRoot = resolve(options.teamsRoot ?? join(agentDir, "team-runs"));
    const catalogFor = options.catalogFor ?? (async (context: TeamRunContext) =>
      loadTeamCatalog({
        builtinsDir,
        userDir: join(agentDir, "teams"),
        projectDir: join(context.cwd, ".pi", "teams"),
        projectTrusted: context.projectTrusted,
      }));
    return {
      catalogFor,
      eventStore: options.eventStore ?? createFileEventStore({ root: teamsRoot }),
      artifactStore: options.artifactStore ?? createFileArtifactStore({ root: teamsRoot }),
      host: options.host ?? createStockPiHost({ agentDir }),
      now: () => new Date().toISOString(),
      randomUUID,
    };
  }, contextFactory);
}

export default function portableTeamsExtension(pi: ExtensionAPI): void {
  registerTeams(pi);
}
