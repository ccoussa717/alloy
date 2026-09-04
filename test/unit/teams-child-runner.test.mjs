import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChildPolicyManifest,
  resolveChildExecutionPolicy,
  runChildAgent,
} from "../../lib/child-runner.mjs";

test("Teams review seam preserves an exact confined read-tool subset through policy and runner", async () => {
  const cwd = process.cwd();
  const policy = resolveChildExecutionPolicy({
    mode: "review",
    tools: ["read"],
    preserveReadOnlyToolSubset: true,
    readRoot: cwd,
  });
  assert.deepEqual(policy.tools, ["read"]);
  assert.equal(policy.readRoot, cwd);
  assert.deepEqual(buildChildPolicyManifest(policy).tools, ["read"]);

  const result = await runChildAgent({
    prompt: "inspect",
    cwd,
    model: "provider/model",
    mode: "review",
    tools: ["read"],
    preserveReadOnlyToolSubset: true,
    readRoot: cwd,
    credentialBroker: "runtime-key",
    brokerRuntimeCredential: { provider: "provider", apiKey: "synthetic" },
    dryRun: true,
  });
  assert.deepEqual(result.policy.tools, ["read"]);
  const toolFlag = result.spawnPlan.args.indexOf("--tools");
  assert.equal(result.spawnPlan.args[toolFlag + 1], "read");
  assert.equal(result.spawnPlan.args.join(" ").includes("write"), false);
  assert.equal(result.spawnPlan.args.join(" ").includes("bash"), false);
  assert.equal(result.policy.readRoot, cwd);
});

test("exact review subset seam rejects any widening tool while legacy review remains read-only", () => {
  for (const tools of [["write"], ["bash"], ["read", "read"], null]) {
    assert.throws(() => resolveChildExecutionPolicy({
      mode: "review",
      tools,
      preserveReadOnlyToolSubset: true,
    }), /read-only tool subset/i);
  }
  assert.deepEqual(resolveChildExecutionPolicy({
    mode: "review",
    tools: ["write", "bash"],
  }).tools, ["read", "grep", "find", "ls"]);
});
