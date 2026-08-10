import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const help = await import(
  pathToFileURL(join(import.meta.dirname, "..", "..", "lib", "command-help.mjs")).href
);

test("helpMenuLines leads with Done and preserves body", () => {
  const lines = help.helpMenuLines(["alpha", "", "beta"]);
  assert.match(lines[0], /Done/i);
  assert.ok(lines.includes("alpha"));
  assert.ok(lines.includes("beta"));
  assert.ok(lines.every((line) => line.length > 0));
});

test("workflow command helps are non-empty and actionable", () => {
  for (const [name, fn] of [
    ["fission", help.formatFissionCommandHelp],
    ["fusion", help.formatFusionCommandHelp],
    ["auto", help.formatAutoCommandHelp],
    ["forge", help.formatForgeCommandHelp],
    ["pack", help.formatPackCommandHelp],
    ["setup", help.formatSetupCommandHelp],
  ]) {
    const lines = fn();
    assert.ok(lines.length >= 8, `${name} help too short`);
    assert.match(lines[0], /Done/i);
    assert.ok(
      lines.some((l) => l.includes(`/${name}`) || name === "setup" || name === "pack"),
      `${name} should mention its command`,
    );
  }
});
