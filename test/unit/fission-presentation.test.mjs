import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFissionPresentationSummary,
  createFissionTransportSummary,
  formatReviewerPresentationText,
} from "../../lib/fission-presentation.mjs";

describe("fission presentation", () => {
  it("formats reviewer findings for side-by-side display", () => {
    const text = formatReviewerPresentationText({
      alias: "R01",
      role: "adversarial_code_review",
      status: "ok",
      actualModel: "openai-codex/gpt-5.6-sol",
      output: {
        reviewerRole: "adversarial_code_review",
        coverage: ["layout"],
        findings: [{
          severity: "medium",
          claim: "overflow clipped",
          affectedPath: "docs/x.html",
          evidence: "overflow:hidden",
          suggestedFix: "allow scroll",
        }],
        errors: ["soft omit note"],
      },
    });
    assert.match(text, /R01/);
    assert.match(text, /overflow clipped/);
    assert.match(text, /soft omit note/);
  });

  it("builds a transport summary", () => {
    const result = {
      kind: "fission",
      status: "COMPLETE",
      verdict: "PASS",
      message: "ok",
      request: "review",
      runId: "abc",
      runDir: "/tmp/missing",
      mode: "repo",
      reviewers: [],
      judge: null,
      usage: { input: 1, output: 1, cost: 0.1, turns: 1, costKnown: true },
    };
    const presented = createFissionPresentationSummary(result);
    assert.equal(presented.kind, "fission");
    assert.equal(presented.verdict, "PASS");
    const transport = createFissionTransportSummary(result);
    assert.equal(transport.kind, "fission");
    assert.equal(transport.bodyStorage, "inline");
  });
});
