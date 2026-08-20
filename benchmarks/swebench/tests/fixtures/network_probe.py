import json
import socket
import sys


def probe(host: str, port: int, family: int) -> bool:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect((host, port))
        return True
    except OSError:
        return False


if __name__ == "__main__":
    target = sys.argv[1]
    port = int(sys.argv[2])
    print(json.dumps({
        "ipv4": probe(target, port, socket.AF_INET),
        "ipv6": probe("::1", port, socket.AF_INET6),
    }, sort_keys=True))
