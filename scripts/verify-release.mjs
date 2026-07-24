import { existsSync, readFileSync } from "node:fs";

function fail(message) {
  console.error(`release verification failed: ${message}`);
  process.exitCode = 1;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lockPath = "npm-shrinkwrap.json";
const publishGate = process.argv.includes("--publish");

if (pkg.name !== "alloy-agent") fail("package name must be alloy-agent");
if (pkg.license !== "MIT") fail("package license must be MIT");
const repositoryUrl =
  typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
const bugsUrl = typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url;
const hasAnyMetadata = Boolean(repositoryUrl || pkg.homepage || bugsUrl);

function publicUrl(label, value, protocols) {
  if (!value || typeof value !== "string") {
    fail(`${label} is required for publication`);
    return null;
  }
  if (/[<>]|\b(?:tbd|todo)\b/i.test(value)) {
    fail(`${label} contains a placeholder`);
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a valid public URL`);
    return null;
  }
  if (!protocols.includes(url.protocol)) {
    fail(`${label} must use ${protocols.join(" or ")}`);
  }
  if (url.username || url.password) {
    fail(`${label} must not contain credentials`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "example.com" ||
    host.endsWith(".example.com")
  ) {
    fail(`${label} must not use a local or placeholder host`);
  }
  return url;
}

if (publishGate || hasAnyMetadata) {
  if (typeof pkg.repository !== "object" || pkg.repository?.type !== "git") {
    fail("repository must be an object with type git");
  }
  const repository = publicUrl(
    "repository.url",
    repositoryUrl,
    ["git+https:", "https:"],
  );
  const homepage = publicUrl("homepage", pkg.homepage, ["https:"]);
  const bugs = publicUrl("bugs.url", bugsUrl, ["https:"]);
  if (repository && homepage && bugs) {
    const repositoryPath = repository.pathname.replace(/\.git$/, "");
    if (
      homepage.hostname !== repository.hostname ||
      bugs.hostname !== repository.hostname ||
      !(
        homepage.pathname === repositoryPath ||
        homepage.pathname.startsWith(`${repositoryPath}/`)
      ) ||
      !(
        bugs.pathname === repositoryPath ||
        bugs.pathname.startsWith(`${repositoryPath}/`)
      )
    ) {
      fail("homepage and bugs URLs must belong to the canonical repository");
    }
  }
}
if (process.env.CI_COMMIT_TAG && process.env.CI_COMMIT_TAG !== `v${pkg.version}`) {
  fail(`release tag must match package version v${pkg.version}`);
}
if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) {
  fail("npm publication must be public and provenance-enabled");
}
if (!existsSync(lockPath)) fail("npm-shrinkwrap.json is required in releases");

for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    fail(`dependency ${name} must use an exact version, found ${version}`);
  }
}

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.name !== pkg.name || lock.version !== pkg.version) {
    fail("package and shrinkwrap identity must match");
  }
  const rootDependencies = lock.packages?.[""]?.dependencies || {};
  if (
    JSON.stringify(Object.entries(rootDependencies).sort()) !==
    JSON.stringify(Object.entries(pkg.dependencies || {}).sort())
  ) {
    fail("package and shrinkwrap root dependencies must match");
  }
  if (
    !lock.packages ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages)
  ) {
    fail("shrinkwrap packages must be an object");
  }
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (path === "") continue;
    let resolved;
    try {
      resolved = new URL(entry?.resolved);
    } catch {
      fail(`${path} must have a valid registry resolution URL`);
      continue;
    }
    if (
      resolved.origin !== "https://registry.npmjs.org" ||
      resolved.username ||
      resolved.password
    ) {
      fail(`${path} must resolve from the credential-free HTTPS npm registry`);
    }
    if (!entry?.integrity) {
      fail(`${path} must include integrity metadata`);
    } else {
      const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity);
      if (!match || Buffer.from(match[1], "base64").length !== 64) {
        fail(`${path} must include a valid SHA-512 integrity value`);
      }
    }
  }
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      fail(`direct dependency ${name} must resolve to ${version}`);
    }
  }
  const piVersions = new Set();
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (/node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(path)) {
      piVersions.add(entry.version);
    }
  }
  if (piVersions.size !== 1 || !piVersions.has(pkg.dependencies["@earendil-works/pi-coding-agent"])) {
    fail(`Pi package family must resolve to one version, found ${[...piVersions].join(", ")}`);
  }
}

if (!process.exitCode) console.log("release metadata verified");
