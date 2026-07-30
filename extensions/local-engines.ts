/**
 * Local engine discovery registration: Ollama, llama.cpp, LM Studio.
 * Registers OpenAI-compatible providers during extension load. Never prints secrets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamOpenAiCompatible } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEngines = require(join(root, "lib", "local-engines.mjs"));
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));
const { getPiAgentDir } = require(join(root, "lib", "paths.mjs"));

type DiscoverFn = typeof localEngines.discoverLocalEngines;

export type LocalEnginesDependencies = {
  discover?: DiscoverFn;
  loadConfig?: () => unknown;
  env?: NodeJS.ProcessEnv;
  manualProviderIds?: () => Set<string>;
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
  if (id === "ollama" && env.OLLAMA_API_KEY?.trim()) return "$OLLAMA_API_KEY";
  if (id === "llama.cpp-local") {
    if (env.LLAMA_CPP_API_KEY?.trim()) return "$LLAMA_CPP_API_KEY";
    if (env.LLAMA_API_KEY?.trim()) return "$LLAMA_API_KEY";
  }
  if (id === "lm-studio" && env.LM_STUDIO_API_KEY?.trim()) return "$LM_STUDIO_API_KEY";
  return PLACEHOLDER[id] || "local";
}

function providerHasApiKey(id: string, env: NodeJS.ProcessEnv) {
  if (id === "ollama") return Boolean(env.OLLAMA_API_KEY?.trim());
  if (id === "llama.cpp-local") {
    return Boolean(env.LLAMA_CPP_API_KEY?.trim() || env.LLAMA_API_KEY?.trim());
  }
  if (id === "lm-studio") return Boolean(env.LM_STUDIO_API_KEY?.trim());
  return false;
}

function loadManualProviderIds() {
  try {
    const parsed = JSON.parse(readFileSync(join(getPiAgentDir(), "models.json"), "utf8"));
    const providers = parsed?.providers;
    return new Set(
      providers && typeof providers === "object" && !Array.isArray(providers)
        ? Object.keys(providers)
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

export async function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;
  const env = dependencies.env ?? process.env;
  const manualProviderIds = (dependencies.manualProviderIds ?? loadManualProviderIds)();
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
  const unavailable: string[] = [];
  for (const { key, id } of entries) {
    if (manualProviderIds.has(id)) continue;
    const result = bundle[key];
    const models = result?.ok && Array.isArray(result.models)
      ? toRegisterModels(result.models)
      : [];
    if (!models.length) {
      unavailable.push(id);
      continue;
    }
    const firstBase =
      result?.models?.[0]?.baseUrl ||
      localEngines.ensureOpenAiV1BaseUrl(result?.baseUrl);
    try {
      const hasApiKey = providerHasApiKey(id, env);
      pi.registerProvider(id, {
        name: DISPLAY[id] || id,
        baseUrl: firstBase,
        apiKey: providerApiKey(id, env),
        api: "openai-completions",
        models,
        streamSimple: (model, context, options) =>
          streamOpenAiCompatible(model, context, hasApiKey
            ? options
            : {
                ...options,
                headers: {
                  ...options?.headers,
                  Authorization: null,
                } as unknown as Record<string, string>,
              }),
      });
      if (models.length) registered += 1;
    } catch {
      // One conflicting provider must not suppress the other local catalogs.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    for (const id of unavailable) {
      try {
        pi.unregisterProvider(id);
      } catch {
        // A missing stale overlay is already the desired state.
      }
    }
    if (
      ctx.model &&
      unavailable.includes(ctx.model.provider) &&
      !ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
    ) {
      const fallback = ctx.modelRegistry.getAvailable().find(
        (model) => !unavailable.includes(model.provider),
      );
      if (fallback) {
        try {
          await pi.setModel(fallback);
        } catch {
          ctx.ui.notify(
            "The active local model is unavailable. Choose /model before prompting.",
            "warning",
          );
        }
      } else {
        ctx.ui.notify(
          "The active local model is unavailable. Start its engine or choose /model.",
          "warning",
        );
      }
    }
    try {
      ctx.ui.setStatus("alloy-local", `local:${registered}`);
    } catch {
      // ignore
    }
  });

  return bundle;
}
