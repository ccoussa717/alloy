import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mod = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "mcp-client.mjs")).href
);

test("mcpToolName sanitizes server and tool", () => {
  assert.match(mod.mcpToolName("foo-bar", "list.things"), /^mcp_foo_bar_list_things_/);
  assert.ok(mod.mcpToolName("a", "b").length <= 64);
  assert.notEqual(
    mod.mcpToolName("foo-bar", "list.things"),
    mod.mcpToolName("foo_bar", "list_things"),
  );
  assert.notEqual(
    mod.mcpToolName("a".repeat(80), "tool"),
    mod.mcpToolName("a".repeat(79) + "b", "tool"),
  );
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

test("resolveMcpTransportKind: stdio, http aliases, url auto", () => {
  assert.equal(mod.resolveMcpTransportKind({ command: "npx" }), "stdio");
  assert.equal(mod.resolveMcpTransportKind({ transport: "stdio", command: "x" }), "stdio");
  assert.equal(mod.resolveMcpTransportKind({ transport: "http", url: "https://x/mcp" }), "http");
  assert.equal(
    mod.resolveMcpTransportKind({ transport: "streamable-http", url: "https://x/mcp" }),
    "http",
  );
  assert.equal(mod.resolveMcpTransportKind({ transport: "sse", url: "https://x/sse" }), "sse");
  // url without command defaults to http
  assert.equal(mod.resolveMcpTransportKind({ url: "https://host/mcp" }), "http");
});

test("expandEnvVars and headers", () => {
  const env = { MCP_HTTP_TOKEN: "secret-token", HOST: "example.com" };
  assert.equal(mod.expandEnvVars("Bearer ${MCP_HTTP_TOKEN}", env), "Bearer secret-token");
  assert.equal(mod.expandEnvVars("https://$HOST/mcp", env), "https://example.com/mcp");
  assert.equal(mod.expandEnvVars("Bearer ${MISSING}", env), "Bearer ");
  const headers = mod.expandEnvRecord(
    { Authorization: "Bearer ${MCP_HTTP_TOKEN}" },
    env,
  );
  assert.equal(headers.Authorization, "Bearer secret-token");
  const init = mod.buildRemoteRequestInit({
    headers: { Authorization: "Bearer ${MCP_HTTP_TOKEN}" },
  });
  // process.env may not have the token — use expandEnvRecord path already tested
  assert.ok(init.headers.Accept.includes("json"));
  assert.equal(init.redirect, "error");
});

test("fetchWithoutRedirect overrides caller redirect behavior", async () => {
  let observed;
  await mod.fetchWithoutRedirect(
    "https://example.com/mcp",
    { redirect: "follow" },
    async (_input, init) => {
      observed = init;
      return { ok: true };
    },
  );
  assert.equal(observed.redirect, "error");
});

test("isMcpSpecConnectable", () => {
  assert.equal(mod.isMcpSpecConnectable({ enabled: false, command: "x" }), false);
  assert.equal(mod.isMcpSpecConnectable({ command: "npx" }), true);
  assert.equal(mod.isMcpSpecConnectable({ url: "https://x/mcp" }), true);
  assert.equal(mod.isMcpSpecConnectable({ transport: "http" }), false);
  assert.equal(mod.isMcpSpecConnectable({ transport: "stdio" }), false);
});

test("McpManager empty connect", async () => {
  const m = new mod.McpManager();
  const results = await m.connectEnabled({
    disabled: { command: "true", enabled: false },
  });
  assert.equal(results.length, 0);
  await m.disconnectAll();
});

test("McpManager rejects incomplete http without url", async () => {
  const m = new mod.McpManager();
  const results = await m.connectEnabled({
    bad: { transport: "http", enabled: true },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /url|missing/i);
  assert.deepEqual(m.listConnections().map(({ name, status, error }) => ({ name, status, error })), [
    { name: "bad", status: "error", error: "missing url" },
  ]);
  await m.disconnectAll();
});

test("remote MCP requires HTTPS for every non-loopback transport", async () => {
  for (const spec of [
    { transport: "http", url: "http://example.com/mcp" },
    {
      transport: "http",
      url: "http://example.com/mcp",
      headers: { "X-Auth-Token": "secret" },
    },
    {
      transport: "http",
      url: "http://example.com/mcp",
      headers: { "X-Custom-Credential": "secret" },
    },
    { transport: "http", url: "http://user:secret@example.com/mcp" },
    { transport: "http", url: "http://example.com/mcp?token=secret" },
    { transport: "sse", url: "http://example.com/events" },
    { transport: "http", url: "http://127.example.com/mcp" },
    { transport: "http", url: "https://example.com/mcp?code=secret" },
    { transport: "http", url: "https://example.com/mcp#secret" },
  ]) {
    await assert.rejects(
      mod.createMcpTransport("unsafe", spec),
      /https|plaintext|credentials|query parameters|fragments/i,
    );
  }

  const local = await mod.createMcpTransport("local", {
    transport: "http",
    url: "http://127.0.0.1:3000/mcp",
    headers: { Authorization: "Bearer local" },
  });
  assert.equal(local.kind, "http");

  const secure = await mod.createMcpTransport("secure", {
    transport: "https",
    url: "https://example.com/mcp",
    headers: { "X-Custom-Credential": "secret" },
  });
  assert.equal(secure.kind, "http");

  const secureWithReviewedQuery = await mod.createMcpTransport("secure-query", {
    transport: "http",
    url: "https://example.com/mcp?user_id=operator",
    allowQuery: true,
  });
  assert.equal(secureWithReviewedQuery.kind, "http");

  await assert.rejects(
    mod.createMcpTransport("unsafe-fragment", {
      transport: "http",
      url: "https://example.com/mcp?user_id=operator#secret",
      allowQuery: true,
    }),
    /fragments/i,
  );
});
