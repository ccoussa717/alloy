/**
 * MCP server configuration loader.
 * Global: ~/.pi/alloy/mcp.json
 * Project: .pi/alloy-mcp.json (trusted projects only — caller enforces)
 */

import { existsSync } from "node:fs";
import {
  getAlloyMcpPath,
  getProjectMcpPath,
} from "./paths.mjs";
import { loadJson, saveJson } from "./config.mjs";

export const DEFAULT_MCP_CONFIG = {
  version: 1,
  servers: {
    // Example (disabled by default):
    // "filesystem": {
    //   "command": "npx",
    //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    //   "env": {},
    //   "enabled": false
    // }
  },
};

export function ensureMcpConfig() {
  const path = getAlloyMcpPath();
  if (!existsSync(path)) {
    saveJson(path, DEFAULT_MCP_CONFIG);
  }
  return path;
}

/**
 * @returns {{ version: number, servers: Record<string, McpServerSpec> }}
 */
export function loadMcpConfig(cwd = process.cwd(), { includeProject = true } = {}) {
  ensureMcpConfig();
  const global = loadJson(getAlloyMcpPath(), DEFAULT_MCP_CONFIG) || DEFAULT_MCP_CONFIG;
  const servers = { ...(global.servers || {}) };

  if (includeProject) {
    const projectPath = getProjectMcpPath(cwd);
    if (existsSync(projectPath)) {
      const project = loadJson(projectPath, {}) || {};
      Object.assign(servers, project.servers || {});
    }
  }

  return { version: 1, servers };
}

export function listMcpServers(cwd = process.cwd()) {
  const { servers } = loadMcpConfig(cwd);
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    enabled: spec?.enabled !== false,
    command: spec?.command || "",
    args: spec?.args || [],
    transport: spec?.transport || "stdio",
  }));
}
