import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const fusion = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "fusion.mjs")).href
);

test("resolveFusionModels uses config fusion.models", () => {
  const models = fusion.resolveFusionModels(
    {
      fusion: {
        models: ["anthropic/claude-a", "openai-codex/gpt-b", "xai/grok-c"],
      },
      providers: { favorites: [] },
    },
    2,
  );
  assert.equal(models.length, 3);
  assert.equal(models[0], "anthropic/claude-a");
});

test("resolveFusionModels falls back to favorites", () => {
  const models = fusion.resolveFusionModels(
    {
      fusion: { models: [] },
      providers: {
        favorites: ["anthropic/x", "xai/y"],
      },
    },
    2,
  );
  assert.deepEqual(models, ["anthropic/x", "xai/y"]);
});

test("resolveFusionModels pads to count", () => {
  const models = fusion.resolveFusionModels({ fusion: {}, providers: {} }, 2);
  assert.equal(models.length, 2);
});
