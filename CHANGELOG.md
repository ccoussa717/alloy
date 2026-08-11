# Changelog

All notable changes to Alloy will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [semantic versioning](https://semver.org/).

## [Unreleased]

## [1.1.3] - 2026-08-11

### Fixed

- **Codex model list is complete again** in `/fission setup` (and fusion/auto
  setup): session registries that only exposed a partial openai-codex subset
  (e.g. missing `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) are merged with
  the full pinned Pi builtin catalog. Same expand runs at session start so
  `/model` and child launches see the full set too.

## [1.1.2] - 2026-08-11

### Fixed

- Fission **INCOMPLETE with zero agents** is much clearer: status warns when
  orchestration is disabled, the result dialog explains no reviewers started,
  the agent panel shows the launch error, and config hints cover common codes
  (`orchestration_disabled`, `provider_unavailable`, local `child_failed`, …).
- Subject packet cleanup no longer leaves frozen attempt dirs when capture fails.

## [1.1.1] - 2026-08-11

### Fixed

- Fission/fusion/auto **children on Ollama / llama.cpp / LM Studio** no longer
  die with opaque `child_failed`. Isolated children load only the child
  enforcer (no local discovery), so session leases now broker baseUrl + model
  transport for local engines and child-enforcer registers them with keyless
  OpenAI-compatible streaming. Cloud routes stay key-only (no baseUrl smuggling).
- Fission panel errors include a short stderr hint when a child fails.

## [1.1.0] - 2026-08-11

### Added

- **General-purpose `/fission`**: adversarial multi-perspective review of
  **any request** — plans, documents, ideas, contracts — not only git repos.
  Default **auto** mode freezes a trusted dirty tree when available; otherwise
  freezes the request as an immutable `subject.md` packet.
- Explicit modes: `fissionMode: "auto"|"subject"|"repo"`, CLI
  `alloy fission --subject|--repo|--mode …`.
- Forge plan-phase fission uses **subject** mode so pre-build review no longer
  skips on a clean tree.

### Changed

- Help, MVP, and status copy describe freeform + dirty-tree fission.
- Result payloads include `mode` (`subject` | `repo`).

## [1.0.5] - 2026-08-10

### Added

- `/fission setup` (and other session-trusted model pickers) include
  **auto-discovered Ollama, llama.cpp, and LM Studio** models the same way
  `/model` does. Local engines get session credential leases and may run as
  fission reviewers / workflow children; arbitrary custom transports stay
  blocked.

## [1.0.4] - 2026-08-10

### Fixed

- Bare `/fission`, `/fusion`, `/auto`, `/forge`, `/pack` open an **action menu**
  that runs the chosen subcommand (help/status/setup/apply) instead of a
  decorative list that dismissed on Enter.


## [1.0.3] - 2026-08-10

### Fixed

- Slash-command help panels (`/fission help`, `/fusion help`, `/auto help`,
  `/forge help`, `/pack help`, `/setup help`) no longer flash closed from the
  same Enter that submitted the command; richer help menus with a clear Done row.


## [1.0.2] - 2026-08-10

### Fixed

- Slash-command dialogs (`/help`, setup, doctor, …) use nearly the full
  terminal: list content starts at the top of the panel instead of leaving a
  large empty upper half.


## [1.0.1] - 2026-08-10

### Changed

- **Occam simplify:** one model map (`profiles.*` canonical; `roles.*` optional
  auto overrides; orchestration primaries are legacy fallback).
- **Implement permissions:** inherit session `/permissions` by default;
  `auto.forceSandbox` forces Docker sandbox for implement (fail closed).
  Legacy `auto.implementPermissionProfile` / `ALLOY_IMPLEMENT_PROFILE` still work.
- **Policy packs** are model-agnostic (posture only: forceSandbox, budgets, counts).
- **Identity** is env-only (`ALLOY_AGENT_ID`); no config.identity block required.
- **`/setup`**: one path for fusion → fission reminder → auto setup.
- README and `/help` rewritten around the three-layer operator model (Chat ·
  Workflows · Policy).

## [1.0.0] - 2026-08-10

### Added

- **`/auto setup`** and **`/auto status`** for implement role models and
  implement permission profile (default **sandbox**).
- Local policy packs: **`/pack list`** · **`/pack apply ship|incident|economy`**
  (presets only; fission model routes are preserved).
- Alloy-native agent identity: `ALLOY_AGENT_ID` or `identity.id` in config, plus
  append-only run index at `~/.pi/alloy/runs/index.jsonl` (`/runs`, `alloy runs`).
- Non-interactive CLI: `alloy fission`, `alloy forge`, `alloy runs` with exit
  codes `0` / `1` / `2` for CI.
- Example GitHub Actions fission gate: `docs/ci/github-actions-fission.yml`.
- Installer **stable** channel (`ALLOY_CHANNEL=stable` default; falls back to
  `main` when no GitHub release exists).

### Changed

- Implement phase for `/auto` and `/forge` defaults to **sandbox** permission
  profile; Docker unavailability fails closed (no silent downgrade). Override
  with `auto.implementPermissionProfile` or `ALLOY_IMPLEMENT_PROFILE`.
- Package version **1.0.0** (root and TUI package versions stay aligned).

## [0.8.4] - 2026-07-31

### Fixed

- Existing installs with Alloy's generated 0.8.2 hosted-only provider allowlist
  now gain implicit Ollama, llama.cpp, and LM Studio discovery after upgrade.
  Customized allowlists and explicit local-engine settings remain authoritative.

## [0.8.3] - 2026-07-30

### Added

- Auto-discovery for local engines: Ollama, llama.cpp, and LM Studio (zero-config
  `/model` and `--list-models` when servers are up). Auto-discovered llama.cpp
  models use `llama.cpp-local` to preserve Pi's native provider and `/llama`.
- `/doctor` and `/providers` report local engine reachability and model counts
  (never secrets).
- Config: `providers.local.{enabled,ollama,llamaCpp,lmStudio}` and default
  allowlist entries for the three providers.
- Added a native responsive Fusion dashboard that streams bounded Architect,
  Builder, and Synthesizer model output and read-tool activity while preserving
  the final attributed transcript and generic RPC widget fallback.

### Changed

- Replaced generic Fusion workers/build mode with a bounded read-only Architect,
  Builder, and Synthesizer workflow using provider-scoped ephemeral credentials
  and mechanically repository-confined read tools.
- Prepared organization-neutral open-source packaging and community policies.
- Pinned executable dependencies and added a release-included npm shrinkwrap.
- Added packed-artifact startup, release metadata, SBOM, and security gates.
- Required HTTPS for non-loopback remote MCP and hardened local MCP secrets-file handling.
- Added explicit `allowQuery` opt-in for reviewed remote MCP endpoints that
  require non-secret routing parameters while retaining default rejection.
- Switched the coding-agent runtime to Alloy's integrity-pinned Pi 0.82.1 fork,
  adding a fixed transcript viewport, independent transcript navigation, and
  width-safe user-message rails while retaining Pi's native authentication,
  session, command, tool, and extension APIs. Source installs now use Alloy's
  root shrinkwrap to pin the resolved Pi 0.82.1 transitive graph.
- Updated the forked terminal runtime with mouse-wheel transcript scrolling,
  sticky-tail restoration, image-safe navigation, and sanitized model activity
  labels. Both coding-agent and TUI artifacts are source- and integrity-pinned.
- Unified OpenTUI slash-command metadata across autocomplete and searchable help,
  and added a quiet first-run command-discovery hint.

### Fixed

- Bounded local-engine response bodies and aggregate probes, redacted endpoint
  credentials, rejected malformed catalogs, preserved optional inference keys,
  and removed stale auto-discovered catalogs when an engine is disabled or
  unavailable without overriding manual `models.json` providers. Keyless
  inference no longer sends placeholder bearer credentials.
- Existing configs with an explicit hosted-only `providers.allow` array must add
  `ollama`, `llama.cpp-local`, and `lm-studio` to enable local discovery.

- Preserved malformed or non-object Pi settings instead of replacing them with
  Alloy startup defaults, with a path-specific warning before startup continues.
- Prevented Fusion child output from growing quadratically by using compact JSON
  deltas, bounded newest-event retention, byte-accurate UTF-8 stream handling,
  and preserved partial output when a child exceeds its stream safety limit.
- Bounded live Fusion model-output repaints while preserving immediate tool and
  terminal transitions, expanded display redaction for common credential forms,
  and made newest-output previews terminal-cell aware.
- Restored the transient green copy confirmation after mouse-selection clipboard
  writes complete.
- Fixed completed browser-based provider logins leaving an orphaned fallback
  prompt or unfocused composer, and added green `configured` and gray
  `not configured` status labels to every provider in `/login`.
- Kept slash autocomplete available beside retained workflow panels, preserved
  long command names on compact terminals, and expanded recognized prompt and
  skill commands correctly when submitted during streaming.

## [0.8.2] - 2026-07-24

### Added

- Multi-provider Pi harness with memory, skills, MCP, policy modes, agents,
  checkpoints, worktrees, diagnostics, and optional Docker sandboxing.
