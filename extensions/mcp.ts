/**
 * Live MCP adapter: connect stdio servers, register tools on the agent.
 * Policy: MCP tools go through the same tool_call gate (readonly blocks mutating MCP names).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { listMcpServers, loadMcpConfig, ensureMcpConfig } = require(
  join(root, "lib", "mcp-config.mjs"),
);
const { getAlloyMcpPath, getProjectMcpPath } = require(
  join(root, "lib", "paths.mjs"),
);
const {
  McpManager,
  formatMcpResult,
  isMcpToolName,
} = require(join(root, "lib", "mcp-client.mjs"));
const { setMcpStats } = require(join(root, "lib", "state.mjs"));
const { loadConfig } = require(join(root, "lib", "config.mjs"));

type ServerRow = {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  transport: string;
};

/** Shared manager for this process */
const manager = new McpManager();
const registeredNames = new Set<string>();

function jsonSchemaToTypeBox(schema: Record<string, unknown> | undefined) {
  // Accept any object args — MCP validates on the server side.
  // Prefer listing property keys as optional unknowns when present.
  const props = (schema?.properties || {}) as Record<string, unknown>;
  const keys = Object.keys(props);
  if (!keys.length) {
    return Type.Object(
      {},
      { additionalProperties: true, description: "MCP tool arguments" },
    );
  }
  const shape: Record<string, unknown> = {};
  for (const k of keys) {
    shape[k] = Type.Optional(Type.Any({ description: `MCP arg: ${k}` }));
  }
  return Type.Object(shape, { additionalProperties: true });
}

function registerToolsFromManager(pi: ExtensionAPI) {
  const tools = manager.getRegisteredTools();
  let added = 0;
  for (const t of tools) {
    if (registeredNames.has(t.registerName)) continue;
    registeredNames.add(t.registerName);
    const server = t.server;
    const tool = t.tool;
    const desc =
      t.description || `MCP tool ${tool} from server ${server}`;

    pi.registerTool({
      name: t.registerName,
      label: `MCP ${server}/${tool}`,
      description: `${desc} (via MCP server "${server}")`,
      promptSnippet: `MCP ${server}/${tool}`,
      parameters: jsonSchemaToTypeBox(t.inputSchema as Record<string, unknown>),
      async execute(_id, params) {
        try {
          const result = await manager.callRegistered(t.registerName, params);
          const text = formatMcpResult(result);
          return {
            content: [{ type: "text", text }],
            details: { server, tool, isError: Boolean(result?.isError) },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `MCP call failed (${server}/${tool}): ${(err as Error).message || err}`,
              },
            ],
            details: { server, tool, error: true },
          };
        }
      },
    });
    added++;
  }
  setMcpStats({
    connected: manager.listConnections().some((c: { status: string }) => c.status === "connected"),
    toolCount: manager.getRegisteredTools().length,
  });
  return { added, total: manager.getRegisteredTools().length };
}

async function connectAll(pi: ExtensionAPI, ctx?: { ui?: { notify?: Function; setStatus?: Function } }) {
  ensureMcpConfig();
  const { servers } = loadMcpConfig(process.cwd());
  const enabled = Object.entries(servers).filter(([, s]) => s && s.enabled !== false && s.command);
  if (!enabled.length) {
    return { results: [], message: "No enabled MCP servers in config." };
  }

  const results = await manager.connectEnabled(Object.fromEntries(enabled), {
    onProgress: (msg: string) => ctx?.ui?.notify?.(msg, "info"),
  });
  const reg = registerToolsFromManager(pi);
  const ok = results.filter((r: { ok: boolean }) => r.ok).length;
  const fail = results.filter((r: { ok: boolean }) => !r.ok);
  ctx?.ui?.setStatus?.(
    "alloy-mcp",
    `mcp:${ok}/${results.length} t:${reg.total}`,
  );
  return { results, reg, ok, fail };
}

export function registerMcp(pi: ExtensionAPI) {
  ensureMcpConfig();

  pi.registerCommand("mcp", {
    description:
      "MCP: /mcp [list|status|connect|disconnect|reload|path]",
    handler: async (args, ctx) => {
      const parts = (args || "list").trim().split(/\s+/);
      const cmd = parts[0] || "list";
      const servers: ServerRow[] = listMcpServers(process.cwd());

      if (cmd === "path") {
        ctx.ui.notify(
          `Global: ${getAlloyMcpPath()}\nProject: ${getProjectMcpPath(process.cwd())}`,
          "info",
        );
        return;
      }

      if (cmd === "disconnect") {
        await manager.disconnectAll();
        setMcpStats({ connected: false, toolCount: 0 });
        ctx.ui.setStatus("alloy-mcp", "mcp:off");
        ctx.ui.notify("Disconnected all MCP servers.", "info");
        return;
      }

      if (cmd === "connect" || cmd === "reload") {
        if (cmd === "reload") {
          await manager.disconnectAll();
          // Note: Pi cannot unregister tools; reload reconnects and registers any new names
        }
        ctx.ui.notify("Connecting MCP servers…", "info");
        const { results, reg, ok, fail } = await connectAll(pi, ctx);
        const lines = (results || []).map(
          (r: { name: string; ok: boolean; tools?: number; error?: string }) =>
            r.ok
              ? `✓ ${r.name}  (${r.tools} tools)`
              : `✗ ${r.name}  ${r.error}`,
        );
        lines.push("---");
        lines.push(`Registered tools this session: ${reg?.total ?? 0} (+${reg?.added ?? 0} new)`);
        if (!lines.length) {
          ctx.ui.notify("No servers to connect. Edit mcp.json and enable servers.", "warning");
          return;
        }
        await ctx.ui.select(`MCP connect (${ok} ok, ${fail?.length || 0} failed)`, lines);
        return;
      }

      if (cmd === "status" || cmd === "list") {
        const live = manager.listConnections();
        if (!servers.length && !live.length) {
          ctx.ui.notify(
            [
              "No MCP servers configured.",
              `Edit ${getAlloyMcpPath()}`,
              "Then: /mcp connect",
              "",
              "Example:",
              '{ "servers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "enabled": true } } }',
            ].join("\n"),
            "info",
          );
          return;
        }
        const items: string[] = [];
        for (const s of servers) {
          const conn = live.find((c: { name: string }) => c.name === s.name);
          const state = conn
            ? `${conn.status} tools=${conn.toolCount}`
            : s.enabled
              ? "configured (not connected — /mcp connect)"
              : "disabled";
          items.push(
            `${s.enabled ? "●" : "○"} ${s.name}  ${state}  ${s.command} ${(s.args || []).join(" ")}`,
          );
        }
        for (const t of manager.getRegisteredTools().slice(0, 40)) {
          items.push(`  tool: ${t.registerName}`);
        }
        if (manager.getRegisteredTools().length > 40) {
          items.push(`  … +${manager.getRegisteredTools().length - 40} more tools`);
        }
        await ctx.ui.select(`MCP (${servers.length} configured)`, items);
        return;
      }

      ctx.ui.notify(
        "Usage: /mcp list|status|connect|disconnect|reload|path",
        "warning",
      );
    },
  });

  pi.registerTool({
    name: "alloy_mcp_list",
    label: "Alloy MCP List",
    description:
      "List configured and connected Alloy MCP servers and their tools.",
    promptSnippet: "List MCP servers and tools",
    parameters: Type.Object({}),
    async execute() {
      const servers: ServerRow[] = listMcpServers(process.cwd());
      const live = manager.listConnections();
      const tools = manager.getRegisteredTools();
      const text = [
        "## Configured",
        ...servers.map(
          (s) =>
            `- ${s.name}: enabled=${s.enabled} cmd=${s.command} ${(s.args || []).join(" ")}`,
        ),
        "",
        "## Connected",
        ...(live.length
          ? live.map(
              (c: { name: string; status: string; toolCount: number; error?: string }) =>
                `- ${c.name}: ${c.status} tools=${c.toolCount}${c.error ? ` err=${c.error}` : ""}`,
            )
          : ["- (none — user should run /mcp connect)"]),
        "",
        "## Tools",
        ...(tools.length
          ? tools.map((t: { registerName: string; description: string }) =>
              `- ${t.registerName}: ${t.description.slice(0, 100)}`,
            )
          : ["- (none)"]),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { servers, live, tools } };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const servers: ServerRow[] = listMcpServers(process.cwd());
      const enabled = servers.filter((s) => s.enabled).length;
      if (servers.length) {
        ctx.ui.setStatus("alloy-mcp", `mcp:cfg ${enabled}/${servers.length}`);
      }
      loadMcpConfig(process.cwd());

      const cfg = loadConfig();
      if (cfg.mcp?.connectOnStart && enabled > 0) {
        ctx.ui.notify("Auto-connecting MCP servers…", "info");
        await connectAll(pi, ctx);
      }
    } catch {
      // ignore
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await manager.disconnectAll();
    } catch {
      // ignore
    }
  });
}

export function getMcpManager() {
  return manager;
}

export { isMcpToolName };
