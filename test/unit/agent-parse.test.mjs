import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// parseAgentCommand is in the TS extension; re-implement light tests against profiles + registry
const profiles = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "agent-profiles.mjs")).href
);

test("resolveAgentSpec uses profile model", () => {
  const spec = profiles.resolveAgentSpec({ profile: "research" });
  assert.equal(spec.profile, "research");
  assert.ok(spec.tools.includes("read"));
  assert.ok(!spec.tools.includes("write"));
});

test("explicit model overrides profile", () => {
  const spec = profiles.resolveAgentSpec({
    profile: "research",
    model: "anthropic/claude-opus-4-6",
  });
  assert.equal(spec.model, "anthropic/claude-opus-4-6");
});

test("listProfiles includes built-ins", () => {
  const names = profiles.listProfiles().map((p) => p.name);
  assert.ok(names.includes("research"));
  assert.ok(names.includes("code"));
  assert.ok(names.includes("review"));
});

// Inline parse mirror (same rules as extensions/agents.ts)
function parseAgentCommand(args) {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let background = false;
  if (tokens[0] === "bg" || tokens[0] === "background") {
    background = true;
    tokens.shift();
  }
  if (!tokens.length) return null;
  const name = tokens.shift();
  let profile;
  let model;
  const toolParts = [];
  while (tokens.length) {
    const t = tokens[0];
    if (t.startsWith("profile=") || t.startsWith("p=")) {
      profile = t.split("=").slice(1).join("=");
      tokens.shift();
      continue;
    }
    if (t.startsWith("model=") || t.startsWith("m=")) {
      model = t.split("=").slice(1).join("=");
      tokens.shift();
      continue;
    }
    if (t.startsWith("tools=") || t.startsWith("t=")) {
      toolParts.push(...t.split("=").slice(1).join("=").split(",").filter(Boolean));
      tokens.shift();
      continue;
    }
    break;
  }
  if (tokens[0] === "use" && tokens[1]) {
    tokens.shift();
    model = tokens.shift().replace(/:$/, "");
  }
  if (tokens[0]?.startsWith("@")) {
    profile = tokens.shift().slice(1);
  }
  const task = tokens.join(" ").trim();
  if (!task) return { error: "missing task", name, background, profile, model };
  return {
    name,
    task,
    background,
    profile,
    model,
    tools: toolParts.length ? toolParts : undefined,
  };
}

test("parse agent command forms", () => {
  const a = parseAgentCommand("scout profile=research Map auth");
  assert.equal(a.name, "scout");
  assert.equal(a.profile, "research");
  assert.equal(a.task, "Map auth");

  const b = parseAgentCommand("bg worker model=xai/grok-3 Find bugs");
  assert.equal(b.background, true);
  assert.equal(b.model, "xai/grok-3");

  const c = parseAgentCommand("r1 use anthropic/claude-opus-4-6: Review PR");
  assert.equal(c.model, "anthropic/claude-opus-4-6");
  assert.equal(c.task, "Review PR");
});
