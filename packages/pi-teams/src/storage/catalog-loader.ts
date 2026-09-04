import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  stat(): Promise<CatalogStats>;
  readFile(): Promise<Uint8Array>;
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

export async function loadTeamCatalog(
  input: LoadTeamCatalogInput,
): Promise<TeamCatalog> {
  const fs = input.fs ?? nodeFs;
  const entries: CatalogEntry[] = [];
  let fileCount = 0;
  let aggregateBytes = 0;
  const sources: Array<[TeamNamespace, string]> = [
    ["builtin", input.builtinsDir],
    ["user", input.userDir],
  ];
  if (input.projectTrusted) {
    sources.push(["project", input.projectDir]);
  }

  for (const [source, configuredRoot] of sources) {
    const rootStat = await fs.lstat(configuredRoot);
    if (rootStat.isSymbolicLink()) {
      throw loaderError("catalog_root_symlink", configuredRoot);
    }
    if (!rootStat.isDirectory()) {
      throw loaderError("catalog_root_regular", configuredRoot);
    }
    const root = await fs.realpath(configuredRoot);
    const names = (await fs.readdir(root))
      .filter((name) => name.endsWith(".yaml"))
      .sort();

    fileCount += names.length;
    if (fileCount > TEAM_LIMITS.catalogFiles) {
      throw loaderError(
        "catalog_files",
        `catalog contains more than ${TEAM_LIMITS.catalogFiles} YAML files`,
      );
    }

    for (const name of names) {
      const origin = resolve(root, name);
      const before = await fs.lstat(origin);
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
      const handle = await fs.open(origin, flags);
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

        const realOrigin = await fs.realpath(origin);
        if (!isContained(root, realOrigin)) {
          throw loaderError("catalog_escape", `${origin} resolves outside ${root}`);
        }

        if (aggregateBytes + afterSize > TEAM_LIMITS.catalogBytes) {
          throw loaderError(
            "catalog_bytes",
            `catalog exceeds ${TEAM_LIMITS.catalogBytes} bytes`,
          );
        }
        const bytes = await handle.readFile();
        if (bytes.byteLength > TEAM_LIMITS.manifestBytes) {
          throw loaderError(
            "catalog_file_bytes",
            `${origin} exceeds ${TEAM_LIMITS.manifestBytes} bytes`,
          );
        }
        if (aggregateBytes + bytes.byteLength > TEAM_LIMITS.catalogBytes) {
          throw loaderError(
            "catalog_bytes",
            `catalog exceeds ${TEAM_LIMITS.catalogBytes} bytes`,
          );
        }
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
  }

  return createTeamCatalog(entries);
}
