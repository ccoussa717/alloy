import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-security-gates-"));
const TEST_INTEGRITY = `sha512-${Buffer.alloc(64).toString("base64")}`;
const TEST_PI_FORK_URL =
  "https://github.com/ccoussa717/pi/releases/download/alloy-tui-v0.82.1.5/earendil-works-pi-coding-agent-0.82.1.tgz";
const TEST_PI_TUI_FORK_URL =
  "https://github.com/ccoussa717/pi/releases/download/alloy-tui-v0.82.1.5/earendil-works-pi-tui-0.82.1.tgz";
const TEST_PI_FORK_COMMIT = "ba288b26a30e0212cf3a1b292f93c4c99d190d22";
const TEST_PI_FORK_ARTIFACT = Buffer.from("alloy pi fork artifact fixture");
const TEST_PI_FORK_SHA256 = createHash("sha256").update(TEST_PI_FORK_ARTIFACT).digest("hex");
const TEST_PI_FORK_INTEGRITY = `sha512-${createHash("sha512").update(TEST_PI_FORK_ARTIFACT).digest("base64")}`;
const TEST_PI_TUI_FORK_ARTIFACT = Buffer.from("alloy pi tui fork artifact fixture");
const TEST_PI_TUI_FORK_SHA256 = createHash("sha256").update(TEST_PI_TUI_FORK_ARTIFACT).digest("hex");
const TEST_PI_TUI_FORK_INTEGRITY = `sha512-${createHash("sha512").update(TEST_PI_TUI_FORK_ARTIFACT).digest("base64")}`;
after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  const cwd = options.cwd || root;
  const mockFetch = join(cwd, "mock-release-fetch.mjs");
  const env = { ...process.env, ...(options.env || {}) };
  if (existsSync(mockFetch)) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --import=${mockFetch}`.trim();
  }
  return spawnSync(command, args, {
    cwd,
    env,
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
      "@earendil-works/pi-agent-core": "0.82.1",
      "@earendil-works/pi-ai": "0.82.1",
      "@earendil-works/pi-coding-agent": TEST_PI_FORK_URL,
      "@earendil-works/pi-tui": TEST_PI_TUI_FORK_URL,
    },
    overrides: { "brace-expansion": "5.0.8" },
    alloy: {
      piFork: {
        version: "0.82.1",
        commit: TEST_PI_FORK_COMMIT,
        url: TEST_PI_FORK_URL,
        sha256: TEST_PI_FORK_SHA256,
        integrity: TEST_PI_FORK_INTEGRITY,
        tui: {
          url: TEST_PI_TUI_FORK_URL,
          sha256: TEST_PI_TUI_FORK_SHA256,
          integrity: TEST_PI_TUI_FORK_INTEGRITY,
        },
      },
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
      version: "0.82.1",
      resolved:
        name === "@earendil-works/pi-coding-agent"
          ? TEST_PI_FORK_URL
          : name === "@earendil-works/pi-tui"
            ? TEST_PI_TUI_FORK_URL
          : `https://registry.npmjs.org/${name}/-/${slug}-0.82.1.tgz`,
      integrity:
        name === "@earendil-works/pi-coding-agent"
          ? TEST_PI_FORK_INTEGRITY
          : name === "@earendil-works/pi-tui"
            ? TEST_PI_TUI_FORK_INTEGRITY
            : TEST_INTEGRITY,
    };
  }
  packages["node_modules/brace-expansion"] = {
    version: "5.0.8",
    resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz",
    integrity: TEST_INTEGRITY,
  };
  Object.assign(packages, overrides.packages || {});
  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg));
  writeFileSync(
    join(directory, "npm-shrinkwrap.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages }),
  );
  const artifactPath = join(directory, "pi-fork-artifact.tgz");
  writeFileSync(artifactPath, TEST_PI_FORK_ARTIFACT);
  writeFileSync(
    join(directory, "mock-release-fetch.mjs"),
    `import { readFileSync } from "node:fs";
const artifact = readFileSync(${JSON.stringify(artifactPath)});
const tuiArtifact = Buffer.from(${JSON.stringify(TEST_PI_TUI_FORK_ARTIFACT.toString())});
globalThis.fetch = async (input, options) => {
  if (!(options?.signal instanceof AbortSignal)) return new Response("missing timeout", { status: 598 });
  const url = String(input);
  if (url === "https://api.github.com/repos/ccoussa717/pi/git/ref/tags/alloy-tui-v0.82.1.5") {
    return new Response(JSON.stringify({ object: { type: "commit", sha: ${JSON.stringify(TEST_PI_FORK_COMMIT)} } }), { status: 200 });
  }
  if (url === ${JSON.stringify(TEST_PI_FORK_URL)}) return new Response(artifact, { status: 200 });
  if (url === ${JSON.stringify(TEST_PI_TUI_FORK_URL)}) return new Response(tuiArtifact, { status: 200 });
  return new Response("not found", { status: 404 });
};
`,
  );
  return directory;
}

function piForkReleaseFixture() {
  return releaseFixture();
}

describe("release metadata verification", () => {
  const script = join(root, "scripts", "verify-release.mjs");

  it("accepts complete registry provenance alongside the pinned Pi fork", () => {
    const result = run(process.execPath, [script], { cwd: releaseFixture() });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("requires Pi fork provenance metadata", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    delete pkg.alloy;
    writeFileSync(packagePath, JSON.stringify(pkg));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /piFork metadata is required/);
  });

  it("rejects a Pi fork release tag at a different commit", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.alloy.piFork.commit = "0".repeat(40);
    writeFileSync(packagePath, JSON.stringify(pkg));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must resolve to commit/);
  });

  it("resolves an annotated Pi fork release tag to its commit", () => {
    const directory = piForkReleaseFixture();
    const artifactPath = join(directory, "pi-fork-artifact.tgz");
    writeFileSync(
      join(directory, "mock-release-fetch.mjs"),
      `import { readFileSync } from "node:fs";
const artifact = readFileSync(${JSON.stringify(artifactPath)});
const tuiArtifact = Buffer.from(${JSON.stringify(TEST_PI_TUI_FORK_ARTIFACT.toString())});
globalThis.fetch = async (input, options) => {
  if (!(options?.signal instanceof AbortSignal)) return new Response("missing timeout", { status: 598 });
  const url = String(input);
  if (url.endsWith("/git/ref/tags/alloy-tui-v0.82.1.5")) {
    return new Response(JSON.stringify({ object: { type: "tag", sha: "${"a".repeat(40)}" } }), { status: 200 });
  }
  if (url.endsWith("/git/tags/${"a".repeat(40)}")) {
    return new Response(JSON.stringify({ object: { type: "commit", sha: ${JSON.stringify(TEST_PI_FORK_COMMIT)} } }), { status: 200 });
  }
  if (url === ${JSON.stringify(TEST_PI_FORK_URL)}) return new Response(artifact, { status: 200 });
  if (url === ${JSON.stringify(TEST_PI_TUI_FORK_URL)}) return new Response(tuiArtifact, { status: 200 });
  return new Response("not found", { status: 404 });
};
`,
    );

    const result = run(process.execPath, [script], { cwd: directory });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("rejects a failed Pi fork release tag request", () => {
    const directory = piForkReleaseFixture();
    writeFileSync(
      join(directory, "mock-release-fetch.mjs"),
      `globalThis.fetch = async (_input, options) => {
  if (!(options?.signal instanceof AbortSignal)) return new Response("missing timeout", { status: 598 });
  return new Response("unavailable", { status: 503 });
};
`,
    );

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not resolve Pi fork release tag.*HTTP 503/);
  });

  it("rejects a downloaded Pi fork artifact with a different SHA-256", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.alloy.piFork.sha256 = "0".repeat(64);
    writeFileSync(packagePath, JSON.stringify(pkg));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match alloy\.piFork\.sha256/);
  });

  it("accepts the explicitly pinned Alloy Pi fork artifact", () => {
    const directory = piForkReleaseFixture();

    const result = run(process.execPath, [script], { cwd: directory });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("rejects a fork artifact outside the approved repository", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const unapprovedUrl = TEST_PI_FORK_URL.replace("ccoussa717/pi", "acme/pi");
    pkg.dependencies["@earendil-works/pi-coding-agent"] = unapprovedUrl;
    pkg.alloy.piFork.url = unapprovedUrl;
    lock.packages[""].dependencies = pkg.dependencies;
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].resolved = unapprovedUrl;
    writeFileSync(packagePath, JSON.stringify(pkg));
    writeFileSync(lockPath, JSON.stringify(lock));

    assert.notEqual(run(process.execPath, [script], { cwd: directory }).status, 0);
  });

  it("rejects downloaded fork bytes when matching metadata and shrinkwrap integrity are wrong", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const wrongIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
    pkg.alloy.piFork.integrity = wrongIntegrity;
    lock.packages["node_modules/@earendil-works/pi-coding-agent"].integrity = wrongIntegrity;
    writeFileSync(packagePath, JSON.stringify(pkg));
    writeFileSync(lockPath, JSON.stringify(lock));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /downloaded Pi fork artifact does not match alloy\.piFork\.integrity/);
  });

  it("rejects a downloaded TUI fork artifact with a different SHA-256", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.alloy.piFork.tui.sha256 = "0".repeat(64);
    writeFileSync(packagePath, JSON.stringify(pkg));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match alloy\.piFork\.tui\.sha256/);
  });

  it("requires both Pi fork artifacts to use the same release tag", () => {
    const directory = piForkReleaseFixture();
    const packagePath = join(directory, "package.json");
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const mismatchedUrl = TEST_PI_TUI_FORK_URL.replace(/alloy-tui-v[^/]+/, "alloy-tui-v0.82.1-mismatch");
    pkg.dependencies["@earendil-works/pi-tui"] = mismatchedUrl;
    pkg.alloy.piFork.tui.url = mismatchedUrl;
    lock.packages[""].dependencies = pkg.dependencies;
    lock.packages["node_modules/@earendil-works/pi-tui"].resolved = mismatchedUrl;
    writeFileSync(packagePath, JSON.stringify(pkg));
    writeFileSync(lockPath, JSON.stringify(lock));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must use the same release tag/);
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

  it("keeps the publish gate blocked even with canonical metadata", () => {
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
    const blocked = run(process.execPath, [script, "--publish"], {
      cwd: directory,
      env: { RELEASE_TAG: "v0.8.2" },
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /npm publication is blocked/i);
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
    assert.match(result.stderr, /npm publication is blocked/);
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

  it("rejects a shrinkwrap with an unsupported lockfile version", () => {
    const directory = releaseFixture();
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.lockfileVersion = 2;
    writeFileSync(lockPath, JSON.stringify(lock));

    const result = run(process.execPath, [script], { cwd: directory });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must use lockfileVersion 3/);
  });

  it("rejects a direct package entry at the wrong version", () => {
    const directory = releaseFixture();
    const lockPath = join(directory, "npm-shrinkwrap.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/@earendil-works/pi-ai"].version = "0.0.0";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(run(process.execPath, [script], { cwd: directory }).status, 0);
  });

  it("rejects a vulnerable brace-expansion override or installed node", () => {
    const metadata = releaseFixture();
    const packagePath = join(metadata, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.overrides["brace-expansion"] = "5.0.7";
    writeFileSync(packagePath, JSON.stringify(pkg));
    assert.notEqual(run(process.execPath, [script], { cwd: metadata }).status, 0);

    const installed = releaseFixture();
    const lockPath = join(installed, "npm-shrinkwrap.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/brace-expansion"].version = "5.0.7";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(run(process.execPath, [script], { cwd: installed }).status, 0);
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
