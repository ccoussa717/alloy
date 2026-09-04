import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const enabled = process.env.ALLOY_RUN_TEAMS_STOCK_E2E === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-teams-stock-"));
const consumer = join(temp, "consumer");
const home = join(temp, "home");
const hostNpm = process.env.PATH.split(":")
  .map((entry) => join(entry, "npm"))
  .find(existsSync);

mkdirSync(consumer, { recursive: true });
mkdirSync(home, { recursive: true });
after(() => rmSync(temp, { recursive: true, force: true }));

function run(command, args, options = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    CI: "1",
    ...(options.env ?? {}),
  };
  delete env.NODE_PATH;
  return spawnSync(command, args, {
    cwd: options.cwd ?? consumer,
    env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
  });
}

const smokeSource = String.raw`
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as stockSdk from "@earendil-works/pi-coding-agent";

const stockPackageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const jitiUrl = pathToFileURL(join(stockPackageRoot, "node_modules/jiti/lib/jiti.mjs"));
const { createJiti } = await import(jitiUrl);
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const portableModule = await jiti.import("@alloy/pi-teams");
const extensionModule = await jiti.import("@alloy/pi-teams/extension");
const portableTeams = extensionModule.default;
const { createStockPiHost } = portableModule;

for (const name of [
  "createAgentSession", "DefaultResourceLoader", "SettingsManager",
  "SessionManager", "ModelRuntime", "getAgentDir",
]) assert.ok(stockSdk[name], "missing stock SDK export: " + name);

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("network use is forbidden in the stock package smoke");
};

const commands = [];
const tools = [];
const api = new Proxy({}, {
  get(_target, property) {
    if (property === "registerCommand") return (name, definition) => commands.push({ name, definition });
    if (property === "registerTool") return (definition) => tools.push(definition);
    throw new Error("unexpected extension API access: " + String(property));
  },
});
portableTeams(api);
assert.deepEqual(commands.map(({ name }) => name), ["team"]);
assert.deepEqual(tools.map(({ name }) => name), ["team"]);

const cwd = realpathSync(process.cwd());
const notices = [];
const context = {
  cwd,
  model: undefined,
  modelRegistry: {},
  isProjectTrusted: () => false,
  signal: undefined,
  hasUI: false,
  ui: { notify: (text) => notices.push(text) },
};
await commands[0].definition.handler("list", context);
await commands[0].definition.handler("inspect builtin/investigate", context);
assert.match(notices[0], /builtin\/investigate/);
assert.match(notices[1], /architecture/);

const executeTool = (params) => tools[0].execute("smoke", params, undefined, undefined, context);
const listed = await executeTool({ action: "list" });
const inspected = await executeTool({ action: "inspect", team: "builtin/investigate" });
const requested = await executeTool({
  action: "request",
  team: "builtin/investigate",
  objective: "Inspect package compatibility without provider execution.",
});
assert.match(listed.content[0].text, /builtin\/investigate/);
assert.match(inspected.content[0].text, /lead/);
assert.equal(requested.details.status, "blocked");
assert.equal(networkCalls, 0);

const model = {
  id: "smoke-model",
  name: "Smoke Model",
  api: "anthropic-messages",
  provider: "smoke-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const provider = {
  id: model.provider,
  name: "Smoke Provider",
  models: [model],
  streamSimple() { throw new Error("provider stream must not run in controlled smoke"); },
};
const authStatus = { configured: true, source: "smoke" };
const registry = {
  find(providerId, modelId) {
    return providerId === model.provider && modelId === model.id ? model : undefined;
  },
  getProviderAuthStatus(providerId) {
    return providerId === model.provider ? authStatus : { configured: false };
  },
  getProvider(providerId) {
    return providerId === model.provider ? provider : undefined;
  },
  getRegisteredNativeProvider(providerId) {
    return providerId === model.provider ? provider : undefined;
  },
  getRegisteredProviderConfig() { return undefined; },
  async getProviderAuth(providerId) {
    assert.equal(providerId, model.provider);
    return { auth: { apiKey: "synthetic-smoke-key" }, source: "smoke" };
  },
};
const runContext = {
  cwd,
  projectId: "a".repeat(64),
  projectTrusted: false,
  source: "command",
  runtime: { model, modelRegistry: registry },
};
const member = {
  id: "researcher",
  route: "research",
  capabilities: ["repo.read"],
  tools: ["read", "grep", "find", "ls"],
  needs: [],
  instructions: "Read repository evidence.",
};
let composed;
const controlledSdk = {
  ...stockSdk,
  async createAgentSession(options) {
    composed = options;
    const listeners = new Set();
    return { session: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(_text, options) {
        assert.deepEqual(options, { expandPromptTemplates: false });
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "Controlled stock composition passed." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        for (const listener of listeners) listener({ type: "message_end", message });
      },
      async abort() {},
      dispose() {},
    }};
  },
};
const host = createStockPiHost({ sdk: controlledSdk, agentDir: join(process.env.HOME, ".pi", "agent") });
const admission = await host.preflightMember({ member, maxCostUsd: 1, timeoutMs: 30000 }, runContext);
assert.equal(admission.ok, true, admission.reason);
const execution = host.runMember({
  runId: "123e4567-e89b-42d3-a456-426614174000",
  objective: "Prove controlled stock child composition.",
  member,
  dependencies: [],
  admission,
  maxCostUsd: admission.maxCostUsd,
  timeoutMs: admission.timeoutMs,
}, runContext, new AbortController().signal);
const result = await execution.result;
assert.equal(result.ok, true, result.error);
assert.equal(result.text, "Controlled stock composition passed.");
assert.equal(composed.noTools, "all");
assert.deepEqual(composed.tools, ["read", "grep", "find", "ls"]);
assert.deepEqual(composed.customTools.map(({ name }) => name), ["read", "grep", "find", "ls"]);
assert.equal(composed.scopedModels.length, 1);
assert.equal(composed.model.provider, model.provider);
assert.equal(networkCalls, 0);
console.log("stock teams packed smoke ok");
`;

describe("integration: packed portable teams on stock Pi 0.84.2", { skip: !enabled }, () => {
  it("installs without source-tree leakage and exercises registration, builtins, and controlled SDK composition", () => {
    assert.ok(hostNpm, "npm must be available");
    const packed = run(hostNpm, [
      "pack", "./packages/pi-teams", "--json", "--pack-destination", temp,
    ], { cwd: root });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [{ filename, files }] = JSON.parse(packed.stdout);
    const paths = files.map(({ path }) => path);
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("src/builtins/investigate.yaml"));
    assert.ok(paths.includes("src/adapters/stock-pi.ts"));
    assert.equal(paths.some((path) => path.startsWith("test/") || path.startsWith("lib/")), false);

    const init = run(hostNpm, ["init", "-y"]);
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const install = run(hostNpm, [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
      join(temp, filename),
      "@earendil-works/pi-coding-agent@0.84.2",
      "typebox@1.1.38",
    ]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const portable = JSON.parse(readFileSync(join(consumer, "node_modules/@alloy/pi-teams/package.json"), "utf8"));
    const stock = JSON.parse(readFileSync(join(consumer, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    const typebox = JSON.parse(readFileSync(join(consumer, "node_modules/typebox/package.json"), "utf8"));
    assert.equal(portable.version, "0.1.0");
    assert.equal(stock.version, "0.84.2");
    assert.equal(typebox.version, "1.1.38");
    assert.match(portable.peerDependencies["@earendil-works/pi-coding-agent"], /0\.85\.0/);
    assert.equal(existsSync(join(consumer, "node_modules/@alloy/pi-teams/test")), false);

    const script = join(consumer, "smoke.mjs");
    writeFileSync(script, smokeSource);
    const smoke = run(process.execPath, [script]);
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.match(smoke.stdout, /stock teams packed smoke ok/);
  });
});
