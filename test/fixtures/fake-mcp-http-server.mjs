#!/usr/bin/env node
/**
 * Minimal Streamable HTTP MCP server for Alloy integration tests.
 * Listens on PORT (default 0 = ephemeral); prints JSON { port, url } on stdout once ready.
 * Tools: ping, echo (same as stdio fixture).
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

function createAppServer() {
  const server = new McpServer(
    { name: "alloy-fake-mcp-http", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "ping",
    {
      description: "Health check; returns pong",
      inputSchema: {
        echo: z.string().optional().describe("optional echo payload"),
      },
    },
    async ({ echo }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ pong: true, echo: echo ?? null }),
        },
      ],
    }),
  );

  server.registerTool(
    "echo",
    {
      description: "Echo text back",
      inputSchema: {
        text: z.string().describe("text to echo"),
      },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: String(text ?? "") }],
    }),
  );

  return server;
}

const PORT = Number(process.env.PORT || 0);

const httpServer = createServer(async (req, res) => {
  // Auth probe for header tests
  if (req.headers["x-alloy-test-auth"] === "required") {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer test-token-ok") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  if (req.method === "POST" && req.url?.startsWith("/mcp")) {
    const mcp = createAppServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await mcp.connect(transport);
      // Parse body for transport
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      let body;
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          body = undefined;
        }
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: String(err?.message || err) },
            id: null,
          }),
        );
      }
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/mcp")) {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }),
    );
    return;
  }

  res.writeHead(404).end("not found");
});

httpServer.listen(PORT, "127.0.0.1", () => {
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  const info = {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    id: randomUUID(),
  };
  // Protocol line for parent test harness
  process.stdout.write(JSON.stringify(info) + "\n");
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
