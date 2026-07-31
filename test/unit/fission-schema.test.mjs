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
  manifest: {
    entries: [{ path: "a.txt", included: true, artifactPath: "files/a.txt" }],
  },
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
    "request.txt": {
      type: "request",
      path: "request.txt",
      digest: "c".repeat(64),
      size: 10,
      lineCount: 2,
      mode: 0o400,
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

test("strict JSON retains prototype-named keys as inert own data properties", () => {
  const parsed = parseStrictJsonObject(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"owned":true}},"prototype":{"x":1},"nested":{"__proto__":"safe"}}',
  );
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(Object.hasOwn(parsed, "constructor"), true);
  assert.equal(Object.hasOwn(parsed, "prototype"), true);
  assert.equal(Object.hasOwn(parsed.nested, "__proto__"), true);
  assert.deepEqual(parsed.__proto__, { polluted: true });
  assert.equal(parsed.nested.__proto__, "safe");
  assert.equal({}.polluted, undefined);
  assert.equal({}.owned, undefined);
});

test("prototype-named unknown properties cannot bypass strict TypeBox schemas", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const output = parseStrictJsonObject(JSON.stringify({ ...reviewer(), [key]: "unexpected" }));
    assert.equal(Object.hasOwn(output, key), true);
    assert.equal(Value.Check(ReviewerOutputSchema, output), false);
  }
  const nested = parseStrictJsonObject(JSON.stringify({
    ...reviewer(),
    findings: [{ ...finding(), location: { ...finding().location, __proto_marker: true } }],
  }));
  assert.equal(Value.Check(ReviewerOutputSchema, nested), false);
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

test("strict JSON accepts exactly 50,000 lexical tokens and rejects token 50,001", () => {
  const fixture = (emptyContainers) => {
    const properties = [];
    for (let index = 0; index < 12_499; index += 1) {
      properties.push(`"k${index}":${index < emptyContainers ? "[]" : "0"}`);
    }
    return `{${properties.join(",")}}`;
  };
  assert.doesNotThrow(() => parseStrictJsonObject(fixture(3)));
  assert.throws(() => parseStrictJsonObject(fixture(4)), /token_limit/);
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

test("all required properties and recursive unknown properties are enforced", () => {
  const remove = (value, key) => {
    const copy = structuredClone(value);
    delete copy[key];
    return copy;
  };
  for (const key of ["reviewerRole", "coverage", "findings", "errors"]) {
    assert.equal(Value.Check(ReviewerOutputSchema, remove(reviewer(), key)), false, `reviewer.${key}`);
  }
  for (const key of [
    "severity", "claim", "affectedPath", "location", "evidence", "reproduction", "suggestedFix", "confidence",
  ]) assert.equal(Value.Check(FindingSchema, remove(finding(), key)), false, `finding.${key}`);
  for (const key of ["artifact", "artifactPath", "lineStart", "lineEnd", "artifactDigest"]) {
    const invalid = finding({ location: remove(finding().location, key) });
    assert.equal(Value.Check(FindingSchema, invalid), false, `location.${key}`);
  }

  const id = findingId("correctness", 0, finding());
  const cluster = {
    canonicalFindingId: id,
    findingIds: [id],
    disposition: "validated",
    adjudicatedSeverity: "high",
    rationale: "supported",
    evidenceRefs: [ref()],
  };
  const judge = { clusters: [cluster], judgeConcern: null };
  for (const key of ["clusters", "judgeConcern"])
    assert.equal(Value.Check(JudgeOutputSchema, remove(judge, key)), false, `judge.${key}`);
  for (const key of [
    "canonicalFindingId", "findingIds", "disposition", "adjudicatedSeverity", "rationale", "evidenceRefs",
  ]) {
    assert.equal(
      Value.Check(JudgeOutputSchema, { ...judge, clusters: [remove(cluster, key)] }),
      false,
      `cluster.${key}`,
    );
  }
  for (const [label, invalid] of [
    ["finding", reviewer({ findings: [{ ...finding(), unknown: true }] })],
    ["location", reviewer({ findings: [finding({ location: { ...finding().location, unknown: true } })] })],
  ]) assert.equal(Value.Check(ReviewerOutputSchema, invalid), false, label);
  for (const [label, invalid] of [
    ["cluster", { ...judge, clusters: [{ ...cluster, unknown: true }] }],
    ["evidenceRef", { ...judge, clusters: [{ ...cluster, evidenceRefs: [{ ...ref(), unknown: true }] }] }],
    ["concern", { ...judge, judgeConcern: { claim: "c", rationale: "r", evidenceRefs: [ref()], unknown: true } }],
  ]) assert.equal(Value.Check(JudgeOutputSchema, invalid), false, label);
});

test("schema nullability is exact at every nullable boundary", () => {
  const id = findingId("correctness", 0, finding());
  const baseCluster = {
    canonicalFindingId: id,
    findingIds: [id],
    disposition: "rejected",
    adjudicatedSeverity: null,
    rationale: "rejected",
    evidenceRefs: [],
  };
  assert.equal(Value.Check(JudgeOutputSchema, { clusters: [baseCluster], judgeConcern: null }), true);
  assert.equal(Value.Check(JudgeOutputSchema, {
    clusters: [{ ...baseCluster, disposition: "validated", adjudicatedSeverity: "high", evidenceRefs: [ref()] }],
    judgeConcern: { claim: "Concern", rationale: "Supported", evidenceRefs: [ref()] },
  }), true);
  for (const value of [null, undefined]) {
    assert.equal(Value.Check(FindingSchema, { ...finding(), claim: value }), false);
    assert.equal(Value.Check(FindingSchema, { ...finding(), location: value }), false);
  }
  assert.equal(Value.Check(JudgeOutputSchema, {
    clusters: [{ ...baseCluster, adjudicatedSeverity: undefined }], judgeConcern: null,
  }), false);
  assert.equal(Value.Check(JudgeOutputSchema, { clusters: [], judgeConcern: undefined }), false);
});

test("schema collection counts enforce exact accepted and +1 boundaries", () => {
  assert.equal(Value.Check(ReviewerOutputSchema, reviewer({
    coverage: Array.from({ length: 20 }, (_, index) => `area-${index}`),
    findings: Array.from({ length: 50 }, () => finding()),
    errors: Array.from({ length: 10 }, () => "error"),
  })), true);
  assert.equal(Value.Check(ReviewerOutputSchema, reviewer({
    coverage: Array.from({ length: 21 }, (_, index) => `area-${index}`),
  })), false);
  assert.equal(Value.Check(ReviewerOutputSchema, reviewer({ findings: Array.from({ length: 51 }, () => finding()) })), false);
  assert.equal(Value.Check(ReviewerOutputSchema, reviewer({ errors: Array.from({ length: 11 }, () => "error") })), false);

  const id = findingId("correctness", 0, finding());
  const cluster = {
    canonicalFindingId: id,
    findingIds: [id],
    disposition: "validated",
    adjudicatedSeverity: "high",
    rationale: "supported",
    evidenceRefs: Array.from({ length: 20 }, () => ref()),
  };
  assert.equal(Value.Check(JudgeOutputSchema, { clusters: [cluster], judgeConcern: null }), true);
  assert.equal(Value.Check(JudgeOutputSchema, {
    clusters: [{ ...cluster, evidenceRefs: Array.from({ length: 21 }, () => ref()) }], judgeConcern: null,
  }), false);
  assert.equal(Value.Check(JudgeOutputSchema, {
    clusters: [], judgeConcern: { claim: "c", rationale: "r", evidenceRefs: [] },
  }), false);
});

test("semantic UTF-8 byte limits accept exact bounds and reject +1", () => {
  const exactCoverage = "é".repeat(256);
  const exactNarrative = "é".repeat(4 * 1024);
  const exactPath = "é".repeat(2 * 1024);
  const exactPacket = {
    ...packet,
    manifest: { entries: [...packet.manifest.entries, { path: exactPath, included: false, artifactPath: null }] },
  };
  assert.doesNotThrow(() => validateReviewerOutput({
    output: reviewer({
      coverage: [exactCoverage],
      findings: [finding({ claim: exactNarrative, affectedPath: exactPath })],
      errors: ["é".repeat(1024)],
    }),
    reviewerRole: "correctness_regressions",
    packet: exactPacket,
  }));
  for (const output of [
    reviewer({ coverage: [`${exactCoverage}é`] }),
    reviewer({ findings: [finding({ claim: `${exactNarrative}é` })] }),
    reviewer({ findings: [finding({ affectedPath: `${exactPath}é` })] }),
    reviewer({ errors: [`${"é".repeat(1024)}é`] }),
  ]) assert.throws(() => validateReviewerOutput({
    output,
    reviewerRole: "correctness_regressions",
    packet: output.findings?.[0]?.affectedPath === `${exactPath}é`
      ? { ...packet, manifest: { entries: [{ path: `${exactPath}é`, included: false, artifactPath: null }] } }
      : packet,
  }), /byte_limit/);
});

test("evidence references and judge concerns require every exact property", () => {
  const id = findingId("correctness", 0, finding());
  const cluster = {
    canonicalFindingId: id,
    findingIds: [id],
    disposition: "validated",
    adjudicatedSeverity: "high",
    rationale: "supported",
    evidenceRefs: [ref()],
  };
  for (const key of ["artifactPath", "artifactDigest", "lineStart", "lineEnd"]) {
    const invalidRef = { ...ref() };
    delete invalidRef[key];
    assert.equal(Value.Check(JudgeOutputSchema, {
      clusters: [{ ...cluster, evidenceRefs: [invalidRef] }], judgeConcern: null,
    }), false, `evidenceRef.${key}`);
  }
  for (const key of ["claim", "rationale", "evidenceRefs"]) {
    const concern = { claim: "Concern", rationale: "Supported", evidenceRefs: [ref()] };
    delete concern[key];
    assert.equal(Value.Check(JudgeOutputSchema, { clusters: [cluster], judgeConcern: concern }), false, `concern.${key}`);
  }
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
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ affectedPath: "missing.txt" })] }),
    reviewerRole: "correctness_regressions", packet,
  }), /affected_path/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({
      location: {
        artifact: "file",
        artifactPath: "files/a.txt",
        artifactDigest: digestB,
        lineStart: 1,
        lineEnd: 1,
      },
      affectedPath: "other.txt",
    })] }),
    reviewerRole: "correctness_regressions", packet: {
      ...packet,
      manifest: { entries: [...packet.manifest.entries, { path: "other.txt", included: false }] },
    },
  }), /affected_path/);
  assert.throws(() => validateReviewerOutput({
    output: reviewer({ findings: [finding({ location: {
      artifact: "staged_diff",
      artifactPath: "request.txt",
      artifactDigest: "c".repeat(64),
      lineStart: 1,
      lineEnd: 1,
    } })] }),
    reviewerRole: "correctness_regressions", packet,
  }), /evidence_ref/);
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
  assert.throws(() => validateJudgeOutput({
    output: {
      ...valid,
      clusters: [{ ...valid.clusters[0], evidenceRefs: [{
        artifactPath: "request.txt",
        artifactDigest: "c".repeat(64),
        lineStart: 1,
        lineEnd: 1,
      }] }],
    },
    findings: submitted,
    packet,
  }), /evidence_ref/);
});

test("host verdict table is ordered and reviewer agreement never determines PASS", () => {
  const id = findingId("correctness", 0, finding());
  const rejectedCluster = {
    canonicalFindingId: id,
    findingIds: [id],
    disposition: "rejected",
    adjudicatedSeverity: null,
    rationale: "not supported",
    evidenceRefs: [],
  };
  const pass = { clusters: [rejectedCluster], judgeConcern: null };
  const complete = {
    preflight: { state: "READY" },
    packet,
    sourceVerified: true,
    artifactsVerified: true,
    requestedReviewers: 1,
    reviewers: [{ status: "ok", valid: true, output: reviewer() }],
    judge: { status: "ok", valid: true, output: pass },
  };
  const cases = [
    [{ preflight: { state: "NO_CHANGES" } }, null],
    [{ preflight: { state: "READY" }, packet: { evidenceComplete: false } }, "INCOMPLETE"],
    [{ ...complete, sourceVerified: undefined }, "INCOMPLETE"],
    [{ ...complete, sourceVerified: false }, "INCOMPLETE"],
    [{ ...complete, artifactsVerified: undefined }, "INCOMPLETE"],
    [{ ...complete, artifactsVerified: false }, "INCOMPLETE"],
    [{ ...complete, requestedReviewers: undefined }, "INCOMPLETE"],
    [{ ...complete, requestedReviewers: 0 }, "INCOMPLETE"],
    [{ ...complete, requestedReviewers: 1.5 }, "INCOMPLETE"],
    [{ ...complete, reviewers: [] }, "INCOMPLETE"],
    [{ ...complete, reviewers: [null] }, "INCOMPLETE"],
    [{ ...complete, reviewers: [{ status: "timeout", valid: false }] }, "INCOMPLETE"],
    [{ ...complete, reviewers: [{ status: "ok", valid: false, output: reviewer() }] }, "INCOMPLETE"],
    [{ ...complete, reviewers: [{ status: "ok", valid: true, output: reviewer({ errors: ["failed"] }) }] }, "INCOMPLETE"],
    [{ ...complete, requestedReviewers: 2, reviewers: [...complete.reviewers, ...complete.reviewers] }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "timeout", valid: false } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: false, output: pass } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: true, output: { clusters: [null], judgeConcern: null } } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: true, output: { ...pass, judgeConcern: { claim: "x" } } } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: true, output: { ...pass, judgeConcern: { claim: "Concern", rationale: "Supported", evidenceRefs: [ref()] } } } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: true, output: { clusters: [{ ...rejectedCluster, disposition: "needs_probe" }], judgeConcern: null } } }, "INCOMPLETE"],
    [{ ...complete, judge: { status: "ok", valid: true, output: { clusters: [{ ...rejectedCluster, disposition: "validated", adjudicatedSeverity: "critical", evidenceRefs: [ref()] }], judgeConcern: null } } }, "FAIL"],
    [complete, "PASS"],
  ];
  for (const [input, verdict] of cases) assert.equal(deriveFissionResult(input).verdict, verdict);
  assert.deepEqual(deriveFissionResult({ preflight: { state: "NO_CHANGES" } }), {
    verdict: null,
    message: "no changes to review.",
  });
  assert.equal(
    deriveFissionResult(cases.at(-1)[0]).message,
    "no submitted blocking finding validated.",
  );
});
