export const TEAM_LIMITS = Object.freeze({
  manifestBytes: 65_536,
  yamlNodes: 512,
  yamlDepth: 12,
  aliases: 0,
  documents: 1,
  catalogFiles: 32,
  catalogBytes: 1_048_576,
  members: 5,
  concurrency: 3,
  costUsd: 2,
  timeoutMs: 300_000,
  containmentTimeoutMs: 5_000,
  objectiveBytes: 16_384,
  descriptionBytes: 1_024,
  instructionBytes: 8_192,
  outputBytes: 1_048_576,
  resultBytes: 65_536,
  eventLineBytes: 65_536,
});

export const ZERO_HASH = "0".repeat(64);
export const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;

export function assertBoundedUtf8(
  value: unknown,
  field: string,
  maximum: number,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (Buffer.from(value).toString("utf8") !== value) {
    throw new TypeError(`${field} must be well-formed UTF-8`);
  }
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new RangeError(`${field} exceeds ${maximum} UTF-8 bytes`);
  }
}

export function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a valid identifier`);
  }
}
