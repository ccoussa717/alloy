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
const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
const lock = parseJsonc(readFileSync(lockPath, "utf8"));
if (sbom.bomFormat !== "CycloneDX" || !sbom.specVersion) throw new Error("input SBOM must be CycloneDX");

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

for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"]) {
  if (!sbom.components.some((component) => component.name === name && component.hashes?.some((hash) => hash.alg === "SHA-512"))) {
    throw new Error(`merged SBOM is missing integrity-bearing ${name}`);
  }
}

sbom.components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const temporary = `${sbomPath}.tmp.${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(sbom, null, 2)}\n`);
renameSync(temporary, sbomPath);
console.log(`Merged ${Object.keys(lock.packages || {}).length} Bun lock components into ${sbomPath}`);
