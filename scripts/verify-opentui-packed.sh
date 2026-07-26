#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NODE_BIN="${NODE_22_19:-$(command -v node)}"
BUN_BIN="${ALLOY_BUN_BIN:-$(command -v bun)}"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/alloy-opentui-verification"
mkdir -p "$CACHE_ROOT"
WORK="$(mktemp -d "$CACHE_ROOT/packed.XXXXXX")"
SESSION="alloy-packed-$$"

cleanup() {
  tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true
  if [[ "${KEEP_VERIFY_ARTIFACTS:-0}" != "1" ]]; then
    rm -rf "$WORK"
  else
    printf 'Retained verification artifact: %s\n' "$WORK"
  fi
}
trap cleanup EXIT

for command in pgrep tar tmux; do
  command -v "$command" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$command" >&2; exit 1; }
done
[[ -x "$NPM_BIN" ]] || { printf 'npm was not found next to recorded Node: %s\n' "$NPM_BIN" >&2; exit 1; }
"$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
' || {
  printf 'Node 22.19+ is required; set NODE_22_19 to the recorded binary\n' >&2
  exit 1
}
[[ "$("$BUN_BIN" --version)" == "1.3.14" ]] || {
  printf 'Bun 1.3.14 is required; set ALLOY_BUN_BIN to the exact binary\n' >&2
  exit 1
}

PACK_JSON="$(cd "$ROOT" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" pack --json --pack-destination "$WORK" --ignore-scripts --silent)"
PACK_JSON_FILE="$WORK/npm-pack.json"
printf '%s\n' "$PACK_JSON" > "$PACK_JSON_FILE"
TARBALL="$WORK/$($NODE_BIN -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(value[0].filename)' "$PACK_JSON")"
[[ -f "$TARBALL" ]] || { printf 'npm pack did not create %s\n' "$TARBALL" >&2; exit 1; }

mkdir -p "$WORK/app"
tar -xzf "$TARBALL" -C "$WORK/app" --strip-components=1
[[ ! -d "$WORK/app/tui/node_modules" ]] || { printf 'packed archive leaked tui/node_modules\n' >&2; exit 1; }

(
  cd "$WORK/app"
  "$NODE_BIN" ./scripts/verify-tui-release.mjs \
    --pack-json "$PACK_JSON_FILE" \
    --packed-root "$WORK/app"
)

(cd "$WORK/app" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund >/dev/null)
(cd "$WORK/app/tui" && "$BUN_BIN" install --frozen-lockfile --production >/dev/null)

(
  cd "$WORK/app"
  "$NODE_BIN" ./scripts/verify-tui-release.mjs \
    --pack-json "$PACK_JSON_FILE" \
    --packed-root "$WORK/app" \
    --installed-tui "$WORK/app/tui/node_modules"
)

RUN="before=\$(stty -g); TMPDIR=$(printf %q "$WORK") PI_CODING_AGENT_DIR=$(printf %q "$WORK/pi-agent") ALLOY_NO_CLEAR=1 ALLOY_BUN_BIN=$(printf %q "$BUN_BIN") $(printf %q "$NODE_BIN") $(printf %q "$WORK/app/bin/alloy.mjs") --no-session --approve; code=\$?; after=\$(stty -g); if [ \"\$before\" = \"\$after\" ]; then printf 'PACKED_CHECK:RESTORED:%s\\n' \"\$code\"; else printf 'PACKED_CHECK:MISMATCH:%s\\n' \"\$code\"; fi; sleep 20"
tmux new-session -d -s "$SESSION" -x 80 -y 24 "$RUN"

wait_for_text() {
  local expected="$1" output="" attempts=0
  while [[ "$attempts" -lt 100 ]]; do
    tmux has-session -t "$SESSION" 2>/dev/null || { printf 'session exited waiting for %s\n' "$expected" >&2; return 1; }
    output="$(tmux capture-pane -t "$SESSION" -p)"
    case "$output" in *"$expected"*) printf '%s' "$output"; return 0;; esac
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for %s\n%s\n' "$expected" "$output" >&2
  return 1
}

initial="$(wait_for_text 'MULTI-MODEL CODING HARNESS')"
case "$initial" in *"Ask anything"*) ;; *) printf 'packed composer not visible\n%s\n' "$initial" >&2; exit 1;; esac

tmux send-keys -t "$SESSION" -l "/alloy"
tmux send-keys -t "$SESSION" Enter
dialog="$(wait_for_text 'OpenCode splash')"
case "$dialog" in *"Alloy v"*) ;; *) printf 'packed extension dialog not visible\n%s\n' "$dialog" >&2; exit 1;; esac

tmux send-keys -t "$SESSION" Escape
sleep 0.5
tmux send-keys -t "$SESSION" -l "/chrome"
tmux send-keys -t "$SESSION" Enter
chrome="$(wait_for_text '/chrome is only available with --legacy-pi-ui.')"
case "$chrome" in *"Chrome cleared"*) printf 'packed OpenTUI falsely reported legacy chrome cleanup\n%s\n' "$chrome" >&2; exit 1;; esac

pane_pid="$(tmux display-message -p -t "$SESSION" '#{pane_pid}')"
launcher_pids="$(pgrep -P "$pane_pid" || true)"
set -- $launcher_pids
[[ "$#" -eq 1 ]] || {
  printf 'expected one outer launcher child of pane %s, found: %s\n' "$pane_pid" "${launcher_pids:-none}" >&2
  exit 1
}
kill -TERM "$1"
restored="$(wait_for_text 'PACKED_CHECK:')"
case "$restored" in *"PACKED_CHECK:RESTORED:143"*) ;; *) printf 'packed SIGTERM restoration failed\n%s\n' "$restored" >&2; exit 1;; esac

size="$(wc -c < "$TARBALL" | tr -d ' ')"
printf 'Packed Alloy OpenTUI verification passed: %s bytes, real RPC backend, extension dialog, frontend-aware chrome, outer SIGTERM forwarded, terminal restored\n' "$size"
