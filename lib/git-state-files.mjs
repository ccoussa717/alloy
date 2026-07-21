/**
 * Lexical containment and lstat checks reject observed escapes, symlink
 * ancestors, and collisions. They do not make path validation and later
 * filesystem use atomic against a malicious same-UID racer. A native
 * descriptor-relative openat helper would be separate future hardening.
 */
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export function containedPath(root, rel) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, rel);
  const fromRoot = relative(rootPath, path);
  if (
    !rel ||
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Path escapes root: ${rel}`);
  }
  return { rootPath, path, fromRoot };
}

function ancestorPaths(rootPath, fromRoot) {
  const parts = fromRoot.split(sep);
  return parts.slice(0, -1).map((_, index) =>
    resolve(rootPath, ...parts.slice(0, index + 1)),
  );
}

export function inspectSource(root, rel) {
  const resolved = containedPath(root, rel);
  for (const ancestor of ancestorPaths(resolved.rootPath, resolved.fromRoot)) {
    const stat = lstatIfPresent(ancestor);
    if (!stat) throw new Error(`Missing source ancestor: ${rel}`);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink ancestor: ${rel}`);
    if (!stat.isDirectory()) throw new Error(`Invalid source ancestor: ${rel}`);
  }
  const stat = lstatIfPresent(resolved.path);
  if (!stat) throw new Error(`Missing source: ${rel}`);
  if (stat.isDirectory()) throw new Error(`Refusing recursive source: ${rel}`);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Unsupported source type: ${rel}`);
  }
  return { ...resolved, stat };
}

export function inspectDestination(root, rel) {
  const resolved = containedPath(root, rel);
  for (const ancestor of ancestorPaths(resolved.rootPath, resolved.fromRoot)) {
    const stat = lstatIfPresent(ancestor);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Destination symlink ancestor: ${rel}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Invalid destination ancestor: ${rel}`);
    }
  }
  if (lstatIfPresent(resolved.path)) {
    throw new Error(`Destination collision: ${rel}`);
  }
  return resolved;
}

export function createSafeParents(root, rel, mode = 0o700) {
  const resolved = containedPath(root, rel);
  for (const ancestor of ancestorPaths(resolved.rootPath, resolved.fromRoot)) {
    const stat = lstatIfPresent(ancestor);
    if (!stat) {
      try {
        mkdirSync(ancestor, { mode });
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    const created = lstatIfPresent(ancestor);
    if (created?.isSymbolicLink()) {
      throw new Error(`Destination symlink ancestor: ${rel}`);
    }
    if (!created?.isDirectory()) {
      throw new Error(`Invalid destination ancestor: ${rel}`);
    }
  }
  return resolved.path;
}

export function copyEnumeratedPaths(sourceRoot, destinationRoot, paths) {
  const copied = [];
  const failed = [];
  for (const rel of paths) {
    try {
      const source = inspectSource(sourceRoot, rel);
      inspectDestination(destinationRoot, rel);
      const destination = createSafeParents(destinationRoot, rel);
      if (source.stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(source.path), destination);
      } else {
        copyFileSync(source.path, destination, constants.COPYFILE_EXCL);
      }
      copied.push(rel);
    } catch (err) {
      failed.push({ path: rel, error: String(err?.message || err) });
    }
  }
  return { copied, failed };
}

export function fingerprintEnumeratedPaths(root, paths) {
  return paths.map((rel) => {
    const source = inspectSource(root, rel);
    return {
      path: rel,
      mode: source.stat.mode & 0o777,
      type: source.stat.isSymbolicLink() ? "symlink" : "file",
      value: source.stat.isSymbolicLink()
        ? readlinkSync(source.path)
        : createHash("sha256").update(readFileSync(source.path)).digest("hex"),
    };
  });
}
