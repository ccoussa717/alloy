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


def dns(endpoint):
    query = b"\x12\x34\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.settimeout(0.75)
            connection.sendto(query, tuple(endpoint))
            connection.recvfrom(512)
        return True
    except OSError:
        return False


def relay_http(endpoint):
    host, port = endpoint
    try:
        with socket.create_connection((host, port), timeout=2) as connection:
            request = (
                f"GET /api/tags HTTP/1.1\r\nHost: {host}:{port}\r\n"
                "Connection: close\r\n\r\n"
            )
            connection.sendall(request.encode("ascii"))
            response = connection.recv(4096)
        return b" 200 " in response
    except OSError:
        return False


config = json.loads(sys.argv[1])
observed = {name: tcp(endpoint) for name, endpoint in config["tcp"].items()}
observed["dns"] = dns(config["dns"])
observed["relay"] = relay_http(config["relay"])

diagnostics = {
    "ipv4_routes": Path("/proc/net/route").read_text(),
    "ipv6_routes": Path("/proc/net/ipv6_route").read_text(),
    "interfaces": [name for _index, name in socket.if_nameindex()],
}
result = {
    "observed": observed,
    "boundaries": config["boundaries"],
    "route_diagnostics": diagnostics,
}

if "marker" in config:
    Path(config["marker"]).write_text(json.dumps(result, sort_keys=True) + "\n")
print(json.dumps(result, sort_keys=True))

expected = {
    name: boundary == "allowed-proxy-route"
    for name, boundary in config["boundaries"].items()
}
raise SystemExit(0 if observed == expected else 1)
