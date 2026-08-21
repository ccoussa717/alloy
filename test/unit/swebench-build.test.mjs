import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installer = readFileSync(join(root, "install.sh"), "utf8");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const benchmarkReadme = readFileSync(
  join(root, "benchmarks", "swebench", "README.md"),
  "utf8",
);
const releasing = readFileSync(join(root, "docs", "RELEASING.md"), "utf8");
const rootReadme = readFileSync(join(root, "README.md"), "utf8");
const approvedDesign = readFileSync(
  join(root, "docs", "superpowers", "specs", "2026-08-18-swebench-build-integration-design.md"),
  "utf8",
);
const implementationPlan = readFileSync(
  join(root, "docs", "superpowers", "plans", "2026-08-18-swebench-build-integration.md"),
  "utf8",
);
const normalizedBenchmarkReadme = benchmarkReadme.replace(/\s+/g, " ");
const normalizedReleasing = releasing.replace(/\s+/g, " ");
const scriptsNpmIgnoreLines = readFileSync(join(root, "scripts", ".npmignore"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const ignoreLines = readFileSync(join(root, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

describe("SWE-bench build boundaries", () => {
  it("documents the maintainer-only SWE-bench release gate", () => {
    for (const document of [benchmarkReadme, releasing, approvedDesign, implementationPlan]) {
      assert.match(document, /bash scripts\/run-swebench-release-smoke\.sh test/);
      assert.match(document, /bash scripts\/run-swebench-release-smoke\.sh setup/);
      assert.match(document, /bash scripts\/run-swebench-release-smoke\.sh dry-run/);
      assert.match(document, /bash scripts\/run-swebench-release-smoke\.sh release/);
      assert.doesNotMatch(document, /npm run bench:swebench/);
    }
    assert.match(benchmarkReadme, /one-instance smoke/i);
    assert.match(releasing, /manual SWE-bench release gate/i);
    assert.match(rootReadme, /benchmarks\/swebench\/README\.md/);
    assert.match(rootReadme, /source-only/i);
    assert.match(approvedDesign, /package metadata contains no benchmark command/i);
    assert.match(implementationPlan, /user's command-boundary resolution/i);
  });

  it("documents exact truthful verdict completion semantics", () => {
    assert.match(normalizedReleasing, /`resolved` is a valid official one-instance outcome\./);
    assert.match(
      normalizedReleasing,
      /`unresolved` is a valid official one-instance outcome\./,
    );
    assert.match(
      normalizedReleasing,
      /`infrastructure_failure` means no valid official verdict exists\./,
    );
    assert.match(
      normalizedReleasing,
      /Only a persisted schema-v2 official summary can complete the gate\./,
    );
    assert.match(
      normalizedReleasing,
      /`infrastructure_failure` blocks gate completion\./,
    );
  });

  it("documents the trusted authority, attempt, and artifact boundaries", () => {
    for (const document of [normalizedBenchmarkReadme, normalizedReleasing]) {
      assert.match(
        document,
        /does not intentionally inject host credentials or environment variables, dataset gold fields, or evaluator scripts into persisted artifacts/i,
      );
      assert.match(
        document,
        /stdout\/stderr, model patches, and official summaries are untrusted and may contain sensitive content/i,
      );
      assert.match(
        document,
        /inspect persisted artifacts before sharing, attaching, or releasing them/i,
      );
      assert.doesNotMatch(document, /Host mode is not a filesystem jail/i);
      assert.doesNotMatch(document, /real (?:attempt|release|execution).*disabled/i);
    }

    for (const path of [
      "/usr/local/libexec/alloy-swebench-gate",
      "/etc/alloy/swebench-gate.json",
      "/var/lib/alloy-swebench-gate",
    ]) {
      assert.match(benchmarkReadme, new RegExp(path.replaceAll("/", "\\/")));
      assert.match(releasing, new RegExp(path.replaceAll("/", "\\/")));
    }

    assert.match(normalizedBenchmarkReadme, /provision <authority-sha>` prints an operator-reviewed bootstrap command/i);
    assert.match(normalizedBenchmarkReadme, /--replace-authority <old-sha> <new-sha>/);
    assert.match(normalizedBenchmarkReadme, /dry-run does not consume an attempt/i);
    assert.match(normalizedBenchmarkReadme, /signed first-attempt claim/i);
    assert.match(normalizedBenchmarkReadme, /audited, one-use retry/i);
    assert.match(normalizedBenchmarkReadme, /cleanup-before-sign/i);
    assert.match(normalizedBenchmarkReadme, /manifest\.signature\.json/);
    assert.match(normalizedBenchmarkReadme, /Ed25519/);
  });

  it("documents immutable inputs and the exact release-candidate sequence", () => {
    for (const document of [normalizedBenchmarkReadme, normalizedReleasing]) {
      assert.match(document, /b0dde1093fe417d83b7184254edf8199c1f0dff5/);
      assert.match(document, /438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3/);
      assert.match(document, /36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153/);
      assert.match(document, /f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b/);
      assert.match(document, /c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49/);
      assert.match(document, /7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3/);
      assert.match(document, /3f2d38f9b0363fcc814ba97f8a8c18fc7e46c665e5e5e3b29a70902bc08c54f6/);
      assert.match(document, /run-swebench-release-smoke\.sh dry-run ["']?[<$A-Z_]/);
      assert.match(document, /run-swebench-release-smoke\.sh release ["']?[<$A-Z_]/);
      assert.match(document, /run-swebench-release-smoke\.sh authorize-retry ["']?[<$A-Z_]/);
      assert.match(document, /source-only GitHub release/i);
      assert.match(document, /npm publication (?:is|remains) blocked/i);
    }
  });

  it("documents network, Docker daemon, and local model prerequisites", () => {
    assert.match(benchmarkReadme, /outbound GitHub and codeload access/i);
    assert.match(benchmarkReadme, /target repository clone access/i);
    assert.match(benchmarkReadme, /Hugging Face dataset access/i);
    assert.match(benchmarkReadme, /image and registry access required by\s+SWE-bench/i);
    assert.match(benchmarkReadme, /reachable, functioning Docker daemon/i);
    assert.match(benchmarkReadme, /local Ollama service on loopback/i);
  });

  it("keeps benchmark commands source-only and invokes tests directly in Linux CI", () => {
    for (const [key, value] of Object.entries(pkg.scripts)) {
      assert.doesNotMatch(key, /swebench/i);
      assert.doesNotMatch(value, /swebench|run-swebench-release-smoke/i);
    }
    assert.match(
      ci,
      /actions\/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065/,
    );
    assert.match(ci, /python-version: ["']3\.12["']/);
    assert.match(
      ci,
      /bash scripts\/run-swebench-release-smoke\.sh test/,
    );
    assert.doesNotMatch(ci, /npm run bench:swebench/);
  });

  it("prepares the exact pinned evaluator environment before Linux benchmark tests", () => {
    assert.match(ci, /id: evaluator-python/);
    assert.match(ci, /python-version: ["']3\.14\.4["']/);
    assert.match(ci, /EVALUATOR_PYTHON: \$\{\{ steps\.evaluator-python\.outputs\.python-path \}\}/);
    assert.match(ci, /Python 3\.14\.4/);
    assert.match(ci, /benchmarks\/swebench\/\.venv/);
    assert.match(ci, /--require-hashes/);
    assert.match(ci, /--only-binary=:all:/);
    assert.match(ci, /installed evaluator distributions do not equal requirements\.lock/);
    assert.match(ci, /_apply_verified_patch\(\)/);
    const prepare = ci.indexOf("Prepare pinned SWE-bench evaluator");
    const tests = ci.indexOf("Test source-only SWE-bench release tooling");
    const docker = ci.indexOf("Verify SWE-bench Docker isolation");
    assert.ok(prepare >= 0 && prepare < tests && tests < docker);
  });

  it("keeps benchmark tooling outside runtime boundaries", () => {
    assert.equal(pkg.files.includes("benchmarks"), false);
    assert.equal(
      scriptsNpmIgnoreLines.includes("run-swebench-release-smoke.sh"),
      true,
    );
    assert.match(
      installer,
      /\[\[ ! -L "\$SOURCE_DIR\/benchmarks" \]\] \|\| err "Alloy source archive contains a symlinked benchmarks directory"/,
    );
    assert.match(installer, /rm -rf -- "\$SOURCE_DIR\/benchmarks"/);
    assert.match(
      installer,
      /! exists_or_link "\$SOURCE_DIR\/benchmarks" \|\| err "could not remove release-only benchmark tooling"/,
    );
    assert.match(
      installer,
      /\[\[ ! -L "\$SOURCE_DIR\/scripts" \]\] \|\| err "Alloy source archive contains a symlinked scripts directory"/,
    );
    assert.match(
      installer,
      /\[\[ ! -L "\$SOURCE_DIR\/scripts\/run-swebench-release-smoke\.sh" \]\] \|\| err "Alloy source archive contains a symlinked SWE-bench release wrapper"/,
    );
    assert.match(
      installer,
      /rm -f -- "\$SOURCE_DIR\/scripts\/run-swebench-release-smoke\.sh"/,
    );
    assert.match(
      installer,
      /! exists_or_link "\$SOURCE_DIR\/scripts\/run-swebench-release-smoke\.sh" \|\| err "could not remove release-only SWE-bench wrapper"/,
    );
    const identityValidation = installer.indexOf(
      "Alloy source archive has an unexpected package identity",
    );
    const resourceValidation = installer.indexOf(
      "TUI syntax parser manifest or asset hash verification failed",
    );
    const prune = installer.indexOf('rm -rf -- "$SOURCE_DIR/benchmarks"');
    const wrapperPrune = installer.indexOf(
      'rm -f -- "$SOURCE_DIR/scripts/run-swebench-release-smoke.sh"',
    );
    const appTreeMove = installer.indexOf('mv "$SOURCE_DIR" "$STAGED_APP"');
    assert.ok(
      [identityValidation, resourceValidation, prune, wrapperPrune, appTreeMove]
        .every((index) => index >= 0),
    );
    assert.ok(identityValidation < prune);
    assert.ok(resourceValidation < prune);
    assert.ok(identityValidation < wrapperPrune);
    assert.ok(resourceValidation < wrapperPrune);
    assert.ok(prune < appTreeMove);
    assert.ok(wrapperPrune < appTreeMove);
  });

  it("excludes benchmark tooling from the actual npm pack list", () => {
    const directory = mkdtempSync(join(tmpdir(), "alloy-swebench-pack-"));
    try {
      const packed = spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(packed.status, 0, packed.stderr || packed.stdout);
      const report = JSON.parse(packed.stdout)[0];
      const paths = report.files.map(({ path }) => path);
      assert.equal(paths.includes("scripts/install-cli.sh"), true);
      assert.equal(
        paths.some((path) => path === "benchmarks" || path.startsWith("benchmarks/")),
        false,
      );
      assert.equal(paths.includes("scripts/run-swebench-release-smoke.sh"), false);
      const metadata = spawnSync(
        "tar",
        ["-xOf", join(directory, report.filename), "package/package.json"],
        { encoding: "utf8" },
      );
      assert.equal(metadata.status, 0, metadata.stderr || metadata.stdout);
      const packedPackage = JSON.parse(metadata.stdout);
      for (const [key, value] of Object.entries(packedPackage.scripts)) {
        assert.doesNotMatch(key, /swebench/i);
        assert.doesNotMatch(value, /swebench|run-swebench-release-smoke/i);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("ignores generated benchmark state and Python caches", () => {
    assert.deepEqual(
      ignoreLines.filter((line) => line.startsWith("benchmarks/")),
      [
        "benchmarks/swebench/.venv/",
        "benchmarks/swebench/.cache/",
        "benchmarks/swebench/.work/",
        "benchmarks/swebench/results/",
        "benchmarks/swebench/__pycache__/",
        "benchmarks/swebench/tests/__pycache__/",
      ],
    );
    assert.equal(ignoreLines.includes("__pycache__/"), true);
  });
});
