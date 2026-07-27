import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const panel = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "agent-panel.mjs")).href
);

test("render panel shows agent statuses", () => {
  const p = panel.createPanelState({ title: "ALLOY AUTO", runId: "abc", maxFixRounds: 2 });
  panel.upsertAgent(p, { role: "scout", status: "ok", model: "anthropic/claude", detail: "mapped" });
  panel.upsertAgent(p, { role: "builder", status: "running", detail: "edit" });
  panel.setPhase(p, "BUILDING");
  p.fixRound = 0;
  const lines = panel.renderPanelLines(p);
  assert.ok(lines[0].includes("ALLOY AUTO"));
  assert.ok(lines.some((l) => l.includes("scout") && l.includes("✓")));
  assert.ok(lines.some((l) => l.includes("Builder") && l.includes("●")));
});

test("render panel shows compact routing reason and fallback evidence", () => {
  const p = panel.createPanelState({ title: "ALLOY AUTO", runId: "routed" });
  panel.upsertAgent(p, {
    role: "planner",
    status: "ok",
    model: "anthropic/claude-sonnet-4-6",
    routing: { reason: "fallback", fallbackUsed: true },
  });

  const line = panel.renderPanelLines(p).find((item) => item.includes("planner"));
  assert.match(line, /route:fallback/);
});

test("themed render falls back without theme", () => {
  const p = panel.createPanelState({ title: "X" });
  panel.upsertAgent(p, { role: "reviewer", status: "fail", detail: "FAIL" });
  const lines = panel.renderPanelThemed(p, null);
  assert.ok(lines.some((l) => l.includes("✗")));
});

test("ticker lines appear in panel", () => {
  panel.clearTicker();
  panel.pushTickerEvent({ agent: "coder", tool: "bash", detail: "npm test" });
  const p = panel.createPanelState({ title: "ALLOY" });
  const lines = panel.renderPanelLines(p);
  assert.ok(lines.some((l) => l.includes("live")));
  assert.ok(lines.some((l) => l.includes("coder") && l.includes("bash")));
});

test("fusion roles render as Architect, Builder, then Synthesizer", () => {
  const p = panel.createPanelState({ title: "ALLOY FUSION", runId: "fusion-1" });
  panel.upsertAgent(p, { role: "synthesizer", status: "pending" });
  panel.upsertAgent(p, { role: "builder", status: "ok" });
  panel.upsertAgent(p, { role: "architect", status: "ok" });

  const roleLines = panel
    .renderPanelLines(p)
    .filter((line) => /Architect|Builder|Synthesizer/.test(line));
  assert.equal(roleLines.length, 3);
  assert.match(roleLines[0], /Architect/);
  assert.match(roleLines[1], /Builder/);
  assert.match(roleLines[2], /Synthesizer/);
});

test("fusion proposal view renders Architect and Builder output side by side", () => {
  const p = panel.createPanelState({ title: "ALLOY FUSION", runId: "fusion-2" });
  panel.setPhase(p, "PROPOSING");
  panel.upsertAgent(p, {
    role: "architect",
    status: "running",
    model: "anthropic/claude-fable-5",
    effort: "high",
    output: "Architecture boundaries and risks",
  });
  panel.upsertAgent(p, {
    role: "builder",
    status: "running",
    model: "openai-codex/gpt-5.6-sol",
    effort: "medium",
    output: "Implementation steps and tests",
  });

  const lines = panel.renderFusionPaneLines(p, 100);
  assert.match(lines.join("\n"), /Architect.*Builder/);
  assert.match(lines.join("\n"), /fable-5.*high.*gpt-5\.6-sol.*medium/);
  assert.ok(
    lines.some(
      (line) =>
        line.includes("Architecture boundaries") &&
        line.includes("Implementation steps"),
    ),
  );
  assert.ok(lines.every((line) => panel.visibleWidth(line) <= 100));
});

test("fusion panes stack on narrow terminals and synthesis uses full width", () => {
  const p = panel.createPanelState({ title: "ALLOY FUSION", runId: "fusion-3" });
  panel.setPhase(p, "PROPOSING");
  panel.upsertAgent(p, { role: "architect", status: "ok", model: "anthropic/claude-fable-5", output: `${"boundary ".repeat(80)}ARCH OUTPUT` });
  panel.upsertAgent(p, { role: "builder", status: "ok", model: "openai-codex/gpt-5.6-sol", output: `${"implementation ".repeat(80)}BUILD OUTPUT` });
  let lines = panel.renderFusionPaneLines(p, 50);
  assert.ok(lines.findIndex((line) => line.includes("ARCH OUTPUT")) < lines.findIndex((line) => line.includes("BUILD OUTPUT")));
  assert.ok(lines.length <= 14);

  panel.setPhase(p, "SYNTHESIZING");
  panel.upsertAgent(p, {
    role: "synthesizer",
    status: "running",
    model: "anthropic/claude-fable-5",
    output: `${"verification ".repeat(80)}Combined recommendation`,
  });
  lines = panel.renderFusionPaneLines(p, 100);
  assert.match(lines.join("\n"), /ARCH OUTPUT.*BUILD OUTPUT/);
  assert.match(lines.join("\n"), /Synthesizer/);
  assert.match(lines.join("\n"), /Combined recommendation/);
  assert.match(lines.join("\n"), /Architect.*Builder/);
  assert.ok(lines.length <= 14);

  const widget = panel.renderFusionWidgetLines(p, 32);
  assert.ok(widget.length <= 6);
  assert.match(widget.join("\n"), /Architect/);
  assert.match(widget.join("\n"), /Builder/);
  assert.match(widget.join("\n"), /Synthesizer/);
  assert.ok(widget.every((line) => panel.visibleWidth(line) <= 32));

  lines = panel.renderFusionPaneLines(p, 12);
  assert.ok(lines.every((line) => panel.visibleWidth(line) <= 12));
  assert.ok(lines.length <= 14);
});

test("fusion live widget shows the objective and current role output", () => {
  const p = panel.createPanelState({
    title: "ALLOY FUSION",
    runId: "fusion-live",
    objective: "Decide how to make the terminal output complete",
  });
  panel.setPhase(p, "PROPOSING");
  panel.upsertAgent(p, {
    role: "architect",
    status: "running",
    model: "anthropic/claude-fable-5",
    output: "Inspecting transcript boundaries and context isolation",
  });
  panel.upsertAgent(p, {
    role: "builder",
    status: "running",
    model: "openai-codex/gpt-5.6-sol",
    detail: "Tracing the OpenTUI renderer",
  });

  const lines = panel.renderFusionWidgetLines(p, 80);
  assert.match(lines.join("\n"), /Objective: Decide how to make the terminal output complete/);
  assert.match(lines.join("\n"), /Architect.*Inspecting transcript boundaries/);
  assert.match(lines.join("\n"), /Builder.*Tracing the OpenTUI renderer/);
  assert.ok(lines.length <= 6);
  assert.ok(lines.every((line) => panel.visibleWidth(line) <= 80));

  const compact = panel.renderFusionWidgetLines(p, 32);
  assert.match(compact.join("\n"), /Architect.*Inspecting/);
  assert.match(compact.join("\n"), /Builder.*Tracing/);

  const transported = panel.renderFusionWidgetLines(p);
  assert.match(transported.join("\n"), /Objective: Decide how to make the terminal output complete/);
  assert.match(transported.join("\n"), /Inspecting transcript boundaries and context isolation/);

  const huge = panel.createPanelState({ title: "ALLOY FUSION", objective: "x".repeat(1_100_000) });
  panel.upsertAgent(huge, { role: "architect", status: "running", output: "Visible activity" });
  const hugeLines = panel.renderFusionWidgetLines(huge);
  assert.ok(Buffer.byteLength(JSON.stringify(hugeLines)) < 20_000);
  assert.match(hugeLines.join("\n"), /Visible activity/);
});
