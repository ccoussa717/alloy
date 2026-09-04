import { randomUUID as nodeRandomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "../core/compiler.ts";
import {
  hashEvent,
  isProjectId,
  isRfc3339Utc,
  isRunId,
  isTerminalTeamEvent,
  validateEventDraft,
  validateEventHistory,
} from "../core/events.ts";
import { TEAM_LIMITS, ZERO_HASH } from "../core/limits.ts";
import type {
  EventDraft,
  EventStore,
  EventWriter,
  FileEventStoreOptions,
  RunSnapshotInput,
  TeamEvent,
} from "../core/types.ts";

type FileSystem = typeof nodeFs;
type FileHandle = Awaited<ReturnType<FileSystem["open"]>>;
type FileStat = Awaited<ReturnType<FileHandle["stat"]>>;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIRECTORY_FLAGS = constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const EXCLUSIVE_WRITE_FLAGS = constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);
const APPEND_FLAGS = constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0);

function storeError(code: string, message: string): Error {
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

async function closeAll(handles: Array<FileHandle | undefined>): Promise<void> {
  const results = await Promise.allSettled(handles.map(async (handle) => handle?.close()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

async function descriptorPath(
  fs: FileSystem,
  handle: FileHandle,
  expected: FileStat,
): Promise<string> {
  if (!Number.isInteger(handle.fd) || handle.fd < 0) {
    throw storeError("event_directory_descriptor", "directory descriptor is unavailable");
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
      // Try the next descriptor-path facility.
    } finally {
      await verifier?.close();
    }
  }
  throw storeError(
    "event_directory_descriptor",
    "no verified descriptor-root path facility is available",
  );
}

async function openDirectory(
  fs: FileSystem,
  path: string,
  label: string,
): Promise<{ handle: FileHandle; descriptor: string }> {
  let before: FileStat;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    throw storeError(`event_directory_${label}`, `cannot inspect directory: ${String(error)}`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw storeError(`event_directory_${label}`, "path is not a regular directory");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(path, DIRECTORY_FLAGS);
  } catch (error) {
    throw storeError(`event_directory_${label}`, `cannot open directory: ${String(error)}`);
  }
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || !sameIdentity(before, after)) {
      throw storeError(`event_directory_${label}`, "directory identity changed");
    }
    return { handle, descriptor: await descriptorPath(fs, handle, after) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function ensureRoot(fs: FileSystem, configuredRoot: string) {
  const root = resolve(configuredRoot);
  await fs.mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  const directory = await openDirectory(fs, root, "root");
  await directory.handle.chmod(DIRECTORY_MODE);
  return directory;
}

async function ensureProjectDirectory(
  fs: FileSystem,
  rootDescriptor: string,
  projectId: string,
) {
  const path = `${rootDescriptor}/${projectId}`;
  try {
    await fs.mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const directory = await openDirectory(fs, path, "project");
  await directory.handle.chmod(DIRECTORY_MODE);
  return directory;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw storeError("event_write", "filesystem returned an invalid write count");
    }
    offset += bytesWritten;
  }
}

async function createDurableFile(
  fs: FileSystem,
  path: string,
  value: unknown,
): Promise<void> {
  const handle = await fs.open(path, EXCLUSIVE_WRITE_FLAGS, FILE_MODE);
  try {
    await writeAll(handle, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateStoreIdentifiers(projectId: unknown, runId?: unknown): void {
  if (!isProjectId(projectId)) {
    throw storeError("event_project_id", "project ID must be a lowercase SHA-256 digest");
  }
  if (runId !== undefined && !isRunId(runId)) {
    throw storeError("event_run_id", "run ID must be a lowercase UUID");
  }
}

class FileEventWriter implements EventWriter {
  private lastSequence = 0;
  private lastHash = ZERO_HASH;
  private historyBytes = 0;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly runId: string;
  private readonly eventHandle: FileHandle;
  private readonly lockHandle: FileHandle;
  private readonly runDirectoryHandle: FileHandle;
  private readonly ancestorHandles: FileHandle[];

  constructor(
    runId: string,
    eventHandle: FileHandle,
    lockHandle: FileHandle,
    runDirectoryHandle: FileHandle,
    ancestorHandles: FileHandle[],
  ) {
    this.runId = runId;
    this.eventHandle = eventHandle;
    this.lockHandle = lockHandle;
    this.runDirectoryHandle = runDirectoryHandle;
    this.ancestorHandles = ancestorHandles;
  }

  append(draft: EventDraft): Promise<TeamEvent> {
    let captured: EventDraft;
    try {
      validateEventDraft(draft);
      captured = JSON.parse(canonicalJson(draft)) as EventDraft;
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.tail.then(() => this.appendNow(captured));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    const operation = this.tail.then(() => this.closeNow());
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async appendNow(draft: EventDraft): Promise<TeamEvent> {
    if (this.closed) throw storeError("event_writer_closed", "event writer is closed");
    if (this.lastSequence >= TEAM_LIMITS.eventHistoryEvents) {
      throw storeError(
        "event_history_events",
        `event history exceeds ${TEAM_LIMITS.eventHistoryEvents} events`,
      );
    }

    const eventWithoutHash = {
      v: 1 as const,
      runId: this.runId,
      seq: this.lastSequence + 1,
      type: draft.type,
      actor: draft.actor,
      occurredAt: draft.occurredAt,
      payload: draft.payload,
      prevHash: this.lastHash,
    };
    const event: TeamEvent = {
      ...eventWithoutHash,
      hash: hashEvent(eventWithoutHash),
    };
    const line = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
    if (line.byteLength > TEAM_LIMITS.eventLineBytes) {
      throw storeError(
        "event_line_bytes",
        `event exceeds ${TEAM_LIMITS.eventLineBytes} bytes`,
      );
    }
    if (this.historyBytes + line.byteLength > TEAM_LIMITS.eventHistoryBytes) {
      throw storeError(
        "event_history_bytes",
        `event history exceeds ${TEAM_LIMITS.eventHistoryBytes} bytes`,
      );
    }

    try {
      await writeAll(this.eventHandle, line);
      await this.eventHandle.sync();
      this.lastSequence = event.seq;
      this.lastHash = event.hash;
      this.historyBytes += line.byteLength;
      if (isTerminalTeamEvent(event.type)) {
        await this.runDirectoryHandle.sync();
        await this.closeResources();
      }
      return event;
    } catch (error) {
      try {
        await this.closeResources();
      } catch {
        // Preserve the append failure; the writer remains fail-closed.
      }
      throw error;
    }
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeAll([
      this.eventHandle,
      this.lockHandle,
      this.runDirectoryHandle,
      ...this.ancestorHandles,
    ]);
  }
}

async function readEventLines(handle: FileHandle): Promise<unknown[]> {
  const events: unknown[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  let historyBytes = 0;
  let lineBytes = 0;
  let lineParts: Buffer[] = [];

  while (true) {
    const remaining = TEAM_LIMITS.eventHistoryBytes - historyBytes;
    const requested = Math.min(buffer.byteLength, remaining + 1);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
      throw storeError("event_read", "filesystem returned an invalid read count");
    }
    if (bytesRead === 0) break;
    position += bytesRead;

    let start = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const segment = Buffer.from(buffer.subarray(start, index));
      const consumed = index - start + 1;
      historyBytes += consumed;
      lineBytes += consumed;
      if (historyBytes > TEAM_LIMITS.eventHistoryBytes) {
        throw storeError(
          "event_history_bytes",
          `event history exceeds ${TEAM_LIMITS.eventHistoryBytes} bytes`,
        );
      }
      if (lineBytes > TEAM_LIMITS.eventLineBytes) {
        throw storeError(
          "event_line_bytes",
          `event line exceeds ${TEAM_LIMITS.eventLineBytes} bytes`,
        );
      }
      if (lineBytes === 1) throw storeError("event_blank_line", "event history contains a blank line");
      if (events.length >= TEAM_LIMITS.eventHistoryEvents) {
        throw storeError(
          "event_history_events",
          `event history exceeds ${TEAM_LIMITS.eventHistoryEvents} events`,
        );
      }
      lineParts.push(segment);
      const encoded = Buffer.concat(lineParts);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
      } catch {
        throw storeError("event_utf8", "event line is not valid UTF-8");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw storeError("event_parse", "event line is not valid JSON");
      }
      let canonical: string;
      try {
        canonical = canonicalJson(parsed);
      } catch {
        throw storeError("event_parse", "event line cannot be canonically represented");
      }
      if (canonical !== text) {
        throw storeError("event_canonical", "event line is not canonical JSON");
      }
      events.push(parsed);
      lineParts = [];
      lineBytes = 0;
      start = index + 1;
    }

    if (start < bytesRead) {
      const segment = Buffer.from(buffer.subarray(start, bytesRead));
      historyBytes += segment.byteLength;
      lineBytes += segment.byteLength;
      if (historyBytes > TEAM_LIMITS.eventHistoryBytes) {
        throw storeError(
          "event_history_bytes",
          `event history exceeds ${TEAM_LIMITS.eventHistoryBytes} bytes`,
        );
      }
      if (lineBytes > TEAM_LIMITS.eventLineBytes) {
        throw storeError(
          "event_line_bytes",
          `event line exceeds ${TEAM_LIMITS.eventLineBytes} bytes`,
        );
      }
      lineParts.push(segment);
    }
  }

  if (lineBytes !== 0) {
    throw storeError("event_truncated", "event history does not end in a newline");
  }
  if (events.length === 0) {
    throw storeError("event_history", "event history must not be empty");
  }
  return events;
}

export function createFileEventStore(input: FileEventStoreOptions): EventStore {
  if (input === null || typeof input !== "object" || typeof input.root !== "string") {
    throw storeError("event_store_options", "root must be a path string");
  }
  const fs = input.fs ?? nodeFs;
  const configuredRoot = resolve(input.root);
  const now = input.now ?? (() => new Date().toISOString());
  const randomUUID = input.randomUUID ?? nodeRandomUUID;

  return {
    async createRun(snapshot: RunSnapshotInput): Promise<EventWriter> {
      validateStoreIdentifiers(snapshot?.projectId, snapshot?.runId);
      const projectId = snapshot.projectId;
      const runId = snapshot.runId;
      const manifest = JSON.parse(canonicalJson(snapshot.manifest)) as RunSnapshotInput["manifest"];
      const request = JSON.parse(canonicalJson(snapshot.request)) as RunSnapshotInput["request"];
      const claimedAt = now();
      const writerId = randomUUID();
      if (!isRfc3339Utc(claimedAt)) {
        throw storeError("event_writer_time", "writer claim time must be RFC 3339 UTC");
      }
      if (!isRunId(writerId)) {
        throw storeError("event_writer_id", "writer claim ID must be a lowercase UUID");
      }

      let rootHandle: FileHandle | undefined;
      let projectHandle: FileHandle | undefined;
      let runHandle: FileHandle | undefined;
      let lockHandle: FileHandle | undefined;
      let eventHandle: FileHandle | undefined;
      try {
        const root = await ensureRoot(fs, configuredRoot);
        rootHandle = root.handle;
        const project = await ensureProjectDirectory(fs, root.descriptor, projectId);
        projectHandle = project.handle;
        await rootHandle.sync();
        const runPath = `${project.descriptor}/${runId}`;
        try {
          await fs.mkdir(runPath, { mode: DIRECTORY_MODE });
        } catch (error) {
          if (errorCode(error) === "EEXIST") {
            throw storeError("event_writer_claimed", "run ID has already been claimed");
          }
          throw error;
        }
        await projectHandle.sync();
        const run = await openDirectory(fs, runPath, "run");
        runHandle = run.handle;

        lockHandle = await fs.open(
          `${run.descriptor}/writer.lock`,
          EXCLUSIVE_WRITE_FLAGS,
          FILE_MODE,
        );
        await writeAll(
          lockHandle,
          Buffer.from(`${canonicalJson({ claimedAt, writerId })}\n`, "utf8"),
        );
        await lockHandle.sync();
        await createDurableFile(
          fs,
          `${run.descriptor}/manifest.snapshot.json`,
          manifest,
        );
        await createDurableFile(fs, `${run.descriptor}/request.json`, request);
        await fs.mkdir(`${run.descriptor}/artifacts`, { mode: DIRECTORY_MODE });
        eventHandle = await fs.open(
          `${run.descriptor}/events.jsonl`,
          APPEND_FLAGS,
          FILE_MODE,
        );
        await eventHandle.sync();
        await runHandle.sync();

        return new FileEventWriter(
          runId,
          eventHandle,
          lockHandle,
          runHandle,
          [projectHandle, rootHandle],
        );
      } catch (error) {
        try {
          await closeAll([eventHandle, lockHandle, runHandle, projectHandle, rootHandle]);
        } catch {
          // Preserve the creation failure and leave the consumed run ID untouched.
        }
        throw error;
      }
    },

    async read(projectId: string, runId: string): Promise<TeamEvent[]> {
      validateStoreIdentifiers(projectId, runId);
      let rootHandle: FileHandle | undefined;
      let projectHandle: FileHandle | undefined;
      let runHandle: FileHandle | undefined;
      let eventHandle: FileHandle | undefined;
      try {
        const root = await openDirectory(fs, configuredRoot, "root");
        rootHandle = root.handle;
        const project = await openDirectory(fs, `${root.descriptor}/${projectId}`, "project");
        projectHandle = project.handle;
        const run = await openDirectory(fs, `${project.descriptor}/${runId}`, "run");
        runHandle = run.handle;
        const eventPath = `${run.descriptor}/events.jsonl`;
        eventHandle = await fs.open(eventPath, READ_FLAGS);
        const stat = await eventHandle.stat();
        if (!stat.isFile()) throw storeError("event_file", "events path is not a regular file");
        const parsed = await readEventLines(eventHandle);
        return validateEventHistory(parsed, runId);
      } finally {
        await closeAll([eventHandle, runHandle, projectHandle, rootHandle]);
      }
    },

    async list(projectId: string): Promise<string[]> {
      validateStoreIdentifiers(projectId);
      let rootHandle: FileHandle | undefined;
      let projectHandle: FileHandle | undefined;
      try {
        try {
          await fs.lstat(configuredRoot);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        }
        const root = await openDirectory(fs, configuredRoot, "root");
        rootHandle = root.handle;
        const projectPath = `${root.descriptor}/${projectId}`;
        try {
          await fs.lstat(projectPath);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        }
        const project = await openDirectory(fs, projectPath, "project");
        projectHandle = project.handle;
        const names = await fs.readdir(project.descriptor);
        const runs: string[] = [];
        for (const name of names.sort()) {
          if (!isRunId(name)) continue;
          const stat = await fs.lstat(`${project.descriptor}/${name}`);
          if (stat.isDirectory() && !stat.isSymbolicLink()) runs.push(name);
        }
        return runs;
      } finally {
        await closeAll([projectHandle, rootHandle]);
      }
    },
  };
}
