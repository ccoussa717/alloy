import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runForgeWithDependencies } from "../../lib/forge-workflow.mjs";

// Avoid requiring Docker for unit-level forge orchestration tests
process.env.ALLOY_IMPLEMENT_PROFILE = "ask-all";

function makeForgeDeps(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "alloy-forge-"));
  const calls = { fusion: 0, fission: 0, auto: 0 };
  const createRunDir = (_cwd, runId) => {
    const dir = join(root, runId || "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };

  const deps = {
    createRunDir,
    runFusionWithDependencies: async (_opts, phaseDeps = {}) => {
      calls.fusion++;
      const runDir = phaseDeps.createRunDir
        ? phaseDeps.createRunDir(root, "fusion")
        : join(root, "fusion-inner");
      return {
        status: "COMPLETE",
        runDir,
        synthesis: "## Consensus decision\nShip a health endpoint.",
        synthesizer: { ok: true, contractOk: true },
        error: null,
      };
    },
    runFissionWithDependencies: async (opts, phaseDeps = {}) => {
      calls.fission++;
      const n = calls.fission;
      const phase = n === 1 ? "fission-plan" : "fission-diff";
      const runDir = phaseDeps.createRunDir
        ? phaseDeps.createRunDir(root, phase)
        : join(root, phase);
      if (overrides.fissionPlanFail && n === 1) {
        return {
          status: "COMPLETE",
          verdict: "FAIL",
          message: "blocking finding",
          validatedFindings: [{ claim: "secret in plan", adjudicatedSeverity: "high" }],
          unresolvedFindings: [],
          runDir,
          error: null,
        };
      }
      if (overrides.fissionNoChanges && n === 1) {
        return {
          status: "NO_CHANGES",
          verdict: null,
          message: "no changes to review.",
          validatedFindings: [],
          unresolvedFindings: [],
          runDir,
          error: null,
        };
      }
      return {
        status: "COMPLETE",
        verdict: overrides.fissionDiffFail && n === 2 ? "FAIL" : "PASS",
        message: "ok",
        validatedFindings: [],
        unresolvedFindings: [],
        runDir,
        error: null,
      };
    },
    runAutoWorkflowWithDependencies: async (opts, phaseDeps = {}) => {
      calls.auto++;
      assert.match(opts.forgeContext || "", /Fusion synthesis/);
      const runDir = phaseDeps.createRunDir
        ? phaseDeps.createRunDir(root, "auto")
        : join(root, "auto-inner");
      return {
        status: "COMPLETE",
        pass: overrides.autoFail ? false : true,
        reviewVerdict: overrides.autoFail ? "FAIL" : "PASS",
        runDir,
        worktree: overrides.worktree || null,
        error: overrides.autoFail ? "review_failed" : null,
      };
    },
    ...overrides.deps,
  };

  return { deps, calls, root };
}

test("forge runs fusion → fission-plan → auto → fission-diff with shared root", async () => {
  const { deps, calls, root } = makeForgeDeps();
  const summary = await runForgeWithDependencies(
    { request: "add health check", cwd: root },
    deps,
  );

  assert.equal(calls.fusion, 1);
  assert.equal(calls.fission, 2);
  assert.equal(calls.auto, 1);
  assert.equal(summary.kind, "forge");
  assert.equal(summary.status, "COMPLETE");
  assert.equal(summary.pass, true);
  assert.ok(summary.runDir.startsWith(root));
  assert.ok(existsSync(join(summary.runDir, "forge.json")));
  assert.ok(existsSync(join(summary.runDir, "summary.json")));
  assert.ok(existsSync(join(summary.runDir, "phases", "fusion.json")));
  assert.ok(existsSync(join(summary.runDir, "fusion")));
  assert.ok(existsSync(join(summary.runDir, "fission-plan")));
  assert.ok(existsSync(join(summary.runDir, "auto")));
  assert.ok(existsSync(join(summary.runDir, "fission-diff")));
  const saved = JSON.parse(readFileSync(join(summary.runDir, "summary.json"), "utf8"));
  assert.equal(saved.pass, true);
});

test("forge stops before auto when pre-build fission FAIL", async () => {
  const { deps, calls } = makeForgeDeps({ fissionPlanFail: true });
  const summary = await runForgeWithDependencies(
    { request: "risky change", cwd: "/tmp" },
    deps,
  );
  assert.equal(calls.fusion, 1);
  assert.equal(calls.fission, 1);
  assert.equal(calls.auto, 0);
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.error, "fission_plan_fail");
  assert.equal(summary.pass, false);
});

test("forge continues when pre-build fission is NO_CHANGES", async () => {
  const { deps, calls } = makeForgeDeps({ fissionNoChanges: true });
  const summary = await runForgeWithDependencies(
    { request: "greenfield feature", cwd: "/tmp" },
    deps,
  );
  assert.equal(calls.auto, 1);
  assert.equal(calls.fission, 2);
  assert.equal(summary.pass, true);
  assert.equal(summary.fissionPlan.status, "NO_CHANGES");
});

test("forge fails when post-diff fission is INCOMPLETE even if auto passed", async () => {
  const { deps, calls } = makeForgeDeps({
    deps: {
      runFissionWithDependencies: async (opts, phaseDeps = {}) => {
        const n = (calls.fission += 1);
        const phase = n === 1 ? "fission-plan" : "fission-diff";
        const runDir = phaseDeps.createRunDir
          ? phaseDeps.createRunDir("/tmp", phase)
          : `/tmp/${phase}`;
        if (n === 1) {
          return { status: "COMPLETE", verdict: "PASS", message: "ok", runDir, error: null };
        }
        return {
          status: "INCOMPLETE",
          verdict: "INCOMPLETE",
          message: "judge empty",
          runDir,
          error: "empty_output",
        };
      },
    },
  });
  const summary = await runForgeWithDependencies(
    { request: "ship it", cwd: "/tmp" },
    deps,
  );
  assert.equal(calls.auto, 1);
  assert.equal(summary.pass, false);
  assert.equal(summary.error, "empty_output");
});

test("forge fails when post-diff fission FAIL even if auto passed", async () => {
  const { deps, calls } = makeForgeDeps({ fissionDiffFail: true });
  const summary = await runForgeWithDependencies(
    { request: "ship it", cwd: "/tmp" },
    deps,
  );
  assert.equal(calls.auto, 1);
  assert.equal(calls.fission, 2);
  assert.equal(summary.pass, false);
  assert.equal(summary.error, "fission_diff_fail");
});

test("forge rejects empty request", async () => {
  await assert.rejects(
    () => runForgeWithDependencies({ request: "  " }, makeForgeDeps().deps),
    /empty request/,
  );
});
