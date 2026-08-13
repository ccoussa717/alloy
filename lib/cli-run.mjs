/**
 * Non-interactive CLI runners for CI (fission primary, forge optional).
 * Exit codes: 0 pass, 1 fail (blocking), 2 incomplete/error
 */

import { runFission } from "./fission.mjs";
import { runForge } from "./forge-workflow.mjs";
import {
  DEFAULT_FISSION_WORKFLOW_TIMEOUT_MS,
  loadConfig,
} from "./config.mjs";
import { resolveAgentIdentity, describeIdentity } from "./identity.mjs";
import { listRuns, formatRunIndexLines, getRunIndexPath } from "./run-index.mjs";

export function exitCodeFromFission(result) {
  if (!result) return 2;
  if (result.status === "COMPLETE" && result.verdict === "PASS") return 0;
  if (result.status === "COMPLETE" && result.verdict === "FAIL") return 1;
  if (result.status === "NO_CHANGES") return 0;
  return 2;
}

export function exitCodeFromForge(summary) {
  if (!summary) return 2;
  if (summary.pass === true && summary.status === "COMPLETE") return 0;
  if (summary.status === "FAILED" || summary.pass === false) return 1;
  return 2;
}

export async function cliFission(args = {}) {
  const cwd = args.cwd || process.cwd();
  const request = String(args.request || "").trim();
  if (!request) {
    return { exitCode: 2, error: "missing request", result: null };
  }
  const cfg = loadConfig(cwd);
  const result = await runFission({
    request,
    cwd,
    reviewers: args.reviewers,
    defaultReviewers: cfg.fission?.defaultReviewers,
    maxReviewers: cfg.fission?.maxReviewers,
    timeoutMs:
      args.timeoutMs ??
      cfg.fission?.workflowTimeoutMs ??
      DEFAULT_FISSION_WORKFLOW_TIMEOUT_MS,
    fissionMode: args.fissionMode || args.mode || "auto",
    // Non-interactive: never silently review the prompt instead of the tree.
    allowSubjectFallback: args.allowSubjectFallback === true,
  });
  if (result?.repoFallbackReason) {
    console.error(
      `fission: dirty-tree evidence incomplete (${result.repoFallbackReason}); subject fallback is off unless --subject-fallback`,
    );
  }
  return {
    exitCode: exitCodeFromFission(result),
    result,
    identity: resolveAgentIdentity(),
  };
}

export async function cliForge(args = {}) {
  const cwd = args.cwd || process.cwd();
  const request = String(args.request || "").trim();
  if (!request) {
    return { exitCode: 2, error: "missing request", summary: null };
  }
  const summary = await runForge({
    request,
    cwd,
    timeoutMs: args.timeoutMs || 600_000,
  });
  return {
    exitCode: exitCodeFromForge(summary),
    summary,
    identity: resolveAgentIdentity(),
  };
}

export function cliRuns(args = {}) {
  const rows = listRuns({
    limit: args.limit || 20,
    kind: args.kind,
    agentId: args.agentId,
  });
  return {
    identity: resolveAgentIdentity(),
    indexPath: getRunIndexPath(),
    lines: [describeIdentity(), "", ...formatRunIndexLines(rows)],
    rows,
  };
}
