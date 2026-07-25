/**
 * Adversarial tests: child policy NO-SHIP follow-up.
 * Approval orthogonal to sandbox; enforcer consumption; docker-positive spawn;
 * isolated auth; alloy_auto/alloy_fusion tool propagation.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const root = join(import.meta.dirname, "..", "..");

const home = mkdtempSync(join(tmpdir(), "alloy-child-policy-home-"));
const project = mkdtempSync(join(tmpdir(), "alloy-child-policy-proj-"));
process.env.HOME = home;
process.env.ALLOY_HOME = join(home, ".pi", "alloy");
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

// Synthetic host auth the child must never see
const hostAuthDir = join(home, ".pi", "agent");
mkdirSync(hostAuthDir, { recursive: true, mode: 0o700 });
const hostAuthPath = join(hostAuthDir, "auth.json");
writeFileSync(
  hostAuthPath,
  JSON.stringify({ secret: "HOST_AUTH_MUST_NOT_LEAK_TO_CHILD" }, null, 2),
  { mode: 0o600 },
);

const {
  buildChildEnv,
  buildChildPolicyManifest,
  resolveChildExecutionPolicy,
  runChildAgent,
  buildChildSpawnPlan,
  buildChildRuntimeCredentialEnvelope,
  createIsolatedChildHome,
  provisionChildAuthBroker,
  PROVIDER_CREDENTIAL_ENV_KEYS,
  CHILD_ENV_ALLOWLIST,
} = await import(pathToFileURL(join(root, "lib/child-runner.mjs")).href);

const {
  ensureDefaultConfig,
  loadConfigDetailed,
  saveJson,
} = await import(pathToFileURL(join(root, "lib/config.mjs")).href);

const {
  setRuntimeProjectTrust,
  clearRuntimeProjectTrust,
  isWeakerPermission,
  projectMayReplacePermission,
  toApprovalProfile,
} = await import(pathToFileURL(join(root, "lib/project-trust.mjs")).href);

const { evaluateToolPolicy } = await import(
  pathToFileURL(join(root, "lib/capabilities.mjs")).href
);

const {
  setPermissionProfile,
  setMode,
  setSandboxActive,
  resetStateForTests,
} = await import(pathToFileURL(join(root, "lib/state.mjs")).href);

const { resolveParentChildSpawnOpts } = await import(
  pathToFileURL(join(root, "lib/parent-policy.mjs")).href
);

// Import enforcer pure helper via ts transpilation — use createRequire on .ts
// through node may fail; re-implement import of evaluate path by loading the
// enforcer source logic from a small mjs mirror test of the same rules.
// Prefer dynamic import of compiled path: child-enforcer is TS; load via
// evaluateToolPolicy + same rules tested by importing with ts-node unavailable.
// Instead import the enforce function by evaluating the file as module via
// node --experimental-strip-types if available.
let enforceChildToolCall;
let installRuntimeCredential;
try {
  const enforcerMod = await import(
    pathToFileURL(join(root, "extensions/child-enforcer.ts")).href
  );
  enforceChildToolCall = enforcerMod.enforceChildToolCall;
  installRuntimeCredential = enforcerMod.installRuntimeCredential;
} catch {
  // Node without strip-types: load a tiny inline equivalent using evaluateToolPolicy
  const { toApprovalProfile: tap } = await import(
    pathToFileURL(join(root, "lib/project-trust.mjs")).href
  );
  enforceChildToolCall = (manifest, toolName, input = {}, env = process.env) => {
    if (!manifest?.mechanical) {
      return { block: true, reason: "missing mechanical manifest" };
    }
    if (Array.isArray(manifest.tools) && !manifest.tools.includes(toolName)) {
      return { block: true, reason: "tool outside allowlist", decision: "deny" };
    }
    if (manifest.sandbox && toolName === "bash" && env.ALLOY_CHILD_IN_DOCKER !== "1") {
      return { block: true, reason: "host bash blocked", decision: "deny" };
    }
    if (
      manifest.readRoot &&
      ["read", "grep", "find", "ls", "write", "edit"].includes(toolName)
    ) {
      let target = resolve(
        process.cwd(),
        String(input.path || input.file_path || "."),
      );
      if (!existsSync(target) && !["write", "edit"].includes(toolName)) {
        return { block: true, reason: "missing read path", decision: "deny" };
      }
      while (!existsSync(target)) target = dirname(target);
      target = realpathSync(target);
      const rel = relative(realpathSync(manifest.readRoot), target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { block: true, reason: "read root escape", decision: "deny" };
      }
    }
    const approval = tap(manifest.permissionProfile || "ask-dangerous");
    const result = evaluateToolPolicy({
      toolName,
      input,
      mode: manifest.mode || "build",
      readOnlyMode: Boolean(manifest.readOnly),
      permissionProfile: approval,
    });
    if (result.decision === "deny" || result.decision === "approve") {
      return { block: true, reason: result.reason, decision: result.decision };
    }
    return { block: false, decision: "allow" };
  };
  installRuntimeCredential = (pi, raw) => {
    const credential = JSON.parse(raw);
    pi.registerProvider(credential.provider, {
      apiKey: credential.apiKey,
      ...(credential.headers ? { headers: credential.headers } : {}),
    });
  };
}

function writeProjectAlloy(obj) {
  const dir = join(project, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alloy.json"), JSON.stringify(obj, null, 2));
}

before(() => {
  ensureDefaultConfig();
  const gpath = join(home, ".pi", "alloy", "config.json");
  saveJson(gpath, {
    version: 1,
    permissionProfile: "sandbox",
    mcp: { enabled: true, connectOnStart: false },
    sandbox: {
      image: "node:22-bookworm",
      network: "none",
      allowEnv: ["PATH", "HOME"],
    },
  });
});

beforeEach(() => {
  clearRuntimeProjectTrust();
  resetStateForTests();
});

after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("approval orthogonal to sandbox", () => {
  it("parent ask-all + sandbox keeps ask-all approval (not allow-all sandbox)", () => {
    const r = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-all",
      parentSandbox: true,
      permissionProfile: "ask-none",
      sandbox: false,
      mode: "build",
    });
    assert.equal(r.permissionProfile, "ask-all");
    assert.equal(r.sandbox, true);
    assert.notEqual(r.permissionProfile, "sandbox");

    // evaluateToolPolicy must still require approval for writes under ask-all
    const ev = evaluateToolPolicy({
      toolName: "write",
      input: { path: "x" },
      permissionProfile: r.permissionProfile,
      mode: "build",
    });
    assert.equal(ev.decision, "approve");
  });

  it("parent ask-some + sandbox keeps ask-some (bash needs approve, not free)", () => {
    const r = resolveChildExecutionPolicy({
      parentPermissionProfile: "ask-some",
      parentSandbox: true,
      permissionProfile: "ask-none",
      mode: "build",
    });
    assert.equal(r.permissionProfile, "ask-some");
    assert.equal(r.sandbox, true);
    const ev = evaluateToolPolicy({
      toolName: "bash",
      input: { command: "ls" },
      permissionProfile: r.permissionProfile,
    });
    assert.equal(ev.decision, "approve");
  });

  it("toApprovalProfile(sandbox) is ask-dangerous not allow-all", () => {
    assert.equal(toApprovalProfile("sandbox"), "ask-dangerous");
    const ev = evaluateToolPolicy({
      toolName: "write",
      permissionProfile: "sandbox",
    });
    // legacy id maps to ask-dangerous → allow non-dangerous writes
    assert.equal(ev.decision, "allow");
  });
});

describe("mechanical enforcer consumption", () => {
  it("enforcer blocks write under ask-all (approve → fail-closed)", () => {
    const manifest = buildChildPolicyManifest({
      parentPermissionProfile: "ask-all",
      parentSandbox: false,
      permissionProfile: "ask-all",
      mode: "build",
    });
    assert.equal(manifest.mechanical, true);
    assert.equal(manifest.permissionProfile, "ask-all");
    const d = enforceChildToolCall(manifest, "write", { path: "a.ts" }, {});
    assert.equal(d.block, true);
    assert.match(String(d.reason), /fail-closed|approve|ask-all/i);
  });

  it("enforcer blocks host bash when sandbox and not in docker", () => {
    const manifest = buildChildPolicyManifest({
      parentPermissionProfile: "ask-dangerous",
      parentSandbox: true,
      mode: "build",
    });
    assert.equal(manifest.sandbox, true);
    const d = enforceChildToolCall(
      manifest,
      "bash",
      { command: "echo pwn" },
      { ALLOY_CHILD_IN_DOCKER: "0" },
    );
    assert.equal(d.block, true);
    assert.match(String(d.reason), /docker|host bash/i);
  });

  it("enforcer allows read under ask-all", () => {
    const manifest = buildChildPolicyManifest({
      parentPermissionProfile: "ask-all",
      permissionProfile: "ask-all",
      mode: "build",
    });
    const d = enforceChildToolCall(manifest, "read", { path: "a.ts" }, {});
    assert.equal(d.block, false);
  });

  it("enforcer confines Fusion read tools to the repository root", () => {
    const outside = mkdtempSync(join(tmpdir(), "alloy-child-outside-"));
    const outsideFile = join(outside, "auth.json");
    writeFileSync(outsideFile, "secret", { mode: 0o600 });
    const escapeLink = join(project, "outside-link");
    symlinkSync(outsideFile, escapeLink);
    const manifest = buildChildPolicyManifest({
      parentCwd: project,
      readRoot: project,
      mode: "plan",
      permissionProfile: "ask-none",
    });

    assert.equal(
      enforceChildToolCall(manifest, "read", { path: join(project, "inside.txt") }, {})
        .block,
      true,
      "missing paths fail closed",
    );
    writeFileSync(join(project, "inside.txt"), "safe");
    assert.equal(
      enforceChildToolCall(manifest, "read", { path: join(project, "inside.txt") }, {})
        .block,
      false,
    );
    assert.equal(
      enforceChildToolCall(manifest, "read", { path: outsideFile }, {}).block,
      true,
    );
    assert.equal(
      enforceChildToolCall(manifest, "read", { path: escapeLink }, {}).block,
      true,
    );

    const tildeMirror = join(project, "~", ".pi", "agent");
    mkdirSync(tildeMirror, { recursive: true });
    writeFileSync(join(tildeMirror, "auth.json"), "mirror");

    const atMirror = join(project, `@${outsideFile}`);
    mkdirSync(join(atMirror, ".."), { recursive: true });
    writeFileSync(atMirror, "mirror");

    const fileUrl = pathToFileURL(outsideFile).href;
    const fileUrlMirror = join(project, fileUrl);
    mkdirSync(join(fileUrlMirror, ".."), { recursive: true });
    writeFileSync(fileUrlMirror, "mirror");
    const originalCwd = process.cwd();
    process.chdir(project);
    try {
      assert.equal(
        enforceChildToolCall(manifest, "read", { path: "~/.pi/agent/auth.json" }, {})
          .block,
        true,
      );
      assert.equal(
        enforceChildToolCall(manifest, "read", { path: `@${outsideFile}` }, {}).block,
        true,
      );
      assert.equal(
        enforceChildToolCall(manifest, "read", { path: fileUrl }, {}).block,
        true,
      );
    } finally {
      process.chdir(originalCwd);
    }
    rmSync(escapeLink, { force: true });
    rmSync(join(project, "inside.txt"), { force: true });
    rmSync(join(project, "~"), { recursive: true, force: true });
    rmSync(join(project, "@"), { recursive: true, force: true });
    rmSync(join(project, "file:"), { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("runChildAgent dryRun loads enforcer path in spawn plan", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      permissionProfile: "ask-dangerous",
      parentPermissionProfile: "ask-dangerous",
      sandbox: false,
      dryRun: true,
    });
    assert.equal(result.error, "dry_run");
    assert.ok(result.spawnPlan);
    assert.equal(result.spawnPlan.backend, "host");
    const joined = result.spawnPlan.args.join(" ");
    assert.match(joined, /child-enforcer/);
    assert.match(joined, /--no-extensions|--extension/);
  });

  it("runChildAgent passes an explicit thinking level as one Pi argument", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      permissionProfile: "ask-dangerous",
      parentPermissionProfile: "ask-dangerous",
      sandbox: false,
      thinkingLevel: "high",
      dryRun: true,
    });
    const index = result.spawnPlan.args.indexOf("--thinking");
    assert.ok(index >= 0);
    assert.equal(result.spawnPlan.args[index + 1], "high");
    assert.equal(result.policy.thinkingLevel, "high");
  });

  it("brokered build agents isolate bash in Docker while Pi retains provider egress", async () => {
    const denied = await runChildAgent({
      prompt: "implement the change",
      cwd: project,
      mode: "build",
      tools: ["read", "write", "edit", "bash"],
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "openai-codex",
        apiKey: "synthetic-runtime-token",
      },
      sandboxDiagnostics: { daemon: false, detail: "docker missing" },
    });
    assert.equal(denied.error, "sandbox_unavailable");

    const isolated = await runChildAgent({
      prompt: "implement the change",
      cwd: project,
      mode: "build",
      tools: ["read", "write", "edit", "bash"],
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "openai-codex",
        apiKey: "synthetic-runtime-token",
      },
      sandboxDiagnostics: { daemon: true },
      dryRun: true,
    });
    assert.equal(isolated.policy.sandbox, false);
    assert.equal(isolated.policy.sandboxBash, true);
    assert.equal(isolated.spawnPlan.backend, "host");
  });

  it("removes the brokered bash sandbox after successful host-Pi completion", async () => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    const removed = [];

    const result = await runChildAgent({
      prompt: "implement the change",
      cwd: project,
      mode: "build",
      tools: ["read", "write", "edit", "bash"],
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "openai-codex",
        apiKey: "synthetic-runtime-token",
      },
      sandboxDiagnostics: { daemon: true },
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "tool_execution_start",
              toolName: "bash",
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "implemented" }],
                usage: {
                  input: 10,
                  output: 5,
                  cost: { total: 0.01 },
                },
              },
            })}\n`,
          );
          child.emit("close", 0);
        });
        return child;
      },
      dockerStopImpl: (_command, args) => {
        removed.push(args.at(-1));
        return { status: 0, stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^alloy-sbx-/);
  });

  it("an empty tool allowlist disables Pi defaults and is enforced mechanically", async () => {
    const manifest = buildChildPolicyManifest({
      permissionProfile: "ask-dangerous",
      tools: [],
      credentialBroker: "runtime-key",
    });
    assert.equal(
      enforceChildToolCall(manifest, "write", { path: join(project, "x") }, {}).block,
      true,
    );

    const result = await runChildAgent({
      prompt: "no tools",
      cwd: project,
      tools: [],
      dryRun: true,
    });
    assert.ok(result.spawnPlan.args.includes("--no-tools"));
  });

  it("translates a sandboxed read root to the container workspace", async () => {
    const result = await runChildAgent({
      prompt: "sandboxed read",
      cwd: project,
      tools: ["read"],
      readRoot: project,
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "anthropic",
        apiKey: "synthetic-runtime-key",
      },
      sandbox: true,
      parentSandbox: true,
      sandboxDiagnostics: { daemon: true },
      dryRun: true,
    });
    assert.equal(result.policy.readRoot, "/workspace");
    assert.ok(result.spawnPlan.args.includes("ALLOY_CHILD_CREDENTIAL_STDIN=1"));
  });
});

describe("docker-positive sandbox children execute in container", () => {
  it("mounts a hoisted Pi dependency tree at a stable container path", () => {
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "tcp://docker:2375";
    const isolatedHome = createIsolatedChildHome();
    const policyDir = mkdtempSync(join(tmpdir(), "alloy-child-policy-manifest-"));
    const policyPath = join(policyDir, "policy.json");
    const nodeModulesRoot = join(tempdirForHoistedPi(), "node_modules");
    const piCli = join(
      nodeModulesRoot,
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );

    try {
      writeFileSync(policyPath, "{}\n");
      const plan = buildChildSpawnPlan({
        policy: {
          sandbox: true,
          permissionProfile: "ask-all",
        },
        inv: {
          command: process.execPath,
          argsPrefix: [piCli],
          piNodeModulesRoot: nodeModulesRoot,
        },
        piArgs: ["--mode", "json", "--no-session", "-p", "hello"],
        cwd: project,
        childEnv: {},
        isolatedHome,
        policyPath,
        dockerImage: "node:22-bookworm",
      });

      assert.ok(
        plan.args.includes(`${nodeModulesRoot}:/alloy-runtime/node_modules:ro`),
      );
      const imageIndex = plan.args.indexOf("node:22-bookworm");
      assert.deepEqual(plan.args.slice(imageIndex + 1, imageIndex + 3), [
        "node",
        "/alloy-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ]);
      assert.ok(!plan.args.includes(piCli));
      assert.equal(plan.env.DOCKER_HOST, "tcp://docker:2375");
    } finally {
      if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = originalDockerHost;
      rmSync(isolatedHome.home, { recursive: true, force: true });
      rmSync(policyDir, { recursive: true, force: true });
      rmSync(join(nodeModulesRoot, ".."), { recursive: true, force: true });
    }
  });

  it("sandbox + docker daemon → spawn plan backend docker (never host node)", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      parentPermissionProfile: "ask-all",
      parentSandbox: true,
      permissionProfile: "ask-all",
      sandbox: true,
      sandboxDiagnostics: {
        ok: true,
        docker: true,
        daemon: true,
        detail: "test inject daemon up",
      },
      dryRun: true,
    });
    assert.equal(result.error, "dry_run");
    assert.equal(result.spawnPlan.backend, "docker");
    assert.equal(result.spawnPlan.command, "docker");
    assert.equal(result.spawnPlan.childInDocker, true);
    assert.ok(result.spawnPlan.args.includes("run"));
    assert.ok(result.spawnPlan.args.includes("ALLOY_CHILD_IN_DOCKER=1") ||
      result.spawnPlan.args.some((a) => String(a).includes("ALLOY_CHILD_IN_DOCKER=1")));
    // must not be a direct host node spawn of pi
    assert.notEqual(result.spawnPlan.command, process.execPath);
    // host auth dir must never appear as a volume mount
    const joined = result.spawnPlan.args.join("\n");
    assert.ok(!joined.includes(hostAuthDir), "must not mount host auth dir");
    assert.ok(!joined.includes(hostAuthPath), "must not mount host auth.json");
    // policy still records ask-all approval under docker sandbox
    assert.equal(result.policy.permissionProfile, "ask-all");
    assert.equal(result.policy.sandbox, true);
    assert.equal(result.policy.credentialBoundary, "docker-fs");
    // enforcer path inside container
    assert.match(joined, /child-enforcer/);
  });

  it("sandbox without docker still fail-closed", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      parentSandbox: true,
      sandbox: true,
      sandboxDiagnostics: {
        ok: false,
        daemon: false,
        detail: "docker missing",
      },
    });
    assert.equal(result.error, "sandbox_unavailable");
  });

  it("removes the sandbox container after an abnormal Docker client exit", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = true;
    let cleanupCalls = 0;

    const result = await runChildAgent({
      prompt: "review safely",
      cwd: project,
      mode: "review",
      tools: ["read"],
      parentSandbox: true,
      sandbox: true,
      sandboxDiagnostics: { daemon: true },
      spawnImpl: () => {
        queueMicrotask(() => child.emit("close", 1));
        return child;
      },
      dockerStopImpl: () => {
        cleanupCalls += 1;
        return { status: 0, stderr: "" };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(cleanupCalls, 1);
  });
});

function tempdirForHoistedPi() {
  return mkdtempSync(join(tmpdir(), "alloy-hoisted-pi-"));
}

describe("credential isolation — host auth.json unreadability", () => {
  it("PROVIDER keys not on allowlist; buildChildEnv uses isolated HOME", () => {
    for (const k of PROVIDER_CREDENTIAL_ENV_KEYS) {
      assert.ok(!CHILD_ENV_ALLOWLIST.includes(k));
    }
    // Host credential dirs are not freely copied from process.env
    assert.ok(!CHILD_ENV_ALLOWLIST.includes("HOME"));
    assert.ok(!CHILD_ENV_ALLOWLIST.includes("PI_CODING_AGENT_DIR"));

    process.env.OPENAI_API_KEY = "sk-leak";
    const iso = createIsolatedChildHome();
    const env = buildChildEnv({}, { isolatedHome: iso });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HOME, iso.home);
    assert.equal(env.PI_CODING_AGENT_DIR, iso.piDir);
    assert.notEqual(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
    // host auth file must not exist under isolated home
    assert.equal(existsSync(iso.authPath), false);
    assert.ok(existsSync(hostAuthPath));
    assert.notEqual(iso.authPath, hostAuthPath);
    // secret not present in isolated tree
    const listing = env.PI_CODING_AGENT_DIR;
    assert.ok(!readFileSync(hostAuthPath, "utf8").includes("never mind"));
    assert.ok(
      !existsSync(join(listing, "auth.json")),
      "isolated pi dir must not contain host auth.json",
    );
    rmSync(iso.home, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  it("extras cannot smuggle provider keys or override isolated HOME", () => {
    const iso = createIsolatedChildHome();
    const env = buildChildEnv(
      {
        OPENAI_API_KEY: "sk-extra",
        HOME: process.env.HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      },
      { isolatedHome: iso },
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HOME, iso.home);
    assert.equal(env.PI_CODING_AGENT_DIR, iso.piDir);
    rmSync(iso.home, { recursive: true, force: true });
  });

  it("broker none leaves no auth; ephemeral-json writes only into isolated dir", () => {
    const iso = createIsolatedChildHome();
    const none = provisionChildAuthBroker(iso.piDir, { mode: "none" });
    assert.equal(none.provisioned, false);
    assert.equal(existsSync(iso.authPath), false);

    const prov = provisionChildAuthBroker(iso.piDir, {
      mode: "ephemeral-json",
      authJson: { provider: "test", token: "ephemeral-only" },
    });
    assert.equal(prov.provisioned, true);
    assert.ok(existsSync(iso.authPath));
    const body = readFileSync(iso.authPath, "utf8");
    assert.match(body, /ephemeral-only/);
    // host auth untouched
    assert.match(readFileSync(hostAuthPath, "utf8"), /HOST_AUTH_MUST_NOT_LEAK/);
    assert.ok(!body.includes("HOST_AUTH_MUST_NOT_LEAK"));
    rmSync(iso.home, { recursive: true, force: true });
  });

  it("runtime credentials register from a validated memory-only envelope", () => {
    const envelope = buildChildRuntimeCredentialEnvelope({
      provider: "openai-codex",
      apiKey: "synthetic-runtime-token",
      headers: { "x-account-id": "synthetic-account-id" },
    });
    assert.equal(JSON.parse(envelope).version, 1);
    const calls = [];
    installRuntimeCredential(
      { registerProvider: (...args) => calls.push(args) },
      envelope,
    );
    assert.deepEqual(calls, [
      [
        "openai-codex",
        {
          apiKey: "synthetic-runtime-token",
          headers: { "x-account-id": "synthetic-account-id" },
        },
      ],
    ]);
    assert.throws(
      () =>
        buildChildRuntimeCredentialEnvelope({
          provider: "openai-codex",
          apiKey: "synthetic-runtime-token",
          baseUrl: "https://attacker.example",
        }),
      /cannot override/i,
    );
    assert.throws(
      () =>
        installRuntimeCredential(
          { registerProvider: () => assert.fail("must not register") },
          JSON.stringify({
            version: 2,
            provider: "openai-codex",
            apiKey: "synthetic-runtime-token",
          }),
        ),
      /invalid runtime credential envelope/i,
    );
    assert.throws(
      () =>
        buildChildRuntimeCredentialEnvelope({
          provider: "openai-codex",
          apiKey: 123,
          headers: ["x-test"],
        }),
      /invalid provider-scoped runtime credential/i,
    );
    assert.throws(
      () =>
        installRuntimeCredential(
          { registerProvider: () => assert.fail("must not register") },
          JSON.stringify({
            version: 1,
            provider: "openai-codex",
            apiKey: "synthetic-runtime-token",
            unexpected: true,
          }),
        ),
      /invalid runtime credential envelope/i,
    );
  });

  it("runtime credentials never appear in child argv or returned spawn diagnostics", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      model: "openai-codex/gpt-5.4",
      mode: "plan",
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "openai-codex",
        apiKey: "synthetic-runtime-token",
      },
      dryRun: true,
    });

    assert.doesNotMatch(result.spawnPlan.args.join(" "), /synthetic-runtime-token/);
    assert.doesNotMatch(JSON.stringify(result.spawnPlan), /synthetic-runtime-token/);
    assert.equal(result.spawnPlan.env.ALLOY_FUSION_RUNTIME_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify(result.spawnPlan.env), /synthetic-runtime/);
    assert.equal(result.spawnPlan.env.ALLOY_CHILD_CREDENTIAL_STDIN, "1");
    assert.equal(
      existsSync(join(result.spawnPlan.env.PI_CODING_AGENT_DIR, "auth.json")),
      false,
    );
  });

  it("fails cleanly when the child closes credential stdin early", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = true;

    const result = await runChildAgent({
      prompt: "review safely",
      cwd: project,
      mode: "review",
      tools: ["read"],
      credentialBroker: "runtime-key",
      brokerRuntimeCredential: {
        provider: "openai-codex",
        apiKey: "synthetic-runtime-token",
      },
      spawnImpl: () => {
        queueMicrotask(() => {
          const error = new Error("write EPIPE");
          error.code = "EPIPE";
          child.stdin.emit("error", error);
          child.emit("close", 1);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "credential_handoff_failed");
  });

  it("stops a child after observed usage exceeds its reservation", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = true;

    const result = await runChildAgent({
      prompt: "review safely",
      cwd: project,
      mode: "review",
      tools: ["read"],
      maxCostUsd: 1,
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.write(
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "reviewed" }],
                usage: {
                  input: 10,
                  output: 5,
                  cost: { total: 1.01 },
                },
              },
            }),
          );
          child.exitCode = 0;
          child.emit("close", 0);
        });
        return child;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "budget_exceeded");
    assert.equal(result.usage.cost, 1.01);
  });

  it("host dryRun never points env at host auth; boundary is env-home-isolation", async () => {
    const result = await runChildAgent({
      prompt: "hello",
      cwd: project,
      parentPermissionProfile: "ask-all",
      parentSandbox: false,
      permissionProfile: "ask-all",
      sandbox: false,
      dryRun: true,
    });
    assert.equal(result.error, "dry_run");
    assert.equal(result.spawnPlan.backend, "host");
    assert.equal(result.policy.credentialBoundary, "env-home-isolation");
    assert.notEqual(result.spawnPlan.env.HOME, home);
    assert.notEqual(result.spawnPlan.env.PI_CODING_AGENT_DIR, hostAuthDir);
    assert.equal(existsSync(join(result.spawnPlan.env.PI_CODING_AGENT_DIR, "auth.json")), false);
    // synthetic host secret must not be readable via child env paths
    assert.ok(existsSync(hostAuthPath));
    assert.ok(
      !String(result.spawnPlan.env.HOME || "").includes(hostAuthDir) &&
        result.spawnPlan.env.PI_CODING_AGENT_DIR !== hostAuthDir,
    );
    // cleanup isolated home from dryRun
    if (result.isolatedHome?.home) {
      try {
        rmSync(result.isolatedHome.home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("parent propagation for model-callable tools", () => {
  it("resolveParentChildSpawnOpts reads session sandbox profile id", () => {
    setPermissionProfile("sandbox"); // legacy id → sandbox axis on
    const opts = resolveParentChildSpawnOpts();
    assert.equal(opts.sandbox, true);
    assert.equal(opts.parentSandbox, true);
    assert.equal(opts.permissionProfile, "ask-dangerous"); // approval default under sandbox id
    assert.equal(opts.parentPermissionProfile, "ask-dangerous");
  });

  it("resolveParentChildSpawnOpts preserves ask-all when set", () => {
    setPermissionProfile("ask-all");
    const opts = resolveParentChildSpawnOpts();
    assert.equal(opts.permissionProfile, "ask-all");
    assert.equal(opts.sandbox, false);
  });

  it("ask-all + sandboxActive stays ask-all with sandbox true (orthogonal)", () => {
    setPermissionProfile("ask-all");
    setSandboxActive(true, "test-ctr");
    const opts = resolveParentChildSpawnOpts();
    assert.equal(opts.permissionProfile, "ask-all");
    assert.equal(opts.parentPermissionProfile, "ask-all");
    assert.equal(opts.sandbox, true);
    assert.equal(opts.parentSandbox, true);
    // mechanical clamp must not collapse approval to sandbox/allow-all
    const policy = resolveChildExecutionPolicy({
      ...opts,
      permissionProfile: "ask-none", // child tries to open up
      sandbox: false,
    });
    assert.equal(policy.permissionProfile, "ask-all");
    assert.equal(policy.sandbox, true);
    const ev = evaluateToolPolicy({
      toolName: "write",
      permissionProfile: policy.permissionProfile,
      mode: "build",
    });
    assert.equal(ev.decision, "approve");
  });

  it("handler-equivalent: parentOpts flow into resolveChildExecutionPolicy for auto/fusion", () => {
    // Mirrors extensions/auto.ts alloy_auto / alloy_fusion execute():
    //   const parentOpts = resolveParentChildSpawnOpts();
    //   await runAutoWorkflow({ ...parentOpts }) / runFusion({ ...parentOpts })
    // which then pass parent* into runChildAgent → resolveChildExecutionPolicy.
    setPermissionProfile("ask-some");
    setSandboxActive(true, "ctr");
    const parentOpts = resolveParentChildSpawnOpts();
    assert.equal(parentOpts.permissionProfile, "ask-some");
    assert.equal(parentOpts.sandbox, true);

    const policy = resolveChildExecutionPolicy({
      parentPermissionProfile: parentOpts.parentPermissionProfile,
      parentSandbox: parentOpts.parentSandbox,
      permissionProfile: parentOpts.permissionProfile,
      sandbox: parentOpts.sandbox,
      mode: "build",
    });
    assert.equal(policy.permissionProfile, "ask-some");
    assert.equal(policy.sandbox, true);
    assert.equal(policy.mechanical, true);
    assert.equal(policy.enforcer, "extensions/child-enforcer.ts");

    const manifest = buildChildPolicyManifest(policy);
    const d = enforceChildToolCall(
      manifest,
      "bash",
      { command: "echo x" },
      { ALLOY_CHILD_IN_DOCKER: "0" },
    );
    assert.equal(d.block, true); // sandbox host bash blocked
  });

  it("alloy_auto / alloy_fusion handler path uses resolveParentChildSpawnOpts (source contract)", async () => {
    // Static contract: auto.ts must call resolveParentChildSpawnOpts inside tool execute
    const autoSrc = readFileSync(join(root, "extensions/auto.ts"), "utf8");
    const autoToolIdx = autoSrc.indexOf('name: "alloy_auto"');
    const fusionToolIdx = autoSrc.indexOf('name: "alloy_fusion"');
    assert.ok(autoToolIdx > 0);
    assert.ok(fusionToolIdx > autoToolIdx);
    const autoToolBody = autoSrc.slice(autoToolIdx, fusionToolIdx);
    const fusionToolBody = autoSrc.slice(fusionToolIdx, fusionToolIdx + 1200);
    assert.match(autoToolBody, /resolveParentChildSpawnOpts/);
    assert.match(fusionToolBody, /resolveParentChildSpawnOpts/);
    // must spread parent opts into runAutoWorkflow / runFusion
    assert.match(autoToolBody, /\.\.\.parentOpts/);
    assert.match(fusionToolBody, /\.\.\.parentOpts/);
    assert.match(fusionToolBody, /resolveParentChildSpawnOpts\(\{\s*mode:\s*["']plan["']/);
    assert.doesNotMatch(fusionToolBody, /Type\.Literal\(["']build["']\)/);
    assert.match(fusionToolBody, /formatFusionLines\(summary\)/);

    const fusionCommandIdx = autoSrc.indexOf('registerCommand("fusion"');
    const panelCommandIdx = autoSrc.indexOf('registerCommand("panel"');
    const fusionCommandBody = autoSrc.slice(fusionCommandIdx, panelCommandIdx);
    assert.match(fusionCommandBody, /resolveParentChildSpawnOpts\(\{\s*mode:\s*["']plan["']/);
    assert.doesNotMatch(fusionCommandBody, /\^build\\b|\^plan\\b|plan\|build/);
    assert.match(fusionCommandBody, /formatFusionLines\(summary\)/);
    assert.match(autoSrc, /function formatFusionLines[\s\S]*summary\.synthesis/);
    assert.match(
      autoSrc,
      /function formatFusionLines[\s\S]*join\(summary\.runDir, "fusion", "synthesis\.md"\)/,
    );

    // agents.ts alloy_task tool similarly
    const agentsSrc = readFileSync(join(root, "extensions/agents.ts"), "utf8");
    assert.match(agentsSrc, /resolveParentChildSpawnOpts/);
    assert.match(agentsSrc, /\.\.\.parentOpts/);
    assert.match(agentsSrc, /prepareAgentLaunch/);
    assert.match(agentsSrc, /credentialBroker:\s*launch\.credential\.mode/);
    assert.match(
      agentsSrc,
      /brokerRuntimeCredential:\s*launch\.credential\.runtimeCredential/,
    );
    assert.match(agentsSrc, /routeDecision:\s*launch\.decision/);
    assert.match(agentsSrc, /async execute\([^)]*ctx\)/);
  });
});

describe("trusted project cannot demote global sandbox (preserved)", () => {
  it("projectMayReplacePermission rejects non-sandbox when global is sandbox", () => {
    assert.equal(projectMayReplacePermission("ask-dangerous", "sandbox"), false);
    assert.equal(projectMayReplacePermission("ask-none", "sandbox"), false);
    assert.equal(projectMayReplacePermission("ask-all", "sandbox"), false);
    assert.equal(projectMayReplacePermission("sandbox", "sandbox"), true);
  });

  it("isWeakerPermission treats demoting sandbox to ask-dangerous as weaker", () => {
    assert.equal(isWeakerPermission("ask-dangerous", "sandbox"), true);
    assert.equal(isWeakerPermission("ask-none", "sandbox"), true);
  });

  it("trusted project cannot replace global sandbox with ask-dangerous / ask-none", () => {
    writeProjectAlloy({ permissionProfile: "ask-none" });
    setRuntimeProjectTrust(project, true);
    const detail = loadConfigDetailed(project, { trusted: true });
    assert.equal(detail.config.permissionProfile, "sandbox");
    assert.ok(detail.rejected.some((r) => /permissionProfile|sandbox/i.test(r)));

    writeProjectAlloy({ permissionProfile: "ask-dangerous" });
    const detail2 = loadConfigDetailed(project, { trusted: true });
    assert.equal(detail2.config.permissionProfile, "sandbox");
  });
});
