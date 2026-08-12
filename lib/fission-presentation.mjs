/**
 * Fission presentation helpers — terminal transcript + transport (fusion-style).
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { getRunsDir } from "./paths.mjs";

const META = 256;
const PATH = 512;
const BODY = 48_000;

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out, "utf8") > maxBytes - 1 && out.length > 0) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function presentationUsage(usage) {
  const cost = finiteNonNegative(usage?.cost);
  return {
    input: finiteNonNegative(usage?.input) ?? 0,
    output: finiteNonNegative(usage?.output) ?? 0,
    turns: finiteNonNegative(usage?.turns) ?? 0,
    cost,
    costKnown: usage?.costKnown !== false && cost !== null,
  };
}

function findingMarkdown(finding, index) {
  const severity = finding?.severity || "unknown";
  const claim = finding?.claim || "(no claim)";
  const path = finding?.affectedPath || "—";
  const lines = [
    `### ${index + 1}. ${severity} — ${claim}`,
    "",
    `\`${path}\``,
  ];
  if (finding?.evidence) lines.push("", finding.evidence);
  if (finding?.reproduction) lines.push("", `**Repro:** ${finding.reproduction}`);
  if (finding?.suggestedFix) lines.push("", `**Fix:** ${finding.suggestedFix}`);
  return lines.join("\n");
}

/** Body-only markdown for a pane. Header chrome (alias/model/status) lives in the UI. */
export function formatReviewerPresentationText(reviewer) {
  if (!reviewer) return "(no reviewer)";
  if (reviewer.error && !reviewer.output) {
    return `**Error:** ${reviewer.error}`;
  }
  const output = reviewer.output || {};
  const lines = [];
  const findings = Array.isArray(output.findings) ? output.findings : [];
  if (findings.length) {
    findings.forEach((finding, index) => {
      if (index > 0) lines.push("", "---", "");
      lines.push(findingMarkdown(finding, index));
    });
  } else {
    lines.push("_No findings submitted._");
  }
  if (Array.isArray(output.coverage) && output.coverage.length) {
    lines.push("", "---", "", "**Coverage**", ...output.coverage.map((item) => `- ${item}`));
  }
  const notes = [
    ...(Array.isArray(output.errors) ? output.errors : []),
    ...(Array.isArray(reviewer.warnings) ? reviewer.warnings : []),
  ];
  if (notes.length) {
    lines.push("", "**Notes**", ...notes.map((note) => `- ${note}`));
  }
  if (reviewer.error) lines.push("", `**Error:** ${reviewer.error}`);
  return truncateUtf8(lines.join("\n"), BODY);
}

export function formatJudgePresentationText(result) {
  const judge = result?.judge;
  if (!judge) return "(no judge)";
  if (judge.error && !judge.output) return `**Error:** ${judge.error}`;
  const output = judge.output || {};
  const lines = [];
  if (result?.message) lines.push(result.message, "");
  const clusters = Array.isArray(output.clusters) ? output.clusters : [];
  if (clusters.length) {
    for (const [index, cluster] of clusters.entries()) {
      if (index > 0) lines.push("", "---", "");
      lines.push(
        `### ${index + 1}. ${cluster.disposition || "unknown"}${
          cluster.adjudicatedSeverity ? ` · ${cluster.adjudicatedSeverity}` : ""
        }`,
        "",
        cluster.rationale || "(no rationale)",
      );
    }
  } else {
    lines.push("_No clusters adjudicated._");
  }
  if (output.judgeConcern) {
    lines.push(
      "",
      "---",
      "",
      "### Judge concern",
      "",
      output.judgeConcern.claim || "",
      output.judgeConcern.rationale || "",
    );
  }
  if (judge.error) lines.push("", `**Error:** ${judge.error}`);
  return truncateUtf8(lines.join("\n"), BODY);
}

function clusterLines(label, items) {
  if (!items?.length) return [];
  return [
    `**${label}** (${items.length})`,
    ...items.map((item, index) => {
      const severity = item.adjudicatedSeverity || item.severity || "?";
      const claim = item.claim || item.canonicalFindingId || "finding";
      return `${index + 1}. [${severity}] ${claim}`;
    }),
  ];
}

export function createFissionPresentationSummary(result) {
  const reviewers = Array.isArray(result?.reviewers) ? result.reviewers : [];
  return {
    kind: "fission",
    status: truncateUtf8(result?.status, META) || "UNKNOWN",
    verdict: truncateUtf8(result?.verdict, META) || null,
    message: truncateUtf8(result?.message, META) || "",
    request: String(result?.request || ""),
    runId: truncateUtf8(result?.runId, META) || "",
    runDir: truncateUtf8(result?.runDir, PATH) || "",
    mode: truncateUtf8(result?.mode, META) || "",
    error: result?.error ? truncateUtf8(result.error, META) : null,
    reviewers: reviewers.map((reviewer) => ({
      alias: truncateUtf8(reviewer?.alias, META) || "R?",
      role: truncateUtf8(reviewer?.role, META) || "reviewer",
      model: truncateUtf8(
        reviewer?.actualModel || reviewer?.requestedModel,
        META,
      ) || "unknown model",
      status: reviewer?.status === "ok" ? "done" : "failed",
      text: formatReviewerPresentationText(reviewer),
      usage: presentationUsage(reviewer?.usage),
      error: reviewer?.error ? truncateUtf8(reviewer.error, META) : null,
    })),
    judge: result?.judge
      ? {
          model: truncateUtf8(
            result.judge.actualModel || result.judge.requestedModel,
            META,
          ) || "unknown model",
          status: result.judge.status === "ok" ? "done" : "failed",
          text: formatJudgePresentationText(result),
          usage: presentationUsage(result.judge.usage),
          error: result.judge.error
            ? truncateUtf8(result.judge.error, META)
            : null,
        }
      : null,
    summary: truncateUtf8(
      [
        ...clusterLines("Validated", result?.validatedFindings),
        ...clusterLines("Rejected", result?.rejectedFindings),
        ...clusterLines("Unresolved", result?.unresolvedFindings),
      ]
        .filter(Boolean)
        .join("\n"),
      BODY,
    ),
    usage: presentationUsage(result?.usage),
  };
}

export function createFissionTransportSummary(result) {
  const presented = createFissionPresentationSummary(result);
  const resultPath = presented.runDir
    ? join(presented.runDir, "terminal", "result.json")
    : "";
  let resultSha256 = "";
  try {
    resultSha256 = createHash("sha256").update(readFileSync(resultPath)).digest("hex");
  } catch {
    // early failures may lack artifacts
  }
  const artifactBacked = Boolean(resultSha256);
  return {
    kind: "fission",
    status: presented.status,
    verdict: presented.verdict,
    runId: presented.runId,
    runDir: presented.runDir,
    mode: presented.mode,
    bodyStorage: artifactBacked ? "artifact" : "inline",
    resultPath: artifactBacked ? resultPath : "",
    resultSha256,
    request: truncateUtf8(presented.request, META),
    message: presented.message,
    error: presented.error,
    // Inline fallback when artifact unavailable (small metadata + short texts)
    ...(artifactBacked
      ? {}
      : {
          reviewers: presented.reviewers,
          judge: presented.judge,
          summary: presented.summary,
          usage: presented.usage,
        }),
  };
}

export function hydrateFissionPresentationSummary(summary) {
  if (summary?.bodyStorage !== "artifact") {
    return summary?.kind === "fission"
      ? summary
      : createFissionPresentationSummary(summary);
  }
  try {
    const runsRoot = realpathSync(getRunsDir());
    const runDir = realpathSync(String(summary.runDir || ""));
    const resultPath = realpathSync(String(summary.resultPath || ""));
    const expected = join(runDir, "terminal", "result.json");
    if (!runDir.startsWith(`${runsRoot}${sep}`) || resultPath !== expected) {
      return {
        ...createFissionPresentationSummary(summary),
        error: [summary?.error, "Full Fission output unavailable: artifact path rejected."]
          .filter(Boolean)
          .join("; "),
      };
    }
    const storedBytes = readFileSync(resultPath);
    const digest = createHash("sha256").update(storedBytes).digest("hex");
    if (digest !== String(summary.resultSha256 || "")) {
      return {
        ...createFissionPresentationSummary(summary),
        error: [summary?.error, "Full Fission output unavailable: artifact digest mismatch."]
          .filter(Boolean)
          .join("; "),
      };
    }
    const stored = JSON.parse(storedBytes.toString("utf8"));
    if (
      stored?.kind !== "fission" ||
      String(stored.runId || "") !== String(summary.runId || "")
    ) {
      return {
        ...createFissionPresentationSummary(summary),
        error: [summary?.error, "Full Fission output unavailable: artifact identity mismatch."]
          .filter(Boolean)
          .join("; "),
      };
    }
    return createFissionPresentationSummary(stored);
  } catch {
    return {
      ...createFissionPresentationSummary(summary),
      error: [summary?.error, "Full Fission output unavailable: the run artifact could not be read safely."]
        .filter(Boolean)
        .join("; "),
    };
  }
}

export function formatFissionContextLines(summary) {
  const usage = summary?.usage || {};
  const cost =
    usage.costKnown === false || usage.cost == null
      ? "cost unknown"
      : `$${Number(usage.cost).toFixed(4)}`;
  const lines = [
    `Fission ${summary?.verdict || summary?.status || "UNKNOWN"} (${summary?.runId || "unknown run"})`,
    `Request: ${truncateUtf8(summary?.request, META) || "not recorded"}`,
    `Mode: ${summary?.mode || "—"}`,
    `Reviewers: ${(summary?.reviewers || []).map((r) => r.model).join(", ") || "n/a"}`,
    `Judge: ${summary?.judge?.model || "n/a"}`,
    `Usage: ${usage.input || 0} input, ${usage.output || 0} output, ${usage.turns || 0} turns, ${cost}`,
    `Artifacts: ${summary?.runDir || "n/a"}`,
    "Full reviewer outputs are shown side-by-side in the terminal and saved to artifacts.",
  ];
  if (summary?.message) lines.push(`Message: ${summary.message}`);
  if (summary?.error) lines.push(`Error: ${summary.error}`);
  return lines;
}
