# Multi-Agent Orchestration Plan

Feature: KYL-286

## Goal

Let an operator choose a preferred main model and safely delegate one-level
work through a hybrid router. Alloy must select only configured, authenticated,
allowed child models; preserve the parent permission boundary; use explicit
fallbacks; and record a non-secret explanation for every route.

## Decisions

- The main model preference is global operator configuration. A later explicit
  session `/model` selection remains an override.
- The orchestrator may request a role or an eligible model. Alloy mechanically
  enforces provider, authentication, transport, tool, permission, and budget
  constraints.
- If no role is requested, a deterministic classifier selects one of research,
  planning, implementation, review, or general.
- Only ordered, configured role fallbacks may replace an unavailable primary.
- Write-capable agents launch automatically only within the inherited parent
  permission, sandbox, tool, concurrency, and budget boundary.
- Children do not load Alloy extensions, so delegation remains one level deep.
- Child credentials are provider-scoped ephemeral leases and never enter argv,
  process environment, prompts, logs, records, or run artifacts.

## Execution

1. **KYL-287: policy and pure router.** Add the config schema, trust-boundary
   merge rules, deterministic role classification, candidate filtering, and
   auditable route decisions. Done when focused router and config tests pass.
2. **KYL-288: shared credential lease.** Generalize Fusion's active-session
   credential resolver, preserve fail-closed transport checks, and migrate
   Fusion to it. Done when credential, child-policy, and Fusion tests pass.
3. **KYL-291: free-agent integration.** Route `/agent` and `alloy_task`, pass
   the selected lease to isolated children, and persist/display route evidence.
   Done when manual and model-callable delegation tests pass without secrets.
4. **KYL-289: Auto and Fusion integration.** Route every Auto role, enforce
   cumulative observed cost before subsequent launches, and use the shared
   lease in both workflows. Done when Auto/Fusion focused suites pass.
5. **KYL-290: setup and full verification.** Add `/orchestration setup|status`,
   atomically persist global policy, update the active main model, document the
   feature, and run complete package/security/review gates.

Each issue stops at its accepted boundary for review and verification before
the next issue begins. Commits, merge, deployment, and release require their
own authorization.

## Done

- The configured main model can delegate research, planning, implementation,
  review, and general tasks without naming a child model.
- Routing uses only eligible configured candidates and explains primary,
  fallback, and rejection decisions.
- `/agent`, `alloy_task`, `/auto`, and Fusion can use active parent provider
  access without copying parent auth or weakening policy.
- Custom transports, missing auth, exhausted budget, excessive concurrency,
  and recursive delegation fail closed with actionable non-secret errors.
- Complete Node 22.19 unit, integration, package, release, and security checks
  pass with no must-fix review findings.
