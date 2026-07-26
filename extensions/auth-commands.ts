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
type AuthUI = ExtensionCommandContext["ui"];
type ActiveLogin = { controller: AbortController; provider: Provider; widgetKey: string };
type AuthState = {
  activeLogins: Map<string, ActiveLogin>;
  current?: { runtime: AuthRuntime; modelRegistry: ExtensionCommandContext["modelRegistry"] };
  pendingCredentialSync: Set<string>;
  replacement?: {
    promise: Promise<Error | undefined>;
    resolve: (error?: Error) => void;
  };
};

export interface AuthCommandDependencies {
  /** Test seam; production commands always resolve the active context registry runtime. */
  resolveRuntime?: (ctx: ExtensionCommandContext) => AuthRuntime | Promise<AuthRuntime>;
  replacementTimeoutMs?: number;
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

class AuthRuntimeSyncError extends Error {
  constructor() {
    super("The active session could not reload the stored OAuth credential.");
    this.name = "AuthRuntimeSyncError";
  }
}

const API_KEY_GUIDANCE =
  "API key entry is unavailable because RPC input is not masked. Use environment variables or models.json/config instead.";
const AUTH_WIDGET_PREFIX = "alloy-auth-login";
// Session replacement cache-busts extensions and runtimes; process-global state bridges pending logins.
const AUTH_STATE = (() => {
  const key = Symbol.for("alloy.auth.state.v1");
  const root = globalThis as unknown as { [key: symbol]: unknown };
  const existing = root[key];
  if (existing) return existing as AuthState;
  const created: AuthState = { activeLogins: new Map(), pendingCredentialSync: new Set() };
  root[key] = created;
  return created;
})();
const ACTIVE_LOGINS = AUTH_STATE.activeLogins;

export function registerAuthCommands(
  pi: ExtensionAPI,
  dependencies: AuthCommandDependencies = {},
) {
  const resolveRuntime = dependencies.resolveRuntime ?? getActiveRuntime;
  const replacementTimeoutMs = dependencies.replacementTimeoutMs ?? 30_000;

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") return;
    AUTH_STATE.replacement?.resolve(new AuthRuntimeSyncError());
    let done!: (error?: Error) => void;
    const promise = new Promise<Error | undefined>((resolve) => (done = resolve));
    let replacement!: NonNullable<AuthState["replacement"]>;
    const timer = setTimeout(() => {
      replacement.resolve(new AuthRuntimeSyncError());
    }, replacementTimeoutMs);
    replacement = {
      promise,
      resolve(error) {
        clearTimeout(timer);
        done(error);
      },
    };
    AUTH_STATE.replacement = replacement;
  });

  pi.on("session_start", async (_event, ctx) => {
    const replacement = AUTH_STATE.replacement;
    let syncError: Error | undefined;
    try {
      const current = { runtime: await resolveRuntime(ctx), modelRegistry: ctx.modelRegistry };
      AUTH_STATE.current = current;
      for (const providerId of AUTH_STATE.pendingCredentialSync) {
        await reloadAndVerifyCredential(current, providerId);
        AUTH_STATE.pendingCredentialSync.delete(providerId);
      }
    } catch (error) {
      syncError = error instanceof Error ? error : new AuthRuntimeSyncError();
      // Command invocation will surface an actionable compatibility error if this persists.
    } finally {
      replacement?.resolve(syncError);
      if (AUTH_STATE.replacement === replacement) AUTH_STATE.replacement = undefined;
    }
  });

  pi.registerCommand("login", {
    description: "Sign in to an OAuth provider: /login [provider]",
    handler: async (args, ctx) => {
      const controller = new AbortController();
      const detachAbort = forwardAbort(ctx.signal, controller);
      const ui = ctx.ui;
      let provider: Provider | undefined;
      let loginOwnsLifecycle = false;

      try {
        const runtime = await resolveRuntime(ctx);
        AUTH_STATE.current = { runtime, modelRegistry: ctx.modelRegistry };
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

        if (ACTIVE_LOGINS.has(provider.id)) {
          ui.notify(
            `Login for ${provider.name} is already in progress. Use /login-cancel ${provider.id} to stop it.`,
            "warning",
          );
          return;
        }

        let announceDeviceFlow!: () => void;
        const deviceFlow = new Promise<void>((resolve) => (announceDeviceFlow = resolve));
        const widgetKey = `${AUTH_WIDGET_PREFIX}-${provider.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        const providerId = provider.id;
        ACTIVE_LOGINS.set(providerId, { controller, provider, widgetKey });
        const login = completeOAuthLogin(
          runtime,
          provider,
          ui,
          controller,
          detachAbort,
          widgetKey,
          announceDeviceFlow,
        ).finally(() => {
          if (ACTIVE_LOGINS.get(providerId)?.controller === controller) {
            ACTIVE_LOGINS.delete(providerId);
          }
        });
        loginOwnsLifecycle = true;

        const first = await Promise.race([
          login.then(() => "complete" as const),
          deviceFlow.then(() => "device-code" as const),
        ]);
        if (first === "device-code") {
          ui.notify(
            `Device-code login for ${provider.name} continues in the background. Alloy will report when it completes.`,
            "info",
          );
          return;
        }
      } catch (error) {
        if (error instanceof AuthCancelledError || controller.signal.aborted) {
          ctx.ui.notify("Login cancelled.", "info");
        } else if (error instanceof AuthRuntimeCompatibilityError) {
          ctx.ui.notify(error.message, "error");
        } else {
          ctx.ui.notify(`OAuth login failed${provider ? ` for ${provider.name}` : ""}.`, "error");
        }
      } finally {
        if (!loginOwnsLifecycle) {
          detachAbort();
        }
      }
    },
  });

  pi.registerCommand("login-cancel", {
    description: "Cancel a device-code login: /login-cancel [provider]",
    handler: async (args, ctx) => {
      const pending = [...ACTIVE_LOGINS.values()];
      if (pending.length === 0) {
        ctx.ui.notify("No device-code login is in progress.", "info");
        return;
      }
      const reference = (args || "").trim().toLowerCase();
      const active = reference
        ? pending.find(({ provider }) =>
            provider.id.toLowerCase() === reference || provider.name.toLowerCase() === reference)
        : pending.length === 1
          ? pending[0]
          : undefined;
      if (!active) {
        ctx.ui.notify(
          reference
            ? `No active login found for "${reference}".`
            : `Multiple logins are active; specify one of: ${pending.map(({ provider }) => provider.id).join(", ")}.`,
          "warning",
        );
        return;
      }
      active.controller.abort();
      ctx.ui.notify(`Cancelling login for ${active.provider.name}.`, "info");
    },
  });

  pi.registerCommand("logout", {
    description: "Remove a stored provider credential: /logout [provider]",
    handler: async (args, ctx) => {
      try {
        const runtime = await resolveRuntime(ctx);
        AUTH_STATE.current = { runtime, modelRegistry: ctx.modelRegistry };
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

        const active = ACTIVE_LOGINS.get(credential.providerId);
        if (active) {
          ctx.ui.notify(
            `Login for ${active.provider.name} is still in progress. Cancel it before logging out.`,
            "warning",
          );
          return;
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

async function completeOAuthLogin(
  runtime: AuthRuntime,
  provider: Provider,
  ui: AuthUI,
  controller: AbortController,
  detachAbort: () => void,
  widgetKey: string,
  onDeviceCode: () => void,
): Promise<void> {
  try {
    const interaction = createInteraction(ui, controller, widgetKey, onDeviceCode);
    await runtime.login(provider.id, "oauth", interaction);
    const stored = await runtime.listCredentials();
    const verified = stored.some(
      (entry) => entry.providerId === provider.id && entry.type === "oauth",
    );
    if (!verified) {
      ui.notify(
        `OAuth credential for ${provider.name} could not be verified after login; completion was not confirmed.`,
        "error",
      );
      return;
    }
    const replacement = AUTH_STATE.replacement;
    if (replacement) {
      AUTH_STATE.pendingCredentialSync.add(provider.id);
      const replacementError = await replacement.promise;
      if (replacementError) throw new AuthRuntimeSyncError();
    }
    if (!replacement || AUTH_STATE.pendingCredentialSync.has(provider.id)) {
      await refreshReplacementRuntime(runtime, provider.id);
    }
    ui.notify(
      `OAuth login for ${provider.name} completed; stored credential verified.`,
      "info",
    );
  } catch (error) {
    if (error instanceof AuthRuntimeSyncError) {
      ui.notify(
        `OAuth credential for ${provider.name} was stored, but the active session could not refresh it. Run /reload before selecting a model.`,
        "error",
      );
    } else if (error instanceof AuthCancelledError || controller.signal.aborted) {
      ui.notify("Login cancelled.", "info");
    } else {
      ui.notify(`OAuth login failed for ${provider.name}.`, "error");
    }
  } finally {
    ui.setWidget(widgetKey, undefined);
    detachAbort();
  }
}

async function refreshReplacementRuntime(completedRuntime: AuthRuntime, providerId: string): Promise<void> {
  const current = AUTH_STATE.current;
  if (!current || current.runtime === completedRuntime) return;
  await reloadAndVerifyCredential(current, providerId);
  AUTH_STATE.pendingCredentialSync.delete(providerId);
}

async function reloadAndVerifyCredential(
  current: NonNullable<AuthState["current"]>,
  providerId: string,
): Promise<void> {
  const store = (current.runtime as unknown as {
    credentials?: { store?: { reload?: () => void } };
  }).credentials?.store;
  if (typeof store?.reload !== "function") throw new AuthRuntimeSyncError();
  store.reload();
  const stored = await current.runtime.listCredentials();
  if (!stored.some((entry) => entry.providerId === providerId && entry.type === "oauth")) {
    throw new AuthRuntimeSyncError();
  }
  await current.modelRegistry.refresh();
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
  ui: AuthUI,
  controller: AbortController,
  widgetKey: string,
  onDeviceCode: () => void = () => {},
): AuthInteraction {
  const promptDetails = new Map<string, string>();
  return {
    signal: controller.signal,
    prompt: (prompt) => answerPrompt(ui, controller, prompt, [...promptDetails.values()]),
    notify: (event) => {
      const detail = authPromptDetail(event);
      if (detail) {
        promptDetails.set(detail.key, detail.text);
        ui.setWidget(
          widgetKey,
          [...promptDetails.values()].flatMap((value, index) => [
            ...(index > 0 ? [""] : []),
            ...value.split("\n"),
          ]),
          { placement: "aboveEditor" },
        );
      }
      notifyAuthEvent(ui, event);
      if (event.type === "device_code") onDeviceCode();
    },
  };
}

async function answerPrompt(
  ui: AuthUI,
  controller: AbortController,
  prompt: AuthPrompt,
  details: readonly string[] = [],
): Promise<string> {
  if (prompt.type === "secret") {
    controller.abort();
    throw new Error(API_KEY_GUIDANCE);
  }

  const signal = combinedSignal(controller.signal, prompt.signal);
  const title = details.length > 0 ? `${details.join("\n")}\n\n${prompt.message}` : prompt.message;
  let answer: string | undefined;
  if (prompt.type === "select") {
    const options = prompt.options.map((option) =>
      option.description ? `${option.label} - ${option.description}` : option.label,
    );
    const selected = await ui.select(title, options, { signal });
    if (selected) answer = prompt.options[options.indexOf(selected)]?.id;
  } else {
    answer = await ui.input(title, prompt.placeholder, { signal });
  }

  if (answer === undefined) {
    controller.abort();
    throw new AuthCancelledError();
  }
  return answer;
}

function authPromptDetail(event: AuthEvent): { key: string; text: string } | undefined {
  if (event.type === "auth_url") {
    return {
      key: "auth_url",
      text: event.instructions ? `${event.url}\n${event.instructions}` : event.url,
    };
  }
  if (event.type === "device_code") {
    return {
      key: "device_code",
      text: `${event.verificationUri}\nDevice code: ${event.userCode}`,
    };
  }
  if (event.type === "info" && event.links?.length) {
    return {
      key: "info_links",
      text: event.links.map((link) => `${link.label ?? "Link"}: ${link.url}`).join("\n"),
    };
  }
  return undefined;
}

function notifyAuthEvent(ui: AuthUI, event: AuthEvent): void {
  if (event.type === "auth_url") {
    const instructions = event.instructions ? `\n${event.instructions}` : "";
    ui.notify(`Open this URL to sign in:\n${event.url}${instructions}`, "info");
    return;
  }
  if (event.type === "device_code") {
    ui.notify(
      `Open ${event.verificationUri} and enter device code ${event.userCode}.`,
      "info",
    );
    return;
  }
  if (event.type === "info") {
    const links = event.links?.map((link) => `${link.label ?? "Link"}: ${link.url}`).join("\n");
    ui.notify(links ? `${event.message}\n${links}` : event.message, "info");
    return;
  }
  ui.notify(event.message, "info");
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
