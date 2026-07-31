import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("root extension registers Fission command and tool exactly once in one startup", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-fission-registration-"));
  const previous = {
    HOME: process.env.HOME,
    ALLOY_HOME: process.env.ALLOY_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.HOME = home;
  process.env.ALLOY_HOME = join(home, "alloy");
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  try {
    const registrations = [];
    const noop = () => {};
    const pi = new Proxy({}, {
      get(_target, property) {
        if (property === "registerCommand") {
          return (name) => registrations.push({ kind: "command", name });
        }
        if (property === "registerTool") {
          return (tool) => registrations.push({ kind: "tool", name: tool.name });
        }
        return noop;
      },
    });
    const { default: start } = await import(`../../extensions/index.ts?fission-startup=${Date.now()}`);
    start(pi);
    assert.equal(registrations.filter((item) => item.kind === "command" && item.name === "fission").length, 1);
    assert.equal(registrations.filter((item) => item.kind === "tool" && item.name === "alloy_fission").length, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
