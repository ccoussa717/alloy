import { timingSafeEqual } from "node:crypto";

import { sha256Canonical } from "./compiler.ts";
import { assertBoundedUtf8, TEAM_LIMITS } from "./limits.ts";
import type {
  Admission,
  ApprovalBinding,
  CompiledTeam,
  PolicyDecision,
  PolicyIntersectionInput,
  PublicAdmission,
  TeamCapability,
  TeamLimits,
  TeamToolName,
} from "./types.ts";

export const PACKAGE_CAPABILITIES = ["repo.read"] as const;
export const PACKAGE_TOOLS = ["read", "grep", "find", "ls"] as const;

function blocked(input: PolicyIntersectionInput, reason: string): PolicyDecision {
  return {
    ok: false,
    memberId: input.member.id,
    effectiveRoute: null,
    effectiveModel: null,
    effectiveCapabilities: [],
    effectiveTools: [],
    maxCostUsd: input.maxCostUsd,
    reason,
  };
}

function sameAuthority<T extends string>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((item) => actual.includes(item));
}

export function intersectMemberPolicy(input: PolicyIntersectionInput): PolicyDecision {
  let admissionRecord: DataRecord;
  try {
    admissionRecord = inspectDataRecord(input.admission, "policy_admission", "admission");
  } catch {
    return blocked(input, "policy_admission:malformed host admission");
  }
  const ok = admissionRecord.descriptors.ok?.value;
  if (ok === false) {
    try {
      return normalizeBlockedHostAdmission(input, admissionRecord);
    } catch {
      return blocked(input, "policy_admission:malformed blocked host admission");
    }
  }
  if (ok !== true) return blocked(input, "policy_admission:ok must be a boolean literal");
  const admission = input.admission as Extract<Admission, { ok: true }>;

  const requestedCapabilities = input.member.capabilities;
  if (
    requestedCapabilities.some((capability) =>
      !PACKAGE_CAPABILITIES.includes(capability as (typeof PACKAGE_CAPABILITIES)[number]) ||
      !input.host.capabilities.includes(capability)
    ) ||
    !sameAuthority(admission.effectiveCapabilities, requestedCapabilities)
  ) {
    return blocked(input, "policy_capability:requested capabilities were not fully admitted");
  }

  const requestedTools = input.member.tools;
  if (
    requestedTools.some((tool) =>
      !PACKAGE_TOOLS.includes(tool as (typeof PACKAGE_TOOLS)[number]) ||
      !input.host.tools.includes(tool)
    ) ||
    !sameAuthority(admission.effectiveTools, requestedTools)
  ) {
    return blocked(input, "policy_tool:requested tools were not fully admitted");
  }

  if (admission.memberId !== input.member.id) {
    return blocked(input, "policy_member:admission member does not match request");
  }
  if (admission.effectiveRoute !== input.member.route) {
    return blocked(input, "policy_route:effective route does not match semantic route");
  }
  if (
    !Number.isFinite(input.maxCostUsd) ||
    input.maxCostUsd <= 0 ||
    !Number.isFinite(admission.maxCostUsd) ||
    admission.maxCostUsd !== input.maxCostUsd
  ) {
    return blocked(input, "policy_cost:effective allocation does not match request");
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isInteger(admission.timeoutMs) ||
    admission.timeoutMs <= 0 ||
    admission.timeoutMs > input.timeoutMs
  ) {
    return blocked(input, "policy_timeout:effective timeout must positively narrow the request");
  }

  return {
    ...admission,
    effectiveCapabilities: [...requestedCapabilities] as TeamCapability[],
    effectiveTools: [...requestedTools] as TeamToolName[],
  };
}

function shapeError(code: "policy_admission" | "approval_binding", message: string): never {
  throw new Error(`${code}:${message}`);
}

function isWellFormedString(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    Buffer.from(value, "utf8").toString("utf8") === value;
}

interface DataRecord {
  names: string[];
  descriptors: Record<string, PropertyDescriptor>;
}

function inspectDataRecord(
  value: unknown,
  code: "policy_admission" | "approval_binding",
  label: string,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return shapeError(code, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return shapeError(code, `${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return shapeError(code, `${label} must not have symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of names) {
    const descriptor = descriptors[name]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      return shapeError(code, `${label}.${name} must be an enumerable data property`);
    }
  }
  return { names, descriptors };
}

function requireExactKeys(
  record: DataRecord,
  expected: readonly string[],
  code: "policy_admission" | "approval_binding",
  label: string,
): void {
  const actual = [...record.names].sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((name, index) => name !== required[index])
  ) {
    shapeError(code, `${label} has an invalid own-key set`);
  }
}

function readDataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return shapeError("policy_admission", `${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    return shapeError("policy_admission", `${label}.length must be a data property`);
  }
  const length = lengthDescriptor.value as number;
  const expectedNames = ["length", ...Array.from({ length }, (_, index) => String(index))];
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== expectedNames.length ||
    names.some((name) => !expectedNames.includes(name))
  ) {
    return shapeError("policy_admission", `${label} must be dense without extra properties`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return shapeError("policy_admission", `${label}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function normalizeAuthorityArray<T extends string>(
  value: unknown,
  supported: readonly T[],
  label: string,
): T[] {
  const items = readDataArray(value, label);
  if (
    items.length === 0 ||
    items.some((item) => !isWellFormedString(item) || !supported.includes(item as T)) ||
    new Set(items).size !== items.length
  ) {
    return shapeError("policy_admission", `${label} contains invalid authority`);
  }
  return items as T[];
}

const ADMITTED_KEYS = [
  "ok",
  "memberId",
  "effectiveRoute",
  "effectiveModel",
  "effectiveCapabilities",
  "effectiveTools",
  "maxCostUsd",
  "timeoutMs",
  "token",
] as const;
const BLOCKED_KEYS = [
  "ok",
  "memberId",
  "effectiveRoute",
  "effectiveModel",
  "effectiveCapabilities",
  "effectiveTools",
  "maxCostUsd",
  "reason",
] as const;

function normalizeBlockedHostAdmission(
  input: PolicyIntersectionInput,
  record: DataRecord,
): PolicyDecision {
  requireExactKeys(record, BLOCKED_KEYS, "policy_admission", "admission");
  const memberId = record.descriptors.memberId!.value;
  const maxCostUsd = record.descriptors.maxCostUsd!.value;
  const reason = record.descriptors.reason!.value;
  if (memberId !== input.member.id) {
    return shapeError("policy_admission", "blocked memberId must match the requested member");
  }
  if (
    record.descriptors.effectiveRoute!.value !== null ||
    record.descriptors.effectiveModel!.value !== null ||
    readDataArray(record.descriptors.effectiveCapabilities!.value, "effectiveCapabilities").length !== 0 ||
    readDataArray(record.descriptors.effectiveTools!.value, "effectiveTools").length !== 0
  ) {
    return shapeError("policy_admission", "blocked effective authority must be empty");
  }
  if (
    typeof maxCostUsd !== "number" ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd !== input.maxCostUsd
  ) {
    return shapeError("policy_admission", "blocked maxCostUsd must match the requested allocation");
  }
  try {
    assertBoundedUtf8(reason, "admission.reason", TEAM_LIMITS.descriptionBytes);
  } catch {
    return shapeError("policy_admission", "blocked reason must be bounded, nonblank UTF-8 text");
  }
  return {
    ok: false,
    memberId,
    effectiveRoute: null,
    effectiveModel: null,
    effectiveCapabilities: [],
    effectiveTools: [],
    maxCostUsd,
    reason,
  };
}

function normalizePublicAdmission(value: unknown): PublicAdmission {
  const record = inspectDataRecord(value, "policy_admission", "admission");
  const ok = record.descriptors.ok?.value;
  if (ok === true) {
    requireExactKeys(record, ADMITTED_KEYS, "policy_admission", "admission");
    const memberId = record.descriptors.memberId!.value;
    const effectiveRoute = record.descriptors.effectiveRoute!.value;
    const effectiveModel = record.descriptors.effectiveModel!.value;
    const maxCostUsd = record.descriptors.maxCostUsd!.value;
    const timeoutMs = record.descriptors.timeoutMs!.value;
    if (!isWellFormedString(memberId) || !isWellFormedString(effectiveRoute)) {
      return shapeError("policy_admission", "admitted identity and route must be strings");
    }
    if (effectiveModel !== null && !isWellFormedString(effectiveModel)) {
      return shapeError("policy_admission", "effectiveModel must be null or a string");
    }
    if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return shapeError("policy_admission", "maxCostUsd must be positive and finite");
    }
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0) {
      return shapeError("policy_admission", "timeoutMs must be a positive integer");
    }
    return {
      ok: true,
      memberId,
      effectiveRoute,
      effectiveModel,
      effectiveCapabilities: normalizeAuthorityArray(
        record.descriptors.effectiveCapabilities!.value,
        PACKAGE_CAPABILITIES,
        "effectiveCapabilities",
      ),
      effectiveTools: normalizeAuthorityArray(
        record.descriptors.effectiveTools!.value,
        PACKAGE_TOOLS,
        "effectiveTools",
      ),
      maxCostUsd,
      timeoutMs: timeoutMs as number,
    };
  }

  if (ok === false) {
    requireExactKeys(record, BLOCKED_KEYS, "policy_admission", "admission");
    const memberId = record.descriptors.memberId!.value;
    const maxCostUsd = record.descriptors.maxCostUsd!.value;
    const reason = record.descriptors.reason!.value;
    if (!isWellFormedString(memberId) || !isWellFormedString(reason)) {
      return shapeError("policy_admission", "blocked memberId and reason must be strings");
    }
    if (
      record.descriptors.effectiveRoute!.value !== null ||
      record.descriptors.effectiveModel!.value !== null ||
      readDataArray(record.descriptors.effectiveCapabilities!.value, "effectiveCapabilities").length !== 0 ||
      readDataArray(record.descriptors.effectiveTools!.value, "effectiveTools").length !== 0
    ) {
      return shapeError("policy_admission", "blocked effective authority must be empty");
    }
    if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      return shapeError("policy_admission", "maxCostUsd must be positive and finite");
    }
    return {
      ok: false,
      memberId,
      effectiveRoute: null,
      effectiveModel: null,
      effectiveCapabilities: [],
      effectiveTools: [],
      maxCostUsd,
      reason,
    };
  }

  return shapeError("policy_admission", "ok must be a boolean literal");
}

export function policyDigest(
  admissions: Admission[],
  limits: TeamLimits,
  team: CompiledTeam,
): string {
  const admissionValues = readDataArray(admissions, "admissions");
  const expectedMembers = team?.definition?.spec?.members;
  if (!Array.isArray(expectedMembers) || admissionValues.length !== expectedMembers.length) {
    return shapeError("policy_admission", "admissions must match the compiled member count");
  }

  const compiledLimits = team.definition.spec.limits;
  if (
    !Number.isInteger(limits.maxConcurrency) ||
    limits.maxConcurrency <= 0 ||
    limits.maxConcurrency > compiledLimits.maxConcurrency ||
    typeof limits.maxCostUsd !== "number" ||
    !Number.isFinite(limits.maxCostUsd) ||
    limits.maxCostUsd <= 0 ||
    limits.maxCostUsd > compiledLimits.maxCostUsd ||
    !Number.isInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0 ||
    limits.timeoutMs > compiledLimits.timeoutMs
  ) {
    return shapeError("policy_admission", "effective limits must positively narrow compiled limits");
  }
  const memberAllocation = limits.maxCostUsd / team.definition.spec.limits.maxMembers;
  const timeoutCeiling = Math.min(limits.timeoutMs, team.definition.spec.limits.timeoutMs);
  const expectedById = new Map(expectedMembers.map((member) => [member.id, member]));
  const normalizedById = new Map<string, PublicAdmission>();
  for (const value of admissionValues) {
    const admission = normalizePublicAdmission(value);
    const expected = expectedById.get(admission.memberId);
    if (expected === undefined || normalizedById.has(admission.memberId)) {
      return shapeError("policy_admission", "admission member IDs must be unique and compiled");
    }
    if (admission.maxCostUsd !== memberAllocation) {
      return shapeError("policy_admission", "member cost must match the approved allocation");
    }
    if (
      admission.ok &&
      (
        admission.effectiveRoute !== expected.route ||
        !sameAuthority(admission.effectiveCapabilities, expected.capabilities) ||
        !sameAuthority(admission.effectiveTools, expected.tools) ||
        admission.timeoutMs > timeoutCeiling
      )
    ) {
      return shapeError("policy_admission", "effective member authority exceeds compiled limits");
    }
    normalizedById.set(admission.memberId, admission.ok ? {
      ...admission,
      effectiveCapabilities: [...expected.capabilities],
      effectiveTools: [...expected.tools],
    } : admission);
  }
  const orderedAdmissions = expectedMembers.map((member) => normalizedById.get(member.id));
  if (orderedAdmissions.some((admission) => admission === undefined)) {
    return shapeError("policy_admission", "every compiled member must have one admission");
  }

  return sha256Canonical({
    admissions: orderedAdmissions,
    limits,
  });
}

export function approvalBinding(
  runId: string,
  team: CompiledTeam,
  digest: string,
): ApprovalBinding {
  return Object.freeze({
    runId,
    manifestDigest: team.manifestDigest,
    planDigest: team.planDigest,
    policyDigest: digest,
    requestedAction: "execute" as const,
  });
}

const BINDING_KEYS = [
  "runId",
  "manifestDigest",
  "planDigest",
  "policyDigest",
  "requestedAction",
] as const;
const CANONICAL_DIGEST = /^[0-9a-f]{64}$/;

function validateBinding(value: unknown, label: string): ApprovalBinding {
  const record = inspectDataRecord(value, "approval_binding", label);
  requireExactKeys(record, BINDING_KEYS, "approval_binding", label);
  const runId = record.descriptors.runId!.value;
  const manifestDigest = record.descriptors.manifestDigest!.value;
  const planDigest = record.descriptors.planDigest!.value;
  const policyDigestValue = record.descriptors.policyDigest!.value;
  const requestedAction = record.descriptors.requestedAction!.value;
  if (!isWellFormedString(runId)) {
    return shapeError("approval_binding", `${label}.runId must be a nonempty string`);
  }
  if (
    typeof manifestDigest !== "string" || !CANONICAL_DIGEST.test(manifestDigest) ||
    typeof planDigest !== "string" || !CANONICAL_DIGEST.test(planDigest) ||
    typeof policyDigestValue !== "string" || !CANONICAL_DIGEST.test(policyDigestValue)
  ) {
    return shapeError("approval_binding", `${label} digests must be canonical lowercase SHA-256`);
  }
  if (requestedAction !== "execute") {
    return shapeError("approval_binding", `${label}.requestedAction must be execute`);
  }
  return {
    runId,
    manifestDigest,
    planDigest,
    policyDigest: policyDigestValue,
    requestedAction,
  };
}

function equalDigest(expected: string, actual: string): boolean {
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

export function verifyApprovalBinding(
  expected: ApprovalBinding,
  actual: ApprovalBinding,
): void {
  const validatedExpected = validateBinding(expected, "expected");
  const validatedActual = validateBinding(actual, "actual");
  const manifestMatches = equalDigest(
    validatedExpected.manifestDigest,
    validatedActual.manifestDigest,
  );
  const planMatches = equalDigest(validatedExpected.planDigest, validatedActual.planDigest);
  const policyMatches = equalDigest(validatedExpected.policyDigest, validatedActual.policyDigest);
  if (
    validatedExpected.runId !== validatedActual.runId ||
    validatedExpected.requestedAction !== validatedActual.requestedAction ||
    !manifestMatches ||
    !planMatches ||
    !policyMatches
  ) {
    throw new Error("approval_binding:mismatch");
  }
}
