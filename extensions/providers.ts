/**
 * Three-provider MVP surface: Anthropic, Codex/ChatGPT, xAI Grok.
 * /doctor and /providers — never print secrets.
 * Local engines are surfaced in doctor/providers via discovery (see local-engines).
 */

import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  diagnoseProviders,
  formatFullDoctorReport,
  MVP_PROVIDERS,
} = require(join(root, "lib", "providers.mjs"));
const { diagnoseDocker, formatDockerDoctor } = require(
  join(root, "lib", "docker-sandbox.mjs"),
);
const {
  discoverLocalEngines,
  formatLocalEnginesDoctorSection,
  localEngineDoctorRows,
} = require(join(root, "lib", "local-engines.mjs"));
const { loadGlobalConfig } = require(join(root, "lib", "config.mjs"));
const { getAlloyVersion } = require(join(root, "lib", "version.mjs"));
const { ALLOY_CLAUDE_OPUS_5_MODEL } = require(
  join(root, "lib", "alloy-models.mjs"),
);
const { ensureMvpBuiltinCatalogs } = require(
  join(root, "lib", "model-catalog.mjs"),
);

type ProviderDiagnostic = {
  id: string;
  label: string;
  status: string;
  detail: string;
  loginHint: string;
  ok: boolean;
  freshness?: unknown;
};

type PiAuthRegistry = Pick<
  ModelRegistry,
  "getProviderAuthStatus" | "getProviderAuth"
>;

type ProviderAuthResolution = Awaited<
  ReturnType<PiAuthRegistry["getProviderAuth"]>
>;

const AUTH_DIAGNOSTIC_TIMEOUT_MS = 10_000;
const inFlightAuthResolutions = new WeakMap<
  PiAuthRegistry,
  Map<string, Promise<ProviderAuthResolution>>
>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pi auth diagnostic timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveProviderAuth(
  modelRegistry: PiAuthRegistry,
  providerId: string,
): Promise<ProviderAuthResolution> {
  let providerResolutions = inFlightAuthResolutions.get(modelRegistry);
  if (!providerResolutions) {
    providerResolutions = new Map();
    inFlightAuthResolutions.set(modelRegistry, providerResolutions);
  }
  const active = providerResolutions.get(providerId);
  if (active) return active;

  const resolution = Promise.resolve()
    .then(() => modelRegistry.getProviderAuth(providerId))
    .finally(() => {
      if (providerResolutions.get(providerId) === resolution) {
        providerResolutions.delete(providerId);
      }
    });
  providerResolutions.set(providerId, resolution);
  return resolution;
}

function authRequiresLogin(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const message = current instanceof Error
      ? current.message
      : typeof current === "string"
        ? current
        : "";
    if (/invalid_grant|refresh token.*(?:expired|invalid|revoked)|\b(?:401|403)\b|unauthori[sz]ed/i.test(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export async function diagnoseProvidersWithPiAuth(
  modelRegistry: PiAuthRegistry,
  rawResults: ProviderDiagnostic[] = diagnoseProviders(),
  timeoutMs = AUTH_DIAGNOSTIC_TIMEOUT_MS,
): Promise<ProviderDiagnostic[]> {
  return Promise.all(rawResults.map(async (result) => {
    try {
      const configured = modelRegistry.getProviderAuthStatus(result.id);
      if (!configured.configured) {
        return {
          ...result,
          status: "missing",
          detail: "not configured in Pi's native auth runtime",
          ok: false,
          freshness: undefined,
        };
      }
      const resolved = await withTimeout(
        resolveProviderAuth(modelRegistry, result.id),
        timeoutMs,
      );
      if (!resolved?.auth) {
        return {
          ...result,
          status: "unavailable",
          detail: "Pi native auth could not resolve the configured credential; retry /doctor",
          ok: false,
          freshness: undefined,
        };
      }
      const source = resolved.source?.toLowerCase() ?? "";
      const oauth =
        source.includes("oauth") ||
        result.status === "subscription" ||
        result.status === "refreshable";
      const apiKey =
        ["runtime", "fallback", "models_json_key", "models_json_command"].includes(
          configured.source ?? "",
        ) ||
        result.status === "api_key" ||
        source.includes("api key");
      return {
        ...result,
        status: oauth
          ? "subscription"
          : configured.source === "environment"
            ? "env"
            : apiKey
              ? "api_key"
              : "unknown",
        detail: `Pi native auth resolved ${oauth ? "OAuth" : "provider credentials"}${oauth ? " and refreshes it automatically" : ""}`,
        ok: true,
        freshness: undefined,
      };
    } catch (error) {
      const reauthRequired = authRequiresLogin(error);
      return {
        ...result,
        status: reauthRequired ? "reauth_required" : "unavailable",
        detail: reauthRequired
          ? "Pi rejected the stored authorization; sign in again with /login"
          : "Pi native auth check was unavailable; retry /doctor before changing credentials",
        ok: false,
        freshness: undefined,
      };
    }
  }));
}

export function providerAuthGuidance(
  results: ReadonlyArray<Pick<ProviderDiagnostic, "status">>,
): { needsLogin: number; needsReauth: number; unavailable: number; lines: string[] } {
  const needsLogin = results.filter(
    (result) => result.status === "missing" || result.status === "expired",
  ).length;
  const needsReauth = results.filter(
    (result) => result.status === "reauth_required",
  ).length;
  const unavailable = results.filter(
    (result) => result.status === "unavailable",
  ).length;
  const lines: string[] = [];
  if (needsLogin) {
    lines.push(
      `Run /login to connect ${needsLogin} missing provider${needsLogin === 1 ? "" : "s"}.`,
    );
  }
  if (needsReauth) {
    lines.push(
      `Run /login to reconnect ${needsReauth} provider${needsReauth === 1 ? "" : "s"} whose stored authorization was rejected.`,
    );
  }
  if (unavailable) {
    lines.push(
      `Retry /doctor for ${unavailable} unavailable provider auth check${unavailable === 1 ? "" : "s"}.`,
    );
  }
  return { needsLogin, needsReauth, unavailable, lines };
}

export function withClaudeOpus5(anthropic: Provider): Provider {
  const fallback = ALLOY_CLAUDE_OPUS_5_MODEL;
  return {
    ...anthropic,
    getModels: () => {
      const current = anthropic.getModels();
      return current.some((model) => model.id === fallback.id)
        ? current
        : [...current, fallback];
    },
  };
}

export function registerProviders(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description:
      "Diagnose Alloy versions, providers, model defaults, Docker (never prints secrets)",
    handler: async (_args, ctx) => {
      const results = await diagnoseProvidersWithPiAuth(ctx.modelRegistry);
      const docker = diagnoseDocker(process.cwd());
      let localEnginesText: string | null = null;
      try {
        const localBundle = await discoverLocalEngines({
          config: loadGlobalConfig(),
        });
        localEnginesText = formatLocalEnginesDoctorSection(localBundle);
      } catch {
        // discovery failures must not break hosted /doctor
        localEnginesText =
          "Local engines\n-------------\nDiscovery failed (non-fatal; hosted doctor continues).";
      }
      const full = formatFullDoctorReport({
        results,
        dockerText: formatDockerDoctor(docker),
        localEnginesText,
        includeEconomics: true,
        includeModels: true,
      });

      const footer = [
        "",
        "Commands:",
        "  Sandbox →  /permissions sandbox",
        "  Help    →  /help",
        `ALLOY_ROOT=${process.env.ALLOY_ROOT || "(unset)"}`,
        `ALLOY_VERSION=${process.env.ALLOY_VERSION || getAlloyVersion()}`,
      ].join("\n");

      const report = full + footer;

      if (ctx.hasUI) {
        await ctx.ui.select("Alloy /doctor", report.split("\n"));
      } else {
        console.log(report);
      }

      const guidance = providerAuthGuidance(results);
      for (const line of guidance.lines) ctx.ui.notify(line, "warning");
      if (!guidance.lines.length) {
        ctx.ui.notify("Hosted MVP providers look configured.", "info");
      }
    },
  });

  pi.registerCommand("providers", {
    description:
      "Show hosted MVP + local engine status (Anthropic, Codex, Grok, Ollama, …)",
    handler: async (_args, ctx) => {
      const results = await diagnoseProvidersWithPiAuth(ctx.modelRegistry);
      const items = results.map(
        (r: { ok: boolean; label: string; status: string }) =>
          `${r.ok ? "✓" : "✗"} ${r.label} — ${r.status}`,
      );
      try {
        const localBundle = await discoverLocalEngines({
          config: loadGlobalConfig(),
        });
        const localRows = localEngineDoctorRows(localBundle);
        if (localRows.length) {
          items.push("---");
          items.push("Local engines");
          for (const row of localRows) {
            items.push(
              `${row.ok ? "✓" : "✗"} ${row.label} — ${row.detail}`,
            );
          }
        }
      } catch {
        // discovery failures must not break /providers
      }
      const guidance = providerAuthGuidance(results);
      items.push("---");
      items.push(...(guidance.lines.length
        ? guidance.lines
        : ["Hosted provider authentication resolved through Pi."]));
      items.push("Run /doctor for full detail (economics + catalog + local)");
      await ctx.ui.select("Alloy providers", items);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Ensure full hosted catalogs (e.g. openai-codex gpt-5.6-luna/sol/terra)
    // even when the session registry only exposed a partial subset.
    try {
      ensureMvpBuiltinCatalogs(pi, ctx.modelRegistry);
    } catch {
      // catalog ensure must not block session start
    }

    const anthropic = ctx.modelRegistry.getProvider("anthropic");
    if (
      anthropic &&
      !anthropic.getModels().some((model) => model.id === "claude-opus-5")
    ) {
      pi.registerProvider(withClaudeOpus5(anthropic));
    }

    try {
      const ok = MVP_PROVIDERS.filter(
        (provider: { id: string }) =>
          ctx.modelRegistry.getProviderAuthStatus(provider.id).configured,
      ).length;
      ctx.ui.setStatus("alloy-providers", `auth:${ok}/${MVP_PROVIDERS.length}`);
    } catch {
      // ignore
    }
  });
}
