/**
 * Docker sandbox executor for Alloy.
 *
 * Defaults (locked for v1):
 * - image: node:22-bookworm
 * - network: none
 * - bind-mount project cwd → /workspace
 * - non-root host uid/gid when possible
 * - session-scoped container, started on first use
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadGlobalConfig, GLOBAL_ONLY_SANDBOX_KEYS } from "./config.mjs";

const DEFAULT_SANDBOX = {
  engine: "docker",
  image: "node:22-bookworm",
  network: "none", // none | bridge — operator global only
  memory: "2g",
  cpus: "2",
  workdir: "/workspace",
  autoPull: true,
  allowEnv: ["PATH", "HOME", "NODE_ENV", "TERM", "LANG", "npm_config_cache"],
};

/** @type {Map<string, { name: string, cwd: string, image: string }>} */
const sessionContainers = new Map();

function runDocker(args, { timeoutMs = 120_000 } = {}) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

/**
 * Sandbox security settings come from operator global config only.
 * Project .pi/alloy.json cannot change image/network/allowEnv/autoPull/mounts.
 * cwd is accepted for API compatibility but does not load project sandbox keys.
 */
export function getSandboxConfig(_cwd = process.cwd()) {
  const globalCfg = loadGlobalConfig();
  const g = globalCfg.sandbox || {};
  // Only merge non-sensitive project prefs is intentionally omitted — global only.
  const network =
    g.network === "bridge" || g.network === "none" ? g.network : "none";
  return {
    ...DEFAULT_SANDBOX,
    ...g,
    network,
    image: g.image || DEFAULT_SANDBOX.image,
    allowEnv: Array.isArray(g.allowEnv) ? g.allowEnv : DEFAULT_SANDBOX.allowEnv,
    autoPull: g.autoPull !== false,
    // document which keys are locked
    _globalOnlyKeys: GLOBAL_ONLY_SANDBOX_KEYS,
  };
}

/**
 * Diagnose Docker + image readiness (no secrets).
 */
export function diagnoseDocker(cwd = process.cwd()) {
  const cfg = getSandboxConfig(cwd);
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["docker"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return {
      ok: false,
      docker: false,
      daemon: false,
      image: cfg.image,
      imagePresent: false,
      detail: "docker CLI not found on PATH",
      config: cfg,
    };
  }

  const ver = runDocker(["version", "--format", "{{.Server.Version}}"]);
  if (!ver.ok) {
    return {
      ok: false,
      docker: true,
      daemon: false,
      image: cfg.image,
      imagePresent: false,
      detail: ver.stderr || ver.error || "docker daemon not reachable",
      config: cfg,
    };
  }

  const img = runDocker(["image", "inspect", cfg.image, "--format", "{{.Id}}"]);
  return {
    ok: true,
    docker: true,
    daemon: true,
    serverVersion: ver.stdout,
    image: cfg.image,
    imagePresent: img.ok,
    detail: img.ok ? `image ready (${cfg.image})` : `image missing (will pull on first use): ${cfg.image}`,
    config: cfg,
  };
}

export function formatDockerDoctor(d) {
  const lines = [
    "Alloy docker sandbox",
    "--------------------",
    `docker CLI: ${d.docker ? "yes" : "NO"}`,
    `daemon:     ${d.daemon ? "yes" : "NO"}`,
    `image:      ${d.image}`,
    `present:    ${d.imagePresent ? "yes" : "no"}`,
    `network:    ${d.config?.network || "none"}`,
    `memory:     ${d.config?.memory || "2g"}`,
    `cpus:       ${d.config?.cpus || "2"}`,
    `detail:     ${d.detail}`,
  ];
  return lines.join("\n");
}

function containerNameFor(cwd) {
  const abs = resolve(cwd);
  const hash = createHash("sha256").update(`${abs}:${process.pid}`).digest("hex").slice(0, 12);
  return `alloy-sbx-${hash}`;
}

function ensureImage(image, { autoPull = true } = {}) {
  const inspect = runDocker(["image", "inspect", image, "--format", "{{.Id}}"]);
  if (inspect.ok) return { ok: true, pulled: false };
  if (!autoPull) {
    return { ok: false, error: `image not present: ${image}` };
  }
  const pull = runDocker(["pull", image], { timeoutMs: 600_000 });
  if (!pull.ok) {
    return { ok: false, error: pull.stderr || pull.error || "docker pull failed" };
  }
  return { ok: true, pulled: true };
}

function buildEnvArgs(allowEnv) {
  const args = [];
  for (const key of allowEnv || []) {
    if (process.env[key] != null && process.env[key] !== "") {
      args.push("-e", `${key}=${process.env[key]}`);
    }
  }
  // Always provide a minimal PATH inside container defaults; docker image has its own
  return args;
}

/**
 * Ensure a long-lived session container is running for cwd.
 */
export function ensureSandboxContainer(cwd = process.cwd()) {
  const abs = resolve(cwd);
  if (!existsSync(abs)) throw new Error(`sandbox cwd missing: ${abs}`);

  const cfg = getSandboxConfig(cwd);
  const diag = diagnoseDocker(cwd);
  if (!diag.ok || !diag.daemon) {
    throw new Error(`Docker sandbox unavailable: ${diag.detail}`);
  }

  const imageReady = ensureImage(cfg.image, { autoPull: cfg.autoPull !== false });
  if (!imageReady.ok) throw new Error(imageReady.error);

  const name = containerNameFor(abs);
  const existing = runDocker([
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Status}}",
  ]);

  if (existing.ok && existing.stdout) {
    if (/^Up\b/i.test(existing.stdout)) {
      sessionContainers.set(abs, { name, cwd: abs, image: cfg.image });
      return { name, reused: true, image: cfg.image, network: cfg.network };
    }
    // Remove exited container and recreate
    runDocker(["rm", "-f", name]);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;

  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    cfg.network === "bridge" ? "bridge" : "none",
    "--memory",
    String(cfg.memory || "2g"),
    "--cpus",
    String(cfg.cpus || "2"),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "-v",
    `${abs}:${cfg.workdir || "/workspace"}:rw`,
    "-w",
    cfg.workdir || "/workspace",
    ...buildEnvArgs(cfg.allowEnv),
  ];

  if (uid != null && gid != null) {
    args.push("--user", `${uid}:${gid}`);
  }

  // Keep container alive
  args.push(cfg.image, "sleep", "infinity");

  const started = runDocker(args, { timeoutMs: 120_000 });
  if (!started.ok) {
    throw new Error(started.stderr || started.error || "failed to start sandbox container");
  }

  sessionContainers.set(abs, { name, cwd: abs, image: cfg.image });
  return {
    name,
    reused: false,
    image: cfg.image,
    network: cfg.network,
    pulled: imageReady.pulled,
  };
}

export function stopSandboxContainer(cwd = process.cwd()) {
  const abs = resolve(cwd);
  const rec = sessionContainers.get(abs);
  const name = rec?.name || containerNameFor(abs);
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = runDocker(["rm", "-f", name]);
    if (result.ok || /no such container/i.test(result.stderr || "")) {
      sessionContainers.delete(abs);
      return { name, stopped: true };
    }
  }
  return {
    name,
    stopped: false,
    error: result.stderr || result.error || "failed to remove sandbox container",
  };
}

export function stopAllSandboxContainers() {
  for (const abs of [...sessionContainers.keys()]) {
    stopSandboxContainer(abs);
  }
}

/**
 * BashOperations-compatible exec for Pi createBashTool.
 * Runs command inside the session sandbox container.
 */
export function createDockerBashOperations(cwd = process.cwd()) {
  const abs = resolve(cwd);
  const cfg = getSandboxConfig(cwd);
  const workdir = cfg.workdir || "/workspace";

  return {
    async exec(command, _opsCwd, { onData, signal, timeout }) {
      // Ensure container
      const info = ensureSandboxContainer(abs);
      const timeoutSec =
        timeout !== undefined && timeout > 0 ? Number(timeout) : 0;

      const dockerArgs = [
        "exec",
        "-w",
        workdir,
        info.name,
        "bash",
        "-lc",
        command,
      ];

      return new Promise((resolvePromise, reject) => {
        const child = spawn("docker", dockerArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let cleanupError = null;
        let timeoutHandle;

        if (timeoutSec > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const stopped = stopSandboxContainer(abs);
            if (!stopped.stopped) cleanupError = stopped.error;
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, timeoutSec * 1000);
        }

        child.stdout?.on("data", (d) => onData?.(d));
        child.stderr?.on("data", (d) => onData?.(d));

        const onAbort = () => {
          const stopped = stopSandboxContainer(abs);
          if (!stopped.stopped) cleanupError = stopped.error;
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (cleanupError) reject(new Error(`sandbox cleanup failed: ${cleanupError}`));
          else if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeoutSec}`));
          else resolvePromise({ exitCode: code ?? 1 });
        });
      });
    },
  };
}

/**
 * One-shot helper for tests: run a command in sandbox and capture output.
 */
export function runInSandbox(command, cwd = process.cwd(), { timeoutMs = 60_000 } = {}) {
  const info = ensureSandboxContainer(cwd);
  const cfg = getSandboxConfig(cwd);
  const r = runDocker(
    ["exec", "-w", cfg.workdir || "/workspace", info.name, "bash", "-lc", command],
    { timeoutMs },
  );
  return { ...r, container: info.name };
}
