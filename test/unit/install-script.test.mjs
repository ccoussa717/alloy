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
const localInstaller = readFileSync(join(root, "scripts", "install-cli.sh"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "alloy-installer-"));
const NODE_SHA_LINUX_X64 =
  "d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d";
const NODE_SHA_DARWIN_ARM64 =
  "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d";
const BUN_SHA = {
  "Linux:x86_64": "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
  "Linux:aarch64": "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
  "Darwin:x86_64": "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076",
  "Darwin:arm64": "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
};
const SOURCE_SHA = "a".repeat(40);
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
if [ "$1" = "-e" ]; then
  case "$2" in *process.versions.node*) exit 0 ;; esac
  exec "$REAL_NODE" "$@"
fi
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
  nodeChecksum = NODE_SHA_LINUX_X64,
  bunChecksum,
  os = "Linux",
  arch = "x86_64",
  libc = "glibc",
} = {}) {
  const dir = mkdtempSync(join(temp, "case-"));
  const home = join(dir, "home");
  const fakeBin = join(dir, "bin");
  const runtimeBin = join(dir, "runtime-bin");
  const prefix = join(home, ".local");
  const dataHome = join(home, ".local", "share");
  const npmLog = join(dir, "npm.log");
  const bunLog = join(dir, "bun.log");
  const unzipLog = join(dir, "unzip.log");
  const curlLog = join(dir, "curl.log");
  bunChecksum ??= BUN_SHA[`${os}:${arch}`];
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  goodRuntime(runtimeBin);

  executable(
    join(fakeBin, "uname"),
    "#!/bin/sh\n[ \"$1\" = \"-s\" ] && printf '%s' \"$FAKE_UNAME_S\" || printf '%s' \"$FAKE_UNAME_M\"\n",
  );
  executable(
    join(fakeBin, "ldd"),
    "#!/bin/sh\nprintf '%s libc\\n' \"$FAKE_LIBC\"\n",
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
    `#!/bin/sh
case "$1" in
  *node-v22.19.0-*) checksum='${nodeChecksum}' ;;
  *tui/assets/parsers/manifest.json) checksum="$FAKE_PARSER_MANIFEST_SHA256" ;;
  *) checksum='${bunChecksum}' ;;
esac
printf '%s  %s\n' "$checksum" "$1"
`,
  );
  executable(
    join(fakeBin, "shasum"),
    `#!/bin/sh
case "$3" in
  *node-v22.19.0-*) checksum='${nodeChecksum}' ;;
  *tui/assets/parsers/manifest.json) checksum="$FAKE_PARSER_MANIFEST_SHA256" ;;
  *) checksum='${bunChecksum}' ;;
esac
printf '%s  %s\n' "$checksum" "$3"
`,
  );
  executable(
    join(fakeBin, "unzip"),
    `#!/bin/sh
archive=""
dest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) dest="$2"; shift 2 ;;
    *.zip) archive="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$archive" >> "$FAKE_UNZIP_LOG"
name="\${archive##*/}"
target="$dest/\${name%.zip}"
mkdir -p "$target"
cat > "$target/bun" <<'BUN'
#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '1.3.14'; exit 0; fi
printf '%s|%s\n' "$PWD" "$*" >> "$FAKE_BUN_LOG"
case " $* " in
  *" -e "*) [ "\${FAKE_TUI_PROBE_FAIL:-0}" = "1" ] && exit 42 ;;
esac
if [ "$1" = "install" ]; then mkdir -p "$PWD/node_modules"; fi
BUN
chmod +x "$target/bun"
`,
  );
  executable(
    join(fakeBin, "tar"),
    `#!/bin/sh
case " $* " in
  *" -tzf "*|*" -tf "*)
    printf '%s\n' "$FAKE_ARCHIVE_MEMBERS"
    exit 0
    ;;
esac
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
    mkdir -p "$dest/bin" "$dest/extensions" "$dest/themes" "$dest/skills" "$dest/prompts" "$dest/tui/src" "$dest/tui/patches" "$dest/tui/assets/parsers"
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
    if [ "\${FAKE_MISSING_TUI_RESOURCE:-0}" != "1" ]; then
      printf '%s\n' '{"name":"@alloy/opencode-tui","private":true}' > "$dest/tui/package.json"
      printf '%s\n' 'lockfileVersion = 1' > "$dest/tui/bun.lock"
      : > "$dest/tui/bunfig.toml"
      : > "$dest/tui/LICENSE.opencode"
      : > "$dest/tui/THIRD_PARTY_NOTICES.md"
      : > "$dest/tui/UPSTREAM.md"
      : > "$dest/tui/patches/solid-js@1.9.10.patch"
      : > "$dest/tui/src/index.tsx"
      printf '%s\n' '{"schemaVersion":1,"parsers":{' > "$dest/tui/assets/parsers/manifest.json"
      separator=''
      for language in bash c cpp go java python rust; do
        mkdir -p "$dest/tui/assets/parsers/$language"
        : > "$dest/tui/assets/parsers/$language/LICENSE"
        : > "$dest/tui/assets/parsers/$language/highlights.scm"
        : > "$dest/tui/assets/parsers/$language/parser.wasm"
        printf '%s"%s":{"version":"1.0.0","commit":"%s","repository":"https://github.com/tree-sitter/tree-sitter-%s","release":"https://github.com/tree-sitter/tree-sitter-%s/releases/tag/v1.0.0","wasmUrl":"https://github.com/tree-sitter/tree-sitter-%s/releases/download/v1.0.0/tree-sitter-%s.wasm","assets":{"LICENSE":"${EMPTY_SHA256}","highlights.scm":"${EMPTY_SHA256}","parser.wasm":"${EMPTY_SHA256}"}}' "$separator" "$language" "${SOURCE_SHA}" "$language" "$language" "$language" "$language" >> "$dest/tui/assets/parsers/manifest.json"
        separator=','
      done
      printf '%s\n' '}}' >> "$dest/tui/assets/parsers/manifest.json"
      if [ "\${FAKE_TAMPER_PARSER:-0}" = "1" ]; then
        printf '%s\n' tampered > "$dest/tui/assets/parsers/python/parser.wasm"
      fi
      if [ "\${FAKE_SYMLINK_TUI_LOCK:-0}" = "1" ]; then
        rm -f "$dest/tui/bun.lock"
        ln -s "$FAKE_SYMLINK_TARGET" "$dest/tui/bun.lock"
      fi
    fi
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
    bunLog,
    unzipLog,
    curlLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      ALLOY_PREFIX: prefix,
      ALLOY_REF: "test-ref",
      FAKE_NPM_LOG: npmLog,
      FAKE_BUN_LOG: bunLog,
      FAKE_UNZIP_LOG: unzipLog,
      FAKE_CURL_LOG: curlLog,
      FAKE_RUNTIME_BIN: runtimeBin,
      FAKE_UNAME_S: os,
      FAKE_UNAME_M: arch,
      FAKE_LIBC: libc,
      FAKE_ARCHIVE_MEMBERS: "alloy-test/package.json",
      FAKE_PARSER_MANIFEST_SHA256: "e6107d4bd3cd2e971a245b1bfd3091b29adcd4965210fec03ffb87eb9077e453",
      FAKE_SYMLINK_TARGET: join(dir, "outside-bun.lock"),
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
    assert.match(
      readFileSync(testCase.bunLog, "utf8"),
      /\/tui\|install --frozen-lockfile --production/,
    );
    assert.match(result.stdout, new RegExp(`Alloy ${PACKAGE_VERSION.replaceAll(".", "\\.")}`));
    assert.match(
      readFileSync(testCase.curlLog, "utf8"),
      /https:\/\/codeload\.github\.com\/ccoussa717\/alloy\/tar\.gz\/test-ref/,
    );
    assert.doesNotMatch(readFileSync(testCase.curlLog, "utf8"), /nodejs\.org/);
    assert.match(
      readFileSync(testCase.curlLog, "utf8"),
      /github\.com\/oven-sh\/bun\/releases\/download\/bun-v1\.3\.14\/bun-linux-x64-baseline\.zip/,
    );
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
    assert.equal(
      existsSync(join(testCase.dataHome, "alloy", "app", "tui", "node_modules")),
      true,
    );
    assert.match(
      readFileSync(join(testCase.prefix, "bin", "alloy"), "utf8"),
      new RegExp(`export ALLOY_BUN_BIN='${join(testCase.dataHome, "alloy", "bun-v1.3.14-linux-x64-baseline", "bun").replaceAll("/", "\\/")}'`),
    );
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
    assert.equal(
      readFileSync(testCase.curlLog, "utf8").match(/oven-sh\/bun/g)?.length,
      1,
    );
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
    const testCase = fixture({
      supportedNode: false,
      nodeChecksum: "0".repeat(64),
    });
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("fails closed when the downloaded Bun checksum does not match", () => {
    const testCase = fixture({ bunChecksum: "0".repeat(64) });
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bun archive checksum mismatch/i);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.unzipLog), false);
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

  it("rejects a source manifest that enables npm package consumers", () => {
    const testCase = fixture();
    testCase.env.FAKE_PACKAGE_PRIVATE = "false";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm publication must remain blocked/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("rejects musl before selecting a glibc Bun artifact", () => {
    const testCase = fixture({ libc: "musl" });
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /musl.*not supported/i);
    assert.equal(existsSync(testCase.curlLog), false);
  });

  it("preflights source archive members before extraction", () => {
    const testCase = fixture();
    testCase.env.FAKE_ARCHIVE_MEMBERS = "alloy-test/package.json\nalloy-test/../../escape";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe source archive member/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("rejects absolute source archive members before extraction", () => {
    const testCase = fixture();
    testCase.env.FAKE_ARCHIVE_MEMBERS = "/tmp/archive-escape";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe source archive member: absolute path/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("rejects symlinked required source resources", () => {
    const testCase = fixture();
    writeFileSync(testCase.env.FAKE_SYMLINK_TARGET, "outside\n");
    testCase.env.FAKE_SYMLINK_TUI_LOCK = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked required TUI resource/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("runs the noninteractive OpenTUI native import probe before app rollback state", () => {
    const testCase = fixture();
    testCase.env.FAKE_TUI_PROBE_FAIL = "1";
    const app = join(testCase.dataHome, "alloy", "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "previous"), "previous app\n");

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OpenTUI native import probe failed/i);
    assert.match(readFileSync(testCase.bunLog, "utf8"), / -e /);
    assert.equal(readFileSync(join(app, "previous"), "utf8"), "previous app\n");
  });

  it("rejects a source archive missing injected runtime resources", () => {
    const testCase = fixture();
    testCase.env.FAKE_MISSING_RESOURCE = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required runtime resource(?:s)?/i);
    assert.equal(existsSync(testCase.npmLog), false);
  });

  it("validates nested TUI metadata before installing either dependency tree", () => {
    const testCase = fixture();
    testCase.env.FAKE_MISSING_TUI_RESOURCE = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required TUI resource(?:s)?/i);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.bunLog), false);
    assert.doesNotMatch(readFileSync(testCase.curlLog, "utf8"), /oven-sh\/bun/);
  });

  it("rejects a syntax parser whose hash does not match the bundled manifest", () => {
    const testCase = fixture();
    testCase.env.FAKE_TAMPER_PARSER = "1";
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /syntax parser.*hash/i);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.bunLog), false);
  });

  it("rejects a syntax parser manifest outside the installer trust pin", () => {
    const testCase = fixture();
    testCase.env.FAKE_PARSER_MANIFEST_SHA256 = "0".repeat(64);
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /parser manifest checksum mismatch/i);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.bunLog), false);
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

  it("rejects architectures without a supported pinned Bun artifact", () => {
    const testCase = fixture({ arch: "ppc64le" });
    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bun 1\.3\.14 does not support ppc64le/i);
    assert.equal(existsSync(testCase.curlLog), false);
  });

  it("bootstraps the checksum-pinned macOS arm64 Node artifact with shasum", () => {
    const testCase = fixture({
      supportedNode: false,
      nodeChecksum: NODE_SHA_DARWIN_ARM64,
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

  it("selects and verifies every supported Bun release artifact", () => {
    for (const [os, arch, artifact, platform] of [
      ["Linux", "x86_64", "bun-linux-x64-baseline.zip", "linux-x64-baseline"],
      ["Linux", "aarch64", "bun-linux-aarch64.zip", "linux-aarch64"],
      ["Darwin", "x86_64", "bun-darwin-x64-baseline.zip", "darwin-x64-baseline"],
      ["Darwin", "arm64", "bun-darwin-aarch64.zip", "darwin-aarch64"],
    ]) {
      const testCase = fixture({ os, arch });
      const result = runPiped(testCase);
      assert.equal(result.status, 0, `${os}/${arch}: ${result.stderr || result.stdout}`);
      assert.match(readFileSync(testCase.curlLog, "utf8"), new RegExp(artifact.replaceAll(".", "\\.")));
      assert.equal(
        existsSync(join(testCase.dataHome, "alloy", `bun-v1.3.14-${platform}`, "bun")),
        true,
      );
    }
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

  it("restores a previous managed Bun directory after a late failure", () => {
    const testCase = fixture();
    testCase.env.FAKE_FINAL_FAIL = "1";
    const bunRoot = join(
      testCase.dataHome,
      "alloy",
      "bun-v1.3.14-linux-x64-baseline",
    );
    mkdirSync(bunRoot, { recursive: true });
    writeFileSync(join(bunRoot, "previous"), "previous bun\n");

    const result = runPiped(testCase);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(bunRoot, "previous"), "utf8"), "previous bun\n");
    assert.equal(existsSync(join(bunRoot, "bun")), false);
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

function localFixture({
  bunVersion = "1.3.14",
  nodeVersion = "22.19.0",
  projectName = "project",
  binName = "bin",
} = {}) {
  const dir = mkdtempSync(join(temp, "local-case-"));
  const project = join(dir, projectName);
  const scripts = join(project, "scripts");
  const fakeBin = join(dir, binName);
  const home = join(dir, "home");
  const localBin = join(dir, "local-bin");
  const npmLog = join(dir, "npm.log");
  const bunLog = join(dir, "bun.log");
  const nodeLog = join(dir, "node.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(project, "bin"), { recursive: true });
  mkdirSync(join(project, "tui", "src"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(scripts, "install-cli.sh"), localInstaller);
  executable(join(project, "bin", "alloy.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(join(project, "tui", "package.json"), '{"name":"@alloy/opencode-tui"}\n');
  writeFileSync(join(project, "tui", "bun.lock"), "lockfileVersion = 1\n");
  writeFileSync(join(project, "tui", "src", "index.tsx"), "export {};\n");
  executable(
    join(fakeBin, "node"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NODE_LOG"
if [ "$1" = "--version" ]; then printf '%s\n' 'v${nodeVersion}'; exit 0; fi
if [ "$1" = "-p" ]; then printf '%s\n' '${nodeVersion}'; exit 0; fi
exit 0
`,
  );
  executable(
    join(fakeBin, "npm"),
    `#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "ci" ]; then mkdir -p "$PWD/node_modules/@earendil-works/pi-coding-agent"; fi
`,
  );
  executable(
    join(fakeBin, "bun"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' '${bunVersion}'; exit 0; fi
printf '%s|%s\n' "$PWD" "$*" >> "$FAKE_BUN_LOG"
`,
  );

  return {
    project,
    localBin,
    npmLog,
    bunLog,
    nodeLog,
    dir,
    fakeBin,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      ALLOY_BIN_DIR: localBin,
      FAKE_NPM_LOG: npmLog,
      FAKE_BUN_LOG: bunLog,
      FAKE_NODE_LOG: nodeLog,
    },
  };
}

describe("local install-cli", () => {
  it("requires Bun 1.3.14, installs frozen TUI dependencies, and bakes its path into wrappers", () => {
    const testCase = localFixture();
    const result = spawnSync("/bin/bash", [join(testCase.project, "scripts", "install-cli.sh")], {
      env: testCase.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(testCase.bunLog, "utf8"), /\/tui\|install --frozen-lockfile/);
    assert.match(
      readFileSync(join(testCase.localBin, "alloy"), "utf8"),
      /ALLOY_BUN_BIN='[^']*\/bin\/bun'/,
    );
  });

  it("rejects a different Bun version before installing dependencies or wrappers", () => {
    const testCase = localFixture({ bunVersion: "1.3.13" });
    const result = spawnSync("/bin/bash", [join(testCase.project, "scripts", "install-cli.sh")], {
      env: testCase.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Bun 1\.3\.14 is required/);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(testCase.bunLog), false);
    assert.equal(existsSync(join(testCase.localBin, "alloy")), false);
  });

  it("rejects Node older than 22.19 before installing dependencies or wrappers", () => {
    const testCase = localFixture({ nodeVersion: "22.18.0" });
    const result = spawnSync("/bin/bash", [join(testCase.project, "scripts", "install-cli.sh")], {
      env: testCase.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Node 22\.19\+ is required/);
    assert.equal(existsSync(testCase.npmLog), false);
    assert.equal(existsSync(join(testCase.localBin, "alloy")), false);
  });

  it("quotes adversarial project paths in generated wrappers", () => {
    const testCase = localFixture({
      projectName: 'project ";touch pwned;#',
      binName: "runtime bin 'quoted'",
    });
    const installed = spawnSync("/bin/bash", [join(testCase.project, "scripts", "install-cli.sh")], {
      cwd: testCase.dir,
      env: testCase.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const invoked = spawnSync(join(testCase.localBin, "alloy"), ["--help"], {
      cwd: testCase.dir,
      env: testCase.env,
      encoding: "utf8",
    });
    assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
    assert.equal(existsSync(join(testCase.dir, "pwned")), false);
  });

  it("always validates and invokes the recorded Node and Bun binaries", () => {
    const testCase = localFixture();
    const installed = spawnSync("/bin/bash", [join(testCase.project, "scripts", "install-cli.sh")], {
      env: testCase.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const attackerBin = join(testCase.dir, "attacker-bin");
    const marker = join(testCase.dir, "ambient-node-used");
    mkdirSync(attackerBin);
    executable(join(attackerBin, "node"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`);
    const invoked = spawnSync(join(testCase.localBin, "alloy"), ["--help"], {
      env: { ...testCase.env, PATH: `${attackerBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
    assert.equal(existsSync(marker), false);
    assert.match(readFileSync(testCase.nodeLog, "utf8"), /alloy\.mjs --help/);

    executable(
      join(testCase.fakeBin, "bun"),
      "#!/bin/sh\n[ \"$1\" = \"--version\" ] && printf '%s\\n' 1.3.13\n",
    );
    const staleBun = spawnSync(join(testCase.localBin, "alloy"), ["--help"], {
      env: testCase.env,
      encoding: "utf8",
    });
    assert.notEqual(staleBun.status, 0);
    assert.match(staleBun.stderr, /recorded Bun.*1\.3\.14/i);
  });
});
