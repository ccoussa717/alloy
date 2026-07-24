import assert from "node:assert/strict";
import { test } from "node:test";

let broker = null;
try {
  broker = await import("../../lib/credential-broker.mjs");
} catch {
  // RED: the implementation module does not exist yet.
}

test("credential broker selects only credentials required by role models", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: [
      "anthropic/claude",
      "openai-codex/gpt",
      "anthropic/claude-synth",
    ],
    auth: {
      anthropic: { type: "oauth", access: "anthropic-token" },
      "openai-codex": { type: "oauth", access: "openai-token" },
      xai: { type: "api_key", key: "xai-secret" },
    },
    env: {},
  });

  assert.equal(lease.mode, "ephemeral-json");
  assert.deepEqual(Object.keys(lease.authJson).sort(), [
    "anthropic",
    "openai-codex",
  ]);
  assert.deepEqual(lease.providers, ["anthropic", "openai-codex"]);
  assert.deepEqual(lease.missing, []);
  assert.equal(JSON.stringify(lease.authJson).includes("xai-secret"), false);
});

test("credential broker materializes selected API-key environment variables", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: ["openai/gpt"],
    auth: {},
    env: { OPENAI_API_KEY: "openai-secret", XAI_API_KEY: "xai-secret" },
  });

  assert.deepEqual(lease.authJson, {
    openai: { type: "api_key", key: "openai-secret" },
  });
  assert.deepEqual(lease.missing, []);
});

test("credential broker reports selected providers without credentials", () => {
  assert.ok(broker, "credential broker module should exist");
  const lease = broker.selectCredentialLease({
    models: ["anthropic/claude", "xai/grok"],
    auth: {},
    env: {},
  });

  assert.equal(lease.mode, "none");
  assert.equal(lease.authJson, null);
  assert.deepEqual(lease.missing, ["anthropic", "xai"]);
});

test("credential broker rejects unresolved API-key environment references", () => {
  const lease = broker.selectCredentialLease({
    models: ["openai/gpt"],
    auth: { openai: { type: "api_key", key: "$OPENAI_API_KEY" } },
    env: {},
  });

  assert.equal(lease.mode, "none");
  assert.equal(lease.authJson, null);
  assert.deepEqual(lease.missing, ["openai"]);
});
