import dataclasses
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from benchmarks.swebench.artifacts import ResultWriter
from benchmarks.swebench.attempts import GateSigner
from benchmarks.swebench.authority import VerifiedCandidate
from benchmarks.swebench.containers import (
    DockerRuntime,
    MountSpec,
)
from benchmarks.swebench.coordinator import (
    TrustedCoordinator,
    TrustedRunServices,
    TrustedServiceConfig,
)
from benchmarks.swebench.dataset import write_private_dataset_json
from benchmarks.swebench.evaluator import EvaluationResult, EvaluatorEnvironment
from benchmarks.swebench.fetch import ArtifactFetcher
from benchmarks.swebench.profile import load_profile
from benchmarks.swebench.proxy import ProxyNetwork
from benchmarks.swebench.tests.routed_endpoints import (
    CausalProxyNetworkMixin,
    DNS_ENDPOINT,
    RoutedEndpointHarness,
    TCP_ENDPOINTS,
)


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
FIXTURES = Path(__file__).parent / "fixtures/agents"
LABEL = "alloy.swebench.gate"
BENCH_ROOT = PROFILE_PATH.parent
VENV_PYTHON = BENCH_ROOT / ".venv/bin/python"


class _Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"models":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class _StaticEvaluator:
    _last_teardown_evidence = None

    def run(self, *_args):
        return EvaluationResult(
            "fixture evaluator\n",
            "",
            {
                "schema_version": 2,
                "resolved_ids": [],
                "unresolved_ids": ["astropy__astropy-12907"],
            },
            {
                "container_id": "fixture-evaluator",
                "inspection": {"fixture": True},
            },
            {
                "absent": True,
                "container_id": "fixture-evaluator",
                "workspace_volume": "fixture-evaluator-volume",
                "workspace_volume_absent": True,
            },
        )


class _ControlledGateway:
    def __init__(self):
        self.closed = False
        self.gateway_servers = []

    def add_gateway_alternate(self, host):
        server = ThreadingHTTPServer((host, 0), _Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.gateway_servers.append((server, thread))
        with socket.create_connection((host, server.server_port), timeout=2):
            pass
        return [host, server.server_port]

    def close(self):
        if self.closed:
            return
        self.closed = True
        for server, thread in self.gateway_servers:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def assert_alive(self):
        for server, thread in self.gateway_servers:
            if not thread.is_alive():
                raise AssertionError("controlled gateway listener died before denial probe")
            with socket.create_connection(server.server_address, timeout=2):
                pass


class _CausalProxyNetwork(CausalProxyNetworkMixin, ProxyNetwork):
    pass


class _FixtureServices(TrustedRunServices):
    def __init__(self, config, candidate, fetched, target_source, control):
        super().__init__(config)
        self.fixture_candidate = candidate
        self.fixture_fetched = fetched
        self.fixture_target_source = target_source
        self.control = control

    def authority(self, candidate_commit, state):
        self._run_id = "docker-integration-" + uuid.uuid4().hex
        endpoint_harness = getattr(self.config.proxy, "endpoint_harness", None)
        if endpoint_harness is not None:
            endpoint_harness.run_id = self.run_id
        self.writer = ResultWriter(self.config.results_root, self.run_id)
        state.run_dir = str(self.writer.run_dir)
        self.verified_candidate = self.fixture_candidate
        state.manifest.update(authority_commit=candidate_commit, candidate_commit=candidate_commit)

    def candidate(self, _candidate_commit, state):
        self.fetched = self.fixture_fetched
        state.manifest["candidate_versions"] = {
            "alloy": self.fetched.alloy_version,
            "pi": self.fetched.pi_version,
        }

    def integrity_preflight(self, state):
        report = self.config.runtime.preflight()
        self.target_source = self.fixture_target_source
        self.instance = {"problem_statement": "fixture"}
        state.manifest["host_identity"] = dataclasses.asdict(report.daemon_identity)
        state.manifest["dataset"] = {"fixture": True}

    def attempt_claim(self, state):
        if self.config.agent_command is None:
            raise AssertionError("fixture command was not fixed before attempt claiming")
        super().attempt_claim(state)

    def proxy_start(self, state):
        super().proxy_start(state)
        assert self.endpoint is not None
        endpoint_harness = getattr(self.config.proxy, "endpoint_harness", None)
        if endpoint_harness is None:
            return
        if endpoint_harness.baseline_observed is None:
            raise AssertionError("routed endpoint baseline did not run before nft installation")
        probes = {
            **endpoint_harness.config(),
            "marker": "/agent-work/fixture-marker.json",
            "relay": [self.endpoint.host, self.endpoint.port],
        }
        gateway = subprocess.run(
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}",
                self.endpoint.network,
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        probes["tcp"]["gateway_alternate"] = self.control.add_gateway_alternate(gateway)
        boundaries = {
            **{name: "internal-topology-no-route" for name in TCP_ENDPOINTS},
            "dns": "internal-topology-no-route",
            "gateway_alternate": "nft-agent-input",
            "relay": "allowed-proxy-route",
        }
        probes["boundaries"] = boundaries
        self.network_probes = probes
        state.manifest["network_causality"] = {
            "baseline_observed": endpoint_harness.baseline_observed,
            "baseline_diagnostics": endpoint_harness.baseline_diagnostics,
            "baseline_image_id": endpoint_harness.baseline_image_id,
            "baseline_confinement": "apparmor=unconfined,seccomp=unconfined",
            "denial_boundaries": boundaries,
        }
        environment = (
            *self.config.agent_environment,
            ("NETWORK_CONFIG", json.dumps(probes, separators=(",", ":"))),
        )
        self.config = dataclasses.replace(self.config, agent_environment=environment)

    def agent_start(self, state):
        if not any(
            mount.target == "/fixture/network-probes.py"
            for mount in self.config.agent_mounts
        ):
            return super().agent_start(state)
        results = []
        errors = []

        def probe_live_namespace():
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if self.agent is not None and self.endpoint is not None:
                        inspected = json.loads(
                            self.config.proxy._docker("inspect", self.agent.container_id).stdout
                        )[0]
                        if (
                            inspected["State"]["Running"]
                            and self.endpoint.network in inspected["NetworkSettings"]["Networks"]
                        ):
                            script = (
                                Path(__file__).parent / "fixtures/agents/network-probes.py"
                            ).read_text()
                            config = {
                                key: value for key, value in self.network_probes.items()
                                if key != "marker"
                            }
                            probe = self.config.proxy.endpoint_harness.probe_network_namespace(
                                self.agent, script, config,
                            )
                            if probe.returncode != 0:
                                raise AssertionError(probe.stdout + probe.stderr)
                            self.config.proxy.endpoint_harness.assert_endpoint_live()
                            self.control.assert_alive()
                            results.append(json.loads(probe.stdout))
                            return
                    time.sleep(0.05)
                raise AssertionError("agent namespace was not available for causal probe")
            except BaseException as error:
                errors.append(error)
            finally:
                if self.agent is not None:
                    self.config.proxy._docker(
                        "exec", self.agent.container_id, "python3", "-c",
                        "from pathlib import Path; Path('/agent-work/causal-probe-done').touch()",
                        check=False,
                    )

        thread = threading.Thread(target=probe_live_namespace)
        thread.start()
        try:
            super().agent_start(state)
        finally:
            thread.join(timeout=15)
        if thread.is_alive():
            raise AssertionError("agent namespace causal probe did not finish")
        if errors:
            raise errors[0]
        state.manifest["network_causality"]["internal_namespace_probe"] = results[0]


class DockerBoundaryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("ALLOY_SWEBENCH_REQUIRE_DOCKER") != "1":
            raise unittest.SkipTest(
                "set ALLOY_SWEBENCH_REQUIRE_DOCKER=1 for required Docker isolation"
            )
        if os.geteuid() != 0:
            raise AssertionError("ALLOY_SWEBENCH_REQUIRE_DOCKER=1 requires root")
        cls.profile = load_profile(PROFILE_PATH, REPO_ROOT)
        cls.cache_root = BENCH_ROOT / ".cache" / ("task11-" + uuid.uuid4().hex)
        cls.cache_root.mkdir(mode=0o700, parents=True)
        cls.candidate_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        package = json.loads((REPO_ROOT / "package.json").read_text())
        cls.candidate = VerifiedCandidate(
            cls.candidate_commit, cls.candidate_commit, package["version"], ()
        )

        def downloader(url):
            if url.endswith("/" + cls.candidate_commit) and "ccoussa717/alloy" in url:
                return subprocess.run(
                    [
                        "git", "archive", "--format=tar.gz",
                        f"--prefix=alloy-{cls.candidate_commit}/", cls.candidate_commit,
                    ],
                    cwd=REPO_ROOT,
                    check=True,
                    capture_output=True,
                ).stdout
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=120) as response:
                return response.read(cls.profile.limits.max_export_bytes + 1)

        target_repository = cls.cache_root / "target.git"
        subprocess.run(
            ["git", "clone", "-q", "--no-checkout", "https://github.com/astropy/astropy.git", str(target_repository)],
            check=True,
        )
        subprocess.run(
            ["git", "fetch", "-q", "--depth=1", "origin", cls.profile.base_commit],
            cwd=target_repository,
            check=True,
        )
        subprocess.run(
            ["git", "checkout", "-q", "--detach", cls.profile.base_commit],
            cwd=target_repository,
            check=True,
        )
        fetcher = ArtifactFetcher(
            REPO_ROOT,
            cls.cache_root / "artifacts",
            downloader=downloader,
            profile=cls.profile,
            target_repository=target_repository,
        )
        cls.fetcher = fetcher
        fetched = fetcher.fetch_candidate(cls.candidate)
        cls.fetched = dataclasses.replace(
            fetched,
            npm_cache=fetcher.fetch_npm_cache(fetched),
            bun_archive=fetcher.fetch_bun(),
        )
        cls.target_source = fetcher.fetch_target_source(cls.profile)
        dataset_script = (
            "import json,sys; "
            "from pathlib import Path; "
            "from benchmarks.swebench.dataset import fetch_and_verify_instance; "
            "from benchmarks.swebench.profile import load_profile; "
            "root=Path(sys.argv[1]); profile=load_profile(root/'benchmarks/swebench/profile.json',root); "
            "print(json.dumps(fetch_and_verify_instance(Path(sys.argv[2]),profile),sort_keys=True))"
        )
        dataset = subprocess.run(
            [str(VENV_PYTHON), "-c", dataset_script, str(REPO_ROOT), str(cls.cache_root / "dataset")],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.dataset_row = json.loads(dataset.stdout)
        runtime = DockerRuntime(cls.profile, REPO_ROOT)
        cls.preflight_report = runtime.preflight()
        cls.agent_image_id = runtime.pull_and_verify(cls.profile.agent_image)
        cls.proxy_image_id = runtime.pull_and_verify(cls.profile.proxy_image)
        cls.evaluator_image_id = runtime.pull_and_verify(cls.profile.evaluator_image)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache_root)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy-docker-integration-")
        self.root = Path(self.temporary.name)
        self.control = _ControlledGateway()
        self.addCleanup(self.control.close)
        self.host_paths = {}
        for name in ("HOST_SECRET", "RESULT_SECRET", "DATASET_SECRET", "EVALUATOR_SECRET"):
            path = self.root / name.lower()
            path.write_text(name + "\n")
            self.host_paths[name] = str(path)
        self.private_key = self.root / "gate-key.pem"
        self.public_key = self.root / "gate-key.pub.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", self.private_key],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["openssl", "pkey", "-in", self.private_key, "-pubout", "-out", self.public_key],
            check=True,
            capture_output=True,
        )
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        self.runs = []
        self.evaluator_run_ids = []
        self.evaluator_scratch_before = set(Path("/tmp").glob("alloy-evaluator-*"))

    def tearDown(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join(timeout=5)
        for run_id, proxy, services in self.runs:
            self._emergency_cleanup(run_id, proxy, services)
        for run_id in self.evaluator_run_ids:
            self._emergency_cleanup(run_id, None, None)
        self.temporary.cleanup()

    @staticmethod
    def _docker(*arguments, check=True):
        return subprocess.run(
            ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", *arguments],
            check=check,
            capture_output=True,
            text=True,
        )

    def _resource_inventory(self, run_id, proxy=None, services=None):
        label = f"{LABEL}={run_id}"
        containers = self._docker("ps", "-aq", "--filter", f"label={label}", check=False).stdout.split()
        networks = self._docker("network", "ls", "-q", "--filter", f"label={label}", check=False).stdout.split()
        volumes = self._docker("volume", "ls", "-q", "--filter", f"label={label}", check=False).stdout.split()
        table = "alloy_swe_" + ProxyNetwork._token(run_id)
        nft = subprocess.run(
            ["/usr/sbin/nft", "list", "table", "inet", table],
            check=False,
            capture_output=True,
            text=True,
        )
        work = self.root / "work"
        scratch = [] if not work.exists() else [str(path) for path in work.iterdir()]
        relay = []
        if proxy is not None and (not proxy._closed or proxy._relay is not None):
            relay.append(repr(getattr(proxy._relay, "address", proxy._relay)))
        if services is not None and getattr(services, "_scratch_dir", None) is not None:
            scratch.append(str(services._scratch_dir))
        evaluator_scratch = set(Path("/tmp").glob("alloy-evaluator-*"))
        scratch.extend(str(path) for path in evaluator_scratch - self.evaluator_scratch_before)
        return {
            "containers": containers,
            "networks": networks,
            "volumes": volumes,
            "nft": [table] if nft.returncode == 0 else [],
            "relays": relay,
            "scratch": scratch,
        }

    def _assert_no_leaks(self, run_id, proxy=None, services=None):
        inventory = self._resource_inventory(run_id, proxy, services)
        leaks = {name: values for name, values in inventory.items() if values}
        self.assertEqual(leaks, {}, f"production cleanup leaked resources: {leaks}")

    def _emergency_cleanup(self, run_id, proxy, services):
        if services is not None:
            scratch = getattr(services, "_scratch_dir", None)
            if scratch is not None:
                shutil.rmtree(scratch, ignore_errors=True)
                services._scratch_dir = None
        if proxy is not None and not proxy._closed:
            try:
                proxy.close()
            except BaseException:
                pass
        label = f"{LABEL}={run_id}"
        for list_args, remove_args in (
            (("ps", "-aq", "--filter", f"label={label}"), ("rm", "-f")),
            (("network", "ls", "-q", "--filter", f"label={label}"), ("network", "rm")),
            (("volume", "ls", "-q", "--filter", f"label={label}"), ("volume", "rm", "-f")),
        ):
            identifiers = self._docker(*list_args, check=False).stdout.split()
            if identifiers:
                self._docker(*remove_args, *identifiers, check=False)
        table = "alloy_swe_" + ProxyNetwork._token(run_id)
        subprocess.run(
            ["/usr/sbin/nft", "delete", "table", "inet", table],
            check=False,
            capture_output=True,
            text=True,
        )
        work = self.root / "work"
        if work.exists():
            shutil.rmtree(work)
        inventory = self._resource_inventory(run_id)
        leaks = {name: values for name, values in inventory.items() if values}
        self.assertEqual(leaks, {}, f"emergency cleanup failed: {leaks}")

    def run_fixture(self, name, *, environment=None, timeout=False):
        runtime = DockerRuntime(self.profile, REPO_ROOT)
        proxy_class = _CausalProxyNetwork if name == "network-probes.py" else ProxyNetwork
        proxy = proxy_class(
            runtime,
            self.proxy_image_id,
            REPO_ROOT,
            f"http://127.0.0.1:{self.upstream.server_port}",
            install_signal_handlers=False,
        )
        if name == "network-probes.py":
            proxy.endpoint_harness = RoutedEndpointHarness(
                runtime,
                proxy,
                "pending-run-id",
                self.profile.proxy_image,
                self.proxy_image_id,
                self.profile.agent_image,
                self.agent_image_id,
            )
        fixture = FIXTURES / name
        if name == "network-probes.py":
            command = (
                "/bin/bash",
                "-euc",
                "until (: >/dev/tcp/$PROXY_HOST/$PROXY_PORT) 2>/dev/null; do sleep 0.05; done; "
                "status=0; python3 /fixture/network-probes.py \"$NETWORK_CONFIG\" || status=$?; "
                "until [ -f /agent-work/causal-probe-done ]; do sleep 0.05; done; "
                "rm -f /agent-work/causal-probe-done; exit $status",
            )
            mount = MountSpec(fixture, "/fixture/network-probes.py", True, "bind")
        else:
            command = ("/bin/bash", "/fixture/agent.sh")
            mount = MountSpec(fixture, "/fixture/agent.sh", True, "bind")
        values = {**self.host_paths, **(environment or {})}
        state_dir = self.root / "state" / uuid.uuid4().hex
        state_dir.mkdir(mode=0o700, parents=True)
        config = TrustedServiceConfig(
            repository=REPO_ROOT,
            authority_commit="b" * 40,
            host_config=object(),
            profile=self.profile,
            runtime=runtime,
            fetcher=self.fetcher,
            evaluator=_StaticEvaluator(),
            proxy=proxy,
            signer=GateSigner(self.private_key),
            public_key=self.public_key,
            state_dir=state_dir,
            results_root=self.root / "results",
            work_root=self.root / "work",
            ollama_origin=f"http://127.0.0.1:{self.upstream.server_port}",
            agent_fixture=True,
            agent_command=command,
            agent_mounts=(mount,),
            agent_environment=tuple(values.items()),
            agent_timeout_seconds=1 if timeout else 30,
        )
        services = _FixtureServices(
            config, self.candidate, self.fetched, self.target_source, self.control
        )
        evidence = TrustedCoordinator(services).release(self.candidate_commit)
        self.runs.append((services.run_id, proxy, services))
        consumed = list(state_dir.glob("*.consumed"))
        self.assertEqual(
            len(consumed), 1,
            f"production create callback did not consume claim: {evidence.status}: {evidence.error}",
        )
        self.assertTrue(services.agent_create_attempted)
        self._assert_no_leaks(services.run_id, proxy, services)
        return evidence

    def read_marker_from_patch(self, evidence):
        patch_path = Path(evidence.run_dir) / "model_patch.diff"
        patch = patch_path.read_text()
        checkout = self.root / ("marker-check-" + uuid.uuid4().hex)
        subprocess.run(
            ["git", "clone", "-q", str(self.fetcher.target_repository), str(checkout)],
            check=True,
        )
        subprocess.run(["git", "apply", str(patch_path)], cwd=checkout, check=True)
        marker = json.loads((checkout / "fixture-marker.json").read_text())
        return marker, patch

    def test_host_results_dataset_evaluator_and_docker_socket_are_unreadable(self):
        evidence = self.run_fixture("read-host.sh")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        self.assertRegex(self.preflight_report.kernel_release, r"^[0-9A-Za-z][0-9A-Za-z._+-]+$")
        self.assertRegex(self.preflight_report.runc_version, r"^[0-9]+(?:\.[0-9]+)+")
        self.assertTrue(self.preflight_report.runc_commit)
        self.assertRegex(self.preflight_report.runc_spec, r"^[0-9]+(?:\.[0-9]+)+$")
        for name in ("proxy", "agent"):
            inspection = evidence.manifest["container_inspections"][name]["inspection"]
            self.assertEqual(inspection["HostConfig"].get("CgroupnsMode"), "private")
        marker, _patch = self.read_marker_from_patch(evidence)
        self.assertEqual(marker, {name.lower(): False for name in (*self.host_paths, "DOCKER_SOCKET")})

    def test_agent_can_reach_only_proxy_not_dns_gateway_metadata_or_ip_networks(self):
        evidence = self.run_fixture("network-probes.py")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        marker, _patch = self.read_marker_from_patch(evidence)
        observed = marker["observed"]
        self.assertTrue(observed.pop("relay"), marker)
        expected_boundaries = evidence.manifest["network_causality"]["denial_boundaries"]
        denied = {name: boundary for name, boundary in expected_boundaries.items() if name != "relay"}
        self.assertEqual(observed, {name: False for name in denied}, marker)
        self.assertEqual(marker["boundaries"], expected_boundaries)
        internal_probe = evidence.manifest["network_causality"]["internal_namespace_probe"]
        self.assertEqual(
            internal_probe["observed"],
            {name: boundary == "allowed-proxy-route" for name, boundary in expected_boundaries.items()},
        )
        self.assertEqual(internal_probe["boundaries"], expected_boundaries)
        diagnostics = internal_probe["route_diagnostics"]

        def ipv4_route_covers(address):
            target = int(ipaddress.ip_address(address))
            for line in diagnostics["ipv4_routes"].splitlines()[1:]:
                fields = line.split()
                destination = int.from_bytes(bytes.fromhex(fields[1]), "little")
                mask = int.from_bytes(bytes.fromhex(fields[7]), "little")
                flags = int(fields[3], 16)
                if not flags & 0x200 and target & mask == destination:
                    return True
            return False

        def ipv6_route_covers(address):
            target = int(ipaddress.ip_address(address))
            for line in diagnostics["ipv6_routes"].splitlines():
                fields = line.split()
                destination = int(fields[0], 16)
                prefix = int(fields[1], 16)
                flags = int(fields[8], 16)
                if not flags & 0x200 and (
                    prefix == 0 or target >> (128 - prefix) == destination >> (128 - prefix)
                ):
                    return True
            return False

        for name, (address, _port) in TCP_ENDPOINTS.items():
            route_covers = ipv6_route_covers if ":" in address else ipv4_route_covers
            self.assertFalse(route_covers(address), f"{name} had a covering internal route")
        self.assertFalse(ipv4_route_covers(DNS_ENDPOINT[0]), "DNS had a covering internal route")
        self.assertEqual(
            evidence.manifest["network_causality"]["baseline_observed"],
            {**{name: True for name in TCP_ENDPOINTS}, "dns": True},
        )

    def test_summary_forgery_stays_patch_data_and_cannot_change_official_verdict(self):
        evidence = self.run_fixture("forge-results.sh")
        self.assertEqual((evidence.status, evidence.verdict), ("evaluated", "unresolved"))
        marker, patch = self.read_marker_from_patch(evidence)
        self.assertFalse(marker["host_result_write"])
        self.assertIn("official-summary.json", patch)
        official = json.loads((Path(evidence.run_dir) / "official-summary.json").read_text())
        self.assertEqual(official["unresolved_ids"], ["astropy__astropy-12907"])

    def test_hostile_git_metadata_is_ignored_by_trusted_patch_capture(self):
        evidence = self.run_fixture("git-metadata.sh")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        _marker, patch = self.read_marker_from_patch(evidence)
        self.assertNotIn(".git/config", patch)
        self.assertNotIn("git-command-executed", patch)
        self.assertIn("hostile.txt", patch)

    def test_symlink_escape_and_special_file_exports_fail_closed(self):
        expected = {
            "symlink": "archive symlink 'escape' target must be relative",
            "fifo": "archive member 'special' has forbidden type fifo",
        }
        for attack, message in expected.items():
            with self.subTest(attack=attack):
                evidence = self.run_fixture("symlink-escape.sh", environment={"ATTACK": attack})
                self.assertEqual(evidence.status, "patch_capture_failure")
                self.assertEqual(evidence.error, message)
                self.assertIsNone(evidence.verdict)

    def test_detached_descendants_disappear_after_normal_exit_and_timeout(self):
        normal = self.run_fixture("detached-child.sh")
        self.assertEqual(normal.status, "evaluated", normal.error)
        timed = self.run_fixture(
            "detached-child.sh", environment={"TIMEOUT": "1"}, timeout=True
        )
        self.assertEqual(timed.status, "agent_timeout")
        for evidence in (normal, timed):
            self.assertTrue(evidence.manifest["teardown"]["agent_absent"])

    def test_evaluator_role_has_no_capabilities_socket_or_network_escape(self):
        runtime = DockerRuntime(self.profile, REPO_ROOT)
        run_id = "docker-integration-evaluator-" + uuid.uuid4().hex
        self.evaluator_run_ids.append(run_id)
        predictions = self.root / "private" / "predictions.jsonl"
        dataset = self.root / "private" / "dataset.json"
        secret = "EVALUATOR-HOST-SECRET-" + uuid.uuid4().hex
        host_secret = self.root / "host-results" / "evaluator-secret.txt"
        host_secret.parent.mkdir()
        host_secret.write_text(secret)
        endpoints = list(TCP_ENDPOINTS.values())
        probe = "\n".join([
            "import json, os, socket, time",
            "time.sleep(2)",
            "def readable(path):",
            "    try:",
            "        open(path, 'rb').read(1)",
            "        return True",
            "    except OSError:",
            "        return False",
            "def reachable(endpoint):",
            "    try:",
            "        with socket.create_connection(tuple(endpoint), timeout=0.25): pass",
            "        return True",
            "    except OSError:",
            "        return False",
            "def has_capabilities():",
            "    with open('/proc/self/status') as status:",
            "        return next(line.split()[1] for line in status if line.startswith('CapEff:')) != '0000000000000000'",
            f"paths = {json.dumps([str(host_secret), str(predictions), str(dataset)])}",
            f"endpoints = {json.dumps(endpoints)}",
            "observed = {",
            "    'host_paths': any(readable(path) for path in paths),",
            "    'docker_socket': os.path.exists('/var/run/docker.sock'),",
            "    'network': any(reachable(endpoint) for endpoint in endpoints),",
            "    'capabilities': has_capabilities(),",
            "}",
            "print('EVALUATOR_BOUNDARY=' + json.dumps(observed, sort_keys=True))",
            "assert observed == {key: False for key in observed}",
        ]) + "\n"

        def new_file_patch(path, content):
            lines = content.splitlines()
            additions = "\n".join("+" + line for line in lines)
            return (
                f"diff --git a/{path} b/{path}\nnew file mode 100644\n"
                f"--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(lines)} @@\n{additions}\n"
            )

        test_patch = new_file_patch("astropy/tests/evaluator-boundary-fixture.txt", "private fixture\n")
        row = dict(self.dataset_row)
        node_id = "astropy/tests/test_evaluator_boundary.py::test_evaluator_boundary"
        probe = "def test_evaluator_boundary():\n" + "\n".join(
            "    " + line if line else "" for line in probe.splitlines()
        ) + "\n"
        model_patch = new_file_patch("astropy/tests/test_evaluator_boundary.py", probe)
        row.update({
            "test_patch": test_patch,
            "FAIL_TO_PASS": json.dumps([node_id]),
            "PASS_TO_PASS": "[]",
            "eval_script": "\n".join([
                "#!/bin/bash",
                "set -u",
                "source /opt/miniconda3/bin/activate",
                "conda activate testbed",
                "cd /testbed",
                "git config --global --add safe.directory /testbed",
                "echo '>>>>> Start Test Output'",
                f"pytest -rA {node_id}",
                "status=$?",
                "echo '>>>>> End Test Output'",
                "echo \">>>>> Test Exit Code: $status\"",
                "exit $status",
            ]),
        })
        predictions.parent.mkdir(mode=0o700)
        predictions.write_text(json.dumps({
            "instance_id": self.profile.instance_id,
            "model_name_or_path": "alloy/evaluator-boundary",
            "model_patch": model_patch,
        }, separators=(",", ":")) + "\n")
        write_private_dataset_json(dataset, row)
        environment = EvaluatorEnvironment(
            self.profile, REPO_ROOT, VENV_PYTHON, runtime=runtime,
        )
        result = environment.run(predictions, dataset, run_id)
        self.assertIn(
            self.profile.instance_id, result.summary["resolved_ids"], result.stderr,
        )
        self.assertNotIn(secret, result.stdout + result.stderr + json.dumps(result.summary))
        self.assertTrue(result.teardown_evidence["absent"])
        inspection = result.container_evidence["inspection"]
        self.assertEqual(inspection["HostConfig"].get("CapAdd"), None)
        self.assertEqual(inspection["HostConfig"].get("CgroupnsMode"), "private")
        self._assert_no_leaks(run_id)

    def test_evaluator_timeout_and_crash_remove_workspace_volume(self):
        profile = dataclasses.replace(
            self.profile,
            limits=dataclasses.replace(
                self.profile.limits, evaluator_timeout_seconds=1
            ),
        )
        for mode, expected_error in (
            ("timeout", subprocess.TimeoutExpired),
            ("crash", subprocess.CalledProcessError),
        ):
            with self.subTest(mode=mode):
                run_id = f"docker-integration-evaluator-{mode}-{uuid.uuid4().hex}"
                self.evaluator_run_ids.append(run_id)
                predictions = self.root / f"{mode}-predictions.jsonl"
                dataset = self.root / f"{mode}-dataset.json"
                predictions.write_text("{}\n")
                dataset.write_text("[]\n")
                volume = f"alloy-eval-workspace-{run_id}"
                action = (
                    "import time; time.sleep(30)"
                    if mode == "timeout"
                    else "import os; os._exit(17)"
                )
                code = (
                    "import subprocess; "
                    f"subprocess.run(['/usr/bin/docker','volume','create','--label','{LABEL}={run_id}','{volume}'],check=True,capture_output=True); "
                    + action
                )
                command = [
                    str(VENV_PYTHON),
                    "-c",
                    code,
                    "--report_dir",
                    str(self.root),
                    "--run_id",
                    run_id,
                ]
                environment = EvaluatorEnvironment(
                    profile, REPO_ROOT, VENV_PYTHON, runtime=DockerRuntime(profile, REPO_ROOT)
                )
                environment.runtime.preflight()
                environment._image_id = self.evaluator_image_id
                with (
                    mock.patch.object(environment, "verify"),
                    mock.patch.object(environment, "_command", return_value=command),
                    mock.patch.object(
                        environment,
                        "_await_evaluator_evidence",
                        return_value={"container_id": "fixture", "inspection": {}},
                    ),
                    self.assertRaises(expected_error),
                ):
                    environment.run(predictions, dataset, run_id)
                self._assert_no_leaks(run_id)

    def test_benign_patch_applies_cleanly(self):
        evidence = self.run_fixture("benign.sh")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        patch = Path(evidence.run_dir) / "model_patch.diff"
        clone = self.root / "apply-check"
        subprocess.run(
            ["git", "clone", "-q", str(self.fetcher.target_repository), str(clone)],
            check=True,
        )
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=clone, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=clone, check=True)
        self.assertEqual((clone / "README.txt").read_text(), "after\n")


if __name__ == "__main__":
    unittest.main()
