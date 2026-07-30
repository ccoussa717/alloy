# Changelog

All notable changes to Alloy will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use semantic versioning during the 0.x development series.

## [Unreleased]

### Added

- Auto-discovery for local engines: Ollama, llama.cpp, and LM Studio (zero-config
  `/model` when servers are up).
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
