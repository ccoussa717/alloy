import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import * as ui from "../../extensions/ui.ts";

const {
  buildWordmark,
  buildSplashHintLine,
  panelRow,
  panelWidth,
  splashHorizontalLayout,
  splashTopPadding,
} = ui;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function greenTheme(calls = []) {
  return {
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    fg: (color, text) => {
      calls.push(color);
      return `\x1b[32m${text}\x1b[39m`;
    },
  };
}

test("wide splash renders one letter-spaced ASCII wordmark", () => {
  const colors = [];
  const lines = buildWordmark(greenTheme(colors), 80);
  const title = "A L L O Y   H A R N E S S";

  assert.equal(lines.length, 1);
  assert.deepEqual(colors, ["accent"]);
  assert.equal(
    stripAnsi(lines[0]),
    " ".repeat(Math.floor((80 - title.length) / 2)) + title,
  );
  assert.ok(lines[0].includes("\x1b[1m"));
});

test("narrow splash removes letter spacing before truncating the name", () => {
  assert.equal(stripAnsi(buildWordmark(greenTheme(), 20)[0]).trim(), "ALLOY HARNESS");
  assert.equal(stripAnsi(buildWordmark(greenTheme(), 8)[0]).trim(), "ALLOY");
});

test("splash rows never exceed their component width", () => {
  for (let width = 1; width <= 120; width += 1) {
    const lines = buildWordmark(greenTheme(), width);
    const panel = splashHorizontalLayout(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(panel.boxWidth <= width);
    assert.ok(panelWidth(width, false) <= width);
    assert.ok(visibleWidth(panelRow(greenTheme(), "input", panel.boxWidth)) <= width);
    assert.ok(visibleWidth(buildSplashHintLine(greenTheme(), width)) <= width);
    assert.equal(panel.width, width);
  }
});

test("editor body keeps a three-row writing area", () => {
  assert.equal(typeof ui.ensureMinimumInputRows, "function");
  assert.deepEqual(ui.ensureMinimumInputRows(["cursor"]), ["cursor", "", ""]);
  assert.deepEqual(ui.ensureMinimumInputRows(["one", "two", "three", "four"]), [
    "one",
    "two",
    "three",
    "four",
  ]);
});

test("footer adds one blank row below its hints", () => {
  assert.equal(typeof ui.withBottomPadding, "function");
  assert.deepEqual(ui.withBottomPadding(["footer"]), ["footer", ""]);
  assert.deepEqual(ui.withBottomPadding(["footer"], 5), ["footer"]);
});

test("short terminals collapse the editor before hiding its cursor", () => {
  assert.equal(typeof ui.inputRowsForTerminal, "function");
  assert.equal(ui.inputRowsForTerminal(5), 1);
  assert.equal(ui.inputRowsForTerminal(7), 1);
  assert.equal(ui.inputRowsForTerminal(8), 1);
  assert.equal(ui.inputRowsForTerminal(9), 3);
  assert.equal(ui.inputRowsForTerminal(24), 3);
  assert.equal(typeof ui.showEditorStatus, "function");
  assert.equal(ui.showEditorStatus(8), false);
  assert.equal(ui.showEditorStatus(9), true);
});

test("Pi autocomplete rows stay outside the editor body", () => {
  assert.equal(typeof ui.splitEditorRender, "function");
  assert.deepEqual(
    ui.splitEditorRender([
      "────────",
      "cursor  ",
      "────────",
      "first   ",
      "second  ",
    ]),
    { body: ["cursor  "], autocomplete: ["first   ", "second  "] },
  );
  assert.deepEqual(
    ui.splitEditorRender([
      "──────────",
      "cursor    ",
      "─── ↓ 5...",
      "first     ",
    ]),
    { body: ["cursor    "], autocomplete: ["first     "] },
  );
});

test("compact editor preserves the cursor before autocomplete rows", () => {
  assert.equal(typeof ui.fitCompactAutocomplete, "function");
  const suggestions = ["  first", "→ second"];
  assert.deepEqual(ui.fitCompactAutocomplete(suggestions, 4, true), suggestions);
  assert.deepEqual(ui.fitCompactAutocomplete(suggestions, 4, false), ["→ second"]);
  assert.deepEqual(ui.fitCompactAutocomplete(suggestions, 5, false), suggestions);
});

test("vertical centering includes the taller editor and bottom padding", () => {
  assert.equal(splashTopPadding(24, 1), 7);
  assert.equal(splashTopPadding(4, 1), 0);
});
