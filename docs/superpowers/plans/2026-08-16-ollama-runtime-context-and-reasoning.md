# Ollama Runtime Context and Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Alloy register Ollama's usable runtime context and transmit reasoning controls, then provide 32K Qwen profiles that complete real tool-using turns.

**Architecture:** Ollama discovery resolves context from explicit model `num_ctx`, then the service runtime default, then architecture metadata. A provider-specific compatibility profile enables OpenAI-style `reasoning_effort` without changing llama.cpp or LM Studio. Chappie's global 8K throughput tuning stays intact; two Ollama aliases carry explicit 32K windows.

**Tech Stack:** Node.js 22, TypeScript extensions, Node test runner, Pi 0.82.1, Ollama 0.32.13 OpenAI-compatible API.

## Global Constraints

- Keep `/etc/systemd/system/ollama.service.d/10-parallel.conf` unchanged at `OLLAMA_NUM_PARALLEL=8` and `OLLAMA_CONTEXT_LENGTH=8192`.
- Explicit per-model `num_ctx` wins over the service default; the service default wins over architecture metadata.
- Reasoning controls apply only to Ollama models reporting the `thinking` capability.
- Do not rewrite Pi message history unless a 32K real continuation still reproduces `no user query found in messages`.
- Preserve conservative compatibility behavior for llama.cpp and LM Studio.
- Drive every code change with a failing test before implementation.

---

### Task 1: Resolve Ollama's Runtime Context Truthfully

**Files:**
- Modify: `lib/local-engines.mjs:257-305,371-417`
- Test: `test/unit/local-engines.test.mjs:129-199`

**Interfaces:**
- Consumes: `/api/show` fields `parameters` and `model_info`, plus `env.OLLAMA_CONTEXT_LENGTH`.
- Produces: discovered model `contextWindow: number` and bounded `maxTokens: number`.

- [ ] **Step 1: Replace the old environment-precedence test with three failing precedence tests**

```js
test("explicit Ollama num_ctx wins over service and architecture context", async () => {
  const fetchImpl = mockFetch(async (url) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "explicit" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      parameters: "num_ctx 32768\n",
      model_info: { "model.context_length": 262144 },
    }), { status: 200 });
  });
  const result = await mod.discoverOllamaModels({
    fetchImpl,
    env: { OLLAMA_CONTEXT_LENGTH: "8192" },
  });
  assert.equal(result.models[0].contextWindow, 32768);
  assert.equal(result.models[0].maxTokens, 32768);
});

test("Ollama service context wins over architecture metadata", async () => {
  const fetchImpl = mockFetch(async (url) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "service-default" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model_info: { "model.context_length": 262144 },
    }), { status: 200 });
  });
  const result = await mod.discoverOllamaModels({
    fetchImpl,
    env: { OLLAMA_CONTEXT_LENGTH: "8192" },
  });
  assert.equal(result.models[0].contextWindow, 8192);
  assert.equal(result.models[0].maxTokens, 8192);
});

test("Ollama architecture context is the fallback without runtime settings", async () => {
  const fetchImpl = mockFetch(async (url) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "architecture" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model_info: { "model.context_length": 128000 },
    }), { status: 200 });
  });
  const result = await mod.discoverOllamaModels({ fetchImpl, env: {} });
  assert.equal(result.models[0].contextWindow, 128000);
  assert.equal(result.models[0].maxTokens, 32768);
});
```

- [ ] **Step 2: Run the focused tests and confirm the service-default case fails**

Run: `node --test --test-name-pattern="Ollama (num_ctx|service context|architecture context)" test/unit/local-engines.test.mjs`

Expected: the `service context` test fails with actual `262144`; the other precedence cases establish unchanged behavior.

- [ ] **Step 3: Split explicit runtime and architecture extraction, then apply precedence once**

```js
function extractOllamaArchitectureContextWindow(payload) {
  const modelInfo = payload?.model_info;
  if (!modelInfo || typeof modelInfo !== "object") return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key === "context_length" || key.endsWith(".context_length") || key.endsWith(".context_window")) {
      const n = toPositiveNumberOrUndefined(value);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}
```

In `discoverOllamaModels`, replace `hasReportedContext` with separate values and resolve after `/api/show`:

```js
let explicitContext;
let architectureContext;
// Inside successful /api/show handling:
explicitContext = extractOllamaRuntimeContextWindow(show);
architectureContext = extractOllamaArchitectureContextWindow(show);
// After enrichment:
const serviceContext = toPositiveNumberOrUndefined(env.OLLAMA_CONTEXT_LENGTH);
contextWindow = explicitContext ?? serviceContext ?? architectureContext ?? contextWindow;
```

Remove the old condition that applies `OLLAMA_CONTEXT_LENGTH` only when metadata is missing.

- [ ] **Step 4: Run focused and complete local-engine unit tests**

Run: `node --test test/unit/local-engines.test.mjs`

Expected: all tests pass, including all three precedence cases.

- [ ] **Step 5: Commit the context fix**

```bash
git add lib/local-engines.mjs test/unit/local-engines.test.mjs
git commit -m "fix: honor Ollama runtime context"
```

---

### Task 2: Transmit Ollama Reasoning Effort

**Files:**
- Modify: `lib/local-engines.mjs:135-142,257-282,307-319,409-417`
- Modify: `extensions/local-engines.ts:33-43`
- Test: `test/unit/local-engines.test.mjs:129-164`
- Test: `test/integration/local-engines.e2e.test.mjs:72-176`

**Interfaces:**
- Consumes: Ollama `thinking` capability and Alloy/Pi thinking levels `off|low|medium|high`.
- Produces: model `compat.supportsReasoningEffort`, `thinkingLevelMap`, and OpenAI request `reasoning_effort`.

- [ ] **Step 1: Add failing model-spec assertions**

Extend `discoverOllamaModels maps tags and show metadata`:

```js
assert.equal(m.compat.supportsReasoningEffort, true);
assert.deepEqual(m.thinkingLevelMap, {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
});
```

Add a conservative non-Ollama assertion to the existing llama.cpp or LM Studio discovery test:

```js
assert.equal(result.models[0].compat.supportsReasoningEffort, false);
assert.equal(result.models[0].thinkingLevelMap, undefined);
```

- [ ] **Step 2: Run the focused unit tests and confirm the Ollama assertions fail**

Run: `node --test --test-name-pattern="maps tags and show metadata|discoverLlamaCppModels|discoverLmStudioModels" test/unit/local-engines.test.mjs`

Expected: Ollama reports `supportsReasoningEffort: false` and no thinking-level map.

- [ ] **Step 3: Add provider-specific model compatibility and preserve the map during registration**

```js
export const OLLAMA_COMPAT = Object.freeze({
  ...LOCAL_COMPAT,
  supportsReasoningEffort: true,
});

export const OLLAMA_THINKING_LEVEL_MAP = Object.freeze({
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
});
```

Extend `buildLocalModelSpec` with optional `compat = LOCAL_COMPAT` and `thinkingLevelMap`, then return copied values:

```js
thinkingLevelMap,
compat: { ...compat },
```

For discovered Ollama models, pass:

```js
thinkingLevelMap: reasoning ? OLLAMA_THINKING_LEVEL_MAP : undefined,
compat: OLLAMA_COMPAT,
```

Preserve the new field in `extensions/local-engines.ts`:

```ts
thinkingLevelMap: m.thinkingLevelMap,
```

- [ ] **Step 4: Capture the real Pi request in the integration fixture**

In the first integration test, parse each `/v1/chat/completions` request body and retain its effort:

```js
const inferenceRequests = [];
// In the request handler:
let body = "";
request.setEncoding("utf8");
request.on("data", (chunk) => { body += chunk; });
request.on("end", () => {
  const payload = JSON.parse(body);
  inferenceRequests.push({
    authorization: request.headers.authorization,
    reasoningEffort: payload.reasoning_effort,
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"ollama-test","choices":[{"index":0,"delta":{"role":"assistant","content":"local-ok"},"finish_reason":null}]}\n\n');
  response.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"ollama-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
  response.end("data: [DONE]\n\n");
});
```

Make `/api/show` report `capabilities: ["completion", "thinking"]`. Run one inference with `--thinking off` and assert:

```js
assert.deepEqual(inferenceRequests.at(-1), {
  authorization: undefined,
  reasoningEffort: "none",
});
```

Retain the keyed inference assertion by checking its parsed request object rather than the old header-only array.

- [ ] **Step 5: Run reasoning unit and integration tests**

Run: `node --test test/unit/local-engines.test.mjs test/unit/local-engines-extension.test.mjs`

Expected: all unit tests pass.

Run: `node --test --test-force-exit test/integration/local-engines.e2e.test.mjs`

Expected: all integration tests pass and the fake Ollama server observes `reasoning_effort: "none"`.

- [ ] **Step 6: Commit reasoning support**

```bash
git add lib/local-engines.mjs extensions/local-engines.ts test/unit/local-engines.test.mjs test/unit/local-engines-extension.test.mjs test/integration/local-engines.e2e.test.mjs
git commit -m "fix: send Ollama reasoning effort"
```

---

### Task 3: Prepare Alloy 1.1.21

**Files:**
- Modify: `CHANGELOG.md:8-10`
- Modify: `package.json:3`
- Modify: `npm-shrinkwrap.json` root version fields
- Modify: `tui/package.json:3`

**Interfaces:**
- Consumes: completed context and reasoning fixes.
- Produces: release metadata for Alloy `1.1.21`.

- [ ] **Step 1: Add the release entry and version updates**

Insert below `Unreleased`:

```md
## [1.1.21] - 2026-08-16

### Fixed
- **Local Ollama agents no longer silently run out of context.** Alloy now
  distinguishes the server's runtime context from a model's architectural
  maximum, preserves explicit per-model `num_ctx`, and sends Ollama reasoning
  effort controls including `none`.
```

Set `package.json` and `tui/package.json` top-level `version` fields to `1.1.21`. In `npm-shrinkwrap.json`, set both the top-level `version` and `packages[""].version` values to `1.1.21` without changing dependency resolutions or integrity fields.

- [ ] **Step 2: Verify release metadata**

Run: `node bin/alloy.mjs --version`

Expected: output contains `alloy 1.1.21`.

Run: `node --test --test-name-pattern="release metadata verification|version and model catalog" test/unit/*.test.mjs`

Expected: matching release and version tests pass.

- [ ] **Step 3: Commit release metadata**

```bash
git add CHANGELOG.md package.json npm-shrinkwrap.json tui/package.json
git commit -m "chore: prepare Alloy 1.1.21"
```

---

### Task 4: Create and Verify 32K Qwen Alloy Profiles

**Files:**
- Modify outside repository: Ollama manifests through `ollama create`
- Modify outside repository: `/home/chappie/.pi/agent/settings.json`
- Verify unchanged: `/etc/systemd/system/ollama.service.d/10-parallel.conf`

**Interfaces:**
- Consumes: installed branch code, existing `qwen3.8:latest` and `qwen3.6:27b` blobs.
- Produces: `qwen3.8-alloy:latest`, `qwen3.6-alloy:27b`, and real tool-continuation evidence.

- [ ] **Step 1: Run the complete repository verification before host changes**

Run: `npm test`

Expected: all Node unit tests pass.

Run: `npm run typecheck:tui && npm run test:tui`

Expected: TUI typecheck and tests pass.

Run: `node --test --test-force-exit test/integration/local-engines.e2e.test.mjs`

Expected: all local-engine integration tests pass.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Create aliases without duplicating model blobs**

```bash
printf 'FROM qwen3.8:latest\nPARAMETER num_ctx 32768\n' | ollama create qwen3.8-alloy:latest -f -
printf 'FROM qwen3.6:27b\nPARAMETER num_ctx 32768\n' | ollama create qwen3.6-alloy:27b -f -
```

Expected: both commands finish successfully; `ollama list` shows both aliases.

- [ ] **Step 3: Point Alloy's local default at the Qwen 3.8 profile**

After reading the current file, replace only `defaultModel` so the complete file is:

```json
{
  "lastChangelogVersion": "0.82.1",
  "theme": "alloy-dark",
  "defaultProvider": "ollama",
  "defaultModel": "qwen3.8-alloy:latest",
  "defaultThinkingLevel": "high",
  "quietStartup": true,
  "collapseChangelog": true,
  "hideThinkingBlock": true,
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

Keep `defaultThinkingLevel` unchanged at `high`; the 32K profile is intended to support reasoning.

- [ ] **Step 4: Verify live discovery reports ordinary models at 8K and aliases at 32K**

Run:

```bash
node --input-type=module -e "import { discoverOllamaModels } from './lib/local-engines.mjs'; const r=await discoverOllamaModels(); console.log(r.models.filter(m=>/^qwen3\.(6|8)(-alloy)?/.test(m.id)).map(({id,contextWindow,maxTokens,compat,thinkingLevelMap})=>({id,contextWindow,maxTokens,effort:compat.supportsReasoningEffort,thinkingLevelMap})))"
```

Expected: original Qwen models report `8192`; Alloy aliases report `32768`; reasoning-capable models report effort support and `off: "none"`.

- [ ] **Step 5: Verify Qwen 3.8 calls a tool and delivers a final answer**

Run:

```bash
node bin/alloy.mjs --provider ollama --model qwen3.8-alloy:latest --thinking high --no-session -p 'Use the bash tool to run printf QWEN38_TOOL_OK. Then reply with exactly QWEN38_FINAL_OK.'
```

Expected: tool output includes `QWEN38_TOOL_OK`, final visible output is `QWEN38_FINAL_OK`, and the process exits zero without `length` or `no user query found`.

Run: `curl -fsS http://127.0.0.1:11434/api/ps | jq '.models[] | select(.name=="qwen3.8-alloy:latest") | .context_length'`

Expected: `32768`.

- [ ] **Step 6: Verify Qwen 3.6 calls a tool and delivers a final answer**

Run:

```bash
node bin/alloy.mjs --provider ollama --model qwen3.6-alloy:27b --thinking high --no-session -p 'Use the bash tool to run printf QWEN36_TOOL_OK. Then reply with exactly QWEN36_FINAL_OK.'
```

Expected: tool output includes `QWEN36_TOOL_OK`, final visible output is `QWEN36_FINAL_OK`, and the process exits zero without `length` or `no user query found`.

Run: `curl -fsS http://127.0.0.1:11434/api/ps | jq '.models[] | select(.name=="qwen3.6-alloy:27b") | .context_length'`

Expected: `32768`.

- [ ] **Step 7: Confirm global tuning and repository state**

Run: `systemctl show ollama --property=Environment --no-pager`

Expected: includes `OLLAMA_NUM_PARALLEL=8` and `OLLAMA_CONTEXT_LENGTH=8192`.

Run: `git status --short --branch && git log --oneline github/main..HEAD`

Expected: clean branch with only the approved spec, implementation, tests, and release commits.

- [ ] **Step 8: Investigate only if the 32K continuation still fails**

If either real run reports `no user query found in messages`, stop before shipping. Capture the session JSONL and Ollama journal for that turn, prove whether the serialized request retains the original user message, then add a failing `user -> assistant tool call -> tool result -> assistant answer` integration test before changing history serialization.
