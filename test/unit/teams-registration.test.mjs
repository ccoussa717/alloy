import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("root extension registers portable Teams command and tool exactly once", async () => {
  const home = mkdtempSync(join(tmpdir(), "alloy-teams-registration-"));
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
    const { default: start } = await import(`../../extensions/index.ts?teams-startup=${Date.now()}`);
    await start(pi);
    assert.equal(
      registrations.filter((item) => item.kind === "command" && item.name === "team").length,
      1,
    );
    assert.equal(
      registrations.filter((item) => item.kind === "tool" && item.name === "team").length,
      1,
    );
    assert.deepEqual(rootPackage.pi.extensions, ["./extensions/index.ts"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
