import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesForTool,
  evaluateToolPolicy,
  capsSubsetOf,
  READ_ONLY_CAPS,
  isDangerousBash,
} from "../../lib/capabilities.mjs";

describe("capability policy", () => {
  it("assigns explicit caps to native and alloy tools", () => {
    assert.deepEqual(capabilitiesForTool("read"), ["read"]);
    assert.deepEqual(capabilitiesForTool("write"), ["workspace_write"]);
    assert.deepEqual(capabilitiesForTool("bash"), ["process"]);
    assert.ok(capabilitiesForTool("alloy_auto").includes("child_agent"));
    assert.ok(capabilitiesForTool("alloy_remember").includes("persistent_state"));
    assert.ok(capabilitiesForTool("alloy_worktree").includes("git_destructive"));
    assert.deepEqual(capabilitiesForTool("alloy_fission"), [
      "child_agent",
      "workspace_write",
      "process",
    ]);
    assert.deepEqual(capabilitiesForTool("alloy_memory_search"), ["read"]);
  });

  it("does not treat MCP names as read-only via heuristics", () => {
    // Old bug: mcp_repo_get_and_delete looked "read" because of _get_
    const caps = capabilitiesForTool("mcp_repo_get_and_delete");
    assert.deepEqual(caps, ["external_side_effect"]);
    assert.equal(capsSubsetOf(caps, READ_ONLY_CAPS), false);
  });

  it("plan mode denies bash entirely (no inspection prefix bypass)", () => {
    const r = evaluateToolPolicy({
      toolName: "bash",
      input: { command: "ls -la" },
      mode: "plan",
      readOnlyMode: true,
      permissionProfile: "ask-dangerous",
    });
    assert.equal(r.decision, "deny");
    assert.match(r.reason, /bash entirely/i);
  });

  it("plan mode denies node -e write and npm test style commands", () => {
    for (const command of [
      "node -e \"require('fs').writeFileSync('x','y')\"",
      "echo hi > file.txt",
      "find . -exec rm {} \\;",
      "npm test",
    ]) {
      const r = evaluateToolPolicy({
        toolName: "bash",
        input: { command },
        mode: "plan",
        readOnlyMode: true,
      });
      assert.equal(r.decision, "deny", command);
    }
  });

  it("plan mode denies write/edit and mutating alloy tools", () => {
    for (const tool of [
      "write",
      "edit",
      "alloy_auto",
      "alloy_worktree",
      "alloy_remember",
      "alloy_diagnostics",
      "alloy_fusion",
      "alloy_fission",
      "alloy_task",
    ]) {
      const r = evaluateToolPolicy({
        toolName: tool,
        mode: "review",
        readOnlyMode: true,
      });
      assert.equal(r.decision, "deny", tool);
    }
  });

  it("plan mode allows pure read tools", () => {
    for (const tool of ["read", "grep", "find", "ls", "alloy_help", "alloy_memory_search"]) {
      const r = evaluateToolPolicy({
        toolName: tool,
        mode: "plan",
        readOnlyMode: true,
      });
      assert.equal(r.decision, "allow", tool);
    }
  });

  it("plan mode denies all MCP tools by default (no name inference)", () => {
    for (const tool of [
      "mcp_repo_get_and_delete",
      "mcp_fs_read_file",
      "mcp_search_query",
    ]) {
      const r = evaluateToolPolicy({
        toolName: tool,
        mode: "plan",
        readOnlyMode: true,
      });
      assert.equal(r.decision, "deny", tool);
    }
  });

  it("ask-all requires approval for mutations and MCP", () => {
    assert.equal(
      evaluateToolPolicy({
        toolName: "write",
        permissionProfile: "ask-all",
      }).decision,
      "approve",
    );
    assert.equal(
      evaluateToolPolicy({
        toolName: "mcp_anything",
        permissionProfile: "ask-all",
      }).decision,
      "approve",
    );
    assert.equal(
      evaluateToolPolicy({
        toolName: "read",
        permissionProfile: "ask-all",
      }).decision,
      "allow",
    );
  });

  it("ask-some requires approval for alloy_auto and alloy_remember", () => {
    assert.equal(
      evaluateToolPolicy({
        toolName: "alloy_auto",
        permissionProfile: "ask-some",
        mode: "build",
      }).decision,
      "approve",
    );
    assert.equal(
      evaluateToolPolicy({
        toolName: "alloy_remember",
        permissionProfile: "ask-some",
        mode: "build",
      }).decision,
      "approve",
    );
  });

  it("ask-dangerous flags dangerous bash only", () => {
    assert.equal(
      evaluateToolPolicy({
        toolName: "bash",
        input: { command: "ls" },
        permissionProfile: "ask-dangerous",
        mode: "build",
      }).decision,
      "allow",
    );
    assert.equal(
      evaluateToolPolicy({
        toolName: "bash",
        input: { command: "rm -rf /tmp/x" },
        permissionProfile: "ask-dangerous",
        mode: "build",
      }).decision,
      "approve",
    );
    assert.ok(isDangerousBash("git reset --hard"));
  });

  it("unknown tools are external_side_effect and denied in plan", () => {
    const caps = capabilitiesForTool("totally_unknown_tool");
    assert.deepEqual(caps, ["external_side_effect"]);
    assert.equal(
      evaluateToolPolicy({
        toolName: "totally_unknown_tool",
        mode: "plan",
        readOnlyMode: true,
      }).decision,
      "deny",
    );
  });
});
