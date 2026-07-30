/**
 * MCP server configuration loader with a project trust boundary.
 * Global: ~/.pi/alloy/mcp.json  (always available)
 * Project: .pi/alloy-mcp.json  (trusted projects only)
 *
 * Project MCP servers never auto-connect; operator must /mcp connect.
 */

import { existsSync } from "node:fs";
import {
  getAlloyMcpPath,
  getProjectMcpPath,
} from "./paths.mjs";
import { loadJson, saveJson } from "./config.mjs";
import { isProjectTrusted } from "./project-trust.mjs";

export const DEFAULT_MCP_CONFIG = {
  version: 1,
  servers: {},
};

export function ensureMcpConfig() {
  const path = getAlloyMcpPath();
  if (!existsSync(path)) {
    saveJson(path, DEFAULT_MCP_CONFIG);
  }
  return path;
}

/**
 * @param {string} [cwd]
 * @param {{ includeProject?: boolean, trusted?: boolean }} [opts]
 * @returns {{ version: number, servers: Record<string, object>, sources: Record<string, 'global'|'project'> }}
 */
export function loadMcpConfig(cwd = process.cwd(), opts = {}) {
  ensureMcpConfig();
  const global = loadJson(getAlloyMcpPath(), DEFAULT_MCP_CONFIG) || DEFAULT_MCP_CONFIG;
  /** @type {Record<string, object>} */
  const servers = { ...(global.servers || {}) };
  /** @type {Record<string, 'global'|'project'>} */
  const sources = {};
  for (const name of Object.keys(servers)) sources[name] = "global";

  const includeProject =
    opts.includeProject !== undefined
      ? opts.includeProject
      : opts.trusted !== undefined
        ? Boolean(opts.trusted)
        : isProjectTrusted(cwd);

  if (includeProject) {
    const projectPath = getProjectMcpPath(cwd);
    if (existsSync(projectPath)) {
      const project = loadJson(projectPath, {}) || {};
      for (const [name, spec] of Object.entries(project.servers || {})) {
        // Project servers are tagged; never inherit connectOnStart semantics
        servers[name] = {
          ...spec,
          // force disabled-at-start semantics for project servers
          _alloySource: "project",
        };
        sources[name] = "project";
      }
    }
  }

  return { version: 1, servers, sources };
}

export function isMcpServerEnabled(spec) {
  return spec?.enabled === undefined || spec?.enabled === true;
}

/**
 * Servers eligible for connectOnStart: global only, enabled, never project.
 * Stdio needs command; http/sse need url (transport defaults to http when url-only).
 */
export function listAutoConnectServers(cwd = process.cwd()) {
  const { servers, sources } = loadMcpConfig(cwd, { includeProject: false });
  return Object.entries(servers)
    .filter(([name, spec]) => {
      if (sources[name] === "project") return false;
      if (spec?._alloySource === "project") return false;
      if (!isMcpServerEnabled(spec)) return false;
      // remote (url) or local stdio (command)
      return Boolean(spec?.url || spec?.command);
    })
    .map(([name, spec]) => ({ name, spec }));
}

export function listMcpServers(cwd = process.cwd(), opts = {}) {
  const { servers, sources } = loadMcpConfig(cwd, opts);
  return Object.entries(servers).map(([name, spec]) => {
    const transport =
      spec?.transport ||
      (spec?.url && !spec?.command ? "http" : "stdio");
    return {
      name,
      enabled: isMcpServerEnabled(spec),
      command: spec?.command || "",
      args: spec?.args || [],
      url: spec?.url || "",
      transport,
      source:
        sources[name] ||
        (spec?._alloySource === "project" ? "project" : "global"),
    };
  });
}
