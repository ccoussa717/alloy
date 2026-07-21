/**
 * MVP providers: Anthropic (Claude sub), OpenAI Codex (ChatGPT sub), xAI Grok (sub).
 * Never print credential values — only status.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir } from "./paths.mjs";

/** @typedef {'missing'|'api_key'|'oauth'|'subscription'|'env'|'unknown'} ProviderStatusKind */

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
 * @returns {Array<{id:string,label:string,status:ProviderStatusKind,detail:string,loginHint:string,ok:boolean}>}
 */
export function diagnoseProviders() {
  const auth = loadAuth();
  const results = [];

  for (const p of MVP_PROVIDERS) {
    let status = "missing";
    let detail = "not configured";

    const envHit = p.envKeys.find((k) => process.env[k] && String(process.env[k]).length > 0);
    if (envHit) {
      status = "env";
      detail = `${envHit} set in environment (API key path)`;
    }

    for (const key of p.authKeys) {
      if (auth[key]) {
        const kind = classifyCredential(auth[key]);
        if (kind === "subscription" || kind === "oauth") {
          status = "subscription";
          detail = `auth.json has ${key} (subscription/oauth)`;
        } else if (status === "missing" || status === "unknown") {
          status = kind || "unknown";
          detail = `auth.json has ${key} (${status})`;
        } else if (status === "env") {
          detail += `; also auth.json:${key}`;
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
      ok: status !== "missing",
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
