/**
 * Local engine discovery registration: Ollama, llama.cpp, LM Studio.
 * Registers OpenAI-compatible providers during extension load. Never prints secrets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamOpenAiCompatible } from "@earendil-works/pi-ai/compat";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const modelConfigUrl = pathToFileURL(join(piDist, "core", "model-config.js")).href;
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
  manualProviders?: () => Map<string, ManualProvider> | undefined | Promise<Map<string, ManualProvider> | undefined>;
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

function discoveredModels(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map(objectValue)
    .filter((model): model is Record<string, unknown> => Boolean(model && modelId(model)));
}

function mergeCompat(base: unknown, override: unknown) {
  const left = objectValue(base);
  const right = objectValue(override);
  if (!right) return left;
  const merged = { ...left, ...right };
  for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs"]) {
    const baseNested = objectValue(left?.[key]);
    const overrideNested = objectValue(right[key]);
    if (baseNested || overrideNested) {
      merged[key] = { ...baseNested, ...overrideNested };
    }
  }
  return merged;
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
  if (!manualProvider) return live;
  const liveWithCompat = live.map((model) => ({
    ...model,
    compat: mergeCompat(model.compat, manualProvider.compat),
  }));
  if (!Array.isArray(manualProvider.models)) return liveWithCompat;

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
  const merged = liveWithCompat.map((model) => {
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

async function loadManualProviders() {
  try {
    const { ModelConfig } = await import(modelConfigUrl);
    const config = await ModelConfig.load(join(getPiAgentDir(), "models.json"));
    if (config.getError()) return undefined;
    return new Map(config.getProviderIds().map((id: string) => [id, config.getProvider(id)]));
  } catch {
    return undefined;
  }
}

export async function registerLocalEngines(
  pi: ExtensionAPI,
  dependencies: LocalEnginesDependencies = {},
) {
  const discover = dependencies.discover ?? localEngines.discoverLocalEngines;
  const loadConfig = dependencies.loadConfig ?? loadGlobalConfig;
  const env = dependencies.env ?? process.env;
  const manualProviders = await (dependencies.manualProviders ?? loadManualProviders)();
  const manualConfigValid = manualProviders !== undefined;
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
    try {
      if (!manualConfigValid) continue;
      const result = bundle?.[key];
      const manual = manualProviders.get(id);
      const discovered = result?.ok ? discoveredModels(result.models) : [];
      if (!discovered.length) {
        if (!manual) unavailable.push(id);
        continue;
      }
      const models = mergeRegisterModels(discovered, manual);
      const firstBase =
        discovered[0]?.baseUrl ||
        localEngines.ensureOpenAiV1BaseUrl(result?.baseUrl);
      const manualBaseUrl = typeof manual?.baseUrl === "string" ? manual.baseUrl : undefined;
      const manualApiKey = typeof manual?.apiKey === "string" ? manual.apiKey : undefined;
      const manualApi = typeof manual?.api === "string" ? manual.api : undefined;
      const manualHeaders = objectValue(manual?.headers) as Record<string, string> | undefined;
      const manualAuthHeader = typeof manual?.authHeader === "boolean" ? manual.authHeader : undefined;
      const hasApiKey = Boolean(manualApiKey) || providerHasApiKey(id, env);
      pi.registerProvider(id, {
        name: typeof manual?.name === "string" && manual.name.trim()
          ? manual.name
          : DISPLAY[id] || id,
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
