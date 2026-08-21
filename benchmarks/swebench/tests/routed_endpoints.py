import ipaddress
import json
import os
import signal
import subprocess
import time
import uuid

from benchmarks.swebench.containers import (
    CONTAINER_USER,
    DOCKER_BIN,
    DOCKER_ENDPOINT,
    LABEL,
    ContainerHandle,
    ContainerSpec,
)


TCP_ENDPOINTS = {
    "rfc1918": ["10.77.0.1", 18080],
    "metadata": ["169.254.169.254", 18080],
    "public_ipv4": ["1.1.1.1", 18080],
    "private_ipv6": ["fd00::10", 18080],
    "public_ipv6": ["2606:4700:4700::1111", 18080],
}
DNS_ENDPOINT = ["192.0.2.53", 15353]


PROBE_SCRIPT = r'''
import json, socket, sys
config = json.loads(sys.argv[1]); observed = {}
for name, endpoint in config["tcp"].items():
    family = socket.AF_INET6 if ":" in endpoint[0] else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(1); connection.connect(tuple(endpoint))
        observed[name] = True
    except OSError:
        observed[name] = False
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.settimeout(1)
        connection.sendto(b"\x12\x34\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00", tuple(config["dns"]))
        connection.recvfrom(512)
    observed["dns"] = True
except OSError:
    observed["dns"] = False
print(json.dumps(observed, sort_keys=True))
'''


ENDPOINT_SERVER = r'''
import os, selectors, socket, time
addresses = os.environ["TCP_ADDRESSES"].split(",")
selector = selectors.DefaultSelector()
while True:
    opened = []
    try:
        for address in addresses:
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            listener = socket.socket(family, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET:
                listener.setsockopt(socket.SOL_IP, 15, 1)  # IP_FREEBIND
            else:
                listener.setsockopt(socket.IPPROTO_IPV6, 78, 1)  # IPV6_FREEBIND
            listener.bind((address, int(os.environ["TCP_PORT"])))
            listener.listen(); listener.setblocking(False); opened.append(listener)
        break
    except OSError:
        for item in opened: item.close()
        time.sleep(0.05)
for listener in opened: selector.register(listener, selectors.EVENT_READ)
while True:
    for key, _ in selector.select():
        connection, _ = key.fileobj.accept(); connection.sendall(b"controlled\n"); connection.close()
'''


DNS_SERVER = r'''
import os, socket
server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(("0.0.0.0", int(os.environ["DNS_PORT"])))
while True:
    data, peer = server.recvfrom(4096)
    server.sendto(data, peer)
'''


class RoutedEndpointHarness:
    def __init__(
        self,
        runtime,
        network_owner,
        run_id,
        endpoint_image,
        endpoint_image_id,
        baseline_image,
        baseline_image_id,
    ):
        self.runtime = runtime
        self.network_owner = network_owner
        self.run_id = run_id
        self.endpoint_image = endpoint_image
        self.endpoint_image_id = endpoint_image_id
        self.baseline_image = baseline_image
        self.baseline_image_id = baseline_image_id
        self.endpoint = None
        self.endpoint_processes = []
        self.baseline = None
        self.network = None
        self.endpoint_ipv4 = None
        self.endpoint_ipv6 = f"fd42:{uuid.uuid4().hex[:4]}::2"
        self.gateway_ipv4 = None
        self.gateway_ipv6 = self.endpoint_ipv6.rsplit("::", 1)[0] + "::1"
        self.bridge = None
        self.host_routes = []
        self.host_rules = []
        self.host_addresses = []
        self.host_sysctls = {}
        self.route_table = None
        self._next_ipv6_host = 3
        self.baseline_observed = None
        self.baseline_diagnostics = None

    @staticmethod
    def config():
        return {
            "tcp": {name: list(endpoint) for name, endpoint in TCP_ENDPOINTS.items()},
            "dns": list(DNS_ENDPOINT),
        }

    def _docker(self, *arguments, check=True):
        return self.network_owner._docker(*arguments, check=check)

    def _pid(self, handle):
        result = self._docker("inspect", "--format", "{{.State.Pid}}", handle.container_id)
        pid = int(result.stdout.strip())
        if pid <= 0:
            raise RuntimeError("controlled endpoint container has no network namespace")
        return pid

    @staticmethod
    def _ns(pid, *arguments, check=True):
        return subprocess.run(
            ["/usr/bin/nsenter", "--target", str(pid), "--net", "/usr/sbin/ip", *arguments],
            check=check,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def _enable_ipv6(pid):
        subprocess.run(
            [
                "/usr/bin/nsenter", "--target", str(pid), "--net", "/bin/sh", "-c",
                "printf 0 > /proc/sys/net/ipv6/conf/all/disable_ipv6; "
                "printf 0 > /proc/sys/net/ipv6/conf/eth0/disable_ipv6; "
                "printf 0 > /proc/sys/net/ipv6/conf/all/accept_dad; "
                "printf 0 > /proc/sys/net/ipv6/conf/eth0/accept_dad",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def _network_ipv4(self, handle):
        deadline = time.monotonic() + 5
        networks = None
        while time.monotonic() < deadline:
            inspected = json.loads(self._docker("inspect", handle.container_id).stdout)[0]
            networks = inspected["NetworkSettings"]["Networks"]
            value = (networks.get(self.network) or {}).get("IPAddress")
            if value:
                return value
            time.sleep(0.05)
        logs = self._docker("logs", handle.container_id, check=False)
        raise RuntimeError(
            "controlled endpoint container lacks a bridge address: "
            f"state={inspected.get('State')} networks={networks} "
            f"logs={(logs.stdout + logs.stderr)[-4096:]!r}"
        )

    def _connect(self, handle, *, address=None):
        self._docker("network", "disconnect", "none", handle.container_id)
        arguments = ["network", "connect"]
        if address is not None:
            arguments.extend(("--ip", address))
        self._docker(*arguments, self.network, handle.container_id)

    def _network_topology(self):
        inspected = json.loads(self._docker("network", "inspect", self.network).stdout)[0]
        config = inspected["IPAM"]["Config"][0]
        self.gateway_ipv4 = config["Gateway"]
        self.bridge = inspected["Options"]["com.docker.network.bridge.name"]
        for _attempt in range(20):
            candidate = 10000 + int(uuid.uuid4().hex[:4], 16) % 20000
            routes = []
            for family in ("-4", "-6"):
                result = subprocess.run(
                    ["/usr/sbin/ip", family, "route", "show", "table", str(candidate)],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                routes.append(result.stdout.strip())
            rules = subprocess.run(
                ["/usr/sbin/ip", "rule", "show"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            if not any(routes) and f"lookup {candidate}" not in rules:
                self.route_table = candidate
                break
        if self.route_table is None:
            raise RuntimeError("could not allocate an unused policy-routing table")
        return str(ipaddress.ip_network(config["Subnet"]).network_address + 10)

    def _add_host_route(self, family, destination, gateway):
        command = ["/usr/sbin/ip", family, "route", "add", destination, "via", gateway,
                   "dev", self.bridge, "table", str(self.route_table)]
        subprocess.run(command, check=True, capture_output=True, text=True)
        self.host_routes.append((family, destination))

    def _add_host_rule(self, family):
        subprocess.run(
            [
                "/usr/sbin/ip", family, "rule", "add", "priority", str(self.route_table),
                "iif", self.bridge, "lookup", str(self.route_table),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.host_rules.append(family)

    def _create_endpoint(self):
        spec = ContainerSpec(
            name="alloy-controlled-endpoint-" + uuid.uuid4().hex,
            run_id=self.run_id,
            image=self.endpoint_image,
            image_id=self.endpoint_image_id,
            command=("python3", "-c", "import time; time.sleep(10**9)"),
        )
        self.endpoint = self.runtime.create(spec)
        self._connect(self.endpoint, address=self._network_topology())
        self.endpoint_ipv4 = self._network_ipv4(self.endpoint)
        pid = self._pid(self.endpoint)
        self._enable_ipv6(pid)
        self._ns(pid, "-6", "addr", "add", self.endpoint_ipv6 + "/64", "dev", "eth0")
        for address, _port in TCP_ENDPOINTS.values():
            if ":" not in address:
                self._ns(pid, "-4", "addr", "add", f"{address}/32", "dev", "lo")
        self._ns(pid, "-4", "addr", "add", DNS_ENDPOINT[0] + "/32", "dev", "lo")
        disable_key = f"net.ipv6.conf.{self.bridge}.disable_ipv6"
        self.host_sysctls[disable_key] = subprocess.run(
            ["/usr/sbin/sysctl", "-n", disable_key],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["/usr/sbin/sysctl", "-w", disable_key + "=0"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                "/usr/sbin/ip", "-6", "addr", "add", self.gateway_ipv6 + "/64",
                "dev", self.bridge, "nodad",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.host_addresses.append(self.gateway_ipv6 + "/64")
        self._add_host_rule("-4")
        self._add_host_rule("-6")
        for address, _port in TCP_ENDPOINTS.values():
            family = "-6" if ":" in address else "-4"
            if family == "-6":
                subprocess.run(
                    [
                        "/usr/sbin/ip", "-6", "route", "add", "local", address + "/128",
                        "dev", "lo", "table", str(self.route_table),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.host_routes.append(("-6", address + "/128"))
            else:
                self._add_host_route("-4", address + "/32", self.endpoint_ipv4)
        self._add_host_route("-4", DNS_ENDPOINT[0] + "/32", self.endpoint_ipv4)
        environment = {
            **os.environ,
            "TCP_ADDRESSES": ",".join(
                value[0] for value in TCP_ENDPOINTS.values() if ":" not in value[0]
            ),
            "TCP_PORT": str(next(iter(TCP_ENDPOINTS.values()))[1]),
            "DNS_PORT": str(DNS_ENDPOINT[1]),
        }
        for program in (ENDPOINT_SERVER, DNS_SERVER):
            self.endpoint_processes.append(subprocess.Popen(
                [
                    "/usr/bin/nsenter", "--target", str(pid), "--net",
                    "/usr/bin/python3", "-c", program,
                ],
                env=environment,
                start_new_session=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ))
        host_environment = {
            **environment,
            "TCP_ADDRESSES": ",".join(
                value[0] for value in TCP_ENDPOINTS.values() if ":" in value[0]
            ),
        }
        self.endpoint_processes.append(subprocess.Popen(
            ["/usr/bin/python3", "-c", ENDPOINT_SERVER],
            env=host_environment,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ))

    def _create_unconfined_baseline(self):
        # This test control removes process confinement while retaining the pinned image,
        # user, capabilities, filesystem, and network topology under comparison.
        name = "alloy-network-baseline-" + uuid.uuid4().hex
        result = self._docker(
            "create",
            "--name", name,
            "--label", f"{LABEL}={self.run_id}",
            "--platform", "linux/amd64",
            "--user", CONTAINER_USER,
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--security-opt", "seccomp=unconfined",
            "--security-opt", "apparmor=unconfined",
            "--read-only",
            "--init",
            "--network", "none",
            self.baseline_image.reference,
            "python3", "-c", "import time; time.sleep(10**9)",
        )
        handle = ContainerHandle(name, result.stdout.strip(), self.run_id)
        try:
            inspected = json.loads(self._docker("inspect", handle.container_id).stdout)[0]
            if inspected["Image"] != self.baseline_image_id:
                raise RuntimeError("unconfined baseline image digest does not match pinned image")
            self._docker("start", handle.container_id)
        except BaseException:
            self.runtime.force_remove(handle)
            raise
        return handle

    def probe_network_namespace(self, target, script, config):
        # Joining the production namespace isolates nft/topology from AppArmor's socket rules.
        name = "alloy-network-probe-" + uuid.uuid4().hex
        result = self._docker(
            "create",
            "--name", name,
            "--label", f"{LABEL}={self.run_id}",
            "--platform", "linux/amd64",
            "--user", CONTAINER_USER,
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--security-opt", "seccomp=unconfined",
            "--security-opt", "apparmor=unconfined",
            "--read-only",
            "--init",
            "--network", "container:" + target.container_id,
            self.baseline_image.reference,
            "python3", "-c", script, json.dumps(config, separators=(",", ":")),
        )
        handle = ContainerHandle(name, result.stdout.strip(), self.run_id)
        try:
            inspected = json.loads(self._docker("inspect", handle.container_id).stdout)[0]
            if inspected["Image"] != self.baseline_image_id:
                raise RuntimeError("unconfined namespace probe image digest does not match pinned image")
            return self.runtime._run(
                [DOCKER_BIN, "--host", DOCKER_ENDPOINT, "start", "--attach", handle.container_id],
                check=False,
                timeout=30,
            )
        finally:
            self.runtime.force_remove(handle)

    def assert_endpoint_live(self):
        if self.endpoint is None:
            raise AssertionError("controlled endpoint was not created")
        inspected = json.loads(self._docker("inspect", self.endpoint.container_id).stdout)[0]
        process_states = [process.poll() for process in self.endpoint_processes]
        if not inspected["State"]["Running"] or any(state is not None for state in process_states):
            raise AssertionError(
                "controlled endpoint died before denial probe: "
                f"container={inspected['State']} listeners={process_states}"
            )

    def configure_routes(self, handle):
        if self.endpoint_ipv4 is None:
            raise RuntimeError("controlled endpoint bridge is not initialized")
        pid = self._pid(handle)
        self._enable_ipv6(pid)
        local_ipv6 = f"fd42:{self.endpoint_ipv6.split(':')[1]}::{self._next_ipv6_host}"
        self._next_ipv6_host += 1
        self._ns(pid, "-6", "addr", "add", local_ipv6 + "/64", "dev", "eth0")
        for address, _port in TCP_ENDPOINTS.values():
            if ":" in address:
                self._ns(
                    pid, "-6", "route", "add", address + "/128",
                    "via", self.gateway_ipv6, "dev", "eth0",
                )
            else:
                self._ns(
                    pid, "-4", "route", "add", address + "/32",
                    "via", self.gateway_ipv4, "dev", "eth0",
                )
        self._ns(
            pid, "-4", "route", "add", DNS_ENDPOINT[0] + "/32",
            "via", self.gateway_ipv4, "dev", "eth0",
        )
        return self.diagnostics(handle)

    def diagnostics(self, handle):
        pid = self._pid(handle)
        return {
            "addresses": self._ns(pid, "-j", "address", "show").stdout.strip(),
            "ipv4_routes": self._ns(pid, "-j", "-4", "route", "show").stdout.strip(),
            "ipv6_routes": self._ns(pid, "-j", "-6", "route", "show").stdout.strip(),
            "udp_sockets": subprocess.run(
                [
                    "/usr/bin/nsenter", "--target", str(pid), "--net",
                    "/usr/bin/ss", "-lunp",
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip(),
        }

    def probe(self, handle):
        result = self._docker(
            "exec", handle.container_id, "python3", "-c", PROBE_SCRIPT,
            json.dumps(self.config(), separators=(",", ":")),
        )
        return json.loads(result.stdout)

    def establish_baseline(self, network):
        if self.run_id == "pending-run-id":
            raise AssertionError("controlled endpoint run ID was not bound to the trusted run")
        self.network = network
        self._create_endpoint()
        self.baseline = self._create_unconfined_baseline()
        try:
            self._connect(self.baseline)
            self.baseline_diagnostics = self.configure_routes(self.baseline)
            deadline = time.monotonic() + 10
            while True:
                self.baseline_observed = self.probe(self.baseline)
                if self.baseline_observed == {
                    **{name: True for name in TCP_ENDPOINTS}, "dns": True,
                }:
                    break
                if time.monotonic() >= deadline:
                    endpoint_diagnostics = self.diagnostics(self.endpoint)
                    endpoint_logs = self._docker(
                        "logs", self.endpoint.container_id, check=False
                    )
                    process_state = [process.poll() for process in self.endpoint_processes]
                    process_error = []
                    for process, state in zip(self.endpoint_processes, process_state):
                        if state is not None and process.stderr is not None:
                            process_error.append(process.stderr.read()[-4096:])
                    raise AssertionError(
                        "unconfined routed baseline could not reach controlled endpoints: "
                        f"observed={self.baseline_observed} diagnostics={self.baseline_diagnostics} "
                        f"endpoint_diagnostics={endpoint_diagnostics} "
                        f"endpoint_logs={(endpoint_logs.stdout + endpoint_logs.stderr)[-4096:]!r} "
                        f"listener_state={process_state} "
                        f"listener_error={process_error!r}"
                    )
                time.sleep(0.1)
        finally:
            self.runtime.force_remove(self.baseline)
            self.baseline = None

    def close(self):
        errors = []
        for process in self.endpoint_processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        self.endpoint_processes = []
        for family, destination in reversed(self.host_routes):
            result = subprocess.run(
                [
                    "/usr/sbin/ip", family, "route", "delete", destination,
                    "table", str(self.route_table),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(RuntimeError(result.stderr.strip()))
        self.host_routes = []
        for family in reversed(self.host_rules):
            result = subprocess.run(
                [
                    "/usr/sbin/ip", family, "rule", "delete", "priority",
                    str(self.route_table), "iif", self.bridge,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(RuntimeError(result.stderr.strip()))
        self.host_rules = []
        for address in reversed(self.host_addresses):
            result = subprocess.run(
                ["/usr/sbin/ip", "-6", "addr", "delete", address, "dev", self.bridge],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(RuntimeError(result.stderr.strip()))
        self.host_addresses = []
        for key, value in reversed(self.host_sysctls.items()):
            result = subprocess.run(
                ["/usr/sbin/sysctl", "-w", key + "=" + value],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(RuntimeError(result.stderr.strip()))
        self.host_sysctls = {}
        for attribute in ("baseline", "endpoint"):
            handle = getattr(self, attribute)
            if handle is None:
                continue
            try:
                self.runtime.force_remove(handle)
            except BaseException as error:
                errors.append(error)
            setattr(self, attribute, None)
        if errors:
            raise ExceptionGroup("controlled endpoint cleanup failed", errors)


class CausalProxyNetworkMixin:
    endpoint_harness = None

    def _apply_firewall(self, table, ruleset):
        if self.endpoint_harness is not None and self.endpoint_harness.endpoint is None:
            self.endpoint_harness.establish_baseline(self._egress_network)
        return super()._apply_firewall(table, ruleset)

    def close(self):
        endpoint_error = None
        if self.endpoint_harness is not None:
            try:
                self.endpoint_harness.close()
            except BaseException as error:
                endpoint_error = error
        try:
            super().close()
        except BaseException as network_error:
            if endpoint_error is not None:
                raise ExceptionGroup(
                    "controlled endpoint and proxy cleanup failed",
                    [endpoint_error, network_error],
                )
            raise
        if endpoint_error is not None:
            raise endpoint_error
