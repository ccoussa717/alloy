#!/usr/bin/env node
/**
 * Alloy launcher — thin wrapper around Pi.
 * Resolves the Pi CLI, injects the Alloy package (extension + skills + theme + prompts),
 * forwards all arguments and standard streams, returns Pi's exit status.
 * Contains no agent logic.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function findPiBin() {
  if (process.env.ALLOY_PI_BIN) return process.env.ALLOY_PI_BIN;

  // Prefer the dependency installed next to this package
  try {
    const pkgJson = require.resolve("@earendil-works/pi-coding-agent/package.json");
    const candidate = join(dirname(pkgJson), "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall through
  }

  // Global / PATH
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
    encoding: "utf8",
  });
  if (which.status === 0) {
    const line = which.stdout.trim().split("\n")[0]?.trim();
    if (line) return line;
  }

  console.error(
    [
      "Alloy: could not find the Pi CLI.",
      "Install with:  npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
      "Or set ALLOY_PI_BIN to the pi binary / dist/cli.js path.",
    ].join("\n"),
  );
  process.exit(1);
}

function buildArgs(userArgs) {
  const extension = join(ALLOY_ROOT, "extensions", "index.ts");
  const theme = join(ALLOY_ROOT, "themes", "alloy-dark.json");
  const skills = join(ALLOY_ROOT, "skills");
  const prompts = join(ALLOY_ROOT, "prompts");

  // Inject Alloy resources. User flags after `--` or normal pi flags still work.
  // If the user already passed -e/--extension etc., ours load first; theirs stack.
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

  // Allow `alloy --no-inject ...` for raw Pi passthrough (debug)
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
    ALLOY_VERSION: "0.5.0",
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
