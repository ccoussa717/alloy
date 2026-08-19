# SWE-bench Release Smoke

This maintainer-only gate runs one pinned SWE-bench Lite instance against an
exact Alloy release candidate. It is a one-instance smoke, not an Alloy
SWE-bench score, and is not an end-user Alloy command or dependency.

## Prerequisites

- Python 3.11 or newer. CI uses Python 3.12 for the fast test suite.
- A local Ollama service on loopback with `qwen3.8-alloy:latest` installed at
  digest `116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba`.
- A Git checkout with no tracked changes whose `HEAD` is a full commit SHA
  pushed to the canonical credential-free GitHub remote. The default remote
  name is `github`; set `ALLOY_BENCH_REMOTE` only when the same canonical URL
  uses another name.
- Outbound GitHub and codeload access for remote-tip verification and the exact
  candidate install.
- Outbound Hugging Face dataset access for `SWE-bench/SWE-bench_Lite` and Python
  package index access for setup.

The real `release` command also requires a reachable, functioning Docker daemon
that can start the official SWE-bench containers. Target repository clone access
and the image and registry access required by
SWE-bench's official evaluator. An installed Docker CLI alone is insufficient.

Bootstrap the pinned `swebench==5.0.0` environment:

```bash
bash scripts/run-swebench-release-smoke.sh setup
```

The environment is created at the ignored path `benchmarks/swebench/.venv/`.
It is release tooling only; Python and SWE-bench are not Alloy runtime
dependencies.

If the canonical GitHub remote has another local name, pass that name without
changing its URL:

```bash
ALLOY_BENCH_REMOTE=origin bash scripts/run-swebench-release-smoke.sh dry-run
```

## Fast Tests

```bash
bash scripts/run-swebench-release-smoke.sh test
```

The fast suite validates the profile, command construction, provenance checks,
privacy boundaries, artifact handling, failure reporting, and candidate wrapper
with fixtures. It does not contact Ollama or the SWE-bench dataset, invoke an
autonomous Alloy attempt, start Docker evaluation, install a real candidate, or
produce an official verdict. Normal CI runs these tests only.

All benchmark commands are source-only wrapper subcommands. Root and packed
`package.json` metadata intentionally contain no benchmark command. The
release-only `benchmarks/` tree and
`scripts/run-swebench-release-smoke.sh` are excluded from `npm pack`. The source
installer also removes both from the installed application after validating the
source snapshot, so benchmark tooling is not shipped in Alloy's runtime.

## Candidate Gate

After green CI, push the exact candidate commit before either command. The
wrapper rejects tracked changes, malformed SHAs, credentialed or noncanonical
remote URLs, and commits that merely exist in remote history: local `HEAD` must
equal an advertised non-peeled ref tip on the canonical GitHub remote.

First verify candidate installation and provenance plus the model, evaluator,
and dataset handoff without cloning the target repository, running the agent,
or starting Docker evaluation:

```bash
bash scripts/run-swebench-release-smoke.sh dry-run
```

After reviewing that result, a maintainer may authorize exactly one real
attempt:

```bash
bash scripts/run-swebench-release-smoke.sh release
```

There is no automatic retry. The wrapper invokes the installer and runner once;
the real runner invokes Alloy once and the official evaluator once. Do not turn
an infrastructure failure into an undocumented retry. Any additional attempt
requires a new explicit maintainer decision and must be reported separately.

## Candidate And State Isolation

The wrapper archives `package.json`, `install.sh`, and the complete benchmark
tree from the exact candidate SHA. It executes that immutable installer and
benchmark snapshot rather than mutable working-tree files. The installer is
pinned to the same SHA and writes the candidate under a temporary `ALLOY_PREFIX`
and temporary HOME/XDG directories; the wrapper verifies the installed package,
CLI version, Pi version, and install-manifest commit before launch. That
temporary candidate installation is removed when the wrapper exits.

The autonomous process receives an explicit environment allowlist: terminal and
locale values, `PATH`, a loopback-only `OLLAMA_HOST`, and fresh per-run HOME/XDG
and temporary directories under the ignored `benchmarks/swebench/.work/` tree.
Host credentials and unrelated environment variables are not intentionally
forwarded. The dataset row is stripped of `patch` and `test_patch` before prompt
construction.

Host mode is not a filesystem jail; Alloy runs as the maintainer's Unix user.
The disposable home and environment allowlist reduce ambient state, but they do
not prevent the process from reading files that Unix user can access. The runner
does not intentionally inject host credentials or environment variables,
dataset gold fields, or evaluator scripts into persisted artifacts.

Before any attempt, the runner binds the manifest to the candidate commit,
installed manifest, Alloy and Pi versions, exact Ollama digest, SWE-bench
version, dataset, instance, and commands. Any provenance drift fails before the
agent starts.

## Artifacts

Each invocation prints its newly created directory under:

```text
benchmarks/swebench/results/alloy-<version>-<UTC timestamp>/
```

The ignored result directory has a phase-dependent safe allowlist:

- Every attributable run has `manifest.json` and `summary.json`.
- After dataset loading, `problem.md` contains only the public issue prompt.
- A real agent attempt may add `alloy.stdout.log`, `alloy.stderr.log`,
  `model_patch.diff`, and the official one-line `predictions.jsonl`.
- Evaluation may add only `evaluation/official-summary.json`,
  `evaluation/stdout.log`, and `evaluation/stderr.log`.

Evaluator scratch, including generated evaluator scripts such as `eval.sh` and
hidden test material, is deleted after the allowlisted evaluation files are
copied. The wrapper accepts only the new result path whose pointer and manifest
match this invocation's candidate SHA, run token, canonical results root, and
installed candidate root.

Agent/evaluator stdout/stderr, model patches, and official summaries are
untrusted and may contain sensitive content produced or read by those
processes. Maintainers must inspect persisted artifacts before sharing,
attaching, or releasing them. The artifact allowlist limits file names and
provenance; it is not a content-sanitization or confidentiality boundary.

## Status And Verdicts

The shell exit is authoritative. Exit `0` means either a completed `dry_run` or
an `evaluated` summary with an official verdict; inspect `summary.json` to tell
which. Wrapper preflight/install/pointer failures exit nonzero (invalid usage is
`64`). Runner exits and terminal summary statuses are:

| Exit | `summary.json` status | Meaning |
|---:|---|---|
| 0 | `dry_run` | Provenance and dataset handoff passed; no agent or evaluator ran. |
| 0 | `evaluated` | Official evaluation completed; `verdict` is `resolved` or `unresolved`. |
| 2 | `runtime_failure` | Candidate, install, version, model, or evaluator provenance failed. |
| 3 | `dataset_failure` | The pinned dataset instance could not be loaded or matched. |
| 4 | `checkout_failure` | The target repository/base commit could not be prepared. |
| 5 | `agent_timeout` | The single Alloy attempt exceeded 1,800 seconds. |
| 6 | `agent_failure` | The single Alloy attempt failed. |
| 7 | `patch_capture_failure` | The candidate patch could not be safely captured. |
| 8 | `evaluator_timeout` or `evaluator_failure` | Official evaluation timed out, failed, reported an infrastructure/error category, or supplied no valid verdict. |

`resolved` and `unresolved` are both valid official outcomes for this
one-instance release smoke. `unresolved` includes an official empty patch. They
are derived only from the persisted schema-v2 official summary; logs, exit zero
alone, and human interpretation cannot substitute for that summary.

At the release-policy level, `infrastructure_failure` means no valid official
`resolved` or `unresolved` verdict exists. This includes every non-evaluated
terminal status and any missing, invalid, ambiguous, error, or infrastructure
official summary. An `infrastructure_failure` is the truthful absence of an
official verdict, never a third official evaluator verdict and never evidence
that the gate ran successfully.
