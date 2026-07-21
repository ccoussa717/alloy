/**
 * Alloy filesystem layout.
 *
 * Global:
 *   ~/.pi/alloy/
 *     config.json
 *     mcp.json
 *     memory/user/
 *     memory/projects/<project-id>/
 *     skills-drafts/
 *     runs/
 *
 * Project (trusted):
 *   .pi/alloy.json
 *   .pi/alloy-mcp.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getAlloyHome() {
  const home = process.env.ALLOY_HOME || join(homedir(), ".pi", "alloy");
  ensureDir(home);
  return home;
}

export function getAlloyConfigPath() {
  return join(getAlloyHome(), "config.json");
}

export function getAlloyMcpPath() {
  return join(getAlloyHome(), "mcp.json");
}

export function getUserMemoryDir() {
  const dir = join(getAlloyHome(), "memory", "user");
  ensureDir(dir);
  return dir;
}

export function projectIdFromCwd(cwd = process.cwd()) {
  const abs = resolve(cwd);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 12);
  const base = abs.split(/[/\\]/).filter(Boolean).pop() || "root";
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
  return `${safe}-${hash}`;
}

export function getProjectMemoryDir(cwd = process.cwd()) {
  const dir = join(getAlloyHome(), "memory", "projects", projectIdFromCwd(cwd));
  ensureDir(dir);
  return dir;
}

export function getSkillDraftsDir() {
  const dir = join(getAlloyHome(), "skills-drafts");
  ensureDir(dir);
  return dir;
}

export function getRunsDir() {
  const dir = join(getAlloyHome(), "runs");
  ensureDir(dir);
  return dir;
}

export function getUserSkillsDir() {
  const dir = join(getPiAgentDir(), "skills");
  ensureDir(dir);
  return dir;
}

export function getProjectAlloyConfigPath(cwd = process.cwd()) {
  return join(cwd, ".pi", "alloy.json");
}

export function getProjectMcpPath(cwd = process.cwd()) {
  return join(cwd, ".pi", "alloy-mcp.json");
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
