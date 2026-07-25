import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { registerModes } from "../../extensions/modes.ts";
import { registerPolicy } from "../../extensions/policy.ts";
import {
  getState,
  resetStateForTests,
  setMode,
  setPermissionProfile,
} from "../../lib/state.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "alloy-mode-cycle-"));
const previousPiDir = process.env.PI_CODING_AGENT_DIR;
const previousAlloyHome = process.env.ALLOY_HOME;
process.env.PI_CODING_AGENT_DIR = join(testRoot, "pi");
process.env.ALLOY_HOME = join(testRoot, "alloy");

after(() => {
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  if (previousAlloyHome === undefined) delete process.env.ALLOY_HOME;
  else process.env.ALLOY_HOME = previousAlloyHome;
  rmSync(testRoot, { recursive: true, force: true });
});

function fakePi() {
  const commands = new Map();
  const shortcuts = [];
  const handlers = new Map();
  return {
    commands,
    shortcuts,
    handlers,
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerShortcut(key, spec) {
      shortcuts.push({ key, spec });
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function fakeContext() {
  const notifications = [];
  const statuses = [];
  return {
    notifications,
    statuses,
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      async select() {},
    },
  };
}

test("Shift+Tab is owned by modes and cycles Build to Plan without changing permissions", async () => {
  resetStateForTests();
  setMode("build");
  setPermissionProfile("ask-dangerous");
  const pi = fakePi();
  registerModes(pi);

  assert.equal(pi.shortcuts.length, 1);
  assert.match(pi.shortcuts[0].spec.description, /Build.*Plan/i);
  const ctx = fakeContext();

  await pi.shortcuts[0].spec.handler(ctx);
  assert.equal(getState().mode, "plan");
  assert.equal(getState().permissionProfile, "ask-dangerous");
  assert.match(ctx.notifications.at(-1).message, /Plan/);

  await pi.shortcuts[0].spec.handler(ctx);
  assert.equal(getState().mode, "build");
  assert.equal(getState().permissionProfile, "ask-dangerous");
  assert.match(ctx.notifications.at(-1).message, /Build/);
});

test("Shift+Tab enters Plan safely from non-cycle modes", async () => {
  resetStateForTests();
  setMode("review");
  const pi = fakePi();
  registerModes(pi);

  await pi.shortcuts[0].spec.handler(fakeContext());
  assert.equal(getState().mode, "plan");
});

test("permission policy no longer registers a Shift+Tab shortcut", () => {
  resetStateForTests();
  const pi = fakePi();
  registerPolicy(pi);
  assert.equal(pi.shortcuts.length, 0);
});
