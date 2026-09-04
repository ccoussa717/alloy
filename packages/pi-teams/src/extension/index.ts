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
  type ExtensionAPI as CommandExtensionAPI,
} from "./commands.ts";
import { registerTeamTool, type TeamToolExtensionAPI } from "./tool.ts";

export interface ExtensionAPI extends CommandExtensionAPI, TeamToolExtensionAPI {}

export interface RegisterTeamsOptions {
  host?: TeamHost;
  eventStore?: EventStore;
  artifactStore?: ArtifactStore;
  catalogFor?: TeamServiceDependencies["catalogFor"];
  agentDir?: string;
  teamsRoot?: string;
}

const registeredApis = new WeakSet<object>();
const builtinsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../builtins");

function registrationError(code: string, message: string): never {
  throw new Error(`${code}:${message}`);
}

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
  if (pi === null || (typeof pi !== "object" && typeof pi !== "function")) {
    return registrationError("teams_api", "extension API must be an object");
  }
  if (registeredApis.has(pi as object)) {
    return registrationError("teams_already_registered", "team command and tool are already registered for this API");
  }
  registeredApis.add(pi as object);

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
  const service = createTeamService({
    catalogFor,
    eventStore: options.eventStore ?? createFileEventStore({ root: teamsRoot }),
    artifactStore: options.artifactStore ?? createFileArtifactStore({ root: teamsRoot }),
    host: options.host ?? createStockPiHost({ agentDir }),
    now: () => new Date().toISOString(),
    randomUUID,
  });
  const contextFactory = (ctx: CommandContext, source: "command" | "tool") =>
    createContext(ctx, source);

  registerTeamCommand(pi, service, contextFactory);
  registerTeamTool(pi, service, contextFactory);
  return service;
}

export default function portableTeamsExtension(pi: ExtensionAPI): void {
  registerTeams(pi);
}
