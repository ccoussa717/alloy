#!/usr/bin/env node
/**
 * Alloy launcher and frontend selector.
 * Resolves Pi and Bun, injects the Alloy package, selects OpenTUI or legacy Pi,
 * forwards signals and standard streams, and preserves the child exit status.
 * Contains no agent logic.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  findPackageRoot,
  findPiCli,
  readPackageVersion,
} from "../lib/pi-package.mjs";
import {
  buildOpenTuiLaunch,
  selectInteractiveFrontend,
  shouldSuppressTerminalClear,
  stripLegacyUiFlag,
} from "../lib/tui-launch.mjs";

// Load ~/.pi/alloy/env early so MCP ${VAR} headers work under Pi.
try {
  const { loadAlloyEnvFile } = await import(
    new URL("../lib/alloy-env.mjs", import.meta.url).href
  );
  const result = loadAlloyEnvFile();
  if (result.reason && result.reason !== "missing") {
    console.error(`warning: Alloy secrets file not loaded: ${result.reason}`);
  }
} catch {
  // non-fatal — extension also loads this file
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = resolve(__dirname, "..");

function exists(p) {
  try {
    return Boolean(p && existsSync(p));
  } catch {
    return false;
  }
}

function readAlloyVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ALLOY_ROOT, "package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return process.env.ALLOY_VERSION || "0.0.0";
  }
}

function readPiVersion() {
  return readPackageVersion(
    findPackageRoot("@earendil-works/pi-coding-agent", [ALLOY_ROOT]),
  );
}

function printVersionAndExit() {
  const alloy = readAlloyVersion();
  const pi = readPiVersion();
  const node = process.version;
  console.log(`Alloy ${alloy}`);
  console.log(`Pi    ${pi || "(not found in alloy node_modules)"}`);
  console.log(`Node  ${node}`);
  process.exit(0);
}

function printHelpAndExit() {
  const alloy = readAlloyVersion();
  console.log(`Alloy ${alloy} — multi-provider coding harness on Pi

Usage:
  alloy [pi-args...]
  alloy --version | -V
  alloy --help | -h
  alloy fission [--json] [--reviewers N] [--mode auto|subject|repo] <request>
  alloy forge [--json] <request>
  alloy runs [--limit N]

Interactive session (default):
  alloy
  alloy -p "summarize this repo"

Non-interactive CI:
  alloy fission --json "Review PR auth changes"
  # exit 0=PASS/NO_CHANGES  1=FAIL  2=INCOMPLETE/error

Install:
  curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/main/install.sh | bash
  ALLOY_CHANNEL=stable bash install.sh   # pin to latest release tag when set

Doctor (inside a session): /doctor · /help workflows
`);
  process.exit(0);
}

// Handle Alloy meta flags before resolving/spawning Pi
const userArgv = stripLegacyUiFlag(process.argv.slice(2));
if (userArgv.includes("--version") || userArgv.includes("-V")) {
  const alloy = readAlloyVersion();
  const pi = readPiVersion();
  console.log(`Alloy ${alloy}`);
  try {
    const manifestPath = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".local/share/alloy/install-manifest.json",
    );
    if (exists(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (m.channel) console.log(`Channel ${m.channel}`);
      if (m.commit) console.log(`Commit  ${m.commit}`);
      if (m.version && m.version !== alloy) console.log(`Manifest ${m.version}`);
    }
  } catch {
    // ignore
  }
  if (process.env.ALLOY_CHANNEL) {
    console.log(`Channel ${process.env.ALLOY_CHANNEL}`);
  }
  console.log(`Pi    ${pi || "(not found in alloy node_modules)"}`);
  console.log(`Node  ${process.version}`);
  process.exit(0);
}
if (
  userArgv.includes("--help") ||
  userArgv.includes("-h") ||
  userArgv[0] === "help"
) {
  // Only short-circuit plain help; allow `alloy --help` style. Pi also has --help —
  // Alloy owns -h/--help at the launcher for version/identity clarity.
  if (
    userArgv.length === 1 ||
    userArgv.every((a) => ["--help", "-h", "help"].includes(a))
  ) {
    printHelpAndExit();
  }
}

// Non-interactive workflow commands
if (userArgv[0] === "fission" || userArgv[0] === "forge" || userArgv[0] === "runs") {
  const { cliFission, cliForge, cliRuns } = await import(
    new URL("../lib/cli-run.mjs", import.meta.url).href
  );
  const cmd = userArgv[0];
  const rest = userArgv.slice(1);
  const json = rest.includes("--json");
  const reviewersIdx = rest.indexOf("--reviewers");
  let reviewers;
  if (reviewersIdx >= 0) {
    reviewers = Number.parseInt(rest[reviewersIdx + 1], 10);
  }
  const modeIdx = rest.indexOf("--mode");
  let fissionMode;
  if (modeIdx >= 0) fissionMode = rest[modeIdx + 1];
  if (rest.includes("--repo")) fissionMode = "repo";
  if (rest.includes("--subject")) fissionMode = "subject";
  const limitIdx = rest.indexOf("--limit");
  const limit =
    limitIdx >= 0 ? Number.parseInt(rest[limitIdx + 1], 10) : 20;
  const requestParts = rest.filter(
    (a, i) =>
      a !== "--json" &&
      a !== "--reviewers" &&
      a !== "--mode" &&
      a !== "--repo" &&
      a !== "--subject" &&
      !(reviewersIdx >= 0 && i === reviewersIdx + 1) &&
      !(modeIdx >= 0 && i === modeIdx + 1) &&
      !(limitIdx >= 0 && (i === limitIdx || i === limitIdx + 1)),
  );

  if (cmd === "runs") {
    const out = cliRuns({ limit });
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(out.lines.join("\n"));
    process.exit(0);
  }
  if (cmd === "fission") {
    const request = requestParts.join(" ").trim();
    const out = await cliFission({ request, reviewers, fissionMode });
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      const r = out.result;
      console.log(
        `Fission ${r?.status || "?"} / ${r?.verdict || "—"} ${r?.error || ""}`.trim(),
      );
      if (r?.runDir) console.log(`Artifacts: ${r.runDir}`);
      if (out.error) console.error(out.error);
    }
    process.exit(out.exitCode);
  }
  if (cmd === "forge") {
    const request = requestParts.join(" ").trim();
    const out = await cliForge({ request });
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      const s = out.summary;
      console.log(
        `Forge ${s?.status || "?"} pass=${s?.pass} ${s?.error || ""}`.trim(),
      );
      if (s?.runDir) console.log(`Artifacts: ${s.runDir}`);
      if (out.error) console.error(out.error);
    }
    process.exit(out.exitCode);
  }
}

/**
 * OpenCode-clean empty field before Pi boots.
 * - quietStartup: hide Skills/Prompts resource dump
 * - collapseChangelog: if anything still shows, keep it one line
 * - lastChangelogVersion = pinned Pi version: skip injecting "What's New"
 *   into the chat buffer (Pi never clears that dump when you send a message)
 */
function ensureQuietStartup() {
  const dir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const path = join(dir, "settings.json");
  try {
    mkdirSync(dir, { recursive: true });
    let settings = {};
    if (exists(path)) {
      const contents = readFileSync(path, "utf8");
      try {
        settings = contents === "" ? {} : JSON.parse(contents);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid JSON: ${message}`);
      }
      if (
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings)
      ) {
        throw new Error("settings JSON root must be a JSON object");
      }
    }
    let changed = false;
    if (settings.quietStartup !== true) {
      settings.quietStartup = true;
      changed = true;
    }
    if (settings.collapseChangelog !== true) {
      settings.collapseChangelog = true;
      changed = true;
    }
    // Mark current Pi version as "seen" so startup does not inject changelog
    // Markdown into chatContainer (that content persists under your first messages).
    const piVer = readPiVersion();
    if (piVer && settings.lastChangelogVersion !== piVer) {
      settings.lastChangelogVersion = piVer;
      changed = true;
    }
    // Quieter stream: hide thinking blocks unless user expands
    if (settings.hideThinkingBlock !== true) {
      settings.hideThinkingBlock = true;
      changed = true;
    }
    if (settings.warnings === undefined) {
      settings.warnings = {};
      changed = true;
    }
    if (
      settings.warnings &&
      typeof settings.warnings === "object" &&
      !Array.isArray(settings.warnings) &&
      !Object.hasOwn(settings.warnings, "anthropicExtraUsage")
    ) {
      // Pi 0.82.0's warning predates Anthropic's June 15 billing-policy pause.
      settings.warnings.anthropicExtraUsage = false;
      changed = true;
    }
    if (changed) {
      writeFileSync(path, JSON.stringify(settings, null, "\t") + "\n", "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `warning: Alloy left Pi settings unchanged at ${path}: ${message}`,
    );
  }
}

function npmRootGlobal() {
  const r = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function npmPrefixGlobal() {
  const r = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function findBunBin() {
  const candidates = [
    process.env.ALLOY_BUN_BIN,
    process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, "bin", "bun"),
    join(homedir(), ".bun", "bin", "bun"),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["bun"],
    { encoding: "utf8" },
  );
  if (which.status !== 0) return null;
  const candidate = which.stdout.trim().split("\n")[0]?.trim();
  return candidate && exists(candidate) ? candidate : null;
}

/**
 * Locate Pi's dist/cli.js or a `pi` executable.
 * Note: require.resolve("…/package.json") fails — pi-coding-agent does not export package.json.
 */
function findPiBin() {
  if (process.env.ALLOY_PI_BIN && exists(process.env.ALLOY_PI_BIN)) {
    return process.env.ALLOY_PI_BIN;
  }

  /** @type {string[]} */
  const candidates = [];

  // 1) Normal Node resolution shape, including npm-hoisted dependencies.
  const resolvedCli = findPiCli([ALLOY_ROOT]);
  if (resolvedCli) candidates.push(resolvedCli);

  // 2) Local dependency next to this repo.
  candidates.push(
    join(
      ALLOY_ROOT,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  );

  // 3) Global npm root (even when `pi` is not on PATH)
  const gRoot = npmRootGlobal();
  if (gRoot) {
    candidates.push(
      join(gRoot, "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    );
  }

  // 4) Common nvm / prefix layouts
  const prefix = npmPrefixGlobal();
  if (prefix) {
    candidates.push(
      join(
        prefix,
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      ),
      join(prefix, "bin", "pi"),
    );
  }

  // 5) Home-relative guesses
  const home = homedir();
  for (const p of [
    join(home, ".nvm", "versions", "node"),
    join(home, ".npm-global"),
    join(home, ".local", "lib", "node_modules"),
  ]) {
    // shallow: only direct paths we already cover; nvm needs version dir
    if (p.includes("node_modules")) {
      candidates.push(
        join(p, "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      );
    }
  }

  for (const c of candidates) {
    if (exists(c)) {
      try {
        return realpathSync(c);
      } catch {
        return c;
      }
    }
  }

  // 6) PATH
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["pi"],
    { encoding: "utf8" },
  );
  if (which.status === 0) {
    const line = which.stdout.trim().split("\n")[0]?.trim();
    if (line && exists(line)) return line;
  }

  const localCli = join(
    ALLOY_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );

  console.error(
    [
      "Alloy: could not find the Pi CLI.",
      "",
      "From an Alloy source checkout, run:",
      "  npm ci",
      "  # then confirm:",
      `  ls ${localCli}`,
      "",
      "Or install Pi globally (and ensure npm's global bin is on PATH):",
      "  npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
      "  npm root -g   # should contain @earendil-works/pi-coding-agent",
      "",
      "Or set an absolute path:",
      "  export ALLOY_PI_BIN=/path/to/pi-coding-agent/dist/cli.js",
      "",
      `Looked in alloy root: ${ALLOY_ROOT}`,
      `npm root -g: ${gRoot || "(unavailable)"}`,
    ].join("\n"),
  );
  process.exit(1);
}

function buildArgs(userArgs) {
  const extension = join(ALLOY_ROOT, "extensions", "index.ts");
  const theme = join(ALLOY_ROOT, "themes", "alloy-dark.json");
  const skills = join(ALLOY_ROOT, "skills");
  const prompts = join(ALLOY_ROOT, "prompts");

  const inject = [
    "-e",
    extension,
    "--theme",
    theme,
    "--skill",
    skills,
    "--prompt-template",
    prompts,
  ];

  if (userArgs[0] === "--no-inject") {
    return userArgs.slice(1);
  }

  return [...inject, ...userArgs];
}

const ALLOY_VERSION = readAlloyVersion();

// Node engine gate (soft warn — install.sh hard-fails)
const nodeParts = process.versions.node.split(".").map(Number);
if (
  nodeParts[0] < 22 ||
  (nodeParts[0] === 22 && nodeParts[1] < 19)
) {
  console.error(
    `warning: Alloy requires Node >=22.19.0 (found ${process.version}). Pi may refuse to start.`,
  );
}

const piBin = findPiBin();
const args = buildArgs(userArgv);
const frontend = selectInteractiveFrontend({
  args: process.argv.slice(2),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env: process.env,
});

// Hide Pi startup resource dump so the empty state matches OpenCode's clean field
ensureQuietStartup();

// Full terminal clear before Pi draws — empty black field like OpenCode
// Skip clear for non-interactive / print modes
const skipClear =
  !process.stdout.isTTY ||
  process.env.ALLOY_NO_CLEAR ||
  shouldSuppressTerminalClear(userArgv);
if (!skipClear) {
  try {
    process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
  } catch {
    // ignore
  }
}

let command;
let finalArgs;
let childCwd;
let childEnv;
if (frontend === "opentui") {
  const bunBin = findBunBin();
  if (!bunBin) {
    console.error(
      "Alloy: interactive sessions require Bun 1.3.14 for the OpenTUI frontend. " +
        "Install Bun or set ALLOY_BUN_BIN. Use --legacy-pi-ui only as a temporary rollback.",
    );
    process.exit(1);
  }
  const bunVersion = spawnSync(bunBin, ["--version"], { encoding: "utf8" });
  if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== "1.3.14") {
    console.error(
      `Alloy: OpenTUI requires Bun 1.3.14 (found ${bunVersion.stdout.trim() || "unavailable"}).`,
    );
    process.exit(1);
  }
  const launch = buildOpenTuiLaunch({
    alloyRoot: ALLOY_ROOT,
    bunBin,
    nodeBin: process.execPath,
    piBin,
    piArgs: args,
    cwd: process.cwd(),
    version: ALLOY_VERSION,
    env: process.env,
  });
  command = launch.command;
  finalArgs = launch.args;
  childCwd = launch.cwd;
  childEnv = launch.env;
} else {
  const isNodeEntry = piBin.endsWith(".js") || piBin.endsWith(".mjs");
  command = isNodeEntry ? process.execPath : piBin;
  finalArgs = isNodeEntry ? [piBin, ...args] : args;
  childCwd = process.cwd();
  childEnv = {
    ...process.env,
    ALLOY_ROOT,
    ALLOY_VERSION,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
  };
}

const forwardedSignals = ["SIGTERM", "SIGHUP", "SIGINT"];
const signalHandlers = new Map();
const pendingSignals = [];
let child;
let childSettled = false;
let requestedSignal = null;

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

function finishWithChildStatus(code, signal) {
  if (childSettled) return;
  childSettled = true;
  removeSignalHandlers();
  if (requestedSignal) {
    process.kill(process.pid, requestedSignal);
    return;
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
}

function forwardSignal(signal) {
  requestedSignal ||= signal;
  if (!child) {
    pendingSignals.push(signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

for (const signal of forwardedSignals) {
  const handler = () => forwardSignal(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

// Alloy pins Pi via package.json (node_modules). Global `pi update` does not
// change that pin — but Pi still nags "Update Available" against pi.dev.
// Skip Pi's self-update check under Alloy; bump the dependency intentionally.
try {
  child = spawn(command, finalArgs, {
    stdio: "inherit",
    cwd: childCwd,
    env: childEnv,
    windowsHide: true,
  });
} catch (err) {
  removeSignalHandlers();
  console.error(
    `Alloy: failed to start ${frontend} frontend (${command}): ${err.message}`,
  );
  process.exit(1);
}

for (const signal of pendingSignals.splice(0)) forwardSignal(signal);

child.once("error", (err) => {
  console.error(
    `Alloy: failed to start ${frontend} frontend (${command}): ${err.message}`,
  );
  finishWithChildStatus(1, null);
});

// Wait for stdio to close as well as process exit so TUI cleanup reaches the
// inherited terminal before the launcher restores default signal behavior.
child.once("close", (code, signal) => {
  finishWithChildStatus(code, signal);
});
