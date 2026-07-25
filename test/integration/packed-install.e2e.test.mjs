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
    assert.equal(manifest.name, "alloy-agent");
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
    assert.match(version.stdout, /Pi\s+0\.82\.0/);

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
    const installedRoot = join(project, "node_modules", "alloy-agent");
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
    const sourceFixture = join(temp, "source-fixture");
    cpSync(root, sourceFixture, {
      recursive: true,
      filter(source) {
        if (source === root) return true;
        const first = relative(root, source).split(/[\\/]/)[0];
        return !new Set([".git", "node_modules", "alloy.cdx.json"]).has(first);
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
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$ALLOY_TEST_SOURCE_ARCHIVE" "$out"
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
        PATH: `${installerBin}:/usr/bin:/bin`,
      },
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const packageVersion = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ).version;
    assert.match(installed.stdout, new RegExp(`Alloy ${packageVersion.replaceAll(".", "\\.")}`));

    const app = join(dataHome, "alloy", "app");
    const lock = JSON.parse(readFileSync(join(app, "npm-shrinkwrap.json"), "utf8"));
    const packagePaths = installedPackagePaths(app);
    const installedSet = new Set(packagePaths);
    assert.ok(packagePaths.length > 300);
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
    const version = run(alloy, ["--version"], {
      env: { PATH: `${toolBin}:${process.env.PATH}` },
    });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.match(version.stdout, /Pi\s+0\.82\.0/);
  });
});
