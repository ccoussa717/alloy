import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Isolate Alloy home for tests
const tmp = mkdtempSync(join(tmpdir(), "alloy-test-"));
process.env.ALLOY_HOME = join(tmp, "alloy-home");
process.env.PI_CODING_AGENT_DIR = join(tmp, "pi-agent");

const storeUrl = pathToFileURL(
  join(new URL("../..", import.meta.url).pathname, "lib", "memory-store.mjs"),
).href;
const {
  remember,
  listMemory,
  searchMemory,
  forget,
  formatMemoryForPrompt,
} = await import(storeUrl);

test("remember + list project memory", () => {
  const cwd = join(tmp, "proj-a");
  const entry = remember("Uses pnpm not npm", { cwd, scope: "project" });
  assert.equal(entry.scope, "project");
  const all = listMemory(cwd);
  assert.ok(all.some((e) => e.text.includes("pnpm")));
});

test("search and forget", () => {
  const cwd = join(tmp, "proj-b");
  const entry = remember("API base is https://example.test", {
    cwd,
    scope: "project",
  });
  const hits = searchMemory("example.test", cwd);
  assert.equal(hits.length, 1);
  const result = forget(entry.id, cwd);
  assert.equal(result.removed, 1);
  assert.equal(searchMemory("example.test", cwd).length, 0);
});

test("formatMemoryForPrompt truncates", () => {
  const cwd = join(tmp, "proj-c");
  for (let i = 0; i < 20; i++) {
    remember(`fact number ${i} ${"x".repeat(200)}`, { cwd });
  }
  const text = formatMemoryForPrompt(listMemory(cwd), 500);
  assert.ok(text.includes("Alloy durable memory"));
  assert.ok(text.length <= 600);
});

test("cleanup", () => {
  rmSync(tmp, { recursive: true, force: true });
});
