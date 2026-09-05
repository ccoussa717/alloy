#!/bin/bash
set -euo pipefail

mkdir -p /agent-work/.git
cat > /agent-work/.git/config <<EOF
[diff "hostile"]
    command = /bin/sh -c 'printf executed > /agent-work/git-command-executed'
[core]
    hooksPath = /agent-work/hooks
EOF
printf '* diff=hostile filter=hostile\n' > /agent-work/.gitattributes
printf 'hostile metadata exported\n' > /agent-work/hostile.txt
printf '{"git_metadata_written":true}\n' > /agent-work/fixture-marker.json
