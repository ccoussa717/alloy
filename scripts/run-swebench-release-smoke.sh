#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s [--dry-run]\n' "${0##*/}" >&2
}

DRY_RUN=0
case "$#" in
  0) ;;
  1)
    if [[ "$1" != "--dry-run" ]]; then
      usage
      exit 64
    fi
    DRY_RUN=1
    ;;
  *)
    usage
    exit 64
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
REMOTE="${ALLOY_BENCH_REMOTE:-github}"
CANDIDATE_COMMIT="$(git rev-parse HEAD)"

if [[ ! "$REMOTE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'error: ALLOY_BENCH_REMOTE must be a valid Git remote name\n' >&2
  exit 1
fi

if [[ -n "$(git status --porcelain=v1 --untracked-files=no)" ]]; then
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

REMOTE_REFS="$(git ls-remote "$REMOTE")"
PUSHED_CANDIDATE=0
while IFS=$'\t' read -r remote_commit remote_ref; do
  if [[ "$remote_commit" == "$CANDIDATE_COMMIT" && "$remote_ref" == refs/* ]]; then
    PUSHED_CANDIDATE=1
    break
  fi
done <<< "$REMOTE_REFS"
if [[ "$PUSHED_CANDIDATE" -ne 1 ]]; then
  printf 'error: candidate commit is not a pushed candidate advertised by the remote\n' >&2
  exit 1
fi

EXPECTED_VERSION="$(python3 - "$REPO_ROOT/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as package_file:
    package = json.load(package_file)
version = package.get("version") if isinstance(package, dict) else None
if not isinstance(version, str) or not version:
    raise SystemExit("error: candidate package version is missing or invalid")
print(version)
PY
)"

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/alloy-release-smoke.XXXXXXXX")"
cleanup() {
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT

export HOME="$TEMP_ROOT/home"
export XDG_CONFIG_HOME="$TEMP_ROOT/config"
export XDG_CACHE_HOME="$TEMP_ROOT/cache"
export XDG_DATA_HOME="$TEMP_ROOT/data"
export XDG_STATE_HOME="$TEMP_ROOT/state"
export XDG_RUNTIME_DIR="$TEMP_ROOT/runtime"
export TMPDIR="$TEMP_ROOT/tmp"
export ALLOY_PREFIX="$TEMP_ROOT/prefix"
export ALLOY_CHANNEL="main"
export ALLOY_REF="$CANDIDATE_COMMIT"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$ALLOY_PREFIX"

bash "$REPO_ROOT/install.sh"

ALLOY_BIN="$ALLOY_PREFIX/bin/alloy"
INSTALL_MANIFEST="$XDG_DATA_HOME/alloy/install-manifest.json"
if [[ ! -x "$ALLOY_BIN" || ! -f "$INSTALL_MANIFEST" ]]; then
  printf 'error: installed candidate binary or manifest is missing\n' >&2
  exit 1
fi

VERSION_OUTPUT="$TEMP_ROOT/alloy-version.txt"
"$ALLOY_BIN" --version > "$VERSION_OUTPUT"
python3 - "$EXPECTED_VERSION" "$VERSION_OUTPUT" <<'PY'
import sys

expected = sys.argv[1]
with open(sys.argv[2], encoding="utf-8") as version_file:
    alloy_versions = [
        line[6:] for line in version_file.read().splitlines() if line.startswith("Alloy ")
    ]
if alloy_versions != [expected]:
    raise SystemExit("error: installed candidate binary version does not match package version")
PY

python3 - "$INSTALL_MANIFEST" "$CANDIDATE_COMMIT" "$EXPECTED_VERSION" <<'PY'
import json
import sys

path, expected_commit, expected_version = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
except (OSError, ValueError) as error:
    raise SystemExit("error: installed candidate manifest is missing or invalid") from error
if not isinstance(manifest, dict):
    raise SystemExit("error: installed candidate manifest must be a JSON object")
allowed = {"channel", "commit", "installedAt", "ref", "repository", "version"}
if set(manifest) - allowed:
    raise SystemExit("error: installed candidate manifest contains unknown fields")
if set(manifest) - {"commit", "version", "ref"} and any(
    not isinstance(manifest[key], str)
    for key in set(manifest) - {"commit", "version", "ref"}
):
    raise SystemExit("error: installed candidate manifest fields have invalid types")
if "ref" in manifest and manifest["ref"] is not None and not isinstance(manifest["ref"], str):
    raise SystemExit("error: installed candidate manifest ref has an invalid type")
if manifest.get("commit") != expected_commit or manifest.get("version") != expected_version:
    raise SystemExit("error: installed candidate manifest does not match commit and package version")
PY

VENV_PYTHON="$REPO_ROOT/benchmarks/swebench/.venv/bin/python"
RUNNER=(
  "$VENV_PYTHON"
  "$REPO_ROOT/benchmarks/swebench/runner.py"
  --profile "$REPO_ROOT/benchmarks/swebench/profile.json"
  --alloy-bin "$ALLOY_BIN"
  --candidate-root "$REPO_ROOT"
  --candidate-commit "$CANDIDATE_COMMIT"
  --install-manifest "$INSTALL_MANIFEST"
  --venv-python "$VENV_PYTHON"
)
if [[ "$DRY_RUN" -eq 1 ]]; then
  RUNNER+=(--dry-run)
fi

set +e
"${RUNNER[@]}"
RUNNER_STATUS=$?
set -e

RESULTS_ROOT="$REPO_ROOT/benchmarks/swebench/results"
NEWEST_RUN=""
if [[ -d "$RESULTS_ROOT" ]]; then
  for run_directory in "$RESULTS_ROOT"/*; do
    [[ -d "$run_directory" ]] || continue
    if [[ -z "$NEWEST_RUN" || "$run_directory" -nt "$NEWEST_RUN" ]]; then
      NEWEST_RUN="$run_directory"
    fi
  done
fi
if [[ -n "$NEWEST_RUN" ]]; then
  printf 'benchmark result: %s\n' "$NEWEST_RUN"
else
  printf 'benchmark result: none produced\n' >&2
fi

exit "$RUNNER_STATUS"
