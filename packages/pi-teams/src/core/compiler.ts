import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { IDENTIFIER, TEAM_LIMITS } from "./limits.ts";
import type {
  CatalogEntry,
  CompiledTeam,
  TeamCapability,
  TeamDefinition,
  TeamLimits,
  TeamMember,
  TeamRoute,
  TeamToolName,
} from "./types.ts";

const ROUTES: readonly TeamRoute[] = ["research", "review", "planning"];
const CAPABILITIES: readonly TeamCapability[] = ["repo.read"];
const TOOLS: readonly TeamToolName[] = ["read", "grep", "find", "ls"];

function canonicalError(message: string): never {
  throw new TypeError(`canonical_json:${message}`);
}

function isWellFormedUnicode(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function serializeCanonical(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)) canonicalError("strings must contain well-formed Unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) canonicalError("numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return canonicalError(`unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) canonicalError("cyclic values are not supported");

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
      canonicalError("accessor properties are not supported");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      canonicalError("symbol keys are not supported");
    }

    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
        canonicalError("array length must be a data property");
      }
      const length = lengthDescriptor.value as number;
      for (let index = 0; index < length; index += 1) {
        if (descriptors[String(index)] === undefined) {
          canonicalError("sparse arrays are not supported");
        }
      }
      const ownNames = Object.keys(descriptors);
      if (ownNames.some((name) => {
        if (name === "length") return false;
        const index = Number(name);
        return !Number.isInteger(index) || index < 0 || index >= length || String(index) !== name;
      })) {
        canonicalError("array properties are not supported");
      }
      const items = Array.from({ length }, (_, index) =>
        serializeCanonical(descriptors[String(index)]!.value, ancestors)
      );
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      canonicalError("only plain objects are supported");
    }
    const ownNames = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (ownNames.length !== keys.length) {
      canonicalError("non-enumerable properties are not supported");
    }
    keys.sort();
    return `{${keys.map((key) => {
      if (!isWellFormedUnicode(key)) canonicalError("keys must contain well-formed Unicode");
      return `${JSON.stringify(key)}:${serializeCanonical(descriptors[key]!.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new WeakSet<object>());
}

export interface BoundedCanonicalSnapshot {
  readonly json: string;
  readonly value: unknown;
  readonly bytes: number;
}

type CanonicalValueTask = {
  kind: "value";
  source: unknown;
  parent?: Record<string, unknown> | unknown[];
  key?: string | number;
};

type CanonicalTask =
  | CanonicalValueTask
  | {
      kind: "array";
      source: unknown[];
      clone: unknown[];
      index: number;
      length: number;
    }
  | {
      kind: "object";
      source: Record<string, unknown>;
      clone: Record<string, unknown>;
      keys: string[];
      index: number;
    };

function canonicalLimitError(maximumBytes: number): never {
  throw new RangeError(`canonical_json:exceeds ${maximumBytes} UTF-8 bytes`);
}

export function canonicalJsonSnapshotBounded(
  value: unknown,
  maximumBytes: number,
): BoundedCanonicalSnapshot {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("canonical_json:maximumBytes must be a nonnegative safe integer");
  }

  const chunks: string[] = [];
  let bytes = 0;
  let snapshot: unknown;
  const ancestors = new WeakSet<object>();
  const tasks: CanonicalTask[] = [{ kind: "value", source: value }];

  const append = (text: string, byteLength = Buffer.byteLength(text, "utf8")): void => {
    if (bytes + byteLength > maximumBytes) canonicalLimitError(maximumBytes);
    chunks.push(text);
    bytes += byteLength;
  };

  const appendString = (text: string): void => {
    append("\"");
    let ordinary = "";
    let ordinaryBytes = 0;
    const flush = (): void => {
      if (ordinary.length === 0) return;
      append(ordinary, ordinaryBytes);
      ordinary = "";
      ordinaryBytes = 0;
    };
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      let escaped: string | undefined;
      if (code === 0x22) escaped = "\\\"";
      else if (code === 0x5c) escaped = "\\\\";
      else if (code === 0x08) escaped = "\\b";
      else if (code === 0x0c) escaped = "\\f";
      else if (code === 0x0a) escaped = "\\n";
      else if (code === 0x0d) escaped = "\\r";
      else if (code === 0x09) escaped = "\\t";
      else if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, "0")}`;

      if (escaped !== undefined) {
        flush();
        append(escaped, escaped.length);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) {
          canonicalError("strings must contain well-formed Unicode");
        }
        ordinary += text.slice(index, index + 2);
        ordinaryBytes += 4;
        index += 1;
      } else {
        if (code >= 0xdc00 && code <= 0xdfff) {
          canonicalError("strings must contain well-formed Unicode");
        }
        ordinary += text[index];
        ordinaryBytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      }
      if (ordinary.length >= 1_024) flush();
    }
    flush();
    append("\"");
  };

  const assign = (
    task: Extract<CanonicalTask, { kind: "value" }>,
    captured: unknown,
  ): void => {
    if (task.parent === undefined) {
      snapshot = captured;
    } else if (Array.isArray(task.parent)) {
      task.parent[task.key as number] = captured;
    } else {
      Object.defineProperty(task.parent, task.key as string, {
        value: captured,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  };

  const maximumArrayLength = Math.max(0, Math.floor((maximumBytes - 1) / 2));
  const maximumObjectKeys = Math.max(0, Math.floor((maximumBytes - 1) / 5));

  while (tasks.length > 0) {
    const task = tasks.pop()!;

    if (task.kind === "array") {
      if (task.index >= task.length) {
        append("]", 1);
        Object.freeze(task.clone);
        ancestors.delete(task.source);
        continue;
      }
      if (task.index > 0) append(",", 1);
      const index = task.index;
      const descriptor = Object.getOwnPropertyDescriptor(task.source, String(index));
      if (descriptor === undefined) canonicalError("sparse arrays are not supported");
      if (!("value" in descriptor)) canonicalError("accessor properties are not supported");
      task.index += 1;
      tasks.push(task);
      tasks.push({
        kind: "value",
        source: descriptor.value,
        parent: task.clone,
        key: index,
      });
      continue;
    }

    if (task.kind === "object") {
      if (task.index >= task.keys.length) {
        append("}", 1);
        Object.freeze(task.clone);
        ancestors.delete(task.source);
        continue;
      }
      if (task.index > 0) append(",", 1);
      const key = task.keys[task.index];
      appendString(key);
      append(":", 1);
      const descriptor = Object.getOwnPropertyDescriptor(task.source, key);
      if (descriptor === undefined) {
        canonicalError("property identity changed during canonical capture");
      }
      if (!("value" in descriptor)) canonicalError("accessor properties are not supported");
      if (!descriptor.enumerable) canonicalError("non-enumerable properties are not supported");
      task.index += 1;
      tasks.push(task);
      tasks.push({
        kind: "value",
        source: descriptor.value,
        parent: task.clone,
        key,
      });
      continue;
    }

    const source = task.source;
    if (source === null) {
      assign(task, null);
      append("null", 4);
      continue;
    }
    if (typeof source === "string") {
      assign(task, source);
      appendString(source);
      continue;
    }
    if (typeof source === "boolean") {
      assign(task, source);
      append(source ? "true" : "false", source ? 4 : 5);
      continue;
    }
    if (typeof source === "number") {
      if (!Number.isFinite(source)) canonicalError("numbers must be finite");
      assign(task, source);
      const encoded = JSON.stringify(source);
      append(encoded, encoded.length);
      continue;
    }
    if (typeof source !== "object") {
      canonicalError(`unsupported ${typeof source} value`);
    }
    if (nodeUtilTypes.isProxy(source)) canonicalError("proxy values are not supported");
    if (ancestors.has(source)) canonicalError("cyclic values are not supported");

    if (Array.isArray(source)) {
      const length = source.length;
      if (length > maximumArrayLength) canonicalLimitError(maximumBytes);

      let enumerableKeyCount = 0;
      let minimumEnumerableBytes = 1;
      let customPropertyBytes = 0;
      let hasCustomProperty = false;
      for (const key in source) {
        if (!Object.hasOwn(source, key)) continue;
        if (enumerableKeyCount >= maximumArrayLength) canonicalLimitError(maximumBytes);
        enumerableKeyCount += 1;
        minimumEnumerableBytes += 2;
        if (minimumEnumerableBytes > maximumBytes) canonicalLimitError(maximumBytes);

        const index = Number(key);
        if (
          Number.isInteger(index) && index >= 0 && index < length && String(index) === key
        ) {
          continue;
        }
        hasCustomProperty = true;
        if (key.length > maximumBytes) canonicalLimitError(maximumBytes);
        const keyBytes = Buffer.byteLength(key, "utf8");
        if (customPropertyBytes > maximumBytes - keyBytes) canonicalLimitError(maximumBytes);
        customPropertyBytes += keyBytes;
      }
      if (hasCustomProperty) canonicalError("array properties are not supported");
      if (Object.getOwnPropertySymbols(source).length > 0) {
        canonicalError("symbol keys are not supported");
      }
      const ownNames = Object.getOwnPropertyNames(source);
      if (ownNames.some((name) => {
        if (name === "length") return false;
        const index = Number(name);
        return !Number.isInteger(index) || index < 0 || index >= length || String(index) !== name;
      })) {
        canonicalError("array properties are not supported");
      }
      const clone: unknown[] = new Array(length);
      assign(task, clone);
      ancestors.add(source);
      append("[", 1);
      tasks.push({ kind: "array", source, clone, index: 0, length });
      continue;
    }

    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      canonicalError("only plain objects are supported");
    }
    const keys: string[] = [];
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      if (keys.length >= maximumObjectKeys) canonicalLimitError(maximumBytes);
      keys.push(key);
    }
    if (Object.getOwnPropertySymbols(source).length > 0) {
      canonicalError("symbol keys are not supported");
    }
    if (Object.getOwnPropertyNames(source).length !== keys.length) {
      canonicalError("non-enumerable properties are not supported");
    }
    keys.sort();
    const clone = prototype === null
      ? Object.create(null) as Record<string, unknown>
      : {} as Record<string, unknown>;
    assign(task, clone);
    ancestors.add(source);
    append("{", 1);
    tasks.push({
      kind: "object",
      source: source as Record<string, unknown>,
      clone,
      keys,
      index: 0,
    });
  }

  return Object.freeze({ json: chunks.join(""), value: snapshot, bytes });
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function compileError(code: string, message: string): never {
  throw new Error(`${code}:${message}`);
}

function requirePositiveInteger(value: unknown, maximum: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    return compileError("compile_limit", `${field} must be a positive integer no greater than ${maximum}`);
  }
  return value as number;
}

function normalizeLimits(value: TeamLimits, memberCount: number): TeamLimits {
  if (value === null || typeof value !== "object") {
    return compileError("compile_limit", "limits must be an object");
  }
  const maxConcurrency = requirePositiveInteger(
    value.maxConcurrency,
    TEAM_LIMITS.concurrency,
    "maxConcurrency",
  );
  const maxCostUsd = requirePositiveInteger(value.maxCostUsd, TEAM_LIMITS.costUsd, "maxCostUsd");
  const timeoutMs = requirePositiveInteger(value.timeoutMs, TEAM_LIMITS.timeoutMs, "timeoutMs");
  const maxMembers = requirePositiveInteger(value.maxMembers, TEAM_LIMITS.members, "maxMembers");
  if (maxMembers !== memberCount) {
    return compileError("compile_limit", "maxMembers must equal the member count");
  }
  if (maxConcurrency > maxMembers) {
    return compileError("compile_limit", "maxConcurrency must not exceed maxMembers");
  }
  return { maxConcurrency, maxCostUsd, timeoutMs, maxMembers };
}

function normalizeText(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" ||
    Buffer.from(value).toString("utf8") !== value ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    return compileError("compile_text", `${field} must be nonempty and no greater than ${maximum} UTF-8 bytes`);
  }
  return value;
}

function normalizeRequestedArray<T extends string>(
  value: unknown,
  supported: readonly T[],
  code: string,
  field: string,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    return compileError(code, `${field} must be a nonempty string array`);
  }
  if (new Set(value).size !== value.length) {
    return compileError(code, `${field} must not contain duplicates`);
  }
  if (value.some((item) => !supported.includes(item as T))) {
    return compileError(code, `${field} contains unsupported authority`);
  }
  return [...value] as T[];
}

function normalizeMember(value: TeamMember): TeamMember {
  if (value === null || typeof value !== "object") {
    return compileError("compile_member", "member must be an object");
  }
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) {
    return compileError("compile_identifier", "member id is invalid");
  }
  if (!ROUTES.includes(value.route)) {
    return compileError("compile_route", `${value.id} has an unsupported route`);
  }
  const needsValue = value.needs ?? [];
  if (
    !Array.isArray(needsValue) ||
    needsValue.some((need) => typeof need !== "string" || !IDENTIFIER.test(need)) ||
    new Set(needsValue).size !== needsValue.length
  ) {
    return compileError("compile_dependency", `${value.id} has invalid dependencies`);
  }
  const instructions = normalizeText(
    value.instructions,
    TEAM_LIMITS.instructionBytes,
    `${value.id}.instructions`,
  );
  return {
    id: value.id,
    route: value.route,
    capabilities: normalizeRequestedArray(
      value.capabilities,
      CAPABILITIES,
      "compile_capability",
      `${value.id}.capabilities`,
    ),
    tools: normalizeRequestedArray(value.tools, TOOLS, "compile_tool", `${value.id}.tools`),
    needs: [...needsValue],
    instructions,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function findCycle(members: TeamMember[], indexes: Map<string, number>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    const member = members[indexes.get(id)!]!;
    const dependencies = [...member.needs].sort(
      (left, right) => indexes.get(left)! - indexes.get(right)!,
    );
    for (const dependency of dependencies) {
      if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
      if ((state.get(dependency) ?? 0) === 0) {
        const cycle = visit(dependency);
        if (cycle !== undefined) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };

  for (const member of members) {
    if ((state.get(member.id) ?? 0) === 0) {
      const cycle = visit(member.id);
      if (cycle !== undefined) return cycle;
    }
  }
  return compileError("dag_cycle", "cycle detected");
}

function topologicalOrder(members: TeamMember[], indexes: Map<string, number>): string[] {
  const indegree = new Map(members.map((member) => [member.id, member.needs.length]));
  const dependents = new Map(members.map((member) => [member.id, [] as string[]]));
  for (const member of members) {
    for (const dependency of member.needs) dependents.get(dependency)!.push(member.id);
  }

  const ready = members.filter((member) => member.needs.length === 0).map((member) => member.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((left, right) => indexes.get(left)! - indexes.get(right)!);
      }
    }
  }
  if (order.length !== members.length) {
    compileError("dag_cycle", findCycle(members, indexes).join(" -> "));
  }
  return order;
}

function digestDefinition(definition: TeamDefinition): TeamDefinition {
  return {
    ...definition,
    metadata: { ...definition.metadata },
    spec: {
      limits: { ...definition.spec.limits },
      members: definition.spec.members.map((member) => ({
        ...member,
        capabilities: [...member.capabilities],
        tools: [...member.tools],
        needs: [...member.needs].sort(),
      })),
    },
  };
}

export function compileTeam(entry: CatalogEntry): CompiledTeam {
  const input = entry.definition;
  if (input?.apiVersion !== "pi.dev/teams/v1alpha1" || input.kind !== "Team") {
    return compileError("compile_schema", "unsupported team definition");
  }
  if (
    input.metadata === null ||
    typeof input.metadata !== "object" ||
    typeof input.metadata.name !== "string" ||
    !IDENTIFIER.test(input.metadata.name)
  ) {
    return compileError("compile_schema", "metadata is invalid");
  }
  const description = normalizeText(
    input.metadata.description,
    TEAM_LIMITS.descriptionBytes,
    "metadata.description",
  );
  if (input.spec === null || typeof input.spec !== "object" || !Array.isArray(input.spec.members)) {
    return compileError("compile_schema", "spec is invalid");
  }
  if (input.spec.members.length === 0 || input.spec.members.length > TEAM_LIMITS.members) {
    return compileError("compile_limit", "member count is outside package limits");
  }

  const members = input.spec.members.map(normalizeMember);
  const indexes = new Map<string, number>();
  for (const [index, member] of members.entries()) {
    if (indexes.has(member.id)) compileError("dag_duplicate", member.id);
    indexes.set(member.id, index);
  }
  for (const member of members) {
    for (const dependency of member.needs) {
      if (dependency === member.id) compileError("dag_self", member.id);
      if (!indexes.has(dependency)) compileError("dag_unknown", `${member.id} -> ${dependency}`);
    }
  }

  const limits = normalizeLimits(input.spec.limits, members.length);
  const definition = deepFreeze({
    apiVersion: "pi.dev/teams/v1alpha1" as const,
    kind: "Team" as const,
    metadata: { name: input.metadata.name, description },
    spec: { limits, members },
  });
  const order = topologicalOrder(members, indexes);
  const digestInput = digestDefinition(definition);
  const compiled: CompiledTeam = {
    ref: entry.ref,
    source: entry.source,
    definition,
    topologicalOrder: order,
    manifestDigest: sha256Canonical(digestInput),
    planDigest: sha256Canonical({
      ref: entry.ref,
      members: digestInput.spec.members,
      topologicalOrder: order,
      limits: digestInput.spec.limits,
    }),
  };
  return deepFreeze(compiled);
}
