import json
import socket
import sys


def tcp(host: str, port: int, family: int = socket.AF_INET) -> bool:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect((host, port))
        return True
    except OSError:
        return False


def resolves(host: str) -> bool:
    try:
        return bool(socket.getaddrinfo(host, 80, type=socket.SOCK_STREAM))
    except OSError:
        return False


def docker_dns_resolves(host: str) -> bool:
    labels = host.rstrip(".").split(".")
    question = b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels)
    query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + question + b"\x00\x00\x01\x00\x01"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
            connection.settimeout(1)
            connection.sendto(query, ("127.0.0.11", 53))
            response, _ = connection.recvfrom(4096)
        return len(response) >= 12 and response[3] & 0x0F == 0 and int.from_bytes(response[6:8]) > 0
    except OSError:
        return False


def relay_http(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2) as connection:
            connection.sendall(b"GET /api/tags HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n")
            response = connection.recv(4096)
        return b" 200 " in response
    except OSError:
        return False


if __name__ == "__main__":
    config = json.loads(sys.argv[1])
    results = {
        "docker_dns": docker_dns_resolves("example.com"),
        "external_resolution": resolves("example.com"),
        "relay": relay_http(*config["relay"]),
    }
    for name, target in config["tcp"].items():
        family = socket.AF_INET6 if ":" in target[0] else socket.AF_INET
        results[name] = tcp(target[0], target[1], family)
    print(json.dumps(results, sort_keys=True))
