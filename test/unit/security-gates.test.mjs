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
after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

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
          url: "git+https://github.com/ccoussa717/alloy.git",
        },
        homepage: "https://github.com/ccoussa717/alloy#readme",
        bugs: { url: "https://github.com/ccoussa717/alloy/issues" },
      },
    });
    const valid = run(process.execPath, [script, "--publish"], {
      cwd: directory,
      env: { RELEASE_TAG: "v0.8.2" },
    });
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  });

  it("requires source launches to keep npm publication disabled", () => {
    const publicPackage = run(process.execPath, [script, "--source"], {
      cwd: releaseFixture(),
    });
    assert.notEqual(publicPackage.status, 0);
    assert.match(publicPackage.stderr, /must remain private/);

    const privatePackage = run(process.execPath, [script, "--source"], {
      cwd: releaseFixture({ pkg: { private: true } }),
    });
    assert.equal(privatePackage.status, 0, privatePackage.stderr || privatePackage.stdout);
  });

  it("rejects publication while the package is private", () => {
    const directory = releaseFixture({
      pkg: {
        private: true,
        repository: {
          type: "git",
          url: "git+https://github.com/acme/alloy.git",
        },
        homepage: "https://github.com/acme/alloy#readme",
        bugs: { url: "https://github.com/acme/alloy/issues" },
      },
    });
    const result = run(process.execPath, [script, "--publish"], { cwd: directory });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be private/);
  });

  it("rejects canonical metadata that points away from the Alloy repository", () => {
    const directory = releaseFixture({
      pkg: {
        repository: {
          type: "git",
          url: "git+https://github.com/acme/alloy.git",
        },
        homepage: "https://github.com/acme/alloy#readme",
        bugs: { url: "https://github.com/acme/alloy/issues" },
      },
    });
    const result = run(process.execPath, [script, "--publish"], { cwd: directory });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical Alloy repository/);
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
