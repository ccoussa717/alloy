# Changelog

All notable changes to Alloy will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- **Maintainers can smoke-test an exact release candidate against one pinned
  SWE-bench Lite instance.** Fast model-free contract tests run in Linux CI,
  while source-only commands bootstrap the evaluator and verify immutable
  candidate provenance through `dry-run` without adding benchmark tooling or
  Python dependencies to installed or packed Alloy runtimes. Real execution
  fails closed pending trusted agent isolation and immutable dataset/evaluator
  integrity pins.

## [1.1.25] - 2026-08-17

### Fixed
- **Long local-model turns recover instead of ending on a one-token fragment.**
  When context pressure makes a provider stop below the configured output
  limit, Alloy now compacts the session and retries the interrupted turn once.
  Genuine output-limit completions remain terminal, non-token OpenAI failures
  are not retried, and a response is preserved when there is not enough history
  to compact. Alloy pins the matching coding-agent, AI, and TUI artifacts so
  those provider stop reasons remain intact in an installed release.

## [1.1.24] - 2026-08-16

### Fixed
- **Claude, Codex, and Grok authentication no longer loops back to login for
  recoverable failures.** `/doctor` and `/providers` now use Pi's native auth
  resolver, which refreshes and persists expired OAuth credentials under Pi's
  credential lock. Temporary provider failures report retry guidance, quota
  failures explain the actual remedy, and only rejected authorizations ask for
  a new login. Startup remains network-free. This fixes main-session
  diagnostics; routed child agents still receive a launch-scoped credential.

## [1.1.23] - 2026-08-16

### Fixed
- **Long Ollama sessions compact before exhausting the model context.** Alloy
  requests and persists streaming token usage from Ollama, allowing Pi to
  summarize growing conversations instead of silently stopping at the context
  boundary.

## [1.1.22] - 2026-08-16

### Fixed
- **Local Ollama agents can now budget against the server's runtime context.**
  Alloy distinguishes that limit from a model's architectural maximum when an
  explicit `num_ctx` or matching `OLLAMA_CONTEXT_LENGTH` is available, and sends
  Ollama reasoning effort controls including `none`.
- **Source releases pass the high-severity dependency gate.** Patched transitive
  versions of `brace-expansion`, `undici`, `fast-uri`, `ip-address`, and `hono`
  replace versions covered by current security advisories.

## [1.1.20] - 2026-08-15

### Fixed
- **New Ollama models no longer disappear behind a manual catalog.** Alloy
  merges live discovery with `models.json`: manual model metadata and provider
  settings still win, while newly pulled and manual-only models both remain
  available. Invalid manual configuration fails closed through Pi's canonical
  loader.

## [1.1.19] - 2026-08-13

### Changed
- **Escape interrupts a thinking model.** With no dialog or slash palette
  open, Esc aborts the live turn (same as Ctrl+C during a run).
- **Enter updates the live turn.** A new chat message while the model is
  thinking or using tools aborts that turn and sends the new instruction
  immediately, instead of waiting in the follow-up queue.

## [1.1.18] - 2026-08-13

### Fixed
- **Auto stops on scout/plan failure.** A failed scout or plan no longer
  continues into implement with `"(none)"`.
- **Fission subject fallback is fail-closed.** CLI does not silently review
  the prompt. A thrown dirty-tree capture honors `allowSubjectFallback` and
  confirm. TUI confirm errors or a missing UI decline the fallback.
- **Reviewer verdict requires `VERDICT: PASS|FAIL`.** A last-line bare PASS
  no longer counts.
- **Fusion names missing contract headings** on FAILED / invalid_proposal.
- **Forge `/runs` keeps the project cwd** on every early finish path.
- **Trusted project config cannot weaken implement approvals.**

## [1.1.17] - 2026-08-13

### Fixed
- **Lease handoff fails closed.** A child that requires a runtime credential
  exits instead of continuing after a failed key install.
- **Trusted project config cannot loosen isolation.** `.pi/alloy.json` may not
  set `auto.forceSandbox=false` or `auto.useWorktree=false` against a tighter
  global. Corrupt project JSON is ignored instead of merged.
- **Corrupt `config.json` no longer loads factory defaults.** A broken operator
  file throws instead of silently re-enabling MCP and factory Claude.
- **`/agent model=` is exact.** An explicit requested model is not replaced by
  a role fallback. Routing fails closed if that model is ineligible.
- **INCOMPLETE is no longer one bucket.** Fission headlines and schema messages
  name the reason (`source_drift`, packet evidence, repo not ready, etc.).
- **Repo fission is honest.** Status, results, and `/status` say dirty-tree vs
  HEAD — not a whole-repository review.
- **Slash palette survives a space.** Completing `/fission ` keeps the command
  visible instead of killing autocomplete.
- **Dialog Enter no longer submits the composer.** Notifications dismiss with
  Esc and info toasts expire; failed submits restore or name the dropped text.
- **`alloy_fission` hydrates.** Tool results render the fission transcript, not
  a stub line dump.

### Added
- **`/status` launch preview** across Fusion, Fission, and Auto — setup-pinned
  routes vs factory defaults.

## [1.1.16] - 2026-08-13

### Fixed
- **Setup is the runtime.** Fusion, Auto, and Forge launch the models
  operators pick in setup (exact routes). Complete `/fusion setup` routes
  keep exact-route validation, concurrency limits, budget reservations,
  credential isolation, and accurate role attribution; partial legacy
  Fusion setup stays on generic orchestration. Fusion/Auto setup also
  align orchestration role primaries so `/status` and the run cannot drift.
- **TUI busy = live workflow.** Fusion/Fission dashboards count as busy:
  follow-ups queue as steer, Ctrl+C aborts instead of exiting, the footer
  shows the phase, and heartbeat refresh no longer wipes running tools or
  error banners.
- **Forge and Auto fail closed.** Auto requires a successful build and an
  explicit `VERDICT: PASS`. Forge fails unless post-diff fission is
  `COMPLETE`/`PASS` (or `NO_CHANGES`). Post-diff review is repo-mode only
  and never falls back to reviewing the prompt.
- **Provider API errors surface.** Children map Anthropic/etc. usage and
  stopReason errors instead of empty/`proposal ready`.
- **Fission setup rejects duplicate specialties** before spend. Interactive
  `/fission` confirms before falling back from a dirty tree to subject
  review.

## [1.1.15] - 2026-08-12

### Fixed
- **Working indicator animation:** the footer activity bar animates again
  (including over SSH), uses a 25% shorter track (6 cells), and steps at 120ms
  for a smoother left↔right bounce. Set `ALLOY_ACTIVITY_ANIMATION=off` to
  disable, or a millisecond value (30–2000) to tune speed.

## [1.1.14] - 2026-08-12

### Changed
- **Fission judge always on.** Restored the full adjudicator path for every
  `/fission` run (interactive and CLI). Removed the optional report-only
  `fission.judgeEnabled` switch and the setup on/off prompt. N reviewers always
  feed one independent PASS/FAIL judge.

## [1.1.13] - 2026-08-12

### Added
- **Composer command history:** Up/Down in the input line cycles through previously
  submitted prompts and slash commands (readline-style). History is persisted under
  `~/.pi/alloy/command-history.json` (last 200 entries). Multi-line edits still use
  Up/Down for cursor movement when not on the first/last line; slash autocomplete
  keeps Up/Down for suggestion selection.

## [1.1.12] - 2026-08-12

### Added
- **Optional Fission judge.** Interactive `/fission` defaults to **report only**
  (no adjudicator): side-by-side reviewers complete without a PASS/FAIL gate.
  Enable the judge for a real gate via `/fission setup` or `fission.judgeEnabled: true`.
  CLI and Forge still enable the judge by default. *(Superseded by 1.1.14 —
  judge is always on again.)*

## [1.1.11] - 2026-08-12

### Fixed
- **Fission judge timeout:** the shared reviewer-plus-judge deadline now defaults
  to 15 minutes instead of 5 and is operator-configurable with
  `fission.workflowTimeoutMs` (1 minute to 24 hours). Forge uses the same
  configured deadline for its plan and post-diff fission phases.

## [1.1.10] - 2026-08-12

### Fixed
- **Fission result UX** cleaned up to match Fusion: full-height expandable
  side-by-side panes (no nested teeny scrollboxes), consistent findings-first
  body text, chrome in the pane header, live dashboard cleared when the run
  finishes so the transcript comparison is the primary interaction.

## [1.1.9] - 2026-08-12

### Added
- **Fission result transcript** mirrors Fusion: side-by-side scrollable reviewer
  panes + judge in the main transcript (no more dead-end “Done” modal).

### Fixed
- **Live streaming for fission children.** Output-limited child agents still
  emit `text_delta` to the panel (raw update events stay unretained for safety).
- Live fission panes show multi-line streaming output instead of a one-line tail.

### Fixed

- Backend slash commands remain dispatchable while a response is streaming,
  including `/help`; command names are canonicalized and tabs/newlines are
  accepted as argument separators.

## [1.1.8] - 2026-08-11

### Fixed

- **Fission streaming UI actually shows in Alloy OpenTUI.** Alloy always runs Pi
  in `--mode rpc`; v1.1.7 sent `alloy.fission.live` data the TUI dropped because
  only `alloy.fusion.live` was parsed. OpenTUI now renders a Fission live dashboard
  (reviewer panes + judge), and RPC fallback lines use stream panes not the status list.
- Local installs on 1.1.6 still hit hard `reviewer_errors` for soft-omitted paths;
  ensure you restart Alloy after upgrading to ≥1.1.7/1.1.8.

## [1.1.7] - 2026-08-11

### Added

- **Streaming multi-pane UI for `/fission`** (and shared path for `/fusion` /
  `/auto` / `/forge`): live side-by-side reviewer panes with token/tool stream,
  judge pane while adjudicating, and RPC live snapshots (`alloy.fission.live`).

### Fixed

- `/fission` no longer aborts as **`reviewer_errors`** when a reviewer returns
  real findings plus informational `errors[]` notes (e.g. soft-omitted
  `.worktrees/` paths). Those notes are stored as `warnings`; hard-fail only
  when `errors[]` is non-empty **and** findings are empty. Host verdict uses
  the same rule so COMPLETE/PASS is reachable after soft-omits.

## [1.1.6] - 2026-08-11

### Fixed

- `/fission` no longer looks idle while working: live agent panel + status updates
  as the packet freezes and each reviewer/judge starts and finishes, plus an
  immediate “Fission starting…” notification.

## [1.1.5] - 2026-08-11

### Fixed

- Fission **dirty-tree capture** no longer dies on untracked directories / nested
  git worktrees (e.g. `.worktrees/feat/…`) with `unsupported_type:…`. Those paths
  are soft-omitted. In **auto** mode, if the dirty tree still has nothing
  reviewable, Fission falls back to **subject** review of the request text
  instead of INCOMPLETE with zero agents.

## [1.1.4] - 2026-08-11

### Fixed

- Fission no longer fails with **`custom_transport_unavailable`** for legitimate
  catalog models (e.g. `openai-codex/gpt-5.6-luna`) when the session registry
  only drifts cost/compat/thinking metadata. Trust now keys on core transport
  (provider, id, api, baseUrl), not a full deep-equal of the model blob.

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
