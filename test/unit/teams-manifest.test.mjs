import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ManifestError,
  parseTeamManifest,
} from "../../packages/pi-teams/src/core/manifest.ts";

const VALID = `apiVersion: pi.dev/teams/v1alpha1
kind: Team
metadata:
  name: investigate
  description: Parallel repository investigation with lead synthesis
spec:
  limits:
    maxConcurrency: 2
    maxCostUsd: 2
    timeoutMs: 300000
    maxMembers: 3
  members:
    - id: architecture
      route: research
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      instructions: Map the relevant architecture and cite repository evidence.
    - id: risks
      route: review
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      instructions: Identify compatibility, security, and failure-mode risks.
    - id: lead
      route: planning
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      needs: [architecture, risks]
      instructions: Synthesize the verified member evidence into one answer.
`;

function errorCode(code) {
  return (error) =>
    error?.name === "ManifestError" && error?.code === code;
}

test("valid manifest parses and defaults omitted dependencies", () => {
  assert.deepEqual(parseTeamManifest(VALID, "valid.yaml").spec.members[0].needs, []);
  assert.equal(parseTeamManifest(VALID, "valid.yaml").metadata.name, "investigate");
});

test("valid manifest normalizes every mapping to a null prototype", () => {
  const manifest = parseTeamManifest(VALID, "plain.yaml");
  for (const mapping of [
    manifest,
    manifest.metadata,
    manifest.spec,
    manifest.spec.limits,
    ...manifest.spec.members,
  ]) {
    assert.equal(Object.getPrototypeOf(mapping), null);
  }
});

const YAML_FEATURE_REJECTIONS = [
  ["multiple-documents", `${VALID}---\nkind: Team\n`, "manifest_yaml"],
  [
    "duplicate-keys",
    VALID.replace("  name: investigate", "  name: investigate\n  name: duplicate"),
    "manifest_yaml",
  ],
  ["anchor", VALID.replace("name: investigate", "name: &team investigate"), "manifest_anchor"],
  [
    "alias",
    VALID.replace(
      "name: investigate\n  description: Parallel repository investigation with lead synthesis",
      "name: *description\n  description: &description Parallel repository investigation with lead synthesis",
    ),
    "manifest_alias",
  ],
  ["merge-key", VALID.replace("  limits:", "  <<: {extra: true}\n  limits:"), "manifest_merge"],
  ["javascript-tag", VALID.replace("name: investigate", "name: !!js/function investigate"), "manifest_tag"],
  ["custom-tag", VALID.replace("name: investigate", "name: !custom investigate"), "manifest_tag"],
  [
    "tag-directive",
    `%TAG !team! tag:example.com,2026:team/\n---\n${VALID.replace("name: investigate", "name: !team!name investigate")}`,
    "manifest_directive",
  ],
  ["non-string-key", VALID.replace("metadata:", "? [metadata]\n:"), "manifest_key"],
  ["nan", VALID.replace("maxCostUsd: 2", "maxCostUsd: .nan"), "manifest_number"],
  ["infinity", VALID.replace("maxCostUsd: 2", "maxCostUsd: .inf"), "manifest_number"],
  ["malformed-utf8", VALID.replace("investigate", "investigate\ud800"), "manifest_utf8"],
];

test("unsafe YAML features are rejected before conversion", () => {
  for (const [name, source, code] of YAML_FEATURE_REJECTIONS) {
    assert.throws(
      () => parseTeamManifest(source, `${name}.yaml`),
      errorCode(code),
      name,
    );
  }
});

test("unknown directives rejected even when the YAML parser only warns", () => {
  const source = `%UNKNOWN ignored\n---\n${VALID}`;
  assert.throws(
    () => parseTeamManifest(source, "unknown-directive.yaml"),
    errorCode("manifest_directive"),
  );
});

test("the default YAML tag prefix cannot be redefined", () => {
  const source = `%TAG !! tag:example.com,2026:custom/\n---\n${VALID}`;
  assert.throws(
    () => parseTeamManifest(source, "default-tag-redefinition.yaml"),
    errorCode("manifest_directive"),
  );
});

test("only the YAML 1.2 version directive is allowed", () => {
  assert.equal(
    parseTeamManifest(`%YAML 1.2\n---\n${VALID}`, "yaml-1.2.yaml").metadata.name,
    "investigate",
  );
  assert.throws(
    () => parseTeamManifest(`%YAML 1.1\n---\n${VALID}`, "yaml-1.1.yaml"),
    errorCode("manifest_directive"),
  );
});

function oversizedUtf8(bytes) {
  return "a".repeat(bytes);
}

function nestedYaml(depth) {
  return `${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}`;
}

function nodeYaml(nodes) {
  return `[${Array.from({ length: nodes - 1 }, () => "0").join(",")}]`;
}

function reachesSchemaValidation(resourceCode) {
  return (error) =>
    error instanceof ManifestError && error.code !== resourceCode;
}

test("manifest resource bounds are inclusive and reject the next value", () => {
  assert.throws(
    () => parseTeamManifest(oversizedUtf8(65_537), "bytes.yaml"),
    errorCode("manifest_bytes"),
  );
  assert.throws(
    () => parseTeamManifest(nestedYaml(13), "depth.yaml"),
    errorCode("manifest_depth"),
  );
  assert.throws(
    () => parseTeamManifest(nodeYaml(513), "nodes.yaml"),
    errorCode("manifest_nodes"),
  );

  assert.throws(
    () => parseTeamManifest(oversizedUtf8(65_536), "bytes-inclusive.yaml"),
    reachesSchemaValidation("manifest_bytes"),
  );
  assert.throws(
    () => parseTeamManifest(nestedYaml(12), "depth-inclusive.yaml"),
    reachesSchemaValidation("manifest_depth"),
  );
  assert.throws(
    () => parseTeamManifest(nodeYaml(512), "nodes-inclusive.yaml"),
    reachesSchemaValidation("manifest_nodes"),
  );
});

function replaceFirstInstruction(value) {
  return VALID.replace(
    "instructions: Map the relevant architecture and cite repository evidence.",
    `instructions: ${value}`,
  );
}

function manifestWithMembers(count) {
  const members = Array.from({ length: count }, (_, index) => `    - id: member-${index + 1}
      route: research
      capabilities: [repo.read]
      tools: [read]
      instructions: Read repository evidence.`).join("\n");
  return VALID.replace("maxConcurrency: 2", `maxConcurrency: ${Math.min(count, 3)}`)
    .replace("maxMembers: 3", `maxMembers: ${count}`)
    .replace(/  members:\n[\s\S]*$/, `  members:\n${members}\n`);
}

const SCHEMA_REJECTIONS = [
  ["top-level unknown", `${VALID}unknown: true\n`, "manifest_unknown_field"],
  ["metadata unknown", VALID.replace("  name: investigate", "  unknown: true\n  name: investigate"), "manifest_unknown_field"],
  ["spec unknown", VALID.replace("spec:\n", "spec:\n  unknown: true\n"), "manifest_unknown_field"],
  ["limits unknown", VALID.replace("    maxConcurrency: 2", "    unknown: true\n    maxConcurrency: 2"), "manifest_unknown_field"],
  ["member unknown", VALID.replace("    - id: architecture", "    - id: architecture\n      unknown: true"), "manifest_unknown_field"],
  ["wrong api version", VALID.replace("pi.dev/teams/v1alpha1", "pi.dev/teams/v1"), "manifest_version"],
  ["wrong kind", VALID.replace("kind: Team", "kind: Workflow"), "manifest_kind"],
  ["invalid team id", VALID.replace("name: investigate", "name: Investigate"), "manifest_identifier"],
  ["invalid member id", VALID.replace("id: architecture", "id: Architecture"), "manifest_identifier"],
  ["duplicate member id", VALID.replace("id: risks", "id: architecture"), "manifest_identifier"],
  ["empty members", VALID.replace(/  members:\n[\s\S]*$/, "  members: []\n"), "manifest_members"],
  ["too many members", manifestWithMembers(6), "manifest_limit"],
  ["empty capabilities", VALID.replace("capabilities: [repo.read]", "capabilities: []"), "manifest_capability"],
  ["repeated capabilities", VALID.replace("capabilities: [repo.read]", "capabilities: [repo.read, repo.read]"), "manifest_capability"],
  ["empty tools", VALID.replace("tools: [read, grep, find, ls]", "tools: []"), "manifest_tool"],
  ["repeated tools", VALID.replace("tools: [read, grep, find, ls]", "tools: [read, read]"), "manifest_tool"],
  ["repeated dependencies", VALID.replace("needs: [architecture, risks]", "needs: [architecture, architecture]"), "manifest_dependency"],
  ["unsupported route", VALID.replace("planning", "implementation"), "manifest_route"],
  ["unsupported capability", VALID.replace("repo.read", "repo.write-isolated"), "manifest_capability"],
  ["unsupported tool", VALID.replace("find, ls", "find, bash"), "manifest_tool"],
  ["invalid dependency identifier", VALID.replace("needs: [architecture, risks]", "needs: [architecture, Missing]"), "manifest_dependency"],
  ["mismatched member limit", VALID.replace("maxMembers: 3", "maxMembers: 2"), "manifest_max_members"],
  ["concurrency above members", VALID.replace("maxConcurrency: 2", "maxConcurrency: 4"), "manifest_concurrency"],
  ["boolean limit", VALID.replace("maxConcurrency: 2", "maxConcurrency: true"), "manifest_limit"],
  ["fractional limit", VALID.replace("maxCostUsd: 2", "maxCostUsd: 1.5"), "manifest_limit"],
  ["zero limit", VALID.replace("timeoutMs: 300000", "timeoutMs: 0"), "manifest_limit"],
  ["negative limit", VALID.replace("maxConcurrency: 2", "maxConcurrency: -1"), "manifest_limit"],
  ["concurrency ceiling", VALID.replace("maxConcurrency: 2", "maxConcurrency: 4"), "manifest_concurrency"],
  ["cost ceiling", VALID.replace("maxCostUsd: 2", "maxCostUsd: 3"), "manifest_limit"],
  ["timeout ceiling", VALID.replace("timeoutMs: 300000", "timeoutMs: 300001"), "manifest_limit"],
  ["description ceiling", VALID.replace("Parallel repository investigation with lead synthesis", `${"é".repeat(512)}a`), "manifest_text"],
  ["instruction ceiling", replaceFirstInstruction(`${"é".repeat(4096)}a`), "manifest_text"],
];

test("exact schema and semantic constraints reject unsupported manifests", () => {
  for (const [name, source, code] of SCHEMA_REJECTIONS) {
    assert.throws(
      () => parseTeamManifest(source, `${name.replaceAll(" ", "-")}.yaml`),
      errorCode(code),
      name,
    );
  }
});

test("dependency membership and graph validation are deferred to compilation", () => {
  const unknownDependency = VALID.replace(
    "needs: [architecture, risks]",
    "needs: [architecture, missing]",
  );
  const selfDependency = VALID.replace(
    "needs: [architecture, risks]",
    "needs: [lead]",
  );

  assert.deepEqual(
    parseTeamManifest(unknownDependency, "unknown-dependency.yaml").spec.members[2].needs,
    ["architecture", "missing"],
  );
  assert.deepEqual(
    parseTeamManifest(selfDependency, "self-dependency.yaml").spec.members[2].needs,
    ["lead"],
  );
});

test("semantic text and numeric ceilings are inclusive", () => {
  const descriptionBoundary = VALID.replace(
    "Parallel repository investigation with lead synthesis",
    "é".repeat(512),
  );
  const instructionBoundary = replaceFirstInstruction("é".repeat(4096));

  assert.equal(parseTeamManifest(descriptionBoundary, "description.yaml").metadata.description, "é".repeat(512));
  assert.equal(parseTeamManifest(instructionBoundary, "instruction.yaml").spec.members[0].instructions, "é".repeat(4096));
  assert.equal(parseTeamManifest(manifestWithMembers(5), "members.yaml").spec.members.length, 5);
});
