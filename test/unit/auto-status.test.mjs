import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAutoStatus } from "../../lib/auto-status.mjs";

describe("P0.5 truthful auto status", () => {
  it("COMPLETE only when pass", () => {
    assert.deepEqual(resolveAutoStatus({ pass: true }), {
      status: "COMPLETE",
      pass: true,
    });
  });

  it("never COMPLETE when pass false", () => {
    const r = resolveAutoStatus({
      pass: false,
      hasPartialOutput: true,
    });
    assert.equal(r.status, "PARTIAL");
    assert.equal(r.pass, false);
  });

  it("worktree failure is FAILED", () => {
    assert.equal(
      resolveAutoStatus({ worktreeFailed: true, pass: true }).status,
      "FAILED",
    );
  });

  it("auth and budget and abort", () => {
    assert.equal(resolveAutoStatus({ authFail: true }).status, "AUTH_REQUIRED");
    assert.equal(resolveAutoStatus({ overBudget: true }).status, "FAILED");
    assert.equal(resolveAutoStatus({ aborted: true }).status, "ABORTED");
  });
});
