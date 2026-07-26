import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function fail(message) {
  console.error(`release verification failed: ${message}`);
  process.exitCode = 1;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lockPath = "npm-shrinkwrap.json";
const publishGate = process.argv.includes("--publish");
const sourceGate = process.argv.includes("--source");
const canonicalRepositoryPath = "/ccoussa717/alloy";
const piCodingAgentName = "@earendil-works/pi-coding-agent";
const piFork = pkg.alloy?.piFork;
let piForkReleaseTag;
let piForkShapeValid = true;

if (pkg.name !== "alloy-agent") fail("package name must be alloy-agent");
if (pkg.license !== "MIT") fail("package license must be MIT");
if (publishGate && pkg.private === true) {
  fail("package must not be private for publication");
}
if (sourceGate && pkg.private !== true) {
  fail("package must remain private for a source launch");
}
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
      repository.hostname !== "github.com" ||
      repositoryPath !== canonicalRepositoryPath ||
      homepage.hostname !== "github.com" ||
      homepage.pathname !== canonicalRepositoryPath ||
      bugs.hostname !== "github.com" ||
      bugs.pathname !== `${canonicalRepositoryPath}/issues`
    ) {
      fail("package URLs must point to the canonical Alloy repository");
    }
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
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`) {
  fail(`release tag must match package version v${pkg.version}`);
}
if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) {
  fail("npm publication must be public and provenance-enabled");
}
if (!existsSync(lockPath)) fail("npm-shrinkwrap.json is required in releases");

if (!piFork || typeof piFork !== "object" || Array.isArray(piFork)) {
  fail("alloy.piFork metadata is required");
  piForkShapeValid = false;
} else {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(piFork.version))) {
    fail("alloy.piFork.version must be an exact version");
    piForkShapeValid = false;
  }
  if (!/^[0-9a-f]{40}$/.test(String(piFork.commit))) {
    fail("alloy.piFork.commit must be a full Git commit SHA");
    piForkShapeValid = false;
  }
  if (!/^[0-9a-f]{64}$/.test(String(piFork.sha256))) {
    fail("alloy.piFork.sha256 must be a SHA-256 digest");
    piForkShapeValid = false;
  }
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(piFork.integrity));
  if (!integrityMatch || Buffer.from(integrityMatch[1], "base64").length !== 64) {
    fail("alloy.piFork.integrity must be an npm SHA-512 integrity value");
    piForkShapeValid = false;
  }
  let forkUrl;
  try {
    forkUrl = new URL(piFork.url);
  } catch {
    fail("alloy.piFork.url must be a valid URL");
    piForkShapeValid = false;
  }
  const expectedArtifact = `/earendil-works-pi-coding-agent-${piFork.version}.tgz`;
  const releasePathMatch = forkUrl?.pathname.match(
    /^\/ccoussa717\/pi\/releases\/download\/([^/]+)\/earendil-works-pi-coding-agent-[^/]+\.tgz$/,
  );
  if (
    forkUrl &&
    (forkUrl.origin !== "https://github.com" ||
      forkUrl.username ||
      forkUrl.password ||
      !releasePathMatch ||
      !forkUrl.pathname.endsWith(expectedArtifact))
  ) {
    fail("alloy.piFork.url must pin a release asset from ccoussa717/pi");
    piForkShapeValid = false;
  }
  if (releasePathMatch) {
    try {
      piForkReleaseTag = decodeURIComponent(releasePathMatch[1]);
    } catch {
      fail("alloy.piFork.url contains an invalid release tag encoding");
      piForkShapeValid = false;
    }
  }
  if (pkg.dependencies?.[piCodingAgentName] !== piFork.url) {
    fail("the coding-agent dependency must match alloy.piFork.url");
    piForkShapeValid = false;
  }
}

async function verifyPiForkProvenance() {
  if (!piForkShapeValid || !piForkReleaseTag) return;
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "alloy-release-verifier",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
  try {
    let reference = await fetch(
      `https://api.github.com/repos/ccoussa717/pi/git/ref/tags/${encodeURIComponent(piForkReleaseTag)}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (!reference.ok) {
      fail(`could not resolve Pi fork release tag ${piForkReleaseTag}: HTTP ${reference.status}`);
      return;
    }
    let object = (await reference.json())?.object;
    for (let depth = 0; object?.type === "tag" && depth < 3; depth += 1) {
      reference = await fetch(`https://api.github.com/repos/ccoussa717/pi/git/tags/${object.sha}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!reference.ok) {
        fail(`could not resolve annotated Pi fork tag ${piForkReleaseTag}: HTTP ${reference.status}`);
        return;
      }
      object = (await reference.json())?.object;
    }
    if (object?.type !== "commit" || object.sha !== piFork.commit) {
      fail(`Pi fork release tag ${piForkReleaseTag} must resolve to commit ${piFork.commit}`);
    }

    const artifactResponse = await fetch(piFork.url, {
      headers: { "User-Agent": "alloy-release-verifier" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!artifactResponse.ok) {
      fail(`could not download Pi fork artifact: HTTP ${artifactResponse.status}`);
      return;
    }
    if (!artifactResponse.body) {
      fail("downloaded Pi fork artifact has no response body");
      return;
    }
    const maxArtifactBytes = 64 * 1024 * 1024;
    const sha256Hash = createHash("sha256");
    const sha512Hash = createHash("sha512");
    const reader = artifactResponse.body.getReader();
    let artifactBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      artifactBytes += value.byteLength;
      if (artifactBytes > maxArtifactBytes) {
        await reader.cancel();
        fail(`Pi fork artifact exceeds ${maxArtifactBytes} bytes`);
        return;
      }
      sha256Hash.update(value);
      sha512Hash.update(value);
    }
    const sha256 = sha256Hash.digest("hex");
    const integrity = `sha512-${sha512Hash.digest("base64")}`;
    if (sha256 !== piFork.sha256) fail("downloaded Pi fork artifact does not match alloy.piFork.sha256");
    if (integrity !== piFork.integrity) {
      fail("downloaded Pi fork artifact does not match alloy.piFork.integrity");
    }
  } catch (error) {
    fail(`could not verify Pi fork provenance: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await verifyPiForkProvenance();

for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  if (name === piCodingAgentName && piFork && version === piFork.url) continue;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    fail(`dependency ${name} must use an exact version, found ${version}`);
  }
}

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.lockfileVersion !== 3) fail("npm-shrinkwrap.json must use lockfileVersion 3");
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
    const isPinnedPiFork =
      path === `node_modules/${piCodingAgentName}` && piFork && entry?.resolved === piFork.url;
    if (
      !isPinnedPiFork &&
      (resolved.origin !== "https://registry.npmjs.org" || resolved.username || resolved.password)
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
    const entry = lock.packages?.[`node_modules/${name}`];
    const expectedVersion = name === piCodingAgentName && piFork ? piFork.version : version;
    if (entry?.version !== expectedVersion) {
      fail(`direct dependency ${name} must resolve to ${expectedVersion}`);
    }
    if (name === piCodingAgentName && piFork) {
      if (entry?.resolved !== piFork.url) {
        fail("the coding-agent shrinkwrap resolution must match alloy.piFork.url");
      }
      if (entry?.integrity !== piFork.integrity) {
        fail("the coding-agent shrinkwrap integrity must match alloy.piFork.integrity");
      }
    }
  }
  const piVersions = new Set();
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (/node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(path)) {
      piVersions.add(entry.version);
    }
  }
  const expectedPiVersion = piFork?.version || pkg.dependencies[piCodingAgentName];
  if (piVersions.size !== 1 || !piVersions.has(expectedPiVersion)) {
    fail(`Pi package family must resolve to one version, found ${[...piVersions].join(", ")}`);
  }
}

if (!process.exitCode) console.log("release metadata verified");
