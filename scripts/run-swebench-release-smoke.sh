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
      "/usr/bin/sudo -H /bin/sh -eu -s -- '$AUTHORITY_SHA' <<'ALLOY_SWEBENCH_BOOTSTRAP'" \
      'umask 077' \
      'authority="$1"' \
      'canonical=https://github.com/ccoussa717/alloy.git' \
      '/usr/bin/test ! -L /run' \
      "run_metadata=\$(/usr/bin/stat -c '%F:%u:%g:%a' -- /run)" \
      'case "$run_metadata" in' \
      '  directory:0:0:*) ;;' \
      '  *) exit 1 ;;' \
      'esac' \
      'run_mode=${run_metadata##*:}' \
      '/usr/bin/test $((0$run_mode & 0022)) -eq 0' \
      'bootstrap=$(/usr/bin/mktemp -d /run/alloy-swebench-bootstrap.XXXXXXXX)' \
      'cleanup() {' \
      '  status=$?' \
      '  trap - 0 HUP INT TERM' \
      '  /usr/bin/rm -rf -- "$bootstrap"' \
      '  exit "$status"' \
      '}' \
      'trap cleanup 0' \
      "trap 'exit 129' HUP" \
      "trap 'exit 130' INT" \
      "trap 'exit 143' TERM" \
      "bootstrap_metadata=\$(/usr/bin/stat -c '%F:%u:%g:%a' -- \"\$bootstrap\")" \
      '/usr/bin/test "$bootstrap_metadata" = directory:0:0:700' \
      'home="$bootstrap/home"' \
      'checkout="$bootstrap/authority"' \
      '/usr/bin/mkdir -m 0700 -- "$home"' \
      'git() {' \
      '  /usr/bin/env -i \' \
      '    HOME="$home" \' \
      '    PATH=/usr/bin:/bin \' \
      '    GIT_CONFIG_NOSYSTEM=1 \' \
      '    GIT_CONFIG_GLOBAL=/dev/null \' \
      '    GIT_CONFIG_SYSTEM=/dev/null \' \
      '    GIT_TERMINAL_PROMPT=0 \' \
      '    GIT_ALLOW_PROTOCOL=https \' \
      '    /usr/bin/git \' \
      '    -c core.hooksPath=/dev/null \' \
      '    -c core.fsmonitor=false \' \
      '    -c credential.helper= \' \
      '    -c protocol.file.allow=never \' \
      '    -c protocol.ext.allow=never \' \
      '    "$@"' \
      '}' \
      'git init --quiet "$checkout"' \
      'git -C "$checkout" remote add github "$canonical"' \
      'test "$(git -C "$checkout" remote get-url --all github)" = "$canonical"' \
      'test "$(git -C "$checkout" remote get-url --push --all github)" = "$canonical"' \
      'advertised=$(git -C "$checkout" ls-remote github refs/heads/main)' \
      'expected=$(/usr/bin/printf '\''%s\t%s'\'' "$authority" refs/heads/main)' \
      'test "$advertised" = "$expected"' \
      'git -C "$checkout" fetch --quiet --no-tags --depth=1 github "$authority"' \
      'test "$(git -C "$checkout" rev-parse --verify FETCH_HEAD^{commit})" = "$authority"' \
      'git -C "$checkout" checkout --quiet --detach FETCH_HEAD' \
      'test "$(git -C "$checkout" rev-parse --verify HEAD)" = "$authority"' \
      'test -z "$(git -C "$checkout" status --porcelain=v1 --untracked-files=all)"' \
      'test "$(git -C "$checkout" remote get-url --all github)" = "$canonical"' \
      'tree=$(git -C "$checkout" ls-tree -r --full-tree HEAD)' \
      'case "$tree" in *"160000 commit "*) exit 1 ;; esac' \
      'test ! -e "$checkout/.gitmodules"' \
      '/usr/bin/env -i HOME="$home" PATH=/usr/bin:/bin /usr/bin/python3 -I -E -s "$checkout/benchmarks/swebench/provision.py" "$authority"' \
      'ALLOY_SWEBENCH_BOOTSTRAP'
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
    TEST_PYTHON="${ALLOY_SWEBENCH_TEST_PYTHON:-python3}"
    unset ALLOY_SWEBENCH_TEST_PYTHON
    exec "$TEST_PYTHON" -m unittest discover -s "$BENCH_ROOT/tests" -v
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
