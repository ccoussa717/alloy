/**
 * Local engine discovery registration: Ollama, llama.cpp, LM Studio.
 * Registers OpenAI-compatible providers during extension load. Never prints secrets.
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
  env?: NodeJS.ProcessEnv;
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
  "llama.cpp-local": "local",
  "lm-studio": "local",
};

const DISPLAY: Record<string, string> = {
  ollama: "Ollama",
  "llama.cpp-local": "llama.cpp (auto-discovered)",
  "lm-studio": "LM Studio",
};

function providerApiKey(id: string, env: NodeJS.ProcessEnv) {
  if (id === "ollama" && env.OLLAMA_API_KEY) return "$OLLAMA_API_KEY";
  if (id === "llama.cpp-local") {
    if (env.LLAMA_CPP_API_KEY) return "$LLAMA_CPP_API_KEY";
    if (env.LLAMA_API_KEY) return "$LLAMA_API_KEY";
  }
  if (id === "lm-studio" && env.LM_STUDIO_API_KEY) return "$LM_STUDIO_API_KEY";
  return PLACEHOLDER[id] || "local";
}

export async function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;
  const env = dependencies.env ?? process.env;
  let bundle;
  try {
    const config = loadConfig();
    bundle = await discover({ config, env });
  } catch {
    bundle = {
      ollama: {
        ok: false,
        provider: "ollama",
        baseUrl: localEngines.getImplicitOllamaBaseUrl(env),
        models: [],
        error: "discovery failed",
      },
      llamaCpp: {
        ok: false,
        provider: localEngines.LLAMA_CPP_LOCAL_PROVIDER_ID,
        baseUrl: localEngines.getImplicitLlamaCppBaseUrl(env),
        models: [],
        error: "discovery failed",
      },
      lmStudio: {
        ok: false,
        provider: "lm-studio",
        baseUrl: localEngines.getImplicitLmStudioBaseUrl(env),
        models: [],
        error: "discovery failed",
      },
    };
  }
  const entries: Array<{ key: "ollama" | "llamaCpp" | "lmStudio"; id: string }> = [
    { key: "ollama", id: "ollama" },
    { key: "llamaCpp", id: localEngines.LLAMA_CPP_LOCAL_PROVIDER_ID },
    { key: "lmStudio", id: "lm-studio" },
  ];
  let registered = 0;
  for (const { key, id } of entries) {
    const result = bundle[key];
    const models = result?.ok && Array.isArray(result.models)
      ? toRegisterModels(result.models)
      : [];
    const firstBase =
      result?.models?.[0]?.baseUrl ||
      localEngines.ensureOpenAiV1BaseUrl(result?.baseUrl);
    try {
      pi.registerProvider(id, {
        name: DISPLAY[id] || id,
        baseUrl: firstBase,
        apiKey: providerApiKey(id, env),
        api: "openai-completions",
        models,
      });
      if (models.length) registered += 1;
    } catch {
      // One conflicting provider must not suppress the other local catalogs.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setStatus("alloy-local", `local:${registered}`);
    } catch {
      // ignore
    }
  });

  return bundle;
}
