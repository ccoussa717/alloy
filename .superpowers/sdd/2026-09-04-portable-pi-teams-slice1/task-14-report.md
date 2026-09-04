# Task 14 Report: Alloy Adapter For Portable Teams Slice 1

## Status

Implemented and validated the narrow Alloy host adapter and exactly-once root registration.

## TDD Evidence

RED was observed before implementation:

```text
node --test test/unit/teams-alloy-host.test.mjs test/unit/teams-registration.test.mjs
# tests 5
# pass 0
# fail 5
ERR_MODULE_NOT_FOUND: lib/teams-host.mjs
Teams command registrations: 0 !== 1
```

After implementation, the focused contract and registration run passed:

```text
node --test test/unit/teams-alloy-host.test.mjs test/unit/teams-registration.test.mjs test/unit/fission-registration.test.mjs
# tests 6
# pass 6
# fail 0
```

## Implementation

- Added `createAlloyTeamsHost(dependencies?)` with the required primitive-typed dependency seam.
- Kept authority fixed to `repo.read` and `read`, `grep`, `find`, `ls`.
- Routed semantic member roles through `prepareAgentLaunch` with current Alloy running-count, spent-cost, and model-registry state.
- Blocked route failures, missing/contradictory effective models, tool widening, invalid global policy values, and timeout widening with stable adapter reasons.
- Bound admission in an opaque frozen token and tightened each child budget to the lower of the Team allocation and Alloy allocation.
- Reused `resolveParentChildSpawnOpts({ mode: "review" })` and `spawnAgent`; no alternate router, credential source, subprocess runner, ledger, containment layer, or worktree handling was added.
- Returned synchronous `MemberExecution` handles, bridged caller cancellation into the adapter-owned child signal, and made containment exact to host/run/member/handle identity.
- Mapped Alloy child text, model, token usage, cost, and failure evidence into portable `MemberResult`.
- Added a single Alloy wrapper around portable `registerTeams`, with durable runs under Alloy home, and called it once from the sole root extension.
- Root `package.json.pi.extensions` remains exactly `["./extensions/index.ts"]`.

## Changed Files

- `lib/teams-host.mjs`
- `extensions/teams.ts`
- `extensions/index.ts`
- `test/unit/teams-alloy-host.test.mjs`
- `test/unit/teams-registration.test.mjs`
- `.superpowers/sdd/2026-09-04-portable-pi-teams-slice1/task-14-report.md`

## Validation

- Focused Alloy adapter, Teams registration, and Fission registration: 6 passed.
- Teams plus relevant routing/registry/child-policy Alloy tests: 289 passed.
- Full root unit suite (`npm test`): 1,029 passed.
- Isolated Alloy/Pi startup integration (`test/integration/pi-startup.e2e.test.mjs`): 10 passed.
- Portable Teams TypeScript check (`npm run typecheck:teams`): passed.
- Syntax checks for the adapter and new tests: passed.
- `git diff --check`: passed.
- TUI typecheck was attempted but unavailable because the checkout lacks the `tsgo` executable (`tsgo: command not found`, exit 127). This change does not touch TUI code.

## Scope And Residual Risk

- No Auto, Fusion, Fission, Forge, worktree, or diagnostics implementation was changed or imported by the adapter.
- Superseded in Fix Round 1: host concurrency now derives from the portable ceiling and current Alloy configured capacity rather than a fixed one-member ceiling.
- No live provider child was launched; child option propagation, asynchronous settlement, usage mapping, and exact-handle cancellation are covered with injected primitive contract tests.

## Fix Round 1 (review follow-up)

### RED

The review regressions were added before production changes. The first focused run was intentionally red:

```text
node --test test/unit/teams-alloy-host.test.mjs test/unit/teams-alloy-host-review.test.mjs test/unit/teams-child-runner.test.mjs
# tests 12
# pass 3
# fail 9
```

Failures demonstrated hard-coded concurrency, semantic-route and credential contradictions being admitted, missing confinement/subset propagation, unsafe result normalization, hostile error getter access, retained settled handles, and review-mode tool widening.

### Corrections

- Added one opt-in `preserveReadOnlyToolSubset` seam through `spawnAgent` to the existing child policy/runner. Review/plan behavior is unchanged for all existing callers; the opt-in validates a nonempty unique subset of `read`, `grep`, `find`, and `ls`, rejects `write`/`bash`, preserves the subset in the mechanical policy manifest and Pi `--tools` argument, and keeps `readRoot` confinement.
- Added the existing `loadConfig` as an injected/default host dependency. Advertised host concurrency is now the minimum of the portable package ceiling and current configured global capacity after existing running agents; malformed or exhausted capacity fails closed.
- Required successful route decisions to attest the exact semantic member route, exact model, exact tool subset, positive routing/budget limits, and recognized `runtime-key` credential evidence whose provider matches the admitted model.
- Deep-captured and froze admission evidence as bounded plain data without invoking proxy/getter traps.
- Made spawn normalization bounded and fail-closed for proxies, accessors, cycles, malformed or nonfinite usage, fractional/negative tokens, oversized text, over-budget cost, contradictory status, and missing/mismatched actual model evidence.
- Preserved `actualModel` through the existing registry result and required both normalized model fields to agree with admission.
- Passed the portable output ceiling into the existing child runner.
- Removed settled adapter handles and covered wrong/stale same-host identity, already-aborted launch, repeated/concurrent live containment, synchronous throw, asynchronous rejection, and settlement races.

### Fix-round files

- `lib/teams-host.mjs`
- `lib/agent-registry.mjs`
- `lib/child-runner.mjs`
- `test/unit/teams-alloy-host.test.mjs`
- `test/unit/teams-alloy-host-review.test.mjs`
- `test/unit/teams-child-runner.test.mjs`
- `.superpowers/sdd/2026-09-04-portable-pi-teams-slice1/task-14-report.md`

### Fix-round validation

- Focused adapter, subset-runner, registration, and Fission smoke tests: 15 passed.
- Teams plus relevant routing/child policy/runner tests: 310 passed.
- Full root unit suite (`npm test`): 1,038 passed.
- Isolated Alloy/Pi startup integration: 10 passed.
- Portable Teams typecheck: passed.
- TUI typecheck remains unavailable in this checkout because `tsgo` is not installed (`tsgo: command not found`, exit 127); no TUI code changed.
- Syntax and `git diff --check`: passed.

### Residual risk

No live paid-provider child was launched. The exact subset reaches the real child policy builder and dry-run spawn-plan seam, while credential-safe child spawning remains covered by the existing child-runner and startup integration suites.
