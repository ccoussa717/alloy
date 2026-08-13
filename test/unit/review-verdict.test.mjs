import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const auto = await import(
  pathToFileURL(join(new URL("../..", import.meta.url).pathname, "lib", "auto-workflow.mjs")).href
);

test("parseReviewVerdict prefers VERDICT line", () => {
  assert.equal(auto.parseReviewVerdict("stuff\nVERDICT: FAIL\n"), "FAIL");
  assert.equal(auto.parseReviewVerdict("ok overall\nVERDICT: PASS"), "PASS");
});

test("parseReviewVerdict last-line PASS/FAIL", () => {
  assert.equal(auto.parseReviewVerdict("looks good\nPASS"), "UNKNOWN");
  assert.equal(auto.parseReviewVerdict("broken tests\nFAIL"), "UNKNOWN");
});

test("parseReviewVerdict unknown", () => {
  assert.equal(auto.parseReviewVerdict("no clear call"), "UNKNOWN");
  assert.equal(auto.parseReviewVerdict("this would PASS with tests"), "UNKNOWN");
});

test("parseReviewVerdict uses the last VERDICT line", () => {
  assert.equal(auto.parseReviewVerdict("VERDICT: FAIL\nmore notes\nVERDICT: PASS"), "PASS");
});
