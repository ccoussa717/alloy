import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED = {
  bun: "1.3.14",
  dependencies: {
    "@opentui/core": "0.4.5",
    "@opentui/keymap": "0.4.5",
    "@opentui/solid": "0.4.5",
    "solid-js": "1.9.12",
  },
  devDependencies: {
    "@tsconfig/bun": "1.0.9",
    "@types/bun": "1.3.14",
    "@typescript/native-preview": "7.0.0-dev.20251207.1",
  },
  overrides: {
    "@babel/core": "7.29.7",
    minimatch: "10.2.5",
  },
  securityResolutions: {
    "@babel/core": "7.29.7",
    "brace-expansion": "5.0.8",
    minimatch: "10.2.5",
    seroval: "1.5.6",
    "seroval-plugins": "1.5.6",
    "solid-js": "1.9.12",
  },
  patchPath: "tui/patches/solid-js@1.9.10.patch",
  patchSha256: "34263e60a6b7d5c3016b53227037d14dd5a50e87611739529246b1440ce803da",
  openCodeCommit: "49c69c5ed3ccf706b61b3febb43c8aaff7f8325e",
  openTuiCommit: "0c8c4f7cff2927e3df63a9757a45eff9a343611c",
};
const REQUIRED_PACKED_FILES = [
  "tui/LICENSE.opencode",
  "tui/THIRD_PARTY_NOTICES.md",
  "tui/UPSTREAM.md",
  "tui/bun.lock",
  "tui/bunfig.toml",
  "tui/package.json",
  EXPECTED.patchPath,
  "tui/src/index.tsx",
  "scripts/merge-tui-sbom.mjs",
  "scripts/verify-tui-release.mjs",
];
const SOLID_RUNTIME_FILES = ["dev.cjs", "dev.js", "solid.cjs", "solid.js"];
const PATCH_MARKER = "if (!Transition.sources.has(node)) node.value = nextValue;";
let failed = false;

function fail(message) {
  failed = true;
  console.error(`TUI release verification failed: ${message}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${name} requires a path`);
    return undefined;
  }
  return value;
}

function parseJsonc(source, label) {
  let stripped = "";
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        stripped += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (string) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      stripped += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      stripped += char;
    }
  }
  let withoutTrailingCommas = "";
  string = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (string) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(stripped[next] || "")) next += 1;
      if (stripped[next] === "}" || stripped[next] === "]") continue;
    }
    withoutTrailingCommas += char;
  }
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (error) {
    fail(`${label} is not valid JSONC: ${error.message}`);
    return {};
  }
}

function readRequiredFile(root, relative, label = relative) {
  const path = join(root, relative);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      fail(`${label} must not be a symlink`);
      return "";
    }
    if (!stat.isFile()) {
      fail(`${label} must be a regular file`);
      return "";
    }
    return readFileSync(path, "utf8");
  } catch {
    fail(`${label} is required`);
    return "";
  }
}

function exactMap(actual, expected, label) {
  const actualEntries = Object.entries(actual || {}).sort();
  const expectedEntries = Object.entries(expected).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    fail(`${label} must contain every exact dependency pin: ${JSON.stringify(expected)}`);
  }
}

function validIntegrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value || "");
  return Boolean(match && Buffer.from(match[1], "base64").length === 64);
}

function inspectPackReport(report) {
  const files = report?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail("complete npm pack file list is required");
    return;
  }
  const paths = new Set();
  for (const file of files) {
    const path = file?.path;
    if (typeof path !== "string" || !path) {
      fail("every npm pack file entry must have a path");
      continue;
    }
    const parts = path.split("/");
    if (isAbsolute(path) || path.includes("\\") || parts.some((part) => part === ".." || part === ".")) {
      fail(`unsafe npm pack file path: ${path}`);
    }
    if (parts.includes("node_modules")) fail(`packed node_modules entry is forbidden: ${path}`);
    paths.add(path);
  }
  for (const required of REQUIRED_PACKED_FILES) {
    if (!paths.has(required)) fail(`npm pack file list is missing ${required}`);
  }
}

function inspectPackList(packJson) {
  try {
    inspectPackReport(JSON.parse(readFileSync(packJson, "utf8")));
  } catch (error) {
    fail(`could not read complete npm pack file list: ${error.message}`);
  }
}

const root = process.cwd();
const packedRoot = option("--packed-root");
const installedTui = option("--installed-tui");
let packJson = option("--pack-json");
if (!packJson) {
  const packed = spawnSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    fail(`npm pack dry run failed: ${packed.stderr || packed.stdout}`);
  } else {
    try {
      inspectPackReport(JSON.parse(packed.stdout));
    } catch (error) {
      fail(`npm pack did not return JSON: ${error.message}`);
    }
  }
} else {
  inspectPackList(packJson);
}

const pkg = parseJsonc(readRequiredFile(root, "package.json"), "package.json");
const tuiPkg = parseJsonc(readRequiredFile(root, "tui/package.json"), "tui/package.json");
const lock = parseJsonc(readRequiredFile(root, "tui/bun.lock"), "tui/bun.lock");

if (pkg.private !== true) fail("root package must remain private");
if (!String(pkg.scripts?.prepublishOnly || "").includes("process.exit(1)")) {
  fail("prepublishOnly must block npm publication");
}
if (pkg.alloy?.tuiRelease?.npmPublication !== "blocked") fail("npm publication must be documented as blocked");
if (pkg.alloy?.tuiRelease?.packageConsumerInteractiveInstall !== "unsupported") {
  fail("package-consumer interactive install must be documented as unsupported");
}
if (pkg.alloy?.tuiRelease?.solidTransitionPatchSha256 !== EXPECTED.patchSha256) {
  fail("package metadata must pin the upstreamed Solid transition patch SHA-256");
}
if (tuiPkg.private !== true) fail("TUI package must remain private");
if (tuiPkg.version !== pkg.version) fail("root and TUI package versions must match");
if (tuiPkg.packageManager !== `bun@${EXPECTED.bun}`) fail(`TUI packageManager must be bun@${EXPECTED.bun}`);
exactMap(tuiPkg.dependencies, EXPECTED.dependencies, "TUI dependencies");
exactMap(tuiPkg.devDependencies, EXPECTED.devDependencies, "TUI devDependencies");
exactMap(tuiPkg.overrides, EXPECTED.overrides, "TUI security overrides");
if (tuiPkg.patchedDependencies !== undefined) fail("Solid 1.9.12 must use its upstream transition fix without a local patch");

const workspace = lock.workspaces?.[""];
if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || !workspace) {
  fail("tui/bun.lock must contain Bun lockfile/config version 1 and the root workspace");
}
exactMap(workspace?.dependencies, EXPECTED.dependencies, "Bun lock dependencies");
exactMap(workspace?.devDependencies, EXPECTED.devDependencies, "Bun lock devDependencies");
exactMap(lock.overrides, EXPECTED.overrides, "Bun lock security overrides");
if (lock.patchedDependencies !== undefined) fail("Bun lock must not apply the superseded Solid 1.9.10 patch");
const lockPackages = lock.packages;
if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)) {
  fail("Bun lock packages must be an object");
}
const lockedIdentities = new Set();
for (const [name, entry] of Object.entries(lockPackages || {})) {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || !validIntegrity(entry.at(-1))) {
    fail(`every Bun lock package must include SHA-512 integrity: ${name}`);
  } else {
    lockedIdentities.add(entry[0]);
  }
}
for (const [name, version] of Object.entries({ ...EXPECTED.dependencies, ...EXPECTED.devDependencies })) {
  if (!lockedIdentities.has(`${name}@${version}`)) fail(`Bun lock is missing pinned package ${name}@${version}`);
}
for (const [name, version] of Object.entries(EXPECTED.securityResolutions)) {
  if (!lockedIdentities.has(`${name}@${version}`)) fail(`Bun lock is missing security resolution ${name}@${version}`);
}

const patch = readRequiredFile(root, EXPECTED.patchPath, "OpenCode Solid patch");
const patchHash = createHash("sha256").update(patch).digest("hex");
if (patchHash !== EXPECTED.patchSha256) fail(`OpenCode Solid patch hash changed: ${patchHash}`);
if ((patch.match(new RegExp(PATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length !== 4) {
  fail("OpenCode Solid patch content must patch all four Solid runtimes");
}

const license = readRequiredFile(root, "tui/LICENSE.opencode", "OpenCode license notice");
const notices = readRequiredFile(root, "tui/THIRD_PARTY_NOTICES.md", "TUI third-party notices");
const upstream = readRequiredFile(root, "tui/UPSTREAM.md", "TUI upstream provenance");
if (!license.includes("MIT License") || !license.includes("Copyright (c) 2025 opencode")) {
  fail("OpenCode license notice content is incomplete");
}
for (const required of ["OpenCode 1.18.4", "OpenTUI 0.4.5", "SolidJS 1.9.12", EXPECTED.openCodeCommit, EXPECTED.openTuiCommit]) {
  if (!notices.includes(required)) fail(`TUI third-party notices are missing ${required}`);
}
for (const required of [EXPECTED.openCodeCommit, EXPECTED.openTuiCommit, "solid-js`: 1.9.12 with OpenCode's transition fix upstreamed"]) {
  if (!upstream.includes(required)) fail(`TUI upstream provenance is missing ${required}`);
}

if (packedRoot) {
  for (const required of REQUIRED_PACKED_FILES) readRequiredFile(packedRoot, required, `packed ${required}`);
}
if (installedTui) {
  for (const [name, version] of Object.entries(EXPECTED.securityResolutions)) {
    const manifest = parseJsonc(
      readRequiredFile(installedTui, `${name}/package.json`, `installed ${name} manifest`),
      `installed ${name} manifest`,
    );
    if (manifest.version !== version) fail(`installed ${name} must resolve to ${version}`);
  }
  for (const file of SOLID_RUNTIME_FILES) {
    const content = readRequiredFile(installedTui, `solid-js/dist/${file}`, `installed Solid runtime ${file}`);
    if (!content.includes(PATCH_MARKER)) fail(`upstreamed Solid transition fix is missing from ${file}`);
  }
}

if (failed) process.exit(1);
console.log("TUI release metadata, lock, packed files, notices, provenance, and transition fix verified");
