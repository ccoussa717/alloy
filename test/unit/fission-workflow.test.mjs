import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  FISSION_ROLES,
  buildModelDiversity,
  createFissionResult,
  parseFissionRequest,
  resolveFissionModels,
  runFission,
  runFissionWithDependencies,
} from "../../lib/fission.mjs";

const digest = "a".repeat(64);
const reviewerModels = [
  "anthropic/opus",
  "openai-codex/gpt",
  "xai/grok",
  "google/gemini",
  "openrouter/deepseek",
];
const judgeModel = "anthropic/judge";
const packet = {
  packetRoot: "/run/packet",
  packetDigest: "b".repeat(64),
  sourceDigest: "c".repeat(64),
  evidenceComplete: true,
  reason: null,
  manifest: {
    entries: [{ path: "lib/a.mjs", included: false, reason: "deleted", artifactPath: null }],
  },
  artifacts: {
    "unstaged.diff": {
      type: "unstaged_diff",
      path: "unstaged.diff",
      digest,
      size: 10,
      lineCount: 10,
      mode: 0o400,
      sections: [{ affectedPath: "lib/a.mjs", lineStart: 1, lineEnd: 10 }],
    },
  },
};

function finding(claim) {
  return {
    severity: "high",
    claim,
    affectedPath: "lib/a.mjs",
    location: {
      artifact: "unstaged_diff",
      artifactPath: "unstaged.diff",
      lineStart: 1,
      lineEnd: 1,
      artifactDigest: digest,
    },
    evidence: "line proves it",
    reproduction: "run it",
    suggestedFix: "fix it",
    confidence: 0.9,
  };
}

function reviewerOutput(role, claims = []) {
  return {
    reviewerRole: role,
    coverage: [`coverage:${role}`],
    findings: claims.map(finding),
    errors: [],
  };
}

function childResult(model, output, overrides = {}) {
  return {
    ok: true,
    text: JSON.stringify(output),
    actualModel: model,
    model: model.split("/").at(-1),
    usage: { input: 10, output: 5, cost: 0.1, turns: 1, costKnown: true },
    events: [],
    messages: [],
    ...overrides,
  };
}

function makeDeps(options = {}) {
  const runRoot = mkdtempSync(join(tmpdir(), "alloy-fission-workflow-"));
  const calls = {
    preflight: 0,
    createRunDir: 0,
    capture: 0,
    prepare: [],
    reserve: [],
    settle: [],
    children: [],
    recapture: 0,
    verify: 0,
  };
  let reservation = 0;
  const outputs = [];
  const deps = {
    loadConfig: () => ({
      providers: { allow: ["anthropic", "openai-codex", "xai", "google", "openrouter"] },
      budgets: { maxCostUsd: 20 },
      orchestration: { enabled: true, maxConcurrency: 2 },
      fission: {
        models: reviewerModels,
        judgeModel,
        modelFamilies: options.modelFamilies || {},
        reviewerEfforts: options.reviewerEfforts || [],
        judgeEffort: options.judgeEffort ?? null,
      },
    }),
    preflightFissionRepository: () => {
      calls.preflight++;
      return options.preflight || {
        state: "READY",
        repoRoot: "/repo",
        head: Buffer.from("head\n"),
        status: Buffer.from(" M lib/a.mjs\0"),
      };
    },
    createRunDir: () => {
      calls.createRunDir++;
      return runRoot;
    },
    captureFissionPacket: (input) => {
      calls.capture++;
      assert.equal(input.packetRoot, join(runRoot, "packet"));
      return {
        kind: "repo",
        ...packet,
        packetRoot: input.packetRoot,
        ...(options.packet || {}),
      };
    },
    verifyFissionArtifacts: () => {
      calls.verify++;
      const next = options.verify?.[calls.verify - 1];
      return next || { ok: true, mismatches: [] };
    },
    recaptureFissionSource: () => {
      calls.recapture++;
      const next = options.recapture?.[calls.recapture - 1];
      return next || { ok: true, digest: packet.sourceDigest };
    },
    prepareExactAgentLaunch: async (input) => {
      calls.prepare.push(input);
      if (options.prepareFailure && input.model === options.prepareFailure.model) {
        return { ok: false, decision: { reason: options.prepareFailure.reason, fallbackUsed: false } };
      }
      return {
        ok: true,
        spec: { model: input.model, tools: ["read", "grep", "find", "ls"] },
        decision: { ok: true, model: input.model, fallbackUsed: false },
        credential: { mode: "runtime-key", runtimeCredential: { provider: input.model.split("/")[0], apiKey: "secret" } },
        maxConcurrency: 2,
        budgetUsd: 2,
        budgetLimitUsd: 20,
      };
    },
    getRunningAgentCount: () => options.runningCount?.() ?? 0,
    getAgentSpentCost: () => options.spentCost?.() ?? 0,
    reserveAgentLaunch: (input) => {
      calls.reserve.push(input);
      return { id: `r${++reservation}`, budgetUsd: 2 };
    },
    settleAgentLaunch: (reserved, usage) => {
      calls.settle.push({ reserved, usage });
    },
    runChildAgent: async (input) => {
      calls.children.push(input);
      const index = calls.children.length - 1;
      if (options.runChild) return options.runChild(input, index, outputs);
      if (input.role === "fission-judge") {
        return childResult(input.model, { clusters: [], judgeConcern: null });
      }
      return childResult(input.model, reviewerOutput(input.role.replace("fission-reviewer-", "")));
    },
  };
  return { deps: { ...deps, ...options.deps }, calls, runRoot, outputs };
}

function assertCompleteShape(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "blockingSeverity", "clusters", "error", "evidenceComplete", "judge", "kind",
    "message", "mode", "modelDiversity", "packetDigest", "panel", "rejectedFindings",
    "repoFallbackReason", "request", "requestedReviewers", "reviewers", "runDir", "runId", "sourceDigest",
    "status", "unresolvedFindings", "usage", "validatedFindings", "verdict",
  ].sort());
}

describe("Fission pure contracts", () => {
  it("exports exact frozen default role packs for counts one through five", () => {
    assert.deepEqual(FISSION_ROLES, {
      1: ["general_adversarial"],
      2: ["correctness_regressions", "security_trust_boundaries"],
      3: ["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling"],
      4: ["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling", "test_quality_spec_coverage"],
      5: ["correctness_regressions", "security_trust_boundaries", "architecture_failure_handling", "test_quality_spec_coverage", "performance_concurrency_resources"],
    });
    assert.equal(Object.isFrozen(FISSION_ROLES), true);
    for (const roles of Object.values(FISSION_ROLES)) assert.equal(Object.isFrozen(roles), true);
  });

  it("resolveFissionRoles prefers configured catalog roles over default packs", async () => {
    const { resolveFissionRoles, FISSION_ROLE_CATALOG } = await import("../../lib/fission-roles.mjs");
    assert.ok(FISSION_ROLE_CATALOG.some((role) => role.id === "cynical_customer"));
    assert.deepEqual(
      resolveFissionRoles({
        fission: {
          roles: ["cynical_customer", "security_trust_boundaries", "adversarial_code_review"],
        },
      }, 2),
      ["cynical_customer", "security_trust_boundaries"],
    );
    assert.deepEqual(resolveFissionRoles({ fission: { roles: [] } }, 2), [
      "correctness_regressions",
      "security_trust_boundaries",
    ]);
    assert.throws(
      () => resolveFissionRoles({ fission: { roles: ["not_real"] } }, 1),
      /reviewer_roles/,
    );
    assert.throws(
      () => resolveFissionRoles({
        fission: { roles: ["cynical_customer", "cynical_customer"] },
      }, 2),
      /reviewer_roles/,
    );
  });

  it("parses effective defaults, explicit counts, UTF-8 byte bounds, and never clamps", () => {
    assert.deepEqual(parseFissionRequest("review this", { defaultReviewers: 3, maxReviewers: 5 }), { request: "review this", reviewers: 3 });
    assert.deepEqual(parseFissionRequest("2 review this", { defaultReviewers: 3, maxReviewers: 4 }), { request: "review this", reviewers: 2 });
    assert.equal(Buffer.byteLength(parseFissionRequest("é", { defaultReviewers: 2, maxReviewers: 2 }).request), 2);
    assert.equal(parseFissionRequest("x".repeat(16 * 1024), { defaultReviewers: 1, maxReviewers: 5 }).request.length, 16 * 1024);
    for (const text of ["", "2", "0 review", "1.5 review", "-1 review", "5 review"]) {
      assert.throws(() => parseFissionRequest(text, { defaultReviewers: 2, maxReviewers: 4 }));
    }
    assert.throws(() => parseFissionRequest("é".repeat(8193), { defaultReviewers: 1, maxReviewers: 5 }), /request_limit/);
    assert.throws(() => parseFissionRequest("review \ud800"), /request_utf8/);
  });

  it("selects ordered unique global routes and rejects overrides or a missing judge", () => {
    const cfg = {
      fission: {
        models: [reviewerModels[0], reviewerModels[1], reviewerModels[0], reviewerModels[2]],
        judgeModel,
        reviewerEfforts: ["high", "low", "medium"],
        judgeEffort: "max",
      },
    };
    assert.deepEqual(resolveFissionModels(cfg, 3), {
      reviewerModels: reviewerModels.slice(0, 3),
      judgeModel,
      reviewerEfforts: ["high", "low", "medium"],
      judgeEffort: "max",
    });
    assert.throws(() => resolveFissionModels(cfg, 4), /reviewer_models/);
    assert.throws(() => resolveFissionModels({ fission: { models: reviewerModels } }, 3), /judge_model/);
    assert.throws(() => resolveFissionModels(cfg, 2, { models: ["evil/override"] }), /override/);
  });

  it("builds exact sorted unique observability-only model diversity", () => {
    assert.deepEqual(buildModelDiversity({
      requestedModels: ["xai/grok", "anthropic/opus", "xai/grok"],
      actualModels: [null, "openai-codex/gpt", "anthropic/opus", "openai-codex/gpt"],
      modelFamilies: { "anthropic/opus": "claude", "openai-codex/gpt": "gpt" },
    }), {
      requestedModels: ["anthropic/opus", "xai/grok"],
      actualModels: ["anthropic/opus", "openai-codex/gpt"],
      providers: ["anthropic", "openai-codex"],
      families: ["claude", "gpt"],
      exactModelCount: 2,
      providerCount: 2,
      familyCount: 2,
    });
  });

  it("creates fully populated terminal results", () => {
    const result = createFissionResult({ request: "review", requestedReviewers: 2, error: "refused" });
    assertCompleteShape(result);
    assert.equal(result.kind, "fission");
    assert.equal(result.runDir, null);
    assert.deepEqual(result.reviewers, []);
    assert.deepEqual(result.modelDiversity, buildModelDiversity({}));
  });
});

describe("Fission coordinator", () => {
  it("validates programmatic reviewer counts before preflight or run creation", async () => {
    for (const reviewers of [0, 1.5, 5]) {
      const { deps, calls } = makeDeps();
      const result = await runFissionWithDependencies({ request: "review", reviewers, defaultReviewers: 2, maxReviewers: 4 }, deps);
      assertCompleteShape(result);
      assert.equal(result.error, "reviewer_limit");
      assert.equal(result.requestedReviewers, reviewers);
      assert.equal(calls.preflight, 0);
      assert.equal(calls.createRunDir, 0);
    }
  });

  it("rejects non-round-tripping direct requests before preflight or run creation", async () => {
    const { deps, calls } = makeDeps();
    const result = await runFissionWithDependencies({ request: "review \udfff", reviewers: 1 }, deps);
    assert.equal(result.error, "request_utf8");
    assert.equal(calls.preflight, 0);
    assert.equal(calls.createRunDir, 0);
  });

  it("returns pre-aborted calls without Git, run creation, or artifacts", async () => {
    const caller = new AbortController();
    caller.abort("operator_cancelled");
    const { deps, calls } = makeDeps();
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      signal: caller.signal,
    }, deps);

    assert.equal(result.status, "ABORTED");
    assert.equal(result.error, "aborted");
    assert.equal(calls.preflight, 0);
    assert.equal(calls.createRunDir, 0);
    assert.equal(calls.capture, 0);
  });

  it("uses the supplied effective default and direct runFission preserves explicit counts", async () => {
    for (const reviewers of [undefined, 1, 2, 3]) {
      const { deps } = makeDeps({ preflight: { state: "NO_CHANGES", repoRoot: "/repo" } });
      const opts = {
        request: "review",
        fissionMode: "repo",
        defaultReviewers: 2,
        maxReviewers: 3,
        ...(reviewers === undefined ? {} : { reviewers }),
      };
      const result = await runFission(opts, deps);
      assert.equal(result.requestedReviewers, reviewers ?? 2);
      assert.equal(result.status, "NO_CHANGES");
      assert.equal(result.mode, "repo");
    }
  });

  it("runs pure preflight before writes and creates no artifacts for every early state", async () => {
    for (const preflight of [
      { state: "REFUSED", reason: "untrusted_project" },
      { state: "REFUSED", reason: "not_repository" },
      { state: "REFUSED", reason: "unborn_head" },
      { state: "REFUSED", reason: "unmerged_index" },
      { state: "NO_CHANGES", repoRoot: "/repo" },
    ]) {
      const { deps, calls } = makeDeps({ preflight });
      const result = await runFissionWithDependencies({
        request: "review",
        fissionMode: "repo",
        defaultReviewers: 1,
        maxReviewers: 5,
      }, deps);
      assertCompleteShape(result);
      assert.equal(result.runDir, null);
      assert.equal(result.mode, "repo");
      assert.equal(calls.preflight, 1);
      assert.equal(calls.createRunDir, 0);
      assert.equal(calls.capture, 0);
    }
  });

  it("auto mode falls back to subject when the tree is not a ready dirty repo", async () => {
    for (const preflight of [
      { state: "REFUSED", reason: "not_repository" },
      { state: "REFUSED", reason: "untrusted_project" },
      { state: "NO_CHANGES", repoRoot: "/repo" },
    ]) {
      let subjectCaptures = 0;
      const { deps, calls } = makeDeps({
        preflight,
        deps: {
          captureFissionSubjectPacket: ({ request, packetRoot }) => {
            subjectCaptures++;
            assert.equal(request, "Critique this product plan");
            return {
              kind: "subject",
              packetRoot,
              packetDigest: "d".repeat(64),
              sourceDigest: "e".repeat(64),
              evidenceComplete: true,
              reason: null,
              manifest: {
                kind: "subject",
                entries: [{ path: "subject.md", artifactPath: "subject.md" }],
              },
              artifacts: {},
            };
          },
        },
      });
      const result = await runFissionWithDependencies({
        request: "Critique this product plan",
        reviewers: 1,
        defaultReviewers: 1,
        maxReviewers: 5,
      }, deps);
      assert.equal(result.mode, "subject");
      assert.notEqual(result.status, "REFUSED");
      assert.notEqual(result.error, "not_repository");
      assert.equal(subjectCaptures, 1);
      assert.equal(calls.capture, 0); // repo capture unused
      assert.equal(calls.createRunDir, 1);
    }
  });

  it("auto mode falls back to subject when dirty-tree evidence is incomplete", async () => {
    let subjectCaptures = 0;
    const { deps, calls } = makeDeps({
      preflight: {
        state: "READY",
        repoRoot: "/repo",
        head: Buffer.from("head\n"),
        status: Buffer.from("?? .worktrees/feat/local-engines/\0"),
      },
      packet: {
        evidenceComplete: false,
        reason: "unsupported_type:.worktrees/feat/local-engines/",
        manifest: { entries: [] },
        artifacts: {},
      },
      deps: {
        captureFissionSubjectPacket: ({ packetRoot }) => {
          subjectCaptures++;
          return {
            kind: "subject",
            packetRoot,
            packetDigest: "d".repeat(64),
            sourceDigest: "e".repeat(64),
            evidenceComplete: true,
            reason: null,
            manifest: {
              kind: "subject",
              entries: [{ path: "subject.md", artifactPath: "subject.md", included: true }],
            },
            artifacts: {
              "subject.md": {
                type: "file",
                path: "subject.md",
                digest: "a".repeat(64),
                size: 20,
                lineCount: 2,
                mode: 0o400,
              },
            },
          };
        },
      },
      runChild: (input) => {
        if (input.role === "fission-judge") {
          return childResult(input.model, { clusters: [], judgeConcern: null });
        }
        return childResult(input.model, {
          reviewerRole: input.role.replace("fission-reviewer-", ""),
          coverage: ["subject"],
          findings: [],
          errors: [],
        });
      },
    });
    const result = await runFissionWithDependencies({
      request: "List three security risks of email-only free tier auth.",
      fissionMode: "auto",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, deps);
    assert.equal(result.mode, "subject");
    assert.equal(subjectCaptures, 1);
    assert.equal(calls.capture, 1);
    assert.equal(result.status, "COMPLETE");
  });

  it("subject mode skips git preflight entirely", async () => {
    let subjectCaptures = 0;
    const subjectDigest = "a".repeat(64);
    const subjectPacket = {
      kind: "subject",
      packetDigest: "d".repeat(64),
      sourceDigest: "e".repeat(64),
      evidenceComplete: true,
      reason: null,
      manifest: {
        kind: "subject",
        entries: [{
          path: "subject.md",
          artifactPath: "subject.md",
          included: true,
        }],
      },
      artifacts: {
        "subject.md": {
          type: "file",
          path: "subject.md",
          digest: subjectDigest,
          size: 20,
          lineCount: 3,
          mode: 0o400,
        },
      },
    };
    const { deps, calls } = makeDeps({
      deps: {
        captureFissionSubjectPacket: ({ packetRoot }) => {
          subjectCaptures++;
          return { ...subjectPacket, packetRoot };
        },
      },
      runChild: (input) => {
        if (input.role === "fission-judge") {
          return childResult(input.model, { clusters: [], judgeConcern: null });
        }
        return childResult(input.model, {
          reviewerRole: "general_adversarial",
          coverage: ["subject"],
          findings: [],
          errors: [],
        });
      },
    });
    const result = await runFissionWithDependencies({
      request: "Review this idea for risks",
      fissionMode: "subject",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, deps);
    assert.equal(result.mode, "subject");
    assert.equal(calls.preflight, 0);
    assert.equal(subjectCaptures, 1);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.verdict, "PASS");
  });

  it("creates one run only for READY and persists unsupported packet evidence as INCOMPLETE", async () => {
    const { deps, calls, runRoot } = makeDeps({ packet: { evidenceComplete: false, reason: "binary:asset.bin" } });
    // Explicit repo mode: incomplete dirty-tree evidence stays fail-closed (no subject fallback).
    const result = await runFissionWithDependencies({
      request: "review",
      fissionMode: "repo",
      defaultReviewers: 1,
      maxReviewers: 5,
    }, deps);
    assertCompleteShape(result);
    assert.equal(calls.createRunDir, 1);
    assert.equal(calls.capture, 1);
    assert.equal(calls.children.length, 0);
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "binary:asset.bin");
    assert.equal(JSON.parse(readFileSync(join(runRoot, "terminal", "result.json"), "utf8")).status, "INCOMPLETE");
  });

  it("returns a structured failure when run artifacts cannot be written", async () => {
    const state = makeDeps({ deps: {
      saveArtifact: () => { throw new Error("disk full"); },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "artifact_write_failed");
    assert.equal(state.calls.children.length, 0);
  });

  it("returns a structured failure when the run directory cannot be created", async () => {
    const state = makeDeps({ deps: {
      createRunDir: () => { throw new Error("disk full"); },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "artifact_write_failed");
    assert.equal(result.runDir, null);
    assert.equal(state.calls.children.length, 0);
  });

  it("fails closed when mid-run or terminal artifact persistence fails", async () => {
    for (const failedName of ["dispositions.json", "host-manifest.json", "report.md", "result.json"]) {
      const state = makeDeps({ deps: {
        saveArtifact: (runDir, name, value) => {
          if (name === failedName) throw new Error("disk full");
          const body = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
          writeFileSync(join(runDir, name), body);
        },
      } });
      const result = await runFissionWithDependencies({
        request: "review",
        reviewers: 1,
        defaultReviewers: 1,
        maxReviewers: 5,
      }, state.deps);

      assert.equal(result.status, "INCOMPLETE", failedName);
      assert.equal(result.error, "artifact_write_failed", failedName);
      assert.equal(result.verdict, "INCOMPLETE", failedName);
      assert.equal(existsSync(join(state.runRoot, "terminal")), false, failedName);
    }
  });

  it("publishes no terminal artifacts when the atomic directory commit fails", async () => {
    const state = makeDeps({ deps: {
      commitTerminalArtifacts: () => { throw new Error("rename failed"); },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "artifact_write_failed");
    assert.equal(existsSync(join(state.runRoot, "terminal")), false);
    assert.equal(readdirSync(state.runRoot).some((name) => name.startsWith(".terminal-attempt-")), false);
  });

  it("fails closed on parent sandbox and route configuration after READY", async () => {
    const sandbox = makeDeps();
    const denied = await runFissionWithDependencies({ request: "review", defaultReviewers: 1, maxReviewers: 5, parentSandbox: true }, sandbox.deps);
    assert.equal(denied.error, "sandbox_model_egress_unavailable");
    assertCompleteShape(denied);

    const missing = makeDeps({ deps: { loadConfig: () => ({ orchestration: { enabled: true, maxConcurrency: 2 }, budgets: { maxCostUsd: 5 }, fission: { models: reviewerModels } }) } });
    const invalid = await runFissionWithDependencies({ request: "review", defaultReviewers: 1, maxReviewers: 5 }, missing.deps);
    assert.equal(invalid.error, "judge_model");
    assert.equal(missing.calls.children.length, 0);
  });

  it("launches blind packet-root reviewers with bounded refill, then verifies C before judge", async () => {
    const pending = [];
    let active = 0;
    let maximum = 0;
    const state = makeDeps({
      runningCount: () => active + 1,
      runChild: (input) => new Promise((resolve) => {
        active++;
        maximum = Math.max(maximum, active);
        pending.push(() => {
          active--;
          if (input.role === "fission-judge") resolve(childResult(input.model, { clusters: [], judgeConcern: null }));
          else resolve(childResult(input.model, reviewerOutput(input.role.replace("fission-reviewer-", ""))));
        });
      }),
    });
    const running = runFissionWithDependencies({ request: "review", reviewers: 5, defaultReviewers: 3, maxReviewers: 5 }, state.deps);
    for (let index = 0; index < 5; index++) {
      while (pending.length <= index) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(active, 1, "existing reservation leaves one workflow slot");
      pending[index]();
    }
    while (pending.length < 6) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.calls.recapture >= 1, true);
    assert.equal(state.calls.verify >= 6, true);
    pending[5]();
    const result = await running;
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.verdict, "PASS");
    assert.equal(maximum, 1);
    assert.equal(state.calls.settle.length, 6);
    for (const child of state.calls.children.slice(0, 5)) {
      assert.equal(child.cwd, packet.packetRoot.replace("/run/packet", join(state.runRoot, "packet")));
      assert.equal(child.readRoot, child.cwd);
      assert.deepEqual(child.tools, ["read", "grep", "find", "ls"]);
      assert.equal(child.mode, "review");
      assert.equal(child.maxOutputBytes, 256 * 1024);
      assert.equal(child.thinkingLevel, null);
      assert.doesNotMatch(child.prompt, /anthropic\/opus|openai-codex\/gpt|reviewer-[1-5]/);
      assert.doesNotMatch(child.prompt, /R0[1-5]|fission-reviewer|sibling|peer/i);
      for (const required of [
        '"general_adversarial"', '"performance_concurrency_resources"',
        '"critical"', '"low"', '"staged_diff"', '"unstaged_diff"', '"file"',
        '"maxItems":50', '"maxItems":20', '"maxLength":8192', '"maxLength":4096',
        '"errors"', '"artifactDigest"', '"lineStart"', '"lineEnd"',
        'Review only review-packet.json entries whose included field is true',
        'Entries with included:false are declared packet exclusions',
        'must not by themselves be reported in errors',
        'Use errors only when a required included artifact cannot be inspected',
        'affectedPath must exactly equal an included path',
        'entirely within one diff section owned by affectedPath',
        'Concrete valid JSON example',
      ]) assert.equal(child.prompt.includes(required), true, required);
    }
    assert.equal(state.calls.children.at(-1).thinkingLevel, null);
    const judgePrompt = state.calls.children.at(-1).prompt;
    assert.doesNotMatch(judgePrompt, /anthropic\/judge|R0[1-5]|fission-judge|sibling|peer/i);
    for (const required of [
      '"validated"', '"rejected"', '"needs_probe"', '"human_decision"',
      '"adjudicatedSeverity"', '"null"', '"judgeConcern"', '"evidenceRefs"',
      '"maxItems":50', '"maxItems":20', '"maxLength":8192', '"maxLength":4096',
      'owned by at least one member finding affectedPath',
      'Concrete valid JSON example',
    ]) assert.equal(judgePrompt.includes(required), true, required);
  });

  it("forwards per-reviewer and judge effort as thinkingLevel", async () => {
    const { deps, calls, runRoot } = makeDeps({
      reviewerEfforts: ["high", "low"],
      judgeEffort: "medium",
    });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 2,
      defaultReviewers: 2,
      maxReviewers: 2,
    }, deps);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.verdict, "PASS");
    const reviewers = calls.children.filter((child) => child.role.startsWith("fission-reviewer-"));
    assert.equal(reviewers.length, 2);
    assert.equal(reviewers[0].thinkingLevel, "high");
    assert.equal(reviewers[1].thinkingLevel, "low");
    const judge = calls.children.find((child) => child.role === "fission-judge");
    assert.equal(judge.thinkingLevel, "medium");
    const manifest = JSON.parse(readFileSync(join(runRoot, "launch-manifest.json"), "utf8"));
    assert.deepEqual(manifest.reviewerEfforts, ["high", "low"]);
    assert.equal(manifest.judgeEffort, "medium");
  });

  it("fails reviewers closed for child, schema, attestation, diversity, usage, and budget failures", async () => {
    const cases = [
      [() => { throw new Error("boom"); }, "child_failed"],
      [(input) => childResult(input.model, {}, { ok: false, error: "timeout" }), "timeout"],
      [(input) => childResult(input.model, reviewerOutput("general_adversarial"), { ok: false, error: "aborted" }), "aborted"],
      [(input) => childResult(input.model, reviewerOutput("general_adversarial"), { ok: false, error: "output_limit" }), "output_limit"],
      [(input) => childResult(input.model, { broken: true }), "reviewer_schema"],
      // errors[] with zero findings remains a hard fail
      [(input) => childResult(input.model, { ...reviewerOutput("general_adversarial"), errors: ["could not inspect"] }), "reviewer_errors"],
      [(input) => childResult(input.model, reviewerOutput("general_adversarial"), { actualModel: null }), "actual_model_missing"],
      [(input) => childResult(input.model, reviewerOutput("general_adversarial"), { actualModel: "other/model" }), "actual_model_mismatch"],
      [(input) => childResult(input.model, reviewerOutput("general_adversarial"), { usage: { cost: null, costKnown: false } }), "budget_usage_unavailable"],
    ];
    for (const [runChild, error] of cases) {
      const { deps, calls } = makeDeps({ runChild });
      const result = await runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5 }, deps);
      assert.equal(result.status === "ABORTED" || result.status === "INCOMPLETE", true);
      assert.equal(result.error, error);
      assert.equal(calls.children.some((child) => child.role === "fission-judge"), false);
      assert.equal(calls.settle.length, calls.reserve.length);
    }

    let call = 0;
    const duplicate = makeDeps({ runChild: (input) => {
      if (input.role === "fission-judge") return assert.fail("judge must not run");
      call++;
      return childResult(input.model, reviewerOutput(input.role.replace("fission-reviewer-", "")), { actualModel: reviewerModels[0] });
    } });
    const result = await runFissionWithDependencies({ request: "review", reviewers: 2, defaultReviewers: 2, maxReviewers: 5 }, duplicate.deps);
    assert.equal(result.error, "actual_model_mismatch");
  });

  it("keeps findings when errors[] only notes soft-omitted packet paths", async () => {
    const panels = [];
    const { deps, calls } = makeDeps({
      runChild: (input) => {
        if (input.role === "fission-judge") {
          const submitted = JSON.parse(input.prompt.trim().split("\n").at(-1)).findings;
          const ids = submitted.map((item) => item.id);
          const ref = {
            artifactPath: "unstaged.diff",
            artifactDigest: digest,
            lineStart: 1,
            lineEnd: 1,
          };
          return childResult(input.model, {
            clusters: ids.length
              ? [{
                  canonicalFindingId: ids[0],
                  findingIds: ids,
                  disposition: "rejected",
                  adjudicatedSeverity: null,
                  rationale: "not a real defect after adjudication",
                  evidenceRefs: [ref],
                }]
              : [],
            judgeConcern: null,
          });
        }
        const role = input.role.replace("fission-reviewer-", "");
        return childResult(input.model, {
          ...reviewerOutput(role, ["real finding on the dirty tree"]),
          errors: [
            "The packet lists .worktrees/feat/local-engines/ as an untracked directory with included:false so its contents could not be inspected",
          ],
        });
      },
    });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      onPanel: (panel) => {
        panels.push({
          phase: panel.phase,
          agents: (panel.agents || []).map((agent) => ({
            role: agent.role,
            index: agent.index,
            status: agent.status,
          })),
        });
      },
    }, deps);
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.verdict, "PASS");
    assert.equal(result.error, null);
    assert.equal(result.reviewers[0].status, "ok");
    assert.deepEqual(result.reviewers[0].warnings, [
      "The packet lists .worktrees/feat/local-engines/ as an untracked directory with included:false so its contents could not be inspected",
    ]);
    assert.equal(calls.children.some((child) => child.role === "fission-judge"), true);
    assert.equal(typeof calls.children[0].onEvent, "function");
    assert.equal(typeof calls.children.find((c) => c.role === "fission-judge")?.onEvent, "function");
    assert.ok(panels.length > 0, "live panel should stream during the run");
    assert.ok(panels.some((p) => p.phase === "REVIEW" || p.agents.some((a) => a.role === "reviewer")));
  });

  it("settles an output-limited reviewer with all provider-reported crossing-turn usage", async () => {
    const usage = { input: 30, output: 6, cost: 0.34, turns: 2, costKnown: true };
    const state = makeDeps({
      runChild: (input) => childResult(input.model, reviewerOutput("general_adversarial"), {
        ok: false,
        error: "output_limit",
        usage,
      }),
    });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, state.deps);
    assert.equal(result.error, "output_limit");
    assert.deepEqual(state.calls.settle[0].usage, usage);
  });

  it("aborts a waiting reviewer on terminal sibling failure before all reservations settle", async () => {
    let waitingAborted = false;
    const state = makeDeps({ runChild: (input, index) => {
      if (index === 0) return new Promise((resolve) => setImmediate(() => {
        resolve(childResult(input.model, {}, { ok: false, error: "timeout" }));
      }));
      return new Promise((resolve) => {
        input.signal.addEventListener("abort", () => {
          waitingAborted = true;
          resolve(childResult(input.model, {}, { ok: false, error: "aborted" }));
        }, { once: true });
      });
    } });
    const result = await runFissionWithDependencies({ request: "review", reviewers: 2, defaultReviewers: 2, maxReviewers: 5 }, state.deps);
    assert.equal(waitingAborted, true);
    assert.equal(result.error, "timeout");
    assert.equal(state.calls.settle.length, 2);
  });

  it("detects C source or packet drift before judge, including HEAD-only source drift", async () => {
    for (const options of [
      { recapture: [{ ok: false, reason: "source_drift", digest: "head-only" }] },
      { verify: [{ ok: true, mismatches: [] }, { ok: false, mismatches: ["content:head.txt"] }] },
    ]) {
      const state = makeDeps(options);
      const result = await runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5 }, state.deps);
      assert.equal(result.status, "INCOMPLETE");
      assert.equal(state.calls.children.some((child) => child.role === "fission-judge"), false);
    }
  });

  it("fails judge closed and detects D drift", async () => {
    const cases = [
      [(input) => input.role === "fission-judge" ? childResult(input.model, {}, { ok: false, error: "timeout" }) : childResult(input.model, reviewerOutput("general_adversarial")), "timeout"],
      [(input) => input.role === "fission-judge" ? childResult(input.model, { clusters: [], judgeConcern: null }, { actualModel: null }) : childResult(input.model, reviewerOutput("general_adversarial")), "actual_model_missing"],
      [(input) => input.role === "fission-judge" ? childResult(input.model, { clusters: [], judgeConcern: null }, { actualModel: "other/judge" }) : childResult(input.model, reviewerOutput("general_adversarial")), "actual_model_mismatch"],
      [(input) => input.role === "fission-judge" ? childResult(input.model, { clusters: [], judgeConcern: { claim: "new", rationale: "inspect", evidenceRefs: [{ artifactPath: "unstaged.diff", artifactDigest: digest, lineStart: 1, lineEnd: 1 }] } }) : childResult(input.model, reviewerOutput("general_adversarial")), "judge_concern"],
    ];
    for (const [runChild, error] of cases) {
      const state = makeDeps({ runChild });
      const result = await runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5 }, state.deps);
      assert.equal(result.status, "INCOMPLETE");
      assert.equal(result.error, error);
      if (error !== "judge_concern") {
        const judgeCall = state.calls.children.find((child) => child.role === "fission-judge");
        assert.equal(judgeCall.signal.aborted, true);
      }
    }

    const drift = makeDeps({ recapture: [{ ok: true }, { ok: false, reason: "source_drift" }] });
    const drifted = await runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5 }, drift.deps);
    assert.equal(drifted.status, "INCOMPLETE");
    assert.equal(drifted.error, "source_drift");
  });

  it("fails closed and rewrites judge artifacts when judge settlement throws", async () => {
    const state = makeDeps();
    const settle = state.deps.settleAgentLaunch;
    state.deps.settleAgentLaunch = (reservation, usage) => {
      settle(reservation, usage);
      if (reservation.id === "r2") throw new Error("synthetic settlement failure");
    };

    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.verdict, "INCOMPLETE");
    assert.equal(result.error, "settlement_failed");
    assert.equal(result.judge.valid, false);
    assert.equal(result.judge.status, "fail");
    assert.equal(result.judge.error, "settlement_failed");
    assert.equal(state.calls.settle.filter(({ reserved }) => reserved.id === "r2").length, 1);
    assert.equal(state.calls.children.find((child) => child.role === "fission-judge").signal.aborted, true);
    assert.equal(JSON.parse(readFileSync(join(state.runRoot, "judge.json"), "utf8")).valid, false);
    assert.equal(JSON.parse(readFileSync(join(state.runRoot, "terminal", "result.json"), "utf8")).error, "settlement_failed");
    assert.equal(JSON.parse(readFileSync(join(state.runRoot, "terminal", "host-manifest.json"), "utf8")).error, "settlement_failed");
  });

  it("propagates caller cancellation through judge cleanup and settles judge exactly once", async () => {
    const caller = new AbortController();
    let judgeSawAbort = false;
    const state = makeDeps({ runChild: (input) => {
      if (input.role !== "fission-judge") {
        return childResult(input.model, reviewerOutput("general_adversarial"));
      }
      return new Promise((resolve) => {
        input.signal.addEventListener("abort", () => {
          judgeSawAbort = true;
          resolve(childResult(input.model, {}, { ok: false, error: "aborted" }));
        }, { once: true });
      });
    } });
    const running = runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      signal: caller.signal,
    }, state.deps);
    while (!state.calls.children.some((child) => child.role === "fission-judge")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    caller.abort("operator_cancelled");
    const result = await running;

    assert.equal(judgeSawAbort, true);
    assert.equal(result.status, "ABORTED");
    assert.equal(result.error, "aborted");
    assert.equal(result.judge.valid, false);
    assert.equal(result.judge.error, "aborted");
    assert.equal(state.calls.settle.filter(({ reserved }) => reserved.id === "r2").length, 1);
    assert.equal(JSON.parse(readFileSync(join(state.runRoot, "terminal", "result.json"), "utf8")).status, "ABORTED");
  });

  it("applies one workflow deadline across reviewer and judge work", async () => {
    const state = makeDeps({ runChild: (input) => new Promise((resolve) => {
      input.signal.addEventListener("abort", () => {
        resolve(childResult(input.model, {}, { ok: false, error: "aborted" }));
      }, { once: true });
    }) });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      timeoutMs: 10,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "workflow_timeout");
    assert.equal(state.calls.children.length, 1);
    assert.equal(state.calls.settle.length, 1);
  });

  it("bounds a stalled exact-route preparation by the workflow deadline", { timeout: 1_000 }, async () => {
    const state = makeDeps({ deps: {
      prepareExactAgentLaunch: () => new Promise(() => {}),
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      timeoutMs: 10,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "workflow_timeout");
    assert.equal(state.calls.children.length, 0);
  });

  it("rechecks caller cancellation immediately before deriving a verdict", async () => {
    const caller = new AbortController();
    const state = makeDeps({ deps: {
      recaptureFissionSource: () => {
        state.calls.recapture++;
        if (state.calls.recapture === 2) caller.abort("operator_cancelled");
        return { ok: true, digest: packet.sourceDigest };
      },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      signal: caller.signal,
    }, state.deps);

    assert.equal(result.status, "ABORTED");
    assert.equal(result.error, "aborted");
    assert.equal(result.verdict, null);
  });

  it("rechecks caller cancellation after final packet verification", async () => {
    const caller = new AbortController();
    const state = makeDeps({ deps: {
      verifyFissionArtifacts: () => {
        state.calls.verify++;
        if (state.calls.verify === 3) caller.abort("operator_cancelled");
        return { ok: true, mismatches: [] };
      },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      signal: caller.signal,
    }, state.deps);

    assert.equal(result.status, "ABORTED");
    assert.equal(result.error, "aborted");
  });

  it("rechecks the deadline after synchronous final verification", async () => {
    const state = makeDeps({ deps: {
      recaptureFissionSource: () => {
        state.calls.recapture++;
        if (state.calls.recapture === 2) {
          const until = Date.now() + 20;
          while (Date.now() < until) {}
        }
        return { ok: true, digest: packet.sourceDigest };
      },
    } });
    const result = await runFissionWithDependencies({
      request: "review",
      reviewers: 1,
      defaultReviewers: 1,
      maxReviewers: 5,
      timeoutMs: 10,
    }, state.deps);

    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.error, "workflow_timeout");
    assert.equal(result.verdict, "INCOMPLETE");
  });

  it("normalizes validated, rejected, needs-probe, human-decision, and duplicate members", async () => {
    const claims = ["validated canonical", "validated duplicate", "rejected canonical", "rejected duplicate", "probe", "human"];
    let ids;
    const state = makeDeps({ runChild: (input) => {
      if (input.role !== "fission-judge") return childResult(input.model, reviewerOutput("general_adversarial", claims));
      ids = JSON.parse(input.prompt.trim().split("\n").at(-1)).findings.map((item) => item.id);
      const ref = { artifactPath: "unstaged.diff", artifactDigest: digest, lineStart: 1, lineEnd: 1 };
      return childResult(input.model, {
        clusters: [
          { canonicalFindingId: ids[0], findingIds: [ids[1], ids[0]], disposition: "validated", adjudicatedSeverity: "high", rationale: "valid", evidenceRefs: [ref] },
          { canonicalFindingId: ids[2], findingIds: [ids[3], ids[2]], disposition: "rejected", adjudicatedSeverity: null, rationale: "wrong", evidenceRefs: [] },
          { canonicalFindingId: ids[4], findingIds: [ids[4]], disposition: "needs_probe", adjudicatedSeverity: null, rationale: "probe", evidenceRefs: [] },
          { canonicalFindingId: ids[5], findingIds: [ids[5]], disposition: "human_decision", adjudicatedSeverity: null, rationale: "human", evidenceRefs: [] },
        ],
        judgeConcern: null,
      });
    } });
    const result = await runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5 }, state.deps);
    assert.equal(result.verdict, "INCOMPLETE");
    assert.deepEqual(result.validatedFindings.map((item) => item.clusterId), ["C0001"]);
    assert.deepEqual(result.validatedFindings[0].memberFindingIds, [ids[0], ids[1]].sort((a, b) => a === ids[0] ? -1 : b === ids[0] ? 1 : a.localeCompare(b)));
    assert.deepEqual(result.rejectedFindings.map((item) => item.disposition), ["duplicate", "rejected", "duplicate"]);
    assert.deepEqual(result.unresolvedFindings.map((item) => item.disposition), ["needs_probe", "human_decision"]);
    assert.equal(result.clusters.length, 4);
  });

  it("returns FAIL only for validated blocking findings and narrow PASS otherwise; families never alter verdict", async () => {
    const execute = async (severity, modelFamilies, blockingSeverity = "high") => {
      let submittedId;
      const state = makeDeps({ modelFamilies, runChild: (input) => {
        if (input.role !== "fission-judge") return childResult(input.model, reviewerOutput("general_adversarial", severity ? ["claim"] : []));
        const payload = JSON.parse(input.prompt.trim().split("\n").at(-1));
        submittedId = payload.findings[0]?.id;
        return childResult(input.model, {
          clusters: submittedId ? [{
            canonicalFindingId: submittedId,
            findingIds: [submittedId],
            disposition: "validated",
            adjudicatedSeverity: severity,
            rationale: "valid",
            evidenceRefs: [{ artifactPath: "unstaged.diff", artifactDigest: digest, lineStart: 1, lineEnd: 1 }],
          }] : [],
          judgeConcern: null,
        });
      } });
      return runFissionWithDependencies({ request: "review", reviewers: 1, defaultReviewers: 1, maxReviewers: 5, blockingSeverity }, state.deps);
    };
    const fail = await execute("high", { "anthropic/opus": "family-a" });
    assert.equal(fail.verdict, "FAIL");
    const mediumFail = await execute("medium", {}, "medium");
    const mediumPass = await execute("medium", {}, "high");
    assert.equal(mediumFail.verdict, "FAIL");
    assert.equal(mediumPass.verdict, "PASS");
    const passA = await execute(null, { "anthropic/opus": "family-a" });
    const passB = await execute(null, { "anthropic/opus": "family-b" });
    assert.equal(passA.verdict, "PASS");
    assert.equal(passA.message, "no submitted blocking finding validated.");
    assert.equal(passB.verdict, passA.verdict);
    assert.notDeepEqual(passA.modelDiversity.families, passB.modelDiversity.families);
  });
});
