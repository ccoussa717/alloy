/**
 * MCP stdio client manager for Alloy.
 * Connects enabled servers, lists tools, calls tools, disconnects cleanly.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * @typedef {{
 *   name: string,
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   enabled?: boolean,
 *   transport?: string,
 * }} McpServerSpec
 */

/**
 * Sanitize MCP tool names for Pi tool registry.
 * Pi/LLM tool names: [a-zA-Z0-9_]+ preferably.
 */
export function mcpToolName(serverName, toolName) {
  const s = String(serverName).replace(/[^a-zA-Z0-9_]+/g, "_");
  const t = String(toolName).replace(/[^a-zA-Z0-9_]+/g, "_");
  return `mcp_${s}_${t}`.slice(0, 64);
}

export function isMcpToolName(name) {
  return typeof name === "string" && name.startsWith("mcp_");
}

export class McpConnection {
  /**
   * @param {string} name
   * @param {McpServerSpec} spec
   */
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.status = "disconnected"; // disconnected | connecting | connected | error
    this.error = null;
  }

  async connect({ timeoutMs = 20000 } = {}) {
    if (this.status === "connected" && this.client) return this;
    this.status = "connecting";
    this.error = null;

    const command = this.spec.command;
    if (!command) {
      this.status = "error";
      this.error = "missing command";
      throw new Error(`MCP ${this.name}: missing command`);
    }

    const transport = new StdioClientTransport({
      command,
      args: Array.isArray(this.spec.args) ? this.spec.args : [],
      env: {
        ...process.env,
        ...(this.spec.env || {}),
      },
      stderr: "pipe",
      cwd: this.spec.cwd || process.cwd(),
    });

    const client = new Client(
      { name: "alloy", version: process.env.ALLOY_VERSION || "0.2.0" },
      { capabilities: {} },
    );

    const connectPromise = client.connect(transport);
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout after ${timeoutMs}ms`)), timeoutMs),
    );

    try {
      await Promise.race([connectPromise, timer]);
      const listed = await client.listTools();
      this.tools = listed?.tools || [];
      this.client = client;
      this.transport = transport;
      this.status = "connected";
      return this;
    } catch (err) {
      this.status = "error";
      this.error = err?.message || String(err);
      try {
        await client.close?.();
      } catch {
        // ignore
      }
      try {
        await transport.close?.();
      } catch {
        // ignore
      }
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  async callTool(toolName, args = {}, { timeoutMs = 60000 } = {}) {
    if (!this.client || this.status !== "connected") {
      throw new Error(`MCP ${this.name}: not connected`);
    }
    const call = this.client.callTool({ name: toolName, arguments: args });
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`tool timeout after ${timeoutMs}ms`)), timeoutMs),
    );
    return Promise.race([call, timer]);
  }

  async disconnect() {
    try {
      await this.client?.close?.();
    } catch {
      // ignore
    }
    try {
      await this.transport?.close?.();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.status = "disconnected";
    this.error = null;
  }
}

export class McpManager {
  constructor() {
    /** @type {Map<string, McpConnection>} */
    this.connections = new Map();
    /** @type {Map<string, { server: string, tool: string }>} */
    this.toolIndex = new Map();
  }

  /**
   * Connect all enabled servers from config map.
   * @param {Record<string, McpServerSpec>} servers
   */
  async connectEnabled(servers, { onProgress } = {}) {
    const results = [];
    for (const [name, spec] of Object.entries(servers || {})) {
      if (spec?.enabled === false) continue;
      if ((spec?.transport || "stdio") !== "stdio") {
        results.push({ name, ok: false, error: `unsupported transport: ${spec.transport}` });
        continue;
      }
      if (!spec?.command) {
        results.push({ name, ok: false, error: "missing command" });
        continue;
      }
      try {
        onProgress?.(`connecting ${name}…`);
        // Replace existing
        if (this.connections.has(name)) {
          await this.connections.get(name).disconnect();
          this.connections.delete(name);
        }
        const conn = new McpConnection(name, spec);
        await conn.connect();
        this.connections.set(name, conn);
        for (const tool of conn.tools) {
          const regName = mcpToolName(name, tool.name);
          this.toolIndex.set(regName, { server: name, tool: tool.name, schema: tool });
        }
        results.push({ name, ok: true, tools: conn.tools.length });
      } catch (err) {
        results.push({ name, ok: false, error: err?.message || String(err) });
      }
    }
    return results;
  }

  listConnections() {
    return [...this.connections.entries()].map(([name, c]) => ({
      name,
      status: c.status,
      error: c.error,
      tools: c.tools.map((t) => t.name),
      toolCount: c.tools.length,
    }));
  }

  getRegisteredTools() {
    const out = [];
    for (const [regName, meta] of this.toolIndex.entries()) {
      const conn = this.connections.get(meta.server);
      if (!conn || conn.status !== "connected") continue;
      out.push({
        registerName: regName,
        server: meta.server,
        tool: meta.tool,
        description: meta.schema?.description || "",
        inputSchema: meta.schema?.inputSchema || { type: "object", properties: {} },
      });
    }
    return out;
  }

  async callRegistered(registerName, args) {
    const meta = this.toolIndex.get(registerName);
    if (!meta) throw new Error(`Unknown MCP tool: ${registerName}`);
    const conn = this.connections.get(meta.server);
    if (!conn) throw new Error(`MCP server not connected: ${meta.server}`);
    return conn.callTool(meta.tool, args || {});
  }

  async disconnectAll() {
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }
    this.connections.clear();
    this.toolIndex.clear();
  }
}

/**
 * Convert JSON Schema (MCP) to a loose TypeBox-ish free-form object.
 * Pi tools need TypeBox schemas; for MCP we accept a generic object and
 * pass arguments through after light validation.
 */
export function jsonSchemaToLooseObject() {
  // Handled in extension with Type.Object({ ... Type.Optional(Type.Unknown()) })
  // or Type.Record. We use a passthrough object in the extension.
  return null;
}

/**
 * Format MCP CallToolResult content for the model.
 */
export function formatMcpResult(result) {
  if (!result) return "(empty MCP result)";
  const parts = [];
  if (result.isError) parts.push("[MCP error]");
  const content = result.content || [];
  for (const item of content) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "resource") {
      parts.push(`[resource ${item.resource?.uri || ""}] ${item.resource?.text || ""}`);
    } else if (item.type === "image") {
      parts.push(`[image ${item.mimeType || ""}]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (!parts.length && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n") || "(no content)";
}
