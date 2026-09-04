import { createHash } from "node:crypto";

import { canonicalJson } from "./compiler.ts";
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

function hasExactPlainDataShape(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value).sort();
  if (
    names.length !== expectedKeys.length ||
    names.some((name, index) => name !== expectedKeys[index])
  ) return false;
  return names.every((name) => {
    const descriptor = descriptors[name];
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
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
  try {
    canonicalJson(value);
  } catch {
    eventError("event_payload", "payload must contain only canonical JSON values");
  }
}

function validateType(value: unknown): asserts value is TeamEventType {
  if (typeof value !== "string" || !EVENT_TYPE_SET.has(value)) {
    eventError("event_type", "event type is unknown");
  }
}

export function validateEventDraft(value: unknown): asserts value is EventDraft {
  if (!hasExactPlainDataShape(value, DRAFT_KEYS)) {
    eventError("event_draft", "event draft has an invalid shape");
  }
  validateType(value.type);
  validateActor(value.actor);
  if (!isRfc3339Utc(value.occurredAt)) {
    eventError("event_timestamp", "occurredAt must be an RFC 3339 UTC timestamp");
  }
  validatePayload(value.payload);
}

export function hashEvent(eventWithoutHash: Omit<TeamEvent, "hash">): string {
  return createHash("sha256")
    .update(`${canonicalJson(eventWithoutHash)}\n`, "utf8")
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
    const value = events[index];
    if (!hasExactPlainDataShape(value, EVENT_KEYS)) {
      eventError("event_shape", `event ${index + 1} has an invalid shape`);
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

    const lineBytes = Buffer.byteLength(`${canonicalJson(value)}\n`, "utf8");
    if (lineBytes > TEAM_LIMITS.eventLineBytes) {
      eventError(
        "event_line_bytes",
        `event ${index + 1} exceeds ${TEAM_LIMITS.eventLineBytes} bytes`,
      );
    }
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
