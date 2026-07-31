import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  evaluateDogfoodResults,
  materializeDogfoodFixtures,
  validateDogfoodManifest,
} from "../../scripts/fission-dogfood.mjs";
import { loadProviderCatalogIds } from "../../lib/model-catalog.mjs";
import { findingId } from "../../lib/fission-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(root, "test/fixtures/fission-dogfood");
const manifestPath = join(fixtureRoot, "manifest.json");
const expectedIds = [
  "correctness-stale-cache",
  "correctness-partial-write",
  "security-path-traversal",
  "security-tenant-bypass",
  "failure-handling-reservation-leak",
  "failure-handling-cancellation-reported-as-success",
  "control-cache-invalidation",
  "control-contained-upload",
  "control-finally-settlement",
];

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function treeDigest(path) {
  const hash = createHash("sha256");
  const visit = (current, relative = "") => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = statSync(absolute);
      hash.update(`${child}\0${stat.isDirectory() ? "d" : "f"}\0`);
      if (stat.isDirectory()) visit(absolute, child);
      else hash.update(readFileSync(absolute));
    }
  };
  visit(path);
  return hash.digest("hex");
}

function normalizedFinding(caseEntry, overrides = {}) {
  const expected = caseEntry.expectedFindings[0];
  return {
    clusterId: "C0001",
    canonicalFindingId: "F1234567890abcdef12345678",
    memberFindingIds: ["F1234567890abcdef12345678"],
    affectedPath: expected.affectedPath,
    location: {
      artifact: "unstaged_diff",
      artifactPath: "unstaged.diff",
      lineStart: expected.lineStart ?? 1,
      lineEnd: expected.lineEnd ?? 1,
      artifactDigest: "a".repeat(64),
    },
    claim: "Text is intentionally irrelevant to seed matching.",
    adjudicatedSeverity: "high",
    rationale: "The judge validated the submitted evidence.",
    evidenceRefs: [{
      artifactPath: "unstaged.diff",
      artifactDigest: "a".repeat(64),
      lineStart: expected.lineStart ?? 1,
      lineEnd: expected.lineEnd ?? 1,
    }],
    ...overrides,
  };
}

function resultFor(caseEntry, overrides = {}) {
  const reviewerModels = [
    "anthropic/claude-sonnet-4-6",
    "openai-codex/gpt-5.4",
    "xai/grok-4.5",
    "google/gemini-2.5-pro",
    "openrouter/deepseek/deepseek-r1",
  ];
  const control = caseEntry.control;
  const roles = [
    "correctness_regressions",
    "security_trust_boundaries",
    "architecture_failure_handling",
    "test_quality_spec_coverage",
    "performance_concurrency_resources",
  ];
  const rawFinding = control ? null : {
    severity: "high",
    claim: "Text is intentionally irrelevant to seed matching.",
    affectedPath: caseEntry.expectedFindings[0].affectedPath,
    location: normalizedFinding(caseEntry).location,
    evidence: "The accepted patch contains the seeded behavior.",
    reproduction: "Exercise the contract against the changed tree.",
    suggestedFix: "Restore the safe base behavior.",
    confidence: 0.95,
  };
  const validatedFindings = control ? [] : [normalizedFinding(caseEntry, {
    canonicalFindingId: findingId("R01", 0, rawFinding),
    memberFindingIds: [findingId("R01", 0, rawFinding)],
  })];
  const judgeClusters = validatedFindings.map((finding) => ({
    canonicalFindingId: finding.canonicalFindingId,
    findingIds: finding.memberFindingIds,
    disposition: "validated",
    adjudicatedSeverity: finding.adjudicatedSeverity,
    rationale: finding.rationale,
    evidenceRefs: finding.evidenceRefs,
  }));
  const clusters = judgeClusters.map((cluster, index) => ({
    clusterId: `C${String(index + 1).padStart(4, "0")}`,
    ...cluster,
  }));
  const usage = { input: 10, output: 5, cost: 0.1, turns: 1, costKnown: true };
  const requestedModels = [...reviewerModels, "anthropic/claude-opus-4-6"].sort();
  return {
    kind: "fission",
    runId: `dogfood-${caseEntry.id}`,
    runDir: `/tmp/alloy-fission/${caseEntry.id}`,
    status: "COMPLETE",
    verdict: control ? "PASS" : "FAIL",
    message: control
      ? "no submitted blocking finding validated."
      : "a submitted blocking finding was validated.",
    request: `Review ${caseEntry.id} against its contract.`,
    requestedReviewers: 5,
    blockingSeverity: "high",
    packetDigest: "b".repeat(64),
    sourceDigest: "c".repeat(64),
    evidenceComplete: true,
    reviewers: reviewerModels.map((model, index) => ({
      alias: `R${String(index + 1).padStart(2, "0")}`,
      role: roles[index],
      requestedModel: model,
      actualModel: model,
      status: "ok",
      valid: true,
      malformed: false,
      output: {
        reviewerRole: roles[index],
        coverage: [`coverage:${roles[index]}`],
        findings: index === 0 && rawFinding ? [rawFinding] : [],
        errors: [],
      },
      error: null,
      usage,
    })),
    judge: {
      requestedModel: "anthropic/claude-opus-4-6",
      actualModel: "anthropic/claude-opus-4-6",
      status: "ok",
      valid: true,
      malformed: false,
      output: { clusters: judgeClusters, judgeConcern: null },
      error: null,
      usage,
    },
    clusters,
    validatedFindings,
    rejectedFindings: [],
    unresolvedFindings: [],
    modelDiversity: {
      requestedModels,
      actualModels: requestedModels,
      providers: ["anthropic", "google", "openai-codex", "openrouter", "xai"],
      families: ["unknown"],
      exactModelCount: 6,
      providerCount: 5,
      familyCount: 1,
    },
    usage: { input: 60, output: 30, cost: 0.6, turns: 6, costKnown: true },
    error: null,
    panel: [
      "ALLOY FISSION COMPLETE",
      ...roles.map((role, index) => `R${String(index + 1).padStart(2, "0")} ${role}: ok`),
      "JUDGE: ok",
    ],
    ...overrides,
  };
}

function validResults(manifest) {
  return Object.fromEntries(manifest.cases.map((entry) => [entry.id, resultFor(entry)]));
}

function resultPathsFor(manifest, results = validResults(manifest)) {
  const resultRoot = mkdtempSync(join(tmpdir(), "alloy-fission-dogfood-results-"));
  return Object.fromEntries(Object.entries(results).map(([id, result]) => {
    const path = join(resultRoot, `${id}.json`);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    return [id, path];
  }));
}

test("dogfood manifest has the exact nine strict cases and valid source trees", () => {
  const manifest = readManifest();
  assert.doesNotThrow(() => validateDogfoodManifest(manifest, fixtureRoot));
  assert.deepEqual(Object.keys(manifest), ["version", "seededBlockerCount", "cases"]);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.seededBlockerCount, 6);
  assert.deepEqual(manifest.cases.map(({ id }) => id), expectedIds);
  assert.equal(new Set(manifest.cases.map(({ id }) => id)).size, 9);

  const defects = manifest.cases.filter(({ control }) => !control);
  const controls = manifest.cases.filter(({ control }) => control);
  assert.equal(defects.length, 6);
  assert.equal(controls.length, 3);
  for (const category of ["correctness", "security", "failure-handling"]) {
    assert.equal(defects.filter((entry) => entry.category === category).length, 2);
    assert.equal(controls.filter((entry) => entry.category === category).length, 1);
  }

  for (const entry of manifest.cases) {
    assert.deepEqual(Object.keys(entry), ["id", "category", "control", "expectedFindings"]);
    assert.equal(readFileSync(join(fixtureRoot, entry.id, "contract.md"), "utf8").trim().length > 0, true);
    assert.equal(readdirSync(join(fixtureRoot, entry.id, "base")).length > 0, true);
    assert.equal(readdirSync(join(fixtureRoot, entry.id, "changed")).length > 0, true);
    if (entry.control) assert.deepEqual(entry.expectedFindings, []);
    else {
      assert.equal(entry.expectedFindings.length, 1);
      const location = entry.expectedFindings[0];
      assert.deepEqual(
        Object.keys(location),
        location.lineStart === undefined
          ? ["affectedPath"]
          : ["affectedPath", "lineStart", "lineEnd"],
      );
      if (location.lineStart !== undefined) {
        assert.equal(Number.isInteger(location.lineStart) && location.lineStart > 0, true);
        assert.equal(Number.isInteger(location.lineEnd) && location.lineEnd >= location.lineStart, true);
      }
    }
  }
});

test("safe upload fixtures use separator-aware cross-platform containment", () => {
  const safePaths = [
    "control-contained-upload/changed/subject.mjs",
    "security-path-traversal/base/subject.mjs",
  ];
  const sources = safePaths.map((path) => readFileSync(join(fixtureRoot, path), "utf8"));
  assert.equal(sources[0], sources[1]);
  for (const source of sources) {
    assert.match(source, /import \{ isAbsolute, relative, resolve, sep \} from "node:path";/);
    assert.match(source, /rel === "\.\."/);
    assert.match(source, /rel\.startsWith\(`\.\.\$\{sep\}`\)/);
    assert.match(source, /isAbsolute\(rel\)/);
  }
  const windowsRelative = `..${win32.sep}outside`;
  assert.equal(windowsRelative.startsWith(`..${win32.sep}`), true);
});

test("manifest validation rejects unknown keys, IDs, counts, and invalid locations", () => {
  const manifest = readManifest();
  const invalid = [
    { ...manifest, unknown: true },
    { ...manifest, seededBlockerCount: 5 },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, unknown: true }) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index === 1 ? { ...entry, id: manifest.cases[0].id } : entry) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, id: "unknown-case" }) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, category: "security" }) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, expectedFindings: [] }) },
    { ...manifest, cases: manifest.cases.map((entry) => entry.control ? { ...entry, expectedFindings: [{ affectedPath: "subject.mjs" }] } : entry) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, expectedFindings: [{ affectedPath: "subject.mjs", lineStart: 1 }] }) },
    { ...manifest, cases: manifest.cases.map((entry, index) => index ? entry : { ...entry, expectedFindings: [{ affectedPath: "subject.mjs", lineStart: 3, lineEnd: 2 }] }) },
  ];
  for (const value of invalid) assert.throws(() => validateDogfoodManifest(value, fixtureRoot));
});

test("materializer creates nine committed dirty repositories without mutating fixtures", () => {
  const outputRoot = join(mkdtempSync(join(tmpdir(), "alloy-fission-dogfood-test-")), "runs");
  const before = treeDigest(fixtureRoot);
  const run = materializeDogfoodFixtures({ fixtureRoot, outputRoot });
  assert.equal(treeDigest(fixtureRoot), before);
  assert.deepEqual(run.cases.map(({ id }) => id), expectedIds);
  assert.deepEqual(JSON.parse(readFileSync(join(outputRoot, "dogfood-run.json"), "utf8")), run);
  for (const entry of run.cases) {
    assert.equal(resolve(entry.repoPath).startsWith(`${resolve(outputRoot)}/`), true);
    assert.equal(resolve(entry.contractPath).startsWith(`${resolve(fixtureRoot)}/`), true);
    assert.equal(execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: entry.repoPath, encoding: "utf8" }).trim().length, 40);
    assert.notEqual(execFileSync("git", ["status", "--porcelain=v1"], { cwd: entry.repoPath, encoding: "utf8" }), "");
  }
});

test("materializer rejects an output root inside fixture sources", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "alloy-fission-dogfood-contained-"));
  const copiedFixtures = join(temporaryRoot, "fixtures");
  cpSync(fixtureRoot, copiedFixtures, { recursive: true });
  const before = treeDigest(copiedFixtures);
  assert.throws(() => materializeDogfoodFixtures({
    fixtureRoot: copiedFixtures,
    outputRoot: join(copiedFixtures, "generated"),
  }), /output_root_inside_fixture_root/);
  assert.equal(treeDigest(copiedFixtures), before);
});

test("materializer resolves a symlinked output ancestor before containment checks", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "alloy-fission-dogfood-symlink-"));
  const copiedFixtures = join(temporaryRoot, "fixtures");
  const outputAlias = join(temporaryRoot, "output-alias");
  cpSync(fixtureRoot, copiedFixtures, { recursive: true });
  symlinkSync(copiedFixtures, outputAlias, "dir");
  const before = treeDigest(copiedFixtures);
  assert.throws(() => materializeDogfoodFixtures({
    fixtureRoot: copiedFixtures,
    outputRoot: join(outputAlias, "generated"),
  }), /output_root_inside_fixture_root/);
  assert.equal(treeDigest(copiedFixtures), before);
});

test("evaluator passes only complete exact-route results with every seed matched", () => {
  const manifest = readManifest();
  const evaluation = evaluateDogfoodResults(manifest, resultPathsFor(manifest));
  assert.deepEqual(evaluation, {
    status: "PASSED",
    exitCode: 0,
    seededBlockersValidated: 6,
    seededBlockerCount: 6,
    blockingControlFindings: 0,
    controlCount: 3,
    message: "PASSED: 6/6 seeded blockers validated; 0/3 controls produced blocking findings",
    errors: [],
  });
});

test("evaluator matches exact paths and inclusive line overlap without consulting claim text", () => {
  const manifest = readManifest();
  const entry = manifest.cases.find(({ id }) => id === "correctness-stale-cache");
  const pass = validResults(manifest);
  const result = pass[entry.id];
  result.validatedFindings[0].claim = "This says nothing about a cache.";
  result.validatedFindings[0].location = {
    ...result.validatedFindings[0].location,
    lineStart: entry.expectedFindings[0].lineEnd,
    lineEnd: entry.expectedFindings[0].lineEnd + 3,
  };
  const secondRawFinding = {
    severity: "medium",
    claim: "A separate nonblocking observation.",
    affectedPath: entry.expectedFindings[0].affectedPath,
    location: normalizedFinding(entry).location,
    evidence: "The accepted patch contains the observation.",
    reproduction: "Inspect the changed tree.",
    suggestedFix: "Consider a follow-up cleanup.",
    confidence: 0.8,
  };
  const secondId = findingId("R02", 0, secondRawFinding);
  const second = normalizedFinding(entry, {
    clusterId: "C0002",
    canonicalFindingId: secondId,
    memberFindingIds: [secondId],
    adjudicatedSeverity: "medium",
  });
  result.reviewers[1].output.findings.push(secondRawFinding);
  result.validatedFindings.push(second);
  const secondJudgeCluster = {
    canonicalFindingId: second.canonicalFindingId,
    findingIds: second.memberFindingIds,
    disposition: "validated",
    adjudicatedSeverity: second.adjudicatedSeverity,
    rationale: second.rationale,
    evidenceRefs: second.evidenceRefs,
  };
  result.judge.output.clusters.push(secondJudgeCluster);
  result.clusters.push({ clusterId: second.clusterId, ...secondJudgeCluster });
  assert.equal(evaluateDogfoodResults(manifest, resultPathsFor(manifest, pass)).status, "PASSED");

  const wrongPath = structuredClone(pass);
  wrongPath[entry.id].validatedFindings[0].affectedPath = `other/${entry.expectedFindings[0].affectedPath}`;
  assert.equal(evaluateDogfoodResults(manifest, resultPathsFor(manifest, wrongPath)).status, "FAILED");
  const wrongLines = structuredClone(pass);
  wrongLines[entry.id].validatedFindings[0].location.lineStart = entry.expectedFindings[0].lineEnd + 1;
  wrongLines[entry.id].validatedFindings[0].location.lineEnd = entry.expectedFindings[0].lineEnd + 2;
  assert.equal(evaluateDogfoodResults(manifest, resultPathsFor(manifest, wrongLines)).status, "FAILED");
});

test("evaluator fails closed for malformed, incomplete, nonterminal, route, verdict, and control errors", () => {
  const manifest = readManifest();
  const firstDefect = manifest.cases.find(({ control }) => !control);
  const firstControl = manifest.cases.find(({ control }) => control);
  const mutations = [
    (results) => { results[firstDefect.id] = null; },
    (results) => { results[firstDefect.id] = { status: "COMPLETE", verdict: "FAIL" }; },
    (results) => { results[firstDefect.id].kind = "other"; },
    (results) => { results[firstDefect.id].unknown = true; },
    (results) => { results[firstDefect.id].status = "RUNNING"; },
    (results) => { results[firstDefect.id].verdict = "PASS"; },
    (results) => { results[firstDefect.id].message = "complete but inconsistent"; },
    (results) => { results[firstDefect.id].evidenceComplete = false; },
    (results) => { results[firstDefect.id].packetDigest = null; },
    (results) => { results[firstDefect.id].sourceDigest = "z".repeat(64); },
    (results) => { results[firstDefect.id].error = "fabricated_terminal_error"; },
    (results) => { results[firstDefect.id].requestedReviewers = 4; },
    (results) => { results[firstDefect.id].reviewers.pop(); },
    (results) => { delete results[firstDefect.id].reviewers[0].output; },
    (results) => { results[firstDefect.id].reviewers[0].unknown = true; },
    (results) => { results[firstDefect.id].reviewers[0].output.unknown = true; },
    (results) => { results[firstDefect.id].reviewers[1].requestedModel = results[firstDefect.id].reviewers[0].requestedModel; },
    (results) => { results[firstDefect.id].reviewers[0].actualModel = "other/model"; },
    (results) => { results[firstDefect.id].judge.actualModel = null; },
    (results) => { results[firstDefect.id].judge.valid = false; },
    (results) => { results[firstDefect.id].judge.unknown = true; },
    (results) => { results[firstDefect.id].judge.output.unknown = true; },
    (results) => { results[firstDefect.id].clusters = []; },
    (results) => { results[firstDefect.id].clusters[0].unknown = true; },
    (results) => { results[firstDefect.id].modelDiversity.exactModelCount = 5; },
    (results) => { results[firstDefect.id].modelDiversity.unknown = true; },
    (results) => { results[firstDefect.id].usage.costKnown = false; },
    (results) => { results[firstDefect.id].usage.unknown = true; },
    (results) => { results[firstDefect.id].panel = [null]; },
    (results) => { results[firstDefect.id].validatedFindings[0].adjudicatedSeverity = "medium"; },
    (results) => { results[firstDefect.id].validatedFindings[0].unknown = true; },
    (results) => { delete results[firstDefect.id].validatedFindings[0].location.lineEnd; },
    (results) => { results[firstDefect.id].validatedFindings[0].evidenceRefs = []; },
    (results) => { delete results[firstDefect.id].rejectedFindings; },
    (results) => { results[firstDefect.id].rejectedFindings = [{ malformed: true }]; },
    (results) => { results[firstDefect.id].unresolvedFindings = [{ malformed: true }]; },
    (results) => { results[firstControl.id].verdict = "FAIL"; },
    (results) => { results[firstControl.id].validatedFindings = [normalizedFinding(firstDefect)]; },
  ];
  for (const key of Object.keys(resultFor(firstDefect))) {
    mutations.push((results) => { delete results[firstDefect.id][key]; });
  }
  for (const mutate of mutations) {
    const results = validResults(manifest);
    mutate(results);
    const evaluation = evaluateDogfoodResults(manifest, resultPathsFor(manifest, results));
    assert.equal(evaluation.status, "FAILED");
    assert.equal(evaluation.exitCode, 1);
    assert.equal(evaluation.errors.length > 0, true);
  }
});

test("missing case result paths are UNEXECUTED with CLI exit 2", () => {
  const manifest = readManifest();
  const paths = resultPathsFor(manifest);
  delete paths[manifest.cases[0].id];
  const evaluation = evaluateDogfoodResults(manifest, paths);
  assert.equal(evaluation.status, "UNEXECUTED");
  assert.equal(evaluation.exitCode, 2);

  const cli = spawnSync(process.execPath, [
    "scripts/fission-dogfood.mjs",
    "evaluate",
    "--manifest",
    "test/fixtures/fission-dogfood/manifest.json",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 2);
  assert.match(cli.stdout, /^UNEXECUTED:/);
});

test("dogfood source and package boundary exclude model access and source fixtures", () => {
  const source = readFileSync(join(root, "scripts/fission-dogfood.mjs"), "utf8");
  for (const forbidden of [
    "lib/fission.mjs",
    "runFission",
    "runChildAgent",
    "modelRegistry",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["fission-dogfood"], undefined);
  assert.equal(packageJson.files.includes("scripts"), true);
  assert.equal(packageJson.files.includes("test"), false);
});

test("operator docs and example config state the complete Fission acceptance boundary", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const readme = read("README.md");
  const architecture = read("docs/ARCHITECTURE.md");
  const security = read("docs/SECURITY.md");
  const mvp = read("docs/MVP.md");
  const boundary = read("docs/BOUNDARY.md");
  const docs = [readme, architecture, security, mvp, boundary].join("\n");
  for (const required of [
    "/fission 5",
    "alloy_fission",
    "NO_CHANGES",
    "INCOMPLETE",
    "no submitted blocking finding validated.",
    "no fallback",
    "same-UID",
    "ABA",
    "dogfood",
    "/auto",
  ]) assert.equal(docs.includes(required), true, required);
  assert.match(readme, /Fission is for projects the operator has marked trusted\./);
  assert.match(readme, /Repository Git config\/attributes may execute under normal Git behavior\./);
  assert.match(readme, /Do not run it on hostile\/untrusted repositories\./);
  assert.match(readme, /product boundary, not a hidden implementation caveat/);
  for (const cap of [
    "request: 16 KiB",
    "status: 1 MiB",
    "staged plus unstaged patches: 2 MiB",
    "each retained file: 256 KiB",
    "all retained files: 2 MiB",
    "changed entries: 10,000",
    "assistant output per reviewer or judge: 256 KiB",
  ]) assert.equal(readme.includes(cap), true, cap);
  assert.match(architecture, /packet root/);
  assert.match(architecture, /in-process registry/);
  assert.match(architecture, /drift/i);
  assert.match(security, /output limit/i);
  assert.match(boundary, /standalone v1/i);
  assert.match(mvp, /manual authenticated/i);

  const example = JSON.parse(read("config/alloy.example.json"));
  assert.equal(example.fission.models.length, 5);
  assert.equal(new Set(example.fission.models).size, 5);
  assert.equal(typeof example.fission.judgeModel, "string");
  assert.equal(Object.keys(example.fission.modelFamilies).length >= 5, true);
  assert.equal(example.fission.defaultReviewers, 3);
  assert.equal(example.fission.maxReviewers, 5);
  const catalogs = loadProviderCatalogIds();
  for (const route of [...example.fission.models, example.fission.judgeModel]) {
    const slash = route.indexOf("/");
    assert.equal(catalogs[route.slice(0, slash)]?.includes(route.slice(slash + 1)), true, route);
  }
});
