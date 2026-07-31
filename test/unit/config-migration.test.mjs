import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..", "..");
const home = mkdtempSync(join(tmpdir(), "alloy-config-migration-"));
process.env.ALLOY_HOME = join(home, ".pi", "alloy");

const { getAlloyConfigPath } = await import(
  pathToFileURL(join(root, "lib/paths.mjs")).href
);
const { loadGlobalConfig, saveJson } = await import(
  pathToFileURL(join(root, "lib/config.mjs")).href
);

const hostedOnly = ["anthropic", "openai", "openai-codex", "xai"];
const localProviders = ["ollama", "llama.cpp-local", "lm-studio"];

after(() => rmSync(home, { recursive: true, force: true }));

test("generated 0.8.2 allowlist gains implicit local providers after upgrade", () => {
  const persisted = {
    version: 1,
    providers: {
      allow: hostedOnly,
      favorites: ["anthropic/claude-sonnet-4-5"],
    },
  };
  saveJson(getAlloyConfigPath(), persisted);

  const config = loadGlobalConfig();

  assert.deepEqual(config.providers.allow, [...hostedOnly, ...localProviders]);
  assert.deepEqual(config.providers.favorites, persisted.providers.favorites);
  assert.equal(config.providers.local.enabled, true);
  assert.deepEqual(
    JSON.parse(readFileSync(getAlloyConfigPath(), "utf8")),
    persisted,
  );
});

test("custom provider allowlists remain authoritative", () => {
  const customAllow = ["xai", "anthropic", "openai-codex", "openai"];
  saveJson(getAlloyConfigPath(), {
    version: 1,
    providers: { allow: customAllow },
  });

  assert.deepEqual(loadGlobalConfig().providers.allow, customAllow);
});

test("explicit local settings prevent compatibility migration", () => {
  saveJson(getAlloyConfigPath(), {
    version: 1,
    providers: {
      allow: hostedOnly,
      local: { enabled: false },
    },
  });

  const config = loadGlobalConfig();
  assert.deepEqual(config.providers.allow, hostedOnly);
  assert.equal(config.providers.local.enabled, false);
});

test("malformed allowlist shapes are preserved instead of migrated", () => {
  saveJson(getAlloyConfigPath(), {
    version: 1,
    providers: { allow: "anthropic" },
  });

  assert.equal(loadGlobalConfig().providers.allow, "anthropic");
});
