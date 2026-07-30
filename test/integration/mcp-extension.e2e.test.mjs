import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..", "..");
const fixture = join(root, "test", "fixtures", "fake-mcp-server.mjs");
const home = mkdtempSync(join(tmpdir(), "alloy-mcp-extension-home-"));
const project = mkdtempSync(join(tmpdir(), "alloy-mcp-extension-project-"));
const alloyHome = join(home, ".pi", "alloy");
let importSequence = 0;

before(() => {
  process.env.HOME = home;
  process.env.ALLOY_HOME = alloyHome;
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
});

after(() => {
  delete globalThis.__alloyMcpManager;
  delete globalThis.__alloyMcpRegisteredTools;
  delete globalThis.__alloyMcpDeactivatedTools;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function configureGlobal({ enabled, connectOnStart, serverEnabled = true }) {
  writeJson(join(alloyHome, "config.json"), {
    version: 1,
    permissionProfile: "ask-dangerous",
    mcp: { enabled, connectOnStart },
  });
  writeJson(join(alloyHome, "mcp.json"), {
    version: 1,
    servers: {
      fake: {
        command: process.execPath,
        args: [fixture],
        enabled: serverEnabled,
      },
    },
  });
}

function configureProject(mcp) {
  const projectPi = join(project, ".pi");
  rmSync(projectPi, { recursive: true, force: true });
  writeJson(join(projectPi, "alloy.json"), { version: 1, mcp });
}

function clearProjectConfig() {
  rmSync(join(project, ".pi"), { recursive: true, force: true });
}

function configureProjectMcp(servers) {
  writeJson(join(project, ".pi", "alloy-mcp.json"), { version: 1, servers });
}

async function freshMcpExtension() {
  delete globalThis.__alloyMcpManager;
  delete globalThis.__alloyMcpRegisteredTools;
  delete globalThis.__alloyMcpDeactivatedTools;
  importSequence += 1;
  return import(
    `${pathToFileURL(join(root, "extensions", "mcp.ts")).href}?test=${importSequence}`
  );
}

function isolatedChildEnv() {
  const env = {
    HOME: home,
    ALLOY_HOME: alloyHome,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function terminateChild(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill(signal);
  await closed;
}

function createPi() {
  const commands = new Map();
  const events = new Map();
  const tools = [];
  let activeTools = [];
  return {
    commands,
    events,
    tools,
    api: {
      registerCommand: (name, command) => commands.set(name, command),
      registerTool: (tool) => {
        tools.push(tool);
        activeTools = [...new Set([...activeTools, tool.name])];
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => {
        activeTools = [...names];
      },
      on: (event, handler) => events.set(event, handler),
    },
    activeToolNames: () => [...activeTools],
  };
}

function createContext({ trusted, hasUI }) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      cwd: project,
      hasUI,
      isProjectTrusted: () => trusted,
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
        select: async () => undefined,
        setStatus: () => {},
      },
    },
  };
}

function registeredMcpTools(tools) {
  return tools.filter((tool) => tool.name.startsWith("mcp_"));
}

async function startWithExtension(extension, { trusted, hasUI }) {
  const pi = createPi();
  const context = createContext({ trusted, hasUI });
  extension.registerMcp(pi.api);
  await pi.events.get("session_start")({}, context.ctx);
  return { extension, pi, context };
}

async function startSession(options) {
  return startWithExtension(await freshMcpExtension(), options);
}

async function stopSession(run) {
  await run.pi.events.get("session_shutdown")();
}

test("global mcp.enabled=false blocks automatic and explicit connections", async () => {
  configureGlobal({ enabled: false, connectOnStart: true });
  configureProject({});
  const run = await startSession({ trusted: true, hasUI: true });
  try {
    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.equal(registeredMcpTools(run.pi.tools).length, 0);

    await run.pi.commands.get("mcp").handler("connect", run.context.ctx);
    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.equal(registeredMcpTools(run.pi.tools).length, 0);
    assert.ok(
      run.context.notifications.some(({ message }) => /mcp is disabled/i.test(message)),
    );
  } finally {
    await stopSession(run);
  }
});

test("malformed global mcp.enabled fails closed", async () => {
  configureGlobal({ enabled: "false", connectOnStart: true });
  configureProject({});
  const run = await startSession({ trusted: true, hasUI: false });
  try {
    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.equal(registeredMcpTools(run.pi.tools).length, 0);
  } finally {
    await stopSession(run);
  }
});

test("malformed auto-connect and server enablement fail closed", async () => {
  for (const config of [
    { enabled: true, connectOnStart: "false" },
    { enabled: true, connectOnStart: true, serverEnabled: "false" },
  ]) {
    configureGlobal(config);
    configureProject({});
    const run = await startSession({ trusted: true, hasUI: false });
    try {
      assert.equal(run.extension.getMcpManager().listConnections().length, 0);
      assert.equal(registeredMcpTools(run.pi.tools).length, 0);
    } finally {
      await stopSession(run);
    }
  }
});

test("malformed trusted-project mcp.enabled fails closed", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  configureProject({ enabled: "false" });
  const run = await startSession({ trusted: true, hasUI: false });
  try {
    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.equal(registeredMcpTools(run.pi.tools).length, 0);
  } finally {
    await stopSession(run);
  }
});

test("a trusted project can disable MCP but an untrusted project cannot", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  configureProject({ enabled: false });
  configureProjectMcp({
    fake: { command: "project-shadow-must-not-run", enabled: true },
    "project-only": { command: "project-server-must-not-run", enabled: true },
  });

  const trustedRun = await startSession({ trusted: true, hasUI: false });
  try {
    assert.equal(trustedRun.extension.getMcpManager().listConnections().length, 0);
    assert.equal(registeredMcpTools(trustedRun.pi.tools).length, 0);

    const listTool = trustedRun.pi.tools.find(({ name }) => name === "alloy_mcp_list");
    const result = await listTool.execute("call-1", {}, undefined, undefined, trustedRun.context.ctx);
    assert.match(result.content[0].text, /project-only/);
  } finally {
    await stopSession(trustedRun);
  }

  const untrustedRun = await startSession({ trusted: false, hasUI: false });
  try {
    assert.equal(untrustedRun.extension.getMcpManager().listConnections()[0]?.status, "connected");
    assert.deepEqual(
      untrustedRun.extension.getMcpManager().listConnections().map(({ name }) => name),
      ["fake"],
    );
    assert.equal(untrustedRun.extension.getMcpManager().connections.get("fake")?.spec.cwd, project);
    assert.ok(registeredMcpTools(untrustedRun.pi.tools).length >= 2);
  } finally {
    await stopSession(untrustedRun);
  }
});

test("disabling MCP tears down live state and deactivates its tools", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  configureProject({});
  const run = await startSession({ trusted: true, hasUI: true });
  try {
    assert.equal(run.extension.getMcpManager().listConnections()[0]?.status, "connected");
    assert.ok(run.pi.activeToolNames().some((name) => name.startsWith("mcp_")));
    const initialRegistrations = registeredMcpTools(run.pi.tools).length;

    configureGlobal({ enabled: false, connectOnStart: false });
    await run.pi.commands.get("mcp").handler("connect", run.context.ctx);

    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.equal(run.extension.getMcpManager().getRegisteredTools().length, 0);
    assert.ok(!run.pi.activeToolNames().some((name) => name.startsWith("mcp_")));

    configureGlobal({ enabled: true, connectOnStart: false });
    await run.pi.commands.get("mcp").handler("connect", run.context.ctx);
    assert.equal(run.extension.getMcpManager().listConnections()[0]?.status, "connected");
    assert.ok(run.pi.activeToolNames().some((name) => name.startsWith("mcp_")));
    assert.ok(registeredMcpTools(run.pi.tools).length > initialRegistrations);

    configureGlobal({ enabled: true, connectOnStart: false, serverEnabled: false });
    await run.pi.commands.get("mcp").handler("connect", run.context.ctx);
    assert.equal(run.extension.getMcpManager().listConnections().length, 0);
    assert.ok(!run.pi.activeToolNames().some((name) => name.startsWith("mcp_")));
  } finally {
    await stopSession(run);
  }
});

test("a replacement session receives dynamic MCP tools after shutdown", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  configureProject({});
  const extension = await freshMcpExtension();

  const first = await startWithExtension(extension, { trusted: true, hasUI: false });
  assert.ok(registeredMcpTools(first.pi.tools).length >= 2);
  await stopSession(first);

  const second = await startWithExtension(extension, { trusted: true, hasUI: false });
  try {
    assert.ok(registeredMcpTools(second.pi.tools).length >= 2);
  } finally {
    await stopSession(second);
  }
});

test("global auto-connect registers tools before UI and headless startup returns", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  configureProject({});

  for (const hasUI of [true, false]) {
    const run = await startSession({ trusted: true, hasUI });
    try {
      assert.equal(run.extension.getMcpManager().listConnections()[0]?.status, "connected");
      assert.ok(registeredMcpTools(run.pi.tools).length >= 2);
    } finally {
      await stopSession(run);
    }
  }
});

test("successful MCP connect and tool calls do not pin the child event loop", async () => {
  const clientUrl = pathToFileURL(join(root, "lib", "mcp-client.mjs")).href;
  const script = `
const { McpManager, mcpToolName } = await import(${JSON.stringify(clientUrl)});
const manager = new McpManager();
const results = await manager.connectEnabled({
  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixture)}], enabled: true }
});
if (!results[0]?.ok) throw new Error(results[0]?.error || "MCP connect failed");
await manager.callRegistered(mcpToolName("fake", "ping"), { echo: "timer-probe" });
await manager.disconnectAll();
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: isolatedChildEnv(),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP child stayed alive after successful work: ${stderr}`));
      }, 3_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
  } finally {
    await terminateChild(child, "SIGKILL");
  }
  assert.equal(code, 0, stderr);
});

test("real Pi RPC exposes auto-connected MCP state before serving commands", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  clearProjectConfig();
  const child = spawn(
    process.execPath,
    [join(root, "bin", "alloy.mjs"), "--mode", "rpc", "--no-session", "--offline"],
    {
      cwd: project,
      env: isolatedChildEnv(),
    },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`RPC MCP startup timed out: ${stderr || stdout}`)),
        10_000,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (
            message.type === "response" &&
            message.command === "get_sidebar_state" &&
            message.id === "mcp-startup"
          ) {
            clearTimeout(timeout);
            resolve(message);
          }
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`RPC exited ${code}: ${stderr || stdout}`));
        }
      });
      child.stdin.write(
        `${JSON.stringify({ id: "mcp-startup", type: "get_sidebar_state" })}\n`,
      );
    });

    const fake = response.data.mcp.find(({ name }) => name === "fake");
    assert.equal(fake?.status, "connected");
    assert.ok(fake?.toolCount >= 2);
  } finally {
    await terminateChild(child);
  }
});

test("real Pi print mode registers MCP tools before the first prompt", async () => {
  configureGlobal({ enabled: true, connectOnStart: true });
  clearProjectConfig();
  const marker = join(home, "print-mcp-tools.json");
  const verifier = join(home, "print-mcp-verifier.mjs");
  writeFileSync(
    verifier,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getActiveTools().filter((name) => name.startsWith("mcp_"));
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ mode: ctx.mode, tools }));
  });
}
`,
  );

  const child = spawn(
    process.execPath,
    [
      join(root, "bin", "alloy.mjs"),
      "--no-session",
      "--offline",
      "--extension",
      verifier,
      "-p",
      "startup probe",
    ],
    {
      cwd: project,
      env: isolatedChildEnv(),
    },
  );
  child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await new Promise((resolve, reject) => {
      let poll;
      const timeout = setTimeout(
        () => {
          clearInterval(poll);
          reject(new Error(`print MCP startup timed out: ${stderr}`));
        },
        10_000,
      );
      poll = setInterval(() => {
        if (!existsSync(marker)) return;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }, 20);
      child.on("error", (error) => {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        if (existsSync(marker)) return;
        clearInterval(poll);
        clearTimeout(timeout);
        reject(new Error(`print mode exited ${code} before startup probe: ${stderr}`));
      });
    });

    const probe = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(probe.mode, "print");
    assert.ok(probe.tools.length >= 2);
  } finally {
    await terminateChild(child);
  }
});
