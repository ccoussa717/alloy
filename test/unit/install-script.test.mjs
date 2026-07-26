import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PACKAGE_VERSION = packageJson.version;
const PI_VERSION = packageJson.alloy.piFork.version;
const installer = readFileSync(join(root, "install.sh"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "alloy-installer-"));
const NODE_SHA_LINUX_X64 =
  "d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d";
const NODE_SHA_DARWIN_ARM64 =
  "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d";
const SOURCE_SHA = "a".repeat(40);

after(() => rmSync(temp, { recursive: true, force: true }));

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function goodRuntime(bin) {
  mkdirSync(bin, { recursive: true });
  executable(
    join(bin, "node"),
    `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
if [ "$1" = "--version" ]; then printf '%s\n' v22.19.0; exit 0; fi
case "$1" in
  */bin/alloy.mjs)
    case "$1" in
      */alloy/app/bin/alloy.mjs)
        [ "\${FAKE_FINAL_FAIL:-0}" = "1" ] && exit 1
        ;;
    esac
    shift
    if [ "$1" = "--version" ]; then
      printf '%s\n' 'Alloy ${PACKAGE_VERSION}' 'Pi    ${PI_VERSION}' 'Node  v22.19.0'
    fi
    exit 0
    ;;
esac
exit 0
`,
  );
  executable(
    join(bin, "npm"),
    `#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$FAKE_NPM_LOG"
if [ "\${FAKE_CONSUME_STDIN:-0}" = "1" ]; then
  if IFS= read -r stolen; then
    printf 'stdin=%s\n' "$stolen" >> "$FAKE_NPM_LOG"
  else
    printf '%s\n' 'stdin=<eof>' >> "$FAKE_NPM_LOG"
  fi
fi
mkdir -p "$PWD/node_modules/@earendil-works/pi-coding-agent/dist"
: > "$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
`,
  );
}

function fixture({
  supportedNode = true,
  checksum = NODE_SHA_LINUX_X64,
  os = "Linux",
  arch = "x86_64",
} = {}) {
  const dir = mkdtempSync(join(temp, "case-"));
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const runtimeBin = join(dir, "runtime-bin");
  const prefix = join(home, ".local");
  const dataHome = join(home, ".local", "share");
  const npmLog = join(dir, "npm.log");
  const curlLog = join(dir, "curl.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  goodRuntime(runtimeBin);

  executable(
    join(fakeBin, "uname"),
    "#!/bin/sh\n[ \"$1\" = \"-s\" ] && printf '%s' \"$FAKE_UNAME_S\" || printf '%s' \"$FAKE_UNAME_M\"\n",
  );
  executable(
    join(fakeBin, "node"),
    supportedNode
      ? readFileSync(join(runtimeBin, "node"), "utf8")
      : "#!/bin/sh\n[ \"$1\" = \"--version\" ] && printf '%s\\n' v20.0.0\nexit 1\n",
  );
  executable(join(fakeBin, "npm"), readFileSync(join(runtimeBin, "npm"), "utf8"));
  executable(
    join(fakeBin, "curl"),
    `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  https://api.github.com/repos/ccoussa717/alloy/commits/main)
    printf '%s\n' '{"sha":"${SOURCE_SHA}"}'
    exit 0
    ;;
esac
: > "$out"
`,
  );
  executable(
    join(fakeBin, "sha256sum"),
    `#!/bin/sh\nprintf '%s  %s\\n' '${checksum}' "$1"\n`,
  );
  executable(
    join(fakeBin, "shasum"),
    `#!/bin/sh\nprintf '%s  %s\\n' '${checksum}' "$3"\n`,
  );
  executable(
    join(fakeBin, "tar"),
    `#!/bin/sh
dest=""
archive=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -C) dest="$2"; shift 2 ;;
    *.tar.gz) archive="$1"; shift ;;
    *) shift ;;
  esac
done
case "$archive" in
  *node-v22.19.0-*.tar.gz)
    name="\${archive##*/}"
    target="$dest/\${name%.tar.gz}/bin"
    mkdir -p "$target"
    cp "$FAKE_RUNTIME_BIN/node" "$target/node"
    cp "$FAKE_RUNTIME_BIN/npm" "$target/npm"
    chmod +x "$target/node" "$target/npm"
    ;;
  *)
    mkdir -p "$dest/bin" "$dest/extensions" "$dest/themes" "$dest/skills" "$dest/prompts"
    : > "$dest/bin/alloy.mjs"
    chmod +x "$dest/bin/alloy.mjs"
    if [ "\${FAKE_BAD_REPOSITORY:-0}" = "1" ]; then
      repository='https://example.com/not-alloy'
    else
      repository='git+https://github.com/ccoussa717/alloy.git'
    fi
    package_private="\${FAKE_PACKAGE_PRIVATE:-true}"
    printf '{"name":"alloy-agent","version":"${PACKAGE_VERSION}","private":%s,"repository":{"type":"git","url":"%s"}}\n' "$package_private" "$repository" > "$dest/package.json"
    printf '%s\n' '{"name":"alloy-agent","lockfileVersion":3,"packages":{}}' > "$dest/npm-shrinkwrap.json"
    if [ "\${FAKE_MISSING_RESOURCE:-0}" != "1" ]; then
      : > "$dest/extensions/index.ts"
    fi
    : > "$dest/themes/alloy-dark.json"
    ;;
esac
`,
  );

  return {
    dir,
    home,
    prefix,
    dataHome,
    npmLog,
    curlLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      ALLOY_PREFIX: prefix,
      ALLOY_REF: "test-ref",
      FAKE_NPM_LOG: npmLog,
      FAKE_CURL_LOG: curlLog,
      FAKE_RUNTIME_BIN: runtimeBin,
      FAKE_UNAME_S: os,
      FAKE_UNAME_M: arch,
      REAL_NODE: process.execPath,
    },
  };
}

function runPiped(testCase) {
  return spawnSync("/bin/bash", [], {
    input: installer,
    env: testCase.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("curl-pipe installer", () => {
  it("reuses supported Node and installs the selected Alloy source ref", () => {
    const testCase = fixture();
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      readFileSync(testCase.npmLog, "utf8"),
      /\|ci --ignore-scripts --no-audit --no-fund/,
    );
    assert.match(result.stdout, new RegExp(`Alloy ${PACKAGE_VERSION.replaceAll(".", "\\.")}`));
    assert.match(
      readFileSync(testCase.curlLog, "utf8"),
      /https:\/\/codeload\.github\.com\/ccoussa717\/alloy\/tar\.gz\/test-ref/,
    );
    assert.doesNotMatch(readFileSync(testCase.curlLog, "utf8"), /nodejs\.org/);
    assert.equal(
      existsSync(
        join(
          testCase.dataHome,
          "alloy",
          "app",
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
      ),
      true,
    );
    assert.equal(existsSync(join(testCase.prefix, "bin", "alloy")), true);
    assert.match(
      readFileSync(join(testCase.home, ".profile"), "utf8"),
      /\.config\/alloy\/env/,
    );
    assert.match(
      readFileSync(join(testCase.home, ".config", "alloy", "env"), "utf8"),
      /\.local\/bin/,
    );

    const repeated = runPiped(testCase);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const profile = readFileSync(join(testCase.home, ".profile"), "utf8");
    assert.equal(profile.match(/# Alloy CLI/g)?.length, 1);

    const conflictBin = join(testCase.dir, "conflict-bin");
    mkdirSync(conflictBin);
    executable(join(conflictBin, "alloy"), "#!/bin/sh\nexit 0\n");
    const resolved = spawnSync(
      "/bin/bash",
      ["-c", '. "$1"; command -v alloy', "bash", join(testCase.home, ".config", "alloy", "env")],
      {
        env: { ...process.env, PATH: `${conflictBin}:/usr/bin:/bin` },
        encoding: "utf8",
      },
    );
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(resolved.stdout.trim(), join(testCase.prefix, "bin", "alloy"));
  });

  it("resolves main once and downloads that exact source commit", () => {
    const testCase = fixture();
    delete testCase.env.ALLOY_REF;
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const curlLog = readFileSync(testCase.curlLog, "utf8");
    assert.match(curlLog, /api\.github\.com\/repos\/ccoussa717\/alloy\/commits\/main/);
    assert.match(
      curlLog,
      new RegExp(`codeload\\.github\\.com/ccoussa717/alloy/tar\\.gz/${SOURCE_SHA}`),
    );
  });

  it("installs checksum-verified Node when the existing runtime is too old", () => {
    const testCase = fixture({ supportedNode: false });
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      readFileSync(testCase.curlLog, "utf8"),
      /node-v22\.19\.0-linux-x64\.tar\.gz/,
    );
    assert.equal(
      existsSync(
        join(testCase.dataHome, "alloy", "node-v22.19.0-linux-x64", "bin", "node"),
      ),
      true,
    );
    assert.match(result.stdout, /Installed Node\.js v22\.19\.0/);
  });

  it("fails closed when the downloaded Node checksum does not match", () => {
    const testCase = fixture({ supportedNode: false, checksum: "0".repeat(64) });
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("rejects an unsafe source ref before installing anything", () => {
    const testCase = fixture();
    testCase.env.ALLOY_REF = "../main";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe characters/i);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.curlLog), false);
  });

  it("rejects a source archive from a non-canonical repository", () => {
    const testCase = fixture();
    testCase.env.FAKE_BAD_REPOSITORY = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected package identity/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("accepts a canonical publishable source manifest", () => {
    const testCase = fixture();
    testCase.env.FAKE_PACKAGE_PRIVATE = "false";
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it("rejects a source archive missing injected runtime resources", () => {
    const testCase = fixture();
    testCase.env.FAKE_MISSING_RESOURCE = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required runtime resources/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("rejects relative install paths", () => {
    const testCase = fixture();
    testCase.env.ALLOY_PREFIX = "relative-prefix";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be absolute/i);
    assert.equal(existsSync(testCase.curlLog), false);
  });

  it("refuses to overlap another installer for the same user", () => {
    const testCase = fixture();
    const lock = join(testCase.home, ".config", "alloy", "install.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "123\n");
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another Alloy installer is active/);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.curlLog), false);
  });

  it("keeps streamed installer input away from npm", () => {
    const testCase = fixture();
    testCase.env.FAKE_CONSUME_STDIN = "1";
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(testCase.npmLog, "utf8"), /stdin=<eof>/);
  });

  it("quotes custom prefix paths without executing their contents", () => {
    const testCase = fixture();
    const marker = join(testCase.dir, "injected");
    testCase.env.ALLOY_PREFIX = join(
      testCase.home,
      `prefix '$(touch ${marker})'`,
    );
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const envFile = join(testCase.home, ".config", "alloy", "env");
    const sourced = spawnSync("/bin/bash", ["-c", '. "$1"', "bash", envFile], {
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(sourced.status, 0, sourced.stderr || sourced.stdout);
    assert.equal(existsSync(marker), false);
  });

  it("reuses a supported runtime on architectures without a bootstrap artifact", () => {
    const testCase = fixture({ arch: "ppc64le" });
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(readFileSync(testCase.curlLog, "utf8"), /nodejs\.org/);
  });

  it("bootstraps the checksum-pinned macOS arm64 artifact with shasum", () => {
    const testCase = fixture({
      supportedNode: false,
      checksum: NODE_SHA_DARWIN_ARM64,
      os: "Darwin",
      arch: "arm64",
    });
    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      readFileSync(testCase.curlLog, "utf8"),
      /node-v22\.19\.0-darwin-arm64\.tar\.gz/,
    );
    assert.equal(
      existsSync(
        join(testCase.dataHome, "alloy", "node-v22.19.0-darwin-arm64", "bin", "node"),
      ),
      true,
    );
  });

  it("restores the previous app, command, and environment after a late failure", () => {
    const testCase = fixture();
    testCase.env.FAKE_FINAL_FAIL = "1";
    const app = join(testCase.dataHome, "alloy", "app");
    const alloy = join(testCase.prefix, "bin", "alloy");
    const envFile = join(testCase.home, ".config", "alloy", "env");
    mkdirSync(app, { recursive: true });
    mkdirSync(dirname(alloy), { recursive: true });
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(join(app, "previous"), "previous app\n");
    executable(
      alloy,
      "#!/bin/sh\n# Generated by Alloy install.sh; do not edit.\nprintf old\\n\n",
    );
    writeFileSync(envFile, "previous env\n");

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(app, "previous"), "utf8"), "previous app\n");
    assert.match(readFileSync(alloy, "utf8"), /printf old/);
    assert.equal(readFileSync(envFile, "utf8"), "previous env\n");
  });

  it("restores a previous managed Node directory when source installation fails", () => {
    const testCase = fixture({ supportedNode: false });
    testCase.env.FAKE_BAD_REPOSITORY = "1";
    const nodeRoot = join(
      testCase.dataHome,
      "alloy",
      "node-v22.19.0-linux-x64",
    );
    mkdirSync(nodeRoot, { recursive: true });
    writeFileSync(join(nodeRoot, "previous"), "previous node\n");

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.equal(
      readFileSync(join(nodeRoot, "previous"), "utf8"),
      "previous node\n",
    );
    assert.equal(existsSync(join(nodeRoot, "bin", "node")), false);
  });

  it("refuses to replace a symlinked generated environment", () => {
    const testCase = fixture();
    const envFile = join(testCase.home, ".config", "alloy", "env");
    const target = join(testCase.dir, "managed-env");
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(target, "managed elsewhere\n");
    symlinkSync(target, envFile);

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to replace symlink/i);
    assert.equal(readFileSync(target, "utf8"), "managed elsewhere\n");
  });

  it("refuses to replace any symlinked Alloy command", () => {
    const testCase = fixture();
    const target = join(testCase.dir, "unrelated", "bin", "alloy");
    const alloy = join(testCase.prefix, "bin", "alloy");
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(dirname(alloy), { recursive: true });
    writeFileSync(target, "unrelated command\n");
    symlinkSync(target, alloy);

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to replace symlink/i);
    assert.equal(readlinkSync(alloy), target);
    assert.equal(readFileSync(target, "utf8"), "unrelated command\n");
  });

  it("preserves an existing shell startup file mode", () => {
    const testCase = fixture();
    const profile = join(testCase.home, ".profile");
    writeFileSync(profile, "# existing\n");
    chmodSync(profile, 0o644);

    const result = runPiped(testCase);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(statSync(profile).mode & 0o777, 0o644);
  });
});
