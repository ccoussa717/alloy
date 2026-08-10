import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const home = mkdtempSync(join(tmpdir(), "alloy-backbone-"));
const prevHome = process.env.HOME;
const prevAlloy = process.env.ALLOY_HOME;
const prevAgent = process.env.ALLOY_AGENT_ID;

before(() => {
  process.env.HOME = home;
  process.env.ALLOY_HOME = join(home, ".pi", "alloy");
  delete process.env.ALLOY_AGENT_ID;
});

after(() => {
  process.env.HOME = prevHome;
  if (prevAlloy === undefined) delete process.env.ALLOY_HOME;
  else process.env.ALLOY_HOME = prevAlloy;
  if (prevAgent === undefined) delete process.env.ALLOY_AGENT_ID;
  else process.env.ALLOY_AGENT_ID = prevAgent;
  rmSync(home, { recursive: true, force: true });
});

const root = join(import.meta.dirname, "..", "..");

test("identity resolves ALLOY_AGENT_ID then config then default", async () => {
  const { resolveAgentIdentity, sanitizeAgentId } = await import(
    pathToFileURL(join(root, "lib/identity.mjs")).href
  );
  assert.equal(sanitizeAgentId("Sonny Agent!"), "sonny-agent");
  assert.equal(resolveAgentIdentity({ env: {}, config: {} }).id, "default");
  assert.equal(
    resolveAgentIdentity({
      env: { ALLOY_AGENT_ID: "Ava" },
      config: { identity: { id: "ignored" } },
    }).id,
    "ava",
  );
  assert.equal(
    resolveAgentIdentity({
      env: {},
      config: { identity: { id: "sonny", displayName: "Sonny" } },
    }).displayName,
    "Sonny",
  );
});

test("run index append and list", async () => {
  const { recordRun, listRuns, getRunIndexPath } = await import(
    pathToFileURL(join(root, "lib/run-index.mjs")).href
  );
  process.env.ALLOY_AGENT_ID = "test-agent";
  recordRun({
    kind: "auto",
    runId: "r1",
    runDir: "/tmp/r1",
    status: "COMPLETE",
    pass: true,
  });
  recordRun({
    kind: "forge",
    runId: "r2",
    runDir: "/tmp/r2",
    status: "FAILED",
    pass: false,
    error: "fission_diff_fail",
  });
  const rows = listRuns({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].runId, "r2");
  assert.equal(rows[0].agentId, "test-agent");
  assert.ok(existsSync(getRunIndexPath()));
});

test("policy packs list and merge without wiping fission models", async () => {
  const { listPolicyPacks, getPolicyPack, mergePackOntoConfig } = await import(
    pathToFileURL(join(root, "lib/policy-packs.mjs")).href
  );
  assert.ok(listPolicyPacks().some((p) => p.id === "ship"));
  const pack = getPolicyPack("ship");
  const merged = mergePackOntoConfig(
    {
      auto: { useWorktree: true, implementPermissionProfile: "sandbox" },
      fission: {
        models: ["a/b", "c/d"],
        judgeModel: "e/f",
        blockingSeverity: "medium",
      },
      roles: { scout: { model: null } },
    },
    pack,
  );
  assert.equal(merged.auto.implementPermissionProfile, "ask-dangerous");
  assert.equal(merged.fission.blockingSeverity, "high");
  assert.deepEqual(merged.fission.models, ["a/b", "c/d"]);
  assert.equal(merged.roles.builder.model, "openai-codex/gpt-5.4");
});

test("implement policy defaults to sandbox and rejects invalid", async () => {
  const { resolveImplementPermissionProfile } = await import(
    pathToFileURL(join(root, "lib/implement-policy.mjs")).href
  );
  // Isolate from ambient ALLOY_IMPLEMENT_PROFILE (unit suites may set it).
  assert.equal(
    resolveImplementPermissionProfile({}, { env: {} }).profile,
    "sandbox",
  );
  assert.equal(
    resolveImplementPermissionProfile(
      {},
      { env: { ALLOY_IMPLEMENT_PROFILE: "ask-all" } },
    ).profile,
    "ask-all",
  );
  assert.throws(() =>
    resolveImplementPermissionProfile(
      {},
      { env: {}, implementPermissionProfile: "nope" },
    ),
  );
});

test("fission/forge exit codes", async () => {
  const { exitCodeFromFission, exitCodeFromForge } = await import(
    pathToFileURL(join(root, "lib/cli-run.mjs")).href
  );
  assert.equal(exitCodeFromFission({ status: "COMPLETE", verdict: "PASS" }), 0);
  assert.equal(exitCodeFromFission({ status: "NO_CHANGES" }), 0);
  assert.equal(exitCodeFromFission({ status: "COMPLETE", verdict: "FAIL" }), 1);
  assert.equal(exitCodeFromFission({ status: "INCOMPLETE" }), 2);
  assert.equal(exitCodeFromForge({ status: "COMPLETE", pass: true }), 0);
  assert.equal(exitCodeFromForge({ status: "FAILED", pass: false }), 1);
});
