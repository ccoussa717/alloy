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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32" || typeof child.pid !== "number") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Alloy subprocess timed out\n${stderr}`));
        return;
      }
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

test("real Pi migrates the generated hosted-only allowlist before local discovery", async (t) => {
  const inferenceHeaders = [];
  const ollama = await listen((request, response) => {
    if (request.url === "/api/tags") {
      json(response, { models: [{ name: "ollama-test" }] });
      return;
    }
    if (request.url === "/api/show") {
      json(response, { parameters: "num_ctx 4096\n" });
      return;
    }
    if (request.url === "/v1/chat/completions") {
      inferenceHeaders.push(request.headers.authorization);
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"ollama-test","choices":[{"index":0,"delta":{"role":"assistant","content":"local-ok"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"ollama-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
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
  await mkdir(alloyHome, { recursive: true });
  await writeFile(
    join(alloyHome, "config.json"),
    JSON.stringify({
      version: 1,
      providers: {
        allow: ["anthropic", "openai", "openai-codex", "xai"],
        favorites: ["anthropic/claude-sonnet-4-5"],
      },
    }),
  );

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

  const keyless = await runAlloy(
    ["--model", "ollama/ollama-test", "--no-session", "-p", "hello"],
    childEnv,
  );
  assert.equal(keyless.code, 0, keyless.stderr);
  assert.match(keyless.stdout, /local-ok/);
  assert.equal(inferenceHeaders.at(-1), undefined);

  const keyed = await runAlloy(
    ["--model", "ollama/ollama-test", "--no-session", "-p", "hello"],
    { ...childEnv, OLLAMA_API_KEY: "inference-secret" },
  );
  assert.equal(keyed.code, 0, keyed.stderr);
  assert.match(keyed.stdout, /local-ok/);
  assert.equal(inferenceHeaders.at(-1), "Bearer inference-secret");
});

test("real Alloy merges live and manual Ollama catalogs", async (t) => {
  const inferenceModels = [];
  const ollama = await listen((request, response) => {
    if (request.url === "/api/tags") {
      json(response, { models: [{ name: "existing-live" }, { name: "new-live" }] });
      return;
    }
    if (request.url === "/api/show") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const { name } = JSON.parse(body);
        json(response, { parameters: `num_ctx ${name === "existing-live" ? 8192 : 4096}\n` });
      });
      return;
    }
    if (request.url === "/v1/chat/completions") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        inferenceModels.push(JSON.parse(body).model);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('data: {"id":"chatcmpl-merge","object":"chat.completion.chunk","created":0,"model":"new-live","choices":[{"index":0,"delta":{"role":"assistant","content":"merged-live-ok"},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"chatcmpl-merge","object":"chat.completion.chunk","created":0,"model":"new-live","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => new Promise((resolveClose) => ollama.server.close(resolveClose)));

  const home = await mkdtemp(join(tmpdir(), "alloy-local-merge-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const alloyHome = join(home, ".pi", "alloy");
  await mkdir(agentDir, { recursive: true });
  await mkdir(alloyHome, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      ollama: {
        baseUrl: `${ollama.url}/v1`,
        api: "openai-completions",
        apiKey: "ollama",
        models: [
          { id: "existing-live", name: "Manual Existing", contextWindow: 65536 },
          { id: "manual-only", name: "Manual Alias" },
        ],
      },
    },
  }));

  const childEnv = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ALLOY_HOME: alloyHome,
    OLLAMA_BASE_URL: ollama.url,
  };
  for (const name of [
    "ALLOY_PI_BIN",
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

  const result = await runAlloy(["--list-models"], childEnv);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ollama\s+existing-live/);
  assert.match(result.stdout, /ollama\s+new-live/);
  assert.match(result.stdout, /ollama\s+manual-only/);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Provider .* error/i);

  const inference = await runAlloy(
    ["--model", "ollama/new-live", "--no-session", "-p", "hello"],
    childEnv,
  );
  assert.equal(inference.code, 0, inference.stderr);
  assert.match(inference.stdout, /merged-live-ok/);
  assert.equal(inference.stderr, "");
  assert.deepEqual(inferenceModels, ["new-live"]);
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
