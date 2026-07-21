/**
 * MCP adapter scaffold.
 *
 * MVP:
 * - Load ~/.pi/alloy/mcp.json and project .pi/alloy-mcp.json
 * - /mcp list|status|reload
 * - Register placeholder tools for enabled servers (full stdio client is next iteration)
 *
 * Design rule: MCP tools must eventually share the same approval/path policy as native tools.
 * Full JSON-RPC stdio client lands after this scaffold is daily-driver stable.
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

type ServerRow = {
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  transport: string;
};

export function registerMcp(pi: ExtensionAPI) {
  ensureMcpConfig();

  pi.registerCommand("mcp", {
    description: "MCP servers: /mcp [list|status|reload|path]",
    handler: async (args, ctx) => {
      const cmd = (args || "list").trim().split(/\s+/)[0] || "list";
      const servers: ServerRow[] = listMcpServers(process.cwd());

      if (cmd === "path") {
        ctx.ui.notify(
          `Global: ${getAlloyMcpPath()}\nProject: ${getProjectMcpPath(process.cwd())}`,
          "info",
        );
        return;
      }

      if (cmd === "reload") {
        ensureMcpConfig();
        const again = listMcpServers(process.cwd());
        ctx.ui.notify(
          `Reloaded MCP config. ${again.length} server(s) defined.`,
          "info",
        );
        return;
      }

      if (cmd === "status" || cmd === "list") {
        if (!servers.length) {
          ctx.ui.notify(
            [
              "No MCP servers configured.",
              `Edit ${getAlloyMcpPath()}`,
              "Example server block:",
              '{ "servers": { "example": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "enabled": true } } }',
              "",
              "Full stdio tool bridging is scaffolded next; config + discovery works now.",
            ].join("\n"),
            "info",
          );
          return;
        }
        const items = servers.map(
          (s) =>
            `${s.enabled ? "●" : "○"} ${s.name}  ${s.command} ${(s.args || []).join(" ")}`,
        );
        items.push("---");
        items.push("● enabled  ○ disabled");
        items.push("Tool bridging: scaffold (see README)");
        await ctx.ui.select(`MCP servers (${servers.length})`, items);
        return;
      }

      ctx.ui.notify("Usage: /mcp list | status | reload | path", "warning");
    },
  });

  // Discovery tool so the model can see configured servers even before live bridging
  pi.registerTool({
    name: "alloy_mcp_list",
    label: "Alloy MCP List",
    description:
      "List configured Alloy MCP servers (from mcp.json). Does not start servers.",
    promptSnippet: "List configured MCP servers",
    parameters: Type.Object({}),
    async execute() {
      const servers: ServerRow[] = listMcpServers(process.cwd());
      const text =
        servers.length === 0
          ? "No MCP servers configured."
          : servers
              .map(
                (s) =>
                  `- ${s.name}: enabled=${s.enabled} cmd=${s.command} ${(s.args || []).join(" ")}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { servers },
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      const servers: ServerRow[] = listMcpServers(process.cwd());
      const enabled = servers.filter((s) => s.enabled).length;
      if (servers.length) {
        ctx.ui.setStatus("alloy-mcp", `mcp:${enabled}/${servers.length}`);
      }
      // Warm-load config so path exists
      loadMcpConfig(process.cwd());
    } catch {
      // ignore
    }
  });
}
