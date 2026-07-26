import { readFileSync, renameSync, writeFileSync } from "node:fs";

function parseJsonc(source) {
  let output = "";
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
        output += char;
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
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += char;
    }
  }
  let normalized = "";
  string = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (string) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      normalized += char;
      continue;
    }
    if (char === ",") {
      let following = index + 1;
      while (/\s/.test(output[following] || "")) following += 1;
      if (output[following] === "}" || output[following] === "]") continue;
    }
    normalized += char;
  }
  return JSON.parse(normalized);
}

function packageIdentity(spec) {
  const separator = spec.lastIndexOf("@");
  if (separator <= 0) throw new Error(`invalid Bun lock package identity: ${spec}`);
  return { name: spec.slice(0, separator), version: spec.slice(separator + 1) };
}

function purl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity, lockName) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || "");
  if (!match) throw new Error(`Bun lock package ${lockName} has no SHA-512 integrity`);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64) throw new Error(`Bun lock package ${lockName} has invalid SHA-512 integrity`);
  return bytes.toString("hex");
}

const sbomPath = process.argv[2] || "alloy.cdx.json";
const lockPath = process.argv[3] || "tui/bun.lock";
const parserManifestPath = process.argv[4] || "tui/assets/parsers/manifest.json";
const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
const lock = parseJsonc(readFileSync(lockPath, "utf8"));
const parserManifest = JSON.parse(readFileSync(parserManifestPath, "utf8"));
if (sbom.bomFormat !== "CycloneDX" || !sbom.specVersion) throw new Error("input SBOM must be CycloneDX");
const rootRef = sbom.metadata?.component?.["bom-ref"];
if (typeof rootRef !== "string" || !rootRef) throw new Error("input SBOM must identify its root component");

sbom.components ||= [];
const components = new Map(sbom.components.map((component) => [`${component.name}@${component.version}`, component]));
for (const [lockName, entry] of Object.entries(lock.packages || {})) {
  if (!Array.isArray(entry)) throw new Error(`Bun lock package ${lockName} has an invalid entry`);
  const { name, version } = packageIdentity(entry[0]);
  const hash = integrityHash(entry.at(-1), lockName);
  const key = `${name}@${version}`;
  const existing = components.get(key);
  if (existing) {
    existing.hashes ||= [];
    if (!existing.hashes.some((candidate) => candidate.alg === "SHA-512" && candidate.content === hash)) {
      existing.hashes.push({ alg: "SHA-512", content: hash });
    }
    continue;
  }
  const component = {
    type: "library",
    "bom-ref": purl(name, version),
    group: name.startsWith("@") ? name.split("/")[0] : undefined,
    name,
    version,
    hashes: [{ alg: "SHA-512", content: hash }],
    purl: purl(name, version),
    properties: [
      { name: "alloy:dependency-manager", value: "bun@1.3.14" },
      { name: "alloy:bun-lock-key", value: lockName },
    ],
  };
  if (component.group === undefined) delete component.group;
  sbom.components.push(component);
  components.set(key, component);
}

for (const [language, parser] of Object.entries(parserManifest.parsers || {})) {
  if (!/^[0-9a-f]{40}$/.test(parser.commit || "")) throw new Error(`syntax parser ${language} has no immutable commit`);
  const wasmHash = parser.assets?.["parser.wasm"];
  if (!/^[0-9a-f]{64}$/.test(wasmHash || "")) throw new Error(`syntax parser ${language} has no WASM SHA-256`);
  const name = `tree-sitter-${language}`;
  const parserPurl = `pkg:github/tree-sitter/${name}@v${parser.version}`;
  if (sbom.components.some((component) => component["bom-ref"] === parserPurl)) continue;
  sbom.components.push({
    type: "library",
    "bom-ref": parserPurl,
    group: "tree-sitter",
    name,
    version: parser.version,
    hashes: [{ alg: "SHA-256", content: wasmHash }],
    licenses: [{ license: { id: "MIT" } }],
    purl: parserPurl,
    externalReferences: [
      { type: "vcs", url: `${parser.repository}/tree/${parser.commit}` },
      { type: "distribution", url: parser.wasmUrl },
    ],
    properties: [
      { name: "alloy:bundled-asset", value: `tui/assets/parsers/${language}/parser.wasm` },
      { name: "alloy:release", value: parser.release },
      { name: "alloy:source-commit", value: parser.commit },
      { name: "alloy:license-sha256", value: parser.assets.LICENSE },
      { name: "alloy:highlight-query-sha256", value: parser.assets["highlights.scm"] },
    ],
  });
}

sbom.dependencies ||= [];
let rootDependency = sbom.dependencies.find((dependency) => dependency.ref === rootRef);
if (!rootDependency) {
  rootDependency = { ref: rootRef, dependsOn: [] };
  sbom.dependencies.push(rootDependency);
}
rootDependency.dependsOn ||= [];
for (const [language, parser] of Object.entries(parserManifest.parsers || {})) {
  const ref = `pkg:github/tree-sitter/tree-sitter-${language}@v${parser.version}`;
  if (!rootDependency.dependsOn.includes(ref)) rootDependency.dependsOn.push(ref);
}
rootDependency.dependsOn.sort();

for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"]) {
  if (!sbom.components.some((component) => component.name === name && component.hashes?.some((hash) => hash.alg === "SHA-512"))) {
    throw new Error(`merged SBOM is missing integrity-bearing ${name}`);
  }
}
for (const language of Object.keys(parserManifest.parsers || {})) {
  if (!sbom.components.some((component) => component.name === `tree-sitter-${language}` && component.hashes?.some((hash) => hash.alg === "SHA-256"))) {
    throw new Error(`merged SBOM is missing integrity-bearing tree-sitter-${language}`);
  }
}

sbom.components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const temporary = `${sbomPath}.tmp.${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(sbom, null, 2)}\n`);
renameSync(temporary, sbomPath);
console.log(`Merged ${Object.keys(lock.packages || {}).length} Bun lock and ${Object.keys(parserManifest.parsers || {}).length} parser components into ${sbomPath}`);
