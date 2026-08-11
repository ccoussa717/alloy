/**
 * Alloy child policy enforcer — loaded ONLY into child Pi processes via
 * `pi -e <this-file> --no-extensions`.
 *
 * Mechanically consumes ALLOY_CHILD_POLICY (JSON manifest):
 * - evaluateToolPolicy for approval ceiling (ask-all / ask-some / …)
 * - deny host bash when sandbox is required but ALLOY_CHILD_IN_DOCKER ≠ 1
 * - headless fail-closed on "approve" decisions (no interactive UI in children)
 *
 * Prompt/manifest text is not trusted; this extension is the gate.
 */

import {
  createBashTool,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { streamSimple as streamOpenAiCompatible } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { evaluateToolPolicy, formatApprovalDetail } = require(
  join(root, "lib", "capabilities.mjs"),
);
const { toApprovalProfile } = require(join(root, "lib", "project-trust.mjs"));
const { createDockerBashOperations, ensureSandboxContainer } = require(
  join(root, "lib", "docker-sandbox.mjs"),
);
const { ALLOY_CLAUDE_OPUS_5_MODEL } = require(
  join(root, "lib", "alloy-models.mjs"),
);
const { isLocalEngineProvider } = require(join(root, "lib", "local-engines.mjs"));

type ChildManifest = {
  permissionProfile?: string;
  mode?: string;
  readOnly?: boolean;
  sandbox?: boolean;
  sandboxBash?: boolean;
  tools?: string[] | null;
  readRoot?: string | null;
  credentialBroker?: string;
  mechanical?: boolean;
  model?: string | null;
};

const PATH_CONFINED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
]);
const MUTATING_PATH_TOOLS = new Set(["write", "edit"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizePiToolPath(input: string): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

function pathEscapesRoot(
  manifest: ChildManifest,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!manifest.readRoot || !PATH_CONFINED_TOOLS.has(toolName)) return null;
  const rawPath = input.path ?? input.file_path ?? ".";
  if (typeof rawPath !== "string") return "Child enforcer: tool path must be a string";
  try {
    const root = realpathSync(manifest.readRoot);
    const requested = resolve(process.cwd(), normalizePiToolPath(rawPath));
    if (!existsSync(requested) && !MUTATING_PATH_TOOLS.has(toolName)) {
      return `Child enforcer: ${toolName} path could not be verified inside the allowed repository root`;
    }
    let target = requested;
    while (!existsSync(target)) {
      const parent = dirname(target);
      if (parent === target) {
        return `Child enforcer: ${toolName} path could not be verified inside the allowed repository root`;
      }
      target = parent;
    }
    target = realpathSync(target);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `Child enforcer: ${toolName} path escapes the allowed repository root`;
    }
    return null;
  } catch {
    return `Child enforcer: ${toolName} path could not be verified inside the allowed repository root`;
  }
}

function loadManifest(): ChildManifest | null {
  const path = process.env.ALLOY_CHILD_POLICY;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChildManifest;
  } catch {
    return null;
  }
}

/**
 * Pure decision helper — exported path for unit tests via dynamic import of
 * the compiled logic; also used inline by the extension.
 */
export function enforceChildToolCall(
  manifest: ChildManifest | null,
  toolName: string,
  input: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): { block: boolean; reason?: string; decision?: string } {
  if (!manifest || !manifest.mechanical) {
    return {
      block: true,
      reason:
        "Child enforcer: missing mechanical ALLOY_CHILD_POLICY manifest — fail closed",
    };
  }

  if (Array.isArray(manifest.tools) && !manifest.tools.includes(toolName)) {
    return {
      block: true,
      reason: `Child enforcer: ${toolName} is outside the child tool allowlist`,
      decision: "deny",
    };
  }

  const approval = toApprovalProfile(manifest.permissionProfile || "ask-dangerous");
  const sandbox = Boolean(manifest.sandbox);
  const inDocker = env.ALLOY_CHILD_IN_DOCKER === "1";

  const rootViolation = pathEscapesRoot(manifest, toolName, input);
  if (rootViolation) {
    return { block: true, reason: rootViolation, decision: "deny" };
  }

  // Sandbox children must not run host bash outside the container.
  if (sandbox && toolName === "bash" && !inDocker) {
    return {
      block: true,
      reason:
        "Child enforcer: sandbox requires Docker — host bash blocked (ALLOY_CHILD_IN_DOCKER≠1)",
      decision: "deny",
    };
  }

  const result = evaluateToolPolicy({
    toolName,
    input,
    mode: manifest.mode || "build",
    readOnlyMode: Boolean(manifest.readOnly),
    permissionProfile: approval,
  });

  if (result.decision === "deny") {
    return {
      block: true,
      reason: result.reason || `Denied ${toolName}`,
      decision: "deny",
    };
  }

  if (result.decision === "approve") {
    // Children are headless — cannot prompt. Fail closed at the parent ceiling.
    const detail = formatApprovalDetail(toolName, input);
    return {
      block: true,
      reason: `Child enforcer fail-closed (${approval}): would require approval for ${toolName}${detail ? ` — ${detail}` : ""}`,
      decision: "approve",
    };
  }

  return { block: false, decision: "allow" };
}

export function installRuntimeCredential(
  pi: ExtensionAPI,
  rawEnvelope: string,
  selectedModel?: string | null,
) {
  if (!rawEnvelope || rawEnvelope.length > 64 * 1024) {
    throw new Error("Invalid runtime credential envelope");
  }
  const credential = JSON.parse(rawEnvelope) as {
    version?: unknown;
    provider?: unknown;
    apiKey?: unknown;
    headers?: unknown;
    env?: unknown;
    baseUrl?: unknown;
    transport?: unknown;
  };
  if (
    !credential ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    Object.keys(credential).some(
      (key) =>
        !["version", "provider", "apiKey", "headers", "transport"].includes(key),
    )
  ) {
    throw new Error("Invalid runtime credential envelope");
  }
  const provider = credential?.provider;
  const apiKey = credential?.apiKey;
  if (
    credential?.version !== 1 ||
    typeof provider !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(provider) ||
    typeof apiKey !== "string" ||
    !apiKey ||
    credential.env != null ||
    credential.baseUrl != null
  ) {
    throw new Error("Invalid runtime credential envelope");
  }
  const headers: Record<string, string> = {};
  if (credential.headers != null) {
    if (
      typeof credential.headers !== "object" ||
      Array.isArray(credential.headers) ||
      Object.getPrototypeOf(credential.headers) !== Object.prototype
    ) {
      throw new Error("Invalid runtime credential envelope");
    }
    for (const [name, value] of Object.entries(credential.headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof value !== "string"
      ) {
        throw new Error("Invalid runtime credential envelope");
      }
      headers[name] = value;
    }
  }

  // Local engines: full OpenAI-compatible transport must be brokered because
  // children load only this enforcer (no local-engines discovery extension).
  if (credential.transport != null) {
    if (!isLocalEngineProvider(provider)) {
      throw new Error("Runtime transport is only allowed for local engines");
    }
    const transport = credential.transport as {
      baseUrl?: unknown;
      api?: unknown;
      model?: Record<string, unknown>;
    };
    let baseUrl: string;
    try {
      const parsed = new URL(String(transport.baseUrl || ""));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
      baseUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      throw new Error("Invalid local engine transport baseUrl");
    }
    if (transport.api !== "openai-completions") {
      throw new Error("Invalid local engine transport api");
    }
    const model = transport.model;
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      typeof model.id !== "string" ||
      !String(model.id).trim()
    ) {
      throw new Error("Invalid local engine transport model");
    }
    const modelId = String(model.id);
    // Placeholder keys ("ollama"/"local") must not force Authorization headers.
    const hasRealKey =
      apiKey !== "ollama" &&
      apiKey !== "local" &&
      !apiKey.startsWith("$");
    pi.registerProvider(provider, {
      baseUrl,
      apiKey,
      api: "openai-completions",
      ...(Object.keys(headers).length ? { headers } : {}),
      models: [
        {
          id: modelId,
          name:
            typeof model.name === "string" && model.name
              ? model.name
              : modelId,
          reasoning: Boolean(model.reasoning),
          input: Array.isArray(model.input) ? model.input : ["text"],
          cost:
            model.cost && typeof model.cost === "object"
              ? model.cost
              : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          compat: model.compat,
        },
      ],
      streamSimple: (streamModel, context, options) =>
        streamOpenAiCompatible(
          streamModel,
          context,
          hasRealKey
            ? options
            : {
                ...options,
                headers: {
                  ...options?.headers,
                  Authorization: null,
                } as unknown as Record<string, string>,
              },
        ),
    });
    return;
  }

  const canonicalModel =
    selectedModel === "anthropic/claude-opus-5" && provider === "anthropic"
      ? ALLOY_CLAUDE_OPUS_5_MODEL
      : null;
  const providerModel = canonicalModel
    ? Object.fromEntries(
        Object.entries(canonicalModel).filter(([key]) => key !== "provider"),
      )
    : null;
  pi.registerProvider(provider, {
    apiKey,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(providerModel
      ? {
          baseUrl: canonicalModel.baseUrl,
          api: canonicalModel.api,
          models: [providerModel],
        }
      : {}),
  });
}

export default function childEnforcerExtension(pi: ExtensionAPI) {
  const manifest = loadManifest();
  if (process.env.ALLOY_CHILD_CREDENTIAL_STDIN === "1") {
    try {
      installRuntimeCredential(pi, readFileSync(0, "utf8"), manifest?.model);
    } catch {
      console.error(
        "Alloy child-enforcer: runtime credential handoff failed closed",
      );
    }
  }
  if (!manifest) {
    console.error(
      "Alloy child-enforcer: ALLOY_CHILD_POLICY missing or unreadable — all tools will be blocked",
    );
  }
  if (manifest?.sandboxBash && !manifest.sandbox) {
    const hostBash = createBashTool(process.cwd());
    pi.registerTool({
      ...hostBash,
      async execute(id, params, signal, onUpdate) {
        ensureSandboxContainer(process.cwd());
        const sandboxed = createBashTool(process.cwd(), {
          operations: createDockerBashOperations(
            process.cwd(),
          ) as BashOperations,
        });
        return sandboxed.execute(id, params, signal, onUpdate);
      },
    });
  }

  pi.on("tool_call", async (event) => {
    const decision = enforceChildToolCall(
      manifest,
      event.toolName,
      (event.input || {}) as Record<string, unknown>,
      process.env,
    );
    if (decision.block) {
      return {
        block: true,
        reason: decision.reason || "Blocked by Alloy child policy enforcer",
      };
    }
    return undefined;
  });
}
