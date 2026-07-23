/**
 * Streamable HTTP MCP integration — first-class remote transport.
 * Spawns test/fixtures/fake-mcp-http-server.mjs and connects via McpManager.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "fake-mcp-http-server.mjs");
const home = mkdtempSync(join(tmpdir(), "alloy-mcp-http-e2e-"));
process.env.ALLOY_HOME = join(home, "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");

const { McpManager, mcpToolName } = await import(
  join(root, "lib", "mcp-client.mjs")
);

async function startHttpFixture() {
  const child = spawn(process.execPath, [fixture], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  const line = await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("timeout waiting for HTTP MCP fixture")),
      10000,
    );
    rl.once("line", (l) => {
      clearTimeout(t);
      resolve(l);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(new Error(`HTTP MCP fixture exited early: ${code}`)),
    );
    child.stderr.on("data", () => {
      // ignore fixture logs
    });
  });
  const info = JSON.parse(line);
  return { child, info };
}

describe("integration: fake MCP streamable HTTP server", () => {
  /** @type {McpManager} */
  let manager;
  /** @type {{ child: import('node:child_process').ChildProcess, info: { url: string } }} */
  let fixtureProc;

  before(async () => {
    manager = new McpManager();
    fixtureProc = await startHttpFixture();
  });

  after(async () => {
    try {
      await manager.disconnectAll({ timeoutMs: 2000 });
    } catch {
      // ignore
    }
    try {
      fixtureProc?.child?.kill("SIGTERM");
    } catch {
      // ignore
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("connects over http, lists tools, and calls ping/echo", async () => {
    const results = await manager.connectEnabled({
      fakehttp: {
        transport: "http",
        url: fixtureProc.info.url,
        enabled: true,
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal(results[0].transport, "http");
    assert.ok(results[0].tools >= 2);

    const names = manager.getRegisteredTools().map((t) => t.registerName);
    assert.ok(names.includes(mcpToolName("fakehttp", "ping")));
    assert.ok(names.includes(mcpToolName("fakehttp", "echo")));

    const ping = await manager.callRegistered(mcpToolName("fakehttp", "ping"), {
      echo: "http-hi",
    });
    const pingText =
      ping?.content?.map((c) => c.text).join("") || JSON.stringify(ping);
    assert.match(pingText, /pong/);
    assert.match(pingText, /http-hi/);

    const echo = await manager.callRegistered(mcpToolName("fakehttp", "echo"), {
      text: "alloy-http-e2e",
    });
    const echoBody =
      echo?.content?.map((c) => c.text).join("") || JSON.stringify(echo);
    assert.match(echoBody, /alloy-http-e2e/);
  });

  it("url-only config (no transport field) auto-selects http", async () => {
    await manager.disconnectAll();
    const results = await manager.connectEnabled({
      autohttp: {
        url: fixtureProc.info.url,
        enabled: true,
      },
    });
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal(results[0].transport, "http");
  });
});
