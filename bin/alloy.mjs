#!/usr/bin/env node
/**
 * Alloy launcher — thin wrapper around Pi.
 * Resolves the Pi CLI, injects the Alloy package (extension + skills + theme + prompts),
 * forwards all arguments and standard streams, returns Pi's exit status.
 * Contains no agent logic.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = resolve(__dirname, "..");

function exists(p) {
  try {
    return Boolean(p && existsSync(p));
  } catch {
    return false;
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

  // 1) Local dependency next to this repo (most reliable after npm install)
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

  // 2) Resolve package main from alloy root, then sibling cli.js
  try {
    const requireFromRoot = createRequire(join(ALLOY_ROOT, "package.json"));
    const main = requireFromRoot.resolve("@earendil-works/pi-coding-agent");
    // typically …/dist/index.js → cli.js beside it
    candidates.push(join(dirname(main), "cli.js"));
    candidates.push(join(dirname(main), "dist", "cli.js"));
    candidates.push(join(dirname(dirname(main)), "dist", "cli.js"));
  } catch {
    // fall through
  }

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
      "From the alloy repo directory, run:",
      "  npm install",
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

const piBin = findPiBin();
const args = buildArgs(process.argv.slice(2));

const isNodeEntry = piBin.endsWith(".js") || piBin.endsWith(".mjs");
const command = isNodeEntry ? process.execPath : piBin;
const finalArgs = isNodeEntry ? [piBin, ...args] : args;

const child = spawn(command, finalArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    ALLOY_ROOT,
    ALLOY_VERSION: "0.6.3",
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
