import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  findPackageRoot,
  findPiCli,
  findPiRuntime,
  readPackageVersion,
} from "../../lib/pi-package.mjs";

const temp = mkdtempSync(join(tmpdir(), "alloy-pi-package-"));

after(() => rmSync(temp, { recursive: true, force: true }));

function fakePackage(root, name, version, files = []) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
}

test("finds Pi when npm hoists it beside the installed Alloy package", () => {
  const alloyRoot = join(temp, "hoisted", "node_modules", "alloy-agent");
  const piRoot = join(
    temp,
    "hoisted",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  mkdirSync(alloyRoot, { recursive: true });
  fakePackage(piRoot, "@earendil-works/pi-coding-agent", "0.82.0", [
    "dist/cli.js",
  ]);

  assert.equal(
    findPackageRoot("@earendil-works/pi-coding-agent", [alloyRoot]),
    piRoot,
  );
  assert.equal(findPiCli([alloyRoot]), join(piRoot, "dist", "cli.js"));
  assert.deepEqual(findPiRuntime([alloyRoot]), {
    packageRoot: piRoot,
    cli: join(piRoot, "dist", "cli.js"),
    nodeModulesRoot: join(temp, "hoisted", "node_modules"),
  });
  assert.equal(readPackageVersion(piRoot), "0.82.0");
});

test("prefers a nested Pi dependency and validates the package identity", () => {
  const alloyRoot = join(temp, "nested", "alloy-agent");
  const wrongRoot = join(
    alloyRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  fakePackage(wrongRoot, "not-pi", "9.9.9", ["dist/cli.js"]);

  assert.equal(
    findPackageRoot("@earendil-works/pi-coding-agent", [alloyRoot]),
    null,
  );
  assert.equal(findPiCli([alloyRoot]), null);
});

test("installed Pi AI distinguishes token and non-token incomplete responses", async () => {
  const model = {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  };
  const output = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  async function* incomplete(reason) {
    yield {
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        id: `resp_${reason}`,
        status: "incomplete",
        incomplete_details: { reason },
        usage: {
          input_tokens: 30,
          output_tokens: 1,
          total_tokens: 31,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    };
  }

  for (const reason of ["content_filter", "max_time_limit"]) {
    const message = structuredClone(output);
    await processResponsesStream(
      incomplete(reason),
      message,
      new AssistantMessageEventStream(),
      model,
    );
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, `Response incomplete: ${reason}`);
  }

  const lengthMessage = structuredClone(output);
  await processResponsesStream(
    incomplete("max_output_tokens"),
    lengthMessage,
    new AssistantMessageEventStream(),
    model,
  );
  assert.equal(lengthMessage.stopReason, "length");
  assert.equal(lengthMessage.errorMessage, undefined);
});

test("installed Pi compacts and retries one partial length stop", async (t) => {
  const cwd = process.cwd();
  const agentDir = join(temp, "agent-session");
  mkdirSync(agentDir, { recursive: true });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const model = {
    id: "synthetic-overflow",
    name: "Synthetic overflow model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    noTools: "all",
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
  });
  t.after(() => session.dispose());

  const responses = [
    { text: "partial answer", stopReason: "length", output: 1 },
    { text: "summary checkpoint", stopReason: "stop", output: 4 },
    { text: "completed response", stopReason: "stop", output: 2 },
  ];
  let streamCalls = 0;
  session.agent.streamFunction = (requestModel) => {
    const response = responses[streamCalls++];
    assert.ok(response, "unexpected extra model call");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: response.text }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: {
        input: 100,
        output: response.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100 + response.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: response.stopReason,
      timestamp: Date.now() + streamCalls,
    };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => stream.push({
      type: "done",
      reason: message.stopReason,
      message,
    }));
    return stream;
  };

  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("x".repeat(115680));

  assert.equal(streamCalls, 3);
  assert.equal(
    events.filter((event) => event.type === "compaction_start" && event.reason === "overflow").length,
    1,
  );
  const compactionEnd = events.find(
    (event) => event.type === "compaction_end" && event.reason === "overflow",
  );
  assert.deepEqual(
    { aborted: compactionEnd?.aborted, willRetry: compactionEnd?.willRetry },
    { aborted: false, willRetry: true },
  );
  assert.ok(compactionEnd?.result);
  assert.equal(events.filter((event) => event.type === "agent_end").length, 2);
  assert.equal(
    session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
    1,
  );
  assert.equal(session.getLastAssistantText(), "completed response");
});
