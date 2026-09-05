import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { createTeamCatalog } from "../core/catalog.ts";
import { TEAM_LIMITS } from "../core/limits.ts";
import { parseTeamManifest } from "../core/manifest.ts";
import type {
  CatalogEntry,
  TeamCatalog,
  TeamNamespace,
} from "../core/types.ts";

interface CatalogStats {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface CatalogFileHandle {
  readonly fd: number;
  stat(): Promise<CatalogStats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  close(): Promise<void>;
}

export interface CatalogFileSystem {
  lstat(path: string): Promise<CatalogStats>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number): Promise<CatalogFileHandle>;
}

export interface LoadTeamCatalogInput {
  builtinsDir: string;
  userDir: string;
  projectDir: string;
  projectTrusted: boolean;
  fs?: CatalogFileSystem;
}

function loaderError(code: string, message: string): Error {
  return new Error(`${code}:${message}`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (
    error === null ||
    typeof error !== "object" ||
    nodeUtilTypes.isProxy(error) ||
    !nodeUtilTypes.isNativeError(error)
  ) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === code;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function sameIdentity(left: CatalogStats, right: CatalogStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function numericSize(stat: CatalogStats, origin: string): number {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw loaderError("catalog_file_bytes", `${origin} has an invalid size`);
  }
  return size;
}

async function descriptorRootPath(
  fs: CatalogFileSystem,
  rootHandle: CatalogFileHandle,
  rootStat: CatalogStats,
): Promise<string> {
  if (!Number.isInteger(rootHandle.fd) || rootHandle.fd < 0) {
    throw loaderError("catalog_descriptor_path", "root descriptor is unavailable");
  }

  for (const base of ["/proc/self/fd", "/dev/fd"] as const) {
    const candidate = `${base}/${rootHandle.fd}`;
    let verifier: CatalogFileHandle | undefined;
    try {
      await fs.realpath(candidate);
      verifier = await fs.open(
        candidate,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      const verified = await verifier.stat();
      if (verified.isDirectory() && sameIdentity(rootStat, verified)) {
        return candidate;
      }
    } catch {
      // Try the next known descriptor-path facility.
    } finally {
      await verifier?.close();
    }
  }

  throw loaderError(
    "catalog_descriptor_path",
    "no verified descriptor-root path facility is available",
  );
}

async function readBounded(
  handle: CatalogFileHandle,
  origin: string,
  aggregateBytes: number,
): Promise<Uint8Array> {
  const aggregateRemaining = TEAM_LIMITS.catalogBytes - aggregateBytes;
  const allowed = Math.min(TEAM_LIMITS.manifestBytes, aggregateRemaining);
  const bytes = Buffer.alloc(allowed + 1);
  let offset = 0;

  while (offset < bytes.byteLength) {
    const requested = bytes.byteLength - offset;
    const result = await handle.read(bytes, offset, requested, offset);
    if (
      !Number.isInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > requested
    ) {
      throw loaderError("catalog_read", `${origin} returned an invalid read size`);
    }
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }

  if (offset > TEAM_LIMITS.manifestBytes) {
    throw loaderError(
      "catalog_file_bytes",
      `${origin} exceeds ${TEAM_LIMITS.manifestBytes} bytes`,
    );
  }
  if (offset > aggregateRemaining) {
    throw loaderError(
      "catalog_bytes",
      `source catalog exceeds ${TEAM_LIMITS.catalogBytes} bytes`,
    );
  }
  return bytes.subarray(0, offset);
}

export async function loadTeamCatalog(
  input: LoadTeamCatalogInput,
): Promise<TeamCatalog> {
  const fs = input.fs ?? nodeFs;
  const entries: CatalogEntry[] = [];
  const sources: Array<[TeamNamespace, string, boolean]> = [
    ["builtin", input.builtinsDir, false],
    ["user", input.userDir, true],
  ];
  if (input.projectTrusted) {
    sources.push(["project", input.projectDir, true]);
  }

  for (const [source, configuredRoot, optional] of sources) {
    let rootBefore: CatalogStats;
    try {
      rootBefore = await fs.lstat(configuredRoot);
    } catch (error) {
      if (optional && hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (rootBefore.isSymbolicLink()) {
      throw loaderError("catalog_root_symlink", configuredRoot);
    }
    if (!rootBefore.isDirectory()) {
      throw loaderError("catalog_root_regular", configuredRoot);
    }

    const rootFlags = constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0);
    const rootHandle = await fs.open(configuredRoot, rootFlags);
    try {
      const rootAfter = await rootHandle.stat();
      if (!rootAfter.isDirectory() || !sameIdentity(rootBefore, rootAfter)) {
        throw loaderError("catalog_root_identity", configuredRoot);
      }
      const descriptorRoot = await descriptorRootPath(fs, rootHandle, rootAfter);
      const names = (await fs.readdir(descriptorRoot))
        .filter((name) => name.endsWith(".yaml"))
        .sort();

      if (names.length > TEAM_LIMITS.catalogFiles) {
        throw loaderError(
          "catalog_files",
          `${source} catalog contains more than ${TEAM_LIMITS.catalogFiles} YAML files`,
        );
      }

      let aggregateBytes = 0;
      for (const name of names) {
        if (name === "." || name === ".." || basename(name) !== name) {
          throw loaderError("catalog_escape", `${name} is not a direct child entry`);
        }
        const descriptorOrigin = resolve(descriptorRoot, name);
        const origin = resolve(configuredRoot, name);
        const before = await fs.lstat(descriptorOrigin);
        if (before.isSymbolicLink()) {
          throw loaderError("catalog_symlink", origin);
        }
        if (!before.isFile()) {
          throw loaderError("catalog_regular", origin);
        }
        const beforeSize = numericSize(before, origin);
        if (beforeSize > TEAM_LIMITS.manifestBytes) {
          throw loaderError(
            "catalog_file_bytes",
            `${origin} exceeds ${TEAM_LIMITS.manifestBytes} bytes`,
          );
        }

        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        const handle = await fs.open(descriptorOrigin, flags);
        try {
          const after = await handle.stat();
          if (!after.isFile()) {
            throw loaderError("catalog_regular", origin);
          }
          if (!sameIdentity(before, after)) {
            throw loaderError("catalog_identity", origin);
          }
          const afterSize = numericSize(after, origin);
          if (afterSize > TEAM_LIMITS.manifestBytes) {
            throw loaderError(
              "catalog_file_bytes",
              `${origin} exceeds ${TEAM_LIMITS.manifestBytes} bytes`,
            );
          }

          const descriptorRootReal = await fs.realpath(descriptorRoot);
          const descriptorOriginReal = await fs.realpath(descriptorOrigin);
          if (!isContained(descriptorRootReal, descriptorOriginReal)) {
            throw loaderError(
              "catalog_escape",
              `${origin} resolves outside its admitted root descriptor`,
            );
          }

          if (aggregateBytes + afterSize > TEAM_LIMITS.catalogBytes) {
            throw loaderError(
              "catalog_bytes",
              `${source} catalog exceeds ${TEAM_LIMITS.catalogBytes} bytes`,
            );
          }
          const bytes = await readBounded(handle, origin, aggregateBytes);
          aggregateBytes += bytes.byteLength;

          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw loaderError("catalog_utf8", origin);
          }
          const definition = parseTeamManifest(text, origin);
          entries.push({
            ref: `${source}/${definition.metadata.name}`,
            source,
            origin,
            definition,
          });
        } finally {
          await handle.close();
        }
      }
    } finally {
      await rootHandle.close();
    }
  }

  return createTeamCatalog(entries);
}
