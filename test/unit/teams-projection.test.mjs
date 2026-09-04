import assert from "node:assert/strict";
import { test } from "node:test";

import { hashEvent } from "../../packages/pi-teams/src/core/events.ts";
import {
  projectTeamRun,
  validateTeamLifecycle,
} from "../../packages/pi-teams/src/core/projection.ts";
import { ZERO_HASH } from "../../packages/pi-teams/src/core/limits.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_ID = "a".repeat(64);
const DIGESTS = {
  manifestDigest: "b".repeat(64),
  planDigest: "c".repeat(64),
  policyDigest: "d".repeat(64),
};
const LIMITS = {
  maxConcurrency: 2,
  maxCostUsd: 2,
  timeoutMs: 60_000,
  maxMembers: 2,
};
const MEMBERS = [
  { id: "researcher", needs: [] },
  { id: "lead", needs: ["researcher"] },
];
const BINDING = {
  runId: RUN_ID,
  ...DIGESTS,
  requestedAction: "execute",
};
const ADMISSIONS = MEMBERS.map(({ id }) => ({
  ok: true,
  memberId: id,
  effectiveRoute: "research",
  effectiveModel: "model",
  effectiveCapabilities: ["repo.read"],
  effectiveTools: ["read"],
  maxCostUsd: 1,
  timeoutMs: 60_000,
}));
const ARTIFACT = {
  memberId: "researcher",
  outputPath: "artifacts/researcher/output.md",
  resultPath: "artifacts/researcher/result.json",
  outputBytes: 8,
  outputSha256: "e".repeat(64),
  resultBytes: 64,
  resultSha256: "f".repeat(64),
};

function event(previous, type, payload = {}) {
  const eventWithoutHash = {
    v: 1,
    runId: RUN_ID,
    seq: previous === undefined ? 1 : previous.seq + 1,
    type,
    actor: type === "approval.granted"
      ? { kind: "human", id: "operator" }
      : { kind: "system", id: "teams" },
    occurredAt: `2026-09-04T12:00:${String(previous?.seq ?? 0).padStart(2, "0")}Z`,
    payload,
    prevHash: previous === undefined ? ZERO_HASH : previous.hash,
  };
  return { ...eventWithoutHash, hash: hashEvent(eventWithoutHash) };
}

function append(events, type, payload = {}) {
  return [...events, event(events.at(-1), type, payload)];
}

function requested() {
  return [event(undefined, "run.requested", {
    projectId: PROJECT_ID,
    teamRef: "builtin/investigate",
    objective: "Investigate auth.",
  })];
}

function snapshotted() {
  return append(requested(), "manifest.snapshotted", {
    teamRef: "builtin/investigate",
    manifestDigest: DIGESTS.manifestDigest,
    planDigest: DIGESTS.planDigest,
    limits: LIMITS,
    members: MEMBERS,
  });
}

function admitted() {
  return append(snapshotted(), "policy.admitted", {
    policyDigest: DIGESTS.policyDigest,
    admissions: ADMISSIONS,
  });
}

function awaiting() {
  return append(admitted(), "run.awaiting_approval", { binding: BINDING });
}

function started() {
  let events = append(awaiting(), "approval.granted", { binding: BINDING });
  events = append(events, "run.started");
  return events;
}

function withResearcherSucceeded() {
  let events = append(started(), "member.ready", { memberId: "researcher" });
  events = append(events, "member.started", { memberId: "researcher" });
  events = append(events, "member.artifact_recorded", ARTIFACT);
  events = append(events, "member.succeeded", { memberId: "researcher" });
  events = append(events, "budget.observed", {
    memberId: "researcher",
    input: 10,
    output: 5,
    costUsd: 0.25,
  });
  return events;
}

function completed() {
  let events = append(withResearcherSucceeded(), "member.ready", { memberId: "lead" });
  events = append(events, "member.started", { memberId: "lead" });
  events = append(events, "member.artifact_recorded", {
    ...ARTIFACT,
    memberId: "lead",
    outputPath: "artifacts/lead/output.md",
    resultPath: "artifacts/lead/result.json",
  });
  events = append(events, "member.succeeded", { memberId: "lead" });
  events = append(events, "run.completed");
  return events;
}

// Break caught: durable nonterminal authority is presented as a live running process.
test("projects nonterminal durable histories as incomplete without explicit live attachment", () => {
  const approved = append(awaiting(), "approval.granted", { binding: BINDING });
  const memberStarted = append(
    append(started(), "member.ready", { memberId: "researcher" }),
    "member.started",
    { memberId: "researcher" },
  );

  for (const history of [requested(), snapshotted(), admitted(), approved, started(), memberStarted]) {
    assert.equal(projectTeamRun(history, { live: false }).status, "incomplete");
  }
  const requestedView = projectTeamRun(requested(), { live: false });
  assert.equal(requestedView.projectId, PROJECT_ID);
  assert.deepEqual(requestedView.members, {});
  assert.equal("manifestDigest" in requestedView, false);
  assert.equal("planDigest" in requestedView, false);
  assert.equal("limits" in requestedView, false);

  assert.equal(projectTeamRun(awaiting(), { live: false }).status, "awaiting_approval");
  assert.equal(projectTeamRun(memberStarted, { live: true }).status, "running");
  assert.equal(projectTeamRun(approved, { live: true }).status, "incomplete");
});

// Break caught: ephemeral liveness changes durable terminal or approval authority.
test("live attachment is only a running hint after run.started", () => {
  assert.equal(projectTeamRun(started(), { live: false }).status, "incomplete");
  assert.equal(projectTeamRun(started(), { live: true }).status, "running");
  assert.equal(projectTeamRun(awaiting(), { live: true }).status, "awaiting_approval");
  assert.equal(projectTeamRun(completed(), { live: true }).status, "completed");
});

// Break caught: projection drops immutable identity, policy, member, artifact, or usage evidence.
test("projects complete durable identity, policy, members, artifacts, and observed usage", () => {
  const view = projectTeamRun(completed(), { live: false });

  assert.equal(view.projectId, PROJECT_ID);
  assert.equal(view.runId, RUN_ID);
  assert.equal(view.teamRef, "builtin/investigate");
  assert.equal(view.objective, "Investigate auth.");
  assert.equal(view.status, "completed");
  assert.deepEqual(view.limits, LIMITS);
  assert.equal(view.manifestDigest, DIGESTS.manifestDigest);
  assert.equal(view.planDigest, DIGESTS.planDigest);
  assert.equal(view.policyDigest, DIGESTS.policyDigest);
  assert.deepEqual(view.approvalBinding, BINDING);
  assert.deepEqual(view.admissions, ADMISSIONS);
  assert.deepEqual(view.members, {
    researcher: { id: "researcher", status: "succeeded", artifact: ARTIFACT },
    lead: {
      id: "lead",
      status: "succeeded",
      artifact: {
        ...ARTIFACT,
        memberId: "lead",
        outputPath: "artifacts/lead/output.md",
        resultPath: "artifacts/lead/result.json",
      },
    },
  });
  assert.deepEqual(view.usage, { input: 10, output: 5, costUsd: 0.25 });
  assert.equal(view.lastEvent.type, "run.completed");
});

// Break caught: durable terminal and approval states are collapsed into running/incomplete.
test("projects blocked, awaiting approval, failed, and cancelled terminal states", () => {
  let blocked = append(snapshotted(), "policy.blocked", { reasons: ["model unavailable"] });
  blocked = append(blocked, "run.blocked", { reason: "model unavailable" });
  assert.equal(projectTeamRun(blocked, { live: false }).status, "blocked");
  assert.equal(projectTeamRun(awaiting(), { live: false }).status, "awaiting_approval");

  let failed = append(started(), "member.ready", { memberId: "researcher" });
  failed = append(failed, "member.started", { memberId: "researcher" });
  failed = append(failed, "member.failed", { memberId: "researcher", error: "provider failed" });
  failed = append(failed, "run.failed", { reason: "member failed" });
  const failedView = projectTeamRun(failed, { live: true });
  assert.equal(failedView.status, "failed");
  assert.equal(failedView.members.researcher.error, "provider failed");

  let cancelled = append(started(), "cancel.requested");
  cancelled = append(cancelled, "member.cancelled", { memberId: "researcher" });
  cancelled = append(cancelled, "member.cancelled", { memberId: "lead" });
  cancelled = append(cancelled, "run.cancelled");
  assert.equal(projectTeamRun(cancelled, { live: true }).status, "cancelled");
});

// Break caught: member success can occur without ready/start/artifact state transitions.
test("rejects impossible member transitions and dependency readiness", () => {
  const cases = [
    append(started(), "member.succeeded", { memberId: "researcher" }),
    append(started(), "member.started", { memberId: "researcher" }),
    append(started(), "member.ready", { memberId: "lead" }),
    append(
      append(started(), "member.ready", { memberId: "researcher" }),
      "member.artifact_recorded",
      ARTIFACT,
    ),
  ];

  for (const history of cases) {
    assert.throws(() => projectTeamRun(history, { live: false }), /event_transition:/);
  }
});

// Break caught: nonhuman approval events grant spending authority.
test("requires a human actor for approval authority", () => {
  const history = append(awaiting(), "approval.granted", { binding: BINDING });
  history.at(-1).actor = { kind: "model", id: "agent" };
  assert.throws(() => projectTeamRun(history, { live: false }), /event_transition:/);
});

// Break caught: approval/start and terminal events bypass their required predecessors.
test("rejects impossible run transitions and contradictory terminal member state", () => {
  const approvalBeforeAwaiting = append(admitted(), "approval.granted", { binding: BINDING });
  const startBeforeApproval = append(awaiting(), "run.started");
  const successBeforeStart = append(snapshotted(), "member.succeeded", {
    memberId: "researcher",
  });
  const running = append(
    append(started(), "member.ready", { memberId: "researcher" }),
    "member.started",
    { memberId: "researcher" },
  );
  const completedWhileRunning = append(running, "run.completed");

  for (const history of [
    approvalBeforeAwaiting,
    startBeforeApproval,
    successBeforeStart,
    completedWhileRunning,
  ]) {
    assert.throws(() => projectTeamRun(history, { live: false }), /event_transition:/);
  }
});

// Break caught: duplicate lifecycle records and late/duplicate terminals overwrite authority.
test("rejects duplicate lifecycle transitions and events after a terminal", () => {
  const duplicateReady = append(
    append(started(), "member.ready", { memberId: "researcher" }),
    "member.ready",
    { memberId: "researcher" },
  );
  const duplicateBudget = append(withResearcherSucceeded(), "budget.observed", {
    memberId: "researcher",
    input: 1,
    output: 1,
    costUsd: 0,
  });
  const lateTerminal = append(completed(), "run.failed", { reason: "late" });
  const afterTerminal = append(completed(), "budget.observed", {
    memberId: "lead",
    input: 1,
    output: 1,
    costUsd: 0,
  });

  for (const history of [duplicateReady, duplicateBudget, lateTerminal, afterTerminal]) {
    assert.throws(() => projectTeamRun(history, { live: false }), /event_transition:/);
  }
});

// Break caught: payload identities can name a different run, team, member, or approval.
test("rejects lifecycle payload identity mismatches", () => {
  const wrongTeam = append(requested(), "manifest.snapshotted", {
    teamRef: "builtin/other",
    manifestDigest: DIGESTS.manifestDigest,
    planDigest: DIGESTS.planDigest,
    limits: LIMITS,
    members: MEMBERS,
  });
  const wrongBinding = append(awaiting(), "approval.granted", {
    binding: { ...BINDING, runId: "123e4567-e89b-42d3-a456-426614174001" },
  });
  const wrongArtifact = append(
    append(started(), "member.ready", { memberId: "researcher" }),
    "member.artifact_recorded",
    { ...ARTIFACT, memberId: "lead" },
  );
  const unknownMember = append(started(), "member.ready", { memberId: "unknown" });

  for (const history of [wrongTeam, wrongBinding, wrongArtifact, unknownMember]) {
    assert.throws(() => projectTeamRun(history, { live: false }), /event_(identity|transition):/);
  }
});

// Break caught: extra, missing, accessor, proxy, or malformed payload data gains authority.
test("rejects every unknown or malformed lifecycle payload exactly", () => {
  const extraRequested = requested();
  extraRequested[0] = { ...extraRequested[0], payload: { ...extraRequested[0].payload, extra: true } };
  const malformedCases = [
    extraRequested,
    append(requested(), "manifest.snapshotted", {
      teamRef: "builtin/investigate",
      manifestDigest: DIGESTS.manifestDigest,
      planDigest: DIGESTS.planDigest,
      limits: { ...LIMITS, maxMembers: 3 },
      members: MEMBERS,
    }),
    append(requested(), "manifest.snapshotted", {
      teamRef: "builtin/investigate",
      manifestDigest: DIGESTS.manifestDigest,
      planDigest: DIGESTS.planDigest,
      limits: { ...LIMITS, maxCostUsd: 1.5 },
      members: MEMBERS,
    }),
    append(started(), "member.ready", {}),
    append(started(), "member.ready", { memberId: "researcher", extra: true }),
    append(started(), "budget.observed", {
      memberId: "researcher", input: -1, output: 0, costUsd: 0,
    }),
    append(withResearcherSucceeded().slice(0, -1), "budget.observed", {
      memberId: "researcher", input: 1, output: 1, costUsd: 1.5,
    }),
    append(snapshotted(), "policy.blocked", { reasons: [" "] }),
    append(started(), "run.failed", { reason: "x".repeat(1_025) }),
  ];
  for (const history of malformedCases) {
    assert.throws(() => projectTeamRun(history, { live: false }), /event_payload:/);
  }

  const payloadProxy = new Proxy({ memberId: "researcher" }, {});
  const proxyHistory = append(started(), "member.ready", { memberId: "researcher" });
  proxyHistory.at(-1).payload = payloadProxy;
  assert.throws(
    () => projectTeamRun(proxyHistory, { live: false }),
    /event_payload:/,
  );

  const accessorPayload = {};
  Object.defineProperty(accessorPayload, "memberId", {
    enumerable: true,
    get() { return "researcher"; },
  });
  const accessorHistory = append(started(), "member.ready", { memberId: "researcher" });
  accessorHistory.at(-1).payload = accessorPayload;
  assert.throws(
    () => projectTeamRun(accessorHistory, { live: false }),
    /event_payload:/,
  );
});

// Break caught: history validation rewrites nonterminal status instead of only validating lifecycle.
test("lifecycle validation accepts a nonterminal history without projecting false running", () => {
  assert.doesNotThrow(() => validateTeamLifecycle(started()));
  assert.equal(projectTeamRun(started(), { live: false }).status, "incomplete");
});
