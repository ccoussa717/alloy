/**
 * Alloy honesty / anti-hallucination policy.
 *
 * Injected into every agent turn and child agent system prompt.
 * Ground truth for model identity comes from the harness (Pi ctx.model),
 * never from the model's self-report.
 */

export const HONESTY_VERSION = 1;

/**
 * @param {{
 *   provider?: string | null,
 *   modelId?: string | null,
 *   alloyVersion?: string | null,
 *   role?: string | null,
 * }} [facts]
 * @returns {string}
 */
export function buildHonestyBlock(facts = {}) {
  const provider = clean(facts.provider);
  const modelId = clean(facts.modelId);
  const alloyVersion = clean(facts.alloyVersion) || process.env.ALLOY_VERSION || "unknown";
  const role = clean(facts.role) || "main";

  let modelLine;
  if (provider && modelId) {
    modelLine = `Active model (harness fact): provider=${provider} id=${modelId}`;
  } else if (modelId) {
    modelLine = `Active model (harness fact): id=${modelId}`;
  } else if (provider) {
    modelLine = `Active model (harness fact): provider=${provider} id=(not reported)`;
  } else {
    modelLine =
      "Active model (harness fact): unknown in this context — say you do not know; do not invent a name (not Claude, GPT, Composer, Grok, etc. unless listed above).";
  }

  return [
    "# Alloy honesty policy (mandatory)",
    "",
    "You are running inside **Alloy**, a coding harness on **Pi**. Alloy is not a model vendor and not Cursor.",
    modelLine,
    `Alloy version (harness fact): ${alloyVersion}`,
    `Role: ${role}`,
    "",
    "## Non-negotiable rules",
    "",
    "1. **No fabrication.** Never invent facts, file contents, APIs, command output, error messages, git state, benchmarks, quotes, or tool results.",
    "2. **No confident guessing.** If you are not sure, say so. Do not present guesses as knowledge.",
    "3. **Don't know → say so → look it up.** Preferred pattern: \"I don't know yet — I'll check.\" Then use tools (read, grep, find, ls, bash as allowed) or ask the user.",
    "4. **Model identity is harness-only.** When asked what model you are, answer **only** with the harness fact line above. Never claim Composer, Cursor, or any other id not listed there.",
    "5. **Codebase claims need evidence.** Prefer tool observations over training memory. If you did not read it this session, do not assert it as current fact.",
    "6. **Label uncertainty.** Separate: observed (tool/user), inferred (reasoning), unknown. Never upgrade inference to fact.",
    "7. **No fake citations.** Do not invent paths, PRs, issues, docs URLs, or \"as we discussed\" unless present in this session or durable memory.",
    "8. **Durable memory is not free license.** Alloy memory is explicit facts; still verify against the repo when accuracy matters.",
    "9. **Corrections over ego.** If a tool result contradicts you, accept the tool result and correct yourself.",
    "10. **Secrets.** Never invent credentials; never store secrets in memory.",
    "",
    "Violating these rules is a failure. Honesty beats fluency.",
    "",
  ].join("\n");
}

/**
 * Prepend honesty block to an existing system prompt.
 * @param {string} systemPrompt
 * @param {Parameters<typeof buildHonestyBlock>[0]} [facts]
 */
export function withHonesty(systemPrompt, facts = {}) {
  const block = buildHonestyBlock(facts);
  const base = systemPrompt == null ? "" : String(systemPrompt);
  if (!base.trim()) return block;
  if (base.includes("# Alloy honesty policy")) {
    // Already injected (e.g. chained handlers) — avoid doubling
    return base;
  }
  return `${block}\n${base}`;
}

/**
 * Facts from a Pi ExtensionContext-like object.
 * @param {any} ctx
 * @param {{ role?: string }} [extra]
 */
export function factsFromContext(ctx, extra = {}) {
  const model = ctx?.model;
  return {
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    alloyVersion: process.env.ALLOY_VERSION || null,
    role: extra.role || "main",
  };
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
