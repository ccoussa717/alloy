import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CASES = Object.freeze([
  ["correctness-stale-cache", "correctness", false],
  ["correctness-partial-write", "correctness", false],
  ["security-path-traversal", "security", false],
  ["security-tenant-bypass", "security", false],
  ["failure-handling-reservation-leak", "failure-handling", false],
  ["failure-handling-cancellation-reported-as-success", "failure-handling", false],
  ["control-cache-invalidation", "correctness", true],
  ["control-contained-upload", "security", true],
  ["control-finally-settlement", "failure-handling", true],
]);
const CASE_BY_ID = new Map(CASES.map((entry) => [entry[0], entry]));
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const BLOCKING_SEVERITIES = new Set(["critical", "high"]);
const ROUTE = /^[^/\s]+\/.+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FINDING_ID = /^F[0-9a-f]{24}$/;
const CLUSTER_ID = /^C\d{4}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label}_object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label}_keys`);
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) return false;
  const normalized = relative(".", value);
  return normalized !== ".." && !normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function requireFixtureTree(fixtureRoot, id) {
  const caseRoot = join(fixtureRoot, id);
  for (const name of ["base", "changed"]) {
    const path = join(caseRoot, name);
    if (!existsSync(path) || !statSync(path).isDirectory() || readdirSync(path).length === 0) {
      throw new Error(`${id}_${name}_tree`);
    }
  }
  const contract = join(caseRoot, "contract.md");
  if (!existsSync(contract) || !statSync(contract).isFile() || !readFileSync(contract, "utf8").trim()) {
    throw new Error(`${id}_contract`);
  }
}

export function validateDogfoodManifest(manifest, fixtureRoot) {
  exactKeys(manifest, ["version", "seededBlockerCount", "cases"], "manifest");
  if (manifest.version !== 1) throw new Error("manifest_version");
  if (manifest.seededBlockerCount !== 6) throw new Error("seeded_blocker_count");
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== CASES.length) {
    throw new Error("case_count");
  }
  const ids = new Set();
  const defectCounts = new Map();
  const controlCounts = new Map();
  for (const [index, entry] of manifest.cases.entries()) {
    exactKeys(entry, ["id", "category", "control", "expectedFindings"], `case_${index}`);
    const expectedCase = CASE_BY_ID.get(entry.id);
    if (!expectedCase || entry.id !== CASES[index][0]) throw new Error("case_id");
    if (ids.has(entry.id)) throw new Error("duplicate_case_id");
    ids.add(entry.id);
    if (entry.category !== expectedCase[1] || entry.control !== expectedCase[2]) {
      throw new Error("case_category_or_control");
    }
    if (!Array.isArray(entry.expectedFindings)) throw new Error("expected_findings_array");
    if (entry.control && entry.expectedFindings.length !== 0) throw new Error("control_expected_finding");
    if (!entry.control && entry.expectedFindings.length !== 1) throw new Error("defect_expected_finding");
    const counts = entry.control ? controlCounts : defectCounts;
    counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
    for (const [findingIndex, finding] of entry.expectedFindings.entries()) {
      if (!isObject(finding)) throw new Error("expected_finding_object");
      const hasStart = Object.hasOwn(finding, "lineStart");
      const hasEnd = Object.hasOwn(finding, "lineEnd");
      exactKeys(
        finding,
        hasStart || hasEnd ? ["affectedPath", "lineStart", "lineEnd"] : ["affectedPath"],
        `expected_finding_${findingIndex}`,
      );
      if (!validRelativePath(finding.affectedPath)) throw new Error("expected_affected_path");
      if (hasStart !== hasEnd) throw new Error("expected_partial_line_range");
      if (hasStart && (!positiveInteger(finding.lineStart) || !positiveInteger(finding.lineEnd) || finding.lineStart > finding.lineEnd)) {
        throw new Error("expected_line_range");
      }
    }
    if (fixtureRoot) requireFixtureTree(fixtureRoot, entry.id);
  }
  for (const category of ["correctness", "security", "failure-handling"]) {
    if (defectCounts.get(category) !== 2 || controlCounts.get(category) !== 1) {
      throw new Error("category_counts");
    }
  }
  return manifest;
}

function replaceTree(source, destination) {
  for (const name of readdirSync(destination)) {
    if (name !== ".git") rmSync(join(destination, name), { recursive: true, force: true });
  }
  cpSync(source, destination, { recursive: true, force: true });
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

export function materializeDogfoodFixtures({ fixtureRoot, outputRoot }) {
  const resolvedFixtureRoot = resolve(fixtureRoot);
  const resolvedOutputRoot = resolve(outputRoot);
  const outputFromFixtures = relative(resolvedFixtureRoot, resolvedOutputRoot);
  if (
    outputFromFixtures === "" ||
    (!outputFromFixtures.startsWith("..") && !isAbsolute(outputFromFixtures))
  ) throw new Error("output_root_inside_fixture_root");
  const manifest = JSON.parse(readFileSync(join(resolvedFixtureRoot, "manifest.json"), "utf8"));
  validateDogfoodManifest(manifest, resolvedFixtureRoot);
  if (existsSync(resolvedOutputRoot)) throw new Error("output_root_exists");
  mkdirSync(resolvedOutputRoot, { recursive: true });
  const run = { version: 1, cases: [] };
  for (const entry of manifest.cases) {
    const caseRoot = join(resolvedFixtureRoot, entry.id);
    const repoPath = join(resolvedOutputRoot, entry.id);
    mkdirSync(repoPath);
    cpSync(join(caseRoot, "base"), repoPath, { recursive: true });
    git(repoPath, ["init", "--quiet"]);
    git(repoPath, ["config", "user.name", "Alloy Fission Dogfood"]);
    git(repoPath, ["config", "user.email", "fission-dogfood@localhost"]);
    git(repoPath, ["add", "--all"]);
    git(repoPath, ["commit", "--quiet", "-m", "dogfood base"]);
    replaceTree(join(caseRoot, "changed"), repoPath);
    run.cases.push({
      id: entry.id,
      repoPath,
      contractPath: join(caseRoot, "contract.md"),
    });
  }
  writeFileSync(join(resolvedOutputRoot, "dogfood-run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

function validateLocation(location, label) {
  exactKeys(location, ["artifact", "artifactPath", "lineStart", "lineEnd", "artifactDigest"], `${label}_location`);
  if (
    !["staged_diff", "unstaged_diff", "file"].includes(location.artifact) ||
    !validRelativePath(location.artifactPath) ||
    !positiveInteger(location.lineStart) ||
    !positiveInteger(location.lineEnd) ||
    location.lineStart > location.lineEnd ||
    !DIGEST.test(location.artifactDigest)
  ) throw new Error(`${label}_location`);
}

function validateEvidenceRef(ref, label) {
  exactKeys(ref, ["artifactPath", "artifactDigest", "lineStart", "lineEnd"], label);
  if (
    !validRelativePath(ref.artifactPath) ||
    !DIGEST.test(ref.artifactDigest) ||
    !positiveInteger(ref.lineStart) ||
    !positiveInteger(ref.lineEnd) ||
    ref.lineStart > ref.lineEnd
  ) throw new Error(label);
}

function validateNormalizedFinding(finding, disposition = null) {
  exactKeys(finding, [
    "clusterId",
    "canonicalFindingId",
    "memberFindingIds",
    "affectedPath",
    "location",
    "claim",
    "adjudicatedSeverity",
    "rationale",
    "evidenceRefs",
    ...(disposition ? ["disposition"] : []),
  ], "normalized_finding");
  if (
    !CLUSTER_ID.test(finding.clusterId) ||
    !FINDING_ID.test(finding.canonicalFindingId) ||
    !Array.isArray(finding.memberFindingIds) ||
    finding.memberFindingIds.length === 0 ||
    new Set(finding.memberFindingIds).size !== finding.memberFindingIds.length ||
    !finding.memberFindingIds.every((id) => FINDING_ID.test(id)) ||
    !finding.memberFindingIds.includes(finding.canonicalFindingId) ||
    !validRelativePath(finding.affectedPath) ||
    typeof finding.claim !== "string" || !finding.claim.trim() ||
    (disposition ? finding.adjudicatedSeverity !== null : !SEVERITIES.has(finding.adjudicatedSeverity)) ||
    (disposition && !["rejected", "duplicate"].includes(finding.disposition)) ||
    typeof finding.rationale !== "string" || !finding.rationale.trim() ||
    !Array.isArray(finding.evidenceRefs) ||
    (!disposition && finding.evidenceRefs.length === 0)
  ) throw new Error("normalized_finding");
  validateLocation(finding.location, "normalized_finding");
  finding.evidenceRefs.forEach((ref, index) => validateEvidenceRef(ref, `evidence_ref_${index}`));
}

function validateResult(entry, result) {
  if (!isObject(result)) throw new Error(`${entry.id}: result_object`);
  if (result.status !== "COMPLETE" || !["PASS", "FAIL"].includes(result.verdict)) {
    throw new Error(`${entry.id}: terminal_result`);
  }
  if (result.requestedReviewers !== 5 || !Array.isArray(result.reviewers) || result.reviewers.length !== 5) {
    throw new Error(`${entry.id}: reviewer_count`);
  }
  const requested = [];
  const actual = [];
  for (const reviewer of result.reviewers) {
    if (!isObject(reviewer) || !ROUTE.test(reviewer.requestedModel) || !ROUTE.test(reviewer.actualModel)) {
      throw new Error(`${entry.id}: reviewer_route`);
    }
    if (reviewer.requestedModel !== reviewer.actualModel) throw new Error(`${entry.id}: reviewer_attestation`);
    requested.push(reviewer.requestedModel);
    actual.push(reviewer.actualModel);
  }
  if (new Set(requested).size !== 5 || new Set(actual).size !== 5) {
    throw new Error(`${entry.id}: reviewer_diversity`);
  }
  if (!isObject(result.judge) || !ROUTE.test(result.judge.actualModel)) {
    throw new Error(`${entry.id}: judge_attestation`);
  }
  if (result.judge.requestedModel !== undefined && result.judge.requestedModel !== result.judge.actualModel) {
    throw new Error(`${entry.id}: judge_attestation`);
  }
  if (
    !Array.isArray(result.validatedFindings) ||
    !Array.isArray(result.rejectedFindings) ||
    !Array.isArray(result.unresolvedFindings) ||
    result.unresolvedFindings.length !== 0
  ) throw new Error(`${entry.id}: normalized_findings`);
  result.validatedFindings.forEach((finding) => validateNormalizedFinding(finding));
  result.rejectedFindings.forEach((finding) => validateNormalizedFinding(finding, "rejected"));
  if (entry.control && result.verdict !== "PASS") throw new Error(`${entry.id}: control_verdict`);
  if (!entry.control && result.verdict !== "FAIL") throw new Error(`${entry.id}: defect_verdict`);
}

function overlapsExpected(finding, expected) {
  if (finding.affectedPath !== expected.affectedPath) return false;
  if (expected.lineStart === undefined) return true;
  return finding.location.lineStart <= expected.lineEnd && finding.location.lineEnd >= expected.lineStart;
}

function failedEvaluation(errors, counts) {
  return {
    status: "FAILED",
    exitCode: 1,
    seededBlockersValidated: counts.seededBlockersValidated,
    seededBlockerCount: counts.seededBlockerCount,
    blockingControlFindings: counts.blockingControlFindings,
    controlCount: counts.controlCount,
    message: `FAILED: ${errors.length} dogfood result error${errors.length === 1 ? "" : "s"}`,
    errors,
  };
}

export function evaluateDogfoodResults(manifest, resultPaths) {
  validateDogfoodManifest(manifest);
  const paths = resultPaths instanceof Map ? Object.fromEntries(resultPaths) : resultPaths;
  const missing = manifest.cases.filter((entry) => !isObject(paths) || typeof paths[entry.id] !== "string" || !existsSync(paths[entry.id]));
  const counts = {
    seededBlockersValidated: 0,
    seededBlockerCount: manifest.seededBlockerCount,
    blockingControlFindings: 0,
    controlCount: manifest.cases.filter(({ control }) => control).length,
  };
  if (missing.length) {
    const errors = missing.map(({ id }) => `${id}: result path missing`);
    return {
      status: "UNEXECUTED",
      exitCode: 2,
      ...counts,
      message: `UNEXECUTED: ${missing.length}/${manifest.cases.length} result paths missing`,
      errors,
    };
  }
  const errors = [];
  for (const entry of manifest.cases) {
    let result;
    try {
      result = JSON.parse(readFileSync(paths[entry.id], "utf8"));
      validateResult(entry, result);
      const blocking = result.validatedFindings.filter((finding) => BLOCKING_SEVERITIES.has(finding.adjudicatedSeverity));
      if (entry.control) {
        counts.blockingControlFindings += blocking.length;
        if (blocking.length) throw new Error(`${entry.id}: blocking_control_finding`);
      } else if (entry.expectedFindings.every((expected) => blocking.some((finding) => overlapsExpected(finding, expected)))) {
        counts.seededBlockersValidated += 1;
      } else {
        throw new Error(`${entry.id}: expected_blocker_not_validated`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${entry.id}: invalid_result`);
    }
  }
  if (errors.length) return failedEvaluation(errors, counts);
  return {
    status: "PASSED",
    exitCode: 0,
    ...counts,
    message: `PASSED: ${counts.seededBlockersValidated}/${counts.seededBlockerCount} seeded blockers validated; ${counts.blockingControlFindings}/${counts.controlCount} controls produced blocking findings`,
    errors: [],
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) throw new Error(`missing_${name.slice(2).replaceAll("-", "_")}`);
  return args[index + 1];
}

function parseCases(args) {
  const cases = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--case") continue;
    const value = args[++index];
    const equals = value?.indexOf("=") ?? -1;
    if (equals <= 0 || equals === value.length - 1) throw new Error("invalid_case_path");
    const id = value.slice(0, equals);
    if (Object.hasOwn(cases, id)) throw new Error("duplicate_case_path");
    cases[id] = resolve(value.slice(equals + 1));
  }
  return cases;
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "materialize") {
    const run = materializeDogfoodFixtures({
      fixtureRoot: option(rest, "--fixture-root"),
      outputRoot: option(rest, "--out"),
    });
    console.log(`MATERIALIZED: ${run.cases.length} dogfood repositories`);
    return 0;
  }
  if (command === "evaluate") {
    const manifestPath = resolve(option(rest, "--manifest"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const evaluation = evaluateDogfoodResults(manifest, parseCases(rest));
    console.log(evaluation.message);
    for (const error of evaluation.errors) console.error(error);
    return evaluation.exitCode;
  }
  throw new Error("usage: fission-dogfood.mjs <materialize|evaluate>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
