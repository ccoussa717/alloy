import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveListen({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function json(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function runAlloy(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, "bin", "alloy.mjs"), ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Alloy subprocess timed out\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

test("real Pi --list-models includes all discovered local engines before session_start", async (t) => {
  const ollama = await listen((request, response) => {
    if (request.url === "/api/tags") {
      json(response, { models: [{ name: "ollama-test" }] });
      return;
    }
    if (request.url === "/api/show") {
      json(response, { parameters: "num_ctx 4096\n" });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => new Promise((resolveClose) => ollama.server.close(resolveClose)));
  const llama = await listen((request, response) => {
    if (request.url === "/v1/models") {
      json(response, { data: [{ id: "llama-test", status: "loaded" }] });
      return;
    }
    if (request.url === "/props") {
      json(response, { default_generation_settings: { n_ctx: 8192 } });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => new Promise((resolveClose) => llama.server.close(resolveClose)));
  const lmStudio = await listen((request, response) => {
    if (request.url === "/v1/models") {
      json(response, { data: [{ id: "lm-test" }] });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => new Promise((resolveClose) => lmStudio.server.close(resolveClose)));

  const home = await mkdtemp(join(tmpdir(), "alloy-local-engines-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const alloyHome = join(home, ".pi", "alloy");
  await mkdir(agentDir, { recursive: true });

  const childEnv = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ALLOY_HOME: alloyHome,
    OLLAMA_BASE_URL: ollama.url,
    LLAMA_CPP_BASE_URL: llama.url,
    LM_STUDIO_BASE_URL: `${lmStudio.url}/v1`,
  };
  for (const name of [
    "ALLOY_PI_BIN",
    "OLLAMA_HOST",
    "OLLAMA_API_KEY",
    "LLAMA_API_KEY",
    "LLAMA_CPP_API_KEY",
    "LM_STUDIO_API_KEY",
  ]) {
    delete childEnv[name];
  }
  const result = await runAlloy(["--list-models"], childEnv);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ollama\s+ollama-test/);
  assert.match(result.stdout, /llama\.cpp-local\s+llama-test/);
  assert.match(result.stdout, /lm-studio\s+lm-test/);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Provider .* error/i);
});

test("disabled discovery preserves a manual models.json provider", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "alloy-local-manual-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const alloyHome = join(home, ".pi", "alloy");
  await mkdir(agentDir, { recursive: true });
  await mkdir(alloyHome, { recursive: true });
  await writeFile(
    join(alloyHome, "config.json"),
    JSON.stringify({ providers: { local: { enabled: false } } }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "manual-local",
          models: [{
            id: "manual-model",
            name: "Manual Model",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          }],
        },
      },
    }),
  );

  const childEnv = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ALLOY_HOME: alloyHome,
  };
  for (const name of [
    "ALLOY_PI_BIN",
    "OLLAMA_BASE_URL",
    "OLLAMA_HOST",
    "OLLAMA_API_KEY",
    "LLAMA_BASE_URL",
    "LLAMA_CPP_BASE_URL",
    "LLAMA_API_KEY",
    "LLAMA_CPP_API_KEY",
    "LM_STUDIO_BASE_URL",
    "LM_STUDIO_API_KEY",
  ]) {
    delete childEnv[name];
  }
  const result = await runAlloy(["--list-models", "manual-model"], childEnv);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ollama\s+manual-model/);
});
