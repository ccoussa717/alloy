import { types as nodeUtilTypes } from "node:util";

import { compileTeam } from "./compiler.ts";
import { isProjectId, isRfc3339Utc, isRunId } from "./events.ts";
import { assertBoundedUtf8, TEAM_LIMITS } from "./limits.ts";
import {
  approvalBinding,
  intersectMemberPolicy,
  policyDigest,
  verifyApprovalBinding,
} from "./policy.ts";
import { projectTeamRun } from "./projection.ts";
import { createSchedule } from "./scheduler.ts";
import type {
  Actor,
  Admission,
  AdmittedMember,
  ApprovalBinding,
  CompiledTeam,
  EventDraft,
  EventWriter,
  HostCapabilities,
  MemberExecution,
  PublicAdmission,
  ScheduleState,
  TeamCatalog,
  TeamEvent,
  TeamLimits,
  TeamRunContext,
  TeamRunView,
  TeamService,
  TeamServiceDependencies,
  TeamSummary,
} from "./types.ts";

const ACTOR_KINDS = new Set(["human", "model", "system"]);
const CONTEXT_REQUIRED_KEYS = [
  "cwd", "projectId", "projectTrusted", "runtime", "source",
] as const;
const CONTEXT_OPTIONAL_KEYS = ["signal"] as const;
const ACTOR_KEYS = ["id", "kind"] as const;
const ENTRY_REF = /^(builtin|user|project)\/([a-z][a-z0-9-]{0,63})$/;

interface CapturedRecord {
  names: string[];
  values: Record<string, unknown>;
}

interface LiveRun {
  readonly writer: EventWriter;
  readonly team: CompiledTeam;
  readonly admissions: AdmittedMember[];
  readonly context: TeamRunContext;
  readonly binding: ApprovalBinding;
  scheduler: ScheduleState;
  readonly abortControllers: Map<string, AbortController>;
  readonly executions: Map<string, MemberExecution>;
  readonly events: TeamEvent[];
  approvalPromise?: Promise<TeamRunView>;
  approved: boolean;
}

function serviceError(code: string, message: string): never {
  throw new Error(`${code}:${message}`);
}

function inspectRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: string,
  label: string,
): CapturedRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return serviceError(code, `${label} must be a plain data object`);
  }
  const names = Object.getOwnPropertyNames(value).sort();
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !names.includes(key)) ||
    names.some((name) => !allowed.has(name))
  ) {
    return serviceError(code, `${label} has an invalid shape`);
  }
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return serviceError(code, `${label}.${name} must be an enumerable data property`);
    }
    values[name] = descriptor.value;
  }
  return { names, values };
}

function captureActor(value: unknown, humanOnly = false): Actor {
  const code = humanOnly ? "approval_actor" : "request_actor";
  const { values } = inspectRecord(value, ACTOR_KEYS, [], code, "actor");
  if (
    typeof values.kind !== "string" ||
    !ACTOR_KINDS.has(values.kind) ||
    (humanOnly && values.kind !== "human")
  ) {
    return serviceError(
      code,
      humanOnly ? "approval requires a human actor" : "actor kind is invalid",
    );
  }
  try {
    assertBoundedUtf8(values.id, "actor.id", TEAM_LIMITS.descriptionBytes);
  } catch (error) {
    return serviceError(code, String(error));
  }
  return Object.freeze({ kind: values.kind, id: values.id }) as Actor;
}

function captureContext(value: unknown): TeamRunContext {
  const { names, values } = inspectRecord(
    value,
    CONTEXT_REQUIRED_KEYS,
    CONTEXT_OPTIONAL_KEYS,
    "context",
    "context",
  );
  try {
    assertBoundedUtf8(values.cwd, "context.cwd", TEAM_LIMITS.objectiveBytes);
  } catch (error) {
    return serviceError("context", String(error));
  }
  if (!isProjectId(values.projectId)) {
    return serviceError("context", "projectId must be a lowercase SHA-256 digest");
  }
  if (typeof values.projectTrusted !== "boolean") {
    return serviceError("context", "projectTrusted must be a boolean");
  }
  if (values.source !== "command" && values.source !== "tool") {
    return serviceError("context", "source must be command or tool");
  }
  if (values.runtime === undefined) {
    return serviceError("context", "runtime must be present");
  }
  if (
    names.includes("signal") &&
    values.signal !== undefined &&
    !(values.signal instanceof AbortSignal)
  ) {
    return serviceError("context", "signal must be an AbortSignal");
  }
  return Object.freeze({
    cwd: values.cwd,
    projectId: values.projectId,
    projectTrusted: values.projectTrusted,
    source: values.source,
    ...(names.includes("signal") ? { signal: values.signal as AbortSignal | undefined } : {}),
    runtime: values.runtime,
  }) as TeamRunContext;
}

function validateTeamRef(value: unknown): string {
  try {
    assertBoundedUtf8(value, "teamRef", TEAM_LIMITS.descriptionBytes);
  } catch (error) {
    return serviceError("team_ref", String(error));
  }
  return value;
}

function validateObjective(value: unknown): string {
  try {
    assertBoundedUtf8(value, "objective", TEAM_LIMITS.objectiveBytes);
  } catch (error) {
    return serviceError("objective", String(error));
  }
  return value;
}

function validateCatalogEntry(
  catalog: TeamCatalog,
  teamRef: string,
  context: TeamRunContext,
): CompiledTeam {
  const entry = catalog.resolve(teamRef);
  const match = ENTRY_REF.exec(entry.ref);
  const requestedQualified = ENTRY_REF.test(teamRef);
  if (
    match === null ||
    match[1] !== entry.source ||
    match[2] !== entry.definition?.metadata?.name ||
    (requestedQualified ? entry.ref !== teamRef : entry.definition?.metadata?.name !== teamRef)
  ) {
    return serviceError("catalog_identity", "resolved catalog provenance contradicts the request");
  }
  if (entry.source === "project" && !context.projectTrusted) {
    return serviceError("catalog_trust", "project teams require a trusted project");
  }
  return compileTeam(entry);
}

function validateHostCapabilities(value: unknown): HostCapabilities {
  const { values } = inspectRecord(
    value,
    ["capabilities", "maxConcurrency", "supportsCancellation", "tools"],
    [],
    "host_capabilities",
    "host capabilities",
  );
  if (
    !Array.isArray(values.capabilities) ||
    !Array.isArray(values.tools) ||
    !Number.isSafeInteger(values.maxConcurrency) ||
    (values.maxConcurrency as number) <= 0 ||
    typeof values.supportsCancellation !== "boolean"
  ) {
    return serviceError("host_capabilities", "host capabilities are malformed");
  }
  return Object.freeze({
    capabilities: Object.freeze([...values.capabilities]),
    tools: Object.freeze([...values.tools]),
    maxConcurrency: values.maxConcurrency,
    supportsCancellation: values.supportsCancellation,
  }) as HostCapabilities;
}

function effectiveLimits(team: CompiledTeam, host: HostCapabilities): TeamLimits {
  const manifest = team.definition.spec.limits;
  return Object.freeze({
    maxConcurrency: Math.min(manifest.maxConcurrency, host.maxConcurrency),
    maxCostUsd: manifest.maxCostUsd,
    timeoutMs: manifest.timeoutMs,
    maxMembers: manifest.maxMembers,
  });
}

function publicAdmission(admission: AdmittedMember): Extract<PublicAdmission, { ok: true }> {
  return Object.freeze({
    ok: true,
    memberId: admission.memberId,
    effectiveRoute: admission.effectiveRoute,
    effectiveModel: admission.effectiveModel,
    effectiveCapabilities: Object.freeze([...admission.effectiveCapabilities]),
    effectiveTools: Object.freeze([...admission.effectiveTools]),
    maxCostUsd: admission.maxCostUsd,
    timeoutMs: admission.timeoutMs,
  }) as Extract<PublicAdmission, { ok: true }>;
}

function safeFailureDetail(error: unknown): string {
  let detail: unknown = typeof error === "string" ? error : undefined;
  if (
    error !== null &&
    typeof error === "object" &&
    !nodeUtilTypes.isProxy(error) &&
    nodeUtilTypes.isNativeError(error)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor !== undefined && "value" in descriptor) detail = descriptor.value;
  }
  if (
    typeof detail !== "string" ||
    Buffer.from(detail, "utf8").toString("utf8") !== detail ||
    detail.trim().length === 0
  ) {
    return "host preflight failed";
  }
  return detail;
}

function boundedFailureReason(memberId: string, error: unknown): string {
  const prefix = `preflight_${memberId}:`;
  const detail = safeFailureDetail(error);
  const remainingBytes = TEAM_LIMITS.descriptionBytes - Buffer.byteLength(prefix, "utf8");
  const characters: string[] = [];
  let bytes = 0;
  for (const character of detail) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > remainingBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  const bounded = characters.join("");
  return `${prefix}${bounded || "host preflight failed"}`;
}

function snapshotMembers(team: CompiledTeam): Array<{ id: string; needs: string[] }> {
  const byId = new Map(team.definition.spec.members.map((member) => [member.id, member]));
  return team.topologicalOrder.map((memberId) => {
    const member = byId.get(memberId)!;
    return { id: member.id, needs: [...member.needs] };
  });
}

function scheduleWithLimits(team: CompiledTeam, limits: TeamLimits): ScheduleState {
  const effectiveTeam: CompiledTeam = {
    ...team,
    definition: {
      ...team.definition,
      spec: {
        ...team.definition.spec,
        limits,
      },
    },
  };
  return createSchedule(effectiveTeam);
}

function sameRunContext(expected: TeamRunContext, actual: TeamRunContext): boolean {
  return expected.cwd === actual.cwd &&
    expected.projectId === actual.projectId &&
    expected.projectTrusted === actual.projectTrusted &&
    expected.runtime === actual.runtime;
}

function eventDraft(
  dependencies: TeamServiceDependencies,
  type: EventDraft["type"],
  actor: Actor,
  payload: Record<string, unknown>,
): EventDraft {
  const occurredAt = dependencies.now();
  if (!isRfc3339Utc(occurredAt)) {
    return serviceError("service_time", "now() must return an RFC 3339 UTC timestamp");
  }
  return { type, actor, occurredAt, payload };
}

export function createTeamService(dependencies: TeamServiceDependencies): TeamService {
  if (dependencies === null || typeof dependencies !== "object") {
    return serviceError("service_dependencies", "dependencies must be an object");
  }
  const liveRuns = new Map<string, LiveRun>();
  const claimedRunIds = new Set<string>();
  const systemActor = Object.freeze({ kind: "system" as const, id: "teams" });

  const append = async (
    run: { writer: EventWriter; events: TeamEvent[] },
    type: EventDraft["type"],
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<TeamEvent> => {
    const event = await run.writer.append(eventDraft(dependencies, type, actor, payload));
    run.events.push(event);
    return event;
  };

  const abandonLiveRun = async (runId: string, run: LiveRun): Promise<void> => {
    if (liveRuns.get(runId) === run) liveRuns.delete(runId);
    run.admissions.splice(0, run.admissions.length);
    run.abortControllers.clear();
    run.executions.clear();
    run.approvalPromise = undefined;
    await run.writer.close().catch(() => undefined);
  };

  const service: TeamService = {
    async list(rawContext): Promise<TeamSummary[]> {
      const capturedContext = captureContext(rawContext);
      const catalog = await dependencies.catalogFor(capturedContext);
      return catalog.list().map((entry) => {
        const team = validateCatalogEntry(
          { list: () => catalog.list(), resolve: () => entry },
          entry.ref,
          capturedContext,
        );
        return {
          ref: team.ref,
          description: team.definition.metadata.description,
          members: team.definition.spec.members.length,
          limits: team.definition.spec.limits,
        };
      });
    },

    async inspect(teamRef, rawContext): Promise<CompiledTeam> {
      const capturedRef = validateTeamRef(teamRef);
      const capturedContext = captureContext(rawContext);
      const catalog = await dependencies.catalogFor(capturedContext);
      return validateCatalogEntry(catalog, capturedRef, capturedContext);
    },

    async request(input): Promise<TeamRunView> {
      const captured = inspectRecord(
        input,
        ["actor", "context", "objective", "teamRef"],
        [],
        "request",
        "request",
      ).values;
      const objective = validateObjective(captured.objective);
      const teamRef = validateTeamRef(captured.teamRef);
      const actor = captureActor(captured.actor);
      const context = captureContext(captured.context);

      const catalog = await dependencies.catalogFor(context);
      const team = validateCatalogEntry(catalog, teamRef, context);
      const host = validateHostCapabilities(await dependencies.host.capabilities(context));
      const limits = effectiveLimits(team, host);
      const runId = dependencies.randomUUID();
      if (!isRunId(runId)) {
        return serviceError("service_run_id", "randomUUID() must return a lowercase UUID");
      }
      if (claimedRunIds.has(runId)) {
        return serviceError("service_run_id", "run ID has already been claimed or abandoned");
      }
      claimedRunIds.add(runId);
      const requestedAt = dependencies.now();
      if (!isRfc3339Utc(requestedAt)) {
        return serviceError("service_time", "now() must return an RFC 3339 UTC timestamp");
      }
      const requestSnapshot = Object.freeze({
        teamRef: team.ref,
        objective,
        actor,
        requestedAt,
      });
      const writer = await dependencies.eventStore.createRun({
        projectId: context.projectId,
        runId,
        manifest: team.definition,
        request: requestSnapshot,
      });
      const runBase = { writer, events: [] as TeamEvent[] };
      try {
        await append(runBase, "run.requested", actor, {
          projectId: context.projectId,
          teamRef: team.ref,
          objective,
        });
        await append(runBase, "manifest.snapshotted", systemActor, {
          teamRef: team.ref,
          manifestDigest: team.manifestDigest,
          planDigest: team.planDigest,
          limits,
          members: snapshotMembers(team),
        });

        const maxCostUsd = limits.maxCostUsd / limits.maxMembers;
        const pending = team.definition.spec.members.map((member) =>
          Promise.resolve().then(() => dependencies.host.preflightMember({
            member,
            maxCostUsd,
            timeoutMs: limits.timeoutMs,
          }, context))
        );
        const settled = await Promise.allSettled(pending);
        const decisions: Admission[] = settled.map((result, index) => {
          const member = team.definition.spec.members[index]!;
          if (result.status === "rejected") {
            return {
              ok: false,
              memberId: member.id,
              effectiveRoute: null,
              effectiveModel: null,
              effectiveCapabilities: [],
              effectiveTools: [],
              maxCostUsd,
              reason: boundedFailureReason(member.id, result.reason),
            };
          }
          return intersectMemberPolicy({
            member,
            host,
            admission: result.value,
            maxCostUsd,
            timeoutMs: limits.timeoutMs,
          });
        });
        const blocked = decisions.filter(
          (decision): decision is Extract<Admission, { ok: false }> => !decision.ok,
        );
        if (blocked.length > 0) {
          const reasons = blocked.map((decision) => decision.reason);
          await append(runBase, "policy.blocked", systemActor, { reasons });
          await append(runBase, "run.blocked", systemActor, { reason: reasons[0]! });
          return projectTeamRun(runBase.events, { live: false });
        }

        const admissions = decisions as AdmittedMember[];
        const digest = policyDigest(admissions, limits, team);
        const binding = approvalBinding(runId, team, digest);
        const publicById = new Map(
          admissions.map((admission) => [admission.memberId, publicAdmission(admission)]),
        );
        const publicAdmissions = team.topologicalOrder.map((memberId) => publicById.get(memberId)!);
        await append(runBase, "policy.admitted", systemActor, {
          policyDigest: digest,
          admissions: publicAdmissions,
        });
        await append(runBase, "run.awaiting_approval", systemActor, { binding });
        const live: LiveRun = {
          writer,
          team,
          admissions,
          context,
          binding,
          scheduler: scheduleWithLimits(team, limits),
          abortControllers: new Map(),
          executions: new Map(),
          events: runBase.events,
          approved: false,
        };
        liveRuns.set(runId, live);
        return projectTeamRun(live.events, { live: true });
      } catch (error) {
        await writer.close().catch(() => undefined);
        liveRuns.delete(runId);
        throw error;
      }
    },

    async approve(input): Promise<TeamRunView> {
      const captured = inspectRecord(
        input,
        ["actor", "binding", "context", "runId"],
        [],
        "approval_request",
        "approval request",
      ).values;
      if (!isRunId(captured.runId)) {
        return serviceError("approval_run", "runId must be a lowercase UUID");
      }
      const actor = captureActor(captured.actor, true) as Extract<Actor, { kind: "human" }>;
      const context = captureContext(captured.context);
      const run = liveRuns.get(captured.runId);
      if (run === undefined) {
        return serviceError("approval_run", "run is not a live admitted run");
      }
      if (!sameRunContext(run.context, context)) {
        return serviceError("context_binding", "approval context does not match the requested run");
      }
      verifyApprovalBinding(run.binding, captured.binding as ApprovalBinding);
      if (run.approved) {
        try {
          return projectTeamRun(run.events, { live: true });
        } catch (error) {
          await abandonLiveRun(captured.runId, run);
          throw error;
        }
      }
      if (run.approvalPromise === undefined) {
        run.approvalPromise = (async () => {
          try {
            await append(run, "approval.granted", actor, { binding: run.binding });
            run.approved = true;
            return projectTeamRun(run.events, { live: true });
          } catch (error) {
            await abandonLiveRun(captured.runId as string, run);
            throw error;
          }
        })();
      }
      return run.approvalPromise;
    },

    async execute(): Promise<TeamRunView> {
      return serviceError("execute_unavailable", "execution is not available before Task 10");
    },

    async cancel(): Promise<TeamRunView> {
      return serviceError("cancel_unavailable", "cancellation is not available before Task 10");
    },

    async status(): Promise<TeamRunView> {
      return serviceError("status_unavailable", "durable status is not available before Task 10");
    },

    async view(): Promise<TeamRunView> {
      return serviceError("view_unavailable", "artifact views are not available before Task 10");
    },
  };

  return Object.freeze(service);
}
