/**
 * Project diagnostics: detect stack and run lint/typecheck/test commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DIAGNOSTIC_ENV_ALLOWLIST = [
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
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "npm_config_cache",
];

export function buildDiagnosticEnv(source = process.env) {
  const env = {};
  for (const key of DIAGNOSTIC_ENV_ALLOWLIST) {
    if (source[key] != null && source[key] !== "") env[key] = String(source[key]);
  }
  return env;
}

function run(cmd, args, cwd, timeoutMs = 120000) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: buildDiagnosticEnv(),
    shell: false,
  });
  return {
    command: [cmd, ...args].join(" "),
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").slice(0, 50_000),
    stderr: (r.stderr || "").slice(0, 50_000),
    signal: r.signal || null,
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

export function detectProject(cwd = process.cwd()) {
  const has = (f) => existsSync(join(cwd, f));
  const stacks = [];
  let packageJson = null;

  if (has("package.json")) {
    stacks.push("node");
    try {
      packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    } catch {
      packageJson = {};
    }
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    stacks.push("python");
  }
  if (has("Cargo.toml")) stacks.push("rust");
  if (has("go.mod")) stacks.push("go");
  if (has("tsconfig.json")) stacks.push("typescript");

  const scripts = packageJson?.scripts || {};
  return { stacks, scripts, packageName: packageJson?.name || null };
}

/**
 * Build a list of diagnostic commands for the project.
 */
export function planDiagnostics(cwd = process.cwd(), { includeTests = true } = {}) {
  const { stacks, scripts } = detectProject(cwd);
  const steps = [];

  if (stacks.includes("node") || stacks.includes("typescript")) {
    if (scripts.typecheck) steps.push({ name: "typecheck", cmd: "npm", args: ["run", "typecheck"] });
    else if (existsSync(join(cwd, "tsconfig.json"))) {
      steps.push({ name: "tsc", cmd: "npx", args: ["--no-install", "tsc", "-p", ".", "--noEmit"] });
    }
    if (scripts.lint) steps.push({ name: "lint", cmd: "npm", args: ["run", "lint"] });
    if (includeTests) {
      if (scripts.test) steps.push({ name: "test", cmd: "npm", args: ["test"] });
    }
  }

  if (stacks.includes("python")) {
    if (existsSync(join(cwd, "pyproject.toml"))) {
      steps.push({ name: "pytest", cmd: "python", args: ["-m", "pytest", "-q"] });
    }
  }

  if (stacks.includes("rust")) {
    steps.push({ name: "cargo-check", cmd: "cargo", args: ["check"] });
    if (includeTests) steps.push({ name: "cargo-test", cmd: "cargo", args: ["test"] });
  }

  if (stacks.includes("go")) {
    steps.push({ name: "go-test", cmd: "go", args: ["test", "./..."] });
  }

  // Alloy self: always prefer npm test when present
  if (!steps.length && scripts.test) {
    steps.push({ name: "test", cmd: "npm", args: ["test"] });
  }

  return { stacks, steps };
}

export function formatDiagnosticApproval(cwd = process.cwd(), opts = {}) {
  const { steps } = planDiagnostics(cwd, opts);
  const { scripts } = detectProject(cwd);
  const commands = steps.length
    ? steps
        .map((step) => {
          const command = [step.cmd, ...step.args].join(" ");
          const scriptName =
            step.cmd === "npm" && step.args[0] === "test"
              ? "test"
              : step.cmd === "npm" && step.args[0] === "run"
                ? step.args[1]
                : null;
          const script = scriptName ? scripts[scriptName] : null;
          return script ? `${command} -> ${String(script)}` : command;
        })
        .join("; ")
    : "(no commands detected)";
  return [
    `Runs repository-defined host commands: ${commands}`,
    "These commands are not Docker-sandboxed and retain same-user filesystem and network access.",
  ].join("\n");
}

/**
 * Run planned diagnostics. Continues after failures; reports all.
 */
export function runDiagnostics(cwd = process.cwd(), opts = {}) {
  const plan = planDiagnostics(cwd, opts);
  const results = [];
  for (const step of plan.steps) {
    const r = run(step.cmd, step.args, cwd, opts.timeoutMs || 120000);
    results.push({ name: step.name, ...r });
    if (opts.stopOnFail && !r.ok) break;
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  const skipped = results.length === 0;
  return {
    ok: skipped ? true : ok, // no diagnostics ≠ failure
    skipped,
    stacks: plan.stacks,
    results,
    summary: skipped
      ? "No diagnostic commands detected for this project."
      : results
          .map((r) => `${r.ok ? "✓" : "✗"} ${r.name} (${r.command})`)
          .join("\n"),
  };
}
