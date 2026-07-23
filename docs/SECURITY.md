# Alloy Security Readiness

**Status:** Engineering security-readiness gate **complete** as of 2026-07-23  
**Tree:** `main` @ merge `fix/alloy-grok-child-policy` (child policy + this package)  
**Owner (this pass):** Grok (handoff from Ava checklist)

This document is the **signed-off engineering security readiness record** for Alloy before any public open-source launch. Public launch packaging (fresh git history, GitHub, SBOM) remains a **separate gate** below.

---

## 1. Scope and assets

| Asset | Location | Sensitivity |
|---|---|---|
| Operator auth (Pi) | `~/.pi/agent/auth.json` | High — tokens/subscriptions |
| Provider API keys | Process env | High |
| Alloy config | `~/.pi/alloy/config.json` | Medium — policy defaults |
| Project config / MCP | project `.pi` / mcp configs | Medium — can try to weaken policy |
| Durable memory | `~/.pi/alloy/memory/` | Medium — user content |
| Child run artifacts | `~/.pi/alloy/runs/` | Medium — prompts/transcripts |
| Checkpoints | Git refs + `~/.pi/alloy` store | Medium — can restore destructive state |
| Source tree / worktrees | Project + `~/.pi/alloy/worktrees/` | Code integrity |

**Product shape:** single-operator local coding harness on Pi. **Not** multi-tenant SaaS isolation.

---

## 2. Threat model

### 2.1 Adversaries

1. **Malicious or compromised project tree** — untrusted repo with hostile config, MCP, skills, or content aimed at the agent.
2. **Prompt injection via tools/MCP/web** — content that tries to elevate child autonomy or exfiltrate credentials.
3. **Runaway or buggy child agent** — `/auto`, `/fusion`, `/agent` children exceeding intended permissions.
4. **Local same-user malware / curious process** — another process as the same OS user (outside Alloy’s threat budget for non-sandbox).
5. **Supply chain** — vulnerable transitive npm packages (Pi/MCP stack).

### 2.2 Trust boundaries

```text
┌─────────────────────────────────────────────────────────────┐
│ Operator machine (same uid)                                 │
│  ┌──────────────┐   trust    ┌───────────────────────────┐  │
│  │ Global Alloy │ ─────────► │ Interactive parent session│  │
│  │ config/policy│            │ Pi TUI + Alloy extensions │  │
│  └──────────────┘            └─────────────┬─────────────┘  │
│         ▲                                  │ spawn          │
│         │ cannot weaken                    ▼                │
│  ┌──────────────┐            ┌───────────────────────────┐  │
│  │ Project cfg  │──blocked──│ Child (host backend)       │  │
│  │ untrusted MCP│            │ env scrub + isolated HOME │  │
│  └──────────────┘            │ claim: env-home-isolation │  │
│                              └─────────────┬─────────────┘  │
│                                            │ if sandbox     │
│                              ┌─────────────▼─────────────┐  │
│                              │ Child (Docker backend)    │  │
│                              │ network=none, cap-drop    │  │
│                              │ mounts: workspace, alloy  │  │
│                              │   ro, child-home, policy  │  │
│                              │ claim: docker-fs          │  │
│                              └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Threat → control matrix

| ID | Threat | Control | Verification |
|---|---|---|---|
| T1 | Project config weakens permission/sandbox | P0.1 trust boundary (`lib/config.mjs`, `lib/project-trust.mjs`) | `test/unit` trust/capability suites |
| T2 | Plan/review still mutates | P0.2 `evaluateToolPolicy` hard read-only | `capabilities.test.mjs` |
| T3 | MCP bypass by tool name | Same gate for MCP; no allow-by-name heuristics | policy + mcp tests |
| T4 | Child exceeds parent approval | `resolveChildExecutionPolicy` + `child-enforcer` | `child-policy-sandbox.test.mjs` |
| T5 | Sandbox child runs host bash | Fail closed if no Docker; enforcer denies bash unless `ALLOY_CHILD_IN_DOCKER=1` | child-policy + docker e2e |
| T6 | Child inherits API keys | `PROVIDER_CREDENTIAL_ENV_KEYS` stripped; allowlist env | child-runner unit tests |
| T7 | Child uses host `auth.json` by default | Isolated HOME / `PI_CODING_AGENT_DIR`; Docker does not mount host auth | child-policy tests (synthetic host auth) |
| T8 | Over-claim “secure isolation” on host | Manifest `credentialBoundary`: `env-home-isolation` vs `docker-fs` | unit assertions on manifest |
| T9 | Checkpoint clobber / path escape | Authenticated anchors, no `git clean`, collision preflight | `git-checkpoint.test.mjs`, remediation plan |
| T10 | Worktree escapes root | Containment + hardened remove | `worktree.test.mjs` |
| T11 | Doctor/logs leak secrets | Status/shape only; never token values | `providers.mjs` + doctor tests |
| T12 | Headless child auto-approves | Enforcer fail-closed on `approve` decisions | child-enforcer |
| T13 | Supply chain CVEs | `npm audit` in CI (informational); engines ≥22.19 | CI + §6 below |

### 2.4 Explicit non-goals (residual)

- **Not a multi-tenant security boundary.** Same-uid host processes can always read what the operator can.
- **Host child is not a sandbox.** Absolute host paths remain OS-readable without Docker.
- **MCP is host-side in v1** even when session sandbox is on — treat MCP servers as trusted as the operator who configured them.
- **No global TOCTOU lock** on checkpoint restore against external concurrent writers (documented in architecture).
- **No native `openat` helper** yet (deferred hardening).

---

## 3. Credential-flow audit

### 3.1 Parent interactive session

| Step | Behavior | Code |
|---|---|---|
| Login | Pi `/login` or env keys | Pi runtime |
| Storage | `~/.pi/agent/auth.json` (Pi-owned) | `lib/providers.mjs` → `getAuthPath()` |
| Doctor | Presence, type, expiry **shape only** — never returns token/key material | `probeCredentialFreshness`, `diagnoseProviders` |
| Env keys reported | Name of env var if set (`ANTHROPIC_API_KEY set`), not value | `diagnoseProviders` |

### 3.2 Child spawn path

| Step | Behavior | Code |
|---|---|---|
| Policy clamp | Parent approval ceiling; sandbox orthogonal | `resolveChildExecutionPolicy` |
| Manifest | Records `credentialBoundary`, `credentialBroker: none-by-default` | `buildChildPolicyManifest` v3 |
| Env | Allowlist only; strip provider credential keys | `buildChildEnv`, `PROVIDER_CREDENTIAL_ENV_KEYS` |
| HOME | Ephemeral dir; host auth **not** copied by default | `createIsolatedChildHome` |
| Broker | Optional; default **none** | `provisionChildAuthBroker` |
| Docker mounts | `/workspace` (cwd), `/alloy` ro, `/child-home`, `/alloy-policy` — **no host HOME** | `buildChildSpawnPlan` |
| Host backend env | Isolated HOME + enforcer; still same uid | host branch of `buildChildSpawnPlan` |

### 3.3 MCP

| Step | Behavior |
|---|---|
| Process | Host-side stdio servers |
| Env | Configured per server; integration test asserts host secrets not blindly forwarded |
| Policy | Tools share `evaluateToolPolicy` |

### 3.4 Audit conclusion

**Pass (engineering).** Credential paths are intentional, fail closed where designed, and do not over-claim isolation. Residual: operator discipline (do not `/remember` secrets; treat MCP as trusted config).

---

## 4. Host vs Docker isolation claims

These claims are **normative**. Marketing and `/doctor` copy must match them.

| Claim | Host child (`credentialBoundary: env-home-isolation`) | Docker sandbox child (`credentialBoundary: docker-fs`) |
|---|---|---|
| Provider API keys absent from child env | **Yes** | **Yes** |
| Default Pi auth path is not host `auth.json` | **Yes** (ephemeral HOME) | **Yes** (only `/child-home`) |
| Host `auth.json` not mounted/copied by default | **Yes** (not copied) | **Yes** (not in mount set) |
| Child cannot open arbitrary host paths as same user | **No** | **Yes** (mount namespace) |
| Network egress blocked by default | **No** | **Yes** (`--network none`) |
| Caps dropped / no-new-privileges | **No** | **Yes** |
| Fail closed if Docker missing when sandbox required | N/A | **Yes** (`sandbox_unavailable`) |
| Bash on host while sandbox required | Blocked by enforcer | Allowed only inside container (`ALLOY_CHILD_IN_DOCKER=1`) |

**Session sandbox** (`/permissions sandbox`) for interactive bash uses `lib/docker-sandbox.mjs` with the same class of Docker hardening (network none by default, image from operator config).

---

## 5. Repository history secret scan

**Date:** 2026-07-23  
**Method:**

```bash
# Preferred: allowlisted wrapper (see scripts/security-scan.sh)
npm run security:scan

# Sensitive path additions (also covered by the wrapper)
git log --all --full-history --diff-filter=A --summary -- '**/.env' '**/auth.json' '**/*secret*' '**/*.pem' '**/*.key'
```

The scanner looks for common live credential signatures (Anthropic/OpenAI-style
API key prefixes, GitHub/GitLab PATs, PEM private key headers). It allowlists
the scanner script itself and does not treat documentation of the process as a
finding.

**Result:**

| Check | Result |
|---|---|
| Live secret patterns in tracked source | **None found** |
| History `git grep` for private keys / common token prefixes | **None found** |
| `.env` / `auth.json` / `*.pem` additions in history | **None found** |
| Oversized unexpected blobs (>500KB) in git | **None found** |

**Note:** This is a signature scan, not a guarantee against all secret formats. Public launch still recommends **fresh history re-init** (strategy decision), not scrub-in-place.

---

## 6. Dependency audit (snapshot)

**Date:** 2026-07-23 · `npm audit --omit=dev`

| Severity | Count | Notes |
|---|---|---|
| High | 1 | `brace-expansion` via nested Pi deps |
| Moderate | 7 | `@hono/node-server` / MCP / protobufjs via Pi stack |

**Disposition:** Informational for engineering readiness. Fixes require upstream Pi/MCP bumps; do not force unrelated major upgrades in this gate. CI continues to run `npm audit` as advisory.

---

## 7. Attribution (Pi)

See **[ATTRIBUTION.md](./ATTRIBUTION.md)** for the Alloy-vs-Pi boundary and MIT notice for `@earendil-works/pi-coding-agent` (Copyright Mario Zechner / earendil-works).

Alloy does **not** fork Pi sources into this repo; it depends on the published package and injects extensions.

---

## 8. Engineering gate checklist (Ava)

| # | Item | Status |
|---|---|---|
| 1 | P0 trust / capability / child / checkpoint / orchestration | **Done** (main) |
| 2 | Checkpoint/worktree adversarial remediation | **Done** (main) |
| 3 | Child policy ceiling + sandbox + credential honesty | **Done** (merged `fix/alloy-grok-child-policy`) |
| 4 | KYL-277 checkpoint CI stability | **Done** (merged) |
| 5 | Threat model pass | **Done** (§2) |
| 6 | Credential-flow audit | **Done** (§3) |
| 7 | Repo history secret scan | **Done** (§5) |
| 8 | Explicit host vs Docker claims | **Done** (§4) |
| 9 | Docs reconciled (MVP / architecture / README) | **Done** |
| 10 | Attribution-and-diff audit vs Pi | **Done** (`docs/ATTRIBUTION.md`) |
| 11 | Full unit + integration green on main | **Required on each release commit** |

### Deferred (not blocking engineering readiness)

| Item | Why deferred |
|---|---|
| Native `openat` checkpoint helper | Separate hardening; concurrency bound documented |
| Public GitHub fresh history + two clean-machine installs | OSS launch package |
| Quiet public security preview | After public packaging |
| License change MIT → Apache-2.0 for Alloy originals | Product/legal decision (strategy recommends Apache for public) |
| CODEOWNERS, SBOM, supported-version policy | Launch packaging |
| Route all write/edit through Docker | Optional product follow-up |
| MCP inside sandbox network namespace | Architecture v2 |

---

## 9. Reporting

| Audience | Path |
|---|---|
| Private / pre-public | Maintainers via private team channel (see root `SECURITY.md`) |
| Public | TBD at open-source launch — publish a reporting URL before inviting external reports |

---

## 10. Sign-off

| Role | Call |
|---|---|
| Engineering security-readiness (Ava checklist items 1–10) | **Complete** — Grok, 2026-07-23 |
| Public OSS launch readiness | **Not complete** — see deferred table |
