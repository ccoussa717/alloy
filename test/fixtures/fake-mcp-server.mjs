#!/usr/bin/env node
/**
 * Minimal MCP stdio server for Alloy integration tests.
 * Tools:
 *   ping  → { pong: true, echo }
 *   echo  → echoes text
 *   env_probe → returns selected env keys (for scrub tests)
 *
 * Never logs secrets to stdout (MCP protocol only).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "alloy-fake-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Health check; returns pong",
      inputSchema: {
        type: "object",
        properties: {
          echo: { type: "string", description: "optional echo payload" },
        },
      },
    },
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    {
      name: "env_probe",
      description: "Report whether named env keys are set (names only, not values for secrets)",
      inputSchema: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "ping") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ pong: true, echo: args.echo ?? null }),
        },
      ],
    };
  }

  if (name === "echo") {
    return {
      content: [{ type: "text", text: String(args.text ?? "") }],
    };
  }

  if (name === "env_probe") {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    /** @type {Record<string, boolean>} */
    const present = {};
    for (const k of keys) {
      present[k] = process.env[k] != null && process.env[k] !== "";
    }
    // Also expose allowlisted non-secret values for PATH presence checks
    const safe = {};
    if (process.env.PATH) safe.PATH_set = true;
    if (process.env.ALLOY_FAKE_MARKER) safe.ALLOY_FAKE_MARKER = process.env.ALLOY_FAKE_MARKER;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ present, safe }),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
