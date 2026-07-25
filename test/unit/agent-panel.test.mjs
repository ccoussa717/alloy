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
    output: "Architecture boundaries and risks",
  });
  panel.upsertAgent(p, {
    role: "builder",
    status: "running",
    output: "Implementation steps and tests",
  });

  const lines = panel.renderFusionPaneLines(p, 100);
  assert.match(lines.join("\n"), /Architect.*Builder/);
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
  panel.upsertAgent(p, { role: "architect", status: "ok", output: "ARCH OUTPUT" });
  panel.upsertAgent(p, { role: "builder", status: "ok", output: "BUILD OUTPUT" });
  let lines = panel.renderFusionPaneLines(p, 50);
  assert.ok(lines.findIndex((line) => line.includes("ARCH OUTPUT")) < lines.findIndex((line) => line.includes("BUILD OUTPUT")));

  panel.setPhase(p, "SYNTHESIZING");
  panel.upsertAgent(p, {
    role: "synthesizer",
    status: "running",
    output: "Combined recommendation",
  });
  lines = panel.renderFusionPaneLines(p, 100);
  assert.match(lines.join("\n"), /Synthesizer/);
  assert.match(lines.join("\n"), /Combined recommendation/);
  assert.doesNotMatch(lines[1], /Architect.*Builder/);

  lines = panel.renderFusionPaneLines(p, 12);
  assert.ok(lines.every((line) => panel.visibleWidth(line) <= 12));
});
