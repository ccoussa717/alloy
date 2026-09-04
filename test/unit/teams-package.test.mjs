import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = join(rootDir, "packages/pi-teams");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function filesUnder(path) {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("portable teams package declares its exact host-neutral package contract", () => {
  const root = readJson(join(rootDir, "package.json"));
  const portable = readJson(join(packageDir, "package.json"));

  assert.equal(portable.name, "@alloy/pi-teams");
  assert.equal(portable.version, "0.1.0");
  assert.equal(portable.description, "Portable read-only team orchestration for Pi");
  assert.equal(portable.type, "module");
  assert.equal(portable.private, true);
  assert.deepEqual(portable.files, ["src", "README.md"]);
  assert.deepEqual(portable.exports, {
    ".": "./src/index.ts",
    "./extension": "./src/extension/index.ts",
  });
  assert.deepEqual(portable.pi.extensions, ["./src/extension/index.ts"]);
  assert.equal(portable.engines.node, ">=22.19.0");
  assert.equal(portable.dependencies.yaml, "2.9.0");
  assert.equal(
    portable.peerDependencies["@earendil-works/pi-coding-agent"],
    ">=0.82.1 <0.85.0",
  );
  assert.equal(portable.peerDependencies.typebox, ">=1.1.38 <2");

  assert.ok(root.files.includes("packages/pi-teams"));
  assert.equal(root.dependencies.yaml, "2.9.0");
  assert.equal(root.devDependencies.typescript, "5.9.3");
  assert.equal(
    root.scripts["typecheck:teams"],
    "tsc -p packages/pi-teams/tsconfig.json",
  );
});

test("portable core stays host-neutral and the public barrel is incremental", () => {
  const coreDir = join(packageDir, "src/core");
  for (const path of filesUnder(coreDir)) {
    const source = readFileSync(path, "utf8");
    const name = relative(rootDir, path);
    assert.doesNotMatch(source, /@earendil-works\/pi-coding-agent/, name);
    assert.doesNotMatch(source, /\/lib\//, name);
    assert.doesNotMatch(source, /lib\/teams-host/, name);
  }

  const designated = [
    "./core/types.ts",
    "./core/limits.ts",
    "./core/service.ts",
    "./adapters/stock-pi.ts",
    "./extension/index.ts",
  ];
  const expected = designated.filter((target) =>
    existsSync(join(packageDir, "src", target)),
  );
  const barrel = readFileSync(join(packageDir, "src/index.ts"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^export (?:\*|\{[^}]+\}) from "([^"]+)";$/.exec(line);
      assert.ok(match, `unexpected barrel line: ${line}`);
      return match[1];
    });

  assert.deepEqual(barrel, expected);
  for (const target of barrel) {
    assert.ok(existsSync(join(packageDir, "src", target)), target);
  }
});

test("portable limits enforce identifiers and inclusive bounded UTF-8 text", async () => {
  const limits = await import(
    pathToFileURL(join(packageDir, "src/core/limits.ts")).href
  );

  assert.deepEqual(limits.TEAM_LIMITS, {
    manifestBytes: 65_536,
    yamlNodes: 512,
    yamlDepth: 12,
    aliases: 0,
    documents: 1,
    catalogFiles: 32,
    catalogBytes: 1_048_576,
    members: 5,
    concurrency: 3,
    costUsd: 2,
    timeoutMs: 300_000,
    containmentTimeoutMs: 5_000,
    objectiveBytes: 16_384,
    descriptionBytes: 1_024,
    instructionBytes: 8_192,
    outputBytes: 1_048_576,
    resultBytes: 65_536,
    eventLineBytes: 65_536,
  });
  assert.ok(Object.isFrozen(limits.TEAM_LIMITS));
  assert.equal(limits.ZERO_HASH, "0".repeat(64));

  assert.doesNotThrow(() => limits.assertBoundedUtf8("é", "objective", 2));
  assert.throws(() => limits.assertBoundedUtf8("é", "objective", 1));
  assert.throws(() => limits.assertBoundedUtf8("   ", "objective", 3));
  assert.throws(() => limits.assertBoundedUtf8("\ud800", "objective", 3));
  assert.throws(() => limits.assertBoundedUtf8(42, "objective", 2));

  assert.doesNotThrow(() => limits.assertIdentifier("member-1", "member"));
  assert.throws(() => limits.assertIdentifier("Member_1", "member"));
});
