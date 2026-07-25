/**
 * Durable cross-session memory (user + project).
 * Each fact is a markdown file with simple frontmatter-ish header.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  getProjectMemoryDir,
  getUserMemoryDir,
  projectIdFromCwd,
} from "./paths.mjs";

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "note"
  );
}

function parseEntry(raw, file, scope) {
  const lines = raw.split("\n");
  let id = file.replace(/\.md$/, "");
  let created = "";
  let tags = [];
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    let i = 1;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        bodyStart = i + 1;
        break;
      }
      const m = lines[i].match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      if (m[1] === "id") id = m[2].trim();
      if (m[1] === "created") created = m[2].trim();
      if (m[1] === "tags") {
        tags = m[2]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }
  const text = lines.slice(bodyStart).join("\n").trim();
  return { id, scope, created, tags, text, file };
}

function listDir(dir, scope) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      try {
        return parseEntry(readFileSync(join(dir, f), "utf8"), f, scope);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listMemory(cwd = process.cwd()) {
  const user = listDir(getUserMemoryDir(), "user");
  const project = listDir(getProjectMemoryDir(cwd), "project");
  return [...project, ...user];
}

export function remember(text, options = {}) {
  const scope = options.scope === "user" ? "user" : "project";
  const cwd = options.cwd || process.cwd();
  const dir = scope === "user" ? getUserMemoryDir() : getProjectMemoryDir(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const created = new Date().toISOString();
  const base = slugify(text.slice(0, 80));
  const id = options.id || `${base}-${Date.now().toString(36)}`;
  const tags = options.tags || [];
  const file = `${id}.md`;
  const body = [
    "---",
    `id: ${id}`,
    `created: ${created}`,
    `scope: ${scope}`,
    `tags: ${tags.join(", ")}`,
    "---",
    "",
    text.trim(),
    "",
  ].join("\n");

  writeFileSync(join(dir, file), body, { encoding: "utf8", mode: 0o600 });
  return { id, scope, file, path: join(dir, file), projectId: projectIdFromCwd(cwd) };
}

export function forget(idOrPrefix, cwd = process.cwd()) {
  const entries = listMemory(cwd);
  const matches = entries.filter(
    (e) => e.id === idOrPrefix || e.id.startsWith(idOrPrefix) || e.file.startsWith(idOrPrefix),
  );
  if (matches.length === 0) return { removed: 0, matches: [] };
  if (matches.length > 1 && !entries.some((e) => e.id === idOrPrefix)) {
    return { removed: 0, matches, ambiguous: true };
  }
  const target = matches.find((e) => e.id === idOrPrefix) || matches[0];
  const dir =
    target.scope === "user" ? getUserMemoryDir() : getProjectMemoryDir(cwd);
  unlinkSync(join(dir, target.file));
  return { removed: 1, matches: [target] };
}

export function searchMemory(query, cwd = process.cwd()) {
  const q = query.toLowerCase();
  return listMemory(cwd).filter(
    (e) =>
      e.text.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

export function formatMemoryForPrompt(entries, maxChars = 6000) {
  if (!entries.length) return "";
  const lines = [
    "# Alloy durable memory",
    "Facts that persist across sessions. Prefer these over guesses.",
    "",
  ];
  let used = lines.join("\n").length;
  for (const e of entries) {
    const block = `- [${e.scope}/${e.id}] ${e.text}\n`;
    if (used + block.length > maxChars) {
      lines.push("- … (truncated; use /memory to browse)");
      break;
    }
    lines.push(`- [${e.scope}/${e.id}] ${e.text}`);
    used += block.length;
  }
  return lines.join("\n");
}
