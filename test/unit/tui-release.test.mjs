import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-tui-release-"));
const releaseGate = join(root, "scripts", "verify-tui-release.mjs");
const sbomMerger = join(root, "scripts", "merge-tui-sbom.mjs");
const requiredPackedFiles = [
  "tui/LICENSE.opencode",
  "tui/THIRD_PARTY_NOTICES.md",
  "tui/UPSTREAM.md",
  "tui/bun.lock",
  "tui/bunfig.toml",
  "tui/package.json",
  "tui/patches/solid-js@1.9.10.patch",
  "tui/src/index.tsx",
  "scripts/merge-tui-sbom.mjs",
  "scripts/verify-tui-release.mjs",
];

after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function fixture() {
  const directory = mkdtempSync(join(temp, "fixture-"));
  mkdirSync(join(directory, "tui", "patches"), { recursive: true });
  mkdirSync(join(directory, "tui", "src"), { recursive: true });
  mkdirSync(join(directory, "scripts"), { recursive: true });
  for (const path of [
    "package.json",
    "tui/package.json",
    "tui/bun.lock",
    "tui/bunfig.toml",
    "tui/LICENSE.opencode",
    "tui/THIRD_PARTY_NOTICES.md",
    "tui/UPSTREAM.md",
    "tui/patches/solid-js@1.9.10.patch",
    "scripts/merge-tui-sbom.mjs",
    "scripts/verify-tui-release.mjs",
  ]) {
    copyFileSync(join(root, path), join(directory, path));
  }
  writeFileSync(join(directory, "tui", "src", "index.tsx"), "export {};\n");
  const packJson = join(directory, "pack.json");
  writeFileSync(
    packJson,
    JSON.stringify([{ filename: "alloy-agent.tgz", files: requiredPackedFiles.map((path) => ({ path })) }]),
  );
  return { directory, packJson };
}

function verify(testCase, extraArgs = []) {
  return run(process.execPath, [releaseGate, "--pack-json", testCase.packJson, ...extraArgs], {
    cwd: testCase.directory,
  });
}

describe("TUI release gate", () => {
  it("accepts the exact pinned, noticed, provenance-bearing TUI source", () => {
    const testCase = fixture();
    const result = verify(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("rejects dependency ranges and missing Bun lock integrity", () => {
    const ranged = fixture();
    const packagePath = join(ranged.directory, "tui", "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.dependencies["@opentui/core"] = "^0.4.5";
    writeFileSync(packagePath, JSON.stringify(pkg));
    const rangedResult = verify(ranged);
    assert.notEqual(rangedResult.status, 0);
    assert.match(rangedResult.stderr, /exact dependency pin/i);

    const missingIntegrity = fixture();
    const lockPath = join(missingIntegrity.directory, "tui", "bun.lock");
    writeFileSync(
      lockPath,
      readFileSync(lockPath, "utf8").replace(/"sha512-[A-Za-z0-9+/]+={0,2}"/, '""'),
    );
    const integrityResult = verify(missingIntegrity);
    assert.notEqual(integrityResult.status, 0);
    assert.match(integrityResult.stderr, /every Bun lock package.*integrity/i);
  });

  it("rejects patch drift, symlinked notices, and packed node_modules", () => {
    const patchDrift = fixture();
    writeFileSync(
      join(patchDrift.directory, "tui", "patches", "solid-js@1.9.10.patch"),
      "not the OpenCode patch\n",
    );
    const patchResult = verify(patchDrift);
    assert.notEqual(patchResult.status, 0);
    assert.match(patchResult.stderr, /Solid patch.*hash|content/i);

    const symlinkedNotice = fixture();
    const notice = join(symlinkedNotice.directory, "tui", "THIRD_PARTY_NOTICES.md");
    rmSync(notice);
    symlinkSync(join(root, "tui", "THIRD_PARTY_NOTICES.md"), notice);
    const noticeResult = verify(symlinkedNotice);
    assert.notEqual(noticeResult.status, 0);
    assert.match(noticeResult.stderr, /must not be a symlink/i);

    const leaked = fixture();
    const pack = JSON.parse(readFileSync(leaked.packJson, "utf8"));
    pack[0].files.push({ path: "tui/node_modules/solid-js/package.json" });
    writeFileSync(leaked.packJson, JSON.stringify(pack));
    const leakedResult = verify(leaked);
    assert.notEqual(leakedResult.status, 0);
    assert.match(leakedResult.stderr, /packed node_modules/i);
  });

  it("verifies the upstreamed transition fix and security resolutions in the installed TUI", () => {
    const testCase = fixture();
    const installed = join(testCase.directory, "installed");
    for (const [name, version] of Object.entries({
      "@babel/core": "7.29.7",
      "brace-expansion": "5.0.8",
      minimatch: "10.2.5",
      seroval: "1.5.6",
      "seroval-plugins": "1.5.6",
      "solid-js": "1.9.12",
    })) {
      mkdirSync(join(installed, name), { recursive: true });
      writeFileSync(join(installed, name, "package.json"), JSON.stringify({ name, version }));
    }
    for (const file of ["dev.cjs", "dev.js", "solid.cjs", "solid.js"]) {
      mkdirSync(join(installed, "solid-js", "dist"), { recursive: true });
      writeFileSync(
        join(installed, "solid-js", "dist", file),
        "if (!Transition.sources.has(node)) node.value = nextValue;\n",
      );
    }
    const valid = verify(testCase, ["--installed-tui", installed]);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);

    writeFileSync(join(installed, "solid-js", "dist", "solid.js"), "unpatched\n");
    const invalid = verify(testCase, ["--installed-tui", installed]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /upstreamed Solid transition fix/i);
  });
});

describe("TUI release policy and SBOM", () => {
  it("keeps npm publication and package-consumer interactive install explicitly blocked", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.private, true);
    assert.match(pkg.scripts.prepublishOnly, /process\.exit\(1\)/);
    assert.equal(pkg.alloy.tuiRelease.npmPublication, "blocked");
    assert.equal(pkg.alloy.tuiRelease.packageConsumerInteractiveInstall, "unsupported");
    assert.match(pkg.scripts["audit:release"], /cd tui && bun audit --production/);
    assert.match(pkg.scripts["audit:release"], /npm audit[\s\S]*bun audit/);

    const publish = run(process.execPath, [join(root, "scripts", "verify-release.mjs"), "--publish"]);
    assert.notEqual(publish.status, 0);
    assert.match(publish.stderr, /npm publication is blocked/i);
  });

  it("merges integrity-bearing TUI lock components into CycloneDX", () => {
    const directory = mkdtempSync(join(temp, "sbom-"));
    const sbom = join(directory, "alloy.cdx.json");
    writeFileSync(sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components: [] }));
    const result = run(process.execPath, [sbomMerger, sbom, join(root, "tui", "bun.lock")]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const merged = JSON.parse(readFileSync(sbom, "utf8"));
    for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"]) {
      const component = merged.components.find((candidate) => candidate.name === name);
      assert.ok(component, `${name} must be present`);
      assert.match(component.version, /^\d/);
      assert.match(component.hashes?.[0]?.content || "", /^[0-9a-f]{128}$/);
    }
  });

  it("wires checksum-verified Bun, tmux, frozen deps, and packed PTY verification in CI", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.match(workflow, /apt-get install[^\n]*tmux/);
    assert.match(workflow, /a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7/);
    assert.match(workflow, /bun"? --version/);
    assert.match(workflow, /bun install --cwd tui --frozen-lockfile/);
    assert.match(workflow, /npm run verify:opentui-packed/);
  });
});
