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
  assert.ok(lines.some((l) => l.includes("builder") && l.includes("◐")));
});

test("themed render falls back without theme", () => {
  const p = panel.createPanelState({ title: "X" });
  panel.upsertAgent(p, { role: "reviewer", status: "fail", detail: "FAIL" });
  const lines = panel.renderPanelThemed(p, null);
  assert.ok(lines.some((l) => l.startsWith("✗")));
});
