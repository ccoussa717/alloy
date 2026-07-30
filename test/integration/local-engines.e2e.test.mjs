import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
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
  const lmStudio = await listen((request, response) => {
    if (request.url === "/v1/models") {
      json(response, { data: [{ id: "lm-test" }] });
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => Promise.all([
    new Promise((resolveClose) => ollama.server.close(resolveClose)),
    new Promise((resolveClose) => llama.server.close(resolveClose)),
    new Promise((resolveClose) => lmStudio.server.close(resolveClose)),
  ]));

  const home = await mkdtemp(join(tmpdir(), "alloy-local-engines-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, ".pi", "agent");
  const alloyHome = join(home, ".pi", "alloy");
  await mkdir(agentDir, { recursive: true });

  const result = await runAlloy(["--list-models"], {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    ALLOY_HOME: alloyHome,
    OLLAMA_BASE_URL: ollama.url,
    LLAMA_CPP_BASE_URL: llama.url,
    LM_STUDIO_BASE_URL: `${lmStudio.url}/v1`,
  });

  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ollama\s+ollama-test/);
  assert.match(result.stdout, /llama\.cpp-local\s+llama-test/);
  assert.match(result.stdout, /lm-studio\s+lm-test/);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Provider .* error/i);
});
