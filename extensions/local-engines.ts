/**
 * Local engine discovery registration: Ollama, llama.cpp, LM Studio.
 * Registers OpenAI-compatible providers on session_start. Never prints secrets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEngines = require(join(root, "lib", "local-engines.mjs"));
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));

type DiscoverFn = typeof localEngines.discoverLocalEngines;

export type LocalEnginesDependencies = {
  discover?: DiscoverFn;
  loadConfig?: () => unknown;
};

function toRegisterModels(models: Array<Record<string, unknown>>) {
  return models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: m.compat,
  }));
}

const PLACEHOLDER: Record<string, string> = {
  ollama: "ollama",
  "llama.cpp": "local",
  "lm-studio": "local",
};

const DISPLAY: Record<string, string> = {
  ollama: "Ollama",
  "llama.cpp": "llama.cpp",
  "lm-studio": "LM Studio",
};

export function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;

  const runRegister = async (ctx?: {
    ui?: { setStatus?: (key: string, value: string | undefined) => void };
  }) => {
    const config = loadConfig();
    const bundle = await discover({ config });
    const entries: Array<{ key: "ollama" | "llamaCpp" | "lmStudio"; id: string }> =
      [
        { key: "ollama", id: "ollama" },
        { key: "llamaCpp", id: "llama.cpp" },
        { key: "lmStudio", id: "lm-studio" },
      ];
    let registered = 0;
    for (const { key, id } of entries) {
      const result = bundle[key];
      if (!result?.ok || !result.models?.length) continue;
      const firstBase =
        result.models[0]?.baseUrl ||
        localEngines.ensureOpenAiV1BaseUrl(result.baseUrl);
      pi.registerProvider(id, {
        name: DISPLAY[id] || id,
        baseUrl: firstBase,
        apiKey: PLACEHOLDER[id] || "local",
        api: "openai-completions",
        models: toRegisterModels(result.models),
      });
      registered += 1;
    }
    try {
      ctx?.ui?.setStatus?.("alloy-local", `local:${registered}`);
    } catch {
      // ignore
    }
    return bundle;
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await runRegister(ctx);
    } catch {
      // never break session startup
    }
  });
}
