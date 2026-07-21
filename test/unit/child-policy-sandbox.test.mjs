/**
 * Adversarial tests: child policy ceiling, sandbox fail-closed, credential
 * isolation, and trusted-project sandbox demotion (Ava inbox 480 / Grok fix).
 *
 * These must FAIL on main @ 5cb8df3 and PASS after fix/alloy-grok-child-policy.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..", "..");

const home = mkdtempSync(join(tmpdir(), "alloy-child-policy-home-"));
const project = mkdtempSync(join(tmpdir(), "alloy-child-policy-proj-"));
process.env.HOME = home;
process.env.ALLOY_HOME = join(home, ".pi", "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

const {
  buildChildEnv,
  buildChildPolicyManifest,
  resolveChildExecutionPolicy,
  runChildAgent,
  PROVIDER_CREDENTIAL_ENV_KEYS,
  CHILD_ENV_ALLOWLIST,
} = await import(pathToFileURL(join(root, "lib/child-runner.mjs")).href);

const {
  ensureDefaultConfig,
  loadConfigDetailed,
  saveJson,
} = await import(pathToFileURL(join(root, "lib/config.mjs")).href);

const {
  setRuntimeProjectTrust,
  clearRuntimeProjectTrust,
  isWeakerPermission,
  projectMayReplacePermission,
} = await import(pathToFileURL(join(root, "lib/project-trust.mjs")).href);

function writeProjectAlloy(obj) {
  const dir = join(project, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alloy.json"), JSON.stringify(obj, null, 2));
}

before(() => {
  ensureDefaultConfig();
  const gpath = join(home, ".pi", "alloy", "config.json");
  saveJson(gpath, {
    version: 1,
    permissionProfile: "sandbox",
    mcp: { enabled: true, connectOnStart: false },
    sandbox: {
      image: "node:22-bookworm",
      network: "none",
      allowEnv: ["PATH", "HOME"],
    },
  });
});

beforeEach(() => {
  clearRuntimeProjectTrust();
});

after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("child execution policy ceiling (mechanical)", () => {
  it("resolveChildExecutionPolicy never loosens past parent ask-all", () => {
    const r = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-all",
      parentSandbox: false,
      permissionProfile: "ask-none",
      sandbox: false,
      mode: "build",
      tools: ["read", "write", "bash"],
    });
    assert.equal(r.permissionProfile, "ask-all");
    assert.equal(r.sandbox, false);
    assert.equal(r.clamped, true);
  });

  it("parent sandbox forces child sandbox + sandbox profile", () => {
    const r = resolveChildExecutionPolicy({
      parentPermissionProfile: "sandbox",
      parentSandbox: true,
      permissionProfile: "ask-none",
      sandbox: false,
      mode: "build",
      tools: ["read", "write", "bash"],
    });
    assert.equal(r.permissionProfile, "sandbox");
    assert.equal(r.sandbox, true);
    assert.equal(r.clamped, true);
  });

  it("manifest reflects clamped ceiling not the child request", () => {
    const policy = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-some",
      permissionProfile: "ask-none",
      mode: "build",
    });
    const m = buildChildPolicyManifest(policy);
    assert.equal(m.permissionProfile, "ask-some");
    assert.ok(m.mechanical === true || m.rules.some((x) => /ceiling|mechanical/i.test(x)));
  });

  it("runChildAgent with sandbox=true fails closed when Docker is unavailable (no host spawn)", async () => {
    const result = await runChildAgent({
      prompt: "echo should-not-run",
      cwd: project,
      permissionProfile: "sandbox",
      sandbox: true,
      parentPermissionProfile: "sandbox",
      parentSandbox: true,
      // Inject fail-closed docker check for deterministic RED/GREEN without requiring a real daemon mock
      sandboxDiagnostics: {
        ok: false,
        docker: false,
        daemon: false,
        detail: "docker CLI not found on PATH (test inject)",
      },
      timeoutMs: 5_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "sandbox_unavailable");
    assert.match(String(result.stderr || result.text || ""), /docker|sandbox/i);
    // Must not look like a successful pi child run
    assert.notEqual(result.error, "timeout");
  });
});

describe("provider credential isolation for unsandboxed children", () => {
  it("PROVIDER_CREDENTIAL_ENV_KEYS are not on the default child allowlist", () => {
    assert.ok(Array.isArray(PROVIDER_CREDENTIAL_ENV_KEYS));
    assert.ok(PROVIDER_CREDENTIAL_ENV_KEYS.length >= 3);
    for (const k of PROVIDER_CREDENTIAL_ENV_KEYS) {
      assert.ok(
        !CHILD_ENV_ALLOWLIST.includes(k),
        `${k} must not be on CHILD_ENV_ALLOWLIST (broker/file auth only)`,
      );
    }
  });

  it("buildChildEnv never forwards provider API keys from the host by default", () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.ANTHROPIC_API_KEY = "ant-should-not-leak";
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.GOOGLE_API_KEY = "goog-should-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-should-not-leak";
    process.env.PATH = process.env.PATH || "/usr/bin";

    const env = buildChildEnv();
    for (const k of PROVIDER_CREDENTIAL_ENV_KEYS) {
      assert.equal(env[k], undefined, `unsandboxed child must not receive ${k}`);
    }
    // extras cannot smuggle credentials either
    const env2 = buildChildEnv({
      OPENAI_API_KEY: "sk-via-extra",
      XAI_API_KEY: "xai-via-extra",
      HARMLESS: "ok",
    });
    assert.equal(env2.OPENAI_API_KEY, undefined);
    assert.equal(env2.XAI_API_KEY, undefined);
    assert.equal(env2.HARMLESS, "ok");

    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
});

describe("trusted project cannot demote global sandbox", () => {
  it("projectMayReplacePermission rejects non-sandbox when global is sandbox", () => {
    assert.equal(projectMayReplacePermission("ask-dangerous", "sandbox"), false);
    assert.equal(projectMayReplacePermission("ask-none", "sandbox"), false);
    assert.equal(projectMayReplacePermission("ask-all", "sandbox"), false);
    assert.equal(projectMayReplacePermission("sandbox", "sandbox"), true);
  });

  it("isWeakerPermission treats demoting sandbox to ask-dangerous as weaker", () => {
    assert.equal(isWeakerPermission("ask-dangerous", "sandbox"), true);
    assert.equal(isWeakerPermission("ask-none", "sandbox"), true);
  });

  it("trusted project cannot replace global sandbox with ask-dangerous / ask-none", () => {
    writeProjectAlloy({ permissionProfile: "ask-none" });
    setRuntimeProjectTrust(project, true);
    const detail = loadConfigDetailed(project, { trusted: true });
    assert.equal(detail.config.permissionProfile, "sandbox");
    assert.ok(detail.rejected.some((r) => /permissionProfile|sandbox/i.test(r)));

    writeProjectAlloy({ permissionProfile: "ask-dangerous" });
    const detail2 = loadConfigDetailed(project, { trusted: true });
    assert.equal(
      detail2.config.permissionProfile,
      "sandbox",
      "equal-rank demotion sandbox→ask-dangerous must not land",
    );
  });
});

describe("propagation helpers for auto/fusion/task", () => {
  it("resolveChildExecutionPolicy is the single clamp used by child spawns", () => {
    // Parent ask-dangerous, child tries ask-none → clamp
    const a = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-dangerous",
      permissionProfile: "ask-none",
    });
    assert.equal(a.permissionProfile, "ask-dangerous");

    // Explicit parentSandbox flag alone forces sandbox
    const b = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-dangerous",
      parentSandbox: true,
      permissionProfile: "ask-dangerous",
      sandbox: false,
    });
    assert.equal(b.sandbox, true);
    assert.equal(b.permissionProfile, "sandbox");
  });
});
