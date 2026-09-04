import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { canonicalJson, canonicalJsonSnapshotBounded } from "../core/compiler.ts";
import { isProjectId, isRunId } from "../core/events.ts";
import { IDENTIFIER, TEAM_LIMITS } from "../core/limits.ts";
import type {
  ArtifactRef,
  ArtifactStore,
  FileArtifactStoreOptions,
  MemberResult,
} from "../core/types.ts";

type FileSystem = typeof nodeFs;
type FileHandle = Awaited<ReturnType<FileSystem["open"]>>;
type FileStat = Awaited<ReturnType<FileHandle["stat"]>>;

type OpenDirectory = {
  handle: FileHandle;
  descriptor: string;
  identity: FileStat;
  linkPath: string;
  requireExactMode: boolean;
};

type OpenArtifactFile = {
  handle: FileHandle;
  path: string;
  label: "output" | "result";
  expectedBytes: number;
  expectedDigest: string;
  maximum: number;
  identity: FileStat;
};

type CapturedResult = {
  result: MemberResult;
  output: Buffer;
  resultBytes: Buffer;
};

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIRECTORY_FLAGS = constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const EXCLUSIVE_WRITE_FLAGS = constants.O_RDWR |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);
const ARTIFACT_REF_KEYS = [
  "memberId",
  "outputBytes",
  "outputPath",
  "outputSha256",
  "resultBytes",
  "resultPath",
  "resultSha256",
] as const;
const RESULT_REQUIRED_KEYS = ["model", "ok", "text", "usage"] as const;
const RESULT_WITH_ERROR_KEYS = ["error", "model", "ok", "text", "usage"] as const;
const ENVELOPE_REQUIRED_KEYS = ["memberId", "model", "ok", "runId", "usage"] as const;
const ENVELOPE_WITH_ERROR_KEYS = ["error", "memberId", "model", "ok", "runId", "usage"] as const;
const USAGE_KEYS = ["costUsd", "input", "output"] as const;
const SHA256 = /^[0-9a-f]{64}$/;

function artifactError(code: string, message: string): Error {
  return new Error(`${code}:${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameIdentity(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservedFile(left: FileStat, right: FileStat): boolean {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function closeAll(handles: Array<FileHandle | undefined>): Promise<void> {
  const results = await Promise.allSettled(handles.map(async (handle) => handle?.close()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw artifactError(code, `${label} must be an exact plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw artifactError(code, `${label} must not contain symbol keys`);
  }
  const names = (ownKeys as string[]).slice().sort();
  if (names.length !== keys.length || names.some((name, index) => name !== keys[index])) {
    throw artifactError(code, `${label} has an invalid shape`);
  }
  const captured: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw artifactError(code, `${label} properties must be enumerable data properties`);
    }
    captured[name] = descriptor.value;
  }
  return captured;
}

function utf8ByteLengthBounded(value: unknown, maximum: number, field: string): number {
  if (typeof value !== "string") {
    throw artifactError("artifact_utf8", `${field} must be a string`);
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw artifactError("artifact_utf8", `${field} must contain well-formed Unicode`);
      }
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw artifactError("artifact_utf8", `${field} must contain well-formed Unicode`);
    } else {
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (bytes > maximum) {
      throw artifactError(
        field === "result.text" ? "artifact_output_bytes" : "artifact_result_bytes",
        `${field} exceeds ${maximum} UTF-8 bytes`,
      );
    }
  }
  return bytes;
}

function captureUsage(value: unknown): MemberResult["usage"] {
  const usage = exactDataRecord(value, USAGE_KEYS, "artifact_usage", "usage");
  if (!Number.isSafeInteger(usage.input) || (usage.input as number) < 0) {
    throw artifactError("artifact_usage", "usage.input must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(usage.output) || (usage.output as number) < 0) {
    throw artifactError("artifact_usage", "usage.output must be a nonnegative safe integer");
  }
  if (
    usage.costUsd !== null &&
    (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)
  ) {
    throw artifactError("artifact_usage", "usage.costUsd must be null or finite and nonnegative");
  }
  return {
    input: usage.input as number,
    output: usage.output as number,
    costUsd: usage.costUsd as number | null,
  };
}

function captureResult(value: unknown, runId: string, memberId: string): CapturedResult {
  let hasError = false;
  if (
    value !== null &&
    typeof value === "object" &&
    !nodeUtilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    hasError = Object.prototype.hasOwnProperty.call(value, "error");
  }
  const captured = exactDataRecord(
    value,
    hasError ? RESULT_WITH_ERROR_KEYS : RESULT_REQUIRED_KEYS,
    "artifact_result",
    "member result",
  );
  if (typeof captured.ok !== "boolean") {
    throw artifactError("artifact_ok", "result.ok must be a boolean");
  }
  if (captured.model !== null && typeof captured.model !== "string") {
    throw artifactError("artifact_model", "result.model must be a string or null");
  }
  const outputLength = utf8ByteLengthBounded(
    captured.text,
    TEAM_LIMITS.outputBytes,
    "result.text",
  );
  if (typeof captured.model === "string") {
    utf8ByteLengthBounded(captured.model, TEAM_LIMITS.resultBytes, "result.model");
  }
  if (hasError) {
    utf8ByteLengthBounded(captured.error, TEAM_LIMITS.resultBytes, "result.error");
  }
  const usage = captureUsage(captured.usage);
  const result: MemberResult = {
    ok: captured.ok,
    text: captured.text as string,
    model: captured.model as string | null,
    usage,
    ...(hasError ? { error: captured.error as string } : {}),
  };
  const envelope = {
    runId,
    memberId,
    ok: result.ok,
    model: result.model,
    usage: result.usage,
    ...(hasError ? { error: result.error } : {}),
  };
  let snapshot;
  try {
    snapshot = canonicalJsonSnapshotBounded(envelope, TEAM_LIMITS.resultBytes);
  } catch (error) {
    if (error instanceof RangeError && String(error).includes("canonical_json:exceeds")) {
      throw artifactError(
        "artifact_result_bytes",
        `result JSON exceeds ${TEAM_LIMITS.resultBytes} UTF-8 bytes`,
      );
    }
    throw artifactError("artifact_result", "result cannot be canonically encoded");
  }
  const output = Buffer.from(result.text, "utf8");
  if (output.byteLength !== outputLength) {
    throw artifactError("artifact_utf8", "result.text changed during UTF-8 encoding");
  }
  return {
    result,
    output,
    resultBytes: Buffer.from(snapshot.json, "utf8"),
  };
}

function captureArtifactRef(value: unknown): ArtifactRef {
  const ref = exactDataRecord(value, ARTIFACT_REF_KEYS, "artifact_ref", "artifact reference");
  if (typeof ref.memberId !== "string" || !IDENTIFIER.test(ref.memberId)) {
    throw artifactError("artifact_member_id", "artifact member ID must be a valid identifier");
  }
  for (const field of ["outputPath", "resultPath"] as const) {
    if (typeof ref[field] !== "string") {
      throw artifactError("artifact_path", `${field} must be a string`);
    }
  }
  for (const [field, maximum] of [
    ["outputBytes", TEAM_LIMITS.outputBytes],
    ["resultBytes", TEAM_LIMITS.resultBytes],
  ] as const) {
    if (!Number.isSafeInteger(ref[field]) || (ref[field] as number) < 0 || (ref[field] as number) > maximum) {
      throw artifactError("artifact_size", `${field} is outside package limits`);
    }
  }
  for (const field of ["outputSha256", "resultSha256"] as const) {
    if (typeof ref[field] !== "string" || !SHA256.test(ref[field])) {
      throw artifactError("artifact_digest", `${field} must be canonical lowercase SHA-256`);
    }
  }
  const memberId = ref.memberId;
  const outputPath = `artifacts/${memberId}/output.md`;
  const resultPath = `artifacts/${memberId}/result.json`;
  if (ref.outputPath !== outputPath || ref.resultPath !== resultPath) {
    throw artifactError("artifact_path", "artifact paths do not match the member identity");
  }
  return {
    memberId,
    outputPath,
    resultPath,
    outputBytes: ref.outputBytes as number,
    outputSha256: ref.outputSha256 as string,
    resultBytes: ref.resultBytes as number,
    resultSha256: ref.resultSha256 as string,
  };
}

function validateIdentifiers(projectId: unknown, runId: unknown, memberId?: unknown): void {
  if (!isProjectId(projectId)) {
    throw artifactError("artifact_project_id", "project ID must be a lowercase SHA-256 digest");
  }
  if (!isRunId(runId)) {
    throw artifactError("artifact_run_id", "run ID must be a lowercase UUID");
  }
  if (memberId !== undefined && (typeof memberId !== "string" || !IDENTIFIER.test(memberId))) {
    throw artifactError("artifact_member_id", "member ID must be a valid identifier");
  }
}

async function descriptorPath(
  fs: FileSystem,
  handle: FileHandle,
  expected: FileStat,
): Promise<string> {
  if (!Number.isInteger(handle.fd) || handle.fd < 0) {
    throw artifactError("artifact_directory_descriptor", "directory descriptor is unavailable");
  }
  for (const base of ["/proc/self/fd", "/dev/fd"] as const) {
    const candidate = `${base}/${handle.fd}`;
    let verifier: FileHandle | undefined;
    try {
      await fs.realpath(candidate);
      verifier = await fs.open(candidate, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      const actual = await verifier.stat();
      if (actual.isDirectory() && sameIdentity(expected, actual)) return candidate;
    } catch {
      // Try the next descriptor-path facility; pathname fallback is intentionally forbidden.
    } finally {
      await verifier?.close();
    }
  }
  throw artifactError(
    "artifact_directory_descriptor",
    "no verified descriptor-root path facility is available",
  );
}

async function openDirectory(
  fs: FileSystem,
  path: string,
  label: string,
  requireExactMode = true,
  expectedIdentity?: FileStat,
): Promise<OpenDirectory> {
  let before: FileStat;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    throw artifactError(`artifact_directory_${label}`, `cannot inspect directory: ${String(error)}`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    (expectedIdentity !== undefined && !sameIdentity(before, expectedIdentity))
  ) {
    throw artifactError(`artifact_directory_${label}`, "path is not the expected real directory");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(path, DIRECTORY_FLAGS);
  } catch (error) {
    throw artifactError(`artifact_directory_${label}`, `cannot open directory: ${String(error)}`);
  }
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || !sameIdentity(before, after)) {
      throw artifactError(`artifact_directory_${label}`, "directory identity changed");
    }
    if (requireExactMode && (after.mode & 0o7777) !== DIRECTORY_MODE) {
      throw artifactError(`artifact_directory_${label}`, "directory mode is not exactly 0700");
    }
    return {
      handle,
      descriptor: await descriptorPath(fs, handle, after),
      identity: after,
      linkPath: path,
      requireExactMode,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyDirectoryLinked(
  fs: FileSystem,
  directory: OpenDirectory,
  label: string,
): Promise<void> {
  let linked: FileStat;
  try {
    linked = await fs.lstat(directory.linkPath);
  } catch (error) {
    throw artifactError(`artifact_directory_${label}`, `directory path changed: ${String(error)}`);
  }
  const opened = await directory.handle.stat();
  if (
    linked.isSymbolicLink() ||
    !linked.isDirectory() ||
    !opened.isDirectory() ||
    !sameIdentity(directory.identity, opened) ||
    !sameIdentity(opened, linked) ||
    (directory.requireExactMode && (
      (opened.mode & 0o7777) !== DIRECTORY_MODE ||
      (linked.mode & 0o7777) !== DIRECTORY_MODE
    ))
  ) {
    throw artifactError(
      `artifact_directory_${label}`,
      "directory identity or exact mode changed during artifact access",
    );
  }
}

async function openConfiguredRoot(
  fs: FileSystem,
  configuredRoot: string,
): Promise<{ root: OpenDirectory; chain: OpenDirectory[] }> {
  const rootPath = parse(configuredRoot).root;
  const components = configuredRoot.slice(rootPath.length).split(sep).filter(Boolean);
  const chain: OpenDirectory[] = [];
  try {
    let current = await openDirectory(fs, rootPath, "root_anchor", false);
    chain.push(current);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      if (component === "." || component === ".." || component.includes("/") || component.includes("\\")) {
        throw artifactError("artifact_directory_root_component", "configured root has an invalid component");
      }
      current = await openDirectory(
        fs,
        `${current.descriptor}/${component}`,
        "root_component",
        index === components.length - 1,
      );
      chain.push(current);
    }
    return { root: current, chain };
  } catch (error) {
    await closeAll(chain.map(({ handle }) => handle));
    throw error;
  }
}

async function verifyDirectoryChain(
  fs: FileSystem,
  rootChain: OpenDirectory[],
  descendants: Array<{ directory: OpenDirectory; label: string }>,
): Promise<void> {
  for (const directory of rootChain) {
    await verifyDirectoryLinked(fs, directory, directory === rootChain[0] ? "root_anchor" : "root_component");
  }
  for (const { directory, label } of descendants) {
    await verifyDirectoryLinked(fs, directory, label);
  }
}

async function createMemberDirectory(
  fs: FileSystem,
  artifacts: OpenDirectory,
  memberId: string,
): Promise<OpenDirectory> {
  const path = `${artifacts.descriptor}/${memberId}`;
  try {
    await fs.mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw artifactError("artifact_exists", "member artifact directory already exists");
    }
    throw error;
  }
  let created: FileStat;
  try {
    created = await fs.lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw artifactError("artifact_directory_member", "new member path is not a real directory");
    }
    await fs.chmod(path, DIRECTORY_MODE);
    const tightened = await fs.lstat(path);
    if (
      tightened.isSymbolicLink() ||
      !tightened.isDirectory() ||
      !sameIdentity(created, tightened) ||
      (tightened.mode & 0o7777) !== DIRECTORY_MODE
    ) {
      throw artifactError("artifact_directory_member", "new member directory changed while tightening mode");
    }
    created = tightened;
  } catch (error) {
    throw artifactError("artifact_directory_member", `cannot tighten new member directory: ${String(error)}`);
  }

  let member: OpenDirectory;
  try {
    member = await openDirectory(fs, path, "member", true, created);
  } catch (error) {
    throw artifactError("artifact_directory_member", `cannot verify new member directory: ${String(error)}`);
  }
  try {
    await member.handle.chmod(DIRECTORY_MODE);
    const verified = await member.handle.stat();
    if (!sameIdentity(created, verified) || (verified.mode & 0o7777) !== DIRECTORY_MODE) {
      throw artifactError("artifact_directory_member", "member descriptor identity or mode changed");
    }
    await member.handle.sync();
    await artifacts.handle.sync();
    return member;
  } catch (error) {
    await member.handle.close();
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (
      !Number.isInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.byteLength - offset
    ) {
      throw artifactError("artifact_write", "filesystem returned an invalid write count");
    }
    offset += bytesWritten;
  }
}

async function readExact(
  handle: FileHandle,
  size: number,
  label: "output" | "result",
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.byteLength - offset) {
      throw artifactError(`artifact_file_${label}`, "file changed or returned an invalid read count");
    }
    offset += bytesRead;
  }
  return bytes;
}

async function createDurableFile(
  fs: FileSystem,
  path: string,
  label: "output" | "result",
  bytes: Buffer,
  maximum: number,
): Promise<OpenArtifactFile> {
  const handle = await fs.open(path, EXCLUSIVE_WRITE_FLAGS, FILE_MODE);
  try {
    await handle.chmod(FILE_MODE);
    await writeAll(handle, bytes);
    await handle.sync();
    const identity = await handle.stat();
    const linked = await fs.lstat(path);
    if (
      !identity.isFile() ||
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      !sameObservedFile(identity, linked) ||
      identity.size !== bytes.byteLength ||
      identity.size > maximum ||
      (identity.mode & 0o7777) !== FILE_MODE
    ) {
      throw artifactError(`artifact_file_${label}`, "new file identity, size, or exact mode is invalid");
    }
    return {
      handle,
      path,
      label,
      expectedBytes: bytes.byteLength,
      expectedDigest: digest(bytes),
      maximum,
      identity,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyDigest(bytes: Uint8Array, expectedHex: string, label: string): void {
  const actual = createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw artifactError("artifact_digest", `${label} digest does not match its reference`);
  }
}

async function openBoundedFile(
  fs: FileSystem,
  path: string,
  label: "output" | "result",
  expectedBytes: number,
  expectedDigest: string,
  maximum: number,
): Promise<{ file: OpenArtifactFile; bytes: Buffer }> {
  let before: FileStat;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    throw artifactError(`artifact_file_${label}`, `cannot inspect file: ${String(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw artifactError(`artifact_file_${label}`, "path is not a regular file");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(path, READ_FLAGS);
  } catch (error) {
    throw artifactError(`artifact_file_${label}`, `cannot open file: ${String(error)}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw artifactError(`artifact_file_${label}`, "file identity changed");
    }
    if ((opened.mode & 0o7777) !== FILE_MODE) {
      throw artifactError(`artifact_file_${label}`, "file mode is not exactly 0600");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maximum) {
      throw artifactError(
        label === "output" ? "artifact_output_bytes" : "artifact_result_bytes",
        `${label} file exceeds ${maximum} bytes`,
      );
    }
    if (opened.size !== expectedBytes) {
      throw artifactError("artifact_size", `${label} file size does not match its reference`);
    }

    const bytes = await readExact(handle, opened.size, label);
    const identity = await handle.stat();
    const linked = await fs.lstat(path);
    if (
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      !sameObservedFile(opened, identity) ||
      !sameObservedFile(identity, linked)
    ) {
      throw artifactError(`artifact_file_${label}`, "file identity or content changed during read");
    }
    verifyDigest(bytes, expectedDigest, label);
    return {
      file: { handle, path, label, expectedBytes, expectedDigest, maximum, identity },
      bytes,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyOpenArtifactContents(file: OpenArtifactFile): Promise<void> {
  const before = await file.handle.stat();
  if (
    !before.isFile() ||
    !sameObservedFile(file.identity, before) ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > file.maximum ||
    before.size !== file.expectedBytes ||
    (before.mode & 0o7777) !== FILE_MODE
  ) {
    throw artifactError(`artifact_file_${file.label}`, "open file identity, size, or mode changed");
  }
  const bytes = await readExact(file.handle, before.size, file.label);
  const after = await file.handle.stat();
  if (!sameObservedFile(before, after)) {
    throw artifactError(`artifact_file_${file.label}`, "open file changed during final verification");
  }
  verifyDigest(bytes, file.expectedDigest, file.label);
}

async function verifyOpenArtifactPath(fs: FileSystem, file: OpenArtifactFile): Promise<void> {
  let linked: FileStat;
  try {
    linked = await fs.lstat(file.path);
  } catch (error) {
    throw artifactError(`artifact_file_${file.label}`, `file path changed: ${String(error)}`);
  }
  const opened = await file.handle.stat();
  if (
    linked.isSymbolicLink() ||
    !linked.isFile() ||
    !sameObservedFile(file.identity, opened) ||
    !sameObservedFile(opened, linked) ||
    opened.size !== file.expectedBytes ||
    (opened.mode & 0o7777) !== FILE_MODE
  ) {
    throw artifactError(`artifact_file_${file.label}`, "file pathname identity, size, or mode changed");
  }
}

function fatalDecode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw artifactError("artifact_utf8", `${label} is not valid UTF-8`);
  }
}

function parseResultEnvelope(text: string, runId: string, memberId: string): Omit<MemberResult, "text"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw artifactError("artifact_result", "result file is not valid JSON");
  }
  const hasError = parsed !== null &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "error");
  const envelope = exactDataRecord(
    parsed,
    hasError ? ENVELOPE_WITH_ERROR_KEYS : ENVELOPE_REQUIRED_KEYS,
    "artifact_result",
    "result envelope",
  );
  if (envelope.runId !== runId || envelope.memberId !== memberId) {
    throw artifactError("artifact_identity", "result identity does not match its artifact reference");
  }
  if (typeof envelope.ok !== "boolean") {
    throw artifactError("artifact_ok", "result.ok must be a boolean");
  }
  if (envelope.model !== null && typeof envelope.model !== "string") {
    throw artifactError("artifact_model", "result.model must be a string or null");
  }
  if (typeof envelope.model === "string") {
    utf8ByteLengthBounded(envelope.model, TEAM_LIMITS.resultBytes, "result.model");
  }
  if (hasError) {
    utf8ByteLengthBounded(envelope.error, TEAM_LIMITS.resultBytes, "result.error");
  }
  const usage = captureUsage(envelope.usage);
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    throw artifactError("artifact_result", "result file is not canonical JSON data");
  }
  if (canonical !== text) {
    throw artifactError("artifact_canonical", "result file is not canonical JSON");
  }
  return {
    ok: envelope.ok,
    model: envelope.model as string | null,
    usage,
    ...(hasError ? { error: envelope.error as string } : {}),
  };
}

export function createFileArtifactStore(input: FileArtifactStoreOptions): ArtifactStore {
  if (input === null || typeof input !== "object" || typeof input.root !== "string") {
    throw artifactError("artifact_store_options", "root must be a path string");
  }
  const configuredRoot = resolve(input.root);
  if (configuredRoot === parse(configuredRoot).root) {
    throw artifactError("artifact_store_options", "filesystem root cannot be the artifact store root");
  }
  const fs = input.fs ?? nodeFs;

  return {
    async writeMember(
      projectId: string,
      runId: string,
      memberId: string,
      value: MemberResult,
    ): Promise<ArtifactRef> {
      validateIdentifiers(projectId, runId, memberId);
      const captured = captureResult(value, runId, memberId);
      let rootChain: OpenDirectory[] = [];
      let project: OpenDirectory | undefined;
      let run: OpenDirectory | undefined;
      let artifacts: OpenDirectory | undefined;
      let member: OpenDirectory | undefined;
      let outputFile: OpenArtifactFile | undefined;
      let resultFile: OpenArtifactFile | undefined;
      try {
        const rootAuthority = await openConfiguredRoot(fs, configuredRoot);
        rootChain = rootAuthority.chain;
        const root = rootAuthority.root;
        project = await openDirectory(fs, `${root.descriptor}/${projectId}`, "project");
        run = await openDirectory(fs, `${project.descriptor}/${runId}`, "run");
        artifacts = await openDirectory(fs, `${run.descriptor}/artifacts`, "artifacts");
        member = await createMemberDirectory(fs, artifacts, memberId);

        outputFile = await createDurableFile(
          fs,
          `${member.descriptor}/output.md`,
          "output",
          captured.output,
          TEAM_LIMITS.outputBytes,
        );
        resultFile = await createDurableFile(
          fs,
          `${member.descriptor}/result.json`,
          "result",
          captured.resultBytes,
          TEAM_LIMITS.resultBytes,
        );
        await member.handle.sync();
        await verifyOpenArtifactContents(outputFile);
        await verifyOpenArtifactContents(resultFile);
        await verifyDirectoryChain(fs, rootChain, [
          { directory: project, label: "project" },
          { directory: run, label: "run" },
          { directory: artifacts, label: "artifacts" },
          { directory: member, label: "member" },
        ]);
        await verifyOpenArtifactPath(fs, outputFile);
        await verifyOpenArtifactPath(fs, resultFile);

        return {
          memberId,
          outputPath: `artifacts/${memberId}/output.md`,
          resultPath: `artifacts/${memberId}/result.json`,
          outputBytes: outputFile.expectedBytes,
          outputSha256: outputFile.expectedDigest,
          resultBytes: resultFile.expectedBytes,
          resultSha256: resultFile.expectedDigest,
        };
      } finally {
        await closeAll([
          outputFile?.handle,
          resultFile?.handle,
          member?.handle,
          artifacts?.handle,
          run?.handle,
          project?.handle,
          ...rootChain.map(({ handle }) => handle).reverse(),
        ]);
      }
    },

    async readVerified(
      projectId: string,
      runId: string,
      value: ArtifactRef,
    ): Promise<{ text: string; result: MemberResult }> {
      validateIdentifiers(projectId, runId);
      const ref = captureArtifactRef(value);
      validateIdentifiers(projectId, runId, ref.memberId);
      let rootChain: OpenDirectory[] = [];
      let project: OpenDirectory | undefined;
      let run: OpenDirectory | undefined;
      let artifacts: OpenDirectory | undefined;
      let member: OpenDirectory | undefined;
      let outputFile: OpenArtifactFile | undefined;
      let resultFile: OpenArtifactFile | undefined;
      try {
        const rootAuthority = await openConfiguredRoot(fs, configuredRoot);
        rootChain = rootAuthority.chain;
        const root = rootAuthority.root;
        project = await openDirectory(fs, `${root.descriptor}/${projectId}`, "project");
        run = await openDirectory(fs, `${project.descriptor}/${runId}`, "run");
        artifacts = await openDirectory(fs, `${run.descriptor}/artifacts`, "artifacts");
        member = await openDirectory(fs, `${artifacts.descriptor}/${ref.memberId}`, "member");

        const openedOutput = await openBoundedFile(
          fs,
          `${member.descriptor}/output.md`,
          "output",
          ref.outputBytes,
          ref.outputSha256,
          TEAM_LIMITS.outputBytes,
        );
        outputFile = openedOutput.file;
        const openedResult = await openBoundedFile(
          fs,
          `${member.descriptor}/result.json`,
          "result",
          ref.resultBytes,
          ref.resultSha256,
          TEAM_LIMITS.resultBytes,
        );
        resultFile = openedResult.file;
        const text = fatalDecode(openedOutput.bytes, "member output");
        const envelope = parseResultEnvelope(
          fatalDecode(openedResult.bytes, "member result"),
          runId,
          ref.memberId,
        );
        await verifyOpenArtifactContents(outputFile);
        await verifyOpenArtifactContents(resultFile);
        await verifyDirectoryChain(fs, rootChain, [
          { directory: project, label: "project" },
          { directory: run, label: "run" },
          { directory: artifacts, label: "artifacts" },
          { directory: member, label: "member" },
        ]);
        await verifyOpenArtifactPath(fs, outputFile);
        await verifyOpenArtifactPath(fs, resultFile);
        return { text, result: { ...envelope, text } };
      } finally {
        await closeAll([
          outputFile?.handle,
          resultFile?.handle,
          member?.handle,
          artifacts?.handle,
          run?.handle,
          project?.handle,
          ...rootChain.map(({ handle }) => handle).reverse(),
        ]);
      }
    },
  };
}
