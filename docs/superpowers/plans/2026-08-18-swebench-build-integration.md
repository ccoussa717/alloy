# Alloy SWE-bench Build Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the reviewed one-instance SWE-bench Lite adapter into Alloy's GitHub build as fast CI-tested release tooling with a fail-closed manual gate for an isolated installed release candidate.

**Architecture:** Preserve the reviewed Python adapter under `benchmarks/swebench/`, move experiment inputs into an immutable profile, and derive Alloy/Pi expectations from the candidate source and isolated install. Root npm scripts and GitHub CI run only fast model-free tests; a shell wrapper installs one pushed candidate SHA through the real source installer before a single optional model/Docker run.

**Tech Stack:** Python 3.11+ standard library with Python 3.12 pinned in CI, `swebench==5.0.0`, Node.js 22 test runner, Bash, Git, GitHub Actions, Alloy source installer, Docker, Ollama `qwen3.8-alloy:latest`.

## Global Constraints

- Target the GitHub Alloy history beginning at `github/main` commit `77bc817ecc3142dc175a716453754c2115c2ebf0`; do not merge or copy commits from the divergent GitLab `origin/main` history.
- Benchmark tooling is repository-owned release tooling and must be absent from the installed Alloy application and packed runtime boundary.
- Dataset is `SWE-bench/SWE-bench_Lite`, split `test`, instance `astropy__astropy-12907`, base commit `d16bfe05a744909de4b27f5875fe0d4ed41ce607`.
- Never expose dataset fields `patch` or `test_patch` to Alloy, logs, manifests, or persisted evaluator artifacts.
- Model is `ollama/qwen3.8-alloy:latest` with reviewed digest `116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba`.
- Evaluator dependency is exactly `swebench==5.0.0` in `benchmarks/swebench/.venv`.
- A real smoke uses one fresh autonomous Alloy attempt, a fixed 1,800-second timeout, and no retry.
- The candidate must be a clean full Git commit SHA advertised by the configured GitHub remote and installed through `install.sh` into disposable `HOME`, `XDG_DATA_HOME`, and `ALLOY_PREFIX` paths.
- Fast benchmark tests run in normal CI; the real model and Docker smoke remains a manual release-candidate gate.
- Preserve typed subprocess failures, complete process-group timeout cleanup, dedicated stdout/stderr artifacts, untracked binary patch capture, disposable evaluator scratch, and official schema-v2 verdict classification.
- Generated virtual environments, candidate installs, worktrees, results, and evaluator scratch stay ignored and uncommitted.
- Do not rerun the historical Alloy `1.1.25` benchmark attempt during implementation; it remains an `infrastructure_failure` caused by the fixed agent timeout.

---

## File Map

- Create `benchmarks/__init__.py`: package marker for repository benchmark tooling.
- Create `benchmarks/swebench/__init__.py`: package marker for the SWE-bench adapter.
- Create `benchmarks/swebench/runner.py`: reviewed adapter, parameterized by profile and candidate metadata.
- Create `benchmarks/swebench/profile.json`: pinned dataset, model, evaluator, and timeout inputs.
- Create `benchmarks/swebench/requirements.txt`: pinned official evaluator dependency.
- Create `benchmarks/swebench/tests/__init__.py`: test package marker.
- Create `benchmarks/swebench/tests/test_runner.py`: migrated and extended Python contract tests.
- Create `benchmarks/swebench/tests/test_release_wrapper.py`: candidate-wrapper behavior tests with fake Git and installer commands.
- Create `benchmarks/swebench/README.md`: maintainer usage and verdict contract.
- Create `scripts/run-swebench-release-smoke.sh`: candidate preflight, isolated install, and one-shot runner entry point.
- Create `test/unit/swebench-build.test.mjs`: npm, CI, package, installer, and release-policy wiring tests.
- Modify `.gitignore`: exclude benchmark-local environments, work, results, and candidate state.
- Modify `package.json`: add benchmark scripts and include fast tests in `test:all`.
- Modify `.github/workflows/ci.yml`: pin Python 3.12 before normal verification.
- Modify `install.sh`: remove `benchmarks/` from the staged installed application.
- Modify `test/integration/packed-install.e2e.test.mjs`: prove benchmark tooling is absent after source installation.
- Modify `scripts/verify-release.mjs`: reject accidental benchmark inclusion in the package file boundary.
- Modify `docs/RELEASING.md`: add the manual release-candidate benchmark gate.
- Modify root `README.md`: link maintainers to benchmark documentation without presenting it as an end-user feature.

### Task 1: Preserve the Reviewed Adapter Inside Alloy

**Files:**
- Create: `benchmarks/__init__.py`
- Create: `benchmarks/swebench/__init__.py`
- Create: `benchmarks/swebench/runner.py`
- Create: `benchmarks/swebench/requirements.txt`
- Create: `benchmarks/swebench/tests/__init__.py`
- Create: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Consumes: reviewed standalone commit `e943f02574427c3021f2b713f8ed834b4399afa6` at `/home/chappie/alloy-bench/.worktrees/swebench-smoke`.
- Produces: importable module `benchmarks.swebench.runner` with the existing 42-test behavior unchanged.

- [ ] **Step 1: Copy the reviewed source without semantic edits**

Mechanically copy these exact committed files:

```text
/home/chappie/alloy-bench/.worktrees/swebench-smoke/swebench_runner.py
  -> benchmarks/swebench/runner.py
/home/chappie/alloy-bench/.worktrees/swebench-smoke/tests/test_swebench_runner.py
  -> benchmarks/swebench/tests/test_runner.py
/home/chappie/alloy-bench/.worktrees/swebench-smoke/requirements-swebench.txt
  -> benchmarks/swebench/requirements.txt
```

Create empty package markers:

```python
# benchmarks/__init__.py
```

```python
# benchmarks/swebench/__init__.py
```

```python
# benchmarks/swebench/tests/__init__.py
```

- [ ] **Step 2: Update only the test imports for the package location**

Replace the standalone import block in `benchmarks/swebench/tests/test_runner.py` with:

```python
from benchmarks.swebench import runner as swebench_runner
from benchmarks.swebench.runner import (
    alloy_command,
    build_prompt,
    capture_patch,
    evaluator_command,
    load_instance,
    official_verdict,
    prediction_record,
    public_instance,
    run_command,
    summarize_run,
    write_prediction_jsonl,
    write_json,
)
```

- [ ] **Step 3: Run the migrated suite and observe the location failures**

Run:

```bash
python3 -m unittest discover -s benchmarks/swebench/tests -v
```

Expected: tests import successfully, then location-sensitive assertions fail because `REPO_ROOT`, the default venv path, and standalone module patch strings still name `swebench_runner`.

- [ ] **Step 4: Make package-location-only adaptations**

At the top of `benchmarks/swebench/runner.py`, use separate roots:

```python
BENCH_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BENCH_ROOT.parents[1]
```

Change default generated paths in `main()` to:

```python
parser.add_argument("--results-root", type=Path, default=BENCH_ROOT / "results")
parser.add_argument("--work-root", type=Path, default=BENCH_ROOT / ".work")
parser.add_argument(
    "--venv-python",
    type=Path,
    default=BENCH_ROOT / ".venv" / "bin" / "python",
)
```

Update all mock targets from `swebench_runner.<name>` to
`benchmarks.swebench.runner.<name>`. Update expected module paths to `REPO_ROOT`
or `BENCH_ROOT` according to the definitions above. Do not change benchmark
constants or behavior in this task.

- [ ] **Step 5: Run the complete migrated suite**

Run:

```bash
python3 -m unittest discover -s benchmarks/swebench/tests -v
```

Expected: 42 tests PASS.

- [ ] **Step 6: Verify the migration against the reviewed source**

Run a normalized diff that ignores only the import path and root-location edits.
Confirm no subprocess, privacy, timeout, patch, evaluator, or verdict behavior
changed. Also run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 7: Commit the preserved adapter**

```bash
git add benchmarks
git commit -m "test: bring SWE-bench adapter into Alloy"
```

### Task 2: Separate Benchmark Profile from Candidate Provenance

**Files:**
- Create: `benchmarks/swebench/profile.json`
- Modify: `benchmarks/swebench/runner.py`
- Modify: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Consumes: Task 1's `benchmarks.swebench.runner` contracts.
- Produces: `BenchmarkProfile`, `CandidateMetadata`, `load_profile()`, `load_candidate_metadata()`, and CLI options `--profile`, `--alloy-bin`, `--candidate-root`, `--candidate-commit`, and `--install-manifest`.

- [ ] **Step 1: Add the immutable benchmark profile**

Create `benchmarks/swebench/profile.json`:

```json
{
  "agent_timeout_seconds": 1800,
  "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
  "dataset": "SWE-bench/SWE-bench_Lite",
  "evaluator_timeout_seconds": 2400,
  "instance_id": "astropy__astropy-12907",
  "model": "ollama/qwen3.8-alloy:latest",
  "model_digest": "116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba",
  "ollama_model": "qwen3.8-alloy:latest",
  "split": "test",
  "swebench_version": "5.0.0"
}
```

- [ ] **Step 2: Write failing profile and candidate tests**

Add tests covering these exact contracts:

```python
def test_profile_loads_exact_reviewed_inputs_and_rejects_unknown_keys(self):
    profile = swebench_runner.load_profile(PROFILE_PATH)
    self.assertEqual(profile.instance_id, "astropy__astropy-12907")
    self.assertEqual(profile.agent_timeout_seconds, 1800)
    self.assertEqual(profile.swebench_version, "5.0.0")
    self.assertRaisesRegex(
        RuntimeError,
        "unknown profile keys",
        swebench_runner.parse_profile,
        {**json.loads(PROFILE_PATH.read_text()), "unexpected": True},
    )


def test_candidate_metadata_comes_from_source_package_and_full_commit(self):
    metadata = swebench_runner.load_candidate_metadata(
        candidate_root=fixture_root,
        candidate_commit="a" * 40,
    )
    self.assertEqual(metadata.alloy_version, "1.1.25")
    self.assertEqual(metadata.pi_version, "0.82.1")
    self.assertEqual(metadata.commit, "a" * 40)


def test_candidate_metadata_rejects_short_commit_and_missing_pi_pin(self):
    with self.assertRaisesRegex(RuntimeError, "full candidate commit"):
        swebench_runner.load_candidate_metadata(fixture_root, "abc123")
    # Rewrite fixture package without alloy.piFork.version.
    with self.assertRaisesRegex(RuntimeError, "Pi version"):
        swebench_runner.load_candidate_metadata(fixture_root, "a" * 40)
```

Add a CLI test proving the command passed to Alloy uses the explicit candidate:

```python
def test_main_uses_explicit_candidate_binary_and_metadata(self):
    result = swebench_runner.main([
        "--profile", str(PROFILE_PATH),
        "--alloy-bin", "/candidate/bin/alloy",
        "--candidate-root", str(fixture_root),
        "--candidate-commit", "a" * 40,
        "--install-manifest", str(install_manifest),
        "--dry-run",
    ])
    self.assertEqual(result, 0)
    self.assertEqual(manifest["candidate_commit"], "a" * 40)
    self.assertEqual(manifest["commands"]["alloy"][0], "/candidate/bin/alloy")
```

- [ ] **Step 3: Run focused tests and verify missing interfaces**

Run:

```bash
python3 -m unittest \
  benchmarks.swebench.tests.test_runner.ProfileTests \
  benchmarks.swebench.tests.test_runner.CandidateMetadataTests -v
```

Expected: FAIL on missing `load_profile`, `parse_profile`, or
`load_candidate_metadata`.

- [ ] **Step 4: Implement strict profile and candidate types**

Add frozen dataclasses with explicit fields:

```python
@dataclass(frozen=True)
class BenchmarkProfile:
    agent_timeout_seconds: int
    base_commit: str
    dataset: str
    evaluator_timeout_seconds: int
    instance_id: str
    model: str
    model_digest: str
    ollama_model: str
    split: str
    swebench_version: str


@dataclass(frozen=True)
class CandidateMetadata:
    alloy_version: str
    pi_version: str
    commit: str
    root: Path
```

`parse_profile()` must require exactly the dataclass field names, reject bools
for integer fields, require positive timeouts, validate the full Git SHA and
64-character model digest formats, and preserve the pinned values from JSON.
`load_candidate_metadata()` must read `package.json`, require a semantic root
version, require `alloy.piFork.version`, and require a 40-character lowercase
Git SHA.

- [ ] **Step 5: Parameterize every runner stage**

Remove module constants for dataset, split, instance, base commit, model,
digest, evaluator version, and timeouts. Pass `BenchmarkProfile` into:

```python
build_prompt(instance: dict) -> str
load_instance(profile: BenchmarkProfile) -> dict
alloy_command(alloy_bin: Path, model: str, prompt: str) -> list[str]
run_alloy(alloy_bin: Path, profile: BenchmarkProfile, checkout: Path, prompt: str, environment: dict[str, str]) -> CommandResult
evaluator_command(profile: BenchmarkProfile, python: Path, predictions: Path, run_id: str) -> list[str]
official_verdict(profile: BenchmarkProfile, evaluation_dir: Path) -> str
run_official_evaluation(profile: BenchmarkProfile, python: Path, predictions: Path, run_id: str, work_root: Path, evaluation_dir: Path) -> str
```

Pass the explicit candidate binary into runtime probing:

```python
probe_runtime_versions(alloy_bin: Path, environment: dict[str, str]) -> dict[str, str]
```

The manifest must record:

```json
{
  "candidate_commit": "<40-char SHA>",
  "candidate_source_root": "<absolute path>",
  "install_manifest": {
    "commit": "<same SHA>",
    "version": "<same observed Alloy version>"
  }
}
```

Reject candidate source, installed manifest, `alloy --version`, Pi, model
digest, or evaluator-version drift before dataset loading.

- [ ] **Step 6: Run all benchmark tests**

Run:

```bash
python3 -m unittest discover -s benchmarks/swebench/tests -v
```

Expected: all migrated and new tests PASS.

- [ ] **Step 7: Commit profile and candidate provenance**

```bash
git add benchmarks/swebench/profile.json benchmarks/swebench/runner.py benchmarks/swebench/tests/test_runner.py
git commit -m "feat: bind SWE-bench runs to Alloy candidates"
```

### Task 3: Build the Fail-Closed Release Candidate Wrapper

**Files:**
- Create: `scripts/run-swebench-release-smoke.sh`
- Create: `benchmarks/swebench/tests/test_release_wrapper.py`
- Modify: `benchmarks/swebench/runner.py`

**Interfaces:**
- Consumes: Task 2's candidate-aware runner CLI.
- Produces: `scripts/run-swebench-release-smoke.sh [--dry-run]` and environment override `ALLOY_BENCH_REMOTE` defaulting to `github`.

- [ ] **Step 1: Write failing wrapper preflight tests**

Create subprocess tests with a temporary fake `git`, `bash`, and candidate
installer. Cover:

```python
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SHA = "a" * 40


class ReleaseWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.bin.mkdir()
        (self.repo / "benchmarks" / "swebench" / ".venv" / "bin").mkdir(
            parents=True
        )
        (self.repo / "benchmarks" / "swebench" / "profile.json").write_text("{}\n")
        (self.repo / "install.sh").write_text("#!/bin/sh\n")
        self.installer_log = self.root / "installer.log"
        self.runner_log = self.root / "runner.log"
        self._executable(
            self.bin / "git",
            """#!/bin/sh
case "$*" in
  "rev-parse --show-toplevel") printf '%s\\n' "$FAKE_REPO" ;;
  "rev-parse HEAD") printf '%s\\n' "$FAKE_SHA" ;;
  "status --porcelain=v1 --untracked-files=no") printf '%s' "${FAKE_STATUS:-}" ;;
  "remote get-url github") printf '%s\\n' "$FAKE_REMOTE_URL" ;;
  "ls-remote github") printf '%s\\trefs/heads/feature\\n' "$FAKE_REMOTE_SHA" ;;
  *) printf 'unexpected git command: %s\\n' "$*" >&2; exit 91 ;;
esac
""",
        )
        self._executable(
            self.bin / "bash",
            """#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$ALLOY_REF" "$HOME" "$XDG_DATA_HOME" "$ALLOY_PREFIX" "$*" >> "$FAKE_INSTALLER_LOG"
mkdir -p "$ALLOY_PREFIX/bin" "$XDG_DATA_HOME/alloy"
cat > "$ALLOY_PREFIX/bin/alloy" <<'ALLOY'
#!/bin/sh
printf '%s\\n' 'Alloy 1.1.25' 'Pi    0.82.1' 'Node  v22.22.3'
ALLOY
chmod +x "$ALLOY_PREFIX/bin/alloy"
printf '{"commit":"%s","version":"1.1.25"}\\n' "$ALLOY_REF" > "$XDG_DATA_HOME/alloy/install-manifest.json"
""",
        )
        self._executable(
            self.repo / "benchmarks" / "swebench" / ".venv" / "bin" / "python",
            """#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RUNNER_LOG"
exit "${FAKE_RUNNER_STATUS:-0}"
""",
        )
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_REPO": str(self.repo),
            "FAKE_SHA": SHA,
            "FAKE_REMOTE_SHA": SHA,
            "FAKE_REMOTE_URL": "https://github.com/ccoussa717/alloy.git",
            "FAKE_INSTALLER_LOG": str(self.installer_log),
            "FAKE_RUNNER_LOG": str(self.runner_log),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def _executable(self, path: Path, source: str) -> None:
        path.write_text(source)
        path.chmod(0o755)

    def _run(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                "/bin/bash",
                str(Path(__file__).resolve().parents[3] / "scripts" / "run-swebench-release-smoke.sh"),
                *arguments,
            ],
            cwd=self.repo,
            env={**self.environment, **environment},
            text=True,
            capture_output=True,
            check=False,
        )

    def test_wrapper_rejects_dirty_tracked_worktree(self):
        result = self._run(FAKE_STATUS=" M package.json\\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clean tracked worktree", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_commit_not_advertised_by_github_remote(self):
        result = self._run(FAKE_REMOTE_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pushed candidate", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_non_github_remote_url(self):
        result = self._run(FAKE_REMOTE_URL="git@gitlab.com:kylaira/alloy.git")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical GitHub remote", result.stderr)

    def test_wrapper_installs_full_sha_into_disposable_paths(self):
        result = self._run("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        install = self.installer_log.read_text().strip().split("|")
        self.assertEqual(install[0], SHA)
        self.assertIn("/home", install[1])
        self.assertIn("/data", install[2])
        self.assertIn("/prefix", install[3])

    def test_wrapper_passes_candidate_binary_manifest_and_dry_run_once(self):
        result = self._run("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.runner_log.read_text().splitlines()
        self.assertEqual(len(calls), 1)
        self.assertIn(f"--candidate-root {self.repo}", calls[0])
        self.assertIn(f"--candidate-commit {SHA}", calls[0])
        self.assertIn("--install-manifest", calls[0])
        self.assertIn("--dry-run", calls[0])

    def test_wrapper_real_mode_invokes_runner_once_without_retry(self):
        result = self._run(FAKE_RUNNER_STATUS="5")
        self.assertEqual(result.returncode, 5)
        calls = self.runner_log.read_text().splitlines()
        self.assertEqual(len(calls), 1)
        self.assertNotIn("--dry-run", calls[0])
```

The success fixture must assert these runner arguments exactly:

```text
--profile <repo>/benchmarks/swebench/profile.json
--alloy-bin <temp>/prefix/bin/alloy
--candidate-root <repo>
--candidate-commit <40-char SHA>
--install-manifest <temp>/data/alloy/install-manifest.json
--venv-python <repo>/benchmarks/swebench/.venv/bin/python
```

`--dry-run` must appear only when requested.

- [ ] **Step 2: Run wrapper tests and verify the script is missing**

Run:

```bash
python3 -m unittest benchmarks.swebench.tests.test_release_wrapper -v
```

Expected: FAIL because `scripts/run-swebench-release-smoke.sh` does not exist.

- [ ] **Step 3: Implement candidate and remote preflight**

Create a Bash script with `set -euo pipefail`. It must:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
REMOTE="${ALLOY_BENCH_REMOTE:-github}"
CANDIDATE_COMMIT="$(git rev-parse HEAD)"
```

Then fail unless:

```bash
git status --porcelain=v1 --untracked-files=no
```

is empty, `CANDIDATE_COMMIT` matches `^[0-9a-f]{40}$`, the remote URL is a
credential-free `https://github.com/ccoussa717/alloy.git` or
`git@github.com:ccoussa717/alloy.git`, and `git ls-remote "$REMOTE"` contains
the candidate SHA as a remote ref tip.

Do not accept a short SHA, tag-like user input, arbitrary URL, local-only
commit, or dirty tracked tree.

- [ ] **Step 4: Implement isolated install and exact runner invocation**

Create one temporary root with a cleanup trap. Set:

```bash
HOME="$TEMP_ROOT/home"
XDG_DATA_HOME="$TEMP_ROOT/data"
ALLOY_PREFIX="$TEMP_ROOT/prefix"
ALLOY_CHANNEL="main"
ALLOY_REF="$CANDIDATE_COMMIT"
```

Run the repository's real `install.sh` once. Verify:

```text
<prefix>/bin/alloy --version
<data>/alloy/install-manifest.json
```

both name the candidate package version and full commit. Invoke the benchmark
venv Python and runner once with the exact arguments from Step 1. Do not loop or
retry either installer or runner.

- [ ] **Step 5: Preserve the runner exit and artifact path**

The wrapper must return the runner's exact exit code. On any terminal runner
status, print the newest run directory from `benchmarks/swebench/results/`
without changing its summary. Never convert `unresolved` or infrastructure
failure into a synthetic pass.

- [ ] **Step 6: Run wrapper and benchmark tests**

Run:

```bash
python3 -m unittest benchmarks.swebench.tests.test_release_wrapper -v
python3 -m unittest discover -s benchmarks/swebench/tests -v
bash -n scripts/run-swebench-release-smoke.sh
```

Expected: all tests PASS and Bash syntax validation exits 0.

- [ ] **Step 7: Commit the candidate wrapper**

```bash
git add scripts/run-swebench-release-smoke.sh benchmarks/swebench/tests/test_release_wrapper.py benchmarks/swebench/runner.py
git commit -m "feat: install exact Alloy candidate for SWE-bench"
```

### Task 4: Wire Fast Tests and Exclude Benchmarks from Runtime Builds

**Files:**
- Create: `test/unit/swebench-build.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `install.sh`
- Modify: `test/integration/packed-install.e2e.test.mjs`
- Modify: `scripts/verify-release.mjs`

**Interfaces:**
- Consumes: Task 3's test and wrapper commands.
- Produces: root npm benchmark commands, normal CI execution, and verified runtime exclusion.

- [ ] **Step 1: Write failing Node build-boundary tests**

Create `test/unit/swebench-build.test.mjs` with assertions that:

```javascript
assert.equal(pkg.scripts["bench:swebench:test"],
  "python3 -m unittest discover -s benchmarks/swebench/tests -v");
assert.equal(pkg.scripts["bench:swebench:setup"],
  "python3 -m venv benchmarks/swebench/.venv && benchmarks/swebench/.venv/bin/python -m pip install --upgrade pip && benchmarks/swebench/.venv/bin/python -m pip install -r benchmarks/swebench/requirements.txt");
assert.equal(pkg.scripts["bench:swebench:dry-run"],
  "bash scripts/run-swebench-release-smoke.sh --dry-run");
assert.equal(pkg.scripts["bench:swebench:release"],
  "bash scripts/run-swebench-release-smoke.sh");
assert.match(pkg.scripts["test:all"], /bench:swebench:test/);
assert.equal(pkg.files.includes("benchmarks"), false);
assert.match(installer, /rm -rf -- "\$SOURCE_DIR\/benchmarks"/);
assert.match(ci, /actions\/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065/);
assert.match(ci, /python-version: ["']3\.12["']/);
```

Also assert `.gitignore` contains exactly these benchmark-local patterns:

```gitignore
benchmarks/swebench/.venv/
benchmarks/swebench/.work/
benchmarks/swebench/results/
benchmarks/swebench/__pycache__/
benchmarks/swebench/tests/__pycache__/
```

- [ ] **Step 2: Run the focused Node test and verify failure**

Run:

```bash
node --test test/unit/swebench-build.test.mjs
```

Expected: FAIL because npm scripts, CI Python setup, ignore rules, and installer
pruning are absent.

- [ ] **Step 3: Add root scripts and CI Python setup**

Add the four exact npm scripts from Step 1. Insert
`npm run bench:swebench:test` into `test:all` before model/TUI integration work.

In the Linux verification job, add the official `actions/setup-python` v5 tag
resolved on 2026-08-18 to commit
`a26af69be951a213d495a4c3e4e4022e16d87065`:

```yaml
uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5
with:
  python-version: "3.12"
```

The Linux `ci:checks` path must run the benchmark tests. The macOS job does not
execute root `test:all`, so do not add an unused Python setup step there.

- [ ] **Step 4: Exclude benchmark tooling from installed applications**

After source archive validation and before moving `SOURCE_DIR` into
`ALLOY_APP_ROOT`, add a fail-closed prune:

```bash
[[ ! -L "$SOURCE_DIR/benchmarks" ]] || err "Alloy source archive contains a symlinked benchmarks directory"
rm -rf -- "$SOURCE_DIR/benchmarks"
[[ ! -e "$SOURCE_DIR/benchmarks" ]] || err "could not remove release-only benchmark tooling"
```

Do not remove benchmark tooling before repository identity, required-resource,
or archive-safety checks complete.

- [ ] **Step 5: Prove source installs and package boundaries exclude benchmarks**

In the source-installer integration test, add:

```javascript
assert.equal(existsSync(join(app, "benchmarks")), false);
```

In `scripts/verify-release.mjs`, fail when `pkg.files` directly includes
`benchmarks` or a `benchmarks/` descendant:

```javascript
for (const path of pkg.files || []) {
  if (path === "benchmarks" || path.startsWith("benchmarks/")) {
    fail("benchmark tooling must not ship in the runtime package boundary");
  }
}
```

Add a security-gate regression that mutates `pkg.files` to include
`benchmarks/swebench` and expects that exact failure.

- [ ] **Step 6: Run focused and full build verification**

Run:

```bash
node --test test/unit/swebench-build.test.mjs test/unit/install-script.test.mjs test/unit/security-gates.test.mjs
npm run bench:swebench:test
npm test
npm run test:installer
npm run release:verify:source
git diff --check
```

Expected: all commands PASS; root Node suite remains at least 774 tests plus new
tests, benchmark suite remains fully green, and installed app has no
`benchmarks/` directory.

- [ ] **Step 7: Commit build and package integration**

```bash
git add .gitignore package.json .github/workflows/ci.yml install.sh scripts/verify-release.mjs test/unit/swebench-build.test.mjs test/unit/security-gates.test.mjs test/integration/packed-install.e2e.test.mjs
git commit -m "build: verify SWE-bench release tooling"
```

### Task 5: Document and Verify the Integrated Release Gate

**Files:**
- Create: `benchmarks/swebench/README.md`
- Modify: `docs/RELEASING.md`
- Modify: `README.md`
- Modify: benchmark files only if verification exposes a tested integration defect.

**Interfaces:**
- Consumes: Tasks 1-4's npm commands and candidate wrapper.
- Produces: reviewed maintainer-facing release instructions ready for the post-review integration gate.

- [ ] **Step 1: Write documentation assertions first**

Extend `test/unit/swebench-build.test.mjs` to require:

```javascript
assert.match(benchmarkReadme, /npm run bench:swebench:setup/);
assert.match(benchmarkReadme, /npm run bench:swebench:dry-run/);
assert.match(benchmarkReadme, /npm run bench:swebench:release/);
assert.match(benchmarkReadme, /one-instance smoke/i);
assert.match(releasing, /manual SWE-bench release gate/i);
assert.match(releasing, /resolved|unresolved|infrastructure_failure/);
assert.match(rootReadme, /benchmarks\/swebench\/README\.md/);
```

- [ ] **Step 2: Run the documentation test and verify failure**

Run:

```bash
node --test test/unit/swebench-build.test.mjs
```

Expected: FAIL because benchmark and release documentation is absent.

- [ ] **Step 3: Write maintainer documentation**

`benchmarks/swebench/README.md` must document:

- Python 3.11+ (Python 3.12 in CI), Docker, local Ollama, and the exact pinned model digest.
- `npm run bench:swebench:setup` bootstrap.
- Fast tests and what they do not execute.
- Candidate dry-run and real release commands.
- Clean/pushed SHA and GitHub-remote requirement.
- Disposable candidate install and agent state.
- Artifact paths and safe allowlist.
- Exit/status meanings.
- Exactly one attempt and no automatic retry.
- `resolved` and `unresolved` as valid official one-instance outcomes.
- `infrastructure_failure` as absence of an official verdict.
- Explicit warning that one result is not an Alloy SWE-bench score.

Update `docs/RELEASING.md` with a manual gate after green CI and before tagging.
The release checklist must require `npm run bench:swebench:dry-run`, then one
maintainer-authorized `npm run bench:swebench:release`. It must not claim the
gate ran when no official summary exists.

Add one root README maintainer link. Do not advertise an `alloy benchmark`
command or end-user Python dependency.

- [ ] **Step 4: Run all local verification before pushing**

Run:

```bash
npm run bench:swebench:test
npm test
npm run typecheck:tui
npm run test:tui
npm run verify:tui:pty
npm run test:integration
npm run test:installer
npm run release:verify:source
npm run security:scan
git diff --check
git status --short
```

Expected: every check PASS and only intended source changes remain.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/RELEASING.md benchmarks/swebench/README.md test/unit/swebench-build.test.mjs
git commit -m "docs: add SWE-bench release gate"
```

## Post-Review Integration Gate

Run this gate only after Tasks 1-5 pass their individual reviews, the full local
verification is green, and the final whole-branch review says the branch is
ready to integrate. These steps are not part of Task 5 and must not run before
that review sequence completes.

- [ ] **Step 1: Push the reviewed branch before candidate verification**

Push the branch to the GitHub remote:

```bash
git push -u github feat/swebench-build-integration
```

Expected: the remote advertises the exact local `HEAD` SHA. Do not create the
pull request until the candidate dry-run passes.

- [ ] **Step 2: Run the isolated candidate dry-run**

Before writing timestamps, run the required system clock command:

```bash
date "+%Y-%m-%d %H:%M:%S %Z (%A)"
npm run bench:swebench:setup
npm run bench:swebench:dry-run
```

Expected: exit 0; the wrapper installs the exact pushed SHA under disposable
paths; no autonomous `-p` attempt or Docker evaluator starts; the manifest's
candidate commit, install manifest commit, Alloy version, Pi version, model
digest, and SWE-bench version all match.

- [ ] **Step 3: Verify dry-run artifacts mechanically**

Inspect the newest `benchmarks/swebench/results/alloy-*` directory. Assert:

```text
manifest.json exists
problem.md exists
summary.json status is dry_run
candidate_commit equals git rev-parse HEAD
install_manifest.commit equals candidate_commit
commands.alloy points inside the disposable candidate prefix recorded for the run
no predictions.jsonl
no model_patch.diff
no evaluation directory
no eval.sh anywhere under persisted results
no patch or test_patch fields or gold sentinels
```

The wrapper may remove the candidate installation after the runner exits, but
the manifest must retain its verified commit and version provenance.

- [ ] **Step 4: Open the pull request without running the real benchmark**

Create a PR against GitHub `main` summarizing fast-test evidence and the
candidate dry-run. State explicitly that the historical real attempt ended in
`infrastructure_failure` and that the new manual real release gate was not run
during integration.

Do not bump Alloy's version or create a release tag in this implementation PR;
the release workflow decides the next version after merge authority is granted.
