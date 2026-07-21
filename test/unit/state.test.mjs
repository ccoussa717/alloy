import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const state = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "state.mjs")).href
);

test("setMode and isReadOnlyMode", () => {
  state.setMode("build");
  state.setPermissionProfile("safe");
  assert.equal(state.isReadOnlyMode(), false);

  state.setMode("plan");
  assert.equal(state.isReadOnlyMode(), true);

  state.setMode("build");
  state.setPermissionProfile("readonly");
  assert.equal(state.isReadOnlyMode(), true);

  state.setPermissionProfile("safe");
  state.setMode("review");
  assert.equal(state.isReadOnlyMode(), true);

  state.setMode("build");
  assert.equal(state.getState().mode, "build");
});

test("invalid mode throws", () => {
  assert.throws(() => state.setMode("fusion"));
});
