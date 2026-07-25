import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildWordmark,
  buildSplashHintLine,
  panelRow,
  panelWidth,
  splashHorizontalLayout,
  splashTopPadding,
} from "../../extensions/ui.ts";

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

test("vertical centering includes Pi's quiet-startup spacer", () => {
  assert.equal(splashTopPadding(24, 1), 9);
  assert.equal(splashTopPadding(4, 1), 0);
});
