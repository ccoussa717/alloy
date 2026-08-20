#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s {test|setup|dry-run|release}\n' "${0##*/}" >&2
}

if [[ "$#" -ne 1 ]]; then
  usage
  exit 64
fi
SUBCOMMAND="$1"
case "$SUBCOMMAND" in
  test|setup|dry-run|release) ;;
  *)
    usage
    exit 64
    ;;
esac

if [[ "$SUBCOMMAND" == "release" ]]; then
  printf 'error: release is disabled pending trusted isolation for the agent, evaluator, and results\n' >&2
  exit 1
fi

if ! REPO_ROOT_OUTPUT="$(git rev-parse --show-toplevel && printf '\001')"; then
  printf 'error: could not determine repository root\n' >&2
  exit 1
fi
if [[ "$REPO_ROOT_OUTPUT" != *$'\n'$'\001' ]]; then
  printf 'error: git returned a malformed repository root\n' >&2
  exit 1
fi
REPO_ROOT="${REPO_ROOT_OUTPUT%$'\001'}"
REPO_ROOT="${REPO_ROOT%$'\n'}"
BENCH_ROOT="$REPO_ROOT/benchmarks/swebench"

case "$SUBCOMMAND" in
  test)
    exec python3 -m unittest discover -s "$BENCH_ROOT/tests" -v
    ;;
  setup)
    python3 -m venv "$BENCH_ROOT/.venv"
    exec "$BENCH_ROOT/.venv/bin/python" -m pip install --require-hashes -r "$BENCH_ROOT/requirements.lock"
    ;;
esac

DRY_RUN=0
if [[ "$SUBCOMMAND" == "dry-run" ]]; then
  DRY_RUN=1
fi
REMOTE="${ALLOY_BENCH_REMOTE:-github}"
CANDIDATE_COMMIT="$(git rev-parse HEAD)"

if [[ "$REPO_ROOT" == *$'\n'* || "$REPO_ROOT" == *$'\r'* ]]; then
  printf 'error: repository path contains a newline\n' >&2
  exit 1
fi
REPO_ROOT="$(python3 - "$REPO_ROOT" <<'PY'
import os
import sys

root = os.path.realpath(sys.argv[1])
if not os.path.isabs(root) or not os.path.isdir(root):
    raise SystemExit("error: repository root is not an absolute directory")
print(root)
PY
)"

if [[ ! "$REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'error: ALLOY_BENCH_REMOTE must be a valid Git remote name\n' >&2
  exit 1
fi

if ! TRACKED_STATUS="$(git status --porcelain=v1 --untracked-files=no)"; then
  printf 'error: could not verify clean tracked worktree\n' >&2
  exit 1
fi
if [[ -n "$TRACKED_STATUS" ]]; then
  printf 'error: release smoke requires a clean tracked worktree\n' >&2
  exit 1
fi

if [[ ! "$CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'error: candidate commit must be a full lowercase Git SHA\n' >&2
  exit 1
fi

REMOTE_URL="$(git remote get-url "$REMOTE")"
case "$REMOTE_URL" in
  https://github.com/ccoussa717/alloy.git|git@github.com:ccoussa717/alloy.git) ;;
  *)
    printf 'error: benchmark remote must be the canonical GitHub remote without credentials\n' >&2
    exit 1
    ;;
esac

if ! REMOTE_REFS="$(git ls-remote "$REMOTE")"; then
  printf 'error: could not read advertised refs from benchmark remote\n' >&2
  exit 1
fi
PUSHED_CANDIDATE=0
while IFS=$'\t' read -r remote_commit remote_ref; do
  if [[
    "$remote_commit" == "$CANDIDATE_COMMIT" &&
    "$remote_ref" == refs/* &&
    "$remote_ref" != *'^{}'
  ]]; then
    PUSHED_CANDIDATE=1
    break
  fi
done <<< "$REMOTE_REFS"
if [[ "$PUSHED_CANDIDATE" -ne 1 ]]; then
  printf 'error: candidate commit is not an advertised ref tip on the remote\n' >&2
  exit 1
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/alloy-release-smoke.XXXXXXXX")"
cleanup() {
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

SNAPSHOT_ROOT="$TEMP_ROOT/snapshot"
ARCHIVE_PATH="$TEMP_ROOT/candidate.tar"
mkdir -p "$SNAPSHOT_ROOT"
git archive \
  --format=tar \
  --output="$ARCHIVE_PATH" \
  "$CANDIDATE_COMMIT" \
  -- \
  package.json \
  install.sh \
  benchmarks/swebench
tar -xf "$ARCHIVE_PATH" -C "$SNAPSHOT_ROOT"

SNAPSHOT_PACKAGE="$SNAPSHOT_ROOT/package.json"
SNAPSHOT_INSTALLER="$SNAPSHOT_ROOT/install.sh"
SNAPSHOT_BENCH="$SNAPSHOT_ROOT/benchmarks/swebench"
SNAPSHOT_RUNNER="$SNAPSHOT_BENCH/runner.py"
SNAPSHOT_PROFILE="$SNAPSHOT_BENCH/profile.json"
python3 \
  - "$SNAPSHOT_ROOT" "$SNAPSHOT_PACKAGE" "$SNAPSHOT_INSTALLER" \
  "$SNAPSHOT_RUNNER" "$SNAPSHOT_PROFILE" <<'PY'
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
for path in sys.argv[2:]:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise SystemExit("error: candidate snapshot is incomplete") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit("error: candidate snapshot files must be regular files")
    resolved = os.path.realpath(path)
    if os.path.commonpath((root, resolved)) != root:
        raise SystemExit("error: candidate snapshot escaped disposable scratch")
PY

export HOME="$TEMP_ROOT/home"
export ZDOTDIR="$TEMP_ROOT/zdotdir"
export XDG_CONFIG_HOME="$TEMP_ROOT/config"
export XDG_CACHE_HOME="$TEMP_ROOT/cache"
export XDG_DATA_HOME="$TEMP_ROOT/data"
export XDG_STATE_HOME="$TEMP_ROOT/state"
export XDG_RUNTIME_DIR="$TEMP_ROOT/runtime"
export TMPDIR="$TEMP_ROOT/tmp"
export ALLOY_PREFIX="$TEMP_ROOT/prefix"
export ALLOY_CHANNEL="main"
export ALLOY_REF="$CANDIDATE_COMMIT"
unset BASH_ENV ENV
mkdir -p \
  "$HOME" \
  "$ZDOTDIR" \
  "$XDG_CONFIG_HOME" \
  "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_RUNTIME_DIR" \
  "$TMPDIR" \
  "$ALLOY_PREFIX"

bash "$SNAPSHOT_INSTALLER"

ALLOY_BIN="$ALLOY_PREFIX/bin/alloy"
INSTALL_MANIFEST="$XDG_DATA_HOME/alloy/install-manifest.json"
INSTALLED_APP="$XDG_DATA_HOME/alloy/app"
INSTALLED_PACKAGE="$INSTALLED_APP/package.json"
if [[
  ! -x "$ALLOY_BIN" ||
  ! -f "$INSTALL_MANIFEST" ||
  ! -f "$INSTALLED_PACKAGE" ||
  -L "$ALLOY_BIN" ||
  -L "$INSTALL_MANIFEST" ||
  -L "$INSTALLED_PACKAGE"
]]; then
  printf 'error: installed candidate binary, app, or manifest is missing or unsafe\n' >&2
  exit 1
fi

VERSION_OUTPUT="$TEMP_ROOT/alloy-version.txt"
"$ALLOY_BIN" --version > "$VERSION_OUTPUT"
python3 \
  - "$SNAPSHOT_PACKAGE" "$INSTALLED_PACKAGE" "$INSTALL_MANIFEST" \
  "$VERSION_OUTPUT" "$CANDIDATE_COMMIT" "$XDG_DATA_HOME" <<'PY'
import os
import json
import re
import sys

snapshot_path, installed_path, manifest_path, version_path, commit, data_home = sys.argv[1:]

def read_object(path, label):
    try:
        with open(path, encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, ValueError) as error:
        raise SystemExit(f"error: {label} is missing or invalid") from error
    if not isinstance(value, dict):
        raise SystemExit(f"error: {label} must be a JSON object")
    return value

semantic_version = re.compile(
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)

snapshot = read_object(snapshot_path, "candidate snapshot package")
installed = read_object(installed_path, "installed candidate package")
expected_version = snapshot.get("version")
snapshot_alloy = snapshot.get("alloy")
snapshot_pi_fork = snapshot_alloy.get("piFork") if isinstance(snapshot_alloy, dict) else None
expected_pi = snapshot_pi_fork.get("version") if isinstance(snapshot_pi_fork, dict) else None
if not isinstance(expected_version, str) or semantic_version.fullmatch(expected_version) is None:
    raise SystemExit("error: candidate snapshot package version is invalid")
if not isinstance(expected_pi, str) or semantic_version.fullmatch(expected_pi) is None:
    raise SystemExit("error: candidate snapshot Pi version is invalid")
expected_installed_root = os.path.join(os.path.realpath(data_home), "alloy", "app")
installed_root = os.path.dirname(installed_path)
if installed_root != expected_installed_root or os.path.realpath(installed_root) != expected_installed_root:
    raise SystemExit("error: installed candidate app escaped disposable storage")
installed_alloy = installed.get("alloy")
installed_pi_fork = installed_alloy.get("piFork") if isinstance(installed_alloy, dict) else None
installed_pi = installed_pi_fork.get("version") if isinstance(installed_pi_fork, dict) else None
if installed.get("version") != expected_version or installed_pi != expected_pi:
    raise SystemExit("error: installed candidate app does not match snapshot package metadata")

with open(version_path, encoding="utf-8") as version_file:
    lines = version_file.read().splitlines()
alloy_versions = [line[6:] for line in lines if line.startswith("Alloy ")]
pi_versions = [line[6:].strip() for line in lines if line.startswith("Pi ")]
if alloy_versions != [expected_version] or pi_versions != [expected_pi]:
    raise SystemExit("error: installed candidate binary does not match snapshot package metadata")

manifest = read_object(manifest_path, "installed candidate manifest")
allowed = {"channel", "commit", "installedAt", "ref", "repository", "version"}
if set(manifest) - allowed:
    raise SystemExit("error: installed candidate manifest contains unknown fields")
metadata_keys = set(manifest) - {"commit", "version", "ref"}
if any(not isinstance(manifest[key], str) for key in metadata_keys):
    raise SystemExit("error: installed candidate manifest fields have invalid types")
if "ref" in manifest and manifest["ref"] is not None and not isinstance(manifest["ref"], str):
    raise SystemExit("error: installed candidate manifest ref has an invalid type")
if manifest.get("commit") != commit or manifest.get("version") != expected_version:
    raise SystemExit("error: installed candidate manifest does not match commit and package version")
PY

RESULTS_ROOT="$REPO_ROOT/benchmarks/swebench/results"
validate_results_root() {
  python3 - "$REPO_ROOT" "$RESULTS_ROOT" "$1" <<'PY'
import os
import stat
import sys

repo_root, results_root, mode = sys.argv[1:]
bench_root = os.path.join(repo_root, "benchmarks", "swebench")
if os.path.realpath(bench_root) != bench_root or not os.path.isdir(bench_root):
    raise SystemExit("error: benchmark output parent is not canonical")
try:
    metadata = os.lstat(results_root)
except FileNotFoundError:
    if mode != "prepare":
        raise SystemExit("error: benchmark results root disappeared before launch")
    try:
        os.mkdir(results_root, 0o755)
    except FileExistsError:
        pass
    metadata = os.lstat(results_root)
if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
    raise SystemExit("error: benchmark results root must be a real directory")
expected = os.path.join(bench_root, "results")
if os.path.realpath(results_root) != expected:
    raise SystemExit("error: benchmark results root is not canonical")
PY
}
validate_results_root prepare

VENV_PYTHON="$REPO_ROOT/benchmarks/swebench/.venv/bin/python"
if [[ ! -x "$VENV_PYTHON" ]]; then
  printf 'error: benchmark virtual environment Python is missing\n' >&2
  exit 1
fi

RUN_PATH_FILE="$TEMP_ROOT/run-path.json"
RUN_TOKEN="${TEMP_ROOT##*/}"
EXISTING_RUNS_FILE="$TEMP_ROOT/existing-runs.json"
validate_results_root launch
python3 - "$RESULTS_ROOT" "$EXISTING_RUNS_FILE" <<'PY'
import json
import os
import sys

results_root, output_path = sys.argv[1:]
existing = []
with os.scandir(results_root) as entries:
    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            existing.append(os.path.realpath(entry.path))
with open(output_path, "x", encoding="utf-8") as output:
    json.dump(sorted(existing), output, separators=(",", ":"))
    output.write("\n")
PY

RUNNER=(
  "$VENV_PYTHON"
  "$SNAPSHOT_RUNNER"
  --profile "$SNAPSHOT_PROFILE"
  --alloy-bin "$ALLOY_BIN"
  --candidate-root "$INSTALLED_APP"
  --candidate-commit "$CANDIDATE_COMMIT"
  --install-manifest "$INSTALL_MANIFEST"
  --results-root "$RESULTS_ROOT"
  --run-path-file "$RUN_PATH_FILE"
  --run-token "$RUN_TOKEN"
  --venv-python "$VENV_PYTHON"
)
if [[ "$DRY_RUN" -eq 1 ]]; then
  RUNNER+=(--dry-run)
fi

validate_results_root launch
set +e
"${RUNNER[@]}"
RUNNER_STATUS=$?
set -e

set +e
RUN_DIRECTORY="$(python3 \
  - "$RUN_PATH_FILE" "$RESULTS_ROOT" "$CANDIDATE_COMMIT" "$RUN_TOKEN" \
  "$EXISTING_RUNS_FILE" "$INSTALLED_APP" <<'PY'
import json
import os
import stat
import sys

pointer_path, results_root, commit, token, existing_path, candidate_root = sys.argv[1:]

def fail(message):
    raise SystemExit(f"error: invalid run path pointer: {message}")

try:
    pointer_metadata = os.lstat(pointer_path)
except OSError:
    fail("run path pointer is missing")
if not stat.S_ISREG(pointer_metadata.st_mode):
    fail("run path pointer is not a regular file")
try:
    with open(pointer_path, encoding="utf-8") as pointer_file:
        pointer = json.load(pointer_file)
except (OSError, ValueError):
    fail("run path pointer is malformed")
expected_keys = {
    "candidate_commit", "results_root", "run_dir", "run_id", "run_token",
    "schema_version",
}
if not isinstance(pointer, dict) or set(pointer) != expected_keys:
    fail("run path pointer has an unsupported schema")
if pointer.get("schema_version") != 1:
    fail("run path pointer has an unsupported schema")
for key in expected_keys - {"schema_version"}:
    if not isinstance(pointer.get(key), str) or not pointer[key]:
        fail(f"run path pointer {key} is invalid")

try:
    results_metadata = os.lstat(results_root)
except OSError:
    fail("canonical benchmark results root is missing")
if stat.S_ISLNK(results_metadata.st_mode) or not stat.S_ISDIR(results_metadata.st_mode):
    fail("canonical benchmark results root is unsafe")
canonical_results = os.path.realpath(results_root)
if canonical_results != results_root or pointer["results_root"] != canonical_results:
    fail("pointer does not name the canonical benchmark results root")
if pointer["candidate_commit"] != commit or pointer["run_token"] != token:
    fail("pointer provenance does not match this invocation")

run_value = pointer["run_dir"]
if not os.path.isabs(run_value):
    fail("run path is not absolute")
canonical_run = os.path.realpath(run_value)
if canonical_run != run_value:
    fail("run path escapes the canonical benchmark results root through a symlink")
if os.path.dirname(canonical_run) != canonical_results:
    fail("run path is not within the canonical benchmark results root")
try:
    run_metadata = os.lstat(canonical_run)
except OSError:
    fail("run path does not exist")
if stat.S_ISLNK(run_metadata.st_mode) or not stat.S_ISDIR(run_metadata.st_mode):
    fail("run path is not a real directory")
if os.path.basename(canonical_run) != pointer["run_id"]:
    fail("run id does not match run path")

try:
    with open(existing_path, encoding="utf-8") as existing_file:
        existing = json.load(existing_file)
except (OSError, ValueError):
    fail("pre-launch result inventory is invalid")
if canonical_run in existing:
    fail("stale run path predates this invocation")

manifest_path = os.path.join(canonical_run, "manifest.json")
summary_path = os.path.join(canonical_run, "summary.json")
for artifact in (manifest_path, summary_path):
    try:
        artifact_metadata = os.lstat(artifact)
    except OSError:
        fail("pointed run is missing required artifacts")
    if not stat.S_ISREG(artifact_metadata.st_mode):
        fail("pointed run contains unsafe artifacts")
try:
    with open(manifest_path, encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
except (OSError, ValueError):
    fail("pointed run manifest is malformed")
if not isinstance(manifest, dict):
    fail("pointed run manifest is malformed")
if manifest.get("candidate_commit") != commit or manifest.get("run_id") != pointer["run_id"]:
    fail("pointed run manifest provenance does not match")
manifest_candidate_root = manifest.get("candidate_source_root")
if not isinstance(manifest_candidate_root, str):
    fail("pointed run candidate root is invalid")
if os.path.realpath(manifest_candidate_root) != os.path.realpath(candidate_root):
    fail("pointed run candidate root does not match installed candidate")
print(canonical_run)
PY
)"
POINTER_STATUS=$?
set -e

if [[ "$POINTER_STATUS" -eq 0 ]]; then
  printf 'benchmark result: %s\n' "$RUN_DIRECTORY"
elif [[ "$RUNNER_STATUS" -eq 0 ]]; then
  exit "$POINTER_STATUS"
fi

exit "$RUNNER_STATUS"
