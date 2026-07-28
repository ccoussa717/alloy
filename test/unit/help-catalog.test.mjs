import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const help = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "help-catalog.mjs")).href
);
const piSlashCommands = await import(
  pathToFileURL(
    join(
      new URL("../..", import.meta.url).pathname,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "slash-commands.js",
    ),
  ).href
);

test("catalog has core topics", () => {
  const ids = help.listTopics().map((t) => t.id);
  for (const need of [
    "overview",
    "auth",
    "sandbox",
    "auto",
    "fusion",
    "commands",
    "mcp",
    "memory",
  ]) {
    assert.ok(ids.includes(need), `missing topic ${need}`);
  }
});

test("getTopic by id", () => {
  const t = help.getTopic("sandbox");
  assert.ok(t);
  assert.match(t.body, /Docker|network none|node:22-bookworm/i);
});

test("diagnostics help discloses host execution and sandbox limits", () => {
  const topic = help.getTopic("diagnostics");
  assert.match(topic.body, /repository-defined host commands/i);
  assert.match(topic.body, /same-user filesystem and network\s+access/i);
  assert.match(topic.body, /auto fails closed/i);
});

test("searchHelp ranks relevant topics", () => {
  const hits = help.searchHelp("docker sandbox network");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "sandbox");
});

test("searchHelp memory", () => {
  const hits = help.searchHelp("remember facts");
  assert.ok(hits.some((h) => h.id === "memory"));
});

test("formatTopic", () => {
  const text = help.formatTopic(help.getTopic("commands"));
  assert.match(text, /\/help commands/);
  assert.match(text, /active command registry/);
});

test("fusion help documents the plan-only three-role workflow", () => {
  const topic = help.getTopic("fusion");
  assert.match(topic.body, /\/fusion <objective>/);
  assert.match(topic.body, /Architect.*Builder.*Synthesizer/s);
  assert.match(topic.body, /architectModel/);
  assert.match(topic.body, /builderModel/);
  assert.match(topic.body, /synthesizerModel/);
  assert.doesNotMatch(topic.body, /\[plan\|build\]|workers|mergerModel/i);
});

test("help assigns Shift+Tab to Build and Plan, not approval levels", () => {
  const modes = help.getTopic("modes");
  const permissions = help.getTopic("permissions");
  const effort = help.getTopic("effort");

  assert.match(modes.body, /Shift\+Tab.*Build.*Plan/is);
  assert.doesNotMatch(permissions.title, /Shift\+Tab/i);
  assert.doesNotMatch(permissions.body, /Shift\+Tab.*permission/is);
  assert.match(permissions.body, /\/permissions cycle/);
  assert.match(effort.body, /Shift\+Tab.*Build.*Plan/is);
});

test("native command catalog stays complete for the pinned Pi runtime", () => {
  assert.deepEqual(
    help.PI_NATIVE_COMMANDS,
    piSlashCommands.BUILTIN_SLASH_COMMANDS,
  );
});

test("formatCommandCatalog merges native and live commands without duplicates", () => {
  const text = help.formatCommandCatalog([
    {
      name: "fusion",
      description: "Run Fusion",
      source: "extension",
    },
    {
      name: "skill:testing",
      description: "Test a change",
      source: "skill",
    },
    {
      name: "model",
      description: "Extension collision",
      source: "extension",
    },
  ]);

  assert.match(text, /Pi native/);
  assert.match(text, /\/model <provider\/model> .*Select model/);
  assert.match(text, /Extensions/);
  assert.match(text, /\/fusion .*Run Fusion/);
  assert.match(text, /Skills/);
  assert.equal(text.match(/^\/model\b/gm)?.length, 1);
});

test("OpenTUI command catalog omits Pi commands its frontend cannot execute", () => {
  const text = help.formatCommandCatalog([], { frontend: "opentui" });

  assert.match(text, /OpenTUI built-ins/);
  assert.match(text, /\/model <provider\/model>/);
  assert.match(text, /\/sidebar - Toggle workspace sidebar/);
  assert.match(text, /\/clone - Clone the current session/);
  assert.match(text, /\/help - Browse and search Alloy help/);
  assert.match(text, /\/quit - Exit Alloy/);
  assert.match(text, /\/export - Export the current session to HTML/);
  assert.doesNotMatch(text, /\/export .*specify path/);
  assert.doesNotMatch(text, /Quit pi/);
  assert.doesNotMatch(text, /Pi native/);
  assert.doesNotMatch(text, /\/resume/);
  assert.doesNotMatch(text, /\/trust\b/);
  assert.doesNotMatch(text, /\/settings\b/);
  assert.doesNotMatch(text, /\/share\b/);
});

test("help argument completions expose search and every topic", () => {
  const all = help.getHelpArgumentCompletions("");
  assert.ok(all.some((item) => item.value === "search "));
  assert.ok(all.some((item) => item.value === "commands"));
  assert.ok(all.some((item) => item.value === "fusion"));
  assert.deepEqual(
    help.getHelpArgumentCompletions("fus").map((item) => item.value),
    ["fusion"],
  );
  assert.equal(help.getHelpArgumentCompletions("search docker"), null);
});
