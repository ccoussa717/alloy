import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mod = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "mcp-client.mjs")).href
);

test("mcpToolName sanitizes server and tool", () => {
  assert.equal(mod.mcpToolName("foo-bar", "list.things"), "mcp_foo_bar_list_things");
  assert.ok(mod.mcpToolName("a", "b").length <= 64);
});

test("isMcpToolName", () => {
  assert.equal(mod.isMcpToolName("mcp_x_y"), true);
  assert.equal(mod.isMcpToolName("write"), false);
});

test("formatMcpResult text and error", () => {
  assert.match(
    mod.formatMcpResult({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    }),
    /MCP error|boom/,
  );
  assert.equal(
    mod.formatMcpResult({ content: [{ type: "text", text: "ok" }] }),
    "ok",
  );
});

test("McpManager empty connect", async () => {
  const m = new mod.McpManager();
  const results = await m.connectEnabled({
    disabled: { command: "true", enabled: false },
  });
  assert.equal(results.length, 0);
  await m.disconnectAll();
});
