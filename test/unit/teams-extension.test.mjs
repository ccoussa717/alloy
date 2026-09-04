import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import { parseTeamManifest } from "../../packages/pi-teams/src/core/manifest.ts";
import {
  parseTeamCommand,
  registerTeamCommand,
} from "../../packages/pi-teams/src/extension/commands.ts";
import {
  formatMemberView,
  formatTeamInspect,
  formatTeamList,
  formatTeamRun,
} from "../../packages/pi-teams/src/extension/presentation.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_RUN_ID = "123e4567-e89b-42d3-a456-426614174001";
const PROJECT_ID = "a".repeat(64);
const BINDING = Object.freeze({
  runId: RUN_ID,
  manifestDigest: "b".repeat(64),
  planDigest: "c".repeat(64),
  policyDigest: "d".repeat(64),
  requestedAction: "execute",
});

function runView(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    teamRef: "builtin/investigate",
    objective: "map auth",
    status: "awaiting_approval",
    manifestDigest: BINDING.manifestDigest,
    planDigest: BINDING.planDigest,
    policyDigest: BINDING.policyDigest,
    approvalBinding: BINDING,
    limits: {
      maxConcurrency: 2,
      maxCostUsd: 2,
      timeoutMs: 300_000,
      maxMembers: 3,
    },
    admissions: [
      {
        ok: true,
        memberId: "architecture",
        effectiveRoute: "research",
        effectiveModel: "provider/research-model",
        effectiveCapabilities: ["repo.read"],
        effectiveTools: ["read", "grep", "find", "ls"],
        maxCostUsd: 2 / 3,
        timeoutMs: 120_000,
        token: "must-not-render",
      },
      {
        ok: true,
        memberId: "risks",
        effectiveRoute: "review",
        effectiveModel: null,
        effectiveCapabilities: ["repo.read"],
        effectiveTools: ["read", "grep", "find", "ls"],
        maxCostUsd: 2 / 3,
        timeoutMs: 90_000,
      },
      {
        ok: true,
        memberId: "lead",
        effectiveRoute: "planning",
        effectiveModel: "provider/planning-model",
        effectiveCapabilities: ["repo.read"],
        effectiveTools: ["read", "grep", "find", "ls"],
        maxCostUsd: 2 / 3,
        timeoutMs: 60_000,
      },
    ],
    members: {
      architecture: { id: "architecture", status: "pending" },
      risks: { id: "risks", status: "pending" },
      lead: { id: "lead", status: "pending" },
    },
    usage: { input: 0, output: 0, costUsd: 0 },
    lastEvent: {
      v: 1,
      runId: RUN_ID,
      seq: 6,
      type: "run.awaiting_approval",
      actor: { kind: "system", id: "team-service" },
      occurredAt: "2026-09-04T12:00:00.000Z",
      payload: { secretRawPayload: "must-not-render" },
      prevHash: "e".repeat(64),
      hash: "f".repeat(64),
    },
    ...overrides,
  };
}

function compiledTeam() {
  return {
    ref: "builtin/investigate",
    source: "builtin",
    definition: {
      apiVersion: "pi.dev/teams/v1alpha1",
      kind: "Team",
      metadata: {
        name: "investigate",
        description: "Parallel repository investigation with lead synthesis",
      },
      spec: {
        limits: {
          maxConcurrency: 2,
          maxCostUsd: 2,
          timeoutMs: 300_000,
          maxMembers: 3,
        },
        members: [
          {
            id: "architecture",
            route: "research",
            capabilities: ["repo.read"],
            tools: ["read", "grep", "find", "ls"],
            needs: [],
            instructions: "Map the relevant architecture and cite repository evidence.",
          },
          {
            id: "risks",
            route: "review",
            capabilities: ["repo.read"],
            tools: ["read", "grep", "find", "ls"],
            needs: [],
            instructions: "Identify compatibility, security, and failure-mode risks.",
          },
          {
            id: "lead",
            route: "planning",
            capabilities: ["repo.read"],
            tools: ["read", "grep", "find", "ls"],
            needs: ["architecture", "risks"],
            instructions: "Synthesize the verified member evidence into one answer.",
          },
        ],
      },
    },
    topologicalOrder: ["architecture", "risks", "lead"],
    manifestDigest: BINDING.manifestDigest,
    planDigest: BINDING.planDigest,
  };
}

test("builtin investigate manifest is the only built-in and has the exact read-only DAG", async () => {
  const directory = new URL("../../packages/pi-teams/src/builtins/", import.meta.url);
  assert.deepEqual(await readdir(directory), ["investigate.yaml"]);
  const source = await readFile(new URL("investigate.yaml", directory), "utf8");
  const manifest = parseTeamManifest(source, "builtin/investigate.yaml");

  assert.deepEqual(structuredClone(manifest), compiledTeam().definition);
  assert.deepEqual(
    manifest.spec.members.map(({ id, needs }) => [id, needs]),
    [["architecture", []], ["risks", []], ["lead", ["architecture", "risks"]]],
  );
  for (const member of manifest.spec.members) {
    assert.deepEqual(member.capabilities, ["repo.read"]);
    assert.deepEqual(member.tools, ["read", "grep", "find", "ls"]);
  }
});

test("command parser accepts the exact human team grammar", () => {
  assert.deepEqual(parseTeamCommand("list"), { action: "list" });
  assert.deepEqual(parseTeamCommand("inspect builtin/investigate"), {
    action: "inspect", teamRef: "builtin/investigate",
  });
  assert.deepEqual(parseTeamCommand("run builtin/investigate map auth"), {
    action: "run", teamRef: "builtin/investigate", objective: "map auth",
  });
  assert.deepEqual(parseTeamCommand("  run\tbuiltin/investigate\t map  auth \n carefully  "), {
    action: "run", teamRef: "builtin/investigate", objective: "map  auth \n carefully",
  });
  assert.deepEqual(parseTeamCommand("status"), { action: "status" });
  assert.deepEqual(parseTeamCommand(`status ${RUN_ID}`), { action: "status", runId: RUN_ID });
  assert.deepEqual(parseTeamCommand(`view ${RUN_ID}`), { action: "view", runId: RUN_ID });
  assert.deepEqual(parseTeamCommand(`view ${RUN_ID} architecture`), {
    action: "view", runId: RUN_ID, memberId: "architecture",
  });
  assert.deepEqual(parseTeamCommand(`approve ${RUN_ID}`), { action: "approve", runId: RUN_ID });
  assert.deepEqual(parseTeamCommand(`cancel ${RUN_ID}`), { action: "cancel", runId: RUN_ID });
});

test("command parser rejects missing, excess, unknown, empty, and invalid arguments", () => {
  for (const input of [
    "", "list extra", "inspect", "inspect builtin/investigate extra", "run",
    "run builtin/investigate", "run builtin/investigate   ", "status one two",
    "view", `view ${RUN_ID} architecture extra`, "approve", `approve ${RUN_ID} extra`,
    "cancel", `cancel ${RUN_ID} extra`, "request builtin/investigate map auth", "unknown",
    "status NOT-A-UUID", "view not-a-uuid", "approve not-a-uuid", "cancel not-a-uuid",
    `view ${RUN_ID} INVALID_MEMBER`, `view ${RUN_ID} architecture/other`,
  ]) {
    assert.throws(() => parseTeamCommand(input), /team_usage/, input);
  }
});

test("presentation formatters return plain truthful strings without opaque or raw payload data", () => {
  const list = formatTeamList([{
    ref: "builtin/investigate",
    description: "Parallel repository investigation with lead synthesis",
    members: 3,
    limits: { maxConcurrency: 2, maxCostUsd: 2, timeoutMs: 300_000, maxMembers: 3 },
  }]);
  const inspect = formatTeamInspect(compiledTeam());
  const run = formatTeamRun(runView());
  const member = formatMemberView({
    run: runView({ status: "completed" }),
    member: { id: "architecture", status: "succeeded" },
    text: "Evidence found.",
    result: {
      ok: true,
      text: "Evidence found.",
      model: "provider/research-model",
      usage: { input: 10, output: 5, costUsd: 0.01 },
    },
  });

  for (const output of [list, inspect, run, member]) assert.equal(typeof output, "string");
  assert.match(list, /Team: "builtin\/investigate"/);
  assert.match(inspect, /Topological order: \["architecture","risks","lead"\]/);
  for (const expected of [
    'Team: "builtin/investigate"', 'Status: "awaiting_approval"',
    "Effective max concurrency: 2", "Maximum cost USD: 2",
    'Member: "architecture"', 'Effective route: "research"',
    'Effective model: "provider/research-model"', 'Capabilities: ["repo.read"]',
    'Tools: ["read","grep","find","ls"]', "Timeout ms: 120000",
    'Member: "risks"', "Timeout ms: 90000", 'Effective model: null',
    'Member: "lead"', "Timeout ms: 60000",
    `Approval run ID: "${RUN_ID}"`, `Policy digest: "${BINDING.policyDigest}"`,
  ]) assert.match(run, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(run, /must-not-render|secretRawPayload|lastEvent|token/i);
  assert.match(member, /Text: "Evidence found\."/);

  const requestedOnly = runView({
    status: "incomplete",
    manifestDigest: undefined,
    planDigest: undefined,
    policyDigest: undefined,
    approvalBinding: undefined,
    limits: undefined,
    admissions: [],
    members: {},
  });
  const incomplete = formatTeamRun(requestedOnly);
  assert.match(incomplete, /Status: "incomplete"/);
  assert.doesNotMatch(incomplete, /undefined|Manifest digest|Plan digest|Policy digest|Effective max concurrency|Maximum cost USD|Approval run ID/);
});

test("presentation escapes model text control and bidi characters as one JSON-safe scalar", () => {
  const hostileText = "before\u001b]8;;https://attacker.invalid\u0007link\u001b]8;;\u0007\rrewritten\nnext\u009b31mred\u202egnp.exe\u2066isolated\u2069";
  const output = formatMemberView({
    run: runView({ status: "completed" }),
    member: { id: "architecture", status: "succeeded" },
    text: hostileText,
    result: {
      ok: true,
      text: hostileText,
      model: "provider/research-model",
      usage: { input: 1, output: 1, costUsd: 0 },
    },
  });

  assert.match(output, /Text: "before/);
  assert.ok(output.includes("\\u001b]8;;https://attacker.invalid\\u0007"));
  assert.ok(output.includes("\\rrewritten\\nnext\\u009b31mred\\u202egnp.exe\\u2066isolated\\u2069"));
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
});

test("presentation emits only strict stable error codes and withholds raw error details", () => {
  const secrets = [
    "sk-live-SUPERSECRET",
    "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "-----BEGIN PRIVATE " + "KEY-----",
    "https://credentials.invalid/token?api_key=SECRET",
    "provider diagnostic must stay private",
  ];
  const errorRun = runView({
    status: "failed",
    admissions: [{
      ok: false,
      memberId: "architecture",
      effectiveRoute: null,
      effectiveModel: null,
      effectiveCapabilities: [],
      effectiveTools: [],
      maxCostUsd: 2 / 3,
      reason: `stock_auth: ${secrets[0]} ${secrets[1]}\u001b]0;owned\u0007`,
    }],
    members: {
      architecture: {
        id: "architecture",
        status: "failed",
        error: `member_failed: ${secrets[2]}\r${secrets[3]}`,
      },
      risks: {
        id: "risks",
        status: "failed",
        error: `Uppercase_invalid: ${secrets[4]}`,
      },
    },
  });
  const runOutput = formatTeamRun(errorRun);
  const memberOutput = formatMemberView({
    run: errorRun,
    member: errorRun.members.architecture,
    text: "safe evidence",
    result: {
      ok: false,
      text: "safe evidence",
      model: null,
      usage: { input: 1, output: 0, costUsd: 0 },
      error: `provider_error: ${secrets.join(" ")}\u202e`,
    },
  });
  const malformedMember = { id: "lead", status: "failed", error: `${"a".repeat(65)}: too long` };
  const malformedOutput = formatMemberView({
    run: runView({ status: "failed", members: { lead: malformedMember } }),
    member: malformedMember,
    text: "safe evidence",
    result: {
      ok: false,
      text: "safe evidence",
      model: null,
      usage: { input: 0, output: 0, costUsd: null },
      error: `missing prefix ${secrets[0]}`,
    },
  });

  assert.match(runOutput, /Reason code: "stock_auth"/);
  assert.match(runOutput, /Member error code: "member_failed"/);
  assert.match(runOutput, /Member error code: "details_withheld"/);
  assert.match(memberOutput, /Result error code: "provider_error"/);
  assert.match(malformedOutput, /Member error code: "details_withheld"/);
  assert.match(malformedOutput, /Result error code: "details_withheld"/);
  for (const output of [runOutput, memberOutput, malformedOutput]) {
    for (const secret of secrets) assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  }
});

function commandHarness({ confirm = true, hasUI = true } = {}) {
  const calls = [];
  const outputs = [];
  const requested = runView();
  const executed = runView({ status: "completed", approvalBinding: undefined });
  const service = {
    async list(context) {
      calls.push(["list", context]);
      return [{
        ref: "builtin/investigate", description: "Investigate", members: 3,
        limits: { maxConcurrency: 2, maxCostUsd: 2, timeoutMs: 300_000, maxMembers: 3 },
      }];
    },
    async inspect(teamRef, context) {
      calls.push(["inspect", teamRef, context]);
      return compiledTeam();
    },
    async request(input) {
      calls.push(["request", input]);
      return requested;
    },
    async approve(input) {
      calls.push(["approve", input]);
      return runView({ status: "awaiting_approval" });
    },
    async execute(runId, context) {
      calls.push(["execute", runId, context]);
      return executed;
    },
    async status(runId, context) {
      calls.push(["status", runId, context]);
      return requested;
    },
    async view(runId, memberId, context) {
      calls.push(["view", runId, memberId, context]);
      return memberId === undefined ? requested : {
        run: requested,
        member: { id: memberId, status: "succeeded" },
        text: "member evidence",
        result: { ok: true, text: "member evidence", model: null, usage: { input: 1, output: 2, costUsd: 0 } },
      };
    },
    async cancel(runId, actor, context) {
      calls.push(["cancel", runId, actor, context]);
      return runView({ status: "cancelled", approvalBinding: undefined });
    },
  };
  const commandContext = { marker: "command-context" };
  const contexts = [];
  const contextFactory = (ctx, source) => {
    contexts.push([ctx, source]);
    return commandContext;
  };
  let registration;
  const pi = {
    registerCommand(name, options) {
      assert.equal(registration, undefined, "registered once");
      registration = { name, ...options };
    },
  };
  const ctx = {
    hasUI,
    ui: {
      notify(text, level) {
        calls.push(["notify", text, level]);
        outputs.push(text);
      },
      async confirm(title, text) {
        calls.push(["confirm", title, text]);
        outputs.push(text);
        return confirm;
      },
    },
  };
  registerTeamCommand(pi, service, contextFactory);
  assert.equal(registration.name, "team");
  return { calls, outputs, requested, executed, registration, ctx, contexts, commandContext };
}

test("command dispatches list inspect status and view through one injected service", async () => {
  const harness = commandHarness();
  for (const input of [
    "list", "inspect builtin/investigate", "status", `status ${RUN_ID}`,
    `view ${RUN_ID}`, `view ${RUN_ID} architecture`,
  ]) await harness.registration.handler(input, harness.ctx);

  assert.deepEqual(
    harness.calls.filter(([name]) => !["notify"].includes(name)).map((call) => call.slice(0, -1)),
    [
      ["list"], ["inspect", "builtin/investigate"], ["status", undefined],
      ["status", RUN_ID], ["view", RUN_ID, undefined], ["view", RUN_ID, "architecture"],
    ],
  );
  assert.equal(harness.contexts.length, 6);
  assert.ok(harness.contexts.every(([, source]) => source === "command"));
  assert.ok(harness.calls.filter(([name]) => !["notify"].includes(name)).every((call) => call.at(-1) === harness.commandContext));
});

test("run displays bound effective policy before confirmed human approval and execution", async () => {
  const harness = commandHarness({ confirm: true });
  await harness.registration.handler("run builtin/investigate map auth", harness.ctx);
  const operational = harness.calls.filter(([name]) => name !== "notify");
  assert.deepEqual(operational.map(([name]) => name), ["request", "confirm", "approve", "execute"]);
  assert.deepEqual(operational[0][1], {
    teamRef: "builtin/investigate",
    objective: "map auth",
    actor: { kind: "human", id: "pi-user" },
    context: harness.commandContext,
  });
  const preview = operational[1][2];
  for (const expected of [
    'Team: "builtin/investigate"', "Effective max concurrency: 2", "Maximum cost USD: 2",
    'Effective route: "research"', 'Effective model: "provider/research-model"',
    'Capabilities: ["repo.read"]', 'Tools: ["read","grep","find","ls"]',
    "Timeout ms: 120000", "Timeout ms: 90000", "Timeout ms: 60000",
    `Approval run ID: "${RUN_ID}"`, `Policy digest: "${BINDING.policyDigest}"`,
  ]) assert.ok(preview.includes(expected), expected);
  assert.deepEqual(operational[2][1], {
    runId: RUN_ID,
    actor: { kind: "human", id: "pi-user" },
    binding: BINDING,
    context: harness.commandContext,
  });
  assert.deepEqual(operational[3], ["execute", RUN_ID, harness.commandContext]);
});

test("run stops awaiting approval after false confirmation or without dialog-capable UI", async () => {
  for (const options of [{ confirm: false, hasUI: true }, { confirm: true, hasUI: false }]) {
    const harness = commandHarness(options);
    await harness.registration.handler("run builtin/investigate map auth", harness.ctx);
    const names = harness.calls.map(([name]) => name);
    assert.equal(names.filter((name) => name === "request").length, 1);
    assert.ok(!names.includes("approve"));
    assert.ok(!names.includes("execute"));
    assert.ok(harness.outputs.some((text) => text.includes("approval_required")));
    if (!options.hasUI) assert.ok(!names.includes("confirm"));
  }
});

test("approve loads and confirms the stored binding before approve and execute", async () => {
  const harness = commandHarness({ confirm: true });
  await harness.registration.handler(`approve ${RUN_ID}`, harness.ctx);
  const operational = harness.calls.filter(([name]) => name !== "notify");
  assert.deepEqual(operational.map(([name]) => name), ["status", "confirm", "approve", "execute"]);
  assert.strictEqual(operational[2][1].binding, BINDING);
  assert.ok(operational[1][2].includes(`Approval run ID: "${RUN_ID}"`));
  assert.deepEqual(operational[3], ["execute", RUN_ID, harness.commandContext]);
});

test("approve without confirmation cannot approve or execute", async () => {
  for (const options of [{ confirm: false, hasUI: true }, { confirm: true, hasUI: false }]) {
    const harness = commandHarness(options);
    await harness.registration.handler(`approve ${RUN_ID}`, harness.ctx);
    const names = harness.calls.map(([name]) => name);
    assert.deepEqual(names.filter((name) => !["notify", "confirm"].includes(name)), ["status"]);
    assert.ok(harness.outputs.some((text) => text.includes("approval_required")));
  }
});

test("cancel calls only cancel with the human actor", async () => {
  const harness = commandHarness();
  await harness.registration.handler(`cancel ${OTHER_RUN_ID}`, harness.ctx);
  const operational = harness.calls.filter(([name]) => name !== "notify");
  assert.deepEqual(operational, [[
    "cancel", OTHER_RUN_ID, { kind: "human", id: "pi-user" }, harness.commandContext,
  ]]);
});
