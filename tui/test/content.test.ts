import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { displayPreview, messageBlocks, messageRole, redactDisplayText, resultText, toolSummary, transcriptToolStates, type TranscriptBlock } from "../src/content"

describe("redactDisplayText", () => {
  test("removes complete bearer and basic authorization credentials", () => {
    expect(redactDisplayText("Authorization: Bearer bearer-secret")).not.toContain("bearer-secret")
    expect(redactDisplayText("Authorization: Basic dXNlcjpzZWNyZXQ=")).not.toContain("dXNlcjpzZWNyZXQ=")
    expect(redactDisplayText("Authorization: Digest username=admin response=secret-response")).toBe("Authorization: [REDACTED]")
    expect(redactDisplayText("Authorization: AWS4-HMAC-SHA256 Signature=secret-signature")).toBe("Authorization: [REDACTED]")
    expect(redactDisplayText("Authorization: Digest username=admin, response=secret-response; opaque=secret")).toBe("Authorization: [REDACTED]")
  })

  test("does not corrupt ordinary source and prose", () => {
    expect(redactDisplayText("const token = await lexer.next()")).toBe("const token = await lexer.next()")
    expect(redactDisplayText("type Credential = string")).toBe("type Credential = string")
    expect(redactDisplayText("Use Basic authentication")).toBe("Use Basic authentication")
  })
})

describe("messageRole", () => {
  test("normalizes Pi and custom roles without trusting the input", () => {
    expect(messageRole({ role: "user" })).toBe("user")
    expect(messageRole({ role: "assistant" })).toBe("assistant")
    expect(messageRole({ role: "toolResult" })).toBe("tool")
    expect(messageRole({ role: "system" })).toBe("system")
    expect(messageRole({ role: "bashExecution" })).toBe("custom")
    expect(messageRole({ role: "custom" })).toBe("custom")
    expect(messageRole({ role: "future-role" })).toBe("unknown")
    expect(messageRole(null)).toBe("unknown")
  })
})

describe("messageBlocks", () => {
  test("keeps user text and image content as separate blocks", () => {
    expect(
      messageBlocks({
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", mimeType: "image/png", data: "abc" },
          { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///notes.txt" },
        ],
      }),
    ).toEqual([
      { kind: "text", text: "inspect this" },
      { kind: "image", mimeType: "image/png", data: "abc" },
      { kind: "file", mimeType: "text/plain", name: "notes.txt", url: "file:///notes.txt" },
    ])
  })

  test("keeps assistant text, reasoning, and tool calls in source order", () => {
    expect(
      messageBlocks({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check types", redacted: true },
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
          { type: "reasoning", text: "streamed provider reasoning" },
        ],
      }),
    ).toEqual([
      { kind: "reasoning", text: "check types", source: "thinking", redacted: true },
      { kind: "text", text: "I will inspect it." },
      {
        kind: "tool-call",
        id: "call-1",
        name: "read",
        input: { path: "src/a.ts" },
        summary: "Read src/a.ts",
      },
      { kind: "reasoning", text: "streamed provider reasoning", source: "reasoning", redacted: false },
    ])
  })

  test("retains full tool output alongside a bounded collapsed preview", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
    const blocks = messageBlocks(
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: output }],
      },
      { previewLines: 3, previewChars: 100 },
    )

    expect(blocks).toEqual([
      {
        kind: "tool-result",
        id: "call-1",
        name: "bash",
        isError: false,
        preview: "line 1\nline 2\nline 3\n…",
        expanded: output,
        truncated: true,
      },
    ])
    expect((blocks[0] as { expanded: string }).expanded).toEndWith("line 30")
  })

  test("caps a huge single-line preview without changing its expanded output", () => {
    const output = "😀".repeat(10_000)
    const [block] = messageBlocks(
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: output }] },
      { previewLines: 3, previewChars: 8 },
    )

    expect(block).toEqual({
      kind: "tool-result",
      name: "bash",
      isError: false,
      preview: "😀😀😀😀😀😀😀…",
      expanded: output,
      truncated: true,
    })
  })

  test("preserves images returned by tools separately from the result", () => {
    expect(
      messageBlocks({
        role: "toolResult",
        toolCallId: "image-1",
        toolName: "screenshot",
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/jpeg", data: "xyz" },
        ],
      }),
    ).toEqual([
      {
        kind: "tool-result",
        id: "image-1",
        name: "screenshot",
        isError: false,
        preview: "captured",
        expanded: "captured",
        truncated: false,
      },
      { kind: "image", mimeType: "image/jpeg", data: "xyz" },
    ])
  })

  test("preserves coding-agent custom messages", () => {
    expect(
      messageBlocks({ role: "custom", customType: "notice", content: { status: "waiting", attempt: 2 } }),
    ).toEqual([
      {
        kind: "custom",
        name: "notice",
        text: '{"status":"waiting","attempt":2}',
        value: { status: "waiting", attempt: 2 },
      },
    ])

    expect(
      messageBlocks({ role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0 }),
    ).toEqual([
      {
        kind: "custom",
        name: "bashExecution",
        text: "$ pwd\n/tmp\nexit 0",
        value: { command: "pwd", output: "/tmp", exitCode: 0 },
      },
    ])
  })

  test("normalizes Alloy Fusion results for durable transcript rendering", () => {
    expect(
      messageBlocks({
        role: "custom",
        customType: "alloy-fusion",
        content: "fallback summary",
        details: {
          kind: "fusion",
          status: "COMPLETE",
          runId: "fusion-1",
          runDir: "/tmp/fusion-1",
          objective: "Compare both approaches",
          requestedEfforts: {
            architect: "high",
            builder: "medium",
            synthesizer: "low",
          },
          proposals: [
            {
              role: "architect",
              model: "anthropic/claude-fable-5",
              ok: true,
              durationMs: 1_250,
              text: "## Architecture\n\nKeep the boundary explicit.",
              usage: { input: 1_200, output: 340, cost: 0.0123, turns: 2 },
            },
            {
              role: "builder",
              model: "openai-codex/gpt-5.6-sol",
              ok: true,
              durationMs: 980,
              text: "## Build\n\nShip the smallest complete slice.",
              usage: { input: 900, output: 280, cost: 0.0098, turns: 1 },
            },
          ],
          synthesis: "## Recommendation\n\nCombine both approaches.",
          synthesizer: {
            ok: true,
            model: "anthropic/claude-fable-5",
            durationMs: 640,
            usage: { input: 2_500, output: 410, cost: 0.015, turns: 1 },
          },
        },
      }),
    ).toEqual([
      {
        kind: "fusion",
        status: "COMPLETE",
        runId: "fusion-1",
        runDir: "/tmp/fusion-1",
        objective: "Compare both approaches",
        proposals: [
          {
            role: "architect",
            model: "anthropic/claude-fable-5",
            effort: "high",
            status: "done",
            durationMs: 1_250,
            text: "## Architecture\n\nKeep the boundary explicit.",
            usage: { input: 1_200, output: 340, cost: 0.0123, costKnown: true, turns: 2 },
          },
          {
            role: "builder",
            model: "openai-codex/gpt-5.6-sol",
            effort: "medium",
            status: "done",
            durationMs: 980,
            text: "## Build\n\nShip the smallest complete slice.",
            usage: { input: 900, output: 280, cost: 0.0098, costKnown: true, turns: 1 },
          },
        ],
        synthesis: {
          role: "synthesizer",
          model: "anthropic/claude-fable-5",
          effort: "low",
          status: "done",
          durationMs: 640,
          text: "## Recommendation\n\nCombine both approaches.",
          usage: { input: 2_500, output: 410, cost: 0.015, costKnown: true, turns: 1 },
        },
      },
    ])
  })

  test("preserves complete Fusion role output in durable transcript blocks", () => {
    const architect = `Architect starts\n${"architecture detail ".repeat(2_000)}\nARCHITECT END`
    const builder = `Builder starts\n${"implementation detail ".repeat(2_000)}\nBUILDER END`
    const synthesis = `## Agreements\nShared evidence.\n\n## Disagreements\nAttributed differences.\n\n## Consensus\n${"actionable answer ".repeat(2_000)}\nCONSENSUS END`
    const [block] = messageBlocks({
      role: "custom",
      customType: "alloy-fusion",
      details: {
        kind: "fusion",
        status: "COMPLETE",
        objective: "Show every result in the terminal",
        proposals: [
          { role: "architect", model: "anthropic/a", ok: true, text: architect },
          { role: "builder", model: "openai-codex/b", ok: true, text: builder },
        ],
        synthesis,
        synthesizer: { model: "anthropic/s", ok: true },
      },
    })

    expect(block).toMatchObject({
      kind: "fusion",
      objective: "Show every result in the terminal",
      proposals: [{ text: architect }, { text: builder }],
      synthesis: { text: synthesis },
    })
  })

  test("hydrates complete Fusion output from an artifact-backed transport record", () => {
    const home = mkdtempSync(join(tmpdir(), "alloy-tui-fusion-"))
    const previousHome = process.env.ALLOY_HOME
    process.env.ALLOY_HOME = home
    try {
      const runDir = join(home, "runs", "fusion-artifact")
      mkdirSync(runDir, { recursive: true })
      const summary = {
        kind: "fusion",
        status: "COMPLETE",
        runId: "fusion-artifact",
        runDir,
        objective: "Render the complete result",
        proposals: [
          { role: "architect", model: "anthropic/a", ok: true, text: `ARCH ${"full ".repeat(50_000)}END` },
          { role: "builder", model: "openai-codex/b", ok: true, text: `BUILD ${"full ".repeat(50_000)}END` },
        ],
        synthesis: `## Agreements\nShared.\n\n## Disagreements\n- Architect: A\n- Builder: B\n- Status: open\n\n## Consensus\n- Decision: C\n- Caveats: D\n${"full ".repeat(50_000)}END`,
        synthesizer: { model: "anthropic/s", ok: true },
      }
      const summaryPath = join(runDir, "summary.json")
      writeFileSync(summaryPath, JSON.stringify(summary))
      const summarySha256 = createHash("sha256").update(readFileSync(summaryPath)).digest("hex")

      const details = {
        kind: "fusion",
        bodyStorage: "artifact",
        summaryPath,
        summarySha256,
        status: "COMPLETE",
        runId: "fusion-artifact",
        runDir,
        objective: "Render the complete result",
      }
      const [block] = messageBlocks({
        role: "custom",
        customType: "alloy-fusion",
        details,
      })

      expect(block).toMatchObject({
        kind: "fusion",
        objective: summary.objective,
        proposals: [{ text: summary.proposals[0]!.text }, { text: summary.proposals[1]!.text }],
        synthesis: { text: summary.synthesis },
      })

      const toolBlocks = messageBlocks({
        role: "toolResult",
        toolName: "alloy_fusion",
        content: [{ type: "text", text: "Fusion metadata" }],
        details,
      })
      expect(toolBlocks[1]).toMatchObject({
        kind: "fusion",
        proposals: [{ text: summary.proposals[0]!.text }, { text: summary.proposals[1]!.text }],
        synthesis: { text: summary.synthesis },
      })
      const spoofed = messageBlocks({
        role: "toolResult",
        toolName: "unrelated_tool",
        content: [{ type: "text", text: "Not Fusion" }],
        details,
      })
      expect(spoofed.some((item) => item.kind === "fusion")).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.ALLOY_HOME
      else process.env.ALLOY_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("keeps actionable Fusion failure text when no role result exists", () => {
    expect(
      messageBlocks({
        role: "custom",
        customType: "alloy-fusion",
        content: "Provider unavailable in this Alloy session: anthropic",
        details: {
          kind: "fusion",
          status: "FAILED",
          runId: "fusion-failed",
          runDir: "/tmp/fusion-failed",
          proposals: [],
          synthesis: "",
          synthesizer: null,
          error: "provider_unavailable",
        },
      })[0],
    ).toMatchObject({
      kind: "fusion",
      status: "FAILED",
      error: "provider_unavailable",
      summary: "Provider unavailable in this Alloy session: anthropic",
    })
  })

  test("keeps partial failure guidance and distinguishes unknown metrics from zero", () => {
    const block = messageBlocks({
      role: "custom",
      customType: "alloy-fusion",
      content: "Provider unavailable in this Alloy session: openai-codex\nRoute reason: authentication required",
      details: {
        kind: "fusion",
        status: "FAILED",
        runId: "fusion-partial",
        runDir: "/tmp/fusion-partial",
        objective: "Compare both approaches",
        requestedEfforts: { architect: "high" },
        proposals: [{
          role: "architect",
          model: "anthropic/claude-fable-5",
          ok: true,
          durationMs: -5,
          text: "Architect result",
          usage: { input: -1, output: 0, cost: -1, costKnown: false, turns: 0 },
        }],
        synthesis: "",
        synthesizer: null,
        error: "provider_unavailable",
      },
    })[0]

    expect(block).toMatchObject({
      kind: "fusion",
      objective: "Compare both approaches",
      error: "provider_unavailable",
      summary: "Provider unavailable in this Alloy session: openai-codex\nRoute reason: authentication required",
      proposals: [{
        durationMs: null,
        usage: { input: 0, output: 0, cost: null, costKnown: false, turns: 0 },
      }],
    })
  })

  test("accepts only explicit unique proposal roles and forces synthesis provenance", () => {
    const block = messageBlocks({
      role: "custom",
      customType: "alloy-fusion",
      content: "Fusion COMPLETE",
      details: {
        kind: "fusion",
        status: "COMPLETE",
        proposals: [
          { role: "unknown", model: "spoofed", ok: true, text: "Spoofed architect" },
          { role: "architect", model: "architect-1", ok: true, text: "Real architect" },
          { role: "architect", model: "architect-2", ok: true, text: "Duplicate architect" },
          { role: "builder", model: "builder", ok: true, text: "Real builder" },
        ],
        synthesis: "Real synthesis",
        synthesizer: { role: "architect", model: "synth", ok: true },
      },
    })[0]

    expect(block).toMatchObject({
      kind: "fusion",
      proposals: [
        { role: "builder", model: "builder", text: "Real builder" },
      ],
      synthesis: { role: "synthesizer", model: "synth", text: "Real synthesis" },
    })
    expect((block as Extract<TranscriptBlock, { kind: "fusion" }>).error).toMatch(/malformed.*unknown.*duplicate architect/i)
  })

  test("turns malformed and future content into inspectable unknown blocks", () => {
    const circular: Record<string, unknown> = { type: "future", payload: { answer: 42 } }
    circular.self = circular

    const blocks = messageBlocks({ role: "assistant", content: [null, circular, { type: "text", text: {} }] })

    expect(blocks).toHaveLength(3)
    expect(blocks.every((block) => !("text" in block) || !block.text.includes("[object Object]"))).toBe(true)
    expect(blocks[0]).toEqual({ kind: "unknown", text: "null", value: null })
    expect(blocks[1]?.kind).toBe("unknown")
    expect((blocks[1] as { text: string }).text).toContain('"answer":42')
    expect((blocks[1] as { text: string }).text).toContain("[Circular]")
    expect(blocks[2]).toEqual({ kind: "unknown", text: '{"type":"text","text":{}}', value: { type: "text", text: {} } })
  })

  test("accepts partial streaming messages without throwing or fabricating object strings", () => {
    expect(messageBlocks({ role: "assistant" })).toEqual([])
    expect(messageBlocks({ role: "assistant", content: "partial" })).toEqual([{ kind: "text", text: "partial" }])
    expect(messageBlocks({ role: "assistant", content: [{ type: "toolCall", id: "pending" }] })).toEqual([
      { kind: "tool-call", id: "pending", name: "tool", input: {}, summary: "tool" },
    ])
    expect(messageBlocks(undefined)).toEqual([{ kind: "unknown", text: "undefined", value: undefined }])
  })

  test("redacts nested secrets in custom and unknown display text without mutating values", () => {
    const nested = {
      safe: "visible",
      auth: {
        apiKey: "key-live-123",
        deeper: [{ password: "password-live-456" }, { note: "Bearer bearer-live-789" }],
      },
    }
    const custom = messageBlocks({ role: "custom", customType: "notice", content: nested })[0]
    const unknown = messageBlocks({ role: "future", content: nested })[0]

    expect(custom).toMatchObject({ kind: "custom", value: nested })
    expect(unknown).toMatchObject({ kind: "unknown", value: nested })
    expect((custom as { text: string }).text).toContain("visible")
    expect((custom as { text: string }).text).not.toContain("key-live-123")
    expect((custom as { text: string }).text).not.toContain("password-live-456")
    expect((custom as { text: string }).text).not.toContain("bearer-live-789")
    expect((unknown as { text: string }).text).not.toContain("key-live-123")
    expect(nested.auth.apiKey).toBe("key-live-123")
    expect(nested.auth.deeper[0]?.password).toBe("password-live-456")
  })
})

describe("resultText", () => {
  test("extracts all textual result content without capping it", () => {
    const huge = "x".repeat(20_000)
    expect(resultText({ content: [{ type: "text", text: huge }] })).toBe(huge)
    expect(resultText({ content: [{ text: "one" }, { type: "text", text: "two" }] })).toBe("one\ntwo")
  })

  test("serializes structural and malformed results without object coercion", () => {
    expect(resultText({ content: [{ type: "json", value: { ok: true } }] })).toBe(
      '{"type":"json","value":{"ok":true}}',
    )
    expect(resultText({ output: { files: ["a.ts"] } })).toBe('{"files":["a.ts"]}')
    expect(resultText({ details: { error: "boom" } })).toBe('{"error":"boom"}')
    expect(resultText({ content: [], details: { error: "empty stream" } })).toBe('{"error":"empty stream"}')
    expect(resultText(null)).toBe("")
    expect(resultText({})).toBe("")
  })

  test("redacts nested secret keys and bearer values in result display copies", () => {
    const result = {
      output: {
        ok: true,
        credentials: {
          accessToken: "token-live-123",
          authorization: "Bearer auth-live-456",
        },
      },
    }

    const text = resultText(result)
    expect(text).toContain('"ok":true')
    expect(text).not.toContain("token-live-123")
    expect(text).not.toContain("auth-live-456")
    expect(text).toContain("[REDACTED]")
    expect(result.output.credentials.accessToken).toBe("token-live-123")
  })
})

describe("toolSummary", () => {
  test("formats Pi built-ins like OpenCode transcript labels", () => {
    expect(toolSummary("bash", { command: "bun test" })).toBe("$ bun test")
    expect(toolSummary("read", { path: "src/a.ts", offset: 4, limit: 20 })).toBe("Read src/a.ts:4+20")
    expect(toolSummary("write", { path: "src/a.ts" })).toBe("Write src/a.ts")
    expect(toolSummary("edit", { filePath: "src/a.ts" })).toBe("Edit src/a.ts")
    expect(toolSummary("grep", { pattern: "needle", path: "src" })).toBe('Grep "needle" in src')
    expect(toolSummary("find", { pattern: "*.ts", path: "src" })).toBe('Find "*.ts" in src')
    expect(toolSummary("ls", { path: "src" })).toBe("List src")
  })

  test("formats web, orchestration, and mutation tools", () => {
    expect(toolSummary("webfetch", { url: "https://example.com" })).toBe("WebFetch https://example.com")
    expect(toolSummary("web", { url: "https://example.com/docs" })).toBe("WebFetch https://example.com/docs")
    expect(toolSummary("web_search", { query: "OpenTUI" })).toBe('Web Search "OpenTUI"')
    expect(toolSummary("task", { subagent_type: "explore", description: "trace messages" })).toBe(
      "Explore Task — trace messages",
    )
    expect(toolSummary("skill", { name: "tdd" })).toBe('Skill "tdd"')
    expect(toolSummary("todowrite", { todos: [{}, {}] })).toBe("Update todos (2)")
    expect(toolSummary("apply_patch", { patchText: "*** Begin Patch" })).toBe("Patch")
  })

  test("handles aliases, generic tools, partial arguments, and circular values", () => {
    expect(toolSummary("shell", { command: "pwd" })).toBe("$ pwd")
    expect(toolSummary("glob", { pattern: "*.tsx" })).toBe('Find "*.tsx"')
    expect(toolSummary("mcp_linear_create_issue", { title: "Bug", metadata: { priority: 1 } })).toBe(
      "linear create issue [title=Bug]",
    )
    expect(toolSummary("read", undefined)).toBe("Read")

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const summary = toolSummary("custom", { nested: circular })
    expect(summary).toContain("custom")
    expect(summary).toContain("[Circular]")
    expect(summary).not.toContain("[object Object]")
  })

  test("redacts secret arguments and bearer-like values from summaries", () => {
    expect(toolSummary("custom", { apiKey: "key-live", label: "visible" })).toBe(
      "custom [apiKey=[REDACTED], label=visible]",
    )
    expect(toolSummary("bash", { command: "curl -H 'Authorization: Bearer auth-live' example.com" })).not.toContain(
      "auth-live",
    )
  })

  test("caps redacted live display previews by line and character limits", () => {
    const preview = displayPreview(
      { output: `one\ntwo\nBearer auth-live\n${"x".repeat(100)}` },
      { previewLines: 3, previewChars: 40 },
    )
    expect(preview).not.toContain("auth-live")
    expect(preview).toEndWith("…")
    expect(Array.from(preview).length).toBeLessThanOrEqual(41)
  })
})

describe("transcriptToolStates", () => {
  test("collects completion and error state so live activity rows do not duplicate transcript entries", () => {
    expect(
      transcriptToolStates([
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [] },
        { role: "toolResult", toolCallId: "call-2", toolName: "bash", isError: true, content: [] },
        { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "write" }] },
      ]),
    ).toEqual({ "call-1": "completed", "call-2": "error", "call-3": "pending" })
  })
})
