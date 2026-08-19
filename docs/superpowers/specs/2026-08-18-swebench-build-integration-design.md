# Alloy SWE-bench Build Integration Design

## Goal

Move the reviewed one-instance SWE-bench Lite adapter into Alloy's canonical
GitHub source line so benchmark contracts travel with the build they evaluate.
Fast, model-free tests run in normal CI. A real 30-minute model and Docker run
remains an explicit release-candidate gate.

The integration targets GitHub `main` beginning at Alloy `1.1.25`. It does not
target the unrelated GitLab `0.8.2` history.

## Product Boundary

SWE-bench support is repository-owned release tooling, not an end-user Alloy
feature. Operators do not receive Python, SWE-bench, benchmark fixtures, or
benchmark commands in an installed Alloy application.

The source repository contains the adapter under `benchmarks/swebench/`. Per
the user's final command-boundary resolution, every benchmark operation uses
the source-only `scripts/run-swebench-release-smoke.sh` wrapper. Root, installed,
and packed package metadata contains no benchmark command. CI invokes the
wrapper's fast test subcommand directly. The source installer explicitly
removes `benchmarks/` before it commits the installed application tree.
Installer and release tests must prove that exclusion.

Generated virtual environments, candidate installs, checkouts, evaluator
scratch, logs, and result artifacts remain ignored and uncommitted.

## Repository Layout

The integration uses these boundaries:

- `benchmarks/swebench/runner.py`: dataset, agent, patch, artifact, and official
  evaluator orchestration.
- `benchmarks/swebench/profile.json`: immutable benchmark inputs that are not
  properties of the Alloy build, including dataset, split, instance, base
  commit, model name and digest, evaluator version, and timeouts.
- `benchmarks/swebench/requirements.txt`: exact official evaluator dependency.
- `benchmarks/swebench/tests/`: model-free Python contract and orchestration
  tests.
- `benchmarks/swebench/README.md`: maintainer bootstrap, dry-run, release-gate,
  artifact, and verdict instructions.
- `scripts/run-swebench-release-smoke.sh`: fail-closed candidate installation
  and one-shot release gate.
- Root `package.json`: no benchmark script key or value.
- `.github/workflows/ci.yml`: pinned Python setup and a direct source-only
  `bash scripts/run-swebench-release-smoke.sh test` invocation.

The benchmark directory is not added to `package.json.files` and is removed
from the source installer's staged application before installation.

## Build Integration

Normal Linux CI installs a pinned supported Python version and runs
`bash scripts/run-swebench-release-smoke.sh test` without installing
`swebench`, loading a model, or starting Docker. This direct workflow step keeps
the test mandatory without routing release tooling through package metadata.
Every existing Node, TUI, integration, security, and release check remains.

The source-only wrapper provides one stable maintainer interface:

- `bash scripts/run-swebench-release-smoke.sh test`: run fast Python tests.
- `bash scripts/run-swebench-release-smoke.sh setup`: create or update the ignored benchmark virtual environment and
  install the pinned evaluator.
- `bash scripts/run-swebench-release-smoke.sh dry-run`: validate candidate, model, evaluator, and dataset
  provenance without starting an autonomous attempt or Docker evaluation.
- `bash scripts/run-swebench-release-smoke.sh release`: execute the isolated candidate installation and
  one real smoke attempt.

The real smoke is not placed in hosted CI. It requires local Ollama, the pinned
17 GB model, Docker, public dataset access, and up to roughly 70 minutes across
the agent and evaluator limits. Running it on every hosted build would be slow,
hardware-specific, and nondeterministic.

## Candidate Installation

The release wrapper evaluates the exact pushed GitHub commit under review, not
the machine's existing stable Alloy command and not an uninstalled source
launcher.

Before installation it must:

1. Require a clean tracked worktree.
2. Resolve `HEAD` to a full commit and prove the commit is reachable from the
   configured GitHub remote.
3. Refuse an unpushed or ambiguous candidate.
4. Read the expected Alloy version and Pi provenance from the candidate source.

The wrapper creates disposable `HOME`, `XDG_DATA_HOME`, `ALLOY_PREFIX`, and
temporary paths. It invokes the real `install.sh` with `ALLOY_REF` set to the
candidate commit, verifies the resulting install manifest and `alloy --version`,
then passes the installed candidate command to the Python runner explicitly.

The wrapper starts the runner exactly once. A failed, unresolved, or timed-out
agent attempt is never retried automatically.

## Benchmark Profile And Provenance

Build provenance and benchmark-profile provenance are separate.

The runner derives expected Alloy and Pi values from the candidate source and
checks them against the isolated installed command. This allows the tool to
follow future Alloy releases without hard-coding `1.1.25` in executable code.

`profile.json` pins the experiment inputs:

- Dataset `SWE-bench/SWE-bench_Lite`, split `test`.
- Instance `astropy__astropy-12907`.
- Base commit `d16bfe05a744909de4b27f5875fe0d4ed41ce607`.
- Model `ollama/qwen3.8-alloy:latest` and its reviewed local digest.
- `swebench==5.0.0`.
- One 1,800-second Alloy attempt and a bounded evaluator timeout.

Each manifest records the candidate Git commit, installed manifest provenance,
observed Alloy/Pi versions, model digest, evaluator version, exact public
instance identity, commands with prompt content redacted, and timestamps.

## Data And Execution Flow

The runner performs this sequence:

1. Validate the profile schema and candidate metadata.
2. Create a unique ignored result directory and write the manifest before
   loading the dataset.
3. Probe the installed candidate, local Ollama inventory, and evaluator version.
4. Load exactly one dataset row and remove `patch` and `test_patch` before any
   prompt or log is built.
5. Clone the target repository at the exact base commit.
6. Run the installed candidate once in print mode with a minimal environment,
   disposable home/XDG state, fixed timeout, and full process-group cleanup.
7. Capture tracked and untracked non-ignored binary changes without mutating the
   checkout index.
8. Write the official one-line prediction record.
9. Run the official evaluator in disposable ignored scratch.
10. Persist only the official schema-v2 summary plus evaluator stdout/stderr,
    then delete scratch containing evaluator scripts and hidden material.
11. Derive `resolved` or `unresolved` only from the official summary.

## Failure And Privacy Model

Typed command failures distinguish nonzero exits from real wall-clock timeouts.
Agent and evaluator stdout/stderr are written to dedicated files on both
success and failure; summaries contain bounded metadata rather than complete
streams.

Terminal statuses distinguish runtime provenance, dataset, checkout, agent,
patch capture, evaluator, and evaluator-timeout failures. An official empty
patch is a valid `unresolved` result. Official infrastructure, ambiguous, or
error categories are infrastructure failures. Missing official output is never
reported as resolved or unresolved.

The autonomous process receives only an explicit environment allowlist and
disposable state directories. The runner never persists environment variables,
credentials, dataset gold patches, hidden test patches, generated evaluator
scripts, or unrelated host files. Ollama probes are loopback-only and bypass
proxy configuration.

## Release Policy

Fast benchmark tests are mandatory in normal CI. The real smoke is a manual
release-candidate gate documented in `docs/RELEASING.md`.

The command always reports one of:

- `resolved`: the official evaluator passed the pinned instance.
- `unresolved`: the official evaluator completed and failed or received an
  empty patch.
- `infrastructure_failure`: no valid official verdict exists.

Only a completed official `resolved` or `unresolved` verdict satisfies the
benchmark execution portion of release readiness. The verdict is a one-instance
smoke and must never be presented as an Alloy SWE-bench score. Release authority
remains with the maintainer; the benchmark command never tags, publishes, or
releases Alloy.

## Historical Run

The original Alloy `1.1.25` attempt reached the fixed 1,800-second agent timeout
without producing a patch. It is correctly classified as
`infrastructure_failure`. Its generated local artifacts remain historical
evidence outside Git and are not rerun or imported into the repository.

## Verification

Implementation is complete when:

- The migrated Python suite and integration-specific regressions pass.
- Root, source-installed, and packed package script metadata contains no
  `swebench` key, value, or wrapper path.
- GitHub CI runs the fast benchmark suite with pinned Python.
- Installer tests prove `benchmarks/` is absent from the installed application.
- Release verification proves benchmark tooling is absent from packed runtime
  boundaries.
- Candidate-wrapper tests reject dirty, unpushed, mismatched, or stale builds
  and construct the isolated installer invocation exactly.
- A dry-run against an isolated candidate install records matching commit,
  Alloy, Pi, model, and evaluator provenance without launching an autonomous
  attempt or Docker evaluator.
- Existing Alloy unit, TUI, PTY, integration, installer, security, audit, and
  release checks remain green.

The implementation does not perform another real Alloy SWE-bench attempt. A
future maintainer runs the manual release gate once for the release candidate.
