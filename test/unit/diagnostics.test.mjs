import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-diag-"));
const diag = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "diagnostics.mjs")).href
);

test("detects node project and plans npm test", () => {
  const dir = join(tmp, "node-proj");
  spawnMk(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }),
  );
  const info = diag.detectProject(dir);
  assert.ok(info.stacks.includes("node"));
  const plan = diag.planDiagnostics(dir);
  assert.ok(plan.steps.some((s) => s.name === "test"));
  const result = diag.runDiagnostics(dir);
  assert.equal(result.ok, true);
});

test("empty project skips cleanly", () => {
  const dir = join(tmp, "empty");
  spawnMk(dir);
  const result = diag.runDiagnostics(dir);
  assert.equal(result.skipped, true);
  assert.equal(result.ok, true);
});

function spawnMk(dir) {
  const { mkdirSync } = require("node:fs");
  mkdirSync(dir, { recursive: true });
}

// ESM require helper
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
