#!/usr/bin/env node
/**
 * Alloy launcher — thin wrapper around Pi.
 * Resolves the Pi CLI, injects the Alloy package (extension + skills + theme + prompts),
 * forwards all arguments and standard streams, returns Pi's exit status.
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

Alloy injects its extension, theme, skills, and prompts into Pi.
All other flags are forwarded to Pi (e.g. -c, -p, --mode).

Examples:
  alloy
  alloy --version
  alloy -p "summarize this repo"

Install CLI onto PATH:
  bash scripts/install-cli.sh

Doctor (inside a session): /doctor
`);
  process.exit(0);
}

// Handle Alloy meta flags before resolving/spawning Pi
const userArgv = process.argv.slice(2);
if (userArgv.includes("--version") || userArgv.includes("-V")) {
  printVersionAndExit();
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

/**
 * OpenCode-clean empty field before Pi boots.
 * - quietStartup: hide Skills/Prompts resource dump
 * - collapseChangelog: if anything still shows, keep it one line
 * - lastChangelogVersion = pinned Pi version: skip injecting "What's New"
 *   into the chat buffer (Pi never clears that dump when you send a message)
 */
function ensureQuietStartup() {
  try {
    const dir =
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const path = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    let settings = {};
    if (exists(path)) {
      try {
        settings = JSON.parse(readFileSync(path, "utf8") || "{}") || {};
      } catch {
        settings = {};
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
  } catch {
    // non-fatal — chrome still works, just noisier
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

// Hide Pi startup resource dump so the empty state matches OpenCode's clean field
ensureQuietStartup();

// Full terminal clear before Pi draws — empty black field like OpenCode
// Skip clear for non-interactive / print modes
const skipClear =
  !process.stdout.isTTY ||
  process.env.ALLOY_NO_CLEAR ||
  userArgv.includes("-p") ||
  userArgv.includes("--mode") ||
  userArgv.includes("--version");
if (!skipClear) {
  try {
    process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
  } catch {
    // ignore
  }
}

const isNodeEntry = piBin.endsWith(".js") || piBin.endsWith(".mjs");
const command = isNodeEntry ? process.execPath : piBin;
const finalArgs = isNodeEntry ? [piBin, ...args] : args;

// Alloy pins Pi via package.json (node_modules). Global `pi update` does not
// change that pin — but Pi still nags "Update Available" against pi.dev.
// Skip Pi's self-update check under Alloy; bump the dependency intentionally.
const child = spawn(command, finalArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    ALLOY_ROOT,
    ALLOY_VERSION,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
  },
  windowsHide: true,
});

child.on("error", (err) => {
  console.error(`Alloy: failed to start Pi (${command}): ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
