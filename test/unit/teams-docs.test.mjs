import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageReadme = join(root, "packages/pi-teams/README.md");
const rootReadme = join(root, "README.md");
const helpCatalog = join(root, "lib/help-catalog.mjs");

function source(path) {
  return readFileSync(path, "utf8");
}

function requiresPhrases(text, phrases, label) {
  for (const phrase of phrases) {
    assert.match(text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `${label}: ${phrase}`);
  }
}

test("portable package documentation states compatibility, operation, authority, and failure boundaries", () => {
  const text = source(packageReadme);

  requiresPhrases(text, [
    "builtin/investigate",
    "0.82.1",
    "0.84.2",
    "ModelRuntime",
    "getAgentDir",
    "approval_required",
    "incomplete",
    "project trust",
    "maxTimeoutMs",
    "min(requested timeoutMs, maxTimeoutMs)",
    "5,000 ms",
    "abort before containment",
    "events.jsonl",
    "artifacts",
    "/team list",
    "/team inspect",
    "/team run",
    "/team status",
    "/team view",
    "/team approve",
    "/team cancel",
    "team tool",
    "human approval",
  ], "package README");

  for (const exclusion of [
    "repository mutation",
    "resume",
    "candidate create/apply",
    "push",
    "publish",
    "deploy",
    "custom graphical TUI",
    "Auto/Fusion/Fission/Forge refactor",
  ]) {
    assert.match(text, new RegExp(`(?:no|does not|not)\\s+[^\\n]{0,80}${exclusion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), `explicit exclusion: ${exclusion}`);
  }
});

test("portable documentation separates stock Pi setup and accurately warns about cross-package duplicates", () => {
  const text = source(packageReadme);
  const prose = text.replace(/\s+/g, " ");
  requiresPhrases(prose, [
    "## Stock Pi setup",
    "## Alloy setup",
    "Alloy root already registers Teams",
    "must not add the standalone package again",
    "Pi may retain both extension instances",
    "duplicate command/tool resolution is host-dependent",
    "module-local same-API registration guard",
    "does not protect against cross-package extension instances",
  ], "package README setup");
  assert.doesNotMatch(text, /duplicate standalone registration[^.]*fails closed/i);
});

test("root README links the portable Teams Slice 1 documentation and states both targets", () => {
  const text = source(rootReadme);
  requiresPhrases(text, [
    "Portable Teams Slice 1",
    "packages/pi-teams/README.md",
    "builtin/investigate",
    "stock Pi 0.84.2",
    "Alloy 0.82.1",
  ], "root README");
});

test("plain Alloy help distinguishes the human command from the model tool", () => {
  const text = source(helpCatalog);
  requiresPhrases(text, [
    "id: \"teams\"",
    "/team list",
    "/team run",
    "team tool",
    "approval_required",
    "human",
    "builtin/investigate",
  ], "help catalog");
});
