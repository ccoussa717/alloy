#!/usr/bin/env bash
# Fast local secret and sensitive-path gate. Hosted CI also runs GitLab's
# maintained historic secret detector and validates its report.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pattern='(sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{36}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)'

scan_lines() {
  local found=0 line rest path
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    rest="$line"
    if [[ "$rest" =~ ^[0-9a-f]{7,40}:(.*)$ ]]; then
      rest="${BASH_REMATCH[1]}"
    fi
    path="${rest%%:*}"
    printf '%s\n' "$line" >&2
    found=1
  done
  return "$found"
}

git_grep_scan() {
  local output status
  set +e
  output="$(git grep "$@")"
  status=$?
  set -e
  if (( status > 1 )); then
    printf '%s\n' "FAIL: git grep could not complete" >&2
    return "$status"
  fi
  if (( status == 1 )); then
    return 0
  fi
  printf '%s\n' "$output" | scan_lines
}

printf '%s\n' "== tracked tree secret signatures =="
if ! git_grep_scan -I -nE "$pattern" -- .; then
  printf '%s\n' "FAIL: possible secret in tracked source" >&2
  exit 1
fi
printf '%s\n' "ok"

printf '%s\n' "== release worktree secret signatures =="
set +e
worktree_list="$(mktemp)"
trap 'rm -f "$worktree_list"' EXIT
git ls-files -z --cached --others --exclude-standard >"$worktree_list"
worktree_files_status=$?
set -e
if (( worktree_files_status != 0 )); then
  printf '%s\n' "FAIL: git ls-files could not enumerate the release worktree" >&2
  exit "$worktree_files_status"
fi
worktree_files=()
while IFS= read -r -d '' file; do
  [[ -f "$file" ]] && worktree_files[${#worktree_files[@]}]="$file"
done <"$worktree_list"
if (( ${#worktree_files[@]} > 0 )) && ! git_grep_scan --no-index -I -nE "$pattern" -- "${worktree_files[@]}"; then
  printf '%s\n' "FAIL: possible secret in release worktree" >&2
  exit 1
fi
printf '%s\n' "ok"

printf '%s\n' "== full history secret signatures =="
set +e
revision_output="$(git rev-list --all)"
revision_status=$?
set -e
if (( revision_status != 0 )); then
  printf '%s\n' "FAIL: git rev-list could not complete" >&2
  exit "$revision_status"
fi
revisions=()
if [[ -n "$revision_output" ]]; then
  while IFS= read -r revision; do
    revisions[${#revisions[@]}]="$revision"
  done <<<"$revision_output"
fi
if (( ${#revisions[@]} > 0 )) && ! git_grep_scan -I -nE "$pattern" "${revisions[@]}" -- .; then
  printf '%s\n' "FAIL: possible secret in git history" >&2
  exit 1
fi
printf '%s\n' "ok"

printf '%s\n' "== sensitive paths added in history =="
set +e
sensitive_paths="$(git log --all --full-history --diff-filter=A --name-only --format= -- \
  '**/.env' '**/.env.*' '**/auth.json' '**/*secret*' '**/*.pem' '**/*.key' \
  '**/*.p12' '**/*.pfx')"
log_status=$?
set -e
if (( log_status != 0 )); then
  printf '%s\n' "FAIL: git log could not complete" >&2
  exit "$log_status"
fi
if [[ -n "${sensitive_paths//[[:space:]]/}" ]]; then
  printf '%s\n' "$sensitive_paths" >&2
  printf '%s\n' "FAIL: sensitive-looking path exists in git history" >&2
  exit 1
fi
printf '%s\n' "ok"

printf '%s\n' "RESULT: PASS"
