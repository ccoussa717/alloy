import json
import socket
import sys
from pathlib import Path


def tcp(endpoint):
    try:
        with socket.create_connection(tuple(endpoint), timeout=0.75):
            return True
    except OSError:
        return False


config = json.loads(sys.argv[1])
observed = {name: tcp(endpoint) for name, endpoint in config["tcp"].items()}
try:
    socket.getaddrinfo("example.com", 80)
except OSError:
    observed["dns"] = False
else:
    observed["dns"] = True

if "marker" in config:
    Path(config["marker"]).write_text(json.dumps(observed, sort_keys=True) + "\n")
print(json.dumps(observed, sort_keys=True))

expected = {name: False for name in observed}
if "proxy" in observed:
    expected["proxy"] = True
raise SystemExit(0 if observed == expected else 1)
