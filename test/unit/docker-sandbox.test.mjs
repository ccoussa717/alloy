import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "alloy-sbx-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");

const sbx = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "docker-sandbox.mjs")).href
);

test("getSandboxConfig defaults", () => {
  const cfg = sbx.getSandboxConfig(tmp);
  assert.equal(cfg.image, "node:22-bookworm");
  assert.equal(cfg.network, "none");
  assert.equal(cfg.memory, "2g");
});

test("diagnoseDocker returns structured result without throwing", () => {
  const d = sbx.diagnoseDocker(tmp);
  assert.equal(typeof d.ok, "boolean");
  assert.equal(typeof d.docker, "boolean");
  assert.equal(d.image, "node:22-bookworm");
  const report = sbx.formatDockerDoctor(d);
  assert.match(report, /docker sandbox/i);
  // This VM may not have docker — either path is fine
  if (!d.docker) {
    assert.match(d.detail, /not found/i);
  }
});

test("createDockerBashOperations returns exec function", () => {
  const ops = sbx.createDockerBashOperations(tmp);
  assert.equal(typeof ops.exec, "function");
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
