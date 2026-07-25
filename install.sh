#!/usr/bin/env bash
# Install one immutable Alloy npm release on Linux or macOS.
set -euo pipefail

ALLOY_NODE_MIN="${ALLOY_NODE_MIN:-22.19}"

log() { printf '==> %s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s 2>/dev/null || true)" in
  Linux|Darwin) ;;
  *) err "Alloy currently supports Linux and macOS" ;;
esac

command -v node >/dev/null 2>&1 || err "Node.js ${ALLOY_NODE_MIN}+ is required"
command -v npm >/dev/null 2>&1 || err "npm is required"

node -e '
  const need = process.argv[1].split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  const ok = have[0] > need[0] ||
    (have[0] === need[0] && have[1] >= need[1]);
  process.exit(ok ? 0 : 1);
' "$ALLOY_NODE_MIN" || err "Node.js ${ALLOY_NODE_MIN}+ is required; found $(node --version)"

# The registry identity is not public yet. Require an explicitly reviewed local
# artifact so this pre-release installer cannot resolve an unclaimed name.
ALLOY_PACKAGE_SPEC="${ALLOY_PACKAGE_SPEC:-}"
[[ -n "$ALLOY_PACKAGE_SPEC" ]] || err "set ALLOY_PACKAGE_SPEC to a reviewed local .tgz artifact"
case "$ALLOY_PACKAGE_SPEC" in
  /*.tgz|./*.tgz|../*.tgz) ;;
  *) err "ALLOY_PACKAGE_SPEC must be a reviewed local .tgz path" ;;
esac

log "Installing ${ALLOY_PACKAGE_SPEC}"
npm install --global --ignore-scripts "$ALLOY_PACKAGE_SPEC"

command -v alloy >/dev/null 2>&1 || err "npm installed Alloy but alloy is not on PATH"
alloy --version
alloy --no-inject --list-models >/dev/null

log "Alloy is ready. Run: alloy"
