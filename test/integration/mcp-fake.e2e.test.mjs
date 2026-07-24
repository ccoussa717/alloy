/**
 * Fake MCP process integration.
 * Spawns test/fixtures/fake-mcp-server.mjs over stdio via McpManager.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "fake-mcp-server.mjs");
const home = mkdtempSync(join(tmpdir(), "alloy-mcp-e2e-"));
process.env.ALLOY_HOME = join(home, "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
// Host secret that must NOT reach MCP child via default env scrub
process.env.AWS_SECRET_ACCESS_KEY = "should-not-leak-to-mcp";
process.env.ALLOY_FAKE_MARKER = "fixture-ok";

const { McpManager, buildMcpChildEnv, mcpToolName } = await import(
  join(root, "lib", "mcp-client.mjs")
);

describe("integration: fake MCP stdio server", () => {
  /** @type {McpManager} */
  let manager;

  before(() => {
    manager = new McpManager();
  });

  after(async () => {
    try {
      await manager.disconnectAll({ timeoutMs: 2000 });
    } catch {
      // ignore
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.ALLOY_FAKE_MARKER;
  });

  it("connects, lists tools, and calls ping/echo", async () => {
    const results = await manager.connectEnabled({
      fake: {
        command: process.execPath,
        args: [fixture],
        enabled: true,
        env: { ALLOY_FAKE_MARKER: "fixture-ok" },
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].error);
    assert.ok(results[0].tools >= 2);

    const tools = manager.getRegisteredTools();
    const names = tools.map((t) => t.registerName);
    assert.ok(names.includes(mcpToolName("fake", "ping")));
    assert.ok(names.includes(mcpToolName("fake", "echo")));

    const ping = await manager.callRegistered(mcpToolName("fake", "ping"), {
      echo: "hi",
    });
    const pingText = JSON.stringify(ping);
    assert.match(pingText, /pong/);
    assert.match(pingText, /hi/);

    const echo = await manager.callRegistered(mcpToolName("fake", "echo"), {
      text: "alloy-e2e",
    });
    const echoBody =
      echo?.content?.map((c) => c.text).join("") || JSON.stringify(echo);
    assert.match(echoBody, /alloy-e2e/);
  });

  it("does not leak AWS_SECRET_ACCESS_KEY into MCP child env by default", async () => {
    // Reconnect with env_probe
    await manager.disconnectAll();
    const results = await manager.connectEnabled({
      fake: {
        command: process.execPath,
        args: [fixture],
        enabled: true,
        env: { ALLOY_FAKE_MARKER: "fixture-ok" },
      },
    });
    assert.equal(results[0].ok, true, results[0].error);

    const probe = await manager.callRegistered(mcpToolName("fake", "env_probe"), {
      keys: ["AWS_SECRET_ACCESS_KEY", "PATH", "ALLOY_FAKE_MARKER"],
    });
    const text =
      probe?.content?.map((c) => c.text).join("") || JSON.stringify(probe);
    const data = JSON.parse(text);
    assert.equal(data.present.AWS_SECRET_ACCESS_KEY, false);
    assert.equal(data.present.PATH, true);
    // Explicit spec.env is allowed
    assert.equal(data.safe.ALLOY_FAKE_MARKER, "fixture-ok");
  });

  it("buildMcpChildEnv matches scrub policy used by connect", () => {
    const env = buildMcpChildEnv({ ALLOY_FAKE_MARKER: "x" });
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.ALLOY_FAKE_MARKER, "x");
    assert.ok(env.PATH);
  });
});
