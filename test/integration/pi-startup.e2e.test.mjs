/**
 * Isolated HOME / Pi startup smoke.
 * Does not require network model calls.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { findPiCli } from "../../lib/pi-package.mjs";

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

  it("registers a child runtime credential from stdin without persisting it", () => {
    const runtimeHome = mkdtempSync(join(tmpdir(), "alloy-runtime-auth-e2e-"));
    const runtimeAgentDir = join(runtimeHome, ".pi", "agent");
    const credential = "runtime-secret-must-remain-memory-only";
    mkdirSync(runtimeAgentDir, { recursive: true });

    try {
      const piCli = findPiCli([root]);
      assert.ok(piCli, "Pi CLI must be resolvable for the integration test");
      const r = spawnSync(
        process.execPath,
        [
          piCli,
          "--no-extensions",
          "--extension",
          join(root, "extensions", "child-enforcer.ts"),
          "--list-models",
          "openai-codex",
        ],
        {
          encoding: "utf8",
          input: JSON.stringify({
            version: 1,
            provider: "openai-codex",
            apiKey: credential,
          }),
          env: {
            ...env,
            HOME: runtimeHome,
            PI_CODING_AGENT_DIR: runtimeAgentDir,
            ALLOY_CHILD_CREDENTIAL_STDIN: "1",
          },
          cwd: root,
        },
      );

      const output = `${r.stdout || ""}${r.stderr || ""}`;
      assert.equal(r.status, 0, output);
      assert.match(r.stdout, /openai-codex/);
      assert.doesNotMatch(output, new RegExp(credential));
      assert.equal(readFileSync(join(runtimeAgentDir, "auth.json"), "utf8"), "{}");
      assert.equal(
        readFileSync(join(runtimeAgentDir, "models-store.json"), "utf8"),
        "{}",
      );
      assert.equal(existsSync(join(runtimeAgentDir, "models.json")), false);
    } finally {
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("exposes Claude Opus 5 without replacing live Anthropic composition", async () => {
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: "https://proxy.example.test/v1",
            models: [
              {
                id: "claude-custom-test",
                name: "Claude Custom Test",
                api: "anthropic-messages",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      }),
    );
    const child = spawn(
      process.execPath,
      [join(root, "bin", "alloy.mjs"), "--mode", "rpc", "--no-session"],
      {
        env: { ...env, ANTHROPIC_API_KEY: "test-only" },
        cwd: root,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`RPC model list timed out: ${stderr || stdout}`)),
        10000,
      );
      let requested = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (!requested) {
            requested = true;
            child.stdin.write(
              `${JSON.stringify({ type: "get_available_models" })}\n`,
            );
          }
          if (
            message.type === "response" &&
            message.command === "get_available_models"
          ) {
            clearTimeout(timeout);
            resolve(message);
          }
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`RPC exited ${code}: ${stderr || stdout}`));
        }
      });
    }).finally(async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    });

    assert.equal(response.success, true);
    const models = response.data.models.filter(
      (model) => model.provider === "anthropic",
    );
    assert.ok(models.some((model) => model.id === "claude-opus-4-8"));
    assert.ok(models.some((model) => model.id === "claude-sonnet-5"));
    assert.ok(models.some((model) => model.id === "claude-custom-test"));
    const opus5 = models.find((model) => model.id === "claude-opus-5");
    assert.ok(opus5);
    assert.equal(opus5.baseUrl, "https://proxy.example.test/v1");
    assert.equal(opus5.contextWindow, 1_000_000);
    assert.equal(opus5.maxTokens, 128_000);
  });

  it("quietStartup can be set under isolated agent dir", () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ quietStartup: true }, null, "\t") + "\n",
    );
    assert.ok(existsSync(settingsPath));
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
