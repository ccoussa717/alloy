import type { TeamService, TeamServiceDependencies } from "../core/types.ts";
import type {
  ContextFactory,
  ExtensionAPI as CommandExtensionAPI,
} from "./commands.ts";
import type { TeamToolExtensionAPI } from "./tool.ts";

export interface TeamRegistrationFactories {
  createService(dependencies: TeamServiceDependencies): TeamService;
  registerCommand(
    pi: Pick<CommandExtensionAPI, "registerCommand">,
    service: TeamService,
    contextFactory: ContextFactory,
  ): void;
  registerTool(
    pi: Pick<TeamToolExtensionAPI, "registerTool">,
    service: TeamService,
    contextFactory: ContextFactory,
  ): void;
}

export interface TeamRegistrationAPI extends CommandExtensionAPI, TeamToolExtensionAPI {}

type DependenciesFactory = () => TeamServiceDependencies;

function registrationError(code: string, message: string): never {
  throw new Error(`${code}:${message}`);
}

function validateApi(pi: TeamRegistrationAPI): TeamRegistrationAPI {
  let registerTool: TeamRegistrationAPI["registerTool"];
  let registerCommand: TeamRegistrationAPI["registerCommand"];
  try {
    registerTool = pi.registerTool;
    registerCommand = pi.registerCommand;
  } catch {
    return registrationError("teams_api", "extension registration methods are unavailable");
  }
  if (typeof registerTool !== "function" || typeof registerCommand !== "function") {
    return registrationError("teams_api", "registerTool and registerCommand must be functions");
  }

  return Object.freeze({
    registerTool(tool: Parameters<TeamRegistrationAPI["registerTool"]>[0]) {
      Reflect.apply(registerTool, pi, [tool]);
    },
    registerCommand(
      name: Parameters<TeamRegistrationAPI["registerCommand"]>[0],
      options: Parameters<TeamRegistrationAPI["registerCommand"]>[1],
    ) {
      Reflect.apply(registerCommand, pi, [name, options]);
    },
  });
}

export function createTeamRegistration(factories: TeamRegistrationFactories) {
  const claimedApis = new WeakSet<object>();

  return function register(
    rawPi: TeamRegistrationAPI,
    dependenciesFactory: DependenciesFactory,
    contextFactory: ContextFactory,
  ): TeamService {
    if (rawPi === null || (typeof rawPi !== "object" && typeof rawPi !== "function")) {
      return registrationError("teams_api", "extension API must be an object");
    }
    const identity = rawPi as object;
    if (claimedApis.has(identity)) {
      return registrationError(
        "teams_already_registered",
        "team command and tool registration was already attempted for this API",
      );
    }
    const pi = validateApi(rawPi);
    claimedApis.add(identity);

    let state: "pending" | "active" | "failed" = "pending";
    const gatedContextFactory: ContextFactory = (ctx, source) => {
      if (state !== "active") {
        return registrationError(
          "teams_registration_inactive",
          "team registration did not complete",
        );
      }
      return contextFactory(ctx, source);
    };

    try {
      const service = factories.createService(dependenciesFactory());
      factories.registerTool(pi, service, gatedContextFactory);
      factories.registerCommand(pi, service, gatedContextFactory);
      state = "active";
      return service;
    } catch (error) {
      state = "failed";
      throw error;
    }
  };
}
