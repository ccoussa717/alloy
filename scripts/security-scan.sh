#!/usr/bin/env bash
# Alloy engineering secret/signature scan (not a substitute for full SCA).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Alloy security scan =="
echo "root: $ROOT"
echo "head: $(git rev-parse --short HEAD 2>/dev/null || echo 'n/a')"
echo

FAIL=0

# Real-looking credential signatures. Documentation of this pattern lives in
# docs/SECURITY.md without embedding these exact prefixes end-to-end.
pattern='sk-ant-|sk-proj-|sk-or-|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----|xai-[A-Za-z0-9]{20,}'

# Paths that legitimately mention patterns (scanner itself, lockfile noise).
is_allowlisted_path() {
  local path="$1"
  case "$path" in
    scripts/security-scan.sh|package-lock.json|node_modules/*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "-- tracked tree (exclude node_modules) --"
TREE_HITS=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path="${line%%:*}"
  if is_allowlisted_path "$path"; then
    continue
  fi
  # Docs may describe the scan; only fail if a line looks like an assigned secret.
  if [[ "$path" == docs/* ]] || [[ "$path" == README.md ]] || [[ "$path" == SECURITY.md ]]; then
    if [[ "$line" =~ (TOKEN|KEY|SECRET|password|BEGIN)[[:space:]]*= ]] || [[ "$line" =~ \"sk-ant- ]]; then
      echo "$line"
      TREE_HITS=1
    fi
    continue
  fi
  echo "$line"
  TREE_HITS=1
done < <(git grep -I -nE "$pattern" -- ':(exclude)node_modules' 2>/dev/null || true)

if [[ "$TREE_HITS" -ne 0 ]]; then
  echo "FAIL: pattern match in tracked tree" >&2
  FAIL=1
else
  echo "ok: no signature matches in tracked tree"
fi
echo

echo "-- git history (all commits, same patterns; skip allowlisted paths) --"
if git rev-list --all >/dev/null 2>&1; then
  HIST_HITS=0
  # Limit output; fail if any non-allowlisted path matches
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # format: <commit>:path:line:content  OR path:line when single tree — git grep with revs uses commit:path
    rest="$line"
    # strip commit hash prefix if present
    if [[ "$rest" =~ ^[0-9a-f]{7,40}:(.*)$ ]]; then
      rest="${BASH_REMATCH[1]}"
    fi
    path="${rest%%:*}"
    if is_allowlisted_path "$path"; then
      continue
    fi
    if [[ "$path" == docs/* ]] || [[ "$path" == README.md ]] || [[ "$path" == SECURITY.md ]]; then
      continue
    fi
    echo "$line"
    HIST_HITS=1
  done < <(git grep -I -nE "$pattern" $(git rev-list --all) 2>/dev/null | head -80 || true)

  if [[ "$HIST_HITS" -ne 0 ]]; then
    echo "FAIL: pattern match in history" >&2
    FAIL=1
  else
    echo "ok: no signature matches in history"
  fi
else
  echo "skip: not a git repo"
fi
echo

echo "-- sensitive path additions in history --"
SENS=$(git log --all --full-history --diff-filter=A --summary -- \
  '**/.env' '**/auth.json' '**/*secret*' '**/*.pem' '**/*.key' 2>/dev/null || true)
if [[ -n "${SENS// }" ]]; then
  echo "$SENS"
  echo "WARN: sensitive-looking paths added in history (review manually)" >&2
else
  echo "ok: no .env/auth.json/pem/key path additions"
fi
echo

echo "-- npm audit (informational; does not fail this script) --"
if command -v npm >/dev/null 2>&1; then
  npm audit --omit=dev 2>&1 | tail -25 || true
else
  echo "skip: npm not available"
fi
echo

if [[ "$FAIL" -ne 0 ]]; then
  echo "RESULT: FAIL" >&2
  exit 1
fi
echo "RESULT: PASS (signature scan clean; npm audit is advisory)"
exit 0
