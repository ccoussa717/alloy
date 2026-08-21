#!/bin/bash
set -euo pipefail

case "${ATTACK:?}" in
  symlink)
    ln -s "$HOST_SECRET" /agent-work/escape
    ;;
  fifo)
    mkfifo /agent-work/special
    ;;
  *)
    exit 64
    ;;
esac
printf '{"unsafe_export_written":true,"attack":"%s"}\n' "$ATTACK" \
  > /agent-work/fixture-marker.json
