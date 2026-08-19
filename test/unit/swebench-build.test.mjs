import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installer = readFileSync(join(root, "install.sh"), "utf8");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const ignoreLines = readFileSync(join(root, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean);

describe("SWE-bench build boundaries", () => {
  it("wires fast benchmark commands into normal verification", () => {
    assert.equal(
      pkg.scripts["bench:swebench:test"],
      "python3 -m unittest discover -s benchmarks/swebench/tests -v",
    );
    assert.equal(
      pkg.scripts["bench:swebench:setup"],
      "python3 -m venv benchmarks/swebench/.venv && benchmarks/swebench/.venv/bin/python -m pip install --upgrade pip && benchmarks/swebench/.venv/bin/python -m pip install -r benchmarks/swebench/requirements.txt",
    );
    assert.equal(
      pkg.scripts["bench:swebench:dry-run"],
      "bash scripts/run-swebench-release-smoke.sh --dry-run",
    );
    assert.equal(
      pkg.scripts["bench:swebench:release"],
      "bash scripts/run-swebench-release-smoke.sh",
    );
    assert.match(pkg.scripts["test:all"], /bench:swebench:test/);
    assert.match(
      ci,
      /actions\/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065/,
    );
    assert.match(ci, /python-version: ["']3\.12["']/);
  });

  it("keeps benchmark tooling outside runtime boundaries", () => {
    assert.equal(pkg.files.includes("benchmarks"), false);
    assert.match(
      installer,
      /\[\[ ! -L "\$SOURCE_DIR\/benchmarks" \]\] \|\| err "Alloy source archive contains a symlinked benchmarks directory"/,
    );
    assert.match(installer, /rm -rf -- "\$SOURCE_DIR\/benchmarks"/);
    assert.match(
      installer,
      /\[\[ ! -e "\$SOURCE_DIR\/benchmarks" \]\] \|\| err "could not remove release-only benchmark tooling"/,
    );
    const identityValidation = installer.indexOf(
      "Alloy source archive has an unexpected package identity",
    );
    const resourceValidation = installer.indexOf(
      "TUI syntax parser manifest or asset hash verification failed",
    );
    const prune = installer.indexOf('rm -rf -- "$SOURCE_DIR/benchmarks"');
    const appTreeMove = installer.indexOf('mv "$SOURCE_DIR" "$STAGED_APP"');
    assert.ok(
      [identityValidation, resourceValidation, prune, appTreeMove].every(
        (index) => index >= 0,
      ),
    );
    assert.ok(identityValidation < prune);
    assert.ok(resourceValidation < prune);
    assert.ok(prune < appTreeMove);
  });

  it("ignores generated benchmark state and Python caches", () => {
    assert.deepEqual(
      ignoreLines.filter((line) => line.startsWith("benchmarks/")),
      [
        "benchmarks/swebench/.venv/",
        "benchmarks/swebench/.work/",
        "benchmarks/swebench/results/",
        "benchmarks/swebench/__pycache__/",
        "benchmarks/swebench/tests/__pycache__/",
      ],
    );
    assert.equal(ignoreLines.includes("__pycache__/"), true);
  });
});
