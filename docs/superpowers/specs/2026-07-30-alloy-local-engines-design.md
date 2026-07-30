# Alloy local engines design (Ollama, llama.cpp, LM Studio)

**Date:** 2026-07-30
**Status:** implemented with landing-review amendments
**Repo:** [ccoussa717/alloy](https://github.com/ccoussa717/alloy)
**Inspiration:** [Oh My Pi](https://github.com/can1357/oh-my-pi) implicit local discovery (not a dependency)

## Summary

Add **zero-config auto-discovery** for three local model engines so Alloy lists their models in `/model` without hand-written `models.json` and without OAuth:

| Provider ID | Default base URL |
|-------------|------------------|
| `ollama` | `http://127.0.0.1:11434` |
| `llama.cpp-local` | `http://127.0.0.1:8080` |
| `lm-studio` | `http://127.0.0.1:1234/v1` |

Alloy remains on the existing Pi stack (`@earendil-works/pi-*`). Discovery is an Alloy extension that probes engines and registers providers via `pi.registerProvider`. Hosted MVP auth (Anthropic, Codex, xAI) is unchanged.

## Background

### Oh My Pi (reference behavior)

OMP treats local engines as **first-class, keyless, auto-discovered**:

- Catalog sources: bundled models → `models.yml` → **runtime discovery** → extension-registered providers.
- Implicit providers when not configured and not disabled: `ollama`, `llama.cpp`, `lm-studio`.
- Ollama: `GET /api/tags` + `POST /api/show` for capabilities and context; base for inference becomes `{endpoint}/v1`.
- Keyless: models are selectable without login when the engine answers.
- Env: `OLLAMA_BASE_URL` / `OLLAMA_HOST`, `LLAMA_CPP_BASE_URL`, `LM_STUDIO_BASE_URL`; optional keys only when required.

### Pi (what Alloy runs today)

- Custom locals work via `~/.pi/agent/models.json` (static model lists; often need a dummy `apiKey`).
- Built-in **llama.cpp** extension: `/login llama.cpp`, `/llama` (load/unload/download), env `LLAMA_BASE_URL` / `LLAMA_API_KEY`.
- Extensions may `pi.registerProvider(...)` with static or dynamically fetched models; `models.json` composes above registered providers.
- Many hosted open providers already exist in `pi-ai`; Alloy’s product surface is intentionally MVP-narrow.

### Alloy today

- Product MVP: Anthropic, OpenAI Codex, xAI only (`lib/providers.mjs`, `/doctor`, `/providers`).
- Default `providers.allow`: `anthropic`, `openai`, `openai-codex`, `xai`.
- No Ollama/LM Studio probe; llama.cpp not promoted in doctor/allowlist.
- Orchestration respects `providers.allow`.

**Gap:** capability exists in Pi; Alloy does not deliver OMP-style “Ollama is running → models appear.”

## Goals

1. Zero-config local pickup when an engine is running on default or env-overridden URL.
2. OMP-like flow: probe → discover → enrich metadata → selectable without OAuth.
3. Honest `/doctor` and `/providers` for local engines (reachable, count, base URL; never secrets).
4. First-class selection allowlist: `ollama`, `llama.cpp-local`, `lm-studio`.
5. Stay on current Pi; no Oh My Pi dependency; no Pi fork for v1.

## Non-goals (v1)

- Ollama Cloud / full hosted OSS catalog UI (Groq, OpenRouter, etc.)
- New Alloy secret store
- Auto-starting Ollama, llama-server, or LM Studio
- Guaranteeing tool-calling quality on every local GGUF
- Replacing Pi’s `/llama` load/unload/download UI
- Changing default fusion primary models to local engines

## Success criteria

| Check | Pass |
|-------|------|
| Ollama up with ≥1 model | `ollama/<id>` in `/model` after start or refresh |
| llama.cpp router up with loaded models | `llama.cpp-local/<id>` selectable |
| LM Studio (or OpenAI-compat on its URL) with models | `lm-studio/<id>` selectable |
| Engine down | Provider absent or doctor “unreachable”; no hang beyond probe budget |
| No credentials | Default local needs no env keys |
| Regression | Anthropic / Codex / xAI login and doctor behavior unchanged |

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│ Alloy extension: local-engines                          │
│  - resolve base URLs (env + defaults)                   │
│  - probe ollama / llama.cpp / lm-studio in parallel     │
│  - build model entries + pi.registerProvider(...)       │
│  - feed /doctor + /providers                            │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Pi ModelRuntime (auth.json, models.json, /model)        │
│  - MVP OAuth providers unchanged                        │
│  - Pi /llama remains for load/unload/download           │
└─────────────────────────────────────────────────────────┘
```

**Principle:** Alloy owns auto-discovery and product UX. Pi owns streaming, auth storage, and `/model`.

### Module layout

| Piece | Role |
|-------|------|
| `lib/local-engines.mjs` | URL normalize, probes, model mapping, doctor row builders |
| `extensions/local-engines.ts` | `registerProvider` + session (and optional `/model` refresh) hooks |
| `lib/providers.mjs` / `extensions/providers.ts` | Merge local rows into `/doctor` and `/providers` |
| `config/alloy.example.json` | Default allowlist includes the three local ids |
| `docs/REFERENCE.md`, README, CHANGELOG | Operator-facing docs |
| `test/unit/local-engines.test.mjs` (and doctor tests) | Mocked fetch; no live daemon required in CI |

## Discovery protocols

### Base URL resolution

| Provider | Precedence (first wins) | Default |
|----------|-------------------------|---------|
| `ollama` | `OLLAMA_BASE_URL` → normalize `OLLAMA_HOST` → default | `http://127.0.0.1:11434` |
| `llama.cpp` | `LLAMA_CPP_BASE_URL` → `LLAMA_BASE_URL` (Pi) → default | `http://127.0.0.1:8080` |
| `lm-studio` | `LM_STUDIO_BASE_URL` → default | `http://127.0.0.1:1234/v1` |

**`OLLAMA_HOST` normalization:** accept `host`, `host:port`, `//host:port`, `:port`, or full URL; default HTTP port `11434` when port omitted on HTTP; reject non-http(s).

**v1 simplification for llama.cpp custom hosts:** env → default only (do not parse auth.json for stored URL). Users set `LLAMA_BASE_URL` or use Pi `/login llama.cpp` for non-default hosts; document both.

Optional (v1 nice-to-have if cheap): `OLLAMA_CONTEXT_LENGTH` positive int overrides missing per-model context.

### Ollama

1. Normalize native base (strip trailing slash; do not require `/v1` for native API).
2. `GET {base}/api/tags` → model ids/names.
3. Best-effort `POST {base}/api/show` per model:
   - context: `parameters` `num_ctx`, else `model_info` keys ending in `context_length` / related
   - vision if capabilities include vision/image
   - reasoning if capabilities include thinking
4. Register models with:
   - `api: "openai-completions"`
   - `baseUrl: {native}/v1`
   - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
   - `compat`: `supportsDeveloperRole: false`, `supportsReasoningEffort: false` (and other local-safe flags aligned with Pi llama provider where applicable)
   - `contextWindow` from metadata or default **128000**
   - `maxTokens: min(contextWindow, 32768)`

### llama.cpp

1. Probe OpenAI-compatible model list: `GET {base}/v1/models` or `GET {base}/models`.
2. Prefer **loaded-only** entries when status metadata is available (same product rule as Pi: only loaded models in `/model`).
3. Optional enrich from `GET {native}/props` (`n_ctx`, vision modalities).
4. Register as provider id `llama.cpp-local` with `openai-completions`, inference base ending in `/v1`, zero cost, and local compat flags including `maxTokensField: "max_tokens"`.

**Coexistence with Pi’s built-in `/llama`:**

- Keep Pi's `llama.cpp` provider and extension for load/unload/download from Hugging Face.
- Use the separate `llama.cpp-local` id because a same-id extension overlay replaces Pi's native provider runtime and disconnects `/llama` from the selectable catalog.
- Alloy fills the **selectable** alias catalog when the server is up so default local router use does not require `/login` first.
- Do not reimplement `/llama` UI in Alloy.

### LM Studio (OpenAI-compat on configured URL)

1. `GET {base}/models` (ensure `/v1` path for OpenAI list).
2. Map each `id` with defaults: context 128k or advertised field; text-only unless metadata says otherwise; zero cost; same local compat flags.
3. Same path works for other local OpenAI-compatible servers pointed at `LM_STUDIO_BASE_URL`.

### Timeouts and failure

| Target | Timeout | On failure |
|--------|---------|------------|
| Loopback (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0`) | 250–500 ms | Engine down; skip; no throw |
| Non-loopback | 10 s | Same |
| Parallelism | `Promise.allSettled` | One dead engine never blocks others |
| Partial `/api/show` | per-model ignore | Keep tag with safe defaults |

Never block session start beyond the probe budget (~10s worst-case remote; typically sub-second on loopback).
Responses are capped at 4 MiB and catalogs at 512 models per engine. Ollama
enrichment stops issuing requests when the aggregate engine deadline expires.

### When discovery runs

1. **Extension load / `session_start`** — primary registration.
2. **`/model` open** — re-probe when a safe refresh path exists (Pi already reloads catalogs for the selector in some paths); otherwise re-register if `registerProvider` is safe to call again.
3. **`/doctor`** — always re-probe for live status (non-destructive).

Fallback documentation if refresh is limited: restart session or re-run doctor after `ollama pull` / loading a llama model.

### Auth model (local)

Pi treats many providers as needing configured auth before models appear. V1 mirrors the practical local pattern:

- Resolve a **non-secret placeholder** key (`"local"` / `"ollama"`) so models are considered configured.
- If optional env keys are set, send Bearer: `OLLAMA_API_KEY`, `LLAMA_API_KEY` / `LLAMA_CPP_API_KEY`, `LM_STUDIO_API_KEY`.
- No new Alloy secret store; no `/login` required for default local.
- Doctor **never** prints key values or placeholders as secrets.

Hosted `/login` paths remain OAuth-only in OpenTUI (existing Alloy rule).

## Configuration

### Defaults

```json
"providers": {
  "allow": [
    "anthropic",
    "openai",
    "openai-codex",
    "xai",
    "ollama",
    "llama.cpp-local",
    "lm-studio"
  ],
  "local": {
    "enabled": true,
    "ollama": true,
    "llamaCpp": true,
    "lmStudio": true
  }
}
```

| Knob | Default | Behavior |
|------|---------|----------|
| `providers.allow` | includes three local ids | Remove id to disable its probe and hide it from selection |
| `providers.local.enabled` | `true` | Master switch; skip all probes when `false` |
| `providers.local.ollama` / `llamaCpp` / `lmStudio` | `true` | Per-engine disable |
| Env URLs | unset | Defaults above |
| Optional API key envs | unset | Bearer only if set |

- No required new config file for discovery to work.
- Default **fusion** role models stay cloud (do not switch primaries to local).
- Child orchestration remains restricted to pinned built-in cloud transports; local aliases are manual-session models in v1.

### Disable examples

- No local probes: `"providers": { "local": { "enabled": false } }`
- Ollama only: set `llamaCpp` / `lmStudio` false, or drop those ids from `allow`

## UX

### `/model`

- Local models under `ollama`, `llama.cpp-local`, `lm-studio`.
- Only reachable engines with ≥1 usable model contribute (llama.cpp: loaded only when status exists).
- Selection uses normal OpenAI-compat streaming path.

### `/providers`

Include local rows alongside MVP, for example:

```text
✓ Ollama — reachable (4 models) @ http://127.0.0.1:11434
✗ llama.cpp — unreachable @ http://127.0.0.1:8080
✓ LM Studio — reachable (2 models) @ http://127.0.0.1:1234/v1
```

### `/doctor`

Add a **Local engines** section:

- resolved base URL (which env won, or default)
- probe result (optional latency ms)
- model count
- hints (`ollama serve`, llama-server flags, LM Studio server, env vars, `/login llama.cpp` / `/llama` when relevant)
- still no live chat call; no secrets

MVP subscription economics block unchanged.

### `/login` and `/llama`

- Hosted MVP login unchanged.
- Local defaults need no login.
- Pi `/login llama.cpp` and `/llama` remain for custom URL, optional API key, load/unload/download.

### Status chrome

Optional v1 polish (non-blocking): e.g. `local:ollama(4)` beside existing auth status.

## Security

- Probes are read-only GETs plus Ollama `/api/show` with model name only.
- Default assumption is loopback; remote URLs are opt-in via env (operator responsibility).
- Placeholder keys are not real credentials; never log them.
- Child/orchestration: local providers remain ineligible because the credential broker accepts only pinned built-in transports.

## Testing

| Layer | Coverage |
|-------|----------|
| Unit discovery | URL normalize; Ollama tags/show; llama models/props; LM Studio list; timeouts; unreachable; empty lists; doctor strings contain no secret material |
| Unit doctor/providers | Local rows merge with MVP; all-local-down does not break cloud status |
| Unit config | Defaults include three ids; `local.enabled: false` skips registration |
| Integration | Optional: if engine up in environment, assert non-empty discovery; else skip |
| Regression | Existing provider, auth, orchestration tests pass |

CI uses mocked `fetch` only.

## Rollout order

1. `lib/local-engines.mjs` + unit tests
2. `extensions/local-engines.ts` + wire into extension index
3. Doctor / providers surface
4. Config defaults + `alloy.example.json`
5. Docs + CHANGELOG
6. Manual smoke when a local engine is available

No installer change. No Pi package bump required for v1 if `registerProvider` + OpenAI completions is sufficient (true on Pi 0.82.1 used by Alloy).

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Clash with Pi `llama.cpp` provider | Publish discovery as `llama.cpp-local`; keep Pi's native `llama.cpp` and `/llama` untouched |
| Slow remote host | Timeouts; parallel probes; doctor unreachable |
| Dummy apiKey confusion | Docs: local placeholder; never print as secret |
| Weak tool-calling on some GGUFs | Document; no false full-parity claims |
| User `models.json` overrides | Pi composes `models.json` above registered providers — user static config still wins where Pi defines precedence |
| Stale catalog after pull/load | Re-probe on `/model` when possible; else document session restart / doctor |

## Alternatives considered

1. **Static `models.json` writer only** — simpler but stale; still dummy-key friction; weaker than OMP live discovery. Rejected as primary approach.
2. **Hosted OSS allowlist only** (Groq, OpenRouter, …) — useful later; does not deliver Ollama auto-pickup. Deferred.
3. **Ollama-only first** — smaller; user chose full trio for v1.

## Open questions (resolved for v1)

| Question | Decision |
|----------|----------|
| Which engines? | Ollama + llama.cpp + LM Studio |
| Read auth.json for llama URL? | No for v1; env + default |
| Change fusion defaults to local? | No |
| Depend on Oh My Pi? | No |

## Approval

- Section 1 goals/non-goals: approved
- Section 2 architecture/discovery: approved
- Section 3 UX/config/testing/rollout: approved
- Written spec: approved for implementation, then amended during independent landing review

After approval of this file, create an implementation plan via the writing-plans skill, then implement.
