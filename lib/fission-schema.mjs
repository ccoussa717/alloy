import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { FISSION_ROLE_IDS } from "./fission-roles.mjs";

const Strict = (properties) => Type.Object(properties, { additionalProperties: false });
const NonemptyNarrative = Type.String({ minLength: 1, maxLength: 8 * 1024 });
const PacketPath = Type.String({ minLength: 1, maxLength: 4 * 1024 });
const Digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const FindingId = Type.String({ pattern: "^F[0-9a-f]{24}$" });

export const ReviewerRoleSchema = Type.Union(
  FISSION_ROLE_IDS.map((id) => Type.Literal(id)),
);
export const SeveritySchema = Type.Union([
  Type.Literal("critical"), Type.Literal("high"),
  Type.Literal("medium"), Type.Literal("low"),
]);
export const ArtifactKindSchema = Type.Union([
  Type.Literal("staged_diff"),
  Type.Literal("unstaged_diff"),
  Type.Literal("file"),
]);
export const LocationSchema = Strict({
  artifact: ArtifactKindSchema,
  artifactPath: PacketPath,
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  artifactDigest: Digest,
});
export const EvidenceRefSchema = Strict({
  artifactPath: PacketPath,
  artifactDigest: Digest,
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
});
export const FindingSchema = Strict({
  severity: SeveritySchema,
  claim: NonemptyNarrative,
  affectedPath: PacketPath,
  location: LocationSchema,
  evidence: NonemptyNarrative,
  reproduction: NonemptyNarrative,
  suggestedFix: NonemptyNarrative,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});
export const ReviewerOutputSchema = Strict({
  reviewerRole: ReviewerRoleSchema,
  coverage: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 20,
  }),
  findings: Type.Array(FindingSchema, { maxItems: 50 }),
  errors: Type.Array(Type.String({ minLength: 1, maxLength: 2 * 1024 }), {
    maxItems: 10,
  }),
});
export const DispositionSchema = Type.Union([
  Type.Literal("validated"),
  Type.Literal("rejected"),
  Type.Literal("needs_probe"),
  Type.Literal("human_decision"),
]);
export const JudgeClusterSchema = Strict({
  canonicalFindingId: FindingId,
  findingIds: Type.Array(FindingId, { minItems: 1, maxItems: 50 }),
  disposition: DispositionSchema,
  adjudicatedSeverity: Type.Union([SeveritySchema, Type.Null()]),
  rationale: NonemptyNarrative,
  evidenceRefs: Type.Array(EvidenceRefSchema, { maxItems: 20 }),
});
export const JudgeConcernSchema = Strict({
  claim: NonemptyNarrative,
  rationale: NonemptyNarrative,
  evidenceRefs: Type.Array(EvidenceRefSchema, { minItems: 1, maxItems: 20 }),
});
export const JudgeOutputSchema = Strict({
  clusters: Type.Array(JudgeClusterSchema, { maxItems: 50 }),
  judgeConcern: Type.Union([JudgeConcernSchema, Type.Null()]),
});

function bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertByteLimit(value, limit) {
  if (bytes(value) > limit) throw new Error("byte_limit");
}

function assertPacketPath(path) {
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    posix.normalize(path) !== path ||
    path === "." ||
    path.startsWith("../")
  ) throw new Error("packet_path");
  assertByteLimit(path, 4 * 1024);
}

function artifactMap(packet) {
  return packet?.artifacts || {};
}

function changedEntry(packet, path) {
  return packet?.manifest?.entries?.find((entry) => entry.path === path) || null;
}

function assertEvidenceRef(reference, packet, expectedKind, allowedPaths = null) {
  assertPacketPath(reference.artifactPath);
  if (reference.lineStart > reference.lineEnd) throw new Error("line_range");
  const artifact = artifactMap(packet)[reference.artifactPath];
  if (!artifact || artifact.digest !== reference.artifactDigest) throw new Error("evidence_ref");
  if (!["staged_diff", "unstaged_diff", "file"].includes(artifact.type)) throw new Error("evidence_ref");
  if (expectedKind && artifact.type !== expectedKind) throw new Error("evidence_ref");
  if (artifact.type === "file") {
    const entry = packet?.manifest?.entries?.find((candidate) => candidate.artifactPath === artifact.path);
    if (!entry || entry.artifactPath !== artifact.path) throw new Error("affected_path");
    if (allowedPaths && !allowedPaths.has(entry.path)) throw new Error("affected_path");
  } else {
    if (!Array.isArray(artifact.sections)) throw new Error("evidence_ref");
    const sections = artifact.sections.filter((section) =>
      section && Number.isInteger(section.lineStart) && Number.isInteger(section.lineEnd) &&
      typeof section.affectedPath === "string" &&
      section.lineStart >= 1 && section.lineEnd >= section.lineStart &&
      section.lineStart <= reference.lineStart && section.lineEnd >= reference.lineEnd);
    if (sections.length !== 1) throw new Error("line_range");
    if (allowedPaths && !allowedPaths.has(sections[0].affectedPath)) throw new Error("affected_path");
  }
  if (reference.lineEnd > artifact.lineCount) throw new Error("line_range");
}

function assertNarratives(finding) {
  for (const key of ["claim", "evidence", "reproduction", "suggestedFix"])
    assertByteLimit(finding[key], 8 * 1024);
  assertPacketPath(finding.affectedPath);
}

export function validateReviewerOutput(input) {
  const output = input?.output ?? input;
  if (!Value.Check(ReviewerOutputSchema, output)) throw new Error("reviewer_schema");
  if (input?.reviewerRole && output.reviewerRole !== input.reviewerRole) {
    throw new Error("reviewer_role");
  }
  if (new Set(output.coverage).size !== output.coverage.length) throw new Error("coverage_unique");
  for (const item of output.coverage) assertByteLimit(item, 512);
  for (const error of output.errors) assertByteLimit(error, 2 * 1024);
  for (const finding of output.findings) {
    if (!Number.isFinite(finding.confidence)) throw new Error("confidence");
    assertNarratives(finding);
    if (!changedEntry(input?.packet, finding.affectedPath)) throw new Error("affected_path");
    assertEvidenceRef(
      finding.location,
      input?.packet,
      finding.location.artifact,
      new Set([finding.affectedPath]),
    );
  }
  return output;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function findingId(alias, ordinal, finding) {
  const claimDigest = createHash("sha256").update(finding.claim).digest("hex");
  const identity = {
    alias,
    ordinal,
    affectedPath: finding.affectedPath,
    location: finding.location,
    claimDigest,
  };
  return `F${createHash("sha256").update(canonical(identity)).digest("hex").slice(0, 24)}`;
}

function submittedMap(findings) {
  const map = new Map();
  for (const item of findings || []) {
    const id = item.id || item.findingId;
    const finding = item.finding || item;
    if (!id || map.has(id)) throw new Error("finding_ids");
    map.set(id, finding);
  }
  return map;
}

export function validateJudgeOutput(input) {
  const output = input?.output ?? input;
  if (!Value.Check(JudgeOutputSchema, output)) throw new Error("judge_schema");
  const submitted = submittedMap(input?.findings);
  if (output.clusters.length > submitted.size) throw new Error("cluster_count");
  const seen = new Set();
  for (const cluster of output.clusters) {
    assertByteLimit(cluster.rationale, 8 * 1024);
    if (new Set(cluster.findingIds).size !== cluster.findingIds.length) throw new Error("cluster_unique");
    if (!cluster.findingIds.includes(cluster.canonicalFindingId)) throw new Error("canonical_member");
    for (const id of cluster.findingIds) {
      if (!submitted.has(id) || seen.has(id)) throw new Error("finding_coverage");
      seen.add(id);
    }
    if (cluster.disposition === "validated") {
      if (cluster.adjudicatedSeverity === null) throw new Error("severity_required");
      if (cluster.evidenceRefs.length === 0) throw new Error("evidence_required");
    } else if (cluster.adjudicatedSeverity !== null) {
      throw new Error("severity_forbidden");
    }
    const memberPaths = new Set(cluster.findingIds.map((id) => submitted.get(id).affectedPath));
    for (const reference of cluster.evidenceRefs) {
      assertEvidenceRef(reference, input?.packet, null, memberPaths);
    }
    if (cluster.disposition === "validated") {
      const memberSeverities = cluster.findingIds.map((id) => submitted.get(id).severity);
      if (!memberSeverities.includes(cluster.adjudicatedSeverity) && cluster.evidenceRefs.length === 0) {
        throw new Error("severity_change_evidence");
      }
    }
  }
  if (seen.size !== submitted.size) throw new Error("finding_coverage");
  if (output.judgeConcern !== null) {
    assertByteLimit(output.judgeConcern.claim, 8 * 1024);
    assertByteLimit(output.judgeConcern.rationale, 8 * 1024);
    const changedPaths = new Set((input?.packet?.manifest?.entries || []).map((entry) => entry.path));
    for (const reference of output.judgeConcern.evidenceRefs) {
      assertEvidenceRef(reference, input?.packet, null, changedPaths);
    }
  }
  return output;
}

export function deriveFissionResult(input) {
  if (input?.preflight?.state === "NO_CHANGES") {
    return { verdict: null, message: "no changes to review." };
  }
  const subjectPacket = input?.packet?.kind === "subject";
  const repoReady = input?.preflight?.state === "READY";
  if (
    (!subjectPacket && !repoReady) ||
    input.packet?.evidenceComplete !== true ||
    input.sourceVerified !== true ||
    input.artifactsVerified !== true
  ) return { verdict: "INCOMPLETE", message: "review evidence is incomplete." };
  const requestedCount = input.requestedReviewers;
  const reviewers = input.reviewers;
  if (
    !Number.isInteger(requestedCount) ||
    requestedCount < 1 ||
    !Array.isArray(reviewers) ||
    reviewers.length !== requestedCount
  ) return { verdict: "INCOMPLETE", message: "reviewer quorum is incomplete." };
  const completedRoles = new Set();
  for (const reviewer of reviewers) {
    // Informational packet notes in errors[] are warnings when findings exist.
    // Only empty findings + non-empty errors means the reviewer failed closed.
    const fatalReviewerErrors =
      Array.isArray(reviewer?.output?.errors) &&
      reviewer.output.errors.length !== 0 &&
      !(Array.isArray(reviewer?.output?.findings) && reviewer.output.findings.length > 0);
    if (
      reviewer?.status !== "ok" ||
      reviewer?.valid !== true ||
      reviewer?.malformed ||
      !Value.Check(ReviewerOutputSchema, reviewer?.output) ||
      fatalReviewerErrors
    ) {
      return { verdict: "INCOMPLETE", message: "reviewer output is incomplete." };
    }
    // Each reviewer must own a distinct specialty; duplicates cannot form a quorum.
    if (completedRoles.has(reviewer.output.reviewerRole)) {
      return {
        verdict: "INCOMPLETE",
        message:
          "reviewer roles must be distinct (duplicate specialty in /fission setup).",
      };
    }
    completedRoles.add(reviewer.output.reviewerRole);
  }
  if (
    input.judge?.status !== "ok" ||
    input.judge.valid !== true ||
    input.judge.malformed ||
    !Value.Check(JudgeOutputSchema, input.judge.output) ||
    input.judge.output.judgeConcern !== null
  ) return { verdict: "INCOMPLETE", message: "judge output is incomplete." };
  if (input.judge.output.clusters.some((cluster) =>
    cluster.disposition === "needs_probe" || cluster.disposition === "human_decision")) {
    return { verdict: "INCOMPLETE", message: "judge left findings unresolved." };
  }
  if (input.judge.output.clusters.some((cluster) =>
    cluster.disposition === "validated" && ["critical", "high"].includes(cluster.adjudicatedSeverity))) {
    return { verdict: "FAIL", message: "a submitted blocking finding was validated." };
  }
  return { verdict: "PASS", message: "no submitted blocking finding validated." };
}
