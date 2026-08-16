# Ollama Manual and Live Catalog Merge Design

**Date:** 2026-08-15
**Status:** Approved for implementation

## Problem

Alloy currently treats any `ollama` provider in `~/.pi/agent/models.json` as a
complete replacement for live Ollama discovery. The local-engine extension
skips provider registration when that manual provider exists. As a result,
models pulled later with `ollama pull` are visible through `/api/tags` but remain
absent from Alloy's model picker until the operator manually edits the catalog.

Manual provider configuration is still valuable for custom aliases and metadata
such as context windows and compatibility flags. The fix must preserve those
overrides without allowing the manual model list to become stale.

## Decision

When Ollama discovery succeeds and a manual Ollama provider exists, Alloy will
register one merged provider catalog:

1. Every live-discovered model is included.
2. Every manual-only model is included.
3. For the same model ID, manual model fields override discovered fields.
4. Manual top-level provider settings remain authoritative.
5. Ordering is deterministic: discovered order first, followed by manual-only
   entries in their configured order.

When discovery is disabled, unavailable, malformed, or empty, Alloy leaves the
preloaded manual provider untouched. It must not unregister a working manual
catalog merely because live discovery failed.

## Architecture

`extensions/local-engines.ts` remains the single registration boundary.

- Replace the provider-ID-only loader with a parser that returns sanitized
  manual local-provider definitions needed for merging.
- Do not log or return provider secrets. Manual fields remain in memory only and
  flow directly into provider registration.
- For a successful discovery result, convert discovered models to Pi's nested
  model shape, merge them by exact model ID, and overlay matching manual model
  fields.
- Register the merged catalog through Pi's extension layer. Pi composes this
  layer over `models.json`; no unregister cycle or config-file rewrite is
  required.
- Preserve the existing auto-discovered provider defaults when no manual
  provider exists.
- Keep existing failure isolation: a conflict or registration failure for one
  local provider cannot suppress other local providers.

No configuration file is rewritten. No migration, background refresh, watcher,
or Ollama daemon change is introduced.

## Data Rules

- Only provider objects and model objects with valid non-empty string IDs
  participate in a merge.
- Pi-supported manual model metadata and provider transport/auth settings are
  preserved. Unknown or schema-invalid fields are outside this merge contract.
- A manual `models` value that is absent or malformed contributes no overrides;
  live discovery may still register normally.
- Duplicate manual model IDs collapse deterministically, with the last manual
  entry winning.
- The merge never copies discovery-only `provider`, `api`, or `baseUrl` fields
  into nested model entries, matching the existing registration contract.

## Failure Behavior

- Discovery disabled or failed: retain the existing manual provider unchanged.
- Discovery succeeds with no models: retain the existing manual provider.
- Discovery succeeds and merge registration fails: preserve per-provider error
  isolation and do not affect hosted or other local providers.
- No manual provider: preserve today's live-discovery behavior.

## Testing

Unit tests will prove:

- a newly discovered model appears beside a stale manual catalog;
- a matching manual model overrides discovered metadata;
- manual-only aliases remain visible;
- deterministic ordering and duplicate-ID behavior;
- manual top-level provider settings are preserved;
- disabled, failed, malformed, and empty discovery leave manual providers alone;
- providers without manual configuration retain current behavior;
- one provider's registration failure remains isolated.

An integration test will launch Alloy with a temporary manual Ollama catalog and
a fake Ollama endpoint, then assert `--list-models` contains the discovered new
model, the overridden matching model, and the manual-only alias without provider
startup errors.

## Scope

Expected production change:

- `extensions/local-engines.ts`

Expected tests:

- `test/unit/local-engines-extension.test.mjs`
- `test/integration/local-engines.e2e.test.mjs`

Documentation may be updated only where it explains manual/live Ollama catalog
precedence. Package dependencies, lockfiles, TUI behavior, hosted providers,
other local-engine discovery protocols, and user configuration files are out of
scope.

## Acceptance

- Pulling a new model into a reachable Ollama server makes it appear in a new
  Alloy session even when `models.json` contains older Ollama entries.
- Manual model and provider overrides continue to work.
- Existing manual-provider fallback behavior survives discovery failure.
- Focused unit and integration tests pass.
- The complete Alloy unit suite remains green.
