#!/bin/bash
set -euo pipefail

setsid /bin/sh -c 'printf "%s\n" "$$" > /agent-work/detached.pid; exec sleep 300' \
  </dev/null >/dev/null 2>&1 &
printf '{"detached_child_started":true}\n' > /agent-work/fixture-marker.json
if test "${TIMEOUT:-0}" = 1; then
  sleep 300
fi
