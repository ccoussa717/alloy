import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const p = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "permissions.mjs")).href
);

test("normalize aliases", () => {
  assert.equal(p.normalizePermissionId("safe"), "ask-dangerous");
  assert.equal(p.normalizePermissionId("workspace"), "ask-none");
  assert.equal(p.normalizePermissionId("everything"), "ask-all");
  assert.equal(p.normalizePermissionId("ask-some"), "ask-some");
  assert.equal(p.normalizePermissionId("Ask Me For Everything"), "ask-all");
  assert.equal(p.normalizePermissionId("don't ask me for anything"), "ask-none");
});

test("cycle order", () => {
  let id = "ask-all";
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const n = p.nextPermissionLevel(id);
    seen.push(n.id);
    id = n.id;
  }
  assert.deepEqual(seen, [
    "ask-some",
    "ask-dangerous",
    "ask-none",
    "ask-all",
  ]);
});

test("inspection vs dangerous bash", () => {
  assert.equal(p.isInspectionBash("git status"), true);
  assert.equal(p.isInspectionBash("ls -la"), true);
  assert.equal(p.isDangerousBash("rm -rf /"), true);
  assert.equal(p.isDangerousBash("git status"), false);
});
