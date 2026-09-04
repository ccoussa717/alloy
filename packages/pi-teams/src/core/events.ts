import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { canonicalJsonSnapshotBounded } from "./compiler.ts";
import { TEAM_LIMITS, ZERO_HASH } from "./limits.ts";
import type { Actor, EventDraft, TeamEvent, TeamEventType } from "./types.ts";

export const TEAM_EVENT_TYPES = Object.freeze([
  "run.requested", "manifest.snapshotted", "policy.admitted", "policy.blocked",
  "run.awaiting_approval", "approval.granted", "run.started", "member.ready",
  "member.started", "member.artifact_recorded", "member.succeeded",
  "member.failed", "budget.observed", "cancel.requested", "member.cancelled",
  "run.completed", "run.failed", "run.blocked", "run.cancelled",
] as const satisfies readonly TeamEventType[]);

export const TERMINAL_TEAM_EVENT_TYPES = Object.freeze([
  "run.completed", "run.failed", "run.blocked", "run.cancelled",
] as const satisfies readonly TeamEventType[]);

const EVENT_KEYS = [
  "actor", "hash", "occurredAt", "payload", "prevHash", "runId", "seq", "type", "v",
] as const;
const DRAFT_KEYS = ["actor", "occurredAt", "payload", "type"] as const;
const ACTOR_KEYS = ["id", "kind"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const EVENT_TYPE_SET = new Set<string>(TEAM_EVENT_TYPES);
const TERMINAL_TYPE_SET = new Set<string>(TERMINAL_TEAM_EVENT_TYPES);
const ACTOR_KIND_SET = new Set(["human", "model", "system"]);

function eventError(code: string, message: string): never {
  throw new Error(`${code}:${message}`);
}

function captureExactPlainDataShape(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return eventError(code, "record must be a plain object");
  }
  if (nodeUtilTypes.isProxy(value)) return eventError(code, "proxy records are not supported");
  if (Array.isArray(value)) return eventError(code, "record must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return eventError(code, "record must have the plain object prototype");
  }
  const propertyKeys = Reflect.ownKeys(value);
  if (propertyKeys.some((key) => typeof key === "symbol")) {
    return eventError(code, "record must not have symbol keys");
  }
  const names = (propertyKeys as string[]).slice().sort();
  if (
    names.length !== expectedKeys.length ||
    names.some((name, index) => name !== expectedKeys[index])
  ) {
    return eventError(code, "record has an invalid shape");
  }
  const captured: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return eventError(code, "record properties must be enumerable data properties");
    }
    Object.defineProperty(captured, name, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return captured;
}

function hasExactPlainDataShape(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    captureExactPlainDataShape(value, expectedKeys, "event_shape");
    return true;
  } catch {
    return false;
  }
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || nodeUtilTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  return names.every((name) => {
    const descriptor = descriptors[name];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

export function isRfc3339Utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_UTC.exec(value);
  if (match === null || match[1] === "0000") return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
}

function validateActor(value: unknown): asserts value is Actor {
  if (!hasExactPlainDataShape(value, ACTOR_KEYS)) {
    eventError("event_actor", "actor must have exactly kind and id");
  }
  if (!ACTOR_KIND_SET.has(value.kind as string)) {
    eventError("event_actor", "actor kind is unknown");
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    Buffer.from(value.id, "utf8").toString("utf8") !== value.id
  ) {
    eventError("event_actor", "actor id must be a nonempty well-formed string");
  }
}

function validatePayload(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainDataObject(value)) {
    eventError("event_payload", "payload must be a plain data object");
  }
}

function boundedSnapshot(value: unknown): { json: string; value: unknown; bytes: number } {
  try {
    return canonicalJsonSnapshotBounded(value, TEAM_LIMITS.eventLineBytes - 1);
  } catch (error) {
    if (error instanceof RangeError && String(error).startsWith("RangeError: canonical_json:exceeds")) {
      return eventError(
        "event_line_bytes",
        `event exceeds ${TEAM_LIMITS.eventLineBytes} bytes`,
      );
    }
    throw error;
  }
}

function validateType(value: unknown): asserts value is TeamEventType {
  if (typeof value !== "string" || !EVENT_TYPE_SET.has(value)) {
    eventError("event_type", "event type is unknown");
  }
}

function validateCapturedEventDraft(value: Record<string, unknown>): EventDraft {
  validateType(value.type);
  validateActor(value.actor);
  if (!isRfc3339Utc(value.occurredAt)) {
    eventError("event_timestamp", "occurredAt must be an RFC 3339 UTC timestamp");
  }
  validatePayload(value.payload);
  return value as unknown as EventDraft;
}

export function snapshotEventDraft(value: unknown): EventDraft {
  const captured = captureExactPlainDataShape(value, DRAFT_KEYS, "event_draft");
  let snapshot: unknown;
  try {
    snapshot = boundedSnapshot(captured).value;
  } catch (error) {
    if (String(error).includes("canonical_json:")) {
      return eventError("event_payload", "payload must contain only canonical JSON values");
    }
    throw error;
  }
  if (!hasExactPlainDataShape(snapshot, DRAFT_KEYS)) {
    return eventError("event_draft", "canonical snapshot has an invalid shape");
  }
  return validateCapturedEventDraft(snapshot);
}

export function hashEvent(eventWithoutHash: Omit<TeamEvent, "hash">): string {
  const canonical = boundedSnapshot(eventWithoutHash).json;
  return createHash("sha256")
    .update(`${canonical}\n`, "utf8")
    .digest("hex");
}

export function validateEventHistory(
  events: unknown[],
  expectedRunId: string,
): TeamEvent[] {
  if (!isRunId(expectedRunId)) {
    eventError("event_run_id", "expected run ID must be a lowercase UUID");
  }
  if (!Array.isArray(events) || events.length === 0) {
    eventError("event_history", "event history must not be empty");
  }
  if (events.length > TEAM_LIMITS.eventHistoryEvents) {
    eventError(
      "event_history_events",
      `event history exceeds ${TEAM_LIMITS.eventHistoryEvents} events`,
    );
  }

  let previousHash = ZERO_HASH;
  let historyBytes = 0;
  let terminalSeen = false;
  const validated: TeamEvent[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const captured = captureExactPlainDataShape(events[index], EVENT_KEYS, "event_shape");
    let canonical;
    try {
      canonical = boundedSnapshot(captured);
    } catch (error) {
      if (String(error).includes("canonical_json:")) {
        return eventError("event_payload", `event ${index + 1} is not canonical JSON`);
      }
      throw error;
    }
    const value = canonical.value;
    if (!hasExactPlainDataShape(value, EVENT_KEYS)) {
      eventError("event_shape", `event ${index + 1} canonical snapshot has an invalid shape`);
    }
    if (value.v !== 1) {
      eventError("event_version", `event ${index + 1} has an unsupported version`);
    }
    if (!isRunId(value.runId) || value.runId !== expectedRunId) {
      eventError("event_run_id", `event ${index + 1} has the wrong run ID`);
    }
    if (!Number.isSafeInteger(value.seq) || value.seq !== index + 1) {
      eventError("event_sequence", `event ${index + 1} has a noncontiguous sequence`);
    }
    validateType(value.type);
    validateActor(value.actor);
    if (!isRfc3339Utc(value.occurredAt)) {
      eventError("event_timestamp", `event ${index + 1} has an invalid timestamp`);
    }
    validatePayload(value.payload);
    if (typeof value.prevHash !== "string" || !HASH.test(value.prevHash)) {
      eventError("event_prev_hash", `event ${index + 1} has an invalid previous hash`);
    }
    if (value.prevHash !== previousHash) {
      eventError("event_prev_hash", `event ${index + 1} does not link to its predecessor`);
    }
    if (typeof value.hash !== "string" || !HASH.test(value.hash)) {
      eventError("event_hash", `event ${index + 1} has an invalid hash`);
    }

    const eventWithoutHash = {
      v: value.v as 1,
      runId: value.runId,
      seq: value.seq,
      type: value.type,
      actor: value.actor,
      occurredAt: value.occurredAt,
      payload: value.payload,
      prevHash: value.prevHash,
    };
    const expectedHash = hashEvent(eventWithoutHash);
    if (value.hash !== expectedHash) {
      eventError("event_hash", `event ${index + 1} hash does not match its content`);
    }

    const lineBytes = canonical.bytes + 1;
    historyBytes += lineBytes;
    if (historyBytes > TEAM_LIMITS.eventHistoryBytes) {
      eventError(
        "event_history_bytes",
        `event history exceeds ${TEAM_LIMITS.eventHistoryBytes} bytes`,
      );
    }

    if (terminalSeen) {
      eventError("event_terminal", "an event appears after the terminal event");
    }
    if (TERMINAL_TYPE_SET.has(value.type)) terminalSeen = true;

    previousHash = value.hash;
    validated.push(value as unknown as TeamEvent);
  }

  return validated;
}

export function isTerminalTeamEvent(type: TeamEventType): boolean {
  return TERMINAL_TYPE_SET.has(type);
}
