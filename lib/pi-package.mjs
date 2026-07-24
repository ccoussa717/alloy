import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

function packageParts(packageName) {
  return packageName.split("/").filter(Boolean);
}

function packageIdentityMatches(root, packageName) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.name === packageName;
  } catch {
    return false;
  }
}

/**
 * Resolve a package from one or more module roots using Node's upward
 * node_modules lookup shape. This works for nested and npm-hoisted installs
 * without relying on package export maps.
 */
export function findPackageRoot(packageName, starts = [process.cwd()]) {
  const suffix = packageParts(packageName);
  const visited = new Set();

  for (const start of starts.filter(Boolean)) {
    let current = resolve(start);
    const filesystemRoot = parse(current).root;
    while (!visited.has(current)) {
      visited.add(current);
      const candidate = join(current, "node_modules", ...suffix);
      if (existsSync(candidate) && packageIdentityMatches(candidate, packageName)) {
        try {
          return realpathSync(candidate);
        } catch {
          return candidate;
        }
      }
      if (current === filesystemRoot) break;
      current = dirname(current);
    }
  }
  return null;
}

export function readPackageVersion(packageRoot) {
  if (!packageRoot) return null;
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function findPiCli(starts = [process.cwd()]) {
  return findPiRuntime(starts)?.cli || null;
}

export function piRuntimeFromCli(cli) {
  if (!cli) return null;
  let resolvedCli;
  try {
    resolvedCli = realpathSync(cli);
  } catch {
    return null;
  }
  const packageRoot = dirname(dirname(resolvedCli));
  if (!packageIdentityMatches(packageRoot, "@earendil-works/pi-coding-agent")) {
    return null;
  }
  const nodeModulesRoot = dirname(dirname(packageRoot));
  if (
    resolve(packageRoot) !==
    resolve(nodeModulesRoot, "@earendil-works", "pi-coding-agent")
  ) {
    return null;
  }
  return { packageRoot, cli: resolvedCli, nodeModulesRoot };
}

export function findPiRuntime(starts = [process.cwd()]) {
  const root = findPackageRoot("@earendil-works/pi-coding-agent", starts);
  if (!root) return null;
  const cli = join(root, "dist", "cli.js");
  return piRuntimeFromCli(cli);
}
