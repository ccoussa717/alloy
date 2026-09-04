import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

import {
  assertBoundedUtf8,
  assertIdentifier,
  TEAM_LIMITS,
} from "./limits.ts";
import type {
  TeamCapability,
  TeamDefinition,
  TeamLimits,
  TeamMember,
  TeamRoute,
  TeamToolName,
} from "./types.ts";

export class ManifestError extends Error {
  readonly code: string;
  readonly origin: string;

  constructor(code: string, message: string, origin: string) {
    super(`${code}:${origin}:${message}`);
    this.name = "ManifestError";
    this.code = code;
    this.origin = origin;
  }
}

function assertManifestBytes(source: string, maximum: number, origin: string): void {
  if (Buffer.from(source).toString("utf8") !== source) {
    throw new ManifestError("manifest_utf8", "source must be well-formed UTF-8", origin);
  }
  if (Buffer.byteLength(source, "utf8") > maximum) {
    throw new ManifestError(
      "manifest_bytes",
      `source exceeds ${maximum} UTF-8 bytes`,
      origin,
    );
  }
}

function inspectYamlNode(
  node: unknown,
  depth: number,
  state: { nodes: number },
  origin: string,
): void {
  if (node === null || node === undefined) return;
  if (depth > TEAM_LIMITS.yamlDepth) {
    throw new ManifestError(
      "manifest_depth",
      `YAML depth exceeds ${TEAM_LIMITS.yamlDepth}`,
      origin,
    );
  }
  state.nodes += 1;
  if (state.nodes > TEAM_LIMITS.yamlNodes) {
    throw new ManifestError(
      "manifest_nodes",
      `YAML nodes exceed ${TEAM_LIMITS.yamlNodes}`,
      origin,
    );
  }

  if (isAlias(node)) {
    throw new ManifestError("manifest_alias", "aliases are not allowed", origin);
  }
  if (
    typeof node === "object" &&
    "anchor" in node &&
    typeof node.anchor === "string"
  ) {
    throw new ManifestError("manifest_anchor", "anchors are not allowed", origin);
  }
  if (
    typeof node === "object" &&
    "tag" in node &&
    typeof node.tag === "string"
  ) {
    throw new ManifestError("manifest_tag", "explicit tags are not allowed", origin);
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new ManifestError("manifest_key", "mapping keys must be strings", origin);
      }
      if (pair.key.value === "<<") {
        throw new ManifestError("manifest_merge", "merge keys are not allowed", origin);
      }
      inspectYamlNode(pair.key, depth + 1, state, origin);
      inspectYamlNode(pair.value, depth + 1, state, origin);
    }
    return;
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      inspectYamlNode(item, depth + 1, state, origin);
    }
  }
}

function normalizePlainValue(value: unknown, origin: string): unknown {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "number") {
    throw new ManifestError("manifest_number", "numbers must be finite", origin);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePlainValue(item, origin));
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ManifestError("manifest_value", "non-plain values are not allowed", origin);
    }
    const normalized: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizePlainValue(item, origin);
    }
    return normalized;
  }
  throw new ManifestError("manifest_value", "unsupported scalar value", origin);
}

type PlainMapping = Record<string, unknown>;

function nullPrototype<T extends object>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

function requireMapping(value: unknown, field: string, origin: string): PlainMapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError("manifest_schema", `${field} must be a mapping`, origin);
  }
  return value as PlainMapping;
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  field: string,
  origin: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new ManifestError(
      "manifest_unknown_field",
      `${field}.${unknown} is not allowed`,
      origin,
    );
  }
}

function validateIdentifier(value: unknown, field: string, origin: string): string {
  try {
    assertIdentifier(value, field);
    return value;
  } catch (error) {
    throw new ManifestError(
      "manifest_identifier",
      error instanceof Error ? error.message : `${field} is invalid`,
      origin,
    );
  }
}

function validateText(
  value: unknown,
  field: string,
  maximum: number,
  origin: string,
): string {
  try {
    assertBoundedUtf8(value, field, maximum);
    return value;
  } catch (error) {
    throw new ManifestError(
      "manifest_text",
      error instanceof Error ? error.message : `${field} is invalid`,
      origin,
    );
  }
}

function validateStringArray(
  value: unknown,
  field: string,
  code: string,
  origin: string,
  allowEmpty: boolean,
): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new ManifestError(code, `${field} must be a string array`, origin);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw new ManifestError(code, `${field} must not contain duplicates`, origin);
  }
  return [...result];
}

function validateIntegerLimit(
  value: unknown,
  field: string,
  maximum: number,
  origin: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ManifestError(
      "manifest_limit",
      `${field} must be a positive integer no greater than ${maximum}`,
      origin,
    );
  }
  return value as number;
}

function validateLimits(
  value: unknown,
  memberCount: number,
  origin: string,
): TeamLimits {
  const limits = requireMapping(value, "spec.limits", origin);
  assertExactKeys(
    limits,
    ["maxConcurrency", "maxCostUsd", "timeoutMs", "maxMembers"],
    "spec.limits",
    origin,
  );

  const maxConcurrencyValue = limits.maxConcurrency;
  if (
    !Number.isInteger(maxConcurrencyValue) ||
    (maxConcurrencyValue as number) <= 0
  ) {
    throw new ManifestError(
      "manifest_limit",
      "spec.limits.maxConcurrency must be a positive integer",
      origin,
    );
  }
  if ((maxConcurrencyValue as number) > TEAM_LIMITS.concurrency) {
    throw new ManifestError(
      "manifest_concurrency",
      `maxConcurrency exceeds ${TEAM_LIMITS.concurrency}`,
      origin,
    );
  }
  const maxConcurrency = maxConcurrencyValue as number;
  const maxCostUsd = validateIntegerLimit(
    limits.maxCostUsd,
    "spec.limits.maxCostUsd",
    TEAM_LIMITS.costUsd,
    origin,
  );
  const timeoutMs = validateIntegerLimit(
    limits.timeoutMs,
    "spec.limits.timeoutMs",
    TEAM_LIMITS.timeoutMs,
    origin,
  );
  const maxMembers = validateIntegerLimit(
    limits.maxMembers,
    "spec.limits.maxMembers",
    TEAM_LIMITS.members,
    origin,
  );

  if (maxMembers !== memberCount) {
    throw new ManifestError(
      "manifest_max_members",
      "maxMembers must equal the actual member count",
      origin,
    );
  }
  if (maxConcurrency > maxMembers) {
    throw new ManifestError(
      "manifest_concurrency",
      "maxConcurrency must not exceed maxMembers",
      origin,
    );
  }
  return nullPrototype({ maxConcurrency, maxCostUsd, timeoutMs, maxMembers });
}

function validateMember(value: unknown, origin: string): TeamMember {
  const member = requireMapping(value, "spec.members[]", origin);
  assertExactKeys(
    member,
    ["id", "route", "capabilities", "tools", "needs", "instructions"],
    "spec.members[]",
    origin,
  );

  const id = validateIdentifier(member.id, "spec.members[].id", origin);
  const routes: readonly TeamRoute[] = ["research", "review", "planning"];
  if (typeof member.route !== "string" || !routes.includes(member.route as TeamRoute)) {
    throw new ManifestError("manifest_route", "member route is unsupported", origin);
  }
  const route = member.route as TeamRoute;

  const capabilities = validateStringArray(
    member.capabilities,
    "spec.members[].capabilities",
    "manifest_capability",
    origin,
    false,
  );
  if (capabilities.some((capability) => capability !== "repo.read")) {
    throw new ManifestError(
      "manifest_capability",
      "member capability is unsupported",
      origin,
    );
  }

  const supportedTools: readonly TeamToolName[] = ["read", "grep", "find", "ls"];
  const tools = validateStringArray(
    member.tools,
    "spec.members[].tools",
    "manifest_tool",
    origin,
    false,
  );
  if (tools.some((tool) => !supportedTools.includes(tool as TeamToolName))) {
    throw new ManifestError("manifest_tool", "member tool is unsupported", origin);
  }

  const needs = member.needs === undefined
    ? []
    : validateStringArray(
        member.needs,
        "spec.members[].needs",
        "manifest_dependency",
        origin,
        true,
      );
  for (const need of needs) {
    try {
      assertIdentifier(need, "spec.members[].needs[]");
    } catch (error) {
      throw new ManifestError(
        "manifest_dependency",
        error instanceof Error ? error.message : "dependency is invalid",
        origin,
      );
    }
  }

  return nullPrototype({
    id,
    route,
    capabilities: capabilities as TeamCapability[],
    tools: tools as TeamToolName[],
    needs,
    instructions: validateText(
      member.instructions,
      "spec.members[].instructions",
      TEAM_LIMITS.instructionBytes,
      origin,
    ),
  });
}

export function parseTeamManifest(source: string, origin: string): TeamDefinition {
  assertManifestBytes(source, TEAM_LIMITS.manifestBytes, origin);

  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    schema: "core",
  });
  if (document.errors.length > 0) {
    throw new ManifestError("manifest_yaml", document.errors[0]!.message, origin);
  }
  const directives = document.directives;
  const tags = directives === undefined
    ? []
    : Object.keys(directives.tags).filter((tag) => tag !== "!!");
  if (tags.length > 0) {
    throw new ManifestError("manifest_directive", "directive is not allowed", origin);
  }

  inspectYamlNode(document.contents, 1, { nodes: 0 }, origin);
  const manifest = requireMapping(
    normalizePlainValue(document.toJS({ maxAliasCount: 0 }), origin),
    "manifest",
    origin,
  );
  assertExactKeys(manifest, ["apiVersion", "kind", "metadata", "spec"], "manifest", origin);

  if (manifest.apiVersion !== "pi.dev/teams/v1alpha1") {
    throw new ManifestError("manifest_version", "apiVersion is unsupported", origin);
  }
  if (manifest.kind !== "Team") {
    throw new ManifestError("manifest_kind", "kind must be Team", origin);
  }

  const metadata = requireMapping(manifest.metadata, "metadata", origin);
  assertExactKeys(metadata, ["name", "description"], "metadata", origin);
  const name = validateIdentifier(metadata.name, "metadata.name", origin);
  const description = validateText(
    metadata.description,
    "metadata.description",
    TEAM_LIMITS.descriptionBytes,
    origin,
  );

  const spec = requireMapping(manifest.spec, "spec", origin);
  assertExactKeys(spec, ["limits", "members"], "spec", origin);
  if (!Array.isArray(spec.members) || spec.members.length === 0) {
    throw new ManifestError("manifest_members", "spec.members must be nonempty", origin);
  }
  if (spec.members.length > TEAM_LIMITS.members) {
    throw new ManifestError(
      "manifest_limit",
      `member count exceeds ${TEAM_LIMITS.members}`,
      origin,
    );
  }
  const members = spec.members.map((member) => validateMember(member, origin));
  const memberIds = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.id)) {
      throw new ManifestError(
        "manifest_identifier",
        `duplicate member id ${member.id}`,
        origin,
      );
    }
    memberIds.add(member.id);
  }
  for (const member of members) {
    for (const dependency of member.needs) {
      if (dependency === member.id || !memberIds.has(dependency)) {
        throw new ManifestError(
          "manifest_dependency",
          `invalid dependency ${dependency} for ${member.id}`,
          origin,
        );
      }
    }
  }

  return nullPrototype({
    apiVersion: "pi.dev/teams/v1alpha1" as const,
    kind: "Team" as const,
    metadata: nullPrototype({ name, description }),
    spec: nullPrototype({
      limits: validateLimits(spec.limits, members.length, origin),
      members,
    }),
  });
}
