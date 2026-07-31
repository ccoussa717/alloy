import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { parseStrictJsonObject } from "../../lib/strict-json.mjs";
import {
  ArtifactKindSchema,
  DispositionSchema,
  FindingSchema,
  JudgeOutputSchema,
  ReviewerOutputSchema,
  ReviewerRoleSchema,
  SeveritySchema,
  deriveFissionResult,
  findingId,
  validateJudgeOutput,
  validateReviewerOutput,
} from "../../lib/fission-schema.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const packet = {
  evidenceComplete: true,
  artifacts: {
    "staged.diff": {
      type: "staged_diff",
      path: "staged.diff",
      digest: digestA,
      size: 20,
      lineCount: 4,
      mode: 0o400,
    },
    "files/a.txt": {
      type: "file",
      path: "files/a.txt",
      digest: digestB,
      size: 10,
      lineCount: 2,
      mode: 0o100644,
    },
  },
};

function finding(overrides = {}) {
  return {
    severity: "high",
    claim: "The change can lose data.",
    affectedPath: "a.txt",
    location: {
      artifact: "staged_diff",
      artifactPath: "staged.diff",
      lineStart: 1,
      lineEnd: 2,
      artifactDigest: digestA,
    },
    evidence: "The accepted diff removes the durable write.",
    reproduction: "Run the operation and interrupt after line 2.",
    suggestedFix: "Make the durable write precede acknowledgement.",
    confidence: 0.9,
    ...overrides,
  };
}

function reviewer(overrides = {}) {
  return {
    reviewerRole: "correctness_regressions",
    coverage: ["durability", "failure handling"],
    findings: [finding()],
    errors: [],
    ...overrides,
  };
}

function ref(overrides = {}) {
  return {
    artifactPath: "staged.diff",
    artifactDigest: digestA,
    lineStart: 1,
    lineEnd: 2,
    ...overrides,
  };
}

test("strict JSON accepts one lowercase fence and rejects prose, trailing JSON, and malformed input", () => {
  assert.deepEqual(parseStrictJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(parseStrictJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  for (const text of [
    '```JSON\n{"ok":true}\n```',
    'prefix {"ok":true}',
    '{"ok":true} suffix',
    '{}{}',
    '{"ok":}',
    '[]',
  ]) assert.throws(() => parseStrictJsonObject(text));
});

test("strict JSON rejects decoded duplicate keys recursively", () => {
  assert.throws(() => parseStrictJsonObject('{"a":1,"\\u0061":2}'), /duplicate_key/);
  assert.throws(() => parseStrictJsonObject('{"outer":{"x":1,"x":2}}'), /duplicate_key/);
});

test("strict JSON enforces depth, node, token, and output byte boundaries", () => {
  const nested = (depth) => `${'{"x":'.repeat(depth - 1)}{}${"}".repeat(depth - 1)}`;
  assert.doesNotThrow(() => parseStrictJsonObject(nested(64)));
  assert.throws(() => parseStrictJsonObject(nested(65)), /depth_limit/);

  const nodes = (count) => `{"x":[${Array.from({ length: count - 2 }, () => "0").join(",")}]} `;
  assert.doesNotThrow(() => parseStrictJsonObject(nodes(20_000)));
  assert.throws(() => parseStrictJsonObject(nodes(20_001)), /node_limit/);

  assert.doesNotThrow(() => parseStrictJsonObject('{"a":[],"b":false}', { tokens: 10 }));
  assert.throws(() => parseStrictJsonObject('{"a":[],"b":false}', { tokens: 9 }), /token_limit/);
  const exact = `{"x":"${"a".repeat(256 * 1024 - 8)}"}`;
  assert.equal(Buffer.byteLength(exact), 256 * 1024);
  assert.doesNotThrow(() => parseStrictJsonObject(exact));
  assert.throws(() => parseStrictJsonObject(`${exact} `), /output_limit/);
});

test("strict JSON lexes escaped strings, numbers, booleans, and null", () => {
  assert.deepEqual(
    parseStrictJsonObject('{"escaped":"\\u0061","number":-1.2e3,"yes":true,"no":false,"nil":null}'),
    { escaped: "a", number: -1200, yes: true, no: false, nil: null },
  );
});

test("exported TypeBox contracts are strict and cover every union member", () => {
  for (const role of [
    "general_adversarial",
    "correctness_regressions",
    "security_trust_boundaries",
    "architecture_failure_handling",
    "test_quality_spec_coverage",
    "performance_concurrency_resources",
  ]) assert.equal(Value.Check(ReviewerRoleSchema, role), true);
  for (const severity of ["critical", "high", "medium", "low"])
    assert.equal(Value.Check(SeveritySchema, severity), true);
  for (const kind of ["staged_diff", "unstaged_diff", "file"])
    assert.equal(Value.Check(ArtifactKindSchema, kind), true);
  for (const disposition of ["validated", "rejected", "needs_probe", "human_decision"])
    assert.equal(Value.Check(DispositionSchema, disposition), true);

  assert.equal(Value.Check(FindingSchema, finding()), true);
  assert.equal(Value.Check(FindingSchema, { ...finding(), unknown: true }), false);
  assert.equal(Value.Check(ReviewerOutputSchema, reviewer()), true);
  assert.equal(Value.Check(ReviewerOutputSchema, { ...reviewer(), unknown: true }), false);
  assert.equal(Value.Check(JudgeOutputSchema, { clusters: [], judgeConcern: null }), true);
  assert.equal(Value.Check(JudgeOutputSchema, { clusters: [] }), false);
});

test("reviewer validation enforces exact role, unique coverage, finite confidence, bytes, and packet refs", () => {
  assert.deepEqual(
    validateReviewerOutput({ output: reviewer(), reviewerRole: "correctness_regressions", packet }),
    reviewer(),
  );
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ reviewerRole: "general_adversarial" }),
    reviewerRole: "correctness_regressions",
    packet,
  }), /reviewer_role/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ coverage: ["same", "same"] }), reviewerRole: "correctness_regressions", packet,
  }), /coverage/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ confidence: Infinity })] }),
    reviewerRole: "correctness_regressions", packet,
  }));
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ claim: "é".repeat(5_000) })] }),
    reviewerRole: "correctness_regressions", packet,
  }), /byte_limit/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ location: { ...finding().location, artifactDigest: digestB } })] }),
    reviewerRole: "correctness_regressions", packet,
  }), /evidence_ref/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ location: { ...finding().location, lineEnd: 5 } })] }),
    reviewerRole: "correctness_regressions", packet,
  }), /line_range/);
});

test("finding IDs are stable lowercase identifiers over canonical finding fields", () => {
  const first = findingId("correctness", 0, finding());
  assert.match(first, /^F[0-9a-f]{24}$/);
  assert.equal(first, findingId("correctness", 0, finding()));
  assert.notEqual(first, findingId("correctness", 1, finding()));
  assert.notEqual(first, findingId("security", 0, finding()));
  assert.notEqual(first, findingId("correctness", 0, finding({ claim: "Different" })));
});

test("judge validation requires exhaustive unique clusters and disposition evidence rules", () => {
  const submittedFinding = finding();
  const id = findingId("correctness", 0, submittedFinding);
  const submitted = [{ id, finding: submittedFinding }];
  const valid = {
    clusters: [{
      canonicalFindingId: id,
      findingIds: [id],
      disposition: "validated",
      adjudicatedSeverity: "high",
      rationale: "The packet evidence supports the finding.",
      evidenceRefs: [ref()],
    }],
    judgeConcern: null,
  };
  assert.deepEqual(validateJudgeOutput({ output: valid, findings: submitted, packet }), valid);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, clusters: [] }, findings: submitted, packet,
  }), /coverage/);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, clusters: [{ ...valid.clusters[0], canonicalFindingId: `F${"c".repeat(24)}` }] },
    findings: submitted, packet,
  }), /canonical/);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, clusters: [{ ...valid.clusters[0], adjudicatedSeverity: null }] },
    findings: submitted, packet,
  }), /severity/);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, clusters: [{ ...valid.clusters[0], disposition: "rejected" }] },
    findings: submitted, packet,
  }), /severity/);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, clusters: [{ ...valid.clusters[0], adjudicatedSeverity: "critical", evidenceRefs: [] }] },
    findings: submitted, packet,
  }), /evidence/);
  assert.throws(() => validateJudgeOutput({
    output: { ...valid, judgeConcern: { claim: "Concern", rationale: "Reason", evidenceRefs: [] } },
    findings: submitted, packet,
  }));
});

test("host verdict table is ordered and reviewer agreement never determines PASS", () => {
  const pass = { clusters: [{ disposition: "rejected", adjudicatedSeverity: null }], judgeConcern: null };
  const cases = [
    [{ preflight: { state: "NO_CHANGES" } }, "NO_CHANGES"],
    [{ preflight: { state: "READY" }, packet: { evidenceComplete: false } }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, sourceVerified: false }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [{ status: "timeout" }] }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [{ status: "ok", output: { errors: ["failed"] } }] }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [], judge: { status: "timeout" } }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [], judge: { status: "ok", output: { ...pass, judgeConcern: { claim: "x" } } } }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [], judge: { status: "ok", output: { clusters: [{ disposition: "needs_probe", adjudicatedSeverity: null }], judgeConcern: null } } }, "INCOMPLETE"],
    [{ preflight: { state: "READY" }, packet, reviewers: [], judge: { status: "ok", output: { clusters: [{ disposition: "validated", adjudicatedSeverity: "critical" }], judgeConcern: null } } }, "FAIL"],
    [{ preflight: { state: "READY" }, packet, reviewers: [], judge: { status: "ok", output: pass } }, "PASS"],
  ];
  for (const [input, verdict] of cases) assert.equal(deriveFissionResult(input).verdict, verdict);
  assert.equal(
    deriveFissionResult(cases.at(-1)[0]).message,
    "no submitted blocking finding validated.",
  );
});
