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

type ManualProvider = Record<string, unknown> & {
  models?: Array<Record<string, unknown>>;
};

export type LocalEnginesDependencies = {
  discover?: DiscoverFn;
  loadConfig?: () => unknown;
  env?: NodeJS.ProcessEnv;
  manualProviders?: () => Map<string, ManualProvider>;
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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function modelId(model: Record<string, unknown>): string | undefined {
  return typeof model.id === "string" && model.id.trim() ? model.id : undefined;
}

function mergeCompat(base: unknown, override: unknown) {
  const left = objectValue(base);
  const right = objectValue(override);
  return left || right ? { ...left, ...right } : undefined;
}

function mergeModel(
  base: Record<string, unknown> | undefined,
  manual: Record<string, unknown>,
  providerCompat: unknown,
) {
  const id = modelId(manual);
  if (!id) return undefined;
  return {
    id,
    name: typeof manual.name === "string" ? manual.name : base?.name ?? id,
    api: manual.api ?? base?.api,
    baseUrl: manual.baseUrl ?? base?.baseUrl,
    reasoning: typeof manual.reasoning === "boolean" ? manual.reasoning : base?.reasoning ?? false,
    thinkingLevelMap: manual.thinkingLevelMap ?? base?.thinkingLevelMap,
    input: Array.isArray(manual.input) ? manual.input : base?.input ?? ["text"],
    cost: { ...ZERO_COST, ...objectValue(base?.cost), ...objectValue(manual.cost) },
    contextWindow: manual.contextWindow ?? base?.contextWindow ?? 128000,
    maxTokens: manual.maxTokens ?? base?.maxTokens ?? 16384,
    headers: objectValue(manual.headers) ?? base?.headers,
    compat: mergeCompat(mergeCompat(base?.compat, providerCompat), manual.compat),
  };
}

function mergeRegisterModels(
  discovered: Array<Record<string, unknown>>,
  manualProvider?: ManualProvider,
) {
  const live = toRegisterModels(discovered);
  if (!manualProvider || !Array.isArray(manualProvider.models)) return live;

  const manualById = new Map<string, Record<string, unknown>>();
  const manualOrder: string[] = [];
  for (const model of manualProvider.models) {
    const record = objectValue(model);
    const id = record && modelId(record);
    if (!record || !id) continue;
    const previous = manualOrder.indexOf(id);
    if (previous >= 0) manualOrder.splice(previous, 1);
    manualOrder.push(id);
    manualById.set(id, record);
  }

  const seen = new Set<string>();
  const merged = live.map((model) => {
    const id = modelId(model)!;
    seen.add(id);
    const manual = manualById.get(id);
    return manual
      ? mergeModel(model, manual, manualProvider.compat)!
      : { ...model, compat: mergeCompat(model.compat, manualProvider.compat) };
  });
  for (const id of manualOrder) {
    if (seen.has(id)) continue;
    const model = mergeModel(undefined, manualById.get(id)!, manualProvider.compat);
    if (model) merged.push(model);
  }
  return merged;
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

function loadManualProviders() {
  try {
    const parsed = JSON.parse(readFileSync(join(getPiAgentDir(), "models.json"), "utf8"));
    const providers = parsed?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return new Map<string, ManualProvider>();
    }
    return new Map(
      Object.entries(providers).filter(
        (entry): entry is [string, ManualProvider] =>
          Boolean(entry[0]) && typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
      ),
    );
  } catch {
    return new Map<string, ManualProvider>();
  }
}

export async function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;
  const env = dependencies.env ?? process.env;
  const manualProviders = (dependencies.manualProviders ?? loadManualProviders)();
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
    const result = bundle[key];
    const manual = manualProviders.get(id);
    const discovered = result?.ok && Array.isArray(result.models) ? result.models : [];
    if (!discovered.length) {
      if (!manual) unavailable.push(id);
      continue;
    }
    const models = mergeRegisterModels(discovered, manual);
    const firstBase =
      result?.models?.[0]?.baseUrl ||
      localEngines.ensureOpenAiV1BaseUrl(result?.baseUrl);
    try {
      const manualBaseUrl = typeof manual?.baseUrl === "string" ? manual.baseUrl : undefined;
      const manualApiKey = typeof manual?.apiKey === "string" ? manual.apiKey : undefined;
      const manualApi = typeof manual?.api === "string" ? manual.api : undefined;
      const manualHeaders = objectValue(manual?.headers) as Record<string, string> | undefined;
      const manualAuthHeader = typeof manual?.authHeader === "boolean" ? manual.authHeader : undefined;
      const hasApiKey = Boolean(manualApiKey) || providerHasApiKey(id, env);
      pi.registerProvider(id, {
        name: DISPLAY[id] || id,
        baseUrl: manualBaseUrl || firstBase,
        apiKey: manualApiKey || providerApiKey(id, env),
        api: manualApi || "openai-completions",
        headers: manualHeaders,
        authHeader: manualAuthHeader,
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
