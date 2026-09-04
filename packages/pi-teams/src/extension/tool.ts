import { types as nodeUtilTypes } from "node:util";
import { Type, type TSchema } from "typebox";

import { isRunId } from "../core/events.ts";
import { IDENTIFIER, TEAM_LIMITS, assertBoundedUtf8 } from "../core/limits.ts";
import type {
  Actor,
  MemberView,
  TeamRunView,
  TeamService,
} from "../core/types.ts";
import type { CommandContext, ContextFactory } from "./commands.ts";
import {
  formatMemberView,
  formatTeamInspect,
  formatTeamList,
  formatTeamRun,
} from "./presentation.ts";

const TEAM_REF_PATTERN = "^(?:(?:builtin|user|project)/)?[a-z][a-z0-9-]{0,63}$";
const RUN_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const IDENTIFIER_PATTERN = "^[a-z][a-z0-9-]{0,63}$";
const ACTIONS = ["list", "inspect", "request", "run", "status", "view", "cancel"] as const;

type TeamToolAction = typeof ACTIONS[number];
type TeamToolInput =
  | { action: "list" }
  | { action: "inspect"; team: string }
  | { action: "request" | "run"; team: string; objective: string }
  | { action: "status"; runId?: string }
  | { action: "view"; runId: string; memberId?: string }
  | { action: "cancel"; runId: string };

interface TeamToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface TeamToolDefinition {
  name: "team";
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: CommandContext,
  ): Promise<TeamToolResult>;
}

export interface TeamToolExtensionAPI {
  registerTool(tool: TeamToolDefinition): void;
}

const action = <T extends TeamToolAction>(value: T) => Type.Literal(value);
const team = Type.String({
  minLength: 1,
  maxLength: TEAM_LIMITS.descriptionBytes,
  pattern: TEAM_REF_PATTERN,
});
const objective = Type.String({ minLength: 1, maxLength: TEAM_LIMITS.objectiveBytes });
const runId = Type.String({ minLength: 36, maxLength: 36, pattern: RUN_ID_PATTERN });
const memberId = Type.String({ minLength: 1, maxLength: 64, pattern: IDENTIFIER_PATTERN });

const actionSchema = Type.Union(ACTIONS.map((value) => action(value)));
const actionBranches = Type.Union([
  Type.Object({ action: action("list") }, { additionalProperties: false }),
  Type.Object({ action: action("inspect"), team }, { additionalProperties: false }),
  Type.Object({ action: action("request"), team, objective }, { additionalProperties: false }),
  Type.Object({ action: action("run"), team, objective }, { additionalProperties: false }),
  Type.Object({ action: action("status"), runId: Type.Optional(runId) }, { additionalProperties: false }),
  Type.Object({ action: action("view"), runId, memberId: Type.Optional(memberId) }, { additionalProperties: false }),
  Type.Object({ action: action("cancel"), runId }, { additionalProperties: false }),
]);
const teamToolParameters = {
  ...actionBranches,
  type: "object" as const,
  properties: {
    action: actionSchema,
    team,
    objective,
    runId,
    memberId,
  },
  additionalProperties: false,
};

function toolError(message: string): never {
  throw new Error(`team_tool_input:${message}`);
}

function captureDataObject(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return toolError("arguments must be an exact plain data object");

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return toolError("arguments must not contain symbol properties");
  }
  const captured: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) return toolError(`argument ${key} must be an enumerable data property`);
    captured[key] = descriptor.value;
  }
  return captured;
}

function exactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const names = Object.keys(input).sort();
  const expected = [...required, ...optional].sort();
  if (
    required.some((name) => !names.includes(name)) ||
    names.some((name) => !expected.includes(name))
  ) toolError("arguments do not match the selected action");
}

function boundedString(value: unknown, field: string, maximum: number): string {
  try {
    assertBoundedUtf8(value, field, maximum);
  } catch {
    return toolError(`${field} is invalid`);
  }
  return value;
}

function capturedTeam(value: unknown): string {
  const captured = boundedString(value, "team", TEAM_LIMITS.descriptionBytes);
  if (!new RegExp(TEAM_REF_PATTERN).test(captured)) return toolError("team is invalid");
  return captured;
}

function capturedRunId(value: unknown): string {
  if (!isRunId(value)) return toolError("runId is invalid");
  return value;
}

function capturedMemberId(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return toolError("memberId is invalid");
  }
  return value;
}

function captureToolInput(value: unknown): TeamToolInput {
  const input = captureDataObject(value);
  const selected = input.action;
  if (typeof selected !== "string" || !ACTIONS.includes(selected as TeamToolAction)) {
    return toolError("action is invalid");
  }
  switch (selected) {
    case "list":
      exactKeys(input, ["action"]);
      return { action: selected };
    case "inspect":
      exactKeys(input, ["action", "team"]);
      return { action: selected, team: capturedTeam(input.team) };
    case "request":
    case "run":
      exactKeys(input, ["action", "objective", "team"]);
      return {
        action: selected,
        team: capturedTeam(input.team),
        objective: boundedString(input.objective, "objective", TEAM_LIMITS.objectiveBytes),
      };
    case "status":
      exactKeys(input, ["action"], ["runId"]);
      return !Object.hasOwn(input, "runId")
        ? { action: selected }
        : { action: selected, runId: capturedRunId(input.runId) };
    case "view":
      exactKeys(input, ["action", "runId"], ["memberId"]);
      return !Object.hasOwn(input, "memberId")
        ? { action: selected, runId: capturedRunId(input.runId) }
        : {
            action: selected,
            runId: capturedRunId(input.runId),
            memberId: capturedMemberId(input.memberId),
          };
    case "cancel":
      exactKeys(input, ["action", "runId"]);
      return { action: selected, runId: capturedRunId(input.runId) };
  }
  return toolError("action is invalid");
}

function isMemberView(view: TeamRunView | MemberView): view is MemberView {
  return "run" in view;
}

function result(text: string, details: Record<string, unknown>): TeamToolResult {
  return { content: [{ type: "text", text }], details };
}

function safeServiceFailure(error: unknown): Error {
  let message: unknown;
  if (typeof error === "string") message = error;
  else if (
    error !== null &&
    typeof error === "object" &&
    !nodeUtilTypes.isProxy(error) &&
    nodeUtilTypes.isNativeError(error)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor) message = descriptor.value;
  }
  const code = typeof message === "string"
    ? /^([a-z][a-z0-9_]{0,63}):/.exec(message)?.[1]
    : undefined;
  return new Error(`team_tool_failed:${code ?? "details_withheld"}`);
}

function modelActor(context: CommandContext): Extract<Actor, { kind: "model" }> {
  const model = context.model;
  return Object.freeze({
    kind: "model",
    id: model === undefined ? "no-active-model" : `${model.provider}/${model.id}`,
  });
}

export function registerTeamTool(
  pi: Pick<TeamToolExtensionAPI, "registerTool">,
  service: TeamService,
  contextFactory: ContextFactory,
): void {
  pi.registerTool({
    name: "team",
    label: "Team",
    description: "List, inspect, request, view, status, or cancel bounded read-only team runs. Execution always requires separate human approval.",
    parameters: teamToolParameters,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = captureToolInput(rawParams);
      try {
        const context = contextFactory(ctx, "tool");
        switch (params.action) {
          case "list":
            return result(formatTeamList(await service.list(context)), { status: "ok" });
          case "inspect":
            return result(formatTeamInspect(await service.inspect(params.team, context)), { status: "ok" });
          case "status":
            return result(formatTeamRun(await service.status(params.runId, context)), { status: "ok" });
          case "view": {
            const view = await service.view(params.runId, params.memberId, context);
            return result(
              isMemberView(view) ? formatMemberView(view) : formatTeamRun(view),
              { status: "ok" },
            );
          }
          case "cancel": {
            const cancelled = await service.cancel(params.runId, modelActor(ctx), context);
            return result(formatTeamRun(cancelled), { status: "ok" });
          }
          case "request":
          case "run": {
            const requested = await service.request({
              teamRef: params.team,
              objective: params.objective,
              actor: modelActor(ctx),
              context,
            });
            if (requested.status === "blocked" && requested.approvalBinding === undefined) {
              return result(formatTeamRun(requested), {
                status: "blocked",
                runId: requested.runId,
              });
            }
            if (
              requested.status !== "awaiting_approval" ||
              requested.approvalBinding === undefined
            ) {
              throw new Error("team_tool_result:request returned a contradictory state");
            }
            return result(`approval_required\n${formatTeamRun(requested)}`, {
              status: "approval_required",
              runId: requested.runId,
              binding: requested.approvalBinding,
            });
          }
        }
      } catch (error) {
        throw safeServiceFailure(error);
      }
    },
  });
}
