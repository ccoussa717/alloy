import { describe, expect, it } from "bun:test";
import { contextRows, mcpRows } from "../src/sidebar";

describe("sidebar presentation", () => {
  it("formats authoritative context usage and cost", () => {
    expect(contextRows(null)).toEqual(["Waiting for session"]);
    expect(contextRows({ tokens: 1200, contextWindow: 200000, percent: 0.6, cost: 0.0123 })).toEqual([
      "1.2k / 200k tokens",
      "0.6% used",
      "$0.01 session",
    ]);
    expect(contextRows({ tokens: null, contextWindow: 200000, percent: null, cost: 0 })).toEqual([
      "Context recalculating",
      "$0.00 session",
    ]);
  });

  it("renders truthful MCP state, transport, tools, and bounded errors", () => {
    expect(mcpRows([
      { name: "open-brain", status: "connected", toolCount: 3, transport: "http" },
      { name: "local", status: "connecting", transport: "stdio" },
      { name: "broken", status: "failed", error: "offline", transport: "sse" },
      { name: "manual", status: "disconnected", transport: "http" },
      { name: "disabled", status: "disabled", transport: "stdio" },
    ])).toEqual([
      "× broken · failed · sse",
      "  offline",
      "○ disabled · disabled · stdio",
      "◐ local · connecting · stdio",
      "○ manual · disconnected · http",
      "● open-brain · 3 tools · http",
    ]);
  });
});
