import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

test("diagnostic approval detail names the resolved host commands", () => {
  const dir = join(tmp, "approval-proj");
  spawnMk(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "approval", scripts: { test: "node test.mjs" } }),
  );
  const detail = diag.formatDiagnosticApproval(dir, { includeTests: true });
  assert.match(detail, /repository-defined host commands/i);
  assert.match(detail, /npm test -> node test\.mjs/);
  assert.match(detail, /not Docker-sandboxed/i);
});

test("diagnostic approval detail does not hide long script suffixes", () => {
  const dir = join(tmp, "long-approval-proj");
  spawnMk(dir);
  const script = `${"x".repeat(400)} dangerous-tail`;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "long-approval", scripts: { test: script } }),
  );
  assert.match(
    diag.formatDiagnosticApproval(dir, { includeTests: true }),
    /dangerous-tail/,
  );
});

test("repository diagnostics do not inherit arbitrary host secrets", () => {
  const dir = join(tmp, "env-proj");
  spawnMk(dir);
  writeFileSync(
    join(dir, "capture-env.mjs"),
    `
      import { writeFileSync } from "node:fs";
      writeFileSync("captured.json", JSON.stringify({
        marker: process.env.ALLOY_DIAGNOSTIC_TEST_SECRET,
        provider: process.env.OPENAI_API_KEY,
        path: process.env.PATH
      }));
    `,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "env-probe", scripts: { test: "node capture-env.mjs" } }),
  );

  const previousMarker = process.env.ALLOY_DIAGNOSTIC_TEST_SECRET;
  const previousProvider = process.env.OPENAI_API_KEY;
  process.env.ALLOY_DIAGNOSTIC_TEST_SECRET = "must-not-leak";
  process.env.OPENAI_API_KEY = "synthetic-provider-secret";

  try {
    const result = diag.runDiagnostics(dir);
    assert.equal(result.ok, true);
    const captured = JSON.parse(readFileSync(join(dir, "captured.json"), "utf8"));
    assert.equal(captured.marker, undefined);
    assert.equal(captured.provider, undefined);
    assert.ok(captured.path);
  } finally {
    if (previousMarker === undefined) delete process.env.ALLOY_DIAGNOSTIC_TEST_SECRET;
    else process.env.ALLOY_DIAGNOSTIC_TEST_SECRET = previousMarker;
    if (previousProvider === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousProvider;
  }
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
