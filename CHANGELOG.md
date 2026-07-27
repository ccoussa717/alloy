# Changelog

All notable changes to Alloy will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use semantic versioning during the 0.x development series.

## [Unreleased]

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

## [0.8.2] - 2026-07-24

### Added

- Multi-provider Pi harness with memory, skills, MCP, policy modes, agents,
  checkpoints, worktrees, diagnostics, and optional Docker sandboxing.
