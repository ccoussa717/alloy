import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalJson,
  compileTeam,
  sha256Canonical,
} from "../../packages/pi-teams/src/core/compiler.ts";
import {
  approvalBinding,
  intersectMemberPolicy,
  policyDigest,
  verifyApprovalBinding,
} from "../../packages/pi-teams/src/core/policy.ts";

function definition() {
  return {
    apiVersion: "pi.dev/teams/v1alpha1",
    kind: "Team",
    metadata: {
      name: "investigate",
      description: "Investigate repository evidence.",
    },
    spec: {
      limits: {
        maxConcurrency: 2,
        maxCostUsd: 2,
        timeoutMs: 300_000,
        maxMembers: 3,
      },
      members: [
        {
          id: "architecture",
          route: "research",
          capabilities: ["repo.read"],
          tools: ["read", "grep"],
          needs: [],
          instructions: "Map the architecture.",
        },
        {
          id: "risks",
          route: "review",
          capabilities: ["repo.read"],
          tools: ["grep", "find"],
          needs: [],
          instructions: "Review the risks.",
        },
        {
          id: "lead",
          route: "planning",
          capabilities: ["repo.read"],
          tools: ["read", "ls"],
          needs: ["architecture", "risks"],
          instructions: "Synthesize the evidence.",
        },
      ],
    },
  };
}

function entry(overrides = {}) {
  return {
    ref: "builtin/investigate",
    source: "builtin",
    origin: "builtin/investigate.yaml",
    definition: definition(),
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function host(overrides = {}) {
  return {
    capabilities: ["repo.read"],
    tools: ["read", "grep", "find", "ls"],
    maxConcurrency: 2,
    supportsCancellation: true,
    ...overrides,
  };
}

function member(overrides = {}) {
  return {
    id: "reader",
    route: "research",
    capabilities: ["repo.read"],
    tools: ["read", "grep"],
    needs: [],
    instructions: "Read repository evidence.",
    ...overrides,
  };
}

function admitted(overrides = {}) {
  return {
    ok: true,
    memberId: "reader",
    effectiveRoute: "research",
    effectiveModel: "provider/model",
    effectiveCapabilities: ["repo.read"],
    effectiveTools: ["grep", "read"],
    maxCostUsd: 2 / 3,
    timeoutMs: 120_000,
    token: { opaque: true },
    ...overrides,
  };
}

function policyInput(overrides = {}) {
  return {
    member: member(),
    host: host(),
    admission: admitted(),
    maxCostUsd: 2 / 3,
    timeoutMs: 300_000,
    ...overrides,
  };
}

function admissionsForTeam() {
  return [
    admitted({
      memberId: "architecture",
      effectiveRoute: "research",
      effectiveTools: ["read", "grep"],
    }),
    admitted({
      memberId: "risks",
      effectiveRoute: "review",
      effectiveTools: ["grep", "find"],
    }),
    admitted({
      memberId: "lead",
      effectiveRoute: "planning",
      effectiveTools: ["read", "ls"],
    }),
  ];
}

function blockedAdmission(memberId, overrides = {}) {
  return {
    ok: false,
    memberId,
    effectiveRoute: null,
    effectiveModel: null,
    effectiveCapabilities: [],
    effectiveTools: [],
    maxCostUsd: 2 / 3,
    reason: "operator_denied",
    ...overrides,
  };
}

// Break caught: key insertion order accidentally changes canonical hashes.
test("canonical JSON recursively sorts mapping keys and preserves array order", () => {
  const left = { z: { b: 2, a: 1 }, a: [3, 2, 1] };
  const right = { a: [3, 2, 1], z: { a: 1, b: 2 } };

  assert.equal(canonicalJson(left), '{"a":[3,2,1],"z":{"a":1,"b":2}}');
  assert.equal(sha256Canonical(left), sha256Canonical(right));
  assert.notEqual(sha256Canonical({ a: [1, 2] }), sha256Canonical({ a: [2, 1] }));
});

// Break caught: values JSON cannot faithfully represent are silently discarded or coerced.
test("canonical JSON rejects undefined, nonfinite, and non-JSON values", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse.length = 1;
  const arrayWithIgnoredNumericProperty = [];
  arrayWithIgnoredNumericProperty[4_294_967_295] = "ignored by JSON";
  const invalid = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol("value"),
    () => undefined,
    new Date(0),
    { missing: undefined },
    [undefined],
    sparse,
    arrayWithIgnoredNumericProperty,
    cyclic,
  ];

  for (const value of invalid) {
    assert.throws(() => canonicalJson(value), /canonical_json/);
  }
});

// Break caught: canonicalization executes accessors or replaces malformed Unicode.
test("canonical JSON rejects accessors and malformed Unicode without invoking getters", () => {
  let getterCalls = 0;
  const objectAccessor = {};
  Object.defineProperty(objectAccessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "secret";
    },
  });
  const arrayAccessor = [];
  Object.defineProperty(arrayAccessor, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "secret";
    },
  });
  arrayAccessor.length = 1;

  assert.throws(() => canonicalJson(objectAccessor), /canonical_json/);
  assert.throws(() => canonicalJson(arrayAccessor), /canonical_json/);
  assert.throws(() => canonicalJson("\ud800"), /canonical_json/);
  assert.throws(() => canonicalJson({ "\udfff": "value" }), /canonical_json/);
  assert.equal(getterCalls, 0);
});

// Break caught: a ready member is selected by map/set order instead of declaration order.
test("compiler uses declaration order as the stable topological tie-breaker", () => {
  const reordered = definition();
  reordered.spec.members = [
    reordered.spec.members[2],
    reordered.spec.members[0],
    reordered.spec.members[1],
  ];

  assert.deepEqual(compileTeam(entry({ definition: reordered })).topologicalOrder, [
    "architecture",
    "risks",
    "lead",
  ]);
});

// Break caught: dependency declaration order leaks into semantically equivalent digests.
test("compiler sorts needs for digest input", () => {
  const first = definition();
  const second = definition();
  second.spec.members[2].needs = ["risks", "architecture"];

  const firstCompiled = compileTeam(entry({ definition: first }));
  const secondCompiled = compileTeam(entry({ definition: second }));
  assert.equal(firstCompiled.manifestDigest, secondCompiled.manifestDigest);
  assert.equal(firstCompiled.planDigest, secondCompiled.planDigest);
});

// Break caught: compiled manifests remain mutable after authority was digested.
test("compiler deeply freezes its normalized definition", () => {
  const input = entry();
  const compiled = compileTeam(input);
  input.definition.metadata.description = "Changed after compilation.";

  assert.equal(compiled.definition.metadata.description, "Investigate repository evidence.");
  assert.ok(Object.isFrozen(compiled.definition));
  assert.ok(Object.isFrozen(compiled.definition.spec.members));
  assert.ok(Object.isFrozen(compiled.definition.spec.members[0].tools));
  assert.throws(() => { compiled.definition.spec.members[0].tools.push("ls"); }, TypeError);
});

// Break caught: a member can depend on itself and enter a permanently blocked plan.
test("compiler rejects self-dependencies", () => {
  const invalid = definition();
  invalid.spec.members[0].needs = ["architecture"];
  assert.throws(() => compileTeam(entry({ definition: invalid })), /dag_self:architecture/);
});

// Break caught: a dependency typo survives compilation.
test("compiler rejects unknown dependencies", () => {
  const invalid = definition();
  invalid.spec.members[2].needs = ["missing"];
  assert.throws(
    () => compileTeam(entry({ definition: invalid })),
    /dag_unknown:lead -> missing/,
  );
});

// Break caught: duplicate IDs collapse distinct member nodes.
test("compiler rejects duplicate member IDs", () => {
  const invalid = definition();
  invalid.spec.members[1].id = "architecture";
  assert.throws(() => compileTeam(entry({ definition: invalid })), /dag_duplicate:architecture/);
});

// Break caught: a two-node cycle is reported without a concrete deterministic path.
test("compiler rejects two-node cycles with a concrete path", () => {
  const invalid = definition();
  invalid.spec.members[0].needs = ["lead"];
  invalid.spec.members[2].needs = ["architecture"];
  assert.throws(
    () => compileTeam(entry({ definition: invalid })),
    /dag_cycle:architecture -> lead -> architecture/,
  );
});

// Break caught: cycle detection only handles direct pairs.
test("compiler rejects longer cycles with a concrete path", () => {
  const invalid = definition();
  invalid.spec.members[0].needs = ["risks"];
  invalid.spec.members[1].needs = ["lead"];
  invalid.spec.members[2].needs = ["architecture"];
  assert.throws(
    () => compileTeam(entry({ definition: invalid })),
    /dag_cycle:architecture -> risks -> lead -> architecture/,
  );
});

// Break caught: a meaningful manifest field can change without invalidating its digest.
test("manifest digest binds every mutable manifest field", () => {
  const base = entry();
  const baseDigest = compileTeam(base).manifestDigest;
  const mutations = [
    (value) => { value.definition.metadata.name = "investigation"; },
    (value) => { value.definition.metadata.description = "Different description."; },
    (value) => { value.definition.spec.limits.maxConcurrency = 1; },
    (value) => { value.definition.spec.limits.maxCostUsd = 1; },
    (value) => { value.definition.spec.limits.timeoutMs = 200_000; },
    (value) => { value.definition.spec.members[0].route = "review"; },
    (value) => { value.definition.spec.members[0].tools = ["read"]; },
    (value) => { value.definition.spec.members[0].instructions = "Different work."; },
    (value) => { value.definition.spec.members[2].needs = ["architecture"]; },
  ];

  for (const mutate of mutations) {
    const changed = clone(base);
    mutate(changed);
    assert.notEqual(compileTeam(changed).manifestDigest, baseDigest);
  }
});

// Break caught: a plan field changes while an old execution-plan digest remains reusable.
test("plan digest binds the qualified ref, members, topology, and limits", () => {
  const base = entry();
  const baseDigest = compileTeam(base).planDigest;
  const mutations = [
    (value) => { value.ref = "user/investigate"; value.source = "user"; },
    (value) => { value.definition.spec.limits.maxConcurrency = 1; },
    (value) => { value.definition.spec.limits.maxCostUsd = 1; },
    (value) => { value.definition.spec.limits.timeoutMs = 200_000; },
    (value) => { value.definition.spec.members[0].route = "review"; },
    (value) => { value.definition.spec.members[0].tools = ["read"]; },
    (value) => { value.definition.spec.members[0].instructions = "Different work."; },
    (value) => { value.definition.spec.members[2].needs = ["architecture"]; },
    (value) => { value.definition.spec.members = [value.definition.spec.members[1], value.definition.spec.members[0], value.definition.spec.members[2]]; },
  ];

  for (const mutate of mutations) {
    const changed = clone(base);
    mutate(changed);
    assert.notEqual(compileTeam(changed).planDigest, baseDigest);
  }
});

// Break caught: compiler accepts authority or limits outside Slice 1's fixed package contract.
test("compiler defensively rejects unsupported fields and invalid limits", () => {
  const mutations = [
    [(value) => { value.definition.spec.members[0].route = "writer"; }, /compile_route/],
    [(value) => { value.definition.spec.members[0].capabilities = ["repo.write"]; }, /compile_capability/],
    [(value) => { value.definition.spec.members[0].tools = ["bash"]; }, /compile_tool/],
    [(value) => { value.definition.spec.limits.maxConcurrency = 4; }, /compile_limit/],
    [(value) => { value.definition.spec.limits.maxMembers = 2; }, /compile_limit/],
    [(value) => { value.definition.spec.limits.maxCostUsd = 2.5; }, /compile_limit/],
    [(value) => { value.definition.spec.limits.timeoutMs = 0; }, /compile_limit/],
    [(value) => { value.definition.metadata.description = "x".repeat(1_025); }, /compile_text/],
    [(value) => { value.definition.spec.members[0].instructions = "x".repeat(8_193); }, /compile_text/],
  ];

  for (const [mutate, expected] of mutations) {
    const invalid = entry();
    mutate(invalid);
    assert.throws(() => compileTeam(invalid), expected);
  }
});

// Break caught: a host admission can silently drop manifest-requested authority.
test("policy admits only the complete package-host-admission-manifest intersection", () => {
  const decision = intersectMemberPolicy(policyInput());

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.effectiveCapabilities, ["repo.read"]);
  assert.deepEqual(decision.effectiveTools, ["read", "grep"]);
  assert.equal(decision.effectiveRoute, "research");
  assert.equal(decision.effectiveModel, "provider/model");
  assert.equal(decision.maxCostUsd, 2 / 3);
  assert.equal(decision.timeoutMs, 120_000);
});

// Break caught: missing upper-bound authority is silently widened or dropped instead of blocking.
test("policy blocks any requested capability or tool missing from an upper bound", () => {
  const cases = [
    policyInput({ member: member({ capabilities: ["repo.write"] }), admission: admitted({ effectiveCapabilities: ["repo.write"] }) }),
    policyInput({ host: host({ capabilities: [] }) }),
    policyInput({ admission: admitted({ effectiveCapabilities: [] }) }),
    policyInput({ member: member({ tools: ["read", "bash"] }), admission: admitted({ effectiveTools: ["read", "bash"] }) }),
    policyInput({ host: host({ tools: ["read"] }) }),
    policyInput({ admission: admitted({ effectiveTools: ["read"] }) }),
    policyInput({ admission: admitted({ effectiveTools: ["read", "grep", "find"] }) }),
  ];

  for (const input of cases) {
    const decision = intersectMemberPolicy(input);
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /^policy_/);
  }
});

// Break caught: a host can substitute another member, route, or budget allocation.
test("policy blocks mismatched member identity, semantic route, or allocation", () => {
  const cases = [
    admitted({ memberId: "other" }),
    admitted({ effectiveRoute: "review" }),
    admitted({ maxCostUsd: 1 }),
  ];

  for (const admission of cases) {
    assert.equal(intersectMemberPolicy(policyInput({ admission })).ok, false);
  }
});

// Break caught: a valid blocked host result is returned by reference instead of normalized.
test("policy validates and normalizes a blocked host admission", () => {
  const hostBlocked = blockedAdmission("reader");
  const decision = intersectMemberPolicy(policyInput({ admission: hostBlocked }));

  assert.notEqual(decision, hostBlocked);
  assert.deepEqual(decision, {
    ok: false,
    memberId: "reader",
    effectiveRoute: null,
    effectiveModel: null,
    effectiveCapabilities: [],
    effectiveTools: [],
    maxCostUsd: 2 / 3,
    reason: "operator_denied",
  });
});

// Break caught: malformed blocked host results pass through, including accessors and opaque data.
test("policy rejects malformed blocked host admissions without invoking accessors", () => {
  let getterCalls = 0;
  const accessor = blockedAdmission("reader");
  Object.defineProperty(accessor, "ok", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return false;
    },
  });
  const accessorDecision = intersectMemberPolicy(policyInput({ admission: accessor }));
  assert.equal(getterCalls, 0);
  assert.equal(accessorDecision.ok, false);
  assert.match(accessorDecision.reason, /^policy_admission:/);

  const malformed = [
    blockedAdmission("other"),
    blockedAdmission("reader", { token: { opaque: true } }),
    blockedAdmission("reader", { unknown: true }),
    blockedAdmission("reader", { reason: "   " }),
    blockedAdmission("reader", { reason: "x".repeat(1_025) }),
    blockedAdmission("reader", { reason: "\ud800" }),
    blockedAdmission("reader", { maxCostUsd: 1 }),
  ];
  for (const admission of malformed) {
    const decision = intersectMemberPolicy(policyInput({ admission }));
    assert.equal(decision.ok, false);
    assert.equal(decision.memberId, "reader");
    assert.match(decision.reason, /^policy_admission:/);
    assert.deepEqual(Object.keys(decision).sort(), [
      "effectiveCapabilities",
      "effectiveModel",
      "effectiveRoute",
      "effectiveTools",
      "maxCostUsd",
      "memberId",
      "ok",
      "reason",
    ]);
  }
});

// Break caught: compilation substitutes a concrete model for a semantic route.
test("compiled plans keep routes semantic and models admission-only", () => {
  const compiled = compileTeam(entry());
  const decision = intersectMemberPolicy(policyInput());

  assert.equal(compiled.definition.spec.members[0].route, "research");
  assert.equal("model" in compiled.definition.spec.members[0], false);
  assert.equal(decision.ok && decision.effectiveModel, "provider/model");
});

// Break caught: per-member policy rounds, truncates, or widens an exact team allocation.
test("policy retains exact per-member cost allocation", () => {
  const limits = definition().spec.limits;
  const allocation = limits.maxCostUsd / limits.maxMembers;
  const decision = intersectMemberPolicy(policyInput({
    maxCostUsd: allocation,
    admission: admitted({ maxCostUsd: allocation }),
  }));

  assert.equal(decision.ok, true);
  assert.equal(decision.maxCostUsd, 2 / 3);
});

// Break caught: a valid host timeout narrowing is discarded or widened.
test("policy admits and retains equal or narrower positive integer timeouts", () => {
  for (const timeoutMs of [300_000, 120_000, 1]) {
    const decision = intersectMemberPolicy(policyInput({ admission: admitted({ timeoutMs }) }));
    assert.equal(decision.ok, true);
    assert.equal(decision.timeoutMs, timeoutMs);
  }
});

// Break caught: an invalid or wider host timeout gains execution authority.
test("policy blocks zero, negative, fractional, nonfinite, and larger timeouts", () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 300_001]) {
    const decision = intersectMemberPolicy(policyInput({ admission: admitted({ timeoutMs }) }));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /^policy_timeout/);
  }
});

// Break caught: opaque host tokens or insertion order affect public approval policy.
test("policy digest hashes canonical public admissions and effective limits without tokens", () => {
  const compiled = compileTeam(entry());
  const limits = {
    maxConcurrency: Math.min(definition().spec.limits.maxConcurrency, host().maxConcurrency),
    maxCostUsd: 2,
    timeoutMs: 300_000,
    maxMembers: 3,
  };
  const first = admissionsForTeam();
  const second = clone(first);
  second.forEach((admission) => { admission.token = { secret: "different" }; });

  assert.equal(policyDigest(first, limits, compiled), policyDigest(second.reverse(), {
    timeoutMs: 300_000,
    maxMembers: 3,
    maxCostUsd: 2,
    maxConcurrency: 2,
  }, compiled));
  assert.notEqual(policyDigest(first, limits, compiled), policyDigest(first, {
    ...limits,
    maxConcurrency: 1,
  }, compiled));
});

// Break caught: policy hashing accepts admissions that do not correspond exactly to compiled members.
test("policy digest requires one admission per compiled member and binds declaration order", () => {
  const compiled = compileTeam(entry());
  const limits = definition().spec.limits;
  const admissions = admissionsForTeam();
  const expected = policyDigest(admissions, limits, compiled);

  assert.equal(policyDigest([...admissions].reverse(), limits, compiled), expected);
  const invalid = [
    admissions.slice(0, 2),
    [...admissions, admitted({ memberId: "unknown" })],
    [admissions[0], clone(admissions[0]), admissions[2]],
    [admissions[0], admissions[1], admitted({ memberId: "unknown" })],
  ];
  for (const value of invalid) {
    assert.throws(() => policyDigest(value, limits, compiled), /policy_admission/);
  }
});

// Break caught: well-shaped admissions can contradict compiled member and effective-limit authority.
for (const [name, change] of [
  ["package-supported but unrequested tools", { effectiveTools: ["read", "grep", "find"] }],
  ["missing requested tools", { effectiveTools: ["read"] }],
  ["the approved per-member allocation", { maxCostUsd: 1 }],
  ["the effective timeout ceiling", { timeoutMs: 300_001 }],
]) {
  test(`policy digest rejects authority contradicting ${name}`, () => {
    const compiled = compileTeam(entry());
    const limits = definition().spec.limits;
    const base = admissionsForTeam();
    const contradictory = { ...base[0], ...change };

    assert.throws(
      () => policyDigest([contradictory, base[1], base[2]], limits, compiled),
      /policy_admission/,
    );
  });
}

// Break caught: malformed or extended successful admission objects are normalized and hashed.
test("policy digest rejects malformed successful public admission shapes", () => {
  const compiled = compileTeam(entry());
  const limits = definition().spec.limits;
  const base = admissionsForTeam();
  const malformed = [
    { ...base[0], unknown: true },
    { ...base[0], ok: "true" },
    { ...base[0], memberId: 1 },
    { ...base[0], effectiveRoute: null },
    { ...base[0], effectiveModel: 1 },
    { ...base[0], effectiveCapabilities: ["repo.write"] },
    { ...base[0], effectiveTools: ["bash"] },
    { ...base[0], maxCostUsd: Number.NaN },
    { ...base[0], timeoutMs: 1.5 },
    (() => { const value = { ...base[0] }; delete value.timeoutMs; return value; })(),
  ];
  const symbolExtended = { ...base[0] };
  symbolExtended[Symbol("unknown")] = true;
  malformed.push(symbolExtended);
  const toolsWithProperty = [...base[0].effectiveTools];
  toolsWithProperty.unknown = true;
  malformed.push({ ...base[0], effectiveTools: toolsWithProperty });

  for (const value of malformed) {
    assert.throws(
      () => policyDigest([value, base[1], base[2]], limits, compiled),
      /policy_admission/,
    );
  }
});

// Break caught: blocked admissions bypass runtime validation or leak an opaque token into the digest.
test("policy digest validates blocked admission shapes and excludes forbidden tokens", () => {
  const compiled = compileTeam(entry());
  const limits = definition().spec.limits;
  const success = admissionsForTeam();
  const valid = blockedAdmission("architecture");
  assert.doesNotThrow(() => policyDigest([valid, success[1], success[2]], limits, compiled));

  const malformed = [
    { ...valid, token: { opaque: true } },
    { ...valid, unknown: true },
    { ...valid, effectiveRoute: "research" },
    { ...valid, effectiveModel: "provider/model" },
    { ...valid, effectiveCapabilities: ["repo.read"] },
    { ...valid, effectiveTools: ["read"] },
    { ...valid, maxCostUsd: Number.POSITIVE_INFINITY },
    { ...valid, reason: "" },
    (() => { const value = { ...valid }; delete value.reason; return value; })(),
  ];
  for (const value of malformed) {
    assert.throws(
      () => policyDigest([value, success[1], success[2]], limits, compiled),
      /policy_admission/,
    );
  }
});

// Break caught: changing only one effective member timeout can reuse stale approval.
test("policy digest and approval bind every admitted effective timeout", () => {
  const compiled = compileTeam(entry());
  const limits = definition().spec.limits;
  const admissions = admissionsForTeam();
  const original = approvalBinding("run-1", compiled, policyDigest(admissions, limits, compiled));
  const changedAdmissions = clone(admissions);
  changedAdmissions[1].timeoutMs = 60_000;
  const actual = approvalBinding(
    "run-1",
    compiled,
    policyDigest(changedAdmissions, limits, compiled),
  );

  assert.notEqual(original.policyDigest, actual.policyDigest);
  assert.throws(() => verifyApprovalBinding(original, actual), /approval_binding/);
});

// Break caught: approval verification checks only a subset of its five authority fields.
test("approval verification rejects every independently changed binding field", () => {
  const compiled = compileTeam(entry());
  const expected = approvalBinding("run-1", compiled, "a".repeat(64));
  const changes = {
    runId: "run-2",
    manifestDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    requestedAction: "inspect",
  };

  assert.doesNotThrow(() => verifyApprovalBinding(expected, { ...expected }));
  for (const [field, value] of Object.entries(changes)) {
    assert.throws(
      () => verifyApprovalBinding(expected, { ...expected, [field]: value }),
      /approval_binding/,
    );
  }
});

// Break caught: structurally malformed bindings reach value comparison as valid approvals.
test("approval verification requires exact primitive canonical binding shapes", () => {
  const compiled = compileTeam(entry());
  const expected = approvalBinding("run-1", compiled, "a".repeat(64));
  const malformed = [
    { ...expected, unknown: true },
    (() => { const value = { ...expected }; delete value.runId; return value; })(),
    { ...expected, runId: 1 },
    { ...expected, runId: "" },
    { ...expected, manifestDigest: "A".repeat(64) },
    { ...expected, planDigest: "a".repeat(63) },
    { ...expected, policyDigest: `${"a".repeat(63)}g` },
    { ...expected, policyDigest: new String("a".repeat(64)) },
    { ...expected, requestedAction: "inspect" },
  ];
  const symbolExtended = { ...expected };
  symbolExtended[Symbol("unknown")] = true;
  malformed.push(symbolExtended);
  const hiddenExtended = { ...expected };
  Object.defineProperty(hiddenExtended, "hidden", { value: true });
  malformed.push(hiddenExtended);

  let getterCalls = 0;
  const accessor = { ...expected };
  Object.defineProperty(accessor, "policyDigest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "a".repeat(64);
    },
  });
  malformed.push(accessor);

  for (const actual of malformed) {
    assert.throws(() => verifyApprovalBinding(expected, actual), /approval_binding/);
  }
  assert.throws(
    () => verifyApprovalBinding({ ...expected, manifestDigest: "invalid" }, expected),
    /approval_binding/,
  );
  assert.equal(getterCalls, 0);
});
