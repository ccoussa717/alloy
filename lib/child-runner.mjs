/**
 * Spawn isolated Pi child processes for Alloy roles (child-policy).
 *
 * Axes (orthogonal):
 *   - approval: ask-all | ask-some | ask-dangerous | ask-none
 *   - sandbox: boolean (Docker isolation)
 *
 * Guarantees:
 * - Parent approval ceiling is mechanical (child-enforcer extension + clamp)
 * - Sandbox children execute inside Docker when daemon is up (never host spawn)
 * - Children get isolated HOME / PI_CODING_AGENT_DIR (host auth.json not mounted)
 * - Runtime credentials are consumed from stdin before tools run, never files/argv/env
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  toApprovalProfile,
  stricterApproval,
  isSandboxProfileId,
  parentPolicyAxes,
} from "./project-trust.mjs";
import {
  diagnoseDocker,
  getSandboxConfig,
  sandboxContainerName,
} from "./docker-sandbox.mjs";
import { findPiRuntime, piRuntimeFromCli } from "./pi-package.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = join(__dirname, "..");
const CHILD_ENFORCER = join(ALLOY_ROOT, "extensions", "child-enforcer.ts");

/** Max captured stdout / stderr bytes per stream */
export const CHILD_STREAM_LIMIT = 8 * 1024 * 1024; // 8 MiB
/** Max JSONL events retained in memory */
export const CHILD_EVENT_LIMIT = 5000;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeThinkingLevel(value) {
  if (value == null || value === "") return null;
  const level = String(value).toLowerCase();
  if (!THINKING_LEVELS.has(level)) {
    throw new Error(`Invalid child thinking level: ${value}`);
  }
  return level;
}

/**
 * Provider credential env keys — never forwarded to children.
 */
export const PROVIDER_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "XAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
];

const PROVIDER_CREDENTIAL_SET = new Set(PROVIDER_CREDENTIAL_ENV_KEYS);

/**
 * Env keys that may be copied from the host process.
 * NOTE: HOME and PI_CODING_AGENT_DIR are intentionally omitted from host copy —
 * children always receive isolated paths (credential boundary).
 */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "COLORTERM",
  "NODE_ENV",
  "NODE_PATH",
  "ALLOY_ROOT",
  "ALLOY_VERSION",
  "ALLOY_PI_BIN",
  "npm_config_cache",
];

function exists(p) {
  try {
    return Boolean(p && existsSync(p));
  } catch {
    return false;
  }
}

function findPiInvocation() {
  if (process.env.ALLOY_PI_BIN && exists(process.env.ALLOY_PI_BIN)) {
    const bin = process.env.ALLOY_PI_BIN;
    if (bin.endsWith(".js") || bin.endsWith(".mjs")) {
      const runtime = piRuntimeFromCli(bin);
      return {
        command: process.execPath,
        argsPrefix: [bin],
        piNodeModulesRoot: runtime?.nodeModulesRoot || null,
      };
    }
    return { command: bin, argsPrefix: [], piNodeModulesRoot: null };
  }

  const localRuntime = findPiRuntime([ALLOY_ROOT]);
  if (localRuntime) {
    return {
      command: process.execPath,
      argsPrefix: [localRuntime.cli],
      piNodeModulesRoot: localRuntime.nodeModulesRoot,
    };
  }

  const candidates = [];
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    if (r.status === 0) {
      candidates.push(
        join(
          r.stdout.trim(),
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        ),
      );
    }
  } catch {
    // ignore
  }

  for (const c of candidates) {
    const runtime = piRuntimeFromCli(c);
    if (runtime) {
      return {
        command: process.execPath,
        argsPrefix: [runtime.cli],
        piNodeModulesRoot: runtime.nodeModulesRoot,
      };
    }
  }

  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["pi"],
    { encoding: "utf8" },
  );
  if (which.status === 0) {
    const line = which.stdout.trim().split("\n")[0]?.trim();
    if (line && exists(line)) {
      return { command: line, argsPrefix: [], piNodeModulesRoot: null };
    }
  }

  throw new Error(
    "Pi CLI not found. Run npm ci in a source checkout, reinstall Alloy, or set ALLOY_PI_BIN.",
  );
}

function extractText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/**
 * Create an isolated HOME + PI_CODING_AGENT_DIR for a child.
 * Host auth.json is never copied/linked (narrow boundary).
 * @returns {{ home: string, piDir: string, authPath: string }}
 */
export function createIsolatedChildHome() {
  const home = mkdtempSync(join(tmpdir(), "alloy-child-home-"));
  const piDir = join(home, ".pi", "agent");
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  return {
    home,
    piDir,
    authPath: join(piDir, "auth.json"),
  };
}

/**
 * Optional narrow broker: provision a minimal ephemeral auth.json into the
 * isolated child dir from a caller-supplied payload (never from host path mount).
 * Default is none — children start without credentials unless explicitly brokered.
 *
 * @param {string} piDir
 * @param {{ mode?: 'none'|'ephemeral-json', authJson?: object|string }} [opts]
 */
export function provisionChildAuthBroker(piDir, opts = {}) {
  const mode = opts.mode || "none";
  if (mode === "none" || !opts.authJson) {
    return { provisioned: false, mode: "none", path: join(piDir, "auth.json") };
  }
  if (mode !== "ephemeral-json") {
    throw new Error(`Unknown credential broker mode: ${mode}`);
  }
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const path = join(piDir, "auth.json");
  const body =
    typeof opts.authJson === "string"
      ? opts.authJson
      : JSON.stringify(opts.authJson, null, 2) + "\n";
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return { provisioned: true, mode, path };
}

export function buildChildRuntimeCredentialEnvelope(credential) {
  if (credential?.env != null || credential?.baseUrl != null) {
    throw new Error("Runtime credential cannot override environment or transport");
  }
  if (
    !credential ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    Object.keys(credential).some(
      (key) => !["provider", "apiKey", "headers"].includes(key),
    )
  ) {
    throw new Error("Invalid provider-scoped runtime credential");
  }
  const { provider, apiKey } = credential;
  if (
    typeof provider !== "string" ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(provider) ||
    typeof apiKey !== "string" ||
    !apiKey
  ) {
    throw new Error("Invalid provider-scoped runtime credential");
  }
  if (
    credential.headers != null &&
    (typeof credential.headers !== "object" ||
      Array.isArray(credential.headers) ||
      Object.getPrototypeOf(credential.headers) !== Object.prototype)
  ) {
    throw new Error("Invalid provider-scoped runtime credential headers");
  }
  const headers = {};
  for (const [name, value] of Object.entries(credential.headers || {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      typeof value !== "string"
    ) {
      throw new Error("Invalid provider-scoped runtime credential header");
    }
    headers[name] = value;
  }
  return JSON.stringify({
    version: 1,
    provider,
    apiKey,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
}

/**
 * Build scrubbed child environment.
 * Never copies host HOME / PI_CODING_AGENT_DIR / provider keys.
 * Caller must pass isolated home paths via extra or isolatedHome.
 *
 * @param {Record<string, string>} [extra]
 * @param {{ allowProviderCredentials?: boolean, isolatedHome?: { home: string, piDir: string } }} [opts]
 */
export function buildChildEnv(extra = {}, opts = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] != null && process.env[key] !== "") {
      out[key] = process.env[key];
    }
  }
  if (!out.PATH && process.env.PATH) out.PATH = process.env.PATH;

  out.ALLOY_ROOT = ALLOY_ROOT;
  out.ALLOY_CHILD = "1";
  out.ALLOY_VERSION = process.env.ALLOY_VERSION || out.ALLOY_VERSION || "0.8.2";

  // Isolated identity — never host HOME / PI_CODING_AGENT_DIR
  if (opts.isolatedHome) {
    out.HOME = opts.isolatedHome.home;
    out.PI_CODING_AGENT_DIR = opts.isolatedHome.piDir;
    out.ALLOY_HOME = join(opts.isolatedHome.home, ".pi", "alloy");
  }

  for (const [k, v] of Object.entries(extra || {})) {
    if (v == null) continue;
    if (k === "ALLOY_CHILD_FORBIDDEN") continue;
    if (PROVIDER_CREDENTIAL_SET.has(k) && !opts.allowProviderCredentials) {
      continue;
    }
    // Refuse host identity override smuggling of credential dirs unless isolated
    if (
      (k === "HOME" || k === "PI_CODING_AGENT_DIR" || k === "ALLOY_HOME") &&
      opts.isolatedHome
    ) {
      continue; // isolated paths win
    }
    out[k] = String(v);
  }

  if (!opts.allowProviderCredentials) {
    for (const k of PROVIDER_CREDENTIAL_ENV_KEYS) {
      delete out[k];
    }
  }

  // Final belt: never point child at process.env host credential dirs
  if (opts.isolatedHome) {
    out.HOME = opts.isolatedHome.home;
    out.PI_CODING_AGENT_DIR = opts.isolatedHome.piDir;
  }

  return out;
}

/**
 * Mechanically clamp child request to parent approval ceiling + sandbox flag.
 * Approval and sandbox are orthogonal — parent ask-all + sandbox stays ask-all.
 *
 * @param {object} opts
 */
export function resolveChildExecutionPolicy(opts = {}) {
  // Parent axes: approval + isolation (orthogonal)
  const parentSandbox =
    Boolean(opts.parentSandbox) ||
    isSandboxProfileId(opts.parentPermissionProfile);

  const parentApproval = toApprovalProfile(
    opts.parentPermissionProfile ??
      (isSandboxProfileId(opts.permissionProfile) && !opts.parentPermissionProfile
        ? "ask-dangerous"
        : opts.permissionProfile) ??
      "ask-dangerous",
  );

  const requestedApproval = toApprovalProfile(
    opts.permissionProfile ?? parentApproval,
  );

  // Never more autonomous than parent on the approval axis
  const approval = stricterApproval(requestedApproval, parentApproval);

  // Sandbox isolation: parent forces on; request/profile "sandbox" or flag tightens
  let sandbox =
    parentSandbox ||
    Boolean(opts.sandbox) ||
    isSandboxProfileId(opts.permissionProfile);

  if (parentSandbox) sandbox = true;

  const mode = opts.mode || "build";
  const readOnly = mode === "plan" || mode === "review";
  let tools = opts.tools ?? null;
  if (readOnly) {
    tools = ["read", "grep", "find", "ls"];
  }

  const clamped =
    approval !== requestedApproval ||
    sandbox !== Boolean(opts.sandbox) ||
    parentSandbox;

  return {
    // Always an ask-* profile — never the string "sandbox"
    permissionProfile: approval,
    sandbox,
    mode,
    tools,
    readOnly,
    role: opts.role || "child",
    model: opts.model ?? null,
    thinkingLevel: normalizeThinkingLevel(opts.thinkingLevel),
    parentCwd: opts.parentCwd || process.cwd(),
    readRoot: opts.readRoot ? realpathSync(resolve(opts.readRoot)) : null,
    credentialBroker: opts.credentialBroker || "none",
    sandboxBash: Boolean(opts.sandboxBash),
    parentPermissionProfile: parentApproval,
    parentSandbox,
    clamped,
    mechanical: true,
    enforcer: "extensions/child-enforcer.ts",
  };
}

/**
 * Immutable policy snapshot for a child (also loaded by child-enforcer).
 */
export function buildChildPolicyManifest(input = {}) {
  const resolved =
    input.mechanical === true && input.permissionProfile
      ? input
      : resolveChildExecutionPolicy(input);

  const permissionProfile = toApprovalProfile(
    resolved.permissionProfile || "ask-dangerous",
  );
  const mode = resolved.mode || "build";
  const sandbox = Boolean(resolved.sandbox);
  const readOnly =
    resolved.readOnly != null
      ? Boolean(resolved.readOnly)
      : mode === "plan" || mode === "review";
  let effectiveTools = resolved.tools;
  if (readOnly) {
    effectiveTools = ["read", "grep", "find", "ls"];
  }

  // Credential boundary is honest about host same-user limits:
  // - docker-fs: host HOME/auth not mounted into the container
  // - env-home-isolation: child HOME/PI_CODING_AGENT_DIR point only at an
  //   ephemeral dir (no host auth copy); same-uid host processes can still
  //   open absolute host paths if known — real unreadability requires sandbox
  const credentialBoundary = sandbox ? "docker-fs" : "env-home-isolation";

  return {
    version: 5,
    role: resolved.role || input.role || "child",
    parentCwd: resolved.parentCwd || input.parentCwd || process.cwd(),
    model: resolved.model ?? input.model ?? null,
    thinkingLevel: resolved.thinkingLevel ?? input.thinkingLevel ?? null,
    permissionProfile,
    mode,
    readOnly,
    sandbox,
    sandboxBash: Boolean(resolved.sandboxBash),
    tools: effectiveTools,
    readRoot: resolved.readRoot || null,
    mechanical: true,
    parentPermissionProfile:
      resolved.parentPermissionProfile || permissionProfile,
    parentSandbox: Boolean(resolved.parentSandbox),
    enforcer: "extensions/child-enforcer.ts",
    credentialBoundary,
    credentialBroker: resolved.credentialBroker || "none",
    createdAt: new Date().toISOString(),
    rules: [
      "Approval ceiling is mechanical via child-enforcer extension (not prompt-only).",
      "Sandbox flag is orthogonal to approval; ask-all+sandbox stays ask-all.",
      "Sandbox children execute inside Docker; host bash is denied.",
      resolved.sandboxBash
        ? "Brokered host children execute bash inside the network-isolated Docker sandbox."
        : "Bash uses the selected child isolation boundary.",
      sandbox
        ? "Credential boundary docker-fs: host HOME/auth.json are not mounted; only isolated /child-home."
        : "Credential boundary env-home-isolation: HOME/PI_CODING_AGENT_DIR are ephemeral (no host auth copy); same-uid absolute host paths remain OS-readable without Docker.",
      "Provider credentials are never placed in child argv or environment variables.",
      resolved.credentialBroker && resolved.credentialBroker !== "none"
        ? "Runtime credentials are consumed from stdin before tools run; file tools remain repository-confined."
        : "No brokered provider credential is mounted.",
      "Read-only mode forces read tools only.",
      resolved.readRoot
        ? `Read tools are mechanically confined to ${resolved.readRoot}.`
        : "Read tools are not path-confined beyond their native behavior.",
    ],
  };
}

function policySystemAppendix(manifest) {
  return [
    "",
    "# Alloy child policy manifest (enforced by child-enforcer extension)",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
    "You are an Alloy child agent. The child-enforcer extension blocks violations.",
    `- approval ceiling: ${manifest.permissionProfile}`,
    `- mode: ${manifest.mode}${manifest.readOnly ? " (READ-ONLY)" : ""}`,
    `- sandbox: ${manifest.sandbox ? "Docker required" : "off"}`,
    `- tools: ${(manifest.tools || ["(default)"]).join(", ")}`,
    "",
  ].join("\n");
}

/**
 * Build the concrete spawn plan (host vs docker). Pure — no process start.
 * Used by runChildAgent and adversarial tests.
 *
 * @param {{
 *   policy: object,
 *   inv: { command: string, argsPrefix: string[], piNodeModulesRoot?: string|null },
 *   piArgs: string[],
 *   cwd: string,
 *   childEnv: Record<string,string>,
 *   isolatedHome: { home: string, piDir: string },
 *   policyPath: string,
 *   enforcerPath?: string,
 *   dockerImage?: string,
 * }} p
 */
export function buildChildSpawnPlan(p) {
  const enforcer = p.enforcerPath || CHILD_ENFORCER;
  const cwd = resolve(p.cwd);
  const policyDir = dirname(p.policyPath);
  const policyBase = basename(p.policyPath);

  // Pi args always include enforcer + no other extensions
  const piArgs = [
    ...p.inv.argsPrefix,
    "--no-extensions",
    "--extension",
    enforcer,
    ...p.piArgs.filter((a) => a !== "--no-extensions"),
  ];

  if (p.policy.sandbox) {
    if (!p.inv.piNodeModulesRoot) {
      throw new Error(
        "Sandbox child requires a resolvable Pi JavaScript package runtime.",
      );
    }
    const image = p.dockerImage || getSandboxConfig(cwd).image || "node:22-bookworm";
    const containerName =
      p.containerName ||
      `alloy-child-${basename(p.isolatedHome.home).replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const gid = typeof process.getgid === "function" ? process.getgid() : null;
    const userArgs = uid != null && gid != null ? ["--user", `${uid}:${gid}`] : [];
    const containerPolicy = `/alloy-policy/${policyBase}`;
    const containerEnforcer = "/alloy/extensions/child-enforcer.ts";
    const cleanInner = [];
    cleanInner.push("--mode", "json", "--no-session", "--no-extensions", "--extension", containerEnforcer);
    // append from original piArgs everything after mode/json setup
    let i = 0;
    const src = p.piArgs;
    while (i < src.length) {
      if (src[i] === "--extension" && src[i + 1]) {
        i += 2;
        continue;
      }
      if (src[i] === "--no-extensions") {
        i += 1;
        continue;
      }
      if (src[i] === "--mode" && src[i + 1] === "json") {
        i += 2;
        continue;
      }
      if (src[i] === "--no-session") {
        i += 1;
        continue;
      }
      // rewrite host paths in remaining args
      let a = src[i];
      if (typeof a === "string") {
        if (a.startsWith(ALLOY_ROOT)) a = a.replace(ALLOY_ROOT, "/alloy");
        else if (a.startsWith(policyDir)) a = a.replace(policyDir, "/alloy-policy");
        else if (a.startsWith(p.isolatedHome.home))
          a = a.replace(p.isolatedHome.home, "/child-home");
        else if (a === p.policyPath) a = containerPolicy;
        else if (a === enforcer || a.endsWith("child-enforcer.ts"))
          a = containerEnforcer;
      }
      cleanInner.push(a);
      i += 1;
    }

    const finalDockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--network",
      "none",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      ...userArgs,
      "-v",
      `${cwd}:/workspace:rw`,
      "-v",
      `${ALLOY_ROOT}:/alloy:ro`,
      "-v",
      `${p.inv.piNodeModulesRoot}:/alloy-runtime/node_modules:ro`,
      "-v",
      `${p.isolatedHome.home}:/child-home:rw`,
      "-v",
      `${policyDir}:/alloy-policy:ro`,
      "-w",
      "/workspace",
      "-e",
      "HOME=/child-home",
      "-e",
      "PI_CODING_AGENT_DIR=/child-home/.pi/agent",
      "-e",
      "ALLOY_CHILD=1",
      "-e",
      "ALLOY_CHILD_IN_DOCKER=1",
      "-e",
      `ALLOY_CHILD_POLICY=${containerPolicy}`,
      "-e",
      "ALLOY_CHILD_SANDBOX=1",
      "-e",
      `ALLOY_CHILD_PERMISSION=${p.policy.permissionProfile}`,
      "-e",
      "ALLOY_ROOT=/alloy",
      ...(p.childEnv.ALLOY_CHILD_CREDENTIAL_STDIN === "1"
        ? ["-e", "ALLOY_CHILD_CREDENTIAL_STDIN=1"]
        : []),
      image,
      "node",
      "/alloy-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ...cleanInner,
    ];

    return {
      backend: "docker",
      command: "docker",
      args: finalDockerArgs,
      cwd, // docker client cwd
      env: {
        PATH: process.env.PATH || "/usr/bin",
        HOME: process.env.HOME || p.isolatedHome.home,
        ...Object.fromEntries(
          [
            "DOCKER_HOST",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "SSH_AUTH_SOCK",
          ]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
      },
      childInDocker: true,
      containerName,
      isolatedHome: p.isolatedHome.home,
      policyPath: p.policyPath,
    };
  }

  // Host backend (non-sandbox): still isolated HOME; enforcer loaded
  return {
    backend: "host",
    command: p.inv.command,
    args: piArgs,
    cwd,
    env: p.childEnv,
    childInDocker: false,
    isolatedHome: p.isolatedHome.home,
    policyPath: p.policyPath,
  };
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // ignore
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  const forceKillTimer = setTimeout(() => {
    try {
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 2500);
  forceKillTimer.unref?.();
}

function waitForProcessClose(proc, timeoutMs = 3500) {
  if (proc.exitCode != null || proc.signalCode != null) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      proc.removeListener?.("close", onClose);
      resolvePromise(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    proc.once?.("close", onClose);
  });
}

function appendBounded(current, chunk, limit) {
  const next = current + chunk;
  if (next.length <= limit) return next;
  return (
    next.slice(0, limit) +
    `\n…[truncated ${next.length - limit} bytes by Alloy child runner]\n`
  );
}

/**
 * Run a single child Pi agent under Alloy policy.
 * @returns {Promise<object>}
 */
export function runChildAgent({
  prompt,
  cwd = process.cwd(),
  model,
  thinkingLevel,
  tools,
  systemPrompt,
  timeoutMs = 300_000,
  signal,
  onEvent,
  permissionProfile = "ask-dangerous",
  mode = "build",
  sandbox = false,
  role = "child",
  envExtra = {},
  parentPermissionProfile,
  parentSandbox,
  readRoot = null,
  sandboxDiagnostics,
  /** @type {'none'|'ephemeral-json'|'runtime-key'} */
  credentialBroker = "none",
  brokerAuthJson = null,
  brokerRuntimeCredential = null,
  maxCostUsd = null,
  /** Override the captured stream limit for tests. */
  streamLimitBytes = CHILD_STREAM_LIMIT,
  /** If true, return spawn plan without starting a process (tests). */
  dryRun = false,
  /** Inject spawn for tests */
  spawnImpl = spawn,
  /** Inject synchronous Docker cleanup for tests. */
  dockerStopImpl = spawnSync,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    return Promise.resolve({
      ok: false,
      exitCode: 1,
      text: "",
      messages: [],
      stderr: "empty prompt",
      usage: emptyUsage(),
      error: "empty prompt",
      events: [],
    });
  }

  const brokeredBashRequiresSandbox =
    credentialBroker === "runtime-key" &&
    mode !== "plan" &&
    mode !== "review" &&
    (!Array.isArray(tools) || tools.includes("bash"));
  const policy = resolveChildExecutionPolicy({
    parentPermissionProfile: parentPermissionProfile ?? permissionProfile,
    parentSandbox: parentSandbox ?? sandbox,
    permissionProfile,
    sandbox,
    sandboxBash: brokeredBashRequiresSandbox,
    mode,
    tools,
    role,
    model: model || null,
    thinkingLevel,
    parentCwd: cwd,
    readRoot,
    credentialBroker,
  });

  if (policy.sandbox || policy.sandboxBash) {
    const diag =
      sandboxDiagnostics !== undefined
        ? sandboxDiagnostics
        : diagnoseDocker(cwd);
    if (!diag || !diag.daemon) {
      const detail = (diag && diag.detail) || "Docker sandbox unavailable";
      return Promise.resolve({
        ok: false,
        exitCode: 1,
        text: "",
        messages: [],
        stderr: `Sandbox child denied: ${detail}`,
        usage: emptyUsage(),
        error: "sandbox_unavailable",
        events: [],
        policy: buildChildPolicyManifest(policy),
      });
    }
  }

  const manifest = buildChildPolicyManifest(
    policy.sandbox && policy.readRoot
      ? { ...policy, readRoot: "/workspace" }
      : policy,
  );
  const inv = findPiInvocation();

  let tmpDir = null;
  let isolatedHome = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "alloy-child-"));
    isolatedHome = createIsolatedChildHome();
    const runtimeCredentialEnvelope =
      credentialBroker === "runtime-key"
        ? buildChildRuntimeCredentialEnvelope(brokerRuntimeCredential)
        : null;
    if (!runtimeCredentialEnvelope) {
      provisionChildAuthBroker(isolatedHome.piDir, {
        mode: credentialBroker,
        authJson: brokerAuthJson,
      });
    }

    const sp = join(tmpDir, "system.md");
    const combined =
      (systemPrompt ? String(systemPrompt).trim() + "\n" : "") +
      policySystemAppendix(manifest);
    writeFileSync(sp, combined, "utf8");

    const mp = join(tmpDir, "policy.json");
    writeFileSync(mp, JSON.stringify(manifest, null, 2), "utf8");

    const piArgs = [
      "--mode",
      "json",
      "--json-events",
      "compact",
      "--no-session",
      "--append-system-prompt",
      sp,
    ];
    if (manifest.thinkingLevel) {
      piArgs.push("--thinking", manifest.thinkingLevel);
    }
    piArgs.push("-p");
    if (model) {
      piArgs.push("--model", model);
    }
    if (Array.isArray(manifest.tools) && manifest.tools.length === 0) {
      piArgs.push("--no-tools");
    } else if (manifest.tools && manifest.tools.length) {
      piArgs.push("--tools", manifest.tools.join(","));
    }
    piArgs.push(String(prompt));

    const childEnv = buildChildEnv(
      {
        ...envExtra,
        ALLOY_CHILD_POLICY: mp,
        ALLOY_CHILD_SANDBOX: manifest.sandbox ? "1" : "0",
        ALLOY_CHILD_PERMISSION: manifest.permissionProfile,
        ALLOY_CHILD_IN_DOCKER: manifest.sandbox ? "0" : "0", // set true only inside docker plan
        ...(runtimeCredentialEnvelope
          ? { ALLOY_CHILD_CREDENTIAL_STDIN: "1" }
          : {}),
      },
      { allowProviderCredentials: false, isolatedHome },
    );
    const plan = buildChildSpawnPlan({
      policy: manifest,
      inv,
      piArgs,
      cwd,
      childEnv,
      isolatedHome,
      policyPath: mp,
      enforcerPath: CHILD_ENFORCER,
    });

    // Ensure host plan env has isolated paths
    if (plan.backend === "host") {
      plan.env = childEnv;
    }

    if (dryRun) {
      const result = {
        ok: false,
        exitCode: 0,
        text: "",
        messages: [],
        stderr: "dry_run",
        usage: emptyUsage(),
        error: "dry_run",
        events: [],
        policy: manifest,
        spawnPlan: plan,
        isolatedHome,
      };
      cleanupDirs(tmpDir, isolatedHome);
      return Promise.resolve(result);
    }

    return new Promise((resolvePromise) => {
      let proc;
      let bashContainerName = null;
      try {
        proc = spawnImpl(plan.command, plan.args, {
          cwd: plan.cwd,
          shell: false,
          stdio: [runtimeCredentialEnvelope ? "pipe" : "ignore", "pipe", "pipe"],
          env: plan.env,
          detached: process.platform !== "win32" && plan.backend === "host",
        });
        if (policy.sandboxBash && proc.pid) {
          bashContainerName = sandboxContainerName(cwd, proc.pid);
        }
      } catch (err) {
        cleanupDirs(tmpDir, isolatedHome);
        resolvePromise({
          ok: false,
          exitCode: 1,
          text: "",
          messages: [],
          stderr: String(err?.message || err),
          usage: emptyUsage(),
          error: "spawn_failed",
          events: [],
          spawnPlan: plan,
        });
        return;
      }

      let buffer = "";
      let stderr = "";
      let stdoutBytes = 0;
      let eventCount = 0;
      let assistantText = "";
      let assistantInProgress = false;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const messages = [];
      const events = [];
      let eventCursor = 0;
      const usage = emptyUsage(false);
      let modelUsed = model || null;
      let settled = false;
      let lastTool = "";
      let bashSandboxMayExist = false;

      const stopSandboxWorkload = async () => {
        const names = [
          ...(plan.backend === "docker" && plan.containerName
            ? [plan.containerName]
            : []),
          ...(bashContainerName && bashSandboxMayExist ? [bashContainerName] : []),
        ];
        for (const name of names) {
          let removed = false;
          const delays = [0, 100, 500];
          for (const [attempt, delayMs] of delays.entries()) {
            if (delayMs) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
            }
            const stopped = dockerStopImpl(
              "docker",
              ["rm", "-f", name],
              {
                encoding: "utf8",
                timeout: 30_000,
                env: plan.backend === "docker" ? plan.env : process.env,
              },
            );
            if (stopped?.status === 0) {
              removed = true;
              break;
            }
            if (
              attempt === delays.length - 1 &&
              /no such container/i.test(String(stopped?.stderr || ""))
            ) {
              removed = true;
            }
          }
          if (!removed) return false;
        }
        return true;
      };

      const finish = (exitCode, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupDirs(tmpDir, isolatedHome);
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const text = extractText(lastAssistant);
        const outputText =
          ((error || exitCode !== 0) && assistantInProgress && assistantText) ||
          text ||
          assistantText;
        const authFail =
          /No API key found|not authenticated|auth/i.test(stderr) ||
          /No API key found/i.test(outputText);
        resolvePromise({
          ok: exitCode === 0 && !error && !authFail && Boolean(outputText),
          exitCode: exitCode ?? 1,
          text:
            outputText ||
            (authFail
              ? "Child agent: authentication required (run /login)."
              : ""),
          messages,
          stderr,
          usage,
          model: modelUsed || undefined,
          error: error || (authFail ? "auth_required" : undefined),
          events:
            events.length === CHILD_EVENT_LIMIT && eventCursor > 0
              ? [...events.slice(eventCursor), ...events.slice(0, eventCursor)]
              : events,
          stdoutBytes,
          eventCount,
          lastTool,
          policy: manifest,
          spawnPlan: plan,
        });
      };

      let terminating = false;
      const terminate = async (reason) => {
        if (settled || terminating) return;
        terminating = true;
        const closePromise = waitForProcessClose(proc);
        killProcessTree(proc);
        const processClosed = await closePromise;
        const stopped = await stopSandboxWorkload();
        const cleanupFailed = !processClosed || !stopped;
        finish(
          1,
          cleanupFailed ? `${reason}_container_cleanup_failed` : reason,
        );
      };

      const timer = setTimeout(() => {
        void terminate("timeout");
      }, timeoutMs);

      const processLine = (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        eventCount++;
        if (event.type === "message_start" && event.message?.role === "assistant") {
          assistantText = extractText(event.message);
          assistantInProgress = true;
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta" &&
          typeof event.assistantMessageEvent.delta === "string"
        ) {
          assistantText += event.assistantMessageEvent.delta;
          assistantInProgress = true;
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          assistantText = extractText(event.message) || assistantText;
          assistantInProgress = false;
        }
        const observedEvent = {
          ...event,
          ...((event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end") && assistantText
            ? { outputText: assistantText }
            : {}),
          stdoutBytes,
          eventCount,
        };
        if (events.length < CHILD_EVENT_LIMIT) {
          events.push(event);
        } else {
          events[eventCursor] = event;
          eventCursor = (eventCursor + 1) % CHILD_EVENT_LIMIT;
        }
        if (event.type === "tool_execution_start" && event.toolName) {
          lastTool = event.toolName;
          if (policy.sandboxBash && event.toolName === "bash") {
            bashSandboxMayExist = true;
          }
        }
        if (event.type === "message_end" && event.message) {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            accumulateAssistantUsage(usage, event.message);
            if (event.message.model) modelUsed = event.message.model;
            if (Number.isFinite(maxCostUsd)) {
              if (!usage.costKnown) {
                void terminate("budget_usage_unavailable");
              } else if (usage.cost > maxCostUsd) {
                void terminate("budget_exceeded");
              }
            }
          }
        }
        onEvent?.(observedEvent);
      };

      proc.stdout?.on("data", (data) => {
        if (settled || terminating) return;
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stdoutBytes += raw.length;
        buffer += stdoutDecoder.write(raw);
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) processLine(line);
        if (
          stdoutBytes > streamLimitBytes * 2 ||
          Buffer.byteLength(buffer) > streamLimitBytes
        ) {
          void terminate("stdout_limit");
        }
      });
      proc.stderr?.on("data", (data) => {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stderr = appendBounded(stderr, stderrDecoder.write(raw), streamLimitBytes);
      });
      proc.stdin?.on("error", () => {
        if (!settled) void terminate("credential_handoff_failed");
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        if (terminating) return;
        if (plan.backend === "docker" || bashContainerName) {
          void stopSandboxWorkload().then((stopped) => {
            finish(
              1,
              stopped
                ? err.message || String(err)
                : "child_error_container_cleanup_failed",
            );
          });
          return;
        }
        finish(1, err.message || String(err));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (terminating) return;
        buffer += stdoutDecoder.end();
        stderr = appendBounded(stderr, stderrDecoder.end(), streamLimitBytes);
        if (buffer.trim()) processLine(buffer);
        if (terminating) return;
        if ((plan.backend === "docker" && code !== 0) || bashContainerName) {
          void stopSandboxWorkload().then((stopped) => {
            finish(
              code ?? 1,
              stopped ? undefined : "child_exit_container_cleanup_failed",
            );
          });
          return;
        }
        finish(code ?? 0);
      });

      if (signal) {
        const onAbort = () => {
          void terminate("aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      if (runtimeCredentialEnvelope) {
        try {
          proc.stdin?.end(runtimeCredentialEnvelope);
        } catch {
          void terminate("credential_handoff_failed");
        }
      }
    });
  } catch (err) {
    cleanupDirs(tmpDir, isolatedHome);
    return Promise.resolve({
      ok: false,
      exitCode: 1,
      text: "",
      messages: [],
      stderr: String(err?.message || err),
      usage: emptyUsage(),
      error: "child_setup_failed",
      events: [],
    });
  }
}

function cleanupDirs(tmpDir, isolatedHome) {
  for (const d of [tmpDir, isolatedHome?.home]) {
    if (!d) continue;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function emptyUsage(costKnown = true) {
  return { input: 0, output: 0, cost: 0, turns: 0, costKnown };
}

export function accumulateAssistantUsage(usage, message) {
  const firstReportedTurn = usage.turns === 0;
  usage.turns++;
  if (firstReportedTurn) usage.costKnown = true;
  const current = message?.usage;
  if (current) {
    usage.input += Number(current.input) || 0;
    usage.output += Number(current.output) || 0;
  }
  const cost = current?.cost?.total;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    usage.cost += cost;
  } else {
    usage.costKnown = false;
  }
  return usage;
}

// silence unused import when tree-shaken
void readFileSync;
