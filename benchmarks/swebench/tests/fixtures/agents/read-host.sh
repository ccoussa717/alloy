#!/bin/bash
set -euo pipefail

python3 - <<'PY'
import json
import os
import socket
from pathlib import Path

results = {}
for name in ("HOST_SECRET", "RESULT_SECRET", "DATASET_SECRET", "EVALUATOR_SECRET"):
    path = Path(os.environ[name])
    try:
        path.read_bytes()
    except OSError:
        results[name.lower()] = False
    else:
        results[name.lower()] = True

connected = False
client = socket.socket(socket.AF_UNIX)
client.settimeout(0.5)
try:
    client.connect("/var/run/docker.sock")
except OSError:
    pass
else:
    connected = True
finally:
    client.close()
results["docker_socket"] = connected

Path("/agent-work/fixture-marker.json").write_text(
    json.dumps(results, sort_keys=True) + "\n"
)
raise SystemExit(1 if any(results.values()) else 0)
PY
