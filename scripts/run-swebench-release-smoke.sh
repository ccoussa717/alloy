#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s {test|setup|provision <authority-sha>|dry-run <candidate-sha>|release <candidate-sha>|authorize-retry <candidate-sha> <reason>}\n' "${0##*/}" >&2
}

if [[ "$#" -lt 1 ]]; then
  usage
  exit 64
fi

SUBCOMMAND="$1"
shift
case "$SUBCOMMAND" in
  test|setup)
    if [[ "$#" -ne 0 ]]; then
      usage
      exit 64
    fi
    ;;
  provision)
    if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
      usage
      exit 64
    fi
    AUTHORITY_SHA="$1"
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
  provision)
    printf '%s\n' \
      "/usr/bin/sudo -H /bin/sh -eu -c '" \
      'umask 077' \
      'authority="$1"' \
      'bootstrap="/var/lib/alloy-swebench-bootstrap-$authority"' \
      'checkout="$bootstrap/authority"' \
      '/usr/bin/mkdir -m 0700 "$bootstrap"' \
      '/usr/bin/git init --quiet "$checkout"' \
      'advertised=$(/usr/bin/git ls-remote https://github.com/ccoussa717/alloy.git refs/heads/main)' \
      'expected=$(/usr/bin/printf '\''%s\t%s'\'' "$authority" refs/heads/main)' \
      'test "$advertised" = "$expected"' \
      '/usr/bin/git -C "$checkout" fetch --quiet --no-tags --depth=1 https://github.com/ccoussa717/alloy.git "$authority"' \
      '/usr/bin/git -C "$checkout" checkout --quiet --detach FETCH_HEAD' \
      'test "$(/usr/bin/git -C "$checkout" rev-parse HEAD)" = "$authority"' \
      'test -z "$(/usr/bin/git -C "$checkout" status --porcelain=v1 --untracked-files=all)"' \
      '/usr/bin/git -C "$checkout" remote add github https://github.com/ccoussa717/alloy.git' \
      'exec /usr/bin/python3 -I -E -s "$checkout/benchmarks/swebench/provision.py" "$authority"' \
      "' sh '$AUTHORITY_SHA'"
    exit 0
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
esac
