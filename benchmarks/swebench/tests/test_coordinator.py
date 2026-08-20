import subprocess
import tempfile
import types
import unittest
from pathlib import Path

from benchmarks.swebench.coordinator import (
    EXPECTED_RELEASE_PHASES,
    CoordinatorFailure,
    TrustedRunServices,
    TrustedServiceConfig,
    TrustedCoordinator,
    _RunState,
)
from benchmarks.swebench.attempts import GateSigner
from benchmarks.swebench.artifacts import ResultWriter
from benchmarks.swebench.authority import HostConfig, VerifiedCandidate
from benchmarks.swebench.containers import CleanupUncertainError, ContainerHandle
from benchmarks.swebench.evaluator import EvaluationResult
from benchmarks.swebench.install import PreparedTarget, VerifiedCandidateInstall
from benchmarks.swebench.profile import load_profile
from benchmarks.swebench.proxy import ProxyEndpoint


SHA = "a" * 40
REPO_ROOT = Path(__file__).parents[3]
PROFILE = load_profile(Path(__file__).parents[1] / "profile.json", REPO_ROOT)


class RecordingServices:
    def __init__(self, *, verdict="resolved", failure=None, cleanup_failure=None):
        self.calls = []
        self.cleanups = []
        self.consumed = False
        self.agent_absent = False
        self.patch_trusted = False
        self.evaluator_absent = False
        self.verdict = verdict
        self.failure = failure
        self.cleanup_failure = cleanup_failure
        self.signed_manifest = None
        self.unsigned_manifest = None

    def arm_cleanup(self, phase, state):
        armed = {"phase": phase, "used": False}
        self.cleanups.append(armed)

        def cleanup():
            armed["used"] = True
            if self.cleanup_failure and self.cleanup_failure[0] == phase:
                raise self.cleanup_failure[1]

        return cleanup

    def _phase(self, name, state):
        self.calls.append(name)
        if name in {
            "candidate_install",
            "target_setup",
            "proxy_start",
            "agent_start",
            "evaluation",
        }:
            self.assert_cleanup_armed(name)
        if self.failure and self.failure[0] == name:
            raise self.failure[1]

    def assert_cleanup_armed(self, phase):
        if not any(item["phase"] == phase for item in self.cleanups):
            raise AssertionError(f"cleanup was not armed before {phase}")

    def authority(self, candidate_commit, state):
        self._phase("authority", state)
        state.manifest.update(
            authority_commit="b" * 40,
            coordinator_tree_sha256="c" * 64,
            host_identity={"daemon_id": "daemon-1", "name": "release-host"},
        )

    def candidate(self, candidate_commit, state):
        self._phase("candidate", state)
        state.manifest.update(
            candidate_commit=candidate_commit,
            candidate_versions={"alloy": "1.1.26", "pi": "0.82.1"},
        )

    def integrity_preflight(self, state):
        self._phase("integrity_preflight", state)
        state.manifest.update(
            dataset={"revision": "d" * 40, "row_sha256": "e" * 64},
            image_digests={"agent": "sha256:" + "f" * 64},
            policy_digests={"apparmor": "1" * 64, "seccomp": "2" * 64},
            lock_digests={"evaluator": "3" * 64, "npm": "4" * 64},
            model_digest="5" * 64,
        )

    def candidate_install(self, state):
        self._phase("candidate_install", state)

    def target_setup(self, state):
        self._phase("target_setup", state)

    def attempt_claim(self, state):
        self._phase("attempt_claim", state)
        state.manifest["attempt_ordinal"] = 1
        state.claim = object()

    def proxy_start(self, state):
        self._phase("proxy_start", state)
        state.manifest.setdefault("container_ids", {})["proxy"] = "proxy-id"
        state.manifest.setdefault("container_inspections", {})["proxy"] = {
            "network": "internal"
        }

    def prepare_agent_launch(self, state):
        if state.claim is None:
            raise AssertionError("claim was not verified before launch preparation")
        self.consumed = True

    def agent_start(self, state):
        if not self.consumed:
            raise AssertionError("agent launch was not prepared")
        self._phase("agent_start", state)
        state.manifest.setdefault("container_ids", {})["agent"] = "agent-id"
        state.manifest.setdefault("container_inspections", {})["agent"] = {
            "absent": False
        }

    def agent_teardown(self, state):
        self._phase("agent_teardown", state)
        self.agent_absent = True
        state.manifest.setdefault("container_inspections", {}).setdefault("agent", {})[
            "absent"
        ] = True
        state.manifest.setdefault("teardown", {})["agent_absent"] = True

    def patch_capture(self, state):
        if not self.agent_absent:
            raise AssertionError("patch capture preceded proven agent absence")
        self._phase("patch_capture", state)
        self.patch_trusted = True
        state.manifest["patch_sha256"] = "6" * 64

    def evaluation(self, state):
        if not self.agent_absent or not self.patch_trusted:
            raise AssertionError("evaluation preceded trusted patch reconstruction")
        self._phase("evaluation", state)
        state.verdict = self.verdict
        state.manifest["evaluator_summary_sha256"] = "7" * 64

    def evaluation_teardown(self, state):
        self._phase("evaluation_teardown", state)
        self.evaluator_absent = True
        state.manifest.setdefault("teardown", {})["evaluator_absent"] = True

    def sign_results(self, state):
        if "evaluation" in self.calls and not self.evaluator_absent:
            raise AssertionError("results signed before evaluator teardown")
        if not all(item["used"] for item in self.cleanups) or "cleanup" not in self.calls:
            raise AssertionError("results signed before full cleanup")
        self._phase("sign_results", state)
        self.signed_manifest = dict(state.manifest)
        return "signed-evidence"

    def cleanup(self, state):
        self._phase("cleanup", state)
        if self.cleanup_failure and self.cleanup_failure[0] == "cleanup":
            raise self.cleanup_failure[1]

    def write_unsigned_failure(self, state):
        self.calls.append("write_unsigned_failure")
        self.unsigned_manifest = dict(state.manifest)


class CoordinatorTests(unittest.TestCase):
    def test_release_has_one_fixed_order_and_boundary_only_claim_consumption(self):
        services = RecordingServices()
        evidence = TrustedCoordinator(services).release(SHA)

        self.assertEqual(
            tuple(services.calls),
            (
                "authority",
                "candidate",
                "integrity_preflight",
                "candidate_install",
                "target_setup",
                "attempt_claim",
                "proxy_start",
                "agent_start",
                "agent_teardown",
                "patch_capture",
                "evaluation",
                "evaluation_teardown",
                "cleanup",
                "sign_results",
            ),
        )
        self.assertEqual(
            EXPECTED_RELEASE_PHASES[-2:],
            ("cleanup", "sign_results"),
        )
        self.assertEqual(evidence.status, "evaluated")
        self.assertEqual(evidence.verdict, "resolved")
        self.assertEqual(evidence.exit_code, 0)
        self.assertTrue(all(item["used"] for item in services.cleanups))

    def test_dry_run_never_claims_launches_or_evaluates(self):
        services = RecordingServices()
        evidence = TrustedCoordinator(services).dry_run(SHA)

        self.assertEqual(
            services.calls,
            [
                "authority",
                "candidate",
                "integrity_preflight",
                "candidate_install",
                "cleanup",
                "sign_results",
            ],
        )
        self.assertNotIn("attempt_ordinal", evidence.manifest)
        self.assertEqual(evidence.status, "dry_run")
        self.assertEqual(evidence.exit_code, 0)

    def test_only_official_resolved_or_unresolved_release_outcomes_succeed(self):
        for verdict, exit_code in (("resolved", 0), ("unresolved", 0), ("other", 8)):
            with self.subTest(verdict=verdict):
                evidence = TrustedCoordinator(RecordingServices(verdict=verdict)).release(SHA)
                self.assertEqual(evidence.exit_code, exit_code)
                if verdict == "other":
                    self.assertEqual(evidence.status, "evaluator_failure")

    def test_failures_keep_attributable_status_and_always_cleanup(self):
        cases = (
            ("candidate", RuntimeError("bad candidate"), "runtime_failure", 2),
            ("target_setup", RuntimeError("bad target"), "checkout_failure", 4),
            ("agent_start", TimeoutError("agent timed out"), "agent_timeout", 5),
            ("agent_start", RuntimeError("agent failed"), "agent_failure", 6),
            ("patch_capture", RuntimeError("bad export"), "patch_capture_failure", 7),
            ("evaluation", TimeoutError("evaluator timed out"), "evaluator_timeout", 8),
        )
        for phase, error, status, exit_code in cases:
            with self.subTest(phase=phase):
                services = RecordingServices(failure=(phase, error))
                evidence = TrustedCoordinator(services).release(SHA)
                self.assertEqual((evidence.status, evidence.exit_code), (status, exit_code))
                self.assertEqual(services.calls[-2:], ["cleanup", "sign_results"])
                self.assertIn("terminal_status", services.signed_manifest)

    def test_cleanup_failure_is_unsigned_and_cannot_leave_stale_signed_success(self):
        services = RecordingServices(
            cleanup_failure=("proxy_start", RuntimeError("proxy cleanup uncertain"))
        )

        evidence = TrustedCoordinator(services).release(SHA)

        self.assertIsNone(evidence.signature)
        self.assertIsNone(services.signed_manifest)
        self.assertEqual(services.calls[-1], "write_unsigned_failure")
        self.assertEqual(evidence.status, "runtime_failure")
        self.assertIn("proxy_start: proxy cleanup uncertain", evidence.cleanup_errors)
        self.assertEqual(
            services.unsigned_manifest["cleanup_errors"],
            [{"phase": "proxy_start", "error": "proxy cleanup uncertain"}],
        )

    def test_primary_timeout_and_all_cleanup_errors_remain_attributable(self):
        services = RecordingServices(
            failure=("agent_start", TimeoutError("agent timed out")),
            cleanup_failure=("proxy_start", RuntimeError("proxy cleanup uncertain")),
        )

        evidence = TrustedCoordinator(services).release(SHA)

        self.assertEqual(evidence.status, "agent_timeout")
        self.assertEqual(evidence.error, "agent timed out")
        self.assertIn("proxy_start: proxy cleanup uncertain", evidence.cleanup_errors)
        self.assertEqual(services.unsigned_manifest["primary_error"], "agent timed out")
        self.assertEqual(
            services.unsigned_manifest["cleanup_errors"],
            [{"phase": "proxy_start", "error": "proxy cleanup uncertain"}],
        )

    def test_agent_teardown_failure_blocks_patch_capture_and_evaluation(self):
        services = RecordingServices(
            failure=("agent_teardown", RuntimeError("agent absence uncertain"))
        )

        evidence = TrustedCoordinator(services).release(SHA)

        self.assertEqual(evidence.status, "agent_failure")
        self.assertNotIn("patch_capture", services.calls)
        self.assertNotIn("evaluation", services.calls)
        self.assertIsNone(evidence.signature)
        self.assertEqual(
            evidence.cleanup_errors,
            ("agent_teardown: agent absence uncertain",),
        )

    def test_explicit_failure_status_is_preserved(self):
        services = RecordingServices(
            failure=("integrity_preflight", CoordinatorFailure("dataset_failure", "drift"))
        )
        evidence = TrustedCoordinator(services).release(SHA)
        self.assertEqual((evidence.status, evidence.exit_code), ("dataset_failure", 3))

    def test_signing_failure_preserves_primary_status_and_is_attributed(self):
        services = RecordingServices(
            failure=(
                "sign_results",
                RuntimeError("signature persistence failed"),
            )
        )

        evidence = TrustedCoordinator(services).release(SHA)

        self.assertEqual(evidence.status, "runtime_failure")
        self.assertEqual(
            evidence.cleanup_errors,
            ("sign_results: signature persistence failed",),
        )
        self.assertEqual(
            services.unsigned_manifest["cleanup_errors"],
            [
                {
                    "phase": "sign_results",
                    "error": "signature persistence failed",
                }
            ],
        )

    def test_signed_release_manifest_has_all_authority_and_teardown_evidence(self):
        services = RecordingServices()
        evidence = TrustedCoordinator(services).release(SHA)
        manifest = services.signed_manifest

        self.assertEqual(manifest, evidence.manifest)
        self.assertEqual(manifest["terminal_status"], "evaluated")
        for field in (
            "authority_commit",
            "candidate_commit",
            "coordinator_tree_sha256",
            "host_identity",
            "attempt_ordinal",
            "dataset",
            "image_digests",
            "policy_digests",
            "lock_digests",
            "model_digest",
            "container_ids",
            "container_inspections",
            "candidate_versions",
            "patch_sha256",
            "evaluator_summary_sha256",
            "teardown",
            "terminal_status",
        ):
            self.assertIn(field, manifest)
        self.assertEqual(evidence.signature, "signed-evidence")


class AgentBoundaryRuntime:
    def __init__(self, *, create_error=None, teardown_error=None):
        self.events = []
        self.create_error = create_error
        self.teardown_error = teardown_error
        self.handle = ContainerHandle("alloy-agent-run", "observed-agent-id", "run")

    def create(self, spec, *, before_create=None):
        self.events.append("pre-create-complete")
        before_create()
        self.events.append("docker-create")
        if self.create_error is not None:
            raise self.create_error
        return self.handle

    def inspect_security(self, handle, spec, *, expected_networks=()):
        return {
            "container_id": handle.container_id,
            "daemon_identity": {"daemon_id": "observed-daemon"},
            "inspection": {
                "HostConfig": {"SecurityOpt": ["observed-security"]},
                "Mounts": ["observed-mount"],
                "NetworkSettings": {"Networks": list(expected_networks)},
            },
        }

    def wait(self, handle, *, timeout=None):
        return 0

    def force_remove(self, handle):
        self.events.append("force-remove")
        if self.teardown_error is not None:
            raise self.teardown_error

    def assert_absent(self, handle):
        self.events.append("absence-verified")

    def remove_volume(self, name, run_id):
        self.events.append(("remove-volume", name, run_id))


class AgentBoundaryProxy:
    def __init__(self):
        self.events = []

    def _docker(self, *arguments):
        self.events.append(arguments)

    def close(self):
        self.events.append(("close",))


class TrustedRunServicesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.private_key = self.root / "gate-key.pem"
        self.public_key = self.root / "gate-key.pub.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", self.private_key],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "openssl",
                "pkey",
                "-in",
                self.private_key,
                "-pubout",
                "-out",
                self.public_key,
            ],
            check=True,
            capture_output=True,
        )

    def services(self, runtime):
        proxy = AgentBoundaryProxy()
        config = TrustedServiceConfig(
            repository=REPO_ROOT,
            authority_commit="b" * 40,
            host_config=types.SimpleNamespace(),
            profile=PROFILE,
            runtime=runtime,
            fetcher=types.SimpleNamespace(),
            evaluator=types.SimpleNamespace(),
            proxy=proxy,
            signer=GateSigner(self.private_key),
            public_key=self.public_key,
            state_dir=self.root / "state",
            results_root=self.root / "results",
            work_root=self.root / "work",
            ollama_origin="http://127.0.0.1:11434",
        )
        services = TrustedRunServices(config)
        services._run_id = "run"
        services.candidate = VerifiedCandidate("b" * 40, SHA, "1.1.26", ())
        services.install = VerifiedCandidateInstall(
            "sha256:" + "1" * 64,
            "1.1.26",
            "0.82.1",
            SHA,
            "app-volume",
            "2" * 64,
            "3" * 64,
            "4" * 64,
        )
        services.target = PreparedTarget(
            "sha256:" + "5" * 64,
            PROFILE.base_commit,
            "6" * 64,
            "agent-volume",
        )
        services.agent_state_volume = "state-volume"
        services.instance = {"problem_statement": "Fix it", "patch": "gold", "test_patch": "hidden"}
        services.endpoint = ProxyEndpoint(
            "http://172.28.0.2:8080",
            "172.28.0.2",
            8080,
            "agent-network",
            ContainerHandle("proxy", "proxy-id", "run"),
            {"container_id": "proxy-id", "inspection": {"observed": True}},
        )
        state = _RunState("release", SHA)
        services.attempt_claim(state)
        services.prepare_agent_launch(state)
        return services, state, proxy

    def test_claim_callback_is_adjacent_to_create_and_manifest_uses_observed_inspection(self):
        runtime = AgentBoundaryRuntime()
        services, state, _proxy = self.services(runtime)

        services.agent_start(state)

        self.assertEqual(runtime.events[:2], ["pre-create-complete", "docker-create"])
        evidence = state.manifest["container_inspections"]["agent"]
        self.assertEqual(evidence["container_id"], "observed-agent-id")
        self.assertEqual(evidence["daemon_identity"]["daemon_id"], "observed-daemon")
        self.assertEqual(
            evidence["inspection"]["NetworkSettings"]["Networks"], ["agent-network"]
        )

    def test_create_cleanup_uncertainty_never_infers_absence(self):
        handle = ContainerHandle("alloy-agent-run", "uncertain-id", "run")
        uncertainty = CleanupUncertainError(
            handle,
            RuntimeError("create failed"),
            RuntimeError("initial cleanup uncertain"),
        )
        runtime = AgentBoundaryRuntime(
            create_error=uncertainty,
            teardown_error=RuntimeError("retry cleanup uncertain"),
        )
        services, state, _proxy = self.services(runtime)

        with self.assertRaises(CleanupUncertainError) as raised:
            services.agent_start(state)
        self.assertFalse(services.agent_absent)
        self.assertFalse(raised.exception.evidence["cleanup_verified"])
        with self.assertRaisesRegex(RuntimeError, "retry cleanup uncertain"):
            services.agent_teardown(state)
        self.assertFalse(services.agent_absent)
        self.assertNotIn("agent_absent", state.manifest.get("teardown", {}))

    def test_concrete_cleanup_finishes_scratch_before_signed_success_is_persisted(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        services.writer = ResultWriter(self.root / "results", "signed-run")
        scratch = self.root / "work" / "scratch"
        scratch.mkdir(parents=True)
        (scratch / "sentinel").write_text("scratch")
        services._scratch_dir = scratch
        services.agent_absent = True
        services.evaluator_absent = True
        state.manifest = {"terminal_status": "evaluated", "cleanup_errors": []}

        services.cleanup(state)
        self.assertFalse(scratch.exists())
        signature = services.sign_results(state)

        run_dir = self.root / "results" / "signed-run"
        self.assertTrue(signature)
        self.assertTrue((run_dir / "manifest.json").is_file())
        self.assertTrue((run_dir / "manifest.signature.json").is_file())
        self.assertFalse((run_dir / "failure.json").exists())

    def test_concrete_signing_refuses_before_cleanup(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        services.writer = ResultWriter(self.root / "results", "early-sign-run")
        services.agent_absent = True
        services.evaluator_absent = True
        state.manifest = {"terminal_status": "evaluated", "cleanup_errors": []}

        with self.assertRaisesRegex(RuntimeError, "before clean teardown"):
            services.sign_results(state)

    def test_concrete_clean_failure_before_any_launch_can_be_signed(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        services.writer = ResultWriter(self.root / "results", "clean-failure-run")
        state.manifest = {
            "terminal_status": "dataset_failure",
            "primary_error": "dataset drift",
            "cleanup_errors": [],
        }

        services.cleanup(state)
        signature = services.sign_results(state)

        run_dir = self.root / "results" / "clean-failure-run"
        self.assertTrue(signature)
        self.assertTrue((run_dir / "manifest.json").is_file())
        self.assertTrue((run_dir / "manifest.signature.json").is_file())

    def test_concrete_partial_sign_failure_leaves_no_signed_manifest_pair(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        delegate = ResultWriter(self.root / "results", "partial-sign-run")

        class FailingManifestWriter:
            run_dir = delegate.run_dir

            def write_json(self, name, value):
                if name == "manifest.signature.json":
                    raise OSError("signature persistence failed")
                return delegate.write_json(name, value)

            def close(self):
                delegate.close()

        services.writer = FailingManifestWriter()
        state.manifest = {"terminal_status": "evaluated", "cleanup_errors": []}
        services.agent_absent = True
        services.evaluator_absent = True
        services.cleanup(state)

        with self.assertRaisesRegex(OSError, "signature persistence failed"):
            services.sign_results(state)

        run_dir = self.root / "results" / "partial-sign-run"
        self.assertTrue((run_dir / "manifest.json").is_file())
        self.assertFalse((run_dir / "manifest.signature.json").exists())

    def test_concrete_unsigned_failure_path_cannot_create_signed_manifest(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        services.writer = ResultWriter(self.root / "results", "failed-run")
        state.manifest = {
            "terminal_status": "runtime_failure",
            "cleanup_errors": ["proxy cleanup uncertain"],
        }

        services.write_unsigned_failure(state)

        run_dir = self.root / "results" / "failed-run"
        self.assertTrue((run_dir / "failure.json").is_file())
        self.assertFalse((run_dir / "manifest.json").exists())
        self.assertFalse((run_dir / "manifest.signature.json").exists())

    def test_concrete_unsigned_failure_creates_writer_when_authority_failed_early(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        state.manifest = {
            "terminal_status": "runtime_failure",
            "primary_error": "authority failed",
            "cleanup_errors": [],
        }

        services.write_unsigned_failure(state)

        self.assertIsNotNone(state.run_dir)
        run_dir = Path(state.run_dir)
        self.assertTrue((run_dir / "failure.json").is_file())
        self.assertFalse((run_dir / "manifest.json").exists())

    def test_concrete_evaluation_records_observed_container_and_teardown_evidence(self):
        services, state, _proxy = self.services(AgentBoundaryRuntime())
        services.writer = ResultWriter(self.root / "results", "evaluation-run")
        services.patch = b"diff --git a/x b/x\n"
        services.agent_absent = True
        services.config.evaluator.run = lambda *_args: EvaluationResult(
            "stdout",
            "stderr",
            {"schema_version": 2, "resolved_ids": [PROFILE.instance_id]},
            {
                "container_id": "observed-evaluator-id",
                "daemon_identity": {"daemon_id": "observed-daemon"},
                "inspection": {"SecurityOpt": ["observed-security"]},
            },
            {
                "absent": True,
                "container_id": "observed-evaluator-id",
                "daemon_identity": {"daemon_id": "observed-daemon"},
            },
        )

        services.evaluation(state)
        services.evaluation_teardown(state)

        self.assertEqual(
            state.manifest["container_ids"]["evaluator"], "observed-evaluator-id"
        )
        self.assertEqual(
            state.manifest["container_inspections"]["evaluator"]["inspection"],
            {"SecurityOpt": ["observed-security"]},
        )
        self.assertTrue(state.manifest["teardown"]["evaluator"]["absent"])


if __name__ == "__main__":
    unittest.main()
