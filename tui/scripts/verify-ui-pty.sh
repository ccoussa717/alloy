#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
FIXTURE="$ROOT/test/fixtures/fake-alloy-rpc.ts"
BUN_BIN="$(command -v bun)"
BASE="alloy-ui-pty-$$"
SESSION="$BASE-main"
NARROW="$BASE-narrow"
RESTORE="$BASE-restore"
LOSS="$BASE-loss"
SPLASH="$BASE-splash"
REMOTE_AUTO="$BASE-remote-auto"
REMOTE_ON="$BASE-remote-on"
EARLY_TERM="$BASE-early-term"
EARLY_INT="$BASE-early-int"
LOG="$ROOT/test/fixtures/.$BASE.log"
SELECTION_OUTPUT="$ROOT/test/fixtures/.$BASE-selection.raw"
REMOTE_AUTO_OUTPUT="$ROOT/test/fixtures/.$BASE-remote-auto.raw"
REMOTE_ON_OUTPUT="$ROOT/test/fixtures/.$BASE-remote-on.raw"

cleanup() {
  for session in "$SESSION" "$NARROW" "$RESTORE" "$LOSS" "$SPLASH" "$REMOTE_AUTO" "$REMOTE_ON" "$EARLY_TERM" "$EARLY_INT"; do
    tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session" || true
  done
  rm -f "$LOG" "$SELECTION_OUTPUT" "$REMOTE_AUTO_OUTPUT" "$REMOTE_ON_OUTPUT" "$ROOT/test/fixtures/.$BASE-early-"*.log "$ROOT/test/fixtures/.$BASE-early-"*.pid
}
trap cleanup EXIT

for command in bun cat grep pgrep sleep stty tmux wc; do
  command -v "$command" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$command" >&2; exit 1; }
done

run_command() {
  printf 'cd %q && ALLOY_FAKE_EMPTY=%q ALLOY_ACTIVITY_ANIMATION=%q SSH_CONNECTION=%q ALLOY_RPC_COMMAND=%q ALLOY_RPC_ARGS_JSON=%q ALLOY_VERSION=0.8.2 ALLOY_FAKE_LOG=%q bun run start' \
    "$ROOT" "${1:-0}" "${2:-on}" "${3:-}" "$BUN_BIN" "[\"$FIXTURE\"]" "$LOG"
}

capture() { tmux capture-pane -t "$1" -p; }

pipe_capture_command() { printf 'cat > %q' "$1"; }

wait_for_stable_file_size() {
  local path="$1" previous="" current="" stable=0 attempts=0
  while [ "$attempts" -lt 80 ]; do
    if [ -f "$path" ]; then
      current="$(wc -c < "$path")"
      if [[ "$current" == "$previous" ]]; then
        stable=$((stable + 1))
        [ "$stable" -ge 4 ] && return 0
      else
        stable=0
      fi
      previous="$current"
    fi
    attempts=$((attempts + 1))
    sleep 0.05
  done
  printf 'timed out waiting for stable file size: %s\n' "$path" >&2
  return 1
}

activity_line() {
  local line=""
  while IFS= read -r line; do
    case "$line" in *Working*) printf '%s' "$line"; return 0;; esac
  done <<EOF
$(capture "$1")
EOF
  return 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) printf 'assertion failed: %s\nexpected: %s\noutput:\n%s\n' "$3" "$2" "$1" >&2; exit 1 ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) printf 'assertion failed: %s\nunexpected: %s\noutput:\n%s\n' "$3" "$2" "$1" >&2; exit 1 ;;
    *) ;;
  esac
}

wait_for_text() {
  local session="$1" expected="$2" output="" attempts=0
  while [ "$attempts" -lt 80 ]; do
    tmux has-session -t "$session" 2>/dev/null || { printf 'session exited waiting for %s\n' "$expected" >&2; return 1; }
    output="$(capture "$session")"
    case "$output" in *"$expected"*) printf '%s' "$output"; return 0;; esac
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for %s\n%s\n' "$expected" "$output" >&2
  return 1
}

wait_for_log() {
  local expected="$1" log="${2:-$LOG}" attempts=0
  while [ "$attempts" -lt 80 ]; do
    if [ -f "$log" ] && grep -F "$expected" "$log" >/dev/null; then return 0; fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for RPC log: %s\n' "$expected" >&2
  [ -f "$log" ] && grep . "$log" >&2 || true
  return 1
}

wait_for_log_count() {
  local expected="$1" count="$2" log="${3:-$LOG}" attempts=0 observed=0
  while [ "$attempts" -lt 80 ]; do
    if [ -f "$log" ]; then observed="$(grep -Fc "$expected" "$log" || true)"; fi
    [ "$observed" -ge "$count" ] && return 0
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for %s occurrences of RPC log entry: %s (observed %s)\n' "$count" "$expected" "$observed" >&2
  return 1
}

wait_for_file() {
  local path="$1" attempts=0
  while [ "$attempts" -lt 80 ]; do
    [ -s "$path" ] && return 0
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for file: %s\n' "$path" >&2
  return 1
}

terminal_state() { tmux display-message -p -t "$1" '#{alternate_on}:#{cursor_flag}:#{mouse_any_flag}'; }

wait_for_terminal_state() {
  local session="$1" expected="$2" state="" attempts=0
  while [ "$attempts" -lt 80 ]; do
    state="$(terminal_state "$session")"
    [ "$state" = "$expected" ] && return 0
    attempts=$((attempts + 1))
    sleep 0.1
  done
  printf 'timed out waiting for terminal state %s; observed %s\n' "$expected" "$state" >&2
  return 1
}

exercise_early_signal() {
  local signal="$1" expected_code="$2" session="$3"
  local log="$ROOT/test/fixtures/.$BASE-early-$signal.log"
  local pid_file="$ROOT/test/fixtures/.$BASE-early-$signal.pid"
  local early_run backend_pid pane_pid frontend_pids frontend_pid result

  early_run="$(printf 'cd %q && ALLOY_RPC_COMMAND=%q ALLOY_RPC_ARGS_JSON=%q ALLOY_VERSION=0.8.2 ALLOY_FAKE_LOG=%q ALLOY_FAKE_PID_FILE=%q ALLOY_FAKE_STARTUP_DELAY_MS=10000 bun run start' \
    "$ROOT" "$BUN_BIN" "[\"$FIXTURE\"]" "$log" "$pid_file")"
  tmux new-session -d -s "$session" -x 80 -y 24 \
    "before=\$(stty -g); $early_run; code=\$?; after=\$(stty -g); if [ \"\$before\" = \"\$after\" ]; then printf 'EARLY_CHECK:RESTORED:%s\\n' \"\$code\"; else printf 'EARLY_CHECK:MISMATCH:%s\\n' \"\$code\"; fi; sleep 20"
  wait_for_file "$pid_file"
  backend_pid="$(<"$pid_file")"
  pane_pid="$(tmux display-message -p -t "$session" '#{pane_pid}')"
  frontend_pids="$(pgrep -P "$pane_pid" || true)"
  set -- $frontend_pids
  [ "$#" -eq 1 ] || { printf 'expected one pre-readiness frontend process, found: %s\n' "${frontend_pids:-none}" >&2; exit 1; }
  frontend_pid="$1"
  kill -"$signal" "$frontend_pid"
  result="$(wait_for_text "$session" 'EARLY_CHECK:')"
  assert_contains "$result" "EARLY_CHECK:RESTORED:$expected_code" "pre-readiness $signal restores terminal"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$backend_pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$backend_pid" 2>/dev/null; then
    printf 'pre-readiness %s orphaned backend %s\n' "$signal" "$backend_pid" >&2
    exit 1
  fi
}

RUN="$(run_command 0)"
SPLASH_RUN="$(run_command 1)"
REMOTE_AUTO_RUN="$(run_command 0 auto fixture)"
REMOTE_ON_RUN="$(run_command 0 on fixture)"

exercise_early_signal TERM 143 "$EARLY_TERM"
exercise_early_signal INT 130 "$EARLY_INT"

tmux new-session -d -s "$SESSION" -x 80 -y 24 "$RUN"
initial="$(wait_for_text "$SESSION" 'hydrated history item 50')"
assert_contains "$initial" "ALLOY" "launch identity"
assert_contains "$initial" "fixture widget" "extension widget"
assert_contains "$initial" "Plan" "extension status"
assert_contains "$(tmux display-message -p -t "$SESSION" '#{pane_title}')" "ALLOY | Fixture title" "extension title"
wait_for_log '"type":"get_messages"'
wait_for_log '"type":"get_commands"'
wait_for_log '"type":"get_available_models"'
wait_for_log '"type":"get_session_stats"'

tmux pipe-pane -t "$SESSION" -o "$(pipe_capture_command "$SELECTION_OUTPUT")"
selection_drag="$(printf '\033[<0;3;1M\033[<32;7;1M')"
tmux send-keys -t "$SESSION" -l "$selection_drag"
sleep 0.1
if [ -f "$SELECTION_OUTPUT" ] && grep -F ']52;' "$SELECTION_OUTPUT" >/dev/null; then
  printf 'selection copied before mouse release\n' >&2
  exit 1
fi
selection_release="$(printf '\033[<0;7;1m')"
tmux send-keys -t "$SESSION" -l "$selection_release"
wait_for_log ']52;' "$SELECTION_OUTPUT"
wait_for_log 'QUxMTw==' "$SELECTION_OUTPUT"
tmux pipe-pane -t "$SESSION"

tmux send-keys -t "$SESSION" -l "PTY prompt"
tmux send-keys -t "$SESSION" Enter
wait_for_log '"message":"PTY prompt"'
wheel_up="$(printf '\033[<64;10;10M')"
wheel_down="$(printf '\033[<65;10;10M')"
wait_for_text "$SESSION" 'Working' >/dev/null
working_frame_a="$(activity_line "$SESSION")"
sleep 0.12
working_frame_b="$(activity_line "$SESSION")"
if [[ "$working_frame_a" == "$working_frame_b" ]]; then
  printf 'activity scanner did not advance while the backend was working\n' >&2
  exit 1
fi
tmux send-keys -t "$SESSION" -l "$wheel_up$wheel_up$wheel_up$wheel_up"
sleep 0.8
scrolled="$(capture "$SESSION")"
assert_not_contains "$scrolled" "streamed assistant text" "wheel pauses sticky tail"
assert_contains "$scrolled" "hydrated history item" "wheel reveals history"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do tmux send-keys -t "$SESSION" -l "$wheel_down"; done
streamed="$(wait_for_text "$SESSION" 'streamed assistant text')"
assert_contains "$streamed" "✓ Read /tmp/example.ts" "completed tool row"
assert_contains "$streamed" "✓ $ printf 'fixture command'" "completed command row"
assert_contains "$streamed" 'const status: string = "visible"' "syntax-rendered fenced TypeScript"
wait_for_text "$SESSION" 'Ready' >/dev/null

model_refreshes="$(grep -Fc '"type":"get_available_models"' "$LOG")"
tmux send-keys -t "$SESSION" -l "/model fake/fresh-model"
tmux send-keys -t "$SESSION" Enter
wait_for_log_count '"type":"get_available_models"' "$((model_refreshes + 1))"
wait_for_log '"type":"set_model","provider":"fake","modelId":"fresh-model"'
wait_for_text "$SESSION" 'fresh-model fake' >/dev/null

tmux send-keys -t "$SESSION" -l "/model"
tmux send-keys -t "$SESSION" Enter
provider_dialog="$(wait_for_text "$SESSION" 'Select provider')"
assert_contains "$provider_dialog" "fake" "model selector groups refreshed models by provider"
assert_contains "$provider_dialog" "xai" "model selector includes the authenticated xAI provider"
wait_for_log_count '"type":"get_available_models"' "$((model_refreshes + 2))"
tmux send-keys -t "$SESSION" Down
tmux send-keys -t "$SESSION" Enter
model_dialog="$(wait_for_text "$SESSION" 'Select xai model')"
assert_contains "$model_dialog" "grok-model" "provider selection opens only that provider's models"
tmux send-keys -t "$SESSION" Escape
provider_back="$(wait_for_text "$SESSION" 'Select provider')"
assert_contains "$provider_back" "> xai" "model escape returns to the previously selected provider"
tmux send-keys -t "$SESSION" Enter
wait_for_text "$SESSION" 'Select xai model' >/dev/null
tmux send-keys -t "$SESSION" C-c
sleep 0.1
assert_not_contains "$(capture "$SESSION")" "Select xai model" "Ctrl+C closes the complete model selector"

tmux send-keys -t "$SESSION" -l "/model"
tmux send-keys -t "$SESSION" Enter
wait_for_text "$SESSION" 'Select provider' >/dev/null
tmux send-keys -t "$SESSION" Down
tmux send-keys -t "$SESSION" Enter
wait_for_text "$SESSION" 'Select xai model' >/dev/null
tmux send-keys -t "$SESSION" Enter
wait_for_log '"type":"set_model","provider":"xai","modelId":"grok-model"'

tmux send-keys -t "$SESSION" -l "/login-fixture"
tmux send-keys -t "$SESSION" Enter
login_dialog="$(wait_for_text "$SESSION" 'auth.example.test/authorize')"
assert_contains "$login_dialog" "ABCD-EFGH" "login device code remains visible in prompt"
assert_contains "$login_dialog" "Paste the authorization response below" "login prompt remains visible with URL"
tmux send-keys -t "$SESSION" Escape
wait_for_log '"id":"login-1","cancelled":true'

tmux new-session -d -s "$REMOTE_ON" -x 80 -y 24 "$REMOTE_ON_RUN"
tmux pipe-pane -t "$REMOTE_ON" -o "$(pipe_capture_command "$REMOTE_ON_OUTPUT")"
wait_for_text "$REMOTE_ON" 'hydrated history item 50' >/dev/null
tmux send-keys -t "$REMOTE_ON" -l "hold"
tmux send-keys -t "$REMOTE_ON" Enter
wait_for_text "$REMOTE_ON" 'Working' >/dev/null
sleep 0.12
remote_on_bytes_before="$(wc -c < "$REMOTE_ON_OUTPUT")"
sleep 0.25
remote_on_bytes_after="$(wc -c < "$REMOTE_ON_OUTPUT")"
if [[ "$remote_on_bytes_before" == "$remote_on_bytes_after" ]]; then
  printf 'raw PTY capture did not observe forced SSH animation\n' >&2
  exit 1
fi
tmux kill-session -t "$REMOTE_ON"

tmux new-session -d -s "$REMOTE_AUTO" -x 80 -y 24 "$REMOTE_AUTO_RUN"
tmux pipe-pane -t "$REMOTE_AUTO" -o "$(pipe_capture_command "$REMOTE_AUTO_OUTPUT")"
wait_for_text "$REMOTE_AUTO" 'hydrated history item 50' >/dev/null
tmux send-keys -t "$REMOTE_AUTO" -l "hold"
tmux send-keys -t "$REMOTE_AUTO" Enter
wait_for_text "$REMOTE_AUTO" 'Working' >/dev/null
wait_for_stable_file_size "$REMOTE_AUTO_OUTPUT"
remote_auto_bytes_before="$(wc -c < "$REMOTE_AUTO_OUTPUT")"
sleep 0.25
remote_auto_bytes_after="$(wc -c < "$REMOTE_AUTO_OUTPUT")"
if [[ "$remote_auto_bytes_before" != "$remote_auto_bytes_after" ]]; then
  printf 'TUI emitted continuous redraw bytes over SSH auto mode\n' >&2
  exit 1
fi
tmux kill-session -t "$REMOTE_AUTO"

tmux send-keys -t "$SESSION" BTab
wait_for_log '"message":"/build"'
wait_for_text "$SESSION" 'Mode command received' >/dev/null

tmux send-keys -t "$SESSION" -l "/approval"
tmux send-keys -t "$SESSION" Enter
wait_for_text "$SESSION" '> Deny' >/dev/null
tmux send-keys -t "$SESSION" Up
wait_for_text "$SESSION" '> Allow' >/dev/null
tmux send-keys -t "$SESSION" Enter
wait_for_log '"id":"approval-1","confirmed":true'
wait_for_text "$SESSION" 'Approval received: allow' >/dev/null

tmux send-keys -t "$SESSION" -l "/cancel"
tmux send-keys -t "$SESSION" Enter
wait_for_text "$SESSION" 'Escape must cancel' >/dev/null
tmux send-keys -t "$SESSION" Escape
wait_for_log '"id":"cancel-1","cancelled":true'
wait_for_text "$SESSION" 'Cancellation received' >/dev/null

tmux resize-window -t "$SESSION" -x 40 -y 10
narrow_resize="$(wait_for_text "$SESSION" 'Ctrl+C exit')"
assert_contains "$narrow_resize" "Ask anything" "40x10 composer"
tmux send-keys -t "$SESSION" C-c
sleep 0.3
tmux has-session -t "$SESSION" 2>/dev/null && { printf 'idle Ctrl-C did not exit\n' >&2; exit 1; }

tmux new-session -d -s "$NARROW" -x 40 -y 10 "$RUN"
narrow_launch="$(wait_for_text "$NARROW" 'hydrated history item 50')"
assert_contains "$narrow_launch" "hydrated history item 50" "40x10 hydration"
assert_contains "$narrow_launch" "Ask anything" "40x10 composer"
tmux send-keys -t "$NARROW" -l "/login-fixture"
tmux send-keys -t "$NARROW" Enter
narrow_login="$(wait_for_text "$NARROW" 'auth.example.test')"
assert_contains "$narrow_login" "authorization code" "40x10 login keeps the input visible"
narrow_login_scroll="$(printf '\033[<65;10;4M')"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do tmux send-keys -t "$NARROW" -l "$narrow_login_scroll"; done
wait_for_text "$NARROW" 'Paste the authorization response b' >/dev/null
tmux send-keys -t "$NARROW" Escape
tmux send-keys -t "$NARROW" C-c

tmux new-session -d -s "$RESTORE" -x 80 -y 24 \
  "before=\$(stty -g); $RUN; code=\$?; after=\$(stty -g); if [ \"\$before\" = \"\$after\" ]; then printf 'TERMINAL_CHECK:RESTORED:%s\\n' \"\$code\"; else printf 'TERMINAL_CHECK:MISMATCH:%s\\n' \"\$code\"; fi; sleep 20"
wait_for_text "$RESTORE" 'hydrated history item 50' >/dev/null
wait_for_terminal_state "$RESTORE" "1:1:1"
tmux send-keys -t "$RESTORE" -l "hold"
tmux send-keys -t "$RESTORE" Enter
wait_for_text "$RESTORE" 'Working' >/dev/null
tmux send-keys -t "$RESTORE" C-c
wait_for_log '"type":"abort"'
wait_for_text "$RESTORE" 'Ready' >/dev/null
tmux send-keys -t "$RESTORE" C-c
restored="$(wait_for_text "$RESTORE" 'TERMINAL_CHECK:')"
assert_contains "$restored" "TERMINAL_CHECK:RESTORED:0" "abort then idle exit restores terminal"
wait_for_terminal_state "$RESTORE" "0:1:0"

tmux new-session -d -s "$LOSS" -x 80 -y 24 \
  "before=\$(stty -g); $RUN; code=\$?; after=\$(stty -g); if [ \"\$before\" = \"\$after\" ]; then printf 'LOSS_CHECK:RESTORED:%s\\n' \"\$code\"; else printf 'LOSS_CHECK:MISMATCH:%s\\n' \"\$code\"; fi; sleep 20"
wait_for_text "$LOSS" 'hydrated history item 50' >/dev/null
tmux send-keys -t "$LOSS" -l "/backend-loss"
tmux send-keys -t "$LOSS" Enter
lost="$(wait_for_text "$LOSS" 'LOSS_CHECK:')"
assert_contains "$lost" "LOSS_CHECK:RESTORED:1" "backend loss exits nonzero and restores terminal"

tmux new-session -d -s "$SPLASH" -x 80 -y 24 "$SPLASH_RUN"
splash="$(wait_for_text "$SPLASH" 'MULTI-MODEL CODING HARNESS')"
assert_contains "$splash" "──────────────────────────" "green splash divider"
tmux send-keys -t "$SPLASH" C-c

printf 'Alloy UI PTY verification passed: pre-readiness SIGTERM/SIGINT cleanup, hydration, mouse-release clipboard copy, visible login URL, local/forced activity animation, SSH-static raw output, tools, commands, syntax rendering, splash divider, sticky wheel, extension allow/cancel, 40x10, abort/exit, backend loss, terminal restoration\n'
