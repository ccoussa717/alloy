/**
 * Spawn isolated Pi child processes in JSON mode for Alloy roles.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOY_ROOT = join(__dirname, "..");

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
    join(ALLOY_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
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
        join(r.stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
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

  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
    encoding: "utf8",
  });
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
 * Run a single child Pi agent.
 * @returns {Promise<{ ok: boolean, exitCode: number, text: string, messages: any[], stderr: string, usage: object, model?: string, error?: string, events?: any[] }>}
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

  const inv = findPiInvocation();
  const args = [...inv.argsPrefix, "--mode", "json", "--no-session", "-p"];

  let tmpDir = null;
  if (systemPrompt && String(systemPrompt).trim()) {
    tmpDir = mkdtempSync(join(tmpdir(), "alloy-child-"));
    const sp = join(tmpDir, "system.md");
    writeFileSync(sp, systemPrompt, "utf8");
    args.push("--append-system-prompt", sp);
  }
  if (model) args.push("--model", model);
  if (tools && tools.length) args.push("--tools", tools.join(","));
  args.push(String(prompt));

  return new Promise((resolve) => {
    const proc = spawn(inv.command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let buffer = "";
    let stderr = "";
    const messages = [];
    const events = [];
    const usage = emptyUsage();
    let modelUsed = model || null;
    let settled = false;
    let lastTool = "";

    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const text = extractText(lastAssistant);
      const authFail =
        /No API key found|not authenticated|auth/i.test(stderr) ||
        /No API key found/i.test(text);
      resolve({
        ok: exitCode === 0 && !error && !authFail && Boolean(text),
        exitCode: exitCode ?? 1,
        text: text || (authFail ? "Child agent: authentication required (run /login)." : ""),
        messages,
        stderr,
        usage,
        model: modelUsed || undefined,
        error: error || (authFail ? "auth_required" : undefined),
        events,
        lastTool,
      });
    };

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 3000);
      } catch {
        // ignore
      }
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
      events.push(event);
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
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      finish(1, err.message || String(err));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) processLine(buffer);
      finish(code ?? 0);
    });

    if (signal) {
      const onAbort = () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function emptyUsage() {
  return { input: 0, output: 0, cost: 0, turns: 0 };
}

void homedir;
