import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

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
import { registerTeamTool } from "../../packages/pi-teams/src/extension/tool.ts";
import portableTeamsExtension, {
  registerTeams,
} from "../../packages/pi-teams/src/extension/index.ts";
import { createTeamRegistration } from "../../packages/pi-teams/src/extension/registration.ts";

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

function toolHarness() {
  const calls = [];
  const requested = runView();
  const cancelled = runView({ status: "cancelled", approvalBinding: undefined });
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
      throw new Error("approve must not be called by the model tool");
    },
    async execute(runId, context) {
      calls.push(["execute", runId, context]);
      throw new Error("execute must not be called by the model tool");
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
        text: "safe evidence\u001b]0;hidden\u0007\u202e",
        result: {
          ok: false,
          text: "safe evidence\u001b]0;hidden\u0007\u202e",
          model: null,
          usage: { input: 1, output: 0, costUsd: 0 },
          error: "provider_error: sk-secret-must-not-render",
        },
      };
    },
    async cancel(runId, actor, context) {
      calls.push(["cancel", runId, actor, context]);
      return cancelled;
    },
  };
  let tool;
  const pi = {
    registerTool(definition) {
      assert.equal(tool, undefined, "registered once");
      tool = definition;
    },
  };
  const toolContext = { marker: "tool-context" };
  const contexts = [];
  registerTeamTool(pi, service, (ctx, source) => {
    contexts.push([ctx, source]);
    return toolContext;
  });
  const ctx = {
    cwd: "/repo",
    model: { provider: "provider", id: "parent-model" },
    modelRegistry: {},
    isProjectTrusted: () => true,
    signal: undefined,
    hasUI: false,
    ui: {},
  };
  const execute = (params) => tool.execute("call", params, undefined, undefined, ctx);
  return { calls, service, tool, ctx, contexts, toolContext, execute };
}

const VALID_TOOL_INPUTS = [
  { action: "list" },
  { action: "inspect", team: "builtin/investigate" },
  { action: "request", team: "builtin/investigate", objective: "map auth" },
  { action: "run", team: "investigate", objective: "map auth" },
  { action: "status" },
  { action: "status", runId: RUN_ID },
  { action: "view", runId: RUN_ID },
  { action: "view", runId: RUN_ID, memberId: "architecture" },
  { action: "cancel", runId: RUN_ID },
];

test("team tool has an exact closed action-specific bounded schema with no approval authority", () => {
  const { tool } = toolHarness();
  assert.equal(tool.name, "team");
  assert.equal(tool.parameters.additionalProperties, false);
  const branches = tool.parameters.anyOf;
  assert.ok(Array.isArray(branches));
  assert.ok(branches.every((branch) => branch.additionalProperties === false));
  assert.deepEqual(branches.map((branch) => branch.properties.action.const), [
    "list", "inspect", "request", "run", "status", "view", "cancel",
  ]);
  assert.equal(branches.some((branch) => branch.properties.action.const === "approve"), false);

  for (const input of VALID_TOOL_INPUTS) assert.equal(Check(tool.parameters, input), true, JSON.stringify(input));
  for (const input of [
    {}, { action: "approve", runId: RUN_ID }, { action: "list", team: "investigate" },
    { action: "inspect" }, { action: "inspect", team: "investigate", objective: "x" },
    { action: "request", team: "investigate" },
    { action: "request", team: "investigate", objective: "x", runId: RUN_ID },
    { action: "run", objective: "x" }, { action: "run", team: "investigate", objective: "" },
    { action: "status", memberId: "lead" }, { action: "status", runId: "not-a-uuid" },
    { action: "view" }, { action: "view", runId: RUN_ID, team: "investigate" },
    { action: "view", runId: RUN_ID, memberId: "INVALID_MEMBER" },
    { action: "cancel" }, { action: "cancel", runId: RUN_ID, objective: "x" },
    { action: "list", approved: true }, { action: "list", authorization: "human" },
    { action: "list", actor: { kind: "human", id: "pi-user" } },
  ]) assert.equal(Check(tool.parameters, input), false, JSON.stringify(input));

  const requestBranch = branches.find((branch) => branch.properties.action.const === "request");
  assert.equal(requestBranch.properties.team.minLength, 1);
  assert.ok(requestBranch.properties.team.maxLength <= 1_024);
  assert.equal(requestBranch.properties.objective.minLength, 1);
  assert.ok(requestBranch.properties.objective.maxLength <= 16_384);
});

test("team tool dispatches exact actions and request/run can only request approval", async () => {
  const harness = toolHarness();
  for (const input of VALID_TOOL_INPUTS) {
    const result = await harness.execute(input);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(typeof result.content[0].text, "string");
    if (input.action === "request" || input.action === "run") {
      assert.equal(result.details.status, "approval_required");
      assert.equal(result.details.runId, RUN_ID);
      assert.strictEqual(result.details.binding, BINDING);
      assert.match(result.content[0].text, /approval_required/);
    }
  }

  const operational = harness.calls.map(([name]) => name);
  assert.deepEqual(operational, [
    "list", "inspect", "request", "request", "status", "status", "view", "view", "cancel",
  ]);
  assert.equal(operational.filter((name) => name === "approve").length, 0);
  assert.equal(operational.filter((name) => name === "execute").length, 0);
  assert.equal(harness.contexts.length, VALID_TOOL_INPUTS.length);
  assert.ok(harness.contexts.every(([, source]) => source === "tool"));
  assert.ok(harness.calls.every((call) => {
    if (call[0] === "request") return call[1].context === harness.toolContext;
    return call.at(-1) === harness.toolContext;
  }));
  for (const call of harness.calls.filter(([name]) => ["request", "cancel"].includes(name))) {
    const actor = call[0] === "request" ? call[1].actor : call[2];
    assert.deepEqual(actor, { kind: "model", id: "provider/parent-model" });
  }

  harness.ctx.model = undefined;
  await harness.execute({ action: "cancel", runId: RUN_ID });
  assert.deepEqual(harness.calls.at(-1)[2], { kind: "model", id: "no-active-model" });
});

test("team tool reports blocked requests truthfully without approval text or binding", async () => {
  const harness = toolHarness();
  harness.service.request = async (input) => {
    harness.calls.push(["request", input]);
    return runView({
      status: "blocked",
      approvalBinding: undefined,
      admissions: [{
        ok: false,
        memberId: "architecture",
        effectiveRoute: null,
        effectiveModel: null,
        effectiveCapabilities: [],
        effectiveTools: [],
        maxCostUsd: 2 / 3,
        reason: "stock_auth: private provider detail",
      }],
    });
  };

  for (const action of ["request", "run"]) {
    const response = await harness.execute({ action, team: "investigate", objective: "map auth" });
    assert.deepEqual(response.details, { status: "blocked", runId: RUN_ID });
    assert.equal(Object.hasOwn(response.details, "binding"), false);
    assert.doesNotMatch(response.content[0].text, /approval_required|private provider detail/);
    assert.match(response.content[0].text, /Status: "blocked"/);
  }
  assert.deepEqual(harness.calls.map(([name]) => name), ["request", "request"]);
});

test("team tool rejects direct-call proxy accessor and authority arguments before dispatch", async () => {
  const harness = toolHarness();
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "action", {
    enumerable: true,
    get() { getterCalls += 1; return "list"; },
  });
  const proxy = new Proxy({ action: "list" }, {
    get() { throw new Error("proxy trap must not be invoked"); },
  });

  for (const input of [
    accessor,
    proxy,
    Object.assign(Object.create(null), { action: "list" }),
    { action: "status", runId: undefined },
    { action: "list", approved: true },
    { action: "list", authorization: "human" },
    { action: "list", actor: { kind: "human", id: "pi-user" } },
  ]) await assert.rejects(harness.execute(input), /team_tool_input/);
  assert.equal(getterCalls, 0);
  assert.equal(harness.calls.length, 0);
});

test("team tool preserves terminal-safe text and withholds service error details", async () => {
  const harness = toolHarness();
  const result = await harness.execute({ action: "view", runId: RUN_ID, memberId: "architecture" });
  assert.ok(result.content[0].text.includes("\\u001b]0;hidden\\u0007\\u202e"));
  assert.doesNotMatch(result.content[0].text, /sk-secret-must-not-render/);
  assert.match(result.content[0].text, /Result error code: "provider_error"/);
  assert.deepEqual(result.details, { status: "ok" });

  harness.service.list = async () => {
    throw new Error("provider_error: sk-secret-must-not-render\u001b]0;hidden\u0007");
  };
  await assert.rejects(
    harness.execute({ action: "list" }),
    (error) => error.message === "team_tool_failed:provider_error",
  );
});

function registrationApi() {
  const commands = [];
  const tools = [];
  return {
    commands,
    tools,
    pi: {
      registerCommand(name, options) { commands.push({ name, options }); },
      registerTool(tool) { tools.push(tool); },
    },
  };
}

function registrationOptions(contexts = []) {
  const host = { id: "stock-pi" };
  const eventStore = {};
  const artifactStore = {};
  const catalogFor = async (context) => {
    contexts.push(context);
    return { list: () => [], resolve: () => { throw new Error("unused"); } };
  };
  return { host, eventStore, artifactStore, catalogFor };
}

test("registerTeams constructs one shared service and rejects duplicate API registration", () => {
  const harness = registrationApi();
  const service = registerTeams(harness.pi, registrationOptions());
  assert.ok(service && typeof service === "object");
  assert.equal(harness.commands.length, 1);
  assert.equal(harness.commands[0].name, "team");
  assert.equal(harness.tools.length, 1);
  assert.throws(() => registerTeams(harness.pi, registrationOptions()), /teams_already_registered/);
});

test("registerTeams shares canonical trusted runtime context with command and tool", async () => {
  const harness = registrationApi();
  const contexts = [];
  const service = registerTeams(harness.pi, registrationOptions(contexts));
  const signal = new AbortController().signal;
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { marker: "registry" },
    isProjectTrusted: () => false,
    signal,
    hasUI: true,
    ui: { notify() {} },
  };
  await harness.tools[0].execute("call", { action: "list" }, signal, undefined, ctx);
  await harness.commands[0].options.handler("list", ctx);

  assert.ok(service && typeof service === "object");
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts.map(({ source }) => source), ["tool", "command"]);
  const canonical = await realpath(process.cwd());
  const expectedProject = createHash("sha256").update(canonical, "utf8").digest("hex");
  for (const context of contexts) {
    assert.equal(context.cwd, canonical);
    assert.equal(context.projectId, expectedProject);
    assert.equal(context.projectTrusted, false);
    assert.strictEqual(context.signal, signal);
    assert.strictEqual(context.runtime, ctx);
  }
});

test("default registration lists builtins when optional catalog roots are absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "teams-extension-default-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(projectDir)]);
  try {
    const harness = registrationApi();
    registerTeams(harness.pi, {
      agentDir,
      host: { id: "stock-pi" },
      eventStore: {},
      artifactStore: {},
    });
    const ctx = {
      cwd: projectDir,
      model: undefined,
      modelRegistry: {},
      isProjectTrusted: () => true,
      signal: undefined,
      hasUI: false,
      ui: {},
    };
    const response = await harness.tools[0].execute(
      "call",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(response.content[0].text, /Team: "builtin\/investigate"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function registrationCoordinatorHarness() {
  const serviceCalls = [];
  const service = {
    async list(context) { serviceCalls.push(["list", context]); return []; },
    async inspect() { throw new Error("unused:inspect"); },
    async request() { throw new Error("unused:request"); },
    async approve() { throw new Error("unused:approve"); },
    async execute() { throw new Error("unused:execute"); },
    async status() { throw new Error("unused:status"); },
    async view() { throw new Error("unused:view"); },
    async cancel() { throw new Error("unused:cancel"); },
  };
  const order = [];
  const commandServices = [];
  const toolServices = [];
  let createCalls = 0;
  const register = createTeamRegistration({
    createService(dependencies) {
      createCalls += 1;
      assert.deepEqual(dependencies, { marker: "dependencies" });
      return service;
    },
    registerCommand(pi, received, contextFactory) {
      order.push("command");
      commandServices.push(received);
      registerTeamCommand(pi, received, contextFactory);
    },
    registerTool(pi, received, contextFactory) {
      order.push("tool");
      toolServices.push(received);
      registerTeamTool(pi, received, contextFactory);
    },
  });
  const context = { marker: "context" };
  const invoke = (pi) => register(
    pi,
    () => ({ marker: "dependencies" }),
    () => context,
  );
  return {
    service,
    serviceCalls,
    order,
    commandServices,
    toolServices,
    invoke,
    get createCalls() { return createCalls; },
  };
}

test("registration creates one service and passes its strict identity tool-first to both surfaces", () => {
  const coordinator = registrationCoordinatorHarness();
  const harness = registrationApi();
  const returned = coordinator.invoke(harness.pi);
  assert.equal(coordinator.createCalls, 1);
  assert.strictEqual(returned, coordinator.service);
  assert.deepEqual(coordinator.order, ["tool", "command"]);
  assert.deepEqual(coordinator.toolServices, [coordinator.service]);
  assert.deepEqual(coordinator.commandServices, [coordinator.service]);
  assert.throws(() => coordinator.invoke(harness.pi), /teams_already_registered/);
  assert.equal(coordinator.createCalls, 1);
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.commands.length, 1);
});

test("registration validates both API methods before service or registration effects", () => {
  const coordinator = registrationCoordinatorHarness();
  let toolCalls = 0;
  assert.throws(
    () => coordinator.invoke({ registerTool() { toolCalls += 1; } }),
    /teams_api/,
  );
  assert.equal(coordinator.createCalls, 0);
  assert.equal(toolCalls, 0);
  assert.deepEqual(coordinator.order, []);
});

for (const throwAt of ["tool", "command"]) {
  test(`registration failure at ${throwAt} leaves every partial handler inert and retry-safe`, async () => {
    const coordinator = registrationCoordinatorHarness();
    const captured = { tools: [], commands: [] };
    const pi = {
      registerTool(tool) {
        captured.tools.push(tool);
        if (throwAt === "tool") throw new Error("registration_throw:tool");
      },
      registerCommand(name, options) {
        captured.commands.push({ name, options });
        if (throwAt === "command") throw new Error("registration_throw:command");
      },
    };
    assert.throws(() => coordinator.invoke(pi), new RegExp(`registration_throw:${throwAt}`));
    assert.deepEqual(coordinator.order, throwAt === "tool" ? ["tool"] : ["tool", "command"]);

    const ctx = {
      cwd: process.cwd(), model: undefined, modelRegistry: {},
      isProjectTrusted: () => false, signal: undefined, hasUI: false, ui: {},
    };
    for (const tool of captured.tools) {
      await assert.rejects(
        tool.execute("call", { action: "list" }, undefined, undefined, ctx),
        /teams_registration_inactive/,
      );
    }
    for (const command of captured.commands) {
      await assert.rejects(command.options.handler("list", ctx), /teams_registration_inactive/);
    }
    assert.deepEqual(coordinator.serviceCalls, []);

    assert.throws(() => coordinator.invoke(pi), /teams_already_registered/);
    assert.equal(captured.tools.length, 1);
    assert.equal(captured.commands.length, throwAt === "command" ? 1 : 0);
    assert.deepEqual(coordinator.serviceCalls, []);

    const fresh = registrationApi();
    assert.strictEqual(coordinator.invoke(fresh.pi), coordinator.service);
    assert.equal(fresh.tools.length, 1);
    assert.equal(fresh.commands.length, 1);
  });
}

test("portable default extension registers one command and one tool around its one service", () => {
  const harness = registrationApi();
  assert.equal(portableTeamsExtension(harness.pi), undefined);
  assert.deepEqual(harness.commands.map(({ name }) => name), ["team"]);
  assert.deepEqual(harness.tools.map(({ name }) => name), ["team"]);
  assert.throws(() => portableTeamsExtension(harness.pi), /teams_already_registered/);
});
