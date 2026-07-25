import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAlloyVersion,
  getPiVersion,
  nodeMeetsMinimum,
  NODE_MIN,
  formatVersionBlock,
} from "../../lib/version.mjs";
import {
  CATALOG_DEFAULTS,
  resolveModelInCatalog,
  validateDefaultModels,
  loadProviderCatalogIds,
} from "../../lib/model-catalog.mjs";
import {
  formatFullDoctorReport,
  CLAUDE_ECONOMICS_NOTE,
  probeCredentialFreshness,
} from "../../lib/providers.mjs";

describe("version and model catalog", () => {
  it("reports alloy version from package.json", () => {
    const v = getAlloyVersion();
    assert.match(v, /^\d+\.\d+\.\d+/);
  });

  it("finds pi version when installed", () => {
    const pi = getPiVersion();
    // In alloy repo with node_modules this should resolve
    if (pi) assert.match(pi, /^\d+\.\d+/);
  });

  it("nodeMeetsMinimum enforces 22.19", () => {
    assert.equal(nodeMeetsMinimum({ major: 22, minor: 19, patch: 0 }), true);
    assert.equal(nodeMeetsMinimum({ major: 22, minor: 18, patch: 0 }), false);
    assert.equal(nodeMeetsMinimum({ major: 20, minor: 0, patch: 0 }), false);
    assert.equal(nodeMeetsMinimum({ major: 23, minor: 0, patch: 0 }), true);
    assert.equal(NODE_MIN.major, 22);
    assert.equal(NODE_MIN.minor, 19);
  });

  it("formatVersionBlock includes Alloy and Node", () => {
    const b = formatVersionBlock();
    assert.match(b, /Alloy /);
    assert.match(b, /Node /);
  });

  it("default models resolve in pinned Pi catalogs", () => {
    const catalog = loadProviderCatalogIds();
    // If catalogs are present, defaults must resolve
    const hasAny = Object.values(catalog).some((a) => a.length > 0);
    if (!hasAny) {
      // skip soft when catalogs missing in weird installs
      return;
    }
    const results = validateDefaultModels(CATALOG_DEFAULTS);
    const bad = results.filter((r) => !r.ok);
    assert.equal(
      bad.length,
      0,
      `unresolved defaults: ${bad.map((b) => b.ref + ":" + b.reason).join(", ")}`,
    );
    // sanity: known good id
    assert.equal(resolveModelInCatalog("xai/grok-4.5", catalog).ok, true);
  });

  it("doctor reports current Claude subscription economics without leaking secrets", () => {
    const report = formatFullDoctorReport({
      results: [
        {
          id: "anthropic",
          label: "Anthropic (Claude)",
          status: "missing",
          detail: "not configured",
          loginHint: "/login",
          ok: false,
        },
      ],
      dockerText: null,
    });
    assert.match(report, /subscription usage limits/i);
    assert.match(report, /June 15, 2026/i);
    assert.match(report, /usage credits/i);
    assert.match(report, /12429409/);
    assert.doesNotMatch(report, /NOT the included/i);
    assert.ok(CLAUDE_ECONOMICS_NOTE.includes("subscription usage limits"));
    assert.ok(!report.includes("sk-"));
    assert.ok(!report.includes("accessToken"));
    assert.match(report, /Default model catalog check/);
  });

  it("probeCredentialFreshness detects expiry without echoing secrets", () => {
    const past = probeCredentialFreshness({
      type: "oauth",
      accessToken: "super-secret",
      expires_at: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(past.expired, true);
    assert.ok(!JSON.stringify(past).includes("super-secret"));

    const future = probeCredentialFreshness({
      type: "oauth",
      accessToken: "super-secret",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(future.expired, false);
  });
});
