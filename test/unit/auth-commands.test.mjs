import assert from "node:assert/strict";
import { test } from "node:test";

import { registerAuthCommands } from "../../extensions/auth-commands.ts";

function fakePi() {
  const commands = new Map();
  const events = new Map();
  return {
    commands,
    events,
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
  };
}

function fakeContext(selectAnswers = [], inputAnswers = [], runtime) {
  const notifications = [];
  const selections = [];
  const inputs = [];
  const widgets = [];
  let selectIndex = 0;
  let inputIndex = 0;
  return {
    notifications,
    selections,
    inputs,
    widgets,
    signal: undefined,
    modelRegistry: {
      runtime,
      refreshCalls: 0,
      async refresh() {
        this.refreshCalls++;
      },
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      async select(title, options, opts) {
        selections.push({ title, options, opts });
        const answer = selectAnswers[selectIndex++];
        return typeof answer === "function" ? answer(options) : answer;
      },
      async input(title, placeholder, opts) {
        inputs.push({ title, placeholder, opts });
        return inputAnswers[inputIndex++];
      },
      setWidget(key, content, options) {
        widgets.push({ key, content, options });
      },
    },
  };
}

function provider(id, name, { oauth = true, apiKey = false } = {}) {
  return {
    id,
    name,
    auth: {
      oauth: oauth ? { name: `${name} OAuth`, loginLabel: `Sign in to ${name}` } : undefined,
      apiKey: apiKey ? { name: `${name} API key` } : undefined,
    },
  };
}

function register(runtime, options = {}) {
  const pi = fakePi();
  const resolveCalls = [];
  registerAuthCommands(pi, {
    async resolveRuntime(ctx) {
      resolveCalls.push(ctx);
      return runtime;
    },
    ...options,
  });
  return { pi, resolveCalls };
}

function allNotificationText(ctx) {
  return ctx.notifications.map(({ message }) => message).join("\n");
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("login maps OAuth provider, method, prompts, and events through RPC-safe extension UI", async () => {
  const providers = [
    provider("api-only", "API Only", { oauth: false, apiKey: true }),
    provider("anthropic", "Anthropic", { apiKey: true }),
    provider("openai-codex", "OpenAI Codex"),
  ];
  let credentials = [];
  const loginCalls = [];
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(providerId, type, interaction) {
      loginCalls.push({ providerId, type, signal: interaction.signal });
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.test/authorize",
        instructions: "Complete sign-in in your browser.",
      });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
      });
      interaction.notify({
        type: "info",
        message: "Waiting for account approval.",
        links: [{ label: "Help", url: "https://docs.example.test/oauth" }],
      });
      interaction.notify({ type: "progress", message: "Checking authorization..." });

      assert.equal(await interaction.prompt({
        type: "select",
        message: "Choose an account",
        options: [
          { id: "personal", label: "Personal" },
          { id: "team", label: "Team", description: "Organization account" },
        ],
      }), "team");
      assert.equal(await interaction.prompt({
        type: "text",
        message: "Account name",
        placeholder: "name@example.test",
      }), "chris@example.test");
      assert.equal(await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization code",
        placeholder: "code",
      }), "manual-code");

      credentials = [{ providerId, type: "oauth" }];
      return {
        type: "oauth",
        access: "ACCESS_TOKEN_MUST_NOT_LEAK",
        refresh: "REFRESH_TOKEN_MUST_NOT_LEAK",
        expires: Date.now() + 60_000,
      };
    },
    async listCredentials() {
      return credentials;
    },
    async logout() {},
  };
  const { pi, resolveCalls } = register(runtime);
  const ctx = fakeContext(
    [
      (options) => options.find((option) => option.includes("Anthropic")),
      (options) => options.find((option) => /OAuth/.test(option)),
      (options) => options.find((option) => option.startsWith("Team")),
    ],
    ["chris@example.test", "manual-code"],
  );

  await pi.commands.get("login").handler("", ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(resolveCalls, [ctx]);
  assert.equal(ctx.selections.length, 3);
  assert.ok(ctx.selections[0].options.every((option) => !option.includes("API Only")));
  assert.ok(ctx.selections[1].options.some((option) => /OAuth/.test(option)));
  assert.ok(ctx.selections[1].options.some((option) => /API key.*environment.*config/i.test(option)));
  assert.deepEqual(loginCalls.map(({ providerId, type }) => ({ providerId, type })), [
    { providerId: "anthropic", type: "oauth" },
  ]);
  assert.ok(loginCalls[0].signal instanceof AbortSignal);
  assert.equal(ctx.inputs.length, 2);
  assert.match(ctx.inputs[1].title, /authorization code/i);
  assert.match(ctx.inputs[1].title, /https:\/\/auth\.example\.test\/authorize/);
  assert.match(ctx.inputs[1].title, /https:\/\/auth\.example\.test\/device/);
  assert.match(ctx.inputs[1].title, /ABCD-EFGH/);
  assert.ok(ctx.widgets.some(({ content }) => content?.join("\n").includes("https://auth.example.test/authorize")));
  assert.equal(ctx.widgets.at(-1)?.content, undefined);
  assert.equal(ctx.modelRegistry.refreshCalls, 0);

  const visible = allNotificationText(ctx);
  assert.match(visible, /https:\/\/auth\.example\.test\/authorize/);
  assert.match(visible, /ABCD-EFGH/);
  assert.match(visible, /Waiting for account approval/);
  assert.match(visible, /Checking authorization/);
  assert.match(visible, /verified/i);
  assert.doesNotMatch(visible, /ACCESS_TOKEN_MUST_NOT_LEAK|REFRESH_TOKEN_MUST_NOT_LEAK|manual-code/);
});

test("commands use the exact active registry runtime from each command context", async () => {
  const providers = [provider("anthropic", "Anthropic")];
  const calls = [];
  const runtime = (name, credentials = []) => ({
    credentials,
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(providerId, type) {
      calls.push({ operation: "login", name, runtime: this, providerId, type });
      this.credentials = [{ providerId, type }];
    },
    async listCredentials() {
      return this.credentials;
    },
    async logout(providerId) {
      calls.push({ operation: "logout", name, runtime: this, providerId });
      this.credentials = this.credentials.filter((entry) => entry.providerId !== providerId);
    },
  });
  const firstRuntime = runtime("first");
  const secondRuntime = runtime("second", [{ providerId: "anthropic", type: "oauth" }]);
  const pi = fakePi();
  registerAuthCommands(pi);

  await pi.commands.get("login").handler(
    "anthropic",
    fakeContext([], [], firstRuntime),
  );
  await pi.commands.get("logout").handler(
    "anthropic",
    fakeContext([], [], secondRuntime),
  );

  assert.deepEqual(
    calls.map(({ operation, name, providerId, type }) => ({
      operation,
      name,
      providerId,
      type,
    })),
    [
      { operation: "login", name: "first", providerId: "anthropic", type: "oauth" },
      { operation: "logout", name: "second", providerId: "anthropic", type: undefined },
    ],
  );
  assert.equal(calls[0].runtime, firstRuntime);
  assert.equal(calls[1].runtime, secondRuntime);
});

test("device-code login releases the command queue while polling and clears details when done", async () => {
  const providers = [provider("xai", "xAI")];
  let credentials = [];
  let finishLogin;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(providerId, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://auth.example.test/old" });
      interaction.notify({ type: "auth_url", url: "https://auth.example.test/current" });
      interaction.notify({
        type: "device_code",
        userCode: "ZXCV-1234",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve) => (finishLogin = resolve));
      credentials = [{ providerId, type: "oauth" }];
    },
    async listCredentials() {
      return credentials;
    },
    async logout() {},
  };
  const { pi } = register(runtime);
  const ctx = fakeContext();

  let commandFinished = false;
  const login = pi.commands.get("login").handler("xai", ctx).then(() => {
    commandFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  const releasedWhilePolling = commandFinished;
  const active = ctx.widgets.filter(({ content }) => content !== undefined).at(-1)?.content.join("\n") ?? "";
  assert.doesNotMatch(active, /\/old/);
  assert.equal(active.match(/\/current/g)?.length, 1);
  assert.match(active, /https:\/\/auth\.example\.test\/device/);
  assert.match(active, /ZXCV-1234/);

  finishLogin();
  await login;
  await waitUntil(() => ctx.widgets.at(-1)?.content === undefined, "background login did not finish");
  assert.equal(releasedWhilePolling, true);
  assert.equal(ctx.modelRegistry.refreshCalls, 0);
  assert.equal(ctx.widgets.at(-1)?.content, undefined);
  assert.match(allNotificationText(ctx), /completed.*verified/i);
  assert.doesNotMatch(allNotificationText(ctx), /login failed/i);
});

test("device-code login survives command-context invalidation and rejects duplicate starts", async () => {
  const providers = [provider("xai", "xAI")];
  let credentials = [];
  let finishLogin;
  let loginCalls = 0;
  let loginResolved = false;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(providerId, _type, interaction) {
      loginCalls++;
      interaction.notify({
        type: "device_code",
        userCode: "SAFE-4321",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve) => (finishLogin = resolve));
      credentials = [{ providerId, type: "oauth" }];
      loginResolved = true;
    },
    async listCredentials() {
      return credentials;
    },
    async logout() {},
  };
  const { pi } = register(runtime);
  const base = fakeContext();
  const ui = base.ui;
  const modelRegistry = base.modelRegistry;
  let stale = false;
  const ctx = { ...base };
  Object.defineProperties(ctx, {
    ui: { get: () => stale ? (() => { throw new Error("stale ui context"); })() : ui },
    modelRegistry: { get: () => stale ? (() => { throw new Error("stale model context"); })() : modelRegistry },
  });

  await pi.commands.get("login").handler("xai", ctx);
  stale = true;
  const reloaded = register(runtime).pi;
  await reloaded.commands.get("login").handler("xai", base);

  assert.equal(loginCalls, 1);
  assert.match(allNotificationText(base), /already in progress/i);
  await pi.events.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, base);
  finishLogin();
  await waitUntil(() => loginResolved, "background provider login did not resolve");
  assert.notEqual(base.widgets.at(-1)?.content, undefined);

  let credentialReloads = 0;
  let replacementCredentials = [];
  const replacementRuntime = {
    ...runtime,
    async listCredentials() {
      return replacementCredentials;
    },
    credentials: {
      store: {
        reload() {
          credentialReloads++;
          replacementCredentials = [...credentials];
        },
      },
    },
  };
  const replacementCtx = fakeContext([], [], replacementRuntime);
  const replacement = register(replacementRuntime).pi;
  await replacement.events.get("session_start")({ type: "session_start", reason: "new" }, replacementCtx);
  await waitUntil(() => ui.setWidget && base.widgets.at(-1)?.content === undefined, "stale-context login did not clean up");
  assert.equal(credentialReloads, 1);
  assert.equal(replacementCtx.modelRegistry.refreshCalls, 1);
  assert.match(allNotificationText(base), /completed.*verified/i);
});

test("device-code login fails cleanly when session replacement never starts", async () => {
  const providers = [provider("xai", "xAI")];
  let finishLogin;
  let credentials = [];
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(providerId, _type, interaction) {
      interaction.notify({
        type: "device_code",
        userCode: "FAILED-REPLACE",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve) => (finishLogin = resolve));
      credentials = [{ providerId, type: "oauth" }];
    },
    async listCredentials() {
      return credentials;
    },
    async logout() {},
  };
  const { pi } = register(runtime, { replacementTimeoutMs: 0 });
  const ctx = fakeContext();

  await pi.commands.get("login").handler("xai", ctx);
  await pi.events.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  finishLogin();
  await waitUntil(() => ctx.widgets.at(-1)?.content === undefined, "failed replacement left login pending");

  assert.match(allNotificationText(ctx), /credential.*stored.*active session could not refresh/i);
  assert.doesNotMatch(allNotificationText(ctx), /completed.*verified/i);

  const recoveredRuntime = {
    ...runtime,
    credentials: { store: { reload() {} } },
  };
  const recoveredCtx = fakeContext([], [], recoveredRuntime);
  const recovered = register(recoveredRuntime).pi;
  await recovered.events.get("session_start")({ type: "session_start", reason: "reload" }, recoveredCtx);
});

test("login-cancel aborts an active device-code poll", async () => {
  const providers = [provider("xai", "xAI")];
  let observedSignal;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(_providerId, _type, interaction) {
      observedSignal = interaction.signal;
      interaction.notify({
        type: "device_code",
        userCode: "CANCEL-1",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((_resolve, reject) => {
        interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
      });
    },
    async listCredentials() {
      return [];
    },
    async logout() {},
  };
  const { pi } = register(runtime);
  const ctx = fakeContext();

  await pi.commands.get("login").handler("xai", ctx);
  await pi.commands.get("login-cancel").handler("xai", ctx);
  await waitUntil(() => ctx.widgets.at(-1)?.content === undefined, "cancelled login did not clean up");

  assert.equal(observedSignal.aborted, true);
  assert.match(allNotificationText(ctx), /cancelling login/i);
  assert.match(allNotificationText(ctx), /login cancelled/i);
  assert.doesNotMatch(allNotificationText(ctx), /completed.*verified/i);
});

test("late device-code cancellation reports a credential that was already persisted", async () => {
  const providers = [provider("xai", "xAI")];
  let finishLogin;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(_providerId, _type, interaction) {
      interaction.notify({
        type: "device_code",
        userCode: "LATE-1",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve) => (finishLogin = resolve));
    },
    async listCredentials() {
      return [{ providerId: "xai", type: "oauth" }];
    },
    async logout() {},
  };
  const { pi } = register(runtime);
  const ctx = fakeContext();

  await pi.commands.get("login").handler("xai", ctx);
  finishLogin();
  await pi.commands.get("login-cancel").handler("xai", ctx);
  await waitUntil(() => ctx.widgets.at(-1)?.content === undefined, "late-cancelled login did not clean up");

  assert.match(allNotificationText(ctx), /completed.*verified/i);
  assert.doesNotMatch(allNotificationText(ctx), /Login cancelled\./i);
});

test("logout refuses to race an active login for the same provider", async () => {
  const providers = [provider("xai", "xAI")];
  let finishLogin;
  let logoutCalls = 0;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(_providerId, _type, interaction) {
      interaction.notify({
        type: "device_code",
        userCode: "RACE-1",
        verificationUri: "https://auth.example.test/device",
      });
      await new Promise((resolve) => (finishLogin = resolve));
    },
    async listCredentials() {
      return [{ providerId: "xai", type: "oauth" }];
    },
    async logout() {
      logoutCalls++;
    },
  };
  const { pi } = register(runtime);
  const ctx = fakeContext();

  await pi.commands.get("login").handler("xai", ctx);
  await pi.commands.get("logout").handler("xai", ctx);

  assert.equal(logoutCalls, 0);
  assert.match(allNotificationText(ctx), /still in progress.*cancel it before logging out/i);
  finishLogin();
  await waitUntil(() => ctx.widgets.at(-1)?.content === undefined, "racing login did not clean up");
});

test("commands report a clear compatibility error when the registry runtime is unavailable", async () => {
  const pi = fakePi();
  registerAuthCommands(pi);
  const loginCtx = fakeContext();
  const logoutCtx = fakeContext();

  await pi.commands.get("login").handler("anthropic", loginCtx);
  await pi.commands.get("logout").handler("anthropic", logoutCtx);

  assert.match(allNotificationText(loginCtx), /incompatible.*active ModelRuntime/i);
  assert.match(allNotificationText(logoutCtx), /incompatible.*active ModelRuntime/i);
});

test("login accepts a provider id, reports unknown providers safely, and never starts API-key entry", async () => {
  const providers = [provider("anthropic", "Anthropic", { apiKey: true })];
  const calls = [];
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(...args) {
      calls.push(args);
      return { type: "oauth", access: "hidden", refresh: "hidden", expires: 1 };
    },
    async listCredentials() {
      return [];
    },
    async logout() {},
  };
  const { pi } = register(runtime);

  const unknown = fakeContext();
  await pi.commands.get("login").handler("does-not-exist", unknown);
  assert.equal(calls.length, 0);
  assert.match(allNotificationText(unknown), /unknown OAuth provider/i);

  const apiKey = fakeContext([
    (options) => options.find((option) => /API key/.test(option)),
  ]);
  await pi.commands.get("login").handler("anthropic", apiKey);
  assert.equal(calls.length, 0);
  assert.equal(apiKey.inputs.length, 0);
  assert.match(allNotificationText(apiKey), /environment.*config/i);
  assert.match(allNotificationText(apiKey), /not masked/i);
});

test("login cancellation aborts safely and does not claim success", async () => {
  const providers = [provider("anthropic", "Anthropic")];
  let interactionSignal;
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login(_providerId, _type, interaction) {
      interactionSignal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Authorization code" });
      throw new Error("provider should not continue after cancellation");
    },
    async listCredentials() {
      return [];
    },
    async logout() {},
  };
  const { pi } = register(runtime);
  const ctx = fakeContext([], [undefined]);

  await pi.commands.get("login").handler("anthropic", ctx);

  assert.equal(interactionSignal.aborted, true);
  assert.match(allNotificationText(ctx), /cancelled/i);
  assert.doesNotMatch(allNotificationText(ctx), /logged in|complete|verified/i);
  assert.equal(ctx.modelRegistry.refreshCalls, 0);
});

test("login verifies stored credential metadata and redacts provider errors", async () => {
  const providers = [provider("anthropic", "Anthropic")];
  const missingStorage = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login() {
      return { type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: 1 };
    },
    async listCredentials() {
      return [];
    },
    async logout() {},
  };
  const first = register(missingStorage).pi;
  const missingCtx = fakeContext();
  await first.commands.get("login").handler("anthropic", missingCtx);
  assert.equal(missingCtx.modelRegistry.refreshCalls, 0);
  assert.match(allNotificationText(missingCtx), /could not be verified/i);
  assert.match(allNotificationText(missingCtx), /completion was not confirmed/i);
  assert.doesNotMatch(allNotificationText(missingCtx), /logged in|completed;|secret-access|secret-refresh/i);

  const failing = {
    ...missingStorage,
    async login() {
      throw new Error("request failed with bearer SUPER_SECRET_BEARER");
    },
  };
  const second = register(failing).pi;
  const failingCtx = fakeContext();
  await second.commands.get("login").handler("anthropic", failingCtx);
  assert.match(allNotificationText(failingCtx), /login failed/i);
  assert.doesNotMatch(allNotificationText(failingCtx), /SUPER_SECRET_BEARER|bearer/i);
  assert.doesNotMatch(allNotificationText(failingCtx), /logged in|verified/i);
});

test("logout selects from credential metadata only, refreshes, and verifies removal", async () => {
  const providers = [
    provider("anthropic", "Anthropic"),
    provider("openai-codex", "OpenAI Codex"),
  ];
  let credentials = [
    { providerId: "anthropic", type: "oauth", access: "LEAK_ME_NOT" },
    { providerId: "openai-codex", type: "api_key", key: "KEY_LEAK_ME_NOT" },
  ];
  const logoutCalls = [];
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login() {},
    async listCredentials() {
      return credentials;
    },
    async logout(providerId) {
      logoutCalls.push(providerId);
      credentials = credentials.filter((entry) => entry.providerId !== providerId);
    },
  };
  const { pi } = register(runtime);
  const ctx = fakeContext([
    (options) => options.find((option) => option.includes("OpenAI Codex")),
  ]);

  await pi.commands.get("logout").handler("", ctx);

  assert.deepEqual(logoutCalls, ["openai-codex"]);
  assert.equal(ctx.modelRegistry.refreshCalls, 1);
  assert.match(ctx.selections[0].options.join("\n"), /OpenAI Codex.*api key/i);
  assert.doesNotMatch(ctx.selections[0].options.join("\n"), /LEAK_ME_NOT|KEY_LEAK_ME_NOT/);
  assert.match(allNotificationText(ctx), /removed.*verified/i);
});

test("logout cancellation, unknown metadata, and failures never claim success or leak errors", async () => {
  const providers = [provider("anthropic", "Anthropic")];
  const logoutCalls = [];
  const runtime = {
    getProviders: () => providers,
    getProvider: (id) => providers.find((entry) => entry.id === id),
    async login() {},
    async listCredentials() {
      return [{ providerId: "anthropic", type: "oauth" }];
    },
    async logout(providerId) {
      logoutCalls.push(providerId);
      throw new Error("failed while deleting SECRET_REFRESH_TOKEN");
    },
  };
  const { pi } = register(runtime);

  const cancelled = fakeContext([undefined]);
  await pi.commands.get("logout").handler("", cancelled);
  assert.equal(logoutCalls.length, 0);
  assert.doesNotMatch(allNotificationText(cancelled), /logged out|removed|complete|verified/i);

  const unknown = fakeContext();
  await pi.commands.get("logout").handler("openai-codex", unknown);
  assert.equal(logoutCalls.length, 0);
  assert.match(allNotificationText(unknown), /no stored credential/i);

  const failed = fakeContext();
  await pi.commands.get("logout").handler("anthropic", failed);
  assert.deepEqual(logoutCalls, ["anthropic"]);
  assert.match(allNotificationText(failed), /logout failed/i);
  assert.doesNotMatch(allNotificationText(failed), /SECRET_REFRESH_TOKEN|logged out|verified/i);
  assert.equal(failed.modelRegistry.refreshCalls, 0);
});
