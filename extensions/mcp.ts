/**
 * Live MCP adapter: connect stdio + HTTP (streamable) + SSE servers,
 * register tools on the agent.
 * Policy: MCP tools go through the same tool_call gate (readonly blocks mutating MCP names).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  listMcpServers,
  loadMcpConfig,
  ensureMcpConfig,
  listAutoConnectServers,
} = require(join(root, "lib", "mcp-config.mjs"));
const { getAlloyMcpPath, getProjectMcpPath } = require(
  join(root, "lib", "paths.mjs"),
);
const {
  McpManager,
  formatMcpResult,
  isMcpToolName,
} = require(join(root, "lib", "mcp-client.mjs"));
const { loadAlloyEnvFile } = require(join(root, "lib", "alloy-env.mjs"));
const { setMcpStats } = require(join(root, "lib", "state.mjs"));
const { loadConfig, loadGlobalConfig } = require(join(root, "lib", "config.mjs"));
const { setRuntimeProjectTrust, isProjectTrusted } = require(
  join(root, "lib", "project-trust.mjs"),
);

type ServerRow = {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  url?: string;
  transport: string;
};

/**
 * Process-wide manager. Pi may re-evaluate extension modules; keep one
 * McpManager so /mcp connect and /mcp list share connection state.
 */
const g = globalThis as typeof globalThis & {
  __alloyMcpManager?: InstanceType<typeof McpManager>;
  __alloyMcpRegisteredTools?: Set<string>;
};
if (!g.__alloyMcpManager) g.__alloyMcpManager = new McpManager();
if (!g.__alloyMcpRegisteredTools) g.__alloyMcpRegisteredTools = new Set();
const manager = g.__alloyMcpManager;
const registeredNames = g.__alloyMcpRegisteredTools;

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

function isConnectableSpec(s: {
  enabled?: boolean;
  command?: string;
  url?: string;
} | null) {
  if (!s || s.enabled === false) return false;
  return Boolean(s.command || s.url);
}

async function connectAll(pi: ExtensionAPI, ctx?: { ui?: { notify?: Function; setStatus?: Function } }) {
  // Ensure MCP ${ENV} secrets are present even if launcher did not load them
  loadAlloyEnvFile({ force: true });
  ensureMcpConfig();
  const { servers } = loadMcpConfig(process.cwd());
  const enabled = Object.entries(servers).filter(([, s]) =>
    isConnectableSpec(s as { enabled?: boolean; command?: string; url?: string }),
  );
  if (!enabled.length) {
    return {
      results: [] as Array<{
        name: string;
        ok: boolean;
        tools?: number;
        error?: string;
        transport?: string;
      }>,
      reg: { added: 0, total: 0 },
      ok: 0,
      fail: [] as Array<{ name: string; ok: boolean; error?: string }>,
      message:
        "No enabled MCP servers in config (need command for stdio or url for http/sse).",
    };
  }

  // Quiet by default — no per-server progress toasts
  const results = await manager.connectEnabled(Object.fromEntries(enabled));
  const reg = registerToolsFromManager(pi);
  const ok = results.filter((r: { ok: boolean }) => r.ok).length;
  const fail = results.filter((r: { ok: boolean }) => !r.ok);
  // Compact status: mcp:name×tools or mcp:2/2 t:34
  let status = `mcp:off`;
  if (ok > 0) {
    const live = manager.listConnections().filter(
      (c: { status: string }) => c.status === "connected",
    );
    if (live.length === 1) {
      status = `mcp:${live[0].name}·${live[0].toolCount}`;
    } else {
      status = `mcp:${ok}/${results.length}·${reg.total}`;
    }
  } else if (results.length) {
    status = `mcp:fail`;
  }
  ctx?.ui?.setStatus?.("alloy-mcp", status);
  return { results, reg, ok, fail, message: undefined as string | undefined };
}

export function registerMcp(pi: ExtensionAPI) {
  ensureMcpConfig();

  pi.registerCommand("mcp", {
    description:
      "MCP: /mcp [list|status|tools|connect|disconnect|reload|path]",
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
        ctx.ui.notify("MCP disconnected", "info");
        return;
      }

      if (cmd === "connect" || cmd === "reload") {
        if (cmd === "reload") {
          await manager.disconnectAll();
        }
        const { results, reg, ok, fail, message } = await connectAll(pi, ctx);
        if (message && !(results || []).length) {
          ctx.ui.notify(message, "warning");
          return;
        }
        // One short line — no modal, no tool dump
        if (ok > 0 && !(fail?.length)) {
          const bits = (results || [])
            .filter((r: { ok: boolean }) => r.ok)
            .map(
              (r: { name: string; tools?: number }) =>
                `${r.name}·${r.tools ?? 0}`,
            );
          ctx.ui.notify(`MCP ${bits.join(", ")}`, "info");
        } else {
          ctx.ui.notify(
            `MCP connect: ${ok} ok, ${fail?.length || 0} failed`,
            ok > 0 ? "info" : "warning",
          );
          for (const f of fail || []) {
            ctx.ui.notify(
              `${f.name}: ${(f as { error?: string }).error || "failed"}`,
              "warning",
            );
          }
        }
        void reg;
        return;
      }

      // Explicit tool dump only when asked
      if (cmd === "tools") {
        const tools = manager.getRegisteredTools();
        if (!tools.length) {
          ctx.ui.notify("No MCP tools — /mcp connect first", "info");
          return;
        }
        const items = tools.map(
          (t: { registerName: string; description: string }) =>
            `${t.registerName}${t.description ? `  — ${t.description.slice(0, 60)}` : ""}`,
        );
        await ctx.ui.select(`MCP tools (${tools.length})`, items);
        return;
      }

      if (cmd === "status" || cmd === "list") {
        const live = manager.listConnections();
        if (!servers.length && !live.length) {
          ctx.ui.notify(
            `No MCP servers. Edit ${getAlloyMcpPath()} then /mcp connect`,
            "info",
          );
          return;
        }
        // Compact: one line per server — name + status + tool count (no tool names)
        const items: string[] = [];
        for (const s of servers) {
          const conn = live.find((c: { name: string }) => c.name === s.name);
          if (conn && conn.status === "connected") {
            items.push(
              `● ${s.name}  ${conn.toolCount} tools  [${conn.transport || s.transport}]`,
            );
          } else if (s.enabled) {
            items.push(`○ ${s.name}  not connected  [${s.transport}]`);
          } else {
            items.push(`○ ${s.name}  disabled  [${s.transport}]`);
          }
        }
        // Also show live servers not in config (shouldn't happen often)
        for (const c of live) {
          if (!servers.some((s) => s.name === c.name) && c.status === "connected") {
            items.push(`● ${c.name}  ${c.toolCount} tools  [${c.transport || "?"}]`);
          }
        }
        items.push("—  /mcp tools for full tool list");
        await ctx.ui.select(`MCP (${servers.length})`, items);
        return;
      }

      ctx.ui.notify(
        "Usage: /mcp list|status|tools|connect|disconnect|reload|path",
        "warning",
      );
    },
  });

  pi.registerTool({
    name: "alloy_mcp_list",
    label: "Alloy MCP List",
    description:
      "Summarize Alloy MCP servers (name, status, tool counts). Set includeTools=true only when the user asks for tool names.",
    promptSnippet: "List MCP servers (summary)",
    parameters: Type.Object({
      includeTools: Type.Optional(
        Type.Boolean({
          description:
            "If true, include every registered tool name. Default false.",
        }),
      ),
    }),
    async execute(_id, params: { includeTools?: boolean }) {
      const servers: ServerRow[] = listMcpServers(process.cwd());
      const live = manager.listConnections();
      const tools = manager.getRegisteredTools();
      const lines: string[] = ["## MCP servers"];
      if (!servers.length && !live.length) {
        lines.push("- (none configured)");
      }
      for (const s of servers) {
        const conn = live.find((c: { name: string }) => c.name === s.name);
        if (conn && conn.status === "connected") {
          lines.push(
            `- ${s.name}: connected, ${conn.toolCount} tools [${conn.transport || s.transport}]`,
          );
        } else {
          lines.push(
            `- ${s.name}: ${s.enabled ? "not connected" : "disabled"} [${s.transport}]`,
          );
        }
      }
      lines.push(`Total tools registered: ${tools.length}`);
      if (params?.includeTools && tools.length) {
        lines.push("", "## Tools");
        for (const t of tools) {
          lines.push(`- ${t.registerName}`);
        }
      } else if (tools.length) {
        lines.push("(Pass includeTools=true or user runs /mcp tools for names.)");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          servers,
          live,
          toolCount: tools.length,
          tools: params?.includeTools ? tools : undefined,
        },
      };
    },
  });

  // Sync Alloy trust with Pi's authoritative project trust
  pi.on("project_trust", async (event) => {
    // Do not own the decision — only observe if Pi already resolved later.
    // Returning undecided lets Pi / other handlers decide.
    try {
      // event.cwd available; trust not yet final. Leave undecided.
      void event;
    } catch {
      // ignore
    }
    return { trusted: "undecided" as const };
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Secrets for HTTP MCP (${TOKEN}) — also done in launcher
      loadAlloyEnvFile({ force: true });

      // Authoritative trust from Pi session
      try {
        const trusted =
          typeof ctx.isProjectTrusted === "function"
            ? Boolean(ctx.isProjectTrusted())
            : isProjectTrusted(ctx.cwd || process.cwd());
        setRuntimeProjectTrust(ctx.cwd || process.cwd(), trusted);
      } catch {
        // fail closed remains default
      }

      const cwd = process.cwd();
      const servers: ServerRow[] = listMcpServers(cwd);
      const enabled = servers.filter((s) => s.enabled).length;
      if (servers.length) {
        ctx.ui.setStatus("alloy-mcp", `mcp:cfg ${enabled}/${servers.length}`);
      }
      loadMcpConfig(cwd);

      // connectOnStart: GLOBAL servers only. One quiet status line on success.
      const globalCfg = loadGlobalConfig();
      if (globalCfg.mcp?.connectOnStart) {
        const auto = listAutoConnectServers(cwd);
        if (auto.length > 0) {
          const { results, reg, ok, fail } = await connectAll(pi, ctx);
          const failN = fail?.length || 0;
          if (ok > 0 && failN === 0) {
            const bits = (results || [])
              .filter((r: { ok: boolean }) => r.ok)
              .map(
                (r: { name: string; tools?: number }) =>
                  `${r.name}·${r.tools ?? 0}`,
              );
            // Single compact toast — matches footer status, no tool dump
            ctx.ui.notify(`MCP ${bits.join(", ")}`, "info");
          } else if (failN > 0) {
            ctx.ui.notify(
              `MCP: ${ok} ok, ${failN} failed`,
              ok > 0 ? "info" : "warning",
            );
            for (const f of fail || []) {
              ctx.ui.notify(
                `${f.name}: ${(f as { error?: string }).error || "failed"}`,
                "warning",
              );
            }
          }
          void reg;
        }
      }
    } catch (err) {
      try {
        ctx.ui.notify(
          `MCP: ${(err as Error)?.message || err}`,
          "warning",
        );
      } catch {
        // ignore
      }
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
