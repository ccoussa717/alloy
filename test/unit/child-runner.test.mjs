import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChildEnv,
  buildChildPolicyManifest,
  CHILD_ENV_ALLOWLIST,
} from "../../lib/child-runner.mjs";

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
