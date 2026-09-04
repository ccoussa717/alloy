import assert from "node:assert/strict";
import { test } from "node:test";

import { compileTeam } from "../../packages/pi-teams/src/core/compiler.ts";
import {
  createSchedule,
  markFailed,
  markStarted,
  markSucceeded,
  readyMembers,
  requestCancellation,
} from "../../packages/pi-teams/src/core/scheduler.ts";

function definition({ maxConcurrency = 2, members } = {}) {
  return {
    apiVersion: "pi.dev/teams/v1alpha1",
    kind: "Team",
    metadata: {
      name: "investigate",
      description: "Investigate repository evidence.",
    },
    spec: {
      limits: {
        maxConcurrency,
        maxCostUsd: 2,
        timeoutMs: 300_000,
        maxMembers: members?.length ?? 3,
      },
      members: members ?? [
        {
          id: "architecture",
          route: "research",
          capabilities: ["repo.read"],
          tools: ["read", "grep"],
          needs: [],
          instructions: "Map the architecture.",
        },
        {
          id: "risks",
          route: "review",
          capabilities: ["repo.read"],
          tools: ["grep", "find"],
          needs: [],
          instructions: "Review the risks.",
        },
        {
          id: "lead",
          route: "planning",
          capabilities: ["repo.read"],
          tools: ["read", "ls"],
          needs: ["architecture", "risks"],
          instructions: "Synthesize the evidence.",
        },
      ],
    },
  };
}

function compile(definitionValue = definition()) {
  return compileTeam({
    ref: "builtin/investigate",
    source: "builtin",
    origin: "builtin/investigate.yaml",
    definition: definitionValue,
  });
}

function rootMember(id) {
  return {
    id,
    route: "research",
    capabilities: ["repo.read"],
    tools: ["read"],
    needs: [],
    instructions: `Investigate ${id}.`,
  };
}

// Break caught: initial roots or ready output follow object insertion rather than compiled order.
test("creates a deterministic schedule with dependency-gated initial readiness", () => {
  const compiled = compile();
  const schedule = createSchedule(compiled);

  assert.strictEqual(schedule.team, compiled);
  assert.equal(schedule.cancelling, false);
  assert.deepEqual(schedule.members, {
    architecture: { id: "architecture", status: "ready" },
    risks: { id: "risks", status: "ready" },
    lead: { id: "lead", status: "pending" },
  });
  assert.deepEqual(readyMembers(schedule), ["architecture", "risks"]);
});

// Break caught: runnable roots can exceed free slots or be started out of declaration order.
test("bounds ready and start transitions by free concurrency slots in stable order", () => {
  const compiled = compile(definition({
    maxConcurrency: 2,
    members: [rootMember("first"), rootMember("second"), rootMember("third")],
  }));
  const initial = createSchedule(compiled);

  assert.deepEqual(readyMembers(initial), ["first", "second"]);
  assert.throws(() => markStarted(initial, "third"), /scheduler_start/);

  const firstRunning = markStarted(initial, "first");
  assert.deepEqual(readyMembers(firstRunning), ["second"]);
  const twoRunning = markStarted(firstRunning, "second");
  assert.deepEqual(readyMembers(twoRunning), []);
  assert.throws(() => markStarted(twoRunning, "third"), /scheduler_start/);

  const oneFinished = markSucceeded(twoRunning, "first");
  assert.deepEqual(readyMembers(oneFinished), ["third"]);
});

// Break caught: transitions mutate an earlier schedule or clone unaffected member records.
test("transitions are immutable and clone only records whose status changes", () => {
  const initial = createSchedule(compile());
  const oneRunning = markStarted(initial, "architecture");

  assert.equal(initial.members.architecture.status, "ready");
  assert.equal(oneRunning.members.architecture.status, "running");
  assert.notStrictEqual(oneRunning, initial);
  assert.notStrictEqual(oneRunning.members, initial.members);
  assert.notStrictEqual(oneRunning.members.architecture, initial.members.architecture);
  assert.strictEqual(oneRunning.members.risks, initial.members.risks);
  assert.strictEqual(oneRunning.members.lead, initial.members.lead);

  const architectureDone = markSucceeded(oneRunning, "architecture");
  assert.equal(oneRunning.members.architecture.status, "running");
  assert.equal(architectureDone.members.architecture.status, "succeeded");
  assert.equal(architectureDone.members.lead.status, "pending");
  assert.strictEqual(architectureDone.members.risks, oneRunning.members.risks);
  assert.strictEqual(architectureDone.members.lead, oneRunning.members.lead);
});

// Break caught: a dependent is released by partial completion or by a failed predecessor.
test("releases dependencies only after every predecessor succeeds and blocks on failure", () => {
  const initial = createSchedule(compile());
  const architectureRunning = markStarted(initial, "architecture");
  const bothRunning = markStarted(architectureRunning, "risks");
  const architectureDone = markSucceeded(bothRunning, "architecture");

  assert.equal(architectureDone.members.lead.status, "pending");
  assert.deepEqual(readyMembers(architectureDone), []);

  const risksDone = markSucceeded(architectureDone, "risks");
  assert.equal(risksDone.members.lead.status, "ready");
  assert.deepEqual(readyMembers(risksDone), ["lead"]);

  const failedBranch = markFailed(bothRunning, "architecture");
  assert.equal(failedBranch.members.architecture.status, "failed");
  assert.equal(failedBranch.members.lead.status, "pending");
  assert.deepEqual(readyMembers(markSucceeded(failedBranch, "risks")), []);
  assert.throws(() => markStarted(failedBranch, "lead"), /scheduler_start/);
});

// Break caught: duplicate starts or terminal settlements silently overwrite state.
test("rejects unknown, illegal, duplicate start, and duplicate settlement transitions", () => {
  const initial = createSchedule(compile());

  assert.throws(() => markStarted(initial, "missing"), /scheduler_member/);
  assert.throws(() => markStarted(initial, "lead"), /scheduler_start/);
  assert.throws(() => markSucceeded(initial, "architecture"), /scheduler_succeed/);
  assert.throws(() => markFailed(initial, "architecture"), /scheduler_fail/);

  const running = markStarted(initial, "architecture");
  assert.throws(() => markStarted(running, "architecture"), /scheduler_start/);

  const succeeded = markSucceeded(running, "architecture");
  assert.throws(() => markSucceeded(succeeded, "architecture"), /scheduler_succeed/);
  assert.throws(() => markFailed(succeeded, "architecture"), /scheduler_fail/);

  const failed = markFailed(running, "architecture");
  assert.throws(() => markFailed(failed, "architecture"), /scheduler_fail/);
  assert.throws(() => markSucceeded(failed, "architecture"), /scheduler_succeed/);
});

// Break caught: cancellation aborts scheduler state for running work or permits later starts.
test("cancellation cancels pending and ready members while leaving running work settleable", () => {
  const initial = createSchedule(compile());
  const running = markStarted(initial, "architecture");
  const cancelling = requestCancellation(running);

  assert.equal(cancelling.cancelling, true);
  assert.deepEqual(cancelling.members, {
    architecture: { id: "architecture", status: "running" },
    risks: { id: "risks", status: "cancelled" },
    lead: { id: "lead", status: "cancelled" },
  });
  assert.equal(running.cancelling, false);
  assert.equal(running.members.risks.status, "ready");
  assert.equal(running.members.lead.status, "pending");
  assert.strictEqual(cancelling.members.architecture, running.members.architecture);
  assert.notStrictEqual(cancelling.members.risks, running.members.risks);
  assert.notStrictEqual(cancelling.members.lead, running.members.lead);
  assert.deepEqual(readyMembers(cancelling), []);
  assert.throws(() => markStarted(cancelling, "risks"), /scheduler_start/);

  const settled = markFailed(cancelling, "architecture");
  assert.equal(settled.cancelling, true);
  assert.equal(settled.members.architecture.status, "failed");
  assert.equal(cancelling.members.architecture.status, "running");
});

// Break caught: cancellation rewrites members that were already terminal.
test("cancellation preserves completed members and can settle a running member successfully", () => {
  const initial = createSchedule(compile());
  const architectureDone = markSucceeded(markStarted(initial, "architecture"), "architecture");
  const risksRunning = markStarted(architectureDone, "risks");
  const cancelling = requestCancellation(risksRunning);

  assert.equal(cancelling.members.architecture.status, "succeeded");
  assert.equal(cancelling.members.risks.status, "running");
  assert.equal(cancelling.members.lead.status, "cancelled");
  assert.strictEqual(cancelling.members.architecture, risksRunning.members.architecture);
  assert.strictEqual(cancelling.members.risks, risksRunning.members.risks);

  const settled = markSucceeded(cancelling, "risks");
  assert.equal(settled.members.risks.status, "succeeded");
  assert.equal(settled.members.lead.status, "cancelled");
  assert.deepEqual(readyMembers(settled), []);
});
