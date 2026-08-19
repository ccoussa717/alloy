import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-packed-install-"));
const project = join(temp, "project");
const home = join(temp, "home");
const toolBin = join(temp, "bin");
const hostNpm = process.env.PATH.split(":")
  .map((entry) => join(entry, "npm"))
  .find(existsSync);
const hostCurl = process.env.PATH.split(":")
  .map((entry) => join(entry, "curl"))
  .find(existsSync);
assert.ok(hostNpm, "npm must be available to run the packed-install test");
mkdirSync(toolBin, { recursive: true });
symlinkSync(process.execPath, join(toolBin, "node"));
symlinkSync(realpathSync(hostNpm), join(toolBin, "npm"));
const npm = join(toolBin, "npm");
const cleanPath = [toolBin, "/usr/bin", "/bin"].join(":");
mkdirSync(project, { recursive: true });
mkdirSync(home, { recursive: true });

after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  const env = {
    ...process.env,
    PATH: cleanPath,
    HOME: home,
    ALLOY_HOME: join(home, ".pi", "alloy"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    ALLOY_NO_CLEAR: "1",
    CI: "1",
    ...(options.env || {}),
  };
  delete env.ALLOY_PI_BIN;
  delete env.NODE_PATH;
  Object.assign(env, options.env || {});

  return spawnSync(command, args, {
    cwd: options.cwd || project,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("integration: packed npm artifact", () => {
  it("installs and starts its bundled Pi dependency without a global pi", async () => {
    const ambientPi = run("pi", ["--version"]);
    assert.equal(ambientPi.error?.code, "ENOENT");

    const packed = run(
      npm,
      ["pack", "--json", "--pack-destination", temp],
      { cwd: root },
    );
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [{ filename }] = JSON.parse(packed.stdout);
    const tarball = join(temp, filename);

    const init = run(npm, ["init", "-y"]);
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const install = run(npm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const manifest = JSON.parse(
      readFileSync(join(project, "node_modules", "alloy-agent", "package.json")),
    );
    const installedRoot = join(project, "node_modules", "alloy-agent");
    assert.equal(manifest.name, "alloy-agent");
    assert.equal(existsSync(join(project, "node_modules", "alloy-agent", "docs", "plans")), false);
    assert.equal(existsSync(join(installedRoot, "tui", "bun.lock")), true);
    assert.equal(existsSync(join(installedRoot, "tui", "src", "index.tsx")), true);
    assert.equal(existsSync(join(installedRoot, "tui", "node_modules")), false);
    assert.equal(
      readFileSync(
        join(project, "node_modules", "alloy-agent", "npm-shrinkwrap.json"),
        "utf8",
      ).includes('"integrity"'),
      true,
    );

    const alloy = join(project, "node_modules", ".bin", "alloy");
    const version = run(alloy, ["--version"]);
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.match(version.stdout, new RegExp(`Pi\\s+${manifest.alloy.piFork.version.replaceAll(".", "\\.")}`));
    assert.equal(
      existsSync(join(project, "node_modules", "@earendil-works", "pi-coding-agent", "LICENSE")),
      true,
    );
    const piPackage = join(project, "node_modules", "@earendil-works", "pi-coding-agent");
    const viewportPath = join(
      piPackage,
      "dist",
      "modes",
      "interactive",
      "components",
      "interactive-viewport.js",
    );
    assert.equal(
      existsSync(viewportPath),
      true,
    );
    assert.match(
      readFileSync(join(piPackage, "dist", "modes", "interactive", "interactive-mode.js"), "utf8"),
      /new InteractiveViewport\(/,
    );
    const { InteractiveViewport } = await import(pathToFileURL(viewportPath));
    const component = (lines) => ({ render: () => lines, invalidate() {} });
    const viewport = new InteractiveViewport(() => 8, {
      header: component(["header"]),
      transcript: component(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)),
      bottom: component(["editor", "footer"]),
      renderScrollIndicator: (line) => `${line} UP`,
    });
    assert.deepEqual(viewport.render(80), [
      "header",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
      "editor",
      "footer",
    ]);
    viewport.pageUp();
    const pausedFrame = viewport.render(80);
    assert.equal(pausedFrame[0], "header");
    assert.equal(pausedFrame.at(-2), "editor");
    assert.equal(pausedFrame.at(-1), "footer");
    assert.equal(pausedFrame.some((line) => line.endsWith(" UP")), true);
    viewport.end();
    assert.equal(viewport.render(80).some((line) => line.endsWith(" UP")), false);

    const startup = run(alloy, ["--no-inject", "--list-models"]);
    assert.equal(startup.status, 0, startup.stderr || startup.stdout);
    assert.doesNotMatch(startup.stderr, /could not find the Pi CLI/i);
    assert.match(startup.stdout, /No models available|anthropic|openai|xai/i);

    const fakePi = join(temp, "fake-pi.mjs");
    writeFileSync(
      fakePi,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    const injected = run(alloy, ["--list-models"], {
      env: { ALLOY_PI_BIN: fakePi },
    });
    assert.equal(injected.status, 0, injected.stderr || injected.stdout);
    const injectedArgs = JSON.parse(injected.stdout);
    assert.deepEqual(injectedArgs.slice(0, 8), [
      "-e",
      join(installedRoot, "extensions", "index.ts"),
      "--theme",
      join(installedRoot, "themes", "alloy-dark.json"),
      "--skill",
      join(installedRoot, "skills"),
      "--prompt-template",
      join(installedRoot, "prompts"),
    ]);

    const [{ buildChildSpawnPlan }, { findPiRuntime }] = await Promise.all([
      import(
        pathToFileURL(join(installedRoot, "lib", "child-runner.mjs")).href
      ),
      import(pathToFileURL(join(installedRoot, "lib", "pi-package.mjs")).href),
    ]);
    const runtime = findPiRuntime([installedRoot]);
    assert.equal(runtime.nodeModulesRoot, join(project, "node_modules"));
    const childHome = join(temp, "child-home");
    const policyDir = join(temp, "policy");
    mkdirSync(join(childHome, ".pi", "agent"), { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    const policyPath = join(policyDir, "policy.json");
    writeFileSync(policyPath, "{}\n");
    const plan = buildChildSpawnPlan({
      policy: { sandbox: true, permissionProfile: "ask-all" },
      inv: {
        command: process.execPath,
        argsPrefix: [runtime.cli],
        piNodeModulesRoot: runtime.nodeModulesRoot,
      },
      piArgs: ["--mode", "json", "--no-session", "-p", "hello"],
      cwd: project,
      childEnv: {},
      isolatedHome: { home: childHome, piDir: join(childHome, ".pi", "agent") },
      policyPath,
      dockerImage: "node:22-bookworm",
    });
    assert.ok(
      plan.args.includes(
        `${join(project, "node_modules")}:/alloy-runtime/node_modules:ro`,
      ),
    );
    const imageIndex = plan.args.indexOf("node:22-bookworm");
    assert.deepEqual(plan.args.slice(imageIndex + 1, imageIndex + 3), [
      "node",
      "/alloy-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ]);
    assert.ok(!plan.args.includes(runtime.cli));

  });
});

function installedPackagePaths(directory, relative = "node_modules") {
  const nodeModules = join(directory, relative);
  if (!existsSync(nodeModules)) return [];
  const paths = [];
  for (const name of readdirSync(nodeModules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const child of readdirSync(join(nodeModules, name))) {
        const packagePath = join(relative, name, child);
        paths.push(packagePath);
        paths.push(...installedPackagePaths(directory, join(packagePath, "node_modules")));
      }
      continue;
    }
    const packagePath = join(relative, name);
    paths.push(packagePath);
    paths.push(...installedPackagePaths(directory, join(packagePath, "node_modules")));
  }
  return paths;
}

describe("integration: source installer", () => {
  it("installs the exact shrinkwrapped tree from the current worktree", {
    skip: process.env.ALLOY_RUN_SOURCE_INSTALLER_E2E !== "1",
  }, () => {
    assert.ok(hostCurl, "curl must be available to run the source-installer test");
    const sourceFixture = join(temp, "source-fixture");
    cpSync(root, sourceFixture, {
      recursive: true,
      filter(source) {
        if (source === root) return true;
        const parts = relative(root, source).split(/[\\/]/);
        return !parts.includes("node_modules") && !new Set([".git", "alloy.cdx.json"]).has(parts[0]);
      },
    });
    const sourceArchive = join(temp, "source-fixture.tar.gz");
    const archived = run(
      "tar",
      ["-czf", sourceArchive, "-C", temp, "source-fixture"],
    );
    assert.equal(archived.status, 0, archived.stderr || archived.stdout);

    const installerBin = join(temp, "installer-bin");
    mkdirSync(installerBin, { recursive: true });
    symlinkSync(process.execPath, join(installerBin, "node"));
    symlinkSync(realpathSync(hostNpm), join(installerBin, "npm"));
    const curl = join(installerBin, "curl");
    writeFileSync(
      curl,
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
case "$url" in
  https://codeload.github.com/ccoussa717/alloy/tar.gz/local-worktree)
    cp "$ALLOY_TEST_SOURCE_ARCHIVE" "$out"
    ;;
  *)
    exec "$ALLOY_TEST_REAL_CURL" -fsSL --retry 3 -o "$out" "$url"
    ;;
esac
`,
    );
    chmodSync(curl, 0o755);

    const installerHome = join(temp, "installer-home");
    const prefix = join(installerHome, ".local");
    const dataHome = join(prefix, "share");
    mkdirSync(installerHome, { recursive: true });
    const installed = run("bash", [join(root, "install.sh")], {
      env: {
        HOME: installerHome,
        XDG_DATA_HOME: dataHome,
        ALLOY_PREFIX: prefix,
        ALLOY_REF: "local-worktree",
        ALLOY_TEST_SOURCE_ARCHIVE: sourceArchive,
        ALLOY_TEST_REAL_CURL: realpathSync(hostCurl),
        PATH: `${installerBin}:/usr/bin:/bin`,
      },
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const packageVersion = sourceManifest.version;
    assert.match(installed.stdout, new RegExp(`Alloy ${packageVersion.replaceAll(".", "\\.")}`));

    const app = join(dataHome, "alloy", "app");
    assert.equal(existsSync(join(app, "benchmarks")), false);
    assert.equal(
      existsSync(join(app, "tui", "node_modules", "@opentui", "core")),
      true,
    );
    const lock = JSON.parse(readFileSync(join(app, "npm-shrinkwrap.json"), "utf8"));
    const packagePaths = installedPackagePaths(app);
    const installedSet = new Set(packagePaths);
    assert.ok(packagePaths.length >= 200);
    for (const packagePath of packagePaths) {
      const expected = lock.packages?.[packagePath]?.version;
      const actual = JSON.parse(
        readFileSync(join(app, packagePath, "package.json"), "utf8"),
      ).version;
      assert.equal(actual, expected, `${packagePath} must match npm-shrinkwrap.json`);
    }
    for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
      if (!packagePath || entry.optional) continue;
      assert.equal(
        installedSet.has(packagePath),
        true,
        `${packagePath} is required by npm-shrinkwrap.json`,
      );
    }

    const alloy = join(prefix, "bin", "alloy");
    assert.match(readFileSync(alloy, "utf8"), /export ALLOY_BUN_BIN=.*bun-v1\.3\.14/);
    const version = run(alloy, ["--version"], {
      env: { PATH: `${toolBin}:${process.env.PATH}` },
    });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.match(
      version.stdout,
      new RegExp(`Pi\\s+${sourceManifest.alloy.piFork.version.replaceAll(".", "\\.")}`),
    );
  });
});
