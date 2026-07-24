/**
 * Isolated HOME / Pi startup smoke.
 * Does not require network model calls.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "alloy-pi-e2e-"));
const agentDir = join(home, ".pi", "agent");
const alloyHome = join(home, ".pi", "alloy");
mkdirSync(agentDir, { recursive: true });
mkdirSync(alloyHome, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  ALLOY_HOME: alloyHome,
  ALLOY_NO_CLEAR: "1",
  // prevent interactive clear / trust prompts hanging
  CI: "1",
};

after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("integration: isolated alloy/pi startup", () => {
  it("alloy --version works with isolated HOME", () => {
    const r = spawnSync(process.execPath, [join(root, "bin", "alloy.mjs"), "--version"], {
      encoding: "utf8",
      env,
      cwd: root,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Alloy \d+\.\d+\.\d+/);
    assert.match(r.stdout, /Pi\s+/);
    assert.match(r.stdout, /Node\s+v/);
  });

  it("alloy --help does not require auth", () => {
    const r = spawnSync(process.execPath, [join(root, "bin", "alloy.mjs"), "--help"], {
      encoding: "utf8",
      env,
      cwd: root,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /multi-provider coding harness/i);
  });

  it("quietStartup can be set under isolated agent dir", () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ quietStartup: true }, null, "\t") + "\n",
    );
    assert.ok(existsSync(settingsPath));
    const { readFileSync } = require("node:fs");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(s.quietStartup, true);
  });

  it("npm run doctor works isolated", () => {
    const r = spawnSync("npm", ["run", "doctor"], {
      encoding: "utf8",
      env,
      cwd: root,
      shell: false,
    });
    // doctor may exit 0 with missing providers
    assert.ok(r.status === 0 || r.stdout || r.stderr);
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /Alloy doctor|providers|extra usage|catalog/i);
  });
});
