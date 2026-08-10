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
    "workflows",
    "auth",
    "sandbox",
    "auto",
    "fusion",
    "fission",
    "forge",
    "commands",
    "mcp",
    "memory",
  ]) {
    assert.ok(ids.includes(need), `missing topic ${need}`);
  }
});

test("workflows help maps fusion fission auto forge and setups", () => {
  const topic = help.getTopic("workflows");
  assert.match(topic.body, /\/fusion setup/);
  assert.match(topic.body, /\/fission setup/);
  assert.match(topic.body, /\/auto setup/);
  assert.match(topic.body, /roles\.\*\.model|roles\.scout|\/auto setup/i);
  assert.match(topic.body, /\/forge/);
  assert.match(topic.body, /\/auto/);
  assert.match(topic.body, /main chat \/model/i);
});

test("auto help documents setup, implement profile, and roles config", () => {
  const topic = help.getTopic("auto");
  assert.match(topic.body, /\/auto setup/);
  assert.match(topic.body, /implementPermissionProfile|Implement profile|sandbox/i);
  assert.match(topic.body, /roles/);
  assert.match(topic.body, /scout/);
  assert.match(topic.body, /builder/);
});

test("forge help lists setup checklist", () => {
  const topic = help.getTopic("forge");
  assert.match(topic.body, /\/fusion setup/);
  assert.match(topic.body, /\/fission setup/);
  assert.match(topic.body, /\/auto setup/);
  assert.match(topic.body, /fusion.*fission.*auto/is);
});

test("getTopic by id", () => {
  const t = help.getTopic("sandbox");
  assert.ok(t);
  assert.match(t.body, /Docker|network none|node:22-bookworm/i);
});

test("MCP help states startup and read-only boundaries", () => {
  assert.match(help.getTopic("mcp").body, /mcp\.enabled must be true/i);
  assert.match(help.getTopic("mcp").body, /enabled global servers only/i);
  assert.match(help.getTopic("modes").body, /no write\/edit\/bash\/MCP/i);
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

test("fission help documents its complete fail-closed review contract", () => {
  const topic = help.getTopic("fission");
  assert.match(topic.body, /trusted repositor/i);
  assert.match(topic.body, /Git config.*attributes.*execute/is);
  assert.match(topic.body, /hostile repositor.*unsupported/is);
  assert.match(topic.body, /defaultReviewers.*maxReviewers/is);
  assert.match(topic.body, /project.*lower.*global/is);
  assert.match(topic.body, /read-only tools/i);
  assert.match(topic.body, /maximum.*5|cap.*5/i);
  assert.match(topic.body, /COMPLETE.*INCOMPLETE.*ABORTED.*REFUSED.*NO_CHANGES/is);
  assert.match(topic.body, /PASS.*submitted blocking finding/is);
  assert.match(topic.body, /no.*fallback/i);
  assert.match(topic.body, /does not.*tests.*fixes.*merge.*deploy/is);
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
  assert.ok(all.some((item) => item.value === "fission"));
  assert.deepEqual(
    help.getHelpArgumentCompletions("fus").map((item) => item.value),
    ["fusion"],
  );
  assert.equal(help.getHelpArgumentCompletions("search docker"), null);
});
