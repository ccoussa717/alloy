#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s {test|setup|provision|dry-run <candidate-sha>|release <candidate-sha>|authorize-retry <candidate-sha> <reason>}\n' "${0##*/}" >&2
}

if [[ "$#" -lt 1 ]]; then
  usage
  exit 64
fi

SUBCOMMAND="$1"
shift
case "$SUBCOMMAND" in
  test|setup|provision)
    if [[ "$#" -ne 0 ]]; then
      usage
      exit 64
    fi
    ;;
  dry-run|release)
    if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
      usage
      exit 64
    fi
    CANDIDATE_SHA="$1"
    ;;
  authorize-retry)
    if [[ "$#" -ne 2 || ! "$1" =~ ^[0-9a-f]{40}$ || -z "${2//[[:space:]]/}" ]]; then
      usage
      exit 64
    fi
    CANDIDATE_SHA="$1"
    RETRY_REASON="$2"
    ;;
  *)
    usage
    exit 64
    ;;
esac

case "$SUBCOMMAND" in
  dry-run|release)
    exec /usr/bin/sudo -n /usr/local/libexec/alloy-swebench-gate "$SUBCOMMAND" "$CANDIDATE_SHA"
    ;;
  authorize-retry)
    exec /usr/bin/sudo -n /usr/local/libexec/alloy-swebench-gate \
      authorize-retry "$CANDIDATE_SHA" "$RETRY_REASON"
    ;;
esac

if ! REPO_ROOT="$(git rev-parse --show-toplevel)" || [[ -z "$REPO_ROOT" ]]; then
  printf 'error: could not determine repository root\n' >&2
  exit 1
fi
BENCH_ROOT="$REPO_ROOT/benchmarks/swebench"

case "$SUBCOMMAND" in
  test)
    exec python3 -m unittest discover -s "$BENCH_ROOT/tests" -v
    ;;
  setup)
    python3 -m venv --copies "$BENCH_ROOT/.venv"
    if [[ -L "$BENCH_ROOT/.venv/lib64" ]]; then
      unlink "$BENCH_ROOT/.venv/lib64"
    fi
    "$BENCH_ROOT/.venv/bin/python" -m pip install \
      --require-hashes -r "$BENCH_ROOT/requirements.lock"
    mkdir -p "$BENCH_ROOT/.cache/artifacts" "$BENCH_ROOT/.cache/dataset"
    TARGET_CACHE="$BENCH_ROOT/.cache/target.git"
    if [[ ! -d "$TARGET_CACHE/.git" ]]; then
      if [[ -e "$TARGET_CACHE" ]]; then
        printf 'error: target cache exists but is not a Git checkout\n' >&2
        exit 1
      fi
      git clone --quiet --no-checkout \
        https://github.com/astropy/astropy.git "$TARGET_CACHE"
    fi
    git -C "$TARGET_CACHE" fetch --quiet --depth=1 origin \
      d16bfe05a744909de4b27f5875fe0d4ed41ce607
    git -C "$TARGET_CACHE" checkout --quiet --detach \
      d16bfe05a744909de4b27f5875fe0d4ed41ce607
    if [[ "$(git -C "$TARGET_CACHE" rev-parse HEAD)" != d16bfe05a744909de4b27f5875fe0d4ed41ce607 ]] || \
       [[ -n "$(git -C "$TARGET_CACHE" status --porcelain=v1 --untracked-files=all)" ]]; then
      printf 'error: target cache does not match the pinned Astropy commit\n' >&2
      exit 1
    fi
    chmod -R a-w "$TARGET_CACHE"
    chmod 0700 "$BENCH_ROOT/.cache" "$BENCH_ROOT/.cache/artifacts" "$BENCH_ROOT/.cache/dataset"
    ;;
  provision)
    AUTHORITY_SHA="$(git rev-parse HEAD)"
    if [[ ! "$AUTHORITY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      printf 'error: authority commit must be a full lowercase Git SHA\n' >&2
      exit 1
    fi
    exec /usr/bin/sudo -n /usr/bin/python3 \
      "$BENCH_ROOT/provision.py" "$AUTHORITY_SHA"
    ;;
esac
