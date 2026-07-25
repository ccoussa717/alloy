/**
 * Real Docker sandbox e2e.
 * Skips locally when Docker is unavailable, but release CI can require it.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "alloy-docker-e2e-"));
process.env.ALLOY_HOME = join(home, "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");

const sbx = await import(join(root, "lib", "docker-sandbox.mjs"));
const { buildChildSpawnPlan } = await import(join(root, "lib", "child-runner.mjs"));
const { findPiRuntime } = await import(join(root, "lib", "pi-package.mjs"));

function dockerAvailable() {
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["docker"],
    { encoding: "utf8" },
  );
  if (which.status !== 0) return { ok: false, reason: "docker CLI not found" };
  const ver = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (ver.status !== 0) {
    return { ok: false, reason: ver.stderr || "daemon not reachable" };
  }
  return { ok: true, version: ver.stdout.trim() };
}

const docker = dockerAvailable();

if (!docker.ok && process.env.ALLOY_REQUIRE_DOCKER_TEST === "1") {
  throw new Error(`Docker is required for this test run: ${docker.reason}`);
}

describe("integration: docker sandbox e2e", { skip: !docker.ok && `skip: ${docker.reason}` }, () => {
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "hello.txt"), "from-host\n");

  after(() => {
    try {
      sbx.stopSandboxContainer(cwd);
    } catch {
      // ignore
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("diagnoseDocker reports daemon healthy", () => {
    const d = sbx.diagnoseDocker(cwd);
    assert.equal(d.docker, true);
    assert.equal(d.daemon, true);
    assert.equal(d.ok, true);
  });

  it("getSandboxConfig forces network none from global defaults", () => {
    const cfg = sbx.getSandboxConfig(cwd);
    assert.equal(cfg.network, "none");
    assert.equal(cfg.image, "node:22-bookworm");
  });

  it("ensureSandboxContainer starts and reuses container", () => {
    const a = sbx.ensureSandboxContainer(cwd);
    assert.ok(a.name.startsWith("alloy-sbx-"));
    const b = sbx.ensureSandboxContainer(cwd);
    assert.equal(b.name, a.name);
    assert.equal(b.reused, true);
  });

  it("runInSandbox executes with project mount and captures output", () => {
    const result = sbx.runInSandbox(
      "cat hello.txt && echo SANDBOX_OK && touch wrote-in-sandbox.txt",
      cwd,
      { timeoutMs: 60_000 },
    );
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.match(result.stdout, /from-host/);
    assert.match(result.stdout, /SANDBOX_OK/);

    assert.ok(existsSync(join(cwd, "wrote-in-sandbox.txt")));
  });

  it("network is none on container (docker inspect)", () => {
    const info = sbx.ensureSandboxContainer(cwd);
    const insp = spawnSync(
      "docker",
      [
        "inspect",
        "-f",
        "{{.HostConfig.NetworkMode}}",
        info.name,
      ],
      { encoding: "utf8" },
    );
    assert.equal(insp.status, 0, insp.stderr);
    assert.match(insp.stdout.trim(), /none/i);
  });

  it("executes the real child-container Pi runtime plan", () => {
    const runtime = findPiRuntime([root]);
    assert.ok(runtime);
    const childHome = join(home, "child-home");
    const policyDir = join(home, "child-policy");
    mkdirSync(join(childHome, ".pi", "agent"), { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    const policyPath = join(policyDir, "policy.json");
    writeFileSync(policyPath, "{}\n");
    const plan = buildChildSpawnPlan({
      policy: { sandbox: true, permissionProfile: "ask-all" },
      inv: {
        command: process.execPath,
        argsPrefix: [runtime.cli],
        piNodeModulesRoot: runtime.nodeModulesRoot,
      },
      piArgs: ["--list-models"],
      cwd,
      childEnv: {},
      isolatedHome: { home: childHome, piDir: join(childHome, ".pi", "agent") },
      policyPath,
      dockerImage: "node:22-bookworm",
    });
    const result = spawnSync(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const check = spawnSync(
      "docker",
      ["ps", "-a", "--filter", `name=^/${plan.containerName}$`, "--format", "{{.Names}}"],
      { encoding: "utf8", env: plan.env },
    );
    assert.equal((check.stdout || "").trim(), "");
  });

  it("stopSandboxContainer removes container", () => {
    const stopped = sbx.stopSandboxContainer(cwd);
    assert.equal(stopped.stopped, true);
    const check = spawnSync(
      "docker",
      ["ps", "-a", "--filter", `name=^/${stopped.name}$`, "--format", "{{.Names}}"],
      { encoding: "utf8" },
    );
    assert.equal((check.stdout || "").trim(), "");
  });
});

// Always-run meta test so suite is not empty when docker missing
describe("integration: docker availability gate", () => {
  it("reports skip reason when docker unavailable", () => {
    if (!docker.ok) {
      assert.ok(docker.reason);
      console.log(`[docker e2e skipped] ${docker.reason}`);
    } else {
      assert.ok(docker.version);
    }
  });
});
