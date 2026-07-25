import { readFileSync, writeFileSync } from "node:fs";

const path = "npm-shrinkwrap.json";
const sourcePath = process.argv[2] || path;
const lock = JSON.parse(readFileSync(sourcePath, "utf8"));
if (sourcePath !== path) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const sourceDependencies = lock.packages?.[""]?.dependencies || {};
  if (
    JSON.stringify(Object.entries(sourceDependencies).sort()) !==
    JSON.stringify(Object.entries(pkg.dependencies || {}).sort())
  ) {
    throw new Error("imported lock root dependencies do not match package.json");
  }
  lock.name = pkg.name;
  lock.version = pkg.version;
  lock.packages[""] = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    dependencies: pkg.dependencies,
    bin: pkg.bin,
    engines: pkg.engines,
  };
}
const integrityByResolved = new Map();

for (const entry of Object.values(lock.packages || {})) {
  if (entry?.resolved && entry.integrity) {
    integrityByResolved.set(entry.resolved, entry.integrity);
  }
}

let changed = 0;
const unresolved = [];
for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
  if (!entry?.resolved?.startsWith("https://registry.npmjs.org/") || entry.integrity) {
    continue;
  }
  const integrity = integrityByResolved.get(entry.resolved);
  if (!integrity) {
    unresolved.push(packagePath);
    continue;
  }
  entry.integrity = integrity;
  changed++;
}

if (unresolved.length) {
  console.error(
    `cannot normalize integrity for: ${unresolved.join(", ")}`,
  );
  process.exit(1);
}

if (changed || sourcePath !== path) {
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o644 });
}
console.log(`normalized ${changed} shrinkwrap integrity entr${changed === 1 ? "y" : "ies"}`);
