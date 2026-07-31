import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatFissionLines,
  registerFission,
} from "../../extensions/fission.ts";
import { parseFissionRequest } from "../../lib/fission.mjs";

function result(overrides = {}) {
  return {
    status: "COMPLETE",
    verdict: "PASS",
    message: "no submitted blocking finding validated.",
    validatedFindings: [],
    rejectedFindings: [],
    unresolvedFindings: [],
    modelDiversity: {
      exactModelCount: 3,
      providerCount: 2,
      familyCount: 2,
      actualModels: ["anthropic/opus", "openai-codex/gpt", "anthropic/judge"],
      providers: ["anthropic", "openai-codex"],
      families: ["claude", "gpt"],
    },
    usage: { input: 10, output: 20, turns: 3, cost: 0.25, costKnown: true },
    runDir: "/tmp/fission-run",
    panel: [],
    ...overrides,
  };
}

function harness(fission = { defaultReviewers: 3, maxReviewers: 5 }) {
  const commands = new Map();
  const tools = new Map();
  const calls = [];
  const parent = {
    permissionProfile: "ask-all",
    parentPermissionProfile: "ask-all",
    sandbox: false,
    parentSandbox: false,
    mode: "review",
  };
  registerFission(
    {
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerTool(spec) {
        tools.set(spec.name, spec);
      },
    },
    {
      loadConfig: () => ({ fission }),
      resolveParentChildSpawnOpts: (overrides) => {
        assert.deepEqual(overrides, { mode: "review" });
        return parent;
      },
      runFission: async (input) => {
        calls.push(input);
        return result();
      },
    },
  );
  return { commands, tools, calls, parent };
}

test("parseFissionRequest honors every effective reviewer pair and UTF-8 bounds", () => {
  for (const [defaults, text, expected] of [
    [{ defaultReviewers: 3, maxReviewers: 5 }, "review this", 3],
    [{ defaultReviewers: 2, maxReviewers: 4 }, "review this", 2],
    [{ defaultReviewers: 2, maxReviewers: 2 }, "review this", 2],
    [{ defaultReviewers: 2, maxReviewers: 4 }, "4 review this", 4],
  ]) {
    assert.deepEqual(parseFissionRequest(text, defaults), {
      request: "review this",
      reviewers: expected,
    });
  }
  assert.equal(parseFissionRequest("snowman: ☃", { defaultReviewers: 2, maxReviewers: 4 }).request, "snowman: ☃");
  assert.equal(Buffer.byteLength(parseFissionRequest("x".repeat(16 * 1024), { defaultReviewers: 2, maxReviewers: 4 }).request), 16 * 1024);
  for (const text of ["", "2", "0 review", "1.5 review", "-1 review", "5 review"]) {
    assert.throws(() => parseFissionRequest(text, { defaultReviewers: 2, maxReviewers: 4 }));
  }
  assert.throws(
    () => parseFissionRequest("☃".repeat(5462), { defaultReviewers: 2, maxReviewers: 4 }),
    /request_limit/,
  );
});

test("registerFission adds exactly one command and one tool with a strict hard-cap schema", () => {
  const { commands, tools } = harness({ defaultReviewers: 2, maxReviewers: 4 });
  assert.deepEqual([...commands.keys()], ["fission"]);
  assert.deepEqual([...tools.keys()], ["alloy_fission"]);
  const schema = tools.get("alloy_fission").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["request"]);
  assert.equal(schema.properties.request.minLength, 1);
  assert.equal(schema.properties.request.maxLength, 16 * 1024);
  assert.equal(schema.properties.reviewers.minimum, 1);
  assert.equal(schema.properties.reviewers.maximum, 5);
  assert.equal(schema.properties.reviewers.type, "integer");
});

test("slash invocation passes the effective pair, context, timeout, and review parent policy", async () => {
  const { commands, calls, parent } = harness({ defaultReviewers: 2, maxReviewers: 4 });
  const selected = [];
  const ctx = {
    cwd: "/repo/project",
    modelRegistry: { id: "registry" },
    ui: { async select(title, lines) { selected.push({ title, lines }); } },
  };
  await commands.get("fission").handler("4 inspect ☃", ctx);
  assert.deepEqual(calls, [{
    request: "inspect ☃",
    reviewers: 4,
    defaultReviewers: 2,
    maxReviewers: 4,
    cwd: ctx.cwd,
    modelRegistry: ctx.modelRegistry,
    timeoutMs: 300_000,
    ...parent,
  }]);
  assert.equal(Object.hasOwn(calls[0], "signal"), false);
  assert.match(selected[0].lines[0], /PASS.*COMPLETE|COMPLETE.*PASS/);
});

test("tool invocation parses UTF-8 bytes, preserves signal identity, and never clamps", async () => {
  const { tools, calls, parent } = harness({ defaultReviewers: 2, maxReviewers: 4 });
  const signal = new AbortController().signal;
  const ctx = { cwd: "/repo/tool", modelRegistry: { id: "tool-registry" }, ui: {} };
  const output = await tools.get("alloy_fission").execute(
    "call-1",
    { request: "inspect this", reviewers: 4 },
    signal,
    undefined,
    ctx,
  );
  assert.deepEqual(calls, [{
    request: "inspect this",
    reviewers: 4,
    defaultReviewers: 2,
    maxReviewers: 4,
    cwd: ctx.cwd,
    modelRegistry: ctx.modelRegistry,
    signal,
    timeoutMs: 300_000,
    ...parent,
  }]);
  assert.equal(calls[0].signal, signal);
  assert.match(output.content[0].text, /^Fission PASS \/ COMPLETE/);

  await assert.rejects(
    tools.get("alloy_fission").execute("call-2", { request: "inspect", reviewers: 5 }, signal, undefined, ctx),
    /reviewer_limit/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    tools.get("alloy_fission").execute("call-3", { request: "☃".repeat(5462) }, signal, undefined, ctx),
    /request_limit/,
  );
  assert.equal(calls.length, 1);
});

test("formatFissionLines orders adjudication evidence and uses narrow PASS language", () => {
  const lines = formatFissionLines(result({
    validatedFindings: [{ claim: "validated claim", adjudicatedSeverity: "high" }],
    rejectedFindings: [{ claim: "rejected claim" }],
    unresolvedFindings: [{ claim: "unresolved claim" }],
  }));
  const text = lines.join("\n");
  assert.match(lines[0], /PASS.*COMPLETE|COMPLETE.*PASS/);
  assert.ok(text.indexOf("validated claim") < text.indexOf("rejected claim"));
  assert.ok(text.indexOf("rejected claim") < text.indexOf("unresolved claim"));
  assert.match(text, /no submitted blocking finding validated/i);
  assert.match(text, /Models:.*3 exact.*2 providers.*2 families/i);
  assert.match(text, /Usage:.*10 input.*20 output.*3 turns.*\$0\.2500/i);
  assert.match(text, /Artifacts: \/tmp\/fission-run/);
  assert.doesNotMatch(formatFissionLines(result({ runDir: null })).join("\n"), /Artifacts:/);
});
