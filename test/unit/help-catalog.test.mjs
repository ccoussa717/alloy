import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const help = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "help-catalog.mjs")).href
);

test("catalog has core topics", () => {
  const ids = help.listTopics().map((t) => t.id);
  for (const need of [
    "overview",
    "auth",
    "sandbox",
    "auto",
    "fusion",
    "commands",
    "mcp",
    "memory",
  ]) {
    assert.ok(ids.includes(need), `missing topic ${need}`);
  }
});

test("getTopic by id", () => {
  const t = help.getTopic("sandbox");
  assert.ok(t);
  assert.match(t.body, /Docker|network none|node:22-bookworm/i);
});

test("searchHelp ranks relevant topics", () => {
  const hits = help.searchHelp("docker sandbox network");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "sandbox");
});

test("searchHelp memory", () => {
  const hits = help.searchHelp("remember facts");
  assert.ok(hits.some((h) => h.id === "memory"));
});

test("formatTopic", () => {
  const text = help.formatTopic(help.getTopic("commands"));
  assert.match(text, /\/auto/);
  assert.match(text, /\/help/);
});
