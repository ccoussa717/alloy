/**
 * Spawn isolated Pi child processes for Alloy roles (P0.3 / child-policy).
 *
 * - Scrubbed env (no full process.env; no provider API keys by default)
 * - Mechanical permission ceiling + sandbox inheritance from parent
 * - Immutable policy manifest (permission ceiling, mode, tools)
 * - Process-group kill on timeout/abort
 * - Bounded stdout/stderr
 * - Sandbox children fail closed when Docker is unavailable (no host spawn)
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizePermissionId } from "./permissions.mjs";
import { stricterPermission } from "./project-trust.mjs";
import { diagnoseDocker } from "./docker-sandbox.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = join(__dirname, "..");

/** Max captured stdout / stderr bytes per stream */
export const CHILD_STREAM_LIMIT = 8 * 1024 * 1024; // 8 MiB
/** Max JSONL events retained in memory */
export const CHILD_EVENT_LIMIT = 5000;

/**
 * Provider credential env keys — never forwarded to arbitrary unsandboxed
 * children. Auth is via PI_CODING_AGENT_DIR file store (/login), not process env.
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

/** Env keys forwarded to children (credentials intentionally excluded). */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
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
  "PI_CODING_AGENT_DIR",
  "ALLOY_HOME",
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
 * Build scrubbed child environment.
 * Never copies full process.env. Never forwards provider API keys by default
 * (narrow broker boundary: Pi file auth under PI_CODING_AGENT_DIR only).
 * @param {Record<string, string>} [extra]
 * @param {{ allowProviderCredentials?: boolean }} [opts]
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
  if (!out.HOME && process.env.HOME) out.HOME = process.env.HOME;
  out.ALLOY_ROOT = ALLOY_ROOT;
  out.ALLOY_CHILD = "1";
  out.ALLOY_VERSION = process.env.ALLOY_VERSION || out.ALLOY_VERSION || "0.8.2";

  for (const [k, v] of Object.entries(extra || {})) {
    if (v == null) continue;
    if (k === "ALLOY_CHILD_FORBIDDEN") continue;
    // Extras cannot smuggle provider credentials unless explicit broker opt-in
    if (PROVIDER_CREDENTIAL_SET.has(k) && !opts.allowProviderCredentials) {
      continue;
    }
    out[k] = String(v);
  }

  // Strip any credential that slipped through allowlist/host env
  if (!opts.allowProviderCredentials) {
    for (const k of PROVIDER_CREDENTIAL_ENV_KEYS) {
      delete out[k];
    }
  }
  return out;
}

/**
 * Mechanically clamp a child request to the parent permission/sandbox ceiling.
 * Prompt text alone is not trusted — callers must use this before spawn.
 *
 * @param {{
 *   parentPermissionProfile?: string,
 *   parentSandbox?: boolean,
 *   permissionProfile?: string,
 *   sandbox?: boolean,
 *   mode?: string,
 *   tools?: string[]|null,
 *   role?: string,
 *   model?: string|null,
 *   parentCwd?: string,
 * }} opts
 */
export function resolveChildExecutionPolicy(opts = {}) {
  const parentRaw =
    opts.parentPermissionProfile ?? opts.permissionProfile ?? "ask-dangerous";
  const parentProfile =
    normalizePermissionId(parentRaw) || parentRaw || "ask-dangerous";
  const parentSbx =
    Boolean(opts.parentSandbox) || parentProfile === "sandbox";

  const reqRaw = opts.permissionProfile ?? parentProfile;
  const requested = normalizePermissionId(reqRaw) || reqRaw || parentProfile;

  // Never more autonomous than parent; sandbox parent forces sandbox child.
  let effective = parentSbx
    ? "sandbox"
    : stricterPermission(requested, parentProfile);

  // Requested sandbox is allowed (tightens isolation) unless parent forbids —
  // parent non-sandbox still may run a sandbox child; parent sandbox always wins.
  let sandbox =
    parentSbx ||
    Boolean(opts.sandbox) ||
    requested === "sandbox" ||
    effective === "sandbox";

  if (sandbox) {
    effective = "sandbox";
  }

  const mode = opts.mode || "build";
  const readOnly = mode === "plan" || mode === "review";
  let tools = opts.tools ?? null;
  if (readOnly) {
    tools = ["read", "grep", "find", "ls"];
  }

  const clamped =
    effective !== requested ||
    sandbox !== Boolean(opts.sandbox) ||
    parentSbx;

  return {
    permissionProfile: effective,
    sandbox,
    mode,
    tools,
    readOnly,
    role: opts.role || "child",
    model: opts.model ?? null,
    parentCwd: opts.parentCwd || process.cwd(),
    parentPermissionProfile: parentProfile,
    parentSandbox: parentSbx,
    clamped,
    mechanical: true,
  };
}

/**
 * Immutable policy snapshot for a child.
 * Children may tighten tools further via `tools` arg; they cannot raise autonomy.
 */
export function buildChildPolicyManifest(input = {}) {
  // Accept either raw fields or already-resolved policy
  const resolved =
    input.mechanical === true && input.permissionProfile
      ? input
      : resolveChildExecutionPolicy(input);

  const permissionProfile = resolved.permissionProfile || "ask-dangerous";
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

  return {
    version: 2,
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
    createdAt: new Date().toISOString(),
    rules: [
      "Child inherits parent permission ceiling mechanically; may not loosen.",
      "Sandbox parent forces sandbox child; Docker required or spawn is denied.",
      "Env is scrubbed allowlist; provider API keys are not forwarded.",
      "Read-only parent mode forces read tools only.",
      "This manifest is also enforced by the Alloy child runner, not prompt text alone.",
    ],
  };
}

function policySystemAppendix(manifest) {
  return [
    "",
    "# Alloy child policy manifest (immutable, mechanically enforced)",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
    "You are an Alloy child agent. Obey the manifest:",
    `- permissionProfile ceiling: ${manifest.permissionProfile}`,
    `- mode: ${manifest.mode}${manifest.readOnly ? " (READ-ONLY — no writes, no bash)" : ""}`,
    `- sandbox: ${manifest.sandbox ? "REQUIRED" : "off"}`,
    `- tools: ${(manifest.tools || ["(default)"]).join(", ")}`,
    "Do not attempt to bypass these constraints.",
    "",
  ].join("\n");
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    // Negative PID = process group (when detached/setsid). Also try direct.
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // may not be group leader
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
  /** Parent session ceiling — required for mechanical inheritance */
  parentPermissionProfile,
  parentSandbox,
  /**
   * Optional diagnostics inject for tests. Production uses diagnoseDocker(cwd).
   * @type {{ ok?: boolean, daemon?: boolean, detail?: string } | undefined}
   */
  sandboxDiagnostics,
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

  // Mechanical sandbox gate: never spawn a host child that would claim sandbox
  // without Docker — prevents host bash under a sandbox label.
  if (policy.sandbox) {
    const diag =
      sandboxDiagnostics !== undefined
        ? sandboxDiagnostics
        : diagnoseDocker(cwd);
    if (!diag || !diag.daemon) {
      const detail =
        (diag && diag.detail) || "Docker sandbox unavailable";
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
  const args = [...inv.argsPrefix, "--mode", "json", "--no-session", "-p"];

  let tmpDir = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "alloy-child-"));
    const sp = join(tmpDir, "system.md");
    const combined =
      (systemPrompt ? String(systemPrompt).trim() + "\n" : "") +
      policySystemAppendix(manifest);
    writeFileSync(sp, combined, "utf8");
    args.push("--append-system-prompt", sp);

    const mp = join(tmpDir, "policy.json");
    writeFileSync(mp, JSON.stringify(manifest, null, 2), "utf8");
    envExtra = {
      ...envExtra,
      ALLOY_CHILD_POLICY: mp,
      ALLOY_CHILD_SANDBOX: manifest.sandbox ? "1" : "0",
      ALLOY_CHILD_PERMISSION: manifest.permissionProfile,
    };
  } catch (err) {
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

  if (model) args.push("--model", model);
  if (manifest.tools && manifest.tools.length) {
    args.push("--tools", manifest.tools.join(","));
  }
  args.push(String(prompt));

  // Credentials never in child env (file auth only).
  const childEnv = buildChildEnv(envExtra, { allowProviderCredentials: false });

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(inv.command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        // New process group so we can kill the whole tree
        detached: process.platform !== "win32",
      });
    } catch (err) {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      resolve({
        ok: false,
        exitCode: 1,
        text: "",
        messages: [],
        stderr: String(err?.message || err),
        usage: emptyUsage(),
        error: "spawn_failed",
        events: [],
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

    const cleanupTmp = () => {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        tmpDir = null;
      }
    };

    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      cleanupTmp();
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const text = extractText(lastAssistant);
      const authFail =
        /No API key found|not authenticated|auth/i.test(stderr) ||
        /No API key found/i.test(text);
      resolve({
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

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdoutBytes += chunk.length;
      if (stdoutBytes > CHILD_STREAM_LIMIT * 2) {
        // stop reading further into buffer growth
        killProcessTree(proc);
        finish(1, "stdout_limit");
        return;
      }
      buffer = appendBounded(buffer, chunk, CHILD_STREAM_LIMIT);
      // process complete lines from buffer without losing remainder
      const parts = buffer.split("\n");
      // If we truncated, skip parsing garbage tail
      if (buffer.includes("[truncated")) {
        buffer = parts.pop() || "";
        return;
      }
      buffer = parts.pop() || "";
      for (const line of parts) processLine(line);
    });
    proc.stderr.on("data", (data) => {
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
}

function emptyUsage() {
  return { input: 0, output: 0, cost: 0, turns: 0 };
}
