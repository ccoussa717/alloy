import dataclasses
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import types
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from benchmarks.swebench.artifacts import ResultWriter
from benchmarks.swebench.attempts import GateSigner
from benchmarks.swebench.containers import (
    ContainerHandle,
    ContainerSpec,
    DockerRuntime,
    MountSpec,
)
from benchmarks.swebench.coordinator import (
    TrustedCoordinator,
    TrustedRunServices,
    TrustedServiceConfig,
)
from benchmarks.swebench.evaluator import EvaluationResult
from benchmarks.swebench.install import PreparedTarget
from benchmarks.swebench.profile import load_profile
from benchmarks.swebench.proxy import ProxyNetwork


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
FIXTURES = Path(__file__).parent / "fixtures/agents"
LABEL = "alloy.swebench.gate"
SHA = "a" * 40


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
            {"absent": True, "container_id": "fixture-evaluator"},
        )


class _FixtureServices(TrustedRunServices):
    def __init__(self, config, fixture, fixture_environment, *, timeout=False):
        super().__init__(config)
        self.fixture = fixture
        self.fixture_environment = tuple(fixture_environment.items())
        self.timeout = timeout
        self.fixture_selected_before_claim = False
        self.gateway_listener = None

    def authority(self, candidate_commit, state):
        self._run_id = "docker-integration-" + uuid.uuid4().hex
        self.writer = ResultWriter(self.config.results_root, self.run_id)
        state.run_dir = str(self.writer.run_dir)
        state.manifest.update(authority_commit="b" * 40, candidate_commit=candidate_commit)

    def candidate(self, _candidate_commit, state):
        state.manifest["candidate_versions"] = {"alloy": "fixture", "pi": "fixture"}

    def integrity_preflight(self, state):
        report = self.config.runtime.preflight()
        state.manifest["host_identity"] = dataclasses.asdict(report.daemon_identity)
        state.manifest["dataset"] = {"fixture": True}

    def candidate_install(self, state):
        self.install = types.SimpleNamespace(alloy_version="fixture")
        state.manifest["candidate_install"] = {"fixture": True}

    def _cleanup_install(self):
        self.install = None

    def target_setup(self, state):
        runtime = self.config.runtime
        volume = "alloy-fixture-work-" + uuid.uuid4().hex
        runtime.create_volume(volume, self.run_id)
        runtime.initialize_volume(
            volume,
            "/agent-work",
            self.run_id,
            self.config.profile.evaluator_image,
            self.config.runtime.verify_local_image(self.config.profile.evaluator_image),
        )
        self.target = PreparedTarget(
            self.config.runtime.verify_local_image(self.config.profile.evaluator_image),
            "c" * 40,
            "d" * 64,
            volume,
        )
        helper = runtime.create(
            ContainerSpec(
                name="alloy-fixture-seed-" + uuid.uuid4().hex,
                run_id=self.run_id,
                image=self.config.profile.evaluator_image,
                image_id=self.target.image_id,
                command=("/bin/bash", "-euc", "printf 'before\\n' > /agent-work/README.txt"),
                mounts=(MountSpec(volume, "/agent-work", False, "volume"),),
            )
        )
        try:
            if runtime.wait(helper, timeout=30) != 0:
                raise RuntimeError("fixture target seed failed")
        finally:
            runtime.force_remove(helper)
        state.manifest["target_setup"] = {"fixture": True}
        self.prepare_agent_launch(state)

    def attempt_claim(self, state):
        if self.agent_spec is None:
            raise AssertionError("fixture command was not fixed before attempt claiming")
        self.fixture_selected_before_claim = True
        state.claim = object()
        state.manifest["attempt_ordinal"] = 1

    def proxy_start(self, state):
        super().proxy_start(state)
        assert self.endpoint is not None
        network = self.config.proxy._inspect_network(self.endpoint.network)
        gateway, _proxy_ip = self.config.proxy._addresses(network)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind((gateway, 0))
        listener.listen(1)
        self.gateway_listener = listener
        probes = {
            "marker": "/agent-work/fixture-marker.json",
            "tcp": {
                "proxy": [self.endpoint.host, self.endpoint.port],
                "gateway": [gateway, listener.getsockname()[1]],
                "metadata": ["169.254.169.254", 80],
                "private_ipv4": ["10.255.255.1", 80],
                "public_ipv4": ["1.1.1.1", 80],
                "private_ipv6": ["fd00::1", 80],
                "public_ipv6": ["2606:4700:4700::1111", 80],
            },
        }
        environment = dict(self.fixture_environment)
        environment["NETWORK_CONFIG"] = json.dumps(probes, separators=(",", ":"))
        environment["PROXY_HOST"] = self.endpoint.host
        environment["PROXY_PORT"] = str(self.endpoint.port)
        self.fixture_environment = tuple(environment.items())
        if self.agent_spec is None:
            raise AssertionError("fixture command was not fixed before proxy startup")
        self.agent_spec = dataclasses.replace(
            self.agent_spec, environment=self.fixture_environment
        )

    def prepare_agent_launch(self, _state):
        if self.target is None:
            raise RuntimeError("fixture target is missing")
        script = (
            "until (: >/dev/tcp/$PROXY_HOST/$PROXY_PORT) 2>/dev/null; do sleep 0.05; done; "
            "python3 /fixture/network-probes.py \"$NETWORK_CONFIG\""
            if self.fixture.name == "network-probes.py"
            else "/bin/bash /fixture/agent.sh"
        )
        mounts = [MountSpec(self.target.agent_volume, "/agent-work", False, "volume")]
        if self.fixture.name == "network-probes.py":
            mounts.append(MountSpec(self.fixture, "/fixture/network-probes.py", True, "bind"))
        else:
            mounts.append(MountSpec(self.fixture, "/fixture/agent.sh", True, "bind"))
        image_id = self.config.runtime.verify_local_image(self.config.profile.agent_image)
        self.agent_spec = ContainerSpec(
            name="alloy-agent-" + self.run_id,
            run_id=self.run_id,
            image=self.config.profile.agent_image,
            image_id=image_id,
            command=("/bin/bash", "-euc", script),
            mounts=tuple(mounts),
            environment=self.fixture_environment,
        )

    def agent_start(self, state):
        if self.agent_spec is None or self.endpoint is None:
            raise RuntimeError("fixture launch specification is unavailable")
        self.agent_create_attempted = True
        self.agent = self.config.runtime.create(self.agent_spec)
        state.manifest.setdefault("container_ids", {})["agent"] = self.agent.container_id
        self.config.proxy._docker("network", "disconnect", "none", self.agent.container_id)
        self.config.proxy._docker("network", "connect", self.endpoint.network, self.agent.container_id)
        state.manifest.setdefault("container_inspections", {})["agent"] = (
            self.config.runtime.inspect_security(
                self.agent, self.agent_spec, expected_networks=(self.endpoint.network,)
            )
        )
        timeout = 1 if self.timeout else 30
        try:
            status = self.config.runtime.wait(self.agent, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("fixture agent exceeded timeout") from error
        if status != 0:
            logged = self.config.runtime._run(
                self.config.runtime._docker_arguments("logs", self.agent.container_id)
            )
            detail = (logged.stdout + logged.stderr).strip()
            raise RuntimeError(
                f"fixture agent exited with status {status}: {detail[:4096]}"
            )

    def evaluation(self, state):
        self.instance = {"problem_statement": "fixture"}
        super().evaluation(state)

    def cleanup(self, state):
        try:
            super().cleanup(state)
        finally:
            if self.gateway_listener is not None:
                self.gateway_listener.close()
                self.gateway_listener = None


class DockerBoundaryIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("ALLOY_SWEBENCH_REQUIRE_DOCKER") != "1":
            raise unittest.SkipTest(
                "set ALLOY_SWEBENCH_REQUIRE_DOCKER=1 for required Docker isolation"
            )
        if os.geteuid() != 0:
            raise AssertionError("ALLOY_SWEBENCH_REQUIRE_DOCKER=1 requires root")
        base = load_profile(PROFILE_PATH, REPO_ROOT)
        cls.profile = dataclasses.replace(
            base,
            agent_image=base.proxy_image,
        )
        runtime = DockerRuntime(cls.profile, REPO_ROOT)
        runtime.preflight()
        cls.proxy_image_id = runtime.pull_and_verify(cls.profile.proxy_image)
        cls.evaluator_image_id = runtime.pull_and_verify(cls.profile.evaluator_image)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy-docker-integration-")
        self.root = Path(self.temporary.name)
        self.host_paths = {}
        for name in ("HOST_SECRET", "RESULT_SECRET", "DATASET_SECRET", "EVALUATOR_SECRET"):
            path = self.root / name.lower()
            path.write_text(name + "\n")
            self.host_paths[name] = str(path)
        self.base = self.root / "base"
        self.base.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.base, check=True)
        (self.base / "README.txt").write_text("before\n")
        subprocess.run(["git", "add", "README.txt"], cwd=self.base, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "base"],
            cwd=self.base,
            check=True,
        )
        self.bare = self.root / "target.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(self.base), str(self.bare)], check=True)
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
        self.run_ids = []

    def tearDown(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join(timeout=5)
        for run_id in self.run_ids:
            self._emergency_cleanup(run_id)
        self.temporary.cleanup()

    @staticmethod
    def _docker(*arguments, check=True):
        return subprocess.run(
            ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", *arguments],
            check=check,
            capture_output=True,
            text=True,
        )

    def _emergency_cleanup(self, run_id):
        label = f"{LABEL}={run_id}"
        for resource, list_args, remove_args in (
            ("container", ("ps", "-aq", "--filter", f"label={label}"), ("rm", "-f")),
            ("network", ("network", "ls", "-q", "--filter", f"label={label}"), ("network", "rm")),
            ("volume", ("volume", "ls", "-q", "--filter", f"label={label}"), ("volume", "rm", "-f")),
        ):
            identifiers = self._docker(*list_args, check=False).stdout.split()
            if identifiers:
                self._docker(*remove_args, *identifiers, check=False)
            remaining = self._docker(*list_args, check=False).stdout.strip()
            self.assertEqual(remaining, "", f"left labeled {resource} resources for {run_id}")
        table = "alloy_swe_" + ProxyNetwork._token(run_id)
        subprocess.run(
            ["/usr/sbin/nft", "delete", "table", "inet", table],
            check=False,
            capture_output=True,
            text=True,
        )

    def run_fixture(self, name, *, environment=None, timeout=False):
        runtime = DockerRuntime(self.profile, REPO_ROOT)
        proxy = ProxyNetwork(
            runtime,
            self.proxy_image_id,
            REPO_ROOT,
            f"http://127.0.0.1:{self.upstream.server_port}",
            install_signal_handlers=False,
        )
        fetcher = types.SimpleNamespace(target_repository=self.bare)
        config = TrustedServiceConfig(
            repository=REPO_ROOT,
            authority_commit="b" * 40,
            host_config=object(),
            profile=self.profile,
            runtime=runtime,
            fetcher=fetcher,
            evaluator=_StaticEvaluator(),
            proxy=proxy,
            signer=GateSigner(self.private_key),
            public_key=self.public_key,
            state_dir=self.root / "state",
            results_root=self.root / "results",
            work_root=self.root / "work",
            ollama_origin=f"http://127.0.0.1:{self.upstream.server_port}",
        )
        values = {**self.host_paths, **(environment or {})}
        services = _FixtureServices(config, FIXTURES / name, values, timeout=timeout)
        evidence = TrustedCoordinator(services).release(SHA)
        self.run_ids.append(services.run_id)
        self.assertTrue(
            services.fixture_selected_before_claim,
            f"fixture was not claimed: {evidence.status}: {evidence.error}; {evidence.manifest}",
        )
        return evidence

    def read_marker_from_patch(self, evidence):
        patch_path = Path(evidence.run_dir) / "model_patch.diff"
        patch = patch_path.read_text()
        checkout = self.root / ("marker-check-" + uuid.uuid4().hex)
        subprocess.run(["git", "clone", "-q", str(self.bare), str(checkout)], check=True)
        subprocess.run(["git", "apply", str(patch_path)], cwd=checkout, check=True)
        marker = json.loads((checkout / "fixture-marker.json").read_text())
        return marker, patch

    def test_host_results_dataset_evaluator_and_docker_socket_are_unreadable(self):
        evidence = self.run_fixture("read-host.sh")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        marker, _patch = self.read_marker_from_patch(evidence)
        self.assertEqual(marker, {name.lower(): False for name in (*self.host_paths, "DOCKER_SOCKET")})

    def test_agent_can_reach_only_proxy_not_dns_gateway_metadata_or_ip_networks(self):
        evidence = self.run_fixture("network-probes.py")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        marker, _patch = self.read_marker_from_patch(evidence)
        self.assertTrue(marker.pop("proxy"))
        self.assertEqual(marker, {name: False for name in marker})

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
        for attack in ("symlink", "fifo"):
            with self.subTest(attack=attack):
                evidence = self.run_fixture("symlink-escape.sh", environment={"ATTACK": attack})
                self.assertEqual(evidence.status, "patch_capture_failure")
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
        runtime.preflight()
        run_id = "docker-integration-evaluator-" + uuid.uuid4().hex
        self.run_ids.append(run_id)
        config = {
            "tcp": {
                "metadata": ["169.254.169.254", 80],
                "private_ipv4": ["10.255.255.1", 80],
                "public_ipv4": ["1.1.1.1", 80],
                "private_ipv6": ["fd00::1", 80],
                "public_ipv6": ["2606:4700:4700::1111", 80],
            }
        }
        script = (
            "python3 /fixture/probes.py \"$PROBE_CONFIG\"; "
            "test \"$(awk '/CapEff/{print $2}' /proc/self/status)\" = 0000000000000000; "
            "test ! -S /var/run/docker.sock"
        )
        spec = ContainerSpec(
            name="alloy-evaluator-probe-" + uuid.uuid4().hex,
            run_id=run_id,
            image=self.profile.evaluator_image,
            image_id=self.evaluator_image_id,
            command=("/bin/bash", "-euc", script),
            mounts=(MountSpec(FIXTURES / "network-probes.py", "/fixture/probes.py", True, "bind"),),
            environment=(("PROBE_CONFIG", json.dumps(config, separators=(",", ":"))),),
        )
        handle = runtime.create(spec)
        try:
            status = runtime.wait(handle, timeout=30)
            logged = runtime._run(runtime._docker_arguments("logs", handle.container_id))
            logs = logged.stdout + logged.stderr
            self.assertEqual(status, 0, logs)
            evidence = runtime.inspect_security(handle, spec)
            self.assertEqual(evidence["inspection"]["HostConfig"].get("CapAdd"), None)
        finally:
            runtime.force_remove(handle)

    def test_benign_patch_applies_cleanly(self):
        evidence = self.run_fixture("benign.sh")
        self.assertEqual(evidence.status, "evaluated", evidence.error)
        patch = Path(evidence.run_dir) / "model_patch.diff"
        clone = self.root / "apply-check"
        subprocess.run(["git", "clone", "-q", str(self.bare), str(clone)], check=True)
        subprocess.run(["git", "apply", "--check", str(patch)], cwd=clone, check=True)
        subprocess.run(["git", "apply", str(patch)], cwd=clone, check=True)
        self.assertEqual((clone / "README.txt").read_text(), "after\n")


if __name__ == "__main__":
    unittest.main()
