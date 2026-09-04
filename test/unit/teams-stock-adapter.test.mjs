import assert from "node:assert/strict";
import { test } from "node:test";

import { TEAM_LIMITS } from "../../packages/pi-teams/src/core/limits.ts";
import { createStockPiHost } from "../../packages/pi-teams/src/adapters/stock-pi.ts";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROJECT_ID = "a".repeat(64);
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

function member(overrides = {}) {
  return {
    id: "researcher",
    route: "research",
    capabilities: ["repo.read"],
    tools: [...READ_ONLY_TOOLS],
    needs: [],
    instructions: "Inspect the repository without changing it.",
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    id: "active-model",
    name: "Active Model",
    api: "anthropic-messages",
    provider: "provider",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 10, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000_000,
    maxTokens: 100_000,
    ...overrides,
  };
}

function context(activeModel = model(), overrides = {}) {
  return {
    cwd: "/repo",
    projectId: PROJECT_ID,
    projectTrusted: true,
    source: "tool",
    runtime: {
      model: activeModel,
      modelRegistry: { forbiddenProviderCall() { throw new Error("provider call"); } },
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assistantMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Repository evidence." }],
    api: "anthropic-messages",
    provider: "provider",
    model: "active-model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function sdkFixture(options = {}) {
  const calls = {
    settings: [],
    loaders: [],
    reloads: 0,
    inMemory: [],
    create: [],
  };
  class DefaultResourceLoader {
    constructor(input) {
      this.input = input;
      calls.loaders.push(input);
    }
    async reload() {
      calls.reloads += 1;
      await options.reloadGate?.promise;
    }
  }
  class SettingsManager {
    static inMemory(settings, input) {
      const value = { kind: "settings", settings, input };
      calls.settings.push({ settings, input, value });
      return value;
    }
  }
  class SessionManager {
    static inMemory(cwd) {
      const value = { kind: "session-manager", cwd };
      calls.inMemory.push({ cwd, value });
      return value;
    }
  }
  const sessions = [];
  const sdk = {
    DefaultResourceLoader,
    SettingsManager,
    SessionManager,
    getAgentDir: () => "/default-agent",
    async createAgentSession(input) {
      calls.create.push(input);
      const session = options.sessionFactory?.(input) ?? fakeSession();
      sessions.push(session);
      return { session, extensionsResult: {} };
    },
  };
  return { sdk, calls, sessions };
}

function fakeSession(options = {}) {
  const listeners = new Set();
  const calls = { prompt: [], abort: 0, dispose: 0, unsubscribe: 0 };
  const promptGate = options.promptGate;
  return {
    calls,
    messages: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) calls.unsubscribe += 1;
      };
    },
    async prompt(text, input) {
      calls.prompt.push({ text, input });
      if (promptGate) await promptGate.promise;
      if (options.promptError) throw options.promptError;
      const messages = options.messages ?? [assistantMessage()];
      for (const message of messages) {
        this.messages.push(message);
        for (const listener of listeners) listener({ type: "message_end", message });
      }
    },
    async abort() {
      calls.abort += 1;
      options.onAbort?.();
      await options.abortGate?.promise;
    },
    dispose() {
      calls.dispose += 1;
    },
  };
}

function admittedRun(admission, overrides = {}) {
  return {
    runId: RUN_ID,
    objective: "Find the relevant implementation.",
    member: member(),
    dependencies: [
      {
        memberId: "architecture",
        artifact: {
          memberId: "architecture",
          outputPath: "members/architecture/output.md",
          resultPath: "members/architecture/result.json",
          outputBytes: 12,
          outputSha256: "b".repeat(64),
          resultBytes: 32,
          resultSha256: "c".repeat(64),
        },
        text: "First verified dependency.",
      },
      {
        memberId: "risks",
        artifact: {
          memberId: "risks",
          outputPath: "members/risks/output.md",
          resultPath: "members/risks/result.json",
          outputBytes: 13,
          outputSha256: "d".repeat(64),
          resultBytes: 33,
          resultSha256: "e".repeat(64),
        },
        text: "Second verified dependency.",
      },
    ],
    admission,
    maxCostUsd: admission.maxCostUsd,
    timeoutMs: admission.timeoutMs,
    ...overrides,
  };
}

async function admissionFor(host, ctx = context(), selectedMember = member(), overrides = {}) {
  const admission = await host.preflightMember({
    member: selectedMember,
    maxCostUsd: 2 / 3,
    timeoutMs: 300_000,
    ...overrides,
  }, ctx);
  assert.equal(admission.ok, true, admission.reason);
  return admission;
}

test("stock timeout ceiling", async () => {
  let sdkModelCalls = 0;
  const { sdk } = sdkFixture();
  const active = model();
  const runtime = {};
  Object.defineProperty(runtime, "model", {
    enumerable: true,
    get() {
      sdkModelCalls += 1;
      return active;
    },
  });
  const ctx = context(undefined, { runtime });
  const selectedMember = member();

  assert.deepEqual(await createStockPiHost({ sdk }).capabilities(ctx), {
    capabilities: ["repo.read"],
    tools: ["read", "grep", "find", "ls"],
    maxConcurrency: 1,
    supportsCancellation: true,
  });
  assert.equal(sdkModelCalls, 0);

  const preserved = await createStockPiHost({ sdk }).preflightMember(
    { member: selectedMember, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, ctx,
  );
  assert.equal(preserved.ok && preserved.timeoutMs, 300_000);

  const boundary = await createStockPiHost({ sdk, maxTimeoutMs: 300_000 }).preflightMember(
    { member: selectedMember, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, ctx,
  );
  assert.equal(boundary.ok && boundary.timeoutMs, 300_000);

  const narrowedHost = createStockPiHost({ sdk, maxTimeoutMs: 120_000 });
  const narrowed = await narrowedHost.preflightMember(
    { member: selectedMember, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, ctx,
  );
  assert.equal(narrowed.ok && narrowed.timeoutMs, 120_000);

  const shorterRequest = await narrowedHost.preflightMember(
    { member: selectedMember, maxCostUsd: 2 / 3, timeoutMs: 60_000 }, ctx,
  );
  assert.equal(shorterRequest.ok && shorterRequest.timeoutMs, 60_000);

  for (const value of [null, true, "120000", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 300_001]) {
    const callsBefore = sdkModelCalls;
    assert.throws(
      () => createStockPiHost({ sdk, maxTimeoutMs: value }),
      /stock_timeout_ceiling/,
    );
    assert.equal(sdkModelCalls, callsBefore);
  }

  for (const route of ["research", "review", "planning"]) {
    const decision = await createStockPiHost({ sdk }).preflightMember({
      member: member({ route }),
      maxCostUsd: 2 / 3,
      timeoutMs: 300_000,
    }, ctx);
    assert.equal(decision.ok && decision.effectiveRoute, route);
    assert.equal(decision.ok && decision.effectiveModel, "provider/active-model");
  }

  const missing = await createStockPiHost({ sdk }).preflightMember({
    member: selectedMember,
    maxCostUsd: 2 / 3,
    timeoutMs: 300_000,
  }, context(null));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /stock_model/);

  for (const tools of [["read", "bash"], ["write"], ["edit"], ["network"]]) {
    const denied = await createStockPiHost({ sdk }).preflightMember({
      member: member({ tools }),
      maxCostUsd: 2 / 3,
      timeoutMs: 300_000,
    }, ctx);
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /stock_tool/);
  }

  const invalidPrices = [
    { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 },
    { input: 0, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 },
    { input: 0, output: 1, cacheRead: -1, cacheWrite: 0 },
    { input: 0, output: 1, cacheRead: 0, cacheWrite: undefined },
  ];
  for (const cost of invalidPrices) {
    const denied = await createStockPiHost({ sdk }).preflightMember({
      member: selectedMember,
      maxCostUsd: 2 / 3,
      timeoutMs: 300_000,
    }, context(model({ cost })));
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /stock_pricing/);
  }

  const priced = await createStockPiHost({ sdk }).preflightMember({
    member: selectedMember,
    maxCostUsd: 2 / 3,
    timeoutMs: 300_000,
  }, context(active));
  assert.equal(priced.ok, true);
  const admittedModel = priced.token.model;
  assert.notEqual(admittedModel, active);
  assert.equal(active.maxTokens, 100_000);
  assert.ok(Number.isSafeInteger(admittedModel.maxTokens));
  assert.ok(admittedModel.maxTokens >= 1 && admittedModel.maxTokens < active.maxTokens);
  const maximumDependencies = TEAM_LIMITS.members - 1;
  const fixedEnvelopeBytes = Buffer.byteLength(JSON.stringify({
    objective: "",
    instructions: "",
    dependencies: Array.from({ length: maximumDependencies }, () => ({ memberId: "", text: "" })),
  }), "utf8");
  const maximumInputBytes = fixedEnvelopeBytes + TEAM_LIMITS.objectiveBytes +
    TEAM_LIMITS.instructionBytes +
    (maximumDependencies * (64 + TEAM_LIMITS.outputBytes));
  const upperBoundCost = ((maximumInputBytes * active.cost.input) +
    (admittedModel.maxTokens * active.cost.output)) / 1_000_000;
  assert.ok(upperBoundCost <= (2 / 3), `${upperBoundCost} exceeds allocation`);

  const unaffordable = await createStockPiHost({ sdk }).preflightMember({
    member: selectedMember,
    maxCostUsd: Number.MIN_VALUE,
    timeoutMs: 300_000,
  }, context(active));
  assert.equal(unaffordable.ok, false);
  assert.match(unaffordable.reason, /stock_budget/);
});

test("stock run uses an isolated read-only session and extracts bounded evidence", async () => {
  const session = fakeSession({
    messages: [
      assistantMessage({
        content: [{ type: "text", text: "intermediate" }, { type: "toolCall", id: "1", name: "read", arguments: {} }],
        usage: {
          input: 5,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          cost: { input: 0.05, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.15 },
        },
        stopReason: "toolUse",
      }),
      assistantMessage(),
    ],
  });
  const { sdk, calls } = sdkFixture({ sessionFactory: () => session });
  const host = createStockPiHost({ sdk, agentDir: "/isolated-agent" });
  const ctx = context();
  const admission = await admissionFor(host, ctx);

  let settled = false;
  const execution = host.runMember(admittedRun(admission), ctx, new AbortController().signal);
  execution.result.finally(() => { settled = true; });
  assert.equal(execution.runId, RUN_ID);
  assert.equal(execution.memberId, "researcher");
  assert.ok(execution.handle && typeof execution.handle === "object");
  assert.equal(settled, false);

  const result = await execution.result;
  assert.deepEqual(result, {
    ok: true,
    text: "Repository evidence.",
    model: "provider/active-model",
    usage: { input: 16, output: 9, costUsd: 0.44999999999999996 },
  });
  assert.equal(calls.settings.length, 1);
  assert.deepEqual(calls.settings[0].settings, {});
  assert.deepEqual(calls.settings[0].input, { projectTrusted: false });
  assert.equal(calls.loaders.length, 1);
  assert.deepEqual(calls.loaders[0], {
    cwd: "/repo",
    agentDir: "/isolated-agent",
    settingsManager: calls.settings[0].value,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  assert.equal(calls.reloads, 1);
  assert.equal(calls.inMemory.length, 1);
  assert.equal(calls.inMemory[0].cwd, "/repo");
  assert.equal(calls.create.length, 1);
  const create = calls.create[0];
  assert.deepEqual(Object.keys(create).sort(), [
    "cwd", "model", "resourceLoader", "sessionManager", "settingsManager", "tools",
  ]);
  assert.notEqual(create.model, ctx.runtime.model);
  assert.equal(create.model.provider, "provider");
  assert.equal(create.model.id, "active-model");
  assert.equal(create.model.maxTokens, admission.token.model.maxTokens);
  assert.deepEqual(create.tools, READ_ONLY_TOOLS);
  assert.ok(!create.tools.some((tool) => ["bash", "edit", "write"].includes(tool)));
  assert.equal(create.sessionManager, calls.inMemory[0].value);
  assert.equal(create.resourceLoader.input.noExtensions, true);
  assert.equal(session.calls.prompt.length, 1);
  assert.deepEqual(session.calls.prompt[0].input, { expandPromptTemplates: false });
  assert.doesNotMatch(session.calls.prompt[0].text, /\$\{|{{|<%/);
  assert.deepEqual(JSON.parse(session.calls.prompt[0].text), {
    objective: "Find the relevant implementation.",
    instructions: "Inspect the repository without changing it.",
    dependencies: [
      { memberId: "architecture", text: "First verified dependency." },
      { memberId: "risks", text: "Second verified dependency." },
    ],
  });
  assert.equal(session.calls.unsubscribe, 1);
  assert.equal(session.calls.dispose, 1);
});

test("stock containment targets the exact pending child and is idempotent", async () => {
  const promptGate = deferred();
  const session = fakeSession({ promptGate, onAbort: () => promptGate.resolve() });
  const { sdk, calls } = sdkFixture({ sessionFactory: () => session });
  const host = createStockPiHost({ sdk });
  const ctx = context();
  const admission = await admissionFor(host, ctx);
  const execution = host.runMember(admittedRun(admission), ctx, new AbortController().signal);
  while (calls.create.length === 0) await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    host.containMember({ ...execution, result: undefined, runId: "other" }, ctx, new AbortController().signal),
    /stock_containment/,
  );
  await host.containMember({
    runId: execution.runId,
    memberId: execution.memberId,
    handle: execution.handle,
  }, ctx, new AbortController().signal);
  await host.containMember({
    runId: execution.runId,
    memberId: execution.memberId,
    handle: execution.handle,
  }, ctx, new AbortController().signal);

  const result = await execution.result;
  assert.equal(result.ok, false);
  assert.match(result.error, /contained|aborted/);
  assert.equal(session.calls.abort, 1);
  assert.equal(session.calls.dispose, 1);
});

test("stock abort, timeout, and failure paths dispose once", async () => {
  {
    const promptGate = deferred();
    const session = fakeSession({ promptGate, onAbort: () => promptGate.resolve() });
    const { sdk } = sdkFixture({ sessionFactory: () => session });
    const host = createStockPiHost({ sdk });
    const ctx = context();
    const admission = await admissionFor(host, ctx, member(), { timeoutMs: 10 });
    const execution = host.runMember(admittedRun(admission, { timeoutMs: admission.timeoutMs }), ctx, new AbortController().signal);
    const result = await execution.result;
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout|aborted/);
    assert.equal(session.calls.abort, 1);
    assert.equal(session.calls.dispose, 1);
  }

  {
    const promptGate = deferred();
    const controller = new AbortController();
    const session = fakeSession({ promptGate, onAbort: () => promptGate.resolve() });
    const { sdk, calls } = sdkFixture({ sessionFactory: () => session });
    const host = createStockPiHost({ sdk });
    const ctx = context();
    const admission = await admissionFor(host, ctx);
    const execution = host.runMember(admittedRun(admission), ctx, controller.signal);
    while (calls.create.length === 0) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("operator stopped"));
    const result = await execution.result;
    assert.equal(result.ok, false);
    assert.match(result.error, /aborted/);
    assert.equal(session.calls.abort, 1);
    assert.equal(session.calls.dispose, 1);
  }

  {
    const session = fakeSession({ promptError: new Error("provider failure") });
    const { sdk } = sdkFixture({ sessionFactory: () => session });
    const host = createStockPiHost({ sdk });
    const ctx = context();
    const admission = await admissionFor(host, ctx);
    const result = await host.runMember(
      admittedRun(admission),
      ctx,
      new AbortController().signal,
    ).result;
    assert.equal(result.ok, false);
    assert.match(result.error, /provider failure/);
    assert.equal(session.calls.unsubscribe, 1);
    assert.equal(session.calls.dispose, 1);
  }
});
