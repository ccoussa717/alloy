import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildChildEnv,
  buildChildPolicyManifest,
  CHILD_ENV_ALLOWLIST,
  runChildAgent,
} from "../../lib/child-runner.mjs";

function runEvents(events, options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = true;
  return runChildAgent({
    prompt: "review",
    cwd: process.cwd(),
    mode: "review",
    model: options.model || "anthropic/requested",
    maxOutputBytes: options.maxOutputBytes,
    onEvent: options.onEvent,
    spawnImpl: () => {
      queueMicrotask(() => {
        for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    },
  });
}

describe("child isolation", () => {
  it("buildChildEnv does not copy full process.env", () => {
    process.env.ALLOY_HOST_SECRET_MARKER = "should-not-appear";
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    process.env.PATH = process.env.PATH || "/usr/bin";
    const env = buildChildEnv();
    assert.equal(env.ALLOY_HOST_SECRET_MARKER, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.ALLOY_CHILD, "1");
    assert.ok(env.PATH);
    // only allowlisted keys (+ ALLOY_CHILD/ROOT/VERSION + isolated paths when set)
    for (const k of Object.keys(env)) {
      if (
        CHILD_ENV_ALLOWLIST.includes(k) ||
        k === "ALLOY_CHILD" ||
        k === "ALLOY_ROOT" ||
        k === "ALLOY_VERSION" ||
        k === "HOME" ||
        k === "PI_CODING_AGENT_DIR" ||
        k === "ALLOY_HOME"
      ) {
        continue;
      }
      assert.fail(`unexpected child env key: ${k}`);
    }
    delete process.env.ALLOY_HOST_SECRET_MARKER;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it("buildChildEnv does not reintroduce forbidden extras blindly for secrets", () => {
    const env = buildChildEnv({ FOO: "bar" });
    assert.equal(env.FOO, "bar");
    assert.equal(env.ALLOY_CHILD, "1");
  });

  it("read-only parent mode forces read tools only", () => {
    const m = buildChildPolicyManifest({
      mode: "plan",
      tools: ["read", "write", "edit", "bash", "grep"],
      permissionProfile: "ask-none",
    });
    assert.equal(m.readOnly, true);
    assert.deepEqual(m.tools.sort(), ["find", "grep", "ls", "read"].sort());
    // write/bash stripped
    assert.ok(!m.tools.includes("write"));
    assert.ok(!m.tools.includes("bash"));
  });

  it("build mode keeps requested tools", () => {
    const m = buildChildPolicyManifest({
      mode: "build",
      tools: ["read", "write", "bash"],
      permissionProfile: "ask-dangerous",
    });
    assert.equal(m.readOnly, false);
    assert.deepEqual(m.tools, ["read", "write", "bash"]);
  });

  it("manifest includes policy rules and version", () => {
    const m = buildChildPolicyManifest({ role: "builder" });
    assert.ok(m.version >= 1);
    assert.equal(m.role, "builder");
    assert.equal(m.mechanical, true);
    assert.ok(Array.isArray(m.rules) && m.rules.length > 0);
  });
});

describe("child output and model attestation", () => {
  const message = (fields = {}) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "reviewed" }],
      usage: { input: 1, output: 1, cost: { total: 0.01 } },
      ...fields,
    },
  });

  it("attests only observed provider plus bare model while preserving compatibility model", async () => {
    for (const [fields, expectedActual, expectedModel] of [
      [{ provider: " anthropic ", model: " claude-opus-4-6 " }, "anthropic/claude-opus-4-6", " claude-opus-4-6 "],
      [{ model: "other" }, null, "other"],
      [{ provider: "anthropic", model: "" }, null, "anthropic/requested"],
      [{ provider: "openai-codex", model: "gpt-5.4" }, "openai-codex/gpt-5.4", "gpt-5.4"],
    ]) {
      const result = await runEvents([message(fields)]);
      assert.equal(result.actualModel, expectedActual);
      assert.equal(result.model, expectedModel);
    }
  });

  it("keeps unlimited callback and retention ordering unchanged", async () => {
    const calls = [];
    const first = message({ content: [{ type: "text", text: "first" }] });
    const second = message({ content: [{ type: "text", text: "second" }] });
    const result = await runEvents([first, second], {
      onEvent: (event) => calls.push(event),
    });
    assert.deepEqual(calls, [first, second]);
    assert.deepEqual(result.events, [first, second]);
    assert.deepEqual(result.messages, [first.message, second.message]);
    assert.equal(result.text, "second");
  });

  it("accepts the exact cumulative serialized assistant cap", async () => {
    const event = message({ provider: "anthropic", model: "exact", content: [{ type: "text", text: "å" }] });
    const cap = Buffer.byteLength(JSON.stringify(event.message), "utf8");
    const result = await runEvents([event], { maxOutputBytes: cap });
    assert.equal(result.ok, true);
    assert.deepEqual(result.events, [event]);
    assert.equal(result.actualModel, "anthropic/exact");
  });

  it("replaces an over-cap assistant payload before callback or retention and never leaks it", async () => {
    const accepted = message({ provider: "anthropic", model: "safe", content: [{ type: "text", text: "safe text" }] });
    const secrets = [
      { thinking: "THINKING_SECRET" },
      { content: [{ type: "toolCall", name: "TOOL_SECRET", arguments: { key: "ARG_SECRET" }, signature: "SIG_SECRET" }] },
      { content: [{ type: "text", text: "MULTIBYTE_SECRET_秘密" }], other: "OTHER_SECRET" },
    ];
    for (const oversizedFields of secrets) {
      const oversized = message(oversizedFields);
      const acceptedBytes = Buffer.byteLength(JSON.stringify(accepted.message), "utf8");
      const serializedBytes = Buffer.byteLength(JSON.stringify(oversized.message), "utf8");
      const callbacks = [];
      const result = await runEvents([accepted, oversized], {
        maxOutputBytes: acceptedBytes + serializedBytes - 1,
        onEvent: (event) => {
          const body = JSON.stringify(event);
          if (body.includes("SECRET")) throw new Error("secret reached callback");
          callbacks.push(event);
        },
      });
      const marker = {
        type: "message_end",
        message: { role: "assistant", omitted: true, reason: "output_limit", serializedBytes },
      };
      assert.equal(result.ok, false);
      assert.equal(result.error, "output_limit");
      assert.equal(result.outputLimitExceeded, true);
      assert.equal(result.actualModel, "anthropic/safe");
      assert.equal(result.text, "safe text");
      assert.deepEqual(callbacks, [accepted, marker]);
      assert.deepEqual(result.events, [accepted, marker]);
      assert.deepEqual(result.messages, [accepted.message, marker.message]);
      assert.equal(JSON.stringify({ callbacks, result }).includes("SECRET"), false);
    }
  });

  it("accounts for every completed assistant turn including the omitted crossing message", async () => {
    const first = message({
      provider: "anthropic",
      model: "safe",
      content: [{ type: "text", text: "accepted" }],
      usage: { input: 10, output: 2, cost: { total: 0.11 } },
    });
    const crossing = message({
      provider: "anthropic",
      model: "safe",
      content: [{ type: "text", text: "CROSSING_SECRET" }],
      usage: { input: 20, output: 4, cost: { total: 0.23 } },
    });
    const result = await runEvents([first, crossing], {
      maxOutputBytes: Buffer.byteLength(JSON.stringify(first.message), "utf8"),
    });
    assert.deepEqual(result.usage, {
      input: 30,
      output: 6,
      cost: 0.34,
      turns: 2,
      costKnown: true,
    });
    assert.equal(JSON.stringify(result).includes("CROSSING_SECRET"), false);
  });

  it("drops limited assistant updates without dispatching or retaining delta secrets", async () => {
    for (const update of [
      { type: "message_update", message: { role: "assistant" }, delta: { thinking: "THINKING_DELTA_SECRET" } },
      { type: "message_update", message: { role: "assistant" }, delta: { type: "toolCall", argumentsDelta: "TOOL_DELTA_SECRET" } },
    ]) {
      const complete = message({ provider: "anthropic", model: "safe" });
      const callbacks = [];
      const result = await runEvents([update, complete], {
        maxOutputBytes: Buffer.byteLength(JSON.stringify(complete.message), "utf8"),
        onEvent: (event) => callbacks.push(event),
      });
      assert.deepEqual(callbacks, [complete]);
      assert.deepEqual(result.events, [complete]);
      assert.deepEqual(result.messages, [complete.message]);
      assert.equal(JSON.stringify({ callbacks, result }).includes("SECRET"), false);
    }
  });
});
