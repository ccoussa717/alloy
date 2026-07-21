/**
 * MVP providers: Anthropic (Claude sub), OpenAI Codex (ChatGPT sub), xAI Grok (sub).
 * Never print credential values — only status.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir } from "./paths.mjs";
import {
  formatVersionBlock,
  getNodeVersionInfo,
  nodeMeetsMinimum,
  NODE_MIN,
  getAlloyVersion,
  getPiVersion,
} from "./version.mjs";
import { validateDefaultModels, CATALOG_DEFAULTS } from "./model-catalog.mjs";

/** @typedef {'missing'|'api_key'|'oauth'|'subscription'|'env'|'unknown'|'expired'} ProviderStatusKind */

export const MVP_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    loginHint: "/login  →  select Anthropic  →  subscription (Claude Pro/Max)",
    envKeys: ["ANTHROPIC_API_KEY"],
    authKeys: ["anthropic"],
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex (ChatGPT)",
    loginHint: "/login  →  select OpenAI / ChatGPT  →  Codex subscription",
    envKeys: ["OPENAI_API_KEY"],
    authKeys: ["openai-codex", "openai", "chatgpt", "codex"],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    loginHint: "/login xai  →  Use a subscription",
    envKeys: ["XAI_API_KEY"],
    authKeys: ["xai"],
  },
];

/** Honest economics note (from Pi providers docs). */
export const CLAUDE_ECONOMICS_NOTE = [
  "Claude Pro/Max via third-party harnesses (including Alloy/Pi):",
  "  Usage draws from Claude *extra usage* (per-token), NOT the included",
  "  plan message limits. See https://claude.ai/settings/usage",
  "  Source: Pi docs providers.md (Claude Pro/Max).",
].join("\n");

function authFilePath() {
  return join(getPiAgentDir(), "auth.json");
}

function loadAuth() {
  const path = authFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function classifyCredential(cred) {
  if (!cred || typeof cred !== "object") return null;
  const type = String(cred.type || cred.kind || "").toLowerCase();
  if (type.includes("oauth") || type.includes("subscription") || type === "token") {
    return "subscription";
  }
  if (type.includes("api") || type === "api_key" || cred.key) {
    return "api_key";
  }
  return "unknown";
}

/**
 * Non-destructive expiry probe — never returns secret material.
 * @param {object} cred
 * @returns {{ expired: boolean|null, detail: string }}
 */
export function probeCredentialFreshness(cred) {
  if (!cred || typeof cred !== "object") {
    return { expired: null, detail: "no credential object" };
  }
  const raw =
    cred.expires_at ||
    cred.expiresAt ||
    cred.expiry ||
    cred.expires ||
    cred.expire ||
    cred.accessTokenExpiresAt ||
    null;
  if (raw == null) {
    // Shape checks only — presence of token-like fields without values echoed
    const hasToken = Boolean(
      cred.access ||
        cred.accessToken ||
        cred.refresh ||
        cred.refreshToken ||
        cred.token ||
        cred.key,
    );
    return {
      expired: null,
      detail: hasToken
        ? "credential present (no expiry field to validate)"
        : "credential object has no recognizable token/expiry fields",
    };
  }
  let ms;
  if (typeof raw === "number") {
    ms = raw < 1e12 ? raw * 1000 : raw;
  } else {
    ms = Date.parse(String(raw));
  }
  if (!Number.isFinite(ms)) {
    return { expired: null, detail: "expiry field present but unparsable" };
  }
  const expired = ms < Date.now();
  const hours = Math.round((ms - Date.now()) / 3600000);
  return {
    expired,
    detail: expired
      ? `credential appears EXPIRED (${new Date(ms).toISOString()})`
      : `credential not expired (≈${hours}h remaining)`,
  };
}

/**
 * @returns {Array<{id:string,label:string,status:ProviderStatusKind,detail:string,loginHint:string,ok:boolean,freshness?:object}>}
 */
export function diagnoseProviders() {
  const auth = loadAuth();
  const results = [];

  for (const p of MVP_PROVIDERS) {
    let status = "missing";
    let detail = "not configured";
    let freshness = null;
    let cred = null;

    const envHit = p.envKeys.find(
      (k) => process.env[k] && String(process.env[k]).length > 0,
    );
    if (envHit) {
      status = "env";
      detail = `${envHit} set in environment (API key path)`;
    }

    for (const key of p.authKeys) {
      if (auth[key]) {
        cred = auth[key];
        const kind = classifyCredential(auth[key]);
        freshness = probeCredentialFreshness(auth[key]);
        if (freshness.expired === true) {
          status = "expired";
          detail = `auth.json has ${key} but ${freshness.detail}`;
        } else if (kind === "subscription" || kind === "oauth") {
          status = "subscription";
          detail = `auth.json has ${key} (subscription/oauth); ${freshness.detail}`;
        } else if (status === "missing" || status === "unknown") {
          status = kind || "unknown";
          detail = `auth.json has ${key} (${status}); ${freshness.detail}`;
        } else if (status === "env") {
          detail += `; also auth.json:${key} (${freshness.detail})`;
        }
        break;
      }
    }

    results.push({
      id: p.id,
      label: p.label,
      status,
      detail,
      loginHint: p.loginHint,
      ok: status !== "missing" && status !== "expired",
      freshness,
      // never attach cred
    });
  }

  return results;
}

export function formatDoctorReport(results) {
  const lines = [
    "Alloy doctor — MVP providers",
    "============================",
    "Target: Claude sub · Codex/ChatGPT sub · Grok sub",
    "",
  ];
  for (const r of results) {
    const mark = r.ok ? "OK " : "NO ";
    lines.push(`[${mark}] ${r.label}`);
    lines.push(`       status: ${r.status}`);
    lines.push(`       ${r.detail}`);
    if (!r.ok) lines.push(`       fix: ${r.loginHint}`);
    lines.push("");
  }
  lines.push(`auth file: ${authFilePath()}`);
  lines.push("Secrets are never printed.");
  return lines.join("\n");
}

/**
 * Full doctor report: versions, node, providers, economics, model catalog, docker optional.
 */
export function formatFullDoctorReport({
  results = diagnoseProviders(),
  dockerText = null,
  includeEconomics = true,
  includeModels = true,
} = {}) {
  const lines = [];
  lines.push("Alloy doctor");
  lines.push("============");
  lines.push(formatVersionBlock());
  const node = getNodeVersionInfo();
  lines.push(
    `Node gate: ${nodeMeetsMinimum(node) ? "pass" : "FAIL"} (require >=${NODE_MIN.major}.${NODE_MIN.minor}.${NODE_MIN.patch})`,
  );
  lines.push("");
  lines.push(formatDoctorReport(results));
  lines.push("");

  if (includeEconomics) {
    lines.push("Subscription economics (honest)");
    lines.push("--------------------------------");
    lines.push(CLAUDE_ECONOMICS_NOTE);
    lines.push("");
    lines.push("Codex: requires ChatGPT Plus/Pro (subscription path via /login).");
    lines.push("Grok: /login xai → subscription, or XAI_API_KEY for API path.");
    lines.push("");
  }

  if (includeModels) {
    lines.push("Default model catalog check");
    lines.push("---------------------------");
    const checks = validateDefaultModels(CATALOG_DEFAULTS);
    for (const c of checks) {
      lines.push(
        `  ${c.ok ? "✓" : "✗"} ${c.ref}  (${c.reason}${c.catalogSize != null ? `, catalog n=${c.catalogSize}` : ""})`,
      );
    }
    const bad = checks.filter((c) => !c.ok);
    if (bad.length) {
      lines.push(
        `  ${bad.length} default(s) missing from pinned Pi catalogs — update config favorites/profiles.`,
      );
    } else {
      lines.push("  All shipped defaults resolve in the pinned catalogs.");
    }
    lines.push("");
  }

  if (dockerText) {
    lines.push(dockerText);
    lines.push("");
  }

  lines.push("Live model call: not executed (non-destructive doctor).");
  lines.push("After /login, use /model to confirm selectable models.");
  lines.push(`Alloy ${getAlloyVersion()} · Pi ${getPiVersion() || "?"}`);
  return lines.join("\n");
}
