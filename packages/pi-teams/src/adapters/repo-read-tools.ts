import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import { Type } from "typebox";

const TOOL_OUTPUT_BYTES = 65_536;
const FILE_READ_BYTES = 60_000;
const MAX_ENTRIES = 4_096;
const MAX_PATTERN_BYTES = 1_024;
const MAX_PATH_BYTES = 4_096;
const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OPEN_FILE = constants.O_RDONLY | constants.O_NOFOLLOW;

export interface RepoReadOnlyToolsOptions {
  cwd: string;
  /** Deterministic race hook used by security tests after lstat and before open. */
  beforeOpen?: (relativePath: string) => Promise<void>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface RepoTool {
  name: "read" | "grep" | "find" | "ls";
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

interface OpenedPath {
  handle: FileHandle;
  stat: Stats;
  relativePath: string;
}

function pathError(code: "path" | "symlink" | "identity", message: string): Error {
  return new Error(`repo_tool_${code}:${message}`);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.isDirectory() === right.isDirectory();
}

function relativeSegments(value: unknown, allowRoot: boolean): string[] {
  if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw pathError("path", "path must be well-formed UTF-8 text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw pathError("path", "path exceeds its bound");
  }
  if (value.startsWith("~") || isAbsolute(value) || value.includes("\0")) {
    throw pathError("path", "absolute, home-relative, and NUL paths are forbidden");
  }
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw pathError("path", "parent traversal is forbidden");
  }
  if (!allowRoot && segments.length === 0) {
    throw pathError("path", "a repository-relative file path is required");
  }
  return segments;
}

async function verifiedRoot(cwd: string): Promise<FileHandle> {
  const before = await lstat(cwd);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw pathError("symlink", "repository root must be a real directory");
  }
  const handle = await open(cwd, OPEN_DIRECTORY);
  try {
    const after = await handle.stat();
    if (!sameIdentity(before, after)) {
      throw pathError("identity", "repository root changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function descriptorChild(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`;
}

async function openVerifiedPath(
  options: RepoReadOnlyToolsOptions,
  rawPath: unknown,
  expected: "file" | "directory" | "either",
): Promise<OpenedPath> {
  const segments = relativeSegments(rawPath, expected !== "file");
  let current = await verifiedRoot(options.cwd);
  let currentOwned = true;
  let relativePath = ".";
  try {
    if (segments.length === 0) {
      const stat = await current.stat();
      return { handle: current, stat, relativePath };
    }
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      relativePath = segments.slice(0, index + 1).join("/");
      const path = descriptorChild(current, name);
      const before = await lstat(path);
      if (before.isSymbolicLink()) {
        throw pathError("symlink", `${relativePath} is a symbolic link`);
      }
      const final = index === segments.length - 1;
      if (!final && !before.isDirectory()) {
        throw pathError("path", `${relativePath} is not a directory`);
      }
      if (final) await options.beforeOpen?.(relativePath);
      const flags = !final || expected === "directory" ? OPEN_DIRECTORY : OPEN_FILE;
      const next = await open(path, flags);
      try {
        const after = await next.stat();
        if (!sameIdentity(before, after)) {
          throw pathError("identity", `${relativePath} changed while opening`);
        }
        if (final && expected === "file" && !after.isFile()) {
          throw pathError("path", `${relativePath} is not a regular file`);
        }
        if (final && expected === "directory" && !after.isDirectory()) {
          throw pathError("path", `${relativePath} is not a directory`);
        }
      } catch (error) {
        await next.close().catch(() => undefined);
        throw error;
      }
      if (currentOwned) await current.close();
      current = next;
      currentOwned = true;
    }
    const stat = await current.stat();
    return { handle: current, stat, relativePath };
  } catch (error) {
    if (currentOwned) await current.close().catch(() => undefined);
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("repo_tool_aborted:operation aborted");
}

function boundedText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= TOOL_OUTPUT_BYTES) return value;
  const suffix = "\n[truncated]\n";
  const maximum = TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix);
  const bytes = Buffer.from(value, "utf8").subarray(0, maximum);
  let text = bytes.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maximum) text = text.slice(0, -1);
  return text + suffix;
}

function result(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: boundedText(text) }], details };
}

async function readBounded(handle: FileHandle, signal?: AbortSignal): Promise<string> {
  const bytes = Buffer.alloc(FILE_READ_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    throwIfAborted(signal);
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  const selected = bytes.subarray(0, Math.min(offset, FILE_READ_BYTES));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(selected);
  return offset > FILE_READ_BYTES ? `${text}\n[truncated]\n` : text;
}

function integerParam(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("repo_tool_parameter:numeric parameter is outside its bound");
  }
  return value as number;
}

function stringParam(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > MAX_PATTERN_BYTES
  ) {
    throw new Error(`repo_tool_parameter:${label} is invalid`);
  }
  return value;
}

function wildcard(pattern: string): RegExp {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

async function directoryEntries(handle: FileHandle): Promise<Array<{ name: string; directory: boolean }>> {
  const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
  if (entries.length > MAX_ENTRIES) throw new Error("repo_tool_bound:directory entry limit exceeded");
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function collectFiles(
  options: RepoReadOnlyToolsOptions,
  rootPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pending = [rootPath];
  const files: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const relative = pending.shift()!;
    const opened = await openVerifiedPath(options, relative, "directory");
    try {
      for (const entry of await directoryEntries(opened.handle)) {
        visited += 1;
        if (visited > MAX_ENTRIES) throw new Error("repo_tool_bound:repository traversal limit exceeded");
        const child = relative === "." || relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.directory) pending.push(child);
        else files.push(child);
      }
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }
  return files.sort();
}

const pathProperty = Type.Optional(Type.String({ maxLength: MAX_PATH_BYTES }));

export function createRepoReadOnlyTools(options: RepoReadOnlyToolsOptions): RepoTool[] {
  const readTool: RepoTool = {
    name: "read",
    label: "Read repository file",
    description: "Read a bounded UTF-8 regular file strictly inside the repository.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES }),
      offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const opened = await openVerifiedPath(options, params.path, "file");
      try {
        const text = await readBounded(opened.handle, signal);
        const lines = text.split("\n");
        const offset = integerParam(params.offset, 1, 1, 1_000_000);
        const limit = integerParam(params.limit, 2_000, 1, 2_000);
        return result(lines.slice(offset - 1, offset - 1 + limit).join("\n"), {
          path: opened.relativePath,
          truncated: text.endsWith("\n[truncated]\n"),
        });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    },
  };

  const lsTool: RepoTool = {
    name: "ls",
    label: "List repository directory",
    description: "List a bounded directory strictly inside the repository.",
    parameters: Type.Object({
      path: pathProperty,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      const rawPath = params.path ?? ".";
      const opened = await openVerifiedPath(options, rawPath, "directory");
      try {
        const limit = integerParam(params.limit, 500, 1, 500);
        const entries = (await directoryEntries(opened.handle)).slice(0, limit);
        return result(entries.map((entry) => `${entry.name}${entry.directory ? "/" : ""}`).join("\n"), {
          path: opened.relativePath,
          entries: entries.length,
        });
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    },
  };

  const findTool: RepoTool = {
    name: "find",
    label: "Find repository files",
    description: "Find bounded repository-relative file names with * and ? wildcards.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_BYTES }),
      path: pathProperty,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const pattern = wildcard(stringParam(params.pattern, "pattern"));
      const rawPath = typeof params.path === "string" ? params.path : ".";
      relativeSegments(rawPath, true);
      const limit = integerParam(params.limit, 1_000, 1, 1_000);
      const files = (await collectFiles(options, rawPath, signal))
        .filter((path) => pattern.test(path))
        .slice(0, limit);
      return result(files.join("\n"), { matches: files.length });
    },
  };

  const grepTool: RepoTool = {
    name: "grep",
    label: "Search repository text",
    description: "Search bounded UTF-8 repository files for a fixed string; no subprocess is used.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, maxLength: MAX_PATTERN_BYTES }),
      path: pathProperty,
      glob: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATTERN_BYTES })),
      ignoreCase: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const requested = stringParam(params.pattern, "pattern");
      const needle = params.ignoreCase === true ? requested.toLocaleLowerCase() : requested;
      const rawPath = typeof params.path === "string" ? params.path : ".";
      relativeSegments(rawPath, true);
      const glob = params.glob === undefined ? undefined : wildcard(stringParam(params.glob, "glob"));
      const limit = integerParam(params.limit, 1_000, 1, 1_000);
      const files = await collectFiles(options, rawPath, signal);
      const matches: string[] = [];
      for (const path of files) {
        if (glob !== undefined && !glob.test(path)) continue;
        const opened = await openVerifiedPath(options, path, "file");
        try {
          const text = await readBounded(opened.handle, signal);
          const lines = text.split("\n");
          for (let index = 0; index < lines.length; index += 1) {
            const haystack = params.ignoreCase === true ? lines[index]!.toLocaleLowerCase() : lines[index]!;
            if (haystack.includes(needle)) matches.push(`${path}:${index + 1}:${lines[index]}`);
            if (matches.length >= limit) return result(matches.join("\n"), { matches: matches.length });
          }
        } finally {
          await opened.handle.close().catch(() => undefined);
        }
      }
      return result(matches.join("\n"), { matches: matches.length });
    },
  };

  return [readTool, grepTool, findTool, lsTool];
}
