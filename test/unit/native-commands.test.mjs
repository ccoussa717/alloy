import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPEN_TUI_HOTKEYS,
  flattenSessionTree,
  formatSessionOption,
  formatTreeOption,
  getUserMessageEntries,
  registerNativeCommands,
} from "../../extensions/native-commands.ts";

function fakePi() {
  const commands = new Map();
  const names = [];
  return {
    commands,
    names,
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    async setSessionName(name) {
      names.push(name);
    },
  };
}

function fakeContext(overrides = {}) {
  const notifications = [];
  const selections = [];
  const inputs = [];
  const ctx = {
    notifications,
    selections,
    inputs,
    sessionManager: {
      getCwd: () => "/work/project",
      getSessionDir: () => "/sessions",
      usesDefaultSessionDir: () => true,
      getTree: () => [],
      getBranch: () => [],
      getLeafId: () => null,
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async select(title, options) {
        selections.push({ title, options });
        return undefined;
      },
      async input(title, placeholder) {
        inputs.push({ title, placeholder });
        return undefined;
      },
    },
    async switchSession() {
      return { cancelled: false };
    },
    async navigateTree() {
      return { cancelled: false };
    },
    async fork() {
      return { cancelled: false };
    },
    async reload() {},
    ...overrides,
  };
  return ctx;
}

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/work/project",
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date("2026-01-02T00:00:00Z"),
    messageCount: 3,
    firstMessage: "Fix the parser",
    allMessagesText: "Fix the parser It is fixed",
    ...overrides,
  };
}

function userEntry(id, content, parentId = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content, timestamp: 0 },
  };
}

test("pure helpers flatten and format session data without TUI components", () => {
  const root = userEntry("root", "First request");
  const child = {
    type: "model_change",
    id: "model",
    parentId: "root",
    timestamp: "2026-01-01T00:01:00Z",
    provider: "openai",
    modelId: "gpt-5",
  };
  const sibling = userEntry("other", [{ type: "text", text: "Second request" }]);
  const flat = flattenSessionTree([
    { entry: root, children: [{ entry: child, children: [] }] },
    { entry: sibling, children: [] },
  ]);

  assert.deepEqual(
    flat.map(({ entry, depth }) => [entry.id, depth]),
    [["root", 0], ["model", 1], ["other", 0]],
  );
  assert.match(formatTreeOption(flat[0], "root"), /current.*First request.*root/i);
  assert.match(formatTreeOption(flat[1], "root"), /gpt-5.*model/i);
  assert.deepEqual(getUserMessageEntries([root, child, sibling]).map((entry) => entry.id), ["root", "other"]);
  assert.match(formatSessionOption(session("abc", { name: "Parser repair" })), /Parser repair.*3 messages.*abc/i);
});

test("tree formatting handles Pi messages that do not have content", () => {
  const bashEntry = {
    type: "message",
    id: "bash",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "bashExecution",
      command: "npm test",
      output: "ok",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    },
  };

  assert.match(formatTreeOption({ entry: bashEntry, depth: 0 }), /npm test.*bash/i);
});

test("registers RPC replacements for all Pi TUI-only commands", () => {
  const pi = fakePi();
  registerNativeCommands(pi, { list: async () => [], listAll: async () => [] });
  assert.deepEqual([...pi.commands.keys()], ["resume", "tree", "fork", "reload", "name", "hotkeys"]);
});

test("resume lists the current project, expands to all sessions on request, and awaits switching", async () => {
  const pi = fakePi();
  const calls = [];
  const local = session("local");
  const remote = session("remote", { cwd: "/work/other", firstMessage: "Other work" });
  registerNativeCommands(pi, {
    async list(cwd, sessionDir) {
      calls.push(["list", cwd, sessionDir]);
      return [local];
    },
    async listAll(...args) {
      calls.push(["listAll", ...args]);
      return [local, remote];
    },
  });

  let selection = 0;
  let switched = false;
  const ctx = fakeContext({
    ui: {
      notify(message, type) {
        ctx.notifications.push({ message, type });
      },
      async select(_title, options) {
        ctx.selections.push(options);
        if (selection++ === 0) return options.find((option) => /all sessions/i.test(option));
        return options.find((option) => option.includes("remote"));
      },
      async input() {},
    },
    async switchSession(path) {
      await Promise.resolve();
      switched = path === remote.path;
      return { cancelled: false };
    },
  });

  await pi.commands.get("resume").handler("", ctx);

  assert.deepEqual(calls, [["list", "/work/project", "/sessions"], ["listAll"]]);
  assert.equal(switched, true);
  assert.deepEqual(ctx.notifications, []);
});

test("resume uses a custom session directory for all-session listing", async () => {
  const pi = fakePi();
  const calls = [];
  registerNativeCommands(pi, {
    async list() {
      return [];
    },
    async listAll(...args) {
      calls.push(args);
      return [];
    },
  });
  const ctx = fakeContext({
    sessionManager: {
      ...fakeContext().sessionManager,
      usesDefaultSessionDir: () => false,
    },
    ui: {
      notify(message, type) {
        ctx.notifications.push({ message, type });
      },
      async select(_title, options) {
        return options.find((option) => /all sessions/i.test(option));
      },
      async input() {},
    },
  });

  await pi.commands.get("resume").handler("", ctx);
  assert.deepEqual(calls, [["/sessions"]]);
  assert.match(ctx.notifications.at(-1).message, /no sessions/i);
});

test("tree flattens the current session and awaits navigation to the selected entry", async () => {
  const pi = fakePi();
  registerNativeCommands(pi, { list: async () => [], listAll: async () => [] });
  const root = userEntry("root", "Root request");
  const target = userEntry("target", "Branch request", "root");
  let navigated;
  const ctx = fakeContext({
    sessionManager: {
      ...fakeContext().sessionManager,
      getTree: () => [{ entry: root, children: [{ entry: target, children: [] }] }],
      getLeafId: () => "root",
    },
    ui: {
      notify(message, type) {
        ctx.notifications.push({ message, type });
      },
      async select(_title, options) {
        return options.find((option) => option.includes("target"));
      },
      async input() {},
    },
    async navigateTree(id) {
      await Promise.resolve();
      navigated = id;
      return { cancelled: false };
    },
  });

  await pi.commands.get("tree").handler("", ctx);
  assert.equal(navigated, "target");
  assert.deepEqual(ctx.notifications, []);
});

test("fork offers only user messages and is cancel-safe", async () => {
  const pi = fakePi();
  registerNativeCommands(pi, { list: async () => [], listAll: async () => [] });
  const first = userEntry("first", "First");
  const assistant = {
    type: "message",
    id: "assistant",
    parentId: "first",
    timestamp: "2026-01-01T00:01:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
  };
  const second = userEntry("second", "Second", "assistant");
  let forked;
  const ctx = fakeContext({
    sessionManager: {
      ...fakeContext().sessionManager,
      getBranch: () => [first, assistant, second],
    },
    ui: {
      notify(message, type) {
        ctx.notifications.push({ message, type });
      },
      async select(_title, options) {
        assert.equal(options.length, 2);
        assert.ok(options.every((option) => !option.includes("assistant")));
        return options.find((option) => option.includes("second"));
      },
      async input() {},
    },
    async fork(id) {
      await Promise.resolve();
      forked = id;
      return { cancelled: false };
    },
  });

  await pi.commands.get("fork").handler("", ctx);
  assert.equal(forked, "second");

  ctx.ui.select = async () => undefined;
  forked = undefined;
  await pi.commands.get("fork").handler("", ctx);
  assert.equal(forked, undefined);
});

test("reload and name await operations, while cancelled or blank names are no-ops", async () => {
  const pi = fakePi();
  registerNativeCommands(pi, { list: async () => [], listAll: async () => [] });
  let reloaded = false;
  const ctx = fakeContext({
    async reload() {
      await Promise.resolve();
      reloaded = true;
    },
  });

  await pi.commands.get("reload").handler("", ctx);
  assert.equal(reloaded, true);

  await pi.commands.get("name").handler("  Release prep  ", ctx);
  assert.deepEqual(pi.names, ["Release prep"]);

  ctx.ui.input = async () => "   ";
  await pi.commands.get("name").handler("", ctx);
  ctx.ui.input = async () => undefined;
  await pi.commands.get("name").handler("", ctx);
  assert.deepEqual(pi.names, ["Release prep"]);
});

test("hotkeys shows OpenTUI bindings as a read-only list", async () => {
  const pi = fakePi();
  registerNativeCommands(pi, { list: async () => [], listAll: async () => [] });
  const ctx = fakeContext();

  await pi.commands.get("hotkeys").handler("", ctx);

  assert.deepEqual(ctx.selections[0], { title: "OpenTUI hotkeys", options: OPEN_TUI_HOTKEYS });
  assert.ok(OPEN_TUI_HOTKEYS.some((line) => /Shift\+Tab.*Build.*Plan/i.test(line)));
  assert.ok(OPEN_TUI_HOTKEYS.some((line) => /Ctrl\+C.*abort.*exit/i.test(line)));
  assert.ok(OPEN_TUI_HOTKEYS.some((line) => /Esc.*Abort the thinking model/i.test(line)));
});

test("handlers report errors without claiming success", async () => {
  const pi = fakePi();
  registerNativeCommands(pi, {
    async list() {
      throw new Error("session index unavailable");
    },
    async listAll() {
      return [];
    },
  });
  const ctx = fakeContext({
    async reload() {
      throw new Error("reload failed");
    },
  });

  await pi.commands.get("resume").handler("", ctx);
  await pi.commands.get("reload").handler("", ctx);

  assert.deepEqual(ctx.notifications, [
    { message: "session index unavailable", type: "error" },
    { message: "reload failed", type: "error" },
  ]);
});
