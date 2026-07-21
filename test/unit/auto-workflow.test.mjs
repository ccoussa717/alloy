import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-auto-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const auto = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "auto-workflow.mjs")).href
);

test("createRunDir writes structure", () => {
  const dir = auto.createRunDir(tmp, "testrun1");
  assert.ok(existsSync(join(dir, "agents")));
  assert.ok(existsSync(join(dir, "checks")));
  assert.ok(existsSync(join(dir, "patches")));
});

test("runAutoWorkflow without auth still produces artifacts", async () => {
  // Children will fail auth; workflow should still write summary
  const summary = await auto.runAutoWorkflow({
    request: "noop diagnostic of empty folder",
    cwd: tmp,
    useWorktree: false,
    timeoutMs: 60_000,
  });
  assert.ok(summary.runId);
  assert.ok(summary.runDir);
  assert.ok(existsSync(join(summary.runDir, "summary.json")));
  assert.ok(existsSync(join(summary.runDir, "contract.json")));
  assert.ok(existsSync(join(summary.runDir, "request.md")));
  const body = readFileSync(join(summary.runDir, "summary.json"), "utf8");
  assert.match(body, /runId|status/);
  // Expect FAILED or COMPLETE with auth issues on agents
  assert.ok(["COMPLETE", "FAILED", "ABORTED"].includes(summary.status));
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
