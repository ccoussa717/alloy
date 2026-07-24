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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

type ChildManifest = {
  permissionProfile?: string;
  mode?: string;
  readOnly?: boolean;
  sandbox?: boolean;
  tools?: string[] | null;
  readRoot?: string | null;
  mechanical?: boolean;
};

const PATH_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
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

function readEscapesRoot(
  manifest: ChildManifest,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!manifest.readRoot || !PATH_READ_TOOLS.has(toolName)) return null;
  const rawPath = input.path == null ? "." : input.path;
  if (typeof rawPath !== "string") return "Child enforcer: read path must be a string";
  try {
    const root = realpathSync(manifest.readRoot);
    const target = realpathSync(resolve(process.cwd(), normalizePiToolPath(rawPath)));
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

  const approval = toApprovalProfile(manifest.permissionProfile || "ask-dangerous");
  const sandbox = Boolean(manifest.sandbox);
  const inDocker = env.ALLOY_CHILD_IN_DOCKER === "1";

  const readRootViolation = readEscapesRoot(manifest, toolName, input);
  if (readRootViolation) {
    return { block: true, reason: readRootViolation, decision: "deny" };
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

export default function childEnforcerExtension(pi: ExtensionAPI) {
  const manifest = loadManifest();
  if (!manifest) {
    console.error(
      "Alloy child-enforcer: ALLOY_CHILD_POLICY missing or unreadable — all tools will be blocked",
    );
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
