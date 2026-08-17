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
  // Canary values (not real token prefixes) — assert doctor never echoes them.
  const secretA = "oauth-access-SECRET_MUST_NOT_APPEAR_IN_DOCTOR_abcdef";
  const secretB = "oauth-access-SECRET_MUST_NOT_APPEAR_IN_DOCTOR_xyz";
  const secretC = "subscription-token-SECRET_MUST_NOT_APPEAR_IN_DOCTOR_1234567890";
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "oauth", accessToken: secretA },
      "openai-codex": { type: "oauth", accessToken: secretB },
      xai: { type: "subscription", token: secretC },
    }),
    "utf8",
  );
  const results = mod.diagnoseProviders();
  assert.ok(results.every((r) => r.ok));
  assert.ok(results.every((r) => r.status === "subscription"));
  const report = mod.formatDoctorReport(results);
  assert.ok(report.includes("[OK "));
  const full = mod.formatFullDoctorReport({ results });
  assert.ok(full.includes("extra usage") || full.includes("Claude"));
  for (const s of [secretA, secretB, secretC]) {
    assert.ok(!report.includes(s), "doctor short report must not leak secrets");
    assert.ok(!full.includes(s), "doctor full report must not leak secrets");
    for (const r of results) {
      assert.ok(!JSON.stringify(r).includes(s), "diagnoseProviders payload must not leak secrets");
    }
  }
});

test("reports expired canonical OAuth with a refresh token as pending Pi verification", () => {
  const expiredAccess = "expired-access-SECRET_MUST_NOT_APPEAR";
  const refresh = "refresh-SECRET_MUST_NOT_APPEAR";
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: expiredAccess,
        refresh,
        expires: Date.now() - 60_000,
      },
    }),
    "utf8",
  );

  const anthropic = mod.diagnoseProviders().find((result) => result.id === "anthropic");
  assert.equal(anthropic.ok, false);
  assert.equal(anthropic.status, "refreshable");
  assert.match(anthropic.detail, /Pi.*doctor.*refresh/i);
  assert.doesNotMatch(mod.formatDoctorReport([anthropic]), /fix: \/login/);
  assert.doesNotMatch(JSON.stringify(anthropic), /SECRET_MUST_NOT_APPEAR/);
});

test("keeps expired OAuth without a refresh token unhealthy", () => {
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({
      xai: {
        type: "oauth",
        access: "expired-access-SECRET_MUST_NOT_APPEAR",
        expires: Date.now() - 60_000,
      },
    }),
    "utf8",
  );

  const xai = mod.diagnoseProviders().find((result) => result.id === "xai");
  assert.equal(xai.ok, false);
  assert.equal(xai.status, "expired");
  assert.doesNotMatch(JSON.stringify(xai), /SECRET_MUST_NOT_APPEAR/);
});

test("env key path reports name only, never value", () => {
  writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
  const envSecret = "env-path-SECRET_MUST_NOT_APPEAR_9876543210";
  process.env.XAI_API_KEY = envSecret;
  const results = mod.diagnoseProviders();
  const xai = results.find((r) => r.id === "xai");
  assert.equal(xai.ok, true);
  assert.equal(xai.status, "env");
  assert.ok(xai.detail.includes("XAI_API_KEY"));
  assert.ok(!xai.detail.includes(envSecret));
  const report = mod.formatDoctorReport(results);
  const full = mod.formatFullDoctorReport({ results });
  assert.ok(!report.includes(envSecret));
  assert.ok(!full.includes(envSecret));
  delete process.env.XAI_API_KEY;
});

test("OPENAI_API_KEY does not claim openai-codex subscription health", () => {
  writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
  process.env.OPENAI_API_KEY = "synthetic-openai-key";
  const codex = mod.diagnoseProviders().find((result) => result.id === "openai-codex");
  assert.equal(codex.ok, false);
  assert.equal(codex.status, "missing");
  delete process.env.OPENAI_API_KEY;
});

test("legacy OpenAI auth aliases do not claim openai-codex health", () => {
  for (const alias of ["openai", "chatgpt", "codex"]) {
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ [alias]: { type: "oauth", accessToken: "synthetic" } }),
      "utf8",
    );
    const codex = mod.diagnoseProviders().find((result) => result.id === "openai-codex");
    assert.equal(codex.ok, false, `${alias} must not satisfy openai-codex`);
  }
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
