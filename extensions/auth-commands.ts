/**
 * RPC-compatible authentication commands backed by Pi's public model runtime.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialInfo,
  Provider,
} from "@earendil-works/pi-ai";
type AuthRuntime = Pick<
  ModelRuntime,
  "getProviders" | "getProvider" | "login" | "logout" | "listCredentials"
>;

export interface AuthCommandDependencies {
  /** Test seam; production commands always resolve the active context registry runtime. */
  resolveRuntime?: (ctx: ExtensionCommandContext) => AuthRuntime | Promise<AuthRuntime>;
}

class AuthCancelledError extends Error {
  constructor() {
    super("Authentication cancelled");
    this.name = "AuthCancelledError";
  }
}

class AuthRuntimeCompatibilityError extends Error {
  constructor() {
    super(
      "Authentication commands are incompatible with this Pi version: ctx.modelRegistry does not expose its active ModelRuntime.",
    );
    this.name = "AuthRuntimeCompatibilityError";
  }
}

const API_KEY_GUIDANCE =
  "API key entry is unavailable because RPC input is not masked. Use environment variables or models.json/config instead.";

export function registerAuthCommands(
  pi: ExtensionAPI,
  dependencies: AuthCommandDependencies = {},
) {
  const resolveRuntime = dependencies.resolveRuntime ?? getActiveRuntime;

  pi.registerCommand("login", {
    description: "Sign in to an OAuth provider: /login [provider]",
    handler: async (args, ctx) => {
      const controller = new AbortController();
      const detachAbort = forwardAbort(ctx.signal, controller);
      let provider: Provider | undefined;

      try {
        const runtime = await resolveRuntime(ctx);
        const providers = oauthProviders(runtime.getProviders());
        const providerRef = (args || "").trim();

        if (providerRef) {
          provider = findProvider(providers, providerRef);
          if (!provider) {
            ctx.ui.notify(
              `Unknown OAuth provider "${providerRef}". Run /login to list OAuth providers. ${API_KEY_GUIDANCE}`,
              "error",
            );
            return;
          }
        } else {
          if (providers.length === 0) {
            ctx.ui.notify(`No OAuth providers are available. ${API_KEY_GUIDANCE}`, "warning");
            return;
          }
          provider = await selectProvider(ctx, "Login with OAuth", providers, controller.signal);
          if (!provider) {
            controller.abort();
            ctx.ui.notify("Login cancelled.", "info");
            return;
          }
        }

        if (provider.auth.apiKey) {
          const oauthLabel = `${provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? "Sign in"} (OAuth)`;
          const apiKeyLabel = "API key (use environment/config; RPC input is not masked)";
          const method = await ctx.ui.select(
            `Authentication method for ${provider.name}`,
            [oauthLabel, apiKeyLabel],
            { signal: controller.signal },
          );
          if (!method) {
            controller.abort();
            ctx.ui.notify("Login cancelled.", "info");
            return;
          }
          if (method !== oauthLabel) {
            ctx.ui.notify(API_KEY_GUIDANCE, "warning");
            return;
          }
        }

        const interaction = createInteraction(ctx, controller);
        await runtime.login(provider.id, "oauth", interaction);
        await ctx.modelRegistry.refresh();
        const stored = await runtime.listCredentials();
        const verified = stored.some(
          (entry) => entry.providerId === provider?.id && entry.type === "oauth",
        );
        if (!verified) {
          ctx.ui.notify(
            `OAuth credential for ${provider.name} could not be verified after login; completion was not confirmed.`,
            "error",
          );
          return;
        }

        ctx.ui.notify(
          `OAuth login for ${provider.name} completed; stored credential verified.`,
          "info",
        );
      } catch (error) {
        if (error instanceof AuthCancelledError || controller.signal.aborted) {
          ctx.ui.notify("Login cancelled.", "info");
        } else if (error instanceof AuthRuntimeCompatibilityError) {
          ctx.ui.notify(error.message, "error");
        } else {
          ctx.ui.notify(`OAuth login failed${provider ? ` for ${provider.name}` : ""}.`, "error");
        }
      } finally {
        detachAbort();
      }
    },
  });

  pi.registerCommand("logout", {
    description: "Remove a stored provider credential: /logout [provider]",
    handler: async (args, ctx) => {
      try {
        const runtime = await resolveRuntime(ctx);
        const credentials = metadataOnly(await runtime.listCredentials());
        if (credentials.length === 0) {
          ctx.ui.notify(
            "No stored credentials to remove. Environment variables and models.json/config are unchanged.",
            "info",
          );
          return;
        }

        const providerRef = (args || "").trim();
        let credential: CredentialInfo | undefined;
        if (providerRef) {
          credential = findCredential(runtime, credentials, providerRef);
          if (!credential) {
            ctx.ui.notify(`No stored credential found for "${providerRef}".`, "error");
            return;
          }
        } else {
          credential = await selectCredential(ctx, runtime, credentials);
          if (!credential) {
            ctx.ui.notify("Logout cancelled.", "info");
            return;
          }
        }

        const providerName = runtime.getProvider(credential.providerId)?.name ?? credential.providerId;
        await runtime.logout(credential.providerId);
        await ctx.modelRegistry.refresh();
        const remaining = metadataOnly(await runtime.listCredentials());
        if (remaining.some((entry) => entry.providerId === credential?.providerId)) {
          ctx.ui.notify(
            `Credential removal for ${providerName} could not be verified; completion was not confirmed.`,
            "error",
          );
          return;
        }

        ctx.ui.notify(`Stored credential for ${providerName} removed and verified.`, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof AuthRuntimeCompatibilityError
            ? error.message
            : "Logout failed. Stored credentials may be unchanged.",
          "error",
        );
      }
    },
  });
}

function getActiveRuntime(ctx: ExtensionCommandContext): AuthRuntime {
  // The pinned ModelRegistry emits this as a public JS field, despite declaring it private in TS.
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  if (!isAuthRuntime(runtime)) throw new AuthRuntimeCompatibilityError();
  return runtime;
}

function isAuthRuntime(runtime: unknown): runtime is AuthRuntime {
  if (!runtime || typeof runtime !== "object") return false;
  const candidate = runtime as Record<string, unknown>;
  return ["getProviders", "getProvider", "login", "logout", "listCredentials"].every(
    (method) => typeof candidate[method] === "function",
  );
}

function oauthProviders(providers: readonly Provider[]): Provider[] {
  return providers
    .filter((provider) => provider.auth.oauth !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function findProvider(providers: readonly Provider[], reference: string): Provider | undefined {
  const normalized = reference.toLowerCase();
  return providers.find(
    (provider) =>
      provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
  );
}

async function selectProvider(
  ctx: ExtensionCommandContext,
  title: string,
  providers: readonly Provider[],
  signal: AbortSignal,
): Promise<Provider | undefined> {
  const options = providers.map((provider) => `${provider.name} (${provider.id})`);
  const selected = await ctx.ui.select(title, options, { signal });
  return selected ? providers[options.indexOf(selected)] : undefined;
}

function createInteraction(
  ctx: ExtensionCommandContext,
  controller: AbortController,
): AuthInteraction {
  return {
    signal: controller.signal,
    prompt: (prompt) => answerPrompt(ctx, controller, prompt),
    notify: (event) => notifyAuthEvent(ctx, event),
  };
}

async function answerPrompt(
  ctx: ExtensionCommandContext,
  controller: AbortController,
  prompt: AuthPrompt,
): Promise<string> {
  if (prompt.type === "secret") {
    controller.abort();
    throw new Error(API_KEY_GUIDANCE);
  }

  const signal = combinedSignal(controller.signal, prompt.signal);
  let answer: string | undefined;
  if (prompt.type === "select") {
    const options = prompt.options.map((option) =>
      option.description ? `${option.label} - ${option.description}` : option.label,
    );
    const selected = await ctx.ui.select(prompt.message, options, { signal });
    if (selected) answer = prompt.options[options.indexOf(selected)]?.id;
  } else {
    answer = await ctx.ui.input(prompt.message, prompt.placeholder, { signal });
  }

  if (answer === undefined) {
    controller.abort();
    throw new AuthCancelledError();
  }
  return answer;
}

function notifyAuthEvent(ctx: ExtensionCommandContext, event: AuthEvent): void {
  if (event.type === "auth_url") {
    const instructions = event.instructions ? `\n${event.instructions}` : "";
    ctx.ui.notify(`Open this URL to sign in:\n${event.url}${instructions}`, "info");
    return;
  }
  if (event.type === "device_code") {
    ctx.ui.notify(
      `Open ${event.verificationUri} and enter device code ${event.userCode}.`,
      "info",
    );
    return;
  }
  if (event.type === "info") {
    const links = event.links?.map((link) => `${link.label ?? "Link"}: ${link.url}`).join("\n");
    ctx.ui.notify(links ? `${event.message}\n${links}` : event.message, "info");
    return;
  }
  ctx.ui.notify(event.message, "info");
}

function metadataOnly(credentials: readonly CredentialInfo[]): CredentialInfo[] {
  return credentials.map(({ providerId, type }) => ({ providerId, type }));
}

function findCredential(
  runtime: AuthRuntime,
  credentials: readonly CredentialInfo[],
  reference: string,
): CredentialInfo | undefined {
  const normalized = reference.toLowerCase();
  return credentials.find((credential) => {
    const name = runtime.getProvider(credential.providerId)?.name;
    return (
      credential.providerId.toLowerCase() === normalized || name?.toLowerCase() === normalized
    );
  });
}

async function selectCredential(
  ctx: ExtensionCommandContext,
  runtime: AuthRuntime,
  credentials: readonly CredentialInfo[],
): Promise<CredentialInfo | undefined> {
  const sorted = [...credentials].sort((left, right) => {
    const leftName = runtime.getProvider(left.providerId)?.name ?? left.providerId;
    const rightName = runtime.getProvider(right.providerId)?.name ?? right.providerId;
    return leftName.localeCompare(rightName);
  });
  const options = sorted.map((credential) => {
    const name = runtime.getProvider(credential.providerId)?.name ?? credential.providerId;
    const type = credential.type === "oauth" ? "OAuth" : "API key";
    return `${name} (${credential.providerId}) - stored ${type}`;
  });
  const selected = await ctx.ui.select("Remove stored credential", options);
  return selected ? sorted[options.indexOf(selected)] : undefined;
}

function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
