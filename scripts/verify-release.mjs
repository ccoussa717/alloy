import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`release verification failed: ${message}`);
  process.exitCode = 1;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const tuiPkg = JSON.parse(readFileSync("tui/package.json", "utf8"));
const lockPath = "npm-shrinkwrap.json";
const publishGate = process.argv.includes("--publish");
const sourceGate = process.argv.includes("--source");
const canonicalRepositoryPath = "/ccoussa717/alloy";
const piCodingAgentName = "@earendil-works/pi-coding-agent";
const piAiName = "@earendil-works/pi-ai";
const piTuiName = "@earendil-works/pi-tui";
const swebenchWrapper = "scripts/run-swebench-release-smoke.sh";
const piFork = pkg.alloy?.piFork;
let piForkReleaseTag;
let piForkShapeValid = true;

if (pkg.name !== "alloy-agent") fail("package name must be alloy-agent");
if (pkg.license !== "MIT") fail("package license must be MIT");
if (tuiPkg.version !== pkg.version) {
  fail("tui/package.json version must match package.json");
}

function startsRegexLiteral(source, offset) {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  if (index < 0 || "([{:;,=!?&|+-*%^~<>".includes(source[index])) return true;

  const prefix = source.slice(0, offset);
  return /\b(?:await|case|delete|in|instanceof|new|of|return|throw|typeof|void|yield)\s*$/.test(
    prefix,
  );
}

function isCodeOffset(source, offset) {
  let state = "code";
  let regexCharacterClass = false;

  for (let index = 0; index < offset; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "regex") {
      if (character === "\\") {
        index += 1;
      } else if (character === "[") {
        regexCharacterClass = true;
      } else if (character === "]") {
        regexCharacterClass = false;
      } else if (character === "/" && !regexCharacterClass) {
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
      } else if (character === state) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "/" && startsRegexLiteral(source, index)) {
      state = "regex";
      regexCharacterClass = false;
    } else if (character === '"' || character === "'" || character === "`") {
      state = character;
    }
  }

  return state === "code";
}

const runtimeFallbacks = [
  {
    path: "extensions/ui.ts",
    pattern: /^[\t ]*const\s+VERSION\s*=\s*process\.env\.ALLOY_VERSION\s*\|\|\s*"([^"\r\n]+)"\s*;[\t ]*$/gm,
  },
  {
    path: "lib/child-runner.mjs",
    pattern: /^[\t ]*out\.ALLOY_VERSION\s*=\s*process\.env\.ALLOY_VERSION\s*\|\|\s*out\.ALLOY_VERSION\s*\|\|\s*"([^"\r\n]+)"\s*;[\t ]*$/gm,
  },
  {
    path: "lib/mcp-client.mjs",
    pattern: /^[\t ]*\{\s*name:\s*"alloy",\s*version:\s*process\.env\.ALLOY_VERSION\s*\|\|\s*"([^"\r\n]+)"\s*\},?[\t ]*$/gm,
  },
];

for (const { path, pattern } of runtimeFallbacks) {
  const source = readFileSync(path, "utf8");
  const matches = [...source.matchAll(pattern)].filter((match) => isCodeOffset(source, match.index));
  if (matches.length !== 1) {
    fail(`${path} must contain exactly one executable version fallback`);
  } else if (matches[0][1] !== pkg.version) {
    fail(`${path} version fallback must match package.json`);
  }
}
if (publishGate) fail("npm publication is blocked until package-consumer lifecycle design is explicit");
if (sourceGate && pkg.private !== true) {
  fail("package must remain private for a source launch");
}
function isBenchmarkTooling(path) {
  return path === "benchmarks" || path.startsWith("benchmarks/") || path === swebenchWrapper;
}

for (const path of pkg.files || []) {
  if (path === "." || isBenchmarkTooling(path)) {
    fail("benchmark tooling must not ship in the runtime package boundary");
  }
}

for (const [name, command] of Object.entries(pkg.scripts || {})) {
  if (
    /swebench/i.test(name) ||
    /swebench|scripts\/run-swebench-release-smoke\.sh/i.test(String(command))
  ) {
    fail("benchmark commands must not appear in package script metadata");
  }
}

function packedFilePaths() {
  const packed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (packed.error || packed.status !== 0) {
    fail("could not inspect the runtime package boundary with npm pack");
    return [];
  }
  try {
    const report = JSON.parse(packed.stdout);
    if (
      !Array.isArray(report) ||
      report.length !== 1 ||
      !Array.isArray(report[0]?.files) ||
      report[0].files.some((file) => typeof file?.path !== "string")
    ) {
      throw new Error("unexpected npm pack report shape");
    }
    return report[0].files.map((file) => file.path);
  } catch {
    fail("npm pack returned an invalid runtime package file list");
    return [];
  }
}

for (const path of packedFilePaths()) {
  if (isBenchmarkTooling(path)) {
    fail("benchmark tooling must not ship in the runtime package boundary");
  }
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
if (
  pkg.publishConfig &&
  (pkg.publishConfig.access !== "public" || pkg.publishConfig.provenance !== true)
) {
  fail("configured npm publication must be public and provenance-enabled");
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
}

const piForkArtifacts = [
  {
    dependency: piCodingAgentName,
    slug: "coding-agent",
    metadata: piFork,
    metadataPath: "alloy.piFork",
  },
  {
    dependency: piAiName,
    slug: "ai",
    metadata: piFork?.ai,
    metadataPath: "alloy.piFork.ai",
  },
  {
    dependency: piTuiName,
    slug: "tui",
    metadata: piFork?.tui,
    metadataPath: "alloy.piFork.tui",
  },
];
const piForkReleaseTags = new Set();

for (const artifact of piForkArtifacts) {
  const { dependency, slug, metadata, metadataPath } = artifact;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(`${metadataPath} metadata is required`);
    piForkShapeValid = false;
    continue;
  }
  if (!/^[0-9a-f]{64}$/.test(String(metadata.sha256))) {
    fail(`${metadataPath}.sha256 must be a SHA-256 digest`);
    piForkShapeValid = false;
  }
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(metadata.integrity));
  if (!integrityMatch || Buffer.from(integrityMatch[1], "base64").length !== 64) {
    fail(`${metadataPath}.integrity must be an npm SHA-512 integrity value`);
    piForkShapeValid = false;
  }
  let forkUrl;
  try {
    forkUrl = new URL(metadata.url);
  } catch {
    fail(`${metadataPath}.url must be a valid URL`);
    piForkShapeValid = false;
  }
  const expectedArtifact = `/earendil-works-pi-${slug}-${piFork?.version}.tgz`;
  const releasePathMatch = forkUrl?.pathname.match(
    new RegExp(`^/ccoussa717/pi/releases/download/([^/]+)/earendil-works-pi-${slug}-[^/]+\\.tgz$`),
  );
  if (
    forkUrl &&
    (forkUrl.origin !== "https://github.com" ||
      forkUrl.username ||
      forkUrl.password ||
      !releasePathMatch ||
      !forkUrl.pathname.endsWith(expectedArtifact))
  ) {
    fail(`${metadataPath}.url must pin a release asset from ccoussa717/pi`);
    piForkShapeValid = false;
  }
  if (releasePathMatch) {
    try {
      piForkReleaseTags.add(decodeURIComponent(releasePathMatch[1]));
    } catch {
      fail(`${metadataPath}.url contains an invalid release tag encoding`);
      piForkShapeValid = false;
    }
  }
  if (pkg.dependencies?.[dependency] !== metadata.url) {
    fail(`the ${slug} dependency must match ${metadataPath}.url`);
    piForkShapeValid = false;
  }
}

if (piForkReleaseTags.size === 1) {
  [piForkReleaseTag] = piForkReleaseTags;
} else if (piForkReleaseTags.size > 1) {
  fail("Pi fork artifacts must use the same release tag");
  piForkShapeValid = false;
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

    for (const { metadata, metadataPath } of piForkArtifacts) {
      const artifactResponse = await fetch(metadata.url, {
        headers: { "User-Agent": "alloy-release-verifier" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!artifactResponse.ok) {
        fail(`could not download ${metadataPath} artifact: HTTP ${artifactResponse.status}`);
        continue;
      }
      if (!artifactResponse.body) {
        fail(`downloaded ${metadataPath} artifact has no response body`);
        continue;
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
          fail(`${metadataPath} artifact exceeds ${maxArtifactBytes} bytes`);
          break;
        }
        sha256Hash.update(value);
        sha512Hash.update(value);
      }
      const sha256 = sha256Hash.digest("hex");
      const integrity = `sha512-${sha512Hash.digest("base64")}`;
      if (sha256 !== metadata.sha256) {
        fail(`downloaded Pi fork artifact does not match ${metadataPath}.sha256`);
      }
      if (integrity !== metadata.integrity) {
        fail(`downloaded Pi fork artifact does not match ${metadataPath}.integrity`);
      }
    }
  } catch (error) {
    fail(`could not verify Pi fork provenance: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await verifyPiForkProvenance();

for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  const forkArtifact = piForkArtifacts.find((artifact) => artifact.dependency === name);
  if (forkArtifact && version === forkArtifact.metadata?.url) continue;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
    fail(`dependency ${name} must use an exact version, found ${version}`);
  }
}

if (pkg.overrides?.["brace-expansion"] !== "5.0.9") {
  fail("brace-expansion must be overridden to patched version 5.0.9");
}

if (pkg.overrides?.undici !== "8.10.0") {
  fail("undici must be overridden to patched version 8.10.0");
}

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.lockfileVersion !== 3) fail("npm-shrinkwrap.json must use lockfileVersion 3");
  if (
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    lock.packages?.[""]?.name !== pkg.name ||
    lock.packages?.[""]?.version !== pkg.version
  ) {
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
    const forkArtifact = piForkArtifacts.find(
      (artifact) => path === `node_modules/${artifact.dependency}`,
    );
    const isPinnedPiFork = forkArtifact && entry?.resolved === forkArtifact.metadata?.url;
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
  const securityResolutions = {
    "brace-expansion": "5.0.9",
    "fast-uri": "3.1.5",
    hono: "4.13.2",
    "ip-address": "10.5.0",
    undici: "8.10.0",
  };
  for (const [name, version] of Object.entries(securityResolutions)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entries = Object.entries(lock.packages || {}).filter(([path]) =>
      new RegExp(`(?:^|/)node_modules/${escapedName}$`).test(path)
    );
    if (entries.length === 0 || entries.some(([, entry]) => entry?.version !== version)) {
      fail(`every installed ${name} node must resolve to patched version ${version}`);
    }
  }
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    const entry = lock.packages?.[`node_modules/${name}`];
    const forkArtifact = piForkArtifacts.find((artifact) => artifact.dependency === name);
    const expectedVersion = forkArtifact ? piFork?.version : version;
    if (entry?.version !== expectedVersion) {
      fail(`direct dependency ${name} must resolve to ${expectedVersion}`);
    }
    if (forkArtifact) {
      if (entry?.resolved !== forkArtifact.metadata?.url) {
        fail(`the ${forkArtifact.slug} shrinkwrap resolution must match ${forkArtifact.metadataPath}.url`);
      }
      if (entry?.integrity !== forkArtifact.metadata?.integrity) {
        fail(`the ${forkArtifact.slug} shrinkwrap integrity must match ${forkArtifact.metadataPath}.integrity`);
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
