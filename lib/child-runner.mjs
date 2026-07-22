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
 * - Provider API keys never in child env
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  toApprovalProfile,
  stricterApproval,
  isSandboxProfileId,
  parentPolicyAxes,
} from "./project-trust.mjs";
import { diagnoseDocker, getSandboxConfig } from "./docker-sandbox.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = join(__dirname, "..");
const CHILD_ENFORCER = join(ALLOY_ROOT, "extensions", "child-enforcer.ts");

/** Max captured stdout / stderr bytes per stream */
export const CHILD_STREAM_LIMIT = 8 * 1024 * 1024; // 8 MiB
/** Max JSONL events retained in memory */
export const CHILD_EVENT_LIMIT = 5000;

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
      return { command: process.execPath, argsPrefix: [bin] };
    }
    return { command: bin, argsPrefix: [] };
  }

  const candidates = [
    join(
      ALLOY_ROOT,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  ];

  try {
    const requireFromRoot = createRequire(join(ALLOY_ROOT, "package.json"));
    const main = requireFromRoot.resolve("@earendil-works/pi-coding-agent");
    candidates.push(join(dirname(main), "cli.js"));
  } catch {
    // fall through
  }

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
    if (exists(c)) {
      let path = c;
      try {
        path = realpathSync(c);
      } catch {
        // ignore
      }
      return { command: process.execPath, argsPrefix: [path] };
    }
  }

  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["pi"],
    { encoding: "utf8" },
  );
  if (which.status === 0) {
    const line = which.stdout.trim().split("\n")[0]?.trim();
    if (line && exists(line)) return { command: line, argsPrefix: [] };
  }

  throw new Error(
    "Pi CLI not found. Run npm install in the alloy repo, or set ALLOY_PI_BIN.",
  );
}

function extractText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text || "")
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
    parentCwd: opts.parentCwd || process.cwd(),
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
    version: 3,
    role: resolved.role || input.role || "child",
    parentCwd: resolved.parentCwd || input.parentCwd || process.cwd(),
    model: resolved.model ?? input.model ?? null,
    permissionProfile,
    mode,
    readOnly,
    sandbox,
    tools: effectiveTools,
    mechanical: true,
    parentPermissionProfile:
      resolved.parentPermissionProfile || permissionProfile,
    parentSandbox: Boolean(resolved.parentSandbox),
    enforcer: "extensions/child-enforcer.ts",
    credentialBoundary,
    credentialBroker: "none-by-default",
    createdAt: new Date().toISOString(),
    rules: [
      "Approval ceiling is mechanical via child-enforcer extension (not prompt-only).",
      "Sandbox flag is orthogonal to approval; ask-all+sandbox stays ask-all.",
      "Sandbox children execute inside Docker; host bash is denied.",
      sandbox
        ? "Credential boundary docker-fs: host HOME/auth.json are not mounted; only isolated /child-home."
        : "Credential boundary env-home-isolation: HOME/PI_CODING_AGENT_DIR are ephemeral (no host auth copy); same-uid absolute host paths remain OS-readable without Docker.",
      "Provider API keys are never in child env; optional ephemeral-json broker only writes into the isolated dir.",
      "Read-only mode forces read tools only.",
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
 *   inv: { command: string, argsPrefix: string[] },
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
    const image = p.dockerImage || getSandboxConfig(cwd).image || "node:22-bookworm";
    // Map host paths → container paths
    const containerPolicy = `/alloy-policy/${policyBase}`;
    const containerEnforcer = "/alloy/extensions/child-enforcer.ts";
    const containerPi = p.inv.argsPrefix[0]
      ? p.inv.argsPrefix[0].replace(ALLOY_ROOT, "/alloy")
      : "/alloy/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

    const mappedPiArgs = piArgs.map((a) => {
      if (a === enforcer || a.endsWith("child-enforcer.ts")) return containerEnforcer;
      if (a === p.policyPath) return containerPolicy;
      if (typeof a === "string" && a.startsWith(ALLOY_ROOT)) {
        return a.replace(ALLOY_ROOT, "/alloy");
      }
      if (typeof a === "string" && a.startsWith(policyDir)) {
        return a.replace(policyDir, "/alloy-policy");
      }
      if (typeof a === "string" && a.startsWith(p.isolatedHome.home)) {
        return a.replace(p.isolatedHome.home, "/child-home");
      }
      return a;
    });

    // Ensure --append-system-prompt and policy env use container paths
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
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
      "-v",
      `${cwd}:/workspace:rw`,
      "-v",
      `${ALLOY_ROOT}:/alloy:ro`,
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
      `ALLOY_CHILD_SANDBOX=1`,
      "-e",
      `ALLOY_CHILD_PERMISSION=${p.policy.permissionProfile}`,
      "-e",
      "ALLOY_ROOT=/alloy",
      image,
      // node binary inside image
      "node",
      containerPi.endsWith(".js") || containerPi.endsWith(".mjs")
        ? containerPi
        : "/alloy/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ...mappedPiArgs.filter((a) => {
        // drop host node path if argsPrefix was embedded
        return a !== p.inv.command;
      }),
    ];

    // If inv uses node + script, argsPrefix already has script; avoid double node path
    // Rebuild cleaner docker command:
    const script =
      p.inv.argsPrefix[0] &&
      (p.inv.argsPrefix[0].endsWith(".js") || p.inv.argsPrefix[0].endsWith(".mjs"))
        ? p.inv.argsPrefix[0].replace(ALLOY_ROOT, "/alloy")
        : "/alloy/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

    const innerArgs = [
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "--extension",
      containerEnforcer,
      // remainder of piArgs after stripping argsPrefix and flags we re-add
      ...p.piArgs.filter(
        (a) =>
          a !== "--mode" &&
          a !== "json" &&
          a !== "--no-session" &&
          a !== "--no-extensions",
      ),
    ];
    // p.piArgs should already be the full list after argsPrefix; simplify:
    const cleanInner = [];
    cleanInner.push("--mode", "json", "--no-session", "--no-extensions", "--extension", containerEnforcer);
    // append from original piArgs everything after mode/json setup
    const skip = new Set(["--no-extensions"]);
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
      "-v",
      `${cwd}:/workspace:rw`,
      "-v",
      `${ALLOY_ROOT}:/alloy:ro`,
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
      image,
      "node",
      script,
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
      },
      childInDocker: true,
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
  setTimeout(() => {
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
  sandboxDiagnostics,
  /** @type {'none'|'ephemeral-json'} */
  credentialBroker = "none",
  brokerAuthJson = null,
  /** If true, return spawn plan without starting a process (tests). */
  dryRun = false,
  /** Inject spawn for tests */
  spawnImpl = spawn,
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

  const policy = resolveChildExecutionPolicy({
    parentPermissionProfile: parentPermissionProfile ?? permissionProfile,
    parentSandbox: parentSandbox ?? sandbox,
    permissionProfile,
    sandbox,
    mode,
    tools,
    role,
    model: model || null,
    parentCwd: cwd,
  });

  if (policy.sandbox) {
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

  const manifest = buildChildPolicyManifest(policy);
  const inv = findPiInvocation();

  let tmpDir = null;
  let isolatedHome = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "alloy-child-"));
    isolatedHome = createIsolatedChildHome();
    provisionChildAuthBroker(isolatedHome.piDir, {
      mode: credentialBroker,
      authJson: brokerAuthJson,
    });

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
      "--no-session",
      "--append-system-prompt",
      sp,
      "-p",
    ];
    if (model) {
      piArgs.push("--model", model);
    }
    if (manifest.tools && manifest.tools.length) {
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
      return Promise.resolve({
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
      });
    }

    return new Promise((resolvePromise) => {
      let proc;
      try {
        proc = spawnImpl(plan.command, plan.args, {
          cwd: plan.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: plan.env,
          detached: process.platform !== "win32" && plan.backend === "host",
        });
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
      const messages = [];
      const events = [];
      const usage = emptyUsage();
      let modelUsed = model || null;
      let settled = false;
      let lastTool = "";

      const finish = (exitCode, error) => {
        if (settled) return;
        settled = true;
        cleanupDirs(tmpDir, isolatedHome);
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const text = extractText(lastAssistant);
        const authFail =
          /No API key found|not authenticated|auth/i.test(stderr) ||
          /No API key found/i.test(text);
        resolvePromise({
          ok: exitCode === 0 && !error && !authFail && Boolean(text),
          exitCode: exitCode ?? 1,
          text:
            text ||
            (authFail
              ? "Child agent: authentication required (run /login)."
              : ""),
          messages,
          stderr,
          usage,
          model: modelUsed || undefined,
          error: error || (authFail ? "auth_required" : undefined),
          events,
          lastTool,
          policy: manifest,
          spawnPlan: plan,
        });
      };

      const timer = setTimeout(() => {
        killProcessTree(proc);
        finish(1, "timeout");
      }, timeoutMs);

      const processLine = (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (events.length < CHILD_EVENT_LIMIT) events.push(event);
        onEvent?.(event);
        if (event.type === "tool_execution_start" && event.toolName) {
          lastTool = event.toolName;
        }
        if (event.type === "message_end" && event.message) {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            usage.turns++;
            const u = event.message.usage;
            if (u) {
              usage.input += u.input || 0;
              usage.output += u.output || 0;
              usage.cost += u.cost?.total || 0;
            }
            if (event.message.model) modelUsed = event.message.model;
          }
        }
      };

      proc.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdoutBytes += chunk.length;
        if (stdoutBytes > CHILD_STREAM_LIMIT * 2) {
          killProcessTree(proc);
          finish(1, "stdout_limit");
          return;
        }
        buffer = appendBounded(buffer, chunk, CHILD_STREAM_LIMIT);
        const parts = buffer.split("\n");
        if (buffer.includes("[truncated")) {
          buffer = parts.pop() || "";
          return;
        }
        buffer = parts.pop() || "";
        for (const line of parts) processLine(line);
      });
      proc.stderr?.on("data", (data) => {
        stderr = appendBounded(stderr, data.toString(), CHILD_STREAM_LIMIT);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        finish(1, err.message || String(err));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (buffer.trim() && !buffer.includes("[truncated")) processLine(buffer);
        finish(code ?? 0);
      });

      if (signal) {
        const onAbort = () => {
          killProcessTree(proc);
          finish(1, "aborted");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
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

function emptyUsage() {
  return { input: 0, output: 0, cost: 0, turns: 0 };
}

// silence unused import when tree-shaken
void readFileSync;
