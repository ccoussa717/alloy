import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

test("identity is env-only (ALLOY_AGENT_ID)", async () => {
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
  // config.identity is ignored (env-only)
  assert.equal(
    resolveAgentIdentity({
      env: {},
      config: { identity: { id: "sonny", displayName: "Sonny" } },
    }).id,
    "default",
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

test("policy packs are model-agnostic and set forceSandbox", async () => {
  const { listPolicyPacks, getPolicyPack, mergePackOntoConfig } = await import(
    pathToFileURL(join(root, "lib/policy-packs.mjs")).href
  );
  assert.ok(listPolicyPacks().some((p) => p.id === "ship"));
  const pack = getPolicyPack("ship");
  const merged = mergePackOntoConfig(
    {
      auto: { useWorktree: true, forceSandbox: true },
      fission: {
        models: ["a/b", "c/d"],
        judgeModel: "e/f",
        blockingSeverity: "medium",
      },
      roles: { scout: { model: null } },
    },
    pack,
  );
  assert.equal(merged.auto.forceSandbox, false);
  assert.equal(merged.fission.blockingSeverity, "high");
  assert.deepEqual(merged.fission.models, ["a/b", "c/d"]);
  // packs do not set role models
  assert.equal(merged.roles?.builder?.model, undefined);

  const incident = mergePackOntoConfig({}, getPolicyPack("incident"));
  assert.equal(incident.auto.forceSandbox, true);
});

test("implement inherits session unless forceSandbox or override", async () => {
  const { resolveImplementPermissionProfile } = await import(
    pathToFileURL(join(root, "lib/implement-policy.mjs")).href
  );
  assert.equal(
    resolveImplementPermissionProfile({}, { env: {} }).profile,
    "ask-dangerous",
  );
  assert.equal(
    resolveImplementPermissionProfile(
      { permissionProfile: "ask-all" },
      { env: {} },
    ).profile,
    "ask-all",
  );
  assert.equal(
    resolveImplementPermissionProfile(
      { auto: { forceSandbox: true }, permissionProfile: "ask-all" },
      { env: {} },
    ).profile,
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

test("model map resolves auto roles from one store", async () => {
  const { resolveAutoRoleModel, applyAutoRolesToProfiles } = await import(
    pathToFileURL(join(root, "lib/model-map.mjs")).href
  );
  assert.equal(
    resolveAutoRoleModel(
      {
        roles: { scout: { model: "xai/from-roles" } },
        profiles: { research: { model: "xai/from-profile" } },
      },
      "scout",
    ),
    "xai/from-roles",
  );
  assert.equal(
    resolveAutoRoleModel(
      { profiles: { research: { model: "xai/from-profile" } } },
      "scout",
    ),
    "xai/from-profile",
  );
  const profiles = applyAutoRolesToProfiles(
    { research: { model: "old" } },
    { scout: { model: "xai/new" } },
  );
  assert.equal(profiles.research.model, "xai/new");
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
