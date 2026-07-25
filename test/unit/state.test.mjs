import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const state = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "state.mjs")).href
);

test("setMode and isReadOnlyMode", () => {
  state.setMode("build");
  state.setPermissionProfile("ask-dangerous");
  assert.equal(state.isReadOnlyMode(), false);

  state.setMode("plan");
  assert.equal(state.isReadOnlyMode(), true);

  state.setMode("build");
  // ask-all is NOT hard-readonly; plan/review modes are
  state.setPermissionProfile("ask-all");
  assert.equal(state.isReadOnlyMode(), false);

  state.setMode("review");
  assert.equal(state.isReadOnlyMode(), true);

  state.setMode("build");
  assert.equal(state.getState().mode, "build");
});

test("invalid mode throws", () => {
  assert.throws(() => state.setMode("fusion"));
});

test("Shift+Tab mode cycle alternates Build and Plan with a safe fallback", () => {
  assert.equal(state.nextPrimaryMode("build"), "plan");
  assert.equal(state.nextPrimaryMode("plan"), "build");
  assert.equal(state.nextPrimaryMode("chat"), "plan");
  assert.equal(state.nextPrimaryMode("review"), "plan");
});

test("sandbox profile is allowed", () => {
  state.setPermissionProfile("sandbox");
  assert.equal(state.isSandboxProfile(), true);
  state.setPermissionProfile("ask-dangerous");
  assert.equal(state.isSandboxProfile(), false);
});

test("legacy safe/workspace map on set", () => {
  state.setPermissionProfile("safe");
  assert.equal(state.getState().permissionProfile, "ask-dangerous");
  state.setPermissionProfile("workspace");
  assert.equal(state.getState().permissionProfile, "ask-none");
});
