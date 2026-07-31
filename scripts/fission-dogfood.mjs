import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
const ROUTE = /^[^/\s]+\/[^\s]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FINDING_ID = /^F[0-9a-f]{24}$/;
const CLUSTER_ID = /^C\d{4}$/;
const REVIEWER_ROLES = Object.freeze([
  "correctness_regressions",
  "security_trust_boundaries",
  "architecture_failure_handling",
  "test_quality_spec_coverage",
  "performance_concurrency_resources",
]);
const RESULT_KEYS = Object.freeze([
  "kind", "runId", "runDir", "status", "verdict", "message", "request",
  "requestedReviewers", "blockingSeverity", "packetDigest", "sourceDigest",
  "evidenceComplete", "reviewers", "judge", "clusters", "validatedFindings",
  "rejectedFindings", "unresolvedFindings", "modelDiversity", "usage", "error", "panel",
]);

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
  if (
    typeof value !== "string" || !value || value === "." || posix.isAbsolute(value) ||
    value.includes("\\") || value.includes("\0") || posix.normalize(value) !== value
  ) return false;
  return !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
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

function canonicalPotentialPath(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("output_root_ancestor_missing");
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

export function materializeDogfoodFixtures({ fixtureRoot, outputRoot }) {
  const resolvedFixtureRoot = realpathSync(resolve(fixtureRoot));
  const resolvedOutputRoot = canonicalPotentialPath(outputRoot);
  const outputFromFixtures = relative(resolvedFixtureRoot, resolvedOutputRoot);
  if (
    outputFromFixtures === "" ||
    (outputFromFixtures !== ".." &&
      !outputFromFixtures.startsWith(`..${sep}`) &&
      !isAbsolute(outputFromFixtures))
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

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resultFindingId(alias, ordinal, finding) {
  const identity = {
    alias,
    ordinal,
    affectedPath: finding.affectedPath,
    location: finding.location,
    claimDigest: createHash("sha256").update(finding.claim).digest("hex"),
  };
  return `F${createHash("sha256").update(canonical(identity)).digest("hex").slice(0, 24)}`;
}

function validateUsage(usage, label) {
  exactKeys(usage, ["input", "output", "cost", "turns", "costKnown"], label);
  if (
    !finiteNonnegative(usage.input) ||
    !finiteNonnegative(usage.output) ||
    !finiteNonnegative(usage.cost) ||
    !finiteNonnegative(usage.turns) ||
    usage.costKnown !== true
  ) throw new Error(label);
}

function validateRawFinding(finding, label) {
  exactKeys(finding, [
    "severity", "claim", "affectedPath", "location", "evidence",
    "reproduction", "suggestedFix", "confidence",
  ], label);
  if (
    !SEVERITIES.has(finding.severity) ||
    typeof finding.claim !== "string" || !finding.claim.trim() ||
    !validRelativePath(finding.affectedPath) ||
    typeof finding.evidence !== "string" || !finding.evidence.trim() ||
    typeof finding.reproduction !== "string" || !finding.reproduction.trim() ||
    typeof finding.suggestedFix !== "string" || !finding.suggestedFix.trim() ||
    typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) ||
    finding.confidence < 0 || finding.confidence > 1
  ) throw new Error(label);
  validateLocation(finding.location, label);
}

function validateReviewerOutput(output, role, label) {
  exactKeys(output, ["reviewerRole", "coverage", "findings", "errors"], label);
  if (
    output.reviewerRole !== role ||
    !Array.isArray(output.coverage) || output.coverage.length === 0 ||
    !output.coverage.every((item) => typeof item === "string" && item.trim()) ||
    new Set(output.coverage).size !== output.coverage.length ||
    !Array.isArray(output.findings) ||
    !Array.isArray(output.errors) || output.errors.length !== 0
  ) throw new Error(label);
  output.findings.forEach((finding, index) => validateRawFinding(finding, `${label}_finding_${index}`));
}

function validateReviewer(reviewer, index, entry) {
  const label = `${entry.id}: reviewer_${index}`;
  exactKeys(reviewer, [
    "alias", "role", "requestedModel", "actualModel", "status", "valid",
    "malformed", "output", "error", "usage",
  ], label);
  if (
    reviewer.alias !== `R${String(index + 1).padStart(2, "0")}` ||
    reviewer.role !== REVIEWER_ROLES[index] ||
    !ROUTE.test(reviewer.requestedModel) ||
    reviewer.actualModel !== reviewer.requestedModel ||
    reviewer.status !== "ok" || reviewer.valid !== true || reviewer.malformed !== false ||
    reviewer.error !== null
  ) throw new Error(label);
  validateReviewerOutput(reviewer.output, reviewer.role, `${label}_output`);
  validateUsage(reviewer.usage, `${label}_usage`);
}

function validateCluster(cluster, resultShape, label) {
  exactKeys(cluster, [
    ...(resultShape ? ["clusterId"] : []),
    "canonicalFindingId", "findingIds", "disposition", "adjudicatedSeverity",
    "rationale", "evidenceRefs",
  ], label);
  if (
    (resultShape && !CLUSTER_ID.test(cluster.clusterId)) ||
    !FINDING_ID.test(cluster.canonicalFindingId) ||
    !Array.isArray(cluster.findingIds) || cluster.findingIds.length === 0 ||
    new Set(cluster.findingIds).size !== cluster.findingIds.length ||
    !cluster.findingIds.every((id) => FINDING_ID.test(id)) ||
    !cluster.findingIds.includes(cluster.canonicalFindingId) ||
    !["validated", "rejected"].includes(cluster.disposition) ||
    (cluster.disposition === "validated"
      ? !SEVERITIES.has(cluster.adjudicatedSeverity)
      : cluster.adjudicatedSeverity !== null) ||
    typeof cluster.rationale !== "string" || !cluster.rationale.trim() ||
    !Array.isArray(cluster.evidenceRefs) ||
    (cluster.disposition === "validated" && cluster.evidenceRefs.length === 0)
  ) throw new Error(label);
  cluster.evidenceRefs.forEach((ref, index) => validateEvidenceRef(ref, `${label}_evidence_${index}`));
}

function validateJudge(judge, entry) {
  const label = `${entry.id}: judge`;
  exactKeys(judge, [
    "requestedModel", "actualModel", "status", "valid", "malformed", "output", "error", "usage",
  ], label);
  if (
    !ROUTE.test(judge.requestedModel) || judge.actualModel !== judge.requestedModel ||
    judge.status !== "ok" || judge.valid !== true || judge.malformed !== false || judge.error !== null
  ) throw new Error(label);
  exactKeys(judge.output, ["clusters", "judgeConcern"], `${label}_output`);
  if (!Array.isArray(judge.output.clusters) || judge.output.judgeConcern !== null) throw new Error(`${label}_output`);
  judge.output.clusters.forEach((cluster, index) => validateCluster(cluster, false, `${label}_cluster_${index}`));
  validateUsage(judge.usage, `${label}_usage`);
}

function sortedUniqueStrings(values) {
  return Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value) &&
    isDeepStrictEqual(values, [...new Set(values)].sort());
}

function validateModelDiversity(diversity, result, entry) {
  const label = `${entry.id}: model_diversity`;
  exactKeys(diversity, [
    "requestedModels", "actualModels", "providers", "families",
    "exactModelCount", "providerCount", "familyCount",
  ], label);
  const requestedModels = [...result.reviewers.map((item) => item.requestedModel), result.judge.requestedModel];
  const actualModels = [...result.reviewers.map((item) => item.actualModel), result.judge.actualModel];
  if (
    !sortedUniqueStrings(diversity.requestedModels) ||
    !sortedUniqueStrings(diversity.actualModels) ||
    !sortedUniqueStrings(diversity.providers) ||
    !sortedUniqueStrings(diversity.families) ||
    !isDeepStrictEqual(diversity.requestedModels, [...new Set(requestedModels)].sort()) ||
    !isDeepStrictEqual(diversity.actualModels, [...new Set(actualModels)].sort()) ||
    !isDeepStrictEqual(
      diversity.providers,
      [...new Set(actualModels.map((route) => route.slice(0, route.indexOf("/"))))].sort(),
    ) ||
    diversity.exactModelCount !== diversity.actualModels.length ||
    diversity.providerCount !== diversity.providers.length ||
    diversity.familyCount !== diversity.families.length
  ) throw new Error(label);
}

function deriveNormalizedProjection(judgeOutput, submittedById) {
  const projection = {
    clusters: [],
    validatedFindings: [],
    rejectedFindings: [],
    unresolvedFindings: [],
  };
  for (const [index, cluster] of judgeOutput.clusters.entries()) {
    const clusterId = `C${String(index + 1).padStart(4, "0")}`;
    const members = [
      cluster.canonicalFindingId,
      ...cluster.findingIds
        .filter((id) => id !== cluster.canonicalFindingId)
        .sort(),
    ];
    const canonicalFinding = submittedById.get(cluster.canonicalFindingId);
    if (!canonicalFinding) throw new Error("normalized_canonical_missing");
    projection.clusters.push({ clusterId, ...cluster, findingIds: members });
    const common = {
      clusterId,
      canonicalFindingId: cluster.canonicalFindingId,
      memberFindingIds: members,
      affectedPath: canonicalFinding.affectedPath,
      location: canonicalFinding.location,
      claim: canonicalFinding.claim,
      adjudicatedSeverity: cluster.adjudicatedSeverity,
      rationale: cluster.rationale,
      evidenceRefs: cluster.evidenceRefs,
    };
    if (cluster.disposition === "validated") projection.validatedFindings.push(common);
    else if (cluster.disposition === "rejected") {
      projection.rejectedFindings.push({ ...common, adjudicatedSeverity: null, disposition: "rejected" });
    } else {
      projection.unresolvedFindings.push({
        ...common,
        adjudicatedSeverity: null,
        disposition: cluster.disposition,
      });
    }
    for (const id of members.slice(1)) {
      const memberFinding = submittedById.get(id);
      if (!memberFinding) throw new Error("normalized_member_missing");
      projection.rejectedFindings.push({
        clusterId,
        canonicalFindingId: cluster.canonicalFindingId,
        memberFindingIds: members,
        affectedPath: memberFinding.affectedPath,
        location: memberFinding.location,
        claim: memberFinding.claim,
        adjudicatedSeverity: null,
        rationale: `Duplicate of ${cluster.canonicalFindingId}: ${cluster.rationale}`,
        evidenceRefs: cluster.evidenceRefs,
        disposition: "duplicate",
      });
    }
  }
  return projection;
}

function validateResult(entry, result) {
  exactKeys(result, RESULT_KEYS, `${entry.id}: result`);
  if (
    result.kind !== "fission" ||
    typeof result.runId !== "string" || !result.runId ||
    typeof result.runDir !== "string" || !result.runDir ||
    result.status !== "COMPLETE" || !["PASS", "FAIL"].includes(result.verdict) ||
    result.message !== (result.verdict === "PASS"
      ? "no submitted blocking finding validated."
      : "a submitted blocking finding was validated.") ||
    typeof result.request !== "string" || !result.request.trim() ||
    !SEVERITIES.has(result.blockingSeverity) ||
    !DIGEST.test(result.packetDigest) || !DIGEST.test(result.sourceDigest) ||
    result.evidenceComplete !== true || result.error !== null ||
    !Array.isArray(result.panel) || !result.panel.every((line) => typeof line === "string")
  ) {
    throw new Error(`${entry.id}: terminal_result`);
  }
  if (result.requestedReviewers !== 5 || !Array.isArray(result.reviewers) || result.reviewers.length !== 5) {
    throw new Error(`${entry.id}: reviewer_count`);
  }
  const requested = [];
  const actual = [];
  for (const [index, reviewer] of result.reviewers.entries()) {
    validateReviewer(reviewer, index, entry);
    requested.push(reviewer.requestedModel);
    actual.push(reviewer.actualModel);
  }
  if (new Set(requested).size !== 5 || new Set(actual).size !== 5) {
    throw new Error(`${entry.id}: reviewer_diversity`);
  }
  validateJudge(result.judge, entry);
  const submitted = result.reviewers.flatMap((reviewer) =>
    reviewer.output.findings.map((finding, index) => ({
      id: resultFindingId(reviewer.alias, index, finding),
      finding,
    }))
  );
  const submittedIds = submitted.map(({ id }) => id).sort();
  const judgedIds = result.judge.output.clusters.flatMap((cluster) => cluster.findingIds).sort();
  if (!isDeepStrictEqual(submittedIds, judgedIds)) throw new Error(`${entry.id}: judge_coverage`);
  if (
    !Array.isArray(result.clusters) ||
    !Array.isArray(result.validatedFindings) ||
    !Array.isArray(result.rejectedFindings) ||
    !Array.isArray(result.unresolvedFindings) ||
    result.unresolvedFindings.length !== 0
  ) throw new Error(`${entry.id}: normalized_findings`);
  result.clusters.forEach((cluster, index) => validateCluster(cluster, true, `${entry.id}: cluster_${index}`));
  result.validatedFindings.forEach((finding) => validateNormalizedFinding(finding));
  result.rejectedFindings.forEach((finding) => validateNormalizedFinding(finding, "rejected"));
  const projection = deriveNormalizedProjection(
    result.judge.output,
    new Map(submitted.map(({ id, finding }) => [id, finding])),
  );
  for (const key of ["clusters", "validatedFindings", "rejectedFindings", "unresolvedFindings"]) {
    if (!isDeepStrictEqual(result[key], projection[key])) {
      throw new Error(`${entry.id}: normalized_${key}`);
    }
  }
  validateModelDiversity(result.modelDiversity, result, entry);
  validateUsage(result.usage, `${entry.id}: usage`);
  const expectedPanel = [
    "ALLOY FISSION COMPLETE",
    ...result.reviewers.map((reviewer) => `${reviewer.alias} ${reviewer.role}: ok`),
    "JUDGE: ok",
  ];
  if (!isDeepStrictEqual(result.panel, expectedPanel)) throw new Error(`${entry.id}: panel`);
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
