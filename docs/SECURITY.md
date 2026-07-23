# Alloy Security Readiness

Living security notes for Alloy before any public/open-source launch.
Last updated: 2026-07-23 (Grok handoff from Ava checklist).

## Scope

Alloy is a local coding harness. The primary threats are: **malicious or buggy project config**, **prompt-injected child agents**, **credential exfiltration**, and **over-claiming isolation** (host same-uid limits vs Docker).

This document records **what is enforced**, **what is intentionally not claimed**, and **remaining launch gates**.

---

## Threat model (summary)

| Threat | Mitigation | Residual risk |
|---|---|---|
| Project config weakens operator policy | P0.1 trust boundary: security fields from global config only | Operator must protect `~/.pi/alloy/config.json` |
| Plan/review mode still mutates | P0.2 central capability gate; hard deny bash/write/edit | Extension load order bugs — covered by unit tests |
| MCP tools bypass policy by name | Same capability gate for MCP; no name heuristics | Malicious MCP server can still return data the model sees (host-side MCP) |
| Child exceeds parent permissions | `resolveChildExecutionPolicy` + `child-enforcer` clamp | Prompt-only instructions are not trusted alone |
| Child inherits API keys | Provider credential env keys stripped; allowlisted env | Model may still call providers via child's own Pi auth if credentials are mounted — see credential flow |
| Child reads host `auth.json` | Isolated HOME / `PI_CODING_AGENT_DIR`; Docker does not mount host auth | **Host backend:** same-uid process can open absolute host paths if known (`env-home-isolation` claim only) |
| Sandbox missing but requested | Fail closed (`sandbox_unavailable`) — no host spawn | Operator without Docker cannot use sandbox profile |
| Checkpoint restore deletes work | No `git clean`; authenticated anchors; collision preflight; fail closed on legacy | External concurrent mutation after revalidation (documented TOCTOU bound) |
| Worktree escapes project root | Path containment + hardened remove | Review adversarial tests in `test/unit` |
| Secrets in doctor/memory/logs | Doctor never prints secret values; honesty policy | User can still `/remember` a secret — operational discipline |
| Supply chain (deps) | `npm audit` informational in CI; pin engines ≥22.19 | Nested Pi deps may report findings |

---

## Credential flow audit

### Parent (interactive session)

1. Operator authenticates with **Pi `/login`** (subscription) or env API keys.
2. Pi stores session auth under `~/.pi/agent/auth.json` (Pi-owned; Alloy never logs contents).
3. Alloy `/doctor` and `/providers` report **presence/expiry shape only**, never tokens.

### Children (`/auto`, `/fusion`, `/agent`)

1. **Env scrub:** `PROVIDER_CREDENTIAL_ENV_KEYS` are never copied into the child environment.
2. **HOME isolation:** child receives a temporary HOME and `PI_CODING_AGENT_DIR` so the host auth file is not the default Pi path.
3. **Sandbox path:** when `sandbox=true`, the child runs in Docker with mounts that **do not include host auth**. Credential boundary claim: `docker-fs`.
4. **Host path:** when sandbox is off, boundary claim is **`env-home-isolation` only**. A compromised or prompt-injected child that learns absolute host paths could still open files as the same OS user. Do not market this as a security VM.
5. **Manifest honesty:** each child run records `credentialBoundary` so tooling and reviews cannot over-claim.

### MCP

- MCP servers are host-side in v1 (even under sandbox).
- Server env from config must not dump host secrets into logs; integration tests cover env scrub on fake MCP.

### Operator checklist

- Prefer `/permissions sandbox` for untrusted code execution paths when Docker is available.
- Do not store API keys in Alloy memory, skills, or project MCP command strings when avoidable.
- Treat `ask-none` as power-user convenience, not multi-tenant isolation.

---

## Host vs Docker isolation claims

| Claim | Host child | Docker sandbox child |
|---|---|---|
| No provider keys in env | Yes | Yes |
| Separate HOME / Pi agent dir | Yes | Yes |
| Cannot read host auth via default paths | Yes (defaults isolated) | Yes (not mounted) |
| Cannot open arbitrary host paths | **No** (same uid) | **Yes** (mount + network policy) |
| Network egress blocked | No | Default `network=none` |
| Fail closed without Docker | N/A | Yes |

---

## Security remediation status (engineering)

| Workstream | Status |
|---|---|
| P0.1 Trust boundary | Merged (`origin/main`) |
| P0.2 Capability policy | Merged |
| P0.3 Child isolation baseline | Merged |
| P0.4 Safe checkpoints | Merged + remediation series |
| P0.5 Truthful orchestration | Merged |
| P1 Integration / CI / Docker e2e | Merged |
| Checkpoint/worktree adversarial hardening | Merged (`fix/alloy-security-remediation`) |
| Child policy ceiling + sandbox + credential honesty | **In progress** — branch `fix/alloy-grok-child-policy` |
| KYL-277 checkpoint CI stability | Included on child-policy branch |
| Native `openat` helper | Deferred |
| Public OSS launch gates | Deferred (see below) |

---

## Public launch gates (not yet product-blocking)

From Kylaira open-source strategy (2026-07-22) and Ava checklist:

1. Attribution-and-diff audit vs upstream Pi (MIT notice preserved).
2. Full threat-model pass (this doc is the living start; complete external review).
3. Credential-flow audit sign-off (this section).
4. Fresh git history for public GitHub (re-init, not scrub).
5. Clean install from public source + two fresh-machine install tests.
6. Quiet security preview before loud launch.
7. License decision (Apache-2.0 recommended for Alloy originals; preserve Pi MIT).
8. `SECURITY.md` reporting path, CODEOWNERS, supported-version policy, SBOM/provenance (future).

---

## Reporting

Internal: Sphere relay to `grok` / `ava` / `bishop`, or Chris directly.  
Public reporting path: TBD before GitHub launch.
