import { timingSafeEqual } from "node:crypto";

import { sha256Canonical } from "./compiler.ts";
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
  if (!input.admission.ok) return input.admission;

  const requestedCapabilities = input.member.capabilities;
  if (
    requestedCapabilities.some((capability) =>
      !PACKAGE_CAPABILITIES.includes(capability as (typeof PACKAGE_CAPABILITIES)[number]) ||
      !input.host.capabilities.includes(capability)
    ) ||
    !sameAuthority(input.admission.effectiveCapabilities, requestedCapabilities)
  ) {
    return blocked(input, "policy_capability:requested capabilities were not fully admitted");
  }

  const requestedTools = input.member.tools;
  if (
    requestedTools.some((tool) =>
      !PACKAGE_TOOLS.includes(tool as (typeof PACKAGE_TOOLS)[number]) ||
      !input.host.tools.includes(tool)
    ) ||
    !sameAuthority(input.admission.effectiveTools, requestedTools)
  ) {
    return blocked(input, "policy_tool:requested tools were not fully admitted");
  }

  if (input.admission.memberId !== input.member.id) {
    return blocked(input, "policy_member:admission member does not match request");
  }
  if (input.admission.effectiveRoute !== input.member.route) {
    return blocked(input, "policy_route:effective route does not match semantic route");
  }
  if (
    !Number.isFinite(input.maxCostUsd) ||
    input.maxCostUsd <= 0 ||
    !Number.isFinite(input.admission.maxCostUsd) ||
    input.admission.maxCostUsd !== input.maxCostUsd
  ) {
    return blocked(input, "policy_cost:effective allocation does not match request");
  }
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    !Number.isInteger(input.admission.timeoutMs) ||
    input.admission.timeoutMs <= 0 ||
    input.admission.timeoutMs > input.timeoutMs
  ) {
    return blocked(input, "policy_timeout:effective timeout must positively narrow the request");
  }

  return {
    ...input.admission,
    effectiveCapabilities: [...requestedCapabilities] as TeamCapability[],
    effectiveTools: [...requestedTools] as TeamToolName[],
  };
}

function publicAdmission(admission: Admission): PublicAdmission {
  if (!admission.ok) return { ...admission };
  const { token: _token, ...publicValue } = admission;
  return publicValue;
}

export function policyDigest(admissions: Admission[], limits: TeamLimits): string {
  return sha256Canonical({
    admissions: admissions.map(publicAdmission),
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

function equalDigest(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function verifyApprovalBinding(
  expected: ApprovalBinding,
  actual: ApprovalBinding,
): void {
  const manifestMatches = equalDigest(expected.manifestDigest, actual.manifestDigest);
  const planMatches = equalDigest(expected.planDigest, actual.planDigest);
  const policyMatches = equalDigest(expected.policyDigest, actual.policyDigest);
  if (
    expected.runId !== actual.runId ||
    expected.requestedAction !== actual.requestedAction ||
    !manifestMatches ||
    !planMatches ||
    !policyMatches
  ) {
    throw new Error("approval_binding:mismatch");
  }
}
