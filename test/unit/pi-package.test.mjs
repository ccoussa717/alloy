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
