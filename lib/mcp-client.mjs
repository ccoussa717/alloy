/**
 * MCP client manager for Alloy.
 * Transports: stdio | http (streamable HTTP) | sse (legacy).
 * Remote HTTP is first-class for operator-configured MCP gateways.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * @typedef {{
 *   name?: string,
 *   transport?: string,
 *   command?: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   url?: string,
 *   headers?: Record<string, string>,
 *   allowQuery?: boolean,
 *   enabled?: boolean,
 * }} McpServerSpec
 */

/** Env keys safe to forward to MCP stdio children by default. */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "COLORTERM",
  "NODE_ENV",
  "npm_config_cache",
];

/**
 * Expand ${VAR} and $VAR in strings (for headers/url without pasting secrets).
 * Missing env vars expand to empty string.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function expandEnvVars(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, bare) => {
      const key = braced || bare;
      const v = env[key];
      return v == null ? "" : String(v);
    },
  );
}

/**
 * @param {Record<string, string>|undefined|null} obj
 * @param {NodeJS.ProcessEnv} [env]
 */
export function expandEnvRecord(obj, env = process.env) {
  if (!obj || typeof obj !== "object") return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    out[k] = expandEnvVars(String(v), env);
  }
  return out;
}

/**
 * Normalize transport id.
 * - http | streamable-http | streamable_http → http (Streamable HTTP)
 * - sse → sse (legacy)
 * - stdio → stdio
 * - omitted: url without command → http; else stdio
 * @param {McpServerSpec} spec
 * @returns {'stdio'|'http'|'sse'}
 */
export function resolveMcpTransportKind(spec = {}) {
  const raw = String(spec.transport || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (
    raw === "http" ||
    raw === "streamable-http" ||
    raw === "streamablehttp" ||
    raw === "streamable"
  ) {
    return "http";
  }
  if (raw === "sse" || raw === "server-sent-events") return "sse";
  if (raw === "stdio" || raw === "std-io") return "stdio";
  if (!raw) {
    if (spec.url && !spec.command) return "http";
    return "stdio";
  }
  // Unknown explicit transport — treat as error at connect time via pass-through
  if (spec.url && !spec.command) return "http";
  return /** @type {'stdio'} */ (raw === "stdio" ? "stdio" : raw);
}

/**
 * Whether a server spec is connectable (enabled + has command or url).
 * @param {McpServerSpec} spec
 */
export function isMcpSpecConnectable(spec) {
  if (!spec || (spec.enabled !== undefined && spec.enabled !== true)) return false;
  const kind = resolveMcpTransportKind(spec);
  if (kind === "stdio") return Boolean(spec.command);
  if (kind === "http" || kind === "sse") return Boolean(spec.url || spec.command);
  return false;
}

/**
 * Build a scrubbed env for MCP stdio children.
 * Starts from allowlist ∩ process.env, then applies explicit spec.env.
 * Explicit spec.env values win (operator-configured secrets only via config file).
 */
export function buildMcpChildEnv(specEnv = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    if (process.env[key] != null && process.env[key] !== "") {
      out[key] = process.env[key];
    }
  }
  if (!out.PATH && process.env.PATH) out.PATH = process.env.PATH;

  if (specEnv && typeof specEnv === "object") {
    for (const [k, v] of Object.entries(specEnv)) {
      if (v == null) continue;
      if (k === "NODE_OPTIONS" && /require|import/.test(String(v))) continue;
      out[k] = expandEnvVars(String(v));
    }
  }
  return out;
}

/**
 * Sanitize MCP tool names for Pi tool registry.
 */
export function mcpToolName(serverName, toolName) {
  const s = String(serverName).replace(/[^a-zA-Z0-9_]+/g, "_");
  const t = String(toolName).replace(/[^a-zA-Z0-9_]+/g, "_");
  const hash = createHash("sha256")
    .update(`${serverName}\0${toolName}`)
    .digest("hex")
    .slice(0, 32);
  return `${`mcp_${s}_${t}`.slice(0, 31)}_${hash}`;
}

export function isMcpToolName(name) {
  return typeof name === "string" && name.startsWith("mcp_");
}

/**
 * Build requestInit.headers for remote transports.
 * @param {McpServerSpec} spec
 */
export function buildRemoteRequestInit(spec) {
  const headers = expandEnvRecord(spec.headers || {});
  // Also allow Authorization via env-only convenience: ALLOY_MCP_<NAME>_TOKEN is not
  // automatic — operator should put Authorization in headers with ${VAR}.
  return {
    redirect: "error",
    headers: {
      Accept: "application/json, text/event-stream",
      ...headers,
    },
  };
}

export function fetchWithoutRedirect(input, init = {}, fetchImpl = fetch) {
  return fetchImpl(input, { ...init, redirect: "error" });
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    (isIP(normalized) === 4 && normalized.split(".")[0] === "127") ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * Create an SDK transport for the given server spec.
 * @param {string} name
 * @param {McpServerSpec} spec
 */
export async function createMcpTransport(name, spec) {
  const kind = resolveMcpTransportKind(spec);

  if (kind === "stdio") {
    const command = spec.command;
    if (!command) {
      throw new Error(`MCP ${name}: stdio transport requires command`);
    }
    return {
      kind: "stdio",
      transport: new StdioClientTransport({
        command,
        args: Array.isArray(spec.args) ? spec.args : [],
        env: buildMcpChildEnv(spec.env || {}),
        stderr: "pipe",
        cwd: spec.cwd || process.cwd(),
      }),
    };
  }

  if (kind === "http" || kind === "sse") {
    const urlRaw = expandEnvVars(spec.url || "");
    if (!urlRaw) {
      throw new Error(
        `MCP ${name}: ${kind} transport requires url (e.g. https://host/mcp)`,
      );
    }
    let url;
    try {
      url = new URL(urlRaw);
    } catch {
      throw new Error(`MCP ${name}: invalid url after environment expansion`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `MCP ${name}: url must be http(s), got ${url.protocol}`,
      );
    }
    if (url.username || url.password) {
      throw new Error(`MCP ${name}: url must not contain credentials`);
    }
    if (url.hash) {
      throw new Error(
        `MCP ${name}: remote URLs must not contain fragments`,
      );
    }
    if (url.search && spec.allowQuery !== true) {
      throw new Error(
        `MCP ${name}: remote URL query parameters require allowQuery: true`,
      );
    }
    if (
      url.protocol === "http:" &&
      !isLoopbackHostname(url.hostname)
    ) {
      throw new Error(
        `MCP ${name}: non-loopback remote MCP requires HTTPS`,
      );
    }
    const requestInit = buildRemoteRequestInit(spec);
    const fetchImpl = (input, init) => fetchWithoutRedirect(input, init);
    if (kind === "sse") {
      return {
        kind: "sse",
        transport: new SSEClientTransport(url, { requestInit, fetch: fetchImpl }),
      };
    }
    return {
      kind: "http",
      transport: new StreamableHTTPClientTransport(url, {
        requestInit,
        fetch: fetchImpl,
      }),
    };
  }

  throw new Error(
    `MCP ${name}: unsupported transport "${spec.transport}" (use stdio, http, or sse)`,
  );
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
    /** @type {'stdio'|'http'|'sse'|null} */
    this.transportKind = null;
    this.tools = [];
    this.status = "disconnected"; // disconnected | connecting | connected | error
    this.error = null;
  }

  async connect({ timeoutMs = 20000, onStateChange } = {}) {
    if (this.status === "connected" && this.client) return this;
    this.status = "connecting";
    this.error = null;

    let transport;
    let kind;
    try {
      const created = await createMcpTransport(this.name, this.spec);
      transport = created.transport;
      kind = created.kind;
    } catch (err) {
      this.status = "error";
      this.error = err?.message || String(err);
      throw err;
    }

    const client = new Client(
      { name: "alloy", version: process.env.ALLOY_VERSION || "0.8.3" },
      { capabilities: {} },
    );

    const connectPromise = client.connect(transport);
    let connectTimer;
    const timer = new Promise((_, reject) => {
      connectTimer = setTimeout(
        () => reject(new Error(`connect timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      try {
        await Promise.race([connectPromise, timer]);
      } finally {
        clearTimeout(connectTimer);
      }
      const listed = await client.listTools();
      this.tools = listed?.tools || [];
      this.client = client;
      this.transport = transport;
      this.transportKind = kind;
      this.status = "connected";
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = null;
        this.transport = null;
        this.transportKind = null;
        this.tools = [];
        this.status = "error";
        this.error = "connection closed unexpectedly";
        onStateChange?.(this);
      };
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
      this.transportKind = null;
      throw err;
    }
  }

  async callTool(toolName, args = {}, { timeoutMs = 60000 } = {}) {
    if (!this.client || this.status !== "connected") {
      throw new Error(`MCP ${this.name}: not connected`);
    }
    const call = this.client.callTool({ name: toolName, arguments: args });
    let callTimer;
    const timer = new Promise((_, reject) => {
      callTimer = setTimeout(
        () => reject(new Error(`tool timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([call, timer]);
    } finally {
      clearTimeout(callTimer);
    }
  }

  async disconnect({ timeoutMs = 4000 } = {}) {
    const client = this.client;
    const transport = this.transport;
    const pid = transport?.pid ?? transport?._process?.pid ?? null;
    this.client = null;
    this.transport = null;
    this.transportKind = null;
    this.tools = [];
    this.status = "disconnected";
    this.error = null;
    const close = async () => {
      try {
        await client?.close?.();
      } catch {
        // ignore
      }
      try {
        await transport?.close?.();
      } catch {
        // ignore
      }
    };
    try {
      await Promise.race([
        close(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          t.unref?.();
        }),
      ]);
    } catch {
      // ignore
    }
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

export class McpManager {
  constructor() {
    /** @type {Map<string, McpConnection>} */
    this.connections = new Map();
    /** @type {Map<string, { server: string, tool: string, schema?: object }>} */
    this.toolIndex = new Map();
  }

  /**
   * Connect all enabled servers from config map.
   * @param {Record<string, McpServerSpec>} servers
   */
  async connectEnabled(servers, { onProgress, onStateChange } = {}) {
    const results = [];
    for (const [name, spec] of Object.entries(servers || {})) {
      if (spec?.enabled !== undefined && spec?.enabled !== true) continue;
      if (this.connections.has(name)) {
        await this.connections.get(name).disconnect();
        this.connections.delete(name);
      }
      for (const [reg, meta] of [...this.toolIndex.entries()]) {
        if (meta.server === name) this.toolIndex.delete(reg);
      }
      const conn = new McpConnection(name, spec);
      this.connections.set(name, conn);
      if (!isMcpSpecConnectable(spec)) {
        const kind = resolveMcpTransportKind(spec || {});
        const error =
          kind === "stdio"
            ? "missing command"
            : kind === "http" || kind === "sse"
              ? "missing url"
              : `unsupported or incomplete transport: ${spec?.transport || kind}`;
        conn.status = "error";
        conn.error = error;
        onStateChange?.(this.listConnections());
        results.push({
          name,
          ok: false,
          error,
        });
        continue;
      }
      try {
        const kind = resolveMcpTransportKind(spec);
        onProgress?.(
          kind === "stdio"
            ? `connecting ${name} (stdio)…`
            : `connecting ${name} (${kind})…`,
        );
        const connecting = conn.connect({
          onStateChange: () => {
            if (conn.status !== "connected") {
              for (const [reg, meta] of [...this.toolIndex.entries()]) {
                if (meta.server === name) this.toolIndex.delete(reg);
              }
            }
            onStateChange?.(this.listConnections());
          },
        });
        onStateChange?.(this.listConnections());
        await connecting;
        const registrations = [];
        const seen = new Set();
        for (const tool of conn.tools) {
          const regName = mcpToolName(name, tool.name);
          const existing = this.toolIndex.get(regName);
          if (
            seen.has(regName) ||
            (existing && (existing.server !== name || existing.tool !== tool.name))
          ) {
            await conn.disconnect();
            throw new Error(`MCP tool registration collision: ${regName}`);
          }
          seen.add(regName);
          registrations.push([regName, {
            server: name,
            tool: tool.name,
            schema: tool,
          }]);
        }
        for (const [regName, meta] of registrations) {
          this.toolIndex.set(regName, meta);
        }
        onStateChange?.(this.listConnections());
        results.push({
          name,
          ok: true,
          tools: conn.tools.length,
          transport: conn.transportKind,
        });
      } catch (err) {
        conn.status = "error";
        conn.error = err?.message || String(err);
        onStateChange?.(this.listConnections());
        results.push({ name, ok: false, error: conn.error });
      }
    }
    return results;
  }

  listConnections() {
    return [...this.connections.entries()].map(([name, c]) => ({
      name,
      status: c.status,
      error: c.error,
      transport: c.transportKind || resolveMcpTransportKind(c.spec),
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
        inputSchema:
          meta.schema?.inputSchema || { type: "object", properties: {} },
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

  async disconnectAll({ timeoutMs = 5000 } = {}) {
    const conns = [...this.connections.values()];
    await Promise.all(
      conns.map((conn) =>
        conn.disconnect({ timeoutMs }).catch(() => undefined),
      ),
    );
    this.connections.clear();
    this.toolIndex.clear();
  }
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
      parts.push(
        `[resource ${item.resource?.uri || ""}] ${item.resource?.text || ""}`,
      );
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
