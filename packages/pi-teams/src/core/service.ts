import { types as nodeUtilTypes } from "node:util";

import { compileTeam } from "./compiler.ts";
import {
  isProjectId,
  isRfc3339Utc,
  isRunId,
  isTerminalTeamEvent,
  validateEventHistory,
} from "./events.ts";
import { assertBoundedUtf8, assertIdentifier, TEAM_LIMITS } from "./limits.ts";
import {
  approvalBinding,
  intersectMemberPolicy,
  policyDigest,
  verifyApprovalBinding,
} from "./policy.ts";
import { projectTeamRun } from "./projection.ts";
import {
  createSchedule,
  markFailed,
  markStarted,
  markSucceeded,
  readyMembers,
  requestCancellation,
} from "./scheduler.ts";
import type {
  Actor,
  Admission,
  ArtifactRef,
  AdmittedMember,
  ApprovalBinding,
  CompiledTeam,
  EventDraft,
  EventWriter,
  HostCapabilities,
  MemberExecution,
  MemberResult,
  MemberView,
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

interface StopRequest {
  readonly promise: Promise<{ kind: "cancel" }>;
  resolve(value: { kind: "cancel" }): void;
}

interface RunningExecution {
  readonly execution: MemberExecution;
  readonly controller: AbortController;
  readonly outcome: Promise<MemberOutcome>;
  cleanup(): void;
}

type MemberOutcome =
  | { kind: "succeeded"; memberId: string; ref: ArtifactRef; verified: { text: string; result: MemberResult } }
  | { kind: "failed"; memberId: string; error: unknown; result?: MemberResult }
  | { kind: "timeout"; memberId: string };

interface LiveRun {
  readonly runId: string;
  readonly writer: EventWriter;
  readonly team: CompiledTeam;
  readonly admissions: AdmittedMember[];
  readonly context: TeamRunContext;
  readonly binding: ApprovalBinding;
  scheduler: ScheduleState;
  readonly abortControllers: Map<string, AbortController>;
  readonly executions: Map<string, MemberExecution>;
  readonly running: Map<string, RunningExecution>;
  readonly outcomes: Map<string, Promise<MemberOutcome>>;
  readonly verifiedArtifacts: Map<string, { ref: ArtifactRef; text: string; result: MemberResult }>;
  readonly readyEmitted: Set<string>;
  readonly events: TeamEvent[];
  readonly stop: StopRequest;
  approvalPromise?: Promise<TeamRunView>;
  executionPromise?: Promise<TeamRunView>;
  cancelPromise?: Promise<TeamRunView>;
  cancelActor?: Actor;
  approved: boolean;
  cancelling: boolean;
  stopRequested: boolean;
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

function createStopRequest(): StopRequest {
  let resolve!: StopRequest["resolve"];
  const promise = new Promise<{ kind: "cancel" }>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function boundedRuntimeReason(prefix: string, error: unknown): string {
  const detail = safeFailureDetail(error);
  const available = TEAM_LIMITS.descriptionBytes - Buffer.byteLength(prefix, "utf8");
  const characters: string[] = [];
  let bytes = 0;
  for (const character of detail) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > available) break;
    characters.push(character);
    bytes += size;
  }
  return `${prefix}${characters.join("") || "execution failed"}`;
}

function validatedUsage(result: MemberResult, maximumCostUsd: number): MemberResult["usage"] {
  const usage = result?.usage;
  if (
    usage === null || typeof usage !== "object" || Array.isArray(usage) ||
    !Number.isSafeInteger(usage.input) || usage.input < 0 ||
    !Number.isSafeInteger(usage.output) || usage.output < 0 ||
    (usage.costUsd !== null && (
      typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) ||
      usage.costUsd < 0 || usage.costUsd > maximumCostUsd
    ))
  ) {
    return serviceError("member_usage", "member usage exceeds its admitted allocation");
  }
  return usage;
}

function copyMemberContext(context: TeamRunContext, signal: AbortSignal): TeamRunContext {
  return Object.freeze({
    cwd: context.cwd,
    projectId: context.projectId,
    projectTrusted: context.projectTrusted,
    source: context.source,
    runtime: context.runtime,
    signal,
  });
}

async function boundedOutcomes<T>(
  promises: Array<Promise<T>>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<Array<T | typeof BOUNDED_TIMEOUT>> {
  if (promises.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof BOUNDED_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(BOUNDED_TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.all(promises.map((promise) => Promise.race([promise, timeout])));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const BOUNDED_TIMEOUT = Symbol("bounded timeout");

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
    for (const entry of run.running.values()) entry.cleanup();
    run.running.clear();
    run.outcomes.clear();
    run.verifiedArtifacts.clear();
    run.readyEmitted.clear();
    run.approvalPromise = undefined;
    await run.writer.close().catch(() => undefined);
  };

  const durableView = async (
    runId: string,
    context: TeamRunContext,
  ): Promise<TeamRunView> => {
    if (!isRunId(runId)) return serviceError("status_run", "runId must be a lowercase UUID");
    const events = validateEventHistory(
      await dependencies.eventStore.read(context.projectId, runId),
      runId,
    );
    const owned = liveRuns.get(runId);
    return projectTeamRun(events, {
      live: owned !== undefined && owned.context.projectId === context.projectId,
    });
  };

  const finishRun = async (
    run: LiveRun,
    type: "run.completed" | "run.failed" | "run.cancelled",
    payload: Record<string, unknown>,
  ): Promise<TeamRunView> => {
    await append(run, type, systemActor, payload);
    const projected = projectTeamRun(run.events, { live: false });
    await abandonLiveRun(run.runId, run);
    return projected;
  };

  const appendCancelledMembers = async (run: LiveRun): Promise<void> => {
    for (const memberId of run.team.topologicalOrder) {
      if (run.scheduler.members[memberId]?.status !== "cancelled") continue;
      const alreadyRecorded = run.events.some((event) =>
        event.type === "member.cancelled" && event.payload.memberId === memberId
      );
      if (!alreadyRecorded) await append(run, "member.cancelled", systemActor, { memberId });
    }
  };

  const settleStoppedRun = async (
    run: LiveRun,
    terminal: { kind: "cancel" } | { kind: "failure"; reason: string },
    actor: Actor,
  ): Promise<TeamRunView> => {
    if (!run.cancelling) {
      await append(run, "cancel.requested", actor, {});
      run.cancelling = true;
      run.scheduler = requestCancellation(run.scheduler);
    }

    const active = run.team.topologicalOrder
      .map((memberId) => run.running.get(memberId))
      .filter((entry): entry is RunningExecution => entry !== undefined);

    // All child controllers are aborted before any containment call starts.
    for (const entry of active) entry.controller.abort();

    const containmentControllers: AbortController[] = [];
    const containment = active.map((entry) => {
      const controller = new AbortController();
      containmentControllers.push(controller);
      try {
        return Promise.resolve(dependencies.host.containMember({
          runId: run.runId,
          memberId: entry.execution.memberId,
          handle: entry.execution.handle,
        }, copyMemberContext(run.context, controller.signal), controller.signal)).then(
          () => ({ ok: true as const }),
          () => ({ ok: false as const }),
        );
      } catch {
        return Promise.resolve({ ok: false as const });
      }
    });

    const containmentOutcomes = await boundedOutcomes(
      containment,
      TEAM_LIMITS.containmentTimeoutMs,
      () => { for (const controller of containmentControllers) controller.abort(); },
    );
    const containmentTimedOut = containmentOutcomes.some((outcome) => outcome === BOUNDED_TIMEOUT);
    const containmentFailed = containmentOutcomes.some((outcome) =>
      outcome !== BOUNDED_TIMEOUT && !outcome.ok
    );

    const settlement = active.map((entry) => entry.execution.result.then(
      () => ({ settled: true as const }),
      () => ({ settled: true as const }),
    ));
    const settlementOutcomes = await boundedOutcomes(
      settlement,
      TEAM_LIMITS.containmentTimeoutMs,
      () => undefined,
    );
    const settlementTimedOut = settlementOutcomes.some((outcome) => outcome === BOUNDED_TIMEOUT);

    for (const entry of active) {
      const memberId = entry.execution.memberId;
      entry.cleanup();
      run.running.delete(memberId);
      run.outcomes.delete(memberId);
      run.executions.delete(memberId);
      run.abortControllers.delete(memberId);
    }

    let containmentReason: string | undefined;
    if (containmentFailed) containmentReason = "containment_failed";
    else if (containmentTimedOut) containmentReason = "containment_timeout";
    else if (settlementTimedOut) containmentReason = "member_settlement_timeout";

    if (containmentReason === undefined) {
      let members = run.scheduler.members;
      for (const entry of active) {
        const memberId = entry.execution.memberId;
        if (members[memberId]?.status !== "running") continue;
        if (members === run.scheduler.members) members = { ...members };
        members[memberId] = { ...members[memberId]!, status: "cancelled" };
      }
      if (members !== run.scheduler.members) run.scheduler = { ...run.scheduler, members };
      await appendCancelledMembers(run);
    } else {
      // Pending and ready work was conclusively cancelled even if a live child was not contained.
      await appendCancelledMembers(run);
    }

    const reason = containmentReason ?? (terminal.kind === "failure" ? terminal.reason : undefined);
    if (reason !== undefined) return finishRun(run, "run.failed", { reason });
    return finishRun(run, "run.cancelled", {});
  };

  const emergencyAbandon = async (run: LiveRun): Promise<void> => {
    const active = [...run.running.values()];
    for (const entry of active) entry.controller.abort();
    const containmentControllers: AbortController[] = [];
    const containment = active.map((entry) => {
      const controller = new AbortController();
      containmentControllers.push(controller);
      try {
        return Promise.resolve(dependencies.host.containMember({
          runId: run.runId,
          memberId: entry.execution.memberId,
          handle: entry.execution.handle,
        }, copyMemberContext(run.context, controller.signal), controller.signal)).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve();
      }
    });
    await boundedOutcomes(
      containment,
      TEAM_LIMITS.containmentTimeoutMs,
      () => { for (const controller of containmentControllers) controller.abort(); },
    );
    await boundedOutcomes(
      active.map((entry) => entry.execution.result.then(() => undefined, () => undefined)),
      TEAM_LIMITS.containmentTimeoutMs,
      () => undefined,
    );
    await abandonLiveRun(run.runId, run);
  };

  const driveExecution = async (run: LiveRun, executeContext: TeamRunContext): Promise<TeamRunView> => {
    const objective = run.events[0]!.payload.objective as string;
    const admissions = new Map(run.admissions.map((admission) => [admission.memberId, admission]));
    let signalListener: (() => void) | undefined;
    if (executeContext.signal !== undefined) {
      signalListener = () => {
        run.stopRequested = true;
        run.stop.resolve({ kind: "cancel" });
      };
      if (executeContext.signal.aborted) signalListener();
      else executeContext.signal.addEventListener("abort", signalListener, { once: true });
    }

    const launch = async (memberId: string): Promise<void> => {
      if (run.stopRequested) return;
      if (!run.readyEmitted.has(memberId)) {
        await append(run, "member.ready", systemActor, { memberId });
        run.readyEmitted.add(memberId);
      }
      if (run.stopRequested) return;
      await append(run, "member.started", systemActor, { memberId });
      run.scheduler = markStarted(run.scheduler, memberId);
      const member = run.team.definition.spec.members.find((candidate) => candidate.id === memberId)!;
      const admission = admissions.get(memberId)!;
      const controller = new AbortController();
      run.abortControllers.set(memberId, controller);
      const memberContext = copyMemberContext(run.context, controller.signal);

      let execution: MemberExecution;
      try {
        const dependencyRecords = [];
        for (const dependencyId of member.needs) {
          const dependency = run.verifiedArtifacts.get(dependencyId);
          if (dependency === undefined) {
            return serviceError("dependency_artifact", `${dependencyId} has no verified artifact`);
          }
          const verified = await dependencies.artifactStore.readVerified(
            run.context.projectId,
            run.runId,
            dependency.ref,
          );
          if (verified.text !== dependency.text || verified.result.ok !== true) {
            return serviceError("artifact_integrity", `${dependencyId} artifact changed before use`);
          }
          dependencyRecords.push({
            memberId: dependencyId,
            artifact: dependency.ref,
            text: verified.text,
          });
        }
        execution = dependencies.host.runMember({
          runId: run.runId,
          objective,
          member,
          dependencies: dependencyRecords,
          admission,
          maxCostUsd: admission.maxCostUsd,
          timeoutMs: admission.timeoutMs,
        }, memberContext, controller.signal);
        if (
          execution === null || typeof execution !== "object" ||
          execution.runId !== run.runId || execution.memberId !== memberId ||
          !(execution.result instanceof Promise)
        ) {
          return serviceError("member_execution", "host returned a contradictory execution handle");
        }
      } catch (error) {
        run.outcomes.set(
          memberId,
          Promise.resolve({ kind: "failed", memberId, error } as MemberOutcome),
        );
        return;
      }

      run.executions.set(memberId, execution);
      const maximumCostUsd = admission.maxCostUsd;
      let acceptResult = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<MemberOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timeout", memberId });
        }, admission.timeoutMs);
      });
      const result: Promise<MemberOutcome> = (async () => {
        try {
          const memberResult = await execution.result;
          if (!acceptResult) {
            return { kind: "failed", memberId, error: "member result arrived after stop" };
          }
          const usage = validatedUsage(memberResult, maximumCostUsd);
          if (memberResult.ok !== true) {
            return {
              kind: "failed",
              memberId,
              error: memberResult.error ?? "member failed",
              result: memberResult,
            };
          }
          const ref = await dependencies.artifactStore.writeMember(
            run.context.projectId,
            run.runId,
            memberId,
            memberResult,
          );
          const verified = await dependencies.artifactStore.readVerified(
            run.context.projectId,
            run.runId,
            ref,
          );
          validatedUsage(verified.result, maximumCostUsd);
          if (verified.result.ok !== true || verified.text !== memberResult.text) {
            return serviceError("artifact_integrity", "verified artifact contradicts member result");
          }
          void usage;
          return { kind: "succeeded", memberId, ref, verified };
        } catch (error) {
          return { kind: "failed", memberId, error };
        }
      })();
      const cleanup = () => {
        acceptResult = false;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const outcome = Promise.race([result, timeout]).finally(cleanup);
      run.running.set(memberId, { execution, controller, outcome, cleanup });
      run.outcomes.set(memberId, outcome);
    };

    try {
      await append(run, "run.started", systemActor, {});
      while (true) {
        if (!run.cancelling) {
          for (const memberId of readyMembers(run.scheduler)) {
            if (run.stopRequested) break;
            await launch(memberId);
          }
        }
        const allSucceeded = run.team.topologicalOrder.every((memberId) =>
          run.scheduler.members[memberId]?.status === "succeeded"
        );
        if (allSucceeded) return finishRun(run, "run.completed", {});

        const pending = [...run.outcomes.values()];
        const outcome = await Promise.race([...pending, run.stop.promise]);
        if (outcome.kind === "cancel") {
          return settleStoppedRun(run, { kind: "cancel" }, run.cancelActor ?? systemActor);
        }

        if (!run.outcomes.has(outcome.memberId)) continue;
        if (outcome.kind === "succeeded") {
          run.running.get(outcome.memberId)?.cleanup();
          run.running.delete(outcome.memberId);
          run.outcomes.delete(outcome.memberId);
          run.executions.delete(outcome.memberId);
          run.abortControllers.delete(outcome.memberId);
          const usage = validatedUsage(outcome.verified.result, admissions.get(outcome.memberId)!.maxCostUsd);
          await append(run, "member.artifact_recorded", systemActor, { ...outcome.ref });
          await append(run, "member.succeeded", systemActor, { memberId: outcome.memberId });
          await append(run, "budget.observed", systemActor, {
            memberId: outcome.memberId,
            input: usage.input,
            output: usage.output,
            costUsd: usage.costUsd,
          });
          run.scheduler = markSucceeded(run.scheduler, outcome.memberId);
          run.verifiedArtifacts.set(outcome.memberId, {
            ref: outcome.ref,
            text: outcome.verified.text,
            result: outcome.verified.result,
          });
          continue;
        }

        const reason = outcome.kind === "timeout"
          ? `member_timeout:${outcome.memberId}`
          : boundedRuntimeReason(`member_${outcome.memberId}:`, outcome.error);
        if (outcome.kind === "failed") {
          run.running.get(outcome.memberId)?.cleanup();
          run.running.delete(outcome.memberId);
          run.outcomes.delete(outcome.memberId);
          run.executions.delete(outcome.memberId);
          run.abortControllers.delete(outcome.memberId);
          run.scheduler = markFailed(run.scheduler, outcome.memberId);
          await append(run, "member.failed", systemActor, { memberId: outcome.memberId, error: reason });
          if (outcome.result !== undefined) {
            const usage = validatedUsage(outcome.result, admissions.get(outcome.memberId)!.maxCostUsd);
            await append(run, "budget.observed", systemActor, {
              memberId: outcome.memberId,
              input: usage.input,
              output: usage.output,
              costUsd: usage.costUsd,
            });
          }
        }
        return settleStoppedRun(run, { kind: "failure", reason }, systemActor);
      }
    } finally {
      if (executeContext.signal !== undefined && signalListener !== undefined) {
        executeContext.signal.removeEventListener("abort", signalListener);
      }
    }
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
          runId,
          writer,
          team,
          admissions,
          context,
          binding,
          scheduler: scheduleWithLimits(team, limits),
          abortControllers: new Map(),
          executions: new Map(),
          running: new Map(),
          outcomes: new Map(),
          verifiedArtifacts: new Map(),
          readyEmitted: new Set(),
          events: runBase.events,
          stop: createStopRequest(),
          approved: false,
          cancelling: false,
          stopRequested: false,
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
        try {
          const persisted = await durableView(captured.runId, context);
          if (!isTerminalTeamEvent(persisted.lastEvent.type)) {
            return serviceError("resume_unsupported", "Slice 1 cannot resume a persisted run");
          }
        } catch (error) {
          if (String(error).startsWith("Error: resume_unsupported:")) throw error;
        }
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

    async execute(rawRunId, rawContext): Promise<TeamRunView> {
      if (!isRunId(rawRunId)) {
        return serviceError("execute_run", "runId must be a lowercase UUID");
      }
      const context = captureContext(rawContext);
      const run = liveRuns.get(rawRunId);
      if (run === undefined) {
        const persisted = await durableView(rawRunId, context);
        return serviceError(
          "resume_unsupported",
          `Slice 1 cannot execute persisted run in state ${persisted.status}`,
        );
      }
      if (!sameRunContext(run.context, context)) {
        return serviceError("context_binding", "execution context does not match the requested run");
      }
      if (!run.approved) {
        return serviceError("execute_approval", "run has not received exact human approval");
      }
      if (run.executionPromise === undefined) {
        run.executionPromise = driveExecution(run, context).catch(async (error) => {
          if (liveRuns.get(rawRunId) === run) await emergencyAbandon(run);
          throw error;
        });
      }
      return run.executionPromise;
    },

    async cancel(rawRunId, rawActor, rawContext): Promise<TeamRunView> {
      if (!isRunId(rawRunId)) {
        return serviceError("cancel_run", "runId must be a lowercase UUID");
      }
      const actor = captureActor(rawActor);
      const context = captureContext(rawContext);
      const run = liveRuns.get(rawRunId);
      if (run === undefined) {
        const persisted = await durableView(rawRunId, context);
        if (isTerminalTeamEvent(persisted.lastEvent.type)) return persisted;
        return serviceError("resume_unsupported", "Slice 1 cannot cancel an incomplete run");
      }
      if (!sameRunContext(run.context, context)) {
        return serviceError("context_binding", "cancellation context does not match the requested run");
      }
      if (run.cancelPromise === undefined) {
        if (run.executionPromise !== undefined) {
          run.cancelActor = actor;
          run.stopRequested = true;
          run.stop.resolve({ kind: "cancel" });
          run.cancelPromise = run.executionPromise;
        } else {
          run.cancelPromise = settleStoppedRun(run, { kind: "cancel" }, actor).catch(async (error) => {
            if (liveRuns.get(rawRunId) === run) await emergencyAbandon(run);
            throw error;
          });
        }
      }
      return run.cancelPromise;
    },

    async status(rawRunId, rawContext): Promise<TeamRunView> {
      const context = captureContext(rawContext);
      if (rawRunId !== undefined) return durableView(rawRunId, context);
      const runIds = await dependencies.eventStore.list(context.projectId);
      if (!Array.isArray(runIds) || runIds.length === 0) {
        return serviceError("status_run", "no team runs exist for this project");
      }
      const candidates = await Promise.all(runIds.map(async (runId) => {
        if (!isRunId(runId)) return serviceError("status_run", "event store listed an invalid run ID");
        const view = await durableView(runId, context);
        return { runId, view, time: Date.parse(view.lastEvent.occurredAt) };
      }));
      candidates.sort((left, right) => left.time - right.time || left.runId.localeCompare(right.runId));
      return candidates.at(-1)!.view;
    },

    async view(rawRunId, rawMemberId, rawContext): Promise<TeamRunView | MemberView> {
      if (!isRunId(rawRunId)) {
        return serviceError("view_run", "runId must be a lowercase UUID");
      }
      const context = captureContext(rawContext);
      const run = await durableView(rawRunId, context);
      if (rawMemberId === undefined) return run;
      try {
        assertIdentifier(rawMemberId, "memberId");
      } catch (error) {
        return serviceError("view_member", String(error));
      }
      const member = run.members[rawMemberId];
      if (member === undefined) return serviceError("view_member", "member does not exist in this run");
      if (member.artifact === undefined) {
        return serviceError("view_artifact", "member has no recorded artifact");
      }
      const verified = await dependencies.artifactStore.readVerified(
        context.projectId,
        rawRunId,
        member.artifact,
      );
      return { run, member, text: verified.text, result: verified.result };
    },
  };

  return Object.freeze(service);
}
