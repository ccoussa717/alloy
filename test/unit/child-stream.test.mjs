import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "alloy-child-stream-home-"));
const project = mkdtempSync(join(tmpdir(), "alloy-child-stream-project-"));
process.env.HOME = home;
process.env.ALLOY_HOME = join(home, ".pi", "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

const { CHILD_EVENT_LIMIT, runChildAgent } = await import("../../lib/child-runner.mjs");

function fakeChild(write) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  queueMicrotask(() => write(child));
  return child;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("compact events produce cumulative live output and stream metrics", async () => {
  const live = [];
  const answer = "bounded output ".repeat(100);
  const result = await runChildAgent({
    prompt: "stream compactly",
    cwd: project,
    onEvent: (event) => live.push(event.outputText),
    spawnImpl: () => fakeChild((child) => {
      child.stdout.write(jsonLine({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      for (const delta of answer.match(/.{1,25}/g) ?? []) {
        child.stdout.write(jsonLine({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
        }));
      }
      child.stdout.write(jsonLine({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          usage: { input: 10, output: 100, cost: { total: 0.01 } },
        },
      }));
      child.emit("close", 0);
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, answer);
  assert.equal(live.filter(Boolean).at(-1), answer);
  assert.ok(result.stdoutBytes > answer.length);
  assert.equal(result.eventCount, (answer.match(/.{1,25}/g) ?? []).length + 2);
  assert.ok(result.events.every((event) => event.outputText === undefined));
});

test("live output excludes reasoning-shaped blocks that carry text", async () => {
  const live = [];
  const result = await runChildAgent({
    prompt: "keep reasoning hidden",
    cwd: project,
    onEvent: (event) => live.push(event.outputText),
    spawnImpl: () => fakeChild((child) => {
      const message = {
        role: "assistant",
        content: [
          { type: "reasoning", text: "hidden chain of thought" },
          { type: "text", text: "visible answer" },
        ],
      };
      child.stdout.write(jsonLine({ type: "message_start", message }));
      child.stdout.write(jsonLine({ type: "message_end", message }));
      child.emit("close", 0);
    }),
  });

  assert.equal(result.text, "visible answer");
  assert.equal(live.filter(Boolean).at(-1), "visible answer");
  assert.ok(live.every((value) => !value?.includes("hidden chain of thought")));
});

test("stdout limits retain partial assistant output and classify the failure", async () => {
  const limited = await runChildAgent({
    prompt: "preserve partial output",
    cwd: project,
    streamLimitBytes: 1024,
    spawnImpl: () => fakeChild((child) => {
      child.stdout.write(jsonLine({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "completed prelude" }] },
      }));
      child.stdout.write(jsonLine({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      child.stdout.write(jsonLine({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new useful partial" },
      }));
      child.stdout.write("x".repeat(3000));
      child.emit("close", 0);
    }),
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.error, "stdout_limit");
  assert.equal(limited.text, "new useful partial");
  assert.ok(limited.stdoutBytes > 2048);
  assert.equal(limited.eventCount, 3);
});

test("stdout limits process complete deltas before excess bytes in the same chunk", async () => {
  const limited = await runChildAgent({
    prompt: "preserve coalesced output",
    cwd: project,
    streamLimitBytes: 256,
    spawnImpl: () => fakeChild((child) => {
      child.stdout.write(`${jsonLine({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "coalesced partial" },
      })}${"x".repeat(600)}`);
      child.emit("close", 0);
    }),
  });
  assert.equal(limited.error, "stdout_limit");
  assert.equal(limited.text, "coalesced partial");
  assert.equal(limited.eventCount, 1);
});

test("split UTF-8 JSON chunks preserve text and exact byte metrics", async () => {
  const line = Buffer.from(jsonLine({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "valid 💡 text" }] },
  }));
  const splitAt = line.indexOf(Buffer.from("💡")) + 2;
  const result = await runChildAgent({
    prompt: "decode safely",
    cwd: project,
    spawnImpl: () => fakeChild((child) => {
      child.stdout.write(line.subarray(0, splitAt));
      child.stdout.write(line.subarray(splitAt));
      child.emit("close", 0);
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "valid 💡 text");
  assert.equal(result.stdoutBytes, line.length);
});

test("natural nonzero exits preserve a newer in-progress assistant turn", async () => {
  const result = await runChildAgent({
    prompt: "preserve failed turn",
    cwd: project,
    spawnImpl: () => fakeChild((child) => {
      child.stdout.write(jsonLine({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "old" }] },
      }));
      child.stdout.write(jsonLine({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }));
      child.stdout.write(jsonLine({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new partial" },
      }));
      child.emit("close", 2);
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.text, "new partial");
});

test("bounded event retention keeps the newest diagnostics", async () => {
  const result = await runChildAgent({
    prompt: "retain event tail",
    cwd: project,
    spawnImpl: () => fakeChild((child) => {
      for (let sequence = 0; sequence < CHILD_EVENT_LIMIT + 2; sequence++) {
        child.stdout.write(jsonLine({ type: "diagnostic", sequence }));
      }
      child.stdout.write(jsonLine({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }));
      child.emit("close", 0);
    }),
  });
  assert.equal(result.events.length, CHILD_EVENT_LIMIT);
  assert.equal(result.events[0].sequence, 3);
  assert.equal(result.events.at(-1).type, "message_end");
});
