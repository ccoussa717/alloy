import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-security-gates-"));
const TEST_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const successfulScan = {
  status: "success",
  type: "secret_detection",
  start_time: "2026-07-24T00:00:00Z",
  end_time: "2026-07-24T00:00:01Z",
  analyzer: {
    id: "gitlab-secret-detection",
    name: "GitLab Secret Detection",
    version: "1.0.0",
    vendor: { name: "GitLab" },
  },
  scanner: {
    id: "gitleaks",
    name: "Gitleaks",
    version: "8.0.0",
    vendor: { name: "GitLab" },
  },
};

after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

describe("secret-detection report validation", () => {
  const script = join(root, "scripts", "validate-security-report.mjs");

  for (const [name, report, passes] of [
    ["empty report", { version: "15.2.4", vulnerabilities: [], scan: successfulScan }, true],
    ["finding", { version: "15.2.4", vulnerabilities: [{}], scan: successfulScan }, false],
    ["failed scan", { version: "15.2.4", vulnerabilities: [], scan: { ...successfulScan, status: "failure" } }, false],
    ["missing scanner identity", { version: "15.2.4", vulnerabilities: [], scan: { ...successfulScan, scanner: {} } }, false],
    ["empty scanner identity", { version: "15.2.4", vulnerabilities: [], scan: { ...successfulScan, scanner: { ...successfulScan.scanner, id: "" } } }, false],
    ["non-ISO timestamp", { version: "15.2.4", vulnerabilities: [], scan: { ...successfulScan, start_time: "0" } }, false],
    ["missing vulnerabilities", {}, false],
    ["null vulnerabilities", { vulnerabilities: null }, false],
    ["object vulnerabilities", { vulnerabilities: {} }, false],
    ["top-level array", [], false],
    ["top-level null", null, false],
  ]) {
    it(`${passes ? "accepts" : "rejects"} ${name}`, () => {
      const path = join(temp, `${name.replaceAll(" ", "-")}.json`);
      writeFileSync(path, JSON.stringify(report));
      const result = run(process.execPath, [script, path]);
      assert.equal(result.status === 0, passes, result.stderr || result.stdout);
    });
  }

  it("rejects invalid JSON", () => {
    const path = join(temp, "invalid.json");
    writeFileSync(path, "{");
    assert.notEqual(run(process.execPath, [script, path]).status, 0);
  });
});

describe("local security scanner", () => {
  const script = join(root, "scripts", "security-scan.sh");
  const fakeBin = join(temp, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh
case "$1" in
  grep)
    [ "$FAKE_GIT_FAILURE" = "tracked-grep" ] && exit 2
    case "$*" in *deadbeef*) [ "$FAKE_GIT_FAILURE" = "history-grep" ] && exit 2 ;; esac
    exit 1
    ;;
  rev-list)
    [ "$FAKE_GIT_FAILURE" = "rev-list" ] && exit 2
    printf '%s\\n' deadbeef
    ;;
  log)
    [ "$FAKE_GIT_FAILURE" = "log" ] && exit 2
    exit 0
    ;;
  ls-files)
    [ "$FAKE_GIT_FAILURE" = "ls-files" ] && exit 2
    exit 0
    ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(fakeGit, 0o755);

  it("passes only when every Git scan completes", () => {
    const result = run("bash", [script], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_GIT_FAILURE: "" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /RESULT: PASS/);
  });

  for (const operation of ["tracked-grep", "ls-files", "rev-list", "history-grep", "log"]) {
    it(`fails closed when ${operation} fails`, () => {
      const result = run("bash", [script], {
        env: { PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_GIT_FAILURE: operation },
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /RESULT: PASS/);
    });
  }
});

function releaseFixture(overrides = {}) {
  const directory = mkdtempSync(join(temp, "release-"));
  const pkg = {
    name: "alloy-agent",
    version: "0.8.2",
    license: "MIT",
    dependencies: {
      "@earendil-works/pi-agent-core": "0.82.0",
      "@earendil-works/pi-ai": "0.82.0",
      "@earendil-works/pi-coding-agent": "0.82.0",
      "@earendil-works/pi-tui": "0.82.0",
    },
    publishConfig: { access: "public", provenance: true },
    ...(overrides.pkg || {}),
  };
  const packages = {
    "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
  };
  for (const name of Object.keys(pkg.dependencies)) {
    const path = `node_modules/${name}`;
    const slug = name.split("/").at(-1);
    packages[path] = {
      version: "0.82.0",
      resolved: `https://registry.npmjs.org/${name}/-/${slug}-0.82.0.tgz`,
      integrity: TEST_INTEGRITY,
    };
  }
  Object.assign(packages, overrides.packages || {});
  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(directory, "npm-shrinkwrap.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, packages }),
  );
  return directory;
}

describe("release metadata verification", () => {
  const script = join(root, "scripts", "verify-release.mjs");

  it("accepts complete registry provenance without public-host metadata", () => {
    const result = run(process.execPath, [script], { cwd: releaseFixture() });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  for (const [name, entry] of [
    ["missing resolution", { version: "1.0.0", integrity: TEST_INTEGRITY }],
    ["missing integrity", { version: "1.0.0", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" }],
    ["invalid integrity", { version: "1.0.0", resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz", integrity: "sha512-test" }],
    ["plaintext registry", { version: "1.0.0", resolved: "http://registry.npmjs.org/x/-/x-1.0.0.tgz", integrity: TEST_INTEGRITY }],
    ["alternate origin", { version: "1.0.0", resolved: "https://packages.example/x.tgz", integrity: TEST_INTEGRITY }],
    ["git source", { version: "1.0.0", resolved: "git+ssh://git@example/x.git", integrity: TEST_INTEGRITY }],
    ["local source", { version: "1.0.0", resolved: "file:../x", integrity: TEST_INTEGRITY }],
    ["credentialed URL", { version: "1.0.0", resolved: "https://user:pass@registry.npmjs.org/x/-/x-1.0.0.tgz", integrity: TEST_INTEGRITY }],
  ]) {
    it(`rejects ${name}`, () => {
      const directory = releaseFixture({ packages: { "node_modules/x": entry } });
      assert.notEqual(run(process.execPath, [script], { cwd: directory }).status, 0);
    });
  }

  it("requires canonical metadata only for a publish gate", () => {
    const missing = run(process.execPath, [script, "--publish"], {
      cwd: releaseFixture(),
    });
    assert.notEqual(missing.status, 0);

    const directory = releaseFixture({
      pkg: {
        repository: {
          type: "git",
          url: "git+https://codeberg.org/acme/alloy.git",
        },
        homepage: "https://codeberg.org/acme/alloy",
        bugs: { url: "https://codeberg.org/acme/alloy/issues" },
      },
    });
    const valid = run(process.execPath, [script, "--publish"], {
      cwd: directory,
      env: { CI_COMMIT_TAG: "v0.8.2" },
    });
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  });

  it("rejects a shrinkwrap root dependency map that differs from package.json", () => {
    const directory = releaseFixture();
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages[""].dependencies = {};
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(run(process.execPath, [script], { cwd: directory }).status, 0);
  });

  it("rejects a direct package entry at the wrong version", () => {
    const directory = releaseFixture();
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/@earendil-works/pi-ai"].version = "0.0.0";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(run(process.execPath, [script], { cwd: directory }).status, 0);
  });
});

describe("shrinkwrap normalization", () => {
  it("always writes an imported clean lock even when no integrity is backfilled", () => {
    const directory = releaseFixture();
    const source = join(temp, "clean-source-lock.json");
    const sourceLock = JSON.parse(
      readFileSync(join(directory, "npm-shrinkwrap.json"), "utf8"),
    );
    sourceLock.packages["node_modules/extra"] = {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/extra/-/extra-1.0.0.tgz",
      integrity: TEST_INTEGRITY,
    };
    writeFileSync(source, JSON.stringify(sourceLock));
    const result = run(
      process.execPath,
      [join(root, "scripts", "normalize-shrinkwrap.mjs"), source],
      { cwd: directory },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const imported = JSON.parse(
      readFileSync(join(directory, "npm-shrinkwrap.json"), "utf8"),
    );
    assert.equal(imported.packages["node_modules/extra"].version, "1.0.0");
  });
});
