import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWordmark,
  splashTopPadding,
} from "../../extensions/ui.ts";

const LARGE_WORDMARK = [
  "█▀█ █   █   █▀█ █ █   █ █ █▀█ █▀▄ █▄ █ █▀▀ █▀▀ █▀▀",
  "█▀█ █   █   █ █  █    █▀█ █▀█ █▀▄ █ ▀█ █▀  ▀▀█ ▀▀█",
  "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀  ▀    ▀ ▀ ▀ ▀ ▀ ▀ ▀  ▀ ▀▀▀ ▀▀▀ ▀▀▀",
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

test("wide splash renders a three-row green wordmark", () => {
  const colors = [];
  const lines = buildWordmark(greenTheme(colors), 80);

  assert.equal(lines.length, 3);
  assert.deepEqual(colors, ["accent", "accent", "accent"]);
  assert.ok(lines.every((line) => line.includes("\x1b[32m")));
  assert.deepEqual(
    lines.map(stripAnsi),
    LARGE_WORDMARK.map((line) => " ".repeat(15) + line),
  );
});

test("wordmark changes to the fullwidth fallback below 50 columns", () => {
  const colors = [];
  const wide = buildWordmark(greenTheme(colors), 50);
  const narrow = buildWordmark(greenTheme(colors), 49);

  assert.equal(wide.length, 3);
  assert.equal(narrow.length, 1);
  assert.match(stripAnsi(narrow[0]), /ａｌｌｏｙ　ｈａｒｎｅｓｓ/);
  assert.ok(narrow[0].includes("\x1b[32m"));
});

test("very narrow splash retains the ASCII fallback", () => {
  const lines = buildWordmark(greenTheme([]), 13);

  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]), "alloy harness");
});

test("vertical centering accounts for the rendered wordmark rows", () => {
  assert.equal(splashTopPadding(24, 3), 8);
  assert.equal(splashTopPadding(24, 1), 9);
  assert.equal(splashTopPadding(4, 3), 0);
});
