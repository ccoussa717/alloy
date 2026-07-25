import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const fusion = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "fusion.mjs")).href
);

test("resolveFusionModels uses config fusion.models", () => {
  const models = fusion.resolveFusionModels(
    {
      fusion: {
        models: ["anthropic/claude-a", "openai-codex/gpt-b", "xai/grok-c"],
      },
      providers: { favorites: [] },
    },
    2,
  );
  assert.equal(models.length, 3);
  assert.equal(models[0], "anthropic/claude-a");
});

test("resolveFusionModels falls back to favorites", () => {
  const models = fusion.resolveFusionModels(
    {
      fusion: { models: [] },
      providers: {
        favorites: ["anthropic/x", "xai/y"],
      },
    },
    2,
  );
  assert.deepEqual(models, ["anthropic/x", "xai/y"]);
});

test("resolveFusionModels pads to count", () => {
  const models = fusion.resolveFusionModels({ fusion: {}, providers: {} }, 2);
  assert.equal(models.length, 2);
});

test("resolveFusionRoleModels routes architect, builder, and synthesizer", () => {
  assert.deepEqual(
    fusion.resolveFusionRoleModels({
      fusion: {
        architectModel: "anthropic/architect",
        builderModel: "openai-codex/builder",
        synthesizerModel: "xai/synthesizer",
      },
      providers: { allow: ["anthropic", "openai-codex", "xai"] },
    }),
    {
      architect: "anthropic/architect",
      builder: "openai-codex/builder",
      synthesizer: "xai/synthesizer",
    },
  );
});

test("resolveFusionRoleEfforts returns optional role-specific thinking levels", () => {
  assert.deepEqual(
    fusion.resolveFusionRoleEfforts({
      fusion: {
        architectEffort: "high",
        builderEffort: "medium",
        synthesizerEffort: null,
      },
    }),
    {
      architect: "high",
      builder: "medium",
      synthesizer: null,
    },
  );
  assert.deepEqual(fusion.resolveFusionRoleEfforts({ fusion: {} }), {
    architect: null,
    builder: null,
    synthesizer: null,
  });
  assert.throws(
    () =>
      fusion.resolveFusionRoleEfforts({
        fusion: { architectEffort: "unlimited" },
      }),
    /invalid.*effort/i,
  );
});

test("fusion argument completions expose setup, status, and help", () => {
  assert.deepEqual(
    fusion.getFusionArgumentCompletions("").map((item) => item.value),
    ["setup", "status", "help"],
  );
  assert.deepEqual(
    fusion.getFusionArgumentCompletions("st").map((item) => item.value),
    ["status"],
  );
  assert.equal(fusion.getFusionArgumentCompletions("design the feature"), null);
});

test("groupFusionModelRoutes builds provider-first model choices", () => {
  assert.deepEqual(
    fusion.groupFusionModelRoutes(
      [
        "xai/grok-4.5",
        "anthropic/claude-opus-4-6",
        "openai-codex/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "openai/gpt-5.4",
        "anthropic/claude-opus-4-6",
      ],
      ["anthropic", "openai-codex", "xai"],
    ),
    [
      {
        id: "anthropic",
        label: "Anthropic",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      },
      {
        id: "openai-codex",
        label: "Codex",
        models: ["gpt-5.4"],
      },
      { id: "xai", label: "xAI", models: ["grok-4.5"] },
    ],
  );
});

test("groupFusionModelRoutes gives unknown providers readable labels", () => {
  assert.deepEqual(
    fusion.groupFusionModelRoutes([
      "vertex-ai/gemini-3",
      "invalid-route",
      "/missing-provider",
      "vertex-ai/",
    ]),
    [
      {
        id: "vertex-ai",
        label: "Vertex AI",
        models: ["gemini-3"],
      },
    ],
  );
});

test("resolveFusionRoleModels supports legacy models without allowing duplicate roles", () => {
  assert.deepEqual(
    fusion.resolveFusionRoleModels({
      fusion: {
        models: ["anthropic/architect", "openai-codex/builder"],
        mergerModel: "anthropic/synthesizer",
      },
      providers: { allow: ["anthropic", "openai-codex"] },
    }),
    {
      architect: "anthropic/architect",
      builder: "openai-codex/builder",
      synthesizer: "anthropic/synthesizer",
    },
  );

  assert.throws(
    () =>
      fusion.resolveFusionRoleModels({
        fusion: {
          architectModel: "anthropic/same",
          builderModel: "anthropic/same",
        },
        providers: { allow: ["anthropic"] },
      }),
    /distinct models/,
  );
});

const proposal = `## Perspective
Independent view.

## Proposed approach
Concrete steps.

## Evidence
Files and observed behavior.

## Risks
Failure modes.

## Verification
Commands and expected results.`;

test("fusion proposal and synthesis contracts are validated", () => {
  assert.equal(fusion.validateFusionProposal(proposal).ok, true);
  assert.equal(
    fusion.validateFusionProposal(proposal.replace("## Risks", "## Concerns")).ok,
    false,
  );

  const synthesis = `## Consensus
Shared conclusions.

## Architect contributions
Architecture-specific value.

## Builder contributions
Implementation-specific value.

## Conflicts and resolution
Tradeoffs and choice.

## Rejected claims
Unsupported ideas.

## Final recommendation
One actionable answer.`;
  assert.equal(fusion.validateFusionSynthesis(synthesis).ok, true);
  assert.equal(
    fusion.validateFusionSynthesis(
      synthesis.replace("## Final recommendation", "## Maybe"),
    ).ok,
    false,
  );

  assert.equal(
    fusion.validateFusionProposal(`${proposal}\n\n## Extra\nUnsupported section.`).ok,
    false,
  );
  assert.equal(
    fusion.validateFusionProposal(`\`\`\`markdown\n${proposal}\n\`\`\``).ok,
    false,
  );
  assert.equal(
    fusion.validateFusionProposal(
      proposal.replace("## Evidence\nFiles and observed behavior.", "## Evidence\n"),
    ).ok,
    false,
  );
  assert.equal(
    fusion.validateFusionSynthesis(
      synthesis.replace(
        "## Architect contributions\nArchitecture-specific value.\n\n## Builder contributions",
        "## Builder contributions\nImplementation-specific value.\n\n## Architect contributions",
      ),
    ).ok,
    false,
  );
});

test("fusion status cannot complete without two valid proposals and synthesis", () => {
  const good = { ok: true, contractOk: true };
  assert.equal(
    fusion.deriveFusionStatus({ proposals: [good, good], synthesis: good }),
    "COMPLETE",
  );
  assert.equal(
    fusion.deriveFusionStatus({
      proposals: [good, { ok: false, error: "auth_required" }],
      synthesis: null,
    }),
    "FAILED",
  );
  assert.equal(
    fusion.deriveFusionStatus({
      proposals: [good, { ok: false }],
      synthesis: good,
    }),
    "FAILED",
  );
  assert.equal(
    fusion.deriveFusionStatus({
      proposals: [good, good],
      synthesis: null,
      aborted: true,
    }),
    "ABORTED",
  );
  assert.equal(
    fusion.deriveFusionStatus({
      proposals: [good, good],
      synthesis: null,
      budgetExceeded: true,
    }),
    "BUDGET_EXCEEDED",
  );
  assert.equal(
    fusion.deriveFusionStatus({
      proposals: [good, good],
      synthesis: { ok: false, contractOk: false, error: "auth_required" },
    }),
    "FAILED",
  );
});
