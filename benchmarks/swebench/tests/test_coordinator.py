import unittest

from benchmarks.swebench.coordinator import (
    EXPECTED_RELEASE_PHASES,
    CoordinatorFailure,
    TrustedCoordinator,
)


SHA = "a" * 40


class RecordingServices:
    def __init__(self, *, verdict="resolved", failure=None):
        self.calls = []
        self.cleanups = []
        self.consumed = False
        self.agent_absent = False
        self.patch_trusted = False
        self.evaluator_absent = False
        self.verdict = verdict
        self.failure = failure
        self.signed_manifest = None

    def arm_cleanup(self, phase, state):
        armed = {"phase": phase, "used": False}
        self.cleanups.append(armed)

        def cleanup():
            armed["used"] = True

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

    def consume_claim(self, state):
        if state.claim is None:
            raise AssertionError("claim was not verified before consumption")
        self.calls.append("consume_claim")
        self.consumed = True

    def agent_start(self, state):
        if not self.consumed or self.calls[-1] != "consume_claim":
            raise AssertionError("claim was not consumed at the agent start boundary")
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
        self._phase("sign_results", state)
        self.signed_manifest = dict(state.manifest)
        return "signed-evidence"

    def cleanup(self, state):
        self._phase("cleanup", state)


class CoordinatorTests(unittest.TestCase):
    def test_release_has_one_fixed_order_and_boundary_only_claim_consumption(self):
        services = RecordingServices()
        evidence = TrustedCoordinator(services).release(SHA)

        self.assertEqual(
            tuple(call for call in services.calls if call != "consume_claim"),
            EXPECTED_RELEASE_PHASES,
        )
        start = services.calls.index("agent_start")
        self.assertEqual(services.calls[start - 1], "consume_claim")
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
                "sign_results",
                "cleanup",
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
                self.assertEqual(services.calls[-1], "cleanup")
                self.assertIn("terminal_status", services.signed_manifest)

    def test_explicit_failure_status_is_preserved(self):
        services = RecordingServices(
            failure=("integrity_preflight", CoordinatorFailure("dataset_failure", "drift"))
        )
        evidence = TrustedCoordinator(services).release(SHA)
        self.assertEqual((evidence.status, evidence.exit_code), ("dataset_failure", 3))

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


if __name__ == "__main__":
    unittest.main()
