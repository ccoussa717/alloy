# Final Review Fix Report

## Result

All five final-review findings were fixed as one change set. Alloy now loads
`models.json` through the pinned Pi package's canonical `ModelConfig.load()`
implementation, fails local overlay registration closed when that loader reports
an error, matches Pi's nested compatibility merging, preserves configured
provider names, and proves manual transport settings through a real inference
request.

## RED Evidence

Tests were added before production changes and observed failing for the intended
behavioral reasons.

### Focused unit RED

Command:

```text
node --test test/unit/local-engines-extension.test.mjs
```

Observed: 12 tests, 8 passed, 4 failed.

- Manual provider name expected `Private Ollama` but received `Ollama`.
- Commented `models.json` was ignored, so the configured name and manual model
  were absent.
- A schema-invalid provider activated its manual API key and models instead of
  failing local registration closed.
- Nested `chatTemplateKwargs` lost discovery and provider keys under a model
  override; the same shallow-merge defect covered OpenRouter and Vercel routing.

### Subprocess integration RED

Command:

```text
node --test --test-force-exit test/integration/local-engines.e2e.test.mjs
```

Observed: 3 tests, 2 passed, 1 failed. The commented manual catalog was ignored,
so `manual-only` was absent before inference could exercise the distinct manual
endpoint.

## Implementation

- Resolved the installed Pi package through its exported ESM entrypoint with
  `import.meta.resolve()`, then loaded the pinned `dist/core/model-config.js`.
- Replaced raw synchronous `JSON.parse()` with asynchronous canonical
  `ModelConfig.load()` results. No Pi schema was copied into Alloy.
- Treated every canonical load, parse, or schema error as an invalid manual
  configuration and skipped all local provider registration and unregistration.
  Alloy adds no config-error or secret-bearing output; Pi retains its existing
  diagnostics.
- Matched Pi's nested compat merge behavior for `chatTemplateKwargs`,
  `openRouterRouting`, and `vercelGatewayRouting` across discovery, provider,
  and model layers.
- Used a valid manual provider `name` in the registered extension overlay.
- Split integration discovery and inference across distinct HTTP servers. The
  test records the actual model, authorization header, and configured custom
  header received by the manual endpoint, while asserting the credential
  sentinel never appears in subprocess output.

The first GREEN attempt also exposed that `createRequire.resolve()` selected a
CommonJS export condition unavailable in the pinned ESM-only package. Resolution
was corrected to `import.meta.resolve()` before the final GREEN runs.

## GREEN Evidence

```text
node --test test/unit/local-engines.test.mjs test/unit/local-engines-extension.test.mjs
```

Observed: 38 tests passed, 0 failed.

```text
node --test --test-force-exit test/integration/local-engines.e2e.test.mjs
```

Observed: 3 tests passed, 0 failed.

```text
npm test
```

Observed: 747 tests in 30 suites passed, 0 failed, 0 skipped.

```text
git diff --check
```

Observed: clean, with no whitespace errors.

## Changed Files

- `extensions/local-engines.ts`
- `test/unit/local-engines-extension.test.mjs`
- `test/integration/local-engines.e2e.test.mjs`
- `.superpowers/sdd/final-fix-report.md`

## Self-Review

- Correctness: canonical loading, whole-config fail-closed behavior, nested
  compat precedence, display name precedence, and manual transport behavior all
  have focused regression coverage.
- Failure modes: missing `models.json` remains a valid empty canonical config;
  canonical errors and unexpected loader failures activate no local overlays.
- Security: no production logging was added, no raw config errors are surfaced,
  and integration output is checked for credential leakage.
- Blast radius: the existing test seam still accepts synchronous maps and now
  also accepts asynchronous canonical results. Discovery and per-provider
  registration behavior remain unchanged for valid or absent manual config.
- Scope: no dependency, lockfile, user config, TUI, or hosted-provider changes.

## Concerns

- The loader intentionally depends on the pinned Pi package retaining
  `dist/core/model-config.js` beside its exported `dist/index.js`. The package is
  exactly pinned and the focused subprocess test exercises this path; a future
  Pi upgrade that reorganizes `dist` must update this resolver.
- Request credentials in tests are inert sentinels, not real secrets. They are
  asserted at the in-process fake endpoint but excluded from subprocess output.
