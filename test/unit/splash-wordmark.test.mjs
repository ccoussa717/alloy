import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildWordmark,
  splashTopPadding,
} from "../../extensions/ui.ts";

const LARGE_WORDMARK = [
  "  ⣶⣶  ⢰⡆   ⣶   ⢠⡶⠶⠶⣶ ⢶⡄ ⣰⡆  ⢰⡆  ⣶  ⢰⣶⣆  ⣶⠶⠶⣶ ⢰⣶⡀ ⣶ ⢰⡶⠶⠶⠆⢰⡶⠶⠶ ⣰⡶⠶⠶",
  " ⢸⡏⢸⡇ ⢸⡇   ⣿   ⢸⡇  ⣿⡇⠈⣿⣴⡟   ⢸⣧⣤⣤⣿  ⣿⠁⣿⡀ ⣿  ⣿ ⢸⡟⣷⡀⣿ ⢸⣧⣤⣤⡀⢸⣧⣀⣀ ⢻⣧⣀⡀",
  " ⣿⣧⣼⣿⡀⢸⡇   ⣿   ⢸⡇  ⣿⡇ ⢘⣿    ⢸⡏⠉⠉⣿ ⢸⣿⣤⣼⣇ ⣿⠛⢿⡏ ⢸⡇⠘⣷⣿ ⢸⡏⠉⠉⠁ ⠉⠉⣿⡆ ⠉⠉⣿⡆",
  "⠸⠏  ⠹⠇⠸⠷⠶⠶ ⠿⠶⠶⠶⠘⠷⠶⠶⠿  ⠨⠿    ⠸⠇  ⠿ ⠿⠁ ⠈⠿ ⠿ ⠈⠿⠄⠸⠇ ⠘⠿ ⠸⠷⠶⠶⠆⠰⠶⠶⠿⠃⠲⠶⠶⠿⠁",
];

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function greenTheme(calls) {
  return {
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    fg: (color, text) => {
      calls.push(color);
      return `\x1b[32m${text}\x1b[39m`;
    },
  };
}

test("wide splash renders the four-row Oxanium wordmark", () => {
  const colors = [];
  const lines = buildWordmark(greenTheme(colors), 80);

  assert.equal(lines.length, 4);
  assert.deepEqual(colors, ["accent", "accent", "accent", "accent"]);
  assert.ok(lines.every((line) => line.includes("\x1b[32m")));
  assert.ok(lines.every((line) => line.includes("\x1b[1m")));
  assert.deepEqual(
    lines.map(stripAnsi),
    LARGE_WORDMARK.map(
      (line) =>
        " ".repeat(Math.floor((80 - visibleWidth(line)) / 2)) + line,
    ),
  );
});

test("wordmark changes to the fullwidth fallback below 66 columns", () => {
  const colors = [];
  const wide = buildWordmark(greenTheme(colors), 66);
  const narrow = buildWordmark(greenTheme(colors), 65);

  assert.equal(wide.length, 4);
  assert.equal(narrow.length, 1);
  assert.match(stripAnsi(narrow[0]), /ａｌｌｏｙ　ｈａｒｎｅｓｓ/);
  assert.ok(narrow[0].includes("\x1b[32m"));
});

test("very narrow splash retains the ASCII fallback", () => {
  const lines = buildWordmark(greenTheme([]), 13);

  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]), "alloy harness");
});

test("splash wordmark never exceeds the terminal width", () => {
  for (let width = 1; width <= 80; width += 1) {
    const lines = buildWordmark(greenTheme([]), width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `wordmark overflowed at ${width} columns`,
    );
  }

  const lines = buildWordmark(greenTheme([]), 8);
  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]).trim(), "alloy");
});

test("vertical centering accounts for the rendered wordmark rows", () => {
  assert.equal(splashTopPadding(24, 4), 7);
  assert.equal(splashTopPadding(24, 1), 9);
  assert.equal(splashTopPadding(4, 3), 0);
});
