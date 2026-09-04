import { types as nodeUtilTypes } from "node:util";

import { IDENTIFIER, TEAM_LIMITS } from "./limits.ts";
import type {
  ApprovalBinding,
  ArtifactRef,
  PublicAdmission,
  TeamEvent,
  TeamLimits,
  TeamMemberStatus,
  TeamMemberView,
  TeamRef,
  TeamRunStatus,
  TeamRunView,
} from "./types.ts";

const HASH = /^[0-9a-f]{64}$/;
const PROJECT_ID = HASH;
const TEAM_REF = /^(builtin|user|project)\/[a-z][a-z0-9-]{0,63}$/;
const ROUTES = new Set(["research", "review", "planning"]);
const CAPABILITIES = new Set(["repo.read"]);
const TOOLS = new Set(["read", "grep", "find", "ls"]);

interface DataRecord {
  names: string[];
  values: Record<string, unknown>;
}

interface MemberState extends TeamMemberView {
  needs: string[];
  usageObserved: boolean;
}

type Phase =
  | "none"
  | "requested"
  | "snapshotted"
  | "admitted"
  | "policy_blocked"
  | "awaiting_approval"
  | "approved"
  | "started"
  | "cancelling"
  | "terminal";

interface FoldState {
  phase: Phase;
  runId?: string;
  projectId?: string;
  teamRef?: TeamRef;
  objective?: string;
  manifestDigest?: string;
  planDigest?: string;
  policyDigest?: string;
  approvalBinding?: ApprovalBinding;
  limits?: TeamLimits;
  admissions: PublicAdmission[];
  members: Record<string, MemberState>;
  memberOrder: string[];
  blockedReasons: string[];
  usage: { input: number; output: number; costUsd: number | null };
  started: boolean;
  status?: TeamRunStatus;
}

function lifecycleError(message: string): never {
  throw new Error(`event_transition:${message}`);
}

function payloadError(message: string): never {
  throw new Error(`event_payload:${message}`);
}

function identityError(message: string): never {
  throw new Error(`event_identity:${message}`);
}

function inspectRecord(value: unknown, keys: readonly string[], label: string): DataRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return payloadError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return payloadError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return payloadError(`${label} must not have symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index])
  ) {
    return payloadError(`${label} has an invalid shape`);
  }
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return payloadError(`${label}.${name} must be an enumerable data property`);
    }
    values[name] = descriptor.value;
  }
  return { names, values };
}

function inspectArray(
  value: unknown,
  label: string,
  maximum: number = TEAM_LIMITS.members,
): unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return payloadError(`${label} must be an array`);
  }
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > maximum) {
    return payloadError(`${label} has an invalid length`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return payloadError(`${label} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return payloadError(`${label} must not have symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  const expected = ["length", ...Array.from({ length }, (_, index) => String(index))];
  if (names.length !== expected.length || names.some((name) => !expected.includes(name))) {
    return payloadError(`${label} must be dense without extra properties`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return payloadError(`${label}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function requireString(value: unknown, label: string, maximum: number, nonblank = true): string {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    (nonblank && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    return payloadError(`${label} must be a bounded well-formed string`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return payloadError(`${label} must be a valid identifier`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    return payloadError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireProjectId(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    return payloadError("run.requested.projectId must be a lowercase project digest");
  }
  return value;
}

function requireTeamRef(value: unknown, label: string): TeamRef {
  if (typeof value !== "string" || !TEAM_REF.test(value)) {
    return payloadError(`${label} must be a qualified team reference`);
  }
  return value as TeamRef;
}

function requireFiniteNonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return payloadError(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return payloadError(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    return payloadError(`${label} must be a bounded positive integer`);
  }
  return value as number;
}

function parseLimits(value: unknown): TeamLimits {
  const record = inspectRecord(
    value,
    ["maxConcurrency", "maxCostUsd", "timeoutMs", "maxMembers"],
    "manifest.snapshotted.limits",
  ).values;
  const maxMembers = requirePositiveInteger(
    record.maxMembers,
    "limits.maxMembers",
    TEAM_LIMITS.members,
  );
  const maxConcurrency = requirePositiveInteger(
    record.maxConcurrency,
    "limits.maxConcurrency",
    TEAM_LIMITS.concurrency,
  );
  if (maxConcurrency > maxMembers) {
    return payloadError("limits.maxConcurrency must not exceed maxMembers");
  }
  const maxCostUsd = requirePositiveInteger(
    record.maxCostUsd,
    "limits.maxCostUsd",
    TEAM_LIMITS.costUsd,
  );
  const timeoutMs = requirePositiveInteger(
    record.timeoutMs,
    "limits.timeoutMs",
    TEAM_LIMITS.timeoutMs,
  );
  return { maxConcurrency, maxCostUsd, timeoutMs, maxMembers };
}

function parseMembers(value: unknown, limits: TeamLimits): Array<{ id: string; needs: string[] }> {
  const items = inspectArray(value, "manifest.snapshotted.members");
  if (items.length === 0 || items.length > limits.maxMembers) {
    return payloadError("manifest.snapshotted.members must fit maxMembers");
  }
  const members: Array<{ id: string; needs: string[] }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const record = inspectRecord(
      items[index],
      ["id", "needs"],
      `manifest.snapshotted.members[${index}]`,
    ).values;
    const id = requireIdentifier(record.id, `members[${index}].id`);
    if (seen.has(id)) return payloadError(`duplicate member ${id}`);
    const needs = inspectArray(record.needs, `members[${index}].needs`).map((need, needIndex) =>
      requireIdentifier(need, `members[${index}].needs[${needIndex}]`)
    );
    if (new Set(needs).size !== needs.length || needs.some((need) => !seen.has(need))) {
      return payloadError(`member ${id} dependencies must be unique earlier members`);
    }
    seen.add(id);
    members.push({ id, needs });
  }
  return members;
}

function parseStringArray(value: unknown, label: string): string[] {
  const items = inspectArray(value, label, TEAM_LIMITS.members);
  if (items.length === 0) return payloadError(`${label} must not be empty`);
  return items.map((item, index) =>
    requireString(item, `${label}[${index}]`, TEAM_LIMITS.descriptionBytes)
  );
}

function parseAuthorityArray(
  value: unknown,
  label: string,
  supported: Set<string>,
): string[] {
  const items = inspectArray(value, label, 4);
  if (items.length === 0) return payloadError(`${label} must not be empty`);
  const parsed = items.map((item, index) => requireString(item, `${label}[${index}]`, 64));
  if (new Set(parsed).size !== parsed.length || parsed.some((item) => !supported.has(item))) {
    return payloadError(`${label} contains unknown or duplicate authority`);
  }
  return parsed;
}

function parseAdmission(value: unknown, expectedMemberId: string, limits: TeamLimits): PublicAdmission {
  const record = inspectRecord(value, [
    "ok", "memberId", "effectiveRoute", "effectiveModel", "effectiveCapabilities",
    "effectiveTools", "maxCostUsd", "timeoutMs",
  ], `policy.admitted admission ${expectedMemberId}`).values;
  if (record.ok !== true) return payloadError("policy.admitted admissions must be successful");
  const memberId = requireIdentifier(record.memberId, "admission.memberId");
  if (memberId !== expectedMemberId) return identityError("admission member order or identity mismatch");
  if (typeof record.effectiveRoute !== "string" || !ROUTES.has(record.effectiveRoute)) {
    return payloadError("admission.effectiveRoute is unknown");
  }
  const effectiveModel = record.effectiveModel === null
    ? null
    : requireString(record.effectiveModel, "admission.effectiveModel", TEAM_LIMITS.descriptionBytes);
  const effectiveCapabilities = parseAuthorityArray(
    record.effectiveCapabilities,
    "admission.effectiveCapabilities",
    CAPABILITIES,
  ) as ["repo.read"];
  const effectiveTools = parseAuthorityArray(
    record.effectiveTools,
    "admission.effectiveTools",
    TOOLS,
  ) as Array<"read" | "grep" | "find" | "ls">;
  const maxCostUsd = requireFiniteNonnegative(record.maxCostUsd, "admission.maxCostUsd");
  if (maxCostUsd <= 0 || maxCostUsd > limits.maxCostUsd) {
    return payloadError("admission.maxCostUsd must fit run limits");
  }
  const timeoutMs = requirePositiveInteger(
    record.timeoutMs,
    "admission.timeoutMs",
    limits.timeoutMs,
  );
  return {
    ok: true,
    memberId,
    effectiveRoute: record.effectiveRoute as "research" | "review" | "planning",
    effectiveModel,
    effectiveCapabilities,
    effectiveTools,
    maxCostUsd,
    timeoutMs,
  };
}

function parseBinding(value: unknown, state: FoldState, label: string): ApprovalBinding {
  const record = inspectRecord(
    value,
    ["runId", "manifestDigest", "planDigest", "policyDigest", "requestedAction"],
    label,
  ).values;
  const binding: ApprovalBinding = {
    runId: requireString(record.runId, `${label}.runId`, 64),
    manifestDigest: requireHash(record.manifestDigest, `${label}.manifestDigest`),
    planDigest: requireHash(record.planDigest, `${label}.planDigest`),
    policyDigest: requireHash(record.policyDigest, `${label}.policyDigest`),
    requestedAction: record.requestedAction === "execute"
      ? "execute"
      : payloadError(`${label}.requestedAction must be execute`),
  };
  if (
    binding.runId !== state.runId ||
    binding.manifestDigest !== state.manifestDigest ||
    binding.planDigest !== state.planDigest ||
    binding.policyDigest !== state.policyDigest
  ) {
    return identityError(`${label} does not bind this run policy`);
  }
  return binding;
}

function sameBinding(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return left.runId === right.runId &&
    left.manifestDigest === right.manifestDigest &&
    left.planDigest === right.planDigest &&
    left.policyDigest === right.policyDigest &&
    left.requestedAction === right.requestedAction;
}

function parseMemberId(payload: unknown, label: string): string {
  const values = inspectRecord(payload, ["memberId"], label).values;
  return requireIdentifier(values.memberId, `${label}.memberId`);
}

function memberFor(state: FoldState, memberId: string): MemberState {
  const member = state.members[memberId];
  if (member === undefined) return identityError(`unknown member ${memberId}`);
  return member;
}

function requirePhase(state: FoldState, phase: Phase, type: string): void {
  if (state.phase !== phase) lifecycleError(`${type} is invalid during ${state.phase}`);
}

function requireEmptyPayload(payload: unknown, type: string): void {
  inspectRecord(payload, [], type);
}

function parseArtifact(payload: unknown): ArtifactRef {
  const record = inspectRecord(payload, [
    "memberId", "outputPath", "resultPath", "outputBytes", "outputSha256",
    "resultBytes", "resultSha256",
  ], "member.artifact_recorded").values;
  const memberId = requireIdentifier(record.memberId, "artifact.memberId");
  const outputPath = requireString(record.outputPath, "artifact.outputPath", 256);
  const resultPath = requireString(record.resultPath, "artifact.resultPath", 256);
  if (
    outputPath !== `artifacts/${memberId}/output.md` ||
    resultPath !== `artifacts/${memberId}/result.json`
  ) {
    return identityError("artifact paths do not match member identity");
  }
  const outputBytes = requireNonnegativeInteger(record.outputBytes, "artifact.outputBytes");
  const resultBytes = requireNonnegativeInteger(record.resultBytes, "artifact.resultBytes");
  if (outputBytes > TEAM_LIMITS.outputBytes || resultBytes > TEAM_LIMITS.resultBytes) {
    return payloadError("artifact byte count exceeds package limits");
  }
  return {
    memberId,
    outputPath,
    resultPath,
    outputBytes,
    outputSha256: requireHash(record.outputSha256, "artifact.outputSha256"),
    resultBytes,
    resultSha256: requireHash(record.resultSha256, "artifact.resultSha256"),
  };
}

function hasRunningMember(state: FoldState): boolean {
  return state.memberOrder.some((id) => state.members[id]!.status === "running");
}

function applyEvent(state: FoldState, event: TeamEvent, index: number): void {
  if (state.phase === "terminal") lifecycleError(`${event.type} appears after a terminal event`);
  if (index === 0) {
    state.runId = event.runId;
  } else if (event.runId !== state.runId) {
    identityError(`event ${index + 1} has a different run ID`);
  }

  switch (event.type) {
    case "run.requested": {
      requirePhase(state, "none", event.type);
      const record = inspectRecord(
        event.payload,
        ["projectId", "teamRef", "objective"],
        event.type,
      ).values;
      state.projectId = requireProjectId(record.projectId);
      state.teamRef = requireTeamRef(record.teamRef, "run.requested.teamRef");
      state.objective = requireString(
        record.objective,
        "run.requested.objective",
        TEAM_LIMITS.objectiveBytes,
      );
      state.phase = "requested";
      return;
    }
    case "manifest.snapshotted": {
      requirePhase(state, "requested", event.type);
      const record = inspectRecord(
        event.payload,
        ["teamRef", "manifestDigest", "planDigest", "limits", "members"],
        event.type,
      ).values;
      const teamRef = requireTeamRef(record.teamRef, "manifest.snapshotted.teamRef");
      if (teamRef !== state.teamRef) identityError("snapshot team reference mismatch");
      state.manifestDigest = requireHash(record.manifestDigest, "manifestDigest");
      state.planDigest = requireHash(record.planDigest, "planDigest");
      state.limits = parseLimits(record.limits);
      const members = parseMembers(record.members, state.limits);
      if (members.length !== state.limits.maxMembers) {
        return payloadError("limits.maxMembers must equal the snapshotted member count");
      }
      state.memberOrder = members.map(({ id }) => id);
      for (const member of members) {
        state.members[member.id] = {
          id: member.id,
          status: "pending",
          needs: member.needs,
          usageObserved: false,
        };
      }
      state.phase = "snapshotted";
      return;
    }
    case "policy.admitted": {
      requirePhase(state, "snapshotted", event.type);
      const record = inspectRecord(
        event.payload,
        ["policyDigest", "admissions"],
        event.type,
      ).values;
      state.policyDigest = requireHash(record.policyDigest, "policy.admitted.policyDigest");
      const admissions = inspectArray(record.admissions, "policy.admitted.admissions");
      if (admissions.length !== state.memberOrder.length) {
        return payloadError("policy.admitted must include every member exactly once");
      }
      state.admissions = admissions.map((admission, admissionIndex) =>
        parseAdmission(admission, state.memberOrder[admissionIndex]!, state.limits!)
      );
      state.phase = "admitted";
      return;
    }
    case "policy.blocked": {
      requirePhase(state, "snapshotted", event.type);
      const record = inspectRecord(event.payload, ["reasons"], event.type).values;
      state.blockedReasons = parseStringArray(record.reasons, "policy.blocked.reasons");
      state.phase = "policy_blocked";
      return;
    }
    case "run.awaiting_approval": {
      requirePhase(state, "admitted", event.type);
      const record = inspectRecord(event.payload, ["binding"], event.type).values;
      state.approvalBinding = parseBinding(record.binding, state, "run.awaiting_approval.binding");
      state.phase = "awaiting_approval";
      state.status = "awaiting_approval";
      return;
    }
    case "approval.granted": {
      requirePhase(state, "awaiting_approval", event.type);
      if (event.actor.kind !== "human") {
        lifecycleError("approval.granted requires a human actor");
      }
      const record = inspectRecord(event.payload, ["binding"], event.type).values;
      const binding = parseBinding(record.binding, state, "approval.granted.binding");
      if (state.approvalBinding === undefined || !sameBinding(binding, state.approvalBinding)) {
        identityError("approval does not match awaiting binding");
      }
      state.phase = "approved";
      state.status = undefined;
      return;
    }
    case "run.started":
      requirePhase(state, "approved", event.type);
      requireEmptyPayload(event.payload, event.type);
      state.phase = "started";
      state.started = true;
      return;
    case "member.ready": {
      requirePhase(state, "started", event.type);
      const memberId = parseMemberId(event.payload, event.type);
      const member = memberFor(state, memberId);
      if (member.status !== "pending") lifecycleError(`${memberId} cannot become ready from ${member.status}`);
      if (member.needs.some((dependency) => state.members[dependency]!.status !== "succeeded")) {
        lifecycleError(`${memberId} dependencies have not succeeded`);
      }
      member.status = "ready";
      return;
    }
    case "member.started": {
      requirePhase(state, "started", event.type);
      const memberId = parseMemberId(event.payload, event.type);
      const member = memberFor(state, memberId);
      if (member.status !== "ready") lifecycleError(`${memberId} cannot start from ${member.status}`);
      member.status = "running";
      return;
    }
    case "member.artifact_recorded": {
      requirePhase(state, "started", event.type);
      const artifact = parseArtifact(event.payload);
      const member = memberFor(state, artifact.memberId);
      if (member.status !== "running" || member.artifact !== undefined) {
        lifecycleError(`${artifact.memberId} cannot record an artifact from ${member.status}`);
      }
      member.artifact = artifact;
      return;
    }
    case "member.succeeded": {
      requirePhase(state, "started", event.type);
      const memberId = parseMemberId(event.payload, event.type);
      const member = memberFor(state, memberId);
      if (member.status !== "running" || member.artifact === undefined) {
        lifecycleError(`${memberId} cannot succeed without running and an artifact`);
      }
      member.status = "succeeded";
      return;
    }
    case "member.failed": {
      requirePhase(state, "started", event.type);
      const record = inspectRecord(event.payload, ["memberId", "error"], event.type).values;
      const memberId = requireIdentifier(record.memberId, "member.failed.memberId");
      const member = memberFor(state, memberId);
      if (member.status !== "running") lifecycleError(`${memberId} cannot fail from ${member.status}`);
      member.status = "failed";
      member.error = requireString(
        record.error,
        "member.failed.error",
        TEAM_LIMITS.descriptionBytes,
      );
      return;
    }
    case "budget.observed": {
      if (state.phase !== "started" && state.phase !== "cancelling") {
        lifecycleError(`${event.type} is invalid during ${state.phase}`);
      }
      const record = inspectRecord(
        event.payload,
        ["memberId", "input", "output", "costUsd"],
        event.type,
      ).values;
      const memberId = requireIdentifier(record.memberId, "budget.observed.memberId");
      const input = requireNonnegativeInteger(record.input, "budget.observed.input");
      const output = requireNonnegativeInteger(record.output, "budget.observed.output");
      const costUsd = record.costUsd === null
        ? null
        : requireFiniteNonnegative(record.costUsd, "budget.observed.costUsd");
      const member = memberFor(state, memberId);
      if (
        member.usageObserved ||
        (member.status !== "succeeded" && member.status !== "failed")
      ) {
        lifecycleError(`${memberId} usage contradicts member state ${member.status}`);
      }
      const admission = state.admissions.find((candidate) => candidate.memberId === memberId);
      if (
        admission === undefined ||
        !admission.ok ||
        (costUsd !== null && costUsd > admission.maxCostUsd)
      ) {
        return payloadError(`${memberId} observed cost exceeds its admission`);
      }
      const totalInput = state.usage.input + input;
      const totalOutput = state.usage.output + output;
      if (!Number.isSafeInteger(totalInput) || !Number.isSafeInteger(totalOutput)) {
        return payloadError("observed token usage exceeds safe integer bounds");
      }
      state.usage.input = totalInput;
      state.usage.output = totalOutput;
      state.usage.costUsd = state.usage.costUsd === null || costUsd === null
        ? null
        : state.usage.costUsd + costUsd;
      if (
        state.usage.costUsd !== null &&
        (!Number.isFinite(state.usage.costUsd) || state.usage.costUsd > state.limits!.maxCostUsd)
      ) {
        return payloadError("observed cost exceeds run bounds");
      }
      member.usageObserved = true;
      return;
    }
    case "cancel.requested":
      if (
        state.phase !== "awaiting_approval" &&
        state.phase !== "approved" &&
        state.phase !== "started"
      ) {
        lifecycleError(`${event.type} is invalid during ${state.phase}`);
      }
      requireEmptyPayload(event.payload, event.type);
      state.phase = "cancelling";
      state.status = undefined;
      return;
    case "member.cancelled": {
      requirePhase(state, "cancelling", event.type);
      const memberId = parseMemberId(event.payload, event.type);
      const member = memberFor(state, memberId);
      if (member.status === "succeeded" || member.status === "failed" || member.status === "cancelled") {
        lifecycleError(`${memberId} cannot be cancelled from ${member.status}`);
      }
      member.status = "cancelled";
      return;
    }
    case "run.completed":
      requirePhase(state, "started", event.type);
      requireEmptyPayload(event.payload, event.type);
      if (state.memberOrder.some((id) => state.members[id]!.status !== "succeeded")) {
        lifecycleError("run cannot complete before every member succeeds");
      }
      state.phase = "terminal";
      state.status = "completed";
      return;
    case "run.failed": {
      if (state.phase !== "started" && state.phase !== "cancelling") {
        lifecycleError(`${event.type} is invalid during ${state.phase}`);
      }
      const record = inspectRecord(event.payload, ["reason"], event.type).values;
      requireString(record.reason, "run.failed.reason", TEAM_LIMITS.descriptionBytes);
      if (hasRunningMember(state)) lifecycleError("run cannot fail while a member is running");
      state.phase = "terminal";
      state.status = "failed";
      return;
    }
    case "run.blocked": {
      requirePhase(state, "policy_blocked", event.type);
      const record = inspectRecord(event.payload, ["reason"], event.type).values;
      const reason = requireString(
        record.reason,
        "run.blocked.reason",
        TEAM_LIMITS.descriptionBytes,
      );
      if (!state.blockedReasons.includes(reason)) {
        identityError("terminal block reason was not admitted by policy.blocked");
      }
      state.phase = "terminal";
      state.status = "blocked";
      return;
    }
    case "run.cancelled":
      requirePhase(state, "cancelling", event.type);
      requireEmptyPayload(event.payload, event.type);
      if (state.memberOrder.some((id) => {
        const status = state.members[id]!.status;
        return status === "pending" || status === "ready" || status === "running";
      })) {
        lifecycleError("run cannot be cancelled while a member remains active");
      }
      state.phase = "terminal";
      state.status = "cancelled";
      return;
    default:
      lifecycleError(`unknown lifecycle event ${(event as TeamEvent).type}`);
  }
}

function foldLifecycle(events: TeamEvent[]): FoldState {
  if (!Array.isArray(events) || nodeUtilTypes.isProxy(events) || events.length === 0) {
    return lifecycleError("event history must be a nonempty plain array");
  }
  const state: FoldState = {
    phase: "none",
    admissions: [],
    members: {},
    memberOrder: [],
    blockedReasons: [],
    usage: { input: 0, output: 0, costUsd: 0 },
    started: false,
  };
  for (let index = 0; index < events.length; index += 1) {
    applyEvent(state, events[index]!, index);
  }
  return state;
}

/** Validate payload schemas and lifecycle transitions without deriving a display status. */
export function validateTeamLifecycle(events: TeamEvent[]): void {
  foldLifecycle(events);
}

export function projectTeamRun(
  events: TeamEvent[],
  options: { live: boolean },
): TeamRunView {
  const optionRecord = inspectRecord(options, ["live"], "projection options").values;
  if (typeof optionRecord.live !== "boolean") {
    return payloadError("projection options.live must be a boolean");
  }
  const state = foldLifecycle(events);
  if (
    state.runId === undefined ||
    state.projectId === undefined ||
    state.teamRef === undefined ||
    state.objective === undefined
  ) {
    return lifecycleError("history does not begin with a complete run request");
  }
  const status = state.status ?? (optionRecord.live && state.started ? "running" : "incomplete");
  const members: Record<string, TeamMemberView> = {};
  for (const memberId of state.memberOrder) {
    const member = state.members[memberId]!;
    const view: TeamMemberView = { id: member.id, status: member.status as TeamMemberStatus };
    if (member.artifact !== undefined) view.artifact = member.artifact;
    if (member.error !== undefined) view.error = member.error;
    members[memberId] = view;
  }
  return {
    projectId: state.projectId,
    runId: state.runId,
    teamRef: state.teamRef,
    objective: state.objective,
    status,
    ...(state.manifestDigest === undefined ? {} : { manifestDigest: state.manifestDigest }),
    ...(state.planDigest === undefined ? {} : { planDigest: state.planDigest }),
    ...(state.policyDigest === undefined ? {} : { policyDigest: state.policyDigest }),
    ...(state.approvalBinding === undefined ? {} : { approvalBinding: state.approvalBinding }),
    ...(state.limits === undefined ? {} : { limits: state.limits }),
    admissions: state.admissions,
    members,
    usage: state.usage,
    lastEvent: events.at(-1)!,
  };
}
