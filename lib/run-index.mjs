/**
 * Append-only run index for multi-agent workflows.
 * Path: ~/.pi/alloy/runs/index.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRunsDir, projectIdFromCwd } from "./paths.mjs";
import { resolveAgentIdentity } from "./identity.mjs";

export function getRunIndexPath() {
  return join(getRunsDir(), "index.jsonl");
}

/**
 * @param {object} entry
 */
export function recordRun(entry = {}) {
  const identity = resolveAgentIdentity();
  const record = {
    ts: new Date().toISOString(),
    agentId: identity.id,
    org: identity.org,
    kind: entry.kind || "unknown",
    projectId: entry.projectId || projectIdFromCwd(entry.cwd || process.cwd()),
    cwd: entry.cwd || process.cwd(),
    runId: entry.runId || null,
    runDir: entry.runDir || null,
    status: entry.status || null,
    pass: entry.pass ?? null,
    error: entry.error || null,
    cost: typeof entry.cost === "number" ? entry.cost : null,
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : undefined,
  };
  const path = getRunIndexPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

/**
 * @param {{ limit?: number, kind?: string, agentId?: string }} [opts]
 */
export function listRuns(opts = {}) {
  const path = getRunIndexPath();
  if (!existsSync(path)) return [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const rows = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (opts.kind && row.kind !== opts.kind) continue;
      if (opts.agentId && row.agentId !== opts.agentId) continue;
      rows.push(row);
    } catch {
      // skip corrupt lines
    }
  }
  return rows;
}

export function formatRunIndexLines(rows = []) {
  if (!rows.length) return ["No runs recorded yet."];
  return rows.map((row) => {
    const pass =
      row.pass === true ? "pass" : row.pass === false ? "fail" : "—";
    return [
      row.ts || "?",
      row.agentId || "?",
      row.kind || "?",
      row.status || "?",
      pass,
      row.runId || "?",
      row.error ? `err=${row.error}` : "",
    ]
      .filter(Boolean)
      .join("  ");
  });
}
