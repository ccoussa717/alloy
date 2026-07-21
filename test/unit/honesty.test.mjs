import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHonestyBlock,
  withHonesty,
  factsFromContext,
} from "../../lib/honesty.mjs";

describe("honesty policy", () => {
  it("includes non-negotiable no-fabrication rules", () => {
    const block = buildHonestyBlock({
      provider: "xai",
      modelId: "grok-4",
      alloyVersion: "0.7.6",
    });
    assert.match(block, /No fabrication/i);
    assert.match(block, /No confident guessing/i);
    assert.match(block, /Don't know/i);
    assert.match(block, /provider=xai/);
    assert.match(block, /id=grok-4/);
    assert.match(block, /Composer/);
    assert.match(block, /Alloy version \(harness fact\): 0\.7\.6/);
  });

  it("refuses to invent model when unknown", () => {
    const block = buildHonestyBlock({});
    assert.match(block, /unknown in this context/i);
    assert.match(block, /do not invent/i);
  });

  it("withHonesty prepends and avoids double inject", () => {
    const once = withHonesty("BASE PROMPT", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    assert.ok(once.startsWith("# Alloy honesty policy"));
    assert.match(once, /BASE PROMPT/);
    const twice = withHonesty(once, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    const count = (twice.match(/# Alloy honesty policy/g) || []).length;
    assert.equal(count, 1);
  });

  it("factsFromContext reads ctx.model", () => {
    const f = factsFromContext(
      { model: { provider: "openai-codex", id: "gpt-5.1" } },
      { role: "builder" },
    );
    assert.equal(f.provider, "openai-codex");
    assert.equal(f.modelId, "gpt-5.1");
    assert.equal(f.role, "builder");
  });
});
