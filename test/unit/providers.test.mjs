import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-prov-"));
const agentDir = join(tmp, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ALLOY_HOME = join(tmp, "alloy");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.XAI_API_KEY;

const mod = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "providers.mjs")).href
);

test("all missing when empty auth", () => {
  const results = mod.diagnoseProviders();
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => !r.ok));
});

test("detects auth.json subscription-like credentials", () => {
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "oauth", accessToken: "redacted" },
      openai: { type: "oauth", accessToken: "redacted" },
      xai: { type: "subscription", token: "redacted" },
    }),
    "utf8",
  );
  const results = mod.diagnoseProviders();
  assert.ok(results.every((r) => r.ok));
  assert.ok(results.every((r) => r.status === "subscription"));
  const report = mod.formatDoctorReport(results);
  assert.ok(!report.includes("redacted"));
  assert.ok(report.includes("[OK "));
});

test("env key path", () => {
  writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
  process.env.XAI_API_KEY = "xai-test-not-real";
  const results = mod.diagnoseProviders();
  const xai = results.find((r) => r.id === "xai");
  assert.equal(xai.ok, true);
  assert.equal(xai.status, "env");
  delete process.env.XAI_API_KEY;
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
