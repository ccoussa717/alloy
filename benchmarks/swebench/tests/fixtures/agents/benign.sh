#!/bin/bash
set -euo pipefail

printf 'after\n' > /agent-work/README.txt
printf '{"patch_written":true}\n' > /agent-work/fixture-marker.json
