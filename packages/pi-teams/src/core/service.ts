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

type StopCause =
  | { kind: "cancel"; actor: Actor }
  | {
      kind: "failure";
      actor: Actor;
      reason: string;
      memberId?: string;
      result?: MemberResult;
    };

interface StopRequest {
  readonly promise: Promise<StopCause>;
  resolve(value: StopCause): void;
}

type MemberOutcome =
  | { kind: "succeeded"; memberId: string; ref: ArtifactRef; verified: { text: string; result: MemberResult } }
  | { kind: "failed"; memberId: string }
  | { kind: "stopped"; memberId: string };

interface LaunchState {
  readonly memberId: string;
  readonly controller: AbortController;
  execution?: MemberExecution;
  hostSettled: boolean;
  localStarted: boolean;
  rawSettlement?: Promise<void>;
  outcome?: Promise<MemberOutcome>;
  timer?: ReturnType<typeof setTimeout>;
}

interface ContainmentBatch {
  readonly active: LaunchState[];
  readonly outcomes: Promise<Array<{ ok: boolean } | typeof BOUNDED_TIMEOUT>>;
}

interface ObservedUsage {
  input: number;
  output: number;
  costUsd: number | null;
}

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
  readonly verifiedArtifacts: Map<string, { ref: ArtifactRef; text: string; result: MemberResult }>;
  readonly readyEmitted: Set<string>;
  readonly launchStates: Map<string, LaunchState>;
  readonly events: TeamEvent[];
  readonly stop: StopRequest;
  observedUsage: ObservedUsage;
  stopCause?: StopCause;
  containmentBatch?: ContainmentBatch;
  operationPromise?: Promise<TeamRunView>;
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

function createStopRequest(): StopRequest {
  let resolve!: StopRequest["resolve"];
  const promise = new Promise<StopCause>((settle) => { resolve = settle; });
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
    run.verifiedArtifacts.clear();
    run.readyEmitted.clear();
    for (const state of run.launchStates.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    run.launchStates.clear();
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

  const latchStop = (run: LiveRun, cause: StopCause): boolean => {
    if (run.stopCause !== undefined) return false;
    run.stopCause = cause;

    const states = run.team.topologicalOrder
      .map((memberId) => run.launchStates.get(memberId))
      .filter((state): state is LaunchState => state !== undefined);

    // The latch and every registered abort happen before the first containment call.
    for (const state of states) state.controller.abort();

    const active = states.filter((state) => state.execution !== undefined && !state.hostSettled);
    const containmentControllers: AbortController[] = [];
    const containment = active.map((state) => {
      const controller = new AbortController();
      containmentControllers.push(controller);
      try {
        return Promise.resolve(dependencies.host.containMember({
          runId: run.runId,
          memberId: state.memberId,
          handle: state.execution!.handle,
        }, copyMemberContext(run.context, controller.signal), controller.signal)).then(
          () => ({ ok: true }),
          () => ({ ok: false }),
        );
      } catch {
        return Promise.resolve({ ok: false });
      }
    });
    run.containmentBatch = {
      active,
      outcomes: boundedOutcomes(
        containment,
        TEAM_LIMITS.containmentTimeoutMs,
        () => { for (const controller of containmentControllers) controller.abort(); },
      ),
    };
    run.stop.resolve(cause);
    return true;
  };

  const aggregateUsage = (
    run: LiveRun,
    usage: MemberResult["usage"],
  ): ObservedUsage | undefined => {
    const input = run.observedUsage.input + usage.input;
    const output = run.observedUsage.output + usage.output;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return undefined;
    const costUsd = run.observedUsage.costUsd === null || usage.costUsd === null
      ? null
      : run.observedUsage.costUsd + usage.costUsd;
    if (
      costUsd !== null &&
      (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > run.scheduler.team.definition.spec.limits.maxCostUsd)
    ) {
      return undefined;
    }
    return { input, output, costUsd };
  };

  const settleLatchedRun = async (run: LiveRun): Promise<TeamRunView> => {
    const cause = run.stopCause;
    if (cause === undefined) return serviceError("execution_stop", "settlement requires a stop latch");
    const batch = run.containmentBatch ?? { active: [], outcomes: Promise.resolve([]) };
    const containmentOutcomes = await batch.outcomes;
    const containmentTimedOut = containmentOutcomes.some((outcome) => outcome === BOUNDED_TIMEOUT);
    const containmentFailed = containmentOutcomes.some((outcome) =>
      outcome !== BOUNDED_TIMEOUT && !outcome.ok
    );

    // Result settlement starts only after every bounded containment outcome is known.
    const settlementOutcomes = await boundedOutcomes(
      batch.active.map((state) => state.rawSettlement!),
      TEAM_LIMITS.containmentTimeoutMs,
      () => undefined,
    );
    const settlementTimedOut = settlementOutcomes.some((outcome) => outcome === BOUNDED_TIMEOUT);

    // Local artifact processing has no cancellation port. Never terminalize while it can append.
    const local = [...run.launchStates.values()]
      .filter((state) => state.localStarted && state.outcome !== undefined)
      .map((state) => state.outcome!);
    await Promise.all(local);

    let containmentReason: string | undefined;
    if (containmentFailed) containmentReason = "containment_failed";
    else if (containmentTimedOut) containmentReason = "containment_timeout";
    else if (settlementTimedOut) containmentReason = "member_settlement_timeout";

    const failedMemberId = cause.kind === "failure" ? cause.memberId : undefined;
    if (cause.kind === "failure" && failedMemberId !== undefined) {
      const member = run.scheduler.members[failedMemberId];
      const state = run.launchStates.get(failedMemberId);
      const failureProven = state?.execution === undefined || state.hostSettled;
      if (member?.status === "running" && failureProven) {
        run.scheduler = markFailed(run.scheduler, failedMemberId);
        await append(run, "member.failed", systemActor, {
          memberId: failedMemberId,
          error: cause.reason,
        });
        if (cause.result !== undefined) {
          const usage = validatedUsage(
            cause.result,
            run.admissions.find((candidate) => candidate.memberId === failedMemberId)!.maxCostUsd,
          );
          const aggregate = aggregateUsage(run, usage);
          if (aggregate === undefined) containmentReason = "budget_overflow";
          else {
            await append(run, "budget.observed", systemActor, {
              memberId: failedMemberId,
              input: usage.input,
              output: usage.output,
              costUsd: usage.costUsd,
            });
            run.observedUsage = aggregate;
          }
        }
      }
    }

    await append(run, "cancel.requested", cause.actor, {});
    run.scheduler = requestCancellation(run.scheduler);

    const uncontained = new Set<string>();
    if (containmentFailed || containmentTimedOut) {
      for (const state of batch.active) uncontained.add(state.memberId);
    } else if (settlementTimedOut) {
      for (const state of batch.active) {
        if (!state.hostSettled) uncontained.add(state.memberId);
      }
    }

    let members = run.scheduler.members;
    for (const state of run.launchStates.values()) {
      if (members[state.memberId]?.status !== "running" || uncontained.has(state.memberId)) continue;
      if (members === run.scheduler.members) members = { ...members };
      members[state.memberId] = { ...members[state.memberId]!, status: "cancelled" };
    }
    if (members !== run.scheduler.members) run.scheduler = { ...run.scheduler, members };
    await appendCancelledMembers(run);

    const reason = containmentReason ?? (cause.kind === "failure" ? cause.reason : undefined);
    if (reason !== undefined) return finishRun(run, "run.failed", { reason });
    return finishRun(run, "run.cancelled", {});
  };

  const drainAfterAbnormalFailure = async (run: LiveRun): Promise<void> => {
    const batch = run.containmentBatch ?? { active: [], outcomes: Promise.resolve([]) };
    await batch.outcomes;
    await boundedOutcomes(
      batch.active.map((state) => state.rawSettlement!),
      TEAM_LIMITS.containmentTimeoutMs,
      () => undefined,
    );
    const local = [...run.launchStates.values()]
      .filter((state) => state.localStarted && state.outcome !== undefined)
      .map((state) => state.outcome!);
    await Promise.all(local);
    await abandonLiveRun(run.runId, run);
  };

  const guardedOperation = (
    run: LiveRun,
    operation: () => Promise<TeamRunView>,
  ): Promise<TeamRunView> => {
    const promise = (async () => {
      try {
        return await operation();
      } catch (error) {
        latchStop(run, {
          kind: "failure",
          actor: systemActor,
          reason: "event_append_failed",
        });
        await drainAfterAbnormalFailure(run);
        throw error;
      }
    })();
    run.operationPromise = promise;
    return promise;
  };

  const driveExecution = async (run: LiveRun, executeContext: TeamRunContext): Promise<TeamRunView> => {
    const objective = run.events[0]!.payload.objective as string;
    const admissions = new Map(run.admissions.map((admission) => [admission.memberId, admission]));
    let signalListener: (() => void) | undefined;
    if (executeContext.signal !== undefined) {
      signalListener = () => latchStop(run, { kind: "cancel", actor: systemActor });
      if (executeContext.signal.aborted) signalListener();
      else executeContext.signal.addEventListener("abort", signalListener, { once: true });
    }

    const awaitLaunchStage = async <T>(promise: Promise<T>): Promise<T | typeof LAUNCH_STOPPED> => {
      const completed = promise.then((value) => ({ kind: "completed" as const, value }));
      const stopped = run.stop.promise.then(() => ({ kind: "stopped" as const }));
      const outcome = await Promise.race([completed, stopped]);
      if (outcome.kind === "completed") return outcome.value;
      await promise;
      return LAUNCH_STOPPED;
    };

    const launch = async (memberId: string): Promise<void> => {
      if (run.stopCause !== undefined) return;
      const controller = new AbortController();
      const state: LaunchState = {
        memberId,
        controller,
        hostSettled: false,
        localStarted: false,
      };
      run.launchStates.set(memberId, state);
      run.abortControllers.set(memberId, controller);

      if (!run.readyEmitted.has(memberId)) {
        const ready = await awaitLaunchStage(
          append(run, "member.ready", systemActor, { memberId }),
        );
        if (ready === LAUNCH_STOPPED || run.stopCause !== undefined) return;
        run.readyEmitted.add(memberId);
      }

      const started = await awaitLaunchStage(
        append(run, "member.started", systemActor, { memberId }),
      );
      if (started !== LAUNCH_STOPPED) run.scheduler = markStarted(run.scheduler, memberId);
      else {
        // The append completed while stop was latched; mirror its durable transition.
        run.scheduler = markStarted(run.scheduler, memberId);
        return;
      }
      if (run.stopCause !== undefined) return;

      const member = run.team.definition.spec.members.find((candidate) => candidate.id === memberId)!;
      const admission = admissions.get(memberId)!;
      const dependencyRecords = [];
      try {
        for (const dependencyId of member.needs) {
          const dependency = run.verifiedArtifacts.get(dependencyId);
          if (dependency === undefined) {
            return serviceError("dependency_artifact", `${dependencyId} has no verified artifact`);
          }
          const verified = await awaitLaunchStage(dependencies.artifactStore.readVerified(
            run.context.projectId,
            run.runId,
            dependency.ref,
          ));
          if (verified === LAUNCH_STOPPED || run.stopCause !== undefined) return;
          if (verified.text !== dependency.text || verified.result.ok !== true) {
            return serviceError("artifact_integrity", `${dependencyId} artifact changed before use`);
          }
          dependencyRecords.push({
            memberId: dependencyId,
            artifact: dependency.ref,
            text: verified.text,
          });
        }
      } catch (error) {
        latchStop(run, {
          kind: "failure",
          actor: systemActor,
          memberId,
          reason: boundedRuntimeReason(`member_${memberId}:`, error),
        });
        return;
      }
      if (run.stopCause !== undefined) return;

      let execution: MemberExecution;
      try {
        execution = dependencies.host.runMember({
          runId: run.runId,
          objective,
          member,
          dependencies: dependencyRecords,
          admission,
          maxCostUsd: admission.maxCostUsd,
          timeoutMs: admission.timeoutMs,
        }, copyMemberContext(run.context, controller.signal), controller.signal);
        if (
          execution === null || typeof execution !== "object" ||
          execution.runId !== run.runId || execution.memberId !== memberId ||
          !(execution.result instanceof Promise)
        ) {
          return serviceError("member_execution", "host returned a contradictory execution handle");
        }
      } catch (error) {
        latchStop(run, {
          kind: "failure",
          actor: systemActor,
          memberId,
          reason: boundedRuntimeReason(`member_${memberId}:`, error),
        });
        return;
      }

      state.execution = execution;
      run.executions.set(memberId, execution);
      const maximumCostUsd = admission.maxCostUsd;
      const raw = execution.result.then(
        (result) => {
          state.hostSettled = true;
          if (state.timer !== undefined) clearTimeout(state.timer);
          state.timer = undefined;
          return { status: "fulfilled" as const, result };
        },
        (error) => {
          state.hostSettled = true;
          if (state.timer !== undefined) clearTimeout(state.timer);
          state.timer = undefined;
          return { status: "rejected" as const, error };
        },
      );
      state.rawSettlement = raw.then(() => undefined);
      state.timer = setTimeout(() => {
        latchStop(run, {
          kind: "failure",
          actor: systemActor,
          memberId,
          reason: `member_timeout:${memberId}`,
        });
      }, admission.timeoutMs);

      state.outcome = (async (): Promise<MemberOutcome> => {
        const rawResult = await raw;
        if (run.stopCause !== undefined) return { kind: "stopped", memberId };
        if (rawResult.status === "rejected") {
          latchStop(run, {
            kind: "failure",
            actor: systemActor,
            memberId,
            reason: boundedRuntimeReason(`member_${memberId}:`, rawResult.error),
          });
          return { kind: "failed", memberId };
        }

        let usage: MemberResult["usage"];
        try {
          usage = validatedUsage(rawResult.result, maximumCostUsd);
        } catch (error) {
          latchStop(run, {
            kind: "failure",
            actor: systemActor,
            memberId,
            reason: boundedRuntimeReason(`member_${memberId}:`, error),
          });
          return { kind: "failed", memberId };
        }
        if (rawResult.result.ok !== true) {
          latchStop(run, {
            kind: "failure",
            actor: systemActor,
            memberId,
            result: rawResult.result,
            reason: boundedRuntimeReason(
              `member_${memberId}:`,
              rawResult.result.error ?? "member failed",
            ),
          });
          return { kind: "failed", memberId };
        }

        state.localStarted = true;
        try {
          const ref = await dependencies.artifactStore.writeMember(
            run.context.projectId,
            run.runId,
            memberId,
            rawResult.result,
          );
          const verified = await dependencies.artifactStore.readVerified(
            run.context.projectId,
            run.runId,
            ref,
          );
          validatedUsage(verified.result, maximumCostUsd);
          if (verified.result.ok !== true || verified.text !== rawResult.result.text) {
            return serviceError("artifact_integrity", "verified artifact contradicts member result");
          }
          void usage;
          if (run.stopCause !== undefined) return { kind: "stopped", memberId };
          return { kind: "succeeded", memberId, ref, verified };
        } catch (error) {
          if (run.stopCause === undefined) {
            latchStop(run, {
              kind: "failure",
              actor: systemActor,
              memberId,
              reason: boundedRuntimeReason(`member_${memberId}:`, error),
            });
          }
          return { kind: "failed", memberId };
        }
      })();
    };

    try {
      await append(run, "run.started", systemActor, {});
      if (run.stopCause !== undefined) return settleLatchedRun(run);

      while (true) {
        for (const memberId of readyMembers(run.scheduler)) {
          if (run.stopCause !== undefined) break;
          await launch(memberId);
        }
        if (run.stopCause !== undefined) return settleLatchedRun(run);

        const allSucceeded = run.team.topologicalOrder.every((memberId) =>
          run.scheduler.members[memberId]?.status === "succeeded"
        );
        if (allSucceeded) {
          if (run.stopCause !== undefined) return settleLatchedRun(run);
          return finishRun(run, "run.completed", {});
        }

        const outcomes = [...run.launchStates.values()]
          .filter((state) => state.outcome !== undefined)
          .map((state) => state.outcome!);
        const outcome = await Promise.race([...outcomes, run.stop.promise]);
        if (run.stopCause !== undefined || outcome.kind === "cancel" || outcome.kind === "failure") {
          return settleLatchedRun(run);
        }
        if (outcome.kind !== "succeeded") continue;

        const state = run.launchStates.get(outcome.memberId);
        if (state === undefined) continue;
        const admission = admissions.get(outcome.memberId)!;
        const usage = validatedUsage(outcome.verified.result, admission.maxCostUsd);
        const aggregate = aggregateUsage(run, usage);
        if (aggregate === undefined) {
          latchStop(run, {
            kind: "failure",
            actor: systemActor,
            memberId: outcome.memberId,
            reason: "budget_overflow",
          });
          return settleLatchedRun(run);
        }

        // Once durable success processing begins it remains serialized and completes as one pipeline.
        await append(run, "member.artifact_recorded", systemActor, { ...outcome.ref });
        await append(run, "member.succeeded", systemActor, { memberId: outcome.memberId });
        run.scheduler = markSucceeded(run.scheduler, outcome.memberId);
        await append(run, "budget.observed", systemActor, {
          memberId: outcome.memberId,
          input: usage.input,
          output: usage.output,
          costUsd: usage.costUsd,
        });
        run.observedUsage = aggregate;
        run.verifiedArtifacts.set(outcome.memberId, {
          ref: outcome.ref,
          text: outcome.verified.text,
          result: outcome.verified.result,
        });
        run.launchStates.delete(outcome.memberId);
        run.executions.delete(outcome.memberId);
        run.abortControllers.delete(outcome.memberId);
        if (run.stopCause !== undefined) return settleLatchedRun(run);
      }
    } finally {
      if (executeContext.signal !== undefined && signalListener !== undefined) {
        executeContext.signal.removeEventListener("abort", signalListener);
      }
    }
  };

  const LAUNCH_STOPPED = Symbol("launch stopped");

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
          verifiedArtifacts: new Map(),
          readyEmitted: new Set(),
          launchStates: new Map(),
          events: runBase.events,
          stop: createStopRequest(),
          observedUsage: { input: 0, output: 0, costUsd: 0 },
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
      if (context.source !== "command") {
        return serviceError("approval_source", "approval requires command-origin context");
      }
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
      if (run.operationPromise !== undefined) return run.operationPromise;
      if (!run.approved) {
        return serviceError("execute_approval", "run has not received exact human approval");
      }
      return guardedOperation(run, () => driveExecution(run, context));
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
      latchStop(run, { kind: "cancel", actor });
      if (run.operationPromise === undefined) {
        return guardedOperation(run, () => settleLatchedRun(run));
      }
      return run.operationPromise;
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
