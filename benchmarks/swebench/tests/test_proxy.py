import http.client
import json
import os
import signal
import socket
import subprocess
import threading
import time
import unittest
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from benchmarks.swebench.containers import ContainerHandle, ContainerSpec, DockerRuntime
from benchmarks.swebench.profile import load_profile
from benchmarks.swebench.proxy import (
    HEADER_LIMIT,
    BODY_LIMIT,
    ProxyCleanupError,
    ProxyNetwork,
    ProxyPolicy,
    ProxyStateError,
)
from benchmarks.swebench.proxy_server import create_server


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"


class ProxyPolicyTests(unittest.TestCase):
    def setUp(self):
        profile = load_profile(PROFILE_PATH, REPO_ROOT)
        self.policy = ProxyPolicy(
            profile.proxy.allowed_routes,
            profile.ollama_model,
            "172.30.0.2:8080",
        )

    def validate(self, method, target, body=b"", headers=None):
        values = {"Host": "172.30.0.2:8080", **(headers or {})}
        if method == "POST" and "Content-Length" not in values:
            values["Content-Length"] = str(len(body))
            values["Content-Type"] = "application/json"
        return self.policy.validate(method, target, values, body)

    def test_accepts_only_reviewed_routes_and_pinned_models(self):
        tags = self.validate("GET", "/api/tags")
        self.validate("GET", "/api/tags", headers={"Connection": "close"})
        show = self.validate(
            "POST", "/api/show", json.dumps({"name": "qwen3.8-alloy:latest"}).encode()
        )
        chat = self.validate(
            "POST",
            "/v1/chat/completions",
            json.dumps({"model": "qwen3.8-alloy:latest", "messages": []}).encode(),
        )

        self.assertEqual((tags.method, tags.target), ("GET", "/api/tags"))
        self.assertEqual(show.json_body["name"], "qwen3.8-alloy:latest")
        self.assertEqual(chat.json_body["model"], "qwen3.8-alloy:latest")
        for method, target in (
            ("CONNECT", "example.com:443"),
            ("GET", "http://127.0.0.1:11434/api/tags"),
            ("GET", "//127.0.0.1/api/tags"),
            ("GET", "/api/tags?x=1"),
            ("GET", "/api/tags/"),
            ("POST", "/api/generate"),
        ):
            with self.subTest(method=method, target=target), self.assertRaises(ValueError):
                self.validate(method, target)

    def test_rejects_alternate_host_smuggling_and_oversized_input(self):
        body = b'1'
        cases = (
            ({"Host": "127.0.0.1:11434"}, body),
            ({"Transfer-Encoding": "chunked", "Content-Length": "1"}, body),
            ({"Content-Length": "1, 1"}, body),
            ({"Content-Length": "+1"}, body),
            ({"Content-Length": "2"}, body),
            ({"Connection": "keep-alive"}, body),
            ({"Expect": "100-continue"}, body),
            ({"X-Large": "x" * HEADER_LIMIT}, body),
            ({"Content-Length": str(BODY_LIMIT + 1)}, b"x" * (BODY_LIMIT + 1)),
        )
        for headers, value in cases:
            with self.subTest(headers=list(headers)), self.assertRaises(ValueError):
                self.validate("POST", "/api/show", value, headers)

    def test_rejects_malformed_duplicate_or_unpinned_json(self):
        bodies = (
            b"not-json",
            b"[]",
            b'{"name":"qwen3.8-alloy:latest","name":"other"}',
            b'{"name":"other"}',
            b'{"model":"qwen3.8-alloy:latest"}',
            b'{"name":"qwen3.8-alloy:latest","model":"qwen3.8-alloy:latest"}',
        )
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.validate("POST", "/api/show", body)
        for body in (
            b'{"model":"other","messages":[]}',
            b'{"messages":[]}',
            b'{"model":"qwen3.8-alloy:latest","model":"other"}',
            b'{"model":"qwen3.8-alloy:latest","temperature":NaN}',
        ):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.validate("POST", "/v1/chat/completions", body)


class UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        mode = getattr(self.server, "mode", "normal")
        if mode == "delayed":
            time.sleep(self.server.delay)
        if mode == "oversized-headers":
            self.send_response(200)
            self.send_header("X-Large", "x" * self.server.large_header_bytes)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if mode in {"partial", "slow-partial"}:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "8")
            self.end_headers()
            self.wfile.write(b"part")
            self.wfile.flush()
            if mode == "slow-partial":
                time.sleep(self.server.delay)
            self.close_connection = True
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/api/tags")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        payload = getattr(self.server, "payload", json.dumps({"models": []}).encode())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            pass

    def do_POST(self):
        length = int(self.headers["Content-Length"])
        payload = self.rfile.read(length)
        self.server.observed = (self.path, self.headers, payload)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Upstream", "kept")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


class ProxyServerTests(unittest.TestCase):
    def setUp(self):
        profile = load_profile(PROFILE_PATH, REPO_ROOT)
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        self.policy = ProxyPolicy(
            profile.proxy.allowed_routes,
            profile.ollama_model,
            "127.0.0.1",
        )
        origin = f"http://127.0.0.1:{self.upstream.server_port}"
        self.proxy = create_server(("127.0.0.1", 0), self.policy, origin)
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()

    def tearDown(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.proxy_thread.join(timeout=2)
        self.upstream_thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=2)
        connection.request(method, path, body=body, headers={"Host": "127.0.0.1", **(headers or {})})
        response = connection.getresponse()
        payload = response.read()
        result = response.status, dict(response.getheaders()), payload
        connection.close()
        return result

    def replace_proxy(self, **limits):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.proxy_thread.join(timeout=2)
        origin = f"http://127.0.0.1:{self.upstream.server_port}"
        self.proxy = create_server(("127.0.0.1", 0), self.policy, origin, **limits)
        self.proxy_thread = threading.Thread(target=self.proxy.serve_forever, daemon=True)
        self.proxy_thread.start()

    def test_forwards_only_to_fixed_origin_with_request_id_and_stripped_hop_headers(self):
        body = json.dumps({"name": "qwen3.8-alloy:latest"}).encode()
        status, headers, payload = self.request(
            "POST", "/api/show", body, {"Content-Type": "application/json"}
        )

        self.assertEqual((status, payload), (200, body))
        path, upstream_headers, observed = self.upstream.observed
        self.assertEqual((path, observed), ("/api/show", body))
        self.assertEqual(upstream_headers["Host"], f"127.0.0.1:{self.upstream.server_port}")
        self.assertRegex(upstream_headers["X-Request-ID"], r"^[0-9a-f]{32}$")
        self.assertEqual(headers["X-Request-ID"], upstream_headers["X-Request-ID"])
        self.assertEqual(headers["Connection"], "close")

    def test_rejects_duplicate_content_length_and_never_follows_redirects(self):
        raw = (
            b"POST /api/show HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}"
        )
        with socket.create_connection(("127.0.0.1", self.proxy.server_port), timeout=2) as client:
            client.sendall(raw)
            response = client.recv(4096)
        self.assertIn(b" 400 ", response)

        with mock.patch.object(self.policy, "validate", side_effect=None):
            pass
        opener = self.proxy.opener
        with self.assertRaises(urllib.error.HTTPError) as raised:
            opener.open(f"http://127.0.0.1:{self.upstream.server_port}/redirect", timeout=1)
        raised.exception.close()

    def test_bounds_upstream_bytes_headers_and_deadline(self):
        self.upstream.payload = b"x" * 32
        self.replace_proxy(response_limit=8)
        status, _, payload = self.request("GET", "/api/tags")
        self.assertEqual(status, 200)
        self.assertLessEqual(len(payload), 8)

        self.upstream.mode = "oversized-headers"
        self.upstream.large_header_bytes = 1024
        self.replace_proxy(response_header_limit=512)
        status, _, payload = self.request("GET", "/api/tags")
        self.assertEqual(status, 502)
        self.assertIn(b"upstream request failed", payload)

        self.upstream.mode = "delayed"
        self.upstream.delay = 0.2
        self.replace_proxy(response_timeout=0.05)
        status, _, payload = self.request("GET", "/api/tags")
        self.assertEqual(status, 502)
        self.assertIn(b"upstream request failed", payload)

    def test_partial_and_slow_streams_are_bounded_and_servers_cleanup(self):
        self.upstream.mode = "partial"
        status, _, payload = self.request("GET", "/api/tags")
        self.assertEqual((status, payload), (200, b"part"))

        self.upstream.mode = "slow-partial"
        self.upstream.delay = 0.2
        self.replace_proxy(response_timeout=0.05)
        status, _, payload = self.request("GET", "/api/tags")
        self.assertEqual(status, 200)
        self.assertLessEqual(len(payload), len(b"part"))

        self.proxy.shutdown()
        self.proxy.server_close()
        self.proxy_thread.join(timeout=2)
        self.assertFalse(self.proxy_thread.is_alive())


class FakeRuntime:
    def __init__(self):
        self.calls = []
        self.profile = load_profile(PROFILE_PATH, REPO_ROOT)
        self.handle = ContainerHandle("alloy-proxy-run-123", "proxy-id", "run-123")
        self.networks = set()
        self.containers = {}

    def _assert_daemon_identity(self, handle=None):
        self.calls.append(("identity", handle))

    def _run(self, arguments, *, check=True, timeout=None):
        self.calls.append(("docker", tuple(arguments), check))
        action = arguments[3:]
        if action[:2] == ["ps", "--all"]:
            if f"label=alloy.swebench.gate" in action:
                identifiers = [
                    identifier
                    for identifier, metadata in self.containers.items()
                    if "alloy.swebench.gate" in metadata.get("Config", {}).get("Labels", {})
                ]
                return subprocess.CompletedProcess(
                    arguments, 0, stdout="\n".join(identifiers), stderr=""
                )
            lines = [
                f"{identifier} {metadata['Name'].removeprefix('/')}"
                for identifier, metadata in self.containers.items()
            ]
            return subprocess.CompletedProcess(arguments, 0, stdout="\n".join(lines), stderr="")
        if action[:1] == ["inspect"]:
            identifier = action[1]
            metadata = self.containers.get(identifier)
            if metadata is None:
                return subprocess.CompletedProcess(
                    arguments, 1, stdout="", stderr=f"Error: No such container: {identifier}\n"
                )
            return subprocess.CompletedProcess(
                arguments, 0, stdout=json.dumps([metadata]), stderr=""
            )
        if action[:2] == ["network", "ls"]:
            return subprocess.CompletedProcess(arguments, 0, stdout="", stderr="")
        if action[:2] == ["network", "inspect"]:
            name = action[2]
            if name not in self.networks:
                return subprocess.CompletedProcess(
                    arguments, 1, stdout="[]\n",
                    stderr=f"Error response from daemon: network {name} not found\n",
                )
            if name.endswith("agent-272812a7"):
                internal, gateway, subnet = True, "172.28.0.1", "172.28.0.0/16"
            else:
                internal, gateway, subnet = False, "172.29.0.1", "172.29.0.0/16"
            value = [{
                "Name": name,
                "Driver": "bridge",
                "Internal": internal,
                "EnableIPv6": False,
                "Options": {
                    "com.docker.network.bridge.name": (
                        "asa272812a7" if internal else "ase272812a7"
                    )
                },
                "Labels": {"alloy.swebench.gate": "run-123"},
                "Containers": {},
                "IPAM": {"Config": [{"Gateway": gateway, "Subnet": subnet}]},
            }]
            return subprocess.CompletedProcess(arguments, 0, stdout=json.dumps(value), stderr="")
        if action[:2] == ["network", "create"]:
            self.networks.add(action[-1])
        if action[:2] == ["network", "rm"]:
            self.networks.discard(action[-1])
        return subprocess.CompletedProcess(arguments, 0, stdout="", stderr="")

    def create(self, spec):
        self.calls.append(("create", spec))
        self.containers[self.handle.container_id] = {
            "Id": self.handle.container_id,
            "Name": "/" + self.handle.name,
            "Config": {"Labels": {"alloy.swebench.gate": self.handle.run_id}},
            "State": {"Running": True, "Status": "running"},
        }
        return self.handle

    def inspect_security(self, handle, spec, *, expected_networks=()):
        self.calls.append(("inspect-security", handle, spec, expected_networks))
        return {
            "container_id": handle.container_id,
            "daemon_identity": {"daemon_id": "daemon-id"},
            "inspection": {"NetworkSettings": {"Networks": list(expected_networks)}},
        }

    def force_remove(self, handle):
        self.calls.append(("remove", handle))
        self.containers.pop(handle.container_id, None)

    def wait(self, handle, *, timeout=None):
        self.calls.append(("wait", handle, timeout))
        return 0


class FakeRelay:
    def __init__(self, address):
        self.address = address
        self.closed = False

    def close(self):
        self.closed = True


class FakeLock:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class ProxyNetworkTests(unittest.TestCase):
    def test_cleanup_error_has_no_invented_primary_and_keeps_every_failure(self):
        first = RuntimeError("container removal failed")
        second = RuntimeError("network removal failed")

        error = ProxyCleanupError((first, second))

        self.assertIsNone(error.original_error)
        self.assertEqual(error.cleanup_errors, (first, second))

    def setUp(self):
        self.runtime = FakeRuntime()
        self.nft_calls = []
        self.relays = []
        self.nft_tables = {}
        self.locks = []

        def nft_runner(arguments, **kwargs):
            self.nft_calls.append((tuple(arguments), kwargs))
            if arguments[1:4] == ["-j", "list", "tables"]:
                tables = [
                    {"table": {"family": "inet", "name": name}}
                    for name in self.nft_tables
                ]
                return subprocess.CompletedProcess(
                    arguments, 0, stdout=json.dumps({"nftables": tables}), stderr=""
                )
            if arguments[1:5] == ["-j", "list", "table", "inet"]:
                name = arguments[5]
                owner = self.nft_tables[name]
                value = {"nftables": [{"table": {
                    "family": "inet", "name": name,
                    "comment": f"alloy.swebench.gate={owner}",
                }}]}
                return subprocess.CompletedProcess(arguments, 0, stdout=json.dumps(value), stderr="")
            if arguments[1:3] == ["-f", "-"]:
                match = __import__("re").search(
                    r"table inet (\w+).*alloy\.swebench\.gate=([^\"]+)",
                    kwargs["input"], __import__("re").S,
                )
                self.nft_tables[match.group(1)] = match.group(2)
            if arguments[1:5] == ["delete", "table", "inet", arguments[-1]]:
                self.nft_tables.pop(arguments[-1], None)
            return subprocess.CompletedProcess(arguments, 0, stdout="", stderr="")

        def relay_factory(bind, origin):
            self.assertEqual(bind[0], "172.29.0.1")
            self.assertEqual(origin, ("127.0.0.1", 11434))
            relay = FakeRelay((bind[0], 43123))
            self.relays.append(relay)
            return relay

        self.network = ProxyNetwork(
            self.runtime,
            "sha256:" + "a" * 64,
            REPO_ROOT,
            "http://127.0.0.1:11434",
            nft_runner=nft_runner,
            relay_factory=relay_factory,
            lock_factory=self.lock_factory,
            ready_probe=lambda _host, _port: None,
            install_signal_handlers=False,
        )

    def lock_factory(self):
        lock = FakeLock()
        self.locks.append(lock)
        return lock

    def test_start_builds_internal_bridge_atomic_default_deny_and_exact_allowance(self):
        endpoint = self.network.start("run-123")

        self.assertEqual(endpoint.url, "http://172.28.0.2:8080")
        docker_commands = [call[1] for call in self.runtime.calls if call[0] == "docker"]
        creates = [command for command in docker_commands if command[3:5] == ("network", "create")]
        self.assertEqual(len(creates), 2)
        self.assertIn("--internal", creates[0])
        self.assertNotIn("--internal", creates[1])
        transaction = [kwargs["input"] for args, kwargs in self.nft_calls if args[-2:] == ("-f", "-")][0]
        self.assertIn("table inet alloy_swe_272812a7", transaction)
        self.assertIn("ip saddr 172.29.0.2 ip daddr 172.29.0.1 tcp dport 43123 accept", transaction)
        self.assertIn('iifname "ase272812a7"', transaction)
        self.assertIn("ip6 saddr ::/0 drop", transaction)
        self.assertIn("forward", transaction)
        self.assertIn("drop", transaction)
        proxy_spec = [call[1] for call in self.runtime.calls if call[0] == "create"][0]
        self.assertEqual(proxy_spec.network_mode, "none")
        self.assertEqual(proxy_spec.image, self.runtime.profile.proxy_image)
        self.assertEqual(proxy_spec.dns_servers, ("192.0.2.1",))
        self.assertTrue(
            any(command[3:5] == ("network", "connect") for command in docker_commands)
        )
        disconnect = next(
            index for index, command in enumerate(docker_commands)
            if command[3:6] == ("network", "disconnect", "none")
        )
        connect = next(
            index for index, command in enumerate(docker_commands)
            if command[3:5] == ("network", "connect")
        )
        self.assertLess(disconnect, connect)

        self.network.close()
        self.assertTrue(self.relays[0].closed)
        self.assertTrue(self.locks[0].closed)
        self.assertIn(("remove", self.runtime.handle), self.runtime.calls)
        self.assertTrue(
            any(args[1:4] == ("delete", "table", "inet") for args, _ in self.nft_calls)
        )

    def test_reconciles_only_empty_owned_state_and_refuses_active_or_foreign_state(self):
        stale = {
            "Name": "alloy-swe-stale",
            "Driver": "bridge",
            "Internal": True,
            "Labels": {"alloy.swebench.gate": "old-run"},
            "Containers": {},
            "IPAM": {"Config": [{"Gateway": "172.27.0.1", "Subnet": "172.27.0.0/16"}]},
        }
        active = {**stale, "Containers": {"id": {}}}
        foreign = {**stale, "Labels": {}}
        for metadata, message in ((active, "active"), (foreign, "foreign")):
            network = ProxyNetwork(
                self.runtime,
                "sha256:" + "a" * 64,
                REPO_ROOT,
                "http://127.0.0.1:11434",
                nft_runner=self.network.nft_runner,
                relay_factory=self.network.relay_factory,
                lock_factory=self.lock_factory,
                ready_probe=lambda _host, _port: None,
                install_signal_handlers=False,
            )
            with mock.patch.object(network, "_owned_network_ids", return_value=("stale-id",)), mock.patch.object(
                network, "_inspect_network", return_value=metadata
            ), self.subTest(message=message), self.assertRaisesRegex(ProxyStateError, message):
                network.start("run-123")

        with mock.patch.object(self.network, "_owned_network_ids", return_value=("stale-id",)), mock.patch.object(
            self.network, "_inspect_network", return_value=stale
        ), mock.patch.object(self.network, "_remove_network") as remove:
            self.network._reconcile()
            remove.assert_called_once_with("alloy-swe-stale", "old-run")

    def test_reconciles_proxy_containers_before_network_or_firewall_mutation(self):
        stale = {
            "Id": "stale-id",
            "Name": "/alloy-proxy-stale",
            "Config": {"Labels": {"alloy.swebench.gate": "old-run"}},
            "State": {"Running": False, "Status": "exited"},
        }
        self.runtime.containers["stale-id"] = stale

        self.network.start("run-123")

        removal = self.runtime.calls.index(
            ("remove", ContainerHandle("alloy-proxy-stale", "stale-id", "old-run"))
        )
        first_network_create = next(
            index
            for index, call in enumerate(self.runtime.calls)
            if call[0] == "docker" and call[1][3:5] == ("network", "create")
        )
        self.assertLess(removal, first_network_create)
        self.network.close()

        cases = (
            ({**stale, "State": {"Running": True, "Status": "running"}}, "active"),
            ({**stale, "Config": {"Labels": {}}}, "foreign"),
        )
        for metadata, message in cases:
            runtime = FakeRuntime()
            runtime.containers["collision-id"] = metadata
            network = ProxyNetwork(
                runtime,
                "sha256:" + "a" * 64,
                REPO_ROOT,
                "http://127.0.0.1:11434",
                nft_runner=self.network.nft_runner,
                relay_factory=self.network.relay_factory,
                lock_factory=self.lock_factory,
                ready_probe=lambda _host, _port: None,
                install_signal_handlers=False,
            )
            nft_before = len(self.nft_calls)
            relay_before = len(self.relays)
            with self.subTest(message=message), self.assertRaisesRegex(ProxyStateError, message):
                network.start("run-123")
            self.assertFalse(any(
                call[0] == "docker" and call[1][3:5] == ("network", "create")
                for call in runtime.calls
            ))
            self.assertEqual(len(self.nft_calls), nft_before)
            self.assertEqual(len(self.relays), relay_before)

    def test_reconciles_stale_owned_nft_table_and_refuses_foreign_table(self):
        self.nft_tables["alloy_swe_deadbeef"] = "old-run"
        self.network._reconcile()
        self.assertNotIn("alloy_swe_deadbeef", self.nft_tables)

        self.nft_tables["alloy_swe_foreign"] = "old-run"
        with mock.patch.object(
            self.network, "_nft_owner", side_effect=ProxyStateError("foreign nftables state")
        ), self.assertRaisesRegex(ProxyStateError, "foreign"):
            self.network._reconcile()

    def test_start_failure_and_sigterm_close_every_armed_resource(self):
        with mock.patch.object(self.network, "_connect_proxy", side_effect=TimeoutError("late")):
            with self.assertRaises(TimeoutError):
                self.network.start("run-123")
        self.assertTrue(self.relays[0].closed)
        self.assertIn(("remove", self.runtime.handle), self.runtime.calls)

        replacement = mock.Mock()
        network = ProxyNetwork(
            self.runtime,
            "sha256:" + "a" * 64,
            REPO_ROOT,
            "http://127.0.0.1:11434",
            nft_runner=self.network.nft_runner,
            relay_factory=self.network.relay_factory,
            lock_factory=self.lock_factory,
            ready_probe=lambda _host, _port: None,
            install_signal_handlers=True,
        )
        with mock.patch("benchmarks.swebench.proxy.signal.getsignal", return_value=replacement), mock.patch(
            "benchmarks.swebench.proxy.signal.signal"
        ) as install:
            network.start("run-123")
            handler = install.call_args_list[0].args[1]
            with self.assertRaises(SystemExit) as raised:
                handler(signal.SIGTERM, None)
        self.assertEqual(raised.exception.code, 143)
        self.assertTrue(self.relays[-1].closed)

    def test_running_context_always_cleans_success_timeout_and_exception(self):
        for error in (None, TimeoutError("agent timed out"), RuntimeError("agent failed")):
            runtime = FakeRuntime()
            network = ProxyNetwork(
                runtime,
                "sha256:" + "a" * 64,
                REPO_ROOT,
                "http://127.0.0.1:11434",
                nft_runner=self.network.nft_runner,
                relay_factory=self.network.relay_factory,
                lock_factory=self.lock_factory,
                ready_probe=lambda _host, _port: None,
                install_signal_handlers=False,
            )
            if error is None:
                with network.running("run-123") as endpoint:
                    self.assertEqual(endpoint.port, 8080)
            else:
                with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                    with network.running("run-123"):
                        raise error
            self.assertTrue(network._closed)
            self.assertEqual(runtime.containers, {})
            self.assertEqual(runtime.networks, set())


class RootNetworkIntegrationTests(unittest.TestCase):
    def test_real_proxy_network_denies_every_nonrelay_egress_and_cleans(self):
        if os.environ.get("ALLOY_SWEBENCH_REQUIRE_ROOT_NETWORK") != "1":
            self.skipTest(
                "set ALLOY_SWEBENCH_REQUIRE_ROOT_NETWORK=1 for required root network isolation"
            )
        if os.geteuid() != 0:
            self.fail("ALLOY_SWEBENCH_REQUIRE_ROOT_NETWORK=1 requires root")

        profile = load_profile(PROFILE_PATH, REPO_ROOT)
        runtime = DockerRuntime(profile, REPO_ROOT)
        runtime.preflight()
        proxy_image_id = runtime.pull_and_verify(profile.proxy_image)
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        run_id = "root-network-" + uuid.uuid4().hex
        network = ProxyNetwork(
            runtime,
            proxy_image_id,
            REPO_ROOT,
            f"http://127.0.0.1:{upstream.server_port}",
            install_signal_handlers=False,
        )
        agent = None
        other_listener = None
        table = "alloy_swe_" + network._token(run_id)
        try:
            with network.running(run_id) as endpoint:
                agent = runtime.create(ContainerSpec(
                    name="alloy-network-probe-" + uuid.uuid4().hex,
                    run_id=run_id,
                    image=profile.proxy_image,
                    image_id=proxy_image_id,
                    command=("python3", "-c", "import time; time.sleep(120)"),
                ))
                try:
                    network._docker("network", "disconnect", "none", agent.container_id)
                    network._docker("network", "connect", endpoint.network, agent.container_id)

                    agent_script = (
                        "import urllib.request; "
                        f"r=urllib.request.urlopen('{endpoint.url}/api/tags', timeout=5); "
                        "assert r.status == 200 and b'models' in r.read()"
                    )
                    network._docker("exec", agent.container_id, "python3", "-c", agent_script)

                    relay_host, relay_port = network._relay.address
                    other_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    other_listener.bind((relay_host, 0))
                    other_listener.listen(1)
                    config = {
                        "relay": [relay_host, relay_port],
                        "tcp": {
                            "bridge_other_port": [relay_host, other_listener.getsockname()[1]],
                            "rfc1918": ["10.255.255.1", 80],
                            "metadata": ["169.254.169.254", 80],
                            "public_ipv4": ["1.1.1.1", 80],
                            "public_ipv6": ["2606:4700:4700::1111", 80],
                        },
                    }
                    probe = (Path(__file__).parent / "fixtures/network_probe.py").read_text()
                    result = network._docker(
                        "exec", endpoint.container.container_id,
                        "python3", "-c", probe, json.dumps(config, separators=(",", ":")),
                    )
                    observed = json.loads(result.stdout)
                    self.assertTrue(observed.pop("relay"), observed)
                    self.assertEqual(observed, {name: False for name in observed})
                finally:
                    network._stop_proxy(agent)
                    agent = None
        finally:
            if other_listener is not None:
                other_listener.close()
            if agent is not None:
                network._stop_proxy(agent)
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)
            if not network._closed:
                network.close()

        label = f"alloy.swebench.gate={run_id}"
        containers = runtime._run(runtime._docker_arguments(
            "ps", "--all", "--filter", f"label={label}", "--format", "{{.ID}}"
        ))
        networks = runtime._run(runtime._docker_arguments(
            "network", "ls", "--filter", f"label={label}", "--format", "{{.ID}}"
        ))
        firewall = subprocess.run(
            ["/usr/sbin/nft", "list", "table", "inet", table],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(containers.stdout.strip(), "")
        self.assertEqual(networks.stdout.strip(), "")
        self.assertNotEqual(firewall.returncode, 0)


if __name__ == "__main__":
    unittest.main()
