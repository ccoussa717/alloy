import { isRunId } from "../core/events.ts";
import { IDENTIFIER } from "../core/limits.ts";
import type {
  Actor,
  MemberView,
  TeamRunContext,
  TeamRunView,
  TeamService,
} from "../core/types.ts";
import {
  formatMemberView,
  formatTeamInspect,
  formatTeamList,
  formatTeamRun,
} from "./presentation.ts";

export type TeamCommand =
  | { action: "list" }
  | { action: "inspect"; teamRef: string }
  | { action: "run"; teamRef: string; objective: string }
  | { action: "status"; runId?: string }
  | { action: "view"; runId: string; memberId?: string }
  | { action: "approve"; runId: string }
  | { action: "cancel"; runId: string };

export interface CommandContext {
  cwd: string;
  model: { provider: string; id: string } | undefined;
  modelRegistry: unknown;
  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;
  hasUI: boolean;
  ui: {
    notify?(text: string, level?: "info" | "warning" | "error"): void;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

export interface ExtensionAPI {
  registerCommand(name: string, options: {
    description?: string;
    handler(args: string, ctx: CommandContext): Promise<void>;
  }): void;
}

export type ContextFactory = (
  ctx: CommandContext,
  source: "command" | "tool",
) => TeamRunContext;

const HUMAN_ACTOR: Extract<Actor, { kind: "human" }> = Object.freeze({
  kind: "human",
  id: "pi-user",
});
const TEAM_REF = /^(?:(?:builtin|user|project)\/)?[a-z][a-z0-9-]{0,63}$/;

function usage(): never {
  throw new Error(
    "team_usage: /team list | inspect <team> | run <team> <objective> | status [run-id] | view <run-id> [member-id] | approve <run-id> | cancel <run-id>",
  );
}

function tokens(value: string | undefined): string[] {
  return value === undefined || value.trim() === "" ? [] : value.trim().split(/\s+/);
}

function validRunId(value: string | undefined): value is string {
  return value !== undefined && isRunId(value);
}

export function parseTeamCommand(args: string): TeamCommand {
  if (typeof args !== "string") return usage();
  const input = args.trim();
  if (input === "") return usage();
  const firstSpace = input.search(/\s/);
  const action = firstSpace === -1 ? input : input.slice(0, firstSpace);
  const remainder = firstSpace === -1 ? undefined : input.slice(firstSpace).trim();

  switch (action) {
    case "list":
      if (tokens(remainder).length !== 0) return usage();
      return { action };
    case "inspect": {
      const parts = tokens(remainder);
      if (parts.length !== 1 || !TEAM_REF.test(parts[0]!)) return usage();
      return { action, teamRef: parts[0]! };
    }
    case "run": {
      if (remainder === undefined) return usage();
      const teamEnd = remainder.search(/\s/);
      if (teamEnd === -1) return usage();
      const teamRef = remainder.slice(0, teamEnd);
      const objective = remainder.slice(teamEnd).trim();
      if (!TEAM_REF.test(teamRef) || objective === "") return usage();
      return { action, teamRef, objective };
    }
    case "status": {
      const parts = tokens(remainder);
      if (parts.length === 0) return { action };
      if (parts.length !== 1 || !validRunId(parts[0])) return usage();
      return { action, runId: parts[0] };
    }
    case "view": {
      const parts = tokens(remainder);
      if (parts.length < 1 || parts.length > 2 || !validRunId(parts[0])) return usage();
      if (parts[1] !== undefined && !IDENTIFIER.test(parts[1])) return usage();
      return parts[1] === undefined
        ? { action, runId: parts[0] }
        : { action, runId: parts[0], memberId: parts[1] };
    }
    case "approve":
    case "cancel": {
      const parts = tokens(remainder);
      if (parts.length !== 1 || !validRunId(parts[0])) return usage();
      return { action, runId: parts[0] };
    }
    default:
      return usage();
  }
}

function isMemberView(view: TeamRunView | MemberView): view is MemberView {
  return "run" in view;
}

function present(ctx: CommandContext, text: string): void {
  if (typeof ctx.ui?.notify === "function") ctx.ui.notify(text, "info");
  else console.log(text);
}

async function confirmApproval(
  ctx: CommandContext,
  run: TeamRunView,
): Promise<boolean> {
  const preview = formatTeamRun(run);
  present(ctx, preview);
  if (run.approvalBinding === undefined) {
    present(ctx, "approval_required: run has no stored approval binding");
    return false;
  }
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
    present(ctx, "approval_required: use /team approve <run-id> in an interactive session");
    return false;
  }
  const confirmed = await ctx.ui.confirm("Approve team execution?", preview);
  if (!confirmed) present(ctx, "approval_required: execution was not approved");
  return confirmed;
}

export function registerTeamCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  service: TeamService,
  contextFactory: ContextFactory,
): void {
  pi.registerCommand("team", {
    description: "Read-only teams: /team list|inspect|run|status|view|approve|cancel",
    handler: async (args, ctx) => {
      const command = parseTeamCommand(args);
      const context = contextFactory(ctx, "command");

      switch (command.action) {
        case "list":
          present(ctx, formatTeamList(await service.list(context)));
          return;
        case "inspect":
          present(ctx, formatTeamInspect(await service.inspect(command.teamRef, context)));
          return;
        case "status":
          present(ctx, formatTeamRun(await service.status(command.runId, context)));
          return;
        case "view": {
          const view = await service.view(command.runId, command.memberId, context);
          present(ctx, isMemberView(view) ? formatMemberView(view) : formatTeamRun(view));
          return;
        }
        case "cancel":
          present(ctx, formatTeamRun(await service.cancel(command.runId, HUMAN_ACTOR, context)));
          return;
        case "run": {
          const requested = await service.request({
            teamRef: command.teamRef,
            objective: command.objective,
            actor: HUMAN_ACTOR,
            context,
          });
          if (!await confirmApproval(ctx, requested)) return;
          const binding = requested.approvalBinding;
          if (binding === undefined) return;
          await service.approve({ runId: requested.runId, actor: HUMAN_ACTOR, binding, context });
          present(ctx, formatTeamRun(await service.execute(requested.runId, context)));
          return;
        }
        case "approve": {
          const stored = await service.status(command.runId, context);
          if (!await confirmApproval(ctx, stored)) return;
          const binding = stored.approvalBinding;
          if (binding === undefined) return;
          await service.approve({ runId: command.runId, actor: HUMAN_ACTOR, binding, context });
          present(ctx, formatTeamRun(await service.execute(command.runId, context)));
        }
      }
    },
  });
}
