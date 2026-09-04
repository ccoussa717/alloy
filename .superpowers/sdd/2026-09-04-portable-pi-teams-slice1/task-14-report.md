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
- The host advertises a conservative one-member scheduler ceiling; each spawn additionally carries Alloy's admitted global concurrency ceiling, so concurrency cannot widen beyond either authority. This favors containment and avoids preflight/execution races in the current TeamHost call order.
- No live provider child was launched; child option propagation, asynchronous settlement, usage mapping, and exact-handle cancellation are covered with injected primitive contract tests.
