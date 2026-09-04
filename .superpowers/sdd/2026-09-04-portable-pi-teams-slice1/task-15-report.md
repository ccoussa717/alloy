# Task 15 Report: Portable Teams Packaging, Documentation, And Validation

## Status

Implemented the standalone package documentation and Alloy help, added the opt-in packed stock Pi 0.84.2 smoke, locked the root test script, validated the packed file/peer graph, and completed broad repository validation without live paid model execution.

## TDD Evidence

The documentation boundary test and packed smoke were created before documentation/script implementation. The first required combined run was red for all three documentation surfaces while the stock suite was opt-in skipped:

```text
node --test test/unit/teams-docs.test.mjs test/integration/teams-stock-pi.e2e.test.mjs
# documentation tests: 0 passed, 3 failed
# stock suite: skipped without ALLOY_RUN_TEAMS_STOCK_E2E=1
```

The first opted-in packed smoke exposed two real installer/runtime assumptions and was corrected in the test harness:

1. npm 10 interprets bare `packages/pi-teams` as a GitHub shorthand; the local folder spec must be `./packages/pi-teams`.
2. Node 22 intentionally refuses native type stripping beneath `node_modules`; stock Pi loads TypeScript extensions through its nested Jiti loader. The isolated smoke now imports both installed package export paths through that stock-Pi loading mechanism rather than importing from the source tree.

The final documentation tests pass, and the final isolated packed smoke passes.

## Documentation And Package Work

- Added `packages/pi-teams/README.md` with local/pinned Pi package installation and settings behavior.
- Documented all three catalog roots and namespaces, uniqueness/ambiguity behavior, project trust gating, no-follow loading, and the sole `builtin/investigate` DAG.
- Documented all seven `/team` command forms and all seven `team` tool actions, including the command/tool authority distinction and `approval_required` model boundary.
- Documented human approval binding to effective admissions/timeouts, tighten-only authority, fixed resource/security ceilings, stock active-model routing, Alloy primitive reuse, and `StockPiHostOptions.maxTimeoutMs` validation/narrowing.
- Documented durable event/artifact locations, hash-chain authority, permissions, `incomplete` crash behavior, 5,000 ms abort/containment/settlement bounds, and fail-closed containment outcomes.
- Explicitly excluded repository mutation, resume, candidate create/apply, commit, push, publish, deploy, custom graphical TUI work, later built-ins, and Auto/Fusion/Fission/Forge refactoring.
- Added the concise root README link/compatibility section and a plain-text `/help teams` topic; no graphical UI code was added.
- Added exact `test:teams:stock` script. `npm install --package-lock-only --ignore-scripts` found the existing shrinkwrap current, so it produced no shrinkwrap byte change.

## Packed Stock Pi 0.84.2 Evidence

The opt-in test:

- packs `./packages/pi-teams` and installs only that tarball plus exact stock `@earendil-works/pi-coding-agent@0.84.2` and `typebox@1.1.38` in a fresh consumer;
- verifies installed package/peer versions and absence of package tests/root Alloy internals;
- verifies `createAgentSession`, `DefaultResourceLoader`, `SettingsManager`, `SessionManager`, `ModelRuntime`, and `getAgentDir` exports;
- imports installed `@alloy/pi-teams` and `@alloy/pi-teams/extension` via stock Pi's TypeScript/Jiti loading mechanism;
- invokes the extension with a fail-closed Proxy API and observes exactly one `team` command and one `team` tool;
- exercises builtins-only command/tool list and inspect, plus tool request, from the isolated install with zero provider/network calls;
- uses stock 0.84.2's real `DefaultResourceLoader`, `SettingsManager`, `SessionManager`, and `ModelRuntime` with a controlled session factory to prove isolated active-model composition, disabled default tools, and exactly four confined custom tools without paid/provider execution.

Result:

```text
npm run test:teams:stock
# tests 1; pass 1; fail 0
```

## Deferred-Minor Triage

Three ledger minors were straightforward and fixed:

1. **Concurrency relation interception:** added a two-member manifest with `maxConcurrency: 3`, which is at the global ceiling but exceeds member count, and asserted `manifest_concurrency`.
2. **Escaped-realpath no-open strength:** instrumented filesystem opens and asserted the escaped pathname is never opened in addition to asserting rejection.
3. **Abandoned-run comment:** corrected the comment to state that failed partial creation permanently consumes the run ID.

The writer-close observability minor remains deferred. Evidence: `core/service.ts` intentionally evicts/cancels in-memory authority during fail-closed abandonment and suppresses `EventWriter.close()` cleanup errors; `FileEventWriter.closeResources()` marks the writer closed before closing multiple descriptors. Making cleanup retryable or retaining authority after partial descriptor-close failure changes lifecycle/ownership semantics and is not a straightforward Task 15 packaging/documentation correction. Ruling for final review: preserve the current fail-closed authority eviction rather than mask the initiating lifecycle failure or invent retry semantics; consider a separately designed cleanup-error reporting channel that does not restore run authority.

## Validation

- `npm install --package-lock-only --ignore-scripts`: current; npm reported the pre-existing audit summary of 1 moderate and 1 high vulnerability.
- `node --test test/unit/teams-manifest.test.mjs test/unit/teams-catalog.test.mjs test/unit/teams-events.test.mjs`: 68 passed.
- `node --test test/unit/teams-*.test.mjs test/unit/fission-registration.test.mjs test/unit/pi-package.test.mjs`: 258 passed.
- `npm run typecheck:teams`: passed.
- `npm pack ./packages/pi-teams --json --dry-run`: passed; 24 entries, README/source/builtin included, no root Alloy internals/tests.
- `npm run test:teams:stock`: passed against isolated stock Pi 0.84.2.
- `npm test`: 1,042 passed.
- `npm run test:integration`: 38 passed, 1 opt-in stock suite skipped; Docker suite reported environment skip because Docker CLI is absent.
- Placeholder scan: passed.
- `git diff --check`: passed.
- Mechanical authority scan found only documentation/rejection text for excluded capabilities and exactly one command definition plus one tool definition.
- Historical barrel inspection at Tasks 1, 9, 11, and 13 showed only then-existing modules exported.
- Type/interface audit and TypeScript validation confirmed a single shared producer/consumer vocabulary and matching host/service signatures.

The exact brief spelling `npm pack packages/pi-teams --json --dry-run` is not a valid local path spec under this environment's npm 10: npm treats it as `github:packages/pi-teams`. The semantically correct and successfully validated local command is `npm pack ./packages/pi-teams --json --dry-run`; the smoke uses the same explicit local folder form.

## Changed Files

- `packages/pi-teams/README.md`
- `test/integration/teams-stock-pi.e2e.test.mjs`
- `test/unit/teams-docs.test.mjs`
- `README.md`
- `lib/help-catalog.mjs`
- `package.json`
- `test/unit/teams-manifest.test.mjs`
- `test/unit/teams-catalog.test.mjs`
- `test/unit/teams-events.test.mjs`
- `.superpowers/sdd/2026-09-04-portable-pi-teams-slice1/progress.md`
- `.superpowers/sdd/2026-09-04-portable-pi-teams-slice1/task-15-report.md`

## Residuals

- Writer-close cleanup observability/retry semantics remain a separately scoped final-review item as ruled above.
- No live paid model/provider execution was performed; controlled composition used synthetic auth and a fake session while retaining real stock 0.84.2 SDK resource/runtime primitives.
- npm's audit summary remains 1 moderate and 1 high vulnerability and was not changed by this task.
