from __future__ import annotations

import atexit
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import signal
import socket
import socketserver
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Mapping, Sequence
from urllib.parse import urlsplit

from benchmarks.swebench.cleanup import CleanupUncertaintyError

if TYPE_CHECKING:
    from benchmarks.swebench.containers import ContainerHandle, DockerRuntime


HEADER_LIMIT = 32 * 1024
BODY_LIMIT = 16 * 1024 * 1024
PROXY_PORT = 8080
PINNED_MODEL = "qwen3.8-alloy:latest"
REVIEWED_ROUTES = (
    ("GET", "/api/tags"),
    ("POST", "/api/show"),
    ("POST", "/v1/chat/completions"),
)
NFT_BIN = "/usr/sbin/nft"
LOCK_PATH = "/run/lock/alloy-swebench-proxy.lock"
DOCKER_BIN = "/usr/bin/docker"
DOCKER_ENDPOINT = "unix:///var/run/docker.sock"
LABEL = "alloy.swebench.gate"
FIXED_ENV = {
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}
SAFE_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
TOKEN_PREFIX = "alloy-swe-"
PROXY_CONTAINER_PREFIX = "alloy-proxy-"
HOP_HEADERS = {
    "expect",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


@dataclass(frozen=True)
class ValidatedRequest:
    method: str
    target: str
    headers: tuple[tuple[str, str], ...]
    body: bytes
    json_body: dict[str, object] | None


@dataclass(frozen=True)
class ProxyEndpoint:
    url: str
    host: str
    port: int
    network: str
    container: "ContainerHandle"
    inspection: dict[str, object]


class ProxyStateError(RuntimeError):
    pass


class ProxyCleanupError(CleanupUncertaintyError):
    def __init__(
        self,
        errors: Sequence[BaseException],
        *,
        original_error: BaseException | None = None,
    ) -> None:
        self.errors = tuple(errors)
        super().__init__(
            "proxy cleanup could not prove complete: " + "; ".join(map(str, errors)),
            original_error=original_error,
            cleanup_errors=self.errors,
        )


class _ProcessLock:
    def __init__(self, path: str = LOCK_PATH) -> None:
        flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
        try:
            self.fd = os.open(path, flags, 0o600)
            metadata = os.fstat(self.fd)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                raise ProxyStateError("proxy lifecycle lock is not a private root-owned file")
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(self.fd)
            raise ProxyStateError("an active proxy network lifecycle owns the gate lock") from error
        except BaseException:
            if hasattr(self, "fd"):
                os.close(self.fd)
            raise

    def close(self) -> None:
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def _pairs_without_duplicates(value: bytes) -> dict[str, object]:
    def object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("JSON object contains duplicate keys")
            result[key] = item
        return result

    try:
        decoded = json.loads(
            value,
            object_pairs_hook=object_pairs,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"non-finite JSON value {constant} is forbidden")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("request body must be valid JSON") from error
    if not isinstance(decoded, dict):
        raise ValueError("request JSON must be an object")
    return decoded


class ProxyPolicy:
    def __init__(
        self,
        allowed_routes: Sequence[tuple[str, str]],
        model: str,
        expected_host: str,
        *,
        header_limit: int = HEADER_LIMIT,
        body_limit: int = BODY_LIMIT,
    ) -> None:
        if tuple(allowed_routes) != REVIEWED_ROUTES:
            raise ValueError("proxy routes must equal the reviewed route set")
        if model != PINNED_MODEL:
            raise ValueError("proxy model must equal the pinned Ollama model")
        self.allowed_routes = frozenset(REVIEWED_ROUTES)
        self.model = model
        self.expected_host = expected_host
        self.header_limit = header_limit
        self.body_limit = body_limit

    def validate(
        self,
        method: str,
        target: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> ValidatedRequest:
        if method != method.upper() or (method, target) not in self.allowed_routes:
            raise ValueError("method and target are not allowed")
        parsed = urlsplit(target)
        if (
            not target.startswith("/")
            or target.startswith("//")
            or parsed.scheme
            or parsed.netloc
            or parsed.query
            or parsed.fragment
            or parsed.path != target
        ):
            raise ValueError("request target must use exact origin form")
        if len(body) > self.body_limit:
            raise ValueError("request body exceeds limit")

        raw_items = getattr(headers, "raw_items", None)
        pairs = list(raw_items()) if callable(raw_items) else list(headers.items())
        if sum(len(name) + len(value) + 4 for name, value in pairs) > self.header_limit:
            raise ValueError("request headers exceed limit")
        grouped: dict[str, list[str]] = {}
        for name, value in pairs:
            if not isinstance(name, str) or not isinstance(value, str):
                raise ValueError("request headers must be strings")
            lowered = name.lower()
            grouped.setdefault(lowered, []).append(value)
            if lowered == "connection":
                if value.lower().strip() != "close":
                    raise ValueError("only Connection: close is accepted")
                continue
            if lowered in HOP_HEADERS:
                raise ValueError("hop-by-hop and streaming request headers are forbidden")
            if "\r" in value or "\n" in value:
                raise ValueError("folded request headers are forbidden")
        if grouped.get("host") != [self.expected_host]:
            raise ValueError("request Host is not the proxy endpoint")
        if len(grouped.get("connection", [])) > 1:
            raise ValueError("duplicate Connection headers are forbidden")
        if "transfer-encoding" in grouped:
            raise ValueError("transfer encoding is forbidden")

        lengths = grouped.get("content-length", [])
        if len(lengths) > 1 or (lengths and re.fullmatch(r"0|[1-9][0-9]*", lengths[0]) is None):
            raise ValueError("content length is ambiguous")
        declared = int(lengths[0]) if lengths else 0
        if declared != len(body):
            raise ValueError("content length does not match body")

        parsed_body: dict[str, object] | None = None
        if method == "GET":
            if body or declared:
                raise ValueError("GET body is forbidden")
        else:
            if grouped.get("content-type") != ["application/json"]:
                raise ValueError("POST content type must be application/json")
            parsed_body = _pairs_without_duplicates(body)
            if target == "/api/show":
                model_fields = [name for name in ("name", "model") if name in parsed_body]
                if model_fields != ["name"] or parsed_body["name"] != self.model:
                    raise ValueError("show request must name the pinned model")
            elif parsed_body.get("model") != self.model:
                raise ValueError("chat request must name the pinned model")

        safe_headers = tuple(
            (name, value)
            for name, value in pairs
            if name.lower() in {"accept", "content-type"}
        )
        return ValidatedRequest(method, target, safe_headers, body, parsed_body)


class _RelayHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        upstream = socket.create_connection(self.server.origin, timeout=10)
        upstream.settimeout(30)
        self.request.settimeout(30)

        def pump(source: socket.socket, destination: socket.socket) -> None:
            try:
                while True:
                    data = source.recv(64 * 1024)
                    if not data:
                        break
                    destination.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    destination.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        request_thread = threading.Thread(
            target=pump, args=(self.request, upstream), daemon=True
        )
        try:
            request_thread.start()
            pump(upstream, self.request)
            request_thread.join(timeout=5)
        finally:
            upstream.close()


class _RelayServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True
    block_on_close = True


class HostRelay:
    def __init__(self, bind: tuple[str, int], origin: tuple[str, int]) -> None:
        self.server = _RelayServer(bind, _RelayHandler)
        self.server.origin = origin
        self.address = self.server.server_address
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


NftRunner = Callable[..., subprocess.CompletedProcess[str]]
RelayFactory = Callable[[tuple[str, int], tuple[str, int]], HostRelay]
LockFactory = Callable[[], _ProcessLock]
ReadyProbe = Callable[[str, int], None]


class ProxyNetwork:
    def __init__(
        self,
        runtime: "DockerRuntime",
        proxy_image_id: str,
        authority_root: Path,
        ollama_origin: str,
        *,
        nft_runner: NftRunner = subprocess.run,
        relay_factory: RelayFactory = HostRelay,
        lock_factory: LockFactory = _ProcessLock,
        ready_probe: ReadyProbe | None = None,
        install_signal_handlers: bool = True,
    ) -> None:
        self.runtime = runtime
        self.proxy_image_id = proxy_image_id
        self.authority_root = authority_root.resolve()
        self.ollama_origin = self._origin(ollama_origin)
        self.nft_runner = nft_runner
        self.relay_factory = relay_factory
        self.lock_factory = lock_factory
        self.ready_probe = ready_probe or self._probe_ready
        self.install_signal_handlers = install_signal_handlers
        self._run_id: str | None = None
        self._lock: _ProcessLock | None = None
        self._agent_network: str | None = None
        self._egress_network: str | None = None
        self._nft_table: str | None = None
        self._relay: HostRelay | None = None
        self._container: "ContainerHandle | None" = None
        self._atexit_registered = False
        self._previous_sigterm = None
        self._closed = True

    @staticmethod
    def _origin(value: str) -> tuple[str, int]:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or parsed.port is None
        ):
            raise ValueError("Ollama origin must be an explicit loopback HTTP origin")
        return parsed.hostname, parsed.port

    @staticmethod
    def _token(run_id: str) -> str:
        return hashlib.sha256(run_id.encode("ascii")).hexdigest()[:8]

    def _docker(self, *arguments: str, check: bool = True):
        self.runtime._assert_daemon_identity()
        result = self.runtime._run(
            [DOCKER_BIN, "--host", DOCKER_ENDPOINT, *arguments], check=check
        )
        self.runtime._assert_daemon_identity()
        return result

    @staticmethod
    def _json(result, label: str) -> object:
        try:
            return json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise ProxyStateError(f"Docker returned invalid {label} JSON") from error

    def _owned_network_ids(self) -> tuple[str, ...]:
        labeled = self._docker(
            "network", "ls", "--filter", f"label={LABEL}", "--format", "{{.ID}}"
        )
        namespaced = self._docker(
            "network", "ls", "--format", "{{.ID}} {{.Name}}"
        )
        identifiers = {line for line in labeled.stdout.splitlines() if line}
        for line in namespaced.stdout.splitlines():
            identifier, separator, name = line.partition(" ")
            if separator and name.startswith(TOKEN_PREFIX):
                identifiers.add(identifier)
        return tuple(sorted(identifiers))

    def _proxy_container_ids(self) -> tuple[str, ...]:
        labeled = self._docker(
            "ps", "--all", "--filter", f"label={LABEL}", "--format", "{{.ID}}"
        )
        namespaced = self._docker(
            "ps", "--all", "--format", "{{.ID}} {{.Names}}"
        )
        identifiers = {line for line in labeled.stdout.splitlines() if line}
        for line in namespaced.stdout.splitlines():
            identifier, separator, name = line.partition(" ")
            if separator and name.startswith(PROXY_CONTAINER_PREFIX):
                identifiers.add(identifier)
        return tuple(sorted(identifiers))

    def _inspect_container(self, identifier: str) -> dict[str, object]:
        result = self._docker("inspect", identifier)
        value = self._json(result, "container inspection")
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise ProxyStateError("Docker returned invalid container inspection JSON")
        return value[0]

    def _reconcile_containers(self) -> None:
        from benchmarks.swebench.containers import ContainerHandle

        stale: list[ContainerHandle] = []
        active: list[str] = []
        for identifier in self._proxy_container_ids():
            metadata = self._inspect_container(identifier)
            name_value = metadata.get("Name")
            name = name_value.removeprefix("/") if isinstance(name_value, str) else ""
            labels = self._mapping(self._mapping(metadata.get("Config")).get("Labels"))
            run_id = labels.get(LABEL)
            if not name.startswith(PROXY_CONTAINER_PREFIX):
                continue
            if (
                not isinstance(run_id, str)
                or len(run_id) > 128
                or SAFE_RUN_ID.fullmatch(run_id) is None
            ):
                raise ProxyStateError("foreign proxy container name collision exists")
            container_id = metadata.get("Id")
            if not isinstance(container_id, str) or not container_id:
                raise ProxyStateError("foreign proxy container has invalid identity")
            state = self._mapping(metadata.get("State"))
            status = state.get("Status")
            if state.get("Running") is True or status not in {"created", "exited", "dead"}:
                active.append(name)
            else:
                stale.append(ContainerHandle(name, container_id, run_id))
        if active:
            raise ProxyStateError("active gate-owned proxy container state exists")
        for handle in stale:
            self.runtime.force_remove(handle)

    def _inspect_network(self, identifier: str, *, absent_ok: bool = False) -> dict[str, object] | None:
        result = self._docker("network", "inspect", identifier, check=not absent_ok)
        if result.returncode != 0:
            stderr = result.stderr.lower()
            if absent_ok and (
                "no such network" in stderr
                or f"network {identifier.lower()} not found" in stderr
            ):
                return None
            raise ProxyStateError("could not prove Docker network state")
        value = self._json(result, "network inspection")
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise ProxyStateError("Docker returned invalid network inspection JSON")
        return value[0]

    @staticmethod
    def _mapping(value: object) -> dict[str, object]:
        return value if isinstance(value, dict) else {}

    def _owned_network(self, metadata: dict[str, object]) -> tuple[str, str]:
        name = metadata.get("Name")
        labels = self._mapping(metadata.get("Labels"))
        run_id = labels.get(LABEL)
        if (
            not isinstance(name, str)
            or not name.startswith(TOKEN_PREFIX)
            or not isinstance(run_id, str)
            or not run_id
        ):
            raise ProxyStateError("foreign Docker network state uses a gate name")
        if metadata.get("Driver") != "bridge":
            raise ProxyStateError("foreign Docker network state has an unexpected driver")
        return name, run_id

    def _remove_network(self, name: str, run_id: str) -> None:
        metadata = self._inspect_network(name, absent_ok=True)
        if metadata is None:
            return
        actual_name, actual_run = self._owned_network(metadata)
        if (actual_name, actual_run) != (name, run_id):
            raise ProxyStateError("foreign Docker network ownership changed")
        if self._mapping(metadata.get("Containers")):
            raise ProxyStateError("refusing to remove active gate-owned Docker network")
        self._docker("network", "rm", name)
        if self._inspect_network(name, absent_ok=True) is not None:
            raise ProxyStateError("could not prove Docker network removal")

    def _nft(self, arguments: Sequence[str], *, input: str | None = None, check: bool = True):
        return self.nft_runner(
            [NFT_BIN, *arguments],
            input=input,
            capture_output=True,
            text=True,
            check=check,
            timeout=10,
            env=FIXED_ENV,
        )

    def _nft_tables(self) -> tuple[str, ...]:
        result = self._nft(("-j", "list", "tables"))
        try:
            value = json.loads(result.stdout)
            entries = value["nftables"]
        except (TypeError, KeyError, json.JSONDecodeError) as error:
            raise ProxyStateError("nftables returned invalid table inventory") from error
        names = []
        for entry in entries:
            table = entry.get("table") if isinstance(entry, dict) else None
            if isinstance(table, dict) and table.get("family") == "inet":
                name = table.get("name")
                if isinstance(name, str) and name.startswith("alloy_swe_"):
                    names.append(name)
        return tuple(names)

    def _nft_owner(self, name: str) -> str:
        result = self._nft(("-j", "list", "table", "inet", name))
        try:
            entries = json.loads(result.stdout)["nftables"]
        except (TypeError, KeyError, json.JSONDecodeError) as error:
            raise ProxyStateError("nftables returned invalid gate table state") from error
        for entry in entries:
            table = entry.get("table") if isinstance(entry, dict) else None
            if isinstance(table, dict) and table.get("name") == name:
                comment = table.get("comment")
                prefix = f"{LABEL}="
                if isinstance(comment, str) and comment.startswith(prefix):
                    return comment.removeprefix(prefix)
        raise ProxyStateError("foreign nftables state uses a gate table name")

    def _delete_firewall(self, name: str, run_id: str) -> None:
        if name not in self._nft_tables():
            return
        if self._nft_owner(name) != run_id:
            raise ProxyStateError("foreign nftables ownership changed")
        self._nft(("delete", "table", "inet", name))
        if name in self._nft_tables():
            raise ProxyStateError("could not prove nftables table removal")

    def _reconcile(self) -> None:
        self._reconcile_containers()
        active_runs: set[str] = set()
        stale: list[tuple[str, str]] = []
        for identifier in self._owned_network_ids():
            metadata = self._inspect_network(identifier)
            assert metadata is not None
            name, run_id = self._owned_network(metadata)
            if self._mapping(metadata.get("Containers")):
                active_runs.add(run_id)
            else:
                stale.append((name, run_id))
        if active_runs:
            raise ProxyStateError("active gate-owned Docker network state exists")
        for name, run_id in stale:
            self._remove_network(name, run_id)
        for name in self._nft_tables():
            owner = self._nft_owner(name)
            if owner in active_runs:
                raise ProxyStateError("active gate-owned nftables state exists")
            self._delete_firewall(name, owner)

    def _create_network(self, name: str, run_id: str, bridge: str, *, internal: bool) -> dict[str, object]:
        existing = self._inspect_network(name, absent_ok=True)
        if existing is not None:
            raise ProxyStateError("foreign Docker network occupies the requested gate name")
        arguments = [
            "network", "create", "--driver", "bridge", "--label", f"{LABEL}={run_id}",
            "--opt", f"com.docker.network.bridge.name={bridge}",
        ]
        if internal:
            arguments.append("--internal")
        arguments.append(name)
        self._docker(*arguments)
        metadata = self._inspect_network(name)
        assert metadata is not None
        actual_name, actual_run = self._owned_network(metadata)
        options = self._mapping(metadata.get("Options"))
        if (
            (actual_name, actual_run) != (name, run_id)
            or metadata.get("Internal") is not internal
            or metadata.get("EnableIPv6") is not False
            or options.get("com.docker.network.bridge.name") != bridge
            or self._mapping(metadata.get("Containers"))
        ):
            raise ProxyStateError("created Docker network failed strict inspection")
        return metadata

    @staticmethod
    def _addresses(metadata: dict[str, object]) -> tuple[str, str]:
        ipam = ProxyNetwork._mapping(metadata.get("IPAM"))
        configs = ipam.get("Config")
        if not isinstance(configs, list) or len(configs) != 1 or not isinstance(configs[0], dict):
            raise ProxyStateError("Docker network must have one IPv4 subnet")
        gateway = configs[0].get("Gateway")
        subnet = configs[0].get("Subnet")
        try:
            network = ipaddress.ip_network(str(subnet), strict=True)
            gateway_ip = ipaddress.ip_address(str(gateway))
        except ValueError as error:
            raise ProxyStateError("Docker network has invalid IPAM state") from error
        if network.version != 4 or gateway_ip not in network:
            raise ProxyStateError("Docker network must have one IPv4 gateway")
        proxy_ip = network.network_address + 2
        if proxy_ip not in network or proxy_ip == gateway_ip:
            raise ProxyStateError("Docker network is too small for a fixed proxy address")
        return str(gateway_ip), str(proxy_ip)

    @staticmethod
    def _ruleset(
        table: str,
        run_id: str,
        bridge: str,
        proxy_ip: str,
        relay_ip: str,
        relay_port: int,
    ) -> str:
        return f"""table inet {table} {{
 comment \"{LABEL}={run_id}\"
 chain input {{
  type filter hook input priority -1; policy accept;
  iifname \"{bridge}\" ip saddr {proxy_ip} ip daddr {relay_ip} tcp dport {relay_port} accept
  iifname \"{bridge}\" ip saddr 0.0.0.0/0 drop
  iifname \"{bridge}\" ip6 saddr ::/0 drop
 }}
 chain forward {{
  type filter hook forward priority -1; policy accept;
  iifname \"{bridge}\" ip saddr 0.0.0.0/0 drop
  iifname \"{bridge}\" ip6 saddr ::/0 drop
 }}
}}
"""

    def _apply_firewall(self, table: str, ruleset: str) -> None:
        self._nft(("-f", "-"), input=ruleset)
        if self._nft_owner(table) != self._run_id:
            raise ProxyStateError("could not prove nftables ownership after transaction")

    def _start_proxy(
        self,
        run_id: str,
        token: str,
        agent_ip: str,
        relay_ip: str,
        relay_port: int,
    ) -> tuple["ContainerHandle", object]:
        from benchmarks.swebench.containers import ContainerSpec, MountSpec

        proxy_path = self.authority_root / "benchmarks/swebench/proxy.py"
        server_path = self.authority_root / "benchmarks/swebench/proxy_server.py"
        spec = ContainerSpec(
            name=f"alloy-proxy-{token}",
            run_id=run_id,
            image=self.runtime.profile.proxy_image,
            image_id=self.proxy_image_id,
            command=(
                "python3", "/gate/proxy_server.py",
                "--listen", f"0.0.0.0:{PROXY_PORT}",
                "--origin", f"http://{relay_ip}:{relay_port}",
                "--expected-host", f"{agent_ip}:{PROXY_PORT}",
                "--model", self.runtime.profile.ollama_model,
            ),
            mounts=(
                MountSpec(proxy_path, "/gate/proxy.py", True, "bind"),
                MountSpec(server_path, "/gate/proxy_server.py", True, "bind"),
            ),
            dns_servers=("192.0.2.1",),
        )
        return self.runtime.create(spec), spec

    def _connect_proxy(
        self,
        handle: "ContainerHandle",
        agent_network: str,
        agent_ip: str,
        egress_network: str,
        egress_ip: str,
    ) -> None:
        self._docker("network", "disconnect", "none", handle.container_id)
        self._docker("network", "connect", "--ip", egress_ip, egress_network, handle.container_id)
        self._docker("network", "connect", "--ip", agent_ip, agent_network, handle.container_id)

    def _stop_proxy(self, handle: "ContainerHandle") -> None:
        self._docker(
            "exec", handle.container_id, "python3", "-c",
            "import os, signal; os.kill(1, signal.SIGTERM)",
            check=False,
        )
        if self.runtime.wait(handle, timeout=10) not in {0, 143}:
            raise ProxyStateError("proxy container did not terminate cleanly")
        self.runtime.force_remove(handle)

    def _arm_cleanup(self) -> None:
        if not self._atexit_registered:
            atexit.register(self._atexit_close)
            self._atexit_registered = True
        if self.install_signal_handlers and threading.current_thread() is threading.main_thread():
            self._previous_sigterm = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGTERM, self._sigterm)

    @staticmethod
    def _probe_ready(host: str, port: int) -> None:
        deadline = time.monotonic() + 10
        last_error: BaseException | None = None
        request = (
            f"GET /api/tags HTTP/1.1\r\nHost: {host}:{port}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((host, port), timeout=1) as connection:
                    connection.sendall(request)
                    response = connection.recv(4096)
                if b" 200 " in response:
                    return
                status = response.partition(b"\r\n")[0][:80].decode("ascii", "replace")
                last_error = ProxyStateError(
                    f"proxy readiness returned a non-success response: {status}"
                )
            except OSError as error:
                last_error = error
            time.sleep(0.05)
        raise ProxyStateError("proxy did not become ready before exposure") from last_error

    def _atexit_close(self) -> None:
        try:
            self.close()
        except BaseException:
            pass

    def _sigterm(self, _signum, _frame) -> None:
        self.close()
        raise SystemExit(128 + signal.SIGTERM)

    def start(self, run_id: str) -> ProxyEndpoint:
        if self._run_id is not None or not self._closed:
            raise ProxyStateError("proxy network is already started")
        if len(run_id) > 128 or SAFE_RUN_ID.fullmatch(run_id) is None:
            raise ValueError("run ID must be safe for Docker resources")
        self._closed = False
        self._run_id = run_id
        token = self._token(run_id)
        agent_network = f"{TOKEN_PREFIX}agent-{token}"
        egress_network = f"{TOKEN_PREFIX}egress-{token}"
        nft_table = f"alloy_swe_{token}"
        try:
            self._lock = self.lock_factory()
            self._arm_cleanup()
            self._reconcile()
            self._agent_network = agent_network
            agent = self._create_network(
                agent_network, run_id, f"asa{token}", internal=True
            )
            _agent_gateway, agent_ip = self._addresses(agent)
            self._egress_network = egress_network
            egress = self._create_network(
                egress_network, run_id, f"ase{token}", internal=False
            )
            relay_ip, egress_ip = self._addresses(egress)
            self._relay = self.relay_factory((relay_ip, 0), self.ollama_origin)
            relay_port = int(self._relay.address[1])
            ruleset = self._ruleset(
                nft_table, run_id, f"ase{token}", egress_ip, relay_ip, relay_port
            )
            self._nft_table = nft_table
            self._apply_firewall(nft_table, ruleset)
            self._container, proxy_spec = self._start_proxy(
                run_id, token, agent_ip, relay_ip, relay_port
            )
            self._connect_proxy(
                self._container,
                agent_network,
                agent_ip,
                egress_network,
                egress_ip,
            )
            self.ready_probe(agent_ip, PROXY_PORT)
            inspection = self.runtime.inspect_security(
                self._container,
                proxy_spec,
                expected_networks=(agent_network, egress_network),
            )
            return ProxyEndpoint(
                f"http://{agent_ip}:{PROXY_PORT}",
                agent_ip,
                PROXY_PORT,
                agent_network,
                self._container,
                inspection,
            )
        except BaseException as original_error:
            try:
                self.close()
            except BaseException as cleanup_error:
                raise ProxyCleanupError(
                    (cleanup_error,), original_error=original_error
                ) from original_error
            raise

    @contextlib.contextmanager
    def running(self, run_id: str):
        endpoint = self.start(run_id)
        try:
            yield endpoint
        except BaseException as original_error:
            try:
                self.close()
            except BaseException as cleanup_error:
                raise ProxyCleanupError(
                    (cleanup_error,), original_error=original_error
                ) from original_error
            raise
        else:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        errors: list[BaseException] = []
        if self._container is not None:
            try:
                self._stop_proxy(self._container)
            except BaseException as error:
                errors.append(error)
            else:
                self._container = None
        if self._nft_table is not None and self._run_id is not None:
            try:
                self._delete_firewall(self._nft_table, self._run_id)
            except BaseException as error:
                errors.append(error)
            else:
                self._nft_table = None
        if self._relay is not None:
            try:
                self._relay.close()
            except BaseException as error:
                errors.append(error)
            else:
                self._relay = None
        for name in (self._egress_network, self._agent_network):
            if name is not None and self._run_id is not None:
                try:
                    self._remove_network(name, self._run_id)
                except BaseException as error:
                    errors.append(error)
                else:
                    if name == self._egress_network:
                        self._egress_network = None
                    if name == self._agent_network:
                        self._agent_network = None
        if self._lock is not None and not errors:
            try:
                self._lock.close()
            except BaseException as error:
                errors.append(error)
            else:
                self._lock = None
        if errors:
            raise ProxyCleanupError(errors)
        if self._previous_sigterm is not None:
            signal.signal(signal.SIGTERM, self._previous_sigterm)
            self._previous_sigterm = None
        self._run_id = None
        self._closed = True
